import assert from "node:assert/strict"
import test from "node:test"
import {
	fleetEvaluationResult,
	fleetRuntimeDeadlineMs,
	fleetWorkerHarnessExecution,
	recordFleetInferenceDenials,
	validateCandidateWorkerHarnessExecution,
} from "../controller.js"
import { workerHarnessCliPath } from "../worker-harness.js"
import type {
	CandidateRecord,
	RsiConfig,
	RsiRunRecord,
	TrialResult,
	WorkerHarnessExecution,
} from "../types.js"
import type { FleetJobPayload } from "../postgres-queue.js"

const workerRuntime = {
	imageName: "harness",
	imageDigest: `sha256:${"d".repeat(64)}`,
	harnessCommit: "e".repeat(40),
	dependencyLockDigest: "f".repeat(64),
}

function config(overrides: Partial<RsiConfig> = {}): RsiConfig {
	return {
		repoRoot: "/tmp/repo",
		model: "fixture-model",
		population: 1,
		generations: 1,
		maxConcurrent: 1,
		mutationTask: "fixture",
		regressionCommand: "npm test",
		evalCommands: [],
		hiddenEvalCommands: [],
		archiveDir: "/tmp/archive",
		worktreeDir: "/tmp/worktrees",
		baseRef: "HEAD",
		seed: "fleet-test",
		dryRun: false,
		keepWorktrees: false,
		maxIterations: 1,
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

function trial(command: string, sha: string): TrialResult {
	return {
		ok: true,
		command,
		exitCode: 0,
		durationMs: 2,
		stdout: "",
		stderr: "",
		outputArtifactSha256: sha,
		outputArtifactBytes: 8,
	}
}

function fleetPayload(overrides: Partial<FleetJobPayload> = {}): FleetJobPayload {
	return {
		schemaVersion: 1,
		snapshotSha256: "s".repeat(64),
		snapshotBytes: 8,
		snapshotCommit: "b".repeat(40),
		task: "fixture",
		model: "fixture-model",
		maxIterations: 1,
		timeoutMs: 1000,
		protectedPaths: [],
		candidate: { id: "candidate-a" },
		...overrides,
	}
}

test("fleet runtime deadline follows the run ceiling", () => {
	const started = {
		runId: "run-a",
		startedAt: "2026-09-20T00:00:00.000Z",
	} as RsiRunRecord
	assert.equal(
		fleetRuntimeDeadlineMs(config({ maxRuntimeMs: 60_000 }), started),
		Date.parse("2026-09-20T00:00:00.000Z") + 60_000,
	)
	assert.equal(fleetRuntimeDeadlineMs(config(), started), undefined)
})

test("fleet evaluation result compacts bounded trials", () => {
	const sha = "c".repeat(64)
	const result = fleetEvaluationResult({
		evaluation: {
			regression: trial("regression", sha),
			typecheck: trial("typecheck", sha),
			visible: [trial("visible", sha)],
		},
		outputArtifact: { sha256: sha, bytes: 8 },
	})
	assert.equal(result.regression.command, "regression")
	assert.equal(result.typecheck.command, "typecheck")
	assert.equal(result.visible.length, 1)
})

test("fleet evaluation result rejects malformed envelopes", () => {
	assert.throws(() => fleetEvaluationResult(null), /malformed/)
	assert.throws(() => fleetEvaluationResult({
		evaluation: { regression: null, typecheck: null, visible: [] },
		outputArtifact: { sha256: "c".repeat(64), bytes: 8 },
	}), /malformed/)
	assert.throws(() => fleetEvaluationResult({
		evaluation: {
			regression: trial("regression", "c".repeat(64)),
			typecheck: trial("typecheck", "c".repeat(64)),
			visible: [],
		},
		outputArtifact: { sha256: "short", bytes: 8 },
	}), /artifact reference/)
})

test("fleet harness execution matches the frozen payload", () => {
	const tree = "a".repeat(64)
	const commit = "b".repeat(40)
	const payload = fleetPayload({
		workerHarness: {
			runMode: "fixed-control",
			mode: "fixed-control",
			parentCommit: "a".repeat(40),
			snapshotTreeDigest: tree,
			runtime: workerRuntime,
			executedCliPath: workerHarnessCliPath("fixed-control"),
		},
	})
	const execution: WorkerHarnessExecution = {
		mode: "fixed-control",
		parentCommit: "a".repeat(40),
		snapshotCommit: commit,
		snapshotTreeDigest: tree,
		runtime: workerRuntime,
		executedCliPath: workerHarnessCliPath("fixed-control"),
	}
	assert.deepEqual(
		fleetWorkerHarnessExecution({ workerHarnessExecution: execution }, payload),
		execution,
	)
	assert.equal(fleetWorkerHarnessExecution({}, fleetPayload()), undefined)
	assert.throws(() => fleetWorkerHarnessExecution({
		workerHarnessExecution: { ...execution, mode: "self-hosted" },
	}, payload), /frozen worker harness/)
	assert.throws(() => fleetWorkerHarnessExecution(null, payload), /omitted/)
})

test("candidate harness validation pins mode and runtime", () => {
	const tree = "a".repeat(64)
	const commit = "b".repeat(40)
	const execution: WorkerHarnessExecution = {
		mode: "fixed-control",
		parentCommit: "a".repeat(40),
		snapshotCommit: commit,
		snapshotTreeDigest: tree,
		runtime: workerRuntime,
		executedCliPath: workerHarnessCliPath("fixed-control"),
	}
	const record = candidate()
	validateCandidateWorkerHarnessExecution(
		record,
		{ workerHarnessRuntime: workerRuntime } as RsiRunRecord,
		config({ workerHarnessMode: "fixed-control" }),
		execution,
	)
	assert.deepEqual(record.workerHarnessExecution, execution)
	assert.throws(() => validateCandidateWorkerHarnessExecution(
		candidate(),
		{ workerHarnessRuntime: workerRuntime } as RsiRunRecord,
		config({ workerHarnessMode: "fixed-control" }),
		undefined,
	), /frozen worker harness execution/)
	validateCandidateWorkerHarnessExecution(candidate(), {} as RsiRunRecord, config(), undefined)
})

test("fleet denial audit records only well-formed summaries", () => {
	const payload = fleetPayload({ provider: "openrouter", model: "fixture-model" })
	const record = candidate()
	recordFleetInferenceDenials(record, {
		provider: "openrouter",
		model: "fixture-model",
		inferenceAudit: {
			accounting: "incomplete",
			jobId: "job-1",
			denials: [{ statusCode: 429, count: 2, reason: "rate-limited" }],
		},
	}, payload, "job-1")
	assert.deepEqual(record.inferenceDenials, [{ statusCode: 429, count: 2, reason: "rate-limited" }])
	const ignored = candidate()
	recordFleetInferenceDenials(ignored, {
		provider: "openrouter",
		model: "fixture-model",
		inferenceAudit: {
			accounting: "incomplete",
			jobId: "job-1",
			denials: [{ statusCode: 200, count: 1, reason: "ok" }],
		},
	}, payload, "job-1")
	assert.equal(ignored.inferenceDenials, undefined)
	const ollama = candidate()
	recordFleetInferenceDenials(ollama, {}, fleetPayload({ provider: "ollama" }), "job-1")
	assert.equal(ollama.inferenceDenials, undefined)
})
