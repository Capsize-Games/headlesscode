import assert from "node:assert/strict"
import { generateCurriculumProposals, validateCurriculumTask } from "../curriculum.js"
import type { CandidateRecord, RsiArchive } from "../types.js"

const failed: CandidateRecord = {
	id: "failed-1",
	generation: 0,
	parent: "baseline",
	branch: "rsi/failed-1",
	worktree: "/tmp/failed-1",
	baseCommit: "abc",
	status: "failed",
	model: "qwen",
	mutation: "fixture",
	createdAt: "now",
	updatedAt: "now",
	commits: [],
	changedFiles: [],
	protectedPathViolations: [],
	failure: "Max iterations (20) reached without task completion",
}

const archive: RsiArchive = {
	schemaVersion: 2,
	updatedAt: "now",
	runs: [],
	activeRuns: [],
	candidates: [failed],
	modelCandidates: [],
	combinations: [],
	jobs: [],
	trajectoryRefs: [],
	curriculumTasks: [],
}

const proposals = generateCurriculumProposals(archive, "now")
assert.equal(proposals.length, 1)
assert.equal(proposals[0].capability, "completion-discipline")
assert.equal(validateCurriculumTask(proposals[0]), true)
assert.equal(proposals[0].validated, false)
console.log("All 3 RSI curriculum assertions passed")
