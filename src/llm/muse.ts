/**
 * Meta Model API (Muse) client.
 *
 * Meta serves the Muse Spark family over a drop-in OpenAI-compatible
 * endpoint (Meta's own meta-models/meta-model-cookbook repo + dev.meta.ai
 * docs, verified against multiple independent live integrations):
 *
 * Chat completions:  POST {HEADLESSCODE_MUSE_BASE_URL}/chat/completions
 *   - Base URL default: https://api.meta.ai/v1 (note: the version is part
 *     of the base, unlike OpenRouter's https://openrouter.ai + /api/v1/...
 *     split — the override env var must keep the same shape).
 *   - Authorization: Bearer <key> (a MODEL_API_KEY from the dev.meta.ai
 *     dashboard, `LLM|{numeric_id}|{secret}` shaped).
 *   - Models: muse-spark-1.3 (current default), muse-spark-1.2,
 *     muse-spark-1.1, plus `-contributor` variants of each (cheaper list
 *     rates in exchange for Meta training on the traffic).
 *
 * Verified wire facts this client relies on:
 *   - Standard OpenAI chat-completions request/response shapes, including
 *     `tools` / `tool_calls` and `stream_options: { include_usage: true }`
 *     on streamed calls (usage chunk at the end of the stream).
 *   - Reasoning is internal: surfaced only via usage.reasoning_tokens, never
 *     as a replayable reasoning field — so unlike the OpenRouter client
 *     there is no include_reasoning flag and no reasoning echo.
 *   - `request.reasoningEffort` is IGNORED here (same as OllamaClient
 *     ignores it): the loop's low/medium/high/max vocabulary is DeepSeek's,
 *     and Meta's own `reasoning_effort` scale is unverified — sending an
 *     unmapped value would be a guess on a paid call. Unset = Meta default.
 *   - `request.repeatPenalty` is ignored (no such parameter).
 *
 * Chat model resolution order (per request): `request.model` → constructor
 * `defaultModel` → `HEADLESSCODE_MUSE_MODEL` env var → `muse-spark-1.3`.
 *
 * Provider selection for the whole harness lives here too
 * (`resolveLlmProvider`, `HEADLESSCODE_LLM_PROVIDER`): "openrouter" (the
 * default, zero behavior change) or "muse". Every client-construction site
 * (cli.ts, reviewer.ts, qa.ts, pipeline.ts, orchestrator/cli.ts,
 * decision-proxy) branches on it.
 */

import type {
	LlmClient,
	LlmRequest,
	LlmResponse,
	ChatMessage,
	ChatTool,
	ChatToolCall,
} from "../engine/types.js"
import type { ModelPrice } from "../budget/cost.js"
import { captureTranscript, isTranscriptCaptureEnabled } from "./transcript-capture.js"

/** Default base URL (includes the /v1 — see the header comment). */
export const MUSE_BASE_URL = "https://api.meta.ai/v1"
/** Current default model (Meta's documented default; 1M context). */
export const DEFAULT_MUSE_MODEL = "muse-spark-1.3"
/** Advertised context window for the muse-spark-* family (1,048,576 tokens). */
export const MUSE_CONTEXT_WINDOW_TOKENS = 1_048_576

export const MUSE_API_KEY_ENV = "HEADLESSCODE_MUSE_API_KEY"
/** Meta's own documented key variable (dev.meta.ai dashboard) — honored as a fallback. */
export const META_MODEL_API_KEY_ENV = "MODEL_API_KEY"
export const MUSE_BASE_URL_ENV = "HEADLESSCODE_MUSE_BASE_URL"
export const MUSE_MODEL_ENV = "HEADLESSCODE_MUSE_MODEL"
export const LLM_PROVIDER_ENV = "HEADLESSCODE_LLM_PROVIDER"

export type LlmProvider = "openrouter" | "muse"

export interface MuseClientOptions {
	apiKey?: string
	baseUrl?: string
	defaultModel?: string
}

/** Typed error for non-2xx responses or malformed payloads. */
export class MuseError extends Error {
	readonly status?: number
	readonly body?: string

