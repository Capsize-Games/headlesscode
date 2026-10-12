import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import test from "node:test"
import { OpenShellBenchmarkAgent } from "../benchmark/openshell-agent.js"
import { fetchOpenRouterEndpointPrice, fetchPinnedOpenRouterEndpointPrice, FileOpenRouterInferenceLedger, openRouterCampaignBudgetAllocation, openRouterProfileForModel, RSI_MUSE_OPENROUTER_BILLING_MODEL, RSI_MUSE_OPENROUTER_MODEL, RSI_OPENROUTER_ENDPOINT_PROVIDER, RSI_OPENROUTER_ENDPOINT_TAG, RSI_OPENROUTER_MODEL, startOpenRouterBroker, validateOpenRouterBrokerLimits } from "../inference-broker.js"
import type { OpenRouterBrokerLimits } from "../inference-broker.js"

function limits(campaignId: string, overrides: Partial<OpenRouterBrokerLimits> = {}): OpenRouterBrokerLimits {
	return {
		campaignId, maxCalls: 2, maxInputTokensPerCall: 8_000, maxOutputTokensPerCall: 64, maxTotalTokens: 10_000,
		maxDurationMs: 5_000, maxRequestBytes: 16_384, maxResponseBytes: 16_384,
		maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 1,
		maxCallSpendUsd: 0.02, maxJobSpendUsd: 0.04, maxCampaignSpendUsd: 0.08, ...overrides,
	}
}

async function scratch(prefix: string): Promise<string> {
	const root = path.join(process.cwd(), ".headlesscode", "scratch")
	await fs.mkdir(root, { recursive: true, mode: 0o700 })
	return fs.mkdtemp(path.join(root, `${prefix}-`))
}

function fakeFetch(options: { usage?: Record<string, unknown>; model?: string; returnedProvider?: string | null } = {}) {
	const requests: Array<{ url: string; init?: RequestInit }> = []
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input)
		requests.push({ url, init })
		if (url.includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [endpointMetadata()] } }), { status: 200 })
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>
		assert.equal(body.model, RSI_OPENROUTER_MODEL)
		assert.deepEqual(body.provider, { only: [RSI_OPENROUTER_ENDPOINT_PROVIDER], allow_fallbacks: false })
		assert.equal(body.max_tokens, 64)
		assert.equal(Object.hasOwn(body, "session_id"), false)
		assert.equal(Object.hasOwn(body, "prompt_cache_key"), false)
		assert.equal((init?.headers as Record<string, string>)["X-OpenRouter-Metadata"], "enabled")
		assert.equal((init?.headers as Record<string, string>).authorization, "Bearer host-secret")
		const response = routedResponse({ id: "or-test-1", model: options.model ?? RSI_OPENROUTER_MODEL, choices: [], usage: options.usage ?? { prompt_tokens: 20, completion_tokens: 10, cost: 0.0002 } }, options.returnedProvider)
		return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } })
	}) as typeof fetch
	return { fetcher, requests }
}

function endpointMetadata(overrides: Record<string, unknown> = {}) {
	return { provider_name: "DeepInfra", tag: RSI_OPENROUTER_ENDPOINT_TAG, quantization: "fp8", status: 0, pricing: { prompt: "0.00000006", completion: "0.00000018" }, supported_parameters: ["tools", "tool_choice", "temperature", "seed", "max_tokens"], supports_tool_choice: { auto: true, required: true, function: true }, ...overrides }
}

function museEndpointMetadata(overrides: Record<string, unknown> = {}) {
	return { provider_name: "Meta", tag: "meta", quantization: "unknown", status: 0, pricing: { prompt: "0.0000001", completion: "0.0000002" }, supported_parameters: ["tools", "tool_choice", "temperature", "max_tokens"], supports_tool_choice: { auto: true, required: true, function: true }, ...overrides }
}

function routedResponse(response: Record<string, unknown>, selectedProvider: string | null = RSI_OPENROUTER_ENDPOINT_PROVIDER): Record<string, unknown> {
	return selectedProvider === null ? response : { ...response, openrouter_metadata: { endpoints: { available: [{ provider: selectedProvider, selected: true }] } } }
}

const requestBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
	model: RSI_OPENROUTER_MODEL,
	messages: [{ role: "user", content: "Fix the small function and run its tests." }],
	max_completion_tokens: 256,
	...extra,
})

