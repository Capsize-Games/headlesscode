/**
 * Phase 6 — model pricing + LLM cost estimation (the numeric heart of the
 * per-session cost budget).
 *
 * The harness pays OpenRouter per token (input + output). To enforce a
 * per-session cost cap without post-hoc reconciliation we estimate the USD
 * cost of every LLM call from the `usage` object the provider returns
 * (prompt/completion tokens) × the model's price.
 *
 * Pricing table: USD per 1M tokens, keyed by model id. Defaults cover the
 * models this project actually uses (DeepSeek family via OpenRouter) plus one
 * general model as a sanity reference. The table is overridable:
 *
 *   - in-code: pass a `PricingTable` to `estimateCost` / `accumulateCost` /
 *     `BudgetTracker` (the constructor option);
 *   - via env: `HEADLESSCODE_PRICING_JSON` = path to a JSON file of the same
 *     shape (`{ "<model>": { "input": <per1M USD>, "output": <per1M USD> } }`),
 *     deep-merged over the defaults (per-model override; unlisted models keep
 *     the built-in price).
 *
 * Unknown models fall back to a CONSERVATIVE general rate (`FALLBACK_MODEL_PRICE`)
 * rather than $0 — a runaway session on a model we don't have a price for must
 * still be capped, not silently free.
 *
 * Prices below are the list rates as of the 2026-08 baseline; they are input
 * to a GUARDRAIL (cap enforcement), so being slightly stale is safe (the cap
 * direction — "did we cross the budget" — is what matters).
 */

import * as fs from "node:fs"
import * as path from "node:path"

/** USD per 1M tokens for one model. */
export interface ModelPrice {
	/** Price per 1M INPUT (prompt) tokens, USD. */
	input: number
	/** Price per 1M OUTPUT (completion) tokens, USD. */
	output: number
	/**
	 * Price per 1M CACHED input tokens, USD (a provider-side prompt-cache hit —
	 * see LlmResponse.usage.cachedTokens). Optional and deliberately NOT
	 * defaulted to a discounted guess: when absent, cached tokens are priced
	 * at the full `input` rate, i.e. zero behavior change from before cache
	 * accounting existed. Only set this once you've confirmed the model's
	 * real cache-hit rate (e.g. from OpenRouter/provider docs) — this is a
	 * cost GUARDRAIL, so a wrong optimistic discount could let real spend
	 * exceed a configured cap.
	 */
	cacheRead?: number
}

/** Model id → price. */
export type PricingTable = Record<string, ModelPrice>

/**
 * Default pricing table (OpenRouter list rates, USD per 1M tokens).
 *
 * - `deepseek/deepseek-chat` — the harness default (Phase 1/2/5 workers).
 * - `deepseek/deepseek-reasoner` — the reasoning variant used for review/QA.
 * - `deepseek/deepseek-v4-flash` — verified against OpenRouter's own
 *   `/api/v1/models/deepseek/deepseek-v4-flash/endpoints` on 2026-08-01
 *   (modal/most-common rate across its several routed endpoints — actual
 *   per-request price can vary slightly by which upstream endpoint
 *   OpenRouter routes to, so this is an estimate, not an exact figure —
 *   consistent with this table's own guardrail-not-invoice purpose).
 *   Missing entirely from this table before was the actual root cause of a
 *   real incident: sessions silently fell through to `FALLBACK_MODEL_PRICE`
 *   (7x+ this model's real input rate), producing wildly inflated internal
 *   cost estimates and at least one false-positive budget abort.
 * - `anthropic/claude-3.5-sonnet` — a general-purpose reference model.
 */
export const DEFAULT_PRICING_TABLE: PricingTable = {
	"deepseek/deepseek-chat": { input: 0.27, output: 1.1 },
	"deepseek/deepseek-reasoner": { input: 0.55, output: 2.19 },
	"deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.028 },
	"anthropic/claude-3.5-sonnet": { input: 3.0, output: 15.0 },
}

