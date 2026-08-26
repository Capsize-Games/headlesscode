/**
 * Shared types for the headless harness engine.
 *
 * These are deliberately minimal, local interfaces for the OpenAI-compatible
 * chat message shapes used by OpenRouter. We do NOT pull in the `openai` SDK —
 * the vendored Zoo Code core already provides its own type-only shim for the
 * tool schemas (see `src/vendor/zoo-code/shim/openai.d.ts`), and the harness
 * only needs the handful of message shapes below to talk to a chat-completions
 * endpoint.
 */

import type { PermissionsConfig } from "../permissions/config.js"

export type ChatRole = "system" | "user" | "assistant" | "tool"

/** A single OpenAI-style function call emitted by the model. */
export interface ChatToolCall {
	id: string
	type: "function"
	function: {
		name: string
		arguments: string
	}
}

/** A chat message in OpenAI/OpenRouter chat-completions format. */
export interface ChatMessage {
	role: ChatRole
	content: string | null
	tool_calls?: ChatToolCall[]
	/** Present on `role: "tool"` messages, links back to the assistant call. */
	tool_call_id?: string
	/** Present on `role: "tool"` messages. */
	name?: string
	/**
	 * The model's reasoning/"thinking" text for this assistant message
	 * (streaming-and-reasoning). OpenRouter normalizes DeepSeek's
	 * `reasoning_content` to `reasoning` on the response message; we echo it
	 * back onto outgoing assistant history the same way. Optional — absent
	 * for models/calls that don't produce reasoning content.
	 */
	reasoning?: string
}

/** An OpenAI-format ChatCompletionTool (function schema). */
export interface ChatTool {
	type: "function"
	function: {
		name: string
		description?: string
		strict?: boolean | null
		parameters?: Record<string, unknown>
		[key: string]: unknown
	}
	[key: string]: unknown
}

/** Request shape accepted by an LlmClient. */
export interface LlmRequest {
	model: string
	messages: ChatMessage[]
	tools?: ChatTool[]
	temperature?: number
	maxTokens?: number
	signal?: AbortSignal
	/**
	 * Opt-in SSE streaming (streaming-and-reasoning). When true the client
	 * streams deltas and assembles the final message from the stream instead
	 * of one blocking fetch. Default OFF — existing callers/tests are
	 * unaffected.
	 */
	stream?: boolean
	/**
	 * Streaming-and-reasoning: invoked for each incremental chunk as a streamed
	 * response arrives (kind "text" | "reasoning" | "tool"). Only called when
	 * `stream` is true and the client actually streams; the loop uses it to emit
	 * `llm_stream_chunk` events for the dashboard's live-typing view. Non-fatal
	 * by contract: a throw from this callback must not fail the LLM call.
	 */
	onStreamChunk?: (kind: "text" | "reasoning" | "tool", chunk: string) => void
	/**
	 * Graded reasoning effort for models that support it (the pinned DeepSeek
	 * family — issue #30 experiment). User-facing vocabulary is DeepSeek's
	 * native set low/medium/high/max, plus OpenRouter's normalized "xhigh"
	 * (an alias for the native max); the client normalizes to OpenRouter's
	 * `reasoning: { effort }` field on the wire. Optional — when unset, no
	 * effort field is sent and the endpoint's own undeclared default applies
	 * (pre-existing behavior, unchanged).
	 */
	reasoningEffort?: string
	/**
	 * Sampling-level override for llama.cpp's `repeat_penalty`, applied for
	 * exactly one request. The loop sets this once its identical-consecutive-
	 * call guardrail (see DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD in
	 * src/engine/loop.ts) detects a repeat starting, as an alternative to a
	 * text-only nudge — three rounds of increasingly specific injected
	 * corrections were verified live not to reliably interrupt a local model
	 * mid-repetition (2026-08-21/22), so this escalates at the sampler
	 * instead of only in the prompt. Ignored by clients/backends that don't
	 * support per-request sampling overrides (e.g. OpenRouter).
	 */
	repeatPenalty?: number
	/**
	 * Forces the model to call SOME tool rather than allowing a free
	 * text/empty response — the OpenAI-style `"required"` value (also
	 * `"none"`/`"auto"`). Verified live 2026-08-20: once the identical-call
	 * guard's tool exclusion removes a strongly-preferred tool from the
	 * schema, the model doesn't substitute a different tool call — it
	 * produces a genuinely EMPTY (zero-token) generation instead, 100% of
	 * the time (148/148 in one trial), consistent with the default
	 * `tool_choice: "auto"` leaving a free-text/empty branch available for
	 * the grammar-constrained decoder to collapse into once its preferred
	 * path is removed. `"required"` closes that branch. Ignored by
	 * clients/backends that don't support it.
	 */
	toolChoice?: "auto" | "none" | "required"
}

