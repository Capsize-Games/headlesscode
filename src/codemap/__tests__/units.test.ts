/**
 * COV-3: direct unit tests for the codemap's pure/near-pure building blocks
 * that build.test.ts only exercised indirectly through the full buildCodemap
 * pipeline: fingerprint.ts (content hashing + lock comparison), flows.ts
 * (entrypoint-rooted BFS), and files.ts's naming-convention classifiers
 * (languageForExtension, classifyRole, statLines). extract.ts and html.ts
 * already have real fixture-driven coverage in build.test.ts (TS/Python/C++
 * edge extraction and self-contained HTML markup assertions) — this file
 * fills the gap one level down, at the individual function.
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/codemap/__tests__/units.test.ts`.
 */

import assert from "node:assert/strict"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { codemapFingerprint, contentHash, fingerprintMap, lockMatches } from "../fingerprint.js"
import { computeEntrypointFlows } from "../flows.js"
import { classifyRole, languageForExtension, statLines } from "../files.js"
import type { Codemap, CodemapLock, ModuleEntry } from "../types.js"

// ─── fingerprint.ts ──────────────────────────────────────────────────────────

function testContentHashIsDeterministicSha256(): void {
	const a = contentHash("hello world")
	const b = contentHash("hello world")
	assert.equal(a, b, "same content -> same hash")
	assert.match(a, /^[0-9a-f]{64}$/, "sha256 hex digest")
	assert.notEqual(a, contentHash("hello world!"), "different content -> different hash")
}

function testFingerprintMapBuildsPathToHash(): void {
	const map = fingerprintMap([
		{ path: "a.ts", hash: "h1" },
		{ path: "b.ts", hash: "h2" },
	])
	assert.deepEqual(map, { "a.ts": "h1", "b.ts": "h2" })
}

function mkLock(fingerprints: Record<string, string>): CodemapLock {
	return { project: "fixture", fingerprints, codemapFingerprint: "irrelevant-for-lockMatches" }
}

function testLockMatchesDetectsNoChangeVsAnyChange(): void {
	const modules = [
		{ path: "a.ts", hash: "h1" },
		{ path: "b.ts", hash: "h2" },
	]

	assert.equal(lockMatches(mkLock({ "a.ts": "h1", "b.ts": "h2" }), modules), true, "identical key-set and hashes -> match")
	assert.equal(lockMatches(undefined, modules), false, "no lock at all -> never matches")
	assert.equal(lockMatches(mkLock({ "a.ts": "h1", "b.ts": "DIFFERENT" }), modules), false, "a changed hash -> no match")
	assert.equal(
		lockMatches(mkLock({ "a.ts": "h1" }), modules),
		false,
		"a missing/extra key (different key-set size) -> no match",
	)
	assert.equal(
		lockMatches(mkLock({ "a.ts": "h1", "c.ts": "h2" }), modules),
		false,
		"same size but a renamed key -> no match (undefined !== stored value)",
	)
}

function testCodemapFingerprintIsStableAndOrderIndependent(): void {
	const base: Pick<Codemap, "project" | "modules" | "edges" | "externalDeps"> = {
		project: "fixture",
		modules: [
			{ path: "a.ts", language: "typescript", role: "source", sizeBytes: 1, lineCount: 1, hash: "h1" },
			{ path: "b.ts", language: "typescript", role: "source", sizeBytes: 1, lineCount: 1, hash: "h2" },
		] as ModuleEntry[],
		edges: [
			{ from: "a.ts", to: "b.ts", kind: "import", specifier: "./b.js" },
			{ from: "b.ts", to: "a.ts", kind: "import", specifier: "./a.js" },
		] as Codemap["edges"],
		externalDeps: {},
	}
	const fp1 = codemapFingerprint(base)
	const fp2 = codemapFingerprint(base)
	assert.equal(fp1, fp2, "same input -> same fingerprint")
	assert.match(fp1, /^[0-9a-f]{64}$/)

	// Edge ORDER must not matter (fingerprint sorts edges internally).
	const reordered = { ...base, edges: [...base.edges].reverse() }
	assert.equal(codemapFingerprint(reordered), fp1, "edge order must not affect the fingerprint")

	// A module hash change DOES change it.
	const changed = {
		...base,
		modules: base.modules.map((m) => (m.path === "a.ts" ? { ...m, hash: "DIFFERENT" } : m)),
	}
	assert.notEqual(codemapFingerprint(changed), fp1, "a changed module hash must change the fingerprint")
}

// ─── flows.ts ────────────────────────────────────────────────────────────────

function testComputeEntrypointFlowsBfsReachability(): void {
	// cli.ts -> a.ts -> b.ts -> c.ts, and a separate unreachable island d.ts.
	const modules = [
		{ path: "cli.ts", role: "entrypoint" as const },
		{ path: "a.ts", role: "source" as const },
		{ path: "b.ts", role: "source" as const },
		{ path: "c.ts", role: "source" as const },
		{ path: "d.ts", role: "source" as const },
	]
	const edges = [
		{ from: "cli.ts", to: "a.ts" },
		{ from: "a.ts", to: "b.ts" },
		{ from: "b.ts", to: "c.ts" },
	]
	const flows = computeEntrypointFlows(modules, edges)
	assert.deepEqual(Object.keys(flows), ["cli.ts"], "only entrypoints get a flow entry")
	assert.deepEqual(flows["cli.ts"], ["a.ts", "b.ts", "c.ts"], "sorted, transitively reachable set, excluding the entrypoint itself and unreachable d.ts")
}

