/**
 * Unit tests for src/orchestrator/watch.ts — worktree completion polling,
 * focused on the decision-escalation "blocked" status transition
 * (workstream 2): `.harness.needs-decision` appears -> group status
 * "blocked" with the question recorded -> marker removed -> status flows
 * back to "running". Plain assert-based script (no framework, no network),
 * run via `npm test` -> `tsx src/orchestrator/__tests__/watch.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

import {
	computeBatchUsage,
	computeTotalUsage,
	inspectGroup,
	isIterationExhaustion,
	isProviderFailure,
	tailLog,
	watchGroups,
	DEFAULT_STALL_TIMEOUT_MS,
} from "../watch.js"
import {
	defaultState,
	loadStateSync,
	saveStateSync,
	updateGroup,
	type OrchestratorGroup,
	type OrchestratorState,
} from "../state.js"

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-watch-blocked-"))
}

function baseGroup(overrides: Partial<OrchestratorGroup> = {}): OrchestratorGroup {
	return {
		name: "w1",
		worktree: ".worktrees/w1",
		status: "running",
		spawned: new Date().toISOString(),
		...overrides,
	}
}

// ─── inspectGroup: pure unit coverage ───────────────────────────────────────

async function testInspectGroupDetectsNeedsDecisionMarker(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		await fs.writeFile(
			path.join(wtPath, ".harness.needs-decision"),
			JSON.stringify({
				question: "Which auth strategy should I use?",
				suggestions: ["JWT", "session cookies"],
				askedAt: "2026-08-01T00:00:00.000Z",
			}),
			"utf-8",
		)

		const group = baseGroup()
		const patch = inspectGroup(repoRoot, group, Date.now(), DEFAULT_STALL_TIMEOUT_MS)

		assert.ok(patch, "a needs-decision marker must produce a patch")
		assert.equal(patch?.status, "blocked")
		assert.equal(patch?.blocked?.question, "Which auth strategy should I use?")
		assert.deepEqual(patch?.blocked?.suggestions, ["JWT", "session cookies"])
		assert.equal(patch?.blocked?.askedAt, "2026-08-01T00:00:00.000Z")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

async function testInspectGroupNoChangeWhenAlreadyBlockedOnSameQuestion(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		const decision = { question: "Same question?", askedAt: "2026-08-01T00:00:00.000Z" }
		await fs.writeFile(path.join(wtPath, ".harness.needs-decision"), JSON.stringify(decision), "utf-8")

		const group = baseGroup({ status: "blocked", blocked: decision })
		const patch = inspectGroup(repoRoot, group, Date.now(), DEFAULT_STALL_TIMEOUT_MS)
		assert.equal(patch, undefined, "no state churn when already blocked on the identical question")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

async function testInspectGroupFlowsBackToRunningWhenMarkerRemoved(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		// No .harness.needs-decision file present -> the worker resumed.

		const group = baseGroup({ status: "blocked", blocked: { question: "old question" } })
		const patch = inspectGroup(repoRoot, group, Date.now(), DEFAULT_STALL_TIMEOUT_MS)

		assert.ok(patch, "marker gone while blocked must produce a patch")
		assert.equal(patch?.status, "running")
		assert.equal(patch?.blocked, undefined, "blocked field must be cleared")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

async function testBlockedGroupIsExemptFromStallGuard(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		await fs.writeFile(
			path.join(wtPath, ".harness.needs-decision"),
			JSON.stringify({ question: "still waiting", askedAt: "2020-01-01T00:00:00.000Z" }),
			"utf-8",
		)

		// Spawned far longer ago than the stall timeout, and no pid file at all
		// (which would normally mean "stalled" per the existing guard) — but a
		// present needs-decision marker must win: status stays "blocked", never
		// "failed"/"stalled".
		const longAgo = new Date(Date.now() - DEFAULT_STALL_TIMEOUT_MS * 10).toISOString()
		const group = baseGroup({ spawned: longAgo })
		const patch = inspectGroup(repoRoot, group, Date.now(), DEFAULT_STALL_TIMEOUT_MS)

		assert.ok(patch)
		assert.equal(patch?.status, "blocked", "a blocked group must never be marked stalled/failed by the stall guard")
		assert.equal(patch?.stalled, undefined)
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

// ─── watchGroups: end-to-end blocked -> running transition ─────────────────

async function testWatchGroupsBlockedThenUnblockedFlow(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		const statePath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")

		const initial: OrchestratorState = { ...defaultState("round-1"), groups: [baseGroup()] }
		saveStateSync(statePath, initial)

		const needsDecisionPath = path.join(wtPath, ".harness.needs-decision")
		await fs.writeFile(
			needsDecisionPath,
			JSON.stringify({ question: "Deploy to staging first?", askedAt: new Date().toISOString() }),
			"utf-8",
		)

		const controller = new AbortController()
		const seenStatuses: string[] = []
		const watchPromise = watchGroups({
			repoRoot,
			statePath,
			pollIntervalMs: 20,
			// This test asserts the persisted status flow, not the new stderr
			// signal — silence it so the suite output stays clean.
			stderrWriter: () => {},
			onGroupUpdate: async (group) => {
				seenStatuses.push(group.status)
				if (group.status === "blocked") {
					// Simulate scripts/headlesscode-answer.sh + the worker resuming:
					// remove the needs-decision marker so the next poll sees it gone.
					// Awaited so the next poll iteration never races the unlink.
					await fs.unlink(needsDecisionPath).catch(() => {})
				} else if (group.status === "running") {
					// Worker finished for real now -> terminate the watch loop.
					await fs.mkdir(path.join(wtPath, ".harness.done"))
					await fs.writeFile(path.join(wtPath, ".harness.exit"), "0", "utf-8")
				}
			},
			signal: controller.signal,
		})

		const summary = await watchPromise
		assert.deepEqual(seenStatuses, ["blocked", "running", "done"])
		assert.equal(summary.allTerminal, true)
		const finalGroup = summary.state.groups.find((g) => g.name === "w1")
		assert.equal(finalGroup?.status, "done")
		assert.equal(finalGroup?.blocked, undefined, "blocked field cleared once resolved")

		const persisted = loadStateSync(statePath)
		assert.equal(persisted.groups[0].status, "done")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

// ─── watchGroups: proactive status-change stderr signal (gap 2) ─────────────

async function testWatchGroupsPrintsBlockedTransitionToStderr(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		const statePath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, { ...defaultState("round-1"), groups: [baseGroup()] })
		await fs.writeFile(
			path.join(wtPath, ".harness.needs-decision"),
			JSON.stringify({ question: "Which auth strategy should I use?", askedAt: new Date().toISOString() }),
			"utf-8",
		)

		const controller = new AbortController()
		const lines: string[] = []
		await watchGroups({
			repoRoot,
			statePath,
			pollIntervalMs: 20,
			stderrWriter: (text) => lines.push(text),
			onGroupUpdate: async (group) => {
				if (group.status === "blocked") {
					// Stop the loop once the transition has been observed.
					controller.abort()
				}
			},
			signal: controller.signal,
		})

		const joined = lines.join("")
		assert.ok(joined.includes("[orchestrate] BLOCKED:"), "blocked transition must print a BLOCKED stderr line")
		assert.ok(joined.includes('group "w1"'), "BLOCKED line must name the group")
		assert.ok(joined.includes("Which auth strategy should I use?"), "BLOCKED line must include the question text")
		assert.ok(
			joined.includes("scripts/headlesscode-answer.sh .worktrees/w1"),
			"BLOCKED line must show the answer command with the worktree path",
		)
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

async function testWatchGroupsDoesNotRepeatBlockedLineWhileStillBlocked(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		const statePath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, { ...defaultState("round-1"), groups: [baseGroup()] })
		await fs.writeFile(
			path.join(wtPath, ".harness.needs-decision"),
			JSON.stringify({ question: "stay blocked", askedAt: "2026-08-01T00:00:00.000Z" }),
			"utf-8",
		)

		const controller = new AbortController()
		const lines: string[] = []
		const watchPromise = watchGroups({
			repoRoot,
			statePath,
			pollIntervalMs: 20,
			stderrWriter: (text) => lines.push(text),
			signal: controller.signal,
		})
		// Let several poll iterations run while the group stays blocked, then stop.
		const stopTimer = setTimeout(() => controller.abort(), 200)
		try {
			await watchPromise
		} finally {
			clearTimeout(stopTimer)
		}

		const blockedLines = lines.filter((l) => l.includes("BLOCKED"))
		assert.equal(blockedLines.length, 1, "the BLOCKED line must appear exactly once while the group stays blocked")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

async function testWatchGroupsPrintsDoneTransitionToStderr(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		const statePath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, { ...defaultState("round-1"), groups: [baseGroup()] })
		await fs.mkdir(path.join(wtPath, ".harness.done"))
		await fs.writeFile(path.join(wtPath, ".harness.exit"), "0", "utf-8")

		const lines: string[] = []
		const summary = await watchGroups({
			repoRoot,
			statePath,
			pollIntervalMs: 20,
			stderrWriter: (text) => lines.push(text),
		})

		assert.equal(summary.allTerminal, true)
		const joined = lines.join("")
		assert.ok(joined.includes("[orchestrate] DONE:"), "done transition must print a DONE stderr line")
		assert.ok(joined.includes('group "w1"'), "DONE line must name the group")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

/**
 * Mandatory cost/token history recording: a group reaching "done" must get
 * its combined usage recorded to the central cost-history.jsonl exactly
 * once, with `cost_recorded` set on the persisted group so it's never
 * re-recorded on a later poll. This is the end-to-end counterpart to
 * cost-history.test.ts's unit coverage of recordGroupCost itself.
 */
