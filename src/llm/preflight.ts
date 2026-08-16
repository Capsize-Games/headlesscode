/**
 * Preflight probe for `orchestrate` (issue #13).
 *
 * Before ANY worker is spawned, make one cheap 1-token completion using the
 * EXACT model + provider pin a real worker will use (the pin is applied by
 * `buildRequestBody` in src/llm/openrouter.ts for deepseek/* models, so a
 * probe through `OpenRouterClient.createChatCompletion` reproduces it by
 * construction — this is the whole point: a naive manual test request WITHOUT
 * the pin silently routes to a different, reachable provider and gives a
 * false "it's fine" signal).
 *
 * The failure this catches would otherwise only surface 30-80 iterations
 * (10-15 minutes of wall time and real spend) into a round. The classification
 * also separates three failure modes a generic error message conflates:
 *   - the API key is invalid/missing (HTTP 401/403);
 *   - the OpenRouter account balance is exhausted (402 / insufficient_balance
 *     in the body or a 200 error envelope);
 *   - the PINNED provider itself is unreachable/depleted (5xx/429 — distinct
 *     from account balance; this is the case that misled a real session).
 *
 * `--no-preflight` (orchestrate) skips the extra round-trip for CI /
 * non-interactive contexts; on by default given the cost of getting this
 * wrong.
 */

import type { PricingTable } from "../budget/cost.js"
import { estimateCost, loadPricingTable } from "../budget/cost.js"
import { OpenRouterClient, OpenRouterError, OPENROUTER_BASE_URL, DEFAULT_MODEL } from "./openrouter.js"
import type { LlmRequest } from "../engine/types.js"

/**
 * Outcome of the preflight probe. `"ok"` is the only status that means
 * "spawn the round"; everything else is a distinct, diagnosable failure.
 */
export type PreflightStatus = "ok" | "no-api-key" | "invalid-key" | "balance" | "provider" | "network" | "other"

export interface PreflightResult {
	status: PreflightStatus
	/** The model id the probe ran with (the exact model a worker would use). */
	model: string
	/** The OpenRouter base URL probed. */
	baseUrl: string
	/** A single clear, human-readable preflight line (for the CLI + dashboard). */
	line: string
	/** Probe wall time, ms. */
	latencyMs: number
	/** Estimated USD cost of the 1-token probe itself. */
	probeCostUsd: number
	/**
	 * Order-of-magnitude estimate of the round's LLM cost (nominal per-session
	 * token profile × worker session count × the model's price). undefined when
	 * the caller didn't provide a worker session count.
	 */
	roundCostEstimateUsd?: number
}

export interface PreflightOptions {
	/** The model id a worker would use (defaults to the client default). */
	model?: string
	/** API key (default: $HEADLESSCODE_OPENROUTER_API_KEY). */
	apiKey?: string
	/** OpenRouter base URL (default: $OPENROUTER_BASE_URL or the built-in). */
	baseUrl?: string
	/**
	 * Number of worker sessions the round will spawn — used for the round cost
	 * estimate. Omit/0 to skip the estimate.
	 */
	workerSessions?: number
	/**
	 * Per-session cost cap ($HEADLESSCODE_MAX_COST_USD) — when set, the
	 * preflight line also shows the round ceiling (cap × sessions).
	 */
	maxCostUsd?: number
	/** Env to read key/base-url from (default: process.env). */
	env?: NodeJS.ProcessEnv
	signal?: AbortSignal
}

/**
 * Nominal per-session token profile for the round cost estimate. Deliberately
 * an ORDER-OF-MAGNITUDE heuristic, clearly labeled as such in the output: the
 * estimate is for deciding whether a round is affordable, not for billing.
 */
/** Prefix/first-request size per session (system prompt + tool catalog). */
export const NOMINAL_SESSION_INPUT_TOKENS = 40_000
/** Single-request output baseline (kept for compatibility/testing). */
export const NOMINAL_SESSION_OUTPUT_TOKENS = 10_000
/** Nominal iterations per worker session for the estimate. */
export const NOMINAL_SESSION_ITERATIONS = 120
/** History growth per iteration (tokens) — tool-call turns accumulate. */
export const NOMINAL_HISTORY_GROWTH_PER_ITERATION = 700
/** Output tokens per iteration (a tool-call turn, not a big generation). */
export const NOMINAL_OUTPUT_TOKENS_PER_ITERATION = 1_000
/**
 * Cache-hit rate for resends of the growing history. Live rounds measured
 * ~94% (round1-consolidation 2026-08-16, deepseek-v4-flash) — context resends
 * are cheap cache reads; only the prefix and misses pay full input price.
 */