function testComputeEntrypointFlowsHandlesCyclesWithoutInfiniteLoop(): void {
	const modules = [
		{ path: "main.ts", role: "entrypoint" as const },
		{ path: "a.ts", role: "source" as const },
		{ path: "b.ts", role: "source" as const },
	]
	// a <-> b cycle, both reachable from main.
	const edges = [
		{ from: "main.ts", to: "a.ts" },
		{ from: "a.ts", to: "b.ts" },
		{ from: "b.ts", to: "a.ts" },
	]
	const flows = computeEntrypointFlows(modules, edges)
	assert.deepEqual(flows["main.ts"], ["a.ts", "b.ts"], "a cycle must terminate the BFS, not hang or duplicate")
}

function testComputeEntrypointFlowsIgnoresEdgesOutsideModuleSet(): void {
	const modules = [{ path: "main.ts", role: "entrypoint" as const }]
	const edges = [{ from: "main.ts", to: "not-in-modules.ts" }]
	const flows = computeEntrypointFlows(modules, edges)
	assert.deepEqual(flows["main.ts"], [], "an edge to a module outside the known set must be ignored")
}

// ─── files.ts classifiers ────────────────────────────────────────────────────

function testLanguageForExtension(): void {
	assert.equal(languageForExtension(".ts"), "typescript")
	assert.equal(languageForExtension(".TSX"), "typescript", "case-insensitive")
	assert.equal(languageForExtension(".js"), "javascript")
	assert.equal(languageForExtension(".py"), "python")
	assert.equal(languageForExtension(".cpp"), "cpp")
	assert.equal(languageForExtension(".h"), "c")
	assert.equal(languageForExtension(".rs"), "other", "unrecognized extension falls back to other")
}

function testClassifyRoleNamingConventions(): void {
	assert.equal(classifyRole("src/cli.ts", "typescript"), "entrypoint", "shallow cli.ts is an entrypoint")
	assert.equal(classifyRole("src/codesearch/cli.ts", "typescript"), "source", "a deep cli.ts is a subcommand, not an entrypoint")
	assert.equal(classifyRole("src/foo.test.ts", "typescript"), "test")
	assert.equal(classifyRole("src/foo_test.py", "python"), "test")
	assert.equal(classifyRole("test_foo.py", "python"), "test")
	assert.equal(classifyRole("package.json", "other"), "config")
	assert.equal(classifyRole("node_modules/dep/index.js", "javascript"), "vendor")
	assert.equal(classifyRole("dist/bundle.js", "javascript"), "generated")
	assert.equal(classifyRole("src/types.d.ts", "typescript"), "generated", "declaration files are tagged generated")
	assert.equal(classifyRole("src/index.ts", "typescript"), "entrypoint")
	assert.equal(classifyRole("src/deep/nested/module.ts", "typescript"), "source")
	assert.equal(classifyRole("bin/tool", "other"), "entrypoint", "bin/ prefix is always an entrypoint")
}

async function testStatLinesCountsLinesAndBytes(): Promise<void> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-codemap-statlines-"))
	try {
		// statLines' heuristic: count of '\n' chars, plus 1 for any non-empty
		// file (it does not special-case a trailing newline as "no extra
		// line" — that quirk is the actual, documented behavior being tested).
		const withTrailingNewline = path.join(dir, "a.txt")
		await fsp.writeFile(withTrailingNewline, "one\ntwo\nthree\n", "utf-8")
		const a = statLines(withTrailingNewline)
		assert.equal(a.lineCount, 4, "3 newlines + 1")
		assert.equal(a.sizeBytes, 14)

		const withoutTrailingNewline = path.join(dir, "b.txt")
		await fsp.writeFile(withoutTrailingNewline, "one\ntwo\nthree", "utf-8")
		const b = statLines(withoutTrailingNewline)
		assert.equal(b.lineCount, 3, "2 newlines + 1")

		const empty = path.join(dir, "empty.txt")
		await fsp.writeFile(empty, "", "utf-8")
		assert.equal(statLines(empty).lineCount, 0)

		const missing = statLines(path.join(dir, "does-not-exist.txt"))
		assert.deepEqual(missing, { sizeBytes: 0, lineCount: 0 }, "a missing file degrades to zeros, never throws")
	} finally {
		await fsp.rm(dir, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => void | Promise<void>]> = [
	["fingerprint: contentHash is a deterministic sha256", testContentHashIsDeterministicSha256],
	["fingerprint: fingerprintMap builds path->hash", testFingerprintMapBuildsPathToHash],
	["fingerprint: lockMatches detects no-change vs any change", testLockMatchesDetectsNoChangeVsAnyChange],
	["fingerprint: codemapFingerprint is stable and edge-order-independent", testCodemapFingerprintIsStableAndOrderIndependent],
	["flows: computeEntrypointFlows does transitive BFS reachability", testComputeEntrypointFlowsBfsReachability],
	["flows: a cycle terminates the BFS without hanging or duplicating", testComputeEntrypointFlowsHandlesCyclesWithoutInfiniteLoop],
	["flows: edges outside the known module set are ignored", testComputeEntrypointFlowsIgnoresEdgesOutsideModuleSet],
	["files: languageForExtension maps extensions to language families", testLanguageForExtension],
	["files: classifyRole applies the naming-convention heuristics", testClassifyRoleNamingConventions],
	["files: statLines counts bytes/lines and degrades to zeros on a missing file", testStatLinesCountsLinesAndBytes],
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
	console.log(`\nAll ${tests.length} codemap unit tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
