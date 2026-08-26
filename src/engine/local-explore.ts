/**
 * Opt-in LOCAL EXPLORATION PHASE (default OFF) — plans/local-explore-phase-experiment.md.
 *
 * A bounded, strictly read-only local-model pass that runs BEFORE the cloud
 * model's first turn: a local Ollama model (default qwen3.5:9b) gets a
 * chance to explore the repository with a deliberately narrowed tool set
 * (read_file + list_files + codebase_search — no execute_command, no write
 * tools). codebase_search was originally excluded because the two-phase
 * design avoids co-resident VRAM: the exploration model AND a local
 * embedding model can't share limited VRAM. But the actually-deployed
 * embedder is cloud-side (OpenRouter, qwen/qwen3-embedding-4b — see
 * src/codesearch/cli.ts), NOT local Ollama, so codebase_search touches no
 * local VRAM at all and is safe in the local phase (2026-08-04). When the
 * phase concludes, its transcript is folded into the cloud session's initial
 * context as a clearly-labeled synthetic message and the cloud model takes
 * over completely.
 *
 * The phase is bounded by BOTH an iteration cap and a context-token budget
 * (the measured safe solo-model VRAM ceiling at the configured num_ctx — see
 * the plans doc's live-measured table). Token estimation reuses
 * `estimateMessageChars` from condense.ts (4 chars/token — conservative, so
 * we stop BEFORE the real ceiling, not after).
 *
 * FAIL-OPEN CONTRACT: `runLocalExplorePhase` NEVER throws. Any local-model
 * error (Ollama unreachable, malformed response, model not pulled, ...)
 * returns a result with `terminatedBy: "error"` and a null handoff — the
 * caller then proceeds exactly as today (cloud-only). A broken experimental
 * feature must never be able to break a real session. This mirrors the
 * non-fatal-degradation idiom used for memory/checkpoints in loop.ts.
 */

import { createLocalExploreExecutor } from "../tools/executor.js"
import { DEFAULT_OLLAMA_URL, OLLAMA_URL_ENV } from "../tools/output-summarizer.js"
import { getNativeTools } from "../vendor/zoo-code/src/core/prompts/tools/native-tools/index.js"
import { estimateMessageChars } from "./condense.js"
import { Logger } from "./logger.js"
import { parseToolCall } from "./parser.js"
import type { ChatMessage, ChatTool, ChatToolCall, ToolResult } from "./types.js"

// ─── Configuration (env-var resolvable, like output-summarizer.ts) ─────────

/** Gate env var — HEADLESSCODE_LOCAL_EXPLORE=1 enables the phase (also --local-explore). */
export const LOCAL_EXPLORE_ENV = "HEADLESSCODE_LOCAL_EXPLORE"
/** Local model used for the exploration phase. */
export const LOCAL_EXPLORE_MODEL_ENV = "HEADLESSCODE_LOCAL_EXPLORE_MODEL"
export const DEFAULT_LOCAL_EXPLORE_MODEL = "qwen3.5:9b"
/**
 * Iteration cap (default 15). Justification: each iteration is one local
 * model call (a few seconds warm) + one or more read tool executions. 15
 * calls is comfortably enough for a real exploration arc — list the tree,
 * read the entry point, follow references — while guaranteeing the phase
 * always terminates in well under a minute of warm inference even if the
 * model never calls attempt_completion. The context budget below is the
 * hard safety net that actually protects VRAM; this cap bounds TIME.
 */
export const LOCAL_EXPLORE_MAX_ITERATIONS_ENV = "HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS"
export const DEFAULT_LOCAL_EXPLORE_MAX_ITERATIONS = 15
/**
 * Context-token budget (default 131,072 = the measured safe solo-model
 * ceiling). Live-measured on the project owner's RTX 5080 (16GB), Ollama
 * 0.24.0 with OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0:
 * num_ctx 131,072 → ~12GB VRAM for qwen3.5:9b alone, leaving ~4GB headroom
 * on the card. 262,144 (nominal max) is 17GB → CPU spillover, not usable.
 * This is a HARD constraint (the phase stops before a request would exceed
 * it), not a soft default. Verified live 2026-08-02; re-verify with `ollama
 * ps` if driver/Ollama versions shift.
 */
