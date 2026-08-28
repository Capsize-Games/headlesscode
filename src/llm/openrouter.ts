/**
 * OpenRouter client.
 *
 * Uses the native `fetch` API (Node >= 18) — no axios / node-fetch / openai SDK.
 *
 * Chat completions:  POST {OPENROUTER_BASE_URL}/api/v1/chat/completions
 * Embeddings:        POST {OPENROUTER_BASE_URL}/api/v1/embeddings
 *   - Base URL override: OPENROUTER_BASE_URL env var (default
 *     https://openrouter.ai) — lets tests/proxies point the client at a mock
 *     server (e.g. http://127.0.0.1:<port>).
 *   - Authorization: Bearer <HEADLESSCODE_OPENROUTER_API_KEY>
 *   - Optional headers from env: HTTP-Referer (OPENROUTER_HTTP_REFERER),
 *     X-Title (OPENROUTER_APP_TITLE) — recommended by OpenRouter for
 *     identifying the app and enabling higher rate limits.
 *
 * Chat model resolution order (per request): `request.model` → constructor
 * `defaultModel` → `OPENROUTER_MODEL` env var → `deepseek/deepseek-v4-flash-0731`.
 */

import type {
	LlmClient,
	LlmRequest,
	LlmResponse,
	ChatMessage,
	ChatTool,
	ChatToolCall,
} from "../engine/types.js"
import { parseEndpointPricing, type EndpointPricingEntry, type ModelPrice } from "../budget/cost.js"
import { captureTranscript, isTranscriptCaptureEnabled } from "./transcript-capture.js"

export const OPENROUTER_BASE_URL = "https://openrouter.ai"
export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731"

export interface OpenRouterClientOptions {
	apiKey?: string
	baseUrl?: string
	defaultModel?: string
	httpReferer?: string
	appTitle?: string
}

/** Typed error for non-2xx responses or malformed payloads. */
export class OpenRouterError extends Error {
	readonly status?: number
	readonly body?: string

	constructor(message: string, status?: number, body?: string) {
		super(message)
		this.name = "OpenRouterError"
		this.status = status
		this.body = body
	}
}

/**
 * Whether a `createChatCompletion` failure is worth ONE retry rather than
 * failing the caller outright. Observed live (issue: harness provider-error
 * resilience, 2026-08-08): a hard-pinned model (`allow_fallbacks: false`,
 * see buildRequestBody's deepseek/* pin) has NO fallback to smooth over a
 * blip on that one provider, so a transient hiccup that a normal
 * multi-provider request would silently route around instead kills the
 * request outright. Two shapes seen in one session:
 *   - HTTP 404 "No allowed providers are available for the selected model"
 *     — despite the 4xx status this is an AVAILABILITY signal (the pinned
 *     provider is temporarily down), not a real "this model/slug doesn't
 *     exist" error, which is the normal meaning of 404 elsewhere in this
 *     client (see fetchModelContextWindow's comment) — so it's retryable
 *     here specifically, by message content, not by status code alone.
 *   - HTTP 520 "Provider returned error" — an opaque upstream failure,
 *     retryable like any 5xx.
 * Also retryable: 429 (rate limit) and network-transport failures (thrown
 * with no `.status` — see the network-error catch below). NOT retryable:
 * any other 4xx (auth failure, malformed request, unknown model) — those
 * are deterministic and retrying would just fail the same way again.
 */
export function isRetryableOpenRouterError(error: unknown): boolean {
	if (!(error instanceof OpenRouterError)) {
		return false
	}
	if (error.status === undefined) {
		return true // network/transport failure — see the catch in createChatCompletion
	}
	if (error.status === 429 || error.status >= 500) {
		return true
	}
	return error.status === 404 && /no allowed providers/i.test(error.message)
}

/**
 * One embedding vector plus the model used to produce it (OpenRouter echoes
 * the resolved model id on the response envelope).
 */
