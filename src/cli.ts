#!/usr/bin/env tsx
/**
 * headlesscode — Phase 1 headless CLI entry.
 *
 * Exit codes:
 *   0  success
 *   1  task failed / max iterations / bounded failure
 *   2  usage or configuration error (bad args, missing API key)
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { LocalMemoryStore } from "./memory/local.js"
import type { MemoryStore } from "./memory/types.js"
import { OpenRouterClient } from "./llm/openrouter.js"
import { HeadlessSession } from "./engine/loop.js"
import { Logger } from "./engine/logger.js"
import { buildSystemPrompt, loadCustomModes, selectToolsForMode } from "./engine/prompt.js"
import { orchestrateMain } from "./orchestrator/cli.js"
import { watchMain } from "./watcher/cli.js"
import { checkpointsMain } from "./checkpoints/cli.js"
import { dashboardMain } from "./dashboard/cli.js"
import { indexMain } from "./codesearch/cli.js"
import { provisionMain } from "./github/cli.js"
import { resolvePermissions, type PermissionsConfig } from "./permissions/config.js"
import { resolveModelForMode } from "./config/mode-models.js"

const VERSION = "0.1.0"

interface CliOptions {
	mode: string
	task?: string
	taskFile?: string
	workspace?: string
	/** Explicit session id override (set by the dashboard's session-launch endpoint). */
	sessionId?: string
	model?: string
	maxIterations?: number
	consecutiveErrorLimit?: number
	/** Sliding-window history cap, in messages (also see DEFAULT_WINDOW_SIZE in engine/loop.ts). */
	windowSize?: number
	/** Per-LLM-call abort timeout, ms (default: DEFAULT_LLM_TIMEOUT_MS in engine/loop.ts). */
	llmTimeoutMs?: number
	/** Phase 6: per-session cost cap, USD (also $HEADLESSCODE_MAX_COST_USD). */
	maxCostUsd?: number
	/** Phase 6: per-session duration cap, ms (also $HEADLESSCODE_MAX_DURATION_MS). */
	maxDurationMs?: number
	logFile?: string
	memoryDir?: string
	noMemory: boolean
	dryRun: boolean
	version: boolean
	help: boolean
	/** Checkpoints on by default; --no-checkpoints opts out. */
	noCheckpoints: boolean
	checkpointDir?: string
	/** Decision escalation timeout, ms (also $HEADLESSCODE_DECISION_TIMEOUT_MS). */
	decisionTimeoutMs?: number
	/** Pause/resume max duration, ms (also $HEADLESSCODE_MAX_PAUSE_MS). */
	maxPauseMs?: number
	/** Permissions: comma-separated command prefixes allowed to run (also $HEADLESSCODE_ALLOWED_COMMANDS). */
	allowedCommands?: string
	/** Permissions: comma-separated command prefixes never allowed (also $HEADLESSCODE_DENIED_COMMANDS). */
	deniedCommands?: string
	/** Permissions: comma-separated protected-file globs (also $HEADLESSCODE_PROTECTED_FILES). */
	protectedFiles?: string
	/** Permissions escape hatch: allow writes to protected files (default: false). */
	allowProtectedWrites: boolean
}

