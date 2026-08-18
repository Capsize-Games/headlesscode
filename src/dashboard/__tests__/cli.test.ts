/**
 * COV-5: smoke-level tests for `headlesscode dashboard` (src/dashboard/cli.ts)
 * and `headlesscode trend` (src/dashboard/trend-cli.ts) — no coverage
 * anywhere before this file (the OTHER CLIs in this repo are e2e-covered).
 *
 * Scope note: dashboardMain/trendMain's SUCCESSFUL-start-then-SIGINT path
 * already has real, thorough coverage in sigint-shutdown.test.ts (spawns the
 * actual CLI as a child process, delivers a real OS SIGINT, asserts the port
 * is released). This file covers the other exit paths that file doesn't:
 * arg parsing, --help, and the validation-error branches that return before
 * ever starting a server — reusing the pattern from
 * src/orchestrator/__tests__/cli.test.ts (call the exported *Main(argv) entry
 * point in-process, assert the exit code / stdout / stderr).
 *
 * Plain assert-based script (no test framework), run via `npm test`.
 */

import assert from "node:assert/strict"

import { dashboardMain, parseDashboardArgs } from "../cli.js"
import { parseTrendArgs, trendMain } from "../trend-cli.js"

/** Capture stdout+stderr written during `fn()`. */
async function captureOutput(fn: () => Promise<number>): Promise<{ exit: number; stdout: string; stderr: string }> {
	const origOut = process.stdout.write.bind(process.stdout)
	const origErr = process.stderr.write.bind(process.stderr)
	let stdout = ""
	let stderr = ""
	process.stdout.write = ((chunk: unknown): boolean => {
		stdout += String(chunk)
		return true
	}) as typeof process.stdout.write
	process.stderr.write = ((chunk: unknown): boolean => {
		stderr += String(chunk)
		return true
	}) as typeof process.stderr.write
	try {
		const exit = await fn()
		return { exit, stdout, stderr }
	} finally {
		process.stdout.write = origOut
		process.stderr.write = origErr
	}
}

// ─── dashboard: parseDashboardArgs ──────────────────────────────────────────

function testParseDashboardArgsDefaults(): void {
	const { options, error } = parseDashboardArgs([])
	assert.equal(error, undefined)
	assert.equal(options.repo, undefined)
	assert.ok(Number.isInteger(options.port) && options.port > 0)
}

function testParseDashboardArgsPortAndRepo(): void {
	const { options, error } = parseDashboardArgs(["--port", "5555", "--repo", "/tmp/x"])
	assert.equal(error, undefined)
	assert.equal(options.port, 5555)
	assert.equal(options.repo, "/tmp/x")
}

function testParseDashboardArgsRejectsBadPort(): void {
	assert.match(parseDashboardArgs(["--port", "0"]).error ?? "", /--port requires/)
	assert.match(parseDashboardArgs(["--port", "70000"]).error ?? "", /--port requires/)
	assert.match(parseDashboardArgs(["--port", "abc"]).error ?? "", /--port requires/)
}

function testParseDashboardArgsRejectsUnknownFlag(): void {
	assert.match(parseDashboardArgs(["--nope"]).error ?? "", /Unknown argument/)
}

// ─── dashboard: dashboardMain (paths that return before starting a server) ──

async function testDashboardMainHelpExitsZero(): Promise<void> {
	const { exit, stdout } = await captureOutput(() => dashboardMain(["--help"]))
	assert.equal(exit, 0)
	assert.match(stdout, /headlesscode dashboard/)
}

async function testDashboardMainBadArgExitsTwo(): Promise<void> {
	const { exit, stderr } = await captureOutput(() => dashboardMain(["--port", "-1"]))
	assert.equal(exit, 2)
	assert.match(stderr, /--port requires/)
}

// ─── trend: parseTrendArgs ───────────────────────────────────────────────────

function testParseTrendArgsCollectsMultipleRepos(): void {
	const { options, error } = parseTrendArgs(["--repo", "/tmp/a", "--repo", "/tmp/b"])
	assert.equal(error, undefined)
	assert.deepEqual(options.repos, ["/tmp/a", "/tmp/b"])
}

function testParseTrendArgsRejectsBadPort(): void {
	assert.match(parseTrendArgs(["--repo", "/tmp/a", "--port", "-5"]).error ?? "", /--port requires/)
}

function testParseTrendArgsRejectsUnknownFlag(): void {
	assert.match(parseTrendArgs(["--nope"]).error ?? "", /Unknown argument/)
}

// ─── trend: trendMain (paths that return before starting a server) ──────────

async function testTrendMainHelpExitsZero(): Promise<void> {
	const { exit, stdout } = await captureOutput(() => trendMain(["--help"]))
	assert.equal(exit, 0)
	assert.match(stdout, /headlesscode trend/)
}

async function testTrendMainRequiresAtLeastOneRepoExitsTwo(): Promise<void> {
	const { exit, stderr } = await captureOutput(() => trendMain([]))
	assert.equal(exit, 2)
	assert.match(stderr, /at least one --repo is required/)
}

async function testTrendMainBadArgExitsTwo(): Promise<void> {
	const { exit, stderr } = await captureOutput(() => trendMain(["--bogus"]))
	assert.equal(exit, 2)
	assert.match(stderr, /Unknown argument/)
}

const tests: Array<[string, () => void | Promise<void>]> = [
	["dashboard: parseDashboardArgs applies sane defaults", testParseDashboardArgsDefaults],
	["dashboard: parseDashboardArgs reads --port/--repo", testParseDashboardArgsPortAndRepo],
	["dashboard: parseDashboardArgs rejects an out-of-range/non-numeric port", testParseDashboardArgsRejectsBadPort],
	["dashboard: parseDashboardArgs rejects an unknown flag", testParseDashboardArgsRejectsUnknownFlag],
	["dashboard: dashboardMain --help exits 0 and prints usage", testDashboardMainHelpExitsZero],
	["dashboard: dashboardMain with a bad arg exits 2 without starting a server", testDashboardMainBadArgExitsTwo],
	["trend: parseTrendArgs collects multiple --repo flags", testParseTrendArgsCollectsMultipleRepos],
	["trend: parseTrendArgs rejects a bad port", testParseTrendArgsRejectsBadPort],
	["trend: parseTrendArgs rejects an unknown flag", testParseTrendArgsRejectsUnknownFlag],
	["trend: trendMain --help exits 0 and prints usage", testTrendMainHelpExitsZero],
	["trend: trendMain with zero --repo exits 2 without starting a server", testTrendMainRequiresAtLeastOneRepoExitsTwo],
	["trend: trendMain with a bad arg exits 2", testTrendMainBadArgExitsTwo],
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
	console.log(`\nAll ${tests.length} dashboard/trend CLI tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
