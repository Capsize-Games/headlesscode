/**
 * Fleet replay of registered curriculum fixtures for the RSI
 * controller (issue #126). Replays each proposal's ground-truth
 * command as an idempotent supervised evaluation job.
 */
import {
	fleetEvaluationResult,
	fleetPayload,
	fleetRuntimeDeadlineMs,
	waitForFleetJob,
} from "./controller-fleet.js"
import {
	validateCurriculumProposals,
	type CurriculumReplayResult,
} from "./curriculum.js"
import type { EvaluatorRuntimeIdentity } from "./evaluator-runtime.js"
import { createEvaluationSnapshotBundle } from "./openshell.js"
import {
	fleetJobMatches,
	requiredFleetJobLeaseMs,
	type FleetJob,
	type FleetJobIdentity,
	type FleetJobPayload,
	type PostgresRsiJobQueue,
} from "./postgres-queue.js"
import type {
	CandidateRecord,
	CurriculumTask,
	RsiConfig,
	RsiRunRecord,
} from "./types.js"

export type EvaluatorId = Pick<
	EvaluatorRuntimeIdentity,
	"imageDigest" | "policySha256"
>

interface ReplayScope {
	run: RsiRunRecord
	config: RsiConfig
	task: CurriculumTask
}

function replayCandidateFor(
	scope: ReplayScope,
	attempt: 1 | 2,
	now: () => string,
): CandidateRecord {
	const { run, config, task } = scope
	return {
		id: `${task.fixtureId}-replay-${attempt}`,
		generation: 0, parent: run.baseCommit,
		branch: `curriculum-${task.fixtureId}`,
		worktree: config.repoRoot,
		baseCommit: run.baseCommit,
		status: "evaluating", model: config.model,
		mutation: task.task,
		createdAt: now(), updatedAt: now(),
		commits: [],
		changedFiles: [],
		protectedPathViolations: [],
	}
}

function replayPayloadFor(
	scope: ReplayScope,
	replayCandidate: CandidateRecord,
	snapshot: { content: Buffer; snapshotCommit: string },
	evaluatorRuntime: EvaluatorId,
	artifactSha256: string,
): FleetJobPayload {
	const { config, task } = scope
	const payload = fleetPayload(config, replayCandidate, snapshot,
		{ evaluatorRuntime })
	payload.snapshotSha256 = artifactSha256
	payload.task = `Replay registered curriculum fixture ${task.fixtureId}`
	payload.regressionCommand = "true"
	payload.evalCommands = [task.groundTruthCommand]
	return payload
}

function replayExpectedFor(
	scope: ReplayScope,
	replayCandidate: CandidateRecord,
	artifactSha256: string,
	payload: FleetJobPayload,
	idempotencyKey: string,
): FleetJobIdentity {
	return {
		idempotencyKey,
		runId: scope.run.runId,
		candidateId: replayCandidate.id,
		jobKind: "evaluation",
		resourceClass: "CPU",
		concurrencyKey: `curriculum:${scope.task.fixtureId}`,
		artifactSha256,
		payload,
	}
}

async function loadOrEnqueueReplayJob(
	queue: PostgresRsiJobQueue,
	scope: ReplayScope,
	replayCandidate: CandidateRecord,
	expected: FleetJobIdentity,
): Promise<FleetJob> {
	const job = await queue.getJobByIdempotencyKey(expected.idempotencyKey)
	if (job) return job
	return queue.enqueue({
		idempotencyKey: expected.idempotencyKey,
		runId: scope.run.runId,
		candidateId: replayCandidate.id,
		jobKind: "evaluation",
		resourceClass: "CPU",
		concurrencyKey: expected.concurrencyKey,
		artifactSha256: expected.artifactSha256,
		payload: expected.payload,
	})
}

function replayFailed(failure: string): CurriculumReplayResult {
	return { ok: false, exitCode: null, failure }
}