	constructor(message: string, status?: number, body?: string) {
		super(message)
		this.name = "MuseError"
		this.status = status
		this.body = body
	}
}

/**
 * Whether a `createChatCompletion` failure is worth ONE retry. Meta's own
 * error-handling guidance is "back off with jitter and skip retries on
 * client errors": 429 (rate limit), 5xx, and network-transport failures
 * (thrown with no `.status`) retry; any other 4xx (auth, malformed request,
 * unknown model) is deterministic.
 */
export function isRetryableMuseError(error: unknown): boolean {
	if (!(error instanceof MuseError)) {
		return false
	}
	if (error.status === undefined) {
		return true // network/transport failure — see the catch in createChatCompletion
	}
	return error.status === 429 || error.status >= 500
}

/**
 * Resolve the harness-wide cloud provider. Default "openrouter" (zero
 * behavior change for existing setups). Fails loudly on any other value —
 * a typo must never silently run a round on the wrong provider/account.
 */
export function resolveLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
	const raw = env[LLM_PROVIDER_ENV]
	if (raw === undefined || raw.trim() === "") {
		return "openrouter"
	}
	const normalized = raw.trim().toLowerCase()
	if (normalized === "openrouter") {
		return "openrouter"
	}
	if (normalized === "muse") {
		return "muse"
	}
	throw new Error(
		`${LLM_PROVIDER_ENV} must be "openrouter" or "muse", got '${raw}'`,
	)
}

/**
 * Validate HEADLESSCODE_LLM_PROVIDER for CLI entry points: returns the
 * provider, or reports a clean one-line error and returns undefined (the
 * caller then returns exit code 2). Without this, a typo'd provider value
 * would surface later as an uncaught throw with a stack trace from client
 * construction instead of a clean usage error.
 */
export function resolveLlmProviderOrReport(
	writeErr: (text: string) => void = (text) => process.stderr.write(text),
	env: NodeJS.ProcessEnv = process.env,
): LlmProvider | undefined {
	try {
		return resolveLlmProvider(env)
	} catch (err) {
		writeErr(`headlesscode: ${err instanceof Error ? err.message : String(err)}\n`)
		return undefined
	}
}

/**
 * Eager ultimate-default for session entry points. On the OpenRouter path
 * this is `undefined` (that client's own built-in default stays lazy, as
 * before). On the Muse path it is DEFAULT_MUSE_MODEL — resolved eagerly
 * because HeadlessSession itself falls back to OPENROUTER_MODEL /
 * DEFAULT_MODEL when config.model is undefined (loop.ts), which would
 * inject an OpenRouter id into Muse requests and fail every call with a
 * provider-side 404. Callers use it as
 * `resolveModelForMode({ ... }) ?? providerDefaultModel(provider)`.
 */
export function providerDefaultModel(provider: LlmProvider): string | undefined {
	return provider === "muse" ? DEFAULT_MUSE_MODEL : undefined
}

export class MuseClient implements LlmClient {
	private readonly apiKey: string | undefined
	private readonly baseUrl: string
	private readonly defaultModel: string

	constructor(options: MuseClientOptions = {}) {
		this.apiKey =
			options.apiKey ?? process.env[MUSE_API_KEY_ENV] ?? process.env[META_MODEL_API_KEY_ENV]
		this.baseUrl = (options.baseUrl ?? process.env[MUSE_BASE_URL_ENV] ?? MUSE_BASE_URL).replace(/\/+$/, "")
		this.defaultModel = options.defaultModel ?? process.env[MUSE_MODEL_ENV] ?? DEFAULT_MUSE_MODEL
	}

	/**
	 * Resolve the model id to use for a request. The per-request model wins,
	 * then the client default (which itself falls back to env + built-in).
	 */
	resolveModel(requestModel?: string): string {
		return requestModel?.trim() || this.defaultModel
	}

