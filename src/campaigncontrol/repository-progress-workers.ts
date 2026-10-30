import { REPOSITORY_PROGRESS_FRESH_MS } from "./repository-campaigns.js"
import type { RepositoryCampaignJob } from "./repository-campaigns.js"
import type {
	ProgressFreshness,
	RepositoryProgressCounts,
	RepositoryProgressSnapshot,
	RepositoryProgressWorker,
	RepositoryProgressWorkerUsage,
} from "./repository-progress-types.js"

export function repositoryProgressFreshness(
	jobs: RepositoryCampaignJob[],
	observedAt: number,
): RepositoryProgressSnapshot["freshness"] {
	const active = jobs.filter(isTrackedRunningJob)
	const unknownActive = jobs.some(isUntrackedRunningJob)
	const heartbeatTimes = active.map((job) => job.progress!.heartbeatAt)
	const leaseTimes = active.map((job) => job.progress!.leaseExpiresAt)
	const stale = active.some((job) => jobIsStale(job, observedAt))
	return {
		state: freshnessState(unknownActive, stale),
		lastHeartbeatAt: latestHeartbeat(heartbeatTimes),
		leaseExpiresAt: earliestLease(leaseTimes),
	}
}

function isTrackedRunningJob(job: RepositoryCampaignJob): boolean {
	return job.status === "running" && job.progress !== undefined
}

function isUntrackedRunningJob(job: RepositoryCampaignJob): boolean {
	return job.status === "running" && job.progress === undefined
}

function jobIsStale(job: RepositoryCampaignJob, observedAt: number): boolean {
	const progress = job.progress!
	return observedAt - progress.heartbeatAt > REPOSITORY_PROGRESS_FRESH_MS ||
		observedAt > progress.leaseExpiresAt
}

function freshnessState(unknown: boolean, stale: boolean): ProgressFreshness {
	if (unknown) return "unavailable"
	return stale ? "stale" : "fresh"
}

function latestHeartbeat(values: number[]): number | null {
	return values.length ? Math.max(...values) : null
}

function earliestLease(values: number[]): number | null {
	return values.length ? Math.min(...values) : null
}

export function repositoryProgressCounts(
	jobs: RepositoryCampaignJob[],
	freshness: ProgressFreshness,
): RepositoryProgressCounts {
	if (freshness !== "fresh") return unavailableCounts()
	return {
		source: "repository-campaign-store",
		queued: count(jobs, (job) => job.status === "queued"),
		running: count(jobs, isTrackedRunningJob),
		blocked: count(jobs, (job) => job.progress?.blocker != null),
		completed: count(jobs, (job) => job.status === "succeeded"),
		failed: count(jobs, (job) => job.status === "failed"),
		ambiguous: count(jobs, (job) => job.status === "ambiguous"),
	}
}

function count(
	jobs: RepositoryCampaignJob[],
	predicate: (job: RepositoryCampaignJob) => boolean,
): number {
	return jobs.filter(predicate).length
}

function unavailableCounts(): RepositoryProgressCounts {
	return {
		source: "unavailable",
		queued: null,
		running: null,
		blocked: null,
		completed: null,
		failed: null,
		ambiguous: null,
	}
}

export function repositoryProgressWorkers(
	jobs: RepositoryCampaignJob[],
): RepositoryProgressWorker[] {
	return jobs.flatMap((job) => {
		if (!job.progress) return []
		return [workerView(job)]
	})
}

function workerView(
	job: RepositoryCampaignJob,
): RepositoryProgressWorker {
	const progress = job.progress!
	return {
		...workerIdentity(job, progress),
		...workerSteps(progress),
		...workerTimeline(progress),
		...workerEvidence(progress),
		usage: workerUsage(job),
	}
}

function workerIdentity(
	job: RepositoryCampaignJob,
	progress: NonNullable<RepositoryCampaignJob["progress"]>,
): WorkerIdentity {
	return {
		workerId: progress.workerId,
		jobId: job.id,
		advisoryId: job.advisoryId,
		executionKind: progress.executionKind,
		status: job.status,
		stage: progress.stage,
		goal: progress.goal,
		currentTask: progress.currentTask,
	}
}

type WorkerIdentity = Pick<
	RepositoryProgressWorker,
	| "workerId"
	| "jobId"
	| "advisoryId"
	| "executionKind"
	| "status"
	| "stage"
	| "goal"
	| "currentTask"
>

function workerSteps(
	progress: NonNullable<RepositoryCampaignJob["progress"]>,
): Pick<RepositoryProgressWorker, "completedSteps" | "requiredSteps"> {
	return {
		completedSteps: [...progress.completedSteps],
		requiredSteps: [...progress.requiredSteps],
	}
}

function workerTimeline(
	progress: NonNullable<RepositoryCampaignJob["progress"]>,
): Pick<RepositoryProgressWorker,
	"lastActionAt" | "heartbeatAt" | "leaseExpiresAt" | "blocker" | "nextStep"> {
	return {
		lastActionAt: progress.lastActionAt,
		heartbeatAt: progress.heartbeatAt,
		leaseExpiresAt: progress.leaseExpiresAt,
		blocker: progress.blocker,
		nextStep: progress.nextStep,
	}
}

function workerEvidence(
	progress: NonNullable<RepositoryCampaignJob["progress"]>,
): Pick<RepositoryProgressWorker, "evidenceRefs" | "boardRef"> {
	return {
		evidenceRefs: structuredClone(progress.evidenceRefs),
		boardRef: progress.boardRef ?? null,
	}
}

function workerUsage(
	job: RepositoryCampaignJob,
): RepositoryProgressWorkerUsage {
	const state = usageState(job)
	return state ? usageValues(job, state) : noUsage()
}

function usageState(
	job: RepositoryCampaignJob,
): "reserved" | "measured" | "ambiguous" | null {
	if (job.progress?.executionKind !== "live-cve") return null
	if (job.status === "ambiguous") return "ambiguous"
	if (job.status === "running") return "reserved"
	if (job.status === "succeeded" || job.status === "failed") return "measured"
	return null
}

function usageValues(
	job: RepositoryCampaignJob,
	state: "reserved" | "measured" | "ambiguous",
): RepositoryProgressWorkerUsage {
	const running = state === "reserved"
	const uncertain = state === "ambiguous"
	return {
		source: "repository-claim",
		state,
		settledMicros: running ? 0 : job.settledMicros,
		reservedMicros: running ? job.reservedMicros : 0,
		ambiguousMicros: uncertain ? job.settledMicros : 0,
		settledTokens: running ? 0 : job.settledTokens,
		reservedTokens: running ? job.reservedTokens : 0,
		ambiguousTokens: uncertain ? job.settledTokens : 0,
	}
}

function noUsage(): RepositoryProgressWorkerUsage {
	return {
		source: "unavailable",
		state: "unavailable",
		settledMicros: null,
		reservedMicros: null,
		ambiguousMicros: null,
		settledTokens: null,
		reservedTokens: null,
		ambiguousTokens: null,
	}
}