test("pinned endpoint pricing is a timestamped metadata GET with no inference submission", async () => {
	const requests: Array<{ url: string; method?: string }> = []
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		requests.push({ url: String(input), method: init?.method })
		return new Response(JSON.stringify({ data: { endpoints: [endpointMetadata({ pricing: { prompt: "0.000002", completion: "0.00003" } })] } }), { status: 200 })
	}) as typeof fetch
	const price = await fetchPinnedOpenRouterEndpointPrice("metadata-test-key", fetcher, () => 1_800_000_000_000)
	assert.equal(price.model, RSI_OPENROUTER_MODEL)
	assert.equal(price.provider, "deepinfra")
	assert.equal(price.endpointTag, "deepinfra/fp8")
	assert.equal(price.quantization, "fp8")
	assert.equal(price.inputPricePerMillionUsd, 2)
	assert.equal(price.outputPricePerMillionUsd, 30)
	assert.equal(price.observedAt, "2027-01-15T08:00:00.000Z")
	assert.equal(requests.length, 1)
	assert.equal(requests[0]?.method, "GET")
	assert.match(requests[0]?.url ?? "", /\/models\/deepseek\/deepseek-v4-flash-0731\/endpoints$/)
})

test("pinned endpoint preflight rejects unavailable, retagged, or parameter-incomplete routes", async () => {
	for (const endpoint of [endpointMetadata({ status: -2 }), endpointMetadata({ tag: "deepinfra/other" }), endpointMetadata({ supported_parameters: ["tools"] }), endpointMetadata({ supports_tool_choice: { auto: false, required: false } })]) {
		const fetcher = (async () => new Response(JSON.stringify({ data: { endpoints: [endpoint] } }), { status: 200 })) as typeof fetch
		await assert.rejects(fetchPinnedOpenRouterEndpointPrice("", fetcher), /pinned DeepInfra endpoint with required agent parameters/)
	}
})

test("Muse endpoint admission pins current Meta metadata and rejects changed endpoint capabilities", async () => {
	const requests: Array<{ url: string; method?: string }> = []
	const fetcher = (async (input: string | URL, init?: RequestInit) => {
		requests.push({ url: String(input), method: init?.method })
		return new Response(JSON.stringify({ data: { endpoints: [museEndpointMetadata()] } }), { status: 200 })
	}) as typeof fetch
	const profile = openRouterProfileForModel(RSI_MUSE_OPENROUTER_MODEL, "muse-spark-contributor")
	const price = await fetchOpenRouterEndpointPrice(profile, "metadata-test-key", fetcher, () => 1_800_000_000_000)
	assert.equal(price.model, RSI_MUSE_OPENROUTER_MODEL)
	assert.equal(price.provider, "meta")
	assert.equal(price.endpointTag, "meta")
	assert.equal(price.quantization, "unknown")
	assert.ok(Math.abs(price.inputPricePerMillionUsd - 0.1) < 1e-12)
	assert.ok(Math.abs(price.outputPricePerMillionUsd - 0.2) < 1e-12)
	assert.equal(requests.length, 1)
	assert.equal(requests[0]?.method, "GET")
	assert.match(requests[0]?.url ?? "", /\/models\/meta\/muse-spark-1\.3-contributor\/endpoints$/)
	for (const endpoint of [museEndpointMetadata({ provider_name: "Other" }), museEndpointMetadata({ tag: "other" }), museEndpointMetadata({ quantization: "fp8" }), museEndpointMetadata({ status: -2 }), museEndpointMetadata({ supported_parameters: ["tools"] }), museEndpointMetadata({ supports_tool_choice: { auto: false, required: false } })]) {
		const bad = (async () => new Response(JSON.stringify({ data: { endpoints: [endpoint] } }), { status: 200 })) as typeof fetch
		await assert.rejects(fetchOpenRouterEndpointPrice(profile, "", bad), /required agent parameters/)
	}
})

