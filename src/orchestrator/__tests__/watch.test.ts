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

import { inspectGroup, isIterationExhaustion, watchGroups, DEFAULT_STALL_TIMEOUT_MS } from "../watch.js"
import { defaultState, loadStateSync, saveStateSync, type OrchestratorGroup, type OrchestratorState } from "../state.js"

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
	["watchGroups: FAILED line printed on the transition to failed", testWatchGroupsPrintsFailedTransitionToStderr],
	["isIterationExhaustion matches the exact max-iterations error", testIsIterationExhaustionMatchesExactError],
	["isIterationExhaustion rejects budget/real failures and empty summaries", testIsIterationExhaustionRejectsOtherFailures],
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
	console.log(`\nAll ${tests.length} watch (blocked-status) tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
