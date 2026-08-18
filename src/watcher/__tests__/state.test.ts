/**
 * Unit tests for src/watcher/state.ts — .watcher-state.json read/write and
 * the idempotency semantics (processed vs pending vs failed, write-ahead
 * ordering, restart safety). Plain assert-based (no framework, no network).
 * Run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	defaultWatcherState,
	isProcessed,
	loadWatcherState,
	loadWatcherStateSync,
	markProcessed,
	saveWatcherState,
	saveWatcherStateSync,
	type WatcherIssueEntry,
	type WatcherState,
} from "../state.js"

async function tmpStatePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-watcher-state-"))
	return path.join(dir, ".worktrees", ".watcher-state.json")
}

function entry(partial: Partial<WatcherIssueEntry> = {}): WatcherIssueEntry {
	return {
		number: 27,
		title: "Fix the greet bug",
		label: "needs-agent",
		status: "done",
		updatedAt: "2026-08-01T00:00:00.000Z",
		...partial,
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testSaveLoadRoundTrip(): Promise<void> {
	const p = await tmpStatePath()
	const state: WatcherState = {
		processed: {
			"27": entry({
				number: 27,
				batch: "watcher-2026-08-01",
				groups: [{ name: "w1", issues: [27], taskFile: "w1-issue27.md" }],
				spawnedAt: "2026-08-01T00:00:01.000Z",
				status: "spawned",
			}),
			"28": entry({ number: 28, title: "Decompose models.py", status: "pending" }),
		},
		lastSweep: "2026-08-01T00:00:02.000Z",
	}
	await saveWatcherState(p, state)
	const loaded = await loadWatcherState(p)
	assert.equal(loaded.processed["27"]?.status, "spawned")
	assert.equal(loaded.processed["27"]?.label, "needs-agent")
	assert.deepEqual(loaded.processed["27"]?.groups, [{ name: "w1", issues: [27], taskFile: "w1-issue27.md" }])
	assert.equal(loaded.processed["28"]?.status, "pending")
	assert.equal(loaded.lastSweep, "2026-08-01T00:00:02.000Z")
	assert.ok(loaded.updated, "saveWatcherState stamps `updated`")
}

async function testLoadMissingFileReturnsDefault(): Promise<void> {
	const p = await tmpStatePath()
	const state = await loadWatcherState(p)
	assert.deepEqual(state.processed, {})
	assert.equal(state.updated !== undefined, true)
}

async function testLoadMalformedShapeIsSanitized(): Promise<void> {
	const p = await tmpStatePath()
	await fs.mkdir(path.dirname(p), { recursive: true })
	await fs.writeFile(p, JSON.stringify({ processed: "nope", updated: 123 }), "utf-8")
	const state = await loadWatcherState(p)
	assert.deepEqual(state.processed, {}, "non-object processed coerced to {}")
}

// Issue #78: unlike the orchestrator's state file (the source of truth for
// in-flight work, where a parse error must be loud), watcher state is a
// resumable idempotency cache — a crash-truncated file falls back to a fresh
// default rather than hard-failing the watcher on every subsequent poll.
async function testLoadInvalidJsonFallsBackToDefault(): Promise<void> {
	const p = await tmpStatePath()
	await fs.mkdir(path.dirname(p), { recursive: true })
	await fs.writeFile(p, "{ definitely not json", "utf-8")
	const state = await loadWatcherState(p)
	assert.deepEqual(state.processed, {}, "corrupt file yields a fresh default, not a throw")
}

async function testLoadInvalidJsonFallsBackToDefaultSync(): Promise<void> {
	const p = await tmpStatePath()
	await fs.mkdir(path.dirname(p), { recursive: true })
	await fs.writeFile(p, "{ definitely not json", "utf-8")
	const state = loadWatcherStateSync(p)
	assert.deepEqual(state.processed, {}, "corrupt file yields a fresh default, not a throw")
}

async function testIsProcessedSemantics(): Promise<void> {
	const state = defaultWatcherState()
	assert.equal(isProcessed(state, 27), false, "no entry -> not processed")

	const withPending = markProcessed(state, entry({ number: 27, status: "pending" }))
	assert.equal(isProcessed(withPending, 27), false, "pending -> picked up this sweep")

	const withSpawned = markProcessed(state, entry({ number: 27, status: "spawned" }))
	assert.equal(isProcessed(withSpawned, 27), true, "spawned -> already processed")

	const withDone = markProcessed(state, entry({ number: 28, status: "done" }))
	assert.equal(isProcessed(withDone, 28), true)

	const withSkipped = markProcessed(state, entry({ number: 29, status: "skipped" }))
	assert.equal(isProcessed(withSkipped, 29), true)
}

async function testFailedNotRetriedByDefaultButRetriedWithFlag(): Promise<void> {
	const failed = markProcessed(defaultWatcherState(), entry({ number: 30, status: "failed", error: "boom" }))
	assert.equal(isProcessed(failed, 30), true, "failed -> processed by default (no auto-retry)")
	assert.equal(isProcessed(failed, 30, { retryFailed: true }), false, "failed + retryFailed -> retry next sweep")
}

async function testWriteAheadOrderingEntryVisibleBeforeSpawnStep(): Promise<void> {
	// The watcher's write-ahead contract at the state layer: after
	// markProcessed('spawned') + save, a RELOAD from disk (what the spawn
	// step / a restarted process sees) already contains the entry with
	// status 'spawned' — so a crash between spawn and the final save can
	// never double-spawn.
	const p = await tmpStatePath()
	let state = defaultWatcherState()
	state = markProcessed(state, entry({ number: 27, status: "spawned", spawnedAt: "2026-08-01T00:00:00.000Z" }))
	await saveWatcherState(p, state)

	// The spawn step observes the durable entry BEFORE running:
	const observed = await loadWatcherState(p)
	assert.equal(observed.processed["27"]?.status, "spawned")

	// After the spawn step, the watcher flips it to done:
	state = markProcessed(observed, entry({ number: 27, status: "done" }))
	await saveWatcherState(p, state)
	const final = await loadWatcherState(p)
	assert.equal(final.processed["27"]?.status, "done")
}

async function testLabelRemovedStillProcessed(): Promise<void> {
	// isProcessed keys off the durable entry, NOT the issue's current labels
	// — removing the label from a processed issue must not cause a respawn.
	const p = await tmpStatePath()
	let state = defaultWatcherState()
	state = markProcessed(state, entry({ number: 27, status: "done", label: "needs-agent" }))
	await saveWatcherState(p, state)

	const reloaded = await loadWatcherState(p)
	assert.equal(isProcessed(reloaded, 27), true, "label removed -> still processed")
}

async function testRestartSimulationSkipsProcessed(): Promise<void> {
	// Save with a done + a pending entry; a "restart" (fresh load) must keep
	// the done entry processed and leave the pending one spawnable.
	const p = await tmpStatePath()
	let state = defaultWatcherState()
	state = markProcessed(state, entry({ number: 1, status: "done" }))
	state = markProcessed(state, entry({ number: 2, status: "pending" }))
	await saveWatcherState(p, state)

	const restarted = await loadWatcherState(p)
	assert.equal(isProcessed(restarted, 1), true)
	assert.equal(isProcessed(restarted, 2), false, "pending survives a restart and is still spawnable")
}

async function testMarkProcessedIsImmutable(): Promise<void> {
	const state = defaultWatcherState()
	const next = markProcessed(state, entry({ number: 27, status: "done" }))
	assert.equal(state.processed["27"], undefined, "input state not mutated")
	assert.equal(next.processed["27"]?.number, 27)
	assert.ok(next.updated, "updated timestamp stamped")
}

async function testSyncVariants(): Promise<void> {
	const p = await tmpStatePath()
	saveWatcherStateSync(p, markProcessed(defaultWatcherState(), entry({ number: 1, status: "done" })))
	const state = loadWatcherStateSync(p)
	assert.equal(state.processed["1"]?.status, "done")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["save/load round-trip preserves entries + groups", testSaveLoadRoundTrip],
	["missing state file -> default state", testLoadMissingFileReturnsDefault],
	["malformed shape sanitized to processed {}", testLoadMalformedShapeIsSanitized],
	["invalid JSON falls back to default (async)", testLoadInvalidJsonFallsBackToDefault],
	["invalid JSON falls back to default (sync)", testLoadInvalidJsonFallsBackToDefaultSync],
	["isProcessed semantics (pending spawnable, others processed)", testIsProcessedSemantics],
	["failed is not auto-retried; retryFailed forces it", testFailedNotRetriedByDefaultButRetriedWithFlag],
	["write-ahead: spawned entry is durable before the spawn step", testWriteAheadOrderingEntryVisibleBeforeSpawnStep],
	["label removed -> still processed (no respawn)", testLabelRemovedStillProcessed],
	["restart simulation: done stays processed, pending stays spawnable", testRestartSimulationSkipsProcessed],
	["markProcessed is immutable", testMarkProcessedIsImmutable],
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
	console.log(`\nAll ${tests.length} watcher state tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
