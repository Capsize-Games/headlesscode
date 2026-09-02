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
import { OpenRouterClient, parseReasoningEffort } from "./llm/openrouter.js"
import { OllamaClient } from "./llm/ollama.js"
import type { LlmClient } from "./engine/types.js"
import { HeadlessSession } from "./engine/loop.js"
import { chownWorktreeWorkspace } from "./dashboard/session-launch.js"
import { isLocalExploreEnabled } from "./engine/local-explore.js"
import { Logger } from "./engine/logger.js"
import {
	appendCodeIntelTools,
	appendDescribeImageTool,
	buildSystemPrompt,
	loadCustomModes,
	selectToolsForMode,
} from "./engine/prompt.js"
import { orchestrateMain } from "./orchestrator/cli.js"
import { watchMain } from "./watcher/cli.js"
import { checkpointsMain } from "./checkpoints/cli.js"
import { dashboardMain } from "./dashboard/cli.js"
import { trendMain } from "./dashboard/trend-cli.js"
import { indexMain } from "./codesearch/cli.js"
import { codemapMain } from "./codemap/cli.js"
import { initMain } from "./init/cli.js"
import { provisionMain, pushPrMain } from "./github/cli.js"
import { decisionProxyMain } from "./decision-proxy/cli.js"
import { migrateMain } from "./migrate/cli.js"
import { projectsMain } from "./projects/cli.js"
import { analyzeCliMain } from "./orchestrator/analyze-cli.js"
import { costHistoryCliMain } from "./orchestrator/cost-history-cli.js"
import { resolvePermissions, type PermissionsConfig } from "./permissions/config.js"
import { resolveModelForMode, resolveReasoningEffortForMode } from "./config/mode-models.js"

const VERSION = "0.1.0"

