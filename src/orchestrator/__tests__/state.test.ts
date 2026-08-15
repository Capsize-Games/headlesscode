/**
 * Unit tests for src/orchestrator/state.ts — .orchestrator-state.json
 * read/write/update. Plain assert-based (no framework, no network) matching
 * the repo test style. Run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

import {
	defaultState,
	loadState,
	loadStateSync,
	saveState,
	saveStateSync,
	updateGroup,
	type OrchestratorState,
} from "../state.js"

async function tmpStatePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-state-"))
	return path.join(dir, ".worktrees", ".orchestrator-state.json")
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testSaveLoadRoundTrip(): Promise<void> {
	const p = await tmpStatePath()
	const state: OrchestratorState = {
		batch: "round-test",
		groups: [
			{
				name: "w1",
				worktree: ".worktrees/w1",
				branch: "issues/w1-2026-07-31",
				issues: [27],
				task_file: "plans/parallel-tasks/w1-issue27.md",
				status: "spawned",
				spawned: "2026-07-31T00:00:00Z",
			},
		],
	}
	await saveState(p, state)
	const loaded = await loadState(p)
	assert.equal(loaded.batch, "round-test")
	assert.equal(loaded.groups.length, 1)
	assert.equal(loaded.groups[0].name, "w1")
	assert.equal(loaded.groups[0].status, "spawned")
	assert.ok(loaded.updated, "saveState stamps `updated`")
	assert.ok(loaded.updated !== state.updated)
	// Pretty-printed JSON with trailing newline (readable in a repo).
	const raw = await fs.readFile(p, "utf-8")
	assert.ok(raw.trimEnd().endsWith("}"), "file ends with the JSON document")
}

async function testLoadMissingFileReturnsDefault(): Promise<void> {
	const p = await tmpStatePath()
	const state = await loadState(p)
	assert.deepEqual(state.groups, [])
	assert.equal(state.batch, "unnamed")
}

async function testLoadMalformedShapeIsSanitized(): Promise<void> {
	const p = await tmpStatePath()
	await fs.mkdir(path.dirname(p), { recursive: true })
	await fs.writeFile(p, JSON.stringify({ groups: "not-an-array", updated: 123 }), "utf-8")
	const state = await loadState(p)
	assert.deepEqual(state.groups, [], "non-array groups coerced to []")
}

async function testLoadInvalidJsonThrows(): Promise<void> {
	const p = await tmpStatePath()
	await fs.mkdir(path.dirname(p), { recursive: true })
	await fs.writeFile(p, "{ definitely not json", "utf-8")
	await assert.rejects(() => loadState(p), SyntaxError)
}

async function testUpdateGroupUpsertsAndMerges(): Promise<void> {
	const base: OrchestratorState = {
		batch: "b",
		groups: [{ name: "w1", status: "spawned" }],
	}
	const updated = updateGroup(base, "w1", { status: "running", issues: [27] })
	assert.equal(updated.groups[0].status, "running")
	assert.deepEqual(updated.groups[0].issues, [27])
	// Original state untouched (immutable update).
	assert.equal(base.groups[0].status, "spawned")
	assert.equal(base.groups[0].issues, undefined)

	// Unknown group -> upserted with a default status.
	const added = updateGroup(updated, "w2", { worktree: ".worktrees/w2" })
	assert.equal(added.groups.length, 2)
	assert.equal(added.groups[1].name, "w2")
	assert.equal(added.groups[1].status, "spawned", "new group defaults to spawned")
	assert.ok(typeof added.updated === "string" && added.updated.length > 0, "updated timestamp stamped")
}

async function testSyncVariants(): Promise<void> {
	const p = await tmpStatePath()
	saveStateSync(p, defaultState("sync-batch"))
	const state = loadStateSync(p)
	assert.equal(state.batch, "sync-batch")
	assert.deepEqual(state.groups, [])
}

/** E4: atomic write-to-temp-then-rename leaves no `.tmp-*` residue. */
async function testNoTempResidueAfterAtomicSave(): Promise<void> {
	const p = await tmpStatePath()
	await saveState(p, defaultState("atomic-async"))
	await saveStateSync(p, defaultState("atomic-sync"))

	// The async write's content was replaced by the sync write — the file
	// round-trips the LATEST state, and both writes must have renamed their
	// temp files away cleanly.
	const state = await loadState(p)
	assert.equal(state.batch, "atomic-sync")

	const dirEntries = await fs.readdir(path.dirname(p))
	const leftovers = dirEntries.filter((name) => name.includes(".tmp"))
	assert.deepEqual(leftovers, [], `no temp file may remain after a successful atomic save (found: ${leftovers.join(", ")})`)
}

