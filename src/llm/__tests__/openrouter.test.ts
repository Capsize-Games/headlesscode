/**
 * Unit tests for src/llm/openrouter.ts's request-building logic.
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` -> `tsx src/llm/__tests__/openrouter.test.ts`.
 */

import assert from "node:assert/strict"

import { buildRequestBody } from "../openrouter.js"
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

async function testNonDeepseekModelsAreNotPinned(): Promise<void> {
	const body = buildRequestBody(baseRequest, "anthropic/claude-3.5-sonnet")
	assert.equal(body.provider, undefined, "pinning to the deepseek provider for a non-deepseek model would be wrong")
}

// ─── fetchModelContextWindow (Phase 3 condensation trigger) ─────────────────

async function testFetchModelContextWindowParsesEndpoints(): Promise<void> {
	// A fake OpenRouter models-endpoint response with multiple endpoints —
	// the largest non-zero context_length must win.
	const { OpenRouterClient } = await import("../openrouter.js")
	const client = new OpenRouterClient({ apiKey: "k", baseUrl: "http://mock" })
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (url: string | URL | Request) => {
		assert.match(String(url), /\/api\/v1\/models\/deepseek%2Fdeepseek-v4-flash\/endpoints$/)
		return new Response(
			JSON.stringify({
				data: [
					{ context_length: 131072, id: "host-a" },
					{ context_length: 1048576, id: "official-deepseek" },
					{ context_length: 0, id: "broken" },
				],
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

const tests: Array<[string, () => Promise<void>]> = [
	["deepseek/* models are pinned to the official DeepSeek provider", testDeepseekModelsArePinnedToOfficialProvider],
	["the pin applies to any deepseek/* model, not just one id", testDeepseekReasonerAlsoPinned],
	["non-deepseek models are never pinned to the deepseek provider", testNonDeepseekModelsAreNotPinned],
	["fetchModelContextWindow: parses endpoints, largest non-zero wins", testFetchModelContextWindowParsesEndpoints],
	["fetchModelContextWindow: undefined on failure / missing key", testFetchModelContextWindowReturnsUndefinedOnFailure],
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
