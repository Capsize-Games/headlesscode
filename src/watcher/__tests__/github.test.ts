/**
 * Unit tests for src/watcher/github.ts — the GitHub REST client. Plain
 * assert-based (no framework, no network — fetch is injected). Run via
 * `npm test`.
 */

import assert from "node:assert/strict"

import {
	GhApiError,
	addLabel,
	buildGhUrl,
	ghApi,
	getIssue,
	listIssues,
	toIssue,
} from "../github.js"

interface FakeInit {
	method?: string
	headers?: Record<string, string>
	body?: string
}

type FakeHandler = (url: string, init: FakeInit) => { status: number; body?: unknown }

/**
 * Build a fake `fetch` from a handler. Response bodies are JSON-serialized;
 * 204-style empty responses are expressed with `body: undefined`.
 */
function fakeFetchImpl(handler: FakeHandler): typeof fetch {
	const impl = (input: unknown, init?: unknown): Promise<Response> => {
		const url = typeof input === "string" ? input : String((input as { url?: unknown }).url ?? "")
		const callInit = (init ?? {}) as FakeInit
		const { status, body } = handler(url, callInit)
		// Node's Response constructor rejects 204 with any body, so null out
		// the body for empty responses.
		const payload = body === undefined ? null : JSON.stringify(body)
		return Promise.resolve(new Response(payload, { status, headers: { "Content-Type": "application/json" } }))
	}
	return impl as unknown as typeof fetch
}

