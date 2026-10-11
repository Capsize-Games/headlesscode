/**
 * Unit tests for src/llm/openrouter.ts's request-building logic + the
 * streaming-and-reasoning paths. Plain assert-based script (no test
 * framework, no network), run via
 * `npm test` -> `tsx src/llm/__tests__/openrouter.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { estimateCost } from "../../budget/cost.js"

import { buildRequestBody, isRetryableOpenRouterError, OpenRouterClient, OpenRouterError, parseReasoningEffort } from "../openrouter.js"
import { PromptByteBudgetError } from "../request-budget.js"
import type { LlmRequest } from "../../engine/types.js"

const baseRequest: LlmRequest = {
	model: "irrelevant-here",
	messages: [{ role: "user", content: "hi" }],
}

/**
 * Regression test (2026-08-01 incident): DEFAULT_PRICING_TABLE's deepseek/*
 * entries (src/budget/cost.ts) are only correct because requests are pinned
 * to DeepSeek's own official endpoint — without this pin, OpenRouter's
 * automatic routing could serve a request from a different host (DeepInfra,
 * Baidu, Mancer, ...) with a meaningfully different real price, especially
 * for cache reads, silently invalidating our pricing table.
 */
async function testDeepseekModelsArePinnedToOfficialProvider(): Promise<void> {
	const body = buildRequestBody(baseRequest, "deepseek/deepseek-v4-flash")
	assert.deepEqual(body.provider, { order: ["deepseek"], allow_fallbacks: false })
}

async function testDeepseekReasonerAlsoPinned(): Promise<void> {
	// The pin is keyed off the "deepseek/" prefix, not one specific model id.
	const body = buildRequestBody(baseRequest, "deepseek/deepseek-reasoner")
	assert.deepEqual(body.provider, { order: ["deepseek"], allow_fallbacks: false })
}

async function testRsiProofModelUsesPinnedDeepinfraRoute(): Promise<void> {
	const body = buildRequestBody({ ...baseRequest, reasoningEffort: "high" }, "deepseek/deepseek-v4-flash-0731")
	assert.deepEqual(body.provider, { only: ["deepinfra"], allow_fallbacks: false })
	assert.equal(body.include_reasoning, undefined, "the selected DeepInfra endpoint does not advertise include_reasoning")
	assert.equal(body.reasoning, undefined, "the selected DeepInfra endpoint does not advertise reasoning effort")
}

async function testNonDeepseekModelsAreNotPinned(): Promise<void> {
	const body = buildRequestBody(baseRequest, "anthropic/claude-3.5-sonnet")
	assert.equal(body.provider, undefined, "pinning to the deepseek provider for a non-deepseek model would be wrong")
}

/**
 * `max_tokens` is emitted on the wire exactly when the request carries a
 * `maxTokens` cap — the condensation path relies on this to always bound its
 * output (the session now always resolves a condenseMaxTokens default).
 */
async function testRequestBodyEmitsMaxTokensWhenSet(): Promise<void> {
	const body = buildRequestBody({ ...baseRequest, maxTokens: 4096 }, "deepseek/deepseek-v4-flash")
	assert.equal(body.max_tokens, 4096, "max_tokens must be emitted when maxTokens is set")
	const bare = buildRequestBody(baseRequest, "deepseek/deepseek-v4-flash")
	assert.equal(bare.max_tokens, undefined, "max_tokens must be omitted when maxTokens is unset")
}

async function testOpaqueCacheRoutingKeyIsForwardedWithoutIdentityData(): Promise<void> {
	const key = "hc-123e4567-e89b-42d3-a456-426614174000"
	const body = buildRequestBody({ ...baseRequest, cacheRoutingKey: key }, "meta/muse-spark-1.3-contributor")
	assert.equal(body.session_id, key)
	assert.equal(body.prompt_cache_key, key)
	assert.equal(JSON.stringify(body).includes("user@example.com"), false)
	assert.throws(() => buildRequestBody({ ...baseRequest, cacheRoutingKey: "alice@example.com" }, "meta/muse-spark-1.3-contributor"), /opaque headlesscode UUID/)
}

async function testMuseQualificationPinsOnlyMetaWithoutFallback(): Promise<void> {
	const body = buildRequestBody({ ...baseRequest, providerOnly: "meta" }, "meta/muse-spark-1.3-contributor")
	assert.deepEqual(body.provider, { only: ["meta"], allow_fallbacks: false })
	assert.throws(() => buildRequestBody({ ...baseRequest, providerOnly: "meta" }, "another/model"), /supported only for Meta-routed Muse/)
}

function captureChatRequest(client: OpenRouterClient, request: LlmRequest): Promise<{ body: Record<string, any>; json: string; calls: number }> {
	const originalFetch = globalThis.fetch
	let body: Record<string, any> | undefined
	let json = ""
	let calls = 0
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		calls++
		json = String(init?.body ?? "")
		body = JSON.parse(json)
		if (request.stream) {
			return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } })
		}
		return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 })
	}) as typeof fetch
	return client.createChatCompletion(request).then(() => ({ body: body!, json, calls })).finally(() => { globalThis.fetch = originalFetch })
}

async function testExactUtf8WireBoundaryForStreamAndNonStream(): Promise<void> {
	const cacheRoutingKey = "hc-123e4567-e89b-42d3-a456-426614174000"
	const tools = [{ type: "function" as const, function: { name: "read_file", description: "read \"quoted\" paths", parameters: { type: "object", properties: { path: { type: "string" } } } } }]
	for (const stream of [false, true]) {
		const request: LlmRequest = {
			model: "meta/muse-spark-1.3-contributor",
			messages: [
				{ role: "system", content: "Keep 🙂, quotes \" and backslash \\ verbatim." },
				{ role: "user", content: "Initial task\nDo not rewrite this prefix." },
			],
			tools,
			cacheRoutingKey,
			stream,
		}
		const expectedJson = JSON.stringify(buildRequestBody(request, request.model))
		const exactBytes = Buffer.byteLength(expectedJson, "utf8")
		const success = await captureChatRequest(new OpenRouterClient({ apiKey: "synthetic", baseUrl: "http://mock", maxPromptBytes: exactBytes }), request)
		assert.equal(success.json, expectedJson, `${stream ? "stream" : "non-stream"} sends the exact measured JSON at the boundary`)
		assert.equal(Buffer.byteLength(success.json, "utf8"), exactBytes)
		assert.equal(success.body.prompt_cache_key, cacheRoutingKey)
		assert.deepEqual(success.body.tools, tools, "tool schemas are not rewritten")
		let calls = 0
		const originalFetch = globalThis.fetch
		globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }) }) as typeof fetch
		try {
			const client = new OpenRouterClient({ apiKey: "synthetic", baseUrl: "http://mock", maxPromptBytes: exactBytes - 1 })
			await assert.rejects(client.createChatCompletion(request), /budget/)
			assert.equal(calls, 0, "one byte below the mandatory request fails before transport")
		} finally { globalThis.fetch = originalFetch }
	}
}

