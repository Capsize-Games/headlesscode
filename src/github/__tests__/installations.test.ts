/**
 * COV-4: unit tests for src/github/installations.ts — listInstallationRepos
 * and its toInstallationRepo normalizer. Never asserted directly before
 * (only used transitively by app-auth/pr/cli), despite being a live API
 * surface. Same injected-fake-fetch pattern established in
 * src/github/__tests__/pr.test.ts: plain assert-based (no framework, no
 * network), run via `npm test`.
 */

import assert from "node:assert/strict"

import { listInstallationRepos, toInstallationRepo } from "../installations.js"

const FAKE_TOKEN = "ghs_TESTTOKEN1234567890"
const API_BASE = "https://api.github.com"

interface RecordedRequest {
	url: string
	method: string
	headers: Record<string, string>
}

/** A fake `fetch` that routes on METHOD + URL and records every request. */
function makeFakeFetch(
	handler: (method: string, url: URL) => { status: number; body: unknown } | { networkError: Error },
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = []
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input))
		const method = (init?.method ?? "GET").toUpperCase()
		const headers: Record<string, string> = {}
		for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
			headers[k.toLowerCase()] = String(v)
		}
		requests.push({ url: url.href, method, headers })

		const result = handler(method, url)
		if ("networkError" in result) {
			throw result.networkError
		}
		return new Response(JSON.stringify(result.body), {
			status: result.status,
			headers: { "Content-Type": "application/json" },
		})
	}) as typeof fetch
	return { fetchImpl, requests }
}

function rawRepo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "hello",
		full_name: "octo/hello",
		default_branch: "main",
		...overrides,
	}
}

// ─── toInstallationRepo ──────────────────────────────────────────────────────

function testToInstallationRepoNormalizesAValidPayload(): void {
	const repo = toInstallationRepo(rawRepo())
	assert.deepEqual(repo, { owner: "octo", name: "hello", fullName: "octo/hello", defaultBranch: "main" })
}

function testToInstallationRepoDefaultsMissingBranchToMain(): void {
	const repo = toInstallationRepo(rawRepo({ default_branch: undefined }))
	assert.equal(repo?.defaultBranch, "main")
	const repoEmpty = toInstallationRepo(rawRepo({ default_branch: "" }))
	assert.equal(repoEmpty?.defaultBranch, "main", "an empty string also falls back to main")
}

function testToInstallationRepoRejectsGarbage(): void {
	assert.equal(toInstallationRepo(null), undefined)
	assert.equal(toInstallationRepo(undefined), undefined)
	assert.equal(toInstallationRepo("a string"), undefined)
	assert.equal(toInstallationRepo(42), undefined)
	assert.equal(toInstallationRepo({}), undefined, "missing name/full_name")
	assert.equal(toInstallationRepo(rawRepo({ name: "" })), undefined, "empty name")
	assert.equal(toInstallationRepo(rawRepo({ name: 42 })), undefined, "non-string name")
	assert.equal(toInstallationRepo(rawRepo({ full_name: "no-slash" })), undefined, "full_name without a slash")
	assert.equal(toInstallationRepo(rawRepo({ full_name: undefined })), undefined, "missing full_name")
	assert.equal(
		toInstallationRepo(rawRepo({ name: "other", full_name: "octo/hello" })),
		undefined,
		"full_name's repo segment must match name",
	)
}

// ─── listInstallationRepos ───────────────────────────────────────────────────

async function testListInstallationReposFetchesAndNormalizesASinglePage(): Promise<void> {
	const { fetchImpl, requests } = makeFakeFetch((method, url) => {
		assert.equal(method, "GET")
		assert.equal(url.pathname, "/installation/repositories")
		return {
			status: 200,
			body: { total_count: 2, repositories: [rawRepo({ name: "a", full_name: "octo/a" }), rawRepo({ name: "b", full_name: "octo/b" })] },
		}
	})
	const repos = await listInstallationRepos(123, { getToken: async () => FAKE_TOKEN, baseUrl: API_BASE, fetchImpl })
	assert.deepEqual(
		repos.map((r) => r.fullName),
		["octo/a", "octo/b"],
	)
	assert.equal(requests.length, 1, "a short page (< per_page) must not trigger a second request")

	const req = requests[0]!
	assert.equal(req.headers["authorization"], `Bearer ${FAKE_TOKEN}`)
	assert.equal(req.headers["accept"], "application/vnd.github+json")
	assert.equal(req.headers["x-github-api-version"], "2022-11-28")
	assert.match(req.url, /per_page=100&page=1$/)
}