/** Response shape returned by an LlmClient. */
export interface LlmResponse {
	message: ChatMessage
	usage?: {
		promptTokens?: number
		completionTokens?: number
		totalTokens?: number
		/**
		 * Prompt tokens served from the provider's prefix cache (a subset of
		 * promptTokens, not additional) — OpenRouter surfaces this as
		 * `usage.prompt_tokens_details.cached_tokens` when the underlying
		 * provider (e.g. DeepSeek) supports automatic prompt caching. Cached
		 * tokens are billed at a steep discount; see src/budget/cost.ts.
		 */
		cachedTokens?: number
	}
}

/**
 * The LLM client contract the orchestration loop depends on.
 *
 * The loop must NOT hardcode OpenRouter: tests inject a fake client that
 * implements this interface, so the loop is fully unit-testable without a
 * network or API key.
 */
export interface LlmClient {
	createChatCompletion(request: LlmRequest): Promise<LlmResponse>
}

/** Result of executing one tool call. */
export interface ToolResult {
	content: string
	isError: boolean
}

/**
 * Usage of one LLM call made OUTSIDE the main loop's request path — e.g. the
 * cloud vision captioning in src/vision/describe.ts (browser screenshots and
 * the `describe_image` tool). Auxiliary calls are recorded into the SAME
 * BudgetTracker + running session totals as a main call (see
 * recordAuxLlmUsage in src/engine/loop.ts), so their real token/cost shows up
 * in the session's budget/usage accounting instead of being an untracked side
 * channel. Shape mirrors the token counts of LlmResponse.usage.
 */
export interface AuxLlmUsage {
	/** The model id the auxiliary call actually ran (echoed by the provider). */
	model: string
	inputTokens: number
	outputTokens: number
	/** Subset of inputTokens served from the provider's prompt cache. */
	cachedTokens?: number
}

