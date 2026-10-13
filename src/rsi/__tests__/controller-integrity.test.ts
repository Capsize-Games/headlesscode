import assert from "node:assert/strict"
import test from "node:test"
import {
	adversarialOutputRecords,
	evaluationOutputRecords,
	evaluatorArchiveStateDigest,
	isTerminal,
	mergeIntegrityOutputs,
	proofCandidateSlot,
	trialOutputRecords,
	verifyArchivedIntegrityOutputs,
	type IntegrityOutput,
} from "../controller.js"
import { evaluatorIntegrityDigest } from "../evaluation-integrity.js"
import type {
	AdversarialReviewRecord,
	CandidateRecord,
	EvaluationSummary,
	RsiRunRecord,
	TrialResult,
} from "../types.js"

function trial(overrides: Partial<TrialResult> = {}): TrialResult {
	return {
		ok: true,
		command: "npm test",
		exitCode: 0,
		durationMs: 3,
		stdout: "pass",
		stderr: "",
		...overrides,
	}
}

function evaluation(): EvaluationSummary {
	return {
		regression: trial({ command: "regression" }),
		typecheck: trial({ command: "typecheck" }),
		visible: [trial({ command: "visible-0" })],
		hidden: [trial({ command: "hidden-0" })],
		completed: true,
		crashed: false,
		protectedPathViolation: false,
		changedFiles: [],
	}
}

function review(): AdversarialReviewRecord {
	return {
		candidateId: "candidate-a",
		role: "adversary",
		provider: "ollama",
		model: "adversary-model",
		promptVersion: "v1",
		promptSha256: "p".repeat(64),
		promptArtifactSha256: "a".repeat(64),
		resultArtifactSha256: "b".repeat(64),
		createdAt: "2026-09-20T00:00:00.000Z",
		status: "passed",
		findings: [],
		testResults: [{ id: "t1", passed: true }],
		penaltyPoints: 0,
	}
}

function candidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
	return {
		id: "candidate-a",
		generation: 0,
		parent: "baseline",
		branch: "rsi/candidate-a",
		worktree: "/tmp/worktree",
		baseCommit: "a".repeat(40),
		status: "accepted",
		model: "fixture-model",
		mutation: "fixture",
		createdAt: "2026-09-20T00:00:00.000Z",
		updatedAt: "2026-09-20T00:00:01.000Z",
		commits: [],
		changedFiles: [],
		protectedPathViolations: [],
		...overrides,
	}
}

function run(overrides: Partial<RsiRunRecord> = {}): RsiRunRecord {
	return {
		runId: "rsi-run",
		startedAt: "2026-09-20T00:00:00.000Z",
		model: "fixture-model",
		baseRef: "HEAD",
		baseCommit: "a".repeat(40),
		generations: 1,
		candidates: [],
		reports: [],
		...overrides,
	}
}

test("trial output records hash the command identity", () => {
	const [record] = trialOutputRecords("candidate-a", "regression", trial())
	assert.equal(record?.candidateId, "candidate-a")
	assert.equal(record?.taskId, "regression")
	assert.equal(record?.outputSha256, evaluatorIntegrityDigest({
		command: "npm test",
		exitCode: 0,
		stdout: "pass",
		stderr: "",
		timedOut: false,
	}))
})

test("trial output records carry artifact references", () => {
	const sha = "c".repeat(64)
	const [record] = trialOutputRecords("c", "t", trial({
		outputArtifactSha256: sha,
		outputArtifactBytes: 12,
	}))
	assert.equal(record?.artifactSha256, sha)
	assert.equal(record?.artifactBytes, 12)
})

test("evaluation output records index every trial slot", () => {
	const records = evaluationOutputRecords("candidate-a", evaluation())
	const tasks = records.map((entry) => entry.taskId).sort()
	assert.deepEqual(tasks, ["hidden-0", "regression", "typecheck", "visible-0"])
})

test("adversarial output records skip missing references", () => {
	const records = adversarialOutputRecords(review())
	const tasks = records.map((entry) => entry.taskId).sort()
	assert.deepEqual(tasks, ["adversarial-prompt", "adversarial-result"])
	assert.ok(records.every((entry) => entry.candidateId === "candidate-a"))
})

test("merge integrity outputs upserts and sorts without touching identity", () => {
	const record = { status: "unsealed", outputs: [], generations: [] } as
		NonNullable<RsiRunRecord["evaluatorIntegrity"]>
	const first = trialOutputRecords("candidate-b", "regression", trial())[0]!
	const second = trialOutputRecords("candidate-a", "regression", trial())[0]!
	mergeIntegrityOutputs(record, [first, second])
	assert.deepEqual(record.outputs.map((entry) => entry.candidateId), [
		"candidate-a",
		"candidate-b",
	])
	mergeIntegrityOutputs(record, [structuredClone(second)])
	assert.equal(record.outputs.length, 2)
	assert.throws(() => mergeIntegrityOutputs(record, [{
		...second,
		outputSha256: "d".repeat(64),
	}]), /identity changed/)
})

test("archived integrity verification accepts a matching seal", () => {
	const evaluated = evaluation()
	const candidateRecord = candidate({ result: trial() })
	const reviewRecord = review()
	const signed: IntegrityOutput[] = [
		...evaluationOutputRecords("baseline", evaluated),
		...trialOutputRecords(candidateRecord.id, "regression", candidateRecord.result!),
		...adversarialOutputRecords(reviewRecord),
	]
	verifyArchivedIntegrityOutputs(run({
		baselineEvaluation: evaluated,
		candidates: [candidateRecord],
		adversarialReviews: [reviewRecord],
	}), signed)
})

test("archived integrity verification rejects drift and orphan seals", () => {
	const evaluated = evaluation()
	const signed = evaluationOutputRecords("baseline", evaluated)
	const drifted = structuredClone(signed)
	drifted[0]!.outputSha256 = "d".repeat(64)
	assert.throws(() => verifyArchivedIntegrityOutputs(run({
		baselineEvaluation: evaluated,
	}), drifted), /differs from signed identity/)
	assert.throws(() => verifyArchivedIntegrityOutputs(run(), signed), /missing/)
})

test("evaluator archive digest is stable and content-sensitive", () => {
	const before = evaluatorArchiveStateDigest(run({ candidates: [candidate()] }))
	assert.equal(before, evaluatorArchiveStateDigest(run({ candidates: [candidate()] })))
	const after = evaluatorArchiveStateDigest(run({
		candidates: [candidate({ status: "rejected" })],
	}))
	assert.notEqual(before, after)
})

test("terminal states and proof slots format as expected", () => {
	assert.equal(isTerminal(candidate({ status: "accepted" })), true)
	assert.equal(isTerminal(candidate({ status: "mutating" })), false)
	assert.equal(proofCandidateSlot(2, 3), "g2-candidate-3")
})