async function setup(t: { after(fn: () => void | Promise<void>): void }, overrides: { usage?: Record<string, unknown>; model?: string; profileId?: "muse-spark-contributor"; limits?: OpenRouterBrokerLimits; upstreamFetch?: typeof fetch } = {}) {
	const root = await scratch("rsi-inference-broker")
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const ledger = new FileOpenRouterInferenceLedger(path.join(root, "ledger.json"))
	const upstream = overrides.upstreamFetch ? { fetcher: overrides.upstreamFetch, requests: [] as Array<{ url: string; init?: RequestInit }> } : fakeFetch(overrides)
	const broker = await startOpenRouterBroker({
		jobId: "attempt-1234567890123456", leaseToken: "lease-test", limits: overrides.limits ?? limits("campaign-test"), apiKey: "host-secret",
		bindHost: "127.0.0.1", ledger, upstreamFetch: upstream.fetcher, ...(overrides.model ? { model: overrides.model } : {}), ...(overrides.profileId ? { profileId: overrides.profileId } : {}),
	})
	t.after(() => broker.close())
	return { root, ledger, broker, upstream }
}

test("broker prompt byte budget is derived from the tighter admitted input or request ceiling", async (t) => {
	const tokenBounded = await setup(t, { limits: limits("token-budget", { maxInputTokensPerCall: 4_096, maxRequestBytes: 16_384 }) })
	assert.equal(tokenBounded.broker.maxPromptBytes, 4_096 - 128)
	const requestBounded = await setup(t, { limits: limits("request-budget", { maxInputTokensPerCall: 8_000, maxRequestBytes: 2_048 }) })
	assert.equal(requestBounded.broker.maxPromptBytes, 2_048 - 128)
})

test("broker rejects limits that cannot provide a positive guest prompt budget before metadata admission", async (t) => {
	const root = await scratch("rsi-inference-small-prompt-budget")
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	let upstreamCalls = 0
	const upstreamFetch = (async () => {
		upstreamCalls += 1
		return new Response(JSON.stringify({ data: { endpoints: [endpointMetadata()] } }), { status: 200 })
	}) as typeof fetch
	for (const [campaignId, overrides] of [
		["small-input-budget", { maxInputTokensPerCall: 128 }],
		["small-request-budget", { maxRequestBytes: 128 }],
	] as const) {
		const ledger = new FileOpenRouterInferenceLedger(path.join(root, `${campaignId}.json`))
		await assert.rejects(startOpenRouterBroker({
			jobId: `attempt-${campaignId}`, leaseToken: "lease-small", limits: limits(campaignId, overrides),
			apiKey: "host-secret", bindHost: "127.0.0.1", ledger, upstreamFetch,
		}), /too small to provide a positive prompt byte budget/)
	}
	assert.equal(upstreamCalls, 0, "an impossible guest prompt budget is rejected before endpoint metadata traffic")
})

