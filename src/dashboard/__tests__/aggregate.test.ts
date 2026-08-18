/**
 * Unit tests for src/dashboard/aggregate.ts — the pure aggregation logic
 * behind `GET /api/summary`. Plain assert-based script (no test framework,
 * no network, no HTTP server), run via `npm test` ->
 * `tsx src/dashboard/__tests__/aggregate.test.ts`.
 *
 * Uses fixture `.jsonl` usage files + a fixture `.orchestrator-state.json`
 * written to a real temp dir (matches this project's other fixture-based
 * tests, e.g. src/checkpoints/__tests__/service.test.ts).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { buildSummary, sumSessions } from "../aggregate.js"
import type { LiveUsageRecord, UsageRecord } from "../../engine/usage.js"
import { saveState, type OrchestratorState } from "../../orchestrator/state.js"

async function tmpRepo(prefix = "hc-dashboard-"): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		sessionId: "session-1",
		mode: "code",
		model: "deepseek/deepseek-chat",
		iterations: 3,
		inputTokens: 1000,
		outputTokens: 500,
		costUsd: 0.001,
		startedAt: "2026-08-01T00:00:00.000Z",
		endedAt: "2026-08-01T00:01:00.000Z",
		status: "success",
		workspaceRoot: "/tmp/whatever",
		...overrides,
	}
}

async function writeUsageFile(dir: string, sessionId: string, records: UsageRecord[]): Promise<void> {
	await fs.mkdir(dir, { recursive: true })
	const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n"
	await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines, "utf-8")
}

function liveRecord(overrides: Partial<LiveUsageRecord> = {}): LiveUsageRecord {
	return {
		sessionId: "session-live",
		mode: "code",
		model: "deepseek/deepseek-chat",
		iterations: 2,
		inputTokens: 400,
		outputTokens: 200,
		costUsd: 0.0005,
		startedAt: "2026-08-01T00:10:00.000Z",
		status: "running",
		workspaceRoot: "/tmp/whatever",
		...overrides,
	}
}

async function writeLiveFile(dir: string, sessionId: string, live: LiveUsageRecord): Promise<void> {
	await fs.mkdir(dir, { recursive: true })
	await fs.writeFile(path.join(dir, `${sessionId}.live.json`), JSON.stringify(live), "utf-8")
}

// ─── buildSummary: no repo ──────────────────────────────────────────────────

async function testNoRepoYieldsEmptySummary(): Promise<void> {
	const summary = await buildSummary(undefined)
	assert.deepEqual(summary.sessions, [])
	assert.equal(summary.totals.sessionCount, 0)
	assert.equal(summary.repo, undefined)
	assert.equal(summary.round, undefined)
}

// ─── buildSummary: direct repo usage dir ────────────────────────────────────

async function testSingleSessionSummedCorrectly(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeUsageFile(path.join(repo, ".headlesscode", "usage"), "session-1", [record()])

		const summary = await buildSummary(repo)
		assert.equal(summary.sessions.length, 1)
		assert.equal(summary.sessions[0].sessionId, "session-1")
		assert.equal(summary.sessions[0].source, ".")
		assert.equal(summary.totals.sessionCount, 1)
		assert.ok(Math.abs(summary.totals.costUsd - 0.001) < 1e-9)
		assert.equal(summary.totals.inputTokens, 1000)
		assert.equal(summary.totals.outputTokens, 500)
		assert.equal(summary.totals.iterations, 3)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMultipleSessionsSumCorrectly(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const usageDir = path.join(repo, ".headlesscode", "usage")
		await writeUsageFile(usageDir, "session-1", [record({ sessionId: "session-1", costUsd: 0.001, inputTokens: 100, outputTokens: 50, iterations: 2 })])
		await writeUsageFile(usageDir, "session-2", [record({ sessionId: "session-2", costUsd: 0.002, inputTokens: 200, outputTokens: 75, iterations: 4 })])

		const summary = await buildSummary(repo)
		assert.equal(summary.sessions.length, 2)
		assert.ok(Math.abs(summary.totals.costUsd - 0.003) < 1e-9)
		assert.equal(summary.totals.inputTokens, 300)
		assert.equal(summary.totals.outputTokens, 125)
		assert.equal(summary.totals.iterations, 6)
		assert.equal(summary.totals.sessionCount, 2)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testWorktreeSessionsAreIncluded(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeUsageFile(path.join(repo, ".headlesscode", "usage"), "root-session", [record({ sessionId: "root-session" })])
		await writeUsageFile(
			path.join(repo, ".worktrees", "w1", ".headlesscode", "usage"),
			"worker-session",
			[record({ sessionId: "worker-session", costUsd: 0.005 })],
		)

		const summary = await buildSummary(repo)
		assert.equal(summary.sessions.length, 2)
		const worker = summary.sessions.find((s) => s.sessionId === "worker-session")
		assert.ok(worker, "worker session found under .worktrees/w1")
		assert.equal(worker?.source, ".worktrees/w1")
		assert.ok(Math.abs(summary.totals.costUsd - 0.006) < 1e-9)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── buildSummary: round rollup + blocked groups ────────────────────────────

async function testBlockedGroupSurfacesQuestion(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		const state: OrchestratorState = {
			batch: "round-1",
			groups: [
				{
					name: "w1",
					status: "blocked",
					blocked: { question: "Which auth strategy?", suggestions: ["JWT", "sessions"], askedAt: "2026-08-01T00:00:00.000Z" },
				},
				{
					name: "w2",
					status: "done",
					usage: { costUsd: 0.01, inputTokens: 500, outputTokens: 250, iterations: 5 },
				},
			],
			totalUsage: { costUsd: 0.01, inputTokens: 500, outputTokens: 250, iterations: 5 },
			// Issue #118: per-batch aggregate is threaded through to the round summary.
			batchUsage: { costUsd: 0.006, inputTokens: 300, outputTokens: 150, iterations: 3 },
		}
		await saveState(statePath, state)

		const summary = await buildSummary(repo)
		assert.ok(summary.round, "round data present when .orchestrator-state.json exists")
		assert.equal(summary.round?.batch, "round-1")
		assert.equal(summary.round?.blocked.length, 1)
		assert.equal(summary.round?.blocked[0].name, "w1")
		assert.equal(summary.round?.blocked[0].question, "Which auth strategy?")
		assert.deepEqual(summary.round?.blocked[0].suggestions, ["JWT", "sessions"])
		assert.equal(summary.round?.totalUsage?.costUsd, 0.01)
		assert.equal(summary.round?.batchUsage?.costUsd, 0.006, "issue #118 batch aggregate threaded through")
		assert.equal(summary.round?.groups.length, 2)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRoundSurfacesPreflightProbe(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		const state: OrchestratorState = {
			batch: "round-1",
			groups: [],
			preflight: {
				status: "ok",
				model: "deepseek/deepseek-v4-flash",
				line: 'deepseek/deepseek-v4-flash (pinned to provider "deepseek"): all clear — 1-token probe OK in 812ms',
				latencyMs: 812,
				probeCostUsd: 0.000004,
				roundCostEstimateUsd: 0.14,
			},
		}
		await saveState(statePath, state)

		const summary = await buildSummary(repo)
		assert.ok(summary.round, "round data present when .orchestrator-state.json exists")
		assert.equal(summary.round?.preflight?.status, "ok")
		assert.equal(summary.round?.preflight?.model, "deepseek/deepseek-v4-flash")
		assert.ok(summary.round?.preflight?.line.includes("all clear"), "preflight line reaches the round summary")
		assert.equal(summary.round?.preflight?.roundCostEstimateUsd, 0.14)
		assert.equal(summary.round?.preflight?.latencyMs, 812)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testNoOrchestratorStateYieldsNoRound(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeUsageFile(path.join(repo, ".headlesscode", "usage"), "session-1", [record()])
		const summary = await buildSummary(repo)
		assert.equal(summary.round, undefined, "no .orchestrator-state.json -> no round data")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── buildSummary: live (in-progress) usage snapshots ───────────────────────

async function testLiveSnapshotShowsRunningSession(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// A `.live.json` with no corresponding `.jsonl` → the session is
		// still running, so it shows up as such with its running totals.
		await writeLiveFile(path.join(repo, ".headlesscode", "usage"), "session-live", liveRecord())

		const summary = await buildSummary(repo)
		assert.equal(summary.sessions.length, 1)
		const s = summary.sessions[0]
		assert.equal(s.sessionId, "session-live")
		assert.equal(s.status, "running")
		assert.equal(s.iterations, 2)
		assert.equal(s.inputTokens, 400)
		assert.equal(s.outputTokens, 200)
		assert.ok(Math.abs(s.costUsd - 0.0005) < 1e-9)
		assert.equal(s.endedAt, "", "running sessions have no endedAt")
		assert.equal(summary.totals.sessionCount, 1)
		assert.ok(Math.abs(summary.totals.costUsd - 0.0005) < 1e-9)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testCompletedJsonlWinsOverLiveSnapshot(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// Both a `.live.json` and a completed `.jsonl` exist for the same
		// session id (narrow race at the moment of completion) — the
		// completed record wins; no duplicate row, no double counting.
		const usageDir = path.join(repo, ".headlesscode", "usage")
		await writeUsageFile(usageDir, "session-race", [
			record({
				sessionId: "session-race",
				iterations: 5,
				inputTokens: 5000,
				outputTokens: 2500,
				costUsd: 0.01,
				endedAt: "2026-08-01T00:05:00.000Z",
			}),
		])
		await writeLiveFile(
			usageDir,
			"session-race",
			liveRecord({ sessionId: "session-race", iterations: 2, inputTokens: 400, outputTokens: 200, costUsd: 0.0005 }),
		)

		const summary = await buildSummary(repo)
		assert.equal(summary.sessions.length, 1, "dedup: no duplicate rows for the same session id")
		const s = summary.sessions[0]
		assert.equal(s.sessionId, "session-race")
		assert.equal(s.status, "success", "completed .jsonl record wins over the live snapshot")
		assert.equal(s.iterations, 5)
		assert.equal(s.inputTokens, 5000)
		assert.ok(Math.abs(s.costUsd - 0.01) < 1e-9)
		assert.equal(summary.totals.sessionCount, 1)
		assert.ok(Math.abs(summary.totals.costUsd - 0.01) < 1e-9, "no double counting in totals")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testPostCleanupOnlyCompletedRecordAppears(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// Simulates a session that completed: the loop deleted the live
		// snapshot, leaving only the authoritative .jsonl record behind.
		await writeUsageFile(path.join(repo, ".headlesscode", "usage"), "session-done", [
			record({ sessionId: "session-done" }),
		])

		const summary = await buildSummary(repo)
		assert.equal(summary.sessions.length, 1)
		const s = summary.sessions[0]
		assert.equal(s.sessionId, "session-done")
		assert.equal(s.status, "success")
		assert.equal(s.endedAt, "2026-08-01T00:01:00.000Z")
		assert.ok(summary.sessions.every((row) => row.status !== "running"), "no stale running snapshot after cleanup")
		assert.equal(summary.totals.sessionCount, 1)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Graceful handling of missing/malformed data ────────────────────────────

async function testMissingUsageDirHandledGracefully(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// No .headlesscode dir at all.
		const summary = await buildSummary(repo)
		assert.deepEqual(summary.sessions, [])
		assert.equal(summary.totals.sessionCount, 0)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMalformedJsonlLinesAreSkipped(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const usageDir = path.join(repo, ".headlesscode", "usage")
		await fs.mkdir(usageDir, { recursive: true })
		const goodLine = JSON.stringify(record({ sessionId: "good" }))
		await fs.writeFile(
			path.join(usageDir, "mixed.jsonl"),
			`${goodLine}\nnot json at all\n{"sessionId": "no-status-field"}\n\n`,
			"utf-8",
		)

		const summary = await buildSummary(repo)
		assert.equal(summary.sessions.length, 1, "only the well-formed line with a status field survives")
		assert.equal(summary.sessions[0].sessionId, "good")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMalformedOrchestratorStateHandledGracefully(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const stateDir = path.join(repo, ".worktrees")
		await fs.mkdir(stateDir, { recursive: true })
		await fs.writeFile(path.join(stateDir, ".orchestrator-state.json"), "{ not valid json", "utf-8")

		// loadState throws on invalid JSON (see orchestrator/state.ts) —
		// buildSummary must not propagate that as an unhandled rejection.
		const summary = await buildSummary(repo)
		assert.equal(summary.round, undefined, "malformed state file -> no round data, no throw")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── sumSessions (pure helper) ───────────────────────────────────────────────

async function testSumSessionsEmpty(): Promise<void> {
	const totals = sumSessions([])
	assert.deepEqual(totals, {
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		cachedTokens: 0,
		iterations: 0,
		sessionCount: 0,
	})
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["buildSummary: no repo -> empty summary", testNoRepoYieldsEmptySummary],
	["buildSummary: a single session's usage is reported", testSingleSessionSummedCorrectly],
	["buildSummary: multiple sessions sum correctly", testMultipleSessionsSumCorrectly],
	["buildSummary: worktree usage dirs are included alongside the repo root's own", testWorktreeSessionsAreIncluded],
	["buildSummary: a blocked group surfaces its question in round.blocked", testBlockedGroupSurfacesQuestion],
	["buildSummary: the round surfaces the preflight probe line", testRoundSurfacesPreflightProbe],
	["buildSummary: no .orchestrator-state.json -> round is undefined", testNoOrchestratorStateYieldsNoRound],
	["buildSummary: a live snapshot with no .jsonl shows the session as running", testLiveSnapshotShowsRunningSession],
	["buildSummary: completed .jsonl wins over a live snapshot (no dup, no double count)", testCompletedJsonlWinsOverLiveSnapshot],
	["buildSummary: after completion cleanup only the completed record appears", testPostCleanupOnlyCompletedRecordAppears],
	["buildSummary: missing usage dir handled gracefully (no throw, empty)", testMissingUsageDirHandledGracefully],
	["buildSummary: malformed/partial jsonl lines are skipped, not thrown", testMalformedJsonlLinesAreSkipped],
	["buildSummary: malformed .orchestrator-state.json handled gracefully (no throw)", testMalformedOrchestratorStateHandledGracefully],
	["sumSessions: empty input -> zeroed totals", testSumSessionsEmpty],
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
	console.log(`\nAll ${tests.length} dashboard aggregate tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
