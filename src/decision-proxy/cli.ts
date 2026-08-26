/**
 * `headlesscode decision-proxy` subcommand — the decision-proxy agent
 * (plans/decision-proxy-agent.md): an LLM stand-in for the human on
 * `ask_followup_question`. Watches a workspace for `.harness.needs-decision`
 * and writes `.harness.decision-answer` grounded in the session's original
 * task text, so a headless session never blocks the full decision timeout
 * on a question its own task can answer. See src/decision-proxy/proxy.ts for
 * the three-outcome logic and the fail-open contract.
 *
 *   npx tsx src/cli.ts decision-proxy --workspace <path> [--task <text>] [options]
 *
 * OPT-IN experimental subsystem: refuses to run unless HEADLESSCODE_DECISION_PROXY=1
 * is set (same convention as HEADLESSCODE_LOCAL_EXPLORE).
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { OpenRouterClient } from "../llm/openrouter.js"
import { Logger } from "../engine/logger.js"
import {
	DECISION_PROXY_LOG_FILE,
	DECISION_PROXY_MODEL_KEY,
	isDecisionProxyEnabled,
	resolveDecisionProxyLlmTimeout,
	resolveDecisionProxyPollInterval,
	resolveDecisionProxyModel,
	runDecisionProxy,
} from "./proxy.js"
import type { DecisionProxyOptions } from "./proxy.js"

const DECISION_PROXY_USAGE = `headlesscode decision-proxy — LLM stand-in for the human on ask_followup_question

Usage:
  headlesscode decision-proxy --workspace <path> [--task <text>] [options]

Watches <path> for .harness.needs-decision markers and answers them by writing
.harness.decision-answer — the same file a human writes via
scripts/headlesscode-answer.sh — grounded in the session's ORIGINAL task text.
When the task text cannot ground a specific answer the proxy writes NOTHING
and the session's existing decision-timeout fallback fires exactly as today.

OPT-IN: requires HEADLESSCODE_DECISION_PROXY=1 (experimental subsystem).

Options:
  --workspace <path>    Workspace/worktree to watch (required)
  --task <text>         The session's original task text, VERBATIM. Used to
                        ground answers; when omitted the proxy falls back to
                        --task-file, then to the orchestrator's group
                        task_file (read from .worktrees/.orchestrator-state.json)
  --task-file <path>    Read the original task from this file (relative to
                        --workspace), verbatim
  --model <id>          OpenRouter model id for answers (default: the
                        _decision-proxy key in
                        <workspace>/.headlesscode/mode-models.json, else
                        mode/_default/OPENROUTER_MODEL/client default)
  --poll-interval-ms <n>  Marker poll interval (default:
                        $HEADLESSCODE_DECISION_PROXY_POLL_INTERVAL_MS or 5000)
  --llm-timeout-ms <n>  Per-answer LLM abort timeout, ms (default:
                        $HEADLESSCODE_DECISION_PROXY_LLM_TIMEOUT_MS or 60000)
  --log-file <path>     Proxy audit log (default:
                        <workspace>/.headlesscode/decision-proxy.log)
  --help                Show this help and exit

Environment:
  HEADLESSCODE_DECISION_PROXY       Required: "1"/"true" enables the proxy
  HEADLESSCODE_OPENROUTER_API_KEY   Required (real LLM answers)
  OPENROUTER_MODEL                  Default model id
  HEADLESSCODE_DECISION_PROXY_POLL_INTERVAL_MS  Poll interval, ms (default 5000)
  HEADLESSCODE_DECISION_PROXY_LLM_TIMEOUT_MS    Per-answer timeout, ms (default 60000)

The proxy runs until interrupted (SIGINT/SIGTERM → clean exit 0). Every
question seen is logged with its outcome (answered / uncertain / errored) to
the audit log, so a full session's decision history is reconstructable even
though nothing blocked on it live.
`

interface DecisionProxyCliOptions {
	workspace?: string
	task?: string
	taskFile?: string
	model?: string
	pollIntervalMs?: number
	llmTimeoutMs?: number
	logFile?: string
	help: boolean
}

export function parseDecisionProxyArgs(argv: string[]): { options: DecisionProxyCliOptions; error?: string } {
	const options: DecisionProxyCliOptions = { help: false }

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const eq = arg.indexOf("=")
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				return inlineValue
			}
			const v = argv[i + 1]
			if (v === undefined || v.startsWith("--")) {
				return undefined
			}
			i++
			return v
		}

		switch (flag) {
			case "--workspace": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --workspace" }
				}
				options.workspace = v
				break
			}
			case "--task": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --task" }
				}
				options.task = v
				break
			}
			case "--task-file": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --task-file" }
				}
				options.taskFile = v
				break
			}
			case "--model": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --model" }
				}
				options.model = v
				break
			}
			case "--poll-interval-ms": {
				const v = next()
				const n = Number(v)
				if (v === undefined || !Number.isInteger(n) || n <= 0) {
					return { options, error: "--poll-interval-ms must be a positive integer" }
				}
				options.pollIntervalMs = n
				break
			}
			case "--llm-timeout-ms": {
				const v = next()
				const n = Number(v)
				if (v === undefined || !Number.isInteger(n) || n <= 0) {
					return { options, error: "--llm-timeout-ms must be a positive integer" }
				}
				options.llmTimeoutMs = n
				break
			}
			case "--log-file": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --log-file" }
				}
				options.logFile = v
				break
			}
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown decision-proxy argument: ${arg}` }
		}
	}

	return { options }
}

export async function decisionProxyMain(argv: string[]): Promise<number> {
	const { options, error } = parseDecisionProxyArgs(argv)
	if (error) {
		process.stderr.write(`decision-proxy: ${error}\n\n${DECISION_PROXY_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(DECISION_PROXY_USAGE)
		return 0
	}

	if (!isDecisionProxyEnabled(process.env)) {
		process.stderr.write(
			"decision-proxy: HEADLESSCODE_DECISION_PROXY is not set. The decision proxy is an opt-in\n" +
				"  experimental subsystem (like HEADLESSCODE_LOCAL_EXPLORE) — set HEADLESSCODE_DECISION_PROXY=1\n" +
				"  to enable it.\n",
		)
		return 2
	}

	if (!options.workspace) {
		process.stderr.write(`decision-proxy: --workspace <path> is required\n\n${DECISION_PROXY_USAGE}`)
		return 2
	}

	const workspaceRoot = path.resolve(options.workspace)
	if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
		process.stderr.write(`decision-proxy: workspace does not exist or is not a directory: ${workspaceRoot}\n`)
		return 2
	}

	const apiKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY
	if (!apiKey) {
		process.stderr.write(
			"decision-proxy: HEADLESSCODE_OPENROUTER_API_KEY is not set — the proxy needs a real LLM to answer questions.\n",
		)
		return 2
	}

	// Model resolution: an explicit --model always wins; otherwise the
	// `_decision-proxy` key in mode-models.json (consulted first, like
	// `_condensation`), then mode/_default/OPENROUTER_MODEL/client default.
	const model =
		options.model ?? resolveDecisionProxyModel(workspaceRoot, process.env) ?? undefined

	const logFile = options.logFile ? path.resolve(options.logFile) : path.join(workspaceRoot, DECISION_PROXY_LOG_FILE)
	try {
		await fsp.mkdir(path.dirname(logFile), { recursive: true })
	} catch {
		// Non-fatal: the Logger falls back to stdout/stderr if the file can't be written.
	}
	const logger = new Logger({ level: "info", filePath: logFile })

	const client = new OpenRouterClient({ apiKey, defaultModel: model })

	const proxyOptions: DecisionProxyOptions = {
		workspaceRoot,
		task: options.task,
		taskFile: options.taskFile,
		model,
		llmClient: client,
		pollIntervalMs: options.pollIntervalMs ?? resolveDecisionProxyPollInterval(process.env),
		llmTimeoutMs: options.llmTimeoutMs ?? resolveDecisionProxyLlmTimeout(process.env),
		logger,
	}

	// SIGINT/SIGTERM → stop the loop cleanly and exit 0 (the audit log's
	// "stopped" line is the terminal record for the session's decision history).
	const controller = new AbortController()
	const onSignal = (): void => controller.abort()
	process.on("SIGINT", onSignal)
	process.on("SIGTERM", onSignal)

	try {
		await runDecisionProxy(proxyOptions, controller.signal)
		return 0
	} finally {
		process.off("SIGINT", onSignal)
		process.off("SIGTERM", onSignal)
	}
}
