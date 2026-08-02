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
import { setTimeout as sleep } from "node:timers/promises"

import { randomUUID } from "node:crypto"

import { BudgetExceededError, BudgetTracker, type SessionBudget } from "../budget/budget.js"
import { DEFAULT_MODEL } from "../llm/openrouter.js"
import { createHeadlessExecutor, ToolExecutor } from "../tools/executor.js"
import type { PermissionsConfig } from "../permissions/config.js"
import { buildRollingSummary, extractSessionSummary } from "../memory/summarizer.js"
import type { MemoryStore, RecallResult } from "../memory/types.js"
import { createCheckpointService, type CheckpointService } from "../checkpoints/service.js"
import { recordSessionUsage, removeLiveUsage, writeLiveUsage } from "./usage.js"
import { EventFeed, EVENT_TRUNCATE_CHARS, truncateField } from "./events.js"
import { Logger } from "./logger.js"
import { parseToolCalls } from "./parser.js"
import { appendBrowserActionTool, buildSystemPrompt, loadCustomModes, selectToolsForMode } from "./prompt.js"
import type { ChatMessage, ChatTool, LlmClient, LlmResponse, SessionResult, SessionBudgetUsage } from "./types.js"
import type { ModeConfig } from "@roo-code/types"
import {
	computeEvictCount,
	DEFAULT_CONDENSE_THRESHOLD_FRACTION,
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	maybeCondense,
	skipOrphanedToolMessages,
} from "./condense.js"
import { runLocalExplorePhase, type LocalExploreOptions, type LocalExploreResult } from "./local-explore.js"

/** Default max pause duration for dashboard-initiated pauses, ms (matches watch.ts's stall guard). */
export const DEFAULT_MAX_PAUSE_MS = 2 * 60 * 60 * 1000
/** Default pause marker poll interval, ms (same cadence as decision escalation). */
export const DEFAULT_PAUSE_POLL_INTERVAL_MS = 5_000
/** Marker basenames, relative to the workspace root (see src/tools/executor.ts's marker idiom). */
const PAUSE_REQUESTED_FILENAME = ".harness.pause-requested"
const PAUSED_FILENAME = ".harness.paused"

export const DEFAULT_MAX_ITERATIONS = 50
export const DEFAULT_CONSECUTIVE_ERROR_LIMIT = 3
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

export interface HeadlessSessionConfig {
	workspaceRoot: string
	/**
	 * Explicit session id override (default: a fresh randomUUID). The
	 * dashboard's session-launch endpoint generates the id first and passes
	 * it through (via --session-id) so the browser can open the session's
	 * live event view immediately, before the first event exists.
	 */
	sessionId?: string
	/** Mode slug, default 'code' (built-in or from .roomodes). */
	mode?: string
	/** Model id; default env OPENROUTER_MODEL or 'deepseek/deepseek-chat'. */
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
	 * Phase 3 context condensation: model id used for the condensation LLM
	 * call (default: the session model). A cheaper model can be assigned via
	 * the `_condensation` key in `<workspaceRoot>/.headlesscode/mode-models.json`
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
	/** Shadow-git storage dir override (default: `<workspaceRoot>/.headlesscode/checkpoints`). */
	checkpointDir?: string
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
	 * when absent the executor resolves its own from env vars +
	 * `<workspaceRoot>/.headlesscode/permissions.json` + built-in defaults.
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
	 * True once the real context window has been resolved (from config, the
	 * OpenRouter models endpoint, or the conservative default) — the lookup
	 * is done at most once per session, on the first iteration that needs it.
	 */
	private contextWindowResolved = false

