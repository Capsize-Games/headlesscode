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
 * webview. `ask_followup_question` calls escalate instead of failing
 * immediately: the executor writes a `.harness.needs-decision` marker and
 * blocks (budget clock paused) for a configurable timeout waiting for
 * `.harness.decision-answer` — a human or the orchestrator can answer via
 * `scripts/headlesscode-answer.sh`. Only once that timeout elapses does it
 * fall back to the original "harness is non-interactive" error (see
 * src/tools/executor.ts).
 */

import * as path from "node:path"

import { randomUUID } from "node:crypto"

import { BudgetExceededError, BudgetTracker, type SessionBudget } from "../budget/budget.js"
import { DEFAULT_MODEL } from "../llm/openrouter.js"
import { createHeadlessExecutor, ToolExecutor } from "../tools/executor.js"
import { buildRollingSummary, extractSessionSummary } from "../memory/summarizer.js"
import type { MemoryStore, RecallResult } from "../memory/types.js"
import { createCheckpointService, type CheckpointService } from "../checkpoints/service.js"
import { recordSessionUsage, removeLiveUsage, writeLiveUsage } from "./usage.js"
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
	/** Checkpoints on/off (default true; actual use also requires an edit-capable executor). */
	checkpoints: boolean
	checkpointDir?: string
	/** Decision escalation timeout, ms (see HeadlessSessionConfig.decisionTimeoutMs). */
	decisionTimeoutMs?: number
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
			checkpoints: config.checkpoints ?? true,
			checkpointDir: config.checkpointDir,
			decisionTimeoutMs: config.decisionTimeoutMs,
		}

		this.llmClient = config.llmClient
		this.logger = config.logger ?? new Logger({ level: "info" })
		this.executor =
			config.executor ??
			createHeadlessExecutor(config.workspaceRoot, { decisionTimeoutMs: this.config.decisionTimeoutMs })
		this.sessionId = randomUUID()
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

	private async runIterations(budgetTracker: BudgetTracker, startedAt: string): Promise<SessionResult> {
		const { maxIterations, consecutiveErrorLimit } = this.config
		const messages = this.state.messages
		let consecutiveMistakes = 0
		let lastCallSignature: string | undefined
		let toolCalls = 0

		for (let iteration = 1; iteration <= maxIterations; iteration++) {
			this.logger.info(`[loop] iteration ${iteration}/${maxIterations}`, { history: messages.length })

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
					// Cost/token accounting (workstream 3): feed the provider's usage
					// tokens into the budget tracker unconditionally now (it always
					// exists — see `run()` — with no limits when no budget was
					// configured, so this only ever accumulates, never trips).
					if (response.usage) {
						this.totalInputTokens += response.usage.promptTokens ?? 0
						this.totalOutputTokens += response.usage.completionTokens ?? 0
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
					this.logger.info("[usage] running total", {
						iteration,
						costUsd: budgetTracker.totalCostUsd,
						iterations: budgetTracker.iterationCount,
						inputTokens: this.totalInputTokens,
						outputTokens: this.totalOutputTokens,
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
