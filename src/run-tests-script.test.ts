/**
 * Tests for scripts/run-tests.mjs — the glob-based test runner (issue #26)
 * and its filter argument (issue #4: `npm test -- <pattern>` must work as a
 * bare positional arg, not just `--filter <pattern>`).
 *
 * Shells out to the REAL script against a small, fast, deterministic filter
 * (matching a single quick test file) so this test itself stays quick rather
 * than re-running the full ~99-file suite.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const SCRIPT = path.join(REPO_ROOT, "scripts", "run-tests.mjs")

function run(args: string[]): string {
	return execFileSync("node", [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf-8" })
}

async function testBarePositionalArgFilters(): Promise<void> {
	const out = run(["spawn-state-reset"])
	assert.match(out, /running 1 file\(s\)/, `bare positional arg should filter to exactly one file, got:\n${out}`)
	assert.match(out, /spawn-state-reset tests passed/)
	assert.match(out, /all 1 file\(s\) passed/)
}

async function testExplicitFilterFlagStillWorks(): Promise<void> {
	const out = run(["--filter", "spawn-state-reset"])
	assert.match(out, /running 1 file\(s\)/, `--filter flag should behave identically to the bare arg, got:\n${out}`)
	assert.match(out, /all 1 file\(s\) passed/)
}

async function testNoMatchExitsNonZeroWithClearMessage(): Promise<void> {
	assert.throws(
		() => run(["this-pattern-matches-nothing-xyz"]),
		(err: unknown) => {
			const message = err instanceof Error ? String((err as { stdout?: unknown }).stdout ?? "") + err.message : String(err)
			return /no test files matched/.test(message)
		},
		"a filter matching zero files must exit non-zero with a clear message",
	)
}

const tests: Array<[string, () => Promise<void>]> = [
	["bare positional arg filters like `npm test -- <pattern>` (issue #4)", testBarePositionalArgFilters],
	["explicit --filter flag still works", testExplicitFilterFlagStillWorks],
	["filter matching nothing exits non-zero with a clear message", testNoMatchExitsNonZeroWithClearMessage],
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
	console.log(`\nAll ${tests.length} run-tests-script tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
