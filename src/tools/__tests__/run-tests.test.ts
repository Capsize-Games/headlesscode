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
import { changedFilesFromGit } from "../run-tests.js"
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

// ─── (e) end-to-end: run a REAL matched test through the handler ─────────────

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

const tests: Array<[string, () => Promise<void>]> = [
	["direct match: src/foo/bar.ts → src/foo/__tests__/bar.test.ts", testDirectMatchSelectsSiblingTest],
	["reverse dependency: 2-hop importer test selected via the real import graph", testReverseDependencySelectsImportingTest],
	["fail-safe: no matching test reports honestly and runs nothing", testNoMatchFailsSafe],
	["git-status fallback inference returns modified + untracked files", testChangedFilesFromGit],
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
