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
 * - `deepseek/deepseek-v4-flash-0731` — the harness default (Phase 1/2/5
 *   workers; see `DEFAULT_MODEL` in src/llm/openrouter.ts). Priced the same
 *   as the prior default, `deepseek/deepseek-v4-flash` (kept below for
 *   override compat) — same model line, dated point-release id. The rate is
 *   the OFFICIAL DeepSeek provider's own rate specifically (verified
 *   against OpenRouter's own
 *   `/api/v1/models/deepseek/deepseek-v4-flash/endpoints` on 2026-08-01,
 *   cross-checked against OpenRouter's own pricing UI). This price is only
 *   actually correct because `src/llm/openrouter.ts` pins routing to this
 *   exact provider (`provider: { order: ["deepseek"], allow_fallbacks:
 *   false }`) for deepseek/* models — OTHER routed endpoints behind the
 *   same model id (DeepInfra, Baidu, Mancer, ...) have meaningfully
 *   different prices, especially for cache reads, so this number would be
 *   wrong/unverifiable without that pin. If the pin is ever removed, this
 *   price must be revisited, not left as a stale guess.
 *   Missing entirely from this table before was the actual root cause of a
 *   real incident: sessions silently fell through to `FALLBACK_MODEL_PRICE`
 *   (7x+ this model's real input rate), producing wildly inflated internal
 *   cost estimates and at least one false-positive budget abort. A second,
 *   smaller error (`cacheRead` off by 10x — $0.028 instead of the real
 *   $0.0028/1M) was caught and fixed the same day.
 * - `deepseek/deepseek-v4-flash` — the previous default, kept priced so an
 *   explicit override to the un-dated id still estimates correctly.
 * - `deepseek/deepseek-chat` — the legacy default, still priced so an
 *   explicit `OPENROUTER_MODEL=deepseek/deepseek-chat` override accounts
 *   correctly.
 * - `deepseek/deepseek-reasoner` — the reasoning variant used for review/QA.
 * - `anthropic/claude-3.5-sonnet` — a general-purpose reference model.
 * - `qwen/qwen3-embedding-4b` / `qwen/qwen3-embedding-8b` — the codebase-index
 *   embedding models (src/codesearch/embedder.ts; 8b is the default since
 *   the central-store round, 4b kept priced so a legacy index/override still
 *   estimates correctly). Embedding responses carry no completion tokens
 *   (output is always 0). The rates are CONSERVATIVE input-only estimates:
 *   $0.15/1M for 4b was observed live on OpenRouter's Google embedding
 *   endpoint (2026-08-01), and 8b is estimated at $0.30/1M (2x the 4b rate,
 *   parameter-scaled) because embedding models are absent from OpenRouter's
 *   /api/v1/models listing so neither list price is API-verifiable (see
 *   src/codesearch/embedder.ts's header). Pricing a guardrail means
 *   fail-closed: estimate rather than $0, so an index build on a large repo
 *   still counts against a cost cap.
 */
export const DEFAULT_PRICING_TABLE: PricingTable = {
 "deepseek/deepseek-chat": { input: 0.27, output: 1.1 },
 "deepseek/deepseek-reasoner": { input: 0.55, output: 2.19 },
 "deepseek/deepseek-v4-flash-0731": { input: 0.14, output: 0.28, cacheRead: 0.0028 },
 "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028 },
 "anthropic/claude-3.5-sonnet": { input: 3.0, output: 15.0 },
 "qwen/qwen3-embedding-4b": { input: 0.15, output: 0.15 },
 "qwen/qwen3-embedding-8b": { input: 0.3, output: 0.3 },
 // Cloud vision captioning (src/vision/describe.ts). Live OpenRouter list
 // rates pulled 2026-08-02 for image-input models; the 12b is the default
 // (cheapest candidate that wasn't materially worse than the quality anchor
 // in the image-support evaluation — see plans/image-support.md), and the
 // 27b is priced too so an override to the quality anchor still estimates
 // accurately instead of falling through to FALLBACK_MODEL_PRICE. Both were
 // verified live against the API during the evaluation.
 "google/gemma-3-12b-it": { input: 0.05, output: 0.15 },
 "google/gemma-3-27b-it": { input: 0.08, output: 0.45 },
}

