/**
 * Unit tests for src/llm/preflight.ts — the issue #13 pre-spawn preflight
 * probe. Plain assert-based script (no framework), matching the repo style.
 * The probe's key regression guard is test #1: the probe must go through
 * OpenRouterClient.createChatCompletion (NOT a hand-rolled request), so the
 * EXACT deepseek/* provider pin a real worker gets is applied to the probe —
 * a naive manual test without the pin gives a false "it's fine" signal.
 * Run via `npm test` (tsx, no network).
 */

import assert from "node:assert/strict"

import { classifyError, estimateRoundCost, NOMINAL_SESSION_INPUT_TOKENS, NOMINAL_SESSION_OUTPUT_TOKENS, runPreflight } from "../preflight.js"
import { OpenRouterError } from "../openrouter.js"

/** Capture the request body a mocked fetch receives (for the pin assertion). */
let lastRequestBody: Record<string, unknown> | undefined
const okCompletion = {
	choices: [{ message: { role: "assistant", content: "p" }, finish_reason: "stop" }],
	usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
}
let nextResponse: { status: number; body: unknown } = { status: 200, body: okCompletion }
let nextFetchError: Error | undefined

const originalFetch = globalThis.fetch

function installFetch(): void {
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		lastRequestBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
		if (nextFetchError) {
			const err = nextFetchError
			nextFetchError = undefined
			throw err
		}
		const payload = typeof nextResponse.body === "string" ? nextResponse.body : JSON.stringify(nextResponse.body)
		return new Response(payload, {
			status: nextResponse.status,
			headers: { "Content-Type": "application/json" },
		})
	}) as typeof fetch
}

function restoreFetch(): void {
	globalThis.fetch = originalFetch
	lastRequestBody = undefined
	nextResponse = { status: 200, body: okCompletion }
	nextFetchError = undefined
}

// ─── the probe reproduces the EXACT worker request (provider pin + 1 token) ─

async function testProbeUsesTheExactWorkerProviderPinAndOneToken(): Promise<void> {
	installFetch()
	try {
		const result = await runPreflight({
			model: "deepseek/deepseek-v4-flash",
			apiKey: "k",
			baseUrl: "http://mock",
			workerSessions: 2,
		})
		assert.equal(result.status, "ok")
		// The whole point of the issue: the probe body carries the SAME
		// provider pin (order: ["deepseek"], allow_fallbacks: false) that
		// buildRequestBody applies to a real worker's request. A probe without
		// this pin can silently route to a different provider and lie "ok".
		assert.deepEqual(lastRequestBody?.provider, { order: ["deepseek"], allow_fallbacks: false })
		assert.equal(lastRequestBody?.max_tokens, 1, "the probe is a cheap 1-token completion")
		assert.equal(lastRequestBody?.model, "deepseek/deepseek-v4-flash")
		assert.ok(result.line.includes("all clear"), `ok line names the all-clear: ${result.line}`)
		assert.ok(result.line.includes("estimated round cost"), "ok line carries the round cost estimate")
		assert.ok(result.line.includes("2 worker session(s)"), "round estimate scales with the session count")
		assert.ok(result.latencyMs >= 0)
	} finally {
		restoreFetch()
	}
}

async function testProbeDoesNotPinNonDeepseekModels(): Promise<void> {
	installFetch()
	try {
		await runPreflight({ model: "anthropic/claude-3.5-sonnet", apiKey: "k", baseUrl: "http://mock" })
		assert.equal(lastRequestBody?.provider, undefined, "non-deepseek models keep OpenRouter's default routing")
	} finally {
		restoreFetch()
	}
}

// ─── failure-mode classification (the issue's core ask) ─────────────────────

async function testClassifyInvalidKey(): Promise<void> {
	assert.equal(classifyError(new OpenRouterError("OpenRouter returned HTTP 401: bad key", 401, "unauthorized")), "invalid-key")
	assert.equal(classifyError(new OpenRouterError("OpenRouter returned HTTP 403: forbidden", 403)), "invalid-key")
}

async function testClassifyBalanceExhausted(): Promise<void> {
	// HTTP 402 — the explicit payment-required status.
	assert.equal(classifyError(new OpenRouterError("OpenRouter returned HTTP 402", 402)), "balance")
	// insufficient_balance named in the body text (can arrive as 429 or 200-envelope too).
	assert.equal(
		classifyError(new OpenRouterError("OpenRouter returned HTTP 200 with an error envelope: insufficient_balance")),
		"balance",
	)
	assert.equal(
		classifyError(new OpenRouterError("OpenRouter returned HTTP 429: quota", 429, '"error":"Insufficient Quota"')),
		"balance",
	)
	assert.equal(
		classifyError(new OpenRouterError("OpenRouter returned HTTP 402: out of credits", 402, "out of credit")),
		"balance",
	)
}

