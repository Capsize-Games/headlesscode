/**
 * Ollama-compatible local LLM client — implements the full `LlmClient`
 * interface (not the narrow read-only `LocalChatClient` in
 * src/engine/local-explore.ts) so a session's `code` mode can run entirely
 * against a local model instead of OpenRouter. See
 * plans/local-dual-model-code-agent.md (Phase 2 step 4) and
 * plans/local-code-mode-trial.md for the design this implements.
 *
 * Reuses the wire-format findings already verified live against Ollama
 * 0.24.0 / the local daemon's ollama-compat route in
 * src/engine/local-explore.ts's OllamaLocalChatClient:
 *   - `function.arguments` must be a parsed OBJECT on the wire in both
 *     directions (Ollama rejects the OpenAI/OpenRouter JSON-string form).
 *   - `think` previously had to be hardcoded `false`: a prior local model
 *     was observed leaving `message.content` empty and putting the reply in
 *     `message.thinking` when thinking was on. Re-verified live 2026-08-20
 *     against Qwen3-14B (the first thinking-capable local model this harness
 *     has run) on both a plain reply and a tool call — `content`/`tool_calls`
 *     came back correctly populated with `think: true`, so that failure mode
 *     doesn't reproduce for this model. Rather than flip the default (and
 *     risk the original model that motivated `false`), `think` is now
 *     configurable per client instance — see `OLLAMA_THINK_ENV`.
 * Cost is always $0 (no OpenRouter billing involved) but real token counts
 * are still reported via `usage` so budget/report accounting stays accurate.
 *
 * `node_id` continuity (found 2026-08-27 debugging a live daemon): the
 * airunnerdesktop daemon's `/api/chat` route is NOT actually stateless
 * despite implementing the Ollama wire protocol — `_get_or_create_conversation`
 * (conversation_management_mixin.py) opens a BRAND NEW, empty DB-backed
 * conversation on every call unless the request body carries a stable
 * `node_id` string, which this client never sent. Verified live: without
 * `node_id`, every call got a fresh `conversation_id` (confirmed via the
 * daemon's own logs incrementing 5912 -> 5913 one call apart) with zero
 * prior messages, so on any turn after the first — once the daemon's own
 * chat-template tries to render a multi-turn tool-calling exchange whose
 * "history" is actually empty — the underlying jinja2 chat template raises
 * `TemplateError: No user query found in messages` (the DB truly has no
 * user-role message, since only the single newest turn — a tool result,
 * not the original user turn — ever got attached to that fresh
 * conversation). One real request in isolation "works" (a fresh
 * conversation containing exactly the current user message renders fine),
 * which is why this was easy to misdiagnose as a context-window or
 * capability issue rather than a continuity bug. Sending a stable `node_id`
 * (generated once per `OllamaClient` instance, i.e. once per headlesscode
 * session) makes the daemon reuse the SAME conversation record across every
 * call in a session, matching how a real chat UI like uwuchat's own
 * LangChain-based client drives this same daemon successfully.
 */

import { randomUUID } from "node:crypto"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../engine/types.js"

export const OLLAMA_URL_ENV = "HEADLESSCODE_OLLAMA_URL"
export const DEFAULT_OLLAMA_URL = "http://localhost:11434"
export const DEFAULT_OLLAMA_TIMEOUT_MS = 300_000
/** Opt a thinking-capable local model into `think: true` (default false — see the module doc comment). */
export const OLLAMA_THINK_ENV = "HEADLESSCODE_OLLAMA_THINK"

export interface OllamaClientOptions {
	baseUrl?: string
	defaultModel?: string
	timeoutMs?: number
	fetchImpl?: typeof fetch
	/** Send `think: true` to the daemon (default false). See `OLLAMA_THINK_ENV`. */
	think?: boolean
	/** Override the `node_id` sent with every request (default: a fresh UUID per client instance). See the module doc comment. */
	nodeId?: string
}

