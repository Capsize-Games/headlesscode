import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { FileOpenRouterInferenceLedger, openRouterCampaignBudgetAllocation, RSI_OPENROUTER_MODEL, startOpenRouterBroker, validateOpenRouterBrokerLimits } from "../inference-broker.js"
import type { OpenRouterBrokerLimits } from "../inference-broker.js"

function limits(campaignId: string, overrides: Partial<OpenRouterBrokerLimits> = {}): OpenRouterBrokerLimits {
	return {
		campaignId, maxCalls: 2, maxInputTokensPerCall: 8_000, maxOutputTokensPerCall: 64, maxTotalTokens: 10_000,
		maxDurationMs: 5_000, maxRequestBytes: 16_384, maxResponseBytes: 16_384,
		maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 1,
		maxCallSpendUsd: 0.02, maxJobSpendUsd: 0.04, maxCampaignSpendUsd: 0.08, ...overrides,
	}
}

function fakeFetch(options: { usage?: Record<string, unknown>; model?: string } = {}) {
	const requests: Array<{ url: string; init?: RequestInit }> = []
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input)
		requests.push({ url, init })
		if (url.includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [{ provider_slug: "deepseek", provider_name: "DeepSeek", pricing: { prompt: "0.000001", completion: "0.000001" } }] } }), { status: 200 })
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>
		assert.equal(body.model, RSI_OPENROUTER_MODEL)
		assert.deepEqual(body.provider, { order: ["deepseek"], allow_fallbacks: false })
		assert.equal(body.max_completion_tokens, 64)
		assert.equal((init?.headers as Record<string, string>).authorization, "Bearer host-secret")
		const response = { id: "or-test-1", model: options.model ?? RSI_OPENROUTER_MODEL, choices: [], usage: options.usage ?? { prompt_tokens: 20, completion_tokens: 10, cost: 0.0002 } }
		return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } })
	}) as typeof fetch
	return { fetcher, requests }
}

const requestBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
	model: RSI_OPENROUTER_MODEL,
	messages: [{ role: "user", content: "Fix the small function and run its tests." }],
	max_completion_tokens: 256,
	...extra,
})

async function setup(t: { after(fn: () => void | Promise<void>): void }, overrides: { usage?: Record<string, unknown>; model?: string; limits?: OpenRouterBrokerLimits; upstreamFetch?: typeof fetch } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-inference-broker-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const ledger = new FileOpenRouterInferenceLedger(path.join(root, "ledger.json"))
	const upstream = overrides.upstreamFetch ? { fetcher: overrides.upstreamFetch, requests: [] as Array<{ url: string; init?: RequestInit }> } : fakeFetch(overrides)
	const broker = await startOpenRouterBroker({
		jobId: "attempt-1234567890123456", leaseToken: "lease-test", limits: overrides.limits ?? limits("campaign-test"), apiKey: "host-secret",
		bindHost: "127.0.0.1", ledger, upstreamFetch: upstream.fetcher,
	})
	t.after(() => broker.close())
	return { root, ledger, broker, upstream }
}

test("OpenRouter broker pins model/provider, accounts usage, and survives broker restart", async (t) => {
	const { root, ledger, broker, upstream } = await setup(t)
	const call = () => fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "call-1234567890123456" }, body: requestBody(),
	})
	const response = await call()
	assert.equal(response.status, 200)
	assert.equal((await broker.receipt()).qualified, true)
	assert.equal((await broker.receipt()).costUsd, 0.0002)
	assert.equal(upstream.requests.filter((entry) => entry.url.endsWith("/chat/completions")).length, 1)
	assert.equal(String(upstream.requests[1]?.init?.headers && (upstream.requests[1].init?.headers as Record<string, string>).authorization), "Bearer host-secret")
	await broker.close()
	const restarted = await startOpenRouterBroker({
		jobId: "attempt-1234567890123456", leaseToken: "lease-test", limits: limits("campaign-test"), apiKey: "host-secret",
		bindHost: "127.0.0.1", ledger, upstreamFetch: upstream.fetcher,
	})
	try { assert.equal((await restarted.receipt()).qualified, true, "durable call receipt survives broker restart") }
	finally { await restarted.close() }
})