async function testClassifyPinnedProviderUnreachable(): Promise<void> {
	// 520 = OpenRouter's "the upstream provider failed" — the exact case that
	// misled a real session (a naive no-pin test routed elsewhere and looked
	// fine).
	assert.equal(classifyError(new OpenRouterError("OpenRouter returned HTTP 520", 520)), "provider")
	assert.equal(classifyError(new OpenRouterError("OpenRouter returned HTTP 529", 529)), "provider")
	assert.equal(classifyError(new OpenRouterError("OpenRouter returned HTTP 503", 503)), "provider")
	// 429 without balance language = capacity/no-available-provider (the
	// pinned endpoint's own depletion with allow_fallbacks:false).
	assert.equal(classifyError(new OpenRouterError("OpenRouter returned HTTP 429", 429, "No available providers")), "provider")
	// 200-with-error-envelope naming the endpoint.
	assert.equal(
		classifyError(new OpenRouterError("OpenRouter returned HTTP 200 with an error envelope: endpoint returned an error")),
		"provider",
	)
}

async function testClassifyNetworkAndOther(): Promise<void> {
	assert.equal(classifyError(new OpenRouterError("Network error calling OpenRouter: ECONNREFUSED")), "network")
	assert.equal(classifyError(new OpenRouterError("OpenRouter returned HTTP 400: bad request", 400)), "other")
	assert.equal(classifyError(new Error("not an OpenRouterError")), "other")
}

// ─── runPreflight end-to-end against a mocked endpoint ──────────────────────

async function testRunPreflightClassifiesHttpFailures(): Promise<void> {
	for (const [status, body, expected] of [
		[401, { error: { message: "bad key" } }, "invalid-key"],
		[402, { error: { message: "insufficient_balance" } }, "balance"],
		[520, { error: { message: "upstream error" } }, "provider"],
		[503, {}, "provider"],
	] as const) {
		installFetch()
		try {
			nextResponse = { status, body }
			const result = await runPreflight({ model: "deepseek/deepseek-v4-flash", apiKey: "k", baseUrl: "http://mock", workerSessions: 1 })
			assert.equal(result.status, expected, `HTTP ${status} -> ${expected}`)
			assert.ok(result.line.length > 0, "failure line is present")
			assert.ok(!result.line.includes("all clear"), "a failure never prints the all-clear line")
		} finally {
			restoreFetch()
		}
	}
}

async function testRunPreflightNoApiKey(): Promise<void> {
	// Isolate from the ambient env: an operator may legitimately have
	// HEADLESSCODE_OPENROUTER_API_KEY exported, and this test must exercise
	// the no-key path WITHOUT making a real (paid) network probe.
	const savedKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY
	const savedBaseUrl = process.env.OPENROUTER_BASE_URL
	delete process.env.HEADLESSCODE_OPENROUTER_API_KEY
	process.env.OPENROUTER_BASE_URL = "http://mock"
	try {
		// No workerSessions -> no round estimate; the probe must not hit the network.
		const result = await runPreflight({ model: "deepseek/deepseek-v4-flash" })
		assert.equal(result.status, "no-api-key")
		assert.ok(result.line.includes("HEADLESSCODE_OPENROUTER_API_KEY"), "names the missing env var")
		assert.equal(lastRequestBody, undefined, "no network call without a key")
		assert.equal(result.roundCostEstimateUsd, undefined, "no workerSessions -> no round estimate")
		// With a session count the estimate is still derivable even without a key.
		const withSessions = await runPreflight({ model: "deepseek/deepseek-v4-flash", workerSessions: 3 })
		assert.equal(withSessions.status, "no-api-key")
		assert.ok(typeof withSessions.roundCostEstimateUsd === "number" && withSessions.roundCostEstimateUsd > 0)
	} finally {
		if (savedKey === undefined) {
			delete process.env.HEADLESSCODE_OPENROUTER_API_KEY
		} else {
			process.env.HEADLESSCODE_OPENROUTER_API_KEY = savedKey
		}
		if (savedBaseUrl === undefined) {
			delete process.env.OPENROUTER_BASE_URL
		} else {
			process.env.OPENROUTER_BASE_URL = savedBaseUrl
		}
	}
}

