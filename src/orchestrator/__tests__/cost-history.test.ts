/**
 * Unit tests for src/orchestrator/cost-history.ts — the central,
 * append-only cost/token history store. Plain assert-based, no network.
 * Redirects the central store to a temp dir via $HEADLESSCODE_DATA_DIR so
 * no test ever touches the real ~/.local/share/headlesscode. Run via
 * `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import {
	appendCostHistoryRecord,
	readCostHistory,
	recordGroupCost,
	recordAllSessionCosts,
	readSessionCostHistory,
	type CostHistoryRecord,
} from "../cost-history.js"
import type { OrchestratorGroup } from "../state.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tmpRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cost-history-"))
	try {
		execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" })
	} catch {
		execFileSync("git", ["init", "-q", dir], { stdio: "ignore" })
	}
	return dir
}

function baseRecord(overrides: Partial<CostHistoryRecord> = {}): CostHistoryRecord {
	return {
		recordedAt: new Date().toISOString(),
		repo: "/tmp/repo",
		groupName: "w1",
		issues: [27],
		status: "done",
		costUsd: 0.05,
		inputTokens: 1000,
		outputTokens: 100,
		cachedTokens: 500,
		iterations: 30,
		continuationCount: 0,
		reworkCount: 0,
		...overrides,
	}
}

function baseGroup(overrides: Partial<OrchestratorGroup> = {}): OrchestratorGroup {
	return {
		name: "w1",
		status: "done",
		issues: [27, 29],
		shapes: ["split", "docs"],
		branch: "issues/w1-2026-08-05",
		usage: { costUsd: 0.12, inputTokens: 5000, outputTokens: 400, cachedTokens: 2000, iterations: 45 },
		continuationCount: 1,
		reworkCount: 2,
		...overrides,
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testAppendAndReadRoundTrip(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseRecord())
		await appendCostHistoryRecord(repo, baseRecord({ groupName: "w2", issues: [30] }))
		const records = await readCostHistory(repo)
		assert.equal(records.length, 2)
		assert.equal(records[0]?.groupName, "w1")
		assert.equal(records[1]?.groupName, "w2")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReadMissingFileReturnsEmptyArray(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const records = await readCostHistory(repo)
		assert.deepEqual(records, [])
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReadSkipsMalformedLines(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseRecord())
		const { costHistoryFilePath } = await import("../cost-history.js")
		await fs.appendFile(costHistoryFilePath(repo), "not json\n{\"incomplete\":\n", "utf-8")
		await appendCostHistoryRecord(repo, baseRecord({ groupName: "w2" }))
		const records = await readCostHistory(repo)
		assert.equal(records.length, 2, "malformed lines must be skipped, not throw")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRecordGroupCostBuildsCorrectRecord(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const group = baseGroup()
		const record = await recordGroupCost(repo, group)
		assert.ok(record)
		assert.deepEqual(record?.issues, [27, 29], "must carry EVERY issue the group covered, not just one")
		assert.deepEqual(record?.shapes, ["split", "docs"], "must carry the per-issue shapes (issue #16) — the cost estimator's match key")
		assert.equal(record?.costUsd, 0.12)
		assert.equal(record?.inputTokens, 5000)
		assert.equal(record?.continuationCount, 1)
		assert.equal(record?.reworkCount, 2)
		assert.equal(record?.branch, "issues/w1-2026-08-05")

		const stored = await readCostHistory(repo)
		assert.equal(stored.length, 1)
		assert.equal(stored[0]?.groupName, "w1")
		assert.deepEqual(stored[0]?.shapes, ["split", "docs"], "shapes survive the write/read round trip")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRecordGroupCostSkipsWhenNoUsage(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const group = baseGroup({ usage: undefined })
		const record = await recordGroupCost(repo, group)
		assert.equal(record, undefined, "a group with no usage has nothing meaningful to record")
		const stored = await readCostHistory(repo)
		assert.equal(stored.length, 0, "nothing should be written to disk either")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRecordGroupCostDefaultsMissingIssuesAndCachedTokens(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const group = baseGroup({
			issues: undefined,
			shapes: undefined,
			usage: { costUsd: 0.01, inputTokens: 100, outputTokens: 10, iterations: 5 },
		})
		const record = await recordGroupCost(repo, group)
		assert.deepEqual(record?.issues, [], "missing issues defaults to an empty array, never undefined/throw")
		assert.equal(record?.cachedTokens, 0, "missing cachedTokens defaults to 0")
		assert.equal(record?.shapes, undefined, "a group without shapes records none (pre-#16 groups stay shapeless)")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

/**
 * wallClockMs must reflect the TRUE first-session start, not group.spawned
 * — handleReviewVerdict/handleIterationExhaustion's reset patches
 * explicitly overwrite group.spawned with "now" on every rework/
 * continuation respawn (so the stall guard measures the current attempt),
 * which would otherwise under-report total dispatch-to-completion time to
 * just the FINAL cycle, hiding exactly the wasted time an extra
 * bug-triggered cycle adds.
 */
