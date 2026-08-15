/**
 * HeadlessSession — the Phase 1 orchestration loop.
 *
 * Message flow:
 *
 *   [system prompt, user task] → LLM → assistant message (maybe with
 *   tool_calls) → for each call: parse → execute via ToolExecutor → append
 *   `tool` role message → repeat until a termination condition.
 *
 * Termination:
 *   SUCCESS — the model emits an `attempt_completion` tool call (its
 *     `args.result` is the final answer), or (pragmatic fallback used when
 *     attempt_completion is absent or the model just answers) an assistant
 *     text reply with no tool_calls. A non-empty text-only reply is treated
 *     as the final answer.
 *   BOUNDED FAILURE — `maxIterations` reached, or `consecutiveErrorLimit`
 *     consecutive mistakes (tool errors / parse errors / consecutive identical
 *     repeated calls / empty replies) exceeded. Also any LLM call error or
 *     timeout aborts the session with an error.
 *
 * History management: Phase 1 sliding-window truncation PLUS Phase 3 token-
 * budget-aware condensation (see src/engine/condense.ts). The system message
 * and the first user message are always kept; when the history exceeds
 * `windowSize` messages, the oldest non-system, non-first-user messages are
 * dropped before each request — UNLESS the last request's real prompt-token
 * count crossed the condensation threshold, in which case the oldest turns
 * are first summarized into one compact synthetic message instead of being
 * dropped outright (see `maybeCondenseHistory`).
 *
 * The loop is non-interactive by construction: no approval prompts, no
 * webview. `ask_followup_question` calls escalate instead of failing
 * immediately: the executor writes a `.harness.needs-decision` marker and
 * blocks (budget clock paused) for a configurable timeout waiting for
 * `.harness.decision-answer` — a human or the orchestrator can answer via
 * `scripts/headlesscode-answer.sh`. Only once that timeout elapses does it
 * fall back to the original "harness is non-interactive" error (see
 * src/tools/executor.ts).
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"

import { randomUUID } from "node:crypto"

import { BudgetExceededError, BudgetTracker, type SessionBudget } from "../budget/budget.js"
import { loadPricingTable, mergeLivePrice, type ModelPrice, type PricingTable } from "../budget/cost.js"
import { DEFAULT_MODEL, isRetryableOpenRouterError } from "../llm/openrouter.js"
import { DECISION_PROXY_ANSWER_PREFIX } from "../decision-proxy/proxy.js"
import {
	createHeadlessExecutor,
	escalateDecision,
	NEEDS_DECISION_FILENAME,
	ToolExecutor,
} from "../tools/executor.js"
import type { PermissionsConfig } from "../permissions/config.js"
import { buildRollingSummary, extractSessionSummary } from "../memory/summarizer.js"
import type { MemoryStore, RecallResult } from "../memory/types.js"
import { createCheckpointService, type CheckpointService } from "../checkpoints/service.js"
import { recordSessionUsage, removeLiveUsage, writeLiveUsage } from "./usage.js"
import { EventFeed, EVENT_TRUNCATE_CHARS, truncateField } from "./events.js"
import { writeSessionReport } from "./reports.js"
import { Logger } from "./logger.js"
import { parseToolCalls } from "./parser.js"
import {
	appendBrowserActionTool,
	appendCodeIntelEditTools,
	appendCodeIntelTools,
	appendDescribeImageTool,
	appendRunTestsTool,
	buildSystemPrompt,
	loadCustomModes,
	modeHasEditGroup,
	selectToolsForMode,
} from "./prompt.js"
import type {
	AuxLlmUsage,
	ChatMessage,
	ChatTool,
	LlmClient,
	LlmResponse,
	SessionResult,
	SessionBudgetUsage,
	ToolContext,
	ToolResult,
} from "./types.js"
import type { ModeConfig } from "@roo-code/types"
import {
	buildCondensedMessage,
	computeCondensePlan,
	computeEvictCount,
	condenseOldestTurns,
	DEFAULT_CONDENSE_EARLY_FIRE_FRACTION,
	DEFAULT_CONDENSE_THRESHOLD_FRACTION,
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	estimateMessageChars,
	MAX_CONDENSE_INPUT_CHARS,
	maybeCondense,
	MIN_CONDENSE_TAIL_GROWTH,
	skipOrphanedToolMessages,
} from "./condense.js"
import { writeHandoffSummary } from "./handoff.js"
import { runLocalExplorePhase, type LocalExploreOptions, type LocalExploreResult } from "./local-explore.js"
import { DEFAULT_LINE_LIMIT } from "../vendor/zoo-code/src/core/prompts/tools/native-tools/read_file.js"
import { hasCodebaseIndex } from "../index-util.js"
// Recursive task decomposition (`new_task`): child mode resolution uses the
// SAME lookup the top-level session does (custom modes from .roomodes first,
// then the vendored built-ins — see src/engine/prompt.ts).
import { getModeBySlug, modes } from "../vendor/zoo-code/src/shared/modes.js"

/** Default max pause duration for dashboard-initiated pauses, ms (matches watch.ts's stall guard). */
export const DEFAULT_MAX_PAUSE_MS = 2 * 60 * 60 * 1000
/** Default pause marker poll interval, ms (same cadence as decision escalation). */
export const DEFAULT_PAUSE_POLL_INTERVAL_MS = 5_000
/** Marker basenames, relative to the workspace root (see src/tools/executor.ts's marker idiom). */
const PAUSE_REQUESTED_FILENAME = ".harness.pause-requested"
const PAUSED_FILENAME = ".harness.paused"
/**
 * Mid-session message injection (live chat-UI control): written by the
 * dashboard's POST /api/session/:id/message as JSON `{ text, injectedAt }`,
 * consumed + deleted by checkInjectedMessage (see plans/live-message-injection-for-chat-uis.md).
 */
export const INJECT_MESSAGE_FILENAME = ".harness.inject-message"

/**
 * 2026-08-08: raised from 50 — real rounds against non-trivial issues
 * routinely needed MORE than 50 (exploration alone regularly ate 30-45 of
 * them before the first edit; see the read-only-equivalent execute_command
 * guardrail extension for the biggest driver), so 50 was hitting the cap
 * and forcing a continuation restart (see src/engine/handoff.ts) far more
 * often than it should have. 250 gives a real multi-file task room to
 * finish in ONE session instead of routinely needing 2-4 continuation
 * cycles — each iteration is cheap (prompt caching + condensation keep
 * later iterations from ballooning in cost), so the main cost of a higher
 * cap is wall-clock time on a task that was never going to finish anyway,
 * not spend.
 */
export const DEFAULT_MAX_ITERATIONS = 250
export const DEFAULT_CONSECUTIVE_ERROR_LIMIT = 3
/**
 * Recursive task decomposition (`new_task`): hard cap on recursion depth.
 * Depth 0 is the root session; a session at depth `max` may NOT delegate
 * further (its new_task call is refused as a normal tool error). Default 2 =
 * root (0) → child (1) → grandchild (2); the grandchild is the deepest level
 * that can run. Chosen over 3 because every level also halves the child's
 * iteration budget (see DEFAULT_CHILD_ITERATION_FRACTION), so a 2-deep tree
 * is already bounded to ~1.75× the parent's own iteration cap while still
 * giving a genuinely two-level decomposition — and the shared budget is the
 * real cost governor regardless of depth. See plans/recursive-orchestrator-mode.md.
 */
export const DEFAULT_MAX_RECURSION_DEPTH = 2
/**
 * Recursive task decomposition (`new_task`): a child session's default
 * maxIterations is this fraction of the parent's REMAINING iterations (the
 * parent still needs iterations after the child returns to process the
 * result and finish). 0.5 gives the child half and keeps half for the parent;
 * each further level halves again, so a depth-2 grandchild gets 0.25 of the
 * root's remaining budget. Overridable via --child-iteration-fraction /
 * $HEADLESSCODE_CHILD_ITERATION_FRACTION; the model cannot request more
 * through the strict vendored schema (mode/message/todos only).
 */
export const DEFAULT_CHILD_ITERATION_FRACTION = 0.5
/**
 * Recursive task decomposition (`new_task`): floor on a child's maxIterations
 * so a parent with only a couple of iterations left doesn't spawn a crippled
 * 1-iteration child (real sub-steps need a few tool calls minimum). Never
 * exceeds the parent's remaining iterations — the child is always capped at
 * what the parent itself has left.
 */
export const DEFAULT_MIN_CHILD_ITERATIONS = 3
/**
 * switch_mode (plans/switch-mode-headless.md): hard cap on how many times a
 * single session may change its OWN active mode in place. Mirrors new_task's
 * recursion-depth cap (same rationale: bound worst-case cost/thrash, not just
 * infinite loops). Default 5: a realistic Architect→Code→Architect→Code
 * handoff pipeline fits comfortably, while anything beyond ~5 pivots in one
 * session is almost certainly a model thrashing between modes instead of
 * working — and every switch costs either a human approval round-trip or
 * (with auto-approve on) an unvetted permission expansion, so the cap stays
 * far below anything a legitimate workflow needs. Overridable via
 * --max-mode-switches / $HEADLESSCODE_MAX_MODE_SWITCHES.
 */
export const DEFAULT_MAX_MODE_SWITCHES = 5
/**
 * 2026-08-01: raised from 40. `windowSize` is a MESSAGE count, not a token
 * count, but the models this harness targets (e.g. deepseek/deepseek-v4-flash
 * on its official endpoint, pinned in src/llm/openrouter.ts) have context
 * windows over 1M tokens — a 40-message cap was evicting messages hundreds
 * of thousands of tokens before the model's real context limit. Confirmed
 * live: a real session re-read the same handful of files 14-16 times each
 * because truncation kept dropping their earlier `read_file` results out of
 * view, burning iterations and cost on redundant reads instead of ever
 * reaching a write. 300 messages covers a task's full exploration phase for
 * realistic tasks without approaching the real context ceiling; caching
 * keeps the cost of carrying more history low (see src/budget/cost.ts).
 */
export const DEFAULT_WINDOW_SIZE = 300
/**
 * 2026-08-01: raised from 120_000. A real session's iteration 16 call alone
 * took ~59s and generated 8,000+ output tokens (deepseek/deepseek-v4-flash
 * is a reasoning model — long generations are normal, not a hang); iteration
 * 19 then hit exactly the old 120s ceiling and failed with an opaque "no
 * choices[0].message" error. 300s gives a heavy reasoning turn real room
 * without masking an actually-hung request as something else.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 300_000
/**
 * Blind tree-walking guardrail (speed workstream, P1.6): after this many
 * CONSECUTIVE iterations whose every tool call is a plain read/exploration
 * tool (list_files / read_file / search_files) with no codebase_search,
 * code-intel, or edit mixed in, the loop injects a one-line user-role nudge
 * pointing at codebase_search. Chosen at 8: the whole point is to catch a
 * model settling into a blind tree-walk BEFORE it has burned a dozen+ calls
 * (which is where the airunner sessions' exploration ballooning started),
 * while staying comfortably above a legitimate 2-5 call local recon burst —
 * the nudge must never fire for normal short reads. It is a SOFT nudge
 * (reversible, matches the empty-reply pattern): a single productive call
 * resets the streak, and it never fires when the workspace has no
 * codebase-search index (blind walking is then the only option). Overridable
 * via $HEADLESSCODE_READ_ONLY_NUDGE_THRESHOLD.
 */
export const DEFAULT_READ_ONLY_NUDGE_THRESHOLD = 8
/** Tool names that count as "blind tree-walking" for the guardrail above. */
const READ_ONLY_TOOL_NAMES = new Set(["list_files", "read_file", "search_files"])
/** The injected nudge (user-role, seen by the model on its next turn). */
const READ_ONLY_NUDGE_MESSAGE =
	"You've made several read/exploration calls without using `codebase_search`. If the workspace has an index (it lives in the central project store — see `~/.local/share/headlesscode/projects/`), try `codebase_search` for targeted semantic search instead of blind tree-walking. If the workspace is not indexed, ignore this nudge."

/**
 * Leading command names treated as read-only-equivalent by
 * isReadOnlyEquivalentShellCommand — every one of these inspects the
 * workspace without changing it. Deliberately an ALLOW-list (default "not
 * read-only" for anything unrecognized) rather than a deny-list of mutating
 * commands: a shell one-liner is too open-ended to safely enumerate every
 * way it could mutate something, so the safe default is to under-count
 * (miss a real read-only command occasionally) rather than over-count (wrongly
 * treat a mutation as exploration and never nudge). Low stakes either way —
 * this only feeds a SOFT, reversible nudge, never a block.
 */
const READ_ONLY_SHELL_LEADING_COMMANDS = new Set([
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"find",
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"tree",
	"pwd",
	"echo",
	"printf",
	"stat",
	"file",
	"du",
	"basename",
	"dirname",
	"realpath",
	// A no-op — common as a `git status || true`-style fallback to suppress a
	// read-only command's non-zero exit (e.g. `git log` in a fresh repo).
	"true",
])
/** git/docker subcommands that only inspect state (vs. `git commit`, `docker up`, ...). */
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["log", "diff", "status", "show", "blame", "branch", "rev-parse", "remote"])
const READ_ONLY_DOCKER_SUBCOMMANDS = new Set(["ps", "images", "logs", "inspect"])

/**
 * Measured on a live round (issue: harness slowness investigation, 2026-08-08):
 * `execute_command` — NOT `read_file`/`list_files` — was the dominant
 * exploration tool by a wide margin (e.g. 37-48 execute_command calls per
 * session vs. 0-1 codebase_search calls), almost entirely ad hoc
 * grep/ls/sed/find one-liners doing the exact job `codebase_search` exists to
 * shortcut. The blind-tree-walking guardrail above never saw any of this
 * because `execute_command` wasn't in READ_ONLY_TOOL_NAMES — a long streak of
 * pure shell-grep exploration could run the entire session without ever
 * tripping the nudge. This classifier closes that gap: a `sed -n`/`cat`/`git
 * log`/`docker ps`-style command reads exactly like `read_file`/`list_files`
 * for this guardrail's purposes and should count the same way. Compound
 * commands (`&&`/`;`/`|`/newline-joined) count only if EVERY segment is
 * read-only — one mutating segment (a `git commit`, `docker compose up`, a
 * bare `>` redirect, `sed -i`) marks the whole command as NOT read-only.
 */
export function isReadOnlyEquivalentShellCommand(command: string): boolean {
	// `\|\|` MUST be tried before the bare `\|` alternative below it, or a
	// `cmd || true` fallback splits into a stray `true` segment (not on the
	// allow-list) and the whole command wrongly reads as mutating.
	const segments = command.split(/\|\||&&|;|\||\n/).map((s) => s.trim())
	if (segments.length === 0 || segments.every((s) => s === "")) {
		return false
	}
	for (const segment of segments) {
		if (segment === "") {
			continue
		}
		// A bare `>`/`>>` writes a file; `2>&1`/`>&2` (fd-to-fd redirects) don't.
		if (/(?<!\d)>>?(?!&)/.test(segment)) {
			return false
		}
		const words = segment.split(/\s+/).filter(Boolean)
		const head = words[0]
		if (head === "cd") {
			continue // a leading `cd x &&` is just a working-dir change, not itself an inspection
		}
		if (head === "sed") {
			// `sed -n '...'` (print-only) is read-only; anything with `-i` is not.
			if (words.includes("-i") || words.some((w) => w.startsWith("-i"))) {
				return false
			}
			continue
		}
		if (head === "git") {
			if (READ_ONLY_GIT_SUBCOMMANDS.has(words[1] ?? "")) {
				continue
			}
			return false
		}
		if (head === "docker") {
			// `docker compose ps/logs` vs. `docker compose up/down/build`.
			const sub = words[1] === "compose" ? words[2] : words[1]
			if (READ_ONLY_DOCKER_SUBCOMMANDS.has(sub ?? "")) {
				continue
			}
			return false
		}
		if (READ_ONLY_SHELL_LEADING_COMMANDS.has(head ?? "")) {
			continue
		}
		return false
	}
	return true
}

/**
 * Same-file multi-edit diagnosis (see the tool-execution loop): when the
 * model submits several edit calls to the SAME file in ONE turn, the later
 * calls' SEARCH text was typically composed against the file's PRE-first-edit
 * content — so they fail with a "diff didn't match" error the model has to
 * reason its way out of. The loop tracks which paths earlier calls in the
 * batch already modified and appends this diagnosis to any later failure on
 * the same path, turning the generic mismatch into a pointer at the fix.
 */
const SAME_FILE_BATCH_DIAGNOSIS =
	"\n\n<diagnosis>this file was already edited by an earlier tool call in this same turn — your SEARCH text may have been composed against the file's content BEFORE that edit. Re-read the file to get its current state, or next time include both changes as separate SEARCH/REPLACE blocks in ONE apply_diff call.</diagnosis>"

/** Edit tools whose args name a target file (for the same-file batch diagnosis). */
const BATCH_EDIT_TOOL_NAMES = new Set(["apply_diff", "search_replace", "edit_file", "write_to_file"])

/**
 * Best-effort extraction of the file path an edit tool call targets, for the
 * same-file batch diagnosis. `apply_diff`/`write_to_file` use `path`;
 * `search_replace`/`edit_file` use `file_path`. Resolved against the
 * workspace root so two spellings of the same path collide. Not authoritative
 * (the executor's own safeTarget is) — a mis-extraction only skips a
 * diagnosis, never blocks anything.
 */
function editToolTargetPath(workspaceRoot: string, call: { name: string; args: Record<string, unknown> }): string | undefined {
	if (!BATCH_EDIT_TOOL_NAMES.has(call.name)) {
		return undefined
	}
	const raw =
		typeof call.args.path === "string" && call.args.path.trim() !== ""
			? call.args.path
			: typeof call.args.file_path === "string" && call.args.file_path.trim() !== ""
				? call.args.file_path
				: undefined
	if (raw === undefined) {
		return undefined
	}
	try {
		return path.resolve(workspaceRoot, raw)
	} catch {
		return undefined
	}
}

/**
 * Commit-before-finishing guardrail: the corrective note pushed as the
 * attempt_completion tool RESULT (keeping the assistant-with-tool_calls →
 * tool-result adjacency contract) when a worker tries to finish with
 * uncommitted tracked changes. One nudge per session — a retried
 * attempt_completion is always accepted, since a model may legitimately
 * finish with nothing to commit or a deliberate decision to leave work
 * uncommitted.
 */
const COMMIT_NUDGE_CONTENT =
	"[System: attempt_completion not accepted — the workspace has uncommitted tracked-file changes. Real, working changes must be committed via `git add` + `git commit` BEFORE finishing: one commit per logical change, with a descriptive message matching this repo's normal style (run `git log --oneline` for examples). Commit your changes, then call attempt_completion again. If you genuinely have a reason to leave changes uncommitted (e.g. a read-only investigation), call attempt_completion again as-is and it will be accepted.]"

const execFileP = promisify(execFile)

/**
 * True when the workspace's git repo has uncommitted TRACKED-file changes
 * (modified/staged/deleted/renamed — NOT `??` untracked files, which may be
 * deliberate scratch work the model shouldn't be forced to commit). False
 * when git fails (no repo) or the status is clean. The commit-before-
 * finishing guardrail's structural backstop — independent of whether the
 * prompt instruction alone is followed.
 */
