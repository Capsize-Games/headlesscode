/**
 * Unit tests for src/orchestrator/cli.ts — the rework loop (plans/rework-loop.md):
 * a review "finding" verdict is treated as NEW WORK — re-spawn a worker on the
 * SAME worktree up to --max-rework-cycles, then give up into a distinct
 * "needs-human" terminal state. Plain assert-based (no framework, no network)
 * matching the repo test style. Run via `npm test`.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	buildContinuationTaskFileContent,
	buildPlanFirstTaskFileContent,
	buildQaReworkTaskFileContent,
	buildReworkTaskFileContent,
	buildTaskFileContent,
	buildSpawnEnv,
	fileSyntheticIssues,
	handleIterationExhaustion,
	handleQaSessionError,
	handleQaVerdict,
	handleReviewSessionError,
	handleReviewVerdict,
	orchestrateMain,
	parseOrchestrateArgs,
	writeTaskFiles,
} from "../cli.js"
import { appendCostHistoryRecord } from "../cost-history.js"
import { watchGroups } from "../watch.js"
import { defaultState, loadStateSync, saveStateSync, updateGroup, type OrchestratorGroup, type OrchestratorState } from "../state.js"
import type { ReviewResult } from "../reviewer.js"
import type { QaResult } from "../../qa/qa.js"

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cli-rework-"))
}

/** Initialize a real git repo (orchestrateMain git-checks the target with `git rev-parse --git-dir`). */
function initGitRepo(dir: string): void {
	try {
		execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" })
	} catch {
		execFileSync("git", ["init", "-q", dir], { stdio: "ignore" })
	}
}

/** Run a function while capturing everything written to process.stderr. */
function withCapturedStderr(fn: () => Promise<number>): Promise<{ exit: number; stderr: string }> {
	const original = process.stderr.write.bind(process.stderr)
	let stderr = ""
	process.stderr.write = ((chunk: unknown): boolean => {
		stderr += String(chunk)
		return true
	}) as typeof process.stderr.write
	return fn()
		.finally(() => {
			process.stderr.write = original
		})
		.then((exit) => ({ exit, stderr }))
}

/** Run a function while capturing everything written to process.stdout. */
function withCapturedStdout(fn: () => Promise<number>): Promise<{ exit: number; stdout: string }> {
	const original = process.stdout.write.bind(process.stdout)
	let stdout = ""
	process.stdout.write = ((chunk: unknown): boolean => {
		stdout += String(chunk)
		return true
	}) as typeof process.stdout.write
	return fn()
		.finally(() => {
			process.stdout.write = original
		})
		.then((exit) => ({ exit, stdout }))
}

