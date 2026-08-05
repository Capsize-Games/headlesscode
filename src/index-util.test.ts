/**
 * Smoke test for the codebase-index detection contract used by the
 * spawn-parallel-worktrees scripts and HeadlessSession's read-only-nudge
 * guardrail.
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/index-util.test.ts`. The index now lives in the
 * CENTRAL per-project data store (src/project-store.ts), keyed by the repo's
 * git-common-dir so worktrees share it — these tests pin the
 * detection helpers against that store, redirecting it to a temp dir via
 * $HEADLESSCODE_DATA_DIR so no test touches the real home directory.
 */

import assert from "node:assert/strict"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { hasCodebaseIndex, indexFilePathFor } from "./index-util.js"
import { migrateLegacyProjectData, projectStoreRoot, resolveProjectDataDir, resolveProjectIdentity } from "./project-store.js"

async function mkTmp(prefix: string): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function testAbsentIndexIsDetected(): Promise<void> {
	const data = await mkTmp("hc-idxutil-data-")
	const ws = await mkTmp("hc-idxutil-absent-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		assert.equal(await hasCodebaseIndex(ws), false, "no index file → not indexed")
		assert.ok(
			indexFilePathFor(ws).startsWith(projectStoreRoot() + path.sep),
			"index path lives under the central store, not the workspace",
		)
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testEmptyIndexIsTreatedAsAbsent(): Promise<void> {
	const data = await mkTmp("hc-idxutil-data2-")
	const ws = await mkTmp("hc-idxutil-empty-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		// Empty file = crashed/partial build — must be treated as absent so a
		// worker never starts from a guaranteed-broken index.
		await fsp.mkdir(path.dirname(indexFilePathFor(ws)), { recursive: true })
		await fsp.writeFile(indexFilePathFor(ws), "")
		assert.equal(await hasCodebaseIndex(ws), false, "empty index file is not usable")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testRealIndexIsDetected(): Promise<void> {
	const data = await mkTmp("hc-idxutil-data3-")
	const ws = await mkTmp("hc-idxutil-real-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		await fsp.mkdir(path.dirname(indexFilePathFor(ws)), { recursive: true })
		// Content is irrelevant to detection (any non-empty file counts — the
		// reader-side loose validation in src/codesearch/index.ts is a
		// separate concern from "is there a usable index at all").
		await fsp.writeFile(indexFilePathFor(ws), '{"file":"a.ts","startLine":1,"endLine":2}\n')
		assert.equal(await hasCodebaseIndex(ws), true, "non-empty index file is usable")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

async function testLegacyWorkspaceIndexIsMigratedOnFirstResolution(): Promise<void> {
	const data = await mkTmp("hc-idxutil-data4-")
	const ws = await mkTmp("hc-idxutil-legacy-")
	process.env.HEADLESSCODE_DATA_DIR = data
	try {
		// Old-style workspace-relative index: resolution + migration must land
		// it in the central store (so a fresh worktree/session never starts
		// "not indexed" and never forces a costly re-embed). NOTE: the AUTO
		// migration is skipped under a HEADLESSCODE_DATA_DIR override (tests
		// must never move real data), so the explicit migrateLegacyProjectData
		// — the function both the real-machine auto path and the `headlesscode
		// migrate` subcommand call — is exercised directly; hasCodebaseIndex's
		// pre-migration-grace legacy read is what makes detection correct
		// before that happens.
		await fsp.mkdir(path.join(ws, ".headlesscode", "codesearch"), { recursive: true })
		await fsp.writeFile(path.join(ws, ".headlesscode", "codesearch", "index.jsonl"), "legacy-line\n")
		assert.equal(await hasCodebaseIndex(ws), true, "legacy index is detected as usable (pre-migration grace)")
		const identity = resolveProjectIdentity(ws)
		migrateLegacyProjectData(ws, identity.keySource, resolveProjectDataDir(ws), { log: () => {} })
		assert.equal(
			await fsp
				.stat(path.join(ws, ".headlesscode", "codesearch", "index.jsonl"))
				.then(() => true)
				.catch(() => false),
			false,
			"legacy index source moved out of the workspace after migration",
		)
		assert.equal(
			await fsp.readFile(indexFilePathFor(ws), "utf-8"),
			"legacy-line\n",
			"legacy index content lands in the central store",
		)
		assert.equal(await hasCodebaseIndex(ws), true, "detection still true once the central copy exists")
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fsp.rm(data, { recursive: true, force: true })
		await fsp.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["absent index → not indexed (central path)", testAbsentIndexIsDetected],
	["empty index file → treated as absent (partial build)", testEmptyIndexIsTreatedAsAbsent],
	["real index → usable", testRealIndexIsDetected],
	["legacy workspace .headlesscode index migrates on first resolution", testLegacyWorkspaceIndexIsMigratedOnFirstResolution],
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