async function testRunPreflightNetworkError(): Promise<void> {
	installFetch()
	try {
		nextFetchError = new Error("fetch failed: ECONNREFUSED")
		const result = await runPreflight({ model: "deepseek/deepseek-v4-flash", apiKey: "k", baseUrl: "http://mock" })
		assert.equal(result.status, "network")
		assert.ok(result.line.includes("network error"), `network line: ${result.line}`)
	} finally {
		restoreFetch()
	}
}

async function testRunPreflightOkReportsProbeCostFromUsage(): Promise<void> {
	installFetch()
	try {
		nextResponse = {
			status: 200,
			body: {
				choices: [{ message: { role: "assistant", content: "p" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
			},
		}
		const result = await runPreflight({ model: "deepseek/deepseek-v4-flash", apiKey: "k", baseUrl: "http://mock", workerSessions: 4 })
		assert.equal(result.status, "ok")
		assert.ok(result.probeCostUsd > 0, "probe cost derived from the returned usage")
	} finally {
		restoreFetch()
	}
}

// ─── round cost estimate ─────────────────────────────────────────────────────

async function testEstimateRoundCost(): Promise<void> {
	// deepseek/deepseek-v4-flash: $0.14/1M in, $0.28/1M out, $0.0028/1M cached.
	// The estimator must model the ITERATIVE loop (context resends, mostly
	// cache-read) — the old single-request model was ~27x low on a live round
	// (round1-consolidation 2026-08-16: estimated $0.0336 for the round vs a
	// ~$0.90 actual: $0.09–$0.39/session over 83–241 iterations).
	const perSession = estimateRoundCost("deepseek/deepseek-v4-flash", 1)
	const singleRequest = (NOMINAL_SESSION_INPUT_TOKENS * 0.14 + NOMINAL_SESSION_OUTPUT_TOKENS * 0.28) / 1_000_000
	assert.ok(
		perSession > singleRequest * 10,
		`iterative model must price a real multi-iteration session, not one request (perSession ${perSession} vs single-request ${singleRequest})`,
	)
	assert.ok(perSession > 0.02 && perSession < 1.0, `per-session estimate lands in a plausible band: ${perSession}`)
	assert.ok(Math.abs(estimateRoundCost("deepseek/deepseek-v4-flash", 4) - perSession * 4) < 1e-9, "scales with sessions")
	// Unknown model falls back to FALLBACK_MODEL_PRICE (conservative, > 0).
	assert.ok(estimateRoundCost("nope/model", 1) > 0, "unknown models still produce a conservative estimate")
}

async function testRoundCostCeiling(): Promise<void> {
	const { roundCostCeilingUsd } = await import("../preflight.js")
	assert.equal(roundCostCeilingUsd(2, 0.5), 1.0)
	assert.equal(roundCostCeilingUsd(2, undefined), undefined)
	assert.equal(roundCostCeilingUsd(2, -1), undefined, "a non-positive cap is ignored")
}

// ─── runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["probe uses the exact worker provider pin + 1 token", testProbeUsesTheExactWorkerProviderPinAndOneToken],
	["probe does not pin non-deepseek models", testProbeDoesNotPinNonDeepseekModels],
	["classifyError: invalid key (401/403)", testClassifyInvalidKey],
	["classifyError: account balance exhausted (402/insufficient_balance)", testClassifyBalanceExhausted],
	["classifyError: pinned provider unreachable/depleted (5xx/429)", testClassifyPinnedProviderUnreachable],
	["classifyError: network + unexpected", testClassifyNetworkAndOther],
	["runPreflight classifies HTTP failures end-to-end", testRunPreflightClassifiesHttpFailures],
	["runPreflight: no API key", testRunPreflightNoApiKey],
	["runPreflight: network error", testRunPreflightNetworkError],
	["runPreflight ok reports probe cost from usage", testRunPreflightOkReportsProbeCostFromUsage],
	["estimateRoundCost scales with sessions + pricing", testEstimateRoundCost],
	["roundCostCeilingUsd honors the per-session cap", testRoundCostCeiling],
]

let passed = 0
for (const [name, fn] of tests) {
	try {
		await fn()
		passed++
		console.log(`ok ${passed} - ${name}`)
	} catch (err) {
		console.error(`FAIL - ${name}`)
		console.error(err instanceof Error ? err.stack ?? String(err) : err)
		process.exitCode = 1
		break
	}
}
console.log(`All ${tests.length} tests passed`)
if (passed !== tests.length) {
	process.exitCode = 1
}
