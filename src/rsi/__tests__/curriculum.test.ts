import assert from "node:assert/strict"
import { generateCurriculumProposals, validateCurriculumTask, writeCurriculumProposals } from "../curriculum.js"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
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
assert.equal(validateCurriculumTask(proposals[0]), true, "structural checks only establish that the proposal is well formed")

const output = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-curriculum-"))
try {
	const file = await writeCurriculumProposals(proposals, output)
	const written = JSON.parse(await fs.readFile(file, "utf8")) as Array<{ validated: boolean }>
	assert.equal(written[0].validated, false, "writing proposals must not claim execution validation")
} finally {
	await fs.rm(output, { recursive: true, force: true })
}
console.log("All 5 RSI curriculum assertions passed")
