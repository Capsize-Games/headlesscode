/**
 * Unit tests for src/github/pr.ts — the open-a-PR primitive.
 * Plain assert-based (no framework, no network): the GitHub REST API is a fake
 * `fetch` recording every request, so the payload shape, headers, base-branch
 * resolution and error handling are all asserted against what would actually
 * be sent to api.github.com. Run via `npm test`.
 */

import assert from "node:assert/strict"

import { NoDiffError, OpenPrError, getPullRequestStatus, getRepoDefaultBranch, openPullRequest } from "../pr.js"

/** The token used for API calls in these tests (fake — never a real one). */
const FAKE_TOKEN = "ghs_TESTTOKEN1234567890"
const API_BASE = "https://api.github.com"

interface RecordedRequest {
	url: string
	method: string
	headers: Record<string, string>
	body: string | undefined
}

/** A fake `fetch` that routes on METHOD + URL path and records every request. */
function makeFakeFetch(
	handler: (method: string, path: string) => { status: number; body: unknown } | { networkError: Error },
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = []
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input))
		const method = (init?.method ?? "GET").toUpperCase()
		const headers: Record<string, string> = {}
		for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
			headers[k.toLowerCase()] = String(v)
		}
		const body = typeof init?.body === "string" ? init.body : undefined
		requests.push({ url: url.href, method, headers, body })

		const result = handler(method, url.pathname)
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