/** Run a function while capturing everything written to process.stdout + stderr. */
function withCapturedIo(fn: () => Promise<number>): Promise<{ exit: number; stdout: string; stderr: string }> {
	const originalOut = process.stdout.write.bind(process.stdout)
	const originalErr = process.stderr.write.bind(process.stderr)
	let stdout = ""
	let stderr = ""
	process.stdout.write = ((chunk: unknown): boolean => {
		stdout += String(chunk)
		return true
	}) as typeof process.stdout.write
	process.stderr.write = ((chunk: unknown): boolean => {
		stderr += String(chunk)
		return true
	}) as typeof process.stderr.write
	return fn()
		.finally(() => {
			process.stdout.write = originalOut
			process.stderr.write = originalErr
		})
		.then((exit) => ({ exit, stdout, stderr }))
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

function reviewSessionErrorResult(): ReviewResult {
	return {
		verdict: "error",
		findings: ["[review session error] Bounded failure: 3 consecutive mistakes (limit 3)"],
		summary: "Review session failed: Bounded failure: 3 consecutive mistakes (limit 3)",
	}
}

function qaSessionErrorResult(): QaResult {
	return {
		verdict: "error",
		evidence: "",
		summary: "QA session failed: unknown QA session error",
	}
}

function qaFailResult(evidence = "test suite fails: 2 of 14 tests error out"): QaResult {
	return {
		verdict: "fail",
		evidence,
		summary: "QA verdict: fail — the test suite does not pass",
		reportPath: "/tmp/example-repo/.worktrees/w1/.headlesscode/reports/qa-session-1.md",
	}
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

// ─── buildTaskFileContent: inline issue bodies + rules splice (fixes 1+2) ────

async function testTaskFileContentEmbedsIssueTitleAndBody(): Promise<void> {
	const content = buildTaskFileContent(
		{ name: "w1", issues: [27, 29], taskFile: "w1-issue27-29.md" },
		[
			{ number: 27, title: "Auth token validation", body: "hot path: validate the token in the request handler" },
			{ number: 29, title: "Split utils", body: "" },
		],
	)
	assert.ok(content.includes("### Issue #27: Auth token validation"), "issue title embedded in the task")
	assert.ok(content.includes("hot path: validate the token in the request handler"), "issue body embedded in the task")
	assert.ok(content.includes("### Issue #29: Split utils"), "second issue embedded too")
	assert.ok(!content.includes("gh issue view"), "no runtime gh fetch when bodies are in hand")
	assert.ok(!content.includes("rules-code/rules.md"), "no hardcoded read-the-rules-file instruction (Fix 1)")
	assert.ok(!content.includes("Hard-won lessons"), "hard-won lessons moved to the central rules-code tier (Fix 1)")
	assert.ok(content.includes("inline body above"), "workflow step 1 points at the inline bodies, not a fetch")
}

/** Fix 1 regression guard: NONE of the five task builders may tell the model
 * to go read a rules file itself — that content is spliced automatically. */
async function testAllTaskBuildersNoHardcodedRulesReadInstruction(): Promise<void> {
	const outputs = [
		buildTaskFileContent({ name: "w1", issues: [1], taskFile: "w1.md" }, []),
		buildPlanFirstTaskFileContent({ name: "w1", issues: [1] }),
		buildReworkTaskFileContent({ name: "w1", issues: [1] }, [], 1),
		buildQaReworkTaskFileContent({ name: "w1", issues: [1] }, "", 1),
		buildContinuationTaskFileContent({ name: "w1", issues: [1] }, 1),
	]
	for (const content of outputs) {
		assert.ok(!content.includes("rules-code/rules.md"), "no hardcoded rules read instruction in a task builder")
		assert.ok(content.includes("already spliced into your system prompt"), "builders note rules are spliced automatically")
	}
}

/** Issue #123 regression guard: every task builder designates the workspace
 * scratch dir and explicitly forbids /tmp (reviewers/workers wrote scratch to
 * /tmp in round-2026-08-17, violating the workspace-containment rule). */
async function testAllTaskBuildersDesignateWorkspaceScratchAndForbidTmp(): Promise<void> {
	const outputs = [
		buildTaskFileContent({ name: "w1", issues: [1], taskFile: "w1.md" }, []),
		buildPlanFirstTaskFileContent({ name: "w1", issues: [1] }),
		buildReworkTaskFileContent({ name: "w1", issues: [1] }, [], 1),
		buildQaReworkTaskFileContent({ name: "w1", issues: [1] }, "", 1),
		buildContinuationTaskFileContent({ name: "w1", issues: [1] }, 1),
	]
	for (const content of outputs) {
		assert.ok(content.includes(".headlesscode/scratch/"), "task builder points scratch at the workspace dir")
		assert.ok(
			content.includes("NEVER write to `/tmp`") || content.includes("never `/tmp`") || content.includes("No /tmp"),
			"task builder explicitly forbids /tmp",
		)
	}
}

// ─── buildQaReworkTaskFileContent (issue #52) ────────────────────────────────

async function testQaReworkTaskFileContentIncludesEvidenceAndIssues(): Promise<void> {
	const content = buildQaReworkTaskFileContent(
		{ name: "w1", issues: [52] },
		"test suite fails: 2 of 14 tests error out",
		1,
		"/tmp/example-repo/.worktrees/w1/.headlesscode/reports/qa-session-1.md",
	)
	assert.ok(content.includes("Rework cycle 1"), "content names the rework cycle")
	assert.ok(content.includes("QA findings to fix"), "section names the QA source of the cycle")
	assert.ok(content.includes("test suite fails: 2 of 14 tests error out"), "QA evidence embedded in the task")
	assert.ok(content.includes("qa-session-1.md"), "full QA report path referenced (issue #34-style)")
	assert.ok(content.includes("#52"), "original issue numbers included")
	assert.ok(content.includes("Closing Report (rework cycle 1)"), "closing template reuses the rework variant")
	assert.ok(content.includes("Scope: #52 only — rework cycle 1."), "scope line names the cycle")
}

async function testQaReworkTaskFileContentHandlesEmptyEvidence(): Promise<void> {
	const content = buildQaReworkTaskFileContent({ name: "w1", issues: [52] }, "", 2)
	assert.ok(content.includes("Rework cycle 2"))
	assert.ok(content.includes("no extractable evidence"), "empty evidence gets an explicit fallback")
	assert.ok(content.includes("#52"), "issues still present")
}

// ─── persisted issueBodies embedding (Fix 2, rework/QA/continuation) ─────────

async function testReworkTaskFileContentEmbedsPersistedIssueBodies(): Promise<void> {
	const content = buildReworkTaskFileContent(
		{ name: "w1", issues: [27], issueBodies: { "27": { title: "Auth token validation", body: "hot path body text" } } },
		["finding A"],
		1,
	)
	assert.ok(content.includes("### Issue #27: Auth token validation"), "persisted title embedded (Fix 2)")
	assert.ok(content.includes("hot path body text"), "persisted body embedded (Fix 2)")
	assert.ok(!content.includes("gh issue view"), "no gh fetch when issueBodies are persisted")

	// Regression guard for the fallback path: a group whose state predates the
	// issueBodies feature falls back to the OLD gh-issue-view wording per issue
	// (never silently produce an empty assignment section).
	const fallback = buildReworkTaskFileContent({ name: "w1", issues: [27] }, ["finding A"], 1)
	assert.ok(fallback.includes("gh issue view 27"), "fallback keeps the gh issue view instruction per issue")
}

async function testQaReworkTaskFileContentEmbedsPersistedIssueBodies(): Promise<void> {
	const content = buildQaReworkTaskFileContent(
		{ name: "w1", issues: [52], issueBodies: { "52": { title: "QA issue", body: "qa body text" } } },
		"evidence here",
		1,
	)
	assert.ok(content.includes("### Issue #52: QA issue"), "persisted title embedded (Fix 2)")
	assert.ok(content.includes("qa body text"), "persisted body embedded (Fix 2)")
	assert.ok(!content.includes("gh issue view"), "no gh fetch when issueBodies are persisted")
}

async function testContinuationTaskFileContentEmbedsPersistedIssueBodies(): Promise<void> {
	const content = buildContinuationTaskFileContent(
		{ name: "w1", issues: [29], issueBodies: { "29": { title: "Continuation issue", body: "cont body text" } } },
		1,
	)
	assert.ok(content.includes("### Issue #29: Continuation issue"), "persisted title embedded (Fix 2)")
	assert.ok(content.includes("cont body text"), "persisted body embedded (Fix 2)")
	assert.ok(!content.includes("gh issue view"), "no gh fetch when issueBodies are persisted")
	assert.ok(content.includes("inline body above"), "continuation workflow step 1 points at the inline bodies")
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
	assert.equal(decision.patch.review_report, undefined, "stale review report path cleared for a fresh cycle")
	assert.equal(decision.patch.qa, undefined, "stale QA cleared for a fresh cycle")
	assert.equal(decision.patch.reviewed_at, undefined)
	assert.equal(decision.patch.exit_code, undefined, "previous attempt's exit code cleared")
	assert.ok(typeof decision.patch.spawned === "string", "spawned reset so the stall guard measures the rework worker")
	assert.ok(decision.patch.last_activity && typeof decision.patch.last_activity === "object", "last_activity notes the rework")
}

/**
 * 2026-08-05 real bug caught live on issue #17's own round: a review-SESSION
 * failure (crash/budget/mistake-limit) was being treated exactly like a real
 * code finding and fed into handleReviewVerdict, spawning a worker to "fix"
 * a placeholder error message with nothing actionable in it. Verifies the
 * fix: a session-error verdict goes straight to needs-human, WITHOUT ever
 * calling handleReviewVerdict (no rework spawn, no reworkCount increment).
 */
async function testReviewSessionErrorGoesStraightToNeedsHumanNoRework(): Promise<void> {
	const patch = handleReviewSessionError(reviewSessionErrorResult())
	assert.equal(patch.status, "needs-human", "a review session failure must be terminal, not silently retried forever")
	assert.equal(patch.review_verdict, "error")
	assert.deepEqual(patch.pending_review_findings, [
		"[review session error] Bounded failure: 3 consecutive mistakes (limit 3)",
	])
	assert.equal(patch.reworkCount, undefined, "must NOT touch reworkCount — this never went through the rework path")
	assert.ok(
		typeof patch.last_activity === "object" && patch.last_activity !== null && "note" in patch.last_activity,
		"last_activity must explain the review session failure",
	)
}

/**
 * 2026-08-05 real bug caught live on issue #18's own round: the QA-side
 * twin of the review-session-error bug. A QA-SESSION failure (verdict
 * "error") was recorded as an ordinary "failed" QA with empty evidence,
 * leaving the group's top-level status "done" — the round settled (cost
 * recorded) with QA having never actually validated anything and no human
 * ever notified. Verifies the fix: a QA session-error goes straight to
 * needs-human.
 */
async function testQaSessionErrorGoesStraightToNeedsHuman(): Promise<void> {
	const patch = handleQaSessionError(qaSessionErrorResult())
	assert.equal(patch.status, "needs-human", "a QA session failure must be terminal, not silently settled as done")
	assert.equal(patch.qa?.verdict, "error")
	assert.equal(patch.qa?.status, "failed")
	assert.ok(
		typeof patch.last_activity === "object" && patch.last_activity !== null && "note" in patch.last_activity,
		"last_activity must explain the QA session failure",
	)
}

/**
 * Issue #52 (2026-08-05): a REAL QA "fail" verdict used to only patch the
 * nested `qa` field — the group's top-level status stayed "done" from the
 * worker's own completion, so a QA-caught bug silently settled the round
 * (cost recorded, nothing left pending). Verifies the fix: below the cap a
 * QA fail gets the SAME rework treatment as a review finding — reset to
 * running on the SAME worktree, review/QA/cost cleared, reworkCount
 * incremented, and a QA-evidence-fed task file + spawn command produced.
 */
async function testQaFailBelowCapSpawnsAndResetsState(): Promise<void> {
	const group = baseGroup({ reworkCount: 0, status: "done", issues: [52] })
	const decision = handleQaVerdict(group, qaFailResult(), "/tmp/example-repo", 3, "code")

	assert.equal(decision.shouldSpawn, true, "below the cap the QA fail gets a rework spawn")
	assert.equal(decision.newReworkCount, 1)
	assert.ok(
		decision.taskFilePath?.endsWith(path.join("plans", "parallel-tasks", "w1-qa-rework1.md")),
		`QA rework task file named <name>-qa-rework<n>.md, got ${decision.taskFilePath}`,
	)
	assert.ok(decision.taskContent && decision.taskContent.includes("test suite fails"), "QA evidence embedded in the task")
	assert.ok(decision.spawnCommand && decision.spawnCommand.includes("run-worker.sh"), "spawn command calls run-worker.sh directly")
	assert.ok(decision.spawnCommand?.includes(`--mode "code"`), "spawn command forwards the worker mode")
	assert.ok(decision.spawnCommand?.includes(".worktrees/w1"), "spawn command targets the SAME worktree (no new worktree)")

	// State reset: status back to running, review/QA/cost cleared, count incremented.
	assert.equal(decision.patch.status, "running")
	assert.equal(decision.patch.reworkCount, 1)
	assert.equal(decision.patch.review_verdict, undefined, "review_verdict cleared for a fresh cycle")
	assert.equal(decision.patch.pending_review_findings, undefined, "findings cleared for a fresh cycle")
	assert.equal(decision.patch.review_report, undefined, "stale review report path cleared for a fresh cycle")
	assert.equal(decision.patch.qa, undefined, "stale QA cleared for a fresh cycle")
	assert.equal(decision.patch.reviewed_at, undefined)
	assert.equal(decision.patch.exit_code, undefined, "previous attempt's exit code cleared")
	assert.ok(typeof decision.patch.spawned === "string", "spawned reset so the stall guard measures the rework worker")
	assert.ok(decision.patch.last_activity && typeof decision.patch.last_activity === "object", "last_activity notes the QA rework")
}

/**
 * Issue #52: the QA-fail rework reset must clear a stale cost_recorded just
 * like the review-finding reset (the rework worker adds more real cost; the
 * one-shot recording gate must re-record the combined total once the cycle
 * re-settles). Verified via the real updateGroup MERGE, not the patch literal.
 */
async function testQaFailReworkPatchActuallyClearsCostRecordedOnMerge(): Promise<void> {
	const group = baseGroup({ reworkCount: 0, status: "done", cost_recorded: "2026-08-01T00:00:00.000Z" })
	const decision = handleQaVerdict(group, qaFailResult(), "/tmp/example-repo", 3, "code")
	const state: OrchestratorState = { ...defaultState("round-1"), groups: [group] }
	const merged = updateGroup(state, "w1", decision.patch)
	assert.equal(
		merged.groups[0]?.cost_recorded,
		undefined,
		"a stale cost_recorded from the PREVIOUS attempt must not survive a QA-fail rework reset",
	)
}

/**
 * Issue #52: at the --max-rework-cycles cap a QA fail must NOT silently
 * settle as "done" — it goes terminal needs-human with the QA verdict and
 * evidence left recorded so a human can see exactly what failed.
 */
async function testQaFailAtCapMarksNeedsHumanAndDoesNotSpawn(): Promise<void> {
	const group = baseGroup({ reworkCount: 3, status: "done", issues: [52] })
	const result = qaFailResult("integration test still red")
	const decision = handleQaVerdict(group, result, "/tmp/example-repo", 3, "code")

	assert.equal(decision.shouldSpawn, false, "at the cap nothing is spawned again")
	assert.equal(decision.newReworkCount, 3, "count not incremented — no new attempt happens")
	assert.equal(decision.taskFilePath, undefined)
	assert.equal(decision.spawnCommand, undefined)
	assert.equal(decision.patch.status, "needs-human", "distinct terminal state, not failed/done")
	assert.equal(decision.patch.reworkCount, 3)
	assert.equal(decision.patch.qa?.verdict, "fail", "QA verdict stays recorded for the human")
	assert.equal(decision.patch.qa?.status, "failed")
	assert.equal(decision.patch.qa?.evidence, "integration test still red", "QA evidence stays recorded for the human")
	assert.ok(
		typeof decision.patch.last_activity === "object" && "note" in (decision.patch.last_activity ?? {}),
		"last_activity explains the gave-up reason",
	)
}

/**
 * Issue #52 regression guard: a QA "pass" verdict is NOT new work — it must
 * never route through handleQaVerdict (no reworkCount bump, no status change).
 * The watch loop only calls handleQaVerdict on verdict "fail".
 */
async function testQaPassNeverTouchesReworkCount(): Promise<void> {
	const group = baseGroup({ reworkCount: 2, status: "done" })
	const state = updateGroup({ groups: [group] }, "w1", {
		qa: {
			status: "done",
			verdict: "pass",
			evidence: "all green",
			report: "/tmp/example-repo/.worktrees/w1/.headlesscode/reports/qa-pass-1.md",
			updated: "2026-08-01T00:00:00.000Z",
		},
		last_activity: { note: "QA: verdict=pass" },
	})
	assert.equal(state.groups[0].reworkCount, 2, "a QA pass must not increment reworkCount")
	assert.equal(state.groups[0].qa?.verdict, "pass")
	assert.equal(state.groups[0].status, "done", "a QA pass keeps the group settled as done")
}

/**
 * 2026-08-05 real bug caught while manually recovering a stuck round: a
 * rework/continuation respawn adds MORE real cost on the same worktree,
 * but the reset patch never cleared `cost_recorded` — so once the fresh
 * cycle re-settled, cost-history.ts's one-shot recording gate silently
 * skipped re-recording the combined total forever. Verifies the actual
 * MERGE behavior via updateGroup (not just that the patch literal contains
 * `undefined`, which can't distinguish "explicitly cleared" from "key
 * simply absent" — only the merged result proves the old value is gone).
 */
async function testReworkPatchActuallyClearsCostRecordedOnMerge(): Promise<void> {
	const group = baseGroup({ reworkCount: 0, status: "done", cost_recorded: "2026-08-01T00:00:00.000Z" })
	const decision = handleReviewVerdict(group, findingResult(), "/tmp/example-repo", 3, "code")
	const state: OrchestratorState = { ...defaultState("round-1"), groups: [group] }
	const merged = updateGroup(state, "w1", decision.patch)
	assert.equal(
		merged.groups[0]?.cost_recorded,
		undefined,
		"a stale cost_recorded from the PREVIOUS attempt must not survive a rework reset",
	)
}

async function testContinuationPatchActuallyClearsCostRecordedOnMerge(): Promise<void> {
	const group = baseGroup({
		continuationCount: 0,
		status: "failed",
		summary: "headlesscode: task failed: Max iterations (50) reached without task completion",
		cost_recorded: "2026-08-01T00:00:00.000Z",
	})
	const decision = handleIterationExhaustion(group, "/tmp/example-repo", 3, "code")
	assert.equal(decision.shouldSpawn, true)
	const state: OrchestratorState = { ...defaultState("round-1"), groups: [group] }
	const merged = updateGroup(state, "w1", decision.patch)
	assert.equal(
		merged.groups[0]?.cost_recorded,
		undefined,
		"a stale cost_recorded from the PREVIOUS attempt must not survive a continuation reset",
	)
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

/**
 * Issue #34: the new report-pointer fields (`qa.report`, `review_report`)
 * are part of the state schema — they must survive an updateGroup merge and
 * a saveStateSync/loadStateSync round-trip, so a human reading the state
 * file can follow the pointer to the COMPLETE final report.
 */
async function testReportPointerFieldsSurviveStateRoundTrip(): Promise<void> {
	const repo = await tmpRepo()
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	try {
		const group = baseGroup({
			review_report: path.join(repo, ".worktrees", "w1", ".headlesscode", "reports", "review-session-1.md"),
			qa: {
				status: "failed",
				verdict: "fail",
				evidence: "short slice",
				report: path.join(repo, ".worktrees", "w1", ".headlesscode", "reports", "qa-session-1.md"),
				updated: new Date().toISOString(),
			},
		})
		const state = updateGroup({ ...defaultState("round-1"), groups: [] }, "w1", group)
		await saveStateSync(statePath, state)
		const reloaded = loadStateSync(statePath)
		assert.equal(
			reloaded.groups[0]?.review_report,
			group.review_report,
			"review_report survives the state round-trip",
		)
		assert.equal(reloaded.groups[0]?.qa?.report, group.qa?.report, "qa.report survives the state round-trip")
		assert.equal(reloaded.groups[0]?.qa?.evidence, "short slice", "the lightweight evidence slice is still there")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
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

// ─── parseOrchestrateArgs: --file-issues (Fix 3) ─────────────────────────────

async function testParseOrchestrateArgsFileIssues(): Promise<void> {
	const withJson = parseOrchestrateArgs(["--repo", "/tmp/x", "--issues-json", "issues.json", "--file-issues"])
	assert.equal(withJson.error, undefined, "--file-issues with --issues-json parses")
	assert.equal(withJson.options.fileIssues, true)
	assert.equal(withJson.options.issuesJson, "issues.json")

	const withoutJson = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--file-issues"])
	assert.ok(
		withoutJson.error && withoutJson.error.includes("requires --issues-json"),
		"--file-issues without --issues-json is a usage error (exit-2 convention)",
	)

	const off = parseOrchestrateArgs(["--repo", "/tmp/x", "--issues-json", "issues.json"])
	assert.equal(off.error, undefined)
	assert.equal(off.options.fileIssues, false, "default off — filing is opt-in, never automatic")
}

// ─── fileSyntheticIssues (Fix 3, pure number-substitution logic) ─────────────

async function testFileSyntheticIssuesSubstitutesRealNumbers(): Promise<void> {
	const issues = [
		{ number: 101, title: "synthetic one", body: "body 1" },
		{ number: 102, title: "synthetic two", body: undefined },
	]
	let nextNumber = 500
	const result = fileSyntheticIssues(issues, (issue) => {
		const number = ++nextNumber
		return { number, url: `https://github.com/acme/proj/issues/${number}` }
	})
	assert.equal(result.created.length, 2, "one created record per filed issue")
	assert.deepEqual(
		result.issues.map((i) => i.number),
		[501, 502],
		"synthetic numbers replaced with the real returned numbers",
	)
	assert.equal(result.issues[0]?.title, "synthetic one", "title preserved through substitution")
	assert.equal(result.issues[0]?.body, "body 1", "body preserved through substitution")
	assert.equal(result.created[0]?.url, "https://github.com/acme/proj/issues/501", "created record carries the real URL")
	assert.equal(result.created[1]?.number, 502, "created records carry the real numbers")
}

async function testFileSyntheticIssuesLeavesRealSourcedEntriesUntouched(): Promise<void> {
	const issues = [
		{ number: 7, title: "real issue (gh-sourced)", body: "real body" },
		{ number: 101, title: "synthetic one", body: "body 1" },
	]
	// Gated on "loaded via --issues-json": only the entries the caller marks
	// for filing (the synthetic ones) get filed; anything already carrying a
	// real number passes through byte-identical.
	const result = fileSyntheticIssues(issues, (issue) => ({ number: 900, url: "https://github.com/acme/proj/issues/900" }), (i) =>
		i.number === 101,
	)
	assert.equal(result.created.length, 1, "only the flagged synthetic entry is filed")
	assert.equal(result.issues[0]?.number, 7, "real-sourced entry untouched")
	assert.equal(result.issues[0]?.title, "real issue (gh-sourced)", "real-sourced entry title untouched")
	assert.equal(result.issues[1]?.number, 900, "synthetic entry replaced with the real number")
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

// ─── First-spawn env: the resolved worker model reaches spawnSync ────────────
// The mode-models-first-spawn fix: orchestrateMain resolves the worker's model
// BEFORE the initial spawnSync and threads it into that call's env as
// OPENROUTER_MODEL (the spawner + run-worker.sh inherit it). buildSpawnEnv is
// the extracted, exported builder — inspect its output env, don't just check
// "no error".

async function testSpawnEnvCarriesResolvedModelWhenModeMapped(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// A mode-models.json entry for the worker's mode (code).
		await fs.mkdir(path.join(repo, ".headlesscode"), { recursive: true })
		await fs.writeFile(
			path.join(repo, ".headlesscode", "mode-models.json"),
			JSON.stringify({ code: "deepseek/deepseek-code-model" }, null, 2) + "\n",
			"utf-8",
		)
		const baseEnv = { OPENROUTER_MODEL: "deepseek/deepseek-env-model" }
		const { env, workerModel } = buildSpawnEnv({ repo, mode: "code", env: baseEnv })
		assert.equal(workerModel, "deepseek/deepseek-code-model", "the config entry resolves for the worker's mode")
		assert.equal(
			env.OPENROUTER_MODEL,
			"deepseek/deepseek-code-model",
			"the spawn env carries the RESOLVED model (not the raw env var)",
		)
		// The rest of the spawn env contract is untouched.
		assert.equal(env.TARGET_REPO, repo)
		assert.equal(env.ORCHESTRATOR_MODE, "code")
		assert.equal(env.HEADLESSCODE_PROJECT, path.basename(repo))
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testSpawnEnvCarriesResolvedModelFromDefaultKey(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await fs.mkdir(path.join(repo, ".headlesscode"), { recursive: true })
		await fs.writeFile(
			path.join(repo, ".headlesscode", "mode-models.json"),
			JSON.stringify({ _default: "deepseek/deepseek-default-model" }, null, 2) + "\n",
			"utf-8",
		)
		const { env, workerModel } = buildSpawnEnv({ repo, mode: "code", env: {} })
		assert.equal(workerModel, "deepseek/deepseek-default-model")
		assert.equal(env.OPENROUTER_MODEL, "deepseek/deepseek-default-model")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testSpawnEnvExplicitModelFlagBeatsConfig(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await fs.mkdir(path.join(repo, ".headlesscode"), { recursive: true })
		await fs.writeFile(
			path.join(repo, ".headlesscode", "mode-models.json"),
			JSON.stringify({ code: "deepseek/deepseek-from-file" }, null, 2) + "\n",
			"utf-8",
		)
		const { env, workerModel } = buildSpawnEnv({
			repo,
			mode: "code",
			explicitModel: "deepseek/deepseek-from-flag",
			env: {},
		})
		assert.equal(workerModel, "deepseek/deepseek-from-flag", "an explicit --model always wins (rule 1)")
		assert.equal(env.OPENROUTER_MODEL, "deepseek/deepseek-from-flag")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testSpawnEnvNoConfigKeepsRawEnvModel(): Promise<void> {
	// Regression: no mode-models.json — today's blanket override pattern
	// (OPENROUTER_MODEL=... orchestrate ...) must pass the raw env value
	// through unchanged.
	const repo = await tmpRepo()
	try {
		const { env, workerModel } = buildSpawnEnv({
			repo,
			mode: "code",
			env: { OPENROUTER_MODEL: "deepseek/deepseek-env-model" },
		})
		assert.equal(workerModel, "deepseek/deepseek-env-model")
		assert.equal(env.OPENROUTER_MODEL, "deepseek/deepseek-env-model")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testSpawnEnvNoConfigNoEnvLeavesModelUnset(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { env, workerModel } = buildSpawnEnv({ repo, mode: "code", env: {} })
		assert.equal(workerModel, undefined, "nothing configured -> no model (the CLI's own default applies)")
		assert.equal(env.OPENROUTER_MODEL, undefined, "no OPENROUTER_MODEL injected when nothing resolves")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── --max-iterations / --max-continuations parsing ─────────────────────────

async function testParseOrchestrateArgsMaxIterations(): Promise<void> {
	// Ambient-proof: HEADLESSCODE_MAX_ITERATIONS is a real orchestration knob
	// an operator may legitimately have exported — the "neither flag nor env"
	// case must not depend on the ambient env being clean.
	const savedMaxIterations = process.env.HEADLESSCODE_MAX_ITERATIONS
	delete process.env.HEADLESSCODE_MAX_ITERATIONS
	try {
		// Default with neither a flag nor the env var: undefined -> the
		// harness's own default (50) applies untouched (the issue only makes
		// it overridable).
		const def = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1"])
		assert.equal(def.error, undefined)
		assert.equal(def.options.maxIterations, undefined, "no flag/env -> leave the harness default untouched")

	// Env fallback when no flag is given.
	process.env.HEADLESSCODE_MAX_ITERATIONS = "75"
	try {
		const fromEnv = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1"])
		assert.equal(fromEnv.error, undefined)
		assert.equal(fromEnv.options.maxIterations, 75, "env fallback applies when no flag")
	} finally {
		delete process.env.HEADLESSCODE_MAX_ITERATIONS
	}

	// An explicit flag beats the env fallback.
	process.env.HEADLESSCODE_MAX_ITERATIONS = "75"
	try {
		const flag = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--max-iterations", "120"])
		assert.equal(flag.error, undefined)
		assert.equal(flag.options.maxIterations, 120, "explicit flag beats the env fallback")
	} finally {
		delete process.env.HEADLESSCODE_MAX_ITERATIONS
	}

	const bad = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--max-iterations", "abc"])
	assert.ok(bad.error && bad.error.includes("positive integer"), "non-numeric is rejected")

	const zero = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--max-iterations", "0"])
	assert.ok(zero.error && zero.error.includes("positive integer"), "0 is rejected")
	} finally {
		if (savedMaxIterations === undefined) {
			delete process.env.HEADLESSCODE_MAX_ITERATIONS
		} else {
			process.env.HEADLESSCODE_MAX_ITERATIONS = savedMaxIterations
		}
	}
}

async function testParseOrchestrateArgsMaxContinuations(): Promise<void> {
	const def = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1"])
	assert.equal(def.error, undefined)
	assert.equal(def.options.maxContinuations, 3, "default continuation cap is 3")

	const custom = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--max-continuations", "5"])
	assert.equal(custom.error, undefined)
	assert.equal(custom.options.maxContinuations, 5)

	const zero = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--max-continuations", "0"])
	assert.ok(zero.error && zero.error.includes("positive integer"), "0 is rejected")

	const bad = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--max-continuations", "x"])
	assert.ok(bad.error && bad.error.includes("positive integer"), "non-numeric is rejected")
}

// ─── --no-preflight (issue #13) ──────────────────────────────────────────────

async function testParseOrchestrateArgsNoPreflight(): Promise<void> {
	// The preflight probe is ON by default — the failure it catches costs
	// 10-15 min + real spend before it surfaces otherwise.
	const def = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1"])
	assert.equal(def.error, undefined)
	assert.equal(def.options.preflight, true, "preflight is on by default")

	const skipped = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--no-preflight"])
	assert.equal(skipped.error, undefined)
	assert.equal(skipped.options.preflight, false, "--no-preflight turns the probe off for CI/non-interactive")
}

// ─── --no-issue-size-check (issue #53) ──────────────────────────────────────

async function testParseOrchestrateArgsNoIssueSizeCheck(): Promise<void> {
	// The pre-flight size warning is ON by default (it's free — a pure
	// deterministic scan, unlike the preflight probe's network round-trip).
	const def = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1"])
	assert.equal(def.error, undefined)
	assert.equal(def.options.issueSizeCheck, true, "issue-size check is on by default")

	const skipped = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--no-issue-size-check"])
	assert.equal(skipped.error, undefined)
	assert.equal(skipped.options.issueSizeCheck, false, "--no-issue-size-check silences the warning")
}

async function testOrchestrateMainDryRunWarnsOnOversizedIssue(): Promise<void> {
	// Issue #53: an issue whose body enumerates 3+ independent pieces must
	// produce a loud pre-dispatch warning — but the warning never aborts the
	// round (a crude heuristic can false-positive; the operator decides).
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([
				{
					number: 17,
					title: "Codemap Phase 1",
					body: "Three pieces:\n1. Build the index\n2. Wire the search\n3. Ship the dashboard",
				},
			]),
			"utf-8",
		)
		const { exit, stdout, stderr } = await withCapturedIo(() =>
			orchestrateMain(["--repo", repo, "--issues-json", issuesPath, "--dry-run"]),
		)
		assert.equal(exit, 0, "the warning must never abort the round")
		assert.ok(stdout.includes("Split plan"), "dry-run still prints the full plan")
		assert.ok(stderr.includes("issue #17"), `names the oversized issue, got: ${stderr}`)
		assert.ok(stderr.includes("3 independent pieces of work"), `states the detected section count, got: ${stderr}`)
		assert.ok(stderr.includes("splitting it into 3 sub-issues"), `suggests splitting before dispatch, got: ${stderr}`)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOrchestrateMainDryRunNoIssueSizeWarningWithFlag(): Promise<void> {
	// --no-issue-size-check silences the warning for operators who know what
	// they're doing; everything else about the dry-run is unchanged.
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([
				{
					number: 17,
					title: "Codemap Phase 1",
					body: "Three pieces:\n1. Build the index\n2. Wire the search\n3. Ship the dashboard",
				},
			]),
			"utf-8",
		)
		const { exit, stdout, stderr } = await withCapturedIo(() =>
			orchestrateMain(["--repo", repo, "--issues-json", issuesPath, "--dry-run", "--no-issue-size-check"]),
		)
		assert.equal(exit, 0)
		assert.ok(stdout.includes("Split plan"), "dry-run plan still printed")
		assert.ok(!stderr.includes("independent pieces of work"), "--no-issue-size-check suppresses the warning")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOrchestrateMainDryRunNoWarningForSmallIssue(): Promise<void> {
	// No false positive on a genuinely small issue: no warning, no abort.
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([{ number: 1, title: "Fix the thing", body: "Just one focused change." }]),
			"utf-8",
		)
		const { exit, stderr } = await withCapturedStderr(() =>
			orchestrateMain(["--repo", repo, "--issues-json", issuesPath, "--dry-run"]),
		)
		assert.equal(exit, 0)
		assert.ok(!stderr.includes("independent pieces of work"), "small issue produces no size warning")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testSpawnEnvCarriesMaxIterations(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// Explicit cap -> the spawn env carries it as HEADLESSCODE_MAX_ITERATIONS
		// (run-worker.sh forwards it as --max-iterations to the worker CLI).
		const { env } = buildSpawnEnv({ repo, mode: "code", maxIterations: 123, env: {} })
		assert.equal(env.HEADLESSCODE_MAX_ITERATIONS, "123", "explicit cap forwarded to the spawn env")

		// undefined cap -> the inherited env var (if any) passes through untouched.
		const withEnv = buildSpawnEnv({ repo, mode: "code", env: { HEADLESSCODE_MAX_ITERATIONS: "99" } })
		assert.equal(withEnv.env.HEADLESSCODE_MAX_ITERATIONS, "99", "undefined cap leaves the inherited env var alone")

		// Explicit cap beats the inherited env var.
		const flagBeatsEnv = buildSpawnEnv({ repo, mode: "code", maxIterations: 200, env: { HEADLESSCODE_MAX_ITERATIONS: "99" } })
		assert.equal(flagBeatsEnv.env.HEADLESSCODE_MAX_ITERATIONS, "200", "explicit cap beats the inherited env var")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── --plan-first (issue #49) ────────────────────────────────────────────────

async function testParseOrchestrateArgsPlanFirst(): Promise<void> {
	// Ambient-proof: HEADLESSCODE_PLAN_FIRST_MODE / _MAX_ITERATIONS are real
	// knobs an operator may legitimately have exported — the default case must
	// not depend on the ambient env being clean.
	const savedMode = process.env.HEADLESSCODE_PLAN_FIRST_MODE
	const savedMax = process.env.HEADLESSCODE_PLAN_FIRST_MAX_ITERATIONS
	delete process.env.HEADLESSCODE_PLAN_FIRST_MODE
	delete process.env.HEADLESSCODE_PLAN_FIRST_MAX_ITERATIONS
	try {
		// Opt-in: OFF by default (the issue is explicit that plan-first must
		// never be the default without evidence).
		const def = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1"])
		assert.equal(def.error, undefined)
		assert.equal(def.options.planFirst, false, "plan-first is OFF by default")
		assert.equal(def.options.planFirstMode, "architect", "default plan-first mode is architect")
		assert.equal(def.options.planFirstMaxIterations, 15, "default plan-first cap is 15 (deliberately short)")

		// --plan-first alone turns it on with the defaults.
		const on = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--plan-first"])
		assert.equal(on.error, undefined)
		assert.equal(on.options.planFirst, true, "--plan-first turns the phase on")
		assert.equal(on.options.planFirstMode, "architect", "mode defaults to architect when not overridden")
		assert.equal(on.options.planFirstMaxIterations, 15, "cap defaults to 15 when not overridden")

		// Custom mode + cap.
		const custom = parseOrchestrateArgs([
			"--repo", "/tmp/x", "--issue", "1",
			"--plan-first", "--plan-first-mode", "planner", "--plan-first-max-iterations", "8",
		])
		assert.equal(custom.error, undefined)
		assert.equal(custom.options.planFirst, true)
		assert.equal(custom.options.planFirstMode, "planner", "custom plan-first mode honored")
		assert.equal(custom.options.planFirstMaxIterations, 8, "custom plan-first cap honored")

		// Invalid values are rejected like every other numeric knob.
		const bad = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--plan-first-max-iterations", "x"])
		assert.ok(bad.error && bad.error.includes("positive integer"), "non-numeric plan-first cap is rejected")
		const zero = parseOrchestrateArgs(["--repo", "/tmp/x", "--issue", "1", "--plan-first-max-iterations", "0"])
		assert.ok(zero.error && zero.error.includes("positive integer"), "0 plan-first cap is rejected")
	} finally {
		if (savedMode === undefined) {
			delete process.env.HEADLESSCODE_PLAN_FIRST_MODE
		} else {
			process.env.HEADLESSCODE_PLAN_FIRST_MODE = savedMode
		}
		if (savedMax === undefined) {
			delete process.env.HEADLESSCODE_PLAN_FIRST_MAX_ITERATIONS
		} else {
			process.env.HEADLESSCODE_PLAN_FIRST_MAX_ITERATIONS = savedMax
		}
	}
}

async function testBuildPlanFirstTaskFileContent(): Promise<void> {
	const content = buildPlanFirstTaskFileContent({ name: "w1", issues: [27, 29] })
	assert.ok(content.includes("PLANNING phase"), "names the planning role")
	assert.ok(content.includes("ORCHESTRATOR_TASK.md"), "points the planner at the worker's full task file")
	assert.ok(content.includes("PLAN.md"), "tells the planner where to write the plan")
	assert.ok(content.includes("#27, #29"), "original issue numbers included")
	assert.ok(content.includes("gh issue view 27") && content.includes("gh issue view 29"), "gh fetch lines included")
	assert.ok(content.includes("DO NOT implement"), "planning only — no implementation")
	assert.ok(content.includes("DO NOT ask the human"), "headless — no clarifying questions")
	assert.ok(content.includes("DO NOT use switch_mode"), "the planner must end with attempt_completion")
	assert.ok(content.includes("Scope: #27, #29 only — planning phase."), "scope line present")

	// A group with no recorded issues must still produce a valid planner task.
	const noIssues = buildPlanFirstTaskFileContent({ name: "w1" })
	assert.ok(noIssues.includes("read ORCHESTRATOR_TASK.md"), "no-issues fallback directs the planner to the task file")
}

async function testPlanFirstTaskFileContentEmbedsIssueTitleAndBody(): Promise<void> {
	const content = buildPlanFirstTaskFileContent(
		{ name: "w1", issues: [27, 29] },
		[
			{ number: 27, title: "Auth token validation", body: "hot path body text" },
			{ number: 29, title: "Split utils", body: "split body text" },
		],
	)
	assert.ok(content.includes("### Issue #27: Auth token validation"), "issue title embedded (Fix 2)")
	assert.ok(content.includes("hot path body text"), "issue body embedded (Fix 2)")
	assert.ok(!content.includes("gh issue view"), "no runtime gh fetch when bodies are in hand")
	assert.ok(content.includes("inline bodies above"), "planner reads the inline bodies, not a fetch")
}

async function testWriteTaskFilesWritesPlanFilesWhenPlanFirst(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const specs = [
			{ name: "w1", issues: [1], taskFile: "w1-issue1.md" },
			{ name: "w2", issues: [2], taskFile: "w2-issue2.md" },
		]
		const issues = [
			{ number: 1, title: "t1", body: "b1" },
			{ number: 2, title: "t2", body: "b2" },
		]

		// Plain round: only the worker task files.
		const plain = writeTaskFiles(repo, specs, issues)
		assert.equal(plain.length, 2, "plain round writes only the worker task files")
		assert.ok(plain.some((p) => p.endsWith("w1-issue1.md")))
		assert.ok(!plain.some((p) => p.includes("-plan.md")), "no plan files without planFirst")

		// Plan-first round: worker task files PLUS <name>-plan.md per spec.
		const planned = writeTaskFiles(repo, specs, issues, { planFirst: true })
		assert.equal(planned.length, 4, "plan-first round writes worker + plan task files")
		const planW1 = await fs.readFile(path.join(repo, "plans", "parallel-tasks", "w1-plan.md"), "utf-8")
		assert.ok(planW1.includes("PLANNING phase"), "w1-plan.md is the planner task")
		assert.ok(
			await fs
				.readFile(path.join(repo, "plans", "parallel-tasks", "w1-issue1.md"), "utf-8")
				.then((c) => c.includes("## Your assignment")),
			"the worker task file is unchanged",
		)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testSpawnEnvCarriesPlanFirst(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// Off (the default): none of the PLAN_FIRST* vars leak into the env.
		const off = buildSpawnEnv({ repo, mode: "code", env: {} })
		assert.equal(off.env.PLAN_FIRST, undefined, "no PLAN_FIRST when plan-first is off")
		assert.equal(off.env.PLAN_FIRST_MODE, undefined, "no PLAN_FIRST_MODE when plan-first is off")
		assert.equal(off.env.PLAN_FIRST_MAX_ITERATIONS, undefined, "no PLAN_FIRST_MAX_ITERATIONS when plan-first is off")

		// On: the spawner needs mode + cap to run the plan session.
		const on = buildSpawnEnv({ repo, mode: "code", planFirst: true, planFirstMode: "architect", planFirstMaxIterations: 8, env: {} })
		assert.equal(on.env.PLAN_FIRST, "1", "PLAN_FIRST=1 reaches the spawner")
		assert.equal(on.env.PLAN_FIRST_MODE, "architect", "PLAN_FIRST_MODE reaches the spawner")
		assert.equal(on.env.PLAN_FIRST_MAX_ITERATIONS, "8", "PLAN_FIRST_MAX_ITERATIONS reaches the spawner")

		// Defaults when only planFirst is given.
		const defaults = buildSpawnEnv({ repo, mode: "code", planFirst: true, env: {} })
		assert.equal(defaults.env.PLAN_FIRST_MODE, "architect", "mode defaults to architect")
		assert.equal(defaults.env.PLAN_FIRST_MAX_ITERATIONS, "15", "cap defaults to 15")

		// The rest of the spawn env contract is untouched.
		assert.equal(on.env.ORCHESTRATOR_MODE, "code")
		assert.equal(on.env.TARGET_REPO, repo)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── buildContinuationTaskFileContent ────────────────────────────────────────

async function testContinuationTaskFileContentIncludesIssuesAndCycle(): Promise<void> {
	const content = buildContinuationTaskFileContent({ name: "w1", issues: [27, 29] }, 2)
	assert.ok(content.includes("Continuation cycle 2"), "content names the continuation cycle")
	assert.ok(content.includes("#27, #29"), "original issue numbers included")
	assert.ok(content.includes("gh issue view 27") && content.includes("gh issue view 29"), "gh fetch lines included")
	assert.ok(content.includes("iteration cap"), "explains WHY the previous session stopped")
	assert.ok(content.includes("Closing Report (continuation cycle 2)"), "closing template reuses the continuation variant")
	assert.ok(content.includes("Scope: #27, #29 only — continuation cycle 2."), "scope line names the cycle")

	// A group with no recorded issues must still produce a valid task.
	const noIssues = buildContinuationTaskFileContent({ name: "w1" }, 1)
	assert.ok(noIssues.includes("inspect the worktree"), "no-issues fallback text present")
}

// ─── handleIterationExhaustion ───────────────────────────────────────────────

/** A group whose worker failed specifically because it hit the iteration cap. */
function exhaustedGroup(overrides: Partial<OrchestratorGroup> = {}): OrchestratorGroup {
	return baseGroup({
		status: "failed",
		exit_code: 1,
		summary: "headlesscode: task failed: Max iterations (50) reached without task completion",
		...overrides,
	})
}

async function testExhaustionBelowCapSpawnsAndResetsState(): Promise<void> {
	const group = exhaustedGroup({ issues: [27], continuationCount: 0 })
	const decision = handleIterationExhaustion(group, "/tmp/example-repo", 3, "code")

	assert.equal(decision.shouldSpawn, true, "below the cap the group gets a continuation spawn")
	assert.equal(decision.newContinuationCount, 1)
	assert.ok(
		decision.taskFilePath?.endsWith(path.join("plans", "parallel-tasks", "w1-continue1.md")),
		`continuation task file named <name>-continue<n>.md, got ${decision.taskFilePath}`,
	)
	assert.ok(decision.taskContent && decision.taskContent.includes("Continuation cycle 1"), "cycle number embedded in the task")
	assert.ok(decision.spawnCommand && decision.spawnCommand.includes("run-worker.sh"), "spawn command calls run-worker.sh directly")
	assert.ok(decision.spawnCommand?.includes(`--mode "code"`), "spawn command forwards the worker mode")
	assert.ok(decision.spawnCommand?.includes(".worktrees/w1"), "spawn command targets the SAME worktree (no new worktree)")

	// State reset: status back to running, completion artifacts cleared, count incremented.
	assert.equal(decision.patch.status, "running")
	assert.equal(decision.patch.continuationCount, 1)
	assert.equal(decision.patch.exit_code, undefined, "previous attempt's exit code cleared")
	assert.equal(decision.patch.summary, undefined, "previous attempt's summary cleared")
	assert.equal(decision.patch.review_verdict, undefined, "review verdict cleared for a fresh session")
	assert.equal(decision.patch.qa, undefined, "stale QA cleared for a fresh session")
	assert.ok(typeof decision.patch.spawned === "string", "spawned reset so the stall guard measures the continuation worker")
	assert.ok(decision.patch.last_activity && typeof decision.patch.last_activity === "object", "last_activity notes the continuation")
}

async function testExhaustionIncrementsFromExistingCount(): Promise<void> {
	// A group already on its 2nd continuation moves to its 3rd.
	const group = exhaustedGroup({ continuationCount: 2 })
	const decision = handleIterationExhaustion(group, "/tmp/repo", 3, "code")
	assert.equal(decision.shouldSpawn, true)
	assert.equal(decision.newContinuationCount, 3)
	assert.ok(
		decision.taskFilePath?.endsWith(path.join("plans", "parallel-tasks", "w1-continue3.md")),
		"each cycle writes a NEW task file (prior files not overwritten)",
	)
	assert.equal(decision.patch.continuationCount, 3)
}

async function testExhaustionAtCapMarksNeedsHumanAndDoesNotSpawn(): Promise<void> {
	const group = exhaustedGroup({ continuationCount: 3 })
	const decision = handleIterationExhaustion(group, "/tmp/repo", 3, "code")

	assert.equal(decision.shouldSpawn, false, "at the cap nothing is spawned again")
	assert.equal(decision.newContinuationCount, 3, "count not incremented — no new attempt happens")
	assert.equal(decision.taskFilePath, undefined)
	assert.equal(decision.spawnCommand, undefined)
	assert.equal(decision.patch.status, "needs-human", "distinct terminal state, not failed/done")
	assert.equal(decision.patch.continuationCount, 3)
	const activity = decision.patch.last_activity
	assert.ok(activity && typeof activity === "object" && "note" in activity, "last_activity explains the gave-up reason")
}

async function testBudgetFailureDoesNotContinue(): Promise<void> {
	// A budget stop is a deliberate guardrail, NOT "task too big" — it must
	// never trigger a continuation (the group stays failed).
	const group = baseGroup({
		status: "failed",
		exit_code: 1,
		summary: "headlesscode: task aborted by budget: max cost exceeded",
	})
	const decision = handleIterationExhaustion(group, "/tmp/repo", 3, "code")
	assert.equal(decision.shouldSpawn, false, "a budget stop must never auto-continue")
	assert.equal(decision.newContinuationCount, 0)
	assert.deepEqual(decision.patch, {}, "no state patch — the watcher's failed status stands")
}

async function testGenericFailureDoesNotContinue(): Promise<void> {
	const group = baseGroup({ status: "failed", exit_code: 1, summary: "headlesscode: task failed: consecutive mistakes" })
	const decision = handleIterationExhaustion(group, "/tmp/repo", 3, "code")
	assert.equal(decision.shouldSpawn, false, "a real error must never auto-continue")
	assert.deepEqual(decision.patch, {})
}

async function testCleanExitWithMaxIterationsTextDoesNotContinue(): Promise<void> {
	// The string in the log tail alone is not enough — only a NON-ZERO exit
	// combined with the exhaustion message is a continuable failure.
	const group = baseGroup({
		status: "done",
		exit_code: 0,
		summary: "informational: Max iterations (50) reached without task completion",
	})
	const decision = handleIterationExhaustion(group, "/tmp/repo", 3, "code")
	assert.equal(decision.shouldSpawn, false, "a clean exit is never continuable")
	assert.deepEqual(decision.patch, {})
}

async function testExhaustionSpawnForwardsMaxIterations(): Promise<void> {
	const group = exhaustedGroup()
	const withCap = handleIterationExhaustion(group, "/tmp/repo", 3, "code", undefined, 7)
	assert.ok(
		withCap.spawnCommand?.includes('--max-iterations "7"'),
		"continuation spawn forwards the round-level iteration cap, got " + withCap.spawnCommand,
	)
	const withoutCap = handleIterationExhaustion(group, "/tmp/repo", 3, "code")
	assert.ok(!withoutCap.spawnCommand?.includes("--max-iterations"), "no cap -> no flag (harness default applies)")
}

// ─── handleIterationExhaustion: transient provider failures also auto-continue ──
// A hard-pinned model with no fallback provider hit an HTTP 520 mid-session
// live (2026-08-08) and killed the whole thing — this earns the SAME
// bounded auto-continue treatment as the iteration cap (isProviderFailure),
// not the generic "failed, no continuation" path.

function providerFailureGroup(overrides: Partial<OrchestratorGroup> = {}): OrchestratorGroup {
	return baseGroup({
		status: "failed",
		exit_code: 1,
		summary:
			'headlesscode: task failed: LLM request failed on iteration 28: OpenRouter returned HTTP 520: {"error":{"message":"Provider returned error","code":520,"metadata":{"provider_name":"DeepSeek"}}}',
		...overrides,
	})
}

async function testProviderFailureBelowCapSpawnsAndResetsState(): Promise<void> {
	const group = providerFailureGroup({ issues: [27], continuationCount: 0 })
	const decision = handleIterationExhaustion(group, "/tmp/example-repo", 3, "code")

	assert.equal(decision.shouldSpawn, true, "a transient provider failure below the cap gets a continuation spawn")
	assert.equal(decision.newContinuationCount, 1)
	assert.equal(decision.patch.status, "running")
	assert.equal(decision.patch.exit_code, undefined, "previous attempt's exit code cleared")
	assert.equal(decision.patch.summary, undefined, "previous attempt's summary cleared")
}

async function testProviderFailureAtCapMarksNeedsHuman(): Promise<void> {
	const group = providerFailureGroup({ continuationCount: 3 })
	const decision = handleIterationExhaustion(group, "/tmp/repo", 3, "code")
	assert.equal(decision.shouldSpawn, false, "at the cap a provider failure still stops auto-continuing")
	assert.equal(decision.patch.status, "needs-human", "still surfaces to a human eventually, just after a few free retries")
}

async function testDeterministicProviderErrorDoesNotContinue(): Promise<void> {
	// A 401 (bad API key) is deterministic — retrying changes nothing, so this
	// must fall to the generic "failed, no continuation" path, not auto-continue.
	const group = baseGroup({
		status: "failed",
		exit_code: 1,
		summary: 'headlesscode: task failed: LLM request failed on iteration 2: OpenRouter returned HTTP 401: {"error":{"message":"Invalid API key"}}',
	})
	const decision = handleIterationExhaustion(group, "/tmp/repo", 3, "code")
	assert.equal(decision.shouldSpawn, false, "a deterministic 4xx must never auto-continue")
	assert.deepEqual(decision.patch, {})
}

// ─── watchGroups re-polls a group after a continuation reset ─────────────────
// Mirrors the rework-loop test above: after onGroupUpdate resets a failed
// group to "running" (and the watcher reloads on the callback's `true`), the
// polling loop picks the group back up as running → done.

async function testWatchGroupsRepollsGroupAfterContinuationReset(): Promise<void> {
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
		// First worker hit the iteration cap: exit 1 + the exact failure
		// message in harness.log (run-worker.sh redirects stderr there, and the
		// watcher captures the tail as the group summary).
		await fs.mkdir(path.join(wtPath, ".harness.done"))
		await fs.writeFile(path.join(wtPath, ".harness.exit"), "1", "utf-8")
		await fs.writeFile(
			path.join(wtPath, "harness.log"),
			"headlesscode: task failed: Max iterations (3) reached without task completion\n",
			"utf-8",
		)

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
					// First failure: iteration exhaustion → continuation.
					const decision = handleIterationExhaustion(group, repoRoot, 3, "code")
					assert.equal(decision.shouldSpawn, true, "iteration exhaustion below the cap must continue")
					assert.equal(decision.patch.status, "running")
					// Apply the reset the real callback applies, then simulate a
					// continuation worker that starts AND finishes: clear the old
					// completion markers (run-worker.sh does this) and re-create
					// them to represent the continuation worker's completion.
					saveStateSync(statePath, updateGroup(loadStateSync(statePath), "w1", decision.patch))
					await fs.rm(path.join(wtPath, ".harness.done"), { recursive: true, force: true })
					await fs.rm(path.join(wtPath, ".harness.exit"), { force: true })
					await fs.mkdir(path.join(wtPath, ".harness.done"))
					await fs.writeFile(path.join(wtPath, ".harness.exit"), "0", "utf-8")
					return true
				}
				// Second completion: the continuation finished cleanly.
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

		assert.equal(callbackCalls, 2, "the loop must re-poll the group after the continuation reset and re-review it")
		assert.equal(summary.allTerminal, true)

		// The disk state is authoritative (orchestrateMain reloads it after the round).
		const persisted = loadStateSync(statePath)
		assert.equal(persisted.groups[0].status, "done")
		assert.equal(persisted.groups[0].review_verdict, "clean")
		assert.equal(persisted.groups[0].continuationCount, 1, "continuationCount incremented exactly once")
	} finally {
		await fs.rm(repoRoot, { recursive: true, force: true })
	}
}

// ─── Pre-spawn worktree collision check (Bug 1) ───────────────────────────────

async function testOrchestrateMainSkipsOccupiedWorktreeSlot(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([{ number: 1, title: "Fix the thing", body: "Do it" }]),
			"utf-8",
		)
		// w1 is occupied by a still-running round (or genuinely stale leftover)
		// — the new round must name around it (w2) instead of hard-failing, so
		// a second `orchestrate` invocation against the same repo can proceed
		// alongside an in-flight one. See split.ts's occupiedNames param.
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		await fs.writeFile(path.join(repo, ".worktrees", "w1", "leftover.txt"), "in-flight\n", "utf-8")

		const { exit, stdout } = await withCapturedStdout(() =>
			orchestrateMain(["--repo", repo, "--issues-json", issuesPath, "--dry-run"]),
		)

		assert.equal(exit, 0, "occupied w1 must not fail the round when w2 is free")
		assert.ok(stdout.includes("w2"), `plan should name the group w2, got: ${stdout}`)
		assert.ok(!stdout.includes("w1   issue"), `plan should not reuse the occupied w1 slot, got: ${stdout}`)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOrchestrateMainSkipsMultipleOccupiedSlots(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([{ number: 1, title: "Fix the thing", body: "Do it" }]),
			"utf-8",
		)
		// w1 AND w2 both occupied (e.g. two still-running rounds) — naming
		// must skip both and land on w3, still succeeding.
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		await fs.mkdir(path.join(repo, ".worktrees", "w2"), { recursive: true })

		const { exit, stdout } = await withCapturedStdout(() =>
			orchestrateMain(["--repo", repo, "--issues-json", issuesPath, "--dry-run"]),
		)

		assert.equal(exit, 0, "occupied w1+w2 must not fail the round when w3 is free")
		assert.ok(stdout.includes("w3"), `plan should name the group w3, got: ${stdout}`)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOrchestrateMainDryRunProceedsWhenNoCollision(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([{ number: 1, title: "Fix the thing", body: "Do it" }]),
			"utf-8",
		)

		// No pre-existing .worktrees/w1 -> the collision check passes and the
		// dry-run reaches printPlan (the step that would be followed by the
		// spawn command on a real round), exiting 0.
		const exit = await orchestrateMain(["--repo", repo, "--issues-json", issuesPath, "--dry-run"])
		assert.equal(exit, 0, "clear worktrees -> dry-run proceeds to the plan and exits 0")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOrchestrateMainDryRunShowsEmptyCostEstimateNote(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([{ number: 1, title: "Split the big file into modules", body: "Mechanical" }]),
			"utf-8",
		)
		const { exit, stdout } = await withCapturedStdout(() =>
			orchestrateMain(["--repo", repo, "--issues-json", issuesPath, "--dry-run"]),
		)
		assert.equal(exit, 0)
		assert.match(stdout, /Cost estimate \(from recorded cost-history/)
		assert.match(stdout, /no cost history recorded yet — estimates appear once groups reach a terminal status/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOrchestrateMainDryRunShowsCostEstimateFromHistory(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([{ number: 1, title: "Split the big file into modules", body: "Mechanical" }]),
			"utf-8",
		)
		// Seed recorded history for the same repo (issue #16): three past
		// split-shaped groups — the estimator needs >= 3 same-shape samples.
		for (const [cost, iters] of [
			[0.2, 40],
			[0.3, 50],
			[0.4, 60],
		] as const) {
			await appendCostHistoryRecord(repo, {
				recordedAt: "2026-08-05T00:00:00.000Z",
				repo: path.resolve(repo),
				groupName: `past${cost}`,
				issues: [100],
				shapes: ["split"],
				status: "done",
				costUsd: cost,
				inputTokens: 2000,
				outputTokens: 200,
				cachedTokens: 0,
				iterations: iters,
				continuationCount: 0,
				reworkCount: 0,
			})
		}
		const { exit, stdout } = await withCapturedStdout(() =>
			orchestrateMain(["--repo", repo, "--issues-json", issuesPath, "--dry-run"]),
		)
		assert.equal(exit, 0)
		assert.match(stdout, /Cost estimate \(from recorded cost-history/)
		assert.match(stdout, /w1 \(issues 1 — split\): expected ~\$0\.2000–\$0\.4000 · ~40–60 iterations · 3 sample\(s\)/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

/** Issue #124: a test-shaped issue with thin recorded samples gets its cost
 * scaled by the verification multiplier, surfaced on the dry-run line. */
async function testOrchestrateMainDryRunShowsVerificationMultiplier(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([{ number: 1, title: "Add tests for the API", body: "Test-shaped work." }]),
			"utf-8",
		)
		// Seed three test-shaped records — enough for a shape-match estimate,
		// but thin enough (3 < VERIFICATION_MULTIPLIER_FULL_SAMPLES) that the
		// verification multiplier applies to the recorded median.
		for (const [cost, iters] of [
			[0.2, 40],
			[0.3, 50],
			[0.4, 60],
		] as const) {
			await appendCostHistoryRecord(repo, {
				recordedAt: "2026-08-05T00:00:00.000Z",
				repo: path.resolve(repo),
				groupName: `past${cost}`,
				issues: [100],
				shapes: ["test"],
				status: "done",
				costUsd: cost,
				inputTokens: 2000,
				outputTokens: 200,
				cachedTokens: 0,
				iterations: iters,
				continuationCount: 0,
				reworkCount: 0,
			})
		}
		const { exit, stdout } = await withCapturedStdout(() =>
			orchestrateMain(["--repo", repo, "--issues-json", issuesPath, "--dry-run"]),
		)
		assert.equal(exit, 0)
		assert.match(stdout, /Cost estimate \(from recorded cost-history/)
		// Median per-issue cost $0.3 * 2.5 = $0.75; the multiplier is named.
		assert.match(stdout, /w1 \(issues 1 — test\): expected ~\$0\.5000–\$1\.0000 · ~40–60 iterations · 3 sample\(s\) · 2\.50x verification multiplier/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Pre-spawn preflight probe (issue #13) ───────────────────────────────────

async function testOrchestrateMainPreflightFailureAbortsBeforeSpawn(): Promise<void> {
	const repo = await tmpRepo()
	const savedKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY
	const savedBaseUrl = process.env.OPENROUTER_BASE_URL
	process.env.HEADLESSCODE_OPENROUTER_API_KEY = "k"
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([{ number: 1, title: "Fix the thing", body: "Do it" }]),
			"utf-8",
		)
		// Point the probe at an unreachable endpoint: the 1-token probe fails
		// with a network error, which must ABORT the round BEFORE task files
		// are written or anything is spawned (the issue's whole point — the
		// failure surfaces now, not 30-80 iterations in).
		process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:1"

		const { exit, stdout, stderr } = await withCapturedIo(() =>
			orchestrateMain(["--repo", repo, "--issues-json", issuesPath]),
		)

		assert.notEqual(exit, 0, "a failed preflight must abort the round, got exit 0")
		assert.ok(stdout.includes("[preflight]"), "the preflight line is printed, got: " + stdout)
		assert.ok(stderr.includes("preflight FAILED (network)"), `names the failure mode, got: ${stderr}`)
		assert.ok(stderr.includes("aborting before any workers spawn"), "aborts before spawning, got: " + stderr)
		const taskDirExists = await fs
			.stat(path.join(repo, "plans", "parallel-tasks"))
			.then(() => true, () => false)
		assert.equal(taskDirExists, false, "no task files are written when the preflight fails")
	} finally {
		if (savedKey === undefined) {
			delete process.env.HEADLESSCODE_OPENROUTER_API_KEY
		} else {
			process.env.HEADLESSCODE_OPENROUTER_API_KEY = savedKey
		}
		if (savedBaseUrl === undefined) {
			delete process.env.OPENROUTER_BASE_URL
		} else {
			process.env.OPENROUTER_BASE_URL = savedBaseUrl
		}
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── master ↔ origin sync before spawn (issue #25) ───────────────────────────

async function testOrchestrateMainWarnsOnDriftWhenSyncDisabled(): Promise<void> {
	// Issue #25: with the auto-sync disabled, `orchestrate` must still surface
	// non-trivial unpushed drift loudly instead of letting it compound across
	// rounds — and the warning path must be read-only (never push).
	const repo = await tmpRepo()
	const savedKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY
	const savedBaseUrl = process.env.OPENROUTER_BASE_URL
	const savedNoSync = process.env.HEADLESSCODE_ORCHESTRATE_NO_SYNC
	process.env.HEADLESSCODE_OPENROUTER_API_KEY = "k"
	process.env.HEADLESSCODE_ORCHESTRATE_NO_SYNC = "1"
	try {
		initGitRepo(repo)
		const remote = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cli-sync-remote-"))
		try {
			execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" })
			execFileSync("git", ["-C", repo, "remote", "add", "origin", remote], { stdio: "ignore" })
			execFileSync("git", ["-C", repo, "config", "user.email", "test@headlesscode.invalid"], { stdio: "ignore" })
			execFileSync("git", ["-C", repo, "config", "user.name", "Sync Test"], { stdio: "ignore" })
			execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"], { stdio: "ignore" })
			await fs.writeFile(path.join(repo, "a.txt"), "a\n", "utf-8")
			execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: "ignore" })
			execFileSync("git", ["-C", repo, "commit", "-qm", "init"], { stdio: "ignore" })
			execFileSync("git", ["-C", repo, "push", "-q", "-u", "origin", "main"], { stdio: "ignore" })
			// 6 unpushed commits — past TRIVIAL_DRIFT_AHEAD (5).
			for (let i = 1; i <= 6; i++) {
				await fs.appendFile(path.join(repo, "a.txt"), `line ${i}\n`, "utf-8")
				execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: "ignore" })
				execFileSync("git", ["-C", repo, "commit", "-qm", `local ${i}`], { stdio: "ignore" })
			}
			const issuesPath = path.join(repo, "issues.json")
			await fs.writeFile(issuesPath, JSON.stringify([{ number: 1, title: "Fix the thing", body: "Do it" }]), "utf-8")
			// The round still aborts on the preflight probe (unreachable mock),
			// which runs AFTER the sync block — so both messages must appear.
			process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:1"

			const { exit, stderr } = await withCapturedStderr(() =>
				orchestrateMain(["--repo", repo, "--issues-json", issuesPath]),
			)

			assert.notEqual(exit, 0, "preflight failure still aborts the round")
			assert.ok(stderr.includes("6 commit(s) ahead of origin/main"), `loud drift warning names the drift, got: ${stderr}`)
			assert.ok(stderr.includes("HEADLESSCODE_ORCHESTRATE_NO_SYNC"), "the warning explains why the sync is off")
			const originMain = execFileSync("git", ["-C", repo, "rev-parse", "origin/main"], { encoding: "utf-8" }).trim()
			const localMain = execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf-8" }).trim()
			assert.notEqual(originMain, localMain, "the disabled path is read-only — origin must not be pushed")
		} finally {
			await fs.rm(remote, { recursive: true, force: true })
		}
	} finally {
		if (savedKey === undefined) {
			delete process.env.HEADLESSCODE_OPENROUTER_API_KEY
		} else {
			process.env.HEADLESSCODE_OPENROUTER_API_KEY = savedKey
		}
		if (savedBaseUrl === undefined) {
			delete process.env.OPENROUTER_BASE_URL
		} else {
			process.env.OPENROUTER_BASE_URL = savedBaseUrl
		}
		if (savedNoSync === undefined) {
			delete process.env.HEADLESSCODE_ORCHESTRATE_NO_SYNC
		} else {
			process.env.HEADLESSCODE_ORCHESTRATE_NO_SYNC = savedNoSync
		}
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["rework task file includes findings, issues, rework count", testReworkTaskFileContentIncludesFindingsAndIssues],
	["rework task file handles empty findings gracefully", testReworkTaskFileContentHandlesEmptyFindings],
	["task file embeds real issue title/body, no gh fetch (Fix 2)", testTaskFileContentEmbedsIssueTitleAndBody],
	["all five task builders omit the hardcoded rules-read instruction (Fix 1)", testAllTaskBuildersNoHardcodedRulesReadInstruction],
	["all five task builders designate workspace scratch and forbid /tmp (issue #123)", testAllTaskBuildersDesignateWorkspaceScratchAndForbidTmp],
	["rework task file embeds persisted issueBodies, falls back to gh without (Fix 2)", testReworkTaskFileContentEmbedsPersistedIssueBodies],
	["QA rework task file includes evidence, issues, report pointer (issue #52)", testQaReworkTaskFileContentIncludesEvidenceAndIssues],
	["QA rework task file handles empty evidence gracefully (issue #52)", testQaReworkTaskFileContentHandlesEmptyEvidence],
	["QA rework task file embeds persisted issueBodies (Fix 2)", testQaReworkTaskFileContentEmbedsPersistedIssueBodies],
	["continuation task file embeds persisted issueBodies (Fix 2)", testContinuationTaskFileContentEmbedsPersistedIssueBodies],
	["finding below cap triggers rework spawn + state reset", testFindingBelowCapSpawnsAndResetsState],
	["review session error goes straight to needs-human, never a rework spawn", testReviewSessionErrorGoesStraightToNeedsHumanNoRework],
	["QA session error goes straight to needs-human, not settled as an ordinary failed QA", testQaSessionErrorGoesStraightToNeedsHuman],
	["QA fail below cap triggers rework spawn + state reset (issue #52)", testQaFailBelowCapSpawnsAndResetsState],
	["QA fail rework patch actually clears a stale cost_recorded on merge (issue #52)", testQaFailReworkPatchActuallyClearsCostRecordedOnMerge],
	["QA fail at cap marks needs-human, evidence stays recorded (issue #52)", testQaFailAtCapMarksNeedsHumanAndDoesNotSpawn],
	["QA pass never touches reworkCount (issue #52)", testQaPassNeverTouchesReworkCount],
	["rework patch actually clears a stale cost_recorded on merge", testReworkPatchActuallyClearsCostRecordedOnMerge],
	["continuation patch actually clears a stale cost_recorded on merge", testContinuationPatchActuallyClearsCostRecordedOnMerge],
	["report pointer fields (qa.report / review_report) survive the state round-trip (issue #34)", testReportPointerFieldsSurviveStateRoundTrip],
	["finding increments from an existing rework count", testFindingIncrementsFromExistingCount],
	["finding at cap marks needs-human and does NOT spawn", testFindingAtCapMarksNeedsHumanAndDoesNotSpawn],
	["clean verdict never touches reworkCount", testCleanVerdictNeverTouchesReworkCount],
	["multiple groups rework independently", testMultipleGroupsReworkIndependently],
	["--file-issues parses with --issues-json, usage error without (Fix 3)", testParseOrchestrateArgsFileIssues],
	["fileSyntheticIssues substitutes real returned numbers (Fix 3)", testFileSyntheticIssuesSubstitutesRealNumbers],
	["fileSyntheticIssues leaves real-sourced entries untouched (Fix 3)", testFileSyntheticIssuesLeavesRealSourcedEntriesUntouched],
	["--max-rework-cycles parses (default 3, custom, invalid)", testParseOrchestrateArgsMaxReworkCycles],
	["watchGroups re-polls a group after a rework reset", testWatchGroupsRepollsGroupAfterReworkReset],
	["spawn env carries the resolved model when the worker's mode is mapped", testSpawnEnvCarriesResolvedModelWhenModeMapped],
	["spawn env resolves from the _default key", testSpawnEnvCarriesResolvedModelFromDefaultKey],
	["spawn env: explicit --model flag beats the config file", testSpawnEnvExplicitModelFlagBeatsConfig],
	["spawn env: no config -> raw OPENROUTER_MODEL passes through unchanged", testSpawnEnvNoConfigKeepsRawEnvModel],
	["spawn env: nothing configured -> no model injected", testSpawnEnvNoConfigNoEnvLeavesModelUnset],
	["--max-iterations parses (env fallback, flag beats env, invalid)", testParseOrchestrateArgsMaxIterations],
	["--max-continuations parses (default 3, custom, invalid)", testParseOrchestrateArgsMaxContinuations],
	["spawn env carries HEADLESSCODE_MAX_ITERATIONS (flag > env, untouched when unset)", testSpawnEnvCarriesMaxIterations],
	["--plan-first parses (default off, mode architect, cap 15, invalid rejected)", testParseOrchestrateArgsPlanFirst],
	["plan-first task file instructs a planning-only session writing PLAN.md", testBuildPlanFirstTaskFileContent],
	["plan-first task file embeds real issue title/body (Fix 2)", testPlanFirstTaskFileContentEmbedsIssueTitleAndBody],
	["writeTaskFiles writes <name>-plan.md per spec only when planFirst", testWriteTaskFilesWritesPlanFilesWhenPlanFirst],
	["spawn env carries PLAN_FIRST/MODE/MAX_ITERATIONS only when plan-first is on", testSpawnEnvCarriesPlanFirst],
	["continuation task file includes issues, cycle, and scope", testContinuationTaskFileContentIncludesIssuesAndCycle],
	["iteration exhaustion below cap triggers continuation spawn + state reset", testExhaustionBelowCapSpawnsAndResetsState],
	["iteration exhaustion increments from an existing continuation count", testExhaustionIncrementsFromExistingCount],
	["iteration exhaustion at cap marks needs-human and does NOT spawn", testExhaustionAtCapMarksNeedsHumanAndDoesNotSpawn],
	["budget stop never auto-continues (stays failed)", testBudgetFailureDoesNotContinue],
	["generic failure never auto-continues (stays failed)", testGenericFailureDoesNotContinue],
	["clean exit with the max-iterations text never auto-continues", testCleanExitWithMaxIterationsTextDoesNotContinue],
	["continuation spawn forwards the round-level --max-iterations when set", testExhaustionSpawnForwardsMaxIterations],
	["a transient provider failure below the cap also auto-continues", testProviderFailureBelowCapSpawnsAndResetsState],
	["a transient provider failure at the cap still marks needs-human", testProviderFailureAtCapMarksNeedsHuman],
	["a deterministic provider error (401) must never auto-continue", testDeterministicProviderErrorDoesNotContinue],
	["watchGroups re-polls a group after a continuation reset", testWatchGroupsRepollsGroupAfterContinuationReset],
	["orchestrateMain skips an occupied w1 slot and names the group w2", testOrchestrateMainSkipsOccupiedWorktreeSlot],
	["orchestrateMain skips multiple occupied slots (w1+w2 -> w3)", testOrchestrateMainSkipsMultipleOccupiedSlots],
	["--no-preflight parses (default on, flag off)", testParseOrchestrateArgsNoPreflight],
	["--no-issue-size-check parses (default on, flag off)", testParseOrchestrateArgsNoIssueSizeCheck],
	["orchestrateMain dry-run warns loudly on a 3+-section issue but never aborts (issue #53)", testOrchestrateMainDryRunWarnsOnOversizedIssue],
	["orchestrateMain dry-run: --no-issue-size-check silences the warning (issue #53)", testOrchestrateMainDryRunNoIssueSizeWarningWithFlag],
	["orchestrateMain dry-run: small issues produce no size warning (issue #53)", testOrchestrateMainDryRunNoWarningForSmallIssue],
	["orchestrateMain dry-run proceeds when all worktree dirs are clear", testOrchestrateMainDryRunProceedsWhenNoCollision],
	["orchestrateMain dry-run shows the no-history estimate note on a fresh repo", testOrchestrateMainDryRunShowsEmptyCostEstimateNote],
	["orchestrateMain dry-run shows a cost estimate derived from recorded history", testOrchestrateMainDryRunShowsCostEstimateFromHistory],
	["orchestrateMain dry-run shows the verification multiplier on a thin test-shaped estimate (issue #124)", testOrchestrateMainDryRunShowsVerificationMultiplier],
	["orchestrateMain aborts before spawn when the preflight probe fails", testOrchestrateMainPreflightFailureAbortsBeforeSpawn],
	["orchestrateMain warns loudly on drift when the auto-sync is disabled", testOrchestrateMainWarnsOnDriftWhenSyncDisabled],
]

async function main(): Promise<void> {
	// Redirect the central store so mode-model/permissions resolution and any
	// legacy-file migration stay inside the sandbox, never the real home store.
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "hc-orch-cli-store-"))
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
	console.log(`\nAll ${tests.length} cli tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