async function testOversizedLatestToolGroupIsClippedWithoutMutatingEvidence(): Promise<void> {
	const cacheRoutingKey = "hc-123e4567-e89b-42d3-a456-426614174000"
	const tools = [{ type: "function" as const, function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }]
	const latestCalls = Array.from({ length: 4 }, (_, index) => ({ id: `new-${index}`, type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: `file-${index}.ts`, retained: `arg-${index}` }) } }))
	const denseChunk = ["é", "🙂", "\\", "\"", "\n"].join("")
	const messages: LlmRequest["messages"] = [
		{ role: "system", content: "stable system prefix" },
		{ role: "user", content: "stable first task" },
		{ role: "assistant", content: null, tool_calls: [{ id: "old-call", type: "function", function: { name: "read_file", arguments: "{\"path\":\"old\"}" } }] },
		{ role: "tool", tool_call_id: "old-call", name: "read_file", content: "old result" },
		{ role: "assistant", content: null, tool_calls: latestCalls },
		...latestCalls.map((call, index) => ({ role: "tool" as const, tool_call_id: call.id, name: "read_file", content: `${denseChunk.repeat(5_000)}-${index}` })),
	]
	const request: LlmRequest = { model: "meta/muse-spark-1.3-contributor", messages, tools, cacheRoutingKey }
	const original = JSON.stringify(messages)
	const maxPromptBytes = 55_000
	const result = await captureChatRequest(new OpenRouterClient({ apiKey: "synthetic", baseUrl: "http://mock", maxPromptBytes }), request)
	assert.ok(Buffer.byteLength(result.json, "utf8") <= maxPromptBytes, "four large UTF-8 results fit the exact request budget")
	assert.equal(JSON.stringify(messages), original, "packing never mutates engine messages or original tool evidence")
	assert.deepEqual(result.body.messages.slice(0, 2), messages.slice(0, 2), "system and first-user prefix stay verbatim")
	assert.equal(result.body.messages.some((message: { tool_call_id?: string }) => message.tool_call_id === "old-call"), false, "an older complete tool-call group is evicted as a unit")
	assert.equal(result.body.messages.some((message: { tool_calls?: typeof latestCalls }) => message.tool_calls?.some((call) => call.id === "old-call")), false, "evicting an older result also removes its assistant call")
	const packedAssistant = result.body.messages.find((message: { role: string; tool_calls?: typeof latestCalls }) => message.role === "assistant" && message.tool_calls?.some((call) => call.id === "new-0"))
	assert.ok(packedAssistant, "newest tool-call group remains")
	assert.deepEqual(packedAssistant.tool_calls, latestCalls, "all tool IDs and arguments are unchanged")
	const packedResults = result.body.messages.filter((message: { role: string; tool_call_id?: string }) => message.role === "tool")
	assert.deepEqual(packedResults.map((message: { tool_call_id: string }) => message.tool_call_id), latestCalls.map((call) => call.id), "every retained call has exactly its matching result")
	assert.ok(packedResults.every((message: { content: string }) => message.content.includes("shortened to fit the request byte budget")), "each shortened excerpt carries an explicit notice")
	assert.ok(packedResults.every((message: { content: string }, index: number) => message.content.length < messages[index + 5]!.content!.length), "only transmitted tool-result copies are shortened")
	assert.ok(packedResults.every((message: { content: string }) => isWellFormedUnicode(message.content)), "excerpt clipping never leaves a lone UTF-16 surrogate")
	assert.equal(result.body.prompt_cache_key, cacheRoutingKey, "cache routing key remains stable")
	assert.deepEqual(result.body.tools, tools, "tool schemas remain verbatim")
}

function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1)
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false
			index++
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false
		}
	}
	return true
}

async function testRoleAwarePrefixKeepsUserOnlyAndMultipleSystemHistories(): Promise<void> {
	const userOnly: LlmRequest["messages"] = [
		{ role: "user", content: "initial user task without a system message" },
		{ role: "assistant", content: null, tool_calls: [{ id: "user-only-call", type: "function", function: { name: "read_file", arguments: "{\"path\":\"large.txt\"}" } }] },
		{ role: "tool", tool_call_id: "user-only-call", name: "read_file", content: "é🙂\\\"\n".repeat(1_500) },
	]
	const userOnlyResult = await captureChatRequest(
		new OpenRouterClient({ apiKey: "synthetic", baseUrl: "http://mock", maxPromptBytes: 1_100 }),
		{ model: "meta/muse-spark-1.3-contributor", messages: userOnly },
	)
	assert.deepEqual(userOnlyResult.body.messages[0], userOnly[0], "user-only history preserves its first task verbatim")
	assert.equal(userOnlyResult.body.messages[1].tool_calls[0].id, "user-only-call", "user-only history keeps its assistant tool call")
	assert.equal(userOnlyResult.body.messages[2].tool_call_id, "user-only-call", "user-only history keeps the corresponding result")
	assert.ok(userOnlyResult.body.messages[2].content.includes("shortened to fit the request byte budget"), "the user-only result is clipped rather than split from its call")
	assert.ok(isWellFormedUnicode(userOnlyResult.body.messages[2].content), "user-only Unicode excerpt remains well formed")

	const multipleSystems: LlmRequest["messages"] = [
		{ role: "system", content: "first system" },
		{ role: "system", content: "second system with 🙂" },
		{ role: "user", content: "first user task" },
		{ role: "assistant", content: "older assistant turn" },
		{ role: "assistant", content: null, tool_calls: [{ id: "latest-call", type: "function", function: { name: "read_file", arguments: "{\"path\":\"latest\"}" } }] },
		{ role: "tool", tool_call_id: "latest-call", name: "read_file", content: "latest result" },
	]
	const multiSystemRequest: LlmRequest = { model: "meta/muse-spark-1.3-contributor", messages: multipleSystems }
	const multiSystemBody = buildRequestBody(multiSystemRequest, multiSystemRequest.model)
	const multiSystemLimit = Math.max(600, Buffer.byteLength(JSON.stringify({ ...multiSystemBody, messages: multipleSystems.slice(0, 4) }), "utf8"))
	const multiSystemResult = await captureChatRequest(
		new OpenRouterClient({ apiKey: "synthetic", baseUrl: "http://mock", maxPromptBytes: multiSystemLimit }),
		multiSystemRequest,
	)
	assert.deepEqual(multiSystemResult.body.messages.slice(0, 3), multipleSystems.slice(0, 3), "all leading systems and the initial user stay verbatim")
	assert.ok(multiSystemResult.body.messages.some((message: { tool_calls?: Array<{ id: string }> }) => message.tool_calls?.some((call) => call.id === "latest-call")), "latest complete group is retained when old history is removed")
}