test("file ledger preserves the job deadline across broker restart and rejects a late response", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-inference-deadline-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const ledgerPath = path.join(root, "ledger.json")
	const ledger = new FileOpenRouterInferenceLedger(ledgerPath)
	const jobLimits = limits("campaign-deadline", { maxDurationMs: 1_000 })
	const startedAt = 2_000_000
	let nowMs = startedAt
	let releaseUpstream!: (response: Response) => void
	let dispatched!: () => void
	const wasDispatched = new Promise<void>((resolve) => { dispatched = resolve })
	const upstreamFetch = (async (input: string | URL) => {
		if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [{ provider_slug: "deepseek", pricing: { prompt: "0.000001", completion: "0.000001" } }] } }), { status: 200 })
		dispatched()
		return await new Promise<Response>((resolve) => { releaseUpstream = resolve })
	}) as typeof fetch
	const first = await startOpenRouterBroker({
		jobId: "attempt-deadline-123456", leaseToken: "lease-test", limits: jobLimits, apiKey: "host-secret",
		bindHost: "127.0.0.1", ledger, upstreamFetch, now: () => nowMs,
	})
	const firstReceipt = await ledger.receipt({ jobId: "attempt-deadline-123456", leaseToken: "lease-test", capability: first.capability, model: RSI_OPENROUTER_MODEL, limits: jobLimits })
	assert.equal(firstReceipt.qualified, false)
	await first.close()
	nowMs = startedAt + 500
	const restarted = await startOpenRouterBroker({
		jobId: "attempt-deadline-123456", leaseToken: "lease-test", limits: jobLimits, apiKey: "host-secret",
		bindHost: "127.0.0.1", ledger, upstreamFetch, now: () => nowMs,
	})
	t.after(() => restarted.close())
	const post = fetch(`${restarted.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${restarted.capability}`, "content-type": "application/json", "x-rsi-call-id": "call-deadline-123456" }, body: requestBody(),
	})
	await wasDispatched
	nowMs = startedAt + 1_001
	releaseUpstream(new Response(JSON.stringify({ id: "late", model: RSI_OPENROUTER_MODEL, choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.0002 } }), { status: 200, headers: { "content-type": "application/json" } }))
	const response = await post
	assert.equal(response.status, 429, "a response arriving after the persisted job deadline is not returned to the guest")
	assert.match((await response.json() as { error: { message: string } }).error.message, /duration limit exhausted/)
	const receipt = await restarted.receipt()
	assert.equal(receipt.qualified, false)
	assert.equal(receipt.callReceipts[0]?.state, "unmeasured")
})

test("OpenRouter broker rejects unknown models and oversized tool schemas before paid dispatch", async (t) => {
	const { broker, upstream } = await setup(t)
	const post = (body: string) => fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": `call-${Math.random().toString(36).slice(2).padEnd(20, "x")}` }, body,
	})
	assert.equal((await post(requestBody({ model: "other/model" }))).status, 400)
	const oversized = requestBody({ tools: [{ type: "function", function: { name: "x", parameters: { description: "x".repeat(8_100) } } }] })
	assert.equal((await post(oversized)).status, 413)
	assert.equal(upstream.requests.filter((entry) => entry.url.endsWith("/chat/completions")).length, 0)
})

test("authenticated denials persist as status and reason counts without storing request or credential data", async (t) => {
	const { broker, root } = await setup(t)
	const unauthorized = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, { headers: { authorization: "Bearer wrong-secret" } })
	assert.equal(unauthorized.status, 401)
	const endpoint = await fetch(`${broker.localBaseUrl}/v1/admin`, { headers: { authorization: `Bearer ${broker.capability}` } })
	assert.equal(endpoint.status, 404)
	const invalid = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "x-rsi-call-id": "call-invalid-123456", "content-type": "application/json" }, body: JSON.stringify({ model: "private-prompt-is-not-retained" }),
	})
	assert.equal(invalid.status, 400)
	const receipt = await broker.receipt()
	assert.deepEqual(receipt.denials, [
		{ statusCode: 400, reason: "invalid-request", count: 1 },
		{ statusCode: 404, reason: "unsupported-endpoint", count: 1 },
	])
	const saved = await fs.readFile(path.join(root, "ledger.json"))
	assert.equal(saved.includes(Buffer.from("private-prompt-is-not-retained")), false)
	assert.equal(JSON.stringify(receipt).includes("wrong-secret"), false)
})

