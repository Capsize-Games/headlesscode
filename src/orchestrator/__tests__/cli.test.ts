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
	buildReworkTaskFileContent,
	buildSpawnEnv,
	handleIterationExhaustion,
	handleReviewVerdict,
	orchestrateMain,
	parseOrchestrateArgs,
} from "../cli.js"
import { watchGroups } from "../watch.js"
import { defaultState, loadStateSync, saveStateSync, updateGroup, type OrchestratorGroup, type OrchestratorState } from "../state.js"
import type { ReviewResult } from "../reviewer.js"

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
	// Default with neither a flag nor the env var: undefined -> the harness's
	// own default (50) applies untouched (the issue only makes it overridable).
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

async function testOrchestrateMainFailsOnStaleWorktree(): Promise<void> {
	const repo = await tmpRepo()
	try {
		initGitRepo(repo)
		const issuesPath = path.join(repo, "issues.json")
		await fs.writeFile(
			issuesPath,
			JSON.stringify([{ number: 1, title: "Fix the thing", body: "Do it" }]),
			"utf-8",
		)
		// Leftover worktree dir from a previous round — the round must abort
		// BEFORE spawning anything (and even before the --dry-run early-exit,
		// so a dry run catches stale worktrees too).
		await fs.mkdir(path.join(repo, ".worktrees", "w1"), { recursive: true })
		await fs.writeFile(path.join(repo, ".worktrees", "w1", "leftover.txt"), "stale\n", "utf-8")

		const { exit, stderr } = await withCapturedStderr(() =>
			orchestrateMain(["--repo", repo, "--issues-json", issuesPath, "--dry-run"]),
		)

		assert.notEqual(exit, 0, "a stale worktree dir must fail the round, got exit 0")
		assert.ok(stderr.includes(".worktrees/w1"), `error names the colliding path, got: ${stderr}`)
		assert.ok(stderr.includes("Remove them first"), "error tells the caller how to clean up")
		assert.ok(stderr.includes("git worktree remove"), "cleanup hint names git worktree remove")
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
	["spawn env carries the resolved model when the worker's mode is mapped", testSpawnEnvCarriesResolvedModelWhenModeMapped],
	["spawn env resolves from the _default key", testSpawnEnvCarriesResolvedModelFromDefaultKey],
	["spawn env: explicit --model flag beats the config file", testSpawnEnvExplicitModelFlagBeatsConfig],
	["spawn env: no config -> raw OPENROUTER_MODEL passes through unchanged", testSpawnEnvNoConfigKeepsRawEnvModel],
	["spawn env: nothing configured -> no model injected", testSpawnEnvNoConfigNoEnvLeavesModelUnset],
	["--max-iterations parses (env fallback, flag beats env, invalid)", testParseOrchestrateArgsMaxIterations],
	["--max-continuations parses (default 3, custom, invalid)", testParseOrchestrateArgsMaxContinuations],
	["spawn env carries HEADLESSCODE_MAX_ITERATIONS (flag > env, untouched when unset)", testSpawnEnvCarriesMaxIterations],
	["continuation task file includes issues, cycle, and scope", testContinuationTaskFileContentIncludesIssuesAndCycle],
	["iteration exhaustion below cap triggers continuation spawn + state reset", testExhaustionBelowCapSpawnsAndResetsState],
	["iteration exhaustion increments from an existing continuation count", testExhaustionIncrementsFromExistingCount],
	["iteration exhaustion at cap marks needs-human and does NOT spawn", testExhaustionAtCapMarksNeedsHumanAndDoesNotSpawn],
	["budget stop never auto-continues (stays failed)", testBudgetFailureDoesNotContinue],
	["generic failure never auto-continues (stays failed)", testGenericFailureDoesNotContinue],
	["clean exit with the max-iterations text never auto-continues", testCleanExitWithMaxIterationsTextDoesNotContinue],
	["continuation spawn forwards the round-level --max-iterations when set", testExhaustionSpawnForwardsMaxIterations],
	["watchGroups re-polls a group after a continuation reset", testWatchGroupsRepollsGroupAfterContinuationReset],
	["orchestrateMain fails on a stale worktree dir even in --dry-run", testOrchestrateMainFailsOnStaleWorktree],
	["orchestrateMain dry-run proceeds when all worktree dirs are clear", testOrchestrateMainDryRunProceedsWhenNoCollision],
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