async function hasUncommittedTrackedChanges(workspaceRoot: string): Promise<boolean> {
	try {
		const { stdout } = await execFileP("git", ["status", "--short"], {
			cwd: workspaceRoot,
			timeout: 15_000,
		})
		for (const line of stdout.split("\n")) {
			if (line.trim() === "") {
				continue
			}
			// `?? path` = untracked only; every other status ( M, M , A, D,
			// R, AM, …) is a tracked-file change.
			if (!line.startsWith("??")) {
				return true
			}
		}
		return false
	} catch {
		return false // not a git repo or git missing — nothing to enforce
	}
}

export interface HeadlessSessionConfig {
	workspaceRoot: string
	/**
	 * Explicit session id override (default: a fresh randomUUID). The
	 * dashboard's session-launch endpoint generates the id first and passes
	 * it through (via --session-id) so the browser can open the session's
	 * live event view immediately, before the first event exists.
	 */
	sessionId?: string
	/**
	 * Recursive task decomposition (`new_task`): the id of the session that
	 * spawned this one (absent on root sessions). Stamped onto every event
	 * this session emits and used in checkpoint lineage tags, so a child
	 * feed/checkpoint trail is self-describing.
	 */
	parentSessionId?: string
	/**
	 * Recursive task decomposition (`new_task`): this session's recursion
	 * depth, 0 = root (default). Bumped by the parent's new_task handler;
	 * a session at `recursionDepth >= maxRecursionDepth` refuses further
	 * delegation as a normal tool error.
	 */
	recursionDepth?: number
	/**
	 * Recursive task decomposition (`new_task`): hard cap on how deep a
	 * single root session may delegate (default DEFAULT_MAX_RECURSION_DEPTH
	 * = 2; also settable via --max-recursion-depth). A normal tool error,
	 * never a crash, when a child would exceed it.
	 */
	maxRecursionDepth?: number
	/**
	 * Recursive task decomposition (`new_task`): default maxIterations for a
	 * child session as a fraction of the parent's remaining iterations
	 * (default DEFAULT_CHILD_ITERATION_FRACTION = 0.5; also settable via
	 * --child-iteration-fraction). See the constant's comment for the
	 * reasoning.
	 */
	childIterationFraction?: number
	/**
	 * Recursive task decomposition (`new_task`): floor on a child's default
	 * maxIterations (default DEFAULT_MIN_CHILD_ITERATIONS = 3) so a parent
	 * with only a couple of iterations left doesn't spawn a crippled child.
	 * Never exceeds the parent's remaining iterations.
	 */
	minChildIterations?: number
	/**
	 * switch_mode (plans/switch-mode-headless.md): OPT-IN auto-approval of
	 * mode switches (default false — OFF). When set, a switch_mode call
	 * performs the mode change immediately with no human/orchestrator
	 * approval escalation (still logged + evented, just not gated). OFF by
	 * default because the approval gate is the actual security boundary:
	 * a deliberately restricted mode (e.g. architect, read+md-only) must not
	 * be able to silently grant itself a broader mode's edit permissions.
	 * Also settable via --auto-approve-mode-switch /
	 * $HEADLESSCODE_AUTO_APPROVE_MODE_SWITCH.
	 */
	autoApproveModeSwitch?: boolean
	/**
	 * switch_mode: hard cap on total in-place mode switches per session
	 * (default DEFAULT_MAX_MODE_SWITCHES = 5; also settable via
	 * --max-mode-switches / $HEADLESSCODE_MAX_MODE_SWITCHES). Exceeding it is
	 * a normal tool error (never a crash), mirroring new_task's recursion
	 * depth cap.
	 */
	maxModeSwitches?: number
	/** Mode slug, default 'code' (built-in or from .roomodes). */
	mode?: string
	/** Model id; default env OPENROUTER_MODEL or 'deepseek/deepseek-v4-flash-0731'. */
	model?: string
	taskText: string
	maxIterations?: number
	consecutiveErrorLimit?: number
	/** Skip prompt building and use this exact system prompt. */
	systemPromptOverride?: string
	/** The LLM client (inject a fake in tests; OpenRouterClient in prod). */
	llmClient: LlmClient
	/** Optional executor override (default: createHeadlessExecutor(root)). */
	executor?: ToolExecutor
	/** Optional preloaded custom modes (default: load from .roomodes). */
	customModes?: ModeConfig[]
	/** Optional explicit tool list override (default: selectToolsForMode). */
	tools?: ChatTool[]
	logger?: Logger
	temperature?: number
	maxTokens?: number
	/** Abort timeout per LLM call, ms (default 120s). */
	llmTimeoutMs?: number
	/**
	 * Opt-in SSE streaming (streaming-and-reasoning, default OFF). When true,
	 * LLM calls stream token/reasoning deltas and the loop emits incremental
	 * `llm_stream_chunk` events so the dashboard can show live-typing text.
	 * Default OFF — the blocking request path (which the e2e fixtures and
	 * most tests assume) is unchanged.
	 */
	stream?: boolean
	/**
	 * Graded reasoning effort for deepseek/* models (issue #30 experiment):
	 * low/medium/high/max (native DeepSeek levels; max is normalized to
	 * OpenRouter's "xhigh" on the wire) or "xhigh" directly. Optional — when
	 * unset, no `reasoning.effort` is sent and the endpoint's default applies.
	 * Resolved by the CLI from the `_reasoning_effort` key in mode-models.json,
	 * then $HEADLESSCODE_REASONING_EFFORT, then the built-in per-mode default
	 * (code -> "low", see src/config/mode-models.ts); falls back to the env
	 * var here for direct construction.
	 */
	reasoningEffort?: string
	/** Sliding-window cap on messages sent per request (default 40). */
	windowSize?: number
	/**
	 * Phase 3 context condensation: the model's real context window in
	 * tokens, used to decide WHEN to condense (the last request's real
	 * prompt-token count vs. `condenseThresholdFraction` of this). When
	 * unset, the session tries OpenRouter's `/api/v1/models/<id>/endpoints`
	 * once (via `fetchModelContextWindow`), then falls back to
	 * `DEFAULT_CONTEXT_WINDOW_TOKENS` (see src/engine/condense.ts).
	 */
	contextWindowTokens?: number
	/**
	 * Phase 3 context condensation: fraction of the context window at which
	 * the oldest turns get summarized into one synthetic message (default
	 * DEFAULT_CONDENSE_THRESHOLD_FRACTION = 0.75 — see condense.ts's header
	 * for the reasoning).
	 */
	condenseThresholdFraction?: number
	/**
	 * Async/background condensation (plans/smart-condensation-async.md): the
	 * fraction of the context window at which the condensation LLM call fires
	 * EARLY, in the background against a snapshot, while the main loop keeps
	 * running (default DEFAULT_CONDENSE_EARLY_FIRE_FRACTION = 0.6 — below the
	 * hard threshold; PROVISIONAL, tune from part-1 real data). Must be below
	 * `condenseThresholdFraction`; when it isn't, the async path is safely off
	 * and only the synchronous hard-threshold path runs.
	 */
	condenseEarlyFireFraction?: number
	/**
	 * Phase 3 context condensation: model id used for the condensation LLM
	 * call (default: the session model). A cheaper model can be assigned via
	 * the `_condensation` key in the central store's `mode-models.json`
	 * (see src/config/mode-models.ts's extraKeys).
	 */
	condenseModel?: string
	/**
	 * Phase 3 context condensation: max output tokens for the condensation
	 * call (default: the session's `maxTokens`, if set).
	 */
	condenseMaxTokens?: number
	globalCustomInstructions?: string
	/**
	 * Phase 3 memory store (default null = memory OFF, zero behavior change).
	 * When set, the loop recalls project memory into the first user message
	 * before starting and records the session summary + extracted facts
	 * afterwards. Memory failures are always non-fatal.
	 */
	memory?: MemoryStore | null
	/** Project scope for memory (default: basename of workspaceRoot). */
	project?: string
	/**
	 * Phase 6 per-session budget (default null = budget OFF, zero behavior
	 * change). When set, the loop checks elapsed time + accumulated cost +
	 * iteration count before each LLM call and aborts with status "error" and
	 * reason "budget" when a limit trips. Token usage comes from the LLM
	 * response (`LlmResponse.usage`), which OpenRouterClient already surfaces.
	 */
	budget?: SessionBudget | null
	/**
	 * INTERNAL plumbing for recursive task decomposition (`new_task`) — NOT a
	 * public configuration field. When set, the session reuses THIS budget
	 * tracker instead of constructing its own from `budget`, so a child's LLM
	 * usage counts against the SAME cost/duration/iteration caps as its
	 * parent (one shared cap, never a separate untracked budget per level).
	 * The parent's new_task handler passes its own tracker down; root
	 * sessions leave this unset.
	 */
	budgetTracker?: BudgetTracker
	/**
	 * Checkpoints: auto-snapshot the workspace into a shadow git repo (see
	 * `src/checkpoints/service.ts`) at session start and after every iteration
	 * that executed at least one tool call, so edits can be reverted. Default
	 * ON, but only actually runs when the executor is edit-capable (has
	 * `write_to_file`, `apply_diff`, `search_replace` or `edit_file`
	 * registered) — read-only executors (reviewer/QA) have nothing to
	 * checkpoint. Checkpoint failures are always non-fatal (logged as a
	 * warning, session continues).
	 */
	checkpoints?: boolean
	/** Shadow-git storage dir override (default: the central store's `checkpoints/`). */
	checkpointDir?: string
	/**
	 * INTERNAL plumbing for recursive task decomposition (`new_task`) — NOT a
	 * public configuration field. When set, the session uses THIS checkpoint
	 * service instance (the parent's) instead of creating its own, so a
	 * child's edits land in the SAME shadow-git history as the parent's
	 * (checkpoints are keyed by workspaceRoot; the parent passes its service
	 * down). `null` = the parent's checkpoints failed to init → the child
	 * inherits "disabled" rather than starting a disconnected history.
	 * Root sessions leave this unset and create their own service.
	 */
	checkpointService?: CheckpointService | null
	/**
	 * INTERNAL plumbing for recursive task decomposition (`new_task`) — NOT a
	 * public configuration field. The parent session's full checkpoint
	 * lineage string (e.g. `<rootId>` or `<rootId>/<childId>`), used to tag a
	 * child's checkpoint commit messages as `Task: <lineage>/<childId>, …`
	 * so `headlesscode checkpoints list` shows the whole parent/child chain.
	 */
	checkpointLineagePrefix?: string
	/**
	 * Decision escalation (workstream 2): how long ask_followup_question blocks
	 * waiting for `<workspaceRoot>/.harness.decision-answer` before falling
	 * back to today's autonomous-decision error (default 30 min — see
	 * DEFAULT_DECISION_TIMEOUT_MS in src/tools/executor.ts). Ignored when a
	 * custom `executor` is injected (its own options win).
	 */
	decisionTimeoutMs?: number
	/** Decision-escalation poll interval, ms (default 5s — override in tests). */
	decisionPollIntervalMs?: number
	/**
	 * Resolved permissions (command allow/deny + protected files). Optional:
	 * when absent the executor resolves its own from env vars + the central
	 * store's `permissions.json` + built-in defaults.
	 */
	permissions?: PermissionsConfig
	/**
	 * Pause/resume (dashboard control): max duration a dashboard-initiated
	 * pause may hold the loop before it auto-resumes, ms (default 2h — see
	 * DEFAULT_MAX_PAUSE_MS). Also settable via $HEADLESSCODE_MAX_PAUSE_MS /
	 * --max-pause-ms.
	 */
	maxPauseMs?: number
	/** Pause marker poll interval, ms (default 5s — override in tests). */
	pausePollIntervalMs?: number
	/**
	 * Live event hook: fires for every structured event emitted to the
	 * session's event feed. Tests inject a fake hook to observe events
	 * mid-run without exposing the session's private sessionId (same probe
	 * pattern as the live-usage-snapshot tests).
	 */
	eventHook?: (eventType: string, fields: Record<string, unknown>) => void
	/**
	 * OPT-IN local exploration phase (default OFF — see
	 * plans/local-explore-phase-experiment.md): when truthy, HeadlessSession runs a
	 * bounded, strictly read-only local Ollama exploration pass (read_file +
	 * list_files only) BEFORE its first cloud iteration and folds the
	 * transcript into the cloud context as a clearly-labeled synthetic
	 * message. `true` = enabled with env defaults (HEADLESSCODE_LOCAL_EXPLORE_*);
	 * an options object = enabled with explicit overrides (tests). Non-fatal
	 * by construction: any local failure (Ollama down, bad response, model
	 * not pulled) skips the phase and the session proceeds exactly as today —
	 * a broken experimental feature must never break a real session. When
	 * unset (the default), the phase never runs at all.
	 */
	localExplore?: boolean | LocalExploreOptions
}

export interface SessionRunState {
	systemPrompt: string
	/** The full working message history (system + user + assistant + tool). */
	messages: ChatMessage[]
	tools: ChatTool[]
	mode: string
	model: string
}

/** The session config with every optional field resolved to a concrete value. */
export interface ResolvedSessionConfig {
	workspaceRoot: string
	/** Explicit session id override (see HeadlessSessionConfig.sessionId). */
	sessionId?: string
	mode: string
	model: string
	taskText: string
	maxIterations: number
	consecutiveErrorLimit: number
	systemPromptOverride?: string
	llmTimeoutMs: number
	/** Opt-in SSE streaming (streaming-and-reasoning; default false). */
	stream: boolean
	/** Graded reasoning effort for deepseek/* models (issue #30); undefined = endpoint default. */
	reasoningEffort?: string
	windowSize: number
	/**
	 * Phase 3 context condensation: the model's real context window in
	 * tokens, when explicitly configured (undefined = resolve live from
	 * OpenRouter's models endpoint once, then fall back to
	 * DEFAULT_CONTEXT_WINDOW_TOKENS — see maybeCondenseHistory).
	 */
	contextWindowTokens?: number
	/** Phase 3 context condensation: resolved trigger fraction. */
	condenseThresholdFraction: number
	/** Async/background condensation: resolved early-fire fraction (below the hard threshold). */
	condenseEarlyFireFraction: number
	/** Phase 3 context condensation: model used for the condensation call. */
	condenseModel: string
	/** Phase 3 context condensation: max output tokens for the condensation call. */
	condenseMaxTokens?: number
	temperature?: number
	maxTokens?: number
	globalCustomInstructions?: string
	customModes?: ModeConfig[]
	tools?: ChatTool[]
	executor?: ToolExecutor
	llmClient: LlmClient
	logger?: Logger
	memory?: MemoryStore | null
	project: string
	/** Phase 6: per-session budget (null = off). */
	budget: SessionBudget | null
	/**
	 * Recursive task decomposition (`new_task`): lineage + delegation caps —
	 * resolved from HeadlessSessionConfig (see its doc comments for the
	 * semantics of each field).
	 */
	parentSessionId?: string
	recursionDepth: number
	maxRecursionDepth: number
	childIterationFraction: number
	minChildIterations: number
	/** switch_mode: opt-in auto-approval (see HeadlessSessionConfig.autoApproveModeSwitch). */
	autoApproveModeSwitch: boolean
	/** switch_mode: hard cap on total in-place switches per session (see HeadlessSessionConfig.maxModeSwitches). */
	maxModeSwitches: number
	/** Internal plumbing for `new_task` (NOT public config) — see HeadlessSessionConfig.budgetTracker. */
	budgetTracker?: BudgetTracker
	/** Internal plumbing for `new_task` (NOT public config) — see HeadlessSessionConfig.checkpointService. */
	checkpointService?: CheckpointService | null
	/** Internal plumbing for `new_task` (NOT public config) — see HeadlessSessionConfig.checkpointLineagePrefix. */
	checkpointLineagePrefix?: string
	/** Checkpoints on/off (default true; actual use also requires an edit-capable executor). */
	checkpoints: boolean
	checkpointDir?: string
	/** Decision escalation timeout, ms (see HeadlessSessionConfig.decisionTimeoutMs). */
	decisionTimeoutMs?: number
	/** Decision escalation poll interval, ms (see HeadlessSessionConfig.decisionPollIntervalMs). */
	decisionPollIntervalMs?: number
	/** Permissions, when explicitly resolved by the caller (else executor resolves). */
	permissions?: PermissionsConfig
	/** Pause/resume max duration, ms (see HeadlessSessionConfig.maxPauseMs). */
	maxPauseMs: number
	/** Pause marker poll interval, ms (see HeadlessSessionConfig.pausePollIntervalMs). */
	pausePollIntervalMs: number
	/** Live event hook (see HeadlessSessionConfig.eventHook). */
	eventHook?: (eventType: string, fields: Record<string, unknown>) => void
	/**
	 * Opt-in local exploration phase (see HeadlessSessionConfig.localExplore).
	 * undefined/false = OFF (zero behavior change); options object = enabled
	 * with overrides; true = enabled with env defaults.
	 */
	localExplore?: boolean | LocalExploreOptions
}

/** Phase 3: memory activity recorded for the last `run()` (null when off/failed). */
export interface SessionMemoryStats {
	recalledFacts: number
	recalledSessions: number
	recordedFacts: number
	recordedSessions: number
}

export class HeadlessSession {
	readonly config: ResolvedSessionConfig