async function testWatchGroupsRecordsCostOnDoneTransition(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		const usageDir = path.join(wtPath, ".headlesscode", "usage")
		await fs.mkdir(usageDir, { recursive: true })
		const statePath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, { ...defaultState("round-1"), groups: [baseGroup({ issues: [42] })] })
		await fs.mkdir(path.join(wtPath, ".harness.done"))
		await fs.writeFile(path.join(wtPath, ".harness.exit"), "0", "utf-8")
		await fs.writeFile(
			path.join(usageDir, "session-1.jsonl"),
			`${JSON.stringify({ sessionId: "session-1", costUsd: 0.05, inputTokens: 1000, outputTokens: 100, cachedTokens: 400, iterations: 12 })}\n`,
			"utf-8",
		)

		const summary = await watchGroups({
			repoRoot,
			statePath,
			pollIntervalMs: 20,
			stderrWriter: () => {},
			reviewEnabled: false,
		})
		assert.equal(summary.allTerminal, true)

		const persisted = loadStateSync(statePath)
		const group = persisted.groups.find((g) => g.name === "w1")
		assert.ok(group?.cost_recorded, "cost_recorded must be set once the group is terminal")

		const { readCostHistory } = await import("../cost-history.js")
		const records = await readCostHistory(repoRoot)
		assert.equal(records.length, 1, "exactly one cost-history record must be written")
		assert.deepEqual(records[0]?.issues, [42])
		assert.equal(records[0]?.costUsd, 0.05)
		assert.equal(records[0]?.status, "done")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