export const LOCAL_EXPLORE_CONTEXT_TOKENS_ENV = "HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS"
export const DEFAULT_LOCAL_EXPLORE_CONTEXT_TOKENS = 131_072
/** Per-call HTTP timeout, ms. */
export const LOCAL_EXPLORE_TIMEOUT_MS_ENV = "HEADLESSCODE_LOCAL_EXPLORE_TIMEOUT_MS"
export const DEFAULT_LOCAL_EXPLORE_TIMEOUT_MS = 120_000
/** Max output tokens (num_predict) per local call — tool decisions are short. */
export const DEFAULT_LOCAL_EXPLORE_MAX_TOKENS = 2048
/** Consecutive mistakes (empty replies / failed tool calls) before the phase gives up. */
export const LOCAL_EXPLORE_MISTAKE_LIMIT = 3
/**
 * Cap on the rendered handoff transcript fed to the cloud model (chars).
 * The transcript is a DIGEST of the exploration record — each tool result is
 * truncated to LOCAL_EXPLORE_TOOL_RESULT_TRANSCRIPT_CHARS (below), so a
 * session's handoff is a few KB, not a verbatim file dump. This is
 * deliberate: the cloud model can re-read any file itself (read_file /
 * codebase_search) at lower effective cost than paying ~4 chars/token for
 * raw source it mostly does not need, and the cloud-side input-token bill is
 * exactly what the "free local exploration" cost story must not blow up.
 * Verbatim tool output still lives in the phase's OWN context — the phase's
 * loop uses full results, only the rendered handoff is bounded. Kept as a
 * digest rather than an LLM summarization pass: summarization risks
 * needle-loss (see plans/local-output-summarization.md) and costs latency.
 */
export const MAX_HANDOFF_CHARS = 12_000
/**
 * Per-tool-result cap in the rendered handoff transcript (chars). Long
 * enough to keep the read_file header ("File: X, Showing lines A-B of Y")
 * plus a hint of the body — the verification anchor the cloud model needs —
 * without the bulk.
 */
export const LOCAL_EXPLORE_TOOL_RESULT_TRANSCRIPT_CHARS = 400
/** Chars per estimated token — conservative (lower than the ~8 English rule of thumb) so we stop early, not late. */
export const CHARS_PER_TOKEN = 4

// ─── Types ──────────────────────────────────────────────────────────────────

export type LocalExploreTermination =
	| "attempt_completion"
	| "text-only-reply"
	| "iteration-cap"
	| "context-budget"
	| "error"

export interface LocalExploreOptions {
	workspaceRoot: string
	/** The session task text — also the local phase's mission statement. */
	taskText?: string
	/** Local model id (default env HEADLESSCODE_LOCAL_EXPLORE_MODEL or qwen3.5:9b). */
	model?: string
	/** Ollama base URL (default env HEADLESSCODE_OLLAMA_URL or http://localhost:11434). */
	baseUrl?: string
	/** Iteration cap (default HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS or 15). */
	maxIterations?: number
	/** Context-token budget (default HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS or 131072). */
	contextTokens?: number
	/** Per-call timeout ms (default HEADLESSCODE_LOCAL_EXPLORE_TIMEOUT_MS or 120s). */
	timeoutMs?: number
	/** Max output tokens per local call (default 2048). */
	maxTokens?: number
	/** Handoff transcript cap in chars (default MAX_HANDOFF_CHARS). */
	maxHandoffChars?: number
	logger?: Logger
	/** Injectable chat client (tests use a fake; default: real Ollama client). */
	client?: LocalChatClient
	/** Injectable executor (tests; default: createLocalExploreExecutor(root)). */
	executor?: ReturnType<typeof createLocalExploreExecutor>
	/** Injectable fetch (tests; default: global fetch). */
	fetchImpl?: typeof fetch
	/** System prompt override (tests; default EXPLORE_SYSTEM_PROMPT). */
	systemPrompt?: string
}

