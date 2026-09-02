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
	readLimitFromEnv,
	ToolExecutor,
} from "../tools/executor.js"
import type { PermissionsConfig } from "../permissions/config.js"
import { buildRollingSummary, extractSessionSummary } from "../memory/summarizer.js"
import type { MemoryStore, RecallResult } from "../memory/types.js"
import { createCheckpointService, type CheckpointService } from "../checkpoints/service.js"
import { recordSessionUsage, removeLiveUsage, writeLiveUsage } from "./usage.js"
import { EventFeed, EVENT_TRUNCATE_CHARS, truncateField } from "./events.js"
import {
	allClaimsVerified,
	claimLabel,
	extractClaims,
	firstUnverifiedDetail,
	verifyClaims,
	type ClaimVerification,
} from "./claims.js"
import { writeSessionReport } from "./reports.js"
import { Logger } from "./logger.js"
import { extractEmbeddedToolCall, parseToolCalls } from "./parser.js"
import {
	appendBrowserActionTool,
	appendCodeIntelEditTools,
	appendCodeIntelTools,
	appendDescribeImageTool,
	appendRunTestsTool,
	appendSetIndentationTool,
	buildLeanSystemPrompt,
	buildSystemPrompt,
	isLeanSystemPromptEnabled,
	loadCustomModes,
	modeHasEditGroup,
	patchEditFileToolForLocalModels,
	selectToolsForMode,
} from "./prompt.js"
import type {
	AuxLlmUsage,
	ChatMessage,
	ChatTool,
	LlmClient,
	LlmResponse,
	ParsedToolCall,
	SessionResult,
	SessionBudgetUsage,
	SessionCompletionVerification,
	ToolContext,
	ToolResult,
} from "./types.js"
import type { ModeConfig } from "../vendor/zoo-code/types/index.js"
import {
	buildCondensedMessage,
	computeCondensePlan,
	computeEvictCount,
	condenseOldestTurns,
	DEFAULT_CONDENSE_EARLY_FIRE_FRACTION,
	DEFAULT_CONDENSE_MAX_TOKENS,
	DEFAULT_CONDENSE_THRESHOLD_FRACTION,
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	estimateMessageChars,
	MAX_CONDENSE_INPUT_CHARS,
	maybeCondense,
	MIN_CONDENSE_TAIL_GROWTH,
	skipOrphanedToolMessages,
} from "./condense.js"
import { writeHandoffSummary } from "./handoff.js"
import {
	isLazyToolCatalogEnabled,
	LIST_TOOLS_NAME,
	REQUEST_TOOL_NAME,
	renderToolIndex,
	splitCoreAndLazyTools,
} from "./lazy-tools.js"
import { runLocalExplorePhase, type LocalExploreOptions, type LocalExploreResult } from "./local-explore.js"
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
 * Default cap on the main per-iteration call's OUTPUT tokens, applied when
 * the caller doesn't set `maxTokens` explicitly (there is no CLI flag/env
 * for it today — the config object is the plumbing). Chosen at 32k: 4x the
 * heaviest generation observed in a real session (8,000+ tokens on one
 * iteration — see the DEFAULT_LLM_TIMEOUT_MS comment above; reasoning models
 * emit long tool-call turns by design), so a legitimate multi-file write
 * turn never truncates mid-tool-call, while still bounding the worst-case
 * cost of a runaway generation. Overridable by passing `maxTokens` in the
 * session config.
 */
export const DEFAULT_MAX_TOKENS = 32_768
/**
 * Blind tree-walking guardrail (speed workstream, P1.6): after this many
 * CONSECUTIVE iterations whose every tool call is a plain read/exploration
 * tool (list_files / read_file / search_files) with no codebase_search,
 * code-intel, or edit mixed in, the loop injects a one-line user-role nudge
 * pointing at codebase_search. Chosen at 8: the whole point is to catch a
 * model settling into a blind tree-walk BEFORE it has burned a dozen+ calls
 * (which is where the real sessions' exploration ballooning started),
 * while staying comfortably above a legitimate 2-5 call local recon burst —
 * the nudge must never fire for normal short reads. It is a SOFT nudge
 * (reversible, matches the empty-reply pattern): a single productive call
 * resets the streak, and it never fires when the workspace has no
 * codebase-search index (blind walking is then the only option). Overridable
 * via $HEADLESSCODE_READ_ONLY_NUDGE_THRESHOLD.
 */
export const DEFAULT_READ_ONLY_NUDGE_THRESHOLD = 8
/**
 * Hard cap on consecutive all-read-only iterations (env
 * $HEADLESSCODE_READ_ONLY_STALL_LIMIT). A session doing this many pure
 * read/exploration iterations with NO edit, test run, or completion is stuck —
 * live round w3 (issue #103, 2026-08-16) burned ~200 grep iterations this way,
 * substituting manual verification for the one run_tests call it had planned.
 * Terminate it like a consecutive-mistakes bounded failure instead of letting
 * it eat the whole iteration budget. Any non-read-only call resets the streak,
 * so a legitimately read-heavy task only trips this if it never produces
 * anything for a very long time.
 */
export const DEFAULT_READ_ONLY_STALL_LIMIT = 75
/** Tool names that count as "blind tree-walking" for the guardrail above. */
const READ_ONLY_TOOL_NAMES = new Set(["list_files", "read_file", "search_files"])

/**
 * Identical-consecutive-call guardrail: a local model was repeatedly
 * observed (across several separate sessions/nights — apply_diff repeating
 * the exact same failing diff 4x despite a corrective error message,
 * ask_followup_question asking the identical generic question 4x in a row,
 * list_files calling the exact same path back-to-back tens of times) making
 * the SAME tool call with the SAME arguments turn after turn, with no
 * different action in between. This is distinct from the read-only-stall
 * guardrail above: it fires for ANY tool (not just reads), fires on a
 * SUCCESS streak just as readily as an error streak (list_files kept
 * succeeding every time in the reproduction that motivated this), and its
 * threshold is deliberately tight — a genuine workflow (edit, verify,
 * edit again, verify again) always has a DIFFERENT call between two
 * verification calls, so this only trips on true immediate repetition, not
 * legitimate re-checking. One soft nudge, then a hard stop shortly after —
 * unlike the read-only stall limit's 75, there is no legitimate reason for
 * this specific pattern to run long before intervening.
 */
export const DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD = 2
export const DEFAULT_IDENTICAL_CALL_STALL_LIMIT = 4
/**
 * Sampling-level companion to the text nudge above (see
 * LlmRequest.repeatPenalty's doc comment): once the streak reaches the
 * nudge threshold, the RETRY request itself carries this repeat_penalty
 * instead of whatever the backend's own default/persisted value is. Chosen
 * as a clear step up from this harness's raw-mode default of 1.15
 * (the local daemon's generation-execution support) without being so high
 * it degrades otherwise-fluent output — not yet tuned against a live trial,
 * treat as a starting point. Ignored entirely by non-Ollama clients
 * (OpenRouter has no equivalent per-request knob).
 */
export const DEFAULT_IDENTICAL_CALL_REPEAT_PENALTY_BOOST = 1.3
/**
 * How many iterations a tool stays excluded PAST the streak that
 * triggered it (see excludedToolCooldowns' doc comment in runIterations).
 * Verified live 2026-08-20: without a cooldown, exclusion is a one-shot
 * deterrent — the model returns to the same denied tool on its very next
 * real action and re-triggers exclusion 2 turns later, an indefinite
 * oscillation (48+ cycles observed with no cooldown). Not yet tuned
 * against a live trial with the cooldown active — treat as a starting
 * point, same as the repeat_penalty boost value above.
 */
export const DEFAULT_IDENTICAL_CALL_TOOL_COOLDOWN_TURNS = 4
/**
 * Repeated-tool-failure guardrail (issue #146): the varied-args sibling of
 * the identical-call guardrail above. identicalCallStreak only fires when
 * retries repeat byte-identical arguments — it does nothing when a model
 * keeps retrying the SAME tool with DIFFERENT arguments every time, never
 * pausing to re-diagnose why each attempt failed the same way. Live
 * round 7 of the 2026-08-21 full-cycle demo: `edit_file` failed 17 times in
 * a row against `src/orchestrator/state.ts`, each attempt with a different
 * old_string/new_string, before the session ran out of budget —
 * identicalCallStreak never trips in that shape. MUST stay strictly below
 * DEFAULT_CONSECUTIVE_ERROR_LIMIT (3): the generic consecutive-mistake
 * check runs INSIDE the same per-call loop this guardrail's own tracking
 * runs after, and returns immediately once it trips — live-verified
 * 2026-08-21 (scripts/eval-suite/scenario-146-repeated-tool-failure.sh
 * against the real code-daemon): with this threshold also at 3, the
 * generic check fired first on the 3rd failure and ended the session
 * before this guardrail's post-turn block ever ran, so the specific nudge
 * never had a chance to redirect the model. At 2, the nudge is injected
 * after the 2nd failure — visible in the request that produces the 3rd
 * attempt — giving the model one genuinely-informed try before the
 * generic hard stop would otherwise end the session on an uninformed one.
 */
export const DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD = 2
/**
 * Artifact-gate rejection guardrail (issue #152): requireArtifactMinCitations
 * and requireArtifactSections check PRESENCE (a citation-shaped regex match
 * count, a required substring) — they cannot and do not check that a
 * citation actually backs the specific claim it was required to back, or
 * that a required section actually contains what was asked for. Live
 * evidence 2026-08-21 (issue #152's own transcript): a session rejected 3
 * times in a row for missing citations/sections patched in EXACTLY the
 * missing surface feature each time (a citation-shaped string, a required
 * heading) with ZERO read_file calls between rejections — the retry
 * nudge's own "you already have enough, don't read more" guidance
 * (deliberately anti-context-bloat, see the requireArtifactMinCitations
 * rejection message below) is exactly what let this slide: the model
 * never went back to verify the patch was actually true. This guardrail
 * detects that specific shape — N consecutive artifact-gate rejections
 * with no real read_file call in between — and escalates to an explicit
 * warning naming the pattern, rather than repeating the same
 * easily-satisfied-by-patching instruction. Same threshold as
 * DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD for consistency; no evidence yet
 * that a different value is warranted.
 */
export const DEFAULT_ARTIFACT_REJECTION_NUDGE_THRESHOLD = 2
/** The injected nudge (user-role, seen by the model on its next turn), indexed workspaces. */
const READ_ONLY_NUDGE_MESSAGE =
	"You've made several read/exploration calls without using `codebase_search`. If the workspace has an index (it lives in the central project store — see `~/.local/share/headlesscode/projects/`), try `codebase_search` for targeted semantic search instead of blind tree-walking."
/** The injected nudge for unindexed workspaces — no index to point at, so lead with progress. */
const READ_ONLY_PROGRESS_NUDGE_MESSAGE =
	"You've made several read/exploration calls without progress. If the next step in your todo list is verification, `run_tests` answers it in one shot — prefer running the project's test suite over more manual greps/reads. Take a progress action now (edit, test run, or completion) instead of further read-only exploration."

/**
 * The local daemon's own synthetic fallback text (its
 * `fallback_response_for_empty_result`) when the underlying generation
 * produced no real content — a diagnostic string for the wire response, NOT
 * model-authored text. Same failure family as the narrated-tool-call fix
 * (see extractEmbeddedToolCall's doc comment and the c274ddc commit it
 * references): if persisted into history verbatim, the model is fed its
 * own (fake) prior "reply" on the next turn, and if that turn ALSO
 * produces nothing, the two-message pair (this + the standard nudge) gets
 * evicted and re-added by truncateHistory in exactly matching batches
 * every cycle — the rendered prompt becomes byte-for-byte IDENTICAL
 * turn after turn, a stable, self-reinforcing trap. Verified live
 * 2026-08-20: diffed the daemon's own rendered prompt across three
 * consecutive requests during exactly this pattern — byte-identical.
 * Matched by exact string rather than any heuristic since it's a fixed,
 * known constant on the daemon side, not model-generated text that could
 * coincidentally resemble it.
 */
const DAEMON_EMPTY_REPLY_FALLBACK_TEXTS = [
	"The model produced an empty reply for this request. No changes were applied.",
	"The model attempted a tool-based response but did not produce a final reply. No changes were applied.",
]

/**
 * Extract the first not-done line from a todo checklist (`[ ]` pending or
 * `[-]` in-progress — never `[x]` done), for identicalCallNudgeMessage.
 * Best-effort: any list shape it doesn't recognize just yields undefined,
 * which the nudge message handles by omitting the concrete suggestion
 * rather than guessing.
 */
function firstPendingTodoLine(todos: string | undefined): string | undefined {
	if (!todos) {
		return undefined
	}
	for (const line of todos.split("\n")) {
		const trimmed = line.trim()
		if (trimmed.startsWith("[ ]") || trimmed.startsWith("[-]")) {
			return trimmed
		}
	}
	return undefined
}

/**
 * The injected nudge when the SAME call repeats back-to-back — see
 * DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD. Verified live 2026-08-21: a
 * generic version of this message ("try something different") did not
 * change the model's next action across several trials — it called
 * list_files a 3rd and 4th time anyway, right past the nudge. When a todo
 * list exists, naming the concrete next pending step explicitly is a much
 * more specific, harder-to-ignore instruction than "do something else."
 */
function identicalCallNudgeMessage(signature: string, streak: number, nextTodo: string | undefined): string {
	const concreteNextStep = nextTodo
		? ` Your own todo list's next unfinished step is: ${nextTodo} — do THAT now, not another ${signature} call.`
		: ""
	return (
		`You have called ${signature} ${streak} times in a row with IDENTICAL arguments. Repeating the exact same call ` +
		`will not produce a different result. The information from your earlier call is still visible above in this ` +
		`conversation — re-read it there instead of calling again.${concreteNextStep} If you are stuck on a ` +
		`persistent error, address that error specifically instead of resubmitting the same call or looking around ` +
		`the workspace again.`
	)
}

/**
 * The injected nudge when the SAME TOOL NAME fails repeatedly with VARIED
 * arguments (issue #146) — see DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD's doc
 * comment for why this is distinct from identicalCallNudgeMessage above.
 * Directive, not generic: names the exact re-diagnosis step (re-read the
 * CURRENT real content, quote the exact text to match) rather than a vague
 * "try something different" — the same lesson identicalCallNudgeMessage's
 * own doc comment already draws from a prior failed generic-nudge attempt.
 *
 * `readFileAvailable`/`retryToolAvailable` (issue #153): live-verified
 * 2026-08-21 (scripts/eval-suite/scenario-146-repeated-tool-failure.sh,
 * two separate live runs) that this nudge's own advice — "use read_file"
 * and "retry `toolName`" — can each independently collide with the
 * SEPARATE identical-call guardrail's tool-exclusion cooldown
 * (excludedToolCooldowns in runIterations): first observed with
 * `read_file` on cooldown (fixed below), then on a second live run with
 * `toolName` itself (e.g. `edit_file`) on cooldown from its own identical
 * repeat. A model told to do something it cannot currently do has no good
 * move — in both observed trials it fabricated a fake `<tool_call>` text
 * block for the unavailable tool rather than a real one, which the harness
 * correctly refuses to execute (see the excludedThisTurn check around
 * `extractEmbeddedToolCall`'s call site) but still counts as a mistake.
 * This message checks BOTH tools independently and adapts to whichever
 * combination is actually true, rather than assuming either is available.
 *
 * Known remaining gap, not fixed here: `excludedToolCooldowns` is only
 * populated at the START of the NEXT iteration's request prep (reading
 * identicalCallStreak's value as of the end of THIS one) — so if
 * identicalCallStreak and this guardrail's own streak both cross their
 * threshold on the exact same call, this nudge (fired in that same turn)
 * still sees the about-to-be-excluded tool as available one turn early.
 * Narrow (requires both guardrails tripping simultaneously) and not
 * reproduced in the 2026-08-21 live re-verification after this fix — left
 * as a documented limitation rather than adding cross-guardrail lookahead.
 */
