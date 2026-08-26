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
	mergeLivePrice,
	parseEndpointPricing,
	priceFor,
	type EndpointPricingEntry,
	type PricingTable,
} from "../cost.js"

/**
 * Regression test for a real incident (2026-08-01): `deepseek/deepseek-v4-flash`
 * was missing from DEFAULT_PRICING_TABLE, so every session running it fell
 * through to FALLBACK_MODEL_PRICE (7x+ its real input rate), producing
 * wildly inflated internal cost estimates (one 147-iteration session
 * reported ~$11 estimated vs. the real OpenRouter account showing well
 * under $1 total spend for the whole month) and at least one false-positive
 * budget-cap abort. This must never silently regress back to the fallback.
 */
async function testDeepseekV4FlashPriced(): Promise<void> {
	const price = DEFAULT_PRICING_TABLE["deepseek/deepseek-v4-flash"]
	assert.ok(price, "deepseek/deepseek-v4-flash must be a real entry, not fall through to the fallback")
	assert.notDeepEqual(price, FALLBACK_MODEL_PRICE, "must not accidentally equal the unknown-model fallback price")
	assert.ok(price.input < 1, `input price should be well under $1/1M (real rate is ~$0.14), got $${price.input}`)
	assert.ok(price.cacheRead !== undefined && price.cacheRead < price.input, "cacheRead must be a real discount, not left unset")

	// The actual incident, reproduced: a session that racked up 5.3M input /
	// 37.8K output / 1.4M cached tokens must cost single-digit dollars, not
	// the ~$11 the fallback rate produced.
	const cost = estimateCost({
		model: "deepseek/deepseek-v4-flash",
		inputTokens: 5_338_407,
		outputTokens: 37_804,
		cachedTokens: 1_411_584,
	})
	assert.ok(cost < 2, `expected well under $2 for the real incident's token counts, got $${cost.toFixed(4)}`)
}

/**
 * The harness default model was bumped to the dated point release
 * `deepseek/deepseek-v4-flash-0731` (src/llm/openrouter.ts's DEFAULT_MODEL).
 * Same regression risk as testDeepseekV4FlashPriced: this id must have its
 * own real pricing entry, not fall through to FALLBACK_MODEL_PRICE.
 */
async function testDeepseekV4Flash0731Priced(): Promise<void> {
	const price = DEFAULT_PRICING_TABLE["deepseek/deepseek-v4-flash-0731"]
	assert.ok(price, "deepseek/deepseek-v4-flash-0731 must be a real entry, not fall through to the fallback")
	assert.notDeepEqual(price, FALLBACK_MODEL_PRICE, "must not accidentally equal the unknown-model fallback price")
	assert.ok(price.input < 1, `input price should be well under $1/1M (real rate is ~$0.14), got $${price.input}`)
	assert.ok(price.cacheRead !== undefined && price.cacheRead < price.input, "cacheRead must be a real discount, not left unset")
}

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

