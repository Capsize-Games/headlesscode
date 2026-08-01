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
 *   - Authorization: Bearer <OPENROUTER_API_KEY>
 *   - Optional headers from env: HTTP-Referer (OPENROUTER_HTTP_REFERER),
 *     X-Title (OPENROUTER_APP_TITLE) — recommended by OpenRouter for
 *     identifying the app and enabling higher rate limits.
 *
 * Chat model resolution order (per request): `request.model` → constructor
 * `defaultModel` → `OPENROUTER_MODEL` env var → `deepseek/deepseek-chat`.
 */

import type { LlmClient, LlmRequest, LlmResponse, ChatMessage, ChatTool } from "../engine/types.js"

export const OPENROUTER_BASE_URL = "https://openrouter.ai"
export const DEFAULT_MODEL = "deepseek/deepseek-chat"

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
		this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY
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
	 */
	async embed(inputs: string[], model: string, signal?: AbortSignal): Promise<OpenRouterEmbedding> {
		if (!this.apiKey) {
			throw new OpenRouterError(
				"OPENROUTER_API_KEY is not set. Set the environment variable OPENROUTER_API_KEY (or pass apiKey to OpenRouterClient).",
			)
		}
		if (inputs.length === 0) {
			return { model, embeddings: [], promptTokens: 0, totalTokens: 0 }
		}

		const url = `${this.baseUrl}/api/v1/embeddings`
		const body = { model, input: inputs }

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

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		if (!this.apiKey) {
			throw new OpenRouterError(
				"OPENROUTER_API_KEY is not set. Set the environment variable OPENROUTER_API_KEY (or pass apiKey to OpenRouterClient).",
			)
		}

		const model = this.resolveModel(request.model)
		const url = `${this.baseUrl}/api/v1/chat/completions`

		const headers = this.authHeaders()

		const body = buildRequestBody(request, model)

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

		return {
			message,
			usage: mapUsage(data.usage),
		}
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