/** Resolve tsx by walking up ancestor node_modules/.bin/ (same as scripts/run-tests.mjs). */
function resolveTsxBin(dir: string): string {
	let current = dir
	while (true) {
		const candidate = path.join(current, "node_modules", ".bin", "tsx")
		if (fsSync.existsSync(candidate)) {
			return candidate
		}
		const parent = path.dirname(current)
		if (parent === current) {
			throw new Error(`could not find node_modules/.bin/tsx walking up from ${dir}`)
		}
		current = parent
	}
}

function runFixtureProcess(statePath: string, namePrefix: string, count: number): Promise<void> {
	const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
	const fixture = fileURLToPath(new URL("./fixtures/patch-group-worker.mjs", import.meta.url))
	const tsxBin = resolveTsxBin(repoRoot)
	return new Promise((resolve, reject) => {
		const child = spawn(tsxBin, [fixture, statePath, namePrefix, String(count)], { stdio: "inherit" })
		child.on("error", reject)
		child.on("exit", (code) => {
			if (code === 0) {
				resolve()
			} else {
				reject(new Error(`fixture process (${namePrefix}) exited with code ${code}`))
			}
		})
	})
}

/**
 * Issue #43: patchGroup's in-process lock (withStateLock) only serializes
 * callers within ONE Node process — it does nothing for a SECOND, separate
 * `orchestrate` OS process racing the same state file. Proves the fix (a
 * real cross-process lock, acquireCrossProcessLock, via atomic mkdir) by
 * spawning TWO REAL child processes that each create many new, distinctly
 * named groups in the SAME shared state file concurrently. Without the
 * cross-process lock, one process's group-creation write can be silently
 * discarded by the other's stale-read-based save (the classic lost-update
 * race) — this reliably reproduces with real OS-level interleaving across
 * enough concurrent writes, no artificial delay needed.
 */
async function testPatchGroupSurvivesTwoConcurrentProcesses(): Promise<void> {
	const p = await tmpStatePath()
	saveStateSync(p, defaultState("race-test"))

	const COUNT = 150
	await Promise.all([runFixtureProcess(p, "procA", COUNT), runFixtureProcess(p, "procB", COUNT)])

	const finalState = loadStateSync(p)
	const names = new Set(finalState.groups.map((g) => g.name))
	const missing: string[] = []
	for (const prefix of ["procA", "procB"]) {
		for (let i = 0; i < COUNT; i++) {
			const name = `${prefix}-${i}`
			if (!names.has(name)) {
				missing.push(name)
			}
		}
	}
	assert.deepEqual(
		missing,
		[],
		`${missing.length}/${COUNT * 2} group(s) LOST to a cross-process race (no lock protection): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "..." : ""}`,
	)
	assert.equal(finalState.groups.length, COUNT * 2, "no duplicate or extra entries either")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["save/load round-trip preserves group shape", testSaveLoadRoundTrip],
	["missing state file -> default state", testLoadMissingFileReturnsDefault],
	["malformed shape sanitized to groups array", testLoadMalformedShapeIsSanitized],
	["invalid JSON throws", testLoadInvalidJsonThrows],
	["updateGroup upserts by name, merges, immutable", testUpdateGroupUpsertsAndMerges],
	["sync load/save variants", testSyncVariants],
	["atomic save leaves no .tmp residue (async + sync)", testNoTempResidueAfterAtomicSave],
	["patchGroup survives two concurrent OS processes racing the same state file (issue #43)", testPatchGroupSurvivesTwoConcurrentProcesses],
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
	console.log(`\nAll ${tests.length} state tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
