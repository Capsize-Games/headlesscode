/**
 * Unit tests for src/orchestrator/cli.ts — the rework loop (plans/rework-loop.md):
 * a review "finding" verdict is treated as NEW WORK — re-spawn a worker on the
 * SAME worktree up to --max-rework-cycles, then give up into a distinct
 * "needs-human" terminal state. Plain assert-based (no framework, no network)
 * matching the repo test style. Run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { buildReworkTaskFileContent, handleReviewVerdict, parseOrchestrateArgs } from "../cli.js"
import { watchGroups } from "../watch.js"
import { defaultState, loadStateSync, saveStateSync, updateGroup, type OrchestratorGroup, type OrchestratorState } from "../state.js"
import type { ReviewResult } from "../reviewer.js"

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cli-rework-"))
}

function baseGroup(overrides: Partial<OrchestratorGroup> = {}): OrchestratorGroup {
	return {
		name: "w1",
		worktree: ".worktrees/w1",
		status: "done",
		spawned: new Date().toISOString(),
		...overrides,
	}
}

function findingResult(findings: string[] = ["finding one", "finding two"]): ReviewResult {
	return { verdict: "finding", findings, summary: "REOPENED" }
}

// ─── buildReworkTaskFileContent ──────────────────────────────────────────────

async function testReworkTaskFileContentIncludesFindingsAndIssues(): Promise<void> {
	const content = buildReworkTaskFileContent({ name: "w1", issues: [27, 29] }, ["finding A", "finding B"], 1)
	assert.ok(content.includes("Rework cycle 1"), "content names the rework cycle")
	assert.ok(content.includes("1. finding A") && content.includes("2. finding B"), "findings listed 1-indexed")
	assert.ok(content.includes("#27, #29"), "original issue numbers included")
	assert.ok(content.includes("gh issue view 27") && content.includes("gh issue view 29"), "gh fetch lines included")
	assert.ok(content.includes("Closing Report (rework cycle 1)"), "closing template reuses the rework variant")
	assert.ok(content.includes("Scope: #27, #29 only — rework cycle 1."), "scope line names the cycle")
}

async function testReworkTaskFileContentHandlesEmptyFindings(): Promise<void> {
	const content = buildReworkTaskFileContent({ name: "w1", issues: [27] }, [], 2)
	assert.ok(content.includes("Rework cycle 2"))
	assert.ok(content.includes("no specific findings"), "empty findings get an explicit fallback")
	assert.ok(content.includes("#27"), "issues still present")
	// A group with no recorded issues must still produce a valid task.
	const noIssues = buildReworkTaskFileContent({ name: "w1" }, ["x"], 1)
	assert.ok(noIssues.includes("inspect the worktree"), "no-issues fallback text present")
}

// ─── handleReviewVerdict: below the cap → rework spawn ──────────────────────

async function testFindingBelowCapSpawnsAndResetsState(): Promise<void> {
	const group = baseGroup({ reworkCount: 0, status: "done", issues: [27] })
	const decision = handleReviewVerdict(group, findingResult(), "/tmp/example-repo", 3, "code")

	assert.equal(decision.shouldSpawn, true, "below the cap the group gets a rework spawn")
	assert.equal(decision.newReworkCount, 1)
	assert.ok(
		decision.taskFilePath?.endsWith(path.join("plans", "parallel-tasks", "w1-rework1.md")),
		`rework task file named <name>-rework<n>.md, got ${decision.taskFilePath}`,
	)
	assert.ok(decision.taskContent && decision.taskContent.includes("finding one"), "findings embedded in the task")
	assert.ok(decision.spawnCommand && decision.spawnCommand.includes("run-worker.sh"), "spawn command calls run-worker.sh directly")
	assert.ok(decision.spawnCommand?.includes(`--mode "code"`), "spawn command forwards the worker mode")
	assert.ok(decision.spawnCommand?.includes(".worktrees/w1"), "spawn command targets the SAME worktree (no new worktree)")

	// State reset: status back to running, review/QA cleared, count incremented.
	assert.equal(decision.patch.status, "running")
	assert.equal(decision.patch.reworkCount, 1)
	assert.equal(decision.patch.review_verdict, undefined, "review_verdict cleared for a fresh cycle")
	assert.equal(decision.patch.pending_review_findings, undefined, "findings cleared for a fresh cycle")
	assert.equal(decision.patch.qa, undefined, "stale QA cleared for a fresh cycle")
	assert.equal(decision.patch.reviewed_at, undefined)
	assert.equal(decision.patch.exit_code, undefined, "previous attempt's exit code cleared")
	assert.ok(typeof decision.patch.spawned === "string", "spawned reset so the stall guard measures the rework worker")
	assert.ok(decision.patch.last_activity && typeof decision.patch.last_activity === "object", "last_activity notes the rework")
}

async function testFindingIncrementsFromExistingCount(): Promise<void> {
	// A group already in its 2nd rework cycle moves to its 3rd.
	const group = baseGroup({ reworkCount: 2, status: "done" })
	const decision = handleReviewVerdict(group, findingResult(["still broken"]), "/tmp/example-repo", 3, "code")
	assert.equal(decision.shouldSpawn, true)
	assert.equal(decision.newReworkCount, 3)
	assert.ok(
		decision.taskFilePath?.endsWith(path.join("plans", "parallel-tasks", "w1-rework3.md")),
		"each cycle writes a NEW task file (prior files not overwritten)",
	)
	assert.equal(decision.patch.reworkCount, 3)
}

// ─── handleReviewVerdict: at the cap → needs-human, no spawn ────────────────

async function testFindingAtCapMarksNeedsHumanAndDoesNotSpawn(): Promise<void> {
	const group = baseGroup({ reworkCount: 3, status: "done", issues: [27] })
	const result = findingResult(["still broken"])
	const decision = handleReviewVerdict(group, result, "/tmp/example-repo", 3, "code")

	assert.equal(decision.shouldSpawn, false, "at the cap nothing is spawned again")
	assert.equal(decision.newReworkCount, 3, "count not incremented — no new attempt happens")
	assert.equal(decision.taskFilePath, undefined)
	assert.equal(decision.spawnCommand, undefined)
	assert.equal(decision.patch.status, "needs-human", "distinct terminal state, not failed/done")
	assert.equal(decision.patch.reworkCount, 3)
	const activity = decision.patch.last_activity
	assert.ok(activity && typeof activity === "object" && "note" in activity, "last_activity explains the gave-up reason")
}

// ─── Clean verdict never touches reworkCount ─────────────────────────────────

async function testCleanVerdictNeverTouchesReworkCount(): Promise<void> {
	// The callback only routes "finding" verdicts through handleReviewVerdict;
	// a clean verdict applies the review patch only. Prove reworkCount is
	// untouched at the state level.
	const group = baseGroup({ reworkCount: 2 })
	const state = updateGroup({ groups: [group] }, "w1", {
		review_verdict: "clean",
		pending_review_findings: [],
		reviewed_at: "2026-08-01T00:00:00.000Z",
		last_activity: { note: "reviewed: verdict=clean" },
	})
	assert.equal(state.groups[0].reworkCount, 2, "clean verdict must not increment reworkCount")
	assert.equal(state.groups[0].review_verdict, "clean")
	assert.equal(state.groups[0].status, "done", "clean verdict does not change status")
}

// ─── Multiple groups rework independently ────────────────────────────────────

async function testMultipleGroupsReworkIndependently(): Promise<void> {
	const g1 = baseGroup({ name: "w1", reworkCount: 0, status: "done" })
	const g2 = baseGroup({ name: "w2", reworkCount: 2, status: "done" })
	const result = findingResult(["x"])
	const d1 = handleReviewVerdict(g1, result, "/tmp/repo", 3, "code")
	const d2 = handleReviewVerdict(g2, result, "/tmp/repo", 3, "code")
	assert.equal(d1.newReworkCount, 1)
	assert.equal(d2.newReworkCount, 3)
	assert.equal(d1.shouldSpawn, true)
	assert.equal(d2.shouldSpawn, true)

	// Applying both patches to one shared state keeps the counts independent.
	let state: OrchestratorState = { batch: "b", groups: [g1, g2] }
	state = updateGroup(state, "w1", d1.patch)
	state = updateGroup(state, "w2", d2.patch)
	assert.equal(state.groups[0].reworkCount, 1)
	assert.equal(state.groups[1].reworkCount, 3)
	assert.equal(state.groups[0].status, "running")
	assert.equal(state.groups[1].status, "running")
}

// ─── parseOrchestrateArgs: --max-rework-cycles ───────────────────────────────

async function testParseOrchestrateArgsMaxReworkCycles(): Promise<void> {
	const def = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1"])
	assert.equal(def.error, undefined)
	assert.equal(def.options.maxReworkCycles, 3, "default cap is 3")

	const custom = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--max-rework-cycles", "5"])
	assert.equal(custom.error, undefined)
	assert.equal(custom.options.maxReworkCycles, 5)

	const zero = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--max-rework-cycles", "0"])
	assert.ok(zero.error && zero.error.includes("positive integer"), "0 is rejected")

	const bad = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--max-rework-cycles", "abc"])
	assert.ok(bad.error && bad.error.includes("positive integer"), "non-numeric is rejected")
}

// ─── watchGroups re-polls a group after a rework reset ───────────────────────
// Proves requirement (d) from plans/rework-loop.md: after onGroupUpdate resets
// a group to "running" (and the watcher reloads on the callback's `true`), the
// polling loop picks the group back up as running → done → re-reviewed.

async function testWatchGroupsRepollsGroupAfterReworkReset(): Promise<void> {
	const repoRoot = await tmpRepo()
	try {
		const wtPath = path.join(repoRoot, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		const statePath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
		const initial: OrchestratorState = {
			...defaultState("round-1"),
			groups: [
				{ name: "w1", worktree: ".worktrees/w1", issues: [27], status: "running", spawned: new Date().toISOString() },
			],
		}
		saveStateSync(statePath, initial)
		// First worker finished (exit 0).
		await fs.mkdir(path.join(wtPath, ".harness.done"))
		await fs.writeFile(path.join(wtPath, ".harness.exit"), "0", "utf-8")

		let callbackCalls = 0
		const controller = new AbortController()
		const summary = await watchGroups({
			repoRoot,
			statePath,
			pollIntervalMs: 20,
			stderrWriter: () => {},
			onGroupUpdate: async (group) => {
				callbackCalls++
				if (callbackCalls === 1) {
					// First completion: the review finds something → rework.
					const decision = handleReviewVerdict(group, findingResult(), repoRoot, 3, "code")
					assert.equal(decision.shouldSpawn, true, "first finding is below the cap")
					// Apply the reset the real callback applies, then simulate a
					// rework worker that starts AND finishes: clear the old
					// completion markers (run-worker.sh does this) and re-create
					// them to represent the rework worker's completion.
					saveStateSync(statePath, updateGroup(loadStateSync(statePath), "w1", decision.patch))
					await fs.rm(path.join(wtPath, ".harness.done"), { recursive: true, force: true })
					await fs.rm(path.join(wtPath, ".harness.exit"), { force: true })
					await fs.mkdir(path.join(wtPath, ".harness.done"))
					await fs.writeFile(path.join(wtPath, ".harness.exit"), "0", "utf-8")
					return true
				}
				// Second completion: the rework fixed it → clean verdict.
				const cleanPatch = {
					review_verdict: "clean",
					pending_review_findings: [] as string[],
					reviewed_at: new Date().toISOString(),
					last_activity: { note: "reviewed: verdict=clean" },
				}
				saveStateSync(statePath, updateGroup(loadStateSync(statePath), "w1", cleanPatch))
				return undefined
			},
			signal: controller.signal,
		})

		assert.equal(callbackCalls, 2, "the loop must re-poll the group after the rework reset and re-review it")
		assert.equal(summary.allTerminal, true)

		// The disk state is authoritative (orchestrateMain reloads it after the round).
		const persisted = loadStateSync(statePath)
		assert.equal(persisted.groups[0].status, "done")
		assert.equal(persisted.groups[0].review_verdict, "clean")
		assert.equal(persisted.groups[0].reworkCount, 1, "reworkCount is 1 and the clean re-review did NOT increment it")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["rework task file includes findings, issues, rework count", testReworkTaskFileContentIncludesFindingsAndIssues],
	["rework task file handles empty findings gracefully", testReworkTaskFileContentHandlesEmptyFindings],
	["finding below cap triggers rework spawn + state reset", testFindingBelowCapSpawnsAndResetsState],
	["finding increments from an existing rework count", testFindingIncrementsFromExistingCount],
	["finding at cap marks needs-human and does NOT spawn", testFindingAtCapMarksNeedsHumanAndDoesNotSpawn],
	["clean verdict never touches reworkCount", testCleanVerdictNeverTouchesReworkCount],
	["multiple groups rework independently", testMultipleGroupsReworkIndependently],
	["--max-rework-cycles parses (default 3, custom, invalid)", testParseOrchestrateArgsMaxReworkCycles],
	["watchGroups re-polls a group after a rework reset", testWatchGroupsRepollsGroupAfterReworkReset],
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
	console.log(`\nAll ${tests.length} cli tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