/**
 * Conservative fallback for models missing from the table (USD per 1M).
 * Deliberately a mid-range general rate, NOT $0 — unknown models must still
 * count against the budget (fail-closed: over-estimate slightly rather than
 * underestimate, so a cost cap is never bypassed by an unlisted model id).
 */
export const FALLBACK_MODEL_PRICE: ModelPrice = { input: 2.0, output: 8.0 }

/**
 * Load the effective pricing table: defaults deep-merged with overrides from
 * `HEADLESSCODE_PRICING_JSON` (when set). A missing/unreadable/malformed file
 * throws — a broken pricing override must fail loudly, never silently weaken
 * a cost cap.
 */
export function loadPricingTable(
	env: NodeJS.ProcessEnv = process.env,
	base: PricingTable = DEFAULT_PRICING_TABLE,
): PricingTable {
	const pricingPath = env.HEADLESSCODE_PRICING_JSON
	if (!pricingPath) {
		return base
	}
	const file = path.resolve(pricingPath)
	let raw: string
	try {
		raw = fs.readFileSync(file, "utf-8")
	} catch (err) {
		throw new Error(
			`HEADLESSCODE_PRICING_JSON: cannot read pricing file '${file}': ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new Error(
			`HEADLESSCODE_PRICING_JSON: invalid JSON in '${file}': ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`HEADLESSCODE_PRICING_JSON: '${file}' must be a JSON object of {model: {input, output}}`)
	}
	const overrides: PricingTable = {}
	for (const [model, value] of Object.entries(parsed)) {
		const v = value as { input?: unknown; output?: unknown }
		if (typeof v.input === "number" && Number.isFinite(v.input) && v.input >= 0 && typeof v.output === "number" && Number.isFinite(v.output) && v.output >= 0) {
			overrides[model] = { input: v.input, output: v.output }
		}
	}
	return { ...base, ...overrides }
}

/** Resolve the price for a model (fallback when unlisted). */
export function priceFor(model: string, pricing: PricingTable = DEFAULT_PRICING_TABLE): ModelPrice {
	return pricing[model] ?? FALLBACK_MODEL_PRICE
}

export interface CostInput {
	model: string
	inputTokens?: number
	outputTokens?: number
	/**
	 * Prompt tokens served from the provider's cache (a SUBSET of
	 * inputTokens, not additional — see LlmResponse.usage.cachedTokens).
	 * Priced at price.cacheRead when set, else at the full input rate.
	 */
	cachedTokens?: number
	/** Explicit pricing table (default: env-merged defaults). */
	pricing?: PricingTable
}

/**
 * Estimate the USD cost of one LLM call from its usage token counts.
 *   cost = (inputTokens - cachedTokens) × price.input / 1e6
 *         + cachedTokens × (price.cacheRead ?? price.input) / 1e6
 *         + outputTokens × price.output / 1e6
 * `cachedTokens` is clamped to `inputTokens` (a provider reporting more
 * cached than total prompt tokens would otherwise produce a negative
 * "uncached" count).
 */
export function estimateCost(input: CostInput): number {
	const { model, inputTokens = 0, outputTokens = 0 } = input
	const table = input.pricing ?? loadPricingTable()
	const price = priceFor(model, table)
	const cachedTokens = Math.min(Math.max(input.cachedTokens ?? 0, 0), inputTokens)
	const uncachedTokens = inputTokens - cachedTokens
	const cacheRate = price.cacheRead ?? price.input
	return (uncachedTokens * price.input + cachedTokens * cacheRate + outputTokens * price.output) / 1_000_000
}

/** Sum the estimated cost across multiple calls (runs) — the session total. */
export function accumulateCost(
	runs: Array<{ model: string; inputTokens?: number; outputTokens?: number; cachedTokens?: number }>,
	pricing?: PricingTable,
): number {
	return runs.reduce((sum, run) => sum + estimateCost({ ...run, pricing }), 0)
}