async function testListInstallationReposPaginatesUntilAShortPage(): Promise<void> {
	const page1 = Array.from({ length: 100 }, (_, i) => rawRepo({ name: `r${i}`, full_name: `octo/r${i}` }))
	const page2 = [rawRepo({ name: "last", full_name: "octo/last" })]
	const { fetchImpl, requests } = makeFakeFetch((_method, url) => {
		const page = url.searchParams.get("page")
		return { status: 200, body: { repositories: page === "1" ? page1 : page2 } }
	})
	const repos = await listInstallationRepos(123, { getToken: async () => FAKE_TOKEN, baseUrl: API_BASE, fetchImpl })
	assert.equal(repos.length, 101, "both pages' repos are collected")
	assert.equal(requests.length, 2, "a full page (== per_page) triggers a second request")
	assert.equal(repos[100]!.fullName, "octo/last")
}

async function testListInstallationReposRespectsMaxTotal(): Promise<void> {
	const page1 = Array.from({ length: 100 }, (_, i) => rawRepo({ name: `r${i}`, full_name: `octo/r${i}` }))
	const { fetchImpl, requests } = makeFakeFetch(() => ({ status: 200, body: { repositories: page1 } }))
	const repos = await listInstallationRepos(123, {
		getToken: async () => FAKE_TOKEN,
		baseUrl: API_BASE,
		fetchImpl,
		maxTotal: 5,
	})
	assert.equal(repos.length, 5, "stops accumulating at maxTotal even mid-page")
	assert.equal(requests.length, 1, "must not fetch a second page once maxTotal is already hit")
}

async function testListInstallationReposSkipsGarbageEntriesInAPage(): Promise<void> {
	const { fetchImpl } = makeFakeFetch(() => ({
		status: 200,
		body: { repositories: [rawRepo({ name: "good", full_name: "octo/good" }), { garbage: true }, null, "oops"] },
	}))
	const repos = await listInstallationRepos(123, { getToken: async () => FAKE_TOKEN, baseUrl: API_BASE, fetchImpl })
	assert.deepEqual(
		repos.map((r) => r.fullName),
		["octo/good"],
	)
}

async function testListInstallationReposThrowsOnHttpError(): Promise<void> {
	const { fetchImpl } = makeFakeFetch(() => ({ status: 403, body: { message: "installation suspended" } }))
	await assert.rejects(
		() => listInstallationRepos(123, { getToken: async () => FAKE_TOKEN, baseUrl: API_BASE, fetchImpl }),
		/installation suspended.*HTTP 403/,
	)
}

async function testListInstallationReposThrowsOnHttpErrorWithNonJsonBody(): Promise<void> {
	const fetchImpl = (async () => new Response("not json", { status: 500 })) as typeof fetch
	await assert.rejects(
		() => listInstallationRepos(123, { getToken: async () => FAKE_TOKEN, baseUrl: API_BASE, fetchImpl }),
		/GitHub API HTTP 500/,
	)
}

async function testListInstallationReposWrapsNetworkErrors(): Promise<void> {
	const netErr = new Error("ECONNREFUSED")
	const fetchImpl = (async () => {
		throw netErr
	}) as typeof fetch
	await assert.rejects(
		() => listInstallationRepos(123, { getToken: async () => FAKE_TOKEN, baseUrl: API_BASE, fetchImpl }),
		/GitHub API network error.*ECONNREFUSED/,
	)
}

async function testListInstallationReposHandlesEmptyRepositoriesField(): Promise<void> {
	const { fetchImpl } = makeFakeFetch(() => ({ status: 200, body: {} }))
	const repos = await listInstallationRepos(123, { getToken: async () => FAKE_TOKEN, baseUrl: API_BASE, fetchImpl })
	assert.deepEqual(repos, [], "a missing repositories field degrades to an empty list, never throws")
}

const tests: Array<[string, () => Promise<void>]> = [
	["toInstallationRepo: normalizes a valid payload", async () => testToInstallationRepoNormalizesAValidPayload()],
	["toInstallationRepo: defaults a missing/empty default_branch to main", async () => testToInstallationRepoDefaultsMissingBranchToMain()],
	["toInstallationRepo: rejects garbage/malformed payloads", async () => testToInstallationRepoRejectsGarbage()],
	// (the three above wrap synchronous functions to match the shared Array<[string, () => Promise<void>]> test-table shape)
	["listInstallationRepos: fetches + normalizes a single page, sends the right headers/URL", testListInstallationReposFetchesAndNormalizesASinglePage],
	["listInstallationRepos: paginates until a short page", testListInstallationReposPaginatesUntilAShortPage],
	["listInstallationRepos: stops at maxTotal without over-fetching", testListInstallationReposRespectsMaxTotal],
	["listInstallationRepos: skips garbage entries within a page", testListInstallationReposSkipsGarbageEntriesInAPage],
	["listInstallationRepos: throws with the API's message on HTTP error", testListInstallationReposThrowsOnHttpError],
	["listInstallationRepos: throws a generic message when the error body isn't JSON", testListInstallationReposThrowsOnHttpErrorWithNonJsonBody],
	["listInstallationRepos: wraps network errors with context", testListInstallationReposWrapsNetworkErrors],
	["listInstallationRepos: a missing repositories field degrades to []", testListInstallationReposHandlesEmptyRepositoriesField],
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
			console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} github/installations tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
