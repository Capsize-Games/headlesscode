/**
 * Unit tests for src/orchestrator/merge-check.ts — the deterministic
 * "is this group's work merged?" predicates.
 *
 * checkMergedByAncestor runs against REAL throwaway git fixture repos (the
 * repo's own tests build disposable repos this way; see
 * scripts/e2e-fixture/setup.sh) so the ancestor semantics are proven against
 * actual git, not a mock. checkMergedByGitHubPr uses a fake fetch (the same
 * pattern as src/github/__tests__/pr.test.ts) since it is a pure HTTP
 * consumer. Plain assert-based, run via `npm test`.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { checkMergedByAncestor, checkMergedByGitHubPr } from "../merge-check.js"

function git(repo: string, args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

/** A fresh git repo with one commit on `main` (user config set, GPG off). */
async function makeGitRepo(): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-merge-check-"))
	execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" })
	git(dir, ["config", "user.email", "test@headlesscode.invalid"])
	git(dir, ["config", "user.name", "Merge Check Test"])
	git(dir, ["config", "commit.gpgsign", "false"])
	await fsp.writeFile(path.join(dir, "a.txt"), "a\n")
	git(dir, ["add", "a.txt"])
	git(dir, ["commit", "-qm", "init"])
	return dir
}

/** Create branch `feat` off main and advance it by one REAL file change. */
function makeFeatCommit(repo: string): void {
	git(repo, ["switch", "-q", "-c", "feat"])
	git(repo, ["config", "user.email", "test@headlesscode.invalid"])
	git(repo, ["config", "user.name", "Merge Check Test"])
	git(repo, ["config", "commit.gpgsign", "false"])
	fs.writeFileSync(path.join(repo, "b.txt"), "feat\n")
	git(repo, ["add", "b.txt"])
	git(repo, ["commit", "-qm", "feat work"])
	git(repo, ["switch", "-q", "main"])
}

// ─── checkMergedByAncestor (real git fixtures) ───────────────────────────────