function readReplayTrial(completed: FleetJob): CurriculumReplayResult {
	try {
		const evaluation = fleetEvaluationResult(completed.result)
		const trial = evaluation.visible[0]
		if (!trial) {
			return replayFailed("OpenShell curriculum replay returned no fixture trial")
		}
		return {
			ok: trial.ok,
			exitCode: trial.exitCode,
			outputSha256: trial.outputArtifactSha256,
			...(!trial.ok
				? { failure: `fixture command exited ${trial.exitCode ?? "unknown"}` }
				: {}),
		}
	} catch (error) {
		return replayFailed(error instanceof Error ? error.message : String(error))
	}
}

interface ReplayAttempt {
	queue: PostgresRsiJobQueue
	config: RsiConfig
	run: RsiRunRecord
	task: CurriculumTask
	attempt: 1 | 2
	replayKey: string
	now: () => string
	evaluatorRuntime: EvaluatorId
}

async function awaitReplayCompletion(
	queue: PostgresRsiJobQueue, config: RsiConfig,
	run: RsiRunRecord, job: FleetJob,
): Promise<FleetJob> {
	const leaseMs = requiredFleetJobLeaseMs("evaluation",
		config.commandTimeoutMs, 1) + 60_000
	return waitForFleetJob(queue, job.jobId, leaseMs,
		fleetRuntimeDeadlineMs(config, run))
}

async function settleReplayJob(
	queue: PostgresRsiJobQueue, config: RsiConfig,
	run: RsiRunRecord, job: FleetJob,
	expected: FleetJobIdentity,
): Promise<CurriculumReplayResult> {
	if (!fleetJobMatches(job, expected)) {
		return replayFailed("idempotent curriculum replay key refers"
			+ " to a stale or mismatched fleet job payload")
	}
	const completed = await awaitReplayCompletion(queue, config, run, job)
	const ended = completed.status !== "completed" || !completed.result
		|| typeof completed.result !== "object"
	if (ended) {
		return replayFailed(completed.error
			?? `OpenShell curriculum replay ended ${completed.status}`)
	}
	return readReplayTrial(completed)
}

async function runReplayAttempt(
	args: ReplayAttempt,
): Promise<CurriculumReplayResult> {
	const { queue, config, run, task, attempt, replayKey } = args
	const { now, evaluatorRuntime } = args
	const scope = { run, config, task }
	const replayCandidate = replayCandidateFor(scope, attempt, now)
	const idempotencyKey = `${run.runId}:${replayKey}`
	const snapshot = createEvaluationSnapshotBundle(config.repoRoot,
		run.baseCommit, config)
	const artifact = await queue.putArtifact(snapshot.content)
	const payload = replayPayloadFor(scope, replayCandidate, snapshot,
		evaluatorRuntime, artifact.sha256)
	const expected = replayExpectedFor(scope, replayCandidate,
		artifact.sha256, payload, idempotencyKey)
	const job = await loadOrEnqueueReplayJob(queue, scope, replayCandidate,
		expected)
	return settleReplayJob(queue, config, run, job, expected)
}

export interface FleetCurriculumValidation {
	tasks: RsiRunRecord["curriculumTasks"]
	config: RsiConfig
	run: RsiRunRecord
	queue: PostgresRsiJobQueue
	now: () => string
	evaluatorRuntime: EvaluatorId
}

export async function validateCurriculumOnFleet(
	args: FleetCurriculumValidation,
): Promise<NonNullable<RsiRunRecord["curriculumTasks"]>> {
	const { tasks, config, run, queue, now, evaluatorRuntime } = args
	if (!tasks?.length) return []
	const attemptLabel = (
		task: CurriculumTask, attempt: 1 | 2, replayKey: string,
	): Promise<CurriculumReplayResult> => runReplayAttempt({
		queue, config, run, task, attempt, replayKey, now, evaluatorRuntime,
	})
	return validateCurriculumProposals(tasks, run.baseCommit, attemptLabel, now())
}
