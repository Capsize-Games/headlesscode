/**
 * Unit tests for the `push-pr` CLI subcommand — argument parsing, usage/help
 * text, and exit-code behavior (0 success / 1 runtime / 2 usage-config),
 * following the project convention. pushPrMain's git/API seams are injected
 * fakes; the src/cli.ts dispatch is tested for real (routes `push-pr` to
 * pushPrMain, which then fails on missing App credentials — proving the
 * routing without needing network). Plain assert-based, run via `npm test`.
 */

import assert from "node:assert/strict"

import type { createAppAuthClient } from "../app-auth.js"
import { parsePushPrArgs, pushPrMain, type PushPrDeps } from "../cli.js"

/** The token used for API calls in these tests (fake — never a real one). */
const FAKE_TOKEN = "ghs_TESTTOKEN1234567890"

interface RecordedCalls {
	pushArgs?: Record<string, unknown>
	openPrArgs?: Record<string, unknown>
	defaultBranchCalls: number
	out: string[]
	err: string[]
}

function fakeDeps(): { deps: PushPrDeps; calls: RecordedCalls } {
	const calls: RecordedCalls = { defaultBranchCalls: 0, out: [], err: [] }
	const deps: PushPrDeps = {
		buildClient: () =>
			({
				getInstallationToken: async () => FAKE_TOKEN,
			}) as unknown as ReturnType<typeof createAppAuthClient>,
		pushBranch: async (o) => {
			calls.pushArgs = { ...o }
		},
		openPullRequest: async (o) => {
			calls.openPrArgs = { ...o }
			return { number: 7, url: "https://github.com/octo/hello/pull/7" }
		},
		getRepoDefaultBranch: async () => {
			calls.defaultBranchCalls++
			return "main"
		},
		stdout: (t) => calls.out.push(t),
		stderr: (t) => calls.err.push(t),
	}
	return { deps, calls }
}

const FULL_ARGS = [
	"--installation-id",
	"123",
	"--owner",
	"octo",
	"--repo",
	"hello",
	"--local-dir",
	"/work/hello",
	"--branch",
	"feature-x",
	"--title",
	"Add feature",
	"--body",
	"Closes #1",
]

// ─── parsePushPrArgs ─────────────────────────────────────────────────────────

async function testParseEqualsAndSpaceForms(): Promise<void> {
	const eq = parsePushPrArgs([
		"--installation-id=123",
		"--owner=octo",
		"--repo=hello",
		"--local-dir=/work/hello",
		"--branch=feature-x",
		"--title=Add feature",
		"--body=Closes #1",
		"--base=main",
	])
	assert.equal(eq.error, undefined)
	assert.deepEqual(eq.options, {
		installationId: "123",
		owner: "octo",
		repo: "hello",
		localDir: "/work/hello",
		branch: "feature-x",
		title: "Add feature",
		body: "Closes #1",
		base: "main",
		help: false,
	})

	const space = parsePushPrArgs([...FULL_ARGS, "--base", "develop"])
	assert.equal(space.error, undefined)
	assert.equal(space.options.base, "develop")
	assert.equal(space.options.title, "Add feature")
}

async function testParseErrors(): Promise<void> {
	const missingValue = parsePushPrArgs(["--branch"])
	assert.match(missingValue.error ?? "", /Missing value for --branch/)

	const unknown = parsePushPrArgs(["--frobnicate"])
	assert.match(unknown.error ?? "", /Unknown push-pr argument: --frobnicate/)

	const help = parsePushPrArgs(["--help"])
	assert.equal(help.error, undefined)
	assert.equal(help.options.help, true)
}

// ─── pushPrMain exit codes ───────────────────────────────────────────────────

async function testHelpPrintsUsageAndExitsZero(): Promise<void> {
	const { deps, calls } = fakeDeps()
	const code = await pushPrMain(["--help"], deps)
	assert.equal(code, 0)
	assert.ok(calls.out.join("").includes("headlesscode push-pr"), "help text goes to stdout")
	assert.ok(calls.out.join("").includes("--local-dir <path>"))
}

async function testMissingRequiredArgsExitsTwo(): Promise<void> {
	const { deps, calls } = fakeDeps()
	const code = await pushPrMain(["--owner", "octo"], deps)
	assert.equal(code, 2)
	const errText = calls.err.join("")
	assert.match(errText, /--installation-id, --owner, --repo, --local-dir, --branch/)
	assert.ok(errText.includes("Usage:"))
}