export interface OpenRouterEmbedding {
	model: string
	/** One embedding per input string, in request order. */
	embeddings: number[][]
	/** Total prompt tokens consumed across all inputs in the request. */
	promptTokens: number
	/** Total tokens (prompt + completion; embeddings have no completion tokens). */
	totalTokens: number
}

/**
 * A shared HTTP helper: both the chat-completions and embeddings methods hit
 * the same base URL with the same auth/app-identification headers, and share
 * the same "surface the raw body, don't collapse 200-with-error-envelope into
 * an uninformative message" error philosophy (see createChatCompletion).
 */
export class OpenRouterClient implements LlmClient {
	private readonly apiKey: string | undefined
	private readonly baseUrl: string
	private readonly defaultModel: string
	private readonly httpReferer?: string
	private readonly appTitle?: string

	constructor(options: OpenRouterClientOptions = {}) {
		this.apiKey = options.apiKey ?? process.env.HEADLESSCODE_OPENROUTER_API_KEY
		this.baseUrl = (options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")
		this.defaultModel = options.defaultModel ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL
		this.httpReferer = options.httpReferer ?? process.env.OPENROUTER_HTTP_REFERER
		this.appTitle = options.appTitle ?? process.env.OPENROUTER_APP_TITLE
	}

	/**
	 * Resolve the model id to use for a request. The per-request model wins,
	 * then the client default (which itself falls back to env + built-in).
	 */
	resolveModel(requestModel?: string): string {
		return requestModel?.trim() || this.defaultModel
	}

	/** Shared request headers: auth + the app-identification pair OpenRouter recommends. */
	private authHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey ?? ""}`,
			"Content-Type": "application/json",
		}
		if (this.httpReferer) {
			headers["HTTP-Referer"] = this.httpReferer
		}
		if (this.appTitle) {
			headers["X-Title"] = this.appTitle
		}
		return headers
	}

	/**
	 * Embed a batch of text chunks via OpenRouter's embeddings endpoint.
	 *
	 * The API accepts an ARRAY of inputs in one call (verified live 2026-08-01:
	 * N inputs → N embeddings in a single request, with `usage.prompt_tokens`
	 * summed across all inputs), so a whole repo's chunk batch is sent as one
	 * HTTP request instead of one call per chunk. Embedding models are NOT in
	 * OpenRouter's public `/api/v1/models` listing, but the endpoint is live —
	 * see src/codesearch/embedder.ts's header comment for the full findings.
	 *
	 * `options.provider` (when given) pins routing via `extra_body.provider`
	 * (OpenRouter's `{"order": [...], "allow_fallbacks": bool}` convention,
	 * same shape buildRequestBody uses for the deepseek/* chat pin).
	 */
	async embed(
		inputs: string[],
		model: string,
		options: { signal?: AbortSignal; provider?: { order?: string[]; allowFallbacks?: boolean } } = {},
	): Promise<OpenRouterEmbedding> {
		const { signal, provider } = options
		if (!this.apiKey) {
			throw new OpenRouterError(
				"HEADLESSCODE_OPENROUTER_API_KEY is not set. Set the environment variable HEADLESSCODE_OPENROUTER_API_KEY (or pass apiKey to OpenRouterClient).",
			)
		}
		if (inputs.length === 0) {
			return { model, embeddings: [], promptTokens: 0, totalTokens: 0 }
		}

		const url = `${this.baseUrl}/api/v1/embeddings`
		const body: Record<string, unknown> = { model, input: inputs }
		if (provider) {
			body.provider = provider
		}

		let response: Response
		try {
			response = await fetch(url, {
				method: "POST",
				headers: this.authHeaders(),
				body: JSON.stringify(body),
				signal,
			})
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw err // caller-managed abort
			}
			throw new OpenRouterError(
				`Network error calling OpenRouter embeddings: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		if (!response.ok) {
			const rawBody = await response.text().catch(() => "")
			const excerpt = rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
			throw new OpenRouterError(
				`OpenRouter embeddings returned HTTP ${response.status}: ${excerpt}`,
				response.status,
				excerpt,
			)
		}