	/** Shared request headers: Bearer auth + JSON. */
	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiKey ?? ""}`,
			"Content-Type": "application/json",
		}
	}

	private missingKeyMessage(): string {
		return (
			`${MUSE_API_KEY_ENV} is not set. Set the environment variable ${MUSE_API_KEY_ENV} ` +
			`(or ${META_MODEL_API_KEY_ENV}, the key variable from Meta's dev.meta.ai dashboard) ` +
			`to a Meta Model API key (or pass apiKey to MuseClient).`
		)
	}

	/**
	 * Static model info for the loop's once-per-session lookup (same
	 * optional-method contract as OpenRouterClient.fetchModelInfo, which
	 * loop.ts probes for — see resolveLiveModelInfo). Meta's GET /v1/models
	 * schema for per-model context/pricing is unverified, so no network call
	 * is attempted: muse-spark-* ids resolve to the documented 1M window and
	 * anything else resolves undefined (the loop's conservative default).
	 *
	 * Deliberately returns NO price: the loop logs a returned price as
	 * "resolved live pricing from OpenRouter models endpoint", which would
	 * be a lie for Meta — the hardcoded DEFAULT_PRICING_TABLE entries (plus
	 * HEADLESSCODE_PRICING_JSON overrides) are the price source instead, and
	 * the loop's "using hardcoded table" warning for that case is accurate.
	 */
	async fetchModelInfo(
		model: string,
		_signal?: AbortSignal,
	): Promise<{ contextWindow?: number; price?: ModelPrice } | undefined> {
		if (!model.trim().startsWith("muse-spark-")) {
			return undefined
		}
		return { contextWindow: MUSE_CONTEXT_WINDOW_TOKENS }
	}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		if (!this.apiKey) {
			throw new MuseError(this.missingKeyMessage())
		}

		const model = this.resolveModel(request.model)
		const url = `${this.baseUrl}/chat/completions`
		const startedAt = Date.now()

		const headers = this.authHeaders()
		const body = buildMuseRequestBody(request, model)

		if (request.stream) {
			return this.streamChatCompletion(request, url, headers, body, model, startedAt)
		}

		try {
			return await this.createChatCompletionNonStreaming(request, url, headers, body, model, startedAt)
		} catch (err) {
			if (isTranscriptCaptureEnabled()) {
				captureTranscript(
					{ provider: "muse", model },
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
			throw new MuseError(
				`Network error calling Meta Model API: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		if (!response.ok) {
			const rawBody = await response.text().catch(() => "")
			throw new MuseError(
				`Meta Model API returned HTTP ${response.status}: ${excerpt(rawBody)}`,
				response.status,
				excerpt(rawBody),
			)
		}

		// Same raw-body-first discipline as the OpenRouter client: a 200
		// status doesn't guarantee a well-formed choices[] payload — surface
		// the raw body instead of collapsing every shape into one
		// uninformative "no choices[0].message".
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
			throw new MuseError(`Meta Model API returned HTTP 200 with a non-JSON/unparseable body: ${excerpt(rawBody) || "(empty)"}`)
		}

		if (data?.error) {
			throw new MuseError(
				`Meta Model API returned HTTP 200 with an error envelope: ${data.error.message ?? JSON.stringify(data.error)}`,
			)
		}

		const message = data?.choices?.[0]?.message
		if (!data || !message) {
			const finishReason = data?.choices?.[0]?.finish_reason
			throw new MuseError(
				`Meta Model API response contained no choices[0].message` +
					(finishReason ? ` (finish_reason: ${finishReason})` : "") +
					`. Raw body: ${excerpt(rawBody) || "(empty)"}`,
			)
		}

		const result: LlmResponse = {
			message,
			usage: mapUsage(data.usage),
		}
		if (isTranscriptCaptureEnabled()) {
			captureTranscript(
				{ provider: "muse", model },
				{ messages: request.messages, tools: request.tools, temperature: request.temperature, response: result, durationMs: Date.now() - startedAt },
			)
		}
		return result
	}

	/**
	 * Opt-in SSE streaming path. Same contract as the OpenRouter client's
	 * stream path: `data:` JSON lines ending in `[DONE]`, deltas assembled
	 * into the final message (Meta reports standard OpenAI delta.content +
	 * delta.tool_calls, verified live by independent integrations), the
	 * final usage chunk (via stream_options.include_usage) feeding cost
	 * accounting. The caller's AbortSignal aborts mid-stream reads too.
	 */
	private async streamChatCompletion(
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
				throw err
			}
			throw new MuseError(
				`Network error calling Meta Model API (stream): ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		if (!response.ok) {
			const rawBody = await response.text().catch(() => "")
			throw new MuseError(
				`Meta Model API returned HTTP ${response.status}: ${excerpt(rawBody)}`,
				response.status,
				excerpt(rawBody),
			)
		}

		if (!response.body) {
			throw new MuseError("Meta Model API returned a stream response with no body")
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let done = false

		const contentParts: string[] = []
		const toolCallsByIdx = new Map<number, { id: string; name: string; args: string[] }>()
		let sawFinish = false
		let sawUsage = false
		let lastUsage: RawUsage | undefined

		const fail = (message: string): never => {
			throw new MuseError(message)
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
			let chunk: { done: boolean; value?: Uint8Array }
			try {
				chunk = await reader.read()
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					throw err
				}
				throw new MuseError(
					`Error reading Meta Model API stream: ${err instanceof Error ? err.message : String(err)}`,
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
							choices?: Array<{ delta?: { content?: string; tool_calls?: StreamToolCallDelta[] }; finish_reason?: string }>
							usage?: RawUsage
							error?: { message?: string }
					  }
					| undefined
				try {
					data = JSON.parse(payload) as typeof data
				} catch {
					fail(`Meta Model API stream contained a non-JSON data line: ${payload.slice(0, 200)}`)
				}
				if (data?.error) {
					fail(`Meta Model API stream error envelope: ${data.error.message ?? JSON.stringify(data.error)}`)
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
		}

		if (!sawFinish && !toolCalls.length && content === "" && !sawUsage) {
			// A stream that produced nothing at all (e.g. gateway cut) should
			// surface as an error, not a silent empty assistant turn.
			fail("Meta Model API stream ended with no content, tool calls or usage")
		}

		const result: LlmResponse = {
			message,
			usage: mapUsage(lastUsage),
		}
		if (isTranscriptCaptureEnabled()) {
			captureTranscript(
				{ provider: "muse", model },
				{ messages: request.messages, tools: request.tools, temperature: request.temperature, response: result, durationMs: Date.now() - startedAt },
			)
		}
		return result
	}
}

/** A single `delta.tool_calls[]` entry as the API streams it. */
interface StreamToolCallDelta {
	index: number
	id?: string
	function?: { name?: string; arguments?: string }
}

export function buildMuseRequestBody(request: LlmRequest, model: string): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model,
		messages: request.messages,
	}
	if (request.tools && request.tools.length > 0) {
		body.tools = request.tools satisfies ChatTool[]
		// OpenAI-compatible tool_choice passthrough ("auto"/"none"/"required").
		// The loop sets "required" once its identical-call guard removes a
		// strongly-preferred tool from the schema (see LlmRequest.toolChoice)
		// — without it the decoder can collapse into an empty generation.
		if (request.toolChoice !== undefined) {
			body.tool_choice = request.toolChoice
		}
	}
	if (request.temperature !== undefined) {
		body.temperature = request.temperature
	}
	if (request.maxTokens !== undefined) {
		body.max_tokens = request.maxTokens
	}
	// Opt-in SSE streaming: `stream_options.include_usage` puts the final
	// usage chunk at the end of the stream — without it a streamed response
	// carries NO usage data and cost accounting would silently under-report.
	if (request.stream) {
		body.stream = true
		body.stream_options = { include_usage: true }
	}
	// NOTE: no provider pin, no include_reasoning — both are OpenRouter/
	// DeepSeek-specific. And no reasoningEffort mapping (see header).
	return body
}

interface RawUsage {
	prompt_tokens?: number
	completion_tokens?: number
	total_tokens?: number
	/** Prompt-cache accounting (Meta discounts cached input ~88%). */
	prompt_tokens_details?: {
		cached_tokens?: number
	}
	/** Reasoning is internal-only; its tokens ride inside completion_tokens. */
	completion_tokens_details?: {
		reasoning_tokens?: number
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
