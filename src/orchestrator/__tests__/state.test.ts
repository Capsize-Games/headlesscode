/**
 * Unit tests for src/orchestrator/state.ts — .orchestrator-state.json
 * read/write/update. Plain assert-based (no framework, no network) matching
 * the repo test style. Run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

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

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["save/load round-trip preserves group shape", testSaveLoadRoundTrip],
	["missing state file -> default state", testLoadMissingFileReturnsDefault],
	["malformed shape sanitized to groups array", testLoadMalformedShapeIsSanitized],
	["invalid JSON throws", testLoadInvalidJsonThrows],
	["updateGroup upserts by name, merges, immutable", testUpdateGroupUpsertsAndMerges],
	["sync load/save variants", testSyncVariants],
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
