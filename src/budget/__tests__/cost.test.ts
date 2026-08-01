/**
 * Unit tests for src/budget/cost.ts — model pricing table + cost estimation.
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/budget/__tests__/cost.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	accumulateCost,
	DEFAULT_PRICING_TABLE,
	estimateCost,
	FALLBACK_MODEL_PRICE,
	loadPricingTable,
	priceFor,
	type PricingTable,
} from "../cost.js"

async function testDefaultTableShape(): Promise<void> {
	// The default table covers the models the harness uses: deepseek-chat,
	// deepseek-reasoner and at least one general model.
	assert.ok(DEFAULT_PRICING_TABLE["deepseek/deepseek-chat"], "deepseek-chat priced")
	assert.ok(DEFAULT_PRICING_TABLE["deepseek/deepseek-reasoner"], "deepseek-reasoner priced")
	const general = Object.entries(DEFAULT_PRICING_TABLE).find(([m]) => !m.startsWith("deepseek/"))
	assert.ok(general, "at least one general (non-deepseek) model priced")
	for (const [model, price] of Object.entries(DEFAULT_PRICING_TABLE)) {
		assert.ok(price.input >= 0 && price.output >= 0, `${model} prices are non-negative`)
		assert.ok(price.input > 0 || price.output > 0, `${model} has a non-zero price`)
	}
}

async function testEstimateCostMath(): Promise<void> {
	// 1M input tokens at deepseek-chat ($0.27/1M) = $0.27.
	const inputOnly = estimateCost({ model: "deepseek/deepseek-chat", inputTokens: 1_000_000, outputTokens: 0 })
	assert.ok(Math.abs(inputOnly - 0.27) < 1e-9, `expected $0.27, got ${inputOnly}`)

	// 1M output tokens at deepseek-chat ($1.10/1M) = $1.10.
	const outputOnly = estimateCost({ model: "deepseek/deepseek-chat", inputTokens: 0, outputTokens: 1_000_000 })
	assert.ok(Math.abs(outputOnly - 1.1) < 1e-9, `expected $1.10, got ${outputOnly}`)

	// Mixed: 500k in + 100k out on deepseek-reasoner ($0.55/$2.19).
	const mixed = estimateCost({
		model: "deepseek/deepseek-reasoner",
		inputTokens: 500_000,
		outputTokens: 100_000,
	})
	const expected = 0.5 * 0.55 + 0.1 * 2.19
	assert.ok(Math.abs(mixed - expected) < 1e-9, `expected ${expected}, got ${mixed}`)

	// Missing token counts default to 0.
	const zero = estimateCost({ model: "deepseek/deepseek-chat" })
	assert.equal(zero, 0)
}

async function testModelFallback(): Promise<void> {
	// Unknown model falls back to the conservative FALLBACK_MODEL_PRICE, NOT $0.
	const unknown = estimateCost({ model: "some/vendor-model", inputTokens: 1_000_000, outputTokens: 0 })
	assert.equal(unknown, FALLBACK_MODEL_PRICE.input, "unknown model falls back to the conservative rate")
	const unknownMixed = estimateCost({ model: "some/vendor-model", inputTokens: 500_000, outputTokens: 500_000 })
	assert.equal(unknownMixed, FALLBACK_MODEL_PRICE.input / 2 + FALLBACK_MODEL_PRICE.output / 2)
	assert.ok(unknownMixed > 0, "fallback never under-counts to zero")
}

async function testPriceOverrideTable(): Promise<void> {
	// In-code override: a custom table changes the estimate.
	const custom: PricingTable = { "my/model": { input: 1, output: 2 } }
	const cost = estimateCost({ model: "my/model", inputTokens: 1_000_000, outputTokens: 1_000_000, pricing: custom })
	assert.equal(cost, 3, "1M in @ $1 + 1M out @ $2 = $3")

	// An unlisted model still falls back even with a custom table.
	const fallback = estimateCost({ model: "other/model", inputTokens: 1_000_000, outputTokens: 0, pricing: custom })
	assert.equal(fallback, FALLBACK_MODEL_PRICE.input)

	// priceFor resolves both paths.
	assert.deepEqual(priceFor("my/model", custom), { input: 1, output: 2 })
	assert.deepEqual(priceFor("unlisted", custom), FALLBACK_MODEL_PRICE)
}

async function testEnvPricingJsonOverride(): Promise<void> {
	// HEADLESSCODE_PRICING_JSON: a file with per-model overrides is deep-merged
	// over the defaults (unlisted models keep the built-in price).
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cost-env-"))
	const pricingPath = path.join(dir, "pricing.json")
	try {
		await fs.writeFile(
			pricingPath,
			JSON.stringify({ "deepseek/deepseek-chat": { input: 0.5, output: 1.5 }, "brand/new-model": { input: 9, output: 9 } }),
			"utf-8",
		)
		const saved = process.env.HEADLESSCODE_PRICING_JSON
		process.env.HEADLESSCODE_PRICING_JSON = pricingPath
		try {
			const table = loadPricingTable()
			// Overridden model gets the file's price.
			assert.deepEqual(table["deepseek/deepseek-chat"], { input: 0.5, output: 1.5 })
			// New model added by the file.
			assert.deepEqual(table["brand/new-model"], { input: 9, output: 9 })
			// Unlisted models keep the defaults (deep merge).
			assert.deepEqual(table["deepseek/deepseek-reasoner"], DEFAULT_PRICING_TABLE["deepseek/deepseek-reasoner"])
			// estimateCost picks up the env override.
			const cost = estimateCost({ model: "deepseek/deepseek-chat", inputTokens: 1_000_000, outputTokens: 0 })
			assert.equal(cost, 0.5)
		} finally {
			if (saved === undefined) {
				delete process.env.HEADLESSCODE_PRICING_JSON
			} else {
				process.env.HEADLESSCODE_PRICING_JSON = saved
			}
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testEnvPricingJsonMissingFileThrows(): Promise<void> {
	const saved = process.env.HEADLESSCODE_PRICING_JSON
	process.env.HEADLESSCODE_PRICING_JSON = "/nonexistent/pricing.json"
	try {
		assert.throws(() => loadPricingTable(), /HEADLESSCODE_PRICING_JSON/)
	} finally {
		if (saved === undefined) {
			delete process.env.HEADLESSCODE_PRICING_JSON
		} else {
			process.env.HEADLESSCODE_PRICING_JSON = saved
		}
	}
}

async function testAccumulateCost(): Promise<void> {
	const runs = [
		{ model: "deepseek/deepseek-chat", inputTokens: 1_000_000, outputTokens: 0 }, // $0.27
		{ model: "deepseek/deepseek-chat", inputTokens: 0, outputTokens: 1_000_000 }, // $1.10
		{ model: "unknown/model", inputTokens: 1_000_000, outputTokens: 0 }, // fallback $2.00
	]
	const total = accumulateCost(runs)
	assert.ok(Math.abs(total - (0.27 + 1.1 + FALLBACK_MODEL_PRICE.input)) < 1e-9, `expected sum, got ${total}`)

	// Explicit pricing table variant.
	const custom: PricingTable = { "my/model": { input: 1, output: 1 } }
	const withCustom = accumulateCost([{ model: "my/model", inputTokens: 1_000_000, outputTokens: 0 }], custom)
	assert.equal(withCustom, 1)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["default pricing table covers deepseek-chat + reasoner + a general model", testDefaultTableShape],
	["estimateCost math (per-1M input/output, mixed, zero defaults)", testEstimateCostMath],
	["unknown model falls back to the conservative rate (never $0)", testModelFallback],
	["in-code pricing override table + per-model fallback", testPriceOverrideTable],
	["HEADLESSCODE_PRICING_JSON deep-merges over the defaults", testEnvPricingJsonOverride],
	["HEADLESSCODE_PRICING_JSON with a missing file throws", testEnvPricingJsonMissingFileThrows],
	["accumulateCost sums multiple runs", testAccumulateCost],
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
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} cost tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