/**
 * 2026-08-05 incident: recordCostIfSettled originally fired the FIRST time
 * a group was observed terminal — before review (or QA) even ran. Since
 * review/QA are separate HeadlessSession runs against the SAME worktree,
 * each writing their own `.headlesscode/usage/*.jsonl`, and nothing
 * re-triggers a usage rollup for a "done" group unless a rework respawn
 * happens, their real cost was silently never captured. This reproduces
 * the fix: with review enabled, a "done" group must NOT be recorded until
 * `review_verdict` is set, and the recorded total must include the review
 * session's own usage file, not just the original worker's.
 */
async function testWatchGroupsWaitsForReviewBeforeRecordingCost(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		const usageDir = path.join(wtPath, ".headlesscode", "usage")
		await fs.mkdir(usageDir, { recursive: true })
		const statePath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, { ...defaultState("round-1"), groups: [baseGroup({ issues: [42] })] })
		await fs.mkdir(path.join(wtPath, ".harness.done"))
		await fs.writeFile(path.join(wtPath, ".harness.exit"), "0", "utf-8")
		await fs.writeFile(
			path.join(usageDir, "worker.jsonl"),
			`${JSON.stringify({ sessionId: "worker", costUsd: 0.05, inputTokens: 1000, outputTokens: 100, cachedTokens: 400, iterations: 12 })}\n`,
			"utf-8",
		)

		let callbackCalls = 0
		const summary = await watchGroups({
			repoRoot,
			statePath,
			pollIntervalMs: 20,
			stderrWriter: () => {},
			reviewEnabled: true,
			onGroupUpdate: async (group) => {
				callbackCalls++
				// Simulate the real review step: it's a SEPARATE HeadlessSession
				// against the same worktree, so it writes its OWN usage file,
				// then reports a clean verdict — same shape as cli.ts's real
				// runReview + state patch.
				await fs.writeFile(
					path.join(usageDir, "review.jsonl"),
					`${JSON.stringify({ sessionId: "review", costUsd: 0.02, inputTokens: 500, outputTokens: 50, cachedTokens: 100, iterations: 8 })}\n`,
					"utf-8",
				)
				saveStateSync(
					statePath,
					updateGroup(loadStateSync(statePath), group.name, {
						review_verdict: "clean",
						pending_review_findings: [],
						reviewed_at: new Date().toISOString(),
					}),
				)
				return undefined
			},
		})
		assert.equal(summary.allTerminal, true)
		assert.equal(callbackCalls, 1, "review must run exactly once")

		const persisted = loadStateSync(statePath)
		const group = persisted.groups.find((g) => g.name === "w1")
		assert.ok(group?.cost_recorded, "cost must be recorded once review is settled")
		assert.equal(group?.review_verdict, "clean")

		const { readCostHistory } = await import("../cost-history.js")
		const records = await readCostHistory(repoRoot)
		assert.equal(records.length, 1, "exactly one cost-history record, recorded after review")
		assert.equal(
			records[0]?.costUsd,
			0.07,
			"recorded cost must include BOTH the worker's and the review session's usage, not just the worker's",
		)
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

/**
 * Issue #24 (2026-08-05): watchGroups used to await each group's
 * onGroupUpdate INLINE in the per-group for-loop, so one group's long
 * review/QA fully monopolized the watcher — no other group's completion was
 * even detected until the in-flight one resolved. Live impact: a settled
 * group sat fully idle for 30+ minutes behind another group's review+QA in
 * the same round. This reproduces the fix: group "w1"'s callback blocks on
 * a gate that only opens once group "w2" has ALREADY completed its own
 * callback, proving w2's review runs and finishes while w1's is still stuck
 * — i.e. groups are no longer serialized through the watcher.
 */
