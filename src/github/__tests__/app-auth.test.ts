/**
 * Unit tests for src/github/app-auth.ts — the GitHub App installation-token
 * client. Plain assert-based (no framework, no network — the auth strategy's
 * underlying HTTP is pointed at a fake fetch via `request.defaults`). Run via
 * `npm test`.
 *
 * What's proven here:
 *  - a second getInstallationToken() for the same installation within the
 *    cache window does NOT re-run the token-exchange (proven with a call
 *    counter on the fake fetch, not by reading the code);
 *  - once the cached token is past its expiry, the exchange runs again
 *    (refresh), driven by an INJECTABLE CLOCK — no real sleeping;
 *  - the cache is keyed by installation id (different ids don't collide);
 *  - a failed exchange surfaces as a typed AppAuthError.
 */

import assert from "node:assert/strict"
import * as crypto from "node:crypto"

import { createAppAuthClient, type TokenCache } from "../app-auth.js"

/** A real RSA key (PKCS#1 PEM, like GitHub provides) so JWT signing works. */
function fakePrivateKey(): string {
	const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
		type: "pkcs1",
		format: "pem",
	})
	return typeof key === "string" ? key : key.toString("utf-8")
}

/** In-memory cache with a call counter (mirrors the real TokenCache shape). */
function makeCache(): TokenCache & { count: number } {
	const store = new Map<string, string>()
	return {
		count: 0,
		get: async (key: string) => store.get(key),
		set: async (key: string, value: string) => {
			store.set(key, value)
		},
	}
}

interface TokenResponse {
	token: string
	expires_at: string
	permissions: Record<string, string>
	repository_selection: string
}

/**
 * Fake fetch that serves the token-exchange endpoint. Counts every call so
 * tests can prove caching vs. refresh behavior. `now` is the fake clock value
 * used to stamp expires_at.
 */
function fakeExchangeFetch(counter: { count: number }, now: () => number, tokenFor: (installationId: number) => string): typeof fetch {
	const impl = (input: unknown, init?: unknown): Promise<Response> => {
		counter.count++
		const url = typeof input === "string" ? input : String((input as { url?: unknown }).url ?? "")
		const method = ((init ?? {}) as { method?: string }).method ?? "GET"
		const match = url.match(/\/app\/installations\/(\d+)\/access_tokens$/)
		if (method === "POST" && match) {
			const installationId = Number(match[1])
			const body: TokenResponse = {
				token: tokenFor(installationId),
				expires_at: new Date(now() + 3600_000).toISOString(),
				permissions: { contents: "write", metadata: "read", pull_requests: "write" },
				repository_selection: "selected",
			}
			return Promise.resolve(new Response(JSON.stringify(body), { status: 201, headers: { "Content-Type": "application/json" } }))
		}
		return Promise.resolve(new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } }))
	}
	return impl as unknown as typeof fetch
}

/** A fake clock we can advance (no real sleeping in tests). */
function makeClock(initial = 1_700_000_000_000) {
	let now = initial
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms
		},
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testTokenCachedWithinWindowAvoidsExchange(): Promise<void> {
	const cache = makeCache()
	const clock = makeClock()
	const calls = { count: 0 }
	const client = createAppAuthClient({
		appId: 12345,
		privateKey: fakePrivateKey(),
		cache,
		clock,
		fetchImpl: fakeExchangeFetch(calls, clock.now, () => "ghs_token-a"),
	})

	const first = await client.getInstallationToken(7)
	const second = await client.getInstallationToken(7)
	assert.equal(first, "ghs_token-a")
	assert.equal(second, "ghs_token-a")
	assert.equal(calls.count, 1, "second call within the cache window must NOT re-run the token exchange")
}