test("OpenRouter broker enforces auth, endpoint allowlist, duplicate IDs, and call ceilings", async (t) => {
	const { broker, upstream } = await setup(t, { limits: limits("campaign-auth", { maxCalls: 1 }) })
	const send = (url: string, capability: string, callId = "call-auth-123456789") => fetch(`${broker.localBaseUrl}${url}`, {
		method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json", "x-rsi-call-id": callId }, body: requestBody(),
	})
	assert.equal((await send("/api/v1/chat/completions", "wrong-capability")).status, 401)
	assert.equal((await send("/api/v1/embeddings", broker.capability)).status, 404)
	const first = await send("/api/v1/chat/completions", broker.capability, "call-duplicate-1234")
	assert.equal(first.status, 200)
	assert.equal((await send("/api/v1/chat/completions", broker.capability, "call-duplicate-1234")).status, 429, "duplicate paid call IDs are rejected")
	assert.equal((await send("/api/v1/chat/completions", broker.capability, "call-new-1234567890")).status, 429, "a call ceiling is enforced before dispatch")
	assert.equal(upstream.requests.filter((entry) => entry.url.endsWith("/chat/completions")).length, 1)
})

test("OpenRouter broker can expose status-only access counters without request data", async (t) => {
	const responses: Array<{ method: string; statusCode: number; requestBytes?: number }> = []
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-inference-status-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const upstream = fakeFetch()
	const broker = await startOpenRouterBroker({
		jobId: "attempt-status-1234567890", leaseToken: "lease-test", limits: limits("campaign-status"), apiKey: "host-secret",
		bindHost: "127.0.0.1", ledger: new FileOpenRouterInferenceLedger(path.join(root, "ledger.json")), upstreamFetch: upstream.fetcher,
		onHttpResponse: (event) => responses.push(event),
	})
	t.after(() => broker.close())
	await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body: requestBody() })
	assert.equal(responses.length, 1)
	assert.equal(responses[0]?.method, "POST")
	assert.equal(responses[0]?.statusCode, 401)
	assert.ok(Number.isSafeInteger(responses[0]?.requestBytes) && (responses[0]?.requestBytes ?? 0) > 0, "status-only diagnostics can report request byte size")
	assert.equal(JSON.stringify(responses).includes("host-secret"), false)
	assert.equal(JSON.stringify(responses).includes("Bearer"), false)
})

test("OpenRouter broker marks timeouts unmeasured and does not automatically spend again", async (t) => {
	let dispatched = 0
	const upstream = (async (input: string | URL, init?: RequestInit) => {
		if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [{ provider_slug: "deepseek", pricing: { prompt: "0.000001", completion: "0.000001" } }] } }), { status: 200 })
		dispatched += 1
		return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true }))
	}) as typeof fetch
	// Leave enough time for the local HTTP request to reach the broker on loaded CI
	// workers; the delayed mock response still exercises the real abort deadline.
	const { broker } = await setup(t, { limits: limits("campaign-timeout", { maxDurationMs: 2_000 }), upstreamFetch: upstream })
	const send = (callId: string) => fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": callId }, body: requestBody(),
	})
	assert.equal((await send("call-timeout-12345678")).status, 502)
	assert.equal((await broker.receipt()).qualified, false)
	assert.equal((await send("call-timeout-retry-123")).status, 429, "an ambiguous dispatch blocks retry on the job")
	assert.equal(dispatched, 1)
})

