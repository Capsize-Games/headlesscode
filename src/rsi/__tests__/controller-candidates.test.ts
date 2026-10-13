import assert from "node:assert/strict"
import test from "node:test"
import {
	combinedArchive,
	improveRunOutcome,
	initialRun,
	recoverInterruptedCandidates,
	replaceJob,
	validateDeterministicWorkerHarnessRunId,
} from "../controller.js"
import { baseModelCandidate } from "../models.js"
import type {
	CandidateRecord,
	ExperimentJob,
	RsiArchive,
	RsiConfig,
	RsiRunRecord,
} from "../types.js"

function config(overrides: Partial<RsiConfig> = {}): RsiConfig {
	return {
		repoRoot: "/tmp/repo",
		model: "fixture-model",
		population: 2,
		generations: 2,
		maxConcurrent: 1,
		mutationTask: "fixture evolution",
		regressionCommand: "npm test",
		evalCommands: ["visible"],
		hiddenEvalCommands: [],
		archiveDir: "/tmp/archive",
		worktreeDir: "/tmp/worktrees",
		baseRef: "HEAD",
		seed: "candidate-test",
		dryRun: false,
		keepWorktrees: false,
		maxIterations: 2,
		protectedPaths: [],
		commandTimeoutMs: 1000,
		...overrides,
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
		status: "evaluating",
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

function job(overrides: Partial<ExperimentJob> = {}): ExperimentJob {
	return {
		id: "job-1",
		kind: "mutation",
		status: "queued",
		resource: { class: "CPU", units: 1 },
		createdAt: "2026-09-20T00:00:00.000Z",
		updatedAt: "2026-09-20T00:00:00.000Z",
		attempts: 0,
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

test("initial run freezes the run identity and model candidate", () => {
	const started = initialRun(config(), "a".repeat(40), "2026-09-20T00:00:00.000Z")
	assert.equal(started.baseCommit, "a".repeat(40))
	assert.equal(started.generations, 2)
	assert.deepEqual(
		started.modelCandidates,
		[baseModelCandidate("fixture-model", "2026-09-20T00:00:00.000Z", "model-base")],
	)
	assert.ok(started.runId.startsWith("rsi-20260920000000-"))
})

test("initial run honors deterministic harness identity", () => {
	const pairId = "rsi-proof-a1b2c3d4e5f60718293a"
	const started = initialRun(config({
		workerHarnessMode: "fixed-control",
		workerHarnessPairId: pairId,
		workerHarnessRunId: `${pairId}-fixed`,
	}), "a".repeat(40), "2026-09-20T00:00:00.000Z")
	assert.equal(started.runId, `${pairId}-fixed`)
})

test("deterministic harness run id rejects mismatched pairs", () => {
	assert.throws(() => validateDeterministicWorkerHarnessRunId(config({
		workerHarnessMode: "fixed-control",
		workerHarnessRunId: "rsi-proof-wrong",
	})), /must match its paired campaign/)
	assert.throws(() => validateDeterministicWorkerHarnessRunId(config({
		workerHarnessMode: "fixed-control",
		workerHarnessPairId: "rsi-proof-a1b2c3d4e5f60718293",
		workerHarnessRunId: "rsi-proof-a1b2c3d4e5f60718293-self",
	})), /must match its paired campaign/)
	validateDeterministicWorkerHarnessRunId(config())
})

test("replace job upserts by identity", () => {
	const current = run({ jobs: [job()] })
	replaceJob(current, job({ status: "completed" }))
	assert.equal(current.jobs?.length, 1)
	assert.equal(current.jobs?.[0]?.status, "completed")
	replaceJob(current, job({ id: "job-2" }))
	assert.equal(current.jobs?.length, 2)
})

test("combined archive prefers live candidates over stale copies", () => {
	const archive = {
		schemaVersion: 2,
		updatedAt: "2026-09-20T00:00:00.000Z",
		runs: [],
		activeRuns: [],
		candidates: [candidate({ id: "stale", status: "failed" })],
		modelCandidates: [],
		combinations: [],
		jobs: [],
		trajectoryRefs: [],
		curriculumTasks: [],
	} as RsiArchive
	const merged = combinedArchive(archive, run({
		candidates: [candidate({ id: "stale", status: "accepted" }), candidate()],
	}))
	assert.deepEqual(merged.candidates.map((entry) => entry.id), ["stale", "candidate-a"])
	assert.equal(merged.candidates[0]?.status, "accepted")
})

test("interrupted candidates fail without touching terminal states", () => {
	const current = run({
		candidates: [
			candidate({ id: "active", status: "mutating" }),
			candidate({ id: "settled", status: "accepted" }),
		],
	})
	recoverInterruptedCandidates(current, "2026-09-20T00:00:02.000Z")
	assert.equal(current.candidates[0]?.status, "failed")
	assert.equal(current.candidates[0]?.failure, "run interrupted before candidate reached a terminal state")
	assert.equal(current.candidates[0]?.updatedAt, "2026-09-20T00:00:02.000Z")
	assert.equal(current.candidates[1]?.status, "accepted")
})

test("improve outcome reports campaign state and selection", () => {
	const incomplete = improveRunOutcome({
		runId: "run-a",
		selected: "candidate-a",
		proofCampaign: { state: "incomplete" },
	}, false)
	assert.equal(incomplete.exitCode, 1)
	assert.match(incomplete.output, /incomplete: run-a/)
	const selected = improveRunOutcome({ runId: "run-a", selected: "candidate-a" }, false)
	assert.equal(selected.exitCode, 0)
	assert.match(selected.output, /complete: run-a; selected=candidate-a/)
	const unselected = improveRunOutcome({ runId: "run-a" }, false)
	assert.equal(unselected.exitCode, 1)
	const dry = improveRunOutcome({ runId: "run-a" }, true)
	assert.equal(dry.exitCode, 0)
})