function toolFailureNudgeMessage(
	toolName: string,
	streak: number,
	targetLabel: string | undefined,
	readFileAvailable: boolean,
	retryToolAvailable: boolean,
): string {
	const targetHint = targetLabel ? ` on '${targetLabel}'` : ""
	const base =
		`Your last ${streak} attempts to use ${toolName}${targetHint} all failed, even though the arguments were ` +
		`different each time. Varying the arguments and hoping is not working. `
	if (readFileAvailable && retryToolAvailable) {
		return (
			base +
			`Before trying again: use read_file to see the file's CURRENT exact content around your target, quote the ` +
			`exact text you intend to match, and only THEN retry ${toolName} — do not just adjust the arguments again ` +
			`without first confirming what the file actually contains right now.`
		)
	}
	if (!readFileAvailable && retryToolAvailable) {
		return (
			base +
			`read_file is temporarily unavailable right now (cooldown from a recent repeat) — instead, carefully ` +
			`re-derive the exact current content from what you already read earlier in this conversation, quote the ` +
			`exact text you intend to match, and only THEN retry ${toolName} — do not just adjust the arguments ` +
			`again without first confirming what the file actually contains right now.`
		)
	}
	if (readFileAvailable && !retryToolAvailable) {
		return (
			base +
			`${toolName} is temporarily unavailable right now (cooldown from a recent repeat), so retrying it this ` +
			`turn will not work no matter what arguments you use. Use read_file now to see the file's CURRENT exact ` +
			`content and carefully work out the exact text you'll need to match — you'll be able to retry ${toolName} ` +
			`again in a few turns, and having the exact match ready will make that attempt count.`
		)
	}
	return (
		base +
		`Both read_file and ${toolName} are temporarily unavailable right now (cooldown from recent repeats). Do not ` +
		`fabricate a call to either — call a genuinely different tool, or give a plain text status update, and wait ` +
		`for them to become available again before retrying.`
	)
}

/**
 * Artifact-gate rejection guardrail (issue #152) — see
 * DEFAULT_ARTIFACT_REJECTION_NUDGE_THRESHOLD's doc comment for the real
 * failure shape this addresses.
 */
function artifactRejectionNudgeMessage(streak: number, relativePath: string): string {
	return (
		`Your last ${streak} attempts to complete this task were rejected for the same reason, and each time you ` +
		`edited '${relativePath}' without making any read_file call in between. Adding a citation-shaped string or a ` +
		`section heading does NOT satisfy this requirement unless it reflects something real you actually verified — ` +
		`a citation with a real line number but a wrong description of what's there, or a section heading with ` +
		`placeholder content, is worse than not having it at all. Before your next edit: use read_file on the real ` +
		`source file(s) you intend to cite, confirm exactly what's at that line, and only then write content that ` +
		`genuinely reflects it. Do not just patch in the missing surface feature again.`
	)
}

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
	* (S3) Tool names that are safe to run CONCURRENTLY with their siblings in a
	* single turn: plain read/exploration tools with no shared mutable state.
	* `execute_command` is additionally gated per-call by
	* isReadOnlyEquivalentShellCommand (see isParallelReadOnlyCall).
	*/
const PARALLEL_READ_ONLY_TOOL_NAMES = new Set([
	"read_file",
	"list_files",
	"search_files",
	// TS code-intelligence reads (src/codeintel/) — read-only, executor-side.
	"outline",
	"go_to_definition",
	"find_references",
	"import_graph",
])

/**
	* (S3) Whether a call may run concurrently with the turn's other read-only
	* calls. Only pure reads qualify: the tools above, plus an execute_command
	* whose shell command is read-only-equivalent. Everything else — any
	* edit-capable call, switch_mode / ask_followup_question / new_task (the
	* single decision-marker protocol), or anything ambiguous — is serial.
	* A read_file whose path collides with a file an edit call in this turn
	* modifies is ALSO serial: the model composed that read against the file's
	* state at its position in the turn, so submission order must be preserved
	* (a read-then-edit must see pre-edit content; an edit-then-read must see
	* post-edit content).
	*/
function isParallelReadOnlyCall(
	workspaceRoot: string,
	call: { name: string; args: Record<string, unknown> },
	editedPaths: ReadonlySet<string>,
): boolean {
	if (call.name === "execute_command") {
		return typeof call.args.command === "string" && isReadOnlyEquivalentShellCommand(call.args.command)
	}
	if (!PARALLEL_READ_ONLY_TOOL_NAMES.has(call.name)) {
		return false
	}
	if (call.name === "read_file") {
		const raw = typeof call.args.path === "string" && call.args.path.trim() !== "" ? call.args.path : undefined
		if (raw !== undefined) {
			try {
				if (editedPaths.has(path.resolve(workspaceRoot, raw))) {
					return false
				}
			} catch {
				// Unresolvable path: fall through — a parallel read is harmless.
			}
		}
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
const BATCH_EDIT_TOOL_NAMES = new Set(["apply_diff", "search_replace", "edit_file", "write_to_file", "set_indentation"])

/**
 * Best-effort extraction of the file path an edit tool call targets, for the
 * same-file batch diagnosis. `apply_diff`/`write_to_file` use `path`;
 * `search_replace`/`edit_file` use `file_path`. Resolved against the
 * workspace root so two spellings of the same path collide. Not authoritative
 * (the executor's own safeTarget is) — a mis-extraction only skips a
 * diagnosis, never blocks anything.
 */
/**
 * (T1) Strip reasoning from every assistant history message except the most
 * recent one. Native DeepSeek only needs reasoning echoed on the
 * IMMEDIATELY-PRECEDING assistant message in an active tool-call chain — older
 * echoes are pure token cost on every subsequent request (the whole history is
 * re-sent). Tool and user messages are never touched. Mutates `messages` in
 * place: the caller pushes the new assistant message FIRST, so "most recent"
 * is the message that must keep its reasoning for the next request.
 */
export function stripSupersededReasoning(messages: ChatMessage[]): void {
	let lastAssistant = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			lastAssistant = i
			break
		}
	}
	for (let i = 0; i < messages.length; i++) {
		if (i !== lastAssistant && messages[i].role === "assistant" && messages[i].reasoning !== undefined) {
			messages[i].reasoning = undefined
		}
	}
}

/**
 * Best-effort absolute path for ANY tool call's `path`/`file_path` arg —
 * factored out of editToolTargetPath (below) so the repeated-tool-failure
 * guardrail (issue #146) can recognize a `read_file` call as re-diagnosis
 * of the SAME target a different, currently-failing tool is acting on
 * (read_file isn't in BATCH_EDIT_TOOL_NAMES, so editToolTargetPath alone
 * never resolves it).
 */
