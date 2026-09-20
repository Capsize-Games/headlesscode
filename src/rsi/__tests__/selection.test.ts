import assert from "node:assert/strict"
import { newExperimentJob, paretoFront, selectParentChoices, transitionJob } from "../selection.js"
import type { CandidateRecord, Fitness, MetricVector, RsiArchive } from "../types.js"

function metrics(overrides: Partial<MetricVector>): MetricVector {
	return {
		correctness: 0.8,
		reliability: 0.8,
		generalization: 0.8,
		hidden: 0.8,
		efficiency: 0.8,
		latency: 100,
		tokenUse: 100,
		recovery: 0.8,
		fabricationRate: 0.1,
		complexityPenalty: 0.1,
		...overrides,
	}
}

function candidate(id: string, vector: MetricVector, score: number): CandidateRecord {
	const fitness: Fitness = {
		score,
		components: { regression: 1, visible: vector.generalization, hidden: vector.hidden, efficiency: vector.efficiency, recovery: vector.recovery },
		metrics: vector,
		complexity: { diffLines: 10, changedFiles: 1, newDependencies: 0, additionalModelCalls: 0, runtimeOverheadMs: 0 },
		hardGates: { regressionPass: true, visibleEvalPass: true, hiddenEvalPass: true, noProtectedPathViolation: true, completed: true, noCrash: true, committed: true },
		reason: "all hard gates passed",
	}
	return {
		id,
		generation: 0,
		parent: "baseline",
		branch: `rsi/${id}`,
		worktree: `/tmp/${id}`,
		baseCommit: "base",
		status: "accepted",
		model: "qwen",
		mutation: id,
		createdAt: "now",
		updatedAt: "now",
		commits: [`commit-${id}`],
		changedFiles: ["src/engine/loop.ts"],
		protectedPathViolations: [],
		fitness,
	}
}

function archive(candidates: CandidateRecord[]): RsiArchive {
	return { schemaVersion: 2, updatedAt: "now", runs: [], activeRuns: [], candidates, modelCandidates: [], combinations: [], jobs: [], trajectoryRefs: [], curriculumTasks: [] }
}

function testParetoFrontRetainsTradeoffs(): void {
	const a = candidate("a", metrics({ correctness: 1, efficiency: 0.4 }), 80)
	const b = candidate("b", metrics({ correctness: 0.8, efficiency: 1, hidden: 1 }), 82)
	const dominated = candidate("dominated", metrics({ correctness: 0.7, efficiency: 0.3, hidden: 0.7 }), 70)
	assert.deepEqual(paretoFront([a, b, dominated]).map((entry) => entry.id).sort(), ["a", "b"])
}

function testParentPolicyRecordsReasons(): void {
	const choices = selectParentChoices(archive([candidate("a", metrics({ correctness: 1 }), 90), candidate("b", metrics({ hidden: 1 }), 80)]), "champion-specialist-novelty", 3)
	assert.equal(choices.length, 3)
	assert.equal(choices[0].reason.strategy, "champion")
	assert.ok(choices.some((choice) => choice.reason.strategy === "specialist"))
}

function testJobsAreResourceTaggedAndMonotonic(): void {
	const job = newExperimentJob("mutation", { class: "LOCAL_GPU", units: 1, concurrencyKey: "ollama" }, "now", "a")
	const running = transitionJob(job, "running", "later")
	const done = transitionJob(running, "completed", "done")
	assert.equal(running.attempts, 1)
	assert.equal(done.status, "completed")
	assert.equal(transitionJob(done, "failed", "ignored").status, "completed")
}

testParetoFrontRetainsTradeoffs()
testParentPolicyRecordsReasons()
testJobsAreResourceTaggedAndMonotonic()
console.log("All 3 RSI selection tests passed")
