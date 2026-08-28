/**
 * Unit tests for src/orchestrator/resume.ts — the issue #14 standalone
 * review/rework/resume subcommands: rebuild a group's state from REAL
 * on-disk markers (the first-class recovery path), re-checkout a cleaned-up
 * branch, run the review/rework/QA steps against existing state, and drive
 * the full recovery pipeline. Plain assert-based (no framework, no network,
 * no LLM — every LLM/spawn path is exercised via --dry-run or skipped)
 * matching the repo test style. Run via `npm test`.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { orchestrateMain } from "../cli.js"
import {
	findingsFromCommentBodies,
	parseResumeArgs,
	parseReviewArgs,
	parseReworkArgs,
	rebuildPatchFromMarkers,
	recheckoutWorktree,
	resumeGroup,
	resumeMain,
	reviewMain,
	reworkMain,
	runQaStep,
	runReviewStep,
	runReworkStep,
	resolveTargetGroups,
	type ResumeTarget,
} from "../resume.js"
import { defaultState, loadStateSync, saveStateSync, type OrchestratorGroup, type OrchestratorState } from "../state.js"

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-resume-"))
}

/** Initialize a real git repo (the mains git-check the target with `git rev-parse --git-dir`). */
function initGitRepo(dir: string): void {
	try {
		execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" })
	} catch {
		execFileSync("git", ["init", "-q", dir], { stdio: "ignore" })
	}
}

function baseGroup(overrides: Partial<OrchestratorGroup> = {}): OrchestratorGroup {
	return {
		name: "w1",
		worktree: ".worktrees/w1",
		branch: "issues/w1-2026-08-05",
		issues: [14],
		status: "done",
		spawned: new Date().toISOString(),
		...overrides,
	}
}

