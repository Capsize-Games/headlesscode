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

const tests: Array<[string, () => Promise<void>]> = [
	["deepseek/* models are pinned to the official DeepSeek provider", testDeepseekModelsArePinnedToOfficialProvider],
	["the pin applies to any deepseek/* model, not just one id", testDeepseekReasonerAlsoPinned],
	["non-deepseek models are never pinned to the deepseek provider", testNonDeepseekModelsAreNotPinned],
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
