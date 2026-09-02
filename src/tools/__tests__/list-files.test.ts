/**
 * Unit tests for list_files truncation (src/tools/executor.ts's
 * listFilesHandler + collectEntries): the recursive walk stops collecting
 * once MAX_LIST_FILES is exceeded, and small listings stay complete and
 * dirs-first. Plain assert-based script (no test framework), run via
 * `npm test` -> `tsx src/tools/__tests__/list-files.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor, MAX_LIST_FILES } from "../executor.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

// ─── (a) > MAX_LIST_FILES entries → capped listing + trailer, no hang ────────

async function testLargeTreeIsBoundedAndTruncated(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ls-large-")
	try {
		const dir = path.join(ws, "many")
		await fs.mkdir(dir, { recursive: true })
		// 600 files — well over the 500-entry cap. Before the short-circuit this
		// would collect all 600, sort them, and only then truncate.
		for (let i = 0; i < 600; i++) {
			await fs.writeFile(path.join(dir, `f${String(i).padStart(4, "0")}.txt`), "x", "utf-8")
		}

		const executor = createHeadlessExecutor(ws)
		const started = Date.now()
		const result = await executor.execute("list_files", { path: "many", recursive: true })
		const elapsed = Date.now() - started

		assert.equal(result.isError, false, "listing should succeed")
		const lines = result.content.split("\n")
		assert.equal(
			lines.length,
			MAX_LIST_FILES + 1,
			`expected exactly ${MAX_LIST_FILES} entries plus one trailer line, got ${lines.length}`,
		)
		assert.match(
			result.content,
			/File list truncated: 500 entries shown\. Use list_files on specific subdirectories to see more\./,
			"truncation trailer present (total omitted — the walk was stopped)",
		)
		assert.ok(elapsed < 10_000, `bounded walk must complete quickly (took ${elapsed}ms)`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) small tree → complete, dirs-first listing, no trailer ───────────────

async function testSmallTreeIsCompleteDirsFirst(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ls-small-")
	try {
		await fs.mkdir(path.join(ws, "zdir"), { recursive: true })
		await fs.mkdir(path.join(ws, "adir"), { recursive: true })
		await fs.writeFile(path.join(ws, "adir", "file.txt"), "x", "utf-8")
		await fs.writeFile(path.join(ws, "top.txt"), "x", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("list_files", { path: ".", recursive: true })

		assert.equal(result.isError, false, "listing should succeed")
		assert.doesNotMatch(result.content, /File list truncated/, "no trailer for a small tree")
		const lines = result.content.split("\n")
		assert.ok(lines[0].endsWith("/"), "directories come first in a dirs-first listing")
		assert.ok(lines.some((l) => l === "adir/"), "nested dir listed")
		assert.ok(lines.some((l) => l === "zdir/"), "second dir listed")
		assert.ok(lines.some((l) => l === "top.txt"), "top-level file listed")
		assert.ok(lines.some((l) => l === "adir/file.txt"), "nested file listed")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) repeat-call guard: identical call gets a cache-hit notice ONCE ──────
// (never a refusal — see listFilesHandler's doc comment: a hard refusal was
// tried first and verified live 2026-08-20 to be actively harmful, since a
// model that repeats an identical call verbatim after an error burns its
// whole mistake budget refusing the SAME call over and over. This mirrors
// read_file's toldUnchanged cache exactly.)

async function testRepeatListFilesGetsOneCacheHitThenRealListingAgain(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ls-repeat-")
	try {
		await fs.writeFile(path.join(ws, "top.txt"), "x", "utf-8")

		const executor = createHeadlessExecutor(ws)
		const first = await executor.execute("list_files", { path: "." })
		assert.equal(first.isError, false, "first listing succeeds")
		assert.match(first.content, /top\.txt/, "first listing has the real content")

		const repeat = await executor.execute("list_files", { path: "." })
		assert.equal(repeat.isError, false, "identical repeat is NOT an error — never counts as a mistake")
		assert.match(repeat.content, /\[cache\]/, "repeat gets the short cache-hit notice instead of a full re-listing")
		assert.doesNotMatch(repeat.content, /top\.txt/, "cache-hit notice doesn't repeat the full listing")

		const repeatAgain = await executor.execute("list_files", { path: "." })
		assert.equal(repeatAgain.isError, false, "a THIRD identical call succeeds too")
		assert.match(
			repeatAgain.content,
			/top\.txt/,
			"the cache-hit notice never loops forever — a second repeat gets the real listing again",
		)

		const differentArgs = await executor.execute("list_files", { path: ".", recursive: true })
		assert.equal(differentArgs.isError, false, "a call with DIFFERENT args (recursive flipped) is unaffected")
		assert.match(differentArgs.content, /top\.txt/, "different args always get a real listing")

		executor.notifyCondensed()
		const afterCondense = await executor.execute("list_files", { path: "." })
		assert.equal(afterCondense.isError, false, "a call right after condensation always gets a real listing")
		assert.match(afterCondense.content, /top\.txt/, "condensation resets to a real listing, not a cache-hit notice")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// 2026-09-02: same disableReadFileCache option read_file's cache-hit
// short-circuit respects (src/tools/__tests__/read-cache.test.ts) — the
// local backend sets it because the mechanism's own real token-cost
// savings only matter for a remote model's per-token bill, and it directly
// caused a fabricated attempt_completion in a live local session (see that
// file's comment for the full incident).
async function testDisableReadFileCacheAlsoCoversListFiles(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ls-disabled-")
	try {
		await fs.writeFile(path.join(ws, "a.txt"), "x", "utf-8")

		const executor = createHeadlessExecutor(ws, { disableReadFileCache: true })
		const first = await executor.execute("list_files", { path: ".", recursive: false })
		const second = await executor.execute("list_files", { path: ".", recursive: false })

		assert.equal(first.isError, false)
		assert.equal(second.isError, false)
		assert.doesNotMatch(second.content, /\[cache\]/, "disableReadFileCache must also suppress list_files' cache hit")
		assert.match(second.content, /a\.txt/, "second call must return the real listing, not a cache notice")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testFailedListFilesNotRecordedByGuard(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-ls-repeat-fail-")
	try {
		const executor = createHeadlessExecutor(ws)
		const first = await executor.execute("list_files", { path: "does-not-exist" })
		assert.equal(first.isError, true, "listing a missing dir fails")

		const second = await executor.execute("list_files", { path: "does-not-exist" })
		assert.equal(second.isError, true, "still fails")
		assert.doesNotMatch(
			second.content,
			/\[cache\]/,
			"a failed call is retryable — the guard must not mask the real error with a cache-hit notice",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["large tree (>500 entries): listing capped at 500 + trailer, completes quickly", testLargeTreeIsBoundedAndTruncated],
	["small tree: complete dirs-first listing with no trailer", testSmallTreeIsCompleteDirsFirst],
	[
		"repeat identical list_files gets one cache-hit notice, then real listings again",
		testRepeatListFilesGetsOneCacheHitThenRealListingAgain,
	],
	["a failed list_files call is never recorded by the repeat-call guard", testFailedListFilesNotRecordedByGuard],
	["disableReadFileCache also suppresses list_files' cache-hit notice (2026-09-02)", testDisableReadFileCacheAlsoCoversListFiles],
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
	console.log(`\nAll ${tests.length} list-files tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
