/**
 * Unit tests for src/llm/muse.ts's request-building logic, response mapping,
 * streaming, and provider selection. Plain assert-based script (no test
 * framework, no network), run via
 * `npm test` -> `tsx src/llm/__tests__/muse.test.ts`.
 */

import assert from "node:assert/strict"

import {
	buildMuseRequestBody,
	DEFAULT_MUSE_MODEL,
	isRetryableMuseError,
	MUSE_BASE_URL,
	MUSE_CONTEXT_WINDOW_TOKENS,
	MuseClient,
	MuseError,
	providerDefaultModel,
	resolveLlmProvider,
	resolveLlmProviderOrReport,
} from "../muse.js"
import type { LlmRequest } from "../../engine/types.js"
import { runMain } from "../../test-runner.js"

const baseRequest: LlmRequest = {
	model: "muse-spark-1.3",
	messages: [{ role: "user", content: "hi" }],
}

function sse(...payloads: Array<Record<string, unknown> | string>): string {
	return payloads
		.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`)
		.join("")
}

function sseResponse(body: string): Response {
	const encoder = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(body))
			controller.close()
		},
	})
	return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

function stubFetch(response: Response): () => void {
	const original = globalThis.fetch
	globalThis.fetch = (async () => response) as typeof fetch
	return () => {
		globalThis.fetch = original
	}
}

// ─── Request building ────────────────────────────────────────────────────────

async function testRequestBodyPassesModelAndMessages(): Promise<void> {
	const body = buildMuseRequestBody(baseRequest, "muse-spark-1.3")
	assert.equal(body.model, "muse-spark-1.3")
	assert.deepEqual(body.messages, baseRequest.messages)
}

async function testRequestBodyHasNoProviderPinOrReasoningFlag(): Promise<void> {
	// The provider pin + include_reasoning are OpenRouter/DeepSeek-specific —
	// a Muse request must never carry them (an unknown `provider` object on
	// api.meta.ai would be at best ignored, at worst a 400).
	const body = buildMuseRequestBody(baseRequest, "muse-spark-1.3")
	assert.equal(body.provider, undefined)
	assert.equal(body.include_reasoning, undefined)
	assert.equal(body.reasoning, undefined)
}

async function testRequestBodyEmitsToolsOnlyWhenNonEmpty(): Promise<void> {
	const tools = [{ type: "function" as const, function: { name: "read_file", parameters: { type: "object" } } }]
	const withTools = buildMuseRequestBody({ ...baseRequest, tools }, "muse-spark-1.3")
	assert.deepEqual(withTools.tools, tools)
	const bare = buildMuseRequestBody(baseRequest, "muse-spark-1.3")
	assert.equal(bare.tools, undefined)
	const empty = buildMuseRequestBody({ ...baseRequest, tools: [] }, "muse-spark-1.3")
	assert.equal(empty.tools, undefined)
}

async function testRequestBodyPassesToolChoiceWithTools(): Promise<void> {
	const tools = [{ type: "function" as const, function: { name: "read_file" } }]
	const body = buildMuseRequestBody({ ...baseRequest, tools, toolChoice: "required" }, "muse-spark-1.3")
	assert.equal(body.tool_choice, "required")
}

async function testRequestBodyOmitsToolChoiceWithoutTools(): Promise<void> {
	// tool_choice with no tools schema is meaningless — don't send it.
	const body = buildMuseRequestBody({ ...baseRequest, toolChoice: "required" }, "muse-spark-1.3")
	assert.equal(body.tool_choice, undefined)
}

async function testRequestBodyEmitsMaxTokensWhenSet(): Promise<void> {
	const body = buildMuseRequestBody({ ...baseRequest, maxTokens: 4096 }, "muse-spark-1.3")
	assert.equal(body.max_tokens, 4096)
	const bare = buildMuseRequestBody(baseRequest, "muse-spark-1.3")
	assert.equal(bare.max_tokens, undefined)
}

async function testRequestBodyPassesTemperature(): Promise<void> {
	const body = buildMuseRequestBody({ ...baseRequest, temperature: 0.5 }, "muse-spark-1.3")
	assert.equal(body.temperature, 0.5)
}

async function testRequestBodyAddsStreamFlagsOnlyWhenOptedIn(): Promise<void> {
	const streamed = buildMuseRequestBody({ ...baseRequest, stream: true }, "muse-spark-1.3")
	assert.equal(streamed.stream, true)
	assert.deepEqual(streamed.stream_options, { include_usage: true })
	const bare = buildMuseRequestBody(baseRequest, "muse-spark-1.3")
	assert.equal(bare.stream, undefined)
	assert.equal(bare.stream_options, undefined)
}

async function testRequestBodyIgnoresReasoningEffort(): Promise<void> {
	// The loop's low/medium/high/max vocabulary is DeepSeek's; Meta's own
	// reasoning_effort scale is unverified, so the client must not guess a
	// mapping onto a paid call — unset means Meta's default.
	const body = buildMuseRequestBody({ ...baseRequest, reasoningEffort: "max" }, "muse-spark-1.3")
	assert.equal(body.reasoning, undefined)
}

// ─── Model/key resolution ────────────────────────────────────────────────────

async function testResolveModelPrefersRequest(): Promise<void> {
	const client = new MuseClient({ apiKey: "k", defaultModel: "muse-spark-1.2" })
	assert.equal(client.resolveModel("muse-spark-1.3"), "muse-spark-1.3")
	assert.equal(client.resolveModel("  muse-spark-1.3  "), "muse-spark-1.3")
	assert.equal(client.resolveModel(undefined), "muse-spark-1.2")
	assert.equal(client.resolveModel(""), "muse-spark-1.2")
}

async function testConstructorReadsEnv(): Promise<void> {
	const saved = {
		key: process.env.HEADLESSCODE_MUSE_API_KEY,
		metaKey: process.env.MODEL_API_KEY,
		model: process.env.HEADLESSCODE_MUSE_MODEL,
		base: process.env.HEADLESSCODE_MUSE_BASE_URL,
	}
	try {
		delete process.env.HEADLESSCODE_MUSE_API_KEY
		delete process.env.MODEL_API_KEY
		delete process.env.HEADLESSCODE_MUSE_MODEL
		delete process.env.HEADLESSCODE_MUSE_BASE_URL
		// Bare client: Meta default model; key missing (createChatCompletion throws).
		const bare = new MuseClient()
		assert.equal(bare.resolveModel(undefined), DEFAULT_MUSE_MODEL)
		await assert.rejects(
			bare.createChatCompletion(baseRequest),
			/HEADLESSCODE_MUSE_API_KEY is not set/,
		)
		// Meta's own MODEL_API_KEY is honored as a fallback.
		process.env.MODEL_API_KEY = "LLM|1|meta-fallback"
		const viaMetaKey = new MuseClient({ baseUrl: "http://mock" })
		const restore = stubFetch(
			new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 }),
		)
		try {
			const response = await viaMetaKey.createChatCompletion(baseRequest)
			assert.equal(response.message.content, "ok")
		} finally {
			restore()
		}
		// HEADLESSCODE_MUSE_API_KEY wins over MODEL_API_KEY.
		let seenAuth = ""
		process.env.HEADLESSCODE_MUSE_API_KEY = "LLM|1|primary"
		const originalFetch = globalThis.fetch
		globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
			seenAuth = init?.headers?.["Authorization"] ?? ""
			return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 })
		}) as typeof fetch
		try {
			await new MuseClient({ baseUrl: "http://mock" }).createChatCompletion(baseRequest)
			assert.equal(seenAuth, "Bearer LLM|1|primary")
		} finally {
			globalThis.fetch = originalFetch
		}
		// HEADLESSCODE_MUSE_MODEL overrides the built-in default.
		process.env.HEADLESSCODE_MUSE_MODEL = "muse-spark-1.2"
		assert.equal(new MuseClient().resolveModel(undefined), "muse-spark-1.2")
	} finally {
		if (saved.key === undefined) delete process.env.HEADLESSCODE_MUSE_API_KEY
		else process.env.HEADLESSCODE_MUSE_API_KEY = saved.key
		if (saved.metaKey === undefined) delete process.env.MODEL_API_KEY
		else process.env.MODEL_API_KEY = saved.metaKey
		if (saved.model === undefined) delete process.env.HEADLESSCODE_MUSE_MODEL
		else process.env.HEADLESSCODE_MUSE_MODEL = saved.model
		if (saved.base === undefined) delete process.env.HEADLESSCODE_MUSE_BASE_URL
		else process.env.HEADLESSCODE_MUSE_BASE_URL = saved.base
	}
}

// ─── Non-streaming responses ─────────────────────────────────────────────────

async function testPostsToChatCompletionsWithBearerAuth(): Promise<void> {
	const client = new MuseClient({ apiKey: "LLM|1|secret", baseUrl: "http://mock/v1" })
	const originalFetch = globalThis.fetch
	let seenUrl = ""
	let seenAuth = ""
	let seenBody: Record<string, unknown> = {}
	globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
		seenUrl = String(url)
		seenAuth = init?.headers?.["Authorization"] ?? ""
		seenBody = JSON.parse(init?.body ?? "{}") as Record<string, unknown>
		return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 })
	}) as typeof fetch
	try {
		await client.createChatCompletion(baseRequest)
		assert.equal(seenUrl, "http://mock/v1/chat/completions")
		assert.equal(seenAuth, "Bearer LLM|1|secret")
		assert.equal(seenBody.model, "muse-spark-1.3")
	} finally {
		globalThis.fetch = originalFetch
	}
}

async function testResponseMapsMessageAndUsage(): Promise<void> {
	const client = new MuseClient({ apiKey: "k", baseUrl: "http://mock" })
	const restore = stubFetch(
		new Response(
			JSON.stringify({
				choices: [
					{
						message: {
							role: "assistant",
							content: "reading",
							tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }],
						},
					},
				],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 20,
					total_tokens: 120,
					prompt_tokens_details: { cached_tokens: 80 },
				},
			}),
			{ status: 200 },
		),
	)
	try {
		const response = await client.createChatCompletion(baseRequest)
		assert.equal(response.message.content, "reading")
		assert.deepEqual(response.message.tool_calls, [
			{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } },
		])
		assert.equal(response.usage?.promptTokens, 100)
		assert.equal(response.usage?.completionTokens, 20)
		assert.equal(response.usage?.totalTokens, 120)
		assert.equal(response.usage?.cachedTokens, 80)
	} finally {
		restore()
	}
}

async function testErrorEnvelopeFailsLoudly(): Promise<void> {
	const client = new MuseClient({ apiKey: "k", baseUrl: "http://mock" })
	const restore = stubFetch(
		new Response(JSON.stringify({ error: { message: "model not found", code: "model_not_found" } }), { status: 200 }),
	)
	try {
		await assert.rejects(client.createChatCompletion(baseRequest), /error envelope: model not found/)
	} finally {
		restore()
	}
}

async function testNon2xxFailsWithStatus(): Promise<void> {
	const client = new MuseClient({ apiKey: "k", baseUrl: "http://mock" })
	const restore = stubFetch(new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }))
	try {
		const err = await client.createChatCompletion(baseRequest).then(
			() => assert.fail("expected a throw"),
			(e: unknown) => e,
		)
		assert.ok(err instanceof MuseError)
		assert.equal(err.status, 401)
		assert.match(err.message, /HTTP 401/)
	} finally {
		restore()
	}
}

async function testMissingMessageFailsWithFinishReason(): Promise<void> {
	const client = new MuseClient({ apiKey: "k", baseUrl: "http://mock" })
	const restore = stubFetch(new Response(JSON.stringify({ choices: [{ finish_reason: "length" }] }), { status: 200 }))
	try {
		await assert.rejects(client.createChatCompletion(baseRequest), /no choices\[0\]\.message.*finish_reason: length/)
	} finally {
		restore()
	}
}

// ─── Streaming ───────────────────────────────────────────────────────────────

async function testStreamedTextAndToolCallsAssemble(): Promise<void> {
	const client = new MuseClient({ apiKey: "k", baseUrl: "http://mock" })
	const chunks: Array<[string, string]> = []
	const body = sse(
		{ choices: [{ delta: { role: "assistant" } }] },
		{ choices: [{ delta: { content: "Hello" } }] },
		{ choices: [{ delta: { content: " world" } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "{\"pa" } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a\"}" } }] } }] },
		{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		{ usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } },
		"[DONE]",
	)
	const restore = stubFetch(sseResponse(body))
	try {
		const response = await client.createChatCompletion({
			...baseRequest,
			stream: true,
			onStreamChunk: (kind, chunk) => chunks.push([kind, chunk]),
		})
		assert.equal(response.message.content, "Hello world")
		assert.deepEqual(response.message.tool_calls, [
			{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } },
		])
		assert.deepEqual(chunks, [
			["text", "Hello"],
			["text", " world"],
			["tool", "{\"pa"],
			["tool", "th\":\"a\"}"],
		])
		assert.equal(response.usage?.promptTokens, 50)
		assert.equal(response.usage?.completionTokens, 10)
	} finally {
		restore()
	}
}

async function testEmptyStreamFailsLoudly(): Promise<void> {
	const client = new MuseClient({ apiKey: "k", baseUrl: "http://mock" })
	const restore = stubFetch(sseResponse(sse("[DONE]")))
	try {
		await assert.rejects(client.createChatCompletion({ ...baseRequest, stream: true }), /no content, tool calls or usage/)
	} finally {
		restore()
	}
}

async function testStreamErrorEnvelopeFails(): Promise<void> {
	const client = new MuseClient({ apiKey: "k", baseUrl: "http://mock" })
	const restore = stubFetch(sseResponse(sse({ error: { message: "overloaded" } })))
	try {
		await assert.rejects(client.createChatCompletion({ ...baseRequest, stream: true }), /stream error envelope: overloaded/)
	} finally {
		restore()
	}
}

// ─── Static model info ───────────────────────────────────────────────────────

async function testFetchModelInfoReturnsWindowForMuseSpark(): Promise<void> {
	const client = new MuseClient({ apiKey: "k" })
	const info = await client.fetchModelInfo("muse-spark-1.3")
	assert.equal(info?.contextWindow, MUSE_CONTEXT_WINDOW_TOKENS)
	assert.equal(info?.contextWindow, 1_048_576)
	// No price: the loop would log a returned price as "resolved live pricing
	// from OpenRouter", which would be a lie — the hardcoded table is the
	// price source instead.
	assert.equal(info?.price, undefined)
}

async function testFetchModelInfoReturnsUndefinedForOtherIds(): Promise<void> {
	const client = new MuseClient({ apiKey: "k" })
	assert.equal(await client.fetchModelInfo("deepseek/deepseek-v4-flash-0731"), undefined)
	assert.equal(await client.fetchModelInfo("gpt-4o"), undefined)
}

// ─── Retry classification ────────────────────────────────────────────────────

async function testIsRetryableMuseErrorMatchesTransientShapes(): Promise<void> {
	assert.equal(isRetryableMuseError(new MuseError("Network error calling Meta Model API")), true, "transport failure must retry")
	assert.equal(isRetryableMuseError(new MuseError("rate limited", 429)), true, "429 must retry")
	assert.equal(isRetryableMuseError(new MuseError("overloaded", 503)), true, "5xx must retry")
	assert.equal(isRetryableMuseError(new MuseError("server error", 500)), true, "500 must retry")
}

async function testIsRetryableMuseErrorRejectsDeterministicFailures(): Promise<void> {
	assert.equal(isRetryableMuseError(new MuseError("invalid api key", 401)), false, "401 must not retry")
	assert.equal(isRetryableMuseError(new MuseError("bad request", 400)), false, "400 must not retry")
	assert.equal(isRetryableMuseError(new MuseError("not found", 404)), false, "404 must not retry")
	assert.equal(isRetryableMuseError(new Error("some unrelated error")), false, "a non-MuseError must never retry")
}

// ─── Provider selection ──────────────────────────────────────────────────────

async function testResolveLlmProviderDefaultsAndValues(): Promise<void> {
	assert.equal(resolveLlmProvider({}), "openrouter")
	assert.equal(resolveLlmProvider({ HEADLESSCODE_LLM_PROVIDER: "" }), "openrouter")
	assert.equal(resolveLlmProvider({ HEADLESSCODE_LLM_PROVIDER: "openrouter" }), "openrouter")
	assert.equal(resolveLlmProvider({ HEADLESSCODE_LLM_PROVIDER: "muse" }), "muse")
	assert.equal(resolveLlmProvider({ HEADLESSCODE_LLM_PROVIDER: "Muse" }), "muse")
	assert.equal(resolveLlmProvider({ HEADLESSCODE_LLM_PROVIDER: "  muse  " }), "muse")
}

async function testResolveLlmProviderFailsLoudlyOnTypo(): Promise<void> {
	assert.throws(() => resolveLlmProvider({ HEADLESSCODE_LLM_PROVIDER: "meta" }), /must be "openrouter" or "muse"/)
	assert.throws(() => resolveLlmProvider({ HEADLESSCODE_LLM_PROVIDER: "anthropic" }), /must be "openrouter" or "muse"/)
}

async function testResolveLlmProviderOrReport(): Promise<void> {
	assert.equal(resolveLlmProviderOrReport(() => {}, {}), "openrouter")
	assert.equal(resolveLlmProviderOrReport(() => {}, { HEADLESSCODE_LLM_PROVIDER: "muse" }), "muse")
	let written = ""
	const result = resolveLlmProviderOrReport((t) => {
		written += t
	}, { HEADLESSCODE_LLM_PROVIDER: "meta" })
	assert.equal(result, undefined)
	assert.match(written, /must be "openrouter" or "muse"/)
}

async function testProviderDefaultModel(): Promise<void> {
	assert.equal(providerDefaultModel("muse"), DEFAULT_MUSE_MODEL)
	assert.equal(providerDefaultModel("openrouter"), undefined)
}

async function testBaseUrlDefault(): Promise<void> {
	assert.equal(MUSE_BASE_URL, "https://api.meta.ai/v1")
}

const tests: Array<[string, () => Promise<void>]> = [
	["buildMuseRequestBody passes model + messages through", testRequestBodyPassesModelAndMessages],
	["buildMuseRequestBody never carries a provider pin or reasoning flag", testRequestBodyHasNoProviderPinOrReasoningFlag],
	["buildMuseRequestBody emits tools only when non-empty", testRequestBodyEmitsToolsOnlyWhenNonEmpty],
	["buildMuseRequestBody passes tool_choice through with tools", testRequestBodyPassesToolChoiceWithTools],
	["buildMuseRequestBody omits tool_choice without tools", testRequestBodyOmitsToolChoiceWithoutTools],
	["buildMuseRequestBody emits max_tokens when set, omits it when unset", testRequestBodyEmitsMaxTokensWhenSet],
	["buildMuseRequestBody passes temperature through", testRequestBodyPassesTemperature],
	["buildMuseRequestBody adds stream flags only when opted in", testRequestBodyAddsStreamFlagsOnlyWhenOptedIn],
	["buildMuseRequestBody ignores reasoningEffort (unverified scale)", testRequestBodyIgnoresReasoningEffort],
	["resolveModel prefers the request model, trims, falls back to default", testResolveModelPrefersRequest],
	["constructor resolves key/model from env (MODEL_API_KEY fallback)", testConstructorReadsEnv],
	["createChatCompletion posts to /chat/completions with Bearer auth", testPostsToChatCompletionsWithBearerAuth],
	["createChatCompletion maps message + usage incl. cached tokens", testResponseMapsMessageAndUsage],
	["a 200 error envelope fails loudly", testErrorEnvelopeFailsLoudly],
	["a non-2xx fails with status + excerpt", testNon2xxFailsWithStatus],
	["a missing message fails with the finish reason", testMissingMessageFailsWithFinishReason],
	["streamed text + tool calls assemble, chunks emit in order", testStreamedTextAndToolCallsAssemble],
	["an empty stream fails loudly, not silently", testEmptyStreamFailsLoudly],
	["a mid-stream error envelope fails", testStreamErrorEnvelopeFails],
	["fetchModelInfo returns the 1M window (no price) for muse-spark-*", testFetchModelInfoReturnsWindowForMuseSpark],
	["fetchModelInfo returns undefined for non-Muse ids", testFetchModelInfoReturnsUndefinedForOtherIds],
	["isRetryableMuseError matches network/429/5xx shapes", testIsRetryableMuseErrorMatchesTransientShapes],
	["isRetryableMuseError rejects deterministic 4xx and foreign errors", testIsRetryableMuseErrorRejectsDeterministicFailures],
	["resolveLlmProvider defaults + values", testResolveLlmProviderDefaultsAndValues],
	["resolveLlmProvider fails loudly on typos", testResolveLlmProviderFailsLoudlyOnTypo],
	["resolveLlmProviderOrReport reports cleanly", testResolveLlmProviderOrReport],
	["providerDefaultModel is eager for muse, lazy for openrouter", testProviderDefaultModel],
	["MUSE_BASE_URL is the documented Meta endpoint", testBaseUrlDefault],
]

runMain("muse client", tests)