/** One raw GitHub issue payload (as the API returns it). */
function rawIssue(number: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		number,
		title: `issue ${number}`,
		body: `body of ${number}`,
		labels: [{ name: "needs-agent" }],
		updated_at: "2026-08-01T00:00:00Z",
		html_url: `https://github.com/o/r/issues/${number}`,
		...extra,
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testBuildGhUrl(): Promise<void> {
	// Trailing-slash base + path + params; undefined params are omitted.
	const url = buildGhUrl("https://api.github.com/", "/repos/o/r/issues", {
		per_page: 100,
		page: 2,
		state: "open",
		labels: "needs-agent",
		extra: undefined,
	})
	assert.equal(
		url,
		"https://api.github.com/repos/o/r/issues?per_page=100&page=2&state=open&labels=needs-agent",
	)
	// No params -> no query string.
	assert.equal(buildGhUrl("https://api.github.com", "/repos/o/r/issues"), "https://api.github.com/repos/o/r/issues")
}

async function testGhApiAuthHeader(): Promise<void> {
	let captured: { url: string; init: FakeInit } | undefined
	const fetchImpl = fakeFetchImpl((url, init) => {
		captured = { url, init }
		return { status: 200, body: { ok: true } }
	})
	const result = await ghApi("/repos/o/r/issues/1", {
		token: "test-token",
		baseUrl: "https://api.github.com",
		fetchImpl,
	})
	assert.deepEqual(result, { ok: true })
	assert.ok(captured, "fetch was called")
	assert.equal(captured!.init.method ?? "GET", "GET")
	assert.equal(captured!.init.headers?.["Authorization"], "Bearer test-token")
	assert.equal(captured!.init.headers?.["Accept"], "application/vnd.github+json")
	assert.equal(captured!.init.headers?.["X-GitHub-Api-Version"], "2022-11-28")
	assert.equal(captured!.url, "https://api.github.com/repos/o/r/issues/1")
}

async function testGhApiNon2xxThrowsTypedError(): Promise<void> {
	const fetchImpl = fakeFetchImpl(() => ({
		status: 404,
		body: { message: "Not Found" },
	}))
	await assert.rejects(
		() => ghApi("/repos/o/r/issues/999", { token: "t", baseUrl: "https://api.github.com", fetchImpl }),
		(err) => {
			assert.ok(err instanceof GhApiError)
			assert.equal((err as GhApiError).status, 404)
			assert.match((err as GhApiError).message, /Not Found/)
			return true
		},
	)
}

async function testGhApiNon2xxWithoutJsonBody(): Promise<void> {
	const fetchImpl = fakeFetchImpl(() => ({ status: 500, body: undefined }))
	await assert.rejects(
		() => ghApi("/repos/o/r/issues", { token: "t", baseUrl: "https://api.github.com", fetchImpl }),
		(err) => {
			assert.ok(err instanceof GhApiError)
			assert.equal((err as GhApiError).status, 500)
			assert.match((err as GhApiError).message, /HTTP 500/)
			return true
		},
	)
}

async function testGhApiNetworkErrorWrapped(): Promise<void> {
	const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch
	await assert.rejects(
		() => ghApi("/repos/o/r/issues", { token: "t", baseUrl: "https://api.github.com", fetchImpl }),
		(err) => {
			assert.ok(err instanceof Error)
			assert.match((err as Error).message, /network/i)
			return true
		},
	)
}

async function testGhApiEmptyBodyReturnsUndefined(): Promise<void> {
	const fetchImpl = fakeFetchImpl(() => ({ status: 204, body: undefined }))
	const result = await ghApi("/repos/o/r/issues/1/labels", {
		token: "t",
		baseUrl: "https://api.github.com",
		fetchImpl,
	})
	assert.equal(result, undefined)
}

async function testToIssueFiltersPullRequests(): Promise<void> {
	const pr = toIssue(rawIssue(1, { pull_request: { url: "https://api.github.com/repos/o/r/pulls/1" } }))
	assert.equal(pr, undefined, "PR entries from the issues endpoint are filtered out")
	const issue = toIssue(rawIssue(2))
	assert.equal(issue?.number, 2)
	assert.deepEqual(issue?.labels, ["needs-agent"])
	assert.equal(issue?.title, "issue 2")
	assert.ok(issue?.html_url?.includes("/issues/2"))
	// Garbage / non-objects are dropped too.
	assert.equal(toIssue(null), undefined)
	assert.equal(toIssue("nope"), undefined)
}

async function testListIssuesPaginatesAndFiltersPrs(): Promise<void> {
	const requestedPages: string[] = []
	// Page 1: 100 entries incl. ONE pull request. Page 2: 2 more. Short page
	// after page 2 must stop the loop.
	const fetchImpl = fakeFetchImpl((url) => {
		const page = new URL(url).searchParams.get("page")
		requestedPages.push(page ?? "?")
		if (page === "2") {
			return { status: 200, body: [rawIssue(101), rawIssue(102)] }
		}
		const entries = Array.from({ length: 100 }, (_, i) => rawIssue(i + 1))
		entries[0] = rawIssue(1, { pull_request: { url: "x" } }) // #1 is a PR
		return { status: 200, body: entries }
	})

	const issues = await listIssues({
		owner: "o",
		repo: "r",
		label: "needs-agent",
		token: "t",
		baseUrl: "https://api.github.com",
		fetchImpl,
	})
	assert.equal(issues.length, 101, "100 page-1 entries minus 1 PR plus 2 page-2 entries")
	assert.ok(issues.every((i) => i.number !== 1), "PR #1 filtered out")
	assert.deepEqual(requestedPages, ["1", "2"], "pagination stops after the short page")
	assert.equal(issues[issues.length - 1].number, 102)
}

async function testListIssuesRespectsMaxTotalCap(): Promise<void> {
	let requests = 0
	const fetchImpl = fakeFetchImpl(() => {
		requests++
		return { status: 200, body: Array.from({ length: 100 }, (_, i) => rawIssue(i + 1)) }
	})
	const issues = await listIssues({
		owner: "o",
		repo: "r",
		label: "needs-agent",
		token: "t",
		baseUrl: "https://api.github.com",
		fetchImpl,
		maxTotal: 150,
	})
	assert.equal(issues.length, 150, "capped at maxTotal")
	assert.equal(requests, 2)
}

async function testGetIssue(): Promise<void> {
	const fetchImpl = fakeFetchImpl(() => ({ status: 200, body: rawIssue(27) }))
	const issue = await getIssue("o", "r", 27, { token: "t", baseUrl: "https://api.github.com", fetchImpl })
	assert.equal(issue.number, 27)
	assert.deepEqual(issue.labels, ["needs-agent"])
}

async function testAddLabelPosts(): Promise<void> {
	let captured: { url: string; init: FakeInit } | undefined
	const fetchImpl = fakeFetchImpl((url, init) => {
		captured = { url, init }
		return { status: 200, body: [rawIssue(3)] }
	})
	await addLabel("o", "r", 3, "in-progress", { token: "t", baseUrl: "https://api.github.com", fetchImpl })
	assert.ok(captured)
	assert.equal(captured!.init.method, "POST")
	assert.deepEqual(JSON.parse(captured!.init.body ?? "{}"), { labels: ["in-progress"] })
	assert.equal(captured!.url, "https://api.github.com/repos/o/r/issues/3/labels")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["buildGhUrl constructs URLs + omits undefined params", testBuildGhUrl],
	["ghApi sends Bearer auth + version headers", testGhApiAuthHeader],
	["non-2xx -> typed GhApiError with status + message", testGhApiNon2xxThrowsTypedError],
	["non-2xx without JSON body still yields status", testGhApiNon2xxWithoutJsonBody],
	["network errors are wrapped", testGhApiNetworkErrorWrapped],
	["empty/204 bodies -> undefined", testGhApiEmptyBodyReturnsUndefined],
	["toIssue filters pull requests and normalizes labels", testToIssueFiltersPullRequests],
	["listIssues paginates + filters PRs + stops on short page", testListIssuesPaginatesAndFiltersPrs],
	["listIssues respects maxTotal cap", testListIssuesRespectsMaxTotalCap],
	["getIssue returns a normalized issue", testGetIssue],
	["addLabel POSTs { labels: [...] } to the labels endpoint", testAddLabelPosts],
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
	console.log(`\nAll ${tests.length} github client tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
