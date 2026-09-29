import assert from "node:assert/strict"
import test from "node:test"
import { decideAdaptiveContinuation } from "../adaptive.js"
import type { CandidateRecord, RsiConfig } from "../types.js"

function candidate(id: string, status: CandidateRecord["status"], passCount?: number): CandidateRecord {
	return {
		id, generation: 0, parent: "baseline", branch: id, worktree: `/tmp/${id}`, baseCommit: "base",
		status, model: "local", mutation: "test", createdAt: "now", updatedAt: "now", commits: [],
		changedFiles: [], protectedPathViolations: [],
		...(passCount === undefined ? {} : { fitness: { metrics: { generalization: passCount / 2 } } as CandidateRecord["fitness"] }),
	}
}

function config(overrides: Partial<RsiConfig> = {}): RsiConfig {
	return {
		repoRoot: "/tmp/repo", model: "local", population: 2, generations: 3, maxConcurrent: 2,
		mutationTask: "test", regressionCommand: "test", evalCommands: ["visible"], hiddenEvalCommands: [],
		archiveDir: "/tmp/archive", worktreeDir: "/tmp/worktrees", baseRef: "HEAD", seed: "test",
		dryRun: false, keepWorktrees: false, maxIterations: 4, protectedPaths: [], commandTimeoutMs: 1000,
		computePolicy: "adaptive-independent", maxTrajectories: 4, maxTotalIterations: 16, maxRuntimeMs: 1000,
		...overrides,
	}
}

test("adaptive policy allocates one follow-up when independent evidence is mixed", () => {
	const first = candidate("c0", "accepted", 2)
	const second = candidate("c1", "rejected", 0)
	const decision = decideAdaptiveContinuation({
		generation: 0, generationCandidates: [first, second], allCandidates: [first, second],
		config: config(), elapsedMs: 100, decidedAt: "2026-09-28T00:00:00.000Z",
	})
	assert.equal(decision.decision, "continue")
	assert.equal(decision.reason, "mixed-evidence")
	assert.equal(decision.remainingTrajectories, 2)
	assert.equal(decision.remainingIterations, 8)
	assert.equal(decision.evidence[0]?.visiblePassRate, 1)
})

test("adaptive policy stops and records the first exhausted bound", () => {
	const first = candidate("c0", "accepted", 2)
	const second = candidate("c1", "rejected", 0)
	const cases = [
		[config({ maxTrajectories: 2 }), "trajectory-cap"],
		[config({ maxTotalIterations: 8 }), "iteration-cap"],
		[config({ maxRuntimeMs: 50 }), "runtime-cap"],
		[config({ generations: 0 }), "generation-cap"],
	] as const
	for (const [runConfig, reason] of cases) {
		const decision = decideAdaptiveContinuation({
			generation: 0, generationCandidates: [first, second], allCandidates: [first, second],
			config: runConfig, elapsedMs: 100, decidedAt: "2026-09-28T00:00:00.000Z",
		})
		assert.equal(decision.decision, "stop")
		assert.equal(decision.reason, reason)
	}
})

test("consistent and insufficient evidence stop without extra compute", () => {
	const first = candidate("c0", "rejected", 0)
	const second = candidate("c1", "rejected", 0)
	const shared = { allCandidates: [first, second], config: config(), elapsedMs: 0, decidedAt: "now" }
	assert.equal(decideAdaptiveContinuation({ generation: 0, generationCandidates: [first, second], ...shared }).reason, "consistent-evidence")
	assert.equal(decideAdaptiveContinuation({ generation: 0, generationCandidates: [first], ...shared }).reason, "insufficient-results")
})