	constructor(config: HeadlessSessionConfig) {
		if (!config.llmClient) {
			throw new Error("HeadlessSession requires an llmClient (inject a fake in tests)")
		}
		if (!config.taskText || config.taskText.trim() === "") {
			throw new Error("HeadlessSession requires a non-empty taskText")
		}

		this.config = {
			sessionId: config.sessionId?.trim() ? config.sessionId.trim() : undefined,
			mode: config.mode ?? "code",
			model: config.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL,
			taskText: config.taskText,
			maxIterations: config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			consecutiveErrorLimit: config.consecutiveErrorLimit ?? DEFAULT_CONSECUTIVE_ERROR_LIMIT,
			systemPromptOverride: config.systemPromptOverride,
			llmTimeoutMs: config.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
			stream: config.stream ?? envStreaming(),
			windowSize: config.windowSize ?? DEFAULT_WINDOW_SIZE,
			// Deliberately left undefined when the caller didn't configure it:
			// the live OpenRouter models-endpoint lookup in maybeCondenseHistory
			// resolves the real context window (never hardcode a stale number —
			// constraint 1 of plans/context-condensation.md), with
			// DEFAULT_CONTEXT_WINDOW_TOKENS as the conservative fallback.
			contextWindowTokens: config.contextWindowTokens,
			condenseThresholdFraction: config.condenseThresholdFraction ?? DEFAULT_CONDENSE_THRESHOLD_FRACTION,
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
			})
		this.sessionId = config.sessionId?.trim() ? config.sessionId.trim() : randomUUID()
		this.eventHook = config.eventHook
		this.eventFeed = new EventFeed(config.workspaceRoot, this.sessionId, (eventType, error) => {
			this.logger.warn(`[events] failed to record '${eventType}' (non-fatal; dashboard misses this event)`, {
				error: error instanceof Error ? error.message : String(error),
			})
		})
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