export interface LocalExploreResult {
	/** Why the phase ended. "error" = fail open, no handoff (cloud proceeds as today). */
	terminatedBy: LocalExploreTermination
	/** Number of model calls actually made. */
	iterations: number
	/** The full local transcript: [system, user(task), assistant, tool, ...]. */
	messages: ChatMessage[]
	/** Estimated prompt tokens of the final transcript (chars/4). */
	estimatedPromptTokens: number
	/** Human-readable termination detail (e.g. the error message). */
	detail?: string
	/**
	 * The synthetic cloud-context message to fold into the cloud session, or
	 * null when the phase produced nothing usable (fail open → cloud-only).
	 */
	handoffMessage: ChatMessage | null
}

/** Request shape for a local chat call. */
export interface LocalExploreRequest {
	model: string
	messages: ChatMessage[]
	tools: ChatTool[]
	numCtx: number
	maxTokens: number
	signal?: AbortSignal
}

export interface LocalChatResponse {
	/** Assistant message in engine format (tool_call arguments as JSON strings). */
	message: ChatMessage
	usage: { promptTokens: number; completionTokens: number }
}

export interface LocalChatClient {
	chat(request: LocalExploreRequest): Promise<LocalChatResponse>
}

/** Any local-chat failure — thrown by the client, caught inside runLocalExplorePhase. */
export class LocalExploreError extends Error {}

// ─── The local exploration loop ─────────────────────────────────────────────

/**
 * Run the bounded local exploration phase. NEVER throws: every failure mode
 * (Ollama down, malformed response, timeout, model not pulled) returns a
 * result with `terminatedBy: "error"` and a null handoff so the caller fails
 * open to today's cloud-only behavior.
 */