/** Typed error for a non-2xx response or a malformed payload from the daemon. */
export class OllamaError extends Error {
	readonly status?: number
	readonly body?: string

	constructor(message: string, status?: number, body?: string) {
		super(message)
		this.name = "OllamaError"
		this.status = status
		this.body = body
	}
}

function envThinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env[OLLAMA_THINK_ENV]
	return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
}

export class OllamaClient implements LlmClient {
	private readonly baseUrl: string
	private readonly defaultModel: string
	private readonly timeoutMs: number
	private readonly fetchImpl: typeof fetch
	private readonly think: boolean
	/** Stable per-client identifier sent as `node_id` so a stateful daemon (e.g. airunnerdesktop) reuses one conversation for this session instead of a fresh, history-less one per call. See the module doc comment. */
	private readonly nodeId: string

	constructor(options: OllamaClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? process.env[OLLAMA_URL_ENV] ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "")
		this.defaultModel = options.defaultModel ?? ""
		this.timeoutMs = options.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS
		this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
		this.think = options.think ?? envThinkEnabled()
		this.nodeId = options.nodeId ?? randomUUID()
	}

	resolveModel(requestModel?: string): string {
		return requestModel?.trim() || this.defaultModel
	}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		const model = this.resolveModel(request.model)
		if (!model) {
			throw new OllamaError("OllamaClient: no model resolved (pass request.model or defaultModel)")
		}

		const controller = new AbortController()
		const onAbort = () => controller.abort()
		request.signal?.addEventListener("abort", onAbort)
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)

		try {
			const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({
					model,
					node_id: this.nodeId,
					messages: toOllamaMessages(request.messages),
					stream: false,
					think: this.think,
					tools: request.tools,
					...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
					options: {
						temperature: request.temperature ?? 0,
						...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
						...(request.repeatPenalty !== undefined ? { repeat_penalty: request.repeatPenalty } : {}),
					},
				}),
			})
			if (!res.ok) {
				const body = await res.text().catch(() => "")
				throw new OllamaError(`Ollama /api/chat returned HTTP ${res.status}: ${body.slice(0, 500)}`, res.status, body)
			}
			const data = (await res.json()) as {
				message?: {
					role?: string
					content?: string | null
					thinking?: string | null
					tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>
				}
				prompt_eval_count?: number
				eval_count?: number
			}
			if (!data.message) {
				throw new OllamaError("Ollama /api/chat response had no message field")
			}
			const toolCalls: ChatToolCall[] = (data.message.tool_calls ?? []).map((c, i) => ({
				id: c.id ?? `call_${i}`,
				type: "function" as const,
				function: {
					name: c.function?.name ?? "",
					arguments: normalizeToolCallArguments(c.function?.arguments),
				},
			}))
			const message: ChatMessage = {
				role: "assistant",
				content: data.message.content ?? null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
				...(data.message.thinking ? { reasoning: data.message.thinking } : {}),
			}
			return {
				message,
				usage: {
					promptTokens: data.prompt_eval_count ?? 0,
					completionTokens: data.eval_count ?? 0,
					totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
				},
			}
		} catch (err) {
			if (err instanceof OllamaError) {
				throw err
			}
			if (err instanceof Error && err.name === "AbortError") {
				throw new OllamaError(`Ollama /api/chat timed out after ${this.timeoutMs}ms`)
			}
			throw new OllamaError(
				`Ollama /api/chat request failed: ${err instanceof Error ? err.message : String(err)} (is the daemon running at ${this.baseUrl}? is ${model} loaded?)`,
			)
		} finally {
			clearTimeout(timer)
			request.signal?.removeEventListener("abort", onAbort)
		}
	}
}

/** Engine ChatMessage[] → Ollama wire format (tool_call arguments as OBJECTS, tool schemas untouched). */
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
		try {
			JSON.parse(args)
			return args
		} catch {
			return JSON.stringify({ raw: args })
		}
	}
	return JSON.stringify(args ?? {})
}
