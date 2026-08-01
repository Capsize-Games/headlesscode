/**
 * Unit tests for src/memory/uwuchat.ts — UwUChatMemoryStore URL/path
 * construction + auth headers. NO network: a fake fetch is injected and the
 * store is only exercised for request shape, never against a live server.
 * Plain assert-based (no framework). Run via `npm test`.
 */

import assert from "node:assert/strict"

import { API_PREFIX, UwUChatMemoryError, UwUChatMemoryStore } from "../uwuchat.js"

const BASE = "https://uwu.example"

interface Call {
	input: string
	init?: RequestInit
}

/** Fake fetch that records calls and returns canned per-path JSON. */
function makeFakeFetch(calls: Call[]): typeof fetch {
	return (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString()
		calls.push({ input: url, init })
		let body: unknown = { facts: [] }
		if (url.includes("/record-fact")) {
			body = { fact: { id: "fact_abc", project: "p", kind: "convention", content: "c", tags: [], createdAt: "t" } }
		} else if (url.includes("/query-recall")) {
			body = { facts: [], summaries: [] }
		} else if (url.includes("/record-session")) {
			body = { ok: true }
		} else if (url.includes("/sessions")) {
			body = { sessions: [] }
		} else if (url.includes("/summaries")) {
			body = { summary: "## Rolling session recap" }
		}
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
	}) as unknown as typeof fetch
}

// ─── Tests ───────────────────────────────────────────────────────────────────

function testEndpointConstruction(): void {
	// Trailing slash on the base URL is stripped; paths are joined exactly.
	const store = new UwUChatMemoryStore({ baseUrl: "https://uwu.example/", token: "tok" })
	assert.equal(store.endpoint(`${API_PREFIX}/record-fact`), `${BASE}${API_PREFIX}/record-fact`)
	assert.equal(store.endpoint(`${API_PREFIX}/facts?project=a%20b`), `${BASE}${API_PREFIX}/facts?project=a%20b`)
	// No trailing slash input stays canonical.
	const noSlash = new UwUChatMemoryStore({ baseUrl: BASE, token: "tok" })
	assert.equal(noSlash.endpoint(`${API_PREFIX}/sessions`), `${BASE}${API_PREFIX}/sessions`)
}

function testAuthHeaders(): void {
	const withToken = new UwUChatMemoryStore({ baseUrl: BASE, token: "secret-token" })
	assert.equal(withToken.authHeaders()["Authorization"], "Bearer secret-token")
	assert.equal(withToken.authHeaders()["Content-Type"], "application/json")

	const noToken = new UwUChatMemoryStore({ baseUrl: BASE })
	assert.equal(noToken.authHeaders()["Authorization"], undefined, "no auth header without a token")
}

async function testAddFactRequestShape(): Promise<void> {
	const calls: Call[] = []
	const store = new UwUChatMemoryStore({ baseUrl: BASE, token: "tok", fetchImpl: makeFakeFetch(calls) })
	const fact = await store.addFact("proj", { kind: "convention", content: "always lint", tags: ["style"] })

	assert.equal(calls.length, 1)
	assert.equal(calls[0].input, `${BASE}${API_PREFIX}/record-fact`)
	assert.equal(calls[0].init?.method, "POST")
	assert.equal((calls[0].init?.headers as Record<string, string> | undefined)?.["Authorization"], "Bearer tok")
	assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
		project: "proj",
		fact: { kind: "convention", content: "always lint", tags: ["style"] },
	})
	assert.equal(fact.id, "fact_abc")
}

async function testListFactsUrlAndQuery(): Promise<void> {
	const calls: Call[] = []
	const store = new UwUChatMemoryStore({ baseUrl: BASE, token: "tok", fetchImpl: makeFakeFetch(calls) })
	await store.listFacts("my repo")
	assert.equal(calls[0].input, `${BASE}${API_PREFIX}/facts?project=my%20repo`)
	assert.equal(calls[0].init?.method, "GET")
}

async function testQueryRecallRequestShape(): Promise<void> {
	const calls: Call[] = []
	const store = new UwUChatMemoryStore({ baseUrl: BASE, token: "tok", fetchImpl: makeFakeFetch(calls) })
	const recall = await store.queryRecall("proj", "retry on 429", 3)
	assert.equal(calls[0].input, `${BASE}${API_PREFIX}/query-recall`)
	assert.equal(calls[0].init?.method, "POST")
	assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { project: "proj", query: "retry on 429", limit: 3 })
	assert.deepEqual(recall, { facts: [], summaries: [] })
}

async function testRecordSessionRequestShape(): Promise<void> {
	const calls: Call[] = []
	const store = new UwUChatMemoryStore({ baseUrl: BASE, token: "tok", fetchImpl: makeFakeFetch(calls) })
	const session = {
		id: "summary_1",
		project: "proj",
		task: "t",
		outcome: "success" as const,
		summary: "s",
		facts: [],
		filesTouched: [],
		commandsRun: [],
		createdAt: "2026-08-01T00:00:00.000Z",
	}
	await store.recordSession("proj", session)
	assert.equal(calls[0].input, `${BASE}${API_PREFIX}/record-session`)
	assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { project: "proj", session })
}

async function testListSessionsAndSummarizeUrls(): Promise<void> {
	const calls: Call[] = []
	const store = new UwUChatMemoryStore({ baseUrl: BASE, token: "tok", fetchImpl: makeFakeFetch(calls) })
	await store.listSessions("proj")
	assert.equal(calls[0].input, `${BASE}${API_PREFIX}/sessions?project=proj`)

	await store.summarize("proj", { maxEntries: 7 })
	assert.equal(calls[1].input, `${BASE}${API_PREFIX}/summaries?project=proj&maxEntries=7`)
	assert.equal(calls[1].init?.method, "GET")
}

async function testThrowsWithoutBaseUrl(): Promise<void> {
	const store = new UwUChatMemoryStore({ token: "tok" })
	await assert.rejects(
		() => store.addFact("proj", { kind: "knowledge", content: "x" }),
		(err) => {
			assert.ok(err instanceof UwUChatMemoryError)
			assert.match(err.message, /not implemented — awaiting AIRunner endpoint/)
			return true
		},
	)
	await assert.rejects(() => store.queryRecall("proj", "q"))
}

async function testTypedErrorOnNon2xx(): Promise<void> {
	const failing: typeof fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
	const store = new UwUChatMemoryStore({ baseUrl: BASE, token: "tok", fetchImpl: failing })
	await assert.rejects(
		() => store.listFacts("proj"),
		(err) => {
			assert.ok(err instanceof UwUChatMemoryError)
			assert.equal(err.status, 500)
			assert.match(err.message, /status 500/)
			return true
		},
	)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void> | void]> = [
	["endpoint() URL construction (trailing slash, query params)", testEndpointConstruction],
	["authHeaders() Bearer token + content type", testAuthHeaders],
	["addFact POST shape + auth header", testAddFactRequestShape],
	["listFacts GET URL with project query", testListFactsUrlAndQuery],
	["queryRecall POST body shape", testQueryRecallRequestShape],
	["recordSession POST body shape", testRecordSessionRequestShape],
	["listSessions + summarize GET URLs", testListSessionsAndSummarizeUrls],
	["throws typed 'not implemented' without a base URL", testThrowsWithoutBaseUrl],
	["typed UwUChatMemoryError on non-2xx", testTypedErrorOnNon2xx],
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
	console.log(`\nAll ${tests.length} uwuchat tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