		// Same raw-body-first discipline as chat completions: 200 does not
		// guarantee a well-formed data[] payload.
		const rawBody = await response.text()
		let data:
			| {
					data?: Array<{ embedding?: number[] | string }>
					usage?: RawUsage
					error?: { message?: string; code?: unknown }
			  }
			| undefined
		try {
			data = JSON.parse(rawBody)
		} catch {
			const excerpt = rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
			throw new OpenRouterError(
				`OpenRouter embeddings returned HTTP 200 with a non-JSON/unparseable body: ${excerpt || "(empty)"}`,
			)
		}

		if (data?.error) {
			throw new OpenRouterError(
				`OpenRouter embeddings returned HTTP 200 with an error envelope: ${data.error.message ?? JSON.stringify(data.error)}`,
			)
		}

		if (!data?.data || data.data.length !== inputs.length) {
			const excerpt = rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
			throw new OpenRouterError(
				`OpenRouter embeddings response contained ${data?.data?.length ?? 0} embeddings for ${inputs.length} inputs. Raw body: ${excerpt || "(empty)"}`,
			)
		}

		const embeddings = data.data.map((item) => {
			if (typeof item.embedding === "string") {
				// base64-encoded float32 vector (some models/providers return this
				// when requested or by default) — decode rather than storing a string.
				const buf = Buffer.from(item.embedding, "base64")
				const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
				return Array.from(floats)
			}
			if (!item.embedding || !Array.isArray(item.embedding)) {
				throw new OpenRouterError(
					`OpenRouter embeddings response contained a data entry without a numeric embedding array. Raw body: ${excerpt(rawBody)}`,
				)
			}
			return item.embedding
		})