		// 1. System prompt + tool selection.
		const customModes = this.config.customModes ?? (await loadCustomModes(workspaceRoot))
		const systemPrompt =
			this.config.systemPromptOverride ??
			(await buildSystemPrompt({
				workspaceRoot,
				mode,
				customModes,
				globalCustomInstructions: this.config.globalCustomInstructions,
			})).prompt
		// browser_action is not part of the vendored tool set, so
		// selectToolsForMode can't include it — append it explicitly so the
		// model can launch a browser mid-session (see src/tools/browser/).
		const tools = appendBrowserActionTool(this.config.tools ?? selectToolsForMode(mode, customModes))

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
		const budgetTracker = new BudgetTracker(this.config.budget ?? {})
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
	 * Phase 3 context condensation: resolve the model's real context window
	 * (once per session) and, when the LAST request's real prompt tokens
	 * crossed the threshold, replace the oldest turns with one synthetic
	 * summary message. Non-fatal: any failure falls back to
	 * `truncateHistory` for that call. The condensation call's own usage is
	 * fed into the SAME BudgetTracker + running totals as the main session
	 * (constraint 2 — never invisible spend).
	 */
	private async maybeCondenseHistory(
		messages: ChatMessage[],
		budgetTracker: BudgetTracker,
	): Promise<ChatMessage[]> {
		if (!(this.lastLlmUsage && this.lastLlmUsage.inputTokens > 0)) {
			return messages
		}
		const config = this.config

		// Resolve the real context window at most once per session: explicit
		// config wins, then a live OpenRouter lookup (the same
		// /api/v1/models/<id>/endpoints source the pricing table was verified
		// against), then the conservative default.
		let contextWindowTokens = config.contextWindowTokens
		if (contextWindowTokens === undefined) {
			contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS
			if (!this.contextWindowResolved) {
				this.contextWindowResolved = true
				const client = this.llmClient as {
					fetchModelContextWindow?: (model: string) => Promise<number | undefined>
				}
				try {
					const live = await client.fetchModelContextWindow?.(config.model)
					if (live !== undefined && live > 0) {
						contextWindowTokens = live
						this.logger.info("[condense] resolved live context window from OpenRouter models endpoint", {
							model: config.model,
							contextWindowTokens: live,
						})
					}
				} catch (error) {
					this.logger.warn("[condense] live context-window lookup failed (non-fatal; using conservative default)", {
						error: error instanceof Error ? error.message : String(error),
					})
				}
			}
		}

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
				messages.splice(0, messages.length, ...condensed)
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

	private async runIterations(budgetTracker: BudgetTracker, startedAt: string): Promise<SessionResult> {
		const { maxIterations, consecutiveErrorLimit } = this.config
		const messages = this.state.messages
		let consecutiveMistakes = 0
		let lastCallSignature: string | undefined
		let toolCalls = 0

		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			this.logger.info(`[loop] iteration ${iteration}/${maxIterations}`, { history: messages.length })
			// Live worker monitoring: emit the iteration_start event alongside
			// the human-readable log line above. Non-fatal.
			await this.emitEvent("iteration_start", () => this.eventFeed.iterationStart(iteration, messages.length))

			// Pause/resume (dashboard control): block between iterations (never
			// mid-tool-call — same safe boundary as the budget check below)
			// while a .harness.pause-requested marker is present.
			await this.checkPauseRequested(budgetTracker)

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
				requestMessages = await this.maybeCondenseHistory(messages, budgetTracker)
			} catch (err) {
				if (err instanceof BudgetExceededError) {
					return this.budgetFailure(err, iteration, toolCalls)
				}
				throw err
			}
			requestMessages = truncateHistory(requestMessages, this.config.windowSize)

			// 4. Call the LLM with an abort timeout.
			let assistant: ChatMessage
			try {
				const controller = new AbortController()
				const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs)
				try {
					const response = await this.llmClient.createChatCompletion({
						model: this.config.model,
						messages: requestMessages,
						tools: this.state.tools,
						temperature: this.config.temperature,
						maxTokens: this.config.maxTokens,
						signal: controller.signal,
						stream: this.config.stream,
						onStreamChunk: (kind, chunk) => {
							// Dashboard live-typing: forward each chunk to the event
							// feed (truncated like other large fields). Non-fatal —
							// a feed write failure must never abort the LLM call.
							void this.emitEvent(
								"llm_stream_chunk",
								() => this.eventFeed.llmStreamChunk({ iteration, kind, chunk }),
								{ iteration },
							)
						},
					})
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
					this.logger.info("[usage] running total", {
						iteration,
						costUsd: budgetTracker.totalCostUsd,
						iterations: budgetTracker.iterationCount,
						inputTokens: this.totalInputTokens,
						outputTokens: this.totalOutputTokens,
						cachedTokens: this.totalCachedTokens,
					})
					// Live (in-progress) usage snapshot: overwritten in place each
					// iteration so the dashboard can show this still-running
					// session's accumulating cost/tokens/iterations. Non-fatal —
					// a write failure must never affect the session (same idiom
					// as the final usage record / checkpoints).
					await this.writeLiveSnapshot(startedAt, iteration, budgetTracker.totalCostUsd)
				} finally {
					clearTimeout(timer)
				}
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

			const calls = parseToolCalls(assistant)

			// 6a. SUCCESS via attempt_completion.
			const completionCall = calls.find((call) => call.name === "attempt_completion")
			if (completionCall) {
				const result =
					typeof completionCall.args?.result === "string"
						? completionCall.args.result
						: JSON.stringify(completionCall.args)
				this.logger.info("[loop] attempt_completion received — success", { iteration })
				return { status: "success", result, iterations: iteration, toolCalls: toolCalls + 1 }
			}

			// 6b. Text-only reply (no tool_calls) → pragmatic success fallback.
			if (calls.length === 0) {
				const text = (assistant.content ?? "").trim()
				if (text) {
					this.logger.info("[loop] text-only reply (no tool calls) — success", { iteration })
					return { status: "success", result: text, iterations: iteration, toolCalls }
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
			for (const call of calls) {
				toolCalls++
				let resultContent: string
				let isError: boolean

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
				} else {
					const result = await this.executor.execute(call.name, call.args)
					resultContent = result.content
					isError = result.isError
				}

				messages.push({
					role: "tool",
					tool_call_id: call.id,
					name: call.name,
					content: resultContent,
				})

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

			// Checkpoints: this iteration executed at least one tool call (we only
			// reach here when `calls.length > 0`), so snapshot the workspace.
			// Non-fatal — see saveIterationCheckpoint.
			await this.saveIterationCheckpoint(iteration)
		}

		// maxIterations exhausted without completion.
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
			const service = createCheckpointService({
				taskId: this.sessionId,
				workspaceRoot: this.config.workspaceRoot,
				checkpointDir: this.config.checkpointDir,
				log: (message) => this.logger.debug(`[checkpoints] ${message}`),
			})
			await service.init()
			await service.save(`Task: ${this.sessionId}, Time: ${Date.now()}`, { allowEmpty: true })
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
			await this.checkpointService.save(`Task: ${this.sessionId}, Time: ${Date.now()}`, { allowEmpty: true })
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
 */
function summarizeToolArg(name: string, args: Record<string, unknown>): string | undefined {
	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
	switch (name) {
		case "read_file":
		case "list_files":
		case "write_to_file":
		case "apply_diff":
		case "search_replace":
		case "edit_file":
			return str(args.path)
		case "execute_command":
			return str(args.command)?.slice(0, 200)
		default:
			return undefined
	}
}

/** Batch size for truncateHistory's eviction — see its own doc comment for why. */
export const TRUNCATION_BATCH_SIZE = 10

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
