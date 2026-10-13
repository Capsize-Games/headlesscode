import assert from "node:assert/strict"
import { newExperimentJob, paretoFront, selectParentChoices, transitionJob } from "../selection.js"
import type { CandidateRecord, RsiArchive } from "../types.js"
import { candidate, metrics } from "./fixtures.js"

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

function testRejectedAndIncompleteCandidatesCannotBecomeParents(): void {
	const rejected = candidate("rejected", metrics({ correctness: 1 }), 100)
	rejected.status = "rejected"
	const failing = candidate("failing", metrics({ correctness: 1 }), 99)
	failing.fitness!.hardGates.noProtectedPathViolation = false
	const eligibleCandidate = candidate("accepted", metrics({ correctness: 1 }), 90)
	const choices = selectParentChoices(archive([rejected, failing, eligibleCandidate]), "all-eligible", 4)
	assert.ok(choices.every((entry) => entry.candidateId === "accepted"))
}

function testArchiveCandidatesWithoutCurrentDevelopmentProofAreIneligible(): void {
	const legacy = candidate("legacy", metrics({ correctness: 1 }), 100)
	delete legacy.developmentProof
	assert.deepEqual(selectParentChoices(archive([legacy]), "all-eligible", 1), [])
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
testRejectedAndIncompleteCandidatesCannotBecomeParents()
testArchiveCandidatesWithoutCurrentDevelopmentProofAreIneligible()
testJobsAreResourceTaggedAndMonotonic()
console.log("All 3 RSI selection tests passed")
