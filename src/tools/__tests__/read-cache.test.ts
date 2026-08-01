/**
 * Unit tests for the session-scoped read_file cache (src/tools/executor.ts).
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/tools/__tests__/read-cache.test.ts`.
 *
 * The cache short-circuits a read_file whose effective args AND on-disk
 * content hash are identical to a prior call in the SAME session, returning a
 * short "[cache] ..." message instead of the full content. It is exercised
 * through the REAL readFileHandler (via createHeadlessExecutor /
 * createReadOnlyHeadlessExecutor), not a mock.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor, createReadOnlyHeadlessExecutor } from "../executor.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function isCacheHit(result: { content: string; isError: boolean }): boolean {
	return !result.isError && result.content.startsWith("[cache]")
}

// ─── (a) two identical reads in a row → first real, second cache-hit ────────

async function testSecondIdenticalReadIsCacheHit(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-readcache-identical-")
	try {
		const file = path.join(ws, "data.txt")
		const content = "line one\nline two\nline three\n"
		await fs.writeFile(file, content, "utf-8")

		const executor = createHeadlessExecutor(ws)
		const first = await executor.execute("read_file", { path: "data.txt" })
		const second = await executor.execute("read_file", { path: "data.txt" })

		assert.equal(first.isError, false, "first read should succeed")
		assert.match(first.content, /File: data\.txt/, "first read should return real content")
		assert.ok(first.content.includes("line two"), "first read should contain the file body")
		assert.equal(second.isError, false, "cache hit is informational, not an error")
		assert.ok(isCacheHit(second), `second read should be a cache hit, got: ${second.content.slice(0, 120)}`)
		assert.ok(!second.content.includes("line two"), "cache hit must not re-send the file body")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) three identical reads → real, hit, REAL again (no forever-loop) ────

async function testThirdIdenticalReadServesRealContentAgain(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-readcache-three-")
	try {
		const file = path.join(ws, "data.txt")
		const content = "alpha\nbeta\ngamma\n"
		await fs.writeFile(file, content, "utf-8")

		const executor = createHeadlessExecutor(ws)
		const first = await executor.execute("read_file", { path: "data.txt" })
		const second = await executor.execute("read_file", { path: "data.txt" })
		const third = await executor.execute("read_file", { path: "data.txt" })

		assert.ok(!isCacheHit(first), "first read is real content")
		assert.ok(isCacheHit(second), "second read is the cache-hit short-circuit")
		assert.equal(third.isError, false, "third read should succeed")
		assert.ok(!isCacheHit(third), "third read must serve real content again (no cache-hit loop)")
		assert.ok(third.content.includes("File: data.txt") && third.content.includes("beta"), "third read re-sends the body")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) out-of-band file change → hash-check catches it, fresh content ─────

async function testOutOfBandChangeInvalidatesCache(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-readcache-oob-")
	try {
		const file = path.join(ws, "build.txt")
		const original = "before\n"
		await fs.writeFile(file, original, "utf-8")

		const executor = createHeadlessExecutor(ws)
		const first = await executor.execute("read_file", { path: "build.txt" })
		assert.ok(!isCacheHit(first), "first read is real content")

		// Simulate an out-of-band change (e.g. a build/codegen step the
		// executor never sees as a tool call).
		await fs.writeFile(file, "after\n", "utf-8")

		const second = await executor.execute("read_file", { path: "build.txt" })
		assert.equal(second.isError, false, "re-read after a real change should succeed")
		assert.ok(!isCacheHit(second), "content changed on disk, so NO cache hit")
		assert.ok(second.content.includes("after"), "re-read returns the fresh content")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d) different offset/limit → never a cache hit even for same path ──────

async function testDifferentOffsetOrLimitIsNotCacheHit(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-readcache-offset-")
	try {
		const file = path.join(ws, "pages.txt")
		await fs.writeFile(file, "l1\nl2\nl3\nl4\nl5\nl6\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const a = await executor.execute("read_file", { path: "pages.txt", offset: 1, limit: 3 })
		const b = await executor.execute("read_file", { path: "pages.txt", offset: 4, limit: 3 })

		assert.ok(!isCacheHit(a), "first slice is real content")
		assert.ok(!isCacheHit(b), "different offset must NOT be a cache hit")
		assert.ok(a.content.includes("l1"), "first slice shows lines 1-3")
		assert.ok(b.content.includes("l4"), "second slice shows lines 4-6")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (e) write_to_file on the path → hash-check invalidates correctly ───────

async function testEditThenReadReturnsFreshContent(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-readcache-edit-")
	try {
		const file = path.join(ws, "edit.txt")
		await fs.writeFile(file, "old content\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const first = await executor.execute("read_file", { path: "edit.txt" })
		assert.ok(!isCacheHit(first), "first read is real content")

		// Normal edit path: write_to_file changes the file.
		const write = await executor.execute("write_to_file", { path: "edit.txt", content: "brand new\n" })
		assert.equal(write.isError, false, "write_to_file should succeed")

		const second = await executor.execute("read_file", { path: "edit.txt" })
		assert.equal(second.isError, false, "re-read after an edit should succeed")
		assert.ok(!isCacheHit(second), "content changed via write_to_file, so NO cache hit")
		assert.ok(second.content.includes("brand new"), "re-read returns the edited content")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (f) two independent executors (two sessions) → no cross-instance hits ───

async function testNoCacheHitAcrossExecutors(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-readcache-isolated-")
	try {
		const file = path.join(ws, "shared.txt")
		await fs.writeFile(file, "shared content\n", "utf-8")

		// Simulate two separate sessions (reviewer/QA executor included).
		const execA = createHeadlessExecutor(ws)
		const execB = createHeadlessExecutor(ws)
		const execReadOnly = createReadOnlyHeadlessExecutor(ws)

		const a1 = await execA.execute("read_file", { path: "shared.txt" })
		const b1 = await execB.execute("read_file", { path: "shared.txt" })
		const ro1 = await execReadOnly.execute("read_file", { path: "shared.txt" })

		assert.ok(!isCacheHit(a1), "first session read is real content")
		assert.ok(!isCacheHit(b1), "a DIFFERENT session must get real content, not a cross-instance cache hit")
		assert.ok(!isCacheHit(ro1), "the read-only executor must also get real content")
		for (const r of [a1, b1, ro1]) {
			assert.ok(r.content.includes("shared content"), "each executor sees the file body")
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (g) slice vs indentation mode on the same path → never a cache hit ─────

async function testSliceVsIndentationIsNotCacheHit(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-readcache-mode-")
	try {
		const file = path.join(ws, "code.ts")
		const content = [
			"import assert from 'node:assert'",
			"",
			"export function greet(name: string): string {",
			"    return 'Hello, ' + name",
			"}",
			"",
			"// trailing",
			"",
		].join("\n")
		await fs.writeFile(file, content + "\n", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const slice = await executor.execute("read_file", { path: "code.ts" })
		const indentation = await executor.execute("read_file", {
			path: "code.ts",
			mode: "indentation",
			indentation: { anchor_line: 3 },
		})

		assert.ok(!isCacheHit(slice), "slice read is real content")
		assert.ok(!isCacheHit(indentation), "a different mode must NOT be a cache hit for the same path")
		assert.ok(slice.content.includes("import assert"), "slice read shows the header")
		assert.ok(indentation.content.includes("Hello, ' + name"), "indentation read shows the anchor window")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["two identical reads: first real, second short cache-hit (not error)", testSecondIdenticalReadIsCacheHit],
	["three identical reads: real, hit, real again (no forever loop)", testThirdIdenticalReadServesRealContentAgain],
	["out-of-band on-disk change: hash-check catches it, fresh content", testOutOfBandChangeInvalidatesCache],
	["different offset/limit on same path: never a cache hit", testDifferentOffsetOrLimitIsNotCacheHit],
	["write_to_file then read: edit path invalidates via hash-check", testEditThenReadReturnsFreshContent],
	["two independent executors (sessions): no cross-instance cache", testNoCacheHitAcrossExecutors],
	["slice vs indentation mode on same path: never a cache hit", testSliceVsIndentationIsNotCacheHit],
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
	console.log(`\nAll ${tests.length} read-cache tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