async function testImpossiblePrefixAndInvalidBudgetsFailBeforeNetwork(): Promise<void> {
	const request: LlmRequest = { model: "meta/muse-spark-1.3-contributor", messages: [{ role: "system", content: "mandatory system" }, { role: "user", content: "mandatory task" }] }
	for (const maxPromptBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => new OpenRouterClient({ maxPromptBytes }), /positive safe integer/)
	}
	const previous = process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES
	try {
		process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES = "bad"
		assert.throws(() => new OpenRouterClient(), /HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES/)
		process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES = "0"
		assert.throws(() => new OpenRouterClient(), /positive safe integer/)
		delete process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES
	} finally {
		if (previous === undefined) delete process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES
		else process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES = previous
	}
	let calls = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }) }) as typeof fetch
	try {
		const requiredBytes = Buffer.byteLength(JSON.stringify(buildRequestBody(request, request.model)), "utf8")
		process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES = String(requiredBytes - 1)
		try {
			const envConfigured = new OpenRouterClient({ apiKey: "synthetic" })
			await assert.rejects(envConfigured.createChatCompletion(request), /budget/)
			assert.equal(calls, 0, "the byte limit is read from the documented environment variable")
		} finally {
			if (previous === undefined) delete process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES
			else process.env.HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES = previous
		}
		const client = new OpenRouterClient({ apiKey: "synthetic", maxPromptBytes: 8 })
		await assert.rejects(client.createChatCompletion(request), (error: unknown) => {
			assert.ok(error instanceof PromptByteBudgetError, "budget preflight uses a distinct local error")
			assert.equal(isRetryableOpenRouterError(error), false, "budget errors are not classified as retryable transport failures")
			assert.match(error.message, /required prompt.*exceeding/)
			return true
		})
		assert.equal(calls, 0, "an impossible required prefix makes no network request")
		const incomplete: LlmRequest = {
			model: "meta/muse-spark-1.3-contributor",
			messages: [
				{ role: "system", content: "system" },
				{ role: "user", content: "task" },
				{ role: "assistant", content: null, tool_calls: [
					{ id: "partial-a", type: "function", function: { name: "read_file", arguments: "{}" } },
					{ id: "missing-b", type: "function", function: { name: "read_file", arguments: "{}" } },
				] },
				{ role: "tool", tool_call_id: "partial-a", name: "read_file", content: "result-".repeat(500) },
			],
		}
		await assert.rejects(new OpenRouterClient({ apiKey: "synthetic", maxPromptBytes: 900 }).createChatCompletion(incomplete), /incomplete/)
		assert.equal(calls, 0, "an over-budget incomplete call/result group is rejected instead of orphaning a tool")
		assert.equal(isRetryableOpenRouterError(new OpenRouterError("transport", undefined)), true, "ordinary transport failures remain retryable")
	} finally { globalThis.fetch = originalFetch }
}

