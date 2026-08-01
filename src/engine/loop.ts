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
 * History truncation (Phase 1 placeholder): the system message and the first
 * user message are always kept; when the history exceeds `windowSize`, the
 * oldest non-system, non-first-user messages are dropped before each request.
 * Proper token-based condensation is Phase 3.
 *
 * The loop is non-interactive by construction: no approval prompts, no
 * webview, and `ask_followup_question` calls are answered by the executor with
 * a "harness is non-interactive" result.
 */

import * as path from "node:path"

import { BudgetExceededError, BudgetTracker, type SessionBudget } from "../budget/budget.js"
import { DEFAULT_MODEL } from "../llm/openrouter.js"
import { createHeadlessExecutor, ToolExecutor } from "../tools/executor.js"
import { buildRollingSummary, extractSessionSummary } from "../memory/summarizer.js"
import type { MemoryStore, RecallResult } from "../memory/types.js"
import { Logger } from "./logger.js"
import { parseToolCalls } from "./parser.js"
import { buildSystemPrompt, loadCustomModes, selectToolsForMode } from "./prompt.js"
import type { ChatMessage, ChatTool, LlmClient, SessionResult, SessionBudgetUsage } from "./types.js"
import type { ModeConfig } from "@roo-code/types"

export const DEFAULT_MAX_ITERATIONS = 50
export const DEFAULT_CONSECUTIVE_ERROR_LIMIT = 3
export const DEFAULT_WINDOW_SIZE = 40
export const DEFAULT_LLM_TIMEOUT_MS = 120_000

export interface HeadlessSessionConfig {
	workspaceRoot: string
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
	/** Sliding-window cap on messages sent per request (default 40). */
	windowSize?: number
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
	mode: string
	model: string
	taskText: string
	maxIterations: number
	consecutiveErrorLimit: number
	systemPromptOverride?: string
	llmTimeoutMs: number
	windowSize: number
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

	constructor(config: HeadlessSessionConfig) {
		if (!config.llmClient) {
			throw new Error("HeadlessSession requires an llmClient (inject a fake in tests)")
		}
		if (!config.taskText || config.taskText.trim() === "") {
			throw new Error("HeadlessSession requires a non-empty taskText")
		}

		this.config = {
			mode: config.mode ?? "code",
			model: config.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL,
			taskText: config.taskText,
			maxIterations: config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			consecutiveErrorLimit: config.consecutiveErrorLimit ?? DEFAULT_CONSECUTIVE_ERROR_LIMIT,
			systemPromptOverride: config.systemPromptOverride,
			llmTimeoutMs: config.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
			windowSize: config.windowSize ?? DEFAULT_WINDOW_SIZE,
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
		}

		this.llmClient = config.llmClient
		this.logger = config.logger ?? new Logger({ level: "info" })
		this.executor = config.executor ?? createHeadlessExecutor(config.workspaceRoot)
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
		const tools = this.config.tools ?? selectToolsForMode(mode, customModes)

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

		this.logger.info("[loop] session start", {
			mode,
			model,
			workspaceRoot,
			tools: tools.map((t) => (t.type === "function" ? t.function.name : t.type)),
		})

		// 3. Run the bounded loop, then persist the session + extracted facts.
		// Memory recording never fails the session (wrapped in try/catch).
		const budgetTracker = this.config.budget ? new BudgetTracker(this.config.budget) : null
		const result = await this.runIterations(budgetTracker)
		await this.recordMemory(result)
		// Phase 6: surface the budget accounting on every result when a budget
		// was configured (absent when off → zero behavior change).
		if (budgetTracker) {
			const usage = budgetTracker.check()
			const budgetUsage: SessionBudgetUsage = {
				costUsd: usage.costUsd,
				elapsedMs: usage.elapsedMs,
				iterations: usage.iterations,
				model: this.config.model,
			}
			return { ...result, budgetUsage }
		}
		return result
	}

	private async runIterations(budgetTracker: BudgetTracker | null): Promise<SessionResult> {
		const { maxIterations, consecutiveErrorLimit } = this.config
		const messages = this.state.messages
		let consecutiveMistakes = 0
		let lastCallSignature: string | undefined
		let toolCalls = 0

		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			this.logger.info(`[loop] iteration ${iteration}/${maxIterations}`, { history: messages.length })

			// Phase 6 budget check BEFORE this LLM call: elapsed time, iteration
			// count and accumulated cost are all re-checked here so no further
			// spend happens once a limit has tripped.
			if (budgetTracker) {
				try {
					budgetTracker.tick()
				} catch (err) {
					if (err instanceof BudgetExceededError) {
						return this.budgetFailure(err, iteration, toolCalls)
					}
					throw err
				}
			}

			// 3. Sliding-window truncation (Phase 1 placeholder).
			const requestMessages = truncateHistory(messages, this.config.windowSize)

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
					})
					assistant = response.message
					// Phase 6: feed the provider's usage tokens into the budget
					// (cost accumulation; trips when the cost cap is crossed).
					if (budgetTracker && response.usage) {
						try {
							budgetTracker.record({
								model: this.config.model,
								inputTokens: response.usage.promptTokens,
								outputTokens: response.usage.completionTokens,
							})
						} catch (err) {
							if (err instanceof BudgetExceededError) {
								return this.budgetFailure(err, iteration, toolCalls)
							}
							throw err
						}
					}
				} finally {
					clearTimeout(timer)
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				this.logger.error("[loop] LLM request failed", { iteration, error: message })
				return {
					status: "error",
					error: `LLM request failed on iteration ${iteration}: ${message}`,
					iterations: iteration,
					toolCalls,
				}
			}

			// 5. Append the assistant message.
			const assistantMessage: ChatMessage = {
				role: "assistant",
				content: assistant.content ?? null,
				tool_calls: assistant.tool_calls,
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
					return this.boundedFailure("empty replies", iteration, toolCalls, consecutiveMistakes)
				}
				continue
			}

			// 7. Execute each tool call, feeding results back as `tool` messages.
			for (const call of calls) {
				toolCalls++
				let resultContent: string
				let isError: boolean

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

				this.logger.info(`[loop] tool result: ${call.name}`, { isError, toolCalls })

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
						return this.boundedFailure("consecutive mistakes", iteration, toolCalls, consecutiveMistakes)
					}
				} else {
					consecutiveMistakes = 0
					lastCallSignature = undefined
				}
			}
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
		* Phase 3: recall project memory for this task. Returns the delimited
		* "## PROJECT MEMORY" section (recalled facts + rolling recap) plus counts.
		* Non-fatal: any failure returns an empty section.
		*/
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
			error: `Bounded failure: ${consecutiveMistakes} consecutive ${reason} (limit ${this.config.consecutiveErrorLimit})`,
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
 * Phase 1 sliding-window truncation: keep the system message and the first
 * user message always; drop the oldest non-system, non-first-user messages
 * until the total is at most `windowSize`.
 *
 * Documented placeholder: Phase 3 replaces this with token-count-based
 * condensation (summarize + merge) using the model's real token counts.
 */
export function truncateHistory(messages: ChatMessage[], windowSize: number): ChatMessage[] {
	if (messages.length <= windowSize) {
		return messages
	}
	const system = messages[0]
	const firstUser = messages[1]
	const rest = messages.slice(2)
	const keptTail = rest.slice(-(windowSize - 2))
	return [system, firstUser, ...keptTail]
}