/**
 * Conservative fallback for models missing from the table (USD per 1M).
 * Deliberately a mid-range general rate, NOT $0 — unknown models must still
 * count against the budget (fail-closed: over-estimate slightly rather than
 * underestimate, so a cost cap is never bypassed by an unlisted model id).
 */
export const FALLBACK_MODEL_PRICE: ModelPrice = { input: 2.0, output: 8.0 }

/** One endpoint entry of OpenRouter's `/api/v1/models/<id>/endpoints` response. */
export interface EndpointPricingEntry {
	/** Provider slug as OpenRouter reports it (e.g. "DeepSeek", "DeepInfra"). */
	provider_name?: unknown
	/** Per-token prices as STRINGS, USD per token (verified live 2026-08-04). */
	pricing?: {
		prompt?: unknown
		completion?: unknown
		input_cache_read?: unknown
	}
}

/** Parse a per-token USD string like "0.00000014" into per-1M-token USD. */
function perTokenToPerMillion(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") {
		return undefined
	}
	const n = typeof value === "string" ? Number(value) : value
	if (!Number.isFinite(n) || n < 0) {
		return undefined
	}
	return n * 1_000_000
}

/**
 * Parse live endpoint pricing into a `ModelPrice` (USD per 1M tokens).
 *
 * Selection rules, mirroring how the request actually routes:
 * - When `providerPreference` is given (e.g. "DeepSeek" for the deepseek/*
 *   chat pin), the FIRST endpoint whose provider_name matches (case-
 *   insensitive) is used verbatim — that is the price actually charged.
 * - Otherwise the MAX of each field across all endpoints that expose it is
 *   used. This is a deliberate fail-closed choice: for auto-routed models the
 *   harness cannot know which endpoint served a call, and this table is a
 *   GUARDRAIL (the codebase's FALLBACK_MODEL_PRICE rationale) — over-
 *   estimating is safe, under-estimating lets a cap be bypassed.
 *
 * Returns undefined when no endpoint exposes usable pricing.
 */
export function parseEndpointPricing(
	endpoints: EndpointPricingEntry[],
	providerPreference?: string,
): ModelPrice | undefined {
	let price: ModelPrice | undefined
	for (const ep of endpoints) {
		const pricing = ep?.pricing
		if (!pricing || typeof pricing !== "object") {
			continue
		}
		const parsed: ModelPrice = {
			input: perTokenToPerMillion(pricing.prompt) ?? 0,
			output: perTokenToPerMillion(pricing.completion) ?? 0,
		}
		if (parsed.input === 0 && parsed.output === 0) {
			continue
		}
		const cacheRead = perTokenToPerMillion(pricing.input_cache_read)
		if (cacheRead !== undefined) {
			parsed.cacheRead = cacheRead
		}
		// Provider-preference match wins outright (first match — a match
		// returns immediately, so reaching the end without returning means no
		// usable match existed).
		if (providerPreference) {
			const name = typeof ep?.provider_name === "string" ? ep.provider_name : ""
			if (name.toLowerCase() === providerPreference.toLowerCase()) {
				return parsed
			}
		}
		// Otherwise keep the conservative per-field max.
		price = {
			input: Math.max(price?.input ?? 0, parsed.input),
			output: Math.max(price?.output ?? 0, parsed.output),
			...(cacheRead !== undefined
				? { cacheRead: Math.max(price?.cacheRead ?? 0, cacheRead) }
				: price?.cacheRead !== undefined
					? { cacheRead: price.cacheRead }
					: {}),
		}
	}
	// A preference was requested but no endpoint matched it — return nothing
	// so the caller falls back to the hardcoded table (for deepseek/* that
	// table IS the official endpoint's rate; using some other host's numbers
	// for a pinned model would be wrong).
	if (providerPreference) {
		return undefined
	}
	return price
}

/** Merge a live-resolved price into a pricing table under a model id. */
export function mergeLivePrice(table: PricingTable, model: string, price: ModelPrice): PricingTable {
	return { ...table, [model]: price }
}

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
