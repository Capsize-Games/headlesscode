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
	/** Phase 6: present when the session had a budget (see SessionBudgetUsage). */
	budgetUsage?: SessionBudgetUsage
}