async function testWatchGroupsRunsReviewForMultipleGroupsConcurrently(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const w1Path = path.join(repoRoot, ".worktrees", "w1")
		const w2Path = path.join(repoRoot, ".worktrees", "w2")
		await fs.mkdir(w1Path, { recursive: true })
		await fs.mkdir(w2Path, { recursive: true })
		const statePath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, {
			...defaultState("round-1"),
			groups: [baseGroup({ name: "w1", worktree: ".worktrees/w1" }), baseGroup({ name: "w2", worktree: ".worktrees/w2" })],
		})
		await fs.mkdir(path.join(w1Path, ".harness.done"))
		await fs.writeFile(path.join(w1Path, ".harness.exit"), "0", "utf-8")
		await fs.mkdir(path.join(w2Path, ".harness.done"))
		await fs.writeFile(path.join(w2Path, ".harness.exit"), "0", "utf-8")

		let w2Finished = false
		let resolveW1Started: (() => void) | undefined
		const w1Started = new Promise<void>((resolve) => {
			resolveW1Started = resolve
		})

		const summary = await watchGroups({
			repoRoot,
			statePath,
			pollIntervalMs: 20,
			stderrWriter: () => {},
			reviewEnabled: true,
			onGroupUpdate: async (group) => {
				if (group.name === "w1") {
					resolveW1Started?.()
					// Block until w2's callback has fully finished — if the
					// watcher still serialized groups, this would deadlock
					// (w2's callback would never even start), so the test
					// itself is the proof: it only completes if w2 ran
					// concurrently with w1 still stuck here.
					const deadline = Date.now() + 5000
					while (!w2Finished && Date.now() < deadline) {
						await new Promise((r) => setTimeout(r, 5))
					}
					assert.equal(w2Finished, true, "w2 must finish while w1's callback is still blocked")
					saveStateSync(
						statePath,
						updateGroup(loadStateSync(statePath), "w1", {
							review_verdict: "clean",
							pending_review_findings: [],
							reviewed_at: new Date().toISOString(),
						}),
					)
					return undefined
				}
				await w1Started
				saveStateSync(
					statePath,
					updateGroup(loadStateSync(statePath), "w2", {
						review_verdict: "clean",
						pending_review_findings: [],
						reviewed_at: new Date().toISOString(),
					}),
				)
				w2Finished = true
				return undefined
			},
		})

		assert.equal(summary.allTerminal, true)
		const persisted = loadStateSync(statePath)
		assert.equal(persisted.groups.find((g) => g.name === "w1")?.review_verdict, "clean")
		assert.equal(persisted.groups.find((g) => g.name === "w2")?.review_verdict, "clean")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

/**
 * Issue #116: the watcher writes a heartbeat file (<statePath>.watcher) at
 * poll cadence so a concurrent read-side `status --wait` can tell a live
 * watch loop owns the state and must NOT persist its own read-side
 * reconciliation. The heartbeat must exist before the first poll pass.
 */
async function testWatchGroupsWritesWatcherHeartbeat(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		const statePath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, { ...defaultState("round-1"), groups: [baseGroup()] })
		await fs.mkdir(path.join(wtPath, ".harness.done"))
		await fs.writeFile(path.join(wtPath, ".harness.exit"), "0", "utf-8")

		const heartbeatPath = `${statePath}.watcher`
		const controller = new AbortController()
		await watchGroups({
			repoRoot,
			statePath,
			pollIntervalMs: 20,
			stderrWriter: () => {},
			reviewEnabled: false,
			// Stop the loop once the heartbeat has been observed and the group
			// has reached done (otherwise it loops forever).
			onGroupUpdate: async () => {
				controller.abort()
			},
			signal: controller.signal,
		})

		const stat = await fs.stat(heartbeatPath)
		assert.ok(stat.isFile(), "heartbeat file exists")
		assert.ok(Date.now() - stat.mtimeMs < 60_000, "heartbeat was written recently (this run)")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