test("Muse broker overwrites both generic cache hints with a job-scoped key and receipts report cached usage", async (t) => {
	const root = await scratch("rsi-inference-muse")
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const requests: Array<{ url: string; init?: RequestInit }> = []
	const upstreamFetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input)
		requests.push({ url, init })
		if (url.includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [museEndpointMetadata()] } }), { status: 200 })
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>
		assert.equal(body.model, RSI_MUSE_OPENROUTER_MODEL)
		assert.deepEqual(body.provider, { only: ["meta"], allow_fallbacks: false })
		assert.equal(typeof body.session_id, "string")
		assert.match(String(body.session_id), /^hc-rsi-[A-Za-z0-9_-]{32}$/)
		assert.equal(body.prompt_cache_key, body.session_id, "OpenRouter receives one stable broker-owned cache routing key")
		assert.notEqual(body.session_id, "guest-session-hint")
		assert.notEqual(body.prompt_cache_key, "guest-cache-hint")
		return new Response(JSON.stringify(routedResponse({ id: "muse-request-1", model: RSI_MUSE_OPENROUTER_MODEL, choices: [], usage: { prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 12 }, completion_tokens: 10, cost: 0.0002 } }, "meta")), { status: 200, headers: { "content-type": "application/json" } })
	}) as typeof fetch
	const ledger = new FileOpenRouterInferenceLedger(path.join(root, "ledger.json"))
	const broker = await startOpenRouterBroker({
		jobId: "attempt-muse-123456789012", leaseToken: "lease-muse", limits: limits("campaign-muse"), apiKey: "host-secret",
		bindHost: "127.0.0.1", ledger, upstreamFetch, model: RSI_MUSE_OPENROUTER_MODEL, profileId: "muse-spark-contributor",
	})
	t.after(() => broker.close())
	const response = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "muse-call-123456789012" },
		body: requestBody({ model: RSI_MUSE_OPENROUTER_MODEL, max_tokens: 64, session_id: "guest-session-hint", prompt_cache_key: "guest-cache-hint" }),
	})
	assert.equal(response.status, 200)
	assert.equal(requests.filter((entry) => entry.url.endsWith("/chat/completions")).length, 1)
	const receipt = await broker.receipt()
	assert.equal(receipt.qualified, true)
	assert.equal(receipt.profileId, "muse-spark-contributor")
	assert.equal(receipt.endpointProvider, "meta")
	assert.equal(receipt.endpointPrice?.provider, "meta")
	assert.equal(receipt.callReceipts[0]?.cachedPromptTokens, 12)
	assert.equal(receipt.callReceipts[0]?.costUsd, 0.0002)
	const originalPrice = receipt.endpointPrice
	assert.ok(originalPrice)
	assert.equal(JSON.stringify(receipt), JSON.stringify(await ledger.lookupReceipt("attempt-muse-123456789012")), "benchmark receipt verification requires byte-order-identical durable ledger output")
	const benchmarkAgent = new OpenShellBenchmarkAgent(process.cwd(), undefined, "synthetic-image", undefined, undefined, "openshell-openrouter")
	assert.equal(await benchmarkAgent.verifyReceipt("attempt-muse-123456789012", receipt, path.join(root, "ledger.json")), true, "the actual OpenShell benchmark verifier accepts its Muse ledger receipt")
	await broker.close()
	const restartedFetch = (async (input: string | URL) => {
		if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [museEndpointMetadata({ metadata_revision: "new-observation" })] } }), { status: 200 })
		throw new Error("completed synthetic Muse call must not be dispatched again")
	}) as typeof fetch
	const restarted = await startOpenRouterBroker({
		jobId: "attempt-muse-123456789012", leaseToken: "lease-muse", limits: limits("campaign-muse"), apiKey: "host-secret",
		bindHost: "127.0.0.1", ledger, upstreamFetch: restartedFetch, model: RSI_MUSE_OPENROUTER_MODEL, profileId: "muse-spark-contributor",
	})
	t.after(() => restarted.close())
	const freshObservation = await fetchOpenRouterEndpointPrice(openRouterProfileForModel(RSI_MUSE_OPENROUTER_MODEL, "muse-spark-contributor"), "", restartedFetch, () => Date.parse("2030-01-01T00:00:00.000Z"))
	assert.notEqual(freshObservation.responseSha256, originalPrice.responseSha256)
	assert.notEqual(freshObservation.observedAt, originalPrice.observedAt)
	const recoveredReceipt = await restarted.receipt()
	assert.equal(JSON.stringify(recoveredReceipt), JSON.stringify(await ledger.lookupReceipt("attempt-muse-123456789012")), "restarted broker receipt remains identical to its persisted lookup")
	assert.equal(await benchmarkAgent.verifyReceipt("attempt-muse-123456789012", recoveredReceipt, path.join(root, "ledger.json")), true, "receipt verification still passes after a broker restart")
	assert.deepEqual(recoveredReceipt.endpointPrice, originalPrice, "restart preserves the original endpoint evidence while ignoring changing observation timestamp/hash")
	await restarted.close()
	const changedPriceFetch = (async () => new Response(JSON.stringify({ data: { endpoints: [museEndpointMetadata({ pricing: { prompt: "0.0000002", completion: "0.0000002" } })] } }), { status: 200 })) as typeof fetch
	await assert.rejects(startOpenRouterBroker({
		jobId: "attempt-muse-123456789012", leaseToken: "lease-muse", limits: limits("campaign-muse"), apiKey: "host-secret",
		bindHost: "127.0.0.1", ledger, upstreamFetch: changedPriceFetch, model: RSI_MUSE_OPENROUTER_MODEL, profileId: "muse-spark-contributor",
	}), /job identity conflicts/)
})