async function testRecordGroupCostComputesWallClockFromEarliestSession(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeUsageFile(repo, "w1", "session-original", {
			sessionId: "session-original",
			mode: "code",
			model: "deepseek/deepseek-v4-flash",
			iterations: 40,
			inputTokens: 1000,
			outputTokens: 100,
			costUsd: 0.02,
			startedAt: "2026-08-05T10:00:00.000Z",
			endedAt: "2026-08-05T10:30:00.000Z",
			status: "error",
		})
		await writeUsageFile(repo, "w1", "session-rework", {
			sessionId: "session-rework",
			mode: "code",
			model: "deepseek/deepseek-v4-flash",
			iterations: 20,
			inputTokens: 500,
			outputTokens: 50,
			costUsd: 0.01,
			startedAt: "2026-08-05T11:00:00.000Z",
			endedAt: "2026-08-05T11:15:00.000Z",
			status: "success",
		})
		// group.spawned reflects only the LATEST respawn (reset by the rework
		// patch) — must NOT be what wallClockMs is computed from.
		const group = baseGroup({
			worktree: ".worktrees/w1",
			spawned: "2026-08-05T11:00:00.000Z",
			usage: { costUsd: 0.03, inputTokens: 1500, outputTokens: 150, cachedTokens: 0, iterations: 60 },
		})
		const record = await recordGroupCost(repo, group)
		assert.ok(record)
		assert.equal(record?.spawnedAt, "2026-08-05T10:00:00.000Z", "must use the EARLIEST session's start, not group.spawned")
		assert.ok(record?.wallClockMs && record.wallClockMs > 60 * 60 * 1000, "wall-clock must span from the original session, over an hour, not just the final 15-minute rework")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRecordGroupCostFallsBackToGroupSpawnedWithNoUsageFiles(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const group = baseGroup({ worktree: ".worktrees/w1", spawned: "2026-08-05T10:00:00.000Z" })
		const record = await recordGroupCost(repo, group)
		assert.equal(record?.spawnedAt, "2026-08-05T10:00:00.000Z")
		assert.ok(typeof record?.wallClockMs === "number")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── recordAllSessionCosts: per-session outcome tracking ────────────────────

async function writeUsageFile(repo: string, groupName: string, sessionId: string, record: object): Promise<void> {
	const dir = path.join(repo, ".worktrees", groupName, ".headlesscode", "usage")
	await fs.mkdir(dir, { recursive: true })
	await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`, "utf-8")
}

async function writeLiveFile(repo: string, groupName: string, sessionId: string, record: object): Promise<void> {
	const dir = path.join(repo, ".worktrees", groupName, ".headlesscode", "usage")
	await fs.mkdir(dir, { recursive: true })
	await fs.writeFile(path.join(dir, `${sessionId}.live.json`), JSON.stringify(record), "utf-8")
}

async function testRecordAllSessionCostsClassifiesSuccessErrorAndKilled(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeUsageFile(repo, "w1", "session-ok", {
			sessionId: "session-ok",
			mode: "code",
			model: "deepseek/deepseek-v4-flash",
			iterations: 10,
			inputTokens: 1000,
			outputTokens: 100,
			cachedTokens: 500,
			costUsd: 0.01,
			startedAt: "2026-08-05T00:00:00.000Z",
			endedAt: "2026-08-05T00:05:00.000Z",
			status: "success",
		})
		await writeUsageFile(repo, "w1", "session-errored", {
			sessionId: "session-errored",
			mode: "deepseek-reviewer",
			model: "deepseek/deepseek-v4-flash",
			iterations: 40,
			inputTokens: 500,
			outputTokens: 50,
			costUsd: 0.005,
			startedAt: "2026-08-05T00:10:00.000Z",
			endedAt: "2026-08-05T00:15:00.000Z",
			status: "error",
		})
		// A live snapshot with NO corresponding completed .jsonl — the process
		// was killed/crashed before recordUsage()/removeLiveSnapshot() ran.
		await writeLiveFile(repo, "w1", "session-killed", {
			sessionId: "session-killed",
			mode: "code",
			model: "deepseek/deepseek-v4-flash",
			iterations: 3,
			inputTokens: 200,
			outputTokens: 20,
			costUsd: 0.002,
			startedAt: "2026-08-05T00:20:00.000Z",
			status: "running",
		})

		const group = baseGroup({ worktree: ".worktrees/w1" })
		const recorded = await recordAllSessionCosts(repo, group)
		assert.equal(recorded.length, 3)

		const bySession = new Map(recorded.map((r) => [r.sessionId, r]))
		assert.equal(bySession.get("session-ok")?.status, "success")
		assert.equal(bySession.get("session-errored")?.status, "error")
		assert.equal(bySession.get("session-killed")?.status, "killed")
		assert.equal(bySession.get("session-killed")?.costUsd, 0.002, "a killed session's LAST-known cost is still captured, not lost")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRecordAllSessionCostsIsIdempotent(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeUsageFile(repo, "w1", "session-a", {
			sessionId: "session-a",
			mode: "code",
			model: "deepseek/deepseek-v4-flash",
			iterations: 5,
			inputTokens: 100,
			outputTokens: 10,
			costUsd: 0.001,
			startedAt: "2026-08-05T00:00:00.000Z",
			endedAt: "2026-08-05T00:01:00.000Z",
			status: "success",
		})
		const group = baseGroup({ worktree: ".worktrees/w1" })
		const first = await recordAllSessionCosts(repo, group)
		assert.equal(first.length, 1)
		const second = await recordAllSessionCosts(repo, group)
		assert.equal(second.length, 0, "an already-recorded session must never be re-recorded")

		const all = await readSessionCostHistory(repo)
		assert.equal(all.length, 1, "exactly one record on disk despite calling recordAllSessionCosts twice")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testLiveSnapshotIgnoredWhenCompletedRecordExists(): Promise<void> {
	// A stale .live.json left over from before the FINAL write (a normal
	// artifact of the writeLiveSnapshot -> recordUsage -> removeLiveSnapshot
	// sequence racing with a crash-recovery read) must not be misclassified
	// as "killed" when a real completed .jsonl for the SAME session exists.
	const repo = await tmpRepo()
	try {
		await writeUsageFile(repo, "w1", "session-both", {
			sessionId: "session-both",
			mode: "code",
			model: "deepseek/deepseek-v4-flash",
			iterations: 10,
			inputTokens: 1000,
			outputTokens: 100,
			costUsd: 0.01,
			startedAt: "2026-08-05T00:00:00.000Z",
			endedAt: "2026-08-05T00:05:00.000Z",
			status: "success",
		})
		await writeLiveFile(repo, "w1", "session-both", {
			sessionId: "session-both",
			mode: "code",
			model: "deepseek/deepseek-v4-flash",
			iterations: 9,
			inputTokens: 900,
			outputTokens: 90,
			costUsd: 0.009,
			startedAt: "2026-08-05T00:00:00.000Z",
			status: "running",
		})
		const group = baseGroup({ worktree: ".worktrees/w1" })
		const recorded = await recordAllSessionCosts(repo, group)
		assert.equal(recorded.length, 1, "only the completed record counts, not a stale live snapshot for the same session")
		assert.equal(recorded[0]?.status, "success")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRecordAllSessionCostsNoUsageDirReturnsEmpty(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const group = baseGroup({ worktree: ".worktrees/w1" })
		const recorded = await recordAllSessionCosts(repo, group)
		assert.deepEqual(recorded, [])
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: [string, () => Promise<void>][] = [
	["append + read round-trip", testAppendAndReadRoundTrip],
	["read missing file -> empty array", testReadMissingFileReturnsEmptyArray],
	["read skips malformed lines", testReadSkipsMalformedLines],
	["recordGroupCost builds a correct record from a terminal group", testRecordGroupCostBuildsCorrectRecord],
	["recordGroupCost returns undefined + writes nothing when group has no usage", testRecordGroupCostSkipsWhenNoUsage],
	["recordGroupCost defaults missing issues/cachedTokens", testRecordGroupCostDefaultsMissingIssuesAndCachedTokens],
	["recordGroupCost computes wallClockMs from the earliest session, not group.spawned", testRecordGroupCostComputesWallClockFromEarliestSession],
	["recordGroupCost falls back to group.spawned with no usage files", testRecordGroupCostFallsBackToGroupSpawnedWithNoUsageFiles],
	["recordAllSessionCosts classifies success/error/killed", testRecordAllSessionCostsClassifiesSuccessErrorAndKilled],
	["recordAllSessionCosts is idempotent", testRecordAllSessionCostsIsIdempotent],
	["stale live snapshot ignored when a completed record exists for the same session", testLiveSnapshotIgnoredWhenCompletedRecordExists],
	["recordAllSessionCosts with no usage dir returns empty", testRecordAllSessionCostsNoUsageDirReturnsEmpty],
]

async function main(): Promise<void> {
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cost-history-store-"))
	process.env.HEADLESSCODE_DATA_DIR = storeTmp
	let failed = 0
	try {
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
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fs.rm(storeTmp, { recursive: true, force: true })
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} cost-history tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
