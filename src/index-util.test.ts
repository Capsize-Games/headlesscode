/**
 * Smoke test for the fresh-worktree codebase-index seeding contract
 * (scripts/spawn-parallel-worktrees.sh / -gui.sh).
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/index-util.test.ts`. It exercises the real
 * index-detection helpers (src/index-util.ts) with a real fixture
 * directory + index file, mirroring what the spawner does to decide
 * whether a fresh worktree already has a usable index.
 *
 * The spawner scripts themselves are bash; this test pins their
 * contract — the helpers they call — so a regression in "does a fresh
 * worktree have an index" logic fails here rather than silently
 * restarting every worker at "not indexed".
 */

import assert from "node:assert/strict"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { checkAndNoteHeadlesscodeDir, hasCodebaseIndex, indexFilePathFor } from "./index-util.js"
import { INDEX_RELATIVE_PATH } from "./codesearch/types.js"

async function mkTmp(prefix: string): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function testAbsentIndexIsDetected(): Promise<void> {
	const ws = await mkTmp("hc-idxutil-absent-")
	try {
		assert.equal(await hasCodebaseIndex(ws), false, "no index file → not indexed")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testEmptyIndexIsTreatedAsAbsent(): Promise<void> {
	const ws = await mkTmp("hc-idxutil-empty-")
	try {
		// Empty file = crashed/partial build — must be treated as absent so a
		// worker never starts from a guaranteed-broken index.
		await fsp.mkdir(path.join(ws, ".headlesscode", "codesearch"), { recursive: true })
		await fsp.writeFile(indexFilePathFor(ws), "")
		assert.equal(await hasCodebaseIndex(ws), false, "empty index file is not usable")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testRealIndexIsDetected(): Promise<void> {
	const ws = await mkTmp("hc-idxutil-real-")
	try {
		await fsp.mkdir(path.join(ws, ".headlesscode", "codesearch"), { recursive: true })
		// Content is irrelevant to detection (any non-empty file counts — the
		// reader-side loose validation in src/codesearch/index.ts is a
		// separate concern from "is there a usable index at all").
		await fsp.writeFile(indexFilePathFor(ws), '{"file":"a.ts","startLine":1,"endLine":2}\n')
		assert.equal(await hasCodebaseIndex(ws), true, "non-empty index file is usable")
		assert.equal(
			indexFilePathFor(ws),
			path.join(path.resolve(ws), INDEX_RELATIVE_PATH),
			"index path matches the documented relative location",
		)
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

const NOTE = "This workspace has no `.headlesscode/` directory"

async function testHeadlesscodeDirNotePrintedWhenAbsent(): Promise<void> {
	const ws = await mkTmp("hc-idxutil-note-")
	try {
		const lines: string[] = []
		checkAndNoteHeadlesscodeDir(ws, (line) => lines.push(line))
		assert.equal(lines.length, 1, "exactly one note line when `.headlesscode/` is absent")
		assert.ok(lines[0].includes(NOTE), "note explains per-workspace state vs ~/.headlesscode/")
		assert.ok(lines[0].includes("~/.headlesscode/"), "note distinguishes the global checkpoints dir")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testHeadlesscodeDirNoteSilentWhenPresent(): Promise<void> {
	const ws = await mkTmp("hc-idxutil-note2-")
	try {
		await fsp.mkdir(path.join(ws, ".headlesscode"), { recursive: true })
		const lines: string[] = []
		checkAndNoteHeadlesscodeDir(ws, (line) => lines.push(line))
		assert.equal(lines.length, 0, "no note once `.headlesscode/` exists")
	} finally {
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["absent index → not indexed", testAbsentIndexIsDetected],
	["empty index file → treated as absent (partial build)", testEmptyIndexIsTreatedAsAbsent],
	["real index → usable, at the documented path", testRealIndexIsDetected],
	["P1.7: `.headlesscode/` note printed when the dir is absent", testHeadlesscodeDirNotePrintedWhenAbsent],
	["P1.7: `.headlesscode/` note silent when the dir exists", testHeadlesscodeDirNoteSilentWhenPresent],
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
	console.log(`\nAll ${tests.length} index-util smoke tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