function pullOptions(overrides: Partial<Parameters<typeof openPullRequest>[0]> = {}): Parameters<typeof openPullRequest>[0] {
	return {
		installationId: 123,
		owner: "octo",
		repo: "hello",
		head: "feature-x",
		title: "Add feature",
		body: "Closes #1",
		getToken: async () => FAKE_TOKEN,
		baseUrl: API_BASE,
		...overrides,
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testOpensPrWithExplicitBase(): Promise<void> {
	const { fetchImpl, requests } = makeFakeFetch((method, path) => {
		if (method === "POST" && path === "/repos/octo/hello/pulls") {
			return { status: 201, body: { number: 42, html_url: "https://github.com/octo/hello/pull/42" } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	const result = await openPullRequest(pullOptions({ base: "main", fetchImpl }))

	assert.deepEqual(result, { number: 42, url: "https://github.com/octo/hello/pull/42" })
	assert.equal(requests.length, 1, "with an explicit base only the pulls POST happens")
	const req = requests[0]
	assert.equal(req.method, "POST")
	assert.equal(req.url, `${API_BASE}/repos/octo/hello/pulls`)
	assert.equal(req.headers.authorization, `Bearer ${FAKE_TOKEN}`, "the installation token rides as a Bearer header")
	assert.equal(req.headers.accept, "application/vnd.github+json")
	assert.equal(req.headers["x-github-api-version"], "2022-11-28")
	assert.deepEqual(JSON.parse(req.body!), {
		title: "Add feature",
		head: "feature-x",
		base: "main",
		body: "Closes #1",
	})
}

async function testResolvesRealDefaultBranchWhenBaseOmitted(): Promise<void> {
	// "trunk" — deliberately NOT main/master — proves the default branch is
	// read from the repo API, never hardcoded.
	const { fetchImpl, requests } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello") {
			return { status: 200, body: { default_branch: "trunk" } }
		}
		if (method === "POST" && path === "/repos/octo/hello/pulls") {
			return { status: 201, body: { number: 9, html_url: "https://github.com/octo/hello/pull/9" } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	const result = await openPullRequest(pullOptions({ fetchImpl }))

	assert.equal(result.number, 9)
	assert.equal(requests.length, 2)
	assert.equal(requests[0].method, "GET")
	assert.equal(requests[0].url, `${API_BASE}/repos/octo/hello`)
	const postBody = JSON.parse(requests[1].body!) as { base: string }
	assert.equal(postBody.base, "trunk", "the PR must target the repo's real default branch")
}

async function testNoDiffTopLevelMessageSurfacesAsNoDiffError(): Promise<void> {
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "POST" && path === "/repos/octo/hello/pulls") {
			return {
				status: 422,
				body: { message: "No commits between main and feature-x", documentation_url: "https://docs.github.com/rest" },
			}
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	await assert.rejects(
		() => openPullRequest(pullOptions({ base: "main", fetchImpl })),
		(err) => {
			assert.ok(err instanceof NoDiffError, "must surface as NoDiffError")
			assert.ok(err instanceof OpenPrError, "NoDiffError is a kind of OpenPrError")
			assert.equal((err as OpenPrError).status, 422)
			assert.match((err as Error).message, /nothing to merge/)
			return true
		},
	)
}

async function testNoDiffInErrorsArraySurfacesAsNoDiffError(): Promise<void> {
	// GitHub's other "nothing to merge" shape: a top-level validation message
	// with the real reason nested in errors[].
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "POST" && path === "/repos/octo/hello/pulls") {
			return {
				status: 422,
				body: { message: "Validation Failed", errors: [{ message: "The head and base branches are the same" }] },
			}
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	await assert.rejects(
		() => openPullRequest(pullOptions({ base: "main", fetchImpl })),
		(err) => {
			assert.ok(err instanceof NoDiffError, "must surface as NoDiffError")
			assert.match((err as Error).message, /nothing to merge/)
			return true
		},
	)
}

async function testOtherApiErrorsAreOpenPrErrors(): Promise<void> {
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "POST" && path === "/repos/octo/hello/pulls") {
			return { status: 404, body: { message: "Not Found" } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	await assert.rejects(
		() => openPullRequest(pullOptions({ base: "main", fetchImpl })),
		(err) => {
			assert.ok(err instanceof OpenPrError)
			assert.ok(!(err instanceof NoDiffError), "a 404 is NOT a no-diff condition")
			assert.equal((err as OpenPrError).status, 404)
			return true
		},
	)
}

async function testNetworkErrorSurfacesAsOpenPrError(): Promise<void> {
	const { fetchImpl } = makeFakeFetch(() => ({ networkError: new Error("fetch failed: ECONNREFUSED") }))

	await assert.rejects(
		() => openPullRequest(pullOptions({ base: "main", fetchImpl })),
		(err) => {
			assert.ok(err instanceof OpenPrError)
			assert.equal((err as OpenPrError).status, 0, "network failures carry status 0")
			assert.match((err as Error).message, /network error \(POST/)
			return true
		},
	)
}

async function testValidatesRequiredOptions(): Promise<void> {
	await assert.rejects(
		() => openPullRequest(pullOptions({ owner: "" })),
		(err) => {
			assert.ok(err instanceof OpenPrError)
			assert.match((err as Error).message, /owner and repo are required/)
			return true
		},
	)
	await assert.rejects(
		() => openPullRequest(pullOptions({ title: "" })),
		(err) => {
			assert.ok(err instanceof OpenPrError)
			assert.match((err as Error).message, /title is required/)
			return true
		},
	)
}

async function testGetRepoDefaultBranch(): Promise<void> {
	const { fetchImpl, requests } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello") {
			return { status: 200, body: { default_branch: "develop" } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	const branch = await getRepoDefaultBranch({ owner: "octo", repo: "hello", getToken: async () => FAKE_TOKEN, baseUrl: API_BASE, fetchImpl })
	assert.equal(branch, "develop")
	assert.equal(requests[0].headers.authorization, `Bearer ${FAKE_TOKEN}`)
}

async function testGetRepoDefaultBranchRejectsMissingBranch(): Promise<void> {
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello") {
			return { status: 200, body: { full_name: "octo/hello" } } // no default_branch
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	await assert.rejects(
		() => getRepoDefaultBranch({ owner: "octo", repo: "hello", getToken: async () => FAKE_TOKEN, baseUrl: API_BASE, fetchImpl }),
		(err) => {
			assert.ok(err instanceof OpenPrError)
			assert.match((err as Error).message, /no default_branch/)
			return true
		},
	)
}

// ─── getPullRequestStatus ────────────────────────────────────────────────────

function prStatusOptions(overrides: Partial<Parameters<typeof getPullRequestStatus>[0]> = {}): Parameters<typeof getPullRequestStatus>[0] {
	return {
		owner: "octo",
		repo: "hello",
		prNumber: 42,
		getToken: async () => FAKE_TOKEN,
		baseUrl: API_BASE,
		...overrides,
	}
}

async function testGetPullRequestStatusMerged(): Promise<void> {
	const { fetchImpl, requests } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello/pulls/42") {
			return {
				status: 200,
				body: {
					number: 42,
					state: "closed",
					merged: true,
					merged_at: "2026-08-02T12:00:00Z",
					html_url: "https://github.com/octo/hello/pull/42",
					title: "Add feature",
				},
			}
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	const status = await getPullRequestStatus(prStatusOptions({ fetchImpl }))
	assert.equal(status.merged, true)
	assert.equal(status.state, "closed")
	assert.equal(status.number, 42)
	assert.equal(status.mergedAt, "2026-08-02T12:00:00Z")
	assert.equal(status.htmlUrl, "https://github.com/octo/hello/pull/42")
	assert.equal(requests.length, 1)
	const req = requests[0]
	assert.equal(req.method, "GET")
	assert.equal(req.url, `${API_BASE}/repos/octo/hello/pulls/42`)
	assert.equal(req.headers.authorization, `Bearer ${FAKE_TOKEN}`, "the installation token rides as a Bearer header")
	assert.equal(req.headers.accept, "application/vnd.github+json")
	assert.equal(req.headers["x-github-api-version"], "2022-11-28")
}

async function testGetPullRequestStatusUnmergedOpen(): Promise<void> {
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello/pulls/42") {
			return { status: 200, body: { number: 42, state: "open", merged: false } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	const status = await getPullRequestStatus(prStatusOptions({ fetchImpl }))
	assert.equal(status.merged, false, "an open PR is not merged")
	assert.equal(status.state, "open")
}

async function testGetPullRequestStatusClosedNotMerged(): Promise<void> {
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello/pulls/42") {
			return { status: 200, body: { number: 42, state: "closed", merged: false } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	const status = await getPullRequestStatus(prStatusOptions({ fetchImpl }))
	assert.equal(status.merged, false, "a closed-without-merge PR is NOT merged")
	assert.equal(status.state, "closed")
}

async function testGetPullRequestStatusApiError(): Promise<void> {
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello/pulls/42") {
			return { status: 404, body: { message: "Not Found" } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	await assert.rejects(
		() => getPullRequestStatus(prStatusOptions({ fetchImpl })),
		(err) => {
			assert.ok(err instanceof OpenPrError)
			assert.equal((err as OpenPrError).status, 404)
			return true
		},
	)
}

async function testGetPullRequestStatusNetworkError(): Promise<void> {
	const { fetchImpl } = makeFakeFetch(() => ({ networkError: new Error("fetch failed: ECONNREFUSED") }))

	await assert.rejects(
		() => getPullRequestStatus(prStatusOptions({ fetchImpl })),
		(err) => {
			assert.ok(err instanceof OpenPrError)
			assert.equal((err as OpenPrError).status, 0, "network failures carry status 0")
			assert.match((err as Error).message, /network error \(GET/)
			return true
		},
	)
}

async function testGetPullRequestStatusMalformedBodyThrows(): Promise<void> {
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello/pulls/42") {
			return { status: 200, body: { number: 42 } } // no state/merged
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	await assert.rejects(
		() => getPullRequestStatus(prStatusOptions({ fetchImpl })),
		(err) => {
			assert.ok(err instanceof OpenPrError)
			assert.match((err as Error).message, /unexpected PR status shape/)
			return true
		},
	)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["posts the correct payload with an explicit base and returns {number, url}", testOpensPrWithExplicitBase],
	["resolves the repo's REAL default branch when base is omitted", testResolvesRealDefaultBranchWhenBaseOmitted],
	["surfaces 'no commits between' (top-level message) as NoDiffError", testNoDiffTopLevelMessageSurfacesAsNoDiffError],
	["surfaces 'head and base are the same' (errors[]) as NoDiffError", testNoDiffInErrorsArraySurfacesAsNoDiffError],
	["surfaces other API errors as OpenPrError (not NoDiffError)", testOtherApiErrorsAreOpenPrErrors],
	["surfaces network failures as OpenPrError with status 0", testNetworkErrorSurfacesAsOpenPrError],
	["validates required options", testValidatesRequiredOptions],
	["getRepoDefaultBranch returns the repo's default_branch", testGetRepoDefaultBranch],
	["getRepoDefaultBranch rejects a repo with no default_branch", testGetRepoDefaultBranchRejectsMissingBranch],
	["getPullRequestStatus reads a merged PR's status (GET + Bearer token)", testGetPullRequestStatusMerged],
	["getPullRequestStatus reports an open PR as not merged", testGetPullRequestStatusUnmergedOpen],
	["getPullRequestStatus reports a closed-not-merged PR as not merged", testGetPullRequestStatusClosedNotMerged],
	["getPullRequestStatus surfaces API errors as OpenPrError", testGetPullRequestStatusApiError],
	["getPullRequestStatus surfaces network failures as OpenPrError (status 0)", testGetPullRequestStatusNetworkError],
	["getPullRequestStatus rejects a malformed 2xx body", testGetPullRequestStatusMalformedBodyThrows],
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
	console.log(`\nAll ${tests.length} PR tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