async function testCachedTokenPricing(): Promise<void> {
	// No cacheRead configured for the model: cached tokens are priced at the
	// FULL input rate (zero behavior change from before cache accounting
	// existed) — deliberately NOT a discounted guess by default.
	const noDiscountConfigured = estimateCost({
		model: "deepseek/deepseek-chat",
		inputTokens: 1_000_000,
		cachedTokens: 800_000,
		outputTokens: 0,
	})
	assert.ok(
		Math.abs(noDiscountConfigured - 0.27) < 1e-9,
		`no cacheRead configured -> full input price regardless of cachedTokens, expected $0.27, got ${noDiscountConfigured}`,
	)

	// With an explicit cacheRead price configured, cached tokens are billed
	// at that rate and the rest at the full input rate.
	const withDiscount: PricingTable = { "my/cached-model": { input: 1, output: 2, cacheRead: 0.1 } }
	const discounted = estimateCost({
		model: "my/cached-model",
		inputTokens: 1_000_000,
		cachedTokens: 800_000,
		outputTokens: 0,
		pricing: withDiscount,
	})
	// 200k uncached @ $1/1M + 800k cached @ $0.1/1M = 0.2 + 0.08 = 0.28
	assert.ok(Math.abs(discounted - 0.28) < 1e-9, `expected $0.28, got ${discounted}`)

	// cachedTokens is clamped to inputTokens — a provider reporting more
	// cached than total prompt tokens must never produce a negative
	// "uncached" count (and must never make the estimate go DOWN as a
	// result — this is a cost guardrail, so it must stay conservative).
	const overReported = estimateCost({
		model: "my/cached-model",
		inputTokens: 1_000_000,
		cachedTokens: 5_000_000,
		outputTokens: 0,
		pricing: withDiscount,
	})
	// Clamped to 1M cached @ $0.1/1M = $0.10, not negative and not > the
	// fully-uncached price.
	assert.ok(Math.abs(overReported - 0.1) < 1e-9, `expected $0.10 (clamped), got ${overReported}`)
	assert.ok(overReported >= 0, "cost estimate is never negative")
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

// ─── parseEndpointPricing (Part E live pricing) ───────────────────────────────

async function testParseEndpointPricingProviderPreference(): Promise<void> {
	// deepseek/* pins routing to the official DeepSeek endpoint, so the
	// live price must be that endpoint's, even when another host is cheaper.
	const endpoints: EndpointPricingEntry[] = [
		{
			provider_name: "DeepInfra",
			pricing: { prompt: "0.00000009", completion: "0.00000018", input_cache_read: "0.000000018" },
		},
		{
			provider_name: "DeepSeek",
			pricing: { prompt: "0.00000014", completion: "0.00000028", input_cache_read: "0.0000000028" },
		},
	]
	const price = parseEndpointPricing(endpoints, "DeepSeek")
	assert.ok(price, "a usable price is parsed")
	assert.ok(Math.abs(price.input - 0.14) < 1e-9, `DeepSeek endpoint's prompt price wins (got $${price.input})`)
	assert.ok(Math.abs(price.output - 0.28) < 1e-9, `DeepSeek endpoint's completion price wins (got $${price.output})`)
	assert.ok(Math.abs(price.cacheRead! - 0.0028) < 1e-9, `cacheRead parsed from the preferred endpoint (got $${price.cacheRead})`)
	// Provider match is case-insensitive.
	const lower = parseEndpointPricing(endpoints, "deepseek")
	assert.ok(Math.abs(lower!.input - 0.14) < 1e-9, "provider preference matches case-insensitively")
}

async function testParseEndpointPricingTakesMaxForAutoRouted(): Promise<void> {
	// For auto-routed (non-pinned) models the harness can't know which
	// endpoint served a call — a cost GUARDRAIL takes the per-field max so a
	// cap is never bypassed by under-estimation.
	const endpoints: EndpointPricingEntry[] = [
		{ provider_name: "HostA", pricing: { prompt: "0.0000001", completion: "0.0000005" } },
		{ provider_name: "HostB", pricing: { prompt: "0.0000003", completion: "0.0000002", input_cache_read: "0.00000005" } },
	]
	const price = parseEndpointPricing(endpoints)
	assert.ok(price, "parses a price")
	assert.ok(Math.abs(price.input - 0.3) < 1e-9, `max prompt wins (got $${price.input})`)
	assert.ok(Math.abs(price.output - 0.5) < 1e-9, `max completion wins (got $${price.output})`)
	assert.ok(Math.abs(price.cacheRead! - 0.05) < 1e-9, `max cacheRead wins (got $${price.cacheRead})`)
}

async function testParseEndpointPricingFailOpen(): Promise<void> {
	assert.equal(parseEndpointPricing([]), undefined, "no endpoints → undefined")
	assert.equal(
		parseEndpointPricing([{ provider_name: "HostA", pricing: {} }]),
		undefined,
		"endpoints without pricing → undefined",
	)
	assert.equal(
		parseEndpointPricing([{ provider_name: "HostA", pricing: { prompt: "0.5", completion: "0.5" } }], "DeepSeek"),
		undefined,
		"provider preference with no matching endpoint → undefined (caller falls back to the hardcoded table)",
	)
	// String-per-token is converted to per-1M; numbers are accepted too.
	const mixed = parseEndpointPricing([{ provider_name: "HostA", pricing: { prompt: "0.00000014", completion: 0.00000028 } }])
	assert.ok(Math.abs(mixed!.input - 0.14) < 1e-9 && Math.abs(mixed!.output - 0.28) < 1e-9, "string + numeric per-token prices convert")
}

async function testMergeLivePriceOverridesDefaults(): Promise<void> {
	const table = mergeLivePrice(DEFAULT_PRICING_TABLE, "deepseek/deepseek-v4-flash", { input: 0.99, output: 1.99 })
	assert.equal(table["deepseek/deepseek-v4-flash"].input, 0.99, "the live price replaces the hardcoded entry for that model")
	assert.equal(table["deepseek/deepseek-chat"].input, DEFAULT_PRICING_TABLE["deepseek/deepseek-chat"].input, "other models untouched")
	// estimateCost consumes the merged table directly.
	const cost = estimateCost({ model: "deepseek/deepseek-v4-flash", inputTokens: 1_000_000, outputTokens: 0, pricing: table })
	assert.ok(Math.abs(cost - 0.99) < 1e-9, `live price flows into estimateCost (got $${cost})`)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["default pricing table covers deepseek-chat + reasoner + a general model", testDefaultTableShape],
	["deepseek/deepseek-v4-flash is priced correctly (2026-08-01 incident regression)", testDeepseekV4FlashPriced],
	["deepseek/deepseek-v4-flash-0731 (current default) is priced correctly", testDeepseekV4Flash0731Priced],
	["estimateCost math (per-1M input/output, mixed, zero defaults)", testEstimateCostMath],
	["unknown model falls back to the conservative rate (never $0)", testModelFallback],
	["in-code pricing override table + per-model fallback", testPriceOverrideTable],
	["cached-token pricing: no discount by default, configurable, clamped", testCachedTokenPricing],
	["HEADLESSCODE_PRICING_JSON deep-merges over the defaults", testEnvPricingJsonOverride],
	["HEADLESSCODE_PRICING_JSON with a missing file throws", testEnvPricingJsonMissingFileThrows],
	["accumulateCost sums multiple runs", testAccumulateCost],
	["parseEndpointPricing: pinned provider's endpoint wins", testParseEndpointPricingProviderPreference],
	["parseEndpointPricing: auto-routed models take the conservative max", testParseEndpointPricingTakesMaxForAutoRouted],
	["parseEndpointPricing: fail-open when nothing usable", testParseEndpointPricingFailOpen],
	["mergeLivePrice overrides the hardcoded entry, feeds estimateCost", testMergeLivePriceOverridesDefaults],
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
