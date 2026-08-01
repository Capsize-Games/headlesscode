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

		const data = (await response.json().catch(() => undefined)) as
			| { choices?: Array<{ message?: ChatMessage }>; usage?: RawUsage }
			| undefined

		const message = data?.choices?.[0]?.message
		if (!data || !message) {
			throw new OpenRouterError("OpenRouter response contained no choices[0].message")
		}

		return {
			message,
			usage: mapUsage(data.usage),
		}
	}
}

function buildRequestBody(request: LlmRequest, model: string): Record<string, unknown> {
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