async function testTokenRefreshedAfterExpiry(): Promise<void> {
	const cache = makeCache()
	const clock = makeClock()
	let tokenSerial = 0
	const calls = { count: 0 }
	const client = createAppAuthClient({
		appId: 12345,
		privateKey: fakePrivateKey(),
		cache,
		clock,
		fetchImpl: fakeExchangeFetch(calls, clock.now, () => `ghs_token-${++tokenSerial}`),
	})

	const t1 = await client.getInstallationToken(7)
	assert.equal(t1, "ghs_token-1")
	assert.equal(calls.count, 1)

	// Advance past the 1h token lifetime → the next call must re-exchange.
	clock.advance(61 * 60 * 1000)
	const t2 = await client.getInstallationToken(7)
	assert.equal(t2, "ghs_token-2", "past expiry the client must exchange a FRESH token")
	assert.equal(calls.count, 2, "expired cache entry must trigger exactly one new exchange")
}

async function testCacheKeyedByInstallationId(): Promise<void> {
	const cache = makeCache()
	const clock = makeClock()
	const calls = { count: 0 }
	const client = createAppAuthClient({
		appId: 12345,
		privateKey: fakePrivateKey(),
		cache,
		clock,
		fetchImpl: fakeExchangeFetch(calls, clock.now, (id) => `ghs_inst-${id}`),
	})

	const a = await client.getInstallationToken(1)
	const b = await client.getInstallationToken(2)
	assert.equal(a, "ghs_inst-1")
	assert.equal(b, "ghs_inst-2")
	assert.equal(calls.count, 2, "different installations must NOT share a cached token")

	// Re-fetching either within the window must not re-exchange.
	await client.getInstallationToken(1)
	await client.getInstallationToken(2)
	assert.equal(calls.count, 2)
}

async function testExpiredCacheEntryRefreshedEvenIfLibCacheHit(): Promise<void> {
	// Belt-and-braces: even if the LIBRARY's own cache (disabled via
	// refresh:true) somehow held a stale token, OUR cache's expiry check is
	// what governs — prove a stale cache entry is not served.
	const store = new Map<string, string>()
	const cache: TokenCache = {
		get: async (key: string) => store.get(key),
		set: async (key: string, value: string) => {
			store.set(key, value)
		},
	}
	const clock = makeClock()
	let serial = 0
	const calls = { count: 0 }
	const client = createAppAuthClient({
		appId: 12345,
		privateKey: fakePrivateKey(),
		cache,
		clock,
		fetchImpl: fakeExchangeFetch(calls, clock.now, () => `ghs_fresh-${++serial}`),
	})

	const t1 = await client.getInstallationToken(9)
	assert.equal(t1, "ghs_fresh-1")

	// Manually corrupt the cache entry with an expired timestamp.
	store.set("github-app-installation-token:9", JSON.stringify({ token: "ghs_STALE", expiresAt: clock.now() - 1000 }))
	const t2 = await client.getInstallationToken(9)
	assert.equal(t2, "ghs_fresh-2", "a stale cached token must be refreshed, not served")
}

async function testExchangeFailureThrowsTypedError(): Promise<void> {
	const cache = makeCache()
	const clock = makeClock()
	const failingFetch = (() => Promise.resolve(new Response(JSON.stringify({ message: "bam" }), { status: 500 }))) as unknown as typeof fetch
	const client = createAppAuthClient({
		appId: 12345,
		privateKey: fakePrivateKey(),
		cache,
		clock,
		fetchImpl: failingFetch,
	})

	await assert.rejects(
		() => client.getInstallationToken(7),
		(err) => {
			assert.ok(err instanceof Error)
			assert.equal((err as { name: string }).name, "AppAuthError")
			assert.match((err as Error).message, /installation 7/)
			return true
		},
	)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["token cached within window avoids redundant exchange (call counter)", testTokenCachedWithinWindowAvoidsExchange],
	["token refreshed once past expiry (fake clock)", testTokenRefreshedAfterExpiry],
	["cache keyed by installation id", testCacheKeyedByInstallationId],
	["stale cache entry refreshed, never served", testExpiredCacheEntryRefreshedEvenIfLibCacheHit],
	["exchange failure surfaces as typed AppAuthError", testExchangeFailureThrowsTypedError],
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
	console.log(`\nAll ${tests.length} app-auth tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