	readonly state: SessionRunState
	private readonly llmClient: LlmClient
	private readonly executor: ToolExecutor
	private readonly logger: Logger
	/** Phase 3: memory activity for the last run (null when memory is off or recording failed). */
	memoryStats: SessionMemoryStats | null = null
	private recallInfo: { recalledFacts: number; recalledSessions: number } | null = null
	/** Session id used as the checkpoint service's taskId. */
	private readonly sessionId: string
	private checkpointService: CheckpointService | null = null
	/** Whether checkpoints actually run this session: config on AND the executor is edit-capable. */
	private readonly checkpointsActive: boolean
	/** Cost/token monitoring (workstream 3): cumulative usage tokens across all LLM calls this run. */
	private totalInputTokens = 0
	private totalOutputTokens = 0
	/** Subset of totalInputTokens served from the provider's prompt cache (see LlmResponse.usage.cachedTokens). */
	private totalCachedTokens = 0
	/** Live worker monitoring: the session's structured event feed (non-fatal — see src/engine/events.ts). */
	private readonly eventFeed: EventFeed
	/** The hook fired for every event (tests inject it; undefined in prod). */
	private readonly eventHook?: (eventType: string, fields: Record<string, unknown>) => void
	/** The most recent LLM call's token usage (for the llm_response event). */
	private lastLlmUsage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null = null
	/** The condensation call's token usage, stashed by recordCondensationUsage for the `condensed` event. */
	private lastCondenseUsage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null = null
	/**
	 * Phase 3 context condensation: how far the oldest turns have ALREADY
	 * been condensed. Mutable OBJECT passed by reference into `maybeCondense`
	 * (a private field cannot be passed by reference directly, and a fresh
	 * wrapper per call would discard the mutation). Values: 0 = nothing
	 * condensed yet; 2 = condensation ran and the summary now sits at index
	 * 2. Re-condensation is gated on the uncompressed tail having grown past
	 * MIN_CONDENSE_TAIL_GROWTH — this is what keeps the condensed prefix
	 * STABLE across many subsequent calls (the condensation equivalent of
	 * `truncateHistory`'s fixed-batch eviction — see constraint 5 in
	 * plans/context-condensation.md).
	 */
	private readonly condensedUpToMsgIndex: { value: number } = { value: 0 }
	/** True while a condensation LLM call is in flight (see maybeCondense). */
	private readonly condenseInFlight: { value: boolean } = { value: false }
	/**
	 * Async/background condensation (plans/smart-condensation-async.md part
	 * 2): the single in-flight background condensation job, or null. Fired
	 * BEFORE the hard threshold is crossed (see fireBackgroundCondense), the
	 * call runs against an immutable SNAPSHOT while the main loop keeps
	 * appending; when it resolves, applyBackgroundCondense splices the summary
	 * into the LIVE history at the re-resolved boundary, or discards it (slow
	 * background superseded by the synchronous path / session ended). One job
	 * at a time by design — "needs another one soon after" is a signal the
	 * early-fire fraction needs tuning, not a case for overlapping calls. The
	 * job itself is fire-and-forget (no general background-task framework); a
	 * Promise kicked off without awaiting, tracked here, is enough.
	 */
	private backgroundCondense: {
		/** Immutable prefix [0, 2+count) the call summarized (reference slice — messages are never mutated once pushed). */
		snapshot: ChatMessage[]
		/** How many messages from index 2 the summary replaces. */
		count: number
		/** The iteration at which the background job was fired (for logs/events). */
		firedAtIteration: number
	} | null = null
	/**
	 * Set once the session's iteration loop has finished (attempt_completion,
	 * error, budget abort, max iterations — every exit). A background
	 * condensation resolving after this must DISCARD its result, not splice a
	 * message array that's already been consumed by completion (see
	 * applyBackgroundCondense); its usage has already landed in the
	 * BudgetTracker either way.
	 */
	private sessionEnded = false
	/**
	 * True once the real context window has been resolved (from config, the
	 * OpenRouter models endpoint, or the conservative default) — the lookup
	 * is done at most once per session, on the first iteration that needs it.
	 */
	private contextWindowResolved = false
	/**
	 * The live-resolved context window, cached across the WHOLE session once
	 * found (see maybeCondenseHistory). Distinct from contextWindowResolved:
	 * that flag alone previously caused every condensation check AFTER the
	 * first to silently re-fall-back to DEFAULT_CONTEXT_WINDOW_TOKENS, since
	 * the boolean recorded that resolution was ATTEMPTED but never cached
	 * what it resolved TO — condensation kept firing at 75% of 128k even
	 * after a successful live lookup reported the model's real (larger)
	 * window. Fixed 2026-08-04.
	 */
	private resolvedContextWindowTokens: number | undefined = undefined
	/**
	 * The live-resolved model price (Part E), cached across the WHOLE session
	 * once found — same VALUE-caching discipline as resolvedContextWindowTokens
	 * (a boolean alone recorded the attempt, not what it resolved TO). Set by
	 * resolveLiveModelInfo() during run(); undefined when the live lookup
	 * failed or returned nothing, in which case DEFAULT_PRICING_TABLE (or the
	 * env-merged table) is used exactly as before live pricing existed.
	 */
	private resolvedLivePrice: ModelPrice | undefined = undefined
	/** True once the model-info (context window + pricing) lookup has been attempted. */
	private modelInfoResolved = false
	/**
	 * Recursive task decomposition (`new_task`): the session that spawned this
	 * one, or undefined for root sessions. Stamped onto every event and used
	 * in checkpoint lineage tags.
	 */
	private readonly parentSessionId?: string
	/** Recursive task decomposition (`new_task`): 0 = root; see HeadlessSessionConfig.recursionDepth. */
	private readonly recursionDepth: number
	/** Recursive task decomposition (`new_task`): hard cap on delegation depth. */
	private readonly maxRecursionDepth: number
	/**
	 * Recursive task decomposition (`new_task`): full checkpoint lineage
	 * string. Root: just this session's id; child: `<parentLineage>/<childId>`.
	 * Used in checkpoint commit message tags (`Task: <lineage>, Time: …`) so
	 * `headlesscode checkpoints list` shows the whole parent/child chain.
	 */
	private checkpointLineage: string
	/**
	 * Recursive task decomposition (`new_task`): the parent's iteration number
	 * as of the last completed LLM turn, updated at the top of every loop in
	 * runIterations. The new_task handler reads it to compute the child's
	 * default maxIterations from the parent's REMAINING iterations.
	 */
	private currentIteration = 0
	/** The parent's loaded custom modes, stashed so the new_task handler can
	 * reuse them for child mode resolution instead of re-loading .roomodes. */
	private customModes: ModeConfig[] = []
	/**
	 * Recursive task decomposition (`new_task`): the shared BudgetTracker the
	 * parent runs on, set in run() and passed down to children so the whole
	 * delegation tree spends against ONE cost/duration/iteration budget (see
	 * the config field's comment). Null only before run() starts — new_task
	 * cannot be called before that (the handler only runs inside the loop).
	 */
	private budgetTracker: BudgetTracker | null = null
	/**
	 * switch_mode (plans/switch-mode-headless.md): how many in-place mode
	 * switches this session has already performed (see config.maxModeSwitches
	 * for the cap). Bumped only on an actually-performed switch — refusals
	 * (unknown mode, already there, cap reached, denied/timed-out approval)
	 * never count.
	 */
	private modeSwitchCount = 0
	/**
	 * switch_mode: the visible "[mode switched: …]" transcript marker for a
	 * switch that was JUST approved, consumed by the loop right after the
	 * switch_mode tool result is appended. It lives here (not pushed straight
	 * into this.state.messages by the handler) because the marker MUST come
	 * AFTER the tool result — an assistant message with tool_calls has to be
	 * followed by its tool messages with nothing between (strict providers
	 * like DeepSeek 400 on it), and the handler runs before the loop appends
	 * that result. null when no switch is awaiting its marker.
	 */
	private pendingModeSwitchMarker: string | null = null

	constructor(config: HeadlessSessionConfig) {
		if (!config.llmClient) {
			throw new Error("HeadlessSession requires an llmClient (inject a fake in tests)")
		}
		if (!config.taskText || config.taskText.trim() === "") {
			throw new Error("HeadlessSession requires a non-empty taskText")
		}

		this.config = {
			sessionId: config.sessionId?.trim() ? config.sessionId.trim() : undefined,
			// Recursive task decomposition (`new_task`): lineage fields default
			// to root-session values (undefined parent / depth 0 / cap 2).
			parentSessionId: config.parentSessionId?.trim() ? config.parentSessionId.trim() : undefined,
			recursionDepth: config.recursionDepth ?? 0,
			maxRecursionDepth: config.maxRecursionDepth ?? DEFAULT_MAX_RECURSION_DEPTH,
			childIterationFraction: config.childIterationFraction ?? DEFAULT_CHILD_ITERATION_FRACTION,
			minChildIterations: config.minChildIterations ?? DEFAULT_MIN_CHILD_ITERATIONS,
			// switch_mode: the approval gate is OFF by default — auto-approve
			// is an explicit opt-in (config/CLI/env), never a silent default.
			autoApproveModeSwitch: config.autoApproveModeSwitch ?? false,
			maxModeSwitches: config.maxModeSwitches ?? DEFAULT_MAX_MODE_SWITCHES,
			mode: config.mode ?? "code",
			model: config.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL,
			taskText: config.taskText,
			maxIterations: config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			consecutiveErrorLimit: config.consecutiveErrorLimit ?? DEFAULT_CONSECUTIVE_ERROR_LIMIT,
			systemPromptOverride: config.systemPromptOverride,
			llmTimeoutMs: config.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
			stream: config.stream ?? envStreaming(),
			reasoningEffort: config.reasoningEffort ?? process.env.HEADLESSCODE_REASONING_EFFORT,
			windowSize: config.windowSize ?? DEFAULT_WINDOW_SIZE,
			// Deliberately left undefined when the caller didn't configure it:
			// the live OpenRouter models-endpoint lookup in maybeCondenseHistory
			// resolves the real context window (never hardcode a stale number —
			// constraint 1 of plans/context-condensation.md), with
			// DEFAULT_CONTEXT_WINDOW_TOKENS as the conservative fallback.
			contextWindowTokens: config.contextWindowTokens,
			condenseThresholdFraction: config.condenseThresholdFraction ?? DEFAULT_CONDENSE_THRESHOLD_FRACTION,
			condenseEarlyFireFraction: config.condenseEarlyFireFraction ?? DEFAULT_CONDENSE_EARLY_FIRE_FRACTION,
			condenseModel: config.condenseModel ?? config.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL,
			condenseMaxTokens: config.condenseMaxTokens,
			logger: config.logger,
			temperature: config.temperature,
			maxTokens: config.maxTokens,
			globalCustomInstructions: config.globalCustomInstructions,
			workspaceRoot: config.workspaceRoot,
			llmClient: config.llmClient,
			executor: config.executor,
			customModes: config.customModes,
			tools: config.tools,
			project: config.project ?? path.basename(path.resolve(config.workspaceRoot)),
			memory: config.memory ?? null,
			budget: config.budget ?? null,
			// Internal plumbing for `new_task` (see the config interface):
			// the shared budget tracker / checkpoint service lineage from the
			// parent session, threaded straight through.
			budgetTracker: config.budgetTracker,
			checkpointService: config.checkpointService,
			checkpointLineagePrefix: config.checkpointLineagePrefix,
			checkpoints: config.checkpoints ?? true,
			checkpointDir: config.checkpointDir,
			decisionTimeoutMs: config.decisionTimeoutMs,
			decisionPollIntervalMs: config.decisionPollIntervalMs,
			permissions: config.permissions,
			maxPauseMs: config.maxPauseMs ?? envMaxPauseMs() ?? DEFAULT_MAX_PAUSE_MS,
			pausePollIntervalMs: config.pausePollIntervalMs ?? DEFAULT_PAUSE_POLL_INTERVAL_MS,
			eventHook: config.eventHook,
			localExplore: config.localExplore,
		}

		this.llmClient = config.llmClient
		this.logger = config.logger ?? new Logger({ level: "info" })
		this.executor =
			config.executor ??
			createHeadlessExecutor(config.workspaceRoot, {
				decisionTimeoutMs: this.config.decisionTimeoutMs,
				decisionPollIntervalMs: this.config.decisionPollIntervalMs,
				permissions: this.config.permissions,
				// Live worker monitoring: mirror ask_followup_question's
				// .harness.needs-decision marker lifecycle on the session's
				// event feed (decision_blocked / decision_answered). Non-fatal.
				onDecisionEvent: (eventType, fields) => {
					void this.emitEvent(
						eventType,
						() =>
							eventType === "decision_blocked"
								? this.eventFeed.decisionBlocked(
										typeof fields.question === "string" ? fields.question : "(no question)",
										Array.isArray(fields.suggestions) ? (fields.suggestions as string[]) : undefined,
									)
								: this.eventFeed.decisionAnswered(
										typeof fields.answer === "string" ? fields.answer : undefined,
										fields.timedOut === true,
									),
						fields,
					)
				},
				// Live worker monitoring: mirror each update_todo_list state
				// change on the session's event feed (todo_updated). Non-fatal.
				onTodoEvent: (fields) => {
					void this.emitEvent(
						"todo_updated",
						() =>
							this.eventFeed.todoUpdated({
								todos: fields.todos,
								done: fields.done,
								inProgress: fields.inProgress,
								pending: fields.pending,
							}),
						fields,
					)
				},
				// Cloud vision captioning: every auxiliary LLM call's usage
				// (browser screenshots, describe_image) flows into the SAME
				// BudgetTracker + running totals as a main call, so image cost
				// is never an untracked side channel (recordAuxLlmUsage below).
				// The budgetTracker field is assigned later in run() — handler
				// calls only happen after that, so the closure sees it set.
				onAuxLlmUsage: (usage) => this.recordAuxLlmUsage(usage),
				// Test selection (run_tests): infer files changed since the
				// session's baseline checkpoint, so a worker can verify "did I
				// break anything" against exactly what IT changed — even when
				// the workspace itself is not a git repo. The checkpoint
				// service initializes later in run() (after this executor is
				// constructed), so read it lazily here; undefined → the
				// run_tests handler falls back to the workspace git status.
				getSessionChangedFiles: async () => {
					const svc = this.checkpointService
					if (!svc) {
						return undefined
					}
					const entries = await svc.list()
					const baseline = entries[0]?.hash
					if (!baseline) {
						return undefined
					}
					const diffs = await svc.diff({ from: baseline })
					return diffs.map((d) => d.paths.relative)
				},
			})
		this.sessionId = config.sessionId?.trim() ? config.sessionId.trim() : randomUUID()
		this.parentSessionId = this.config.parentSessionId
		this.recursionDepth = this.config.recursionDepth
		this.maxRecursionDepth = this.config.maxRecursionDepth
		// Checkpoint lineage: root sessions tag commits with just their own id;
		// children append their id to the parent's full lineage chain.
		this.checkpointLineage = this.parentSessionId
			? `${this.config.checkpointLineagePrefix ?? this.parentSessionId}/${this.sessionId}`
			: this.sessionId
		this.eventHook = config.eventHook
		this.eventFeed = new EventFeed(config.workspaceRoot, this.sessionId, (eventType, error) => {
			this.logger.warn(`[events] failed to record '${eventType}' (non-fatal; dashboard misses this event)`, {
				error: error instanceof Error ? error.message : String(error),
			})
		},
		// Recursive task decomposition: stamp the parent/child lineage onto
		// EVERY event of this session's feed so a child's .jsonl is
		// self-describing (the dashboard can render nesting without joining).
		this.parentSessionId ? { parentSessionId: this.parentSessionId, recursionDepth: this.recursionDepth } : undefined)
		// Recursive task decomposition (`new_task`): register the real handler
		// on the headless executor. Read-only executors (reviewer/QA/local
		// explore) already stubbed new_task during construction, so they keep
		// the "not implemented" stub — `has()` is true and this is skipped.
		if (!this.executor.has("new_task")) {
			this.executor.register("new_task", (args) => this.handleNewTask(args))
		}
		// switch_mode (plans/switch-mode-headless.md): same session-bound
		// registration pattern as new_task — the handler needs SESSION state
		// (current mode, transcript, mode-switch counter) plus the shared
		// decision-escalation helper (which needs the per-call ToolContext).
		// Read-only executors (reviewer/QA/local explore) already stubbed it
		// during construction, so they keep the "not implemented" stub.
		if (!this.executor.has("switch_mode")) {
			this.executor.register("switch_mode", (args, ctx) => this.handleSwitchMode(args, ctx))
		}
		// Checkpoints are active when the executor is edit-capable: write_to_file
		// OR any of the surgical edit tools (apply_diff / search_replace /
		// edit_file). An iteration that used ONLY a diff tool must still snapshot
		// the workspace — those are edits too. Read-only executors (reviewer/QA)
		// have none of these and nothing to checkpoint.
		this.checkpointsActive =
			this.config.checkpoints &&
			(this.executor.has("write_to_file") ||
				this.executor.has("apply_diff") ||
				this.executor.has("search_replace") ||
				this.executor.has("edit_file"))
		this.state = {
			systemPrompt: "",
			messages: [],
			tools: [],
			mode: this.config.mode,
			model: this.config.model,
		}
	}

	/**
	 * Build the system prompt (unless overridden), seed the message history and
	 * run the loop to completion. Returns a SessionResult; never throws for
	 * task-level outcomes (LLM errors are returned as `status: "error"`).
	 */
	async run(): Promise<SessionResult> {
		const { workspaceRoot, mode, model } = this.config

		// 1. System prompt + tool selection. customModes is stashed on the
		// session so the new_task handler can reuse it for child mode
		// resolution (avoid re-reading .roomodes per delegation).
		const customModes = this.config.customModes ?? (await loadCustomModes(workspaceRoot))
		this.customModes = customModes
		const systemPrompt =
			this.config.systemPromptOverride ??
			(await buildSystemPrompt({
				workspaceRoot,
				mode,
				customModes,
				globalCustomInstructions: this.config.globalCustomInstructions,
			})).prompt
		// browser_action, describe_image and the code-intelligence tools are
		// not part of the vendored tool set, so selectToolsForMode can't
		// include them — append them explicitly (see src/tools/browser/,
		// src/vision/ and src/codeintel/). The TS-only code-intelligence tools
		// (outline/go_to_definition/find_references/import_graph), rename_symbol
		// (edits files) and run_tests (runs the test suite) are only advertised
		// when THIS session's executor actually registers the handlers: the
		// read-only reviewer/QA executors must not be advertised tools they
		// can't run, and on a non-TS/JS workspace (Python/C++/…) the executor
		// deliberately does not register the ts.Program-based tools at all —
		// so the tool list matches what actually works for the project.
		let tools = appendDescribeImageTool(appendBrowserActionTool(this.config.tools ?? selectToolsForMode(mode, customModes)))
		if (this.executor.has("outline")) {
			tools = appendCodeIntelTools(tools)
		}
		if (this.executor.has("rename_symbol")) {
			tools = appendCodeIntelEditTools(tools)
		}
		if (this.executor.has("run_tests")) {
			tools = appendRunTestsTool(tools)
		}

		this.state.systemPrompt = systemPrompt
		this.state.tools = tools

		// 2. Seed history.
		const messages: ChatMessage[] = [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: this.config.taskText },
		]
		this.state.messages = messages

		// 2b. Phase 3 memory recall (opt-in: null memory = zero behavior
		// change). When a store is configured, query recall for this project
		// and inject a clearly delimited "## PROJECT MEMORY" section into the
		// first user message. Recall failures are non-fatal: the section is
		// simply skipped.
		const recall = await this.recallMemory()
		if (recall.section) {
			messages[1] = { role: "user", content: `${messages[1].content ?? ""}\n\n${recall.section}` }
		}
		this.recallInfo = { recalledFacts: recall.recalledFacts, recalledSessions: recall.recalledSessions }

		// 2bb. OPT-IN local exploration phase (default OFF, see
		// plans/local-explore-phase-experiment.md): a bounded, read-only local Ollama pass
		// runs BEFORE the cloud model's first turn. Its transcript is folded
		// in as a clearly-labeled synthetic message at index 2 (after system +
		// task) so the cloud model can tell it came from a preliminary local
		// pass, not its own prior work. Non-fatal: any local failure skips the
		// phase entirely and the session proceeds exactly as today.
		if (this.config.localExplore) {
			const localResult = await this.runLocalExplore()
			if (localResult?.handoffMessage) {
				messages.splice(2, 0, localResult.handoffMessage)
				this.logger.info("[loop] folded local exploration phase into cloud context", {
					iterations: localResult.iterations,
					terminatedBy: localResult.terminatedBy,
				})
			}
		}

		this.logger.info("[loop] session start", {
			mode,
			model,
			workspaceRoot,
			tools: tools.map((t) => (t.type === "function" ? t.function.name : t.type)),
		})
		// Live worker monitoring: emit the session_start event alongside the
		// human-readable log line above (see src/engine/events.ts). Non-fatal.
		await this.emitEvent("session_start", () =>
			this.eventFeed.sessionStart({ mode, model, workspaceRoot, taskText: this.config.taskText }),
		)

		// 2c. Checkpoints: baseline snapshot before iteration 1 (mirrors Zoo
		// Code's Task.ts:~1447). Non-fatal: any failure just disables
		// checkpoints for the rest of the session (never fails the run).
		await this.initCheckpoints()