export const NOMINAL_CACHE_HIT_RATE = 0.9

/**
 * Estimate the round's LLM cost by modeling the ITERATIVE loop, not a single
 * request: history grows ~linearly each iteration, so total input ≈
 * iterations × average-history-size, most of it cache-read; output scales with
 * iterations. Calibrated against a live 4-worker round (2026-08-16) that
 * measured $0.09–$0.39/session over 83–241 iterations — the old single-request
 * model (40k in / 10k out) estimated $0.0336 for the whole round, ~27× under
 * the ~$0.90 actual. Uses the effective pricing table (defaults +
 * $HEADLESSCODE_PRICING_JSON overrides), same as the budget guardrail.
 */
export function estimateRoundCost(
	model: string,
	workerSessions: number,
	options: { pricing?: PricingTable; env?: NodeJS.ProcessEnv; iterationsPerSession?: number } = {},
): number {
	const table = options.pricing ?? loadPricingTable(options.env ?? process.env)
	const iterations = options.iterationsPerSession ?? NOMINAL_SESSION_ITERATIONS
	// Average history size over the session ≈ prefix + (iterations/2) × growth.
	const avgHistoryTokens = NOMINAL_SESSION_INPUT_TOKENS + (iterations / 2) * NOMINAL_HISTORY_GROWTH_PER_ITERATION
	const totalInputTokens = avgHistoryTokens * iterations
	const perSession = estimateCost({
		model,
		inputTokens: totalInputTokens,
		cachedTokens: Math.round(totalInputTokens * NOMINAL_CACHE_HIT_RATE),
		outputTokens: iterations * NOMINAL_OUTPUT_TOKENS_PER_ITERATION,
		pricing: table,
	})
	return perSession * Math.max(1, workerSessions)
}

/** Round cost ceiling when a per-session cap is configured (cap × sessions). */
export function roundCostCeilingUsd(workerSessions: number, maxCostUsd?: number): number | undefined {
	if (maxCostUsd === undefined || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
		return undefined
	}
	return maxCostUsd * Math.max(1, workerSessions)
}

/** Balance/credit keywords — the highest-signal text signal, checked FIRST. */
const BALANCE_RE = /insufficient_balance|insufficient balance|insufficient_quota|insufficient quota|payment required|out of credit|out of quota|billing|account balance|402/i

/** Pinned-provider-down language, used to name 5xx/429/200-envelope failures. */
const PROVIDER_DOWN_RE = /no available providers?|all providers?|provider.*(?:unavailable|down|error|failed)|endpoint.*(?:unavailable|down|error|failed)|upstream|capacity|overloaded|5[0-9]{2}|520|529|530/i

/**
 * Classify an OpenRouter probe failure into the issue's named failure modes.
 * Exported for direct unit testing; the text checks run before the status
 * checks because OpenRouter reports the same underlying problem (e.g. a dead
 * account) as 402, 429, or a 200-with-error-envelope depending on which
 * gateway layer answers.
 */
export function classifyError(err: unknown): PreflightStatus {
	if (!(err instanceof OpenRouterError)) {
		return "other"
	}
	const haystack = `${err.message} ${err.body ?? ""}`
	if (BALANCE_RE.test(haystack)) {
		return "balance"
	}
	if (err.status === 401 || err.status === 403) {
		return "invalid-key"
	}
	if (err.status === 402) {
		return "balance"
	}
	if (err.status === 429 || (err.status !== undefined && err.status >= 500)) {
		// 429 = OpenRouter's "no available provider / capacity" signal (with
		// allow_fallbacks:false the pinned provider's own quota/depletion
		// surfaces here); 5xx = the upstream endpoint or the OpenRouter
		// gateway failed. Both are "the pinned endpoint isn't serving right
		// now", distinct from the account-balance case above.
		return "provider"
	}
	if (err.status === undefined) {
		if (/^Network error/.test(err.message)) {
			return "network"
		}
		if (PROVIDER_DOWN_RE.test(haystack)) {
			return "provider"
		}
		return "other"
	}
	return "other"
}