/** Per-call context handed to tool handlers. */
export interface ToolContext {
	workspaceRoot: string
	/**
	 * Resolved command allow/deny + protected-file permissions for this
	 * executor/session (see src/permissions/). Always present — the executor
	 * resolves built-in defaults when nothing is configured — so handlers can
	 * enforce command gating (execute_command) and protected-file refusals
	 * (write_to_file) without guessing.
	 */
	permissions: PermissionsConfig
	/**
	 * See HeadlessSessionConfig.guardLargeOverwrites (loop.ts) for the full
	 * writeup. When true, `write_to_file` refuses to overwrite an existing
	 * file that already has substantial content (see the guard in
	 * `writeToFileHandler`, src/tools/executor.ts) — creating a brand-new
	 * file is never affected. Absent/false for cloud sessions and bare
	 * executors (tests, reviewer/QA).
	 */
	guardLargeOverwrites?: boolean
	/**
	 * Decision escalation (ask_followup_question, see src/tools/executor.ts):
	 * how long to block waiting for `.harness.decision-answer` before falling
	 * back to today's autonomous-decision error, and how often to poll for it.
	 * Both optional — handlers fall back to their own defaults when absent.
	 */
	decisionTimeoutMs?: number
	decisionPollIntervalMs?: number
	/**
	 * Budget-clock pause/resume hooks, wired by HeadlessSession right after it
	 * constructs a BudgetTracker (see src/budget/budget.ts's pauseClock /
	 * resumeClock). ask_followup_question calls these around its blocking wait
	 * so time spent waiting on a human/orchestrator answer isn't charged
	 * against the session's duration budget. Absent when no budget is
	 * configured, or when the injected executor never wired them.
	 */
	pauseBudgetClock?: () => void
	resumeBudgetClock?: () => void
	/**
	 * Live worker monitoring: fired at the same lifecycle points where the
	 * `.harness.needs-decision` marker is written/cleared (see the
	 * ask_followup_question handler in src/tools/executor.ts), so the session
	 * can mirror those transitions on its structured event feed
	 * (`decision_blocked` / `decision_answered`). Absent when no hook was
	 * wired (plain executor use, tests without a session).
	 */
	onDecisionEvent?: (eventType: "decision_blocked" | "decision_answered", fields: Record<string, unknown>) => void
	/**
	 * Live todo-list monitoring: fired each time update_todo_list replaces the
	 * session's checklist (see the handler in src/tools/executor.ts), carrying
	 * the full normalized checklist plus done/in-progress/pending counts, so
	 * the session can mirror it on its structured event feed (`todo_updated`).
	 * Absent when no hook was wired (plain executor use, tests without a
	 * session).
	 */
	onTodoEvent?: (fields: { todos: string; done: number; inProgress: number; pending: number }) => void
	/**
	 * Auxiliary LLM usage reporting (cloud vision captioning — see
	 * src/vision/describe.ts): fired after every LLM call made outside the
	 * main loop's request path, so the session can record its tokens/cost into
	 * the same BudgetTracker + totals as a main call (see recordAuxLlmUsage in
	 * src/engine/loop.ts). Absent when no hook was wired — plain executor use,
	 * tests without a session. Its presence also gates the screenshot action's
	 * auto-describe behavior (browser_action only captions screenshots when
	 * attached to a real accounting session; bare executors skip the call and
	 * the model can still use `describe_image` explicitly).
	 */
	onAuxLlmUsage?: (usage: AuxLlmUsage) => void
}

/** A tool handler: dispatch any registered tool by name. */
export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult

/** Parsed result of one assistant tool call. */
export interface ParsedToolCall {
	id: string
	name: string
	args: Record<string, unknown>
	rawArguments: string
	/** Set when JSON.parse failed and best-effort extraction also failed. */
	parseError?: string
}

export type SessionStatus = "success" | "error"

/**
 * Phase 6 — budget accounting surfaced on every SessionResult when a
 * per-session budget is configured (null budget → absent → zero change).
 */
export interface SessionBudgetUsage {
	/** Estimated USD spend (tokens × pricing) accumulated across LLM calls. */
	costUsd: number
	/** Wall-clock elapsed since the session's budget tracker started, ms. */
	elapsedMs: number
	/** Number of LLM calls (ticks) performed. */
	iterations: number
	/** Model id the session ran with. */
	model: string
}

export interface SessionResult {
	status: SessionStatus
	result?: string
	error?: string
	/** Machine-readable failure reason (e.g. "budget") for callers/CLI. */
	reason?: string
	iterations: number
	toolCalls: number
	/**
	 * Issue #34: absolute path to the session's complete final report
	 * (`<workspaceRoot>/.headlesscode/reports/<sessionId>.md`), present when
	 * the session ended successfully (attempt_completion or the text-only
	 * fallback) and the report write succeeded. Callers (runQa/runReview →
	 * orchestrator state) persist this so the full reasoning behind a
	 * review/QA verdict is one file-read away, not a re-run away.
	 */
	reportPath?: string
	/** Phase 6: present when the session had a budget (see SessionBudgetUsage). */
	budgetUsage?: SessionBudgetUsage
}