		return {
			model: typeof (data as { model?: unknown }).model === "string" ? (data as { model: string }).model : model,
			embeddings,
			promptTokens: data.usage?.prompt_tokens ?? 0,
			totalTokens: data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0,
		}
	}

	/**
	 * Fetch BOTH the advertised context window and per-token pricing for a
	 * model from OpenRouter's `/api/v1/models/<id>/endpoints` endpoint — ONE
	 * fetch resolves both, so a session never pays for two round-trips to the
	 * same URL (the pricing capture is Part E of the central-store round; the
	 * context-window side is the pre-existing mechanism from
	 * plans/speed-and-context-efficiency.md).
	 *
	 * Two live-verified quirks are handled here:
	 * - The `<id>` path segment is the model's `provider/model` slug with a
	 *   LITERAL slash — percent-encoding the whole string
	 *   (`encodeURIComponent("deepseek/deepseek-v4-flash")`) yields
	 *   `deepseek%2Fdeepseek-v4-flash` which OpenRouter 404s on. Encode each
	 *   segment separately and rejoin with the literal `/`.
	 * - The response body is `{"data":{"endpoints":[{...}]}}`
	 *   (per-endpoint data nested under `data.endpoints`), NOT the
	 *   `{"data":[...]}` array some proxies return. Accept both shapes.
	 *
	 * The largest non-zero context_length across endpoints is the window. The
	 * pricing selection is delegated to parseEndpointPricing (src/budget/
	 * cost.ts): for the deepseek/* family the OFFICIAL DeepSeek endpoint's
	 * numbers are used (that is the price actually charged — this harness
	 * pins routing to it); for everything else the per-field max across
	 * endpoints is used (fail-closed for a cost guardrail). Returns
	 * `undefined` when the endpoint is unreachable/unauthorized or carries no
	 * usable data — callers fall back to their conservative defaults.
	 */
	async fetchModelInfo(
		model: string,
		signal?: AbortSignal,
	): Promise<{ contextWindow?: number; price?: ModelPrice } | undefined> {
		if (!this.apiKey) {
			return undefined
		}
		// Encode each slug segment separately so the `provider/model` literal
		// slash survives (see comment above — encodeURIComponent on the whole
		// id makes OpenRouter return 404).
		const id = model
			.split("/")
			.map((segment) => encodeURIComponent(segment))
			.join("/")
		const url = `${this.baseUrl}/api/v1/models/${id}/endpoints`

		// This call happens at most ONCE per session (loop.ts caches the
		// result), so a single transient hiccup would silently poison the
		// whole session with the conservative defaults. Retry transport
		// failures and 5xx/429 once with a short backoff; a deterministic 4xx
		// (e.g. 404 from a wrong slug) is not retried.
		let response: Response | undefined
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await fetch(url, {
					method: "GET",
					headers: this.authHeaders(),
					signal,
				})
				if (res.ok) {
					response = res
					break
				}
				if (!(res.status === 429 || res.status >= 500)) {
					return undefined
				}
			} catch {
				// transport failure — retried below
			}
			if (attempt === 0) {
				await new Promise((r) => setTimeout(r, 250))
			}
		}
		if (!response) {
			return undefined
		}

		// Live shape: { data: { id, endpoints: [{ context_length, pricing, ... }] } }.
		// Legacy/proxy shape: { data: [{ context_length }] }.
		let data:
			| {
					data?:
						| Array<{ context_length?: unknown; provider_name?: unknown; pricing?: unknown }>
						| { endpoints?: Array<{ context_length?: unknown; provider_name?: unknown; pricing?: unknown }> }
			  }
			| undefined
		try {
			data = JSON.parse(await response.text()) as typeof data
		} catch {
			return undefined
		}

		const endpoints = Array.isArray(data?.data)
			? data.data
			: Array.isArray(data?.data?.endpoints)
				? data.data.endpoints
				: []
		let contextWindow: number | undefined
		for (const ep of endpoints) {
			const n = typeof ep?.context_length === "number" ? ep.context_length : undefined
			if (typeof n === "number" && Number.isFinite(n) && n > 0) {
				contextWindow = contextWindow === undefined ? n : Math.max(contextWindow, n)
			}
		}
		const providerPreference = model.startsWith("deepseek/") ? "DeepSeek" : undefined
		const price = parseEndpointPricing(endpoints as EndpointPricingEntry[], providerPreference)
		return {
			...(contextWindow !== undefined ? { contextWindow } : {}),
			...(price !== undefined ? { price } : {}),
		}
	}

	/**
	 * Fetch a model's advertised context window (tokens) from OpenRouter's
	 * `/api/v1/models/<id>/endpoints` endpoint (thin wrapper over
	 * fetchModelInfo — see that method's doc for the full contract). Returns
	 * `undefined` when the lookup fails or carries no usable number; the
	 * caller falls back to `DEFAULT_CONTEXT_WINDOW_TOKENS`.
	 */
	async fetchModelContextWindow(model: string, signal?: AbortSignal): Promise<number | undefined> {
		return (await this.fetchModelInfo(model, signal))?.contextWindow
	}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		if (!this.apiKey) {
			throw new OpenRouterError(
				"HEADLESSCODE_OPENROUTER_API_KEY is not set. Set the environment variable HEADLESSCODE_OPENROUTER_API_KEY (or pass apiKey to OpenRouterClient).",
			)
		}

		const model = this.resolveModel(request.model)
		const url = `${this.baseUrl}/api/v1/chat/completions`
		const startedAt = Date.now()

		const headers = this.authHeaders()

		const body = buildRequestBody(request, model)

		// Opt-in SSE streaming (streaming-and-reasoning). When `request.stream`
		// is true the response is parsed incrementally from the `data:` lines and
		// the final message is assembled from the deltas; otherwise the legacy
		// single blocking fetch path below runs unchanged (the default).
		if (request.stream) {
			return this.streamChatCompletion(request, url, headers, body)
		}

		try {
			return await this.createChatCompletionNonStreaming(request, url, headers, body, model, startedAt)
		} catch (err) {
			if (isTranscriptCaptureEnabled()) {
				captureTranscript(
					{ provider: "openrouter", model },
					{
						messages: request.messages,
						tools: request.tools,
						temperature: request.temperature,
						error: err instanceof Error ? err.message : String(err),
						durationMs: Date.now() - startedAt,
					},
				)
			}
			throw err
		}
	}

	private async createChatCompletionNonStreaming(
		request: LlmRequest,
		url: string,
		headers: Record<string, string>,
		body: Record<string, unknown>,
		model: string,
		startedAt: number,
	): Promise<LlmResponse> {
		let response: Response
		try {
			response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: request.signal,
			})
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw err // caller-managed abort (e.g. timeout in the loop)
			}
			throw new OpenRouterError(
				`Network error calling OpenRouter: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		if (!response.ok) {
			const rawBody = await response.text().catch(() => "")
			const excerpt = rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
			throw new OpenRouterError(
				`OpenRouter returned HTTP ${response.status}: ${excerpt}`,
				response.status,
				excerpt,
			)
		}

		// Read the raw body first (not response.json() directly): a 200 status
		// doesn't guarantee a well-formed choices[] payload — OpenRouter/upstream
		// providers can return HTTP 200 with an `{error: {...}}` envelope, an
		// empty/truncated body (e.g. a gateway cutting the connection on a slow
		// generation), or a `choices[0]` with `finish_reason` set but no
		// `message`. Surfacing the raw body distinguishes these cases instead of
		// collapsing them all into one uninformative "no choices[0].message".
		const rawBody = await response.text()
		let data:
			| {
					choices?: Array<{ message?: ChatMessage; finish_reason?: string }>
					usage?: RawUsage
					error?: { message?: string; code?: unknown }
			  }
			| undefined
		try {
			data = JSON.parse(rawBody)
		} catch {
			const excerpt = rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
			throw new OpenRouterError(`OpenRouter returned HTTP 200 with a non-JSON/unparseable body: ${excerpt || "(empty)"}`)
		}

		if (data?.error) {
			throw new OpenRouterError(
				`OpenRouter returned HTTP 200 with an error envelope: ${data.error.message ?? JSON.stringify(data.error)}`,
			)
		}

		const message = data?.choices?.[0]?.message
		if (!data || !message) {
			const finishReason = data?.choices?.[0]?.finish_reason
			const excerpt = rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
			throw new OpenRouterError(
				`OpenRouter response contained no choices[0].message` +
					(finishReason ? ` (finish_reason: ${finishReason})` : "") +
					`. Raw body: ${excerpt || "(empty)"}`,
			)
		}

		const result: LlmResponse = {
			message,
			usage: mapUsage(data.usage),
		}
		if (isTranscriptCaptureEnabled()) {
			captureTranscript(
				{ provider: "openrouter", model },
				{ messages: request.messages, tools: request.tools, temperature: request.temperature, response: result, durationMs: Date.now() - startedAt },
			)
		}
		return result
	}

	/**
	 * Opt-in SSE streaming path (streaming-and-reasoning). `body` is the same
	 * request body the blocking path would send, plus `stream: true` and
	 * `stream_options: { include_usage: true }` (the usage chunk at the end of
	 * the stream is what makes cost accounting work — verified live 2026-08-01:
	 * the final `data:` chunk carries `usage` with the same fields as a
	 * non-streamed response).
	 *
	 * Assembles the final `LlmResponse` message from the streamed deltas so the
	 * caller sees exactly what a non-streamed equivalent response would have
	 * produced. Text, reasoning and tool calls are all reassembled (tool-call
	 * arguments arrive as partial JSON across many chunks — see the probe
	 * findings in the task notes; each chunk's `delta.tool_calls[i]` carries
	 * `index`, and the id/name arrive once on the first chunk for that index,
	 * with subsequent chunks carrying only partial `function.arguments`).
	 *
	 * The caller's AbortSignal (the loop's llmTimeoutMs timer) is passed to the
	 * fetch AND honored while reading the stream body: a mid-stream stall still
	 * aborts (the reader throws AbortError), so a stalled stream cannot hang the
	 * session past the timeout.
	 */
	private async streamChatCompletion(
		request: LlmRequest,
		url: string,
		headers: Record<string, string>,
		body: Record<string, unknown>,
	): Promise<LlmResponse> {
		const streamBody: Record<string, unknown> = {
			...body,
		}

		let response: Response
		try {
			response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(streamBody),
				signal: request.signal,
			})
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw err
			}
			throw new OpenRouterError(
				`Network error calling OpenRouter (stream): ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		if (!response.ok) {
			const rawBody = await response.text().catch(() => "")
			const excerpt = rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
			throw new OpenRouterError(
				`OpenRouter returned HTTP ${response.status}: ${excerpt}`,
				response.status,
				excerpt,
			)
		}

		if (!response.body) {
			throw new OpenRouterError("OpenRouter returned a stream response with no body")
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let done = false

		// Final assembled message. `reasoning` concatenates `delta.reasoning`
		// strings; `content` concatenates `delta.content`; tool calls are keyed
		// by their stream index and merged after the stream ends.
		const contentParts: string[] = []
		const reasoningParts: string[] = []
		const toolCallsByIdx = new Map<number, { id: string; name: string; args: string[] }>()
		let sawFinish = false
		let sawUsage = false
		let lastUsage: RawUsage | undefined

		const fail = (message: string): never => {
			throw new OpenRouterError(message)
		}

		// Fire a live-typing chunk to the caller's callback. Non-fatal by
		// contract (types.ts): a throw from onStreamChunk must never fail the
		// LLM call — the event feed is best-effort.
		const emitChunk = (kind: "text" | "reasoning" | "tool", chunk: string): void => {
			if (!request.onStreamChunk || chunk.length === 0) {
				return
			}
			try {
				request.onStreamChunk(kind, chunk)
			} catch {
				// Swallow: the dashboard's live-typing feed is best-effort.
			}
		}

		while (!done) {
			// Structural type: the lib is ES2022 (no DOM), so the undici
			// ReadableStream read-result shape is spelled out rather than
			// referenced by name.
			let chunk: { done: boolean; value?: Uint8Array }
			try {
				chunk = await reader.read()
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					throw err
				}
				throw new OpenRouterError(
					`Error reading OpenRouter stream: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
			if (chunk.done) {
				done = true
				break
			}
			buffer += decoder.decode(chunk.value, { stream: true })
			const lines = buffer.split("\n")
			buffer = lines.pop() ?? ""

			for (const line of lines) {
				const trimmed = line.trim()
				if (!trimmed || !trimmed.startsWith("data:")) {
					continue
				}
				const payload = trimmed.slice(5).trim()
				if (payload === "[DONE]") {
					done = true
					break
				}
				if (payload === "") {
					continue
				}
				let data:
					| {
							choices?: Array<{ delta?: { content?: string; reasoning?: string; tool_calls?: StreamToolCallDelta[] }; finish_reason?: string }>
							usage?: RawUsage
							error?: { message?: string }
					  }
					| undefined
				try {
					data = JSON.parse(payload) as typeof data
				} catch {
					fail(`OpenRouter stream contained a non-JSON data line: ${payload.slice(0, 200)}`)
				}
				if (data?.error) {
					fail(`OpenRouter stream error envelope: ${data.error.message ?? JSON.stringify(data.error)}`)
				}
				const choice = data?.choices?.[0]
				if (choice?.finish_reason) {
					sawFinish = true
				}
				const delta = choice?.delta
				if (delta) {
					if (typeof delta.content === "string") {
						contentParts.push(delta.content)
						emitChunk("text", delta.content)
					}
					if (typeof delta.reasoning === "string") {
						reasoningParts.push(delta.reasoning)
						emitChunk("reasoning", delta.reasoning)
					}
					if (Array.isArray(delta.tool_calls)) {
						for (const tc of delta.tool_calls) {
							const entry = toolCallsByIdx.get(tc.index) ?? { id: "", name: "", args: [] }
							if (typeof tc.id === "string" && tc.id) {
								entry.id = tc.id
							}
							if (typeof tc.function?.name === "string" && tc.function.name) {
								entry.name = tc.function.name
							}
							if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
								entry.args.push(tc.function.arguments)
								emitChunk("tool", tc.function.arguments)
							}
							toolCallsByIdx.set(tc.index, entry)
						}
					}
				}
				if (data?.usage) {
					sawUsage = true
					lastUsage = data.usage
				}
			}
		}

		const content = contentParts.join("")
		const reasoning = reasoningParts.join("")
		const toolCalls: ChatToolCall[] = [...toolCallsByIdx.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, tc]) => ({
				id: tc.id || `call_stream_${tc.name || "unknown"}`,
				type: "function" as const,
				function: { name: tc.name || "unknown_tool", arguments: tc.args.join("") },
			}))

		const message: ChatMessage = {
			role: "assistant",
			content: content === "" ? null : content,
			...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			...(reasoning !== "" ? { reasoning } : {}),
		}

		if (!sawFinish && !toolCalls.length && content === "" && reasoning === "" && !sawUsage) {
			// A stream that produced nothing at all (e.g. gateway cut) should
			// surface as an error, not a silent empty assistant turn.
			fail("OpenRouter stream ended with no content, reasoning, tool calls or usage")
		}

		return {
			message,
			usage: mapUsage(lastUsage),
		}
	}
}

/** A single `delta.tool_calls[]` entry as OpenRouter streams it. */
interface StreamToolCallDelta {
	index: number
	id?: string
	function?: { name?: string; arguments?: string }
}

/**
 * User-facing reasoning-effort levels for deepseek/* models (issue #30
 * experiment). DeepSeek's native graded set is low/medium/high/max; OpenRouter's
 * normalized `reasoning.effort` accepts "high" and "xhigh" (xhigh maps to the
 * native max). "xhigh" is accepted as an alias for "max" so both vocabularies
 * work. Anything else fails loudly — a typo must never silently keep the
 * endpoint's undeclared default, which would poison the experiment's comparison.
 */
export const REASONING_EFFORT_LEVELS = ["low", "medium", "high", "max", "xhigh"] as const

/** The OpenRouter-normalized `reasoning.effort` values actually sent on the wire. */
export type WireReasoningEffort = "low" | "medium" | "high" | "xhigh"

/**
 * Validate + normalize a configured reasoning-effort value to the
 * OpenRouter-normalized wire value. `undefined`/empty means "no effort sent"
 * (the endpoint's default applies). Throws on anything outside the known set.
 */
export function parseReasoningEffort(value: string | undefined): WireReasoningEffort | undefined {
	if (value === undefined || value.trim() === "") {
		return undefined
	}
	switch (value.trim().toLowerCase()) {
		case "low":
			return "low"
		case "medium":
			return "medium"
		case "high":
			return "high"
		case "max":
		case "xhigh":
			// OpenRouter's normalized reasoning.effort has no "max" — xhigh is
			// its alias for the native max level.
			return "xhigh"
		default:
			throw new Error(
				`reasoning effort must be one of ${REASONING_EFFORT_LEVELS.join("/")} (native DeepSeek levels, plus OpenRouter's normalized "xhigh" alias for "max"), got '${value}'`,
			)
	}
}

export function buildRequestBody(request: LlmRequest, model: string): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model,
		messages: request.messages,
	}
	if (request.tools && request.tools.length > 0) {
		body.tools = request.tools satisfies ChatTool[]
	}
	if (request.temperature !== undefined) {
		body.temperature = request.temperature
	}
	if (request.maxTokens !== undefined) {
		body.max_tokens = request.maxTokens
	}
	// Opt-in SSE streaming (streaming-and-reasoning): `stream: true` makes
	// OpenRouter return a text/event-stream instead of one JSON body, and
	// `stream_options.include_usage: true` puts the final usage chunk (with
	// prompt/completion/reasoning token counts) at the end of the stream —
	// without it a streamed response carries NO usage data and cost
	// accounting would silently under-report. Both are OpenRouter's own
	// OpenAI-compatible conventions, verified live 2026-08-01.
	if (request.stream) {
		body.stream = true
		body.stream_options = { include_usage: true }
	}
	// Pin routing to DeepSeek's own official endpoint for deepseek/* models,
	// not whichever third-party host (DeepInfra, Baidu, Mancer, ...) OpenRouter's
	// automatic price-based routing might otherwise pick behind the same model
	// id. This matters beyond preference: those endpoints have meaningfully
	// different prices — especially cache-read pricing, where the official
	// endpoint's rate is roughly 10x cheaper than third-party hosts serving the
	// same model — so DEFAULT_PRICING_TABLE's deepseek/* entries
	// (src/budget/cost.ts) are only actually correct WITH this pin in place.
	// `allow_fallbacks: false` means a request fails clearly if the official
	// endpoint is down, rather than silently routing elsewhere at a different
	// (unpriced-by-us) rate.
	if (model.startsWith("deepseek/")) {
		body.provider = { order: ["deepseek"], allow_fallbacks: false }
		// Reasoning content (streaming-and-reasoning): request it explicitly for
		// the only model family this harness pins. Verified live 2026-08-01 on
		// deepseek/deepseek-v4-flash: `include_reasoning: true` is in every
		// endpoint's `supported_parameters`; WITHOUT it the pinned official
		// endpoint still reasons (the model thinks anyway) but `include_reasoning:
		// false` suppresses the returned `reasoning` field — so this flag is
		// load-bearing for actually getting the thinking text back. OpenRouter
		// cleanly ignores the param for models that don't support it (probed with
		// 200s on gpt-4o-mini/claude-3.7-sonnet when the model id resolves; the
		// 404s seen were account/data-policy endpoint availability, not the
		// param). Kept to the deepseek/ prefix rather than unconditional to match
		// the existing pin boundary.
		body.include_reasoning = true
		// Graded reasoning effort (issue #30): DeepSeek's native low/medium/
		// high/max is normalized by OpenRouter to `reasoning: { effort: "high" |
		// "xhigh" }` ("xhigh" = max). Unset = send nothing = the endpoint's
		// undeclared default, exactly as before. Same deepseek/ boundary as
		// include_reasoning.
		if (request.reasoningEffort !== undefined) {
			const effort = parseReasoningEffort(request.reasoningEffort)
			if (effort !== undefined) {
				body.reasoning = { effort }
			}
		}
	}
	return body
}

interface RawUsage {
	prompt_tokens?: number
	completion_tokens?: number
	total_tokens?: number
	/** OpenRouter's pass-through of the underlying provider's cache accounting. */
	prompt_tokens_details?: {
		cached_tokens?: number
	}
}

function mapUsage(raw: RawUsage | undefined): LlmResponse["usage"] {
	if (!raw) {
		return undefined
	}
	return {
		promptTokens: raw.prompt_tokens,
		completionTokens: raw.completion_tokens,
		totalTokens: raw.total_tokens,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens,
	}
}

/** Truncate a raw body to a bounded excerpt for error messages. */
function excerpt(body: string): string {
	return body.length > 500 ? `${body.slice(0, 500)}…` : body
}