export async function runLocalExplorePhase(options: LocalExploreOptions): Promise<LocalExploreResult> {
	const logger = options.logger ?? new Logger()
	const model = options.model ?? resolveLocalExploreModel(process.env)
	const baseUrl = options.baseUrl ?? resolveOllamaUrl(process.env)
	const maxIterations = options.maxIterations ?? resolveLocalExploreMaxIterations(process.env)
	const contextTokens = options.contextTokens ?? resolveLocalExploreContextTokens(process.env)
	const timeoutMs = options.timeoutMs ?? resolveLocalExploreTimeoutMs(process.env)
	const maxTokens = options.maxTokens ?? DEFAULT_LOCAL_EXPLORE_MAX_TOKENS
	const maxHandoffChars = options.maxHandoffChars ?? MAX_HANDOFF_CHARS

	const client = options.client ?? new OllamaLocalChatClient({ baseUrl, timeoutMs, fetchImpl: options.fetchImpl })
	const executor = options.executor ?? createLocalExploreExecutor(options.workspaceRoot)
	const tools = buildLocalExploreTools()
	const systemPrompt = options.systemPrompt ?? EXPLORE_SYSTEM_PROMPT

	const messages: ChatMessage[] = [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: options.taskText ?? "Explore this repository and gather the context needed to complete the task." },
	]

	let mistakes = 0
	let iterations = 0
	let terminatedBy: LocalExploreTermination = "iteration-cap"
	let detail: string | undefined

	logger.info("[local-explore] phase start", { model, baseUrl, maxIterations, contextTokens })

	for (; iterations < maxIterations; iterations++) {
		// Context-budget gate: stop BEFORE a request would exceed the ceiling.
		const estimated = estimatePromptTokens(messages)
		if (estimated > contextTokens) {
			terminatedBy = "context-budget"
			detail = `estimated ${estimated} prompt tokens exceeds the ${contextTokens}-token budget`
			logger.warn("[local-explore] context budget reached — stopping", { estimated, contextTokens })
			break
		}

		let response: LocalChatResponse
		try {
			response = await client.chat({ model, messages, tools, numCtx: contextTokens, maxTokens })
		} catch (err) {
			logger.warn(`[local-explore] local model call failed — failing open to cloud-only: ${err instanceof Error ? err.message : String(err)}`)
			return {
				terminatedBy: "error",
				iterations,
				messages,
				estimatedPromptTokens: estimatePromptTokens(messages),
				detail: err instanceof Error ? err.message : String(err),
				handoffMessage: null,
			}
		}

		const assistant = response.message
		messages.push(assistant)

		// The explicit "I'm done exploring, hand off" signal. Distinct from
		// actually completing the task: the local phase is read-only, and the
		// cloud model still does the real work.
		const completionCall = (assistant.tool_calls ?? []).find((c) => c.function.name === "attempt_completion")
		if (completionCall) {
			terminatedBy = "attempt_completion"
			detail = extractCompletionResult(completionCall)
			logger.info("[local-explore] local model signaled completion", { iterations: iterations + 1 })
			break
		}

		const calls = (assistant.tool_calls ?? []).filter((c) => c.function.name !== "attempt_completion")

		if (calls.length === 0) {
			// Text-only reply (non-empty): the model handed its findings back
			// directly — treat it as the exploration result.
			if (assistant.content && assistant.content.trim().length > 0) {
				terminatedBy = "text-only-reply"
				logger.info("[local-explore] local model replied with text (no tool call)", { iterations: iterations + 1 })
				break
			}
			// Empty reply: nudge, like the main loop does. Repeated empties are
			// a local-model failure — abandon the phase (fail open).
			mistakes += 1
			if (mistakes >= LOCAL_EXPLORE_MISTAKE_LIMIT) {
				terminatedBy = "error"
				detail = `local model produced ${mistakes} consecutive empty replies`
				logger.warn(`[local-explore] ${detail}`)
				break
			}
			messages.push({
				role: "user",
				content: "[System: your last response contained no tool calls and no text. Continue exploring: call read_file or list_files, or call attempt_completion when you have enough context.]",
			})
			continue
		}

		// Execute every tool call and feed the results back.
		for (const call of calls) {
			let result: ToolResult
			try {
				result = await executor.execute(call.function.name, parseToolCall(call).args)
			} catch (err) {
				result = { content: `[Error] ${err instanceof Error ? err.message : String(err)}`, isError: true }
			}
			if (result.isError) {
				mistakes += 1
			}
			messages.push({
				role: "tool",
				content: result.content,
				tool_call_id: call.id,
				name: call.function.name,
			})
		}

		// A single huge tool result (e.g. a 30K-char read) can jump the budget
		// even though the request that triggered it was under it — stop before
		// any NEXT request would exceed the ceiling.
		const afterTools = estimatePromptTokens(messages)
		if (afterTools > contextTokens) {
			terminatedBy = "context-budget"
			detail = `estimated ${afterTools} prompt tokens exceeds the ${contextTokens}-token budget after tool results`
			logger.warn("[local-explore] context budget reached after tool results — stopping", { estimated: afterTools, contextTokens })
			break
		}
	}

	if (terminatedBy === "iteration-cap" && iterations >= maxIterations) {
		detail = `iteration cap (${maxIterations}) reached`
		logger.info(`[local-explore] ${detail}`)
	}

	const result: LocalExploreResult = {
		terminatedBy,
		iterations,
		messages,
		estimatedPromptTokens: estimatePromptTokens(messages),
		detail,
		handoffMessage: null,
	}
	result.handoffMessage = buildLocalExploreHandoffMessage(result, maxHandoffChars)
	logger.info("[local-explore] phase end", { terminatedBy, iterations: result.iterations, estimatedPromptTokens: result.estimatedPromptTokens })
	return result
}

// ─── Handoff ────────────────────────────────────────────────────────────────

/** Extract the completion result text from an attempt_completion call. */
function extractCompletionResult(call: ChatToolCall): string {
	try {
		const args = JSON.parse(call.function.arguments) as { result?: unknown }
		if (typeof args.result === "string" && args.result.trim()) {
			return args.result
		}
		return JSON.stringify(args)
	} catch {
		return call.function.arguments
	}
}

/**
 * Build the clearly-labeled synthetic message folded into the cloud session's
 * initial context. Returns null when there is nothing usable to hand off —
 * i.e. the phase failed (fail open → cloud-only) or gathered no activity
 * beyond the seed messages.
 */