async function testTranscriptSeparatesPackedWireMessagesFromOriginalHistory(): Promise<void> {
	const scratch = path.resolve(".headlesscode/scratch/openrouter-byte-budget-transcript")
	fs.rmSync(scratch, { recursive: true, force: true })
	fs.mkdirSync(scratch, { recursive: true })
	const previous = process.env.HEADLESSCODE_CAPTURE_TRANSCRIPT_DIR
	process.env.HEADLESSCODE_CAPTURE_TRANSCRIPT_DIR = scratch
	const messages: LlmRequest["messages"] = [
		{ role: "system", content: "system" },
		{ role: "user", content: "task" },
		{ role: "assistant", content: null, tool_calls: [{ id: "tc", type: "function", function: { name: "read_file", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "tc", name: "read_file", content: "evidence-".repeat(500) },
	]
	const original = JSON.stringify(messages)
	try {
		for (const stream of [false, true]) {
			await captureChatRequest(new OpenRouterClient({ apiKey: "synthetic", baseUrl: "http://mock", maxPromptBytes: 900 }), { model: "meta/muse-spark-1.3-contributor", messages, stream })
		}
		const file = fs.readdirSync(scratch).find((entry) => entry.startsWith("openrouter-"))
		assert.ok(file, "transcript was captured")
		const records = fs.readFileSync(path.join(scratch, file!), "utf8").trim().split("\n").map((line) => JSON.parse(line))
		assert.equal(records.length, 2, "streaming and non-streaming calls are both transcribed")
		for (const record of records) {
			assert.deepEqual(record.messages, record.wireRequest.messages, "transcript messages are the actual packed request view")
			assert.deepEqual(record.originalMessages, messages, "the complete original engine history remains recorded")
			assert.notEqual(JSON.stringify(record.messages), original, "packed transcript is distinguishable from full local evidence")
		}
		assert.equal(records.find((record) => record.wireRequest.stream === true)?.wireRequest.stream_options.include_usage, true, "stream transcript records the actual measured stream options")
	} finally {
		if (previous === undefined) delete process.env.HEADLESSCODE_CAPTURE_TRANSCRIPT_DIR
		else process.env.HEADLESSCODE_CAPTURE_TRANSCRIPT_DIR = previous
		fs.rmSync(scratch, { recursive: true, force: true })
	}
}

async function testOpenRouterUsageCostAndGenerationMetadataAreMapped(): Promise<void> {
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const originalFetch = globalThis.fetch
	let call = 0
	globalThis.fetch = (async (url: string | URL | Request) => {
		call++
		if (String(url).includes("/api/v1/generation?")) {
			return new Response(JSON.stringify({ data: {
				id: "gen-abc-123", model: "meta/muse-spark-1.3-contributor", provider_name: "Meta",
				total_cost: 0.00012, upstream_inference_cost: 0.00011, cache_discount: 0.00003,
				tokens_prompt: 1200, tokens_completion: 8, native_tokens_reasoning: 2, native_tokens_cached: 1100, latency: 900,
			} }), { status: 200 })
		}
		return new Response(JSON.stringify({
			id: "chatcmpl-x", model: "meta/muse-spark-1.3-contributor", provider_name: "Meta",
			choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208,
				prompt_tokens_details: { cached_tokens: 1100, cache_write_tokens: 0 },
				completion_tokens_details: { reasoning_tokens: 2 }, cost: 0.00012, cache_discount: 0.00003 },
		}), { status: 200, headers: { "X-Generation-Id": "gen-abc-123" } })
	}) as typeof fetch
	try {
		const response = await client.createChatCompletion({ model: "meta/muse-spark-1.3-contributor", messages: [{ role: "user", content: "synthetic" }] })
		assert.equal(response.generationId, "gen-abc-123")
		assert.equal(response.returnedModel, "meta/muse-spark-1.3-contributor")
		assert.equal(response.providerName, "Meta")
		assert.equal(response.usage?.cachedTokens, 1100)
		assert.equal(response.usage?.cacheWriteTokens, 0)
		assert.equal(response.usage?.reasoningTokens, 2)
		assert.equal(response.usage?.openRouterReportedCostUsd, 0.00012)
		assert.equal(response.usage?.cacheDiscountUsd, 0.00003)
		assert.ok(response.generationId)
		const metadata = await client.fetchGenerationMetadata(response.generationId)
		assert.deepEqual(metadata, {
			id: "gen-abc-123", model: "meta/muse-spark-1.3-contributor", providerName: "Meta",
			totalCostUsd: 0.00012, upstreamInferenceCostUsd: 0.00011, cacheDiscountUsd: 0.00003,
			tokensPrompt: 1200, tokensCompletion: 8, nativeTokensReasoning: 2, nativeTokensCached: 1100, latencyMs: 900,
		})
		assert.equal(call, 2)
	} finally { globalThis.fetch = originalFetch }
}

async function testMalformedGenerationBillingIsNotReportedAsAuthoritative(): Promise<void> {
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const restore = stubFetch(new Response(JSON.stringify({ data: { id: "gen-safe", total_cost: "unknown", cache_discount: "bad" } }), { status: 200 }))
	try {
		assert.deepEqual(await client.fetchGenerationMetadata("gen-safe"), { id: "gen-safe" })
		assert.equal(await client.fetchGenerationMetadata("not-a-generation-id"), undefined)
	} finally { restore() }
}

async function testGenerationMetadataRetriesAfterDelayedVisibility(): Promise<void> {
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const originalFetch = globalThis.fetch
	let lookups = 0
	globalThis.fetch = (async () => {
		lookups++
		if (lookups === 1) return new Response("not available yet", { status: 404 })
		return new Response(JSON.stringify({ data: { id: "gen-delayed", model: "meta/muse-spark-1.3-contributor-20260902", provider_name: "Meta", total_cost: 0.0002858 } }), { status: 200 })
	}) as typeof fetch
	try {
		const started = Date.now()
		const metadata = await client.fetchGenerationMetadata("gen-delayed", AbortSignal.timeout(10_000))
		assert.equal(lookups, 2, "the delayed generation record is retried")
		assert.ok(Date.now() - started >= 900, "the retry waits for the first 1-second backoff before requesting again")
		assert.equal(metadata?.model, "meta/muse-spark-1.3-contributor-20260902")
		assert.equal(metadata?.totalCostUsd, 0.0002858)
	} finally { globalThis.fetch = originalFetch }
}

async function testMalformedUsageCountsCannotCreateCacheDiscount(): Promise<void> {
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	for (const invalidCachedCount of ["-1", "1.5", "101", "1e999"]) {
		const restore = stubFetch(new Response(`{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":100,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":${invalidCachedCount}}}}`, { status: 200 }))
		try {
			const response = await client.createChatCompletion({ model: "meta/muse-spark-1.3-contributor", messages: [{ role: "user", content: "test" }] })
			assert.equal(response.usage?.promptTokens, 100)
			assert.equal(response.usage?.cachedTokens, undefined, `${invalidCachedCount} cached count must not activate discounted guardrail pricing`)
			assert.equal(estimateCost({
				model: "meta/muse-spark-1.3-contributor",
				inputTokens: response.usage?.promptTokens,
				outputTokens: response.usage?.completionTokens,
				cachedTokens: response.usage?.cachedTokens,
			}), 0.0000104, `${invalidCachedCount} cache count leaves every prompt token at the full guardrail rate`)
		} finally { restore() }
	}
	const restore = stubFetch(new Response(JSON.stringify({
		choices: [{ message: { role: "assistant", content: "ok" } }],
		usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1.5 } },
	}), { status: 200 }))
	try {
		const response = await client.createChatCompletion({ model: "meta/muse-spark-1.3-contributor", messages: [{ role: "user", content: "test" }] })
		assert.equal(response.usage?.cacheWriteTokens, undefined, "fractional counts are not trusted as token telemetry")
	} finally { restore() }
}

// ─── fetchModelContextWindow (Phase 3 condensation trigger) ─────────────────

