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
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url))
const SCRIPT = path.join(REPO_ROOT, "scripts", "run-tests.mjs")

function run(args: string[]): string {
	return execFileSync("node", [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf-8" })
}

/**
 * Issue #32 regression: run-tests.mjs used to hardcode
 * `repoRoot/node_modules/.bin/tsx` — repoRoot being the WORKTREE's own root,
 * which has no node_modules of its own (not git-tracked, never installed
 * there). Every OTHER `npx tsx ...` call in this codebase works fine inside
 * a worktree because npx/Node's own module resolution walks UP through
 * ancestor directories to find the main checkout's node_modules (a worktree
 * is a filesystem CHILD of the main checkout) — the hardcoded absolute path
 * bypassed that walk-up entirely. Verifies against a REAL, freshly created
 * `git worktree` nested under `.worktrees/` (matching this repo's own
 * convention) with zero node_modules of its own.
 */
async function testResolvesTsxViaWalkUpInABareWorktree(): Promise<void> {
	const wtName = `run-tests-nm-check-${Date.now()}`
	const wtPath = path.join(REPO_ROOT, ".worktrees", wtName)
	execFileSync("git", ["worktree", "add", "-q", wtPath, "HEAD", "--detach"], { cwd: REPO_ROOT })
	try {
		assert.ok(!fs.existsSync(path.join(wtPath, "node_modules")), "fixture worktree must have no node_modules of its own")
		const out = execFileSync("node", [path.join(wtPath, "scripts", "run-tests.mjs"), "spawn-state-reset"], {
			cwd: wtPath,
			encoding: "utf-8",
		})
		assert.match(out, /all 1 file\(s\) passed/, `expected the test to run via walk-up resolution, got:\n${out}`)
	} finally {
		execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: REPO_ROOT })
	}
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

/**
 * BUG-14 regression: `--help` starts with `--`, so the old bareArg lookup
 * (`find((a) => !a.startsWith("--"))`) skipped it entirely, leaving `filter`
 * undefined and running the ENTIRE suite (116+ files) instead of printing
 * usage. `-h` hit the same gap for a different reason (no bareArg match
 * either, since it doesn't look like a real filter but wasn't special-cased).
 * Both must now print usage and exit 0 WITHOUT running any test file.
 */
async function testHelpFlagPrintsUsageAndExitsWithoutRunningTests(): Promise<void> {
	for (const flag of ["--help", "-h"]) {
		const out = run([flag])
		assert.match(out, /Usage: node scripts\/run-tests\.mjs/, `${flag}: expected usage text, got:\n${out}`)
		assert.doesNotMatch(out, /running \d+ file\(s\)/, `${flag}: must NOT run any test files, got:\n${out}`)
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["bare positional arg filters like `npm test -- <pattern>` (issue #4)", testBarePositionalArgFilters],
	["explicit --filter flag still works", testExplicitFilterFlagStillWorks],
	["filter matching nothing exits non-zero with a clear message", testNoMatchExitsNonZeroWithClearMessage],
	["resolves tsx via ancestor walk-up in a bare worktree with no node_modules (issue #32)", testResolvesTsxViaWalkUpInABareWorktree],
	["--help / -h print usage and exit 0 without running the suite (BUG-14)", testHelpFlagPrintsUsageAndExitsWithoutRunningTests],
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