export function buildLocalExploreHandoffMessage(
	result: Pick<LocalExploreResult, "terminatedBy" | "iterations" | "messages" | "detail">,
	maxHandoffChars = MAX_HANDOFF_CHARS,
): ChatMessage | null {
	if (result.terminatedBy === "error") {
		return null
	}
	const transcript = renderTranscript(result.messages, maxHandoffChars)
	if (!transcript) {
		return null
	}
	const reason = terminationReason(result)
	const header = `[Local exploration phase — a separate LOCAL model (read-only, could call read_file, list_files and codebase_search: no commands, no writes) ran a pre-pass on this repository BEFORE your first turn. This is NOT your own prior work. Treat its file claims as a starting point to verify, not ground truth. The phase stopped because: ${reason}.]`
	const footer = "=== END LOCAL EXPLORATION TRANSCRIPT ==="
	return {
		role: "user",
		content: `${header}\n\n=== LOCAL EXPLORATION TRANSCRIPT ===\n${transcript}\n${footer}`,
	}
}

function terminationReason(result: Pick<LocalExploreResult, "terminatedBy" | "iterations" | "detail">): string {
	switch (result.terminatedBy) {
		case "attempt_completion":
			return "the local model decided it had enough context"
		case "text-only-reply":
			return "the local model replied directly with its findings"
		case "iteration-cap":
			return `iteration cap (${result.iterations}) reached`
		case "context-budget":
			return result.detail ?? "its context budget was reached"
		default:
			return result.detail ?? result.terminatedBy
	}
}

/**
 * Render the exploration activity into a compact transcript. Skips the seed
 * system + user task messages (the cloud history already carries the task) —
 * only the model's calls, tool results and final reply are included. Capped
 * at maxHandoffChars with a truncation marker.
 */
function renderTranscript(messages: ChatMessage[], maxHandoffChars: number): string {
	const lines: string[] = []
	for (let i = 2; i < messages.length; i++) {
		lines.push(renderMessage(messages[i]))
	}
	if (lines.length === 0) {
		return ""
	}
	let out = lines.join("\n")
	if (out.length > maxHandoffChars) {
		out = `${out.slice(0, maxHandoffChars)}\n...[transcript truncated at ${maxHandoffChars} chars]`
	}
	return out
}

function renderMessage(m: ChatMessage): string {
	switch (m.role) {
		case "assistant":
			if (m.tool_calls && m.tool_calls.length > 0) {
				return m.tool_calls
					.map((c) => {
						if (c.function.name === "attempt_completion") {
							return `[local model] attempt_completion: ${extractCompletionResult(c)}`
						}
						return `[local model] called ${c.function.name}(${c.function.arguments})`
					})
					.join("\n")
			}
			return `[local model] ${m.content ?? ""}`
		case "tool": {
			const body = m.content ?? ""
			const shown = body.length > LOCAL_EXPLORE_TOOL_RESULT_TRANSCRIPT_CHARS
				? `${body.slice(0, LOCAL_EXPLORE_TOOL_RESULT_TRANSCRIPT_CHARS)}\n…[tool result truncated in handoff at ${LOCAL_EXPLORE_TOOL_RESULT_TRANSCRIPT_CHARS} chars — re-read the file yourself to verify]`
				: body
			return `[tool result for ${m.name ?? m.tool_call_id ?? "?"}] ${shown}`
		}
		default:
			return `[${m.role}] ${m.content ?? ""}`
	}
}

// ─── Ollama client ──────────────────────────────────────────────────────────

/**
 * Ollama /api/chat client. WIRE-FORMAT NOTE (verified live 2026-08-02 against
 * Ollama 0.24.0 + qwen3.5:9b): Ollama wants `function.arguments` as a parsed
 * OBJECT in BOTH outgoing history and the response — the JSON-string form that
 * OpenAI/OpenRouter use makes Ollama reject the request with "Value looks like
 * object, but can't find closing '}' symbol". So:
 *   - outgoing: engine ChatToolCall.arguments (JSON string) → parsed object;
 *   - incoming: Ollama's object arguments → engine ChatToolCall.arguments
 *     (JSON string), so the rest of the harness (parseToolCall etc.) works
 *     unchanged.
 * qwen3-class models also reason by default and leave message.content empty —
 * we send `think: false` (same verified finding as output-summarizer.ts).
 */