test("OpenRouter broker parses final SSE usage when streaming is enabled", async (t) => {
	const sseFetch = (async (input: string | URL) => {
		if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [{ provider_slug: "deepseek", pricing: { prompt: "0.000001", completion: "0.000001" } }] } }), { status: 200 })
		return new Response(`data: ${JSON.stringify({ id: "stream-id", model: RSI_OPENROUTER_MODEL, choices: [{ delta: { content: "done" } }] })}\n\ndata: ${JSON.stringify({ id: "stream-id", model: RSI_OPENROUTER_MODEL, usage: { prompt_tokens: 8, completion_tokens: 2, cost: 0.00001 } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
	}) as typeof fetch
	const { broker } = await setup(t, { upstreamFetch: sseFetch })
	const response = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "call-stream-12345678" }, body: requestBody({ stream: true }),
	})
	assert.equal(response.status, 200)
	assert.equal((await broker.receipt()).totalTokens, 10)
})

test("file ledger fails closed on a dead-process lock and rounds spend reservations upward", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-ledger-recovery-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const file = path.join(root, "ledger.json")
	await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: 2_000_000_000, token: "dead", createdAt: Date.now() - 5_000 }), { mode: 0o600 })
	const ledger = new FileOpenRouterInferenceLedger(file)
	const normalized = validateOpenRouterBrokerLimits(limits("fractional", { maxCallSpendUsd: 0.000001, maxJobSpendUsd: 0.000001, maxCampaignSpendUsd: 0.000001 }))
	const first = { jobId: "attempt-1234567890123456", leaseToken: "lease", capability: "cap", model: RSI_OPENROUTER_MODEL as typeof RSI_OPENROUTER_MODEL, limits: normalized }
	await assert.rejects(ledger.register(first), /stale lock; refusing spend/)
	assert.ok(await fs.stat(`${file}.lock`), "stale lock remains for operator inspection; ledger never races to delete it")
	await fs.rm(`${file}.lock`)
	await ledger.register(first)
	await ledger.reserve({ jobId: "attempt-1234567890123456", leaseToken: "lease", capability: "cap", model: RSI_OPENROUTER_MODEL, limits: normalized }, { callId: "fractional-call-0001", requestSha256: "a".repeat(64), reservedUsd: 0.0000001, reservedTokens: 1, startedAt: new Date().toISOString() })
	await ledger.settle({ jobId: "attempt-1234567890123456", leaseToken: "lease", capability: "cap", model: RSI_OPENROUTER_MODEL, limits: normalized }, { callId: "fractional-call-0001", state: "complete", returnedModel: RSI_OPENROUTER_MODEL, promptTokens: 0, completionTokens: 0, costUsd: 0.0000001, responseSha256: "b".repeat(64), completedAt: new Date().toISOString() })
	const next = { jobId: "attempt-2234567890123456", leaseToken: "lease-2", capability: "cap-2", model: RSI_OPENROUTER_MODEL as typeof RSI_OPENROUTER_MODEL, limits: normalized }
	await ledger.register(next)
	await assert.rejects(ledger.reserve(next, { callId: "fractional-call-0002", requestSha256: "c".repeat(64), reservedUsd: 0.0000001, reservedTokens: 1, startedAt: new Date().toISOString() }), /budget exhausted/)
	assert.ok(await fs.stat(file))
})

test("mutation and benchmark budgets are disjoint partitions of the operator campaign ceiling", () => {
	const env = {
		HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD: "1.00",
		HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD: "0.40",
		HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD: "0.50",
	} as NodeJS.ProcessEnv
	assert.deepEqual(openRouterCampaignBudgetAllocation(env), { totalUsd: 1, mutationUsd: 0.4, benchmarkUsd: 0.5 })
	assert.throws(() => openRouterCampaignBudgetAllocation({ ...env, HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD: "0.6" }), /allocations exceed/)
	assert.throws(() => openRouterCampaignBudgetAllocation({
		...env,
		HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD: "1.0000009",
		HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD: "0.5000001",
		HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD: "0.5000001",
	}), /allocations exceed/, "ceil allocated spend and floor the total at micro-USD precision")
})

test("file ledger serializes concurrent reservations against one campaign ceiling", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-ledger-concurrency-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const ledger = new FileOpenRouterInferenceLedger(path.join(root, "ledger.json"))
	const bounded = validateOpenRouterBrokerLimits(limits("shared-cap", { maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.01, maxCampaignSpendUsd: 0.01 }))
	const grants = ["attempt-concurrency-0001", "attempt-concurrency-0002"].map((jobId) => ({ jobId, leaseToken: jobId, capability: `cap-${jobId}`, model: RSI_OPENROUTER_MODEL as typeof RSI_OPENROUTER_MODEL, limits: bounded }))
	await Promise.all(grants.map((grant) => ledger.register(grant)))
	const outcomes = await Promise.allSettled(grants.map((grant, index) => ledger.reserve(grant, {
		callId: `shared-call-${index}-000000`, requestSha256: String(index).repeat(64), reservedUsd: 0.01, reservedTokens: 8, startedAt: new Date().toISOString(),
	})))
	assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1, "the shared cap admits one reservation only")
	assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1)
})