function toolCallPathArg(workspaceRoot: string, call: { args: Record<string, unknown> }): string | undefined {
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

function editToolTargetPath(workspaceRoot: string, call: { name: string; args: Record<string, unknown> }): string | undefined {
	if (!BATCH_EDIT_TOOL_NAMES.has(call.name)) {
		return undefined
	}
	return toolCallPathArg(workspaceRoot, call)
}

/**
 * A real file:line-shaped citation — e.g. `src/engine/loop.ts:123` or
 * `src/tools/executor.ts:45-67`. Used by requireArtifactMinCitations to
 * detect whether a research doc contains grounded evidence, not just
 * unverified prose. Deliberately permissive on the file-extension part
 * (any non-slash, non-colon run) so it matches citations across
 * languages, not just TypeScript.
 */
const CITATION_PATTERN = /\b[\w.-]+(?:\/[\w.-]+)+\.\w+:\d+(?:-\d+)?\b/g

/**
 * Verifies a CITATION_PATTERN match's file:line actually exists on disk —
 * closes PART of issue #152's gap (a citation-shaped string previously
 * counted toward requireArtifactMinCitations even when the cited file
 * doesn't exist, or the line number is past the file's real length).
 * Does NOT verify the citation's CLAIM matches the real content at that
 * location — that needs semantic understanding no deterministic check
 * can provide (confirmed live 2026-08-21: a real-line-number-but-
 * fabricated-claim citation slipped past both this kind of mechanical
 * count AND an LLM judge given only document text — see
 * scripts/eval-suite/verify-citations.mjs, the human/Claude-facing tool
 * that surfaces the real content for that judgment call instead). This
 * only catches a citation pointing at something that doesn't exist at
 * all — a real, if partial, improvement: previously ANY citation-shaped
 * text counted, even a wholly invented file path.
 */
async function countVerifiedCitations(content: string, workspaceRoot: string): Promise<number> {
	const matches = content.match(CITATION_PATTERN) ?? []
	let verified = 0
	for (const citation of matches) {
		const parsed = /^(.+):(\d+)(?:-(\d+))?$/.exec(citation)
		if (!parsed) {
			continue
		}
		const [, filePart, startStr, endStr] = parsed
		const start = Number(startStr)
		const end = endStr ? Number(endStr) : start
		try {
			const fileContent = await fsp.readFile(path.resolve(workspaceRoot, filePart), "utf-8")
			const lineCount = fileContent.split("\n").length
			if (start >= 1 && end <= lineCount) {
				verified++
			}
		} catch {
			// File doesn't exist, unreadable, or outside the workspace — not
			// a real citation regardless of how plausible the text looks.
		}
	}
	return verified
}

/**
 * requireArtifactPathPattern's real check (see HeadlessSessionConfig's doc
 * comment) — a single-directory glob relative to workspaceRoot, e.g.
 * `"plans/research/*.md"`. Checks the REAL filesystem (not tool-call
 * bookkeeping): at least one non-empty file in the target directory whose
 * name matches the glob. Deliberately one directory level only — this
 * exists to verify one specific expected deliverable, not to implement a
 * general recursive glob engine. Returns the matched file's citation count
 * (via CITATION_PATTERN) so the caller can also enforce
 * requireArtifactMinCitations without a second filesystem pass.
 */
async function matchingArtifactFileStatus(
	workspaceRoot: string,
	pattern: string,
): Promise<{ found: boolean; citationCount: number; relativePath?: string; content?: string }> {
	const lastSlash = pattern.lastIndexOf("/")
	const dirPart = lastSlash === -1 ? "." : pattern.slice(0, lastSlash)
	const namePattern = lastSlash === -1 ? pattern : pattern.slice(lastSlash + 1)
	const dirAbs = path.resolve(workspaceRoot, dirPart)
	let entries: string[]
	try {
		entries = await fsp.readdir(dirAbs)
	} catch {
		return { found: false, citationCount: 0 }
	}
	for (const entry of entries) {
		if (!path.matchesGlob(entry, namePattern)) {
			continue
		}
		try {
			const filePath = path.join(dirAbs, entry)
			const stat = await fsp.stat(filePath)
			if (stat.isFile() && stat.size > 0) {
				const content = await fsp.readFile(filePath, "utf-8")
				const citationCount = await countVerifiedCitations(content, workspaceRoot)
				return { found: true, citationCount, relativePath: path.relative(workspaceRoot, filePath), content }
			}
		} catch {
			// Race with a concurrent delete/rename — treat as not-yet-matched.
		}
	}
	return { found: false, citationCount: 0 }
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
	"[System: attempt_completion not accepted — the workspace has uncommitted changes: either an existing tracked file was modified, or a new file YOU wrote this session is still untracked. Real, working changes must be committed via `git add` + `git commit` BEFORE finishing: one commit per logical change, with a descriptive message matching this repo's normal style (run `git log --oneline` for examples) — `git add` a brand-new file too, it does not commit itself. Commit your changes, then call attempt_completion again. If you genuinely have a reason to leave changes uncommitted (e.g. a read-only investigation), call attempt_completion again as-is and it will be accepted.]"

const execFileP = promisify(execFile)

/**
 * True when the workspace's git repo has uncommitted TRACKED-file changes
 * (modified/staged/deleted/renamed — NOT `??` untracked files in general,
 * which may be pre-existing scratch work the model shouldn't be forced to
 * commit) OR an untracked file that THIS session itself wrote via an edit
 * tool (*sessionWrittenPaths* — see the field doc on HeadlessSession for
 * why the general untracked-file exemption has a blind spot for a
 * session's own new-file deliverables, e.g. "write tests for X" almost
 * always produces a brand-new, still-untracked file). False when git fails
 * (no repo) or the status is clean. The commit-before-finishing
 * guardrail's structural backstop — independent of whether the prompt
 * instruction alone is followed.
 */
async function hasUncommittedTrackedChanges(
	workspaceRoot: string,
	sessionWrittenPaths: ReadonlySet<string>,
): Promise<boolean> {
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
			const untrackedPath = line.slice(3).trim()
			let resolved: string
			try {
				resolved = path.resolve(workspaceRoot, untrackedPath)
			} catch {
				continue
			}
			if (sessionWrittenPaths.has(resolved)) {
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
	/**
	 * Cap on the main call's output tokens (default: DEFAULT_MAX_TOKENS in
	 * loop.ts — 32,768; an explicit value here always wins).
	 */
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
	 * unset, no `reasoning.effort` is sent and the endpoint's default applies
	 * (pre-existing behavior). Resolved by the CLI from the `_reasoning_effort`
	 * key in mode-models.json then $HEADLESSCODE_REASONING_EFFORT; falls back
	 * to the env var here for direct construction.
	 */
	reasoningEffort?: string
	/** Sliding-window cap on messages sent per request (default 40). */
	windowSize?: number
	/**
	 * When true, a bare text-only reply (no tool_calls) is NOT accepted as a
	 * successful completion — it's nudged the same as an empty reply, and
	 * only an explicit `attempt_completion` tool call ends the session
	 * successfully. Default false (preserves the pragmatic fallback cloud
	 * models rely on). The local Ollama code-mode backend turns this on: a
	 * model that gives up mid-task and dumps prose (observed live — see
	 * plans/local-dual-model-code-agent.md's handoff doc, 2026-08-19) was
	 * otherwise recorded as `session succeeded` with zero files touched.
	 */
	requireExplicitCompletion?: boolean
	/**
	 * Patch `edit_file`'s schema (move `expected_replacements` into
	 * `required`) before it reaches the model — works around a
	 * llama.cpp/llama-cpp-python grammar-constrained-decoding bug that
	 * corrupts tool calls when a multi-parameter tool has any optional
	 * parameter (ggml-org/llama.cpp#20164). See
	 * prompt.ts's `patchEditFileToolForLocalModels` doc comment for the full
	 * root-cause writeup. Default false; the local Ollama code-mode backend
	 * turns this on. No effect on cloud sessions, which aren't
	 * grammar-constrained this way.
	 */
	patchLocalToolSchemas?: boolean
	/**
	 * Refuse `attempt_completion` when the most recent `execute_command` call
	 * in the session ended in an error and no LATER `execute_command` has
	 * succeeded since. Catches a real, observed failure mode distinct from
	 * `requireExplicitCompletion` (which only rejects a bare-text non-call):
	 * a local model calls `attempt_completion` for real, but claims success
	 * while the last verification command it ran (tsc/tests/build/…) is
	 * still failing — e.g. after a destructive edit it never actually
	 * fixed. Verified live 2026-08-20 against Qwen3-14B: this exact
	 * sequence (failing tsc/test run → one more edit → attempt_completion
	 * with a false "typecheck and tests passed" claim, never re-running
	 * either) went through unchecked. Generic on purpose — it doesn't know
	 * what a "test" command looks like, only whether the last command this
	 * session actually ran succeeded. Default false; the local Ollama
	 * code-mode backend turns this on.
	 */
	verifyBeforeCompletion?: boolean
	/**
	 * Evidence-gated completion — the fabrication fix (2026-09-01, see
	 * src/engine/claims.ts). When true, `attempt_completion` is refused
	 * unless every machine-checkable claim its result text makes (a file
	 * exists, a specific command passed, serial markers appear, a PR
	 * exists) is independently verified against ground truth:
	 *
	 *   - file claim    → fs.stat on the resolved workspace path
	 *   - command claim → RE-RUN the exact command (same permission gate as
	 *                     execute_command), require exit 0
	 *   - serial marker → grep the newest build/serial-*.log for the claimed
	 *                     ordered markers
	 *   - PR claim      → require real git-history evidence of the number
	 *
	 * Ground truth comes from the filesystem and real re-runs — never from
	 * the model's own prose. This is the structural backstop for the exact
	 * failure the FINAL_REPORT documented (§4): a session claimed "all
	 * three hard gates pass" with a fabricated serial-log excerpt when the
	 * driver was never merged and the claimed Makefile target didn't exist.
	 * Fail-closed: any unverifiable claim defers the completion with a
	 * corrective message naming the specific unverified claim.
	 *
	 * Deliberately separate from verifyBeforeCompletion (which is
	 * token/state-based and only looks at the LAST command): this checks
	 * the CONTENT of the completion's claims against the real world,
	 * independent of what the session did or didn't run before.
	 *
	 * Default false; opt-in via --require-evidence or the local code
	 * backend (see cli.ts).
	 */
	evidenceRequiredCompletion?: boolean
	/**
	 * When false, cost is never tracked/accumulated for this session (see
	 * BudgetTrackerOptions.trackCost) — local-backend sessions have no real
	 * dollar cost. Default true.
	 */
	trackCost?: boolean
	/**
	 * Refuse attempt_completion when this session has never once called
	 * execute_command, write_to_file, or edit_file — i.e. it has produced
	 * no real, verifiable artifact or side effect. Issue #143: verified
	 * live 2026-08-21 (twice, word-for-word identical both times) against
	 * Qwen3-14B running the multi-agent-orchestrator-headless mode — a
	 * session claimed to have "implemented the identified modification"
	 * having called only list_files, read_file, update_todo_list, and a
	 * failed ask_followup_question. No file was touched, no command was
	 * run, no GitHub issue was filed.
	 *
	 * NOT folded into verifyBeforeCompletion itself: that flag is set
	 * uniformly by useLocalBackend for every local-backend mode, including
	 * deepseek-reviewer and qa-agent — read-only modes whose CORRECT,
	 * non-fabricated completion is very often "I read the files, formed a
	 * judgment, verdict: clean" with zero write/execute calls. Applying
	 * this check there would force spurious command execution or wrongly
	 * refuse valid clean verdicts. This is deliberately a separate flag the
	 * caller opts into per-mode (cli.ts sets it for `code` and
	 * `multi-agent-orchestrator-headless`, not for read-only modes) rather
	 * than something loop.ts infers from the tool catalog or task text.
	 * Default false.
	 */
	requireArtifactBeforeCompletion?: boolean
	/**
	 * A "research harness" primitive (product direction 2026-08-21: an
	 * agent's MODE has both TOOLS and a HARNESS — a structural runtime
	 * guarantee, not a prompt suggestion). requireArtifactBeforeCompletion
	 * above only checks "did you call ANY write/execute tool at all" —
	 * verified live 2026-08-21 that this is too weak: a session can call
	 * edit_file against some unrelated file (or nothing) while never
	 * producing the actual deliverable it was tasked with, and still pass
	 * that check. This is stricter: a single glob pattern (relative to
	 * workspaceRoot, one directory level — e.g. `"plans/research/*.md"`)
	 * that must match at least one REAL, non-empty file on disk at
	 * attempt_completion time, checked directly against the filesystem
	 * (not tool-call bookkeeping) so it can't be satisfied by a call that
	 * later failed or targeted the wrong file. Undefined = no check.
	 */
	requireArtifactPathPattern?: string
	/**
	 * Companion to requireArtifactPathPattern — a MINIMUM number of real
	 * file:line-shaped citations (e.g. `src/engine/loop.ts:123`) the
	 * matched file's content must contain before completion is accepted.
	 * File-existence alone (requireArtifactPathPattern with no minimum)
	 * can still be satisfied by a stub — this forces the deliverable to
	 * actually contain the kind of grounded evidence a real research pass
	 * produces, not just a title and a paragraph of unverified prose.
	 * Requires requireArtifactPathPattern to also be set. Undefined/0 =
	 * no minimum (existence alone suffices).
	 */
	requireArtifactMinCitations?: number
	/**
	 * Second companion to requireArtifactPathPattern — a list of required
	 * section headings (case-insensitive substring match, e.g. "What to
	 * build", "What NOT to do", "How to verify") that must ALL appear in
	 * the matched file's content before completion is accepted. Live-
	 * verified 2026-08-21: a research session satisfied
	 * requireArtifactMinCitations with a real, well-cited document that
	 * was nonetheless a general SURVEY (what each file does) rather than
	 * the specific "here is one concrete finding, what to build, what not
	 * to, how to verify" deliverable the task actually asked for — real
	 * citations alone don't guarantee the document commits to a scoped
	 * proposal. Requires requireArtifactPathPattern to also be set.
	 * Undefined/empty = no required sections.
	 */
	requireArtifactSections?: string[]
	/**
	 * Refuse `write_to_file` (whole-file overwrite) against a file that
	 * already has substantial content, nudging the model toward `edit_file`/
	 * `search_replace` instead. Verified live 2026-08-20 against both
	 * Qwen2.5-Coder-14B and Qwen3-14B, and reproduced with a synthetic
	 * request bypassing headlesscode entirely: given a real ~500-line file
	 * and a one-function-add task, both models had a strong bias toward
	 * regenerating the ENTIRE file from scratch via `write_to_file` instead
	 * of a targeted diff — and since a full regeneration needs far more
	 * output budget than a precise edit, this reliably truncates mid-file,
	 * silently destroying everything after the cutoff (see
	 * plans/local-dual-model-code-agent-PROMPT-2026-08-20.md, "Tonight's
	 * core finding"). `write_to_file` against a NEW file (the common,
	 * legitimate case — e.g. a test file) is never affected; see
	 * `writeToFileHandler`'s guard in src/tools/executor.ts. Default false;
	 * the local Ollama code-mode backend turns this on.
	 */
	guardLargeOverwrites?: boolean
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
	 * call (default: DEFAULT_CONDENSE_MAX_TOKENS in src/engine/condense.ts —
	 * 4096, independent of the session's `maxTokens`, so the call always
	 * sends `max_tokens`; an explicit value here always wins).
	 */
	condenseMaxTokens?: number
	/**
	 * Skip the LLM-summarization condensation call entirely and rely on
	 * `truncateHistory`'s plain drop-oldest eviction (which always runs
	 * afterward regardless — see maybeCondenseHistory's call site). See the
	 * field's twin in the resolved config below for the full rationale.
	 */
	disableLlmCondensation?: boolean
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
	/** See HeadlessSessionConfig.requireExplicitCompletion (default false). */
	requireExplicitCompletion: boolean
	/** See HeadlessSessionConfig.patchLocalToolSchemas (default false). */
	patchLocalToolSchemas: boolean
	/** See HeadlessSessionConfig.verifyBeforeCompletion (default false). */
	verifyBeforeCompletion: boolean
	/** See HeadlessSessionConfig.evidenceRequiredCompletion (default false). */
	evidenceRequiredCompletion: boolean
	/** See HeadlessSessionConfig.trackCost (default true). */
	trackCost: boolean
	/** See HeadlessSessionConfig.requireArtifactBeforeCompletion (default false). */
	requireArtifactBeforeCompletion: boolean
	/** See HeadlessSessionConfig.requireArtifactPathPattern (default undefined = no check). */
	requireArtifactPathPattern?: string
	/** See HeadlessSessionConfig.requireArtifactMinCitations (default undefined = no minimum). */
	requireArtifactMinCitations?: number
	/** See HeadlessSessionConfig.requireArtifactSections (default undefined = none required). */
	requireArtifactSections?: string[]
	/** See HeadlessSessionConfig.guardLargeOverwrites (default false). */
	guardLargeOverwrites: boolean
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
	/**
	 * Verified live 2026-08-28 against Qwen3.5-9B+LoRA on the local backend:
	 * asked to compress a 30998-token transcript chunk into ~4096 tokens (a
	 * ~13:1 ratio), the condensation call turned a correctly-hedged earlier
	 * note ("qemu-net-smoke is the EXISTING gate, for reference") into a flat
	 * factual claim ("the qemu-net-smoke gate passed... ready to merge") for
	 * an unrelated, already-merged feature that this session never touched —
	 * the CONDENSE_SYSTEM_PROMPT's "never invent content" rule is only as
	 * reliable as the summarizer model executing it, and a 9B model doing a
	 * lossy 13:1 compression under time/token pressure is not reliably that
	 * model. The corrupted summary then re-entered history as trusted fact
	 * and the main loop built on it, repeating the false completion claim
	 * deterministically until bounded failure killed the session. Unlike a
	 * plain truncation gap (the model can always re-read/re-run to recover
	 * lost information), a confidently WRONG summary is not self-correcting
	 * — the model has no way to tell a condensed fact from a fabricated one.
	 * Given local inference has no per-token cost pressure (the entire reason
	 * cloud sessions accept summarization's risk to save a paid, latency-
	 * bearing call), the tradeoff doesn't hold locally: default OFF for the
	 * local backend (cli.ts's useLocalCodeBackend gate, same opt-in-override
	 * pattern as requireExplicitCompletion/verifyBeforeCompletion above —
	 * HEADLESSCODE_ALLOW_LLM_CONDENSATION opts back in). `truncateHistory`'s
	 * message-count eviction (loop.ts's unconditional post-condensation call)
	 * remains fully active either way — this only removes the LLM summary
	 * step, not history management itself.
	 */
	disableLlmCondensation?: boolean
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
	 * Evidence-gated completion (fabrication fix, 2026-09-01): the outcome of
	 * the last attempt_completion claim-verification pass, when
	 * evidenceRequiredCompletion was on and the result contained
	 * machine-checkable claims. Carried onto the SessionResult (see
	 * src/engine/types.ts SessionResult.verification) so callers can
	 * distinguish "success claim independently verified" from "success
	 * accepted on prose alone". undefined when the gate didn't run (flag off,
	 * or no claims to check).
	 */
	private lastCompletionVerification: SessionCompletionVerification | undefined = undefined
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
	/**
	 * Commit-before-finishing guardrail, new-file blind spot fix: every path
	 * this session itself successfully wrote to via an edit tool
	 * (write_to_file/apply_diff/search_replace/edit_file — see
	 * editToolTargetPath), accumulated across the WHOLE session, not just one
	 * turn's batch. hasUncommittedTrackedChanges()'s own `git status --short`
	 * check deliberately exempts `??` untracked files (they may be
	 * pre-existing scratch work unrelated to this session) — but a brand-new
	 * file THIS session just wrote is never "someone else's scratch work",
	 * so it must still force the commit nudge even though it shows up as
	 * `??`. See attempt_completion's call site for how this is consulted.
	 */
	private sessionWrittenPaths = new Set<string>()
	/**
	 * (S2) Ordering guard for fire-and-forget auxiliary writes: a per-session
	 * promise chain so a later-scheduled write never overtakes an earlier one
	 * (event-feed appends and the live-snapshot overwrite must land in
	 * occurrence order). Drained at the end of run() so "session ended" implies
	 * "aux writes flushed" — see scheduleAux/drainAuxWrites.
	 */
	private _auxChain: Promise<void> = Promise.resolve()
	/**
	 * Lazy tool catalog (see src/engine/lazy-tools.ts): tools available via
	 * request_tool but not yet added to state.tools for this session. Empty
	 * when HEADLESSCODE_LAZY_TOOL_CATALOG is off (the default).
	 */
	private lazyToolsByName: Map<string, ChatTool> = new Map()

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
			requireExplicitCompletion: config.requireExplicitCompletion ?? false,
			patchLocalToolSchemas: config.patchLocalToolSchemas ?? false,
			verifyBeforeCompletion: config.verifyBeforeCompletion ?? false,
			evidenceRequiredCompletion: config.evidenceRequiredCompletion ?? false,
			trackCost: config.trackCost ?? true,
			requireArtifactBeforeCompletion: config.requireArtifactBeforeCompletion ?? false,
			requireArtifactPathPattern: config.requireArtifactPathPattern,
			requireArtifactMinCitations: config.requireArtifactMinCitations,
			requireArtifactSections: config.requireArtifactSections,
			guardLargeOverwrites: config.guardLargeOverwrites ?? false,
			// Deliberately left undefined when the caller didn't configure it:
			// the live OpenRouter models-endpoint lookup in maybeCondenseHistory
			// resolves the real context window (never hardcode a stale number —
			// constraint 1 of plans/context-condensation.md), with
			// DEFAULT_CONTEXT_WINDOW_TOKENS as the conservative fallback.
			contextWindowTokens: config.contextWindowTokens,
			condenseThresholdFraction: config.condenseThresholdFraction ?? DEFAULT_CONDENSE_THRESHOLD_FRACTION,
			condenseEarlyFireFraction: config.condenseEarlyFireFraction ?? DEFAULT_CONDENSE_EARLY_FIRE_FRACTION,
			condenseModel: config.condenseModel ?? config.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL,
			condenseMaxTokens: config.condenseMaxTokens ?? DEFAULT_CONDENSE_MAX_TOKENS,
			disableLlmCondensation: config.disableLlmCondensation ?? false,
			logger: config.logger,
			temperature: config.temperature,
			maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
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
				guardLargeOverwrites: this.config.guardLargeOverwrites,
				// Live worker monitoring: mirror ask_followup_question's
				// .harness.needs-decision marker lifecycle on the session's
				// event feed (decision_blocked / decision_answered). Non-fatal.
				// (S2) Routed through scheduleAux so the event lands in the feed
				// in occurrence order (these fire during tool execution, while
				// earlier events may still be queued in the chain).
				onDecisionEvent: (eventType, fields) => {
					this.scheduleAux(() =>
						this.emitEvent(
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
						),
					)
				},
				// Live worker monitoring: mirror each update_todo_list state
				// change on the session's event feed (todo_updated). Non-fatal.
				// (S2) Same ordering reasoning as onDecisionEvent.
				onTodoEvent: (fields) => {
					this.scheduleAux(() =>
						this.emitEvent(
							"todo_updated",
							() =>
								this.eventFeed.todoUpdated({
									todos: fields.todos,
									done: fields.done,
									inProgress: fields.inProgress,
									pending: fields.pending,
								}),
							fields,
						),
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
		// Lazy tool catalog (src/engine/lazy-tools.ts): list_tools/request_tool
		// are pure session-state operations, registered the same session-bound
		// way as new_task/switch_mode regardless of executor capabilities —
		// they exist whenever lazy loading is on, not gated by workspace type.
		if (isLazyToolCatalogEnabled()) {
			if (!this.executor.has(LIST_TOOLS_NAME)) {
				this.executor.register(LIST_TOOLS_NAME, () => this.handleListTools())
			}
			if (!this.executor.has(REQUEST_TOOL_NAME)) {
				this.executor.register(REQUEST_TOOL_NAME, (args) => this.handleRequestTool(args))
			}
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
		const buildPrompt = isLeanSystemPromptEnabled() ? buildLeanSystemPrompt : buildSystemPrompt
		const systemPrompt =
			this.config.systemPromptOverride ??
			(await buildPrompt({
				workspaceRoot,
				mode,
				customModes,
				globalCustomInstructions: this.config.globalCustomInstructions,
			})).prompt
		// browser_action, describe_image and the code-intelligence tools are
		// not part of the vendored tool set, so selectToolsForMode can't
		// include them — append them explicitly (see src/tools/browser/,
		// src/vision/ and src/codeintel/). Every non-vendored append is gated
		// on THIS session's executor actually registering the handler: the
		// read-only reviewer/QA executors must not be advertised tools they
		// can't run (they register browser_action but not describe_image), and
		// on a non-TS/JS workspace (Python/C++/…) the executor deliberately
		// does not register the ts.Program-based tools at all — so the tool
		// list matches what actually works for the project (and read-only
		// sessions don't carry a describe_image schema they'd error on).
		let tools = this.config.tools ?? selectToolsForMode(mode, customModes)
		if (this.executor.has("browser_action")) {
			tools = appendBrowserActionTool(tools)
		}
		if (this.executor.has("describe_image")) {
			tools = appendDescribeImageTool(tools)
		}
		if (this.executor.has("outline")) {
			tools = appendCodeIntelTools(tools)
		}
		if (this.executor.has("rename_symbol")) {
			tools = appendCodeIntelEditTools(tools)
		}
		if (this.executor.has("run_tests")) {
			tools = appendRunTestsTool(tools)
		}
		if (this.executor.has("set_indentation")) {
			tools = appendSetIndentationTool(tools)
		}
		if (this.config.patchLocalToolSchemas) {
			tools = patchEditFileToolForLocalModels(tools)
		}
		if (isLazyToolCatalogEnabled()) {
			const split = splitCoreAndLazyTools(tools)
			this.lazyToolsByName = split.lazyByName
			tools = split.core
		}

		this.state.systemPrompt = systemPrompt
		this.state.tools = tools
		// (T2/T3 measure-first) Log the fixed prompt + tool-catalog prefix size.
		this.logPrefixSize(systemPrompt, tools, "session-start")

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
			new BudgetTracker(this.config.budget ?? {}, {
				trackCost: this.config.trackCost,
				...(pricingTable ? { pricing: pricingTable } : {}),
			})
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
			// of throwing, but if it ever does, flush any still-in-flight aux
			// writes (the last iteration's live snapshot) before removing the
			// snapshot, then rethrow. Non-fatal (see removeLiveSnapshot).
			await this.drainAuxWrites()
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
		// (S2) "Session ended" implies "aux writes flushed": drain the background
		// chain before returning so post-run readers see the final feed/snapshot
		// state, and recordUsage's live-snapshot removal below never races a
		// still-in-flight write from the last iteration.
		await this.drainAuxWrites()
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
	 * (S2) Fire-and-forget auxiliary write dispatcher with an ordering guard:
	 * appends `fn` to a per-session promise chain so a later-scheduled write
	 * never overtakes an earlier one — event-feed appends and the live-snapshot
	 * overwrite must land in occurrence order. The wrapped functions are all
	 * non-fatal already (try/catch inside emitEvent/writeLiveSnapshot/
	 * saveIterationCheckpoint); the catch here is a belt-and-suspenders no-op
	 * log so a scheduling bug can never reject the chain and strand later
	 * writes.
	 */
	private scheduleAux(fn: () => Promise<void>): void {
		this._auxChain = this._auxChain.then(fn).catch((error) => {
			this.logger.warn("[aux] background write failed (non-fatal)", {
				error: error instanceof Error ? error.message : String(error),
			})
		})
	}

	/**
	 * (S2) Await every scheduled auxiliary write. Called at the end of run() so
	 * "session ended" implies "aux writes flushed" — post-run readers (tests,
	 * orchestrators) see the final feed/snapshot state, and the live-snapshot
	 * removal in recordUsage never races a still-in-flight write from the last
	 * iteration.
	 */
	private async drainAuxWrites(): Promise<void> {
		await this._auxChain
	}

	/**
	 * (T2/T3 measure-first) Log the fixed prefix cost — final system prompt +
	 * serialized tool catalog — at session start and on each switch_mode, so
	 * real sessions in harness.log carry the numbers that justify (or kill)
	 * prompt/tool-catalog surgery. Approximate tokens via ~4 chars/token (see
	 * estimateTokenSize).
	 */
	private logPrefixSize(systemPrompt: string, tools: ChatTool[], context: string): void {
		const toolJson = JSON.stringify(tools)
		const totalChars = systemPrompt.length + toolJson.length
		this.logger.info("[prefix-size]", {
			context,
			systemPromptChars: systemPrompt.length,
			systemPromptTokensEstimate: estimateTokenSize(systemPrompt.length),
			toolCount: tools.length,
			toolCatalogChars: toolJson.length,
			toolCatalogTokensEstimate: estimateTokenSize(toolJson.length),
			totalPrefixChars: totalChars,
			totalPrefixTokensEstimate: estimateTokenSize(totalChars),
		})
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
		// (S2) The attempt_completion event is a feed append like any other —
		// schedule it so it lands AFTER this turn's llm_response, which the
		// critical path de-awaited (see scheduleAux).
		this.scheduleAux(() =>
			this.emitEvent(
				"attempt_completion",
				() => this.eventFeed.attemptCompletion({ iteration, result }),
				{ iteration },
			),
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

		// See HeadlessSessionConfig.disableLlmCondensation's doc comment: a
		// weak summarizer can turn hedged context into a confidently WRONG
		// "fact" that then gets trusted as real history, so the LLM
		// summarization call itself is skipped. That is NOT the same as
		// doing nothing, though — truncateHistory (this method's caller,
		// unconditionally, right after) only bounds message COUNT
		// (config.windowSize, default 300), never tokens, and a local
		// model's real context window is far smaller than 300 messages'
		// worth of file reads/edits can stay under. Verified live
		// 2026-08-28: with condensation fully skipped and no token-aware
		// eviction in its place, a real session hit a hard "request exceeds
		// context size" 400 from llama-server at only 45 messages (65,824
		// tokens against a 65,536-token window) — nowhere near windowSize,
		// so truncateHistory never engaged either. Reuse the exact same
		// token-threshold trigger and tool-call-group-safe message count
		// the LLM path computes (computeCondensePlan), but DROP the
		// selected oldest messages outright instead of summarizing them —
		// plain eviction has no fabrication risk (the gap is honest: the
		// model can re-read/re-run to recover it, exactly like
		// truncateHistory's own drop-oldest eviction already relies on
		// elsewhere), unlike a confidently wrong LLM summary.
		if (config.disableLlmCondensation) {
			// computeCondensePlan is a pure calculator — it does not itself
			// check whether the threshold was crossed (maybeCondense in
			// condense.ts does that BEFORE ever calling it on the LLM path).
			// Omitting the same guard here was a real bug, verified live
			// 2026-08-28: eviction fired on iteration 2 of a brand-new
			// session at 17,019 tokens (nowhere near any real threshold)
			// because a negative `wantTokens` (lastPromptTokens well under
			// targetTokens) still yields a near-zero budget that
			// computeCondenseCount always fills with at least one tool-call
			// group by design — silently discarding the model's very first
			// turn before it had a chance to make any progress.
			const threshold = Math.max(1, contextWindowTokens * config.condenseThresholdFraction)
			if (this.lastLlmUsage.inputTokens < threshold) {
				return messages
			}
			const { count } = computeCondensePlan(
				messages,
				this.lastLlmUsage.inputTokens,
				contextWindowTokens,
				config.condenseThresholdFraction,
			)
			if (count >= 2) {
				const messagesBefore = messages.length
				messages.splice(2, count)
				this.executor.notifyCondensed()
				this.logger.info("[condense] disableLlmCondensation: evicted oldest turns (no summary)", {
					iteration,
					evictedCount: count,
					messagesBefore,
					messagesAfter: messages.length,
				})
			}
			return messages
		}

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

		// Same abort-timeout mechanism as the main call (callMainLlm): a
		// provider that never responds must not hang the session forever —
		// on timeout the call aborts and the non-fatal catch below falls back
		// to truncateHistory.
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs)
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
				condenseMaxTokens: config.condenseMaxTokens,
				condenseAbortSignal: controller.signal,
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
				// See ToolExecutor.notifyCondensed: lets the list_files repeat-call
				// guard allow a re-list now that some earlier result may have been
				// compressed away.
				this.executor.notifyCondensed()
				// Emit the feed event the timeline needs: condensation used to
				// be only a log line, invisible to the dashboard. Non-fatal.
				// (S2) Scheduled so it lands after this iteration's
				// iteration_start, in occurrence order.
				this.scheduleAux(() =>
					this.emitEvent("condensed", () =>
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
					),
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
		} finally {
			clearTimeout(timer)
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
		// Same abort-timeout mechanism as the synchronous path / the main
		// call: a hung background condensation must abort on the configured
		// per-LLM-call timeout instead of leaking a never-resolving call.
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs)
		condenseOldestTurns(this.llmClient, {
			messages: snapshot,
			count: plan.count,
			model: config.condenseModel,
			maxTokens: config.condenseMaxTokens,
			signal: controller.signal,
			onUsage: (usage) => this.recordCondensationUsage(usage, budgetTracker),
		})
			.then(async (summary) => {
				clearTimeout(timer)
				// The job is done (applied or discarded) — a NEW background job
				// may fire on a later iteration.
				this.backgroundCondense = null
				await this.applyBackgroundCondense(job, summary)
			})
			.catch((error) => {
				clearTimeout(timer)
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
		// See ToolExecutor.notifyCondensed: lets the list_files repeat-call
		// guard allow a re-list now that some earlier result may have been
		// compressed away.
		this.executor.notifyCondensed()
		this.logger.info("[condense] background condensation applied", {
			firedAtIteration: job.firedAtIteration,
			count: job.count,
			historyBefore: messagesBefore,
			historyAfter: condensed.length,
		})
		// Same feed event the synchronous path emits (see maybeCondenseHistory)
		// so the dashboard timeline shows background condensation too. Non-fatal.
		// (S2) Scheduled for occurrence-order placement in the feed.
		//
		// Issue #84: re-check sessionEnded here, immediately before scheduling,
		// not just at function entry. The whole method body above is
		// synchronous today so the entry check already covers this call, but
		// that's an easy invariant for a future edit to silently break by
		// inserting an `await` earlier in this function — a stale entry check
		// would then let a post-session_end write slip into `scheduleAux` and
		// land in the feed AFTER the terminal session_end event (run()'s
		// drainAuxWrites at the point sessionEnded flips true, loop.ts:1443,
		// only awaits writes already in the chain at that moment). Checking
		// right at the scheduling point keeps the guard correct regardless of
		// what runs earlier in the method.
		if (this.sessionEnded) {
			this.logger.info(
				"[condense] background condensation applied, but session ended before the feed event could be scheduled — event discarded",
				{ firedAtIteration: job.firedAtIteration, count: job.count },
			)
			return
		}
		this.scheduleAux(() =>
			this.emitEvent("condensed", () =>
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
			),
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
					maxTokens: config.condenseMaxTokens,
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
					maxTokens: config.condenseMaxTokens,
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
	 *
	 * `repeatPenaltyOverride` is the sampling-level identical-call
	 * intervention (see LlmRequest.repeatPenalty's doc comment): set by the
	 * caller once the identical-consecutive-call guardrail has detected a
	 * repeat streak at or past the nudge threshold, so the retry request
	 * itself, not just the injected text, pushes the model off the loop.
	 *
	 * `excludedToolNames` is the harder companion lever, applied from the
	 * same nudge threshold as the penalty boost: live trials (2026-08-20,
	 * three at repeat_penalty=1.3, one at 1.8, all with a widened
	 * last_n_tokens_size ruling out the sampler simply not "seeing" the
	 * repeat) verified the penalty alone does not reliably stop this model
	 * from repeating one tool call. This removes the repeated tool's schema
	 * from the request entirely, so the grammar-constrained decoder cannot
	 * select it at all — not merely a discouraged option. `attempt_completion`
	 * is never excludable — it's the one escape hatch the model must always
	 * retain even mid-guardrail.
	 *
	 * `tool_choice: "required"` (LlmRequest.toolChoice) is wired but
	 * deliberately NOT applied here. Tried it (2026-08-20) hoping to close
	 * off a presumed free-text/empty branch once a preferred tool is
	 * excluded — verified live it does nothing for tool SELECTION on this
	 * daemon's Qwen3/HF-chat-template handler (a raw daemon-bypass repro
	 * confirmed the model still freely declines with plain text even with
	 * "required" set), and worse, a request-shape only visible in "required"
	 * requests (a pre-closed empty `<think></think>` block, no conversation
	 * history content at all) showed up as a SEPARATE byte-for-byte-frozen
	 * prompt pattern, unrelated to and unfixed by the history-poisoning
	 * fixes below — suggesting "required" routes through a different
	 * internal prompt-construction path in llama-cpp-python entirely, not
	 * just an inert no-op. Left wired for a future model/handler that might
	 * actually respect it, but not applied by default until that
	 * alternate-path theory is confirmed or ruled out.
	 */
	private async callMainLlm(
		requestMessages: ChatMessage[],
		iteration: number,
		repeatPenaltyOverride?: number,
		excludedToolNames?: string[],
	): Promise<LlmResponse> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs)
		const excluded = new Set((excludedToolNames ?? []).filter((name) => name !== "attempt_completion"))
		const tools =
			excluded.size > 0 ? this.state.tools.filter((tool) => !excluded.has(tool.function.name)) : this.state.tools
		try {
			return await this.llmClient.createChatCompletion({
				model: this.config.model,
				messages: requestMessages,
				tools,
				temperature: this.config.temperature,
				maxTokens: this.config.maxTokens,
				signal: controller.signal,
				stream: this.config.stream,
				reasoningEffort: this.config.reasoningEffort,
				...(repeatPenaltyOverride !== undefined ? { repeatPenalty: repeatPenaltyOverride } : {}),
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
		// verifyBeforeCompletion guardrail: whether the most recent
		// execute_command call in the session (across all iterations) ended
		// in an error. Updated on every execute_command result below;
		// checked (only when the config flag is on) right before honoring
		// attempt_completion.
		let lastExecuteCommandFailed = false
		// Same as lastExecuteCommandFailed above, but for edit_file /
		// write_to_file — see the doc comment where it's set for why this
		// exists as a separate flag.
		let lastWriteToolFailed = false
		// See HeadlessSessionConfig.requireArtifactBeforeCompletion's doc
		// comment (issue #143). Set true the first time this session calls
		// execute_command, write_to_file, or edit_file — regardless of
		// whether that call succeeded (an attempt still proves the session
		// tried to produce a real effect; lastExecuteCommandFailed/
		// lastWriteToolFailed above separately catch a FAILED attempt).
		let hasCalledArtifactTool = false
		// Concrete command + truncated error output for the failure above,
		// so the attempt_completion rejection below can restate WHAT failed
		// instead of pointing at it abstractly — by the time a model reaches
		// a rejected attempt_completion, history truncation/condensation has
		// often already evicted the original error from context, leaving it
		// with nothing concrete to act on (observed live 2026-08-20: this
		// produced a stuck loop of a repeated, unmodified attempt_completion
		// call alternating with genuinely empty replies).
		let lastExecuteCommandSummary: string | undefined
		let lastWriteToolSummary: string | undefined
		// Blind tree-walking guardrail (P1.6): count consecutive all-read-only
		// iterations; when the streak crosses the threshold, inject one soft
		// nudge per streak (codebase_search-specific when indexed, progress-
		// focused when not); when it crosses the hard stall limit, terminate
		// like a bounded failure.
		const readOnlyNudgeThreshold = envReadOnlyNudgeThreshold()
		const readOnlyStallLimit = envReadOnlyStallLimit()
		let readOnlyStreak = 0
		let readOnlyNudgeInjected = false
		// Identical-consecutive-call guardrail (see
		// DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD's doc comment): tracks the
		// canonical signature of the LAST turn's tool call batch and how many
		// consecutive turns it has repeated unchanged.
		let lastCallBatchSignature: string | null = null
		let lastCallBatchNames: string[] = []
		let identicalCallStreak = 0
		let identicalCallNudgeInjected = false
		// Repeated-tool-failure guardrail (issue #146): tracks consecutive
		// FAILURES of the SAME TOOL NAME since the last success of that tool
		// or the last genuine re-diagnosis (a read_file call on the same
		// target path the failing tool is acting on) — see
		// DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD's doc comment.
		let toolFailureStreakName: string | undefined
		let toolFailureStreakCount = 0
		let toolFailureStreakTargetPath: string | undefined
		let toolFailureNudgeInjected = false
		// Artifact-gate rejection guardrail (issue #152): consecutive
		// requireArtifactMinCitations/requireArtifactSections rejections since
		// the last real (isError:false) read_file call anywhere in the
		// session — see DEFAULT_ARTIFACT_REJECTION_NUDGE_THRESHOLD's doc
		// comment.
		let artifactRejectionStreak = 0
		let artifactRejectionNudgeInjected = false
		// Tool-exclusion cooldown: verified live 2026-08-20 (trial 36) that a
		// bare streak-based exclusion is a ONE-SHOT deterrent — the guard
		// (correctly, see c1dd87b) resets as soon as the model produces a
		// text-only reply instead of repeating the excluded tool, but the
		// model's very next REAL action was to call that same tool again
		// immediately, rebuilding the streak from scratch and re-triggering
		// exclusion 2 turns later — an indefinite exclude/retry oscillation
		// (48+ cycles observed, never resolving on its own). Extends a
		// tool's exclusion for several turns PAST the streak that triggered
		// it, independent of the streak/nudge state resetting, so the model
		// has more than one turn's worth of pressure to actually pick
		// something else before the door reopens.
		const excludedToolCooldowns = new Map<string, number>()

		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			// Recursive task decomposition (`new_task`): remember the iteration
			// number so the handler can compute a child's default maxIterations
			// from the parent's REMAINING iterations (see handleNewTask).
			this.currentIteration = iteration
			this.logger.info(`[loop] iteration ${iteration}/${maxIterations}`, { history: messages.length })
			// Live worker monitoring: emit the iteration_start event alongside
			// the human-readable log line above. Non-fatal. The history count is
			// captured EAGERLY: the write runs later (scheduleAux), by which
			// point condensation may have spliced `messages` — the event must
			// report the count at iteration start, not after.
			const historyMessageCount = messages.length
			this.scheduleAux(() => this.emitEvent("iteration_start", () => this.eventFeed.iterationStart(iteration, historyMessageCount)))

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

			// (S2) Coalesce the aux-write flush: per-iteration feed/snapshot
			// writes are fire-and-forget (scheduleAux). Await them as ONE batch
			// before the expensive LLM call so the previous turn's monitoring
			// (and this iteration's iteration_start) is durable when the next
			// request begins — usually already flushed during tool execution,
			// so this is a resolved-promise no-op in practice, not the per-write
			// serialization S2 removed from the critical path.
			await this.drainAuxWrites()

			// 4. Call the LLM with an abort timeout. Retried ONCE on a classified
			// transient provider error (see isRetryableOpenRouterError) — this
			// is the main call, with no fallback provider to smooth over a
			// blip on the pinned deepseek/* endpoint (allow_fallbacks: false),
			// so without this a single hiccup used to kill the entire session
			// outright (observed live: an HTTP 520 "Provider returned error"
			// mid-session, iteration budget otherwise untouched). A second
			// failure — retryable or not — still falls through to the
			// catch block below exactly as before.
			// Sampling-level identical-call intervention (see
			// DEFAULT_IDENTICAL_CALL_REPEAT_PENALTY_BOOST's doc comment):
			// `identicalCallStreak` still holds the value computed at the END
			// of the PREVIOUS iteration, i.e. "was the last completed turn
			// already repeating" — exactly the request this call is about to
			// make, so the boost applies from the same turn the text nudge
			// starts firing on.
			const identicalCallGuardActive = identicalCallStreak >= DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD
			const repeatPenaltyOverride = identicalCallGuardActive ? envIdenticalCallRepeatPenaltyBoost() : undefined
			// Decay existing cooldowns one turn, dropping any that expire, THEN
			// refresh cooldowns for whatever the active streak is currently
			// excluding — so a tool that keeps getting re-triggered stays
			// excluded continuously rather than the cooldown counting down
			// underneath an active exclusion.
			for (const [name, remaining] of excludedToolCooldowns) {
				if (remaining <= 1) {
					excludedToolCooldowns.delete(name)
				} else {
					excludedToolCooldowns.set(name, remaining - 1)
				}
			}
			if (identicalCallGuardActive) {
				for (const name of lastCallBatchNames) {
					excludedToolCooldowns.set(name, DEFAULT_IDENTICAL_CALL_TOOL_COOLDOWN_TURNS)
				}
			}
			const excludedToolNames =
				excludedToolCooldowns.size > 0
					? [...new Set([...(identicalCallGuardActive ? lastCallBatchNames : []), ...excludedToolCooldowns.keys()])]
					: undefined
			if (repeatPenaltyOverride !== undefined || excludedToolNames !== undefined) {
				this.logger.info("[loop] identical-call repeat_penalty boost applied", {
					iteration,
					identicalCallStreak,
					repeatPenaltyOverride,
					excludedToolNames,
					excludedToolCooldowns: Object.fromEntries(excludedToolCooldowns),
				})
			}
			let assistant: ChatMessage
			try {
				let response: LlmResponse
				try {
					response = await this.callMainLlm(requestMessages, iteration, repeatPenaltyOverride, excludedToolNames)
				} catch (firstAttemptError) {
					if (!isRetryableOpenRouterError(firstAttemptError)) {
						throw firstAttemptError
					}
					this.logger.warn("[loop] main LLM call failed with a retryable provider error, retrying once", {
						iteration,
						error: firstAttemptError instanceof Error ? firstAttemptError.message : String(firstAttemptError),
					})
					await sleep(500)
					response = await this.callMainLlm(requestMessages, iteration, repeatPenaltyOverride, excludedToolNames)
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
						costUsd: this.config.trackCost ? budgetTracker.totalCostUsd : null,
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
					this.scheduleAux(() => this.writeLiveSnapshot(startedAt, iteration, budgetTracker.totalCostUsd))
			} catch (error) {
				// Live worker monitoring: surface the LLM call failure on the
				// event feed too (the session is ending with an error). The
				// assistant variable is unset here, so emit via raw fields.
				// (S2) Scheduled so it lands AFTER this iteration's earlier
				// queued events (iteration_start), not ahead of them.
				this.scheduleAux(() =>
					this.emitEvent(
						"llm_error",
						() =>
							this.eventFeed.emit("llm_error", {
								iteration,
								error: truncateField(error instanceof Error ? error.message : String(error)).text,
							}),
						{ iteration },
					),
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
				this.scheduleAux(() =>
					this.emitEvent(
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
					),
				)
			}

			// 5. Append the assistant message. Reasoning is echoed back on the
			// assistant history message (OpenRouter accepts it and providers
			// like native DeepSeek drop prior reasoning if it is not echoed on
			// assistant messages within tool-call turns — see api-docs.deepseek.com
			// /guides/thinking_mode). Harmless for providers that ignore it.
			const assistantMessage: ChatMessage = {
				role: "assistant",
				content: assistant.content ?? null,
				tool_calls: assistant.tool_calls,
				reasoning: assistant.reasoning,
			}
			messages.push(assistantMessage)
			// (T1) Keep reasoning only on the message just pushed — the
			// immediately-preceding assistant message for the NEXT request — and
			// strip it from every older assistant message (pure token cost;
			// DeepSeek only requires it on that one message).
			stripSupersededReasoning(messages)

			let calls = parseToolCalls(assistant)

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

			// 6a. SUCCESS via attempt_completion — only accepted when it is the
			// SOLE call this turn. A model (esp. a smaller/weaker local one) that
			// bundles attempt_completion together with real work calls in the
			// SAME turn — predicting its own writes will land rather than waiting
			// to see them actually happen — must NOT have those real calls
			// silently discarded by an early return here: that produces a
			// confidently-worded "success" report describing work that never
			// happened (observed live 2026-08-19 against Qwen2.5-Coder-14B: 7
			// tool calls in one turn, one of them attempt_completion, and the
			// other 6 — including the actual write_to_file calls — never ran).
			// Refuse the completion (same "refused, siblings still execute"
			// pattern as new_task/switch_mode above) instead, so the batch's
			// real work executes for real and the model's NEXT attempt_completion
			// is judged against actual tool results, not its own prediction.
			const completionCall = calls.find((call) => call.name === "attempt_completion")
			const refusedCompletionIds = new Set<string>()
			if (completionCall && calls.length > 1) {
				refusedCompletionIds.add(completionCall.id)
				this.logger.warn("[loop] attempt_completion refused — bundled with other tool calls this turn", {
					iteration,
					siblingCount: calls.length - 1,
				})
			} else if (completionCall) {
				const result =
					typeof completionCall.args?.result === "string"
						? completionCall.args.result
						: JSON.stringify(completionCall.args)

				// Verify-before-finishing guardrail (see
				// HeadlessSessionConfig.verifyBeforeCompletion's doc comment): the
				// most recent execute_command this session actually ran ended in
				// an error and nothing since has re-run it successfully — refuse
				// the completion (same "refused, siblings still execute" shape as
				// the commit guardrail below) instead of accepting a claim the
				// session's own last command result already contradicts.
				// Deliberately NOT a one-per-session nudge (unlike
				// completionNudged below): verified live 2026-08-20 against
				// Qwen3-14B that a one-shot budget lets a SECOND, later
				// fabricated completion through unchecked once the nudge is
				// spent — the model got nudged once after a failing tsc run,
				// made another failing edit_file (not execute_command) attempt,
				// then called attempt_completion again claiming "typecheck and
				// tests passed" while tsc was still genuinely broken (confirmed
				// by re-running it directly). This guardrail must keep refusing
				// every single time lastExecuteCommandFailed is true, however
				// many times that takes — a model that can't fix the failure
				// eventually hits maxIterations or the consecutive-mistake
				// bound from OTHER errors, which is the correct outcome, not a
				// false "success".
				//
				// unsupportedMeasurementClaim (#136): lastExecuteCommandFailed
				// only catches "the last command failed, you lied about
				// success" — it says nothing about a completion that invents
				// specific measurements (tokens/sec, percentages, "measured",
				// "benchmark") nobody actually produced. Verified live
				// 2026-08-21: a local session declared an infra POC
				// "successfully completed" with fabricated performance
				// numbers, having never run the command that would produce
				// them — the last command it DID run had succeeded, so this
				// guardrail never fired. Checked against every message in
				// history (not just the immediately preceding one), since the
				// evidence for a claim can legitimately come from several
				// tool calls back.
				const unsupportedMeasurementClaim =
					/\d+(\.\d+)?\s*(tokens?\/sec|t\/s|%|ms|seconds?)\b|measured|benchmark/i.test(result) &&
					!messages.some(
						(m) => m.role === "tool" && m.name === "execute_command" && /\d/.test(String(m.content ?? "")),
					)
				if (
					this.config.verifyBeforeCompletion &&
					(lastExecuteCommandFailed || lastWriteToolFailed || unsupportedMeasurementClaim)
				) {
					// Verified live 2026-08-29 (joeos issue #26, rounds 17 + 20):
					// the `continue` at the end of this block skips the
					// identical-call streak update below (it's part of the
					// normal per-iteration `calls` processing this branch
					// exits before reaching) — so lastCallBatchSignature/
					// lastCallBatchNames/identicalCallStreak stay FROZEN at
					// whatever they were when this deferral first started
					// firing (typically two identical execute_command
					// failures in a row, which is often exactly what triggers
					// the deferral in the first place). Every subsequent
					// deferred-completion turn then re-enters the SAME request
					// -prep cooldown-refresh loop above with identicalCall-
					// GuardActive still true and lastCallBatchNames still
					// ["execute_command"], re-arming that tool's exclusion to
					// the full cooldown value EVERY turn before it ever ticks
					// down — the model has no legal move (attempt_completion
					// deferred, execute_command excluded) and just keeps
					// re-calling attempt_completion, which is exactly the
					// input that keeps re-triggering this same `continue`
					// path. Confirmed live: 30+ iterations spinning between
					// "attempt_completion deferred" and an unchanging
					// "excludedToolCooldowns: {execute_command: 4}" until the
					// iteration cap was hit. Same failure class, same fix
					// pattern as the text-only-reply reset a few hundred lines
					// below (lastCallBatchSignature/lastCallBatchNames/
					// identicalCallStreak = null/[]/0) — that reset just never
					// covered this exit path. A deferred completion is
					// definitionally not a repeat of whatever tool-call batch
					// came before it, so the guard has no reason to stay
					// active into the next turn.
					lastCallBatchSignature = null
					lastCallBatchNames = []
					identicalCallStreak = 0
					identicalCallNudgeInjected = false
					excludedToolCooldowns.delete("execute_command")
					const reason = unsupportedMeasurementClaim
						? "unsupported measurement claim"
						: lastExecuteCommandFailed
							? "last execute_command failed"
							: "last edit_file/write_to_file failed"
					for (const sibling of calls) {
						if (sibling.id === completionCall.id) {
							continue
						}
						messages.push({
							role: "tool",
							tool_call_id: sibling.id,
							name: sibling.name,
							content: unsupportedMeasurementClaim
								? "[System: not executed — attempt_completion was deferred because it makes a specific measurement/benchmark claim with no execute_command output in this session's history containing any supporting number; re-issue this call if still needed.]"
								: lastExecuteCommandFailed
									? "[System: not executed — attempt_completion was deferred because the last command you ran ended in an error; re-issue this call if still needed.]"
									: "[System: not executed — attempt_completion was deferred because your last edit_file/write_to_file call failed; re-issue this call if still needed.]",
						})
					}
					messages.push({
						role: "tool",
						tool_call_id: completionCall.id,
						name: "attempt_completion",
						content: unsupportedMeasurementClaim
							? "[System: attempt_completion was NOT accepted. Your result claims a specific measurement/benchmark, but no execute_command output anywhere in this session contains a supporting number. Either run the real command that produces this evidence and re-issue attempt_completion, or restate the result without the unsupported claim.]"
							: lastExecuteCommandFailed
								? "[System: attempt_completion was NOT accepted. The most recent command you ran ended in an error, and you have not run a command since that succeeded:\n" +
									`${lastExecuteCommandSummary ?? "(command output no longer available)"}\n` +
									"Fix the issue, re-run the exact command above, and only call attempt_completion again once it actually passes.]"
								: "[System: attempt_completion was NOT accepted. Your result describes a change as made, but your most recent edit_file/write_to_file call failed and you have not successfully edited anything since:\n" +
									`${lastWriteToolSummary ?? "(edit output no longer available)"}\n` +
									"Fix the issue, make the edit succeed, and only call attempt_completion again once it actually applied.]",
					})
					this.logger.warn("[loop] attempt_completion deferred", { iteration, reason })
					continue
				}

				// requireArtifactBeforeCompletion guardrail (issue #143) — see
				// HeadlessSessionConfig.requireArtifactBeforeCompletion's doc
				// comment for why this is a separate opt-in flag rather than
				// folded into verifyBeforeCompletion above.
				if (this.config.requireArtifactBeforeCompletion && !hasCalledArtifactTool) {
					for (const sibling of calls) {
						if (sibling.id === completionCall.id) {
							continue
						}
						messages.push({
							role: "tool",
							tool_call_id: sibling.id,
							name: sibling.name,
							content:
								"[System: not executed — attempt_completion was deferred because this session has not yet made any real change (no execute_command, write_to_file, or edit_file call); re-issue this call if still needed.]",
						})
					}
					messages.push({
						role: "tool",
						tool_call_id: completionCall.id,
						name: "attempt_completion",
						content:
							"[System: attempt_completion was NOT accepted. This task requires producing a real, verifiable artifact or side effect, but this session has not yet called execute_command, write_to_file, or edit_file even once. Take a real action (e.g. run the command, write the file) before calling attempt_completion again — do not describe work as done that you have not actually performed.]",
					})
					this.logger.warn("[loop] attempt_completion deferred", {
						iteration,
						reason: "no artifact-producing tool call in this session",
					})
					continue
				}

				// requireArtifactPathPattern / requireArtifactMinCitations
				// guardrail (research-harness primitive) — see
				// HeadlessSessionConfig's doc comments. Checks the real
				// filesystem, not tool-call bookkeeping, so a session that
				// wrote SOMETHING but not the actual expected deliverable (or
				// wrote a contentless stub) still gets refused.
				if (this.config.requireArtifactPathPattern !== undefined) {
					const artifactStatus = await matchingArtifactFileStatus(
						this.config.workspaceRoot,
						this.config.requireArtifactPathPattern,
					)
					const minCitations = this.config.requireArtifactMinCitations ?? 0
					const missingReason = !artifactStatus.found
						? `no file matching '${this.config.requireArtifactPathPattern}' exists yet`
						: artifactStatus.citationCount < minCitations
							? `the file matching '${this.config.requireArtifactPathPattern}' only contains ${artifactStatus.citationCount} real file:line citation(s), fewer than the required ${minCitations}`
							: undefined
					if (missingReason !== undefined) {
						for (const sibling of calls) {
							if (sibling.id === completionCall.id) {
								continue
							}
							messages.push({
								role: "tool",
								tool_call_id: sibling.id,
								name: sibling.name,
								content: `[System: not executed — attempt_completion was deferred because ${missingReason}; re-issue this call if still needed.]`,
							})
						}
						messages.push({
							role: "tool",
							tool_call_id: completionCall.id,
							name: "attempt_completion",
							content: !artifactStatus.found
								? `[System: attempt_completion was NOT accepted. This task requires producing a real file matching '${this.config.requireArtifactPathPattern}', and no such file exists on disk yet. Use write_to_file to actually create it with real content before calling attempt_completion again — analysis alone does not satisfy this task.]`
								: `[System: attempt_completion was NOT accepted. ${missingReason}. Your NEXT tool call must be edit_file on '${artifactStatus.relativePath}' (the file that already exists — do not read more code first, you already have enough; do not call write_to_file, that would discard what you already wrote). Add at least ${minCitations - artifactStatus.citationCount} line(s) of the exact literal form 'path/to/file.ts:123' (a real file path you already read, a colon, a real line number) into that file's existing content, each backing a specific claim already in the doc.]`,
						})
						this.logger.warn("[loop] attempt_completion deferred", {
							iteration,
							reason: !artifactStatus.found ? "no file matching requireArtifactPathPattern" : "below requireArtifactMinCitations",
						})
						// Artifact-gate rejection guardrail (issue #152): only the
						// "file exists but citations are insufficient" case counts —
						// "no file yet" isn't a patch-without-re-reading situation,
						// there's nothing to have patched yet.
						if (artifactStatus.found) {
							artifactRejectionStreak++
							if (
								artifactRejectionStreak >= envArtifactRejectionNudgeThreshold() &&
								!artifactRejectionNudgeInjected
							) {
								artifactRejectionNudgeInjected = true
								messages.push({
									role: "user",
									content: artifactRejectionNudgeMessage(artifactRejectionStreak, artifactStatus.relativePath ?? this.config.requireArtifactPathPattern ?? ""),
								})
								this.logger.warn("[loop] artifact-rejection nudge injected", {
									iteration,
									streak: artifactRejectionStreak,
									reason: "below requireArtifactMinCitations",
								})
							}
						}
						continue
					}

					// requireArtifactSections: citations alone don't guarantee the
					// doc actually commits to a scoped proposal rather than a
					// general survey (live-verified 2026-08-21 — see doc comment).
					const requiredSections = this.config.requireArtifactSections ?? []
					const content = artifactStatus.content ?? ""
					const missingSections = requiredSections.filter(
						(section) => !content.toLowerCase().includes(section.toLowerCase()),
					)
					if (requiredSections.length > 0 && missingSections.length > 0) {
						for (const sibling of calls) {
							if (sibling.id === completionCall.id) {
								continue
							}
							messages.push({
								role: "tool",
								tool_call_id: sibling.id,
								name: sibling.name,
								content: `[System: not executed — attempt_completion was deferred because '${artifactStatus.relativePath}' is missing required section(s): ${missingSections.join(", ")}; re-issue this call if still needed.]`,
							})
						}
						messages.push({
							role: "tool",
							tool_call_id: completionCall.id,
							name: "attempt_completion",
							content: `[System: attempt_completion was NOT accepted. '${artifactStatus.relativePath}' exists and has citations, but is missing required section(s): ${missingSections.join(", ")}. This document must be a scoped, actionable proposal, not a general survey — your NEXT tool call must be edit_file on '${artifactStatus.relativePath}' to add each missing section with real, specific content (not a placeholder heading).]`,
						})
						this.logger.warn("[loop] attempt_completion deferred", {
							iteration,
							reason: "missing required artifact sections",
							missingSections,
						})
						// Artifact-gate rejection guardrail (issue #152) — same
						// pattern as the requireArtifactMinCitations site above:
						// adding a missing heading without re-verifying the section
						// actually contains what was asked is the exact exploit this
						// guards against.
						artifactRejectionStreak++
						if (
							artifactRejectionStreak >= envArtifactRejectionNudgeThreshold() &&
							!artifactRejectionNudgeInjected
						) {
							artifactRejectionNudgeInjected = true
							messages.push({
								role: "user",
								content: artifactRejectionNudgeMessage(artifactRejectionStreak, artifactStatus.relativePath ?? this.config.requireArtifactPathPattern ?? ""),
							})
							this.logger.warn("[loop] artifact-rejection nudge injected", {
								iteration,
								streak: artifactRejectionStreak,
								reason: "missing required artifact sections",
							})
						}
						continue
					}
				}

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
					(await hasUncommittedTrackedChanges(
						this.config.workspaceRoot,
						this.sessionWrittenPaths,
					))
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

				// Evidence-gated completion (fabrication fix, 2026-09-01 — see
				// src/engine/claims.ts's module doc for the full writeup): when
				// evidenceRequiredCompletion is on, every machine-checkable claim
				// in the completion's result text (a file exists, a specific
				// command passed, serial markers appear, a PR exists) must be
				// independently verified against ground truth — the filesystem,
				// a real re-run of the exact command, the newest serial log, and
				// real git history — BEFORE the completion is accepted. This is
				// the structural backstop for the FINAL_REPORT's central finding:
				// a session claimed "all three hard gates pass" with a fabricated
				// serial-log excerpt when the driver was never merged and the
				// claimed Makefile target didn't exist. Fail-closed: any
				// unverifiable claim defers the completion with a corrective
				// message naming the specific claim, and emits an
				// `unverified_claim` feed event so downstream consumers (eval,
				// selfplay miner, orchestrator) can see WHY the completion was
				// not accepted. A result with NO machine-checkable claims (pure
				// prose) does not gate — but it also can never *pass* a gate.
				this.lastCompletionVerification = undefined
				if (this.config.evidenceRequiredCompletion) {
					const claims = extractClaims(result)
					if (claims.length > 0) {
						const verification = await verifyClaims(claims, {
							workspaceRoot: this.config.workspaceRoot,
							permissions: this.executor.permissions,
						})
						this.lastCompletionVerification = {
							claimsChecked: claims.length,
							claimsPassed: verification.filter((v) => v.verified).length,
							claimsUnverified: verification.filter((v) => !v.verified).length,
						}
						if (!allClaimsVerified(verification)) {
							// Identical-call guardrail reset — the same live
							// failure the verifyBeforeCompletion deferral above
							// documents (joeos issue #26, rounds 17 + 20): the
							// `continue` at the end of this block skips the
							// identical-call streak update below (it's part of
							// the normal per-iteration `calls` processing this
							// branch exits before reaching), so without this
							// reset lastCallBatchSignature/lastCallBatchNames/
							// identicalCallStreak stay FROZEN at whatever they
							// were when this deferral first started firing —
							// typically two identical execute_command failures
							// in a row, which is often exactly what triggers a
							// fabricated-completion deferral in the first
							// place (a model re-calling the same failing gate).
							// Every subsequent deferred-completion turn then
							// re-enters the request-prep cooldown-refresh loop
							// with identicalCallGuardActive still true and
							// lastCallBatchNames still ["execute_command"],
							// re-arming that tool's exclusion to the full
							// cooldown value EVERY turn before it ever ticks
							// down — the model has no legal move
							// (attempt_completion deferred, execute_command
							// excluded) and just keeps re-calling
							// attempt_completion, which is exactly the input
							// that keeps re-triggering this same `continue`
							// path. Confirmed live: 30+ iterations spinning
							// between "attempt_completion deferred" and an
							// unchanging "excludedToolCooldowns:
							// {execute_command: 4}" until the iteration cap was
							// hit. A deferred completion is definitionally not
							// a repeat of whatever tool-call batch came before
							// it, so the guard has no reason to stay active
							// into the next turn.
							lastCallBatchSignature = null
							lastCallBatchNames = []
							identicalCallStreak = 0
							identicalCallNudgeInjected = false
							excludedToolCooldowns.delete("execute_command")
							const firstBad = verification.find((v) => !v.verified)
							const unverifiedLabels = verification
								.filter((v) => !v.verified)
								.map((v) => claimLabel(v.claim))
								.join(", ")
							for (const sibling of calls) {
								if (sibling.id === completionCall.id) {
									continue
								}
								messages.push({
									role: "tool",
									tool_call_id: sibling.id,
									name: sibling.name,
									content:
										"[System: not executed — attempt_completion was deferred because your result makes claims that could not be verified against the real workspace; re-issue this call if still needed.]",
								})
							}
							messages.push({
								role: "tool",
								tool_call_id: completionCall.id,
								name: "attempt_completion",
								content:
									"[System: attempt_completion was NOT accepted. Your result claims: " +
									`${unverifiedLabels}. None of these could be independently confirmed: ` +
									`${firstBad?.detail ?? "no evidence found"}. ` +
									"Ground truth comes from the real filesystem and real command re-runs — never from a written report. " +
									"Either run/verify the real thing (re-run the exact command, confirm the file actually exists on disk, check the real serial log) and re-issue attempt_completion, " +
									"or restate the result to only claim what you have actually verified.]",
							})
							this.logger.warn("[loop] attempt_completion deferred — unverifiable claims in result", {
								iteration,
								claims,
								verification: verification.map((v) => ({ verified: v.verified, detail: v.detail })),
							})
							this.scheduleAux(() =>
								this.emitEvent(
									"unverified_claim",
									() =>
										this.eventFeed.unverifiedClaim({
											iteration,
											claimsChecked: this.lastCompletionVerification?.claimsChecked ?? 0,
											claimsPassed: this.lastCompletionVerification?.claimsPassed ?? 0,
											claimsUnverified: this.lastCompletionVerification?.claimsUnverified ?? 0,
											detail: firstBad?.detail ?? "",
										}),
									{ iteration },
								),
							)
							continue
						}
					}
				}

				this.logger.info("[loop] attempt_completion received — success", { iteration })
				const reportPath = await this.persistFinalReport(iteration, result)
				return {
					status: "success",
					result,
					iterations: iteration,
					toolCalls: toolCalls + 1,
					reportPath,
					verification: this.lastCompletionVerification,
				}
			}

			// 6b. Text-only reply (no tool_calls) → pragmatic success fallback,
			// UNLESS requireExplicitCompletion is set (see the config doc
			// comment): a model that gives up and dumps prose instead of
			// retrying or calling attempt_completion must not be recorded as
			// a successful session.
			if (calls.length === 0) {
				let text = (assistant.content ?? "").trim()
				// Set below when the model's text-embedded tool call named a real
				// tool that's currently excluded by the identical-call cooldown —
				// see the nudge-message branch further down for why this matters.
				let blockedToolName: string | null = null

				// See DAEMON_EMPTY_REPLY_FALLBACK_TEXTS's doc comment: this
				// is the backend's own synthetic diagnostic string, not something
				// the model said. Treat it exactly like no text at all — persisting
				// it into history (assistantMessage.content, mutated below since
				// the object was already pushed) would feed the model its own fake
				// prior "reply" next turn and risk the self-reinforcing empty-reply
				// loop this was caught causing live.
				if (DAEMON_EMPTY_REPLY_FALLBACK_TEXTS.includes(text)) {
					text = ""
					assistantMessage.content = null
				}

				// A local model can reason correctly about which tool to call
				// and then write the call as prose instead of using the native
				// tool-calling channel (observed live against Qwen2.5-Coder-14B —
				// see extractEmbeddedToolCall's doc comment). Only ever treated
				// as a real call when its name matches a tool actually in this
				// session's catalog — an arbitrary JSON-shaped blob in ordinary
				// prose must not be able to trigger tool execution.
				if (text && this.config.requireExplicitCompletion) {
					const embedded = extractEmbeddedToolCall(text)
					// Validate against the tools actually OFFERED on the request that
					// just ran, not the session's full default catalog. Without this,
					// the identical-call guardrail's tool exclusion (see callMainLlm's
					// doc comment) is fully circumventable: llama.cpp's grammar
					// constraint correctly refuses to emit a genuine tool_calls entry
					// for an excluded tool, but the model can still narrate the SAME
					// call as prose instead — verified live 2026-08-20, list_files
					// still executed via this exact recovery path on a request where
					// its schema had been excluded, because this check was reading
					// the unfiltered session catalog.
					const excludedThisTurn = new Set(excludedToolNames ?? [])
					const isRealTool =
						embedded &&
						!excludedThisTurn.has(embedded.name) &&
						this.state.tools.some((t) => t.type === "function" && t.function.name === embedded.name)
					// The model correctly picked a real tool but it's on cooldown
					// (see callMainLlm's excludedToolNames doc comment) — the block
					// itself is intentional (verified 2026-08-20 it must not be
					// circumventable via text), but the model was previously given
					// no explanation why its call "failed", just a generic "call a
					// tool" nudge — so it kept re-emitting the SAME excluded call
					// every turn for the whole cooldown window, burning consecutive-
					// mistake budget on retries it couldn't have known were futile.
					// Verified live 2026-08-21: execute_command excluded for 4 turns
					// after 2 near-duplicate retries (one a legitimate retry after a
					// real build error, not a true loop) drove 4 straight "mistake"
					// turns this way alone. Naming the blocked tool and its cooldown
					// lets the model choose something else instead of guessing blind.
					if (embedded && !isRealTool && excludedThisTurn.has(embedded.name)) {
						blockedToolName = embedded.name
					}
					if (embedded && isRealTool) {
						this.logger.warn("[loop] recovered tool call written as text instead of tool_calls", {
							iteration,
							tool: embedded.name,
							textLength: text.length,
						})
						assistantMessage.tool_calls = [
							{
								id: embedded.id,
								type: "function",
								function: { name: embedded.name, arguments: embedded.rawArguments },
							},
						]
						// Clear the raw prose from the PERSISTED history message — a
						// local model writing a tool call as text was observed live
						// (2026-08-20) narrating an entire fake exchange around it
						// ("[Called tool X]... [Result of X]: <plausible-looking fake
						// tool output>"), sometimes thousands of characters. Left in
						// history verbatim, this self-narrated blob — an assistant
						// message shaped unlike anything in real training data —
						// reliably preceded a generation hang on the NEXT request in
						// every reproduction. A real tool-call message has no
						// meaningful content alongside tool_calls (see the `content:
						// 0`-length pattern on every genuine tool-call turn); this
						// recovered one now matches that shape instead of keeping the
						// hallucinated narration.
						assistantMessage.content = null
						calls = [embedded]
					}
				}

				if (calls.length === 0) {
					// Identical-consecutive-call guardrail state (identicalCallStreak,
					// lastCallBatchSignature/Names) only ever updates inside the
					// `calls.length > 0` branch below — a genuine text-only/empty
					// reply skips it entirely, so without this reset the streak
					// (and therefore the repeat_penalty boost + tool exclusion it
					// drives — see callMainLlm) stays frozen at whatever it was and
					// keeps applying to every subsequent request indefinitely, long
					// after the model has stopped making the repeated call at all.
					// Verified live 2026-08-20: this produced a run of consecutive
					// genuinely-EMPTY generations (zero tokens, the daemon's own
					// "The model produced an empty reply" fallback) immediately
					// after tool exclusion kicked in — the elevated penalty + a
					// missing tool, still applied turn after turn with no new
					// repeat ever having occurred, is a plausible degenerate
					// sampling combination. A text-only reply is definitionally not
					// a repeat of the previous tool-call batch, so the guard has no
					// reason to still be active.
					lastCallBatchSignature = null
					lastCallBatchNames = []
					identicalCallStreak = 0
					identicalCallNudgeInjected = false
					toolFailureStreakName = undefined
					toolFailureStreakCount = 0
					toolFailureStreakTargetPath = undefined
					toolFailureNudgeInjected = false
					artifactRejectionStreak = 0
					artifactRejectionNudgeInjected = false
					if (text && !this.config.requireExplicitCompletion) {
						// Evidence-gated completion (fabrication fix, 2026-09-01)
						// — the text-only success fallback is a REAL bypass for
						// cloud sessions: requireExplicitCompletion defaults OFF
						// for the cloud backend, so with --require-evidence a
						// cloud model could dump prose ("all three hard gates
						// pass…") and be recorded as success with ZERO
						// evidence, exactly the fabrication shape the gate
						// exists to stop. When evidenceRequiredCompletion is
						// ON, a text-only reply is treated as a completion
						// CANDIDATE and runs the SAME extract/verify gate as an
						// attempt_completion: pure prose (no machine-checkable
						// claims) or fully-verified claims are accepted; any
						// unverifiable claim defers with the corrective nudge
						// and an unverified_claim event, never a success.
						this.lastCompletionVerification = undefined
						if (this.config.evidenceRequiredCompletion) {
							const claims = extractClaims(text)
							if (claims.length > 0) {
								const verification = await verifyClaims(claims, {
									workspaceRoot: this.config.workspaceRoot,
									permissions: this.executor.permissions,
								})
								this.lastCompletionVerification = {
									claimsChecked: claims.length,
									claimsPassed: verification.filter((v) => v.verified).length,
									claimsUnverified: verification.filter((v) => !v.verified).length,
								}
								if (!allClaimsVerified(verification)) {
									// Same identical-call guardrail reset as the
									// attempt_completion deferral above — a text-only
									// reply is definitionally not a repeat of the
									// previous tool-call batch.
									lastCallBatchSignature = null
									lastCallBatchNames = []
									identicalCallStreak = 0
									identicalCallNudgeInjected = false
									excludedToolCooldowns.delete("execute_command")
									const firstBad = verification.find((v) => !v.verified)
									const unverifiedLabels = verification
										.filter((v) => !v.verified)
										.map((v) => claimLabel(v.claim))
										.join(", ")
									messages.push({
										role: "user",
										content:
											`[System: your text-only reply was NOT accepted as a completion. It claims: ${unverifiedLabels}. ` +
											`None of these could be independently confirmed: ${firstBad?.detail ?? "no evidence found"}. ` +
											"Ground truth comes from the real filesystem and real command re-runs — never from a written report. " +
											"Either run/verify the real thing (re-run the exact command, confirm the file actually exists on disk, check the real serial log) and then call attempt_completion, " +
											"or restate your answer to only claim what you have actually verified.]",
									})
									this.logger.warn("[loop] text-only reply NOT accepted — unverifiable claims", {
										iteration,
										claims,
										verification: verification.map((v) => ({
											verified: v.verified,
											detail: v.detail,
										})),
									})
									this.scheduleAux(() =>
										this.emitEvent(
											"unverified_claim",
											() =>
												this.eventFeed.unverifiedClaim({
													iteration,
													claimsChecked: this.lastCompletionVerification?.claimsChecked ?? 0,
													claimsPassed: this.lastCompletionVerification?.claimsPassed ?? 0,
													claimsUnverified: this.lastCompletionVerification?.claimsUnverified ?? 0,
													detail: firstBad?.detail ?? "",
												}),
											{ iteration },
										),
									)
									continue
								}
							}
						}
						this.logger.info("[loop] text-only reply (no tool calls) — success", { iteration })
						const reportPath = await this.persistFinalReport(iteration, text)
						return {
							status: "success",
							result: text,
							iterations: iteration,
							toolCalls,
							reportPath,
							...(this.lastCompletionVerification ? { verification: this.lastCompletionVerification } : {}),
						}
					}
					// Empty reply, or a text reply that requireExplicitCompletion
					// refuses to treat as final: nudge and count as a mistake.
					consecutiveMistakes++
					// The mistake count is appended to the nudge text itself (see
					// DAEMON_EMPTY_REPLY_FALLBACK_TEXTS's doc comment for the
					// full mechanism this guards against): clearing the fake fallback
					// content alone was NOT enough to prevent a byte-for-byte-
					// identical, self-reinforcing prompt — the nudge text itself was
					// just as static, and truncateHistory evicting/re-adding a fixed-
					// size pair every cycle reproduces the exact same trap regardless
					// of what the persisted content specifically is. Verified live
					// 2026-08-20 (trial 41): even after the empty-reply fallback
					// fix, the rendered prompt was STILL byte-
					// identical across consecutive requests. Varying the nudge text
					// structurally prevents the trap from re-forming, independent of
					// whatever is causing the model to produce nothing in the first
					// place.
					messages.push({
						role: "user",
						content: blockedToolName
							? `[System: "${blockedToolName}" is temporarily unavailable (attempt ${consecutiveMistakes}) — it was excluded for a few turns after repeated identical calls. Use a different tool now, or wait; it will become available again on its own. Retrying the same call will not work until then.]`
							: text
								? `[System: a text reply alone does not end the session (attempt ${consecutiveMistakes}). Continue working: call a tool, or provide your final answer via attempt_completion.]`
								: `[System: your last response contained no tool calls and no text (attempt ${consecutiveMistakes}). Continue working: call a tool or provide your final answer via attempt_completion.]`,
					})
					this.logger.warn("[loop] non-completing reply counted as mistake", {
						consecutiveMistakes,
						hadText: Boolean(text),
						textPreview: text.slice(0, 300),
					})
					if (consecutiveMistakes >= consecutiveErrorLimit) {
						return this.boundedFailure("consecutive empty replies", iteration, toolCalls, consecutiveMistakes)
					}
					continue
				}
				// calls.length > 0 here means a text-embedded call was recovered
				// above — fall through to step 7 to execute it for real.
			}

			// 7. Execute each tool call, feeding results back as `tool` messages.
			// Same-file multi-edit diagnosis: paths already successfully
			// modified by an EARLIER call in THIS batch (scoped per assistant
			// turn — the executor re-reads the file per call, so the failure
			// mechanism is stale SEARCH text, not a stale executor).
			const batchEditedPaths = new Map<string, string>()

			// (S3) Partition this turn's calls: pure read-only/exploration calls
			// (read_file/list_files/search_files, the TS code-intel reads, and a
			// read-only-equivalent execute_command) run CONCURRENTLY — no shared
			// mutable state — while everything else stays serialized in
			// submission order: any edit-capable call (editToolTargetPath),
			// switch_mode / ask_followup_question / new_task (the single
			// decision-marker protocol), and anything ambiguous. A read_file
			// whose path collides with a file an edit in this turn modifies is
			// ALSO serial (see isParallelReadOnlyCall).
			const editedPaths = new Set<string>()
			for (const call of calls) {
				const target = editToolTargetPath(this.config.workspaceRoot, call)
				if (target !== undefined) {
					editedPaths.add(target)
				}
			}
			const parallelGroup: Array<{ call: ParsedToolCall; index: number }> = []
			const serialGroup: Array<{ call: ParsedToolCall; index: number }> = []
			calls.forEach((call, index) => {
				if (isParallelReadOnlyCall(this.config.workspaceRoot, call, editedPaths)) {
					parallelGroup.push({ call, index })
				} else {
					serialGroup.push({ call, index })
				}
			})

			// Live worker monitoring: schedule the tool_call events for the whole
			// turn in assistant.tool_calls order (a truncated argument summary —
			// the path for file tools, the command for execute_command — never
			// full content), so the ordering guard keeps them ahead of the
			// tool_result events. Non-fatal.
			for (const call of calls) {
				const argSummary = summarizeToolArg(call.name, call.args) ?? ""
				const truncated = argSummary.length > EVENT_TRUNCATE_CHARS
				this.scheduleAux(() =>
					this.emitEvent(
						"tool_call",
						() =>
							this.eventFeed.toolCall({
								iteration,
								tool: call.name,
								args: truncated ? argSummary.slice(0, EVENT_TRUNCATE_CHARS) : argSummary,
								argsTruncated: truncated,
							}),
						{ iteration },
					),
				)
			}

			// Execution outcomes keyed by the call's ORIGINAL position, so the
			// post-pass below feeds results back — tool messages, diagnosis,
			// mistake accounting — in assistant.tool_calls order regardless of
			// execution order.
			const executed = new Map<number, { resultContent: string; isError: boolean }>()
			const runCall = async (call: ParsedToolCall, index: number): Promise<void> => {
				let resultContent: string
				let isError: boolean
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
				} else if (refusedCompletionIds.has(call.id)) {
					// attempt_completion was bundled with other tool calls this
					// turn — refuse it WITHOUT executing it so the real work
					// siblings below execute for real (see the refusal-set
					// construction above); the model must re-check actual results
					// before declaring done again.
					resultContent =
						"[Error] attempt_completion was not accepted: it was called alongside other tool calls in the same turn, so it was refused and your other calls ran for real instead — check their results below (including any errors) before deciding the task is actually done. Re-issue attempt_completion ALONE, as the only tool call in its own turn, once you've verified the real outcome."
					isError = true
				} else {
					const result = await this.executor.execute(call.name, call.args)
					resultContent = result.content
					isError = result.isError
				}
				executed.set(index, { resultContent, isError })
			}

			// Parallel wave: the turn's independent read-only/exploration calls
			// run concurrently (the S3 win — reads share no mutable state).
			// Serial calls still execute at their exact submission position in
			// the post-pass below, so an early mistake-limit abort never runs an
			// edit the serial loop would have skipped.
			await Promise.all(parallelGroup.map(({ call, index }) => runCall(call, index)))

			// Feed results back + bookkeeping in ORIGINAL tool_calls order: the
			// assistant→tool adjacency contract, same-file diagnosis,
			// batchEditedPaths, switch marker, pause checks, and mistake
			// accounting all behave exactly as in the serial loop.
			for (let i = 0; i < calls.length; i++) {
				const call = calls[i]
				toolCalls++
				if (!executed.has(i)) {
					// Serial call: execute at its submission position.
					await runCall(call, i)
				}
				const outcome = executed.get(i)
				if (outcome === undefined) {
					// Unreachable: runCall always records its outcome before resolving.
					throw new Error(`[loop] internal: no execution outcome for '${call.name}'`)
				}
				let { resultContent, isError } = outcome
				if (
					call.name === "execute_command" ||
					call.name === "write_to_file" ||
					call.name === "edit_file" ||
					// set_indentation (issue #141) genuinely writes to the
					// workspace, same as edit_file — live-verified 2026-08-21
					// that omitting it here left a session unable to ever
					// satisfy requireArtifactBeforeCompletion after a
					// successful, file-changing set_indentation call, looping
					// on "no artifact-producing tool call" until the
					// iteration cap.
					call.name === "set_indentation"
				) {
					hasCalledArtifactTool = true
				}
				if (call.name === "execute_command") {
					lastExecuteCommandFailed = isError
					if (isError) {
						const command = summarizeToolArg(call.name, call.args) ?? "(unknown command)"
						const output =
							typeof resultContent === "string"
								? resultContent.slice(0, 500)
								: JSON.stringify(resultContent).slice(0, 500)
						lastExecuteCommandSummary = `${command}\n${output}`
					} else {
						lastExecuteCommandSummary = undefined
					}
				}
				// Issue found live 2026-08-21 (round 4 of the full-cycle demo):
				// a session's last several real tool calls before
				// attempt_completion were 4 straight FAILED edit_file calls
				// (never a successful one), yet it claimed "I've implemented
				// the optimization" — verifyBeforeCompletion didn't catch it
				// because lastExecuteCommandFailed only tracks execute_command,
				// and edit_file/write_to_file failures were invisible to it.
				// Same shape as the execute_command case above, tracked
				// separately since a failed edit and a failed command are
				// different evidence for the rejection message below.
				if (call.name === "edit_file" || call.name === "write_to_file" || call.name === "set_indentation") {
					lastWriteToolFailed = isError
					if (isError) {
						const target = summarizeToolArg(call.name, call.args) ?? "(unknown target)"
						const output =
							typeof resultContent === "string"
								? resultContent.slice(0, 500)
								: JSON.stringify(resultContent).slice(0, 500)
						lastWriteToolSummary = `${call.name} ${target}\n${output}`
					} else {
						lastWriteToolSummary = undefined
					}
				}
				const targetPath = editToolTargetPath(this.config.workspaceRoot, call)
				const previouslyEditedBy = targetPath === undefined ? undefined : batchEditedPaths.get(targetPath)

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
					this.sessionWrittenPaths.add(targetPath)
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

				// Pause/resume (dashboard control): after tool execution is still
				// a safe boundary (never mid-tool-call, never mid-LLM-call) and
				// makes a pause request responsive even when the LLM is fast
				// enough to run many iterations between the pre-iteration checks.
				// A request that lands during a tool call is honored as soon as
				// that call (and its parallel siblings) settle.
				await this.checkPauseRequested(budgetTracker)

				this.logger.info(`[loop] tool result: ${call.name}`, {
					isError,
					toolCalls,
					arg: summarizeToolArg(call.name, call.args),
				})
				// Live worker monitoring: emit the tool_result event (a
				// truncated preview — never the full result). Non-fatal.
				this.scheduleAux(() =>
					this.emitEvent(
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
					),
				)

				// Consecutive-mistake accounting: errors, parse failures, empty
				// results, and identical repeated calls all count.
				const signature = `${call.name}|${JSON.stringify(call.args)}`
				const isRepeat = signature === lastCallSignature
				lastCallSignature = signature

				// 2026-08-27: `execute_command`'s own spawn-ENOENT retry (see
				// executor.ts's isBashSpawnEnoent/MAX_SPAWN_ATTEMPTS) already
				// exhausted up to ~14s of escalating-backoff retries before this
				// result ever reached the loop — verified live it can still fail
				// after the FULL retry budget, so this is not a rare edge case
				// the retry alone resolves. Whatever is causing it, it is
				// unambiguously an infrastructure condition (the exact same
				// benign command — `git log`, `pwd` — reproduces cleanly outside
				// this process every time), not a model mistake, and the model
				// has no way to avoid or fix it by behaving differently. Counting
				// it against the mistake budget punishes the model for something
				// entirely outside its control and was observed live burning
				// through an otherwise-healthy review session's entire budget on
				// pure infrastructure noise. Excluded from mistake accounting
				// here (a genuine model mistake immediately afterward still
				// counts normally) rather than silently retried again — the
				// model still needs to see the failure and retry the command
				// itself, just without it costing anything.
				// Two message shapes reach here for the same underlying spawn
				// failure, depending on which Node event fired last before the
				// retry budget in executor.ts's spawnAttempt was exhausted: the
				// `error`-event shape ("spawn error for '...': spawn /bin/bash
				// ENOENT") and the negative-close-code shape ("command '...'
				// exited with code -2.", where -2 is -ENOENT). Both are covered.
				const isInfrastructureSpawnFailure =
					isError &&
					(/spawn error for '.*': spawn \S*bash ENOENT/.test(resultContent) ||
						/exited with code -\d+\./.test(resultContent))

				const isMistake =
					!isInfrastructureSpawnFailure &&
					(isError || call.parseError !== undefined || resultContent.trim() === "" || isRepeat)

				if (isInfrastructureSpawnFailure) {
					this.logger.warn("[loop] infrastructure spawn failure — not counted as a mistake", {
						tool: call.name,
					})
				} else if (isMistake) {
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
			// with no edit, test run, or completion, inject a soft user-role
			// nudge. One nudge per streak; any non-read-only tool resets the
			// streak. When the streak crosses the hard stall limit, terminate
			// with a bounded failure — a session that read-only for this long
			// without producing anything is stuck, and letting it burn the
			// whole iteration budget buys nothing (live round w3, issue #103,
			// 2026-08-16: ~200 pure grep iterations replacing one run_tests
			// call). The nudge fires in BOTH indexed and unindexed workspaces —
			// the message just points at codebase_search only where one exists
			// (in an unindexed workspace there is nothing better than walking
			// the tree, so the nudge leads with "make progress / run tests").
			// Soft + reversible — a later productive call resets everything;
			// the stall termination is the only hard stop.
			// Whether every call in this turn is a plain read/exploration call
			// (list_files / read_file / search_files, or a read-only-equivalent
			// execute_command). Shared by the blind-tree-walking nudge above and
			// the read-only checkpoint skip below.
			const allReadOnly =
				calls.length > 0 &&
				calls.every(
					(call) =>
						READ_ONLY_TOOL_NAMES.has(call.name) ||
						(call.name === "execute_command" &&
							typeof call.args.command === "string" &&
							isReadOnlyEquivalentShellCommand(call.args.command)),
				)
			if (calls.length > 0) {
				if (allReadOnly) {
					readOnlyStreak++
					if (readOnlyStreak >= readOnlyNudgeThreshold && !readOnlyNudgeInjected) {
						readOnlyNudgeInjected = true
						const message = (await hasCodebaseIndex(this.config.workspaceRoot))
							? READ_ONLY_NUDGE_MESSAGE
							: READ_ONLY_PROGRESS_NUDGE_MESSAGE
						messages.push({ role: "user", content: message })
						this.logger.warn("[loop] blind tree-walking nudge injected", { readOnlyStreak })
					}
					if (readOnlyStreak >= readOnlyStallLimit) {
						await this.saveIterationCheckpoint(iteration)
						return this.boundedFailure("read-only stagnation", iteration, toolCalls, readOnlyStreak, readOnlyStallLimit)
					}
				} else {
					// Any non-read-only call (edit, codebase_search, code-intel,
					// execute_command, …) breaks the blind-walk pattern.
					readOnlyStreak = 0
					readOnlyNudgeInjected = false
				}

				// Identical-consecutive-call guardrail (see
				// DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD's doc comment) — runs
				// independently of the read-only-only check above: it must catch a
				// repeated WRITE call (e.g. the same failing apply_diff) just as
				// readily as a repeated read.
				const callBatchSignature = calls.map((call) => `${call.name}(${JSON.stringify(call.args)})`).join("|")
				if (callBatchSignature === lastCallBatchSignature) {
					identicalCallStreak++
				} else {
					lastCallBatchSignature = callBatchSignature
					lastCallBatchNames = [...new Set(calls.map((call) => call.name))]
					identicalCallStreak = 1
					identicalCallNudgeInjected = false
				}
				if (identicalCallStreak >= DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD && !identicalCallNudgeInjected) {
					identicalCallNudgeInjected = true
					const signatureLabel = calls.map((call) => call.name).join("+")
					const nextTodo = firstPendingTodoLine(this.executor.getTodoList()?.todos)
					messages.push({ role: "user", content: identicalCallNudgeMessage(signatureLabel, identicalCallStreak, nextTodo) })
					this.logger.warn("[loop] identical-consecutive-call nudge injected", {
						iteration,
						signature: signatureLabel,
						streak: identicalCallStreak,
					})
				}
				if (identicalCallStreak >= DEFAULT_IDENTICAL_CALL_STALL_LIMIT) {
					await this.saveIterationCheckpoint(iteration)
					return this.boundedFailure(
						"identical call repeated",
						iteration,
						toolCalls,
						identicalCallStreak,
						DEFAULT_IDENTICAL_CALL_STALL_LIMIT,
					)
				}

				// Repeated-tool-failure guardrail (issue #146): see
				// DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD's doc comment. Walked in
				// submission order (not the identical-call guardrail's whole-batch
				// signature) since a single turn can mix a failing call with an
				// unrelated one, and a read_file mid-turn must be able to reset the
				// streak before a LATER call in the same turn is evaluated.
				for (let i = 0; i < calls.length; i++) {
					const call = calls[i]
					const outcome = executed.get(i)
					if (outcome === undefined) {
						continue
					}
					if (call.name === "read_file" && toolFailureStreakTargetPath !== undefined) {
						const readTarget = toolCallPathArg(this.config.workspaceRoot, call)
						if (readTarget !== undefined && readTarget === toolFailureStreakTargetPath) {
							toolFailureStreakName = undefined
							toolFailureStreakCount = 0
							toolFailureStreakTargetPath = undefined
							toolFailureNudgeInjected = false
						}
					}
					// Artifact-gate rejection guardrail (issue #152): ANY genuine
					// successful read_file counts as re-diagnosis here (unlike
					// toolFailureStreak above, this isn't scoped to a single
					// failing tool's target path — the concern is "did the model
					// go back to verify anything at all before patching the
					// artifact again").
					if (call.name === "read_file" && !outcome.isError) {
						artifactRejectionStreak = 0
						artifactRejectionNudgeInjected = false
					}
					if (outcome.isError) {
						if (call.name !== toolFailureStreakName) {
							toolFailureStreakName = call.name
							toolFailureStreakCount = 0
							toolFailureNudgeInjected = false
						}
						toolFailureStreakCount++
						toolFailureStreakTargetPath = toolCallPathArg(this.config.workspaceRoot, call) ?? toolFailureStreakTargetPath
					} else if (call.name === toolFailureStreakName) {
						toolFailureStreakName = undefined
						toolFailureStreakCount = 0
						toolFailureStreakTargetPath = undefined
						toolFailureNudgeInjected = false
					}
				}
				if (
					toolFailureStreakName !== undefined &&
					toolFailureStreakCount >= envToolFailureNudgeThreshold() &&
					!toolFailureNudgeInjected
				) {
					toolFailureNudgeInjected = true
					const targetLabel =
						toolFailureStreakTargetPath !== undefined
							? path.relative(this.config.workspaceRoot, toolFailureStreakTargetPath)
							: undefined
					messages.push({
						role: "user",
						content: toolFailureNudgeMessage(
							toolFailureStreakName,
							toolFailureStreakCount,
							targetLabel,
							!excludedToolCooldowns.has("read_file"),
							!excludedToolCooldowns.has(toolFailureStreakName),
						),
					})
					this.logger.warn("[loop] repeated-tool-failure nudge injected", {
						iteration,
						toolName: toolFailureStreakName,
						streak: toolFailureStreakCount,
					})
				}
			}

			// Checkpoints (S1): this iteration executed at least one tool call (we
			// only reach here when `calls.length > 0`). All-read-only turns skip
			// the snapshot entirely — a pure read/explore turn pays no shadow-git
			// commit. Edit-capable turns schedule the snapshot OFF the critical
			// path via scheduleAux; the in-flight ordering guard keeps a later
			// snapshot's commit from landing before an earlier one. The baseline
			// in initCheckpoints is never skipped. Non-fatal — see
			// saveIterationCheckpoint.
			if (!allReadOnly) {
				this.scheduleAux(() => this.saveIterationCheckpoint(iteration))
			}
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
			disableLlmCondensation: this.config.disableLlmCondensation,
			temperature: this.config.temperature,
			maxTokens: this.config.maxTokens,
			globalCustomInstructions: this.config.globalCustomInstructions,
			llmTimeoutMs: this.config.llmTimeoutMs,
			stream: this.config.stream,
			reasoningEffort: this.config.reasoningEffort,
			requireExplicitCompletion: this.config.requireExplicitCompletion,
			patchLocalToolSchemas: this.config.patchLocalToolSchemas,
			verifyBeforeCompletion: this.config.verifyBeforeCompletion,
			guardLargeOverwrites: this.config.guardLargeOverwrites,
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

		// Perform the switch: compute the target mode's tool list FIRST (the
		// SAME way run() does at session start, including the config.tools
		// override precedence) and compare it against the session's current
		// tool set. When the tool names are identical (e.g. two custom modes
		// that differ only in role text but share the same groups), the system
		// prompt does NOT need rebuilding and messages[0] must NOT be replaced:
		// rewriting it invalidates the provider's cached prompt prefix for the
		// whole session, costing a full-prompt cache miss after every such
		// switch. When the tool set differs, rebuild the prompt as before.
		let newTools = this.config.tools ?? selectToolsForMode(modeSlug, this.customModes)
		// Same executor.gated non-vendored appends as run() — see the comment
		// there (T2/T3: a session never carries a schema its executor can't run).
		if (this.executor.has("browser_action")) {
			newTools = appendBrowserActionTool(newTools)
		}
		if (this.executor.has("describe_image")) {
			newTools = appendDescribeImageTool(newTools)
		}
		if (this.executor.has("outline")) {
			newTools = appendCodeIntelTools(newTools)
		}
		if (this.executor.has("rename_symbol")) {
			newTools = appendCodeIntelEditTools(newTools)
		}
		if (this.executor.has("run_tests")) {
			newTools = appendRunTestsTool(newTools)
		}
		if (this.executor.has("set_indentation")) {
			newTools = appendSetIndentationTool(newTools)
		}
		if (this.config.patchLocalToolSchemas) {
			newTools = patchEditFileToolForLocalModels(newTools)
		}
		if (isLazyToolCatalogEnabled()) {
			const split = splitCoreAndLazyTools(newTools)
			this.lazyToolsByName = split.lazyByName
			newTools = split.core
		}
		const toolSetUnchanged = sameToolNames(this.state.tools, newTools)
		this.state.mode = modeSlug
		this.state.tools = newTools
		// (T2/T3 measure-first) Log the post-switch prefix size: state.systemPrompt
		// below reflects the EFFECTIVE prompt (tool-set-unchanged keeps the old
		// one for prompt-cache continuity; a changed tool set rebuilds it).
		this.logPrefixSize(this.state.systemPrompt, newTools, `switch-to-${modeSlug}`)
		let switchResultContent: string
		if (toolSetUnchanged) {
			// Tool set unchanged: keep the current system prompt and
			// messages[0] untouched so the cached prompt prefix survives the
			// switch. The visible "[mode switched: …]" marker below still
			// tells the model's own history when/why the label changed.
			switchResultContent = `Switched to mode '${modeSlug}' (tool set unchanged — system prompt kept for prompt-cache continuity). Reason acknowledged: ${reason}`
		} else {
			const buildPrompt = isLeanSystemPromptEnabled() ? buildLeanSystemPrompt : buildSystemPrompt
			const built = await buildPrompt({
				workspaceRoot: this.config.workspaceRoot,
				mode: modeSlug,
				customModes: this.customModes,
				globalCustomInstructions: this.config.globalCustomInstructions,
			})
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
			switchResultContent = `Switched to mode '${modeSlug}'. Reason acknowledged: ${reason}`
		}
		this.pendingModeSwitchMarker = `[mode switched: ${from} -> ${modeSlug}. Reason: ${reason}]`
		this.modeSwitchCount++
		// Live worker monitoring: structured event for the dashboard (non-fatal
		// like every other event emission). (S2) Scheduled so it lands after
		// this turn's queued tool_call event, in occurrence order.
		this.scheduleAux(() =>
			this.emitEvent("mode_switched", () =>
				this.eventFeed.modeSwitched({ from, to: modeSlug, reason, autoApproved }),
			),
		)
		this.logger.info("[switch_mode] switched", {
			from,
			to: modeSlug,
			count: this.modeSwitchCount,
			autoApproved,
			toolSetUnchanged,
		})
		return {
			content: switchResultContent,
			isError: false,
		}
	}

	/**
	 * list_tools (src/engine/lazy-tools.ts): return the index of tools not
	 * currently in state.tools. Pure introspection — no executor involved.
	 */
	private async handleListTools(): Promise<ToolResult> {
		return { content: renderToolIndex(this.lazyToolsByName), isError: false }
	}

	/**
	 * request_tool (src/engine/lazy-tools.ts): make one lazily-held tool
	 * callable from the NEXT turn onward by appending its schema to
	 * state.tools. Idempotent — calling it again for an already-active tool
	 * is a no-op success, not an error, since a small local model may not
	 * reliably remember what it already unlocked.
	 */
	private async handleRequestTool(args: Record<string, unknown>): Promise<ToolResult> {
		const name = typeof args.name === "string" ? args.name.trim() : ""
		if (!name) {
			return { content: "[Error] request_tool: 'name' is required.", isError: true }
		}
		if (this.state.tools.some((t) => t.type === "function" && t.function.name === name)) {
			return { content: `Tool '${name}' is already available.`, isError: false }
		}
		const tool = this.lazyToolsByName.get(name)
		if (!tool) {
			const available = [...this.lazyToolsByName.keys()].join(", ") || "(none)"
			return {
				content: `[Error] request_tool: unknown tool '${name}'. Available: ${available}`,
				isError: true,
			}
		}
		this.state.tools = [...this.state.tools, tool]
		return { content: `Tool '${name}' is now available starting next turn.`, isError: false }
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
		limit: number = this.config.consecutiveErrorLimit,
	): SessionResult {
		this.logger.error("[loop] bounded failure", { reason, consecutiveMistakes, limit })
		return {
			status: "error",
			error: `Bounded failure: ${consecutiveMistakes} ${reason} (limit ${limit})`,
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
 * (T2/T3 measure-first) Approximate token count from a character count using
 * the standard ~4 chars/token heuristic. Used for prefix-size logging, never
 * for billing or condensation sizing (those use real usage data).
 */
export function estimateTokenSize(chars: number): number {
	return Math.ceil(chars / 4)
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
			return `${filePath} [slice offset=1 limit=${readLimitFromEnv()}]`
		}
		case "list_files":
		case "write_to_file":
		case "apply_diff":
			return str(args.path)
		case "search_replace":
		case "edit_file":
			// 2026-09-02: real, confirmed bug -- these two tools' native
			// schemas (src/vendor/zoo-code/.../native-tools/edit_file.ts,
			// search_replace.ts) declare `file_path`, not `path` (unlike
			// write_to_file/apply_diff/list_files, which really do use
			// `path`) -- so this always returned undefined -> "" here,
			// making the tool_call event's path summary silently blank for
			// every edit_file/search_replace call. That's exactly what made
			// live log-watching during a real session unable to show which
			// file was being edited. Fall back to `path` too in case an
			// older/alias caller still sends that key.
			return str(args.file_path) ?? str(args.path)
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

/** Batch size for truncateHistory's eviction — see its own doc comment for why. */
export const TRUNCATION_BATCH_SIZE = 10

/**
 * True when two tool lists advertise the same set of tool names (sorted name
 * comparison — cheap and sufficient). Used by switch_mode to detect that the
 * target mode's effective tool set equals the current one, in which case the
 * system prompt / messages[0] are left untouched so the provider's cached
 * prompt prefix survives the switch.
 */
function sameToolNames(a: ChatTool[], b: ChatTool[]): boolean {
	const names = (tools: ChatTool[]): string[] =>
		tools
			.filter((t) => t.type === "function")
			.map((t) => t.function.name)
			.sort()
	const na = names(a)
	const nb = names(b)
	if (na.length !== nb.length) {
		return false
	}
	for (let i = 0; i < na.length; i++) {
		if (na[i] !== nb[i]) {
			return false
		}
	}
	return true
}

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

function envReadOnlyStallLimit(): number {
	const raw = process.env.HEADLESSCODE_READ_ONLY_STALL_LIMIT
	if (raw === undefined || raw === "") {
		return DEFAULT_READ_ONLY_STALL_LIMIT
	}
	const n = Number(raw)
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_READ_ONLY_STALL_LIMIT
}

function envToolFailureNudgeThreshold(): number {
	const raw = process.env.HEADLESSCODE_TOOL_FAILURE_NUDGE_THRESHOLD
	if (raw === undefined || raw === "") {
		return DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD
	}
	const n = Number(raw)
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD
}

function envArtifactRejectionNudgeThreshold(): number {
	const raw = process.env.HEADLESSCODE_ARTIFACT_REJECTION_NUDGE_THRESHOLD
	if (raw === undefined || raw === "") {
		return DEFAULT_ARTIFACT_REJECTION_NUDGE_THRESHOLD
	}
	const n = Number(raw)
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_ARTIFACT_REJECTION_NUDGE_THRESHOLD
}

function envIdenticalCallRepeatPenaltyBoost(): number {
	const raw = process.env.HEADLESSCODE_IDENTICAL_CALL_REPEAT_PENALTY_BOOST
	if (raw === undefined || raw === "") {
		return DEFAULT_IDENTICAL_CALL_REPEAT_PENALTY_BOOST
	}
	const n = Number(raw)
	return Number.isFinite(n) && n > 1 ? n : DEFAULT_IDENTICAL_CALL_REPEAT_PENALTY_BOOST
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