export class OllamaLocalChatClient implements LocalChatClient {
	private readonly baseUrl: string
	private readonly timeoutMs: number
	private readonly fetchImpl: typeof fetch

	constructor(options: { baseUrl: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "")
		this.timeoutMs = options.timeoutMs ?? DEFAULT_LOCAL_EXPLORE_TIMEOUT_MS
		this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
	}

	async chat(request: LocalExploreRequest): Promise<LocalChatResponse> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)
		try {
			const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({
					model: request.model,
					messages: toOllamaMessages(request.messages),
					stream: false,
					think: false,
					tools: request.tools,
					options: {
						num_ctx: request.numCtx,
						num_predict: request.maxTokens,
						temperature: 0,
					},
				}),
			})
			if (!res.ok) {
				const body = await res.text().catch(() => "")
				throw new LocalExploreError(`Ollama /api/chat returned HTTP ${res.status}: ${body.slice(0, 500)}`)
			}
			const data = (await res.json()) as {
				message?: {
					role?: string
					content?: string | null
					tool_calls?: Array<{
						id?: string
						function?: { name?: string; arguments?: unknown }
					}>
				}
				prompt_eval_count?: number
				eval_count?: number
			}
			if (!data.message) {
				throw new LocalExploreError("Ollama /api/chat response had no message field")
			}
			return {
				message: {
					role: "assistant",
					content: data.message.content ?? null,
					tool_calls: (data.message.tool_calls ?? []).map((c, i) => ({
						id: c.id ?? `call_${i}`,
						type: "function" as const,
						function: {
							name: c.function?.name ?? "",
							arguments: normalizeToolCallArguments(c.function?.arguments),
						},
					})),
				},
				usage: {
					promptTokens: data.prompt_eval_count ?? 0,
					completionTokens: data.eval_count ?? 0,
				},
			}
		} catch (err) {
			if (err instanceof LocalExploreError) {
				throw err
			}
			if (err instanceof Error && err.name === "AbortError") {
				throw new LocalExploreError(`Ollama /api/chat timed out after ${this.timeoutMs}ms`)
			}
			throw new LocalExploreError(
				`Ollama /api/chat request failed: ${err instanceof Error ? err.message : String(err)} (is Ollama running at ${this.baseUrl}? is ${request.model} pulled?)`,
			)
		} finally {
			clearTimeout(timer)
		}
	}
}

/** Engine ChatMessage[] → Ollama wire format (tool_call arguments as OBJECTS). */
function toOllamaMessages(messages: ChatMessage[]): unknown[] {
	return messages.map((m) => {
		if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
			return {
				role: "assistant",
				content: m.content ?? "",
				tool_calls: m.tool_calls.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.function.name, arguments: toOllamaArgs(c.function.arguments) },
				})),
			}
		}
		if (m.role === "tool") {
			return { role: "tool", content: m.content ?? "", tool_call_id: m.tool_call_id, name: m.name }
		}
		return { role: m.role, content: m.content ?? "" }
	})
}

/** Engine arguments JSON string → Ollama object. Parse failure → {} (Ollama rejects strings here). */
function toOllamaArgs(args: string): unknown {
	try {
		return JSON.parse(args)
	} catch {
		return {}
	}
}

/** Ollama arguments (object, or occasionally string) → engine JSON-string form. */
function normalizeToolCallArguments(args: unknown): string {
	if (typeof args === "string") {
		// Already a JSON string (some models return it stringified) — keep it
		// parseable by the harness's parseToolCall.
		try {
			JSON.parse(args)
			return args
		} catch {
			return JSON.stringify({ raw: args })
		}
	}
	return JSON.stringify(args ?? {})
}

// ─── Tools + prompt ─────────────────────────────────────────────────────────