interface CliOptions {
	mode: string
	task?: string
	taskFile?: string
	workspace?: string
	/** Explicit session id override (set by the dashboard's session-launch endpoint). */
	sessionId?: string
	/** See HeadlessSessionConfig.requireArtifactPathPattern (loop.ts) — a research-harness primitive. */
	requireArtifactPath?: string
	/** See HeadlessSessionConfig.requireArtifactMinCitations (loop.ts). */
	requireArtifactMinCitations?: number
	/** See HeadlessSessionConfig.requireArtifactSections (loop.ts) — pipe-separated on the CLI. */
	requireArtifactSections?: string[]
	model?: string
	maxIterations?: number
	consecutiveErrorLimit?: number
	/**
	 * Recursive task decomposition (`new_task`): hard cap on how deep a single
	 * root session may delegate (default DEFAULT_MAX_RECURSION_DEPTH = 2;
	 * also $HEADLESSCODE_MAX_RECURSION_DEPTH). See src/engine/loop.ts.
	 */
	maxRecursionDepth?: number
	/**
	 * Recursive task decomposition (`new_task`): a child's default
	 * maxIterations as a fraction of the parent's REMAINING iterations
	 * (default DEFAULT_CHILD_ITERATION_FRACTION = 0.5; also
	 * $HEADLESSCODE_CHILD_ITERATION_FRACTION). See src/engine/loop.ts.
	 */
	childIterationFraction?: number
	/**
	 * Hard cap on tokens the model may generate per LLM call (default
	 * DEFAULT_MAX_TOKENS = 32768; also $HEADLESSCODE_MAX_TOKENS). See
	 * src/engine/loop.ts.
	 */
	maxTokens?: number
	/** Sliding-window history cap, in messages (also see DEFAULT_WINDOW_SIZE in engine/loop.ts). */
	windowSize?: number
	/**
	 * Phase 3 context condensation: the model's real context window in
	 * tokens (default: live OpenRouter lookup, else
	 * DEFAULT_CONTEXT_WINDOW_TOKENS in src/engine/condense.ts).
	 */
	contextWindowTokens?: number
	/**
	 * Sampling temperature sent on every LLM call (default: 0 — fully
	 * deterministic/greedy). Exposed 2026-08-27 while investigating whether
	 * greedy decoding was a factor in local-model task failures — there was
	 * previously no way to override this at all.
	 */
	temperature?: number
	/**
	 * Phase 3 context condensation: fraction of the context window at which
	 * the oldest turns are condensed (default
	 * DEFAULT_CONDENSE_THRESHOLD_FRACTION in src/engine/condense.ts).
	 */
	condenseThreshold?: number
	/**
	 * Async/background condensation: fraction of the context window at which
	 * the condensation LLM call fires EARLY in the background (default
	 * DEFAULT_CONDENSE_EARLY_FIRE_FRACTION in src/engine/condense.ts). Must be
	 * below the hard `condenseThreshold`; when it isn't, the async path is off
	 * and only the synchronous hard-threshold path runs.
	 */
	condenseEarlyFire?: number
	/**
	 * Phase 3 context condensation: model id for the condensation call
	 * (default: the session model, or the `_condensation` key in
	 * .headlesscode/mode-models.json).
	 */
	condenseModel?: string
	/** Per-LLM-call abort timeout, ms (default: DEFAULT_LLM_TIMEOUT_MS in engine/loop.ts). */
	llmTimeoutMs?: number
	/**
	 * Streaming-and-reasoning: opt-in SSE streaming (default OFF — the
	 * blocking request path is unchanged). Also settable via
	 * $HEADLESSCODE_STREAM ("1"/"true"/"yes"/"on").
	 */
	stream: boolean
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
	/**
	 * OPT-IN local exploration phase (default OFF): a bounded, read-only local
	 * Ollama pass runs before the cloud model's first turn and folds its
	 * findings into a labeled synthetic message. Also settable via
	 * $HEADLESSCODE_LOCAL_EXPLORE. Experimental — see plans/local-explore-phase-experiment.md.
	 */
	localExplore: boolean
	/**
	 * switch_mode (plans/switch-mode-headless.md): opt-in auto-approval of
	 * in-place mode switches — OFF by default because the approval gate is the
	 * security boundary that keeps a restricted mode from silently granting
	 * itself a broader mode's permissions. Also settable via
	 * $HEADLESSCODE_AUTO_APPROVE_MODE_SWITCH.
	 */
	autoApproveModeSwitch: boolean
	/** switch_mode: hard cap on total in-place mode switches per session (default 5). */
	maxModeSwitches?: number
	/**
	 * Evidence-gated completion (fabrication fix, 2026-09-01): when set,
	 * attempt_completion is refused unless every machine-checkable claim in
	 * its result is independently verified against ground truth (file
	 * existence, real command re-runs, serial logs, git history — see
	 * src/engine/claims.ts). Default ON for the local code backend; this
	 * flag forces it on for cloud sessions too. Also settable via
	 * HEADLESSCODE_REQUIRE_EVIDENCE.
	 */
	requireEvidence: boolean
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
  headlesscode orchestrate status --repo <path> [--wait] [--timeout-ms <n>] [--json]
              Print a compact per-group status of a round, or block inside one
              call until every group is terminal (--wait) — replaces
              hand-rolled poll loops over the state file / harness.log. See
              \`npx tsx src/cli.ts orchestrate status --help\` for full options.
  headlesscode orchestrate stop --repo <path> --group <name> [--group <name> ...]
              Stop a group's worker COMPLETELY (whole process tree via
              scripts/stop-worker.sh — issue #20) and mark it needs-human. See
              \`npx tsx src/cli.ts orchestrate stop --help\` for full options.
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
  headlesscode trend --repo <path> [--repo <path> ...] [--port 4460]
              Serve a local, auto-refreshing page comparing multiple repos'
              cost-efficiency trends side by side (wasted-session tracking,
              cost/iteration vs. round-size correlation, rework rate). See
              \`npx tsx src/cli.ts trend --help\` for full options.
  headlesscode index --workspace <path> [--model <id>] [--embedding-backend <b>]
              Build/refresh the codebase semantic-search index for a workspace
              (used by the codebase_search tool). A separate, explicit step —
              never auto-triggered mid-session. --embedding-backend picks
              openrouter (default), ollama (local), or airunner (local
              AIRunner server). See \`npx tsx src/cli.ts index --help\` for
              full options.
  headlesscode codemap --workspace <path> [--force] [--watch] [--interval-ms <n>]
              Build/refresh a project's deterministic module/import map
              (codemap.json/codemap.lock/codemap.html in the central project
              store). No LLM anywhere in the pipeline; regeneration is
              fingerprint-aware (an unchanged repo writes nothing). --watch
              turns it into a long-running poll loop. See
              \`npx tsx src/cli.ts codemap --help\` for full options.
  headlesscode init --workspace <path> [--skip-index] [--skip-codemap]
              Register a new project in one step: resolves the central data
              dir, detects the stack(s) (drives per-session instruction
              selection), ensures .gitignore excludes .headlesscode/, then
              builds the codesearch index + codemap. See
              \`npx tsx src/cli.ts init --help\` for full options.
  headlesscode provision --installation-id <id> --owner <o> --repo <r> --target <dir>
              Clone a GitHub repo the App installation can access into a local
              dir (token stripped from the remote URL), ready as a
              --workspace value. Also --list-repos <id>. See
              \`npx tsx src/cli.ts provision --help\` for full options.
  headlesscode push-pr --installation-id <id> --owner <o> --repo <r> \\
              --local-dir <path> --branch <name> --title <title> --body <text> [--base <branch>]
              Push a local branch to a GitHub repo with the App installation
              token (token scrubbed from .git/config immediately), then open
              a pull request from it — never to the repo's default branch,
              never auto-merged. See
              \`npx tsx src/cli.ts push-pr --help\` for full options.
  headlesscode decision-proxy --workspace <path> [--task <text>] [--task-file <path>]
              OPT-IN (HEADLESSCODE_DECISION_PROXY=1) LLM stand-in for the
              human on ask_followup_question: watches <path> for
              .harness.needs-decision and answers via .harness.decision-answer,
              grounded in the session's ORIGINAL task text. Writes nothing
              when uncertain/errored — the existing timeout fallback fires
              as today. See \`npx tsx src/cli.ts decision-proxy --help\` for
              full options.
  headlesscode migrate [--workspace <path>]
              One-time central-store migrations: moves global shared
              instructions (~/.roo/) and the checkpoint store
              (~/.headlesscode/checkpoints) into ~/.local/share/headlesscode/,
              plus a workspace's legacy .headlesscode/ content (index,
              mode-models.json, permissions.json) into the central project
              store. Idempotent; each move is verified before the source is
              removed. See \`npx tsx src/cli.ts migrate --help\`.
  headlesscode projects list [--json] [--registered-only] [--stale] [--size]
              Enumerate the central per-project store as a table (or JSON),
              optionally filtered to registered/stale entries, with an
              opt-in size column. See
              \`npx tsx src/cli.ts projects list --help\` for full options.
  headlesscode projects prune [--dry-run] [--yes] [--include-registered]
              Reclaim orphaned store entries (missing paths that were never
              registered, plus pre-registry no-project.json litter). Never
              deletes a registered project without --include-registered; the
              escape hatch for a deleted repo / unmounted drive. See
              \`npx tsx src/cli.ts projects prune --help\` for full options.

Options:
  --mode <slug>              Mode to run in (built-in or from .roomodes). Default: code
  --task <text>              The task description for the agent
  --task-file <path>         Read the task from a file (relative to workspace)
  --workspace <root>         Workspace root (default: $HEADLESSCODE_WORKSPACE_ROOT or cwd)
  --session-id <id>          Explicit session id override (default: a fresh UUID).
                             Used by the dashboard's session-launch endpoint so
                             the browser can open the session's event view
                             immediately; rarely needed from a terminal.
  --model <id>               OpenRouter model id (default: $OPENROUTER_MODEL or deepseek/deepseek-v4-flash-0731)
  --max-iterations <n>       Loop iteration cap (default: 250 — see DEFAULT_MAX_ITERATIONS
                               in src/engine/loop.ts)
  --max-recursion-depth <n>  Recursive task decomposition (new_task): hard cap
                               on how deep one root session may delegate
                               (default: 2 = root → child → grandchild; a
                               deeper new_task call is refused as a normal
                               tool error). Default:
                               $HEADLESSCODE_MAX_RECURSION_DEPTH
  --child-iteration-fraction <f>  Recursive task decomposition: a child's
                               default maxIterations as a fraction of the
                               parent's REMAINING iterations (default: 0.5,
                               floor 3 — a child never exceeds what its parent
                               has left). Default:
                               $HEADLESSCODE_CHILD_ITERATION_FRACTION
  --max-tokens <n>           Hard cap on tokens the model may generate per LLM
                               call (default: 32768 — see DEFAULT_MAX_TOKENS in
                               src/engine/loop.ts). Default: $HEADLESSCODE_MAX_TOKENS
  --consecutive-error-limit <n>  Consecutive mistakes before giving up (default: 3,
                               or 6 for the local code-mode backend — see cli.ts's
                               DEFAULT_LOCAL_CONSECUTIVE_ERROR_LIMIT)
  --window-size <n>          Sliding-window history cap, in messages, before the
                             oldest are evicted (default: 300; see DEFAULT_WINDOW_SIZE
                             in src/engine/loop.ts for why)
  --temperature <f>          Sampling temperature, 0-2 (default: 0 — fully deterministic/
                             greedy; every LLM call uses this, no per-role override)
  --context-window <n>       Phase 3 context condensation: the model's real context
                             window in tokens (default: live OpenRouter lookup, else
                             128000, or 40960 for the local code-mode backend — see
                             DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS in cli.ts and
                             DEFAULT_CONTEXT_WINDOW_TOKENS in src/engine/condense.ts;
                             override with $HEADLESSCODE_CODE_MODE_CONTEXT_WINDOW)
  --condense-threshold <f>   Phase 3 context condensation: fraction of the context
                             window at which the oldest turns are condensed into one
                             summary (default: 0.75, or 0.92 for the local code-mode
                             backend — see cli.ts's LOCAL_CONDENSE_THRESHOLD_FRACTION;
                             must be between 0 and 1)
  --condense-early-fire <f>  Async condensation: fraction of the context window at
                             which the condensation LLM call fires EARLY, in the
                             background against a snapshot, while the loop keeps
                             running (default: 0.6, provisional; DISABLED for the
                             local code-mode backend — a second concurrent call
                             against a single locally-loaded model has no latency to
                             hide and only adds GPU contention — must be below
                             --condense-threshold or the async path is off)
  --condense-model <id>      Phase 3 context condensation: model id for the
                             condensation call (default: the session model, or the
                             _condensation key in .headlesscode/mode-models.json)
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
  --stream                   Opt-in SSE streaming (streaming-and-reasoning):
                              stream token/reasoning deltas and emit
                              llm_stream_chunk events for live-typing view.
                              Default: OFF (blocking requests unchanged).
                              Also settable via $HEADLESSCODE_STREAM
  --local-explore            OPT-IN local exploration phase (experimental,
                               default OFF): run a bounded, strictly read-only
                               local Ollama pass (qwen3.5:9b — read_file +
                               list_files only) before the cloud model's first
                               turn and fold its findings into the cloud
                               context as a labeled synthetic message. Fails
                               open to cloud-only on any local error. Also
                               settable via $HEADLESSCODE_LOCAL_EXPLORE
  --auto-approve-mode-switch switch_mode: auto-approve in-place mode switches
                               WITHOUT escalating to a human/orchestrator.
                               OFF by default — the approval gate is the
                               security boundary that keeps a restricted mode
                               (e.g. architect, read+md-only) from silently
                               granting itself a broader mode's edit
                               permissions. Also settable via
                               $HEADLESSCODE_AUTO_APPROVE_MODE_SWITCH
  --require-evidence          Evidence-gated completion (fabrication fix):
                               refuse attempt_completion unless every
                               machine-checkable claim in its result is
                               independently verified against ground truth
                               (file existence, real command re-runs, serial
                               logs, git history). Default ON for the local
                               code backend; this forces it on for cloud
                               sessions too. Also settable via
                               $HEADLESSCODE_REQUIRE_EVIDENCE
  --max-mode-switches <n>    switch_mode: hard cap on total in-place mode
                               switches per session (default: 5 — see
                               DEFAULT_MAX_MODE_SWITCHES in src/engine/loop.ts).
                               Also settable via
                               $HEADLESSCODE_MAX_MODE_SWITCHES
  --version                  Print version and exit
  --help                     Show this help and exit

Environment:
  HEADLESSCODE_OPENROUTER_API_KEY         Required (except --dry-run)
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
  HEADLESSCODE_MAX_RECURSION_DEPTH    Default --max-recursion-depth (positive int)
  HEADLESSCODE_CHILD_ITERATION_FRACTION  Default --child-iteration-fraction (0 < f <= 1)
  HEADLESSCODE_MAX_TOKENS      Default --max-tokens (positive int)
  HEADLESSCODE_STREAM          Opt-in SSE streaming ("1"/"true"/"yes"/"on")
  HEADLESSCODE_LOCAL_EXPLORE   Opt-in local exploration phase ("1"/"true")
  HEADLESSCODE_AUTO_APPROVE_MODE_SWITCH  Auto-approve switch_mode calls ("1"/"true"/"yes"/"on")
  HEADLESSCODE_REQUIRE_EVIDENCE  Force evidence-gated completion ("1"/"true"/"yes"/"on")
  HEADLESSCODE_MAX_MODE_SWITCHES      switch_mode: hard cap on total in-place
                               mode switches per session (positive int)
  HEADLESSCODE_LOCAL_EXPLORE_MODEL    Local model (default qwen3.5:9b)
  HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS  Iteration cap (default 15)
  HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS   Context-token budget (default 131072)
  HEADLESSCODE_LOCAL_EXPLORE_TIMEOUT_MS       Per-call timeout ms (default 120000)
  HEADLESSCODE_OLLAMA_URL      Ollama base URL (default http://localhost:11434)
  HEADLESSCODE_DECISION_PROXY   Opt-in decision-proxy agent ("1"/"true") — an
                                LLM stand-in for the human on
                                ask_followup_question (headlesscode
                                decision-proxy subcommand; see
                                plans/decision-proxy-agent.md)
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
		stream: false,
		localExplore: false,
		autoApproveModeSwitch: false,
		requireEvidence: false,
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
			case "--session-id":
			case "--require-artifact-path":
			case "--require-artifact-sections": {
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
					case "--require-artifact-path":
						options.requireArtifactPath = value
						break
					case "--require-artifact-sections":
						options.requireArtifactSections = value
							.split("|")
							.map((s) => s.trim())
							.filter(Boolean)
						break
				}
				break
			}
			case "--max-iterations":
			case "--consecutive-error-limit":
			case "--window-size":
			case "--context-window":
			case "--llm-timeout-ms":
			case "--max-recursion-depth":
			case "--max-mode-switches":
			case "--max-tokens":
			case "--require-artifact-min-citations": {
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
				} else if (flag === "--context-window") {
					options.contextWindowTokens = num
				} else if (flag === "--max-recursion-depth") {
					options.maxRecursionDepth = num
				} else if (flag === "--max-mode-switches") {
					options.maxModeSwitches = num
				} else if (flag === "--max-tokens") {
					options.maxTokens = num
				} else if (flag === "--require-artifact-min-citations") {
					options.requireArtifactMinCitations = num
				} else {
					options.llmTimeoutMs = num
				}
				break
			}
			case "--child-iteration-fraction": {
				const value = next()
				const num = value === undefined ? Number.NaN : Number(value)
				if (!Number.isFinite(num) || num <= 0 || num > 1) {
					return { options, error: "--child-iteration-fraction requires a fraction between 0 and 1 (e.g. 0.5)" }
				}
				options.childIterationFraction = num
				break
			}
			case "--temperature": {
				const value = next()
				const num = value === undefined ? Number.NaN : Number(value)
				if (!Number.isFinite(num) || num < 0 || num > 2) {
					return { options, error: "--temperature requires a number between 0 and 2 (e.g. 0.3)" }
				}
				options.temperature = num
				break
			}
			case "--condense-threshold": {
				const value = next()
				const num = value === undefined ? Number.NaN : Number(value)
				if (!Number.isFinite(num) || num <= 0 || num >= 1) {
					return { options, error: "--condense-threshold requires a fraction between 0 and 1 (e.g. 0.75)" }
				}
				options.condenseThreshold = num
				break
			}
			case "--condense-early-fire": {
				const value = next()
				const num = value === undefined ? Number.NaN : Number(value)
				if (!Number.isFinite(num) || num <= 0 || num >= 1) {
					return { options, error: "--condense-early-fire requires a fraction between 0 and 1 (e.g. 0.6)" }
				}
				options.condenseEarlyFire = num
				break
			}
			case "--condense-model": {
				const value = next()
				if (value === undefined) {
					return { options, error: "Missing value for --condense-model" }
				}
				options.condenseModel = value
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
			case "--stream":
				options.stream = true
				break
			case "--local-explore":
				options.localExplore = true
				break
			case "--auto-approve-mode-switch":
				options.autoApproveModeSwitch = true
				break
			case "--require-evidence":
				options.requireEvidence = true
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

	// Issue #148 subcommand: `headlesscode pipeline ...` — run the stage-
	// isolated research→filing pipeline (each stage a fresh session taking the
	// prior stage's artifact as input).
	if (argv[0] === "pipeline") {
		const { pipelineMain } = await import("./orchestrator/cli.js")
		return pipelineMain(argv.slice(1))
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

	// Cross-repo cost-efficiency trend subcommand: `headlesscode trend ...` —
	// a local, auto-refreshing page comparing multiple repos' cost-history
	// side by side (see src/dashboard/trend.ts). Distinct from `dashboard`'s
	// single-repo "Cost history" section: reads live on every request, no
	// cached snapshot.
	if (argv[0] === "trend") {
		return trendMain(argv.slice(1))
	}

	// Codebase semantic-search index subcommand: `headlesscode index ...` —
	// build/refresh <workspace>/.headlesscode/codesearch/index.jsonl for the
	// codebase_search tool (see src/codesearch/). A separate, EXPLICIT step —
	// never auto-triggered mid-session (it costs real money and takes time).
	if (argv[0] === "index") {
		return indexMain(argv.slice(1))
	}

	// Deterministic per-project codemap subcommand: `headlesscode codemap ...` —
	// generate the module/import map (codemap.json/codemap.lock/codemap.html)
	// into the central project store; `--watch` becomes a long-running poll
	// loop (see src/codemap/ + docs/codemap.md). No LLM anywhere in the
	// pipeline — mechanical, deterministic, cheap to regenerate.
	if (argv[0] === "codemap") {
		return codemapMain(argv.slice(1))
	}

	// One-command project registration subcommand: `headlesscode init ...` —
	// resolve central data dir + detect stacks + ensure .gitignore excludes
	// .headlesscode/ + build index + codemap in one step (see src/init/).
	if (argv[0] === "init") {
		return initMain(argv.slice(1))
	}

	// GitHub App repo provisioning subcommand: `headlesscode provision ...` —
	// clone a repo the App installation can access into a local dir (token
	// stripped from the remote), ready as a --workspace value. Also
	// `--list-repos <id>` (see src/github/cli.ts + docs/github-app-setup.md).
	if (argv[0] === "provision") {
		return provisionMain(argv.slice(1))
	}

	// GitHub push-back subcommand: `headlesscode push-pr ...` — push a local
	// branch to a repo the App installation can access (token scrubbed from
	// .git/config immediately), then open a PR from it. The "write" half of
	// provisioning (see src/github/cli.ts + docs/github-app-setup.md).
	if (argv[0] === "push-pr") {
		return pushPrMain(argv.slice(1))
	}

	// Decision-proxy subcommand: `headlesscode decision-proxy ...` — an
	// OPT-IN (HEADLESSCODE_DECISION_PROXY=1) LLM stand-in for the human on
	// ask_followup_question. Watches a workspace for .harness.needs-decision
	// and writes .harness.decision-answer grounded in the session's original
	// task text (see src/decision-proxy/ + plans/decision-proxy-agent.md).
	if (argv[0] === "decision-proxy") {
		return decisionProxyMain(argv.slice(1))
	}

	// Migration subcommand: `headlesscode migrate ...` — the explicit,
	// human-triggered version of the one-time central-store migrations
	// (shared instructions, checkpoint store, legacy workspace
	// `.headlesscode/`). See src/migrate/ + src/project-store.ts.
	if (argv[0] === "migrate") {
		return migrateMain(argv.slice(1))
	}

	// Ad-hoc session log analysis: `headlesscode analyze-worktree ...` — the
	// orchestrator already runs this automatically per group (see
	// src/orchestrator/log-analysis.ts + cli.ts's onGroupUpdate); this
	// subcommand lets a human point it at any worktree by hand.
	if (argv[0] === "analyze-worktree") {
		return analyzeCliMain(argv.slice(1))
	}

	// Cost/token history: `headlesscode cost-history ...` — read-side for
	// the mandatory, automatic recording in watch.ts (recordCostIfTerminal).
	if (argv[0] === "cost-history") {
		return costHistoryCliMain(argv.slice(1))
	}

	// Central-store project registry: `headlesscode projects ...` — enumerate
	// (`list`) and reclaim (`prune`) the central per-project store
	// (~/.local/share/headlesscode/projects/; see src/projects/ + src/project-store.ts).
	if (argv[0] === "projects") {
		return projectsMain(argv.slice(1))
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

	// Silent-death observability (issue #150): live-verified 2026-08-21
	// (twice, across two different models) that this process can disappear
	// entirely mid-run — no exit code, no error log, no trace, not even the
	// wrapping shell's own `echo "exited with code $?"`. Confirmed via
	// `grep -rn` across this file and loop.ts before this fix: zero
	// process-level handlers existed for any of these events. Logger.error/
	// warn write via fs.appendFileSync (synchronous — see logger.ts), so
	// these are safe to call immediately before process.exit without an
	// async flush race. This does NOT catch SIGKILL (uncatchable by
	// definition — the suspected OOM-kill case in #150 may still be
	// SIGKILL, not SIGTERM) or a hard crash inside a native addon, but it
	// closes every JS-level silent-exit path: an uncaught throw, a rejected
	// promise nobody awaited, or a graceful termination request.
	process.on("uncaughtException", (err) => {
		logger.error("[cli] uncaughtException — process terminating", {
			message: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		})
		process.exit(3)
	})
	process.on("unhandledRejection", (reason) => {
		logger.error("[cli] unhandledRejection — process terminating", {
			reason:
				reason instanceof Error
					? (reason.stack ?? reason.message)
					: (() => {
							try {
								return JSON.stringify(reason)
							} catch {
								return String(reason)
							}
						})(),
		})
		process.exit(3)
	})
	process.on("SIGTERM", () => {
		logger.warn("[cli] SIGTERM received — process terminating", {
			rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
		})
		process.exit(143)
	})
	// Cheap postmortem diagnostic for the #150 OOM hypothesis (unconfirmed —
	// dmesg showed no OOM-killer entries when checked live, but access may
	// have been permission-limited): RSS at session start costs one log
	// line and needs no periodic timer, unlike full memory-pressure polling.
	logger.info("[cli] session process started", {
		pid: process.pid,
		rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
	})

	// Fresh-session memory trap (issue #138): every `npx tsx src/cli.ts`
	// invocation is a COMPLETELY fresh process with zero memory of any
	// prior invocation's model reads/edits, even against the same
	// --workspace and --task-file. A task file written/edited across a
	// restart can easily (and wrongly) claim "you already read X, don't
	// re-read it" — live-verified 2026-08-21: a local model trusted
	// exactly that kind of false claim and hallucinated a plausible-but-
	// wrong edit_file call from the claim alone. Cheapest mitigation (the
	// issue's own "direction 1"): a marker file this process itself
	// writes/updates on every run against a workspace, so the NEXT
	// invocation can print a loud, impossible-to-miss note when one
	// existed already. Doesn't stop a bad task file from lying — makes
	// the failure mode visible in the log for whoever's supervising.
	// Scoped to --task-file specifically: the trap is about a task file's
	// own false claims, not sessions in general.
	if (options.taskFile) {
		const markerPath = path.join(workspaceRoot, ".headlesscode", "last-session.json")
		try {
			const prior = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as {
				sessionId?: string
				taskFile?: string
				startedAt?: string
			}
			logger.warn(
				"[cli] NOTE: this is a FRESH process with ZERO memory of any prior run against this workspace, even if the task file references one",
				{
					priorSessionId: prior.sessionId,
					priorTaskFile: prior.taskFile,
					priorStartedAt: prior.startedAt,
					guidance:
						"If the task file claims you already read/did something in an earlier turn, that claim is about a DIFFERENT process — verify everything yourself before acting on it.",
				},
			)
		} catch {
			// No marker (first run against this workspace) or unreadable/
			// corrupt — either way, nothing to warn about, proceed silently.
		}
		try {
			fs.mkdirSync(path.join(workspaceRoot, ".headlesscode"), { recursive: true })
			fs.writeFileSync(
				markerPath,
				JSON.stringify({ sessionId: options.sessionId, taskFile: options.taskFile, startedAt: new Date().toISOString() }),
				"utf-8",
			)
		} catch (err) {
			// Non-fatal: the marker is a best-effort diagnostic, never a
			// reason to abort a real session over a write failure.
			logger.warn("[cli] failed to write last-session marker (non-fatal)", { error: String(err) })
		}
	}

	// ── dry-run: no API key required ──────────────────────────────────────────
	if (options.dryRun) {
		try {
			const customModes = await loadCustomModes(workspaceRoot)
			const built = await buildSystemPrompt({
				workspaceRoot,
				mode: options.mode,
				customModes,
			})
			// Dry-run advertises the same non-vendored tools a real session
			// appends (code-intelligence + describe_image; browser_action is
			// deliberately omitted here — the loop appends it, but this
			// listing is a prompt/config check, not a live session).
			const tools = appendCodeIntelTools(
				appendDescribeImageTool(selectToolsForMode(options.mode, customModes)),
			)
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
			// Reasoning effort (issue #30): resolved + validated here too so
			// --dry-run catches a bad value (e.g. a typo in the env var or
			// mode-models.json `_reasoning_effort` key) BEFORE the experiment
			// burns any real LLM calls. A throw lands in the catch below.
			const dryRunEffort = resolveReasoningEffortForMode({ workspaceRoot, env: process.env })
			parseReasoningEffort(dryRunEffort)

			process.stdout.write(built.prompt + "\n")
			process.stdout.write(
				`\n───── dry-run summary ─────\n` +
					`mode:             ${options.mode}\n` +
					`model:            ${dryRunModel ?? "deepseek/deepseek-v4-flash-0731 (client default)"}\n` +
					`reasoning effort: ${dryRunEffort ?? "(unset — endpoint default)"}\n` +
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
	const apiKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY
	if (!apiKey) {
		process.stderr.write(
			"headlesscode: HEADLESSCODE_OPENROUTER_API_KEY is not set.\n" +
				"  Export it (e.g. export HEADLESSCODE_OPENROUTER_API_KEY=sk-or-...) or use --dry-run to\n" +
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

	// Generalized 2026-08-21 (issue #142) beyond the original `code`-only
	// scope (plans/local-dual-model-code-agent.md, D2) — real need: two
	// separate local daemons on two different GPUs (a coder model and a
	// review model), each needing its own mode -> URL/model mapping.
	// HEADLESSCODE_LOCAL_BACKEND_MODES defaults to "code" alone, so
	// nobody's existing setup changes behavior unless they opt in.
	const codeModeBackend = process.env.HEADLESSCODE_CODE_MODE_BACKEND ?? "openrouter"
	const localBackendModes = new Set(
		(process.env.HEADLESSCODE_LOCAL_BACKEND_MODES ?? "code")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	)
	const useLocalCodeBackend = localBackendModes.has(options.mode) && codeModeBackend === "ollama"

	// The local daemon's own proxy (ollama_shim.py) deliberately runs a 600s
	// upstream request timeout — its own comment documents why: a shorter
	// shim timeout was once found to cut off calls before the harness's own
	// timeout would have. That fix only holds if the harness's own timeout
	// is longer than the shim's. Two SEPARATE timeout mechanisms need this:
	// loop.ts's llmTimeoutMs-driven AbortControllers (used below via
	// `llmTimeoutMs`), and OllamaClient's own independent abort timer
	// (ollama.ts's DEFAULT_OLLAMA_TIMEOUT_MS, passed as `timeoutMs` to the
	// constructor just below) — a 2026-08-20 comment on that constructor
	// call already documents discovering the SAME two-timeout trap for a
	// different reason (`--llm-timeout-ms` being silently ignored). Verified
	// live 2026-08-28: with the loop-level timeout alone raised to 630s, a
	// session still died at exactly 300000ms — OllamaClient's own timer
	// fired first every time since it was never told about the override.
	// Resolved here (before both consumers) so neither can silently fall
	// back to the wrong default the way the other already did once.
	const LOCAL_LLM_TIMEOUT_MS = 630_000
	const llmTimeoutMs = options.llmTimeoutMs ?? (useLocalCodeBackend ? LOCAL_LLM_TIMEOUT_MS : undefined)

	// Issue #139 (updated for #142): warn whenever the local backend was
	// requested via env var but the CURRENT mode isn't in the allow-list
	// — was hardcoded to "code", now checks the real list.
	if (codeModeBackend === "ollama" && !localBackendModes.has(options.mode)) {
		process.stderr.write(
			`[headlesscode] NOTE: HEADLESSCODE_CODE_MODE_BACKEND=ollama is set, but --mode "${options.mode}" is not in HEADLESSCODE_LOCAL_BACKEND_MODES ("${[...localBackendModes].join(",")}") — this session will use the cloud OpenRouter model instead.\n`,
		)
	}
	// When the local backend is selected, every downstream consumer of
	// `model` (session-start logs, event-feed session_start, cost/usage
	// records, and — critically — the `request.model` sent on each
	// OllamaClient call, since OllamaClient.resolveModel() prefers a
	// non-empty request.model over its own defaultModel) must see the
	// LOCAL model id, not the OpenRouter-resolved one. Without this,
	// local sessions were tagged and logged as
	// e.g. "deepseek/deepseek-v4-flash-0731" throughout — cosmetic for
	// generation itself (the local daemon ignores the model string and
	// serves whatever GGUF is loaded) but wrong everywhere the model id
	// is recorded or reported (verified live 2026-08-21: session_start
	// logged the cloud model id while actually running against the
	// local Ollama daemon).
	const effectiveModel = useLocalCodeBackend
		? (resolvePerModeEnv("HEADLESSCODE_CODE_MODE_MODEL", options.mode) ?? model)
		: model
	const client: LlmClient = useLocalCodeBackend
		? new OllamaClient({
				defaultModel: effectiveModel,
				// Issue #142: per-mode URL override (e.g. a review daemon on a
				// different GPU than the code daemon) — falls back to the
				// existing global HEADLESSCODE_OLLAMA_URL, then OllamaClient's
				// own DEFAULT_OLLAMA_URL, when neither is set.
				baseUrl: resolvePerModeEnv("HEADLESSCODE_OLLAMA_URL", options.mode),
				// Without this, --llm-timeout-ms is silently ignored for the
				// Ollama backend: OllamaClient has its own independent abort
				// timer (ollama.ts's DEFAULT_OLLAMA_TIMEOUT_MS), separate
				// from loop.ts's llmTimeoutMs-driven AbortControllers —
				// verified live 2026-08-20: a trial dispatched with
				// --llm-timeout-ms 900000 still aborted at exactly 300000ms
				// because this constructor call never forwarded the option.
				// `llmTimeoutMs` (not `options.llmTimeoutMs`) so the local-
				// backend default resolved above reaches this timer too —
				// verified live 2026-08-28: passing the raw option alone
				// left this at the generic 300s default for every session
				// that didn't explicitly pass --llm-timeout-ms.
				timeoutMs: llmTimeoutMs,
			})
		: new OpenRouterClient({ apiKey, defaultModel: model })
	// A small local model's context is dominated by the full tool catalog
	// (see src/engine/lazy-tools.ts) — default lazy loading ON for local
	// sessions specifically, without touching the cloud path's prompt-cache-
	// friendly static catalog. An explicit env value always wins.
	if (useLocalCodeBackend && process.env.HEADLESSCODE_LAZY_TOOL_CATALOG === undefined) {
		process.env.HEADLESSCODE_LAZY_TOOL_CATALOG = "1"
	}
	// Same rationale (src/engine/prompt.ts's buildLeanSystemPrompt doc comment):
	// the vendored system prompt alone is ~9.5K tokens, GUI-oriented content a
	// headless local session doesn't need. Default on for local, off for cloud.
	if (useLocalCodeBackend && process.env.HEADLESSCODE_LEAN_SYSTEM_PROMPT === undefined) {
		process.env.HEADLESSCODE_LEAN_SYSTEM_PROMPT = "1"
	}
	// A local model that gives up mid-task and dumps prose was observed live
	// (2026-08-19 baseline run) getting recorded as `session succeeded` with
	// zero files touched — the bare-text-reply pragmatic-success fallback
	// (loop.ts, HeadlessSessionConfig.requireExplicitCompletion) exists for
	// cloud models that reliably signal completion through prose; a local
	// session can't trust that signal, so require attempt_completion instead.
	const requireExplicitCompletion =
		useLocalCodeBackend && !envBoolean("HEADLESSCODE_ALLOW_TEXT_ONLY_COMPLETION")
	// Works around a llama.cpp/llama-cpp-python grammar-constrained-decoding
	// bug (ggml-org/llama.cpp#20164) that corrupts tool calls when a
	// multi-parameter tool has any optional parameter — verified live
	// 2026-08-20 against Qwen2.5-Coder-14B (edit_file failed 3/3 on an
	// existing file; write_to_file, which has zero optional params,
	// succeeded every time). See prompt.ts's
	// patchEditFileToolForLocalModels doc comment. Cloud sessions aren't
	// grammar-constrained this way, so this only applies to the local
	// backend.
	const patchLocalToolSchemas =
		useLocalCodeBackend && !envBoolean("HEADLESSCODE_ALLOW_UNPATCHED_LOCAL_TOOL_SCHEMAS")
	// A local model was observed calling attempt_completion for real and
	// claiming success (e.g. "typecheck and tests passed") while the last
	// execute_command it actually ran was still failing, never re-verifying
	// in between (verified live 2026-08-20 against both Qwen2.5-Coder-14B
	// and Qwen3-14B). requireExplicitCompletion above only catches a
	// text-only non-call; this catches a real completion call whose claim
	// the session's own last command result already contradicts. See
	// loop.ts's HeadlessSessionConfig.verifyBeforeCompletion doc comment.
	const verifyBeforeCompletion =
		useLocalCodeBackend && !envBoolean("HEADLESSCODE_ALLOW_UNVERIFIED_COMPLETION")
	// Evidence-gated completion (fabrication fix, 2026-09-01): when on,
	// attempt_completion is refused unless every machine-checkable claim in
	// its result (a file exists, a specific command passed, serial markers
	// appear, a PR exists) is independently verified against ground truth —
	// the real filesystem, a real re-run of the exact command, the newest
	// serial log, and real git history (see src/engine/claims.ts). This is
	// the structural backstop for the FINAL_REPORT's central finding (§4): a
	// session claimed "all three hard gates pass" with a fabricated serial
	// excerpt when the driver was never merged and the claimed target didn't
	// exist. Default ON for the local code backend (the finetune harness and
	// real acceptance gates run local) unless explicitly disabled via
	// HEADLESSCODE_ALLOW_UNVERIFIED_COMPLETION (same opt-in-override pattern
	// as verifyBeforeCompletion); explicitly forceable via --require-evidence
	// OR HEADLESSCODE_REQUIRE_EVIDENCE for cloud sessions too (the pure
	// resolver also honors the env var — see resolveEvidenceRequiredCompletion).
	const evidenceRequiredCompletion = resolveEvidenceRequiredCompletion(
		options.requireEvidence,
		process.env,
		useLocalCodeBackend,
	)
	// A local (Qwen3.5-9B) session was observed live 2026-08-27 doing the
	// actual work correctly (a real, correct edit_file call) and then dying
	// anyway: its first attempt_completion was deferred (a prior
	// execute_command had failed), its next two execute_command retries
	// ALSO failed (nested-quote shell one-liners it wrote — a
	// jsonEscapingNote-class mistake, see prompt.ts — that ran fine when
	// re-run by hand outside the harness), and by the time it gave up and
	// wrote a prose explanation instead of retrying attempt_completion, that
	// was already its 3rd consecutive mistake — DEFAULT_CONSECUTIVE_ERROR_LIMIT
	// (3) counts tool errors and non-completing replies on the SAME counter,
	// so two ordinary tool mistakes leave a local model exactly one strike
	// from a hard stop even when the underlying task is already done. Cloud
	// models haven't shown this failure shape (see prompt.ts's jsonEscapingNote
	// doc comment — that failure was Qwen3-14B-specific too), so this is
	// scoped to the local backend only, same opt-in-override pattern as the
	// flags above. DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD (2) only needs to
	// stay strictly below this value (see its own doc comment) — 6 leaves
	// that comfortably true.
	const DEFAULT_LOCAL_CONSECUTIVE_ERROR_LIMIT = 6
	const consecutiveErrorLimit =
		options.consecutiveErrorLimit ??
		(useLocalCodeBackend ? DEFAULT_LOCAL_CONSECUTIVE_ERROR_LIMIT : undefined)
	// Issue #144: local inference is free — a fabricated dollar figure in
	// every log line is noise at best, misleading at worst.
	const trackCost = !useLocalCodeBackend || envBoolean("HEADLESSCODE_FORCE_COST_TRACKING")
	// Issue #143: unlike verifyBeforeCompletion above, this must NOT apply
	// to every useLocalCodeBackend mode — deepseek-reviewer/qa-agent are
	// read-only and their correct completion is often "read the files,
	// verdict: clean" with zero write/execute calls. Scoped to an explicit
	// allow-list (default: code + the orchestrator meta-mode, both of
	// which are expected to actually change something or file something
	// real), same opt-in pattern as HEADLESSCODE_LOCAL_BACKEND_MODES.
	const artifactRequiredModes = new Set(
		(process.env.HEADLESSCODE_REQUIRE_ARTIFACT_MODES ?? "code,multi-agent-orchestrator-headless")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	)
	const requireArtifactBeforeCompletion =
		useLocalCodeBackend &&
		artifactRequiredModes.has(options.mode) &&
		!envBoolean("HEADLESSCODE_ALLOW_UNVERIFIED_COMPLETION")
	// A local model was observed regenerating an entire existing ~500-line
	// file from scratch via write_to_file for a one-function-add task
	// instead of a targeted diff, getting cut off mid-regeneration and
	// silently destroying everything after the cutoff (verified live
	// 2026-08-20 against both Qwen2.5-Coder-14B and Qwen3-14B, reproduced
	// with a synthetic request bypassing headlesscode entirely — see
	// plans/local-dual-model-code-agent-PROMPT-2026-08-20.md, "Tonight's
	// core finding"). See loop.ts's HeadlessSessionConfig.guardLargeOverwrites
	// doc comment and executor.ts's largeOverwriteRefusal.
	const guardLargeOverwrites =
		useLocalCodeBackend && !envBoolean("HEADLESSCODE_ALLOW_UNGUARDED_OVERWRITES")
	// 2026-09-02: real, confirmed, live-observed failure -- the read_file/
	// list_files session cache's "[cache] unchanged, reuse the earlier
	// result" short-circuit (src/tools/executor.ts) saves real token cost
	// against a remote model's per-token bill, but against the local
	// backend it directly produced a fabricated attempt_completion: an
	// edit_file failure told a session to re-read and retry, it DID call
	// read_file again exactly as instructed, got the cache-hit notice
	// instead of real content, never made the SECOND identical call that
	// would have returned real content again (the mechanism's own safety
	// valve), and gave up with a false success claim instead. See loop.ts's
	// HeadlessSessionConfig.disableReadFileCache doc comment.
	const disableReadFileCache =
		useLocalCodeBackend && !envBoolean("HEADLESSCODE_ALLOW_READ_FILE_CACHE_HIT")
	// The cloud-tuned condensation defaults (0.75 hard threshold, 0.6 early-fire
	// — see condense.ts) were measured firing needlessly aggressively against a
	// local model: a trial condensing at 38 messages against a 16384-token
	// --context-window left most of the daemon's real n_ctx unused (verified
	// live 2026-08-20 — see plans/local-dual-model-code-agent-PROMPT-2026-08-21.md,
	// "Why is condensation firing so heavily"). Two local-only changes, an
	// explicit --condense-threshold/--condense-early-fire flag always wins:
	// (1) the hard threshold moves from 0.75 to 0.92 — condense only once the
	// session is genuinely close to the real limit, not at 3/4 of it; (2) the
	// early-fire background path (designed to hide a CLOUD provider's
	// condensation-call latency behind the main loop) is disabled outright —
	// against a single locally-loaded model it just fires a second concurrent
	// generation request competing with the main loop for the same GPU, with
	// no latency to hide. Disabling it is `earlyFire === hardThreshold`
	// (fireBackgroundCondense's own off-switch, see loop.ts).
	const LOCAL_CONDENSE_THRESHOLD_FRACTION = 0.92
	const condenseThresholdFraction =
		options.condenseThreshold ?? (useLocalCodeBackend ? LOCAL_CONDENSE_THRESHOLD_FRACTION : undefined)
	const condenseEarlyFireFraction =
		options.condenseEarlyFire ?? (useLocalCodeBackend ? LOCAL_CONDENSE_THRESHOLD_FRACTION : undefined)
	// A local (Qwen3.5-9B+LoRA) condensation call was observed live
	// 2026-08-28 turning a correctly-hedged note ("X is an existing gate,
	// for reference") into a flat false claim ("X passed, ready to merge")
	// for a feature the session never touched — a lossy ~13:1 compression
	// under CONDENSE_SYSTEM_PROMPT's "never invent content" rule is only as
	// reliable as the model executing it, and this one wasn't. The
	// corrupted summary then re-entered history as trusted fact and the
	// session repeated the false completion claim until bounded failure
	// killed it. See HeadlessSessionConfig.disableLlmCondensation's doc
	// comment (loop.ts) for the full tradeoff: local inference has no
	// per-token cost pressure, so summarization's risk (a fabricated "fact"
	// the model can't distinguish from a real one) isn't worth taking when
	// truncateHistory's plain drop-oldest eviction — which keeps running
	// either way — only ever loses information, never invents it.
	const disableLlmCondensation =
		useLocalCodeBackend && !envBoolean("HEADLESSCODE_ALLOW_LLM_CONDENSATION")

	// Phase 3 context condensation: a cheaper model for the condensation
	// call can be assigned via the `_condensation` key in
	// .headlesscode/mode-models.json (consulted BEFORE the mode entry —
	// its whole purpose is to override the session model for condensation,
	// so a file that sets both `code` and `_condensation` must use the
	// cheap model). An explicit --condense-model flag always wins; otherwise
	// the session model is used (same model = simplest, consistent quality).
	const condenseModel =
		options.condenseModel ??
		resolveModelForMode({
			workspaceRoot,
			mode: options.mode,
			explicitModel: undefined,
			extraKeys: ["_condensation"],
			env: process.env,
		})

	// loop.ts's resolveContextWindowTokens() live-queries the OpenRouter
	// catalog for the real context window and falls back to
	// DEFAULT_CONTEXT_WINDOW_TOKENS (128000) when that lookup fails or isn't
	// applicable — which is unconditional for the local backend (there's no
	// OpenRouter catalog entry for a locally-loaded GGUF). Verified live
	// 2026-08-27: the code-daemon's actual configured window
	// (AIRUNNER_GGUF_N_CTX, checked via `docker inspect`) is 40960, well
	// under the assumed 128000 — the opposite-direction version of the
	// condenseThresholdFraction incident above (that one was a too-SMALL
	// assumed window firing condensation too early; an unset context window
	// here is too LARGE, so condensation at 92% of a wrong 128000 would fire
	// at ~118000 tokens, past the real 40960 limit, risking a hard daemon
	// failure/silent truncation instead of a graceful condense). No session
	// observed tonight actually reached anywhere near 40960 real tokens, so
	// this didn't cause any of tonight's local-model failures — but it's a
	// real latent gap for any longer local session. Not auto-detectable (the
	// Ollama-compat API doesn't expose it), so a documented env default,
	// same override precedence as every other local-only default above.
	const DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS = 40960
	const localContextWindowTokens = Number(process.env.HEADLESSCODE_CODE_MODE_CONTEXT_WINDOW ?? DEFAULT_LOCAL_CONTEXT_WINDOW_TOKENS)
	const contextWindowTokens =
		options.contextWindowTokens ??
		(useLocalCodeBackend && Number.isFinite(localContextWindowTokens) && localContextWindowTokens > 0
			? localContextWindowTokens
			: undefined)

	// Graded reasoning effort for deepseek/* models (issue #30 experiment):
	// the `_reasoning_effort` key in mode-models.json beats
	// $HEADLESSCODE_REASONING_EFFORT. Deliberately NOT a CLI flag — the
	// experiment compares env/config values and a flag would be one more
	// surface to keep in sync. Validated here so a typo fails at startup
	// (exit 2) with a clear message instead of mid-session on the first LLM
	// call (fail-loudly, same idiom as mode-models.ts).
	const reasoningEffort = resolveReasoningEffortForMode({ workspaceRoot, env: process.env })
	try {
		parseReasoningEffort(reasoningEffort)
	} catch (err) {
		process.stderr.write(`headlesscode: ${err instanceof Error ? err.message : String(err)}\n`)
		return 2
	}

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

	// Recursive task decomposition (`new_task`): CLI flag wins over the env
	// fallback; undefined falls back to loop.ts's own defaults (depth 2 /
	// fraction 0.5). Passed through so children inherit the root's caps.
	const maxRecursionDepth = options.maxRecursionDepth ?? envNumber("HEADLESSCODE_MAX_RECURSION_DEPTH")
	const childIterationFraction =
		options.childIterationFraction ?? envNumber("HEADLESSCODE_CHILD_ITERATION_FRACTION")

	// switch_mode (plans/switch-mode-headless.md): the approval gate is OFF by
	// default. Flag wins over the env fallback
	// ($HEADLESSCODE_AUTO_APPROVE_MODE_SWITCH); undefined falls back to
	// loop.ts's own cap default (DEFAULT_MAX_MODE_SWITCHES = 5).
	const autoApproveModeSwitch =
		options.autoApproveModeSwitch || envBoolean("HEADLESSCODE_AUTO_APPROVE_MODE_SWITCH")
	const maxModeSwitches = options.maxModeSwitches ?? envNumber("HEADLESSCODE_MAX_MODE_SWITCHES")

	// Flag wins over the env fallback; undefined falls back to loop.ts's own
	// default (DEFAULT_MAX_TOKENS = 32768) — sized for a CLOUD reasoning
	// model against a 128K+ context window (4x the heaviest real generation
	// observed there, ~8,000 tokens). Verified live 2026-08-28 (joeos issue
	// #26): applied unchanged to the local backend, this let a single
	// generation run to 29,664 output tokens — on a real llama-server
	// context window of only 65,536 total, that alone pushed the very next
	// request to 65,657 tokens and crashed the session outright ("exceeds
	// the available context size"), un-recoverably, unlike an iteration-cap
	// exhaustion (no auto-continuation exists for a hard crash). The
	// existing condensation threshold guard cannot prevent this class of
	// failure: it only checks the LAST completed request's size before
	// building the next one, with no way to know in advance that the
	// upcoming single response will be enormous. Same local-only-override
	// pattern already used for condenseThresholdFraction below: a runaway
	// generation's blast radius should be a small fraction of the REAL
	// local context window, not up to half of it.
	// 2026-09-02: 8192 was still too generous in practice -- verified live,
	// repeatedly (joeos_finetune_data's eval_verifier.py ground-truth runs,
	// same day): a stuck local-model turn reliably ran to the FULL 8192-token
	// cap every time, taking 8-9 real minutes at this model's ~15 tok/s and
	// consuming the entire session's remaining time budget without ever
	// producing a tool call. Real, productive turns in the same logs (a tool
	// call + a few sentences of reasoning) topped out around 1000-2000
	// output tokens. Lowered so a stuck turn gets cut off in well under a
	// minute instead of silently eating the whole budget.
	const LOCAL_MAX_TOKENS = 2048
	const maxTokens =
		options.maxTokens ?? envNumber("HEADLESSCODE_MAX_TOKENS") ?? (useLocalCodeBackend ? LOCAL_MAX_TOKENS : undefined)

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
		model: effectiveModel,
		taskText,
		maxIterations: options.maxIterations,
		maxRecursionDepth,
		childIterationFraction,
		consecutiveErrorLimit,
		windowSize: options.windowSize,
		contextWindowTokens,
		condenseThresholdFraction,
		condenseEarlyFireFraction,
		condenseModel,
		disableLlmCondensation,
		llmTimeoutMs,
		stream: options.stream,
		reasoningEffort,
		temperature: options.temperature,
		requireExplicitCompletion,
		patchLocalToolSchemas,
		verifyBeforeCompletion,
		evidenceRequiredCompletion,
		trackCost,
		requireArtifactBeforeCompletion,
		requireArtifactPathPattern: options.requireArtifactPath,
		requireArtifactMinCitations: options.requireArtifactMinCitations,
		requireArtifactSections: options.requireArtifactSections,
		guardLargeOverwrites,
		disableReadFileCache,
		llmClient: client,
		logger,
		memory,
		project,
		budget,
		checkpoints: !options.noCheckpoints,
		checkpointDir: options.checkpointDir,
		decisionTimeoutMs,
		autoApproveModeSwitch,
		maxModeSwitches,
		maxTokens,
		maxPauseMs,
		permissions,
		// Opt-in local exploration phase (default OFF). Flag OR env var — the
		// phase itself resolves the remaining HEADLESSCODE_LOCAL_EXPLORE_*
		// defaults at call time. Any local failure fails open to cloud-only.
		localExplore: options.localExplore || isLocalExploreEnabled(process.env),
	})

	const result = await session.run()

	// A session writes into workspaceRoot throughout the run (file edits,
	// its own .headlesscode/{events,usage,reports}, git's index as it
	// stages things) AND, when workspaceRoot is a worktree, into the
	// source repo's separate .git/worktrees/<name>/ admin dir — chowning
	// only at worktree *creation* time (see session-launch.ts's
	// ensureWorktree) misses all of this. Runs regardless of success/
	// failure — a failed session can leave root-owned files too. No-ops
	// when HEADLESSCODE_DASHBOARD_WORKTREE_OWNER isn't set (today's
	// default for a non-container / non-root run).
	chownWorktreeWorkspace(workspaceRoot)

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

/**
 * Per-mode env var lookup for issue #142: `HEADLESSCODE_<BASE>__<MODE>`
 * (mode slug uppercased, "-" -> "_") wins if set, else the plain global
 * `HEADLESSCODE_<BASE>`, else undefined. Shared by both the per-mode
 * Ollama URL and model lookups so they resolve identically.
 */
export function resolvePerModeEnv(
	baseName: string,
	mode: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const modeKey = mode.toUpperCase().replace(/-/g, "_")
	return env[`${baseName}__${modeKey}`] ?? env[baseName]
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

/** Pure env-boolean parse: "1"/"true"/"yes"/"on" → true; anything else (incl. unset) → false. */
export function envBooleanValue(name: string, env: NodeJS.ProcessEnv): boolean {
	const raw = env[name]
	if (raw === undefined || raw === "") {
		return false
	}
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

/** Parse an env boolean opt-in from process.env: "1"/"true"/"yes"/"on" → true; anything else (incl. unset) → false. */
export function envBoolean(name: string): boolean {
	return envBooleanValue(name, process.env)
}

/**
 * Resolve whether evidence-gated completion is ON for a session. Pure
 * (flag + env + local-backend in, boolean out) so the full wiring is
 * testable without spinning up a session.
 *
 * Order of precedence:
 *   1. the explicit --require-evidence flag always wins;
 *   2. HEADLESSCODE_REQUIRE_EVIDENCE env forces it on (cloud sessions
 *      included — this is the finetune-harness/acceptance-gate hook, plan
 *      A5: "force evidence-gated completion without code changes");
 *   3. the local code backend defaults it ON unless explicitly disabled
 *      via HEADLESSCODE_ALLOW_UNVERIFIED_COMPLETION (same opt-in-override
 *      pattern as verifyBeforeCompletion).
 */
export function resolveEvidenceRequiredCompletion(
	requireEvidenceFlag: boolean,
	env: NodeJS.ProcessEnv,
	useLocalCodeBackend: boolean,
): boolean {
	return (
		requireEvidenceFlag ||
		envBooleanValue("HEADLESSCODE_REQUIRE_EVIDENCE", env) ||
		(useLocalCodeBackend && !envBooleanValue("HEADLESSCODE_ALLOW_UNVERIFIED_COMPLETION", env))
	)
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