async function testFastForwardMergedIsAncestor(): Promise<void> {
	const repo = await makeGitRepo()
	try {
		makeFeatCommit(repo)
		git(repo, ["merge", "-q", "feat"]) // fast-forward

		const result = checkMergedByAncestor(repo, "feat", "main")
		assert.equal(result.merged, true, "a fast-forward-merged branch tip IS an ancestor of base")
		assert.equal(result.via, "local-ancestor")
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function testMergedThenBaseAdvancedStillAncestor(): Promise<void> {
	const repo = await makeGitRepo()
	try {
		makeFeatCommit(repo)
		git(repo, ["merge", "-q", "feat"]) // fast-forward
		// Base advances FURTHER after the merge — the branch tip must STILL be
		// an ancestor (ancestor, not tip-equality).
		git(repo, ["commit", "-qm", "base advanced", "--allow-empty"])

		const result = checkMergedByAncestor(repo, "feat", "main")
		assert.equal(result.merged, true, "merged then base advanced further — still an ancestor")
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function testNeverMergedIsNotAncestor(): Promise<void> {
	const repo = await makeGitRepo()
	try {
		makeFeatCommit(repo) // branch advanced, never merged back

		const result = checkMergedByAncestor(repo, "feat", "main")
		assert.equal(result.merged, false, "a never-merged branch tip is NOT an ancestor of base")
		assert.equal(result.via, "local-ancestor")
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function testSquashMergedIsNotAncestor(): Promise<void> {
	// The documented limitation motivating the GitHub-PR path: a squash merge
	// creates a NEW commit hash, so the local ancestor check correctly says
	// "not merged" even though the work WAS merged.
	const repo = await makeGitRepo()
	try {
		makeFeatCommit(repo)
		git(repo, ["merge", "--squash", "feat"])
		git(repo, ["commit", "-qm", "squash merge feat into main"])

		const result = checkMergedByAncestor(repo, "feat", "main")
		assert.equal(result.merged, false, "a squash merge is NOT detectable via the ancestor check (by design)")
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function testMissingBranchThrows(): Promise<void> {
	const repo = await makeGitRepo()
	try {
		assert.throws(
			() => checkMergedByAncestor(repo, "no-such-branch", "main"),
			/merge status unknown/,
			"an unresolvable ref must throw, never guess",
		)
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

// ─── checkMergedByGitHubPr (fake fetch) ──────────────────────────────────────

const FAKE_TOKEN = "ghs_TESTTOKEN1234567890"
const API_BASE = "https://api.github.com"

interface RecordedRequest {
	url: string
	method: string
	headers: Record<string, string>
}

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
		requests.push({ url: url.href, method, headers })
		const result = handler(method, url.pathname)
		if ("networkError" in result) {
			throw result.networkError
		}
		return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } })
	}) as typeof fetch
	return { fetchImpl, requests }
}

function ghOptions(overrides: Partial<Parameters<typeof checkMergedByGitHubPr>[0]> = {}): Parameters<typeof checkMergedByGitHubPr>[0] {
	return {
		owner: "octo",
		repo: "hello",
		prNumber: 42,
		getInstallationToken: async () => FAKE_TOKEN,
		baseUrl: API_BASE,
		...overrides,
	}
}

async function testGitHubMerged(): Promise<void> {
	const { fetchImpl, requests } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello/pulls/42") {
			return { status: 200, body: { number: 42, state: "closed", merged: true } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	const result = await checkMergedByGitHubPr(ghOptions({ fetchImpl }))
	assert.equal(result.merged, true)
	assert.equal(result.via, "github-pr")
	assert.match(result.detail, /PR #42 merged/)
	assert.equal(requests[0].headers.authorization, `Bearer ${FAKE_TOKEN}`)
}

async function testGitHubUnmergedOpen(): Promise<void> {
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello/pulls/42") {
			return { status: 200, body: { number: 42, state: "open", merged: false } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	const result = await checkMergedByGitHubPr(ghOptions({ fetchImpl }))
	assert.equal(result.merged, false)
	assert.equal(result.via, "github-pr")
	assert.match(result.detail, /PR #42 not merged/)
}

async function testGitHubClosedNotMerged(): Promise<void> {
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello/pulls/42") {
			return { status: 200, body: { number: 42, state: "closed", merged: false } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	const result = await checkMergedByGitHubPr(ghOptions({ fetchImpl }))
	assert.equal(result.merged, false, "closed-without-merge is NOT merged")
	assert.equal(result.via, "github-pr")
}

async function testGitHubApiErrorFailsClosed(): Promise<void> {
	const { fetchImpl } = makeFakeFetch((method, path) => {
		if (method === "GET" && path === "/repos/octo/hello/pulls/42") {
			return { status: 404, body: { message: "Not Found" } }
		}
		throw new Error(`unexpected request: ${method} ${path}`)
	})

	const result = await checkMergedByGitHubPr(ghOptions({ fetchImpl }))
	assert.equal(result.merged, false, "an API error must fail CLOSED (never merged)")
	assert.equal(result.via, "unknown")
	assert.match(result.detail, /GitHub API error/)
}

async function testGitHubNetworkErrorFailsClosed(): Promise<void> {
	const { fetchImpl } = makeFakeFetch(() => ({ networkError: new Error("fetch failed: ECONNREFUSED") }))

	const result = await checkMergedByGitHubPr(ghOptions({ fetchImpl }))
	assert.equal(result.merged, false)
	assert.equal(result.via, "unknown")
	assert.match(result.detail, /GitHub (API|PR check) error/, `detail names the failure: ${result.detail}`)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["ancestor: fast-forward-merged branch is merged", testFastForwardMergedIsAncestor],
	["ancestor: merged then base advanced further is still merged", testMergedThenBaseAdvancedStillAncestor],
	["ancestor: never-merged branch is not merged", testNeverMergedIsNotAncestor],
	["ancestor: squash-merged branch is correctly NOT detected (documented)", testSquashMergedIsNotAncestor],
	["ancestor: unresolvable branch throws instead of guessing", testMissingBranchThrows],
	["github-pr: merged PR -> merged via github-pr", testGitHubMerged],
	["github-pr: open PR -> not merged", testGitHubUnmergedOpen],
	["github-pr: closed-not-merged PR -> not merged", testGitHubClosedNotMerged],
	["github-pr: API error fails closed as unknown", testGitHubApiErrorFailsClosed],
	["github-pr: network error fails closed as unknown", testGitHubNetworkErrorFailsClosed],
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
	console.log(`\nAll ${tests.length} merge-check tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
