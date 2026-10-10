import assert from "node:assert/strict"
import {
	buildMuseSyntheticWorkload,
	MUSE_AUDIT_MAX_CALLS,
	MUSE_AUDIT_MAX_OUTPUT_TOKENS,
	MUSE_AUDIT_SPEND_CAP_USD,
	qualificationSpendUpperBoundUsd,
	runMuseCacheQualification,
} from "../../../scripts/qualify-muse-cache.js"

async function testSyntheticWorkloadRepeatsOneStablePrefixAndVariesOnlyTail(): Promise<void> {
	const workload = buildMuseSyntheticWorkload()
	assert.equal(workload.calls.length, MUSE_AUDIT_MAX_CALLS)
	assert.ok(workload.prefix.length >= 8_000, "prefix should be large enough to test cache reuse")
	assert.ok(workload.prefix.length <= 18_000, "prefix remains under its fixed content ceiling")
	assert.equal(new Set(workload.calls.map((call) => call.userTail)).size, MUSE_AUDIT_MAX_CALLS)
	assert.ok(workload.calls.every((call) => call.promptCharacterUpperBound === workload.prefix.length + call.userTail.length))
	assert.doesNotMatch(workload.prefix, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
}

async function testSyntheticSpendCeilingUsesFullInputPriceAndOutputCap(): Promise<void> {
	const workload = buildMuseSyntheticWorkload()
	const bound = qualificationSpendUpperBoundUsd(workload.calls, MUSE_AUDIT_MAX_OUTPUT_TOKENS, { input: 0.1, output: 0.2 })
	assert.ok(bound > 0)
	assert.ok(bound < MUSE_AUDIT_SPEND_CAP_USD, `estimated ceiling $${bound} must fit under cap`)
	const overCap = qualificationSpendUpperBoundUsd(workload.calls, MUSE_AUDIT_MAX_OUTPUT_TOKENS, { input: 10, output: 20 })
	assert.ok(overCap > MUSE_AUDIT_SPEND_CAP_USD, "preflight catches material rate changes before inference")
}

async function testLiveAuditRequiresExplicitFlagAndDoesNotFetch(): Promise<void> {
	const original = globalThis.fetch
	let called = false
	globalThis.fetch = (async () => { called = true; throw new Error("unexpected network") }) as typeof fetch
	const output: string[] = []
	try {
		await runMuseCacheQualification([], { HEADLESSCODE_OPENROUTER_API_KEY: "synthetic-key" }, (text) => output.push(text))
		assert.equal(called, false)
		assert.match(output.join(""), /--confirm-live/)
	} finally { globalThis.fetch = original }
}

async function testTranscriptCaptureBlocksLiveAuditBeforeFetch(): Promise<void> {
	const original = globalThis.fetch
	let called = false
	globalThis.fetch = (async () => { called = true; throw new Error("unexpected network") }) as typeof fetch
	try {
		await assert.rejects(
			runMuseCacheQualification(["--confirm-live"], {
				HEADLESSCODE_OPENROUTER_API_KEY: "synthetic-key",
				HEADLESSCODE_CAPTURE_TRANSCRIPT_DIR: "somewhere",
			}, () => undefined),
			/disable transcript capture/,
		)
		assert.equal(called, false)
	} finally { globalThis.fetch = original }
}

async function testMockedLiveAuditPinsMuseAndRequiresBilledWarmCacheEvidence(): Promise<void> {
	const originalFetch = globalThis.fetch
	const oldExitCode = process.exitCode
	const requests: Array<Record<string, unknown>> = []
	let generationLookups = 0
	const output: string[] = []
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const address = String(url)
		if (address.includes("/api/v1/models/meta/muse-spark-1.3-contributor/endpoints")) {
			return new Response(JSON.stringify({ data: { endpoints: [{ provider_name: "Meta", status: 0, pricing: { prompt: "0.0000001", completion: "0.0000002", input_cache_read: "0.000000002" } }] } }), { status: 200 })
		}
		if (address.endsWith("/api/v1/chat/completions")) {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>
			requests.push(body)
			const ordinal = requests.length
			return testSseResponse([
				{ id: `gen-call-${ordinal}`, model: "meta/muse-spark-1.3-contributor", provider_name: "Meta", choices: [{ delta: { content: "label" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
				{ usage: { prompt_tokens: 1800, completion_tokens: 1, total_tokens: 1801, prompt_tokens_details: { cached_tokens: ordinal === 1 ? 0 : 900 }, completion_tokens_details: { reasoning_tokens: 0 }, cost: 0.0001 } },
				"[DONE]",
			])
		}
		if (address.includes("/api/v1/generation?id=")) {
			generationLookups++
			const id = new URL(address).searchParams.get("id")
			const ordinal = Number(id?.match(/-(\d+)$/)?.[1])
			return new Response(JSON.stringify({ data: {
				id, model: "meta/muse-spark-1.3-contributor", provider_name: "Meta", total_cost: 0.0001,
				tokens_prompt: 1800, tokens_completion: 1, native_tokens_reasoning: 0,
				native_tokens_cached: ordinal === 1 ? 0 : 900, latency: 300,
			} }), { status: 200 })
		}
		throw new Error("unexpected mock URL")
	}) as typeof fetch
	try {
		const summary = await runMuseCacheQualification(["--confirm-live"], { HEADLESSCODE_OPENROUTER_API_KEY: "synthetic-key" }, (text) => output.push(text))
		assert.equal(summary?.result, "qualified")
		assert.equal(summary?.totalBilledCostUsd, 0.0004, "total is aggregated from authoritative generation records")
		assert.equal(requests.length, MUSE_AUDIT_MAX_CALLS)
		assert.equal(generationLookups, MUSE_AUDIT_MAX_CALLS)
		assert.ok(requests.every((body) => body.stream === true && body.max_tokens === MUSE_AUDIT_MAX_OUTPUT_TOKENS))
		assert.ok(requests.every((body) => JSON.stringify(body.provider) === JSON.stringify({ only: ["meta"], allow_fallbacks: false })))
		assert.ok(requests.every((body) => body.session_id === requests[0]?.session_id && body.prompt_cache_key === requests[0]?.prompt_cache_key))
		const firstMessages = requests[0]?.messages
		assert.ok(Array.isArray(firstMessages))
		assert.ok(requests.every((body) => Array.isArray(body.messages) && JSON.stringify(body.messages[0]) === JSON.stringify(firstMessages[0])))
		assert.doesNotMatch(output.join(""), /Record 001|synthetic-key|Synthetic run nonce/)
		assert.equal(process.exitCode, oldExitCode)
	} finally {
		globalThis.fetch = originalFetch
		process.exitCode = oldExitCode
	}
}

async function testMockedAuditFailsWithoutLaterCacheHit(): Promise<void> {
	const originalFetch = globalThis.fetch
	const oldExitCode = process.exitCode
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const address = String(url)
		if (address.includes("/api/v1/models/meta/muse-spark-1.3-contributor/endpoints")) {
			return new Response(JSON.stringify({ data: { endpoints: [{ provider_name: "Meta", status: 0, pricing: { prompt: "0.0000001", completion: "0.0000002" } }] } }), { status: 200 })
		}
		if (address.endsWith("/api/v1/chat/completions")) {
			return testSseResponse([
				{ id: "gen-no-warm-1", model: "meta/muse-spark-1.3-contributor", provider_name: "Meta", choices: [{ delta: { content: "ok" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
				{ usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } },
				"[DONE]",
			])
		}
		if (address.includes("/api/v1/generation?id=")) {
			const id = new URL(address).searchParams.get("id")
			return new Response(JSON.stringify({ data: { id, model: "meta/muse-spark-1.3-contributor", provider_name: "Meta", total_cost: 0.0001 } }), { status: 200 })
		}
		throw new Error("unexpected mock URL")
	}) as typeof fetch
	try {
		const output: string[] = []
		const summary = await runMuseCacheQualification(["--confirm-live"], { HEADLESSCODE_OPENROUTER_API_KEY: "synthetic-key" }, (text) => output.push(text))
		assert.equal(summary?.result, "not-qualified")
		assert.match(summary?.failureReasons?.join(" ") ?? "", /no later request reported cached prompt tokens/)
		assert.match(output.join(""), /not-qualified/)
		assert.equal(process.exitCode, 1)
	} finally {
		globalThis.fetch = originalFetch
		process.exitCode = oldExitCode
	}
}

function testSseResponse(payloads: Array<Record<string, unknown> | string>): Response {
	const body = payloads.map((item) => `data: ${typeof item === "string" ? item : JSON.stringify(item)}\n\n`).join("")
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

const tests: Array<[string, () => Promise<void>]> = [
	["Muse qualification repeats fixed synthetic prefix and varies only short tails", testSyntheticWorkloadRepeatsOneStablePrefixAndVariesOnlyTail],
	["Muse qualification enforces conservative full-input spend estimate", testSyntheticSpendCeilingUsesFullInputPriceAndOutputCap],
	["Muse qualification is inert without explicit live flag", testLiveAuditRequiresExplicitFlagAndDoesNotFetch],
	["Muse qualification rejects transcript capture before network access", testTranscriptCaptureBlocksLiveAuditBeforeFetch],
	["mocked Muse qualification uses pinned streamed client and requires billing/cache evidence", testMockedLiveAuditPinsMuseAndRequiresBilledWarmCacheEvidence],
	["mocked Muse qualification fails when no later request reports cached tokens", testMockedAuditFailsWithoutLaterCacheHit],
]

async function main(): Promise<void> {
	for (const [name, run] of tests) {
		await run()
		console.log(`  ok   ${name}`)
	}
	console.log(`\nAll ${tests.length} Muse cache qualification tests passed`)
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack : error)
	process.exit(1)
})