async function testFetchModelContextWindowParsesEndpoints(): Promise<void> {
	// A fake OpenRouter models-endpoint response with multiple endpoints —
	// the largest non-zero context_length must win.
	const { OpenRouterClient } = await import("../openrouter.js")
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (url: string | URL | Request) => {
		// The model id slug must keep its LITERAL `provider/model` slash —
		// percent-encoding the whole id (deepseek%2Fdeepseek-v4-flash) makes
		// OpenRouter 404 (regression fixed 2026-08-04).
		assert.match(String(url), /\/api\/v1\/models\/deepseek\/deepseek-v4-flash\/endpoints$/)
		return new Response(
			JSON.stringify({
				data: {
					id: "deepseek/deepseek-v4-flash",
					endpoints: [
						{ context_length: 131072, id: "host-a" },
						{ context_length: 1048576, id: "official-deepseek" },
						{ context_length: 0, id: "broken" },
					],
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		)
	}) as typeof fetch
	try {
		const windowTokens = await client.fetchModelContextWindow("deepseek/deepseek-v4-flash")
		assert.equal(windowTokens, 1048576, "the largest non-zero context_length across endpoints wins")
	} finally {
		globalThis.fetch = originalFetch
	}
}

async function testFetchModelContextWindowAcceptsLegacyArrayShape(): Promise<void> {
	// Defensive: some proxies return the older `{"data":[...]}` array shape.
	const { OpenRouterClient } = await import("../openrouter.js")
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				data: [
					{ context_length: 131072, id: "host-a" },
					{ context_length: 1048576, id: "official-deepseek" },
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		)) as typeof fetch
	try {
		const windowTokens = await client.fetchModelContextWindow("deepseek/deepseek-v4-flash")
		assert.equal(windowTokens, 1048576, "legacy array shape still resolves the largest non-zero window")
	} finally {
		globalThis.fetch = originalFetch
	}
}

async function testFetchModelContextWindowReturnsUndefinedOnFailure(): Promise<void> {
	const { OpenRouterClient } = await import("../openrouter.js")
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const originalFetch = globalThis.fetch
	// 404 (unknown model) -> undefined, not throw.
	globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch
	try {
		assert.equal(await client.fetchModelContextWindow("nope/model"), undefined)
	} finally {
		globalThis.fetch = originalFetch
	}
	// No API key -> undefined without even fetching.
	const noKey = new OpenRouterClient({ baseUrl: "http://mock" })
	assert.equal(await noKey.fetchModelContextWindow("deepseek/deepseek-chat"), undefined)
}

async function testFetchModelContextWindowRetriesTransientFailure(): Promise<void> {
	// This lookup happens at most once per session and the loop never
	// re-attempts, so a transient hiccup must not silently poison the session
	// with the 128k default. A transport failure followed by a 200 must resolve
	// the live window (and a 503 similarly).
	const { OpenRouterClient } = await import("../openrouter.js")
	const originalFetch = globalThis.fetch
	let calls = 0
	try {
		const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
		globalThis.fetch = (async () => {
			calls++
			if (calls === 1) {
				throw new TypeError("fetch failed (transient)")
			}
			return new Response(
				JSON.stringify({
					data: {
						id: "deepseek/deepseek-v4-flash",
						endpoints: [{ context_length: 1048576, id: "official-deepseek" }],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			)
		}) as typeof fetch
		assert.equal(await client.fetchModelContextWindow("deepseek/deepseek-v4-flash"), 1048576)
		assert.equal(calls, 2, "transport failure retried exactly once")

		// 503 -> retry once -> 200.
		calls = 0
		globalThis.fetch = (async () => {
			calls++
			if (calls === 1) {
				return new Response("overloaded", { status: 503 })
			}
			return new Response(
				JSON.stringify({
					data: {
						id: "deepseek/deepseek-v4-flash",
						endpoints: [{ context_length: 131072, id: "host-a" }],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			)
		}) as typeof fetch
		assert.equal(await client.fetchModelContextWindow("deepseek/deepseek-v4-flash"), 131072)
		assert.equal(calls, 2, "5xx retried exactly once")

		// Deterministic 404 is NOT retried — exactly one call.
		calls = 0
		globalThis.fetch = (async () => {
			calls++
			return new Response("not found", { status: 404 })
		}) as typeof fetch
		assert.equal(await client.fetchModelContextWindow("nope/model"), undefined)
		assert.equal(calls, 1, "404 is deterministic and must not be retried")
	} finally {
		globalThis.fetch = originalFetch
	}
}

// ─── live pricing via fetchModelInfo (Part E: same endpoints response as the
// context-window lookup; issue #86 dropped the unused fetchModelPricing
// wrapper — loop.ts calls fetchModelInfo directly and reads `.price` off the
// result, so these assert against fetchModelInfo instead) ─

async function testFetchModelPricingPrefersPinnedProvider(): Promise<void> {
	// deepseek/* pins routing to the official endpoint — the live price must
	// be THAT endpoint's numbers, not a cheaper third-party host's.
	const { OpenRouterClient } = await import("../openrouter.js")
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				data: {
					id: "deepseek/deepseek-v4-flash",
					endpoints: [
						{
							provider_name: "DeepInfra",
							context_length: 131072,
							pricing: { prompt: "0.00000009", completion: "0.00000018", input_cache_read: "0.000000018" },
						},
						{
							provider_name: "DeepSeek",
							context_length: 1048576,
							pricing: { prompt: "0.00000014", completion: "0.00000028", input_cache_read: "0.0000000028" },
						},
					],
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		)) as typeof fetch
	try {
		const price = (await client.fetchModelInfo("deepseek/deepseek-v4-flash"))?.price
		assert.ok(price, "a live price is resolved")
		assert.ok(Math.abs(price.input - 0.14) < 1e-9, `official DeepSeek prompt price wins, got $${price.input}`)
		assert.ok(Math.abs(price.output - 0.28) < 1e-9, `official DeepSeek completion price wins, got $${price.output}`)
		assert.ok(Math.abs(price.cacheRead! - 0.0028) < 1e-9, `official DeepSeek cacheRead wins, got $${price.cacheRead}`)
	} finally {
		globalThis.fetch = originalFetch
	}
}

async function testFetchModelPricingFailOpen(): Promise<void> {
	// 404/unknown model → undefined, so the caller falls back to the
	// hardcoded table exactly as before live pricing existed.
	const { OpenRouterClient } = await import("../openrouter.js")
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch
	try {
		assert.equal(await client.fetchModelInfo("nope/model"), undefined)
	} finally {
		globalThis.fetch = originalFetch
	}
	// No pricing fields on the endpoints → price undefined.
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({ data: { id: "m/m", endpoints: [{ provider_name: "HostA", context_length: 131072 }] } }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		)) as typeof fetch
	try {
		assert.equal((await client.fetchModelInfo("m/m"))?.price, undefined)
	} finally {
		globalThis.fetch = originalFetch
	}
	const noKey = new OpenRouterClient({ baseUrl: "http://mock" })
	assert.equal(await noKey.fetchModelInfo("deepseek/deepseek-v4-flash"), undefined)
}

async function testFetchModelInfoSharesOneFetch(): Promise<void> {
	// fetchModelInfo returns context window AND price from the same response —
	// a session pays for exactly ONE lookup, not two.
	const { OpenRouterClient } = await import("../openrouter.js")
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const originalFetch = globalThis.fetch
	let calls = 0
	globalThis.fetch = (async () => {
		calls++
		return new Response(
			JSON.stringify({
				data: {
					id: "some/model",
					endpoints: [
						{ provider_name: "HostA", context_length: 262144, pricing: { prompt: "0.0000002", completion: "0.0000006" } },
					],
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		)
	}) as typeof fetch
	try {
		const info = await client.fetchModelInfo("some/model")
		assert.equal(calls, 1, "exactly one HTTP call")
		assert.equal(info?.contextWindow, 262144, "context window from the same response")
		assert.ok(Math.abs(info?.price?.input! - 0.2) < 1e-9, "price from the same response")
	} finally {
		globalThis.fetch = originalFetch
	}
}

// ─── Reasoning capture (streaming-and-reasoning, part 1) ────────────────────

async function testDeepseekRequestIncludesReasoning(): Promise<void> {
	// `include_reasoning: true` is load-bearing for deepseek/*: without it the
	// pinned official endpoint suppresses the returned reasoning field (verified
	// live 2026-08-01 on deepseek/deepseek-v4-flash).
	const body = buildRequestBody(baseRequest, "deepseek/deepseek-v4-flash")
	assert.equal(body.include_reasoning, true)
}

async function testNonDeepseekRequestsDoNotIncludeReasoning(): Promise<void> {
	// Kept to the deepseek/ prefix (OpenRouter cleanly ignores the param for
	// models that don't support it, but unconditional is untested territory).
	const body = buildRequestBody(baseRequest, "anthropic/claude-3.5-sonnet")
	assert.equal(body.include_reasoning, undefined)
}

// ─── Graded reasoning effort (issue #30 experiment) ─────────────────────────

async function testDeepseekRequestSendsReasoningEffort(): Promise<void> {
	// A configured effort must reach OpenRouter as `reasoning: { effort }`
	// (normalized), alongside the existing include_reasoning flag.
	const body = buildRequestBody({ ...baseRequest, reasoningEffort: "high" }, "deepseek/deepseek-v4-flash")
	assert.deepEqual(body.reasoning, { effort: "high" })
}

async function testMaxEffortNormalizesToXhigh(): Promise<void> {
	// OpenRouter's normalized reasoning.effort has no "max" — the native
	// DeepSeek max maps to "xhigh" on the wire; "xhigh" passes through.
	const body = buildRequestBody({ ...baseRequest, reasoningEffort: "max" }, "deepseek/deepseek-v4-flash")
	assert.deepEqual(body.reasoning, { effort: "xhigh" })
	const body2 = buildRequestBody({ ...baseRequest, reasoningEffort: "xhigh" }, "deepseek/deepseek-v4-flash")
	assert.deepEqual(body2.reasoning, { effort: "xhigh" })
}

async function testNoEffortSendsNothing(): Promise<void> {
	// Regression: an unset effort must NOT add a reasoning field — the
	// endpoint's undeclared default applies, exactly as before issue #30.
	const body = buildRequestBody(baseRequest, "deepseek/deepseek-v4-flash")
	assert.equal(body.reasoning, undefined)
}

async function testEffortKeptToDeepseekBoundary(): Promise<void> {
	// Same deepseek/ prefix boundary as include_reasoning — no reasoning
	// effort is invented for models the harness never pins reasoning on.
	const body = buildRequestBody({ ...baseRequest, reasoningEffort: "high" }, "anthropic/claude-3.5-sonnet")
	assert.equal(body.reasoning, undefined)
}

async function testParseReasoningEffortValidatesAndNormalizes(): Promise<void> {
	assert.equal(parseReasoningEffort(undefined), undefined)
	assert.equal(parseReasoningEffort(""), undefined)
	assert.equal(parseReasoningEffort("  "), undefined)
	assert.equal(parseReasoningEffort("low"), "low")
	assert.equal(parseReasoningEffort("MEDIUM"), "medium") // case-insensitive
	assert.equal(parseReasoningEffort("max"), "xhigh")
	assert.equal(parseReasoningEffort("xhigh"), "xhigh")
	assert.throws(() => parseReasoningEffort("higH-effort"), /must be one of low\/medium\/high\/max\/xhigh/i)
	assert.throws(() => parseReasoningEffort("turbo"), /must be one of low\/medium\/high\/max\/xhigh/i)
}

async function testStreamingRequestAddsStreamFlags(): Promise<void> {
	const body = buildRequestBody({ ...baseRequest, stream: true }, "anthropic/claude-3.5-sonnet")
	assert.equal(body.stream, true)
	assert.deepEqual(body.stream_options, { include_usage: true })
	// A non-streaming request must NOT gain the stream flags.
	const blocking = buildRequestBody(baseRequest, "anthropic/claude-3.5-sonnet")
	assert.equal(blocking.stream, undefined)
	assert.equal(blocking.stream_options, undefined)
}

async function testNonStreamingResponseCapturesReasoning(): Promise<void> {
	// Non-streaming + include_reasoning: OpenRouter normalizes DeepSeek's
	// `reasoning_content` to `message.reasoning` (verified live 2026-08-01:
	// message keys were role/content/refusal/reasoning). It must flow through
	// to the LlmResponse unchanged.
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const restore = stubFetch(
		new Response(
			JSON.stringify({
				id: "chatcmpl-1",
				object: "chat.completion",
				created: 1,
				model: "deepseek/deepseek-v4-flash",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "Answer.", refusal: null, reasoning: "thinking text" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		),
	)
	try {
		const response = await client.createChatCompletion({
			model: "deepseek/deepseek-v4-flash",
			messages: [{ role: "user", content: "hi" }],
		})
		assert.equal(response.message.content, "Answer.")
		assert.equal(response.message.reasoning, "thinking text")
		assert.equal(response.usage?.promptTokens, 10)
		assert.equal(response.usage?.completionTokens, 7)
	} finally {
		restore()
	}
}

// ─── SSE streaming (streaming-and-reasoning, part 2) ────────────────────────

async function testStreamedTextAndReasoningAssembleCorrectly(): Promise<void> {
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const chunks: Array<[string, string]> = []
	const body = sse(
		{ choices: [{ delta: { role: "assistant" } }] },
		{ choices: [{ delta: { reasoning: "Let me think" } }] },
		{ choices: [{ delta: { reasoning: " harder" } }] },
		{ choices: [{ delta: { content: "Hello" } }] },
		{ choices: [{ delta: { content: " world" } }] },
		{ choices: [{ delta: {}, finish_reason: "stop" }] },
		{ id: "gen-stream-1", model: "meta/muse-spark-1.3-contributor", provider_name: "Meta", usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21, prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 3 }, cost: 0.0001, cache_discount: 0.00001 } },
		"[DONE]",
	)
	const restore = stubFetch(sseResponse(body))
	try {
		const response = await client.createChatCompletion({
			model: "deepseek/deepseek-v4-flash",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			onStreamChunk: (kind, chunk) => chunks.push([kind, chunk]),
		})
		// Final assembled message matches what the non-streamed equivalent
		// would have produced.
		assert.equal(response.message.content, "Hello world")
		assert.equal(response.message.reasoning, "Let me think harder")
		assert.equal(response.message.tool_calls, undefined)
		// Incremental chunks arrive in order, reasoning distinct from text.
		assert.deepEqual(chunks, [
			["reasoning", "Let me think"],
			["reasoning", " harder"],
			["text", "Hello"],
			["text", " world"],
		])
		// Usage from the final stream chunk (stream_options.include_usage).
		assert.equal(response.usage?.promptTokens, 12)
		assert.equal(response.usage?.completionTokens, 9)
		assert.equal(response.usage?.totalTokens, 21)
		assert.equal(response.generationId, "gen-stream-1")
		assert.equal(response.returnedModel, "meta/muse-spark-1.3-contributor")
		assert.equal(response.providerName, "Meta")
		assert.equal(response.usage?.cachedTokens, 8)
		assert.equal(response.usage?.cacheWriteTokens, 1)
		assert.equal(response.usage?.reasoningTokens, 3)
		assert.equal(response.usage?.openRouterReportedCostUsd, 0.0001)
		assert.equal(response.usage?.cacheDiscountUsd, 0.00001)
	} finally {
		restore()
	}
}

async function testStreamedToolCallsReassembleAcrossChunks(): Promise<void> {
	// Tool calls stream as partial JSON: id/name on the first chunk for an
	// index, then `function.arguments` fragments across subsequent chunks.
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const body = sse(
		{ choices: [{ delta: { role: "assistant" } }] },
		{
			choices: [
				{
					delta: {
						tool_calls: [
							{ index: 0, id: "call_abc", type: "function", function: { name: "write_to_file", arguments: "" } },
						],
					},
				},
			],
		},
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"hello.txt","content":"hi"}' } }] } }] },
		{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		{ usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 } },
		"[DONE]",
	)
	const restore = stubFetch(sseResponse(body))
	try {
		const response = await client.createChatCompletion({
			model: "deepseek/deepseek-v4-flash",
			messages: [{ role: "user", content: "write a file" }],
			stream: true,
		})
		assert.equal(response.message.content, null)
		assert.ok(response.message.tool_calls, "expected reassembled tool calls")
		assert.equal(response.message.tool_calls?.length, 1)
		const call = response.message.tool_calls![0]
		assert.equal(call.id, "call_abc")
		assert.equal(call.function.name, "write_to_file")
		assert.equal(call.function.arguments, '{"path":"hello.txt","content":"hi"}')
		assert.equal(response.usage?.completionTokens, 15)
	} finally {
		restore()
	}
}

async function testStreamedEmptyResponseFails(): Promise<void> {
	// A stream that ends with no content/reasoning/tool calls/usage must
	// surface as an error, not a silent empty assistant turn.
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const restore = stubFetch(sseResponse("data: [DONE]\n\n"))
	try {
		await assert.rejects(
			client.createChatCompletion({
				model: "deepseek/deepseek-v4-flash",
				messages: [{ role: "user", content: "hi" }],
				stream: true,
			}),
			/OpenRouter stream ended with no content/,
		)
	} finally {
		restore()
	}
}

async function testStreamedStallAbortsOnSignal(): Promise<void> {
	// A mid-stream stall must NOT hang past the caller's timeout: the loop's
	// AbortController aborts the fetch AND the reader, which rejects with
	// AbortError so the loop's existing llmTimeoutMs handling kicks in.
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const controller = new AbortController()
	const restore = stubFetch(stallingSseResponse(controller.signal))
	try {
		const pending = client.createChatCompletion({
			model: "deepseek/deepseek-v4-flash",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			signal: controller.signal,
		})
		setTimeout(() => controller.abort(), 25)
		await assert.rejects(pending, (err: unknown) => err instanceof Error && err.name === "AbortError")
	} finally {
		restore()
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** One `data: <payload>\n\n` line per entry; a string payload is sent verbatim. */
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

/**
 * A stream that emits ONE chunk then stalls forever — only released when the
 * caller's AbortSignal fires (the reader then rejects with AbortError, the
 * same way undici's real fetch body does on abort).
 */
function stallingSseResponse(signal: AbortSignal): Response {
	const encoder = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
			signal.addEventListener(
				"abort",
				() => controller.error(new DOMException("This operation was aborted", "AbortError")),
				{ once: true },
			)
		},
	})
	return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

/** Replace globalThis.fetch for the duration of a test; returns a restore fn. */
function stubFetch(response: Response): () => void {
	const original = globalThis.fetch
	globalThis.fetch = (async () => response) as typeof fetch
	return () => {
		globalThis.fetch = original
	}
}

// ─── isRetryableOpenRouterError ──────────────────────────────────────────────
// A hard-pinned model (deepseek/* with allow_fallbacks: false) has no
// fallback provider to smooth over a blip, so the main call and the handoff
// condensation call (src/engine/loop.ts) both retry ONCE on these shapes.

async function testIsRetryableOpenRouterErrorMatchesTransientShapes(): Promise<void> {
	assert.equal(
		isRetryableOpenRouterError(new OpenRouterError("network error", undefined)),
		true,
		"no status at all (a transport failure) must be retryable",
	)
	assert.equal(isRetryableOpenRouterError(new OpenRouterError("rate limited", 429)), true, "429 must be retryable")
	assert.equal(isRetryableOpenRouterError(new OpenRouterError("provider returned error", 520)), true, "5xx must be retryable")
	assert.equal(isRetryableOpenRouterError(new OpenRouterError("bad gateway", 502)), true, "any 5xx must be retryable")
	assert.equal(
		isRetryableOpenRouterError(new OpenRouterError("No allowed providers are available for the selected model.", 404)),
		true,
		"the specific 'no allowed providers' 404 is an availability signal despite the 4xx status",
	)
}

async function testIsRetryableOpenRouterErrorRejectsDeterministicFailures(): Promise<void> {
	assert.equal(
		isRetryableOpenRouterError(new OpenRouterError("invalid model id", 404)),
		false,
		"a normal 'model not found' 404 (no matching message) must NOT retry",
	)
	assert.equal(isRetryableOpenRouterError(new OpenRouterError("invalid api key", 401)), false, "401 must not retry")
	assert.equal(isRetryableOpenRouterError(new OpenRouterError("malformed request", 400)), false, "400 must not retry")
	assert.equal(isRetryableOpenRouterError(new Error("some unrelated error")), false, "a non-OpenRouterError must never be classified as retryable")
}

const tests: Array<[string, () => Promise<void>]> = [
	["isRetryableOpenRouterError matches network/429/5xx/no-allowed-providers shapes", testIsRetryableOpenRouterErrorMatchesTransientShapes],
	["isRetryableOpenRouterError rejects deterministic 4xx and non-OpenRouterError values", testIsRetryableOpenRouterErrorRejectsDeterministicFailures],
	["legacy deepseek/* models remain pinned to the official DeepSeek provider", testDeepseekModelsArePinnedToOfficialProvider],
	["the pin applies to any deepseek/* model, not just one id", testDeepseekReasonerAlsoPinned],
	["the RSI proof model uses the pinned DeepInfra endpoint and advertised parameters", testRsiProofModelUsesPinnedDeepinfraRoute],
	["non-deepseek models are never pinned to the deepseek provider", testNonDeepseekModelsAreNotPinned],
	["buildRequestBody emits max_tokens when set, omits it when unset", testRequestBodyEmitsMaxTokensWhenSet],
	["opaque cache-routing key is forwarded as session_id and prompt_cache_key", testOpaqueCacheRoutingKeyIsForwardedWithoutIdentityData],
	["Muse qualification pins to Meta with fallbacks disabled", testMuseQualificationPinsOnlyMetaWithoutFallback],
	["exact UTF-8 request boundary is enforced for streaming and non-streaming JSON", testExactUtf8WireBoundaryForStreamAndNonStream],
	["oversized latest tool-call group is clipped without mutating original evidence", testOversizedLatestToolGroupIsClippedWithoutMutatingEvidence],
	["role-aware prefixes preserve user-only and multiple-system histories", testRoleAwarePrefixKeepsUserOnlyAndMultipleSystemHistories],
	["impossible prefixes and invalid byte budgets fail locally", testImpossiblePrefixAndInvalidBudgetsFailBeforeNetwork],
	["transcripts preserve packed wire messages and original local history separately", testTranscriptSeparatesPackedWireMessagesFromOriginalHistory],
	["OpenRouter response usage and generation billing metadata are preserved", testOpenRouterUsageCostAndGenerationMetadataAreMapped],
	["malformed generation cost evidence is omitted", testMalformedGenerationBillingIsNotReportedAsAuthoritative],
	["generation metadata retries after delayed visibility", testGenerationMetadataRetriesAfterDelayedVisibility],
	["malformed usage counts cannot create cache discounts", testMalformedUsageCountsCannotCreateCacheDiscount],
	["deepseek/* requests include include_reasoning (load-bearing)", testDeepseekRequestIncludesReasoning],
	["non-deepseek requests do not include include_reasoning", testNonDeepseekRequestsDoNotIncludeReasoning],
	["deepseek/* requests send reasoning: { effort } when configured", testDeepseekRequestSendsReasoningEffort],
	["native max normalizes to OpenRouter's xhigh on the wire", testMaxEffortNormalizesToXhigh],
	["unset effort sends no reasoning field (default unchanged)", testNoEffortSendsNothing],
	["reasoning effort is kept to the deepseek/ boundary", testEffortKeptToDeepseekBoundary],
	["parseReasoningEffort validates + normalizes, fails loudly on typos", testParseReasoningEffortValidatesAndNormalizes],
	["streaming requests add stream + stream_options.include_usage only when opted in", testStreamingRequestAddsStreamFlags],
	["non-streaming response captures message.reasoning", testNonStreamingResponseCapturesReasoning],
	["streamed text+reasoning assemble correctly and emit incremental chunks", testStreamedTextAndReasoningAssembleCorrectly],
	["streamed tool calls reassemble across chunks", testStreamedToolCallsReassembleAcrossChunks],
	["an empty streamed response fails loudly, not silently", testStreamedEmptyResponseFails],
	["a mid-stream stall aborts via the caller's AbortSignal", testStreamedStallAbortsOnSignal],
	["fetchModelContextWindow: parses endpoints, largest non-zero wins", testFetchModelContextWindowParsesEndpoints],
	["fetchModelContextWindow: accepts the legacy array shape", testFetchModelContextWindowAcceptsLegacyArrayShape],
	["fetchModelContextWindow: retries transient failures, not 404s", testFetchModelContextWindowRetriesTransientFailure],
	["fetchModelContextWindow: undefined on failure / missing key", testFetchModelContextWindowReturnsUndefinedOnFailure],
	["fetchModelInfo price: pinned provider's endpoint price wins", testFetchModelPricingPrefersPinnedProvider],
	["fetchModelInfo price: fail-open (404/no-pricing/no-key) → undefined", testFetchModelPricingFailOpen],
	["fetchModelInfo: one fetch resolves window AND price together", testFetchModelInfoSharesOneFetch],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack : err)
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} openrouter request-building tests passed`)
}

main()
