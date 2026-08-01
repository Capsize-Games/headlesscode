/**
 * OpenRouter chat-completions client.
 *
 * Uses the native `fetch` API (Node >= 18) — no axios / node-fetch / openai SDK.
 *
 * Endpoint: POST {OPENROUTER_BASE_URL}/api/v1/chat/completions
 *   - Base URL override: OPENROUTER_BASE_URL env var (default
 *     https://openrouter.ai) — lets tests/proxies point the client at a mock
 *     server (e.g. http://127.0.0.1:<port>).
 *   - Authorization: Bearer <OPENROUTER_API_KEY>
 *   - Optional headers from env: HTTP-Referer (OPENROUTER_HTTP_REFERER),
 *     X-Title (OPENROUTER_APP_TITLE) — recommended by OpenRouter for
 *     identifying the app and enabling higher rate limits.
 *
 * Model resolution order (per request): `request.model` → constructor
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

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		if (!this.apiKey) {
			throw new OpenRouterError(
				"OPENROUTER_API_KEY is not set. Set the environment variable OPENROUTER_API_KEY (or pass apiKey to OpenRouterClient).",
			)
		}

		const model = this.resolveModel(request.model)
		const url = `${this.baseUrl}/api/v1/chat/completions`

		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
		}
		if (this.httpReferer) {
			headers["HTTP-Referer"] = this.httpReferer
		}
		if (this.appTitle) {
			headers["X-Title"] = this.appTitle
		}

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