test("Muse broker fails closed on price ceilings and mismatched returned model or provider", async (t) => {
	const lowCeiling = limits("campaign-muse-price", { maxInputPricePerMillionUsd: 0.05, maxOutputPricePerMillionUsd: 0.05 })
	const metadataFetch = (async () => new Response(JSON.stringify({ data: { endpoints: [museEndpointMetadata()] } }), { status: 200 })) as typeof fetch
	const root = await scratch("rsi-inference-muse-price")
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const priceLedger = new FileOpenRouterInferenceLedger(path.join(root, "ledger.json"))
	await assert.rejects(startOpenRouterBroker({ jobId: "attempt-muse-price-123", leaseToken: "lease", model: RSI_MUSE_OPENROUTER_MODEL, profileId: "muse-spark-contributor", limits: lowCeiling, apiKey: "host-secret", bindHost: "127.0.0.1", ledger: priceLedger, upstreamFetch: metadataFetch }), /price ceiling is below/)

	for (const returned of [{ model: "meta/other", provider: "meta" }, { model: RSI_MUSE_OPENROUTER_MODEL, provider: "openai" }]) {
		const upstreamFetch = (async (input: string | URL) => {
			if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [museEndpointMetadata()] } }), { status: 200 })
			return new Response(JSON.stringify(routedResponse({ id: "muse-mismatch", model: returned.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0001 } }, returned.provider)), { status: 200, headers: { "content-type": "application/json" } })
		}) as typeof fetch
		const { broker } = await setup(t, { model: RSI_MUSE_OPENROUTER_MODEL, profileId: "muse-spark-contributor", upstreamFetch })
		const response = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
			method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": `muse-mismatch-${returned.provider}-123` },
			body: requestBody({ model: RSI_MUSE_OPENROUTER_MODEL, max_tokens: 64 }),
		})
		assert.equal(response.status, 502)
		assert.equal((await broker.receipt()).qualified, false)
		await broker.close()
	}
	const aliasFetch = (async (input: string | URL) => {
		if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [museEndpointMetadata()] } }), { status: 200 })
		return new Response(JSON.stringify(routedResponse({ id: "muse-billing-alias", model: RSI_MUSE_OPENROUTER_BILLING_MODEL, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.0001 } }, "meta")), { status: 200, headers: { "content-type": "application/json" } })
	}) as typeof fetch
	const { broker } = await setup(t, { model: RSI_MUSE_OPENROUTER_MODEL, profileId: "muse-spark-contributor", upstreamFetch: aliasFetch })
	const admittedAlias = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "muse-billing-alias-123" },
		body: requestBody({ model: RSI_MUSE_OPENROUTER_MODEL, max_tokens: 64 }),
	})
	assert.equal(admittedAlias.status, 200)
	assert.deepEqual((await broker.receipt()).returnedModels, [RSI_MUSE_OPENROUTER_BILLING_MODEL])
	await broker.close()
})

test("OpenRouter broker pins model/provider, accounts usage, and survives broker restart", async (t) => {
	const { root, ledger, broker, upstream } = await setup(t)
	const call = () => fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "call-1234567890123456" }, body: requestBody({ session_id: "guest-session-hint", prompt_cache_key: "guest-cache-hint" }),
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

test("OpenRouter broker leaves missing or mismatched returned endpoint identity unqualified", async (t) => {
	for (const returnedProvider of ["openai", null] as const) {
		const { broker } = await setup(t, { upstreamFetch: fakeFetch({ returnedProvider }).fetcher })
		const response = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
			method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": `call-${returnedProvider ?? "missing"}-provider-123` }, body: requestBody(),
		})
		assert.equal(response.status, 502)
		const receipt = await broker.receipt()
		assert.equal(receipt.qualified, false)
		assert.equal(receipt.callReceipts[0]?.authoritative, false)
		assert.deepEqual(receipt.returnedProviders, returnedProvider ? [returnedProvider] : [])
		await broker.close()
	}
})