async function testFullSuccessFlow(): Promise<void> {
	const { deps, calls } = fakeDeps()
	const code = await pushPrMain(FULL_ARGS, deps)
	assert.equal(code, 0)
	assert.ok(calls.out.join("").includes("PR #7: https://github.com/octo/hello/pull/7\n"))
	// Push ran with the named branch, PR opened from it into the RESOLVED base.
	assert.equal(calls.pushArgs?.branchName, "feature-x")
	assert.equal(calls.openPrArgs?.head, "feature-x")
	assert.equal(calls.openPrArgs?.base, "main")
	assert.equal(calls.defaultBranchCalls, 1, "base was resolved from the repo API")
	// The getToken seam is the shared client for both the push and the PR.
	await (calls.pushArgs?.getToken as () => Promise<string>)()
}

async function testExplicitBaseSkipsDefaultBranchLookup(): Promise<void> {
	const { deps, calls } = fakeDeps()
	const code = await pushPrMain([...FULL_ARGS, "--base", "develop"], deps)
	assert.equal(code, 0)
	assert.equal(calls.defaultBranchCalls, 0, "explicit --base must skip the repo API lookup")
	assert.equal(calls.openPrArgs?.base, "develop")
}

async function testRefusesBranchEqualToDefault(): Promise<void> {
	const { deps, calls } = fakeDeps()
	const code = await pushPrMain([...FULL_ARGS.slice(0, 9), "main", ...FULL_ARGS.slice(10)], deps) // --branch main
	assert.equal(code, 2)
	assert.match(calls.err.join(""), /refusing to push 'main' — it IS the repo's default branch/)
	assert.equal(calls.pushArgs, undefined, "must refuse BEFORE pushing")
	assert.equal(calls.openPrArgs, undefined)
}

async function testRuntimeFailureExitsOne(): Promise<void> {
	const { deps, calls } = fakeDeps()
	deps.openPullRequest = async () => {
		throw new Error("nothing to merge: No commits between main and feature-x")
	}
	const code = await pushPrMain(FULL_ARGS, deps)
	assert.equal(code, 1)
	assert.match(calls.err.join(""), /headlesscode push-pr: nothing to merge/)
}

async function testConfigFailureExitsTwo(): Promise<void> {
	const { deps, calls } = fakeDeps()
	deps.buildClient = () => {
		throw new Error("GITHUB_APP_ID is not set (see docs/github-app-setup.md)")
	}
	const code = await pushPrMain(FULL_ARGS, deps)
	assert.equal(code, 2)
	assert.match(calls.err.join(""), /GITHUB_APP_ID is not set/)
}

// ─── src/cli.ts dispatch (real) ──────────────────────────────────────────────

async function testCliMainDispatchesPushPr(): Promise<void> {
	// Imported lazily so the heavy engine imports only load for this one test.
	const { main } = await import("../../cli.js")

	const writes: string[] = []
	const origWrite = process.stderr.write.bind(process.stderr)
	process.stderr.write = ((chunk: unknown) => {
		writes.push(String(chunk))
		return true
	}) as typeof process.stderr.write

	// Make sure the test env cannot accidentally satisfy App credentials.
	const hadAppId = process.env.GITHUB_APP_ID
	delete process.env.GITHUB_APP_ID
	const hadKey = process.env.GITHUB_APP_PRIVATE_KEY
	delete process.env.GITHUB_APP_PRIVATE_KEY
	const hadKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH
	delete process.env.GITHUB_APP_PRIVATE_KEY_PATH

	try {
		const code = await main(["push-pr", ...FULL_ARGS])
		assert.equal(code, 2, "routing to pushPrMain must hit the App-credentials config check (exit 2)")
		const errText = writes.join("")
		assert.match(errText, /headlesscode push-pr: GITHUB_APP_ID is not set/)
	} finally {
		process.stderr.write = origWrite
		if (hadAppId !== undefined) process.env.GITHUB_APP_ID = hadAppId
		if (hadKey !== undefined) process.env.GITHUB_APP_PRIVATE_KEY = hadKey
		if (hadKeyPath !== undefined) process.env.GITHUB_APP_PRIVATE_KEY_PATH = hadKeyPath
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["parsePushPrArgs accepts both --flag=value and --flag value forms", testParseEqualsAndSpaceForms],
	["parsePushPrArgs reports missing values and unknown flags", testParseErrors],
	["--help prints usage and exits 0", testHelpPrintsUsageAndExitsZero],
	["missing required args exit 2 with usage text", testMissingRequiredArgsExitsTwo],
	["full success flow exits 0, prints PR #n: url, resolves base", testFullSuccessFlow],
	["explicit --base skips the default-branch lookup", testExplicitBaseSkipsDefaultBranchLookup],
	["refuses --branch equal to the default branch (exit 2, no push)", testRefusesBranchEqualToDefault],
	["runtime failure exits 1", testRuntimeFailureExitsOne],
	["config failure exits 2", testConfigFailureExitsTwo],
	["src/cli.ts main() dispatches push-pr to pushPrMain", testCliMainDispatchesPushPr],
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
	console.log(`\nAll ${tests.length} push-pr CLI tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