/** Write a state file with the given groups under <repo>/.worktrees/. */
function writeState(repo: string, groups: OrchestratorGroup[]): string {
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	saveStateSync(statePath, { ...defaultState("round-1"), groups })
	return statePath
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

/** Run a function while capturing process.stdout + stderr. */
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

/** Create a fake worker-completion marker set (as run-worker.sh does). */
async function markDone(wtPath: string, exitCode: number, summary?: string): Promise<void> {
	await fs.mkdir(path.join(wtPath, ".harness.done"), { recursive: true })
	await fs.writeFile(path.join(wtPath, ".harness.exit"), String(exitCode), "utf-8")
	if (summary !== undefined) {
		await fs.writeFile(path.join(wtPath, "harness.log"), summary, "utf-8")
	}
}

// ─── parseReviewArgs ─────────────────────────────────────────────────────────

async function testParseReviewArgsDefaults(): Promise<void> {
	const { options, error } = parseReviewArgs(["--repo", "/tmp/x", "--issue", "14"])
	assert.equal(error, undefined)
	assert.equal(options.repo, "/tmp/x")
	assert.deepEqual(options.target, { issue: 14 })
	assert.equal(options.reviewMode, "deepseek-reviewer", "default review mode")
	assert.equal(options.forceReview, false)
	assert.equal(options.dryRun, false)
}

async function testParseReviewArgsTargetConflicts(): Promise<void> {
	const both = parseReviewArgs(["--repo", "/tmp/x", "--issue", "1", "--pr", "2"])
	assert.ok(both.error && both.error.includes("exactly one"), "issue+pr must be rejected")
	const none = parseReviewArgs(["--repo", "/tmp/x"])
	assert.equal(none.error, undefined, "target presence is validated by the main, not the parser")
	const badPr = parseReviewArgs(["--repo", "/tmp/x", "--pr", "abc"])
	assert.ok(badPr.error && badPr.error.includes("positive integer"))
}

// ─── parseReworkArgs ─────────────────────────────────────────────────────────

async function testParseReworkArgs(): Promise<void> {
	const def = parseReworkArgs(["--repo", "/tmp/x", "--issue", "14"])
	assert.equal(def.error, undefined)
	assert.equal(def.options.maxReworkCycles, 3, "default rework cap")
	assert.equal(def.options.mode, "code", "default worker mode")

	const custom = parseReworkArgs([
		"--repo",
		"/tmp/x",
		"--group",
		"w2",
		"--mode",
		"code",
		"--max-rework-cycles",
		"5",
		"--max-iterations",
		"120",
		"--memory-dir",
		"/tmp/mem",
	])
	assert.equal(custom.error, undefined)
	assert.equal(custom.options.target.group, "w2")
	assert.equal(custom.options.maxReworkCycles, 5)
	assert.equal(custom.options.maxIterations, 120)
	assert.equal(custom.options.memoryDir, "/tmp/mem")

	const zero = parseReworkArgs(["--repo", "/tmp/x", "--issue", "14", "--max-rework-cycles", "0"])
	assert.ok(zero.error && zero.error.includes("positive integer"))
}

// ─── parseResumeArgs ─────────────────────────────────────────────────────────

async function testParseResumeArgs(): Promise<void> {
	const def = parseResumeArgs(["--repo", "/tmp/x"])
	assert.equal(def.error, undefined)
	assert.deepEqual(def.options.target, {}, "no target → resume every group")
	assert.equal(def.options.qa, false, "--qa is opt-in")
	assert.equal(def.options.noReview, false, "review on by default")
	assert.equal(def.options.maxContinuations, 3)
	assert.equal(def.options.maxReworkCycles, 3)

	const full = parseResumeArgs([
		"--repo",
		"/tmp/x",
		"--pr",
		"42",
		"--qa",
		"--force-review",
		"--max-continuations",
		"5",
		"--dry-run",
	])
	assert.equal(full.error, undefined)
	assert.equal(full.options.target.pr, 42)
	assert.equal(full.options.qa, true)
	assert.equal(full.options.forceReview, true)
	assert.equal(full.options.maxContinuations, 5)
	assert.equal(full.options.dryRun, true)
}

// ─── resolveTargetGroups ─────────────────────────────────────────────────────

async function testResolveTargetGroupsByGroupName(): Promise<void> {
	const state: OrchestratorState = {
		...defaultState("r"),
		groups: [baseGroup({ name: "w1" }), baseGroup({ name: "w2", issues: [29] })],
	}
	assert.deepEqual(resolveTargetGroups(state, { group: "w1" }, { repo: "" }).map((g) => g.name), ["w1"])
	assert.deepEqual(resolveTargetGroups(state, { group: "nope" }, { repo: "" }), [])
}

async function testResolveTargetGroupsByIssue(): Promise<void> {
	const state: OrchestratorState = {
		...defaultState("r"),
		groups: [baseGroup({ name: "w1", issues: [14, 29] }), baseGroup({ name: "w2", issues: [31] })],
	}
	assert.deepEqual(resolveTargetGroups(state, { issue: 14 }, { repo: "" }).map((g) => g.name), ["w1"])
	// A group with no recorded issues never matches.
	const noIssues: OrchestratorState = { ...defaultState("r"), groups: [baseGroup({ issues: undefined })] }
	assert.deepEqual(resolveTargetGroups(noIssues, { issue: 14 }, { repo: "" }), [])
}

async function testResolveTargetGroupsByPr(): Promise<void> {
	const state: OrchestratorState = {
		...defaultState("r"),
		groups: [
			baseGroup({ name: "w1", pr: { number: 7 } }),
			baseGroup({ name: "w2", branch: "issues/w2-2026-08-05" }),
		],
	}
	// Direct group.pr?.number match.
	assert.deepEqual(resolveTargetGroups(state, { pr: 7 }, { repo: "" }).map((g) => g.name), ["w1"])
	// Fallback: PR head branch matches group.branch (injected hook — no gh).
	const branchHooked = resolveTargetGroups(state, { pr: 99 }, {
		repo: "",
		hooks: { prHeadBranch: () => "issues/w2-2026-08-05" },
	})
	assert.deepEqual(branchHooked.map((g) => g.name), ["w2"])
	// No match at all.
	const none = resolveTargetGroups(state, { pr: 99 }, {
		repo: "",
		hooks: { prHeadBranch: () => undefined },
	})
	assert.deepEqual(none, [])
}

// ─── findingsFromCommentBodies ───────────────────────────────────────────────

async function testFindingsFromCommentBodies(): Promise<void> {
	const bodies = [
		"### Reopened\n- line 42: the fix breaks the existing path\n\nVERDICT: FINDING",
		"## Findings\n1. rework the second issue\nVERDICT: FINDING",
		"Everything verified, nothing reopened.\nVERDICT: CLEAN",
		"",
	]
	const findings = findingsFromCommentBodies(bodies)
	assert.ok(findings.length >= 2, `expected findings from the finding reports, got ${findings.length}`)
	assert.ok(
		findings.some((f) => /reopened/i.test(f)),
		"the reopened-heading report contributes its reopening signal, got: " + findings.join(" | "),
	)
	assert.ok(findings.some((f) => f.includes("second issue")), "the Findings-section report's item extracted")
	assert.ok(!findings.some((f) => f.includes("verified")), "the clean report contributes nothing")
}

async function testFindingsFromCommentBodiesEmpty(): Promise<void> {
	assert.deepEqual(findingsFromCommentBodies([]), [])
	assert.deepEqual(findingsFromCommentBodies(["no verdict here", "VERDICT: CLEAN"]), [])
}

// ─── rebuildPatchFromMarkers (issue #14 first-class path) ────────────────────

async function testRebuildDoneFromMarkersExitZero(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		await markDone(wtPath, 0)
		// Stale state: the state file says "running" but the REAL markers say done.
		const group = baseGroup({ status: "running", spawned: new Date(Date.now() - 60_000).toISOString() })
		const patch = rebuildPatchFromMarkers(repo, group)
		assert.ok(patch, "a stale running entry with real done markers must yield a patch")
		assert.equal(patch?.status, "done", "exit 0 → done")
		assert.equal(patch?.exit_code, 0)
		const activity = patch?.last_activity
		assert.ok(activity && typeof activity === "object" && "note" in activity, "patch explains the rebuild")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRebuildFailedFromMarkersExitNonZero(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		await markDone(wtPath, 1)
		const group = baseGroup({ status: "running" })
		const patch = rebuildPatchFromMarkers(repo, group)
		assert.ok(patch)
		assert.equal(patch?.status, "failed", "exit 1 → failed")
		assert.equal(patch?.exit_code, 1)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRebuildOrphanedWhenWorktreeGone(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const group = baseGroup({ status: "running" })
		const patch = rebuildPatchFromMarkers(repo, group)
		assert.ok(patch)
		assert.equal(patch?.status, "orphaned", "a missing worktree is never guessed as done/failed")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRebuildNoChangeWhenGenuinelyRunning(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		// No markers, recent spawn, no stall → nothing to rebuild.
		const group = baseGroup({ status: "running", spawned: new Date().toISOString() })
		const patch = rebuildPatchFromMarkers(repo, group)
		assert.equal(patch, undefined, "a genuinely in-flight group is left alone")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── recheckoutWorktree ──────────────────────────────────────────────────────

/** git user config needed for commits in fresh repos. */
function configureGit(repo: string): void {
	execFileSync("git", ["-C", repo, "config", "user.email", "test@headlesscode.invalid"], { stdio: "ignore" })
	execFileSync("git", ["-C", repo, "config", "user.name", "Resume Test"], { stdio: "ignore" })
	execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"], { stdio: "ignore" })
}

/** Commit a file on the current branch of `repo` (git must be configured). */
function commitFile(repo: string, rel: string, content: string, message: string): void {
	const file = path.join(repo, rel)
	execFileSync("git", ["-C", repo, "add", rel], { stdio: "ignore" })
	execFileSync("git", ["-C", repo, "commit", "-qm", message], { stdio: "ignore" })
	void content
	void file
}

async function testRecheckoutWorktreeRecreatesRemovedWorktree(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		configureGit(repo)
		await fs.writeFile(path.join(repo, "base.txt"), "base\n", "utf-8")
		commitFile(repo, "base.txt", "base\n", "base")
		// A group whose branch was already created (as the spawner would).
		const branch = "issues/w1-2026-08-05"
		execFileSync("git", ["-C", repo, "checkout", "-qb", branch], { stdio: "ignore" })
		await fs.writeFile(path.join(repo, "fix.txt"), "fix\n", "utf-8")
		commitFile(repo, "fix.txt", "fix\n", "fix")
		execFileSync("git", ["-C", repo, "checkout", "-q", "main"], { stdio: "ignore" })

		const group = baseGroup({ branch, status: "done" })
		// First re-checkout (fresh worktree).
		const first = recheckoutWorktree(repo, group)
		assert.equal(first.ok, true, `first re-checkout should succeed, got ${first.error}`)
		const wtPath = path.join(repo, ".worktrees", "w1")
		assert.ok((await fs.stat(wtPath)).isDirectory(), "worktree directory created")
		const head = execFileSync("git", ["-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim()
		assert.equal(head, branch, "worktree checks out the group's branch")
		assert.ok((await fs.stat(path.join(wtPath, "fix.txt"))).isFile(), "branch's committed work is present")

		// Cleanup removes the worktree; a SECOND re-checkout must recreate it.
		execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wtPath], { stdio: "ignore" })
		const second = recheckoutWorktree(repo, group)
		assert.equal(second.ok, true, `re-creating a removed worktree should succeed, got ${second.error}`)
		assert.ok((await fs.stat(wtPath)).isDirectory())
		const head2 = execFileSync("git", ["-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim()
		assert.equal(head2, branch)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRecheckoutWorktreeFailsWithoutBranch(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const group = baseGroup({ branch: undefined })
		const result = recheckoutWorktree(repo, group)
		assert.equal(result.ok, false, "no recorded branch → cannot re-checkout")
		assert.ok(result.error?.includes("no recorded branch"))
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── runReviewStep / runQaStep: automatic-fail gate on an empty worktree ────
//
// 2026-08-28 production incident (joeos issue #26): a review session
// fabricated an ENTIRE false completion — invented commit counts, invented
// diff stats, invented passing test output, even a fabricated GitHub PR
// link — and declared VERDICT: CLEAN via the structured, supposedly-
// authoritative verdict line, for a worktree that in reality had ZERO
// commits and ZERO changes. These verify the fix runs BEFORE any LLM call:
// with no real changes in the worktree, runReviewStep/runQaStep must record
// an automatic fail deterministically, never spawning a review/QA session
// (no llmClient needed in these tests at all — that's the point: the gate
// short-circuits before the code path that would ever need one).

/** A worktree checked out on its own branch with no divergence from base. */
function makeEmptyWorktree(repo: string, branch: string): string {
	execFileSync("git", ["-C", repo, "checkout", "-qb", branch], { stdio: "ignore" })
	execFileSync("git", ["-C", repo, "checkout", "-q", "main"], { stdio: "ignore" })
	const wtPath = path.join(repo, ".worktrees", "w1")
	execFileSync("git", ["-C", repo, "worktree", "add", "-q", wtPath, branch], { stdio: "ignore" })
	return wtPath
}

async function testRunReviewStepAutomaticFailOnEmptyWorktree(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		configureGit(repo)
		await fs.writeFile(path.join(repo, "base.txt"), "base\n", "utf-8")
		commitFile(repo, "base.txt", "base\n", "base")
		const branch = "issues/w1-2026-08-28"
		makeEmptyWorktree(repo, branch)

		const group = baseGroup({ branch, status: "done" })
		const statePath = writeState(repo, [group])
		const written: string[] = []
		const result = await runReviewStep({
			repo,
			statePath,
			group,
			reviewMode: "deepseek-reviewer",
			forceReview: false,
			dryRun: false,
			write: (t) => written.push(t),
		})

		assert.equal(result.skipped, false)
		assert.equal(result.message, "no real changes → automatic fail (review session never ran)")
		assert.equal(result.group.review_verdict, "finding")
		assert.ok(result.group.pending_review_findings?.[0]?.includes("structurally impossible"))
		assert.ok(written.some((line) => line.startsWith("AUTOMATIC FAIL:")))
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRunReviewStepProceedsWithRealCommittedChange(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		configureGit(repo)
		await fs.writeFile(path.join(repo, "base.txt"), "base\n", "utf-8")
		commitFile(repo, "base.txt", "base\n", "base")
		const branch = "issues/w1-2026-08-28"
		execFileSync("git", ["-C", repo, "checkout", "-qb", branch], { stdio: "ignore" })
		await fs.writeFile(path.join(repo, "fix.txt"), "fix\n", "utf-8")
		commitFile(repo, "fix.txt", "fix\n", "fix")
		execFileSync("git", ["-C", repo, "checkout", "-q", "main"], { stdio: "ignore" })
		const wtPath = path.join(repo, ".worktrees", "w1")
		execFileSync("git", ["-C", repo, "worktree", "add", "-q", wtPath, branch], { stdio: "ignore" })

		const group = baseGroup({ branch, status: "done" })
		const statePath = writeState(repo, [group])
		// dry-run: proves the gate did NOT trip (a real committed change is
		// present) without actually needing a real/fake LLM client — the
		// dry-run branch returns before ever calling runReviewWithRetries.
		const result = await runReviewStep({
			repo,
			statePath,
			group,
			reviewMode: "deepseek-reviewer",
			forceReview: false,
			dryRun: true,
			write: () => {},
		})
		assert.equal(result.message, "dry-run: review not run", "a real change must reach the normal dry-run path, not the automatic-fail gate")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRunQaStepAutomaticFailOnEmptyWorktree(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		configureGit(repo)
		await fs.writeFile(path.join(repo, "base.txt"), "base\n", "utf-8")
		commitFile(repo, "base.txt", "base\n", "base")
		const branch = "issues/w1-2026-08-28"
		makeEmptyWorktree(repo, branch)

		const group = baseGroup({ branch, status: "done" })
		const statePath = writeState(repo, [group])
		const written: string[] = []
		const result = await runQaStep({
			repo,
			statePath,
			group,
			qaMode: "qa-agent",
			dryRun: false,
			write: (t) => written.push(t),
		})

		assert.equal(result.skipped, false)
		assert.equal(result.message, "no real changes → automatic fail (QA session never ran)")
		assert.equal(result.group.qa?.verdict, "fail")
		assert.equal(result.group.qa?.status, "failed")
		assert.ok(result.group.qa?.evidence.includes("structurally impossible"))
		assert.ok(written.some((line) => line.startsWith("AUTOMATIC FAIL:")))
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

/** Harness bookkeeping files alone must not count as "real changes". */
async function testAutomaticFailGateIgnoresHarnessArtifacts(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		configureGit(repo)
		await fs.writeFile(path.join(repo, "base.txt"), "base\n", "utf-8")
		commitFile(repo, "base.txt", "base\n", "base")
		const branch = "issues/w1-2026-08-28"
		const wtPath = makeEmptyWorktree(repo, branch)
		// Exactly the artifacts a real worker/review/QA session leaves behind
		// (see harness.log/qa.log/review.log/.env/ORCHESTRATOR_TASK.md/
		// .headlesscode/ observed live in every round tonight) — none of
		// these are real work and must not defeat the gate.
		await fs.writeFile(path.join(wtPath, "harness.log"), "log\n", "utf-8")
		await fs.writeFile(path.join(wtPath, ".env"), "X=1\n", "utf-8")
		await fs.mkdir(path.join(wtPath, ".headlesscode"), { recursive: true })
		await fs.writeFile(path.join(wtPath, ".headlesscode", "state.json"), "{}", "utf-8")

		const group = baseGroup({ branch, status: "done" })
		const statePath = writeState(repo, [group])
		const result = await runReviewStep({
			repo,
			statePath,
			group,
			reviewMode: "deepseek-reviewer",
			forceReview: false,
			dryRun: false,
			write: () => {},
		})
		assert.equal(
			result.message,
			"no real changes → automatic fail (review session never ran)",
			"harness bookkeeping files alone must still trip the automatic-fail gate",
		)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── reviewMain (dry-run: no LLM, no state mutation) ─────────────────────────

async function testReviewMainDryRunOnDoneGroup(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		writeState(repo, [baseGroup({ status: "done" })])
		const before = loadStateSync(path.join(repo, ".worktrees", ".orchestrator-state.json"))

		const { exit, stdout } = await withCapturedStdout(() =>
			reviewMain(["--repo", repo, "--issue", "14", "--dry-run"]),
		)
		assert.equal(exit, 0, "clean dry-run review exits 0")
		assert.ok(stdout.includes("reviewing w1"), `names the group, got: ${stdout}`)
		assert.ok(stdout.includes("dry-run: would run a headless review session"), `plans the review, got: ${stdout}`)

		const after = loadStateSync(path.join(repo, ".worktrees", ".orchestrator-state.json"))
		assert.deepEqual(after, before, "dry-run must not touch the state file")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReviewMainRebuildsStaleRunningGroup(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		await markDone(wtPath, 0)
		// Stale state says "running" but the markers show done — reviewMain must
		// rebuild first (dry-run: report only, persist nothing).
		writeState(repo, [baseGroup({ status: "running" })])

		const { exit, stdout } = await withCapturedStdout(() =>
			reviewMain(["--repo", repo, "--issue", "14", "--dry-run"]),
		)
		assert.equal(exit, 0)
		assert.ok(stdout.includes("would rebuild state from markers → done"), `reports the rebuild, got: ${stdout}`)
		assert.ok(stdout.includes("dry-run: would run a headless review session"), `then plans the review, got: ${stdout}`)

		const state = loadStateSync(path.join(repo, ".worktrees", ".orchestrator-state.json"))
		assert.equal(state.groups[0]?.status, "running", "dry-run rebuild is not persisted")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReviewMainRequiresTarget(): Promise<void> {
	const { exit, stderr } = await withCapturedStderr(() => reviewMain(["--repo", "/tmp/x"]))
	assert.equal(exit, 2, "missing target is a usage error")
	assert.ok(stderr.includes("provide exactly one of --issue"), stderr)
}

// ─── reworkMain (dry-run: no spawn, no task-file write) ──────────────────────

async function testReworkMainDryRunPrintsTaskAndSpawnCommand(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		writeState(repo, [
			baseGroup({ status: "done", review_verdict: "finding", pending_review_findings: ["break the loop"] }),
		])
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		const before = loadStateSync(statePath)

		const { exit, stdout } = await withCapturedStdout(() =>
			reworkMain(["--repo", repo, "--issue", "14", "--dry-run"]),
		)
		assert.equal(exit, 0, "dry-run rework exits 0")
		assert.ok(stdout.includes("rework cycle 1"), `names the cycle, got: ${stdout}`)
		assert.ok(stdout.includes("dry-run: would write"), `plans the task file, got: ${stdout}`)
		assert.ok(stdout.includes("run-worker.sh"), `plans the spawn command, got: ${stdout}`)
		assert.ok(stdout.includes(".worktrees/w1"), "rework targets the SAME worktree, got: " + stdout)

		// Nothing persisted, no task file written.
		assert.deepEqual(loadStateSync(statePath), before, "dry-run must not touch state")
		const taskDir = path.join(repo, "plans", "parallel-tasks")
		await assert.rejects(fs.stat(taskDir), "dry-run must not write the rework task file")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReworkMainFallsBackToNoFindingsText(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		// No pending_review_findings, no gh available → the template's
		// no-findings fallback is announced and the dry-run still proceeds.
		writeState(repo, [baseGroup({ status: "done" })])

		const { exit, stdout } = await withCapturedStdout(() =>
			reworkMain(["--repo", repo, "--issue", "14", "--dry-run"]),
		)
		assert.equal(exit, 0)
		assert.ok(stdout.includes("no recorded findings"), `announces the fallback, got: ${stdout}`)
		assert.ok(stdout.includes("dry-run: would write"), "still plans the rework task, got: " + stdout)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReworkMainDryRunAtCapMarksNeedsHuman(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		writeState(repo, [
			baseGroup({
				status: "done",
				reworkCount: 3,
				review_verdict: "finding",
				pending_review_findings: ["still broken"],
			}),
		])
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		const before = loadStateSync(statePath)

		const { exit, stdout } = await withCapturedIo(() =>
			reworkMain(["--repo", repo, "--issue", "14", "--dry-run", "--max-rework-cycles", "3"]),
		)
		assert.equal(exit, 1, "at the rework cap the command reports needs-human")
		assert.ok(stdout.includes("dry-run: would mark w1 needs-human"), `plans the needs-human patch, got: ${stdout}`)
		assert.deepEqual(loadStateSync(statePath), before, "dry-run must not touch state")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── reworkMain / runReworkStep on a QA-failed group (issue #52) ─────────────

/**
	* Issue #52's practical complaint verbatim: `orchestrate rework` against a
	* QA-failed group used to be a no-op (it only reworks REVIEW findings, so it
	* just re-verified the clean review and did nothing about the QA evidence).
	* Verifies the fix end-to-end through the subcommand: a group whose QA came
	* back "fail" (clean review) now produces a QA rework task + spawn command.
	*/
async function testReworkMainDryRunQaFailReworksFromQaEvidence(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		writeState(repo, [
			baseGroup({
				status: "done",
				review_verdict: "clean",
				qa: {
					status: "failed",
					verdict: "fail",
					evidence: "integration test is red: expect 42 got 41",
					updated: new Date().toISOString(),
				},
			}),
		])
		const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
		const before = loadStateSync(statePath)

		const { exit, stdout } = await withCapturedStdout(() =>
			reworkMain(["--repo", repo, "--group", "w1", "--dry-run"]),
		)
		assert.equal(exit, 0, "a QA-failed group is reworkable — the previous no-op is gone")
		assert.ok(stdout.includes("rework cycle 1"), `names the cycle, got: ${stdout}`)
		assert.ok(stdout.includes("run-worker.sh"), `plans the spawn command, got: ${stdout}`)
		assert.ok(stdout.includes("w1-qa-rework1.md"), `QA rework task file named, got: ${stdout}`)
		assert.deepEqual(loadStateSync(statePath), before, "dry-run must not touch state")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRunReworkStepDryRunQaFailProducesQaReworkTask(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const group = baseGroup({
			status: "done",
			qa: {
				status: "failed",
				verdict: "fail",
				evidence: "boot smoke test fails",
				updated: new Date().toISOString(),
			},
		})
		writeState(repo, [group])
		const lines: string[] = []
		const result = await runReworkStep({
			repo,
			statePath: path.join(repo, ".worktrees", ".orchestrator-state.json"),
			group,
			mode: "code",
			maxReworkCycles: 3,
			dryRun: true,
			write: (t) => lines.push(t),
		})
		assert.equal(result.outcome, "dry-run")
		assert.ok(
			lines.some((l) => l.includes("w1-qa-rework1.md")),
			`QA-failed group reworks from QA evidence (qa-rework task file), got: ${lines.join("|")}`,
		)
		assert.ok(lines.some((l) => l.includes("run-worker.sh")), `spawn command planned, got: ${lines.join("|")}`)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRunReworkStepDryRunReviewFindingsWinOverQaFail(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const group = baseGroup({
			status: "done",
			pending_review_findings: ["review finding A"],
			qa: {
				status: "failed",
				verdict: "fail",
				evidence: "qa evidence B",
				updated: new Date().toISOString(),
			},
		})
		writeState(repo, [group])
		const lines: string[] = []
		const result = await runReworkStep({
			repo,
			statePath: path.join(repo, ".worktrees", ".orchestrator-state.json"),
			group,
			mode: "code",
			maxReworkCycles: 3,
			dryRun: true,
			write: (t) => lines.push(t),
		})
		assert.equal(result.outcome, "dry-run")
		assert.ok(
			lines.some((l) => l.includes("w1-rework1.md")),
			`review findings win over QA fail (review task file), got: ${lines.join("|")}`,
		)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

/**
	* Issue #52 in the resume path: a group that ALREADY has a recorded QA fail
	* (status done — the pre-fix code silently settled it, or the rework spawn
	* was interrupted) must be reworked from its QA evidence, NOT reported as
	* settled with cost recorded. Dry-run: the rework is planned, state is
	* untouched.
	*/
async function testResumeGroupDryRunReworksRecordedQaFail(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		const group = baseGroup({
			status: "done",
			review_verdict: "clean",
			qa: {
				status: "failed",
				verdict: "fail",
				evidence: "boot smoke test fails",
				updated: new Date().toISOString(),
			},
		})
		const statePath = writeState(repo, [group])
		const lines: string[] = []
		const result = await resumeGroup({
			repo,
			statePath,
			group,
			reviewMode: "deepseek-reviewer",
			qaMode: "qa-agent",
			reviewEnabled: true,
			qaEnabled: true,
			mode: "code",
			maxReworkCycles: 3,
			maxContinuations: 3,
			forceReview: false,
			dryRun: true,
			write: (t) => lines.push(t),
		})
		assert.equal(
			result.outcome,
			"in-flight",
			`recorded QA fail is reworked, not settled, got ${result.outcome}: ${result.message}`,
		)
		assert.ok(
			lines.some((l) => l.includes("w1-qa-rework1.md")),
			`QA rework task planned, got: ${lines.join("|")}`,
		)
		const state = loadStateSync(statePath)
		assert.equal(state.groups[0]?.status, "done", "dry-run leaves the recorded QA fail untouched")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── resumeMain (dry-run pipeline wiring) ────────────────────────────────────

async function testResumeMainDryRunRebuildThenReviewPlan(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		await markDone(wtPath, 0)
		// Stale "running" entry with REAL done markers — the primary issue #14
		// recovery scenario.
		writeState(repo, [baseGroup({ status: "running" })])

		const { exit, stdout } = await withCapturedStdout(() =>
			resumeMain(["--repo", repo, "--issue", "14", "--dry-run"]),
		)
		assert.equal(exit, 0)
		assert.ok(stdout.includes("rebuilding from disk markers"), `rebuild step runs first, got: ${stdout}`)
		assert.ok(stdout.includes("dry-run: would run a headless review session"), `review step planned, got: ${stdout}`)
		assert.ok(stdout.includes("[resume] w1"), `per-group resume lines, got: ${stdout}`)

		const state = loadStateSync(path.join(repo, ".worktrees", ".orchestrator-state.json"))
		assert.equal(state.groups[0]?.status, "running", "dry-run rebuild is not persisted")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testResumeMainDryRunReworksRecordedFinding(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		// Interrupted round: review recorded a finding verdict but the rework
		// spawn never happened — resume must rework the recorded findings
		// WITHOUT re-running the review (issue #14's exact scenario).
		writeState(repo, [
			baseGroup({
				status: "done",
				review_verdict: "finding",
				pending_review_findings: ["address the finding"],
			}),
		])

		const { exit, stdout } = await withCapturedStdout(() =>
			resumeMain(["--repo", repo, "--issue", "14", "--dry-run"]),
		)
		assert.equal(exit, 0)
		assert.ok(stdout.includes("rework cycle 1"), `plans the rework cycle, got: ${stdout}`)
		assert.ok(stdout.includes("run-worker.sh"), `plans the rework spawn, got: ${stdout}`)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testResumeMainDryRunPlansContinuation(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		await markDone(wtPath, 1, "headlesscode: task failed: Max iterations (50) reached without task completion\n")
		writeState(repo, [baseGroup({ status: "failed", exit_code: 1, summary: "headlesscode: task failed: Max iterations (50) reached without task completion" })])

		const { exit, stdout } = await withCapturedStdout(() =>
			resumeMain(["--repo", repo, "--issue", "14", "--dry-run"]),
		)
		assert.equal(exit, 0)
		assert.ok(stdout.includes("continuation 1"), `plans the continuation, got: ${stdout}`)
		assert.ok(stdout.includes("run-worker.sh"), `plans the continuation spawn, got: ${stdout}`)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── resumeGroup real (non-dry-run) rebuild + cost recording (no LLM) ────────

async function testResumeGroupRebuildsAndRecordsCostWithoutReview(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		await markDone(wtPath, 0)
		const statePath = writeState(repo, [baseGroup({ status: "running", spawned: new Date(Date.now() - 60_000).toISOString() })])

		// reviewEnabled=false so no LLM session is started; the pipeline still
		// rebuilds from markers and records the settled group's cost.
		const lines: string[] = []
		const result = await resumeGroup({
			repo,
			statePath,
			group: baseGroup({ status: "running", spawned: new Date(Date.now() - 60_000).toISOString() }),
			reviewMode: "deepseek-reviewer",
			qaMode: "qa-agent",
			reviewEnabled: false,
			qaEnabled: false,
			mode: "code",
			maxReworkCycles: 3,
			maxContinuations: 3,
			forceReview: false,
			dryRun: false,
			write: (t) => lines.push(t),
		})

		assert.equal(result.outcome, "settled", `expected settled, got ${result.outcome}: ${result.message}`)
		const state = loadStateSync(statePath)
		assert.equal(state.groups[0]?.status, "done", "stale running entry rebuilt to done from real markers")
		assert.equal(state.groups[0]?.exit_code, 0)
		assert.equal(
			state.groups[0]?.cost_recorded !== undefined,
			true,
			"the one-shot cost gate marks the group recorded even with no usage data (mirrors watchGroups' recordCostIfSettled)",
		)
		assert.ok(lines.some((l) => l.includes("rebuilding from disk markers")), "rebuild step reported, got: " + lines.join("|"))
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testResumeGroupDryRunLeavesStateUntouched(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		await markDone(wtPath, 0)
		const statePath = writeState(repo, [baseGroup({ status: "running" })])
		const before = loadStateSync(statePath)

		const result = await resumeGroup({
			repo,
			statePath,
			group: baseGroup({ status: "running" }),
			reviewMode: "deepseek-reviewer",
			qaMode: "qa-agent",
			reviewEnabled: false,
			qaEnabled: false,
			mode: "code",
			maxReworkCycles: 3,
			maxContinuations: 3,
			forceReview: false,
			dryRun: true,
			write: () => {},
		})
		assert.equal(result.outcome, "settled", `dry-run still reports the planned outcome, got ${result.outcome}`)
		assert.deepEqual(loadStateSync(statePath), before, "dry-run never persists")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testResumeGroupInFlightWhenWorkerRunning(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const wtPath = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wtPath, { recursive: true })
		const statePath = writeState(repo, [baseGroup({ status: "running" })])

		const result = await resumeGroup({
			repo,
			statePath,
			group: baseGroup({ status: "running" }),
			reviewMode: "deepseek-reviewer",
			qaMode: "qa-agent",
			reviewEnabled: true,
			qaEnabled: false,
			mode: "code",
			maxReworkCycles: 3,
			maxContinuations: 3,
			forceReview: false,
			dryRun: true,
			write: () => {},
		})
		assert.equal(result.outcome, "in-flight", "a group with no markers and no stall is genuinely in flight")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── orchestrateMain subcommand dispatch (dynamic import wiring) ─────────────

async function testOrchestrateMainDispatchesReviewHelp(): Promise<void> {
	const { exit, stdout } = await withCapturedStdout(() => orchestrateMain(["review", "--help"]))
	assert.equal(exit, 0)
	assert.ok(stdout.includes("orchestrate review"), `review help dispatched, got: ${stdout.slice(0, 80)}`)
}

async function testOrchestrateMainDispatchesReworkHelp(): Promise<void> {
	const { exit, stdout } = await withCapturedStdout(() => orchestrateMain(["rework", "--help"]))
	assert.equal(exit, 0)
	assert.ok(stdout.includes("orchestrate rework"), `rework help dispatched, got: ${stdout.slice(0, 80)}`)
}

async function testOrchestrateMainDispatchesResumeHelp(): Promise<void> {
	const { exit, stdout } = await withCapturedStdout(() => orchestrateMain(["resume", "--help"]))
	assert.equal(exit, 0)
	assert.ok(stdout.includes("orchestrate resume"), `resume help dispatched, got: ${stdout.slice(0, 80)}`)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["parseReviewArgs defaults + target conflicts", testParseReviewArgsDefaults],
	["parseReviewArgs rejects issue+pr conflict and bad values", testParseReviewArgsTargetConflicts],
	["parseReworkArgs defaults, caps, memory-dir", testParseReworkArgs],
	["parseResumeArgs defaults (no target → all groups) and flags", testParseResumeArgs],
	["resolveTargetGroups by group name", testResolveTargetGroupsByGroupName],
	["resolveTargetGroups by issue number", testResolveTargetGroupsByIssue],
	["resolveTargetGroups by PR (direct + branch fallback)", testResolveTargetGroupsByPr],
	["findingsFromCommentBodies extracts reviewer findings", testFindingsFromCommentBodies],
	["findingsFromCommentBodies empty for clean/no comments", testFindingsFromCommentBodiesEmpty],
	["rebuild from markers: stale running + exit 0 → done", testRebuildDoneFromMarkersExitZero],
	["rebuild from markers: exit 1 → failed", testRebuildFailedFromMarkersExitNonZero],
	["rebuild from markers: worktree gone → orphaned", testRebuildOrphanedWhenWorktreeGone],
	["rebuild from markers: genuinely running → no patch", testRebuildNoChangeWhenGenuinelyRunning],
	["recheckoutWorktree recreates a removed worktree on its branch", testRecheckoutWorktreeRecreatesRemovedWorktree],
	["recheckoutWorktree fails without a recorded branch", testRecheckoutWorktreeFailsWithoutBranch],
	["runReviewStep: automatic fail on an empty worktree (issue #26 incident)", testRunReviewStepAutomaticFailOnEmptyWorktree],
	["runReviewStep: a real committed change reaches the normal dry-run path", testRunReviewStepProceedsWithRealCommittedChange],
	["runQaStep: automatic fail on an empty worktree (issue #26 incident)", testRunQaStepAutomaticFailOnEmptyWorktree],
	["automatic-fail gate ignores harness bookkeeping artifacts", testAutomaticFailGateIgnoresHarnessArtifacts],
	["reviewMain --dry-run on a done group exits 0, changes nothing", testReviewMainDryRunOnDoneGroup],
	["reviewMain rebuilds a stale running group before reviewing (dry-run)", testReviewMainRebuildsStaleRunningGroup],
	["reviewMain without a target is a usage error", testReviewMainRequiresTarget],
	["reworkMain --dry-run prints task + spawn command, spawns nothing", testReworkMainDryRunPrintsTaskAndSpawnCommand],
	["reworkMain falls back to the no-findings template text", testReworkMainFallsBackToNoFindingsText],
	["reworkMain at the rework cap reports needs-human (dry-run)", testReworkMainDryRunAtCapMarksNeedsHuman],
	["reworkMain --dry-run reworks a QA-failed group from its QA evidence (issue #52)", testReworkMainDryRunQaFailReworksFromQaEvidence],
	["runReworkStep dry-run on a QA-failed group produces the QA rework task (issue #52)", testRunReworkStepDryRunQaFailProducesQaReworkTask],
	["runReworkStep: review findings win over a QA fail (issue #52)", testRunReworkStepDryRunReviewFindingsWinOverQaFail],
	["resumeGroup dry-run reworks a recorded QA fail instead of settling (issue #52)", testResumeGroupDryRunReworksRecordedQaFail],
	["resumeMain --dry-run: rebuild then review plan", testResumeMainDryRunRebuildThenReviewPlan],
	["resumeMain --dry-run: reworks a recorded finding without re-review", testResumeMainDryRunReworksRecordedFinding],
	["resumeMain --dry-run: plans a continuation on iteration exhaustion", testResumeMainDryRunPlansContinuation],
	["resumeGroup (real): rebuilds stale running → done and records cost", testResumeGroupRebuildsAndRecordsCostWithoutReview],
	["resumeGroup --dry-run leaves state untouched", testResumeGroupDryRunLeavesStateUntouched],
	["resumeGroup reports in-flight for a genuinely running group", testResumeGroupInFlightWhenWorkerRunning],
	["orchestrateMain dispatches review --help", testOrchestrateMainDispatchesReviewHelp],
	["orchestrateMain dispatches rework --help", testOrchestrateMainDispatchesReworkHelp],
	["orchestrateMain dispatches resume --help", testOrchestrateMainDispatchesResumeHelp],
]

async function main(): Promise<void> {
	// Redirect the central store so mode-model resolution stays inside the
	// sandbox, never the real home store.
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "hc-resume-store-"))
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
	console.log(`\nAll ${tests.length} resume tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