const USAGE = `headlesscode — headless coding-agent harness (Phase 1 engine)

Usage:
  headlesscode --task "<task text>" [options]
  headlesscode --task-file <path> [options]
  headlesscode --dry-run [options]          # build system prompt + validate config, no LLM call

Subcommands:
  headlesscode orchestrate --repo <path> --issue <n>... [--qa] [--deploy] [--dry-run]
              Run a full parallel orchestration round
              (split → spawn → review → QA → deploy gate). See
              \`npx tsx src/cli.ts orchestrate --help\` for full options.
  headlesscode watch --owner <o> --repo <r> --label <label> [--run-once]
              Poll GitHub for labeled issues and fan out into orchestration
              batches (idempotent). See
              \`npx tsx src/cli.ts watch --help\` for full options.
  headlesscode checkpoints --workspace <path> [list | restore <hash> | diff <hash>]
              List/restore/diff shadow-git checkpoints for a workspace. See
              \`npx tsx src/cli.ts checkpoints --help\` for full options.
  headlesscode dashboard [--port 4390] [--repo <path>]
              Serve a local cost/token dashboard with a live per-session
              event feed and pause/resume control (Phase 3: no longer purely
              read-only — see src/dashboard/server.ts). See
              \`npx tsx src/cli.ts dashboard --help\` for full options.
  headlesscode index --workspace <path> [--model <id>] [--embedding-backend <b>]
              Build/refresh the codebase semantic-search index for a workspace
              (used by the codebase_search tool). A separate, explicit step —
              never auto-triggered mid-session. --embedding-backend picks
              openrouter (default) or ollama (local). See
              \`npx tsx src/cli.ts index --help\` for full options.
  headlesscode provision --installation-id <id> --owner <o> --repo <r> --target <dir>
              Clone a GitHub repo the App installation can access into a local
              dir (token stripped from the remote URL), ready as a
              --workspace value. Also --list-repos <id>. See
              \`npx tsx src/cli.ts provision --help\` for full options.

Options:
  --mode <slug>              Mode to run in (built-in or from .roomodes). Default: code
  --task <text>              The task description for the agent
  --task-file <path>         Read the task from a file (relative to workspace)
  --workspace <root>         Workspace root (default: $HEADLESSCODE_WORKSPACE_ROOT or cwd)
  --session-id <id>          Explicit session id override (default: a fresh UUID).
                             Used by the dashboard's session-launch endpoint so
                             the browser can open the session's event view
                             immediately; rarely needed from a terminal.
  --model <id>               OpenRouter model id (default: $OPENROUTER_MODEL or deepseek/deepseek-chat)
  --max-iterations <n>       Loop iteration cap (default: 50)
  --consecutive-error-limit <n>  Consecutive mistakes before giving up (default: 3)
  --window-size <n>          Sliding-window history cap, in messages, before the
                             oldest are evicted (default: 300; see DEFAULT_WINDOW_SIZE
                             in src/engine/loop.ts for why)
  --llm-timeout-ms <n>       Per-LLM-call abort timeout, ms (default: 300000 / 5 min
                             — reasoning models can take a while on a heavy turn)
  --log-file <path>          Also append structured logs to this file
  --memory-dir <path>        Store project memory (facts + session summaries) under
                             <path>. Enables Phase 3 memory. Default (when enabled):
                             $HEADLESSCODE_MEMORY_DIR or <workspace>/.headlesscode/memory
  --no-memory                Explicitly disable memory even if HEADLESSCODE_MEMORY_DIR is set
  --max-cost-usd <n>         Phase 6: per-session cost cap in USD (decimal, e.g. 0.05).
                             Default: $HEADLESSCODE_MAX_COST_USD; off when neither is set
  --max-duration-ms <n>      Phase 6: per-session wall-clock cap in ms. Default:
                             $HEADLESSCODE_MAX_DURATION_MS; off when neither is set.
                             When a cap trips the session aborts with reason "budget"
  --dry-run                  Build the system prompt, validate .roomodes/rules loading,
                             then exit without calling the LLM (no API key needed)
  --no-checkpoints           Disable shadow-git checkpoints (on by default; see
                             \`headlesscode checkpoints --help\`). No effect for
                             read-only sessions (reviewer/QA), which never checkpoint
  --checkpoint-dir <path>    Shadow-git storage root override (default:
                             ~/.headlesscode/checkpoints — MUST be outside the
                             workspace; see docs/checkpoints.md)
  --decision-timeout-ms <n>  How long ask_followup_question blocks waiting for
                               a human/orchestrator answer before falling back
                               to autonomous decision, ms (default 1800000 / 30
                               min). Default: $HEADLESSCODE_DECISION_TIMEOUT_MS
  --max-pause-ms <n>         Max duration a dashboard-initiated pause may hold
                               the loop before it auto-resumes, ms (default
                               7200000 / 2h — matches the orchestrator's stall
                               guard). Default: $HEADLESSCODE_MAX_PAUSE_MS
  --allowed-commands <list>  Comma-separated command prefixes the agent may run.
                               Default: $HEADLESSCODE_ALLOWED_COMMANDS, else
                               .headlesscode/permissions.json, else empty (=
                               allow everything except --denied-commands)
  --denied-commands <list>   Comma-separated command prefixes that are ALWAYS
                               refused (deny wins over allow; dangerous shell
                               substitutions are always blocked regardless).
                               Default: $HEADLESSCODE_DENIED_COMMANDS, else
                               .headlesscode/permissions.json, else empty
  --protected-files <list>   Comma-separated glob patterns of files the agent may
                               not write. Default: $HEADLESSCODE_PROTECTED_FILES,
                               else .headlesscode/permissions.json, else
                               ".env,.env.*,*.pem,*.key,id_rsa*"
  --allow-protected-writes   Escape hatch: permit writes to protected files
                               (default: OFF). Also settable via
                               "allowProtectedWrites": true in
                               .headlesscode/permissions.json
  --version                  Print version and exit
  --help                     Show this help and exit

Environment:
  OPENROUTER_API_KEY         Required (except --dry-run)
  OPENROUTER_MODEL           Default model id
  OPENROUTER_HTTP_REFERER    Optional HTTP-Referer header
  OPENROUTER_APP_TITLE       Optional X-Title header
  HEADLESSCODE_WORKSPACE_ROOT  Default workspace root
  HEADLESSCODE_MEMORY_DIR    Default memory dir (memory enabled when set)
  HEADLESSCODE_PROJECT       Project scope for memory (default: workspace basename)
  HEADLESSCODE_ALLOWED_COMMANDS   Default --allowed-commands (comma-separated)
  HEADLESSCODE_DENIED_COMMANDS    Default --denied-commands (comma-separated)
  HEADLESSCODE_PROTECTED_FILES    Default --protected-files (comma-separated globs)
  HEADLESSCODE_ALLOW_PROTECTED_WRITES  Allow protected-file writes ("1"/"true")
`