async function testWatchGroupsPrintsFailedTransitionToStderr(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		const statePath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
		saveStateSync(statePath, { ...defaultState("round-1"), groups: [baseGroup()] })
		await fs.mkdir(path.join(wtPath, ".harness.done"))
		await fs.writeFile(path.join(wtPath, ".harness.exit"), "1", "utf-8")

		const lines: string[] = []
		const summary = await watchGroups({
			repoRoot,
			statePath,
			pollIntervalMs: 20,
			stderrWriter: (text) => lines.push(text),
		})

		assert.equal(summary.allTerminal, true)
		const joined = lines.join("")
		assert.ok(joined.includes("[orchestrate] FAILED:"), "failed transition must print a FAILED stderr line")
		assert.ok(joined.includes('group "w1"'), "FAILED line must name the group")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

/**
 * 2026-08-02 incident regression: a group past the stall timeout whose
 * worker process has ACTUALLY died (not just a missing pid file — a real
 * dead pid recorded in a stale `.harness.pid`) must resolve to "failed"
 * immediately, not sit reporting "still stalled" forever. Before the fix,
 * `hasPid` only checked file existence, so a stale pid file made a dead
 * worker indistinguishable from a live one — the group could never resolve.
 */
async function testStallGuardResolvesToFailedWhenPidIsDead(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		// A pid that is guaranteed dead by the time we read it: spawn a
		// trivial child, let it exit, and use its (now-released) pid.
		const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"])
		const deadPid = dead.pid
		assert.ok(deadPid, "expected the trivial child to report a pid")
		await fs.writeFile(path.join(wtPath, ".harness.pid"), String(deadPid), "utf-8")

		const longAgo = new Date(Date.now() - DEFAULT_STALL_TIMEOUT_MS * 10).toISOString()
		const group = baseGroup({ spawned: longAgo })
		const patch = inspectGroup(repoRoot, group, Date.now(), DEFAULT_STALL_TIMEOUT_MS)

		assert.ok(patch, "a dead-pid stalled group must resolve, not silently do nothing")
		assert.equal(patch?.status, "failed", "a confirmed-dead worker must resolve to failed, not sit stalled forever")
		assert.equal(patch?.stalled, true)
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

/**
 * 2026-08-02 incident regression, the actual busy-loop cause: a group past
 * the stall timeout whose worker IS still genuinely alive must report the
 * stall ONCE (the transition into `stalled: true`), then return `undefined`
 * on every subsequent poll as long as nothing has changed — not a fresh
 * patch every single time. Before the fix, this branch returned a new
 * patch object unconditionally on every call, which `watchGroups`' "only
 * sleep if nothing changed" loop treated as "something changed" forever,
 * producing a zero-delay busy loop (observed: 11+ hours at ~76% CPU on a
 * real orchestrator round).
 */
async function testStallGuardReportsOnceThenStopsWhileStillAlive(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		// This test process's own pid is guaranteed alive for the duration.
		await fs.writeFile(path.join(wtPath, ".harness.pid"), String(process.pid), "utf-8")

		const longAgo = new Date(Date.now() - DEFAULT_STALL_TIMEOUT_MS * 10).toISOString()
		const now = Date.now()

		// First poll: not yet marked stalled -> must report it (once).
		const freshGroup = baseGroup({ spawned: longAgo })
		const firstPatch = inspectGroup(repoRoot, freshGroup, now, DEFAULT_STALL_TIMEOUT_MS)
		assert.ok(firstPatch, "the first stall detection must produce a patch")
		assert.equal(firstPatch?.status, undefined, "still alive -> status must NOT flip to failed")
		assert.equal(firstPatch?.stalled, true)

		// Second poll: simulate the patch having been persisted (stalled:
		// true already recorded) and nothing else changed -- this is the
		// exact repeated-call shape that caused the busy loop.
		const alreadyStalledGroup = baseGroup({ spawned: longAgo, stalled: true })
		const secondPatch = inspectGroup(repoRoot, alreadyStalledGroup, now + 1000, DEFAULT_STALL_TIMEOUT_MS)
		assert.equal(secondPatch, undefined, "an unresolved stall that hasn't changed must not produce a fresh patch every poll")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

// ─── isIterationExhaustion: the continuable-failure predicate ────────────────
// Only the harness's exact "Max iterations (N) reached without task
// completion" error marks a failure as iteration-exhaustion (the auto-continue
// signal); budget stops and real errors must never match.

async function testIsIterationExhaustionMatchesExactError(): Promise<void> {
	assert.equal(
		isIterationExhaustion("headlesscode: task failed: Max iterations (50) reached without task completion"),
		true,
		"the harness CLI's stderr line (redirected into harness.log) must match",
	)
	assert.equal(
		isIterationExhaustion("... some log ... Max iterations (3) reached without task completion"),
		true,
		"the exact error substring anywhere in the summary matches",
	)
}

async function testIsIterationExhaustionRejectsOtherFailures(): Promise<void> {
	assert.equal(
		isIterationExhaustion("headlesscode: task aborted by budget: max cost exceeded"),
		false,
		"a budget stop is NOT iteration exhaustion (must never auto-continue)",
	)
	assert.equal(
		isIterationExhaustion("headlesscode: task failed: consecutive mistakes"),
		false,
		"a real error is NOT iteration exhaustion",
	)
	assert.equal(isIterationExhaustion(undefined), false, "no summary is never exhaustion")
	assert.equal(isIterationExhaustion(""), false, "empty summary is never exhaustion")
}

// ─── isProviderFailure: the second continuable-failure predicate ────────────
// A transient LLM-provider failure on the MAIN call (src/engine/loop.ts's
// callMainLlm) — observed live 2026-08-08: a hard-pinned model with no
// fallback provider hit an HTTP 520 mid-session and killed the whole thing.
// This earns the same auto-continue treatment as the iteration cap; a real
// task/code failure must never match.

async function testIsProviderFailureMatchesKnownShapes(): Promise<void> {
	assert.equal(
		isProviderFailure(
			'headlesscode: task failed: LLM request failed on iteration 28: OpenRouter returned HTTP 520: {"error":{"message":"Provider returned error","code":520,"metadata":{"raw":"error code: 520\\n","provider_name":"DeepSeek","is_byok":false}}}',
		),
		true,
		"a provider 5xx on the main call must match",
	)
	assert.equal(
		isProviderFailure(
			'LLM request failed on iteration 12: OpenRouter returned HTTP 429: {"error":{"message":"Rate limited"}}',
		),
		true,
		"a provider 429 must match",
	)
	assert.equal(
		isProviderFailure(
			'LLM request failed on iteration 5: OpenRouter returned HTTP 404: {"error":{"message":"No allowed providers are available for the selected model."}}',
		),
		true,
		'the "no allowed providers" 404 must match despite the 4xx status (see isRetryableOpenRouterError)',
	)
	assert.equal(
		isProviderFailure("LLM request failed on iteration 3: Network error calling OpenRouter: fetch failed"),
		true,
		"a raw network-transport failure must match",
	)
}

async function testIsProviderFailureRejectsOtherFailures(): Promise<void> {
	assert.equal(
		isProviderFailure(
			'LLM request failed on iteration 9: OpenRouter returned HTTP 401: {"error":{"message":"Invalid API key"}}',
		),
		false,
		"a deterministic 4xx (auth failure) must NOT auto-continue — retrying changes nothing",
	)
	assert.equal(
		isProviderFailure("headlesscode: task aborted by budget: max cost exceeded"),
		false,
		"a budget stop is not a provider failure",
	)
	assert.equal(
		isProviderFailure("headlesscode: task failed: Max iterations (50) reached without task completion"),
		false,
		"iteration exhaustion is handled by isIterationExhaustion, not this predicate",
	)
	assert.equal(isProviderFailure(undefined), false, "no summary is never a provider failure")
	assert.equal(isProviderFailure(""), false, "empty summary is never a provider failure")
}

// ─── computeTotalUsage / computeBatchUsage (issue #118) ─────────────────────

/** A group usage fixture (cost, tokens, iterations). */
function usageFixture(costUsd: number, iterations: number): OrchestratorGroup["usage"] {
	return { costUsd, inputTokens: 1000, outputTokens: 500, iterations }
}

/** State with two batches' worth of groups: current batch + one historical round. */
function twoBatchState(): OrchestratorState {
	let state = defaultState("round-2026-08-17")
	// Current batch groups (spawned timestamps carry the batch date prefix).
	state = updateGroup(
		state,
		"w1",
		baseGroup({ name: "w1", status: "done", spawned: "2026-08-17T08:00:00.000Z", usage: usageFixture(0.5, 50) }),
	)
	state = updateGroup(
		state,
		"w2",
		baseGroup({ name: "w2", status: "done", spawned: "2026-08-17T09:00:00.000Z", usage: usageFixture(0.3, 30) }),
	)
	// A historical group from a PRIOR round, retained in the state file for
	// history/cleanup bookkeeping (this is the accumulation that makes
	// totalUsage misleading for "what did THIS round cost?").
	state = updateGroup(
		state,
		"w-old",
		baseGroup({ name: "w-old", status: "done", spawned: "2026-08-10T10:00:00.000Z", usage: usageFixture(9.0, 900) }),
	)
	return state
}

async function testComputeBatchUsageScopesToCurrentBatch(): Promise<void> {
	const state = twoBatchState()
	const batch = computeBatchUsage(state)
	assert.ok(batch, "current-batch groups have usage -> a batchUsage is produced")
	assert.equal(batch?.costUsd, 0.8, "sums ONLY the current batch's groups (w1 + w2), not w-old")
	assert.equal(batch?.iterations, 80)
	assert.equal(batch?.inputTokens, 2000)
	assert.equal(batch?.outputTokens, 1000)
}

async function testComputeBatchUsageExcludesHistoricalGroups(): Promise<void> {
	const state = twoBatchState()
	const total = computeTotalUsage(state)
	assert.ok(total, "totalUsage exists")
	assert.equal(total?.costUsd, 9.8, "totalUsage stays cumulative across ALL groups (w1 + w2 + w-old)")
	const batch = computeBatchUsage(state)
	assert.equal(batch?.costUsd, 0.8, "batchUsage excludes the historical round's group")
}

async function testComputeBatchUsageUndefinedWithoutBatchOrGroupUsage(): Promise<void> {
	// No batch id at all -> nothing to scope against.
	assert.equal(computeBatchUsage(defaultState("unnamed")), undefined)
	// Current-batch groups with no usage records -> undefined (never a spurious all-zero rollup).
	const empty = twoBatchState()
	for (const g of empty.groups) {
		empty.groups = empty.groups.map((gg) => ({ ...gg, usage: undefined }))
	}
	assert.equal(computeBatchUsage(empty), undefined)
}

async function testComputeBatchUsageMatchesSpawnedByDatePrefix(): Promise<void> {
	// A timestamp-prefixed batch (e.g. custom --batch) matches by prefix, and
	// the 'T' guard (>= 11 chars) keeps a truncated prefix from over-matching.
	let state = defaultState("round-2026-08-17T12")
	state = updateGroup(
		state,
		"w1",
		baseGroup({ name: "w1", status: "done", spawned: "2026-08-17T12:00:00.000Z", usage: usageFixture(0.4, 40) }),
	)
	state = updateGroup(
		state,
		"w2",
		baseGroup({ name: "w2", status: "done", spawned: "2026-08-17T13:00:00.000Z", usage: usageFixture(0.2, 20) }),
	)
	state = updateGroup(
		state,
		"w-old",
		baseGroup({ name: "w-old", status: "done", spawned: "2026-08-16T12:00:00.000Z", usage: usageFixture(5.0, 500) }),
	)
	const batch = computeBatchUsage(state)
	assert.ok(batch, "timestamp-prefixed batch matches by prefix")
	assert.equal(batch?.costUsd, 0.4, "only groups spawned under the batch's exact date/hour prefix count (w2 is hour 13)")
	assert.equal(batch?.iterations, 40)
}

/**
	* 2026-08-05 incident regression: `inspectGroup`'s captured `summary` field
 * silently dropped the ACTUAL final lines of a long-running worker's
 * harness.log. tailLog() correctly returns the last SUMMARY_TAIL_LINES
 * lines of the current run, but that tail was then capped with
 * `.slice(0, 4000)` — the FIRST 4000 chars of an already-end-anchored tail
 * — which discards the tail's own most recent content when the 40-line
 * window exceeds 4000 chars (easy: harness.log's JSON usage lines commonly
 * run 200-300+ chars each). In a real dispatch round this made
 * `isIterationExhaustion(group.summary)` return false for a worker that
 * GENUINELY hit --max-iterations, because the "Max iterations (N) reached"
 * line — always the true last line — never survived into `summary`. Two
 * real, separate consequences from the one bug: auto-continuation never
 * fired, and status output shown to a human/agent never reflected the
 * worker's real final outcome.
 */
async function testInspectGroupSummaryPreservesTrueTailNotHead(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		// Pad with enough long lines that the 40-line tail window exceeds 4000
		// chars well before reaching the final line — reproduces the real
		// harness.log shape (verbose JSON usage-total lines every iteration).
		const padLine =
			'[2026-08-05T14:00:00.000Z] INFO  [usage] running total {"iteration":1,"costUsd":0.01,"inputTokens":100000,"outputTokens":1000,"cachedTokens":90000,"lastPromptTokens":10000,"lastCachedTokens":9000}'
		const padding = Array.from({ length: 39 }, () => padLine).join("\n")
		const finalLine = "headlesscode: task failed: Max iterations (50) reached without task completion"
		await fs.writeFile(path.join(wtPath, "harness.log"), `${padding}\n${finalLine}\n`, "utf-8")
		await fs.mkdir(path.join(wtPath, ".harness.done"))
		await fs.writeFile(path.join(wtPath, ".harness.exit"), "1", "utf-8")

		const patch = inspectGroup(repoRoot, baseGroup(), Date.now(), DEFAULT_STALL_TIMEOUT_MS)
		assert.ok(patch, "a done marker with a failing exit code must produce a patch")
		assert.equal(patch?.status, "failed")
		assert.ok(
			patch?.summary?.includes("Max iterations (50) reached"),
			`captured summary must include the real final error line, got tail: ${patch?.summary?.slice(-200)}`,
		)
		assert.equal(
			isIterationExhaustion(patch?.summary),
			true,
			"the captured summary must actually be detected as iteration exhaustion (this is what gates auto-continuation)",
		)
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

// ─── tailLog: run-separator scoping (restart must not lose prior log/stats) ──
// scripts/run-worker.sh now appends to harness.log across continuation/rework
// respawns on the same worktree (never truncates it), writing a run-start
// separator before each session. tailLog() must scope its summary to content
// after the LAST separator so a short current-run log never inherits a stale
// "Max iterations reached" line from an earlier session in the same file.

async function testTailLogScopesToLatestRunAfterAppend(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const logPath = path.join(repoRoot, "harness.log")
		await fs.writeFile(
			logPath,
			[
				"===== headlesscode run start: 2026-08-01T00:00:00Z =====",
				"first session doing work",
				"headlesscode: task failed: Max iterations (50) reached without task completion",
				"===== headlesscode run start: 2026-08-01T01:00:00Z =====",
				"second session picked up where the first left off",
				"headlesscode: task completed successfully",
			].join("\n"),
			"utf-8",
		)

		const summary = tailLog(logPath)
		assert.ok(!summary.includes("Max iterations"), "must not see the previous session's exhaustion line")
		assert.ok(summary.includes("second session picked up"), "must see the current session's own output")
		assert.equal(isIterationExhaustion(summary), false, "a short current run must not misfire as exhaustion")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

async function testTailLogPreservesFullHistoryOnDisk(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const logPath = path.join(repoRoot, "harness.log")
		await fs.writeFile(logPath, "first session output\n", "utf-8")
		await fs.appendFile(
			logPath,
			"\n===== headlesscode run start: 2026-08-01T01:00:00Z =====\nsecond session output\n",
			"utf-8",
		)

		const raw = await fs.readFile(logPath, "utf-8")
		assert.ok(raw.includes("first session output"), "appending must never destroy a prior session's log")
		assert.ok(raw.includes("second session output"), "and must include the new session's log too")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["inspectGroup: needs-decision marker -> status blocked with question recorded", testInspectGroupDetectsNeedsDecisionMarker],
	["inspectGroup: already blocked on the same question -> no patch (no churn)", testInspectGroupNoChangeWhenAlreadyBlockedOnSameQuestion],
	["inspectGroup: marker removed while blocked -> status running, blocked cleared", testInspectGroupFlowsBackToRunningWhenMarkerRemoved],
	["inspectGroup: blocked group is exempt from the stall guard", testBlockedGroupIsExemptFromStallGuard],
	["inspectGroup: stalled + confirmed-dead pid resolves to failed", testStallGuardResolvesToFailedWhenPidIsDead],
	["inspectGroup: stalled + still-alive pid reports once, then stops (busy-loop regression)", testStallGuardReportsOnceThenStopsWhileStillAlive],
	["watchGroups: blocked -> running -> done end-to-end transition", testWatchGroupsBlockedThenUnblockedFlow],
	["watchGroups: BLOCKED line printed once on the transition into blocked", testWatchGroupsPrintsBlockedTransitionToStderr],
	["watchGroups: BLOCKED line not repeated while the group stays blocked", testWatchGroupsDoesNotRepeatBlockedLineWhileStillBlocked],
	["watchGroups: DONE line printed on the transition to done", testWatchGroupsPrintsDoneTransitionToStderr],
	["watchGroups: records cost history exactly once on the done transition", testWatchGroupsRecordsCostOnDoneTransition],
	["watchGroups: waits for review before recording cost, then includes the review session's own usage", testWatchGroupsWaitsForReviewBeforeRecordingCost],
	["watchGroups: runs review for multiple groups concurrently, not serialized (issue #24)", testWatchGroupsRunsReviewForMultipleGroupsConcurrently],
	["watchGroups: FAILED line printed on the transition to failed", testWatchGroupsPrintsFailedTransitionToStderr],
	["watchGroups: writes the watcher heartbeat file at poll cadence (issue #116)", testWatchGroupsWritesWatcherHeartbeat],
	["isIterationExhaustion matches the exact max-iterations error", testIsIterationExhaustionMatchesExactError],
	["isIterationExhaustion rejects budget/real failures and empty summaries", testIsIterationExhaustionRejectsOtherFailures],
	["isProviderFailure matches provider 5xx/429/no-allowed-providers/network-error shapes", testIsProviderFailureMatchesKnownShapes],
	["isProviderFailure rejects deterministic 4xx, budget stops, and iteration exhaustion", testIsProviderFailureRejectsOtherFailures],
	["computeBatchUsage scopes usage to the current batch, excluding historical groups", testComputeBatchUsageScopesToCurrentBatch],
	["computeTotalUsage stays cumulative while computeBatchUsage excludes history", testComputeBatchUsageExcludesHistoricalGroups],
	["computeBatchUsage is undefined without a batch id or any group usage", testComputeBatchUsageUndefinedWithoutBatchOrGroupUsage],
	["computeBatchUsage matches a timestamp-prefixed batch by prefix", testComputeBatchUsageMatchesSpawnedByDatePrefix],
	["inspectGroup: captured summary preserves the true tail, not the head, of a long harness.log", testInspectGroupSummaryPreservesTrueTailNotHead],
	["tailLog: scopes the summary to content after the latest run-start separator", testTailLogScopesToLatestRunAfterAppend],
	["tailLog: appended harness.log preserves every prior session's output on disk", testTailLogPreservesFullHistoryOnDisk],
]

async function main(): Promise<void> {
	// watchGroups now records cost history (cost-history.ts) as a mandatory
	// side effect of a group reaching a terminal status, which touches the
	// central project store — redirect it to a temp dir so no test run ever
	// writes into the real ~/.local/share/headlesscode (same defensive
	// pattern as config/__tests__/mode-models.test.ts).
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-watch-store-"))
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
				console.error(err instanceof Error ? err.stack ?? err.message : String(err))
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
	console.log(`\nAll ${tests.length} watch (blocked-status) tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