		// 3. Run the bounded loop, then persist the session + extracted facts.
		// Memory recording never fails the session (wrapped in try/catch).
		//
		// Cost/token accounting (workstream 3): a BudgetTracker is ALWAYS
		// created now, even when `config.budget` is unset — in that case it's
		// constructed with `{}` (no limits), so `tick()`/`record()` never trip;
		// it's used purely for accounting so usage is always recorded and
		// logged, regardless of whether enforcement caps are configured.
		const startedAt = new Date().toISOString()
		// Recursive task decomposition (`new_task`): a child session is given
		// the PARENT's BudgetTracker instance (internal plumbing, not public
		// config), so its LLM usage lands in the same running total and trips
		// the SAME cost cap — a $0.50-capped parent can't spawn children that
		// each independently spend up to $0.50. Root sessions (no tracker
		// passed) still build one from config as before.
		// Live pricing (Part E): resolve the model's real price ONCE at session
		// start (same /api/v1/models/<id>/endpoints source as the context
		// window) and hand the BudgetTracker a table with the live value merged
		// over the defaults — live wins, the hardcoded table remains the
		// fallback, and which source was used is logged for harness.log.
		// Children reuse the PARENT's tracker (resolved on the parent's run),
		// so the eager fetch is a root-session-only cost.
		let pricingTable: PricingTable | undefined
		if (this.config.budgetTracker === undefined) {
			const livePrice = await this.resolveLiveModelInfo()
			if (livePrice !== undefined) {
				pricingTable = mergeLivePrice(loadPricingTable(), this.config.model, livePrice)
			}
		}
		const budgetTracker =
			this.config.budgetTracker ??
			new BudgetTracker(this.config.budget ?? {}, pricingTable ? { pricing: pricingTable } : {})
		// Stash it on the session so the new_task handler can hand the SAME
		// instance to children (see handleNewTask).
		this.budgetTracker = budgetTracker
		// Decision escalation: wire the budget clock's pause/resume so
		// ask_followup_question doesn't burn duration budget while blocked
		// waiting on a human/orchestrator answer (see executor.ts).
		this.executor.setBudgetClockHooks(
			() => budgetTracker.pauseClock(),
			() => budgetTracker.resumeClock(),
		)
		let result: SessionResult
		try {
			result = await this.runIterations(budgetTracker, startedAt)
		} catch (error) {
			// Defensive: runIterations normally returns SessionResults instead
			// of throwing, but if it ever does, don't leave a stale live usage
			// snapshot behind. Non-fatal (see removeLiveSnapshot), then rethrow.
			await this.removeLiveSnapshot()
			throw error
		} finally {
			// Session teardown: hard-kill any execute_command children that a
			// timeout left running in the background (see ToolExecutor.dispose
			// in src/tools/executor.ts). Runs on EVERY completion path —
			// success, bounded failure, budget abort, or a thrown error — so a
			// backgrounded process is never orphaned past its session. A single
			// tool call timing out mid-session does NOT trigger this: the child
			// keeps running until the session actually ends, exactly as the
			// vendored execute_command timeout contract promises.
			// The iteration loop is over on every path — a background
			// condensation resolving from here on must discard, not splice a
			// message array already consumed by completion (see
			// applyBackgroundCondense).
			this.sessionEnded = true
			this.executor.dispose()
		}
		await this.recordMemory(result)
		// Surface the budget/usage accounting on every result now (previously
		// only present when a budget was configured).
		const usage = budgetTracker.check()
		const budgetUsage: SessionBudgetUsage = {
			costUsd: usage.costUsd,
			elapsedMs: usage.elapsedMs,
			iterations: usage.iterations,
			model: this.config.model,
		}
		const finalResult: SessionResult = { ...result, budgetUsage }

		// Live worker monitoring: emit the terminal session_end event (the
		// feed is KEPT after the session ends — it's a history/replay log,
		// unlike the live usage snapshot which recordUsage deletes). Non-fatal.
		await this.emitEvent("session_end", () =>
			this.eventFeed.sessionEnd({
				status: result.status,
				iterations: result.iterations,
				costUsd: usage.costUsd,
				inputTokens: this.totalInputTokens,
				outputTokens: this.totalOutputTokens,
				cachedTokens: this.totalCachedTokens,
			}),
		)

		// Persist usage for the dashboard (workstream 3). Non-fatal: any
		// failure is logged as a warning and never fails the session, matching
		// the memory-recording/checkpoint try/catch idiom above.
		await this.recordUsage(finalResult, startedAt)