/**
 * The local phase's tool schemas: read_file, list_files, codebase_search,
 * attempt_completion — taken from the vendored native-tool definitions so the
 * schema matches what the cloud model sees. codebase_search is included even
 * though the phase is local because its embedding call is cloud-side
 * (OpenRouter), not local Ollama — it consumes no local VRAM (see the
 * file-top comment). Everything else is deliberately absent (the executor
 * stubs it if called anyway).
 */
export function buildLocalExploreTools(): ChatTool[] {
	const names = new Set(["read_file", "list_files", "codebase_search", "attempt_completion"])
	return getNativeTools()
		.filter((t) => t.type === "function" && names.has(t.function.name))
		.map((t) => t as unknown as ChatTool)
}

export const EXPLORE_SYSTEM_PROMPT = `You are a LOCAL, read-only repository exploration agent. You run BEFORE the main coding model's turn: your ONLY job is to gather context that will help the main model complete the task. You never implement anything.

Available tools:
- read_file — read a file (path is relative to the workspace root).
- list_files — list files/directories (path is relative to the workspace root; recursive: true for a full tree).
- codebase_search — semantic search over the indexed codebase (a query describing what you need; returns matching file excerpts). Use it for targeted search instead of blind tree-walking.
- attempt_completion — call this when you have gathered ENOUGH context. Its result argument is your exploration report: what you found, which files are relevant and why. This does NOT complete the task — it hands off to the main model.

Rules:
- Read-only: you cannot write files or run commands. You may use read_file, list_files and codebase_search only.
- Prefer codebase_search for targeted lookups ("where is X?" / "how does Y work?") over recursively listing and reading whole trees.
- Do not fabricate file contents or paths. Report exactly what the tools return. If a read fails, say so.
- Explore purposefully: list the top level first, then drill into the directories and files that matter for the task. Prefer reading the actual entry points (package.json, src/index.ts, README) before guessing.
- When you have enough context to hand the main model a focused map of the relevant code, call attempt_completion with your findings. If you cannot make progress, call attempt_completion anyway with what you have — never loop forever.`

// ─── Env resolution (mirrors output-summarizer.ts's pattern) ────────────────

export function isLocalExploreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env[LOCAL_EXPLORE_ENV]
	return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
}

export function resolveLocalExploreModel(env: NodeJS.ProcessEnv = process.env): string {
	return env[LOCAL_EXPLORE_MODEL_ENV]?.trim() || DEFAULT_LOCAL_EXPLORE_MODEL
}

export function resolveOllamaUrl(env: NodeJS.ProcessEnv = process.env): string {
	return env[OLLAMA_URL_ENV]?.trim() || DEFAULT_OLLAMA_URL
}

export function resolveLocalExploreMaxIterations(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInt(env[LOCAL_EXPLORE_MAX_ITERATIONS_ENV], DEFAULT_LOCAL_EXPLORE_MAX_ITERATIONS, LOCAL_EXPLORE_MAX_ITERATIONS_ENV)
}

export function resolveLocalExploreContextTokens(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInt(env[LOCAL_EXPLORE_CONTEXT_TOKENS_ENV], DEFAULT_LOCAL_EXPLORE_CONTEXT_TOKENS, LOCAL_EXPLORE_CONTEXT_TOKENS_ENV)
}

export function resolveLocalExploreTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInt(env[LOCAL_EXPLORE_TIMEOUT_MS_ENV], DEFAULT_LOCAL_EXPLORE_TIMEOUT_MS, LOCAL_EXPLORE_TIMEOUT_MS_ENV)
}

function parsePositiveInt(raw: string | undefined, fallback: number, envName: string): number {
	if (raw === undefined || raw.trim() === "") {
		return fallback
	}
	const n = Number(raw)
	if (!Number.isInteger(n) || n <= 0) {
		throw new LocalExploreError(`${envName} must be a positive integer, got "${raw}"`)
	}
	return n
}

/** Estimated prompt tokens for a message list (reuses condense.ts's estimator). */
export function estimatePromptTokens(messages: ChatMessage[]): number {
	const chars = messages.reduce((sum, m) => sum + estimateMessageChars(m), 0)
	return Math.ceil(chars / CHARS_PER_TOKEN)
}