test("file ledger preserves the job deadline across broker restart and rejects a late response", async (t) => {
	const root = await scratch("rsi-inference-deadline")
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
		if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [endpointMetadata({ pricing: { prompt: "0.000001", completion: "0.000001" } })] } }), { status: 200 })
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
	releaseUpstream(new Response(JSON.stringify(routedResponse({ id: "late", model: RSI_OPENROUTER_MODEL, choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.0002 } })), { status: 200, headers: { "content-type": "application/json" } }))
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
	const root = await scratch("rsi-inference-status")
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
		if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [endpointMetadata({ pricing: { prompt: "0.000001", completion: "0.000001" } })] } }), { status: 200 })
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
		if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [endpointMetadata({ pricing: { prompt: "0.000001", completion: "0.000001" } })] } }), { status: 200 })
		return new Response(`data: ${JSON.stringify({ id: "stream-id", model: RSI_OPENROUTER_MODEL, choices: [{ delta: { content: "done" } }] })}\n\ndata: ${JSON.stringify(routedResponse({ id: "stream-id", model: RSI_OPENROUTER_MODEL, usage: { prompt_tokens: 8, completion_tokens: 2, cost: 0.00001 } }))}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
	}) as typeof fetch
	const { broker } = await setup(t, { upstreamFetch: sseFetch })
	const response = await fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "call-stream-12345678" }, body: requestBody({ stream: true }),
	})
	assert.equal(response.status, 200)
	assert.equal((await broker.receipt()).totalTokens, 10)
})

test("file ledger fails closed on a dead-process lock and rounds spend reservations upward", async (t) => {
	const root = await scratch("rsi-ledger-recovery")
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
	const root = await scratch("rsi-ledger-concurrency")
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

for (const outcome of ["measured", "unmeasured", "out-of-bounds", "upstream-error"] as const) {
	test(`closing drains a disconnected request before returning its ${outcome} receipt`, async (t) => {
		let entered: () => void = () => undefined
		let release: () => void = () => undefined
		const dispatched = new Promise<void>((resolve) => { entered = resolve })
		const barrier = new Promise<void>((resolve) => { release = resolve })
		t.after(() => release())
		const upstreamFetch = (async (input: string | URL) => {
			if (String(input).includes("/models/")) return new Response(JSON.stringify({ data: { endpoints: [endpointMetadata()] } }))
			entered()
			await barrier
			if (outcome === "upstream-error") throw new Error("synthetic upstream failure")
			const usage = outcome === "unmeasured" ? {} : { prompt_tokens: 20, completion_tokens: outcome === "out-of-bounds" ? 65 : 10, cost: 0.0002 }
			return new Response(JSON.stringify(routedResponse({ id: "or-drained-request", model: RSI_OPENROUTER_MODEL, choices: [], usage })), { headers: { "content-type": "application/json" } })
		}) as typeof fetch
		const { broker } = await setup(t, { upstreamFetch })
		const controller = new AbortController()
		const request = fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, {
			method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "x-rsi-call-id": "disconnected-call-12345678" },
			body: requestBody(), signal: controller.signal,
		}).catch(() => undefined)
		await dispatched
		controller.abort()
		await request
		await new Promise((resolve) => setTimeout(resolve, 20))
		let firstClosed = false
		let secondClosed = false
		const first = broker.close().then(() => { firstClosed = true })
		const second = broker.close().then(() => { secondClosed = true })
		await new Promise((resolve) => setTimeout(resolve, 30))
		const before = { firstClosed, secondClosed }
		release()
		await Promise.all([first, second])
		const receipt = await broker.receipt()
		assert.deepEqual(before, { firstClosed: false, secondClosed: false }, "both close callers must await the upstream settlement even after the guest socket disconnects")
		assert.equal(receipt.calls, 1)
		const call = receipt.callReceipts[0]
		assert.ok(call)
		assert.equal(call.state, outcome === "unmeasured" || outcome === "upstream-error" ? "unmeasured" : "complete")
		assert.equal(receipt.qualified, outcome === "measured")
		assert.equal(receipt.costUsd, outcome === "measured" ? 0.0002 : null)
		assert.equal(call.authoritative, outcome === "measured")
		await assert.rejects(fetch(`${broker.localBaseUrl}/api/v1/chat/completions`, { method: "POST", body: requestBody() }), /fetch failed|ECONNREFUSED/)
	})
}

test("closing destroys an incomplete guest request without admitting inference", async (t) => {
	const { request } = await import("node:http")
	const { broker, upstream } = await setup(t)
	const guest = request(`${broker.localBaseUrl}/api/v1/chat/completions`, {
		method: "POST", headers: { authorization: `Bearer ${broker.capability}`, "content-type": "application/json", "content-length": "100", "x-rsi-call-id": "partial-request-1234567890" },
	})
	guest.on("error", () => undefined)
	t.after(() => guest.destroy())
	guest.write('{"model":')
	await new Promise((resolve) => setTimeout(resolve, 30))
	await broker.close()
	const receipt = await broker.receipt()
	assert.equal(receipt.calls, 0)
	assert.equal(receipt.qualified, false)
	assert.equal(upstream.requests.filter((entry) => entry.url.endsWith("/chat/completions")).length, 0)
})