export function parseArgs(argv: string[]): { options: CliOptions; error?: string } {
	const options: CliOptions = {
		mode: "code",
		noMemory: false,
		dryRun: false,
		version: false,
		help: false,
		noCheckpoints: false,
		allowProtectedWrites: false,
	}

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
			case "--mode":
			case "--task":
			case "--task-file":
			case "--workspace":
			case "--model":
			case "--log-file":
			case "--session-id": {
				const value = next()
				if (value === undefined) {
					return { options, error: `Missing value for ${flag}` }
				}
				switch (flag) {
					case "--mode":
						options.mode = value
						break
					case "--task":
						options.task = value
						break
					case "--task-file":
						options.taskFile = value
						break
					case "--workspace":
						options.workspace = value
						break
					case "--model":
						options.model = value
						break
					case "--log-file":
						options.logFile = value
						break
					case "--session-id":
						options.sessionId = value
						break
				}
				break
			}
			case "--max-iterations":
			case "--consecutive-error-limit":
			case "--window-size":
			case "--llm-timeout-ms": {
				const value = next()
				const num = value === undefined ? Number.NaN : Number(value)
				if (!Number.isInteger(num) || num <= 0) {
					return { options, error: `${flag} requires a positive integer` }
				}
				if (flag === "--max-iterations") {
					options.maxIterations = num
				} else if (flag === "--consecutive-error-limit") {
					options.consecutiveErrorLimit = num
				} else if (flag === "--window-size") {
					options.windowSize = num
				} else {
					options.llmTimeoutMs = num
				}
				break
			}
			case "--max-cost-usd": {
				const value = next()
				const num = value === undefined ? Number.NaN : Number(value)
				if (!Number.isFinite(num) || num <= 0) {
					return { options, error: "--max-cost-usd requires a positive number (USD, decimal allowed)" }
				}
				options.maxCostUsd = num
				break
			}
			case "--max-duration-ms": {
				const value = next()
				const num = value === undefined ? Number.NaN : Number(value)
				if (!Number.isInteger(num) || num <= 0) {
					return { options, error: "--max-duration-ms requires a positive integer" }
				}
				options.maxDurationMs = num
				break
			}
			case "--decision-timeout-ms": {
				const value = next()
				const num = value === undefined ? Number.NaN : Number(value)
				if (!Number.isInteger(num) || num <= 0) {
					return { options, error: "--decision-timeout-ms requires a positive integer" }
				}
				options.decisionTimeoutMs = num
				break
			}
			case "--max-pause-ms": {
				const value = next()
				const num = value === undefined ? Number.NaN : Number(value)
				if (!Number.isInteger(num) || num <= 0) {
					return { options, error: "--max-pause-ms requires a positive integer" }
				}
				options.maxPauseMs = num
				break
			}
			case "--memory-dir":
			case "--allowed-commands":
			case "--denied-commands":
			case "--protected-files": {
				const value = next()
				if (value === undefined) {
					return { options, error: `Missing value for ${flag}` }
				}
				switch (flag) {
					case "--memory-dir":
						options.memoryDir = value
						break
					case "--allowed-commands":
						options.allowedCommands = value
						break
					case "--denied-commands":
						options.deniedCommands = value
						break
					case "--protected-files":
						options.protectedFiles = value
						break
				}
				break
			}
			case "--allow-protected-writes":
				options.allowProtectedWrites = true
				break
			case "--checkpoint-dir": {
				const value = next()
				if (value === undefined) {
					return { options, error: "Missing value for --checkpoint-dir" }
				}
				options.checkpointDir = value
				break
			}
			case "--no-memory":
				options.noMemory = true
				break
			case "--no-checkpoints":
				options.noCheckpoints = true
				break
			case "--dry-run":
				options.dryRun = true
				break
			case "--version":
				options.version = true
				break
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown argument: ${arg}` }
		}
	}

	return { options }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	// Phase 2 subcommand: `headlesscode orchestrate ...` — delegates to the
	// orchestrator module (split → spawn → watch → review). Keeps the Phase 1
	// run path untouched.
	if (argv[0] === "orchestrate") {
		return orchestrateMain(argv.slice(1))
	}

	// Phase 5 subcommand: `headlesscode watch ...` — GitHub issue watcher
	// (poll label → split → spawn → durable idempotency state).
	if (argv[0] === "watch") {
		return watchMain(argv.slice(1))
	}

	// Checkpoints subcommand: `headlesscode checkpoints ...` — list/restore/diff
	// shadow-git checkpoints for a workspace (see src/checkpoints/).
	if (argv[0] === "checkpoints") {
		return checkpointsMain(argv.slice(1))
	}

	// Cost/token dashboard subcommand: `headlesscode dashboard ...` — local
	// HTML dashboard with live per-session events + pause/resume control
	// (Phase 3 — see src/dashboard/; no longer purely read-only).
	if (argv[0] === "dashboard") {
		return dashboardMain(argv.slice(1))
	}

	// Codebase semantic-search index subcommand: `headlesscode index ...` —
	// build/refresh <workspace>/.headlesscode/codesearch/index.jsonl for the
	// codebase_search tool (see src/codesearch/). A separate, EXPLICIT step —
	// never auto-triggered mid-session (it costs real money and takes time).
	if (argv[0] === "index") {
		return indexMain(argv.slice(1))
	}

	// GitHub App repo provisioning subcommand: `headlesscode provision ...` —
	// clone a repo the App installation can access into a local dir (token
	// stripped from the remote), ready as a --workspace value. Also
	// `--list-repos <id>` (see src/github/cli.ts + docs/github-app-setup.md).
	if (argv[0] === "provision") {
		return provisionMain(argv.slice(1))
	}

	const { options, error } = parseArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode: ${error}\n\n${USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(USAGE)
		return 0
	}
	if (options.version) {
		process.stdout.write(`headlesscode ${VERSION}\n`)
		return 0
	}

	const workspaceRoot = path.resolve(options.workspace ?? process.env.HEADLESSCODE_WORKSPACE_ROOT ?? process.cwd())
	const logger = new Logger({ level: "info", filePath: options.logFile })

	// ── dry-run: no API key required ──────────────────────────────────────────
	if (options.dryRun) {
		try {
			const customModes = await loadCustomModes(workspaceRoot)
			const built = await buildSystemPrompt({
				workspaceRoot,
				mode: options.mode,
				customModes,
			})
			const tools = selectToolsForMode(options.mode, customModes)
			// Per-mode model assignment: dry-run resolves the model exactly
			// like a real run (mode-models.json / _default / OPENROUTER_MODEL,
			// with an explicit --model always winning) so the effective model
			// is visible without an LLM call. undefined -> the client default.
			const dryRunModel = resolveModelForMode({
				workspaceRoot,
				mode: options.mode,
				explicitModel: options.model,
				env: process.env,
			})

			process.stdout.write(built.prompt + "\n")
			process.stdout.write(
				`\n───── dry-run summary ─────\n` +
					`mode:             ${options.mode}\n` +
					`model:            ${dryRunModel ?? "deepseek/deepseek-chat (client default)"}\n` +
					`workspace:        ${workspaceRoot}\n` +
					`custom modes:     ${customModes.length ? customModes.map((m) => m.slug).join(", ") : "(none, using built-ins)"}\n` +
					`exposed tools:    ${tools.map((t) => (t.type === "function" ? t.function.name : t.type)).join(", ")}\n` +
					`system prompt:    ${built.prompt.length} chars\n`,
			)
			logger.info("dry-run complete", { mode: options.mode, workspaceRoot })
			return 0
		} catch (err) {
			process.stderr.write(`headlesscode: dry-run failed: ${err instanceof Error ? err.message : String(err)}\n`)
			return 2
		}
	}

	// ── real run: API key required ────────────────────────────────────────────
	const apiKey = process.env.OPENROUTER_API_KEY
	if (!apiKey) {
		process.stderr.write(
			"headlesscode: OPENROUTER_API_KEY is not set.\n" +
				"  Export it (e.g. export OPENROUTER_API_KEY=sk-or-...) or use --dry-run to\n" +
				"  validate the prompt/config without calling the LLM.\n",
		)
		return 2
	}

	if (!options.task && !options.taskFile) {
		process.stderr.write(`headlesscode: provide a task with --task <text> or --task-file <path>\n\n${USAGE}`)
		return 2
	}
	if (options.task && options.taskFile) {
		process.stderr.write("headlesscode: use either --task or --task-file, not both\n")
		return 2
	}

	let taskText = options.task ?? ""
	if (options.taskFile) {
		const taskFilePath = path.resolve(workspaceRoot, options.taskFile)
		try {
			taskText = fs.readFileSync(taskFilePath, "utf-8")
		} catch (err) {
			process.stderr.write(
				`headlesscode: cannot read task file '${taskFilePath}': ${err instanceof Error ? err.message : String(err)}\n`,
			)
			return 2
		}
	}
	if (taskText.trim() === "") {
		process.stderr.write("headlesscode: task text is empty\n")
		return 2
	}

	// Per-mode model assignment (plans/mode-model-assignment.md): the
	// resolved mode's config entry / _default / OPENROUTER_MODEL apply only
	// when no explicit --model flag was given (an explicit flag always wins).
	// `undefined` is passed through so the OpenRouter client's own built-in
	// default stays the single source of truth for the ultimate fallback.
	const model = resolveModelForMode({
		workspaceRoot,
		mode: options.mode,
		explicitModel: options.model,
		env: process.env,
	})
	const client = new OpenRouterClient({ apiKey, defaultModel: model })

	// Phase 3 memory: OFF by default (preserves pre-Phase-3 behavior). Enabled
	// only by --memory-dir or $HEADLESSCODE_MEMORY_DIR; --no-memory forces off.
	const memory = resolveMemory(options, workspaceRoot)
	const project = process.env.HEADLESSCODE_PROJECT ?? path.basename(workspaceRoot)

	// Phase 6 per-session budget: flags win over the env fallbacks
	// ($HEADLESSCODE_MAX_COST_USD / $HEADLESSCODE_MAX_DURATION_MS — set by
	// run-worker.sh / run-qa.sh for workers). Off when neither is set.
	const maxCostUsd = options.maxCostUsd ?? envNumber("HEADLESSCODE_MAX_COST_USD")
	const maxDurationMs = options.maxDurationMs ?? envNumber("HEADLESSCODE_MAX_DURATION_MS")
	const budget =
		maxCostUsd !== undefined || maxDurationMs !== undefined ? { maxCostUsd, maxDurationMs } : undefined

	// Decision escalation: flag wins over the env fallback
	// ($HEADLESSCODE_DECISION_TIMEOUT_MS — set by run-worker.sh for workers).
	// Off (undefined) falls back to executor.ts's own default (30 min).
	const decisionTimeoutMs = options.decisionTimeoutMs ?? envNumber("HEADLESSCODE_DECISION_TIMEOUT_MS")

	// Pause/resume (live worker monitoring): flag wins over the env fallback
	// ($HEADLESSCODE_MAX_PAUSE_MS). Off (undefined) falls back to loop.ts's
	// own default (2h — matching watch.ts's stall guard). Passing it through
	// explicitly keeps the CLI the single place that resolves config.
	const maxPauseMs = options.maxPauseMs ?? envNumber("HEADLESSCODE_MAX_PAUSE_MS")

	// Permissions (command allow/deny + protected files): CLI flags > env vars
	// > <workspaceRoot>/.headlesscode/permissions.json > built-in defaults.
	// A malformed permissions.json fails loudly (mirrors HEADLESSCODE_PRICING_JSON).
	let permissions: PermissionsConfig
	try {
		permissions = resolvePermissions({
			workspaceRoot,
			overrides: {
				allowedCommands: options.allowedCommands,
				deniedCommands: options.deniedCommands,
				protectedFiles: options.protectedFiles,
				allowProtectedWrites: options.allowProtectedWrites ? true : null,
			},
			env: process.env,
		})
	} catch (err) {
		process.stderr.write(`headlesscode: ${err instanceof Error ? err.message : String(err)}\n`)
		return 2
	}

	const session = new HeadlessSession({
		workspaceRoot,
		sessionId: options.sessionId,
		mode: options.mode,
		model,
		taskText,
		maxIterations: options.maxIterations,
		consecutiveErrorLimit: options.consecutiveErrorLimit,
		windowSize: options.windowSize,
		llmTimeoutMs: options.llmTimeoutMs,
		llmClient: client,
		logger,
		memory,
		project,
		budget,
		checkpoints: !options.noCheckpoints,
		checkpointDir: options.checkpointDir,
		decisionTimeoutMs,
		maxPauseMs,
		permissions,
	})

	const result = await session.run()

	if (session.memoryStats) {
		process.stdout.write(
			`[memory] project="${project}" recalled ${session.memoryStats.recalledFacts} fact(s) / ${session.memoryStats.recalledSessions} session(s); recorded ${session.memoryStats.recordedFacts} fact(s) / ${session.memoryStats.recordedSessions} session(s)\n`,
		)
	}

	if (result.budgetUsage) {
		process.stdout.write(
			`[budget] cost $${result.budgetUsage.costUsd.toFixed(6)}, elapsed ${result.budgetUsage.elapsedMs}ms, iterations ${result.budgetUsage.iterations}, model ${result.budgetUsage.model}\n`,
		)
	}

	if (result.status === "success") {
		logger.info("session succeeded", { iterations: result.iterations, toolCalls: result.toolCalls })
		process.stdout.write(result.result + "\n")
		return 0
	}

	logger.error("session failed", { error: result.error, iterations: result.iterations, reason: result.reason })
	if (result.reason === "budget") {
		process.stderr.write(`headlesscode: task aborted by budget: ${result.error ?? "budget exceeded"}\n`)
		return 1
	}
	process.stderr.write(`headlesscode: task failed: ${result.error ?? "unknown error"}\n`)
	return 1
}

/** Parse a positive finite number from env (undefined when unset/invalid). */
function envNumber(name: string): number | undefined {
	const raw = process.env[name]
	if (raw === undefined || raw === "") {
		return undefined
	}
	const n = Number(raw)
	return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
	* Resolve the Phase 3 memory store. Default OFF (null) to preserve existing
	* behavior; enabled by --memory-dir or $HEADLESSCODE_MEMORY_DIR. --no-memory
	* forces OFF even when the env var is set.
	*/
function resolveMemory(options: CliOptions, workspaceRoot: string): MemoryStore | null {
	if (options.noMemory) {
		return null
	}
	const dir = options.memoryDir ?? process.env.HEADLESSCODE_MEMORY_DIR
	if (!dir) {
		return null
	}
	return new LocalMemoryStore({ dir: path.resolve(dir) })
}

// Allow `tsx src/cli.ts` / `headlesscode` / `npm run cli` to run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
	main().then(
		(code) => {
			process.exitCode = code
		},
		(err) => {
			process.stderr.write(`headlesscode: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
			process.exitCode = 2
		},
	)
}
