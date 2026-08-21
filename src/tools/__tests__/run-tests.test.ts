/**
 * Unit tests for the `run_tests` tool and its selection heuristic
 * (src/tools/test-selection.ts + src/tools/run-tests.ts).
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/tools/__tests__/run-tests.test.ts`.
 *
 * Covers the three required behaviors:
 *   - the direct match: `src/foo/bar.ts` → `src/foo/__tests__/bar.test.ts`;
 *   - the reverse-dependency match through the REAL import graph (a test that
 *     imports a helper which imports the changed file — the 2-hop case);
 *   - the fail-safe: a change with no matching test reports "no specific
 *     tests matched" instead of silently running zero tests.
 * Plus one end-to-end execution against THIS repo's own workspace (tsx is a
 * devDependency here, so the `npx --no-install tsx` spawn actually works).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../executor.js"
import { getCodeIntelCache, resetCodeIntelCaches } from "../../codeintel/program.js"
import { changedFilesFromGit, runOneTestFile } from "../run-tests.js"
import { directTestMatch, isTestFile, selectTestsForChangedFiles } from "../test-selection.js"

const FIXTURE_TSCONFIG = JSON.stringify(
	{
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "bundler",
			strict: true,
		},
		include: ["src"],
	},
	null,
	2,
)

async function mkWorkspace(prefix: string): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	await fs.writeFile(path.join(ws, "tsconfig.json"), FIXTURE_TSCONFIG)
	return ws
}

async function loadIntel(ws: string) {
	resetCodeIntelCaches()
	return getCodeIntelCache(ws).get()
}

// ─── (a) direct match ────────────────────────────────────────────────────────

async function testDirectMatchSelectsSiblingTest(): Promise<void> {
	const ws = await mkWorkspace("hc-rt-direct-")
	try {
		await fs.mkdir(path.join(ws, "src", "foo"), { recursive: true })
		await fs.mkdir(path.join(ws, "src", "foo", "__tests__"), { recursive: true })
		await fs.writeFile(path.join(ws, "src", "foo", "bar.ts"), "export const bar = 1\n")
		await fs.writeFile(path.join(ws, "src", "foo", "__tests__", "bar.test.ts"), 'import assert from "node:assert/strict"\nassert.equal(1, 1)\n')

		assert.equal(directTestMatch("src/foo/bar.ts"), "src/foo/__tests__/bar.test.ts", "direct match maps the sibling test")
		assert.equal(directTestMatch("src/foo/bar.tsx"), "src/foo/__tests__/bar.test.ts", "tsx source maps to .test.ts")
		assert.equal(directTestMatch("package.json"), undefined, "non-source files have no direct test")
		assert.equal(directTestMatch("src/foo/__tests__/bar.test.ts"), undefined, "a test file never maps onto a sibling")

		const intel = await loadIntel(ws)
		const { tests, notes } = selectTestsForChangedFiles(intel, ws, ["src/foo/bar.ts"])
		assert.deepEqual(tests, ["src/foo/__tests__/bar.test.ts"], "the direct sibling test is selected")
		assert.ok(notes.some((n) => n.startsWith("direct:")), "selection notes say why")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) reverse-dependency match through the real import graph ──────────────

async function testReverseDependencySelectsImportingTest(): Promise<void> {
	const ws = await mkWorkspace("hc-rt-revdep-")
	try {
		await fs.mkdir(path.join(ws, "src", "lib", "__tests__"), { recursive: true })
		// util.ts is the CHANGED file. helper.ts imports it; helper.test.ts
		// imports helper — so the test is 2 hops away from the change.
		await fs.writeFile(path.join(ws, "src", "lib", "util.ts"), "export const util = 1\n")
		await fs.writeFile(path.join(ws, "src", "lib", "helper.ts"), 'import { util } from "./util.js"\nexport const helper = util + 1\n')
		await fs.writeFile(
			path.join(ws, "src", "lib", "__tests__", "helper.test.ts"),
			'import { helper } from "../helper.js"\nimport assert from "node:assert/strict"\nassert.equal(helper, 2)\n',
		)

		const intel = await loadIntel(ws)
		const { tests } = selectTestsForChangedFiles(intel, ws, ["src/lib/util.ts"])
		assert.deepEqual(
			tests,
			["src/lib/__tests__/helper.test.ts"],
			"the 2-hop importer test is selected via the real import graph",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) fail-safe: no match reports honestly, runs nothing ─────────────────

async function testNoMatchFailsSafe(): Promise<void> {
	const ws = await mkWorkspace("hc-rt-nomatch-")
	try {
		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("run_tests", { paths: ["package.json"], timeout: 30 })

		assert.equal(result.isError, true, "running zero tests must NOT be a silent pass")
		assert.match(result.content, /no specific tests matched/, "the fail-safe names the situation")
		assert.match(result.content, /full suite/, "it points at the full suite as the alternative")
		assert.doesNotMatch(result.content, /passed/i, "nothing may claim a pass")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d) git-status fallback inference ───────────────────────────────────────

async function testChangedFilesFromGit(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rt-git-"))
	try {
		const { execFileSync } = await import("node:child_process")
		try {
			execFileSync("git", ["--version"], { stdio: "ignore" })
		} catch {
			console.log("  skip git-status test (git not installed)")
			return
		}
		execFileSync("git", ["init", "-q"], { cwd: ws })
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: ws })
		execFileSync("git", ["config", "user.name", "Test"], { cwd: ws })
		await fs.writeFile(path.join(ws, "tracked.txt"), "v1\n")
		execFileSync("git", ["add", "tracked.txt"], { cwd: ws })
		execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: ws })
		// Untracked files are ignored by the initial status... no wait — they
		// ARE reported by --untracked-files=all. Assert BOTH show up.
		await fs.writeFile(path.join(ws, "tracked.txt"), "v2\n")
		await fs.writeFile(path.join(ws, "new.txt"), "new\n")

		const changed = changedFilesFromGit(ws)
		assert.ok(changed.includes("tracked.txt"), "modified tracked file is inferred")
		assert.ok(changed.includes("new.txt"), "untracked file is inferred (it may need its own test)")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (e) security regression (issue #62): hostile test-path selection ────────
//
// Test paths are untrusted input (workspace file names). The old
// implementation interpolated them into a `shell: true` command string via a
// double-quote wrapper that escaped `"` but NOT `$`/backticks — so a file
// named like `x$(cmd).test.ts` ran `cmd` via command substitution. The fix
// passes the path as a separate spawn ARGV element with `shell: false`; the
// assertions below prove a hostile name neither executes anything nor breaks
// out of the tool's output framing.

async function testHostileTestPathIsNotExecuted(): Promise<void> {
	const ws = await mkWorkspace("hc-rt-hostile-")
	try {
		await fs.mkdir(path.join(ws, "src", "__tests__"), { recursive: true })
		// A real test file whose NAME carries command substitution + newline +
		// backticks (the audit's exact attack). If the old shellQuote path were
		// still in use, the `$()` here would execute `touch` inside the
		// workspace (or `echo` a marker into the tool result).
		const hostile = 'x$(touch PWNED).test.ts`echo PWNED2`\nsecondline'
		await fs.writeFile(path.join(ws, "src", "__tests__", hostile), 'import assert from "node:assert/strict"\nassert.equal(1, 1)\n')

		resetCodeIntelCaches()
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("run_tests", { paths: ["src/lib/util.ts"], timeout: 60 })

		// The selection heuristic finds the direct sibling of a changed file;
		// a hostile file that isn't a sibling is NOT selected, so assert the
		// fail-safe fires (nothing ran, nothing executed).
		assert.equal(result.isError, true, "a changed file with no test must fail safe, not run a hostile path")
		assert.match(result.content, /no specific tests matched/, "no test was selected, so no hostile path ran")

		// Now select the hostile file DIRECTLY (it IS a test file): the newline
		// is rejected outright (output-injection defense), and the `$()`/
		// backticks in the remainder are passed as a literal argv element, so
		// they must never be interpreted by a shell.
		const direct = await executor.execute("run_tests", { paths: [`src/__tests__/${hostile}`], timeout: 60 })
		assert.equal(direct.isError, true, "a newline-containing test path must be refused, not run")
		assert.match(direct.content, /contains a newline/, "the refusal names the reason")

		// A hostile name WITHOUT the newline but with `$()` + backticks (the
		// issue #62 attack shape) must be passed through as ONE literal argv
		// element. tsx's module loader itself chokes on backticks in a file
		// name (`ERR_UNKNOWN_FILE_EXTENSION .ts%60...%60`) and npx may or may
		// not resolve a local tsx at all, so asserting "runs green" would
		// conflate those unrelated failures with the security property — the
		// assertions below check the property that matters: the metacharacters
		// were NEVER interpreted (no PWNED2 marker in the output, no PWNED
		// file, no hang).
		const hostileNoNewline = "x$(touch PWNED).test.ts`echo PWNED2`"
		await fs.writeFile(path.join(ws, "src", "__tests__", hostileNoNewline), 'import assert from "node:assert/strict"\nassert.equal(1, 1)\n')
		const direct2 = await executor.execute("run_tests", { paths: [`src/__tests__/${hostileNoNewline}`], timeout: 60 })
		// The path appears VERBATIM in the selection header (metacharacters
		// intact — they were never interpreted).
		assert.match(
			direct2.content,
			new RegExp(escapeRegExp(`src/__tests__/${hostileNoNewline}`)),
			"the literal hostile path was selected and reported verbatim",
		)
		// Whatever npx/tsx did with the file, `$()`/backticks must never
		// EXECUTE. A prior version of this check stripped the literal path
		// from `direct2.content` and looked for a bare "PWNED2" in what was
		// left — unreliable (issue #156): Node's own ERR_UNKNOWN_FILE_EXTENSION
		// error text embeds a SEPARATE, percent-encoded fragment of the
		// hostile filename (`.ts%60echo%20PWNED2%60`) that no amount of
		// stripping the literal path string accounts for, since it comes
		// from Node's internal error formatting, not this tool's own report.
		// A REAL `echo PWNED2` would print "PWNED2" as a standalone line —
		// check for THAT specific shape instead of a bare substring match.
		assert.doesNotMatch(direct2.content, /(?:^|\n)PWNED2(?:\r?\n|$)/, "no executed backtick/`$()` output (a standalone PWNED2 line)")

		// Direct proof at the spawn boundary (no tsx extension-resolution
		// noise): the hostile name must be delivered to the child as ONE
		// literal argv element — backticks/`$()`/spaces are never re-parsed.
		const spawned = await runOneTestFile(ws, `src/__tests__/${hostileNoNewline}`, 60)
		// A bare `.includes("PWNED2")` also false-positives (issue #156): the
		// SAME Node ERR_UNKNOWN_FILE_EXTENSION crash embeds "PWNED2" inside a
		// percent-encoded fragment of the bad extension
		// (`.ts%60echo%20PWNED2%60`), which legitimately appears in
		// `spawned.output` too — that crash is expected, correct behavior
		// (tsx refusing to load a garbage-extension file), not evidence of
		// execution. A REAL `echo PWNED2` would print "PWNED2" as a
		// standalone line with nothing else on it — check for THAT specific
		// shape instead of a bare substring match.
		const hasMarker = /(?:^|\n)PWNED2(?:\r?\n|$)/.test(spawned.output)
		assert.equal(
			hasMarker,
			false,
			`shell metacharacters in the path must never be interpreted: ${spawned.output.slice(0, 300)}`,
		)
		assert.equal(spawned.timedOut, false, "no hang (a shell waiting on a substituted command would time out)")

		// Control: the hostile run did NOT hang (timedOut stays false) — a
		// shell that had interpreted `$()`/backticks as commands to run would
		// still be waiting on them. (A green run is NOT asserted for the
		// hostile path: npx cannot resolve a local tsx in a node_modules-less
		// temp workspace — that's an environment artifact, not the security
		// property under test. The existing end-to-end test asserts the same
		// argv spawn machinery runs a REAL test green in the real workspace.)

		// No side-effect file was created by `$()`/backticks — the true proof
		// nothing was executed through a shell.
		let pwned = false
		try {
			await fs.access(path.join(ws, "PWNED"))
			pwned = true
		} catch {
			// not created — good
		}
		assert.equal(pwned, false, "`$(touch PWNED)` in the test filename must NOT execute")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (f) end-to-end: run a REAL matched test through the handler ─────────────

async function testEndToEndRunsMatchedTest(): Promise<void> {
	// The repo root is the only workspace with tsx installed (devDependency),
	// so run the full selection+execution path against THIS repo: change
	// src/codeintel/rename-symbol.ts → the handler must select its direct
	// sibling test and run it to green through `npx --no-install tsx`.
	const ws = process.cwd()
	resetCodeIntelCaches()
	const executor = createHeadlessExecutor(ws)
	const result = await executor.execute("run_tests", {
		paths: ["src/codeintel/rename-symbol.ts"],
		timeout: 120,
	})

	assert.equal(result.isError, false, `matched test should pass: ${result.content.slice(0, 2000)}`)
	assert.match(result.content, /src\/codeintel\/__tests__\/rename-symbol\.test\.ts/, "the direct sibling test was selected")
	assert.match(result.content, /All 4 rename_symbol tests passed/, "the tsx run actually executed the test file")
	assert.match(result.content, /full-suite green/, "the selective-pass caveat is stated")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/** Escape a string for use inside a RegExp (literal matching). */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const tests: Array<[string, () => Promise<void>]> = [
	["direct match: src/foo/bar.ts → src/foo/__tests__/bar.test.ts", testDirectMatchSelectsSiblingTest],
	["reverse dependency: 2-hop importer test selected via the real import graph", testReverseDependencySelectsImportingTest],
	["fail-safe: no matching test reports honestly and runs nothing", testNoMatchFailsSafe],
	["git-status fallback inference returns modified + untracked files", testChangedFilesFromGit],
	["security: hostile test path (`$()`, backticks, newline) is never shell-interpreted", testHostileTestPathIsNotExecuted],
	["end-to-end: selects and runs a real matched test via tsx", testEndToEndRunsMatchedTest],
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
	console.log(`\nAll ${tests.length} run_tests tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