function resolveBaseUrl(options: PreflightOptions): string {
	const env = options.env ?? process.env
	return (options.baseUrl ?? env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")
}

function excerpt(text: string, max = 160): string {
	const t = text.trim().replace(/\s+/g, " ")
	return t.length > max ? `${t.slice(0, max)}…` : t
}

/** Compose the single human-readable preflight line for a result. */
export function buildPreflightLine(
	result: Omit<PreflightResult, "line"> & { workerSessions: number; maxCostUsd?: number },
): string {
	const { status, model, latencyMs, probeCostUsd, roundCostEstimateUsd, workerSessions, maxCostUsd } = result
	const pinNote = model.startsWith("deepseek/") ? ' (pinned to provider "deepseek")' : ""
	const costPart =
		roundCostEstimateUsd !== undefined
			? `; estimated round cost ≈ $${roundCostEstimateUsd.toFixed(3)} (${workerSessions} worker session(s), order-of-magnitude)`
			: ""
	const ceiling = roundCostCeilingUsd(workerSessions, maxCostUsd)
	const ceilingPart = ceiling !== undefined ? `; per-session cap $${maxCostUsd} → round ceiling $${ceiling.toFixed(3)}` : ""

	switch (status) {
		case "ok":
			return (
				`${model}${pinNote}: all clear — 1-token probe OK in ${latencyMs}ms (probe ≈ $${probeCostUsd.toFixed(6)})` +
				costPart +
				ceilingPart
			)
		case "no-api-key":
			return "HEADLESSCODE_OPENROUTER_API_KEY is not set — workers cannot reach OpenRouter"
		case "invalid-key":
			return `${model}${pinNote}: API key invalid or unauthorized (HTTP 401/403) — check HEADLESSCODE_OPENROUTER_API_KEY`
		case "balance":
			return `${model}${pinNote}: OpenRouter account balance exhausted (insufficient_balance / HTTP 402) — top up the account before spawning workers`
		case "provider":
			return `${model}${pinNote}: pinned provider unreachable or depleted (HTTP 5xx/429) — distinct from account balance; the pinned official endpoint is not serving this model right now`
		case "network":
			return `network error reaching OpenRouter (${result.baseUrl}) — check connectivity`
		default:
			return `${model}${pinNote}: preflight probe failed with an unexpected error — inspect the message`
	}
}

/**
 * Run the preflight probe. Never throws: every failure mode is folded into a
 * `PreflightResult` with a clear status + line (the CLI aborts on any
 * non-"ok" status).
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
	const env = options.env ?? process.env
	const apiKey = options.apiKey ?? env.HEADLESSCODE_OPENROUTER_API_KEY
	const model = (options.model?.trim() || DEFAULT_MODEL).trim()
	const baseUrl = resolveBaseUrl(options)
	const workerSessions = Math.max(1, options.workerSessions ?? 0)
	const roundCostEstimateUsd =
		options.workerSessions !== undefined && options.workerSessions > 0 ? estimateRoundCost(model, workerSessions, { env }) : undefined

	if (!apiKey) {
		const result: PreflightResult = {
			status: "no-api-key",
			model,
			baseUrl,
			line: "",
			latencyMs: 0,
			probeCostUsd: 0,
			roundCostEstimateUsd,
		}
		result.line = buildPreflightLine({ ...result, workerSessions, maxCostUsd: options.maxCostUsd })
		return result
	}

	const client = new OpenRouterClient({ apiKey, baseUrl, defaultModel: model })
	const startedAt = Date.now()
	let status: PreflightStatus
	let probeCostUsd = 0
	let detail = ""
	try {
		const probeRequest: LlmRequest = {
			model,
			messages: [{ role: "user", content: "ping" }],
			maxTokens: 1,
			temperature: 0,
			signal: options.signal,
		}
		const response = await client.createChatCompletion(probeRequest)
		status = "ok"
		const usage = response.usage
		probeCostUsd = estimateCost({
			model,
			inputTokens: usage?.promptTokens ?? 0,
			outputTokens: usage?.completionTokens ?? 0,
			cachedTokens: usage?.cachedTokens ?? 0,
		})
	} catch (err) {
		status = classifyError(err)
		detail = err instanceof Error ? err.message : String(err)
	}
	const latencyMs = Date.now() - startedAt

	const result: PreflightResult = {
		status,
		model,
		baseUrl,
		line: "",
		latencyMs,
		probeCostUsd,
		roundCostEstimateUsd,
	}
	const line = buildPreflightLine({ ...result, workerSessions, maxCostUsd: options.maxCostUsd })
	result.line = status === "ok" ? line : `${line} — ${excerpt(detail)}`
	return result
}