		return finalResult
	}

	/**
	 * Cost/token monitoring (workstream 3): append one JSON line to
	 * `<workspaceRoot>/.headlesscode/usage/<sessionId>.jsonl` describing this
	 * completed session (success, error, or budget-exceeded — every path that
	 * returns a SessionResult reaches here via `run()`). Non-fatal: any
	 * failure is logged as a warning and never fails the session.
	 */
	private async recordUsage(result: SessionResult, startedAt: string): Promise<void> {
		try {
			await recordSessionUsage(this.config.workspaceRoot, {
				sessionId: this.sessionId,
				mode: this.config.mode,
				model: this.config.model,
				iterations: result.iterations,
				inputTokens: this.totalInputTokens,
				outputTokens: this.totalOutputTokens,
				cachedTokens: this.totalCachedTokens,
				costUsd: result.budgetUsage?.costUsd ?? 0,
				startedAt,
				endedAt: new Date().toISOString(),
				status: result.status === "success" ? "success" : result.reason === "budget" ? "budget" : "error",
				workspaceRoot: this.config.workspaceRoot,
			})
		} catch (error) {
			this.logger.warn("[usage] failed to persist session usage (non-fatal; dashboard will miss this session)", {
				error: error instanceof Error ? error.message : String(error),
			})
		}
		// The final `.jsonl` record is the authoritative source once the
		// session completes (success, error, or budget-exceeded — every path
		// that returns a SessionResult reaches here via `run()`), so the
		// per-iteration live snapshot is now stale. Delete it. Non-fatal.
		await this.removeLiveSnapshot()
	}

	/**
		* Live (in-progress) usage visibility: overwrite the snapshot at
		* `<workspaceRoot>/.headlesscode/usage/<sessionId>.live.json` after each
		* iteration so the dashboard can show a still-running session's
		* accumulating cost/tokens/iteration count. Same running totals as the
		* `[usage] running total` log line. Non-fatal: any failure is logged as a
		* warning and never affects the session.
		*/
	private async writeLiveSnapshot(startedAt: string, iteration: number, costUsd: number): Promise<void> {
		try {
			await writeLiveUsage(this.config.workspaceRoot, {
				sessionId: this.sessionId,
				mode: this.config.mode,
				model: this.config.model,
				iterations: iteration,
				inputTokens: this.totalInputTokens,
				outputTokens: this.totalOutputTokens,
				cachedTokens: this.totalCachedTokens,
				costUsd,
				startedAt,
				status: "running",
				workspaceRoot: this.config.workspaceRoot,
			})
		} catch (error) {
			this.logger.warn("[usage] failed to write live snapshot (non-fatal; dashboard only sees this session once it finishes)", {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	/**
		* Live (in-progress) usage visibility: delete the session's live snapshot.
		* Called on every completion path (success via `recordUsage`, error, and
		* budget-exceeded — all flow back through `run()`/`recordUsage()`, plus a
		* defensive call if `runIterations` ever throws). Non-fatal: a failure is
		* logged as a warning and never affects the session.
		*/
	private async removeLiveSnapshot(): Promise<void> {
		try {
			await removeLiveUsage(this.config.workspaceRoot, this.sessionId)
		} catch (error) {
			this.logger.warn("[usage] failed to remove live snapshot (non-fatal)", {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	/**
	 * Live worker monitoring: append one structured event to the session's
	 * feed, fire the injected eventHook, and never let a feed failure affect
	 * the session (non-fatal — matches the memory/usage/checkpoint idiom).
	 */
	private async emitEvent(
		eventType: string,
		write: () => Promise<void>,
		fields: Record<string, unknown> = {},
	): Promise<void> {
		try {
			await write()
			this.eventHook?.(eventType, fields)
		} catch (error) {
			this.logger.warn(`[events] failed to record '${eventType}' (non-fatal; dashboard misses this event)`, {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	/**
	 * Issue #34 — the final report was the single most information-dense
	 * moment of any session and the least observable: `attempt_completion`
	 * short-circuits at step 6a BEFORE the tool-execution loop, so no
	 * tool_call/tool_result pair was ever recorded for it, and only a narrow
	 * parsed slice (`qa.evidence`, review findings) survived into the
	 * orchestrator state. Both gaps are closed here, at the one place every
	 * success path funnels through:
	 *
	 *   1. emit an `attempt_completion` event carrying the FULL report text
	 *      (deliberately not truncated — see EventFeed.attemptCompletion);
	 *   2. persist the complete report to
	 *      `<workspaceRoot>/.headlesscode/reports/<sessionId>.md` and return
	 *      its path, so runQa/runReview → the orchestrator state can point at
	 *      it and the reasoning behind a surprising verdict is one file-read
	 *      away, never a re-run away.
	 *
	 * Non-fatal on both paths (matches the memory/usage/events idiom): a feed
	 * or report-write failure is logged as a warning and the session still
	 * completes with `reportPath` absent.
	 */
	private async persistFinalReport(iteration: number, result: string): Promise<string | undefined> {
		await this.emitEvent(
			"attempt_completion",
			() => this.eventFeed.attemptCompletion({ iteration, result }),
			{ iteration },
		)
		try {
			const reportPath = await writeSessionReport(this.config.workspaceRoot, this.sessionId, result)
			this.logger.info("[loop] final report persisted", { reportPath })
			return reportPath
		} catch (error) {
			this.logger.warn("[loop] failed to persist final report (non-fatal; full report is one re-run away)", {
				error: error instanceof Error ? error.message : String(error),
			})
			return undefined
		}
	}

	/**
	 * Pause/resume (dashboard control): called before each iteration's LLM
	 * call (the same safe boundary where budgetTracker.tick() runs — never
	 * mid-tool-call). When `<workspaceRoot>/.harness.pause-requested` is
	 * present, writes the `.harness.paused` status marker, emits a `paused`
	 * event, pauses the budget clock, and blocks polling for the marker's
	 * REMOVAL (resume = delete the marker) — up to `maxPauseMs`, after which
	 * the loop auto-resumes (a forgotten pause must never hang a worker
	 * forever). On resume the marker is deleted, a `resumed` event is emitted
	 * and the budget clock resumes, so a paused session is never penalized
	 * for wall-clock duration. Marker-file failures are non-fatal.
	 */
	private async checkPauseRequested(budgetTracker: BudgetTracker): Promise<void> {
		const root = this.config.workspaceRoot
		const requestedPath = path.join(root, PAUSE_REQUESTED_FILENAME)
		const pausedPath = path.join(root, PAUSED_FILENAME)
		try {
			await fsp.access(requestedPath)
		} catch {
			return // No pause requested — normal running.
		}

		this.logger.info("[pause] pause requested — blocking", { maxPauseMs: this.config.maxPauseMs })
		try {
			await fsp.writeFile(pausedPath, new Date().toISOString() + "\n", "utf-8")
		} catch (error) {
			this.logger.warn("[pause] failed to write .harness.paused (non-fatal; continuing unpaused)", {
				error: error instanceof Error ? error.message : String(error),
			})
			return
		}
		await this.emitEvent("paused", () => this.eventFeed.paused(), {})
		budgetTracker.pauseClock()

		const started = Date.now()
		let autoResumed = false
		try {
			while (Date.now() - started < this.config.maxPauseMs) {
				let exists = false
				try {
					await fsp.access(requestedPath)
					exists = true
				} catch {
					exists = false
				}
				if (!exists) {
					break // Marker removed — resume.
				}
				await sleep(Math.min(this.config.pausePollIntervalMs, this.config.maxPauseMs - (Date.now() - started)))
			}
			autoResumed = Date.now() - started >= this.config.maxPauseMs
		} finally {
			budgetTracker.resumeClock()
			await this.emitEvent(
				"resumed",
				() => this.eventFeed.resumed(autoResumed ? "auto-resume: max pause duration reached" : undefined),
				{},
			)
			try {
				await fsp.unlink(pausedPath)
			} catch {
				// Already gone / never existed — fine either way.
			}
		}
		if (autoResumed) {
			this.logger.warn("[pause] max pause duration reached — auto-resuming", {
				maxPauseMs: this.config.maxPauseMs,
			})
		} else {
			this.logger.info("[pause] resume requested — continuing")
		}
	}

	/**
		* Mid-session message injection (live chat-UI control): called at the SAME
		* safe boundary as checkPauseRequested (before each iteration's LLM call —
		* never mid-tool-call). When `<workspaceRoot>/.harness.inject-message` is
		* present (JSON `{ text, injectedAt }` — written by the dashboard's
		* POST /api/session/:id/message), appends `text` to the session's live
		* message array as a plain user-role message, emits a `message_injected`
		* event, and deletes the marker. The next LLM call then sees the message
		* exactly as if the user had typed it in a normal back-and-forth — NOT as
		* a tool result or a system interruption notice.
		*
		* This boundary is safe for the SAME reason it's safe for pause: every
		* prior assistant `tool_calls` message has ALL its matching `tool` results
		* already appended (never an orphaned tool_calls group — inserting a user
		* message mid-group would break the assistant→tool adjacency strict
		* providers 400 on). Once appended, the injected message is just a normal
		* user-role history entry: it participates in truncateHistory/condensation
		* like any other message, and the mechanism is mode-agnostic (session-level,
		* not gated by mode). Marker failures are non-fatal. Policy: ONE pending
		* message — a later POST overwrites an earlier one (overwrite-with-latest,
		* no queue); a malformed marker is logged and deleted so the loop doesn't
		* trip over it every iteration.
		*/
	private async checkInjectedMessage(): Promise<void> {
		const root = this.config.workspaceRoot
		const markerPath = path.join(root, INJECT_MESSAGE_FILENAME)
		let raw: string
		try {
			raw = await fsp.readFile(markerPath, "utf-8")
		} catch {
			return // No injection pending — normal running.
		}

		let text: string | undefined
		try {
			const parsed = JSON.parse(raw) as { text?: unknown }
			if (typeof parsed.text === "string" && parsed.text.trim() !== "") {
				text = parsed.text.trim()
			}
		} catch {
			// Malformed JSON — handled below.
		}
		if (text === undefined) {
			this.logger.warn("[inject] malformed .harness.inject-message — ignoring and removing it", {})
			try {
				await fsp.rm(markerPath, { force: true })
			} catch (error) {
				this.logger.warn("[inject] failed to remove malformed .harness.inject-message (non-fatal)", {
					error: error instanceof Error ? error.message : String(error),
				})
			}
			return
		}

		// Consume the marker BEFORE appending: if the removal fails, no message
		// is injected this iteration and the marker is simply retried next
		// iteration — a failure between push and delete would otherwise
		// re-inject the same message on the next iteration.
		try {
			await fsp.rm(markerPath, { force: true })
		} catch (error) {
			this.logger.warn("[inject] failed to remove .harness.inject-message (non-fatal; will retry next iteration)", {
				error: error instanceof Error ? error.message : String(error),
			})
			return
		}

		this.state.messages.push({ role: "user", content: text })
		this.logger.info("[inject] message injected into live history", { history: this.state.messages.length })
		await this.emitEvent("message_injected", () => this.eventFeed.messageInjected({ text }), {})
	}

	/**
		* Phase 3 context condensation: resolve the model's real context window
	 * (once per session) and, when the LAST request's real prompt tokens
	 * crossed the threshold, replace the oldest turns with one synthetic
	 * summary message. Non-fatal: any failure falls back to
	 * `truncateHistory` for that call. The condensation call's own usage is
	 * fed into the SAME BudgetTracker + running totals as the main session
	 * (constraint 2 — never invisible spend).
	 */
	private async maybeCondenseHistory(
		iteration: number,
		messages: ChatMessage[],
		budgetTracker: BudgetTracker,
	): Promise<ChatMessage[]> {
		if (!(this.lastLlmUsage && this.lastLlmUsage.inputTokens > 0)) {
			return messages
		}
		const config = this.config

		// Resolve the real context window at most once per session (explicit
		// config, then a live OpenRouter lookup, then the conservative default
		// — see resolveContextWindowTokens).
		const contextWindowTokens = await this.resolveContextWindowTokens()

		// Async early-fire (plans/smart-condensation-async.md part 2): when
		// the last request's real size is inside the EARLY window (above the
		// early-fire fraction, below the hard threshold), kick off the
		// condensation LLM call in the background against an immutable snapshot
		// and keep going — the splice lands when it resolves (see
		// applyBackgroundCondense). This is latency-hiding, NOT a replacement
		// for the synchronous hard-threshold path below: a slow or failed
		// background job must never delay or suppress it (the hard fallback is
		// the load-bearing safety property of the design).
		this.fireBackgroundCondense(iteration, messages, budgetTracker, contextWindowTokens)

		try {
			const condensed = await maybeCondense({
				llmClient: this.llmClient,
				logger: this.logger,
				messages,
				model: config.model,
				lastPromptTokens: this.lastLlmUsage.inputTokens,
				contextWindowTokens,
				thresholdFraction: config.condenseThresholdFraction,
				condensedUpTo: this.condensedUpToMsgIndex,
				condenseInFlight: this.condenseInFlight,
				condenseModel: config.condenseModel,
				condenseMaxTokens: config.condenseMaxTokens ?? config.maxTokens,
				condenseAbortSignal: undefined,
				onUsage: (usage) => this.recordCondensationUsage(usage, budgetTracker),
			})
			if (condensed !== null) {
				// Replace the working state IN PLACE so the loop's local
				// `messages` reference (aliased to this.state.messages) and
				// this.state.messages both see the condensed array — the
				// sent prefix then stays stable across subsequent calls
				// (never re-condense the same chunk).
				const messagesBefore = messages.length
				messages.splice(0, messages.length, ...condensed)
				// Emit the feed event the timeline needs: condensation used to
				// be only a log line, invisible to the dashboard. Non-fatal.
				await this.emitEvent("condensed", () =>
					this.eventFeed.condensed({
						iteration,
						messagesBefore,
						messagesAfter: condensed.length,
						...(this.lastCondenseUsage
							? {
									inputTokens: this.lastCondenseUsage.inputTokens,
									outputTokens: this.lastCondenseUsage.outputTokens,
									cachedTokens: this.lastCondenseUsage.cachedTokens,
								}
							: {}),
					}),
				)
				return messages
			}
			return messages
		} catch (error) {
			// A budget trip from the condensation call's usage accounting is
			// NOT non-fatal — it must abort the session exactly like a main
			// call's record() trip (never silently under-report spend).
			if (error instanceof BudgetExceededError) {
				throw error
			}
			// Non-fatal: fall back to truncateHistory for this call.
			this.logger.warn("[condense] condensation failed (non-fatal; falling back to message-count truncation)", {
				error: error instanceof Error ? error.message : String(error),
			})
			return messages
		}
	}

	/**
	 * Resolve the model's real context window + pricing AT MOST ONCE per
	 * session via a single /api/v1/models/<id>/endpoints lookup
	 * (src/llm/openrouter.ts's fetchModelInfo), caching BOTH values — the
	 * pricing for the BudgetTracker's live table (Part E), the context window
	 * for the condensation checks (which then short-circuit on the cached
	 * value instead of re-fetching). Deliberately fail-open and non-fatal: a
	 * missing/failed lookup leaves `resolvedLivePrice` undefined and the
	 * session uses DEFAULT_PRICING_TABLE (or the env-merged table) exactly as
	 * before live pricing existed, with a harness.log line recording which
	 * source was used. Bounded by a 5s timeout so a hung OpenRouter never
	 * blocks session start.
	 */
	private async resolveLiveModelInfo(): Promise<ModelPrice | undefined> {
		if (this.modelInfoResolved) {
			return this.resolvedLivePrice
		}
		this.modelInfoResolved = true
		const client = this.llmClient as {
			fetchModelInfo?: (model: string, signal?: AbortSignal) => Promise<{ contextWindow?: number; price?: ModelPrice } | undefined>
		}
		let info: { contextWindow?: number; price?: ModelPrice } | undefined
		try {
			const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(5_000) : undefined
			info = await client.fetchModelInfo?.(this.config.model, signal)
		} catch (error) {
			this.logger.warn("[budget] live pricing/context-window lookup failed (non-fatal; using hardcoded pricing table)", {
				error: error instanceof Error ? error.message : String(error),
			})
			return undefined
		}
		if (info?.contextWindow !== undefined && info.contextWindow > 0) {
			this.resolvedContextWindowTokens = info.contextWindow
		}
		if (info?.price !== undefined) {
			this.resolvedLivePrice = info.price
			this.logger.info("[budget] resolved live pricing from OpenRouter models endpoint", {
				model: this.config.model,
				input: info.price.input,
				output: info.price.output,
				...(info.price.cacheRead !== undefined ? { cacheRead: info.price.cacheRead } : {}),
			})
		} else {
			this.logger.warn("[budget] live pricing unavailable; using hardcoded DEFAULT_PRICING_TABLE (non-fatal)", {
				model: this.config.model,
			})
		}
		return this.resolvedLivePrice
	}

	/**
	 * Resolve the model's real context window at most once per session:
	 * explicit config wins, then a live OpenRouter lookup (the same
	 * /api/v1/models/<id>/endpoints source the pricing table was verified
	 * against — see src/llm/openrouter.ts's fetchModelContextWindow), then the
	 * conservative default. The resolved value is cached on the session
	 * (`resolvedContextWindowTokens`) so every later check reuses it instead
	 * of re-defaulting to 128k — the 2026-08-04 bug fix (the boolean alone
	 * recorded that a lookup was ATTEMPTED, never what it resolved TO). Shared
	 * by the synchronous condensation check and the async early-fire check.
	 */
	private async resolveContextWindowTokens(): Promise<number> {
		const config = this.config
		if (config.contextWindowTokens !== undefined) {
			return config.contextWindowTokens
		}
		if (this.resolvedContextWindowTokens !== undefined) {
			// Already resolved live earlier THIS session — reuse it.
			return this.resolvedContextWindowTokens
		}
		let contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS
		if (!this.contextWindowResolved) {
			this.contextWindowResolved = true
			const client = this.llmClient as {
				fetchModelContextWindow?: (model: string) => Promise<number | undefined>
			}
			try {
				const live = await client.fetchModelContextWindow?.(config.model)
				if (live !== undefined && live > 0) {
					contextWindowTokens = live
					this.resolvedContextWindowTokens = live
					this.logger.info("[condense] resolved live context window from OpenRouter models endpoint", {
						model: config.model,
						contextWindowTokens: live,
					})
				} else {
					// Silent-undefined is the common failure mode (lookup
					// returned nothing, not an exception) — log it so a
					// fallback to 128k is always visible in harness.log.
					this.logger.warn("[condense] live context-window lookup returned no value (non-fatal; using conservative default)", {
						model: config.model,
						contextWindowTokens,
					})
				}
			} catch (error) {
				this.logger.warn("[condense] live context-window lookup failed (non-fatal; using conservative default)", {
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
		return contextWindowTokens
	}

	/**
	 * Async/background condensation (plans/smart-condensation-async.md part
	 * 2): when the last request's real prompt-token count is inside the EARLY
	 * window (above `condenseEarlyFireFraction`, below the hard threshold),
	 * fire the condensation LLM call against an immutable SNAPSHOT of the
	 * messages and DON'T await it — the main loop keeps appending. On resolve,
	 * `applyBackgroundCondense` splices the summary into the live history at
	 * the re-resolved boundary; on failure it's a logged, non-fatal wasted
	 * call. The synchronous hard-threshold path is the load-bearing safety net
	 * and is NEVER suppressed by a pending background job (this method never
	 * touches `condenseInFlight`).
	 *
	 * One in-flight background job at a time (`backgroundCondense`); firing a
	 * second while the first is pending is deliberately NOT handled — a
	 * conversation that still needs another condensation right after one
	 * resolved is a signal the early-fire fraction needs tuning, not a case to
	 * solve by overlapping calls.
	 */
	private fireBackgroundCondense(
		iteration: number,
		messages: ChatMessage[],
		budgetTracker: BudgetTracker,
		contextWindowTokens: number,
	): void {
		const config = this.config
		const lastPromptTokens = this.lastLlmUsage?.inputTokens ?? 0
		const hardThreshold = Math.max(1, contextWindowTokens * config.condenseThresholdFraction)
		const earlyThreshold = Math.max(1, contextWindowTokens * config.condenseEarlyFireFraction)
		// Misconfigured early-fire fraction (>= the hard threshold): the early
		// window is empty — the async path is safely OFF (sync-only) rather
		// than erroring.
		if (earlyThreshold >= hardThreshold) {
			return
		}
		// Only the early window is ours: below it there's nothing to hide yet;
		// at/above the hard threshold the SYNCHRONOUS path owns the decision
		// (and must never find a background job standing in its way).
		if (!(earlyThreshold <= lastPromptTokens && lastPromptTokens < hardThreshold)) {
			return
		}
		if (this.backgroundCondense !== null) {
			return // one in-flight background condensation at a time
		}
		if (this.condenseInFlight.value) {
			return // a synchronous condensation is running — don't overlap it
		}
		// Same batch-once-stable guard as the synchronous path: after a
		// condensation the uncompressed tail must re-grow meaningfully before
		// condensing again, or the sent prefix would be rewritten every call
		// and defeat provider-side prompt caching.
		const alreadyCondensed = this.condensedUpToMsgIndex.value > 2
		if (alreadyCondensed && messages.length - this.condensedUpToMsgIndex.value < MIN_CONDENSE_TAIL_GROWTH) {
			return
		}
		// Same shared boundary math as the sync path (computeCondensePlan →
		// computeCondenseCount): the snapshot boundary is tool-call-group-safe
		// BY CONSTRUCTION at fire time (re-verified against the live state at
		// apply time).
		const plan = computeCondensePlan(messages, lastPromptTokens, contextWindowTokens, config.condenseThresholdFraction)
		if (plan.count < 2) {
			return
		}
		// Snapshot, don't share state: the call works against ONLY this array.
		// Message objects are never mutated once pushed (the loop only appends;
		// the one in-place mutation is the condensation splice itself), so a
		// reference slice is a stable, immutable-in-practice snapshot while the
		// live array keeps growing under the main loop.
		const snapshot = messages.slice(0, 2 + plan.count)
		this.logger.info("[condense] early-fire background condensation — hiding latency", {
			iteration,
			lastPromptTokens,
			earlyThreshold: Math.round(earlyThreshold),
			hardThreshold: Math.round(hardThreshold),
			count: plan.count,
			condenseModel: config.condenseModel,
		})
		const job = { snapshot, count: plan.count, firedAtIteration: iteration }
		this.backgroundCondense = job
		condenseOldestTurns(this.llmClient, {
			messages: snapshot,
			count: plan.count,
			model: config.condenseModel,
			maxTokens: config.condenseMaxTokens ?? config.maxTokens,
			onUsage: (usage) => this.recordCondensationUsage(usage, budgetTracker),
		})
			.then(async (summary) => {
				// The job is done (applied or discarded) — a NEW background job
				// may fire on a later iteration.
				this.backgroundCondense = null
				await this.applyBackgroundCondense(job, summary)
			})
			.catch((error) => {
				this.backgroundCondense = null
				if (error instanceof BudgetExceededError) {
					// Budget trip from the background call's OWN accounting: the
					// usage was already recorded into the tracker, so the NEXT
					// budgetTracker.tick() in the loop aborts the session exactly
					// like a main call's record() trip — the same
					// non-fatal-here / fatal-next-tick pattern as
					// recordAuxLlmUsage.
					this.logger.warn("[condense] background condensation tripped the budget (next tick aborts the session)", {
						iteration,
						error: error.message,
						costUsd: budgetTracker.totalCostUsd,
					})
					return
				}
				this.logger.warn("[condense] background condensation call failed (non-fatal; synchronous hard-threshold path still applies)", {
					iteration,
					error: error instanceof Error ? error.message : String(error),
				})
			})
	}

	/**
	 * Apply a resolved background condensation to the LIVE history, or discard
	 * it. The splice point is re-resolved against the CURRENT state, never the
	 * stale snapshot:
	 *   - session already ended → discard (a wasted-but-harmless call; its
	 *     usage already landed in the BudgetTracker via recordCondensationUsage);
	 *   - a synchronous condensation is in flight → discard (it will splice the
	 *     same region itself on completion; applying on top would double-
	 *     condense and corrupt the history — the sync path is authoritative);
	 *   - the live prefix no longer matches the snapshot → discard (something
	 *     upstream of the snapshot point was mutated — the stable-prefix
	 *     assumption is verified explicitly, never silently);
	 *   - the boundary lands mid tool-call-group → discard (the same DeepSeek
	 *     HTTP 400 class of bug the sync path's computeCondenseCount prevents).
	 * Otherwise the summary replaces [2, 2+count) of the live array, exactly
	 * as the synchronous path would have, and `condensedUpToMsgIndex` advances
	 * so the batch-once-stable guard applies to later re-fires.
	 */
	private async applyBackgroundCondense(
		job: { snapshot: ChatMessage[]; count: number; firedAtIteration: number },
		summary: string,
	): Promise<void> {
		const config = this.config
		if (this.sessionEnded) {
			this.logger.info("[condense] background condensation resolved after session end — discarded (wasted-but-harmless call)", {
				firedAtIteration: job.firedAtIteration,
				count: job.count,
				condenseModel: config.condenseModel,
			})
			return
		}
		const messages = this.state.messages
		const boundary = 2 + job.count
		if (this.condenseInFlight.value) {
			// The synchronous path is mid-call right now (the hard threshold
			// was hit while this background job was still pending). It will
			// replace the array itself on completion — applying this result on
			// top would double-condense. The sync path is authoritative.
			this.logger.info("[condense] background condensation superseded by the synchronous path — discarded", {
				firedAtIteration: job.firedAtIteration,
			})
			return
		}
		// Verify the stable-prefix assumption explicitly (reference equality
		// per index is authoritative: message objects are never mutated in
		// place once pushed). If the prefix drifted — e.g. a synchronous
		// condensation already ran while this job was pending — the snapshot
		// boundary no longer exists in the live array and the splice must not
		// apply blindly.
		if (!messagesPrefixEquals(messages, job.snapshot)) {
			this.logger.warn("[condense] background condensation discarded — live prefix no longer matches the snapshot", {
				firedAtIteration: job.firedAtIteration,
				count: job.count,
			})
			return
		}
		// Tool-call-group boundary safety against the CURRENT state, reusing
		// the sync path's shared helper: the kept tail must never start with
		// an orphaned `tool` message. The snapshot boundary was group-safe at
		// fire time, so a skip here means the live prefix drifted — discard
		// rather than produce a request strict providers would HTTP 400.
		if (skipOrphanedToolMessages(messages, boundary) !== boundary) {
			this.logger.warn("[condense] background condensation discarded — boundary landed mid tool-call group", {
				firedAtIteration: job.firedAtIteration,
			})
			return
		}
		const messagesBefore = messages.length
		const condensed: ChatMessage[] = [
			messages[0],
			messages[1],
			buildCondensedMessage(summary),
			...messages.slice(boundary),
		]
		messages.splice(0, messages.length, ...condensed)
		// Advance the marker BEFORE any await so a re-fire on a later iteration
		// hits the batch-once-stable guard (the sent prefix with the summary at
		// index 2 stays byte-identical across calls — what prompt caching needs).
		this.condensedUpToMsgIndex.value = 3
		this.logger.info("[condense] background condensation applied", {
			firedAtIteration: job.firedAtIteration,
			count: job.count,
			historyBefore: messagesBefore,
			historyAfter: condensed.length,
		})
		// Same feed event the synchronous path emits (see maybeCondenseHistory)
		// so the dashboard timeline shows background condensation too. Non-fatal.
		await this.emitEvent("condensed", () =>
			this.eventFeed.condensed({
				iteration: job.firedAtIteration,
				messagesBefore,
				messagesAfter: condensed.length,
				...(this.lastCondenseUsage
					? {
							inputTokens: this.lastCondenseUsage.inputTokens,
							outputTokens: this.lastCondenseUsage.outputTokens,
							cachedTokens: this.lastCondenseUsage.cachedTokens,
						}
					: {}),
			}),
		)
	}

	/**
	 * Feed a condensation call's usage into the same BudgetTracker + running
	 * totals as the main session (constraint 2). Mirrors the main call's
	 * accounting block in runIterations — including the budget-limit trip
	 * path (a condensation call that pushes spend over a configured cap must
	 * abort the session exactly like a main call would).
	 */
	private recordCondensationUsage(
		usage: NonNullable<LlmResponse["usage"]>,
		budgetTracker: BudgetTracker,
	): void {
		const inputTokens = usage.promptTokens ?? 0
		const outputTokens = usage.completionTokens ?? 0
		const cachedTokens = usage.cachedTokens ?? 0
		this.totalInputTokens += inputTokens
		this.totalOutputTokens += outputTokens
		this.totalCachedTokens += cachedTokens
		this.lastCondenseUsage = { inputTokens, outputTokens, cachedTokens }
		try {
			budgetTracker.record({
				model: this.config.condenseModel,
				inputTokens,
				outputTokens,
				cachedTokens,
			})
		} catch (err) {
			// Rethrow — the caller (runIterations) turns a BudgetExceededError
			// into a budgetFailure result, same as a main call's record() trip.
			throw err
		}
		this.logger.info("[usage] condensation call recorded", {
			inputTokens,
			outputTokens,
			cachedTokens,
			costUsd: budgetTracker.totalCostUsd,
		})
	}

	/** recordCondensationUsage, but a budget trip is swallowed (logged, not rethrown) — see writeIterationCapHandoff's doc comment. */
	private recordHandoffCondensationUsage(usage: NonNullable<LlmResponse["usage"]>, budgetTracker: BudgetTracker): void {
		try {
			this.recordCondensationUsage(usage, budgetTracker)
		} catch (err) {
			this.logger.warn("[handoff] usage accounting hit a budget limit (non-fatal, ignored)", {
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	/**
	 * Cross-restart handoff (see src/engine/handoff.ts): called ONLY when a
	 * session is about to end with `maxIterations` exhausted — the case where
	 * the orchestrator spawns a brand-new-conversation continuation worker on
	 * the same worktree. Summarizes the ENTIRE session history (not just the
	 * oldest chunk — there is no future turn left to keep a verbatim tail for)
	 * via the same condenseOldestTurns LLM-compression call the mid-session
	 * condensation path uses, and writes the result to
	 * `<workspaceRoot>/.headlesscode/handoff-summary.md` for the continuation
	 * task file to inline.
	 *
	 * Non-fatal by design: this is a courtesy write on the way out of a
	 * session that has already failed for a different reason (the iteration
	 * cap). ANY failure here — including a BudgetExceededError from the
	 * summarization call's own usage — is caught and logged, never allowed to
	 * change or mask the max-iterations result the caller is about to return.
	 */
	private async writeIterationCapHandoff(messages: ChatMessage[], budgetTracker: BudgetTracker): Promise<void> {
		const config = this.config
		try {
			// No system/first-user messages to summarize, or a session too short
			// for the tool-group-safe slice below to be meaningful.
			if (messages.length <= 3) {
				return
			}
			// Cap the input handed to the summarization call (MAX_CONDENSE_INPUT_CHARS):
			// walk forward from the oldest turn until the REMAINING suffix fits the
			// cap, dropping only the oldest, least-actionable material if the full
			// history is too large for one call. Reconstructed as a
			// [system, firstUser, ...tail] array so condenseOldestTurns's
			// `slice(2, 2 + count)` contract still lands exactly on the tail.
			let startIndex = 2
			let suffixChars = 0
			for (let i = messages.length - 1; i >= 2; i--) {
				suffixChars += estimateMessageChars(messages[i])
				if (suffixChars > MAX_CONDENSE_INPUT_CHARS) {
					startIndex = i + 1
					break
				}
			}
			const toSummarize = [messages[0], messages[1], ...messages.slice(startIndex)]
			const count = toSummarize.length - 2
			if (count < 1) {
				return
			}
			// Retry once on failure: this call happens at MOST once per session
			// (right on the way out, when there's no further iteration to fall
			// back to), so a single transient hiccup — observed live: DeepSeek's
			// pinned official endpoint briefly reporting "no allowed providers
			// available" — would otherwise silently drop the entire handoff for
			// that continuation cycle. Mirrors fetchModelContextWindow's own
			// once-per-session retry-with-backoff (src/llm/openrouter.ts).
			let summary: string
			try {
				summary = await condenseOldestTurns(this.llmClient, {
					messages: toSummarize,
					count,
					model: config.condenseModel,
					maxTokens: config.condenseMaxTokens ?? config.maxTokens,
					onUsage: (usage) => this.recordHandoffCondensationUsage(usage, budgetTracker),
				})
			} catch (firstError) {
				this.logger.warn("[handoff] condensation call failed, retrying once after a short backoff", {
					error: firstError instanceof Error ? firstError.message : String(firstError),
				})
				await sleep(250) // matches fetchModelContextWindow's own once-per-session backoff
				summary = await condenseOldestTurns(this.llmClient, {
					messages: toSummarize,
					count,
					model: config.condenseModel,
					maxTokens: config.condenseMaxTokens ?? config.maxTokens,
					onUsage: (usage) => this.recordHandoffCondensationUsage(usage, budgetTracker),
				})
			}
			const header =
				`# Handoff summary — written when the previous session hit the iteration cap\n\n` +
				`Generated ${new Date().toISOString()}, condensing ${count} of ${messages.length - 2} history messages ` +
				`(startIndex=${startIndex}) with model ${config.condenseModel}.\n\n---\n\n`
			const file = await writeHandoffSummary(config.workspaceRoot, header + summary)
			this.logger.info("[handoff] wrote iteration-cap handoff summary", { file, count })
		} catch (error) {
			this.logger.warn("[handoff] failed to write iteration-cap handoff summary (non-fatal)", {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	/**
		* Feed an auxiliary LLM call's usage — cloud vision captioning
		* (src/vision/describe.ts): browser screenshots and the describe_image
		* tool — into the same BudgetTracker + running session totals as a main
		* call, so image cost shows up in the session's real total instead of an
		* untracked side channel. A budget trip from this spend propagates to the
		* tool handler that made the call; the next tick() then aborts the session
		* exactly like a main call's record() trip.
		*/
	private recordAuxLlmUsage(usage: AuxLlmUsage): void {
		const inputTokens = usage.inputTokens
		const outputTokens = usage.outputTokens
		const cachedTokens = usage.cachedTokens ?? 0
		this.totalInputTokens += inputTokens
		this.totalOutputTokens += outputTokens
		this.totalCachedTokens += cachedTokens
		const budgetTracker = this.budgetTracker
		if (budgetTracker === null) {
			return // no tracker — pure accounting is impossible; nothing else to do
		}
		try {
			budgetTracker.record({
				model: usage.model,
				inputTokens,
				outputTokens,
				cachedTokens,
			})
		} catch (err) {
			// Rethrow — the tool handler that made the call surfaces it (see
			// the browser screenshot / describe_image handlers) and the next
			// tick() converts it into a budgetFailure session result.
			throw err
		}
		this.logger.info("[usage] auxiliary LLM call recorded", {
			model: usage.model,
			inputTokens,
			outputTokens,
			cachedTokens,
			costUsd: budgetTracker.totalCostUsd,
		})
	}

	/**
	 * One attempt at the main per-iteration LLM call, with its own fresh
	 * AbortController/timeout (a retried attempt must not inherit an
	 * already-aborted signal from a prior attempt's timer — see the two
	 * call sites in runIterations). Throws on failure exactly like a direct
	 * `this.llmClient.createChatCompletion` call would; callers decide
	 * whether a given failure is worth retrying (isRetryableOpenRouterError).
	 */
	private async callMainLlm(requestMessages: ChatMessage[], iteration: number): Promise<LlmResponse> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs)
		try {
			return await this.llmClient.createChatCompletion({
				model: this.config.model,
				messages: requestMessages,
				tools: this.state.tools,
				temperature: this.config.temperature,
				maxTokens: this.config.maxTokens,
				signal: controller.signal,
				stream: this.config.stream,
				reasoningEffort: this.config.reasoningEffort,
				onStreamChunk: (kind, chunk) => {
					// Dashboard live-typing: forward each chunk to the event feed
					// (truncated like other large fields). Non-fatal — a feed
					// write failure must never abort the LLM call.
					void this.emitEvent(
						"llm_stream_chunk",
						() => this.eventFeed.llmStreamChunk({ iteration, kind, chunk }),
						{ iteration },
					)
				},
			})
		} finally {
			clearTimeout(timer)
		}
	}

	private async runIterations(budgetTracker: BudgetTracker, startedAt: string): Promise<SessionResult> {
		const { maxIterations, consecutiveErrorLimit } = this.config
		const messages = this.state.messages
		let consecutiveMistakes = 0
		let lastCallSignature: string | undefined
		let toolCalls = 0
		// Commit-before-finishing guardrail: whether the one-per-session
		// "uncommitted changes" nudge has already been given. A retried
		// attempt_completion is always accepted afterwards (see
		// COMMIT_NUDGE_CONTENT).
		let completionNudged = false
		// Blind tree-walking guardrail (P1.6): count consecutive read-only
		// iterations; when the streak crosses the threshold AND the workspace
		// is indexed, inject one soft nudge per streak (see READ_ONLY_NUDGE_MESSAGE).
		const readOnlyNudgeThreshold = envReadOnlyNudgeThreshold()
		let readOnlyStreak = 0
		let readOnlyNudgeInjected = false

		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			// Recursive task decomposition (`new_task`): remember the iteration
			// number so the handler can compute a child's default maxIterations
			// from the parent's REMAINING iterations (see handleNewTask).
			this.currentIteration = iteration
			this.logger.info(`[loop] iteration ${iteration}/${maxIterations}`, { history: messages.length })
			// Live worker monitoring: emit the iteration_start event alongside
			// the human-readable log line above. Non-fatal.
			await this.emitEvent("iteration_start", () => this.eventFeed.iterationStart(iteration, messages.length))

			// Pause/resume (dashboard control): block between iterations (never
			// mid-tool-call — same safe boundary as the budget check below)
			// while a .harness.pause-requested marker is present.
			await this.checkPauseRequested(budgetTracker)

			// Mid-session message injection (live chat-UI control): AFTER the
			// pause check (so a message written during a pause is picked up the
			// moment the session resumes), before the LLM call. Every prior
			// assistant tool_calls message has all its tool results appended by
			// now, so a user-role message inserted here can never split an
			// assistant→tool adjacency (see checkInjectedMessage).
			await this.checkInjectedMessage()

			// Budget check BEFORE this LLM call: elapsed time, iteration count
			// and accumulated cost are all re-checked here so no further spend
			// happens once a limit has tripped. When no budget was configured
			// the tracker has no limits, so this never trips (pure accounting).
			try {
				budgetTracker.tick()
			} catch (err) {
				if (err instanceof BudgetExceededError) {
					return this.budgetFailure(err, iteration, toolCalls)
				}
				throw err
			}

			// 3. Phase 3 context condensation + sliding-window truncation.
			// Condensation runs FIRST: when the last request's real prompt
			// tokens crossed the token threshold, the oldest turns are
			// summarized into one synthetic message (non-fatal — on any
			// failure this just returns the messages unchanged, and
			// truncateHistory below still bounds the request). It runs
			// infrequently by design (batch-once-stable prefix — see
			// maybeCondenseHistory), so the sliding-window fallback remains
			// the cheap default for the vast majority of calls. The ONE
			// exception to non-fatal: a budget trip from the condensation
			// call's own usage accounting aborts the session like a main
			// call (constraint 2 — condensation spend is never invisible).
			let requestMessages: ChatMessage[]
			try {
				requestMessages = await this.maybeCondenseHistory(iteration, messages, budgetTracker)
			} catch (err) {
				if (err instanceof BudgetExceededError) {
					return this.budgetFailure(err, iteration, toolCalls)
				}
				throw err
			}
			requestMessages = truncateHistory(requestMessages, this.config.windowSize)
			// Streaming-and-reasoning (stop re-billing reasoning tokens): drop
			// the echoed `reasoning` from every assistant history message EXCEPT
			// the last one before the request goes out. DeepSeek's official
			// endpoint only needs prior reasoning echoed on the immediately-
			// preceding assistant message in the ACTIVE tool-call chain — the
			// completed chains' thinking text is re-sent purely at input-token
			// cost (measured 2-10x the visible output per turn, re-billed as
			// input on every later request). Probe-verified 2026-08-15 against
			// the pinned endpoint (2- and 3-turn tool-call conversations): 200
			// with only the active head's reasoning echoed, chain continues
			// normally; even a full strip is accepted, but the active head is
			// kept as the conservative default (see stripStaleReasoning). Non-
			// mutating — the long-term `messages` state keeps its fields.
			requestMessages = stripStaleReasoning(requestMessages)

			// 4. Call the LLM with an abort timeout. Retried ONCE on a classified
			// transient provider error (see isRetryableOpenRouterError) — this
			// is the main call, with no fallback provider to smooth over a
			// blip on the pinned deepseek/* endpoint (allow_fallbacks: false),
			// so without this a single hiccup used to kill the entire session
			// outright (observed live: an HTTP 520 "Provider returned error"
			// mid-session, iteration budget otherwise untouched). A second
			// failure — retryable or not — still falls through to the
			// catch block below exactly as before.
			let assistant: ChatMessage
			try {
				let response: LlmResponse
				try {
					response = await this.callMainLlm(requestMessages, iteration)
				} catch (firstAttemptError) {
					if (!isRetryableOpenRouterError(firstAttemptError)) {
						throw firstAttemptError
					}
					this.logger.warn("[loop] main LLM call failed with a retryable provider error, retrying once", {
						iteration,
						error: firstAttemptError instanceof Error ? firstAttemptError.message : String(firstAttemptError),
					})
					await sleep(500)
					response = await this.callMainLlm(requestMessages, iteration)
				}
				assistant = response.message
				// Cost/token accounting (workstream 3): feed the provider's usage
					// tokens into the budget tracker unconditionally now (it always
					// exists — see `run()` — with no limits when no budget was
					// configured, so this only ever accumulates, never trips).
					if (response.usage) {
						this.totalInputTokens += response.usage.promptTokens ?? 0
						this.totalOutputTokens += response.usage.completionTokens ?? 0
						this.totalCachedTokens += response.usage.cachedTokens ?? 0
						this.lastLlmUsage = {
							inputTokens: response.usage.promptTokens ?? 0,
							outputTokens: response.usage.completionTokens ?? 0,
							cachedTokens: response.usage.cachedTokens ?? 0,
						}
						try {
							budgetTracker.record({
								model: this.config.model,
								inputTokens: response.usage.promptTokens,
								outputTokens: response.usage.completionTokens,
								cachedTokens: response.usage.cachedTokens,
							})
						} catch (err) {
							if (err instanceof BudgetExceededError) {
								return this.budgetFailure(err, iteration, toolCalls)
							}
							throw err
						}
					}
					// The cumulative fields above are dominated by repeatedly-billed
					// cache reads of the same growing prefix, once per turn — they
					// do NOT represent the current conversation size (see
					// plans/smart-condensation-async.md part 1). The per-iteration
					// fields below are the REAL last single request's numbers, the
					// same values the condensation trigger uses: the right unit for
					// choosing condensation timing, and for correlating cache-hit
					// rate (lastCachedTokens / lastPromptTokens) with conversation
					// growth. Both are already in memory — logged, not computed.
					this.logger.info("[usage] running total", {
						iteration,
						costUsd: budgetTracker.totalCostUsd,
						iterations: budgetTracker.iterationCount,
						inputTokens: this.totalInputTokens,
						outputTokens: this.totalOutputTokens,
						cachedTokens: this.totalCachedTokens,
						lastPromptTokens: this.lastLlmUsage?.inputTokens,
						lastCachedTokens: this.lastLlmUsage?.cachedTokens,
					})
					// Live (in-progress) usage snapshot: overwritten in place each
					// iteration so the dashboard can show this still-running
					// session's accumulating cost/tokens/iterations. Non-fatal —
					// a write failure must never affect the session (same idiom
					// as the final usage record / checkpoints).
					await this.writeLiveSnapshot(startedAt, iteration, budgetTracker.totalCostUsd)
			} catch (error) {
				// Live worker monitoring: surface the LLM call failure on the
				// event feed too (the session is ending with an error). The
				// assistant variable is unset here, so emit via raw fields.
				await this.emitEvent(
					"llm_error",
					() =>
						this.eventFeed.emit("llm_error", {
							iteration,
							error: truncateField(error instanceof Error ? error.message : String(error)).text,
						}),
					{ iteration },
				)
				const message = error instanceof Error ? error.message : String(error)
				this.logger.error("[loop] LLM request failed", { iteration, error: message })
				return {
					status: "error",
					error: `LLM request failed on iteration ${iteration}: ${message}`,
					iterations: iteration,
					toolCalls,
				}
			}

			// Live worker monitoring: emit the llm_response event (a short
			// text preview, whether the response carried tool_calls, this
			// call's token usage incl. cachedTokens, and any reasoning
			// content — see src/engine/events.ts). Non-fatal.
			{
				const text = typeof assistant.content === "string" ? assistant.content.trim() : ""
				await this.emitEvent(
					"llm_response",
					() =>
						this.eventFeed.llmResponse({
							iteration,
							hadToolCalls: Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0,
							textPreview: text || undefined,
							// The full reasoning string: EventFeed.llmResponse
							// truncates it (EVENT_TRUNCATE_CHARS) and flags the cut,
							// exactly once — pre-truncating here would double-truncate
							// and lose the truncated flag for boundary-length content.
							reasoningPreview:
								typeof assistant.reasoning === "string" && assistant.reasoning.trim()
									? assistant.reasoning
									: undefined,
							inputTokens: this.lastLlmUsage?.inputTokens,
							outputTokens: this.lastLlmUsage?.outputTokens,
							cachedTokens: this.lastLlmUsage?.cachedTokens,
						}),
					{ iteration },
				)
			}

			// 5. Append the assistant message. Reasoning is echoed back onto the
			// long-term history message (OpenRouter accepts it and providers
			// like native DeepSeek drop prior reasoning if it is not echoed on
			// assistant messages within tool-call turns — see
			// api-docs.deepseek.com /guides/thinking_mode). The per-request
			// assembly then strips stale reasoning from completed chains before
			// re-sending (see stripStaleReasoning) — this field is what keeps
			// the ACTIVE chain head's reasoning available to the next turn.
			const assistantMessage: ChatMessage = {
				role: "assistant",
				content: assistant.content ?? null,
				tool_calls: assistant.tool_calls,
				reasoning: assistant.reasoning,
			}
			messages.push(assistantMessage)

			const calls = parseToolCalls(assistant)

			// 6a.5 Recursive task decomposition (`new_task`): the vendored tool
			// description mandates "This tool MUST be called alone. Do NOT call
			// this tool alongside other tools in the same message turn." The
			// tool handler only ever sees its own args (ToolExecutor.execute is
			// per-call), so only this loop — which sees the whole `calls`
			// batch — can enforce it. new_task calls are refused with a normal
			// tool error while every sibling call in the turn still executes
			// (the refusal counts toward consecutiveMistakes like any other).
			const refusedNewTaskIds = new Set<string>()
			if (calls.length > 1 && calls.some((call) => call.name === "new_task")) {
				for (const call of calls) {
					if (call.name === "new_task") {
						refusedNewTaskIds.add(call.id)
					}
				}
			}
			// switch_mode (plans/switch-mode-headless.md): the vendored schema
			// does NOT mandate "called alone", but the approval gate makes it
			// necessary anyway — its escalation shares the SINGLE
			// .harness.needs-decision / .harness.decision-answer marker pair
			// with ask_followup_question, so two escalated tools in one turn
			// would stomp each other's marker and both poll the same answer
			// file. Calls are executed sequentially (no true concurrency), but
			// the collision is still real: the second writer overwrites the
			// first's question and whichever reader sees an answer first
			// consumes it. Refusing switch_mode alongside siblings (which
			// still execute) keeps the marker protocol single-writer.
			const refusedSwitchModeIds = new Set<string>()
			if (calls.length > 1 && calls.some((call) => call.name === "switch_mode")) {
				for (const call of calls) {
					if (call.name === "switch_mode") {
						refusedSwitchModeIds.add(call.id)
					}
				}
			}

			// 6a. SUCCESS via attempt_completion.
			const completionCall = calls.find((call) => call.name === "attempt_completion")
			if (completionCall) {
				const result =
					typeof completionCall.args?.result === "string"
						? completionCall.args.result
						: JSON.stringify(completionCall.args)

				// Commit-before-finishing guardrail (structural backstop — see
				// plans/harness-tooling-efficiency.md item 4): in an EDIT-CAPABLE
				// mode, before accepting completion, check for uncommitted
				// TRACKED changes. When present (and the one-per-session nudge
				// hasn't been spent yet), DON'T accept — the nudge becomes this
				// call's tool result (keeping the assistant→tool adjacency
				// contract) and the loop continues so the model can commit and
				// retry. A retried completion is always accepted (the model may
				// legitimately finish uncommitted). Read-only modes never get the
				// check — there's nothing to commit.
				if (
					!completionNudged &&
					modeHasEditGroup(this.config.mode, this.customModes) &&
					(await hasUncommittedTrackedChanges(this.config.workspaceRoot))
				) {
					completionNudged = true
					// Siblings of a deferred attempt_completion never ran — push a
					// tool message for each so the assistant-with-tool_calls →
					// tool-result adjacency contract stays unbroken for strict
					// providers (the completion's own tool message is the nudge).
					for (const sibling of calls) {
						if (sibling.id === completionCall.id) {
							continue
						}
						messages.push({
							role: "tool",
							tool_call_id: sibling.id,
							name: sibling.name,
							content: "[System: not executed — attempt_completion was deferred because the workspace has uncommitted changes; re-issue this call if still needed.]",
						})
					}
					messages.push({
						role: "tool",
						tool_call_id: completionCall.id,
						name: "attempt_completion",
						content: COMMIT_NUDGE_CONTENT,
					})
					this.logger.warn("[loop] attempt_completion deferred — uncommitted tracked changes present", {
						iteration,
					})
					continue
				}

				this.logger.info("[loop] attempt_completion received — success", { iteration })
				const reportPath = await this.persistFinalReport(iteration, result)
				return { status: "success", result, iterations: iteration, toolCalls: toolCalls + 1, reportPath }
			}

			// 6b. Text-only reply (no tool_calls) → pragmatic success fallback.
			if (calls.length === 0) {
				const text = (assistant.content ?? "").trim()
				if (text) {
					this.logger.info("[loop] text-only reply (no tool calls) — success", { iteration })
					const reportPath = await this.persistFinalReport(iteration, text)
					return { status: "success", result: text, iterations: iteration, toolCalls, reportPath }
				}
				// Empty reply: nudge and count as a mistake.
				consecutiveMistakes++
				messages.push({
					role: "user",
					content:
						"[System: your last response contained no tool calls and no text. Continue working: call a tool or provide your final answer via attempt_completion.]",
				})
				this.logger.warn("[loop] empty reply counted as mistake", { consecutiveMistakes })
				if (consecutiveMistakes >= consecutiveErrorLimit) {
					return this.boundedFailure("consecutive empty replies", iteration, toolCalls, consecutiveMistakes)
				}
				continue
			}

			// 7. Execute each tool call, feeding results back as `tool` messages.
			// Same-file multi-edit diagnosis: paths already successfully
			// modified by an EARLIER call in THIS batch (scoped per assistant
			// turn — the executor re-reads the file per call, so the failure
			// mechanism is stale SEARCH text, not a stale executor).
			const batchEditedPaths = new Map<string, string>()
			for (const call of calls) {
				toolCalls++
				let resultContent: string
				let isError: boolean
				const targetPath = editToolTargetPath(this.config.workspaceRoot, call)
				const previouslyEditedBy = targetPath === undefined ? undefined : batchEditedPaths.get(targetPath)

				// Live worker monitoring: emit the tool_call event BEFORE
				// executing (a truncated argument summary — the path for file
				// tools, the command for execute_command — never full content).
				// Non-fatal.
				{
					const argSummary = summarizeToolArg(call.name, call.args) ?? ""
					const truncated = argSummary.length > EVENT_TRUNCATE_CHARS
					await this.emitEvent(
						"tool_call",
						() =>
							this.eventFeed.toolCall({
								iteration,
								tool: call.name,
								args: truncated ? argSummary.slice(0, EVENT_TRUNCATE_CHARS) : argSummary,
								argsTruncated: truncated,
							}),
						{ iteration },
					)
				}

				if (call.parseError) {
					resultContent = `[Error] Failed to parse arguments for tool '${call.name}': ${call.parseError}. Raw arguments: ${call.rawArguments}`
					isError = true
				} else if (refusedNewTaskIds.has(call.id)) {
					// new_task was called alongside other tools this turn — refuse
					// it (per the vendored tool description) WITHOUT executing it,
					// while siblings below execute normally.
					resultContent =
						"[Error] new_task MUST be called alone — do not call it alongside other tools in the same message turn. Re-issue new_task as the ONLY tool call in its own turn."
					isError = true
				} else if (refusedSwitchModeIds.has(call.id)) {
					// switch_mode was called alongside other tools this turn —
					// refuse it WITHOUT executing it (its approval waits on the
					// single .harness.decision-answer marker, which must not
					// collide with a sibling's escalation), while siblings below
					// execute normally. See the refusal-set construction above.
					resultContent =
						"[Error] switch_mode cannot run alongside other tools in the same message turn: its approval waits on a single .harness.decision-answer marker that must not collide with a sibling tool's escalation. Re-issue switch_mode as the ONLY tool call in its own turn."
					isError = true
				} else {
					const result = await this.executor.execute(call.name, call.args)
					resultContent = result.content
					isError = result.isError
				}

				// Same-file multi-edit diagnosis: a LATER edit call failing on a
				// path an EARLIER call in this batch already modified gets the
				// actionable note appended (the generic mismatch error alone
				// leaves the model to guess why its SEARCH text vanished).
				// Only fires on same-file collisions — two calls to DIFFERENT
				// files in one batch never trigger it.
				if (isError && previouslyEditedBy !== undefined) {
					resultContent = `${resultContent}${SAME_FILE_BATCH_DIAGNOSIS}`
				}

				messages.push({
					role: "tool",
					tool_call_id: call.id,
					name: call.name,
					content: resultContent,
				})

				// Record successful edits so a later sibling call on the same
				// path can be diagnosed (see above).
				if (!isError && targetPath !== undefined) {
					batchEditedPaths.set(targetPath, call.name)
				}
	
				// switch_mode (plans/switch-mode-headless.md): append the approved
				// switch's visible transcript marker AFTER the tool result — the
				// assistant-with-tool_calls → tool-result adjacency must stay
				// unbroken (strict providers 400 otherwise; see
				// pendingModeSwitchMarker). Only consumed on success.
				if (call.name === "switch_mode" && !isError && this.pendingModeSwitchMarker !== null) {
					messages.push({ role: "user", content: this.pendingModeSwitchMarker })
					this.pendingModeSwitchMarker = null
				}
	
				// Pause/resume (dashboard control): after each tool execution is
				// still a safe boundary (never mid-tool-call, never mid-LLM-call)
				// and makes a pause request responsive even when the LLM is fast
				// enough to run many iterations between the pre-iteration checks.
				// A request that lands during a tool call is honored as soon as
				// that call returns.
				await this.checkPauseRequested(budgetTracker)

				this.logger.info(`[loop] tool result: ${call.name}`, {
					isError,
					toolCalls,
					arg: summarizeToolArg(call.name, call.args),
				})
				// Live worker monitoring: emit the tool_result event (a
				// truncated preview — never the full result). Non-fatal.
				await this.emitEvent(
					"tool_result",
					() => {
						const preview = truncateField(resultContent)
						return this.eventFeed.toolResult({
							iteration,
							tool: call.name,
							isError,
							result: preview.text,
							resultTruncated: preview.truncated,
						})
					},
					{ iteration },
				)

				// Consecutive-mistake accounting: errors, parse failures, empty
				// results, and identical repeated calls all count.
				const signature = `${call.name}|${JSON.stringify(call.args)}`
				const isRepeat = signature === lastCallSignature
				lastCallSignature = signature

				const isMistake =
					isError || call.parseError !== undefined || resultContent.trim() === "" || isRepeat

				if (isMistake) {
					consecutiveMistakes++
					this.logger.warn("[loop] mistake counted", {
						consecutiveMistakes,
						reason: isError ? "tool error" : call.parseError ? "parse error" : isRepeat ? "identical repeat" : "empty result",
					})
					if (consecutiveMistakes >= consecutiveErrorLimit) {
						await this.saveIterationCheckpoint(iteration)
						return this.boundedFailure("consecutive mistakes", iteration, toolCalls, consecutiveMistakes)
					}
				} else {
					consecutiveMistakes = 0
					lastCallSignature = undefined
				}
			}

			// Blind tree-walking guardrail (P1.6): after N consecutive
			// iterations whose every tool call is a plain read/exploration
			// tool (list_files / read_file / search_files, OR an
			// execute_command whose shell command is read-only-equivalent —
			// see isReadOnlyEquivalentShellCommand's doc comment for why that
			// half matters: it's the dominant real-world exploration pattern)
			// with no codebase_search, code-intel, or edit, inject a soft
			// user-role nudge pointing at codebase_search. One nudge per
			// streak; any non-read-only tool resets the streak. Never fires
			// on an unindexed workspace (blind walking is then the only
			// option). Soft + reversible — a later productive call resets
			// everything.
			if (calls.length > 0) {
				const allReadOnly = calls.every(
					(call) =>
						READ_ONLY_TOOL_NAMES.has(call.name) ||
						(call.name === "execute_command" &&
							typeof call.args.command === "string" &&
							isReadOnlyEquivalentShellCommand(call.args.command)),
				)
				if (allReadOnly) {
					readOnlyStreak++
					if (readOnlyStreak >= readOnlyNudgeThreshold && !readOnlyNudgeInjected) {
						if (await hasCodebaseIndex(this.config.workspaceRoot)) {
							readOnlyNudgeInjected = true
							messages.push({ role: "user", content: READ_ONLY_NUDGE_MESSAGE })
							this.logger.warn("[loop] blind tree-walking nudge injected", { readOnlyStreak })
						} else {
							// Unindexed workspace: the nudge would be noise (the
							// model has no better option than walking the tree).
							// Reset so we stop re-checking every iteration.
							readOnlyStreak = 0
						}
					}
				} else {
					// Any non-read-only call (edit, codebase_search, code-intel,
					// execute_command, …) breaks the blind-walk pattern.
					readOnlyStreak = 0
					readOnlyNudgeInjected = false
				}
			}

			// Checkpoints: this iteration executed at least one tool call (we only
			// reach here when `calls.length > 0`), so snapshot the workspace.
			// Non-fatal — see saveIterationCheckpoint.
			await this.saveIterationCheckpoint(iteration)
		}

		// maxIterations exhausted without completion: this is specifically the
		// case where the orchestrator spawns a continuation worker as a
		// brand-new conversation on the same worktree (see
		// isIterationExhaustion in src/orchestrator/watch.ts, which matches
		// this exact error string) — write a handoff summary so that new
		// conversation doesn't start from a blank slate. Non-fatal; never
		// changes the result below.
		await this.writeIterationCapHandoff(messages, budgetTracker)
		return {
			status: "error",
			error: `Max iterations (${maxIterations}) reached without task completion`,
			iterations: maxIterations,
			toolCalls,
		}
	}

	/**
	 * Checkpoints: initialize the shadow git service and save the baseline
	 * checkpoint before iteration 1 (mirrors Zoo Code's `Task.ts:~1447`).
	 * A no-op when checkpoints are off (config or read-only executor). Never
	 * throws — any failure is logged as a warning and disables checkpoints
	 * for the rest of this session, exactly like the memory-recall pattern
	 * above.
	 */
	private async initCheckpoints(): Promise<void> {
		if (!this.checkpointsActive) {
			return
		}
		try {
			// Recursive task decomposition (`new_task`): a child session reuses
			// the PARENT's CheckpointService instance — checkpoints are keyed by
			// workspaceRoot, not by session, so both sessions' edits land in the
			// same shadow-git history. The lineage tag on each save
			// (`Task: <parentId>/<childId>, …`) keeps them distinguishable in
			// `headlesscode checkpoints list`. Root sessions (no service
			// passed) create their own as before.
			if (this.config.checkpointService) {
				this.checkpointService = this.config.checkpointService
				await this.checkpointService.save(`Task: ${this.checkpointLineage}, Time: ${Date.now()}`, {
					allowEmpty: true,
				})
				this.logger.info("[checkpoints] child baseline checkpoint saved", { lineage: this.checkpointLineage })
				await this.emitEvent("checkpoint_saved", () => this.eventFeed.checkpointSaved(0))
				return
			}
			const service = createCheckpointService({
				taskId: this.sessionId,
				workspaceRoot: this.config.workspaceRoot,
				checkpointDir: this.config.checkpointDir,
				log: (message) => this.logger.debug(`[checkpoints] ${message}`),
			})
			await service.init()
			await service.save(`Task: ${this.checkpointLineage}, Time: ${Date.now()}`, { allowEmpty: true })
			this.checkpointService = service
			this.logger.info("[checkpoints] baseline checkpoint saved", { taskId: this.sessionId })
			// Live worker monitoring: the baseline checkpoint is iteration 0.
			// Non-fatal.
			await this.emitEvent("checkpoint_saved", () => this.eventFeed.checkpointSaved(0))
		} catch (error) {
			this.checkpointService = null
			this.logger.warn("[checkpoints] init/baseline failed (non-fatal; checkpoints disabled for this session)", {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	/**
	 * Checkpoints: save a per-iteration snapshot after a turn that executed
	 * at least one tool call (mirrors Zoo Code's
	 * `presentAssistantMessage.ts:~988`, `task.checkpointSave(true)`). Non-fatal
	 * — a failure here is logged and silently drops checkpointing for the rest
	 * of the session (never fails the run).
	 */
	private async saveIterationCheckpoint(iteration: number): Promise<void> {
		if (!this.checkpointsActive || !this.checkpointService) {
			return
		}
		try {
			await this.checkpointService.save(`Task: ${this.checkpointLineage}, Time: ${Date.now()}`, { allowEmpty: true })
			this.logger.debug("[checkpoints] iteration checkpoint saved", { iteration })
			// Live worker monitoring: mirror the existing checkpoint hook point.
			// Non-fatal.
			await this.emitEvent("checkpoint_saved", () => this.eventFeed.checkpointSaved(iteration))
		} catch (error) {
			this.checkpointService = null
			this.logger.warn("[checkpoints] save failed (non-fatal; checkpoints disabled for the rest of this session)", {
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	/**
		* Recursive task decomposition (`new_task`) — the headless-native
		* equivalent of Zoo Code's GUI `NewTaskTool` /
		* `ClineProvider.delegateParentAndOpenChild` (see plans/recursive-orchestrator-mode.md).
		* This is a deliberate deviation from this project's usual verbatim-port
		* convention: the GUI version pauses and fully disposes the parent task,
		* persists an `awaitingChildId` marker to disk, makes the child the
		* webview's "sole active task", and resumes the parent later via a task
		* scheduler + rollback — a whole persisted-task-history subsystem this
		* single-process loop has no use for (the parent's call stack IS the
		* resume state). Instead the handler constructs a new HeadlessSession
		* SYNCHRONOUSLY and BLOCKS on it like a function call: no new process, no
		* worktree, no parallelism. The child's outcome comes back as this tool
		* call's result and the parent's loop simply continues on its next turn.
		*
		* Containment (the actual point of the feature, not hardening): the child
		* shares the parent's BudgetTracker (one cost cap across the whole tree —
		* see run()) and its maxIterations defaults to a fraction of the parent's
		* REMAINING iterations, so recursive delegation can never silently blow
		* past the parent's own budget/iteration caps.
		*/
	private async handleNewTask(args: Record<string, unknown>): Promise<ToolResult> {
		const mode = typeof args.mode === "string" ? args.mode.trim() : ""
		const message = typeof args.message === "string" ? args.message.trim() : ""
		if (!mode || !message) {
			return {
				content: `[Error] new_task requires both 'mode' and 'message' (mode=${JSON.stringify(args.mode)}, message=${JSON.stringify(args.message)}).`,
				isError: true,
			}
		}

		// Hard depth cap: refuse as a NORMAL tool error (counts toward
		// consecutiveMistakes like any other), never a crash. The refusal is
		// recoverable — the parent model just completes the step itself.
		if (this.recursionDepth >= this.maxRecursionDepth) {
			return {
				content: `[Error] new_task: max recursion depth reached (depth ${this.recursionDepth} >= max ${this.maxRecursionDepth}), cannot delegate further — complete this step yourself.`,
				isError: true,
			}
		}

		// Mode resolution mirrors top-level session mode resolution
		// (loadCustomModes/selectToolsForMode in prompt.ts): custom modes from
		// .roomodes first, then the vendored built-ins. An invalid slug is a
		// normal tool error, not a crash.
		const modeConfig = getModeBySlug(mode, this.customModes) ?? modes.find((m) => m.slug === mode)
		if (!modeConfig) {
			const known = [...modes.map((m) => m.slug), ...this.customModes.map((m) => m.slug)].join(", ")
			return {
				content: `[Error] new_task: unknown mode '${mode}'. Known modes: ${known}.`,
				isError: true,
			}
		}

		// Iteration containment: the child defaults to `childIterationFraction`
		// of the parent's REMAINING iterations (the parent still needs budget
		// after the child returns to consume the result and finish), floored
		// at minChildIterations and NEVER exceeding what the parent has left —
		// a recursive tree can't hand a child an iteration budget independent
		// of the parent's own cap. The strict vendored schema
		// (mode/message/todos only, additionalProperties: false) means the
		// model can't request more room through the tool itself.
		const remaining = Math.max(0, this.config.maxIterations - this.currentIteration)
		const fraction = Math.min(1, Math.max(0, this.config.childIterationFraction))
		const childMaxIterations = Math.max(
			1,
			Math.min(remaining, Math.max(this.config.minChildIterations, Math.floor(remaining * fraction))),
		)

		this.logger.info("[new_task] delegating to child session", {
			childMode: mode,
			parentSessionId: this.sessionId,
			depth: this.recursionDepth + 1,
			maxIterations: childMaxIterations,
			parentRemaining: remaining,
		})

		const child = new HeadlessSession({
			workspaceRoot: this.config.workspaceRoot,
			// Lineage: the child is one level deeper and knows its parent.
			parentSessionId: this.sessionId,
			recursionDepth: this.recursionDepth + 1,
			maxRecursionDepth: this.maxRecursionDepth,
			childIterationFraction: this.config.childIterationFraction,
			minChildIterations: this.config.minChildIterations,
			mode,
			model: this.config.model,
			taskText: message,
			maxIterations: childMaxIterations,
			consecutiveErrorLimit: this.config.consecutiveErrorLimit,
			windowSize: this.config.windowSize,
			contextWindowTokens: this.config.contextWindowTokens,
			condenseThresholdFraction: this.config.condenseThresholdFraction,
			condenseModel: this.config.condenseModel,
			condenseMaxTokens: this.config.condenseMaxTokens,
			temperature: this.config.temperature,
			maxTokens: this.config.maxTokens,
			globalCustomInstructions: this.config.globalCustomInstructions,
			llmTimeoutMs: this.config.llmTimeoutMs,
			stream: this.config.stream,
			reasoningEffort: this.config.reasoningEffort,
			llmClient: this.llmClient,
			logger: this.logger,
			memory: this.config.memory,
			project: this.config.project,
			// Checkpoints: reuse the PARENT's composite shadow-git service so
			// child edits land in the SAME restorable history (checkpoints are
			// keyed by workspaceRoot, not by a session "owning" them). null
			// (the parent's checkpoints failed to init) inherits "disabled" —
			// never start a disconnected history.
			checkpoints: this.config.checkpoints,
			checkpointDir: this.config.checkpointDir,
			checkpointService: this.checkpointService,
			checkpointLineagePrefix: this.checkpointLineage,
			decisionTimeoutMs: this.config.decisionTimeoutMs,
			decisionPollIntervalMs: this.config.decisionPollIntervalMs,
			// switch_mode: children inherit the parent's approval policy and
			// switch cap, so an auto-approving root's children don't silently
			// fall back to per-switch human approval (and vice versa).
			autoApproveModeSwitch: this.config.autoApproveModeSwitch,
			maxModeSwitches: this.config.maxModeSwitches,
			// The child gets the parent's RESOLVED permissions (not the
			// possibly-undefined input), so delegating can't silently bypass
			// a command/deny or protected-file policy by re-resolving from env.
			permissions: this.executor.permissions,
			maxPauseMs: this.config.maxPauseMs,
			pausePollIntervalMs: this.config.pausePollIntervalMs,
			eventHook: this.config.eventHook,
			customModes: this.customModes,
			localExplore: this.config.localExplore,
			// Internal plumbing: the shared budget tracker IS the containment
			// guarantee — the child's spend trips the same cost cap as the
			// parent's (see #2 in plans/recursive-orchestrator-mode.md).
			budgetTracker: this.budgetTracker ?? undefined,
		})

		const childResult = await child.run()

		if (childResult.status === "success") {
			const text = typeof childResult.result === "string" ? childResult.result : "(no result text)"
			this.logger.info("[new_task] child succeeded", {
				childMode: mode,
				iterations: childResult.iterations,
				toolCalls: childResult.toolCalls,
			})
			// Success: the child's final answer IS this tool call's result.
			return { content: text, isError: false }
		}

		// Failure: return an HONEST error — never fabricate a success. The
		// parent model needs the real outcome (why, how much it cost, what
		// the child did) to decide whether to retry differently or finish.
		const usage = childResult.budgetUsage
			? ` (total parent+child spend $${childResult.budgetUsage.costUsd.toFixed(6)})`
			: ""
		const reason = childResult.reason ? `, reason: ${childResult.reason}` : ""
		return {
			content:
				`[Error] new_task child session (mode '${mode}') failed: ${childResult.error ?? "unknown error"}${reason}${usage}. ` +
				`The child made ${childResult.toolCalls} tool call(s) over ${childResult.iterations} iteration(s). Do not blindly retry this exact delegation — reassess and complete the step yourself.`,
			isError: true,
		}
	}

	/**
		* switch_mode — the headless-native equivalent of Zoo Code's GUI mode
		* switch (see plans/switch-mode-headless.md). Deliberately NOT the same
		* thing as new_task: this does NOT spawn a child session — the CURRENT
		* session's own active mode changes IN PLACE (same message history, same
		* iteration count, same budget), just with a new system prompt / tool set
		* / role from this point forward.
		*
		* Approval gate: unless config.autoApproveModeSwitch is set, the switch is
		* escalated through the SAME .harness.needs-decision /
		* .harness.decision-answer marker pair as ask_followup_question and fails
		* CLOSED on denial/timeout (the session stays in its current mode) —
		* silently granting a never-approved switch would defeat the mode
		* restriction boundary entirely (a read-only mode like architect must not
		* be able to grant itself code mode's edit permissions unvetted).
		*/
	private async handleSwitchMode(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
		const modeSlug = typeof args.mode_slug === "string" ? args.mode_slug.trim() : ""
		const reason = typeof args.reason === "string" ? args.reason.trim() : ""
		if (!modeSlug || !reason) {
			return {
				content: `[Error] switch_mode requires both 'mode_slug' and 'reason' (mode_slug=${JSON.stringify(args.mode_slug)}, reason=${JSON.stringify(args.reason)}).`,
				isError: true,
			}
		}

		// Mode resolution mirrors new_task: custom modes from .roomodes first,
		// then the vendored built-ins. An invalid slug is a normal tool error
		// (no escalation, no state change).
		const modeConfig = getModeBySlug(modeSlug, this.customModes) ?? modes.find((m) => m.slug === modeSlug)
		if (!modeConfig) {
			const known = [...modes.map((m) => m.slug), ...this.customModes.map((m) => m.slug)].join(", ")
			return {
				content: `[Error] switch_mode: unknown mode '${modeSlug}'. Known modes: ${known}.`,
				isError: true,
			}
		}

		// Switching to the mode the session is ALREADY in: harmless no-op tool
		// error rather than a pointless approval round-trip.
		if (this.state.mode === modeSlug) {
			return {
				content: `[Error] switch_mode: already in mode '${modeSlug}' — no switch performed.`,
				isError: true,
			}
		}

		// Hard cap on total switches per session (mirrors new_task's recursion
		// depth cap — bound worst-case cost/thrash). A normal tool error, and
		// checked BEFORE the approval gate so a capped-out session never even
		// escalates.
		if (this.modeSwitchCount >= this.config.maxModeSwitches) {
			return {
				content: `[Error] switch_mode: max mode switches reached (${this.modeSwitchCount} >= max ${this.config.maxModeSwitches}), cannot switch to '${modeSlug}' — continue in mode '${this.state.mode}'.`,
				isError: true,
			}
		}

		// Approval gate — fail CLOSED. autoApproveModeSwitch skips escalation
		// entirely; otherwise a human/orchestrator must approve via
		// .harness.decision-answer ("approve"/"yes", case-insensitive), and any
		// other answer (or a timeout) DENIES the switch with no state change.
		const from = this.state.mode
		let autoApproved = false
		if (this.config.autoApproveModeSwitch) {
			autoApproved = true
			this.logger.info("[switch_mode] auto-approved (autoApproveModeSwitch)", { from, to: modeSlug })
		} else {
			const outcome = await escalateDecision(
				ctx,
				`Switch from mode '${from}' to mode '${modeSlug}'? Reason: ${reason}`,
				["approve", "deny"],
			)
			if (outcome.status === "writeFailed") {
				this.logger.warn("[switch_mode] could not write approval marker; denying switch (fail closed)", {
					from,
					to: modeSlug,
					error: outcome.error,
				})
				return {
					content: `[Error] switch_mode: mode switch to '${modeSlug}' could not be escalated for approval (failed to write ${NEEDS_DECISION_FILENAME}: ${outcome.error}). Continue in your current mode '${from}'.`,
					isError: true,
				}
			}
			if (outcome.status === "timedOut") {
				this.logger.warn("[switch_mode] approval timed out; denying switch (fail closed)", { from, to: modeSlug })
				return {
					content: `[Error] switch_mode: mode switch to '${modeSlug}' was not approved within the timeout; continue in your current mode '${from}', or ask a human directly via ask_followup_question if this is blocking your progress.`,
					isError: true,
				}
			}
			// The decision-proxy (src/decision-proxy/) writes its answers with a
			// distinguishing `[decision-proxy] ` prefix so the audit trail can tell
			// a human never looked at the answer — strip it before the exact-text
			// approve/deny match (otherwise a proxy "approve" is misread as a deny).
			let answer = outcome.answer.trim()
			if (answer.toLowerCase().startsWith(DECISION_PROXY_ANSWER_PREFIX.toLowerCase())) {
				answer = answer.slice(DECISION_PROXY_ANSWER_PREFIX.length).trimStart()
			}
			answer = answer.toLowerCase()
			if (!(answer.startsWith("approve") || answer.startsWith("yes"))) {
				this.logger.warn("[switch_mode] approval denied by human/orchestrator; no switch", {
					from,
					to: modeSlug,
					answer: outcome.answer,
				})
				return {
					content: `[Error] switch_mode: mode switch to '${modeSlug}' was denied (answer: ${outcome.answer}). Continue in your current mode '${from}'.`,
					isError: true,
				}
			}
			this.logger.info("[switch_mode] approved by human/orchestrator", { from, to: modeSlug })
		}

		// Perform the switch: recompute the system prompt + tool list the SAME
		// way run() does at session start (including the config.tools override
		// precedence), mutate session state in place (the iteration loop reads
		// this.state.tools fresh on every LLM call — see run()), and leave a
		// visible marker in the transcript so the model's own history honestly
		// shows when/why the switch happened rather than having it silently
		// rewritten underneath.
		const built = await buildSystemPrompt({
			workspaceRoot: this.config.workspaceRoot,
			mode: modeSlug,
			customModes: this.customModes,
			globalCustomInstructions: this.config.globalCustomInstructions,
		})
		let newTools = appendCodeIntelTools(
			appendDescribeImageTool(
				appendBrowserActionTool(this.config.tools ?? selectToolsForMode(modeSlug, this.customModes)),
			),
		)
		if (this.executor.has("rename_symbol")) {
			newTools = appendCodeIntelEditTools(newTools)
		}
		if (this.executor.has("run_tests")) {
			newTools = appendRunTestsTool(newTools)
		}
		this.state.mode = modeSlug
		this.state.tools = newTools
		this.state.systemPrompt = built.prompt
		// The "living" system prompt each LLM call reads (messages[0] is
		// otherwise just a regular history entry — update it in place). The
		// visible "[mode switched: …]" marker is NOT pushed here: the loop
		// appends it right after this call's tool result, so the strict
		// assistant-with-tool_calls → tool-result adjacency contract is kept
		// (see pendingModeSwitchMarker).
		if (this.state.messages[0]?.role === "system") {
			this.state.messages[0].content = built.prompt
		}
		this.pendingModeSwitchMarker = `[mode switched: ${from} -> ${modeSlug}. Reason: ${reason}]`
		this.modeSwitchCount++
		// Live worker monitoring: structured event for the dashboard (non-fatal
		// like every other event emission).
		await this.emitEvent("mode_switched", () =>
			this.eventFeed.modeSwitched({ from, to: modeSlug, reason, autoApproved }),
		)
		this.logger.info("[switch_mode] switched", { from, to: modeSlug, count: this.modeSwitchCount, autoApproved })
		return {
			content: `Switched to mode '${modeSlug}'. Reason acknowledged: ${reason}`,
			isError: false,
		}
	}

	/**
		* Phase 3: recall project memory for this task. Returns the delimited
		* "## PROJECT MEMORY" section (recalled facts + rolling recap) plus counts.
		* Non-fatal: any failure returns an empty section.
		*/
	/**
	 * OPT-IN local exploration phase (default OFF). Wraps runLocalExplorePhase
	 * in a try/catch so even a thrown error (a programming bug, not just a
	 * local-model failure) can never abort a real session — fail open to
	 * today's cloud-only behavior. Returns null when the phase is off or
	 * produced nothing usable.
	 */
	private async runLocalExplore(): Promise<LocalExploreResult | null> {
		const override = typeof this.config.localExplore === "object" ? this.config.localExplore : {}
		try {
			return await runLocalExplorePhase({
				workspaceRoot: this.config.workspaceRoot,
				taskText: this.config.taskText,
				logger: this.logger,
				...override,
			})
		} catch (error) {
			this.logger.warn("[local-explore] local exploration phase failed (non-fatal; proceeding cloud-only)", {
				error: error instanceof Error ? error.message : String(error),
			})
			return null
		}
	}

	private async recallMemory(): Promise<{ section: string; recalledFacts: number; recalledSessions: number }> {
		const memory = this.config.memory
		if (!memory) {
			return { section: "", recalledFacts: 0, recalledSessions: 0 }
		}
		try {
			const recall: RecallResult = await memory.queryRecall(this.config.project, this.config.taskText, 5)
			const rolling = buildRollingSummary(recall.summaries, 10)
			const lines = [
				"## PROJECT MEMORY",
				"",
				"Recalled knowledge about this codebase and its past sessions (scoped to this project only; harness data, never tenant data):",
			]
			if (recall.facts.length === 0) {
				lines.push("- (no relevant facts recalled)")
			} else {
				for (const fact of recall.facts) {
					const score = typeof fact.score === "number" ? ` (score ${fact.score.toFixed(3)})` : ""
					lines.push(`- [${fact.kind}]${score} ${fact.content}`)
				}
			}
			if (rolling) {
				lines.push("", rolling)
			}
			return {
				section: lines.join("\n"),
				recalledFacts: recall.facts.length,
				recalledSessions: recall.summaries.length,
			}
		} catch (error) {
			this.logger.warn("[memory] recall failed (non-fatal; continuing without memory)", {
				error: error instanceof Error ? error.message : String(error),
			})
			return { section: "", recalledFacts: 0, recalledSessions: 0 }
		}
	}

	/**
		* Phase 3: persist the completed session summary + extracted facts (each
		* deduped by content via addFact). Never throws — memory failures are
		* logged and ignored so they can never fail a session.
		*/
	private async recordMemory(result: SessionResult): Promise<void> {
		const memory = this.config.memory
		if (!memory) {
			this.memoryStats = null
			return
		}
		try {
			const summary = extractSessionSummary(result, {
				taskText: this.config.taskText,
				mode: this.config.mode,
				project: this.config.project,
				messages: this.state.messages,
			})
			await memory.recordSession(this.config.project, summary)
			let recordedFacts = 0
			for (const fact of summary.facts) {
				try {
					await memory.addFact(this.config.project, {
						kind: fact.kind,
						content: fact.content,
						tags: fact.tags,
						source: fact.source ?? `session:${summary.id}`,
					})
					recordedFacts++
				} catch (factError) {
					this.logger.warn("[memory] addFact failed (non-fatal)", {
						error: factError instanceof Error ? factError.message : String(factError),
					})
				}
			}
			this.memoryStats = {
				recalledFacts: this.recallInfo?.recalledFacts ?? 0,
				recalledSessions: this.recallInfo?.recalledSessions ?? 0,
				recordedFacts,
				recordedSessions: 1,
			}
			this.logger.info("[memory] session recorded", { ...this.memoryStats })
		} catch (error) {
			this.logger.warn("[memory] record failed (non-fatal; session result is unaffected)", {
				error: error instanceof Error ? error.message : String(error),
			})
			this.memoryStats = null
		}
	}

	private boundedFailure(
		reason: string,
		iterations: number,
		toolCalls: number,
		consecutiveMistakes: number,
	): SessionResult {
		this.logger.error("[loop] bounded failure", { reason, consecutiveMistakes })
		return {
			status: "error",
			error: `Bounded failure: ${consecutiveMistakes} ${reason} (limit ${this.config.consecutiveErrorLimit})`,
			iterations,
			toolCalls,
		}
	}

	/**
	 * Phase 6 — a budget limit tripped mid-run. Returns a SessionResult with
	 * status "error" + reason "budget"; the caller (run) adds `budgetUsage`.
	 */
	private budgetFailure(err: BudgetExceededError, iterations: number, toolCalls: number): SessionResult {
		this.logger.error("[loop] budget exceeded", {
			reason: err.reason,
			costUsd: err.costUsd,
			elapsedMs: err.elapsedMs,
			iterations: err.iterations,
		})
		return {
			status: "error",
			reason: "budget",
			error: `Budget exceeded: ${err.reason} (cost $${err.costUsd.toFixed(6)}, elapsed ${err.elapsedMs}ms, ${err.iterations} iteration(s))`,
			iterations,
			toolCalls,
		}
	}
}

/**
 * Best-effort one-line summary of a tool call's key argument, purely for
 * harness.log diagnostics (e.g. telling "read the same file 5 times in a
 * row" apart from "read 5 different files" without re-running a paid
 * session). Deliberately short and lossy — never logs full file/command
 * content, only the path/command/query a human would want to scan.
 *
 * read_file gets extra detail — the reading mode (default "slice") and the
 * effective range (offset/limit, or the indentation anchor_line) — so
 * harness.log/event feeds reveal whether real sessions actually use the
 * targeted indentation mode or default to broad slice reads. Exported only
 * for tests.
 */
export function summarizeToolArg(name: string, args: Record<string, unknown>): string | undefined {
	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
	switch (name) {
		case "read_file": {
			const filePath = str(args.path)
			if (filePath === undefined) return undefined
			const mode = str(args.mode) === "indentation" ? "indentation" : "slice"
			if (mode === "indentation") {
				const indentation = args.indentation as Record<string, unknown> | undefined
				const anchor = indentation?.["anchor_line"]
				return typeof anchor === "number"
					? `${filePath} [indentation anchor=${anchor}]`
					: `${filePath} [indentation]`
			}
			const offset = typeof args.offset === "number" ? args.offset : undefined
			const limit = typeof args.limit === "number" ? args.limit : undefined
			if (offset !== undefined || limit !== undefined) {
				return `${filePath} [slice${offset !== undefined ? ` offset=${offset}` : ""}${limit !== undefined ? ` limit=${limit}` : ""}]`
			}
			// No slice args: show the tool's real defaults (mirrors the
			// executor's toNonNegativeInt fallbacks) so a default broad read is
			// distinguishable from a targeted one at a glance.
			return `${filePath} [slice offset=1 limit=${DEFAULT_LINE_LIMIT}]`
		}
		case "list_files":
		case "write_to_file":
		case "apply_diff":
		case "search_replace":
		case "edit_file":
			return str(args.path)
		case "execute_command":
			return str(args.command)?.slice(0, 200)
		case "update_todo_list":
			// The checklist body, clipped so a long planning list doesn't spam
			// the event/feed view (the todo_updated event carries full counts).
			return str(args.todos)?.slice(0, 200)
		default:
			return undefined
	}
}

/**
 * Streaming-and-reasoning (stop re-billing reasoning tokens): strip the
 * `reasoning` field from every assistant history message EXCEPT the last one
 * before a request is sent. DeepSeek's official endpoint only needs prior
 * reasoning echoed on the immediately-preceding assistant message in the
 * ACTIVE tool-call chain — the assistant message whose tool results form the
 * conversation tail (probe-verified 2026-08-15 against the pinned endpoint:
 * a 3-turn tool-call conversation re-sent with ONLY the active head's
 * reasoning kept returns 200 and continues the chain; the completed chains'
 * thinking is not load-bearing). The active head is deliberately kept (not
 * stripped) even though a full strip is also accepted: DeepSeek's thinking-
 * mode docs say prior reasoning within an active tool-call turn is dropped
 * if not echoed, so the head's reasoning may carry mid-chain state the next
 * turn relies on — older turns' reasoning carries none.
 *
 * Non-mutating: returns the same array when nothing changes, otherwise a new
 * array with fresh message objects for the stripped entries. The long-term
 * message state must stay byte-identical across calls for prompt-cache /
 * condensation-prefix stability (see messagesPrefixEquals), so request
 * assembly copies rather than edits in place.
 */
export function stripStaleReasoning(messages: ChatMessage[]): ChatMessage[] {
	let lastAssistantIndex = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "assistant") {
			lastAssistantIndex = i
			break
		}
	}
	if (lastAssistantIndex < 0) {
		return messages
	}
	let changed = false
	const out = messages.map((msg, i) => {
		if (i !== lastAssistantIndex && msg.role === "assistant" && msg.reasoning !== undefined) {
			changed = true
			const { reasoning: _drop, ...rest } = msg
			return rest
		}
		return msg
	})
	return changed ? out : messages
}

/** Batch size for truncateHistory's eviction — see its own doc comment for why. */
export const TRUNCATION_BATCH_SIZE = 10

/**
 * Verify the stable-prefix assumption for a background condensation
 * (applyBackgroundCondense): the live history must still hold the SAME
 * message objects at [0, snapshot.length) as the snapshot the background call
 * summarized. Messages are never mutated in place once pushed (the loop only
 * appends; the one in-place mutation is the condensation splice, which
 * REPLACES whole prefix entries), so reference equality per index is
 * authoritative and cheap — no deep compare needed.
 */
function messagesPrefixEquals(live: ChatMessage[], snapshot: ChatMessage[]): boolean {
	if (live.length < snapshot.length) {
		return false
	}
	for (let i = 0; i < snapshot.length; i++) {
		if (live[i] !== snapshot[i]) {
			return false
		}
	}
	return true
}

/**
 * Phase 1 sliding-window truncation: keep the system message and the first
 * user message always; drop the oldest non-system, non-first-user messages
 * once the total exceeds `windowSize`.
 *
 * Evicts in fixed BATCHES rather than sliding by exactly one message per
 * call. A naive "always keep exactly the last (windowSize-2) messages"
 * implementation re-slices a DIFFERENT window on every single call once the
 * threshold is crossed — the "recent conversation" prefix sent to the model
 * never repeats byte-for-byte between consecutive requests, which defeats
 * provider-side prompt caching for the entire remainder of any session that
 * runs long enough to start truncating (confirmed against real usage data:
 * a 147-iteration session's cache-hit-rate stayed pinned in the high-20s%
 * for its whole run instead of climbing toward the 90s%+ a stable, merely-
 * growing conversation should reach). Evicting `TRUNCATION_BATCH_SIZE`
 * messages at once instead keeps the sent prefix IDENTICAL across every
 * call between eviction points, so caching actually accrues for a stretch
 * of calls, at the cost of the window occasionally holding up to
 * `TRUNCATION_BATCH_SIZE - 1` more messages than the strict minimum.
 *
 * Documented placeholder: Phase 3 replaces this with token-count-based
 * condensation (summarize + merge) using the model's real token counts —
 * this batching is a small, targeted fix for the caching regression above,
 * not a substitute for that. Phase 3 is now implemented (see
 * src/engine/condense.ts + `maybeCondenseHistory`): when the last request's
 * real prompt tokens cross the condensation threshold, the oldest turns are
 * summarized into one synthetic message BEFORE this drop-oldest fallback
 * runs. This function remains the cheap default for sessions that never
 * cross the token threshold (constraint 4 of plans/context-condensation.md).
 *
 * 2026-08-01 fix: the batch boundary above is purely positional and doesn't
 * know about the OpenAI tool-call protocol, where an assistant message with
 * `tool_calls` must be immediately followed by one `role: "tool"` message per
 * call. With irregular per-turn tool-call counts (1-3 per iteration in real
 * sessions), a raw batch slice can land mid-group: it evicts the assistant's
 * `tool_calls` message but keeps the `tool` result message(s) that respond to
 * it, producing a kept tail that starts with an orphaned `tool` message.
 * Lenient hosts tolerated this; DeepSeek's official endpoint rejects it with
 * HTTP 400 ("Messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'") — confirmed live against a real session at
 * iteration 17. Fix: after the batch cut, skip forward over any leading
 * orphaned `tool` messages so the kept tail never starts mid-group. The
 * count computation + orphaned-tool skip now live in the SHARED helpers
 * `computeEvictCount` / `skipOrphanedToolMessages` (src/engine/condense.ts),
 * so the token-aware condensation path (`computeCondenseCount`) enforces the
 * same group-boundary invariant from one implementation.
 */
export function truncateHistory(messages: ChatMessage[], windowSize: number): ChatMessage[] {
	if (messages.length <= windowSize) {
		return messages
	}
	const system = messages[0]
	const firstUser = messages[1]
	const rest = messages.slice(2)
	const evictCount = computeEvictCount(rest.length, windowSize, TRUNCATION_BATCH_SIZE)
	const keptTailStart = skipOrphanedToolMessages(rest, evictCount)
	const keptTail = rest.slice(keptTailStart)
	return [system, firstUser, ...keptTail]
}

/**
	* Pause/resume (dashboard control): resolve the max-pause override from
	* `$HEADLESSCODE_MAX_PAUSE_MS` when set and valid (undefined otherwise, so
	* the caller's flag/default wins). Mirrors the other env fallbacks in
	* src/cli.ts (envNumber) — invalid values are ignored, not fatal.
	*/
function envMaxPauseMs(): number | undefined {
	const raw = process.env.HEADLESSCODE_MAX_PAUSE_MS
	if (raw === undefined || raw === "") {
		return undefined
	}
	const n = Number(raw)
	return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Blind tree-walking guardrail (P1.6): the streak threshold at which a
 * read-only nudge is injected, from $HEADLESSCODE_READ_ONLY_NUDGE_THRESHOLD
 * (default DEFAULT_READ_ONLY_NUDGE_THRESHOLD = 8). Non-positive/invalid
 * values fall back to the default — a 0 or negative threshold would inject
 * the nudge on the very first read, which is noise, not guidance.
 */
function envReadOnlyNudgeThreshold(): number {
	const raw = process.env.HEADLESSCODE_READ_ONLY_NUDGE_THRESHOLD
	if (raw === undefined || raw === "") {
		return DEFAULT_READ_ONLY_NUDGE_THRESHOLD
	}
	const n = Number(raw)
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_READ_ONLY_NUDGE_THRESHOLD
}

/**
 * Streaming-and-reasoning: resolve the SSE-streaming opt-in from
 * `$HEADLESSCODE_STREAM` (accepted: "1", "true", "yes", "on"; anything else
 * — including unset — means OFF). Default OFF deliberately: the blocking
 * request path (which the e2e fixtures and most tests assume) is unchanged.
 */
function envStreaming(): boolean {
	const raw = process.env.HEADLESSCODE_STREAM
	if (raw === undefined || raw === "") {
		return false
	}
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}
