import {
	REPOSITORY_PROGRESS_FRESH_MS,
	type RepositoryCampaignDefinition,
	type RepositoryCampaignJob,
	type RepositoryEvidenceRef,
} from "./repository-campaigns.js"

export type ProgressFreshness = "fresh" | "stale" | "unavailable"
export type ProgressState = "ready" | "running" | "waiting" | "stopping" | "stopped" |
	"budget-exhausted" | "blocked-prerequisite" | "blocked-access" | "failed" | "unavailable"

export interface FleetRepositoryBudgetSnapshot {
	mode: "fleet-v2" | "fleet-v2-readonly"; available: boolean; snapshotOnly?: boolean; limitMicros: number; limitTokens: number; committedMicros: number; committedTokens: number;
	asOfMs: number; campaignId: string; globalEnabled: boolean; canAdmit: boolean; controlEpoch: number; runId: string | null; runExpiresAtMs: number | null;
	repositoryCampaignId: string; repositoryId: string; repository: string; sourceRevision: string; policySha256: string;
	model: string; profileId: string; repositoryEnabled: boolean; repositoryEpoch: number;
	monthly: { month: string; limitMicros: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number };
	campaignLifetime: { limitMicros: number; limitTokens: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number };
	legacyLifetime: { settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number };
	repositoryLifetime: { limitMicros: number; limitTokens: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number };
}

export interface RepositoryProgressSnapshot {
	schemaVersion: 1
	campaignId: string
	executionKind: "development-checkpoint" | "live-cve" | "unavailable"
	observedAt: number
	repository: { id: string; name: string; slug: string | null }
	state: ProgressState
	readiness: { state: "ready" | "blocked-prerequisite" | "blocked-access" | "budget-exhausted" | "unavailable"; reasons: string[] }
	freshness: { state: ProgressFreshness; lastHeartbeatAt: number | null; leaseExpiresAt: number | null }
	budget: {
		source: "fleet-v2-ledger" | "unavailable"
		updatedAt: number | null
		state: "measured" | "unavailable"
		global: { limitMicros: number | null; limitTokens: number | null; committedMicros: number | null; committedTokens: number | null }
		monthly: { month: string | null; limitMicros: number | null; settledMicros: number | null; reservedMicros: number | null; ambiguousMicros: number | null }
		campaignLifetime: { limitMicros: number | null; limitTokens: number | null; settledMicros: number | null; reservedMicros: number | null; ambiguousMicros: number | null; settledTokens: number | null; reservedTokens: number | null; ambiguousTokens: number | null }
		legacyLifetime: { settledMicros: number | null; reservedMicros: number | null; ambiguousMicros: number | null; settledTokens: number | null; reservedTokens: number | null; ambiguousTokens: number | null }
		repositoryLifetime: { limitMicros: number | null; limitTokens: number | null; settledMicros: number | null; reservedMicros: number | null; ambiguousMicros: number | null; settledTokens: number | null; reservedTokens: number | null; ambiguousTokens: number | null }
		control: { campaignId: string | null; enabled: boolean | null; canAdmit: boolean | null; epoch: number | null; runId: string | null; runExpiresAtMs: number | null }
		repository: { id: string | null; slug: string | null; sourceRevision: string | null; policySha256: string | null; model: string | null; profileId: string | null; enabled: boolean | null; epoch: number | null }
	}
	workers: Array<{
		workerId: string
		jobId: string
		advisoryId: string
		executionKind: "development-checkpoint" | "live-cve"
		status: RepositoryCampaignJob["status"]
		stage: NonNullable<RepositoryCampaignJob["progress"]>["stage"]
		goal: string
		currentTask: string
		completedSteps: string[]
		requiredSteps: string[]
		lastActionAt: number
		heartbeatAt: number
		leaseExpiresAt: number
		blocker: string | null
		nextStep: string | null
		evidenceRefs: RepositoryEvidenceRef[]
		boardRef: string | null
		usage: {
			source: "repository-claim" | "fleet-v2-ledger" | "unavailable"
			state: "reserved" | "measured" | "ambiguous" | "unavailable"
			settledMicros: number | null
			reservedMicros: number | null
			ambiguousMicros: number | null
			settledTokens: number | null
			reservedTokens: number | null
			ambiguousTokens: number | null
		}
	}>
	counts: {
		source: "repository-campaign-store" | "unavailable"
		queued: number | null
		running: number | null
		blocked: number | null
		completed: number | null
		failed: number | null
		ambiguous: number | null
	}
}

export interface RepositoryRuntimeReadiness {
	state: "ready" | "blocked-prerequisite" | "blocked-access"
	reasons: string[]
}

function readinessState(campaign: Record<string, unknown>): RepositoryProgressSnapshot["readiness"]["state"] {
	const value = campaign.readiness
	if (value === "ready" || value === "blocked-prerequisite" || value === "blocked-access" || value === "budget-exhausted") return value
	return "unavailable"
}

function campaignState(value: unknown): ProgressState {
	if (["ready", "running", "waiting", "stopped", "budget-exhausted", "blocked-prerequisite", "blocked-access"].includes(String(value))) {
		return value as ProgressState
	}
	return "unavailable"
}

function usage(job: RepositoryCampaignJob): RepositoryProgressSnapshot["workers"][number]["usage"] {
	if (job.progress?.executionKind !== "live-cve") return {
		source: "unavailable", state: "unavailable", settledMicros: null, reservedMicros: null,
		ambiguousMicros: null, settledTokens: null, reservedTokens: null, ambiguousTokens: null,
	}
	if (job.status === "ambiguous") return {
		source: "repository-claim", state: "ambiguous", settledMicros: job.settledMicros,
		reservedMicros: 0, ambiguousMicros: job.settledMicros, settledTokens: job.settledTokens,
		reservedTokens: 0, ambiguousTokens: job.settledTokens,
	}
	if (job.status === "running") return {
		source: "repository-claim", state: "reserved", settledMicros: 0,
		reservedMicros: job.reservedMicros, ambiguousMicros: 0, settledTokens: 0,
		reservedTokens: job.reservedTokens, ambiguousTokens: 0,
	}
	if (job.status === "succeeded" || job.status === "failed") return {
		source: "repository-claim", state: "measured", settledMicros: job.settledMicros,
		reservedMicros: 0, ambiguousMicros: 0, settledTokens: job.settledTokens,
		reservedTokens: 0, ambiguousTokens: 0,
	}
	return { source: "unavailable", state: "unavailable", settledMicros: null, reservedMicros: null,
		ambiguousMicros: null, settledTokens: null, reservedTokens: null, ambiguousTokens: null }
}

function budgetIsFresh(definition: RepositoryCampaignDefinition, budget: FleetRepositoryBudgetSnapshot | undefined, observedAt: number): boolean {
	if (!budget || !snapshotModeValid(budget) || !snapshotTimeValid(budget.asOfMs, observedAt) || !snapshotRunValid(budget, observedAt)) return false
	return snapshotIdentityValid(definition, budget)
}

function snapshotModeValid(budget: FleetRepositoryBudgetSnapshot): boolean {
	return budget.mode === "fleet-v2" ? budget.available && !budget.snapshotOnly : budget.snapshotOnly === true
}
function snapshotTimeValid(asOfMs: number, observedAt: number): boolean {
	return Number.isSafeInteger(asOfMs) && observedAt - asOfMs <= REPOSITORY_PROGRESS_FRESH_MS && asOfMs <= observedAt + REPOSITORY_PROGRESS_FRESH_MS
}
function snapshotRunValid(budget: FleetRepositoryBudgetSnapshot, observedAt: number): boolean {
	return budget.mode === "fleet-v2-readonly" ? budget.runId === null && budget.runExpiresAtMs === null :
		budget.runExpiresAtMs !== null && budget.runExpiresAtMs > observedAt
}
function snapshotIdentityValid(definition: RepositoryCampaignDefinition, budget: FleetRepositoryBudgetSnapshot): boolean {
	return budget.repositoryCampaignId === definition.id && budget.repositoryId === definition.repositoryId && budget.repository === definition.repository &&
		budget.sourceRevision === definition.sourceRevision && budget.policySha256 === definition.policySha256 && budget.model === definition.model &&
		budget.profileId === definition.workerProfile && /^[a-f0-9]{64}$/.test(budget.policySha256)
}

function freshnessFor(jobs: RepositoryCampaignJob[], observedAt: number): RepositoryProgressSnapshot["freshness"] {
	const active = jobs.filter((job) => job.status === "running" && job.progress)
	const unknownActive = jobs.some((job) => job.status === "running" && !job.progress)
	const lastHeartbeatAt = active.length ? Math.max(...active.map((job) => job.progress!.heartbeatAt)) : null
	const leaseExpiresAt = active.length ? Math.min(...active.map((job) => job.progress!.leaseExpiresAt)) : null
	const stale = active.some((job) => observedAt - job.progress!.heartbeatAt > REPOSITORY_PROGRESS_FRESH_MS || observedAt > job.progress!.leaseExpiresAt)
	return { state: unknownActive ? "unavailable" : stale ? "stale" : "fresh", lastHeartbeatAt, leaseExpiresAt }
}

function countsFor(jobs: RepositoryCampaignJob[], freshness: ProgressFreshness): RepositoryProgressSnapshot["counts"] {
	const fresh = freshness === "fresh"
	return {
		source: fresh ? "repository-campaign-store" : "unavailable",
		queued: fresh ? jobs.filter((job) => job.status === "queued").length : null,
		running: fresh ? jobs.filter((job) => job.status === "running" && job.progress).length : null,
		blocked: fresh ? jobs.filter((job) => job.progress?.blocker !== null && job.progress?.blocker !== undefined).length : null,
		completed: fresh ? jobs.filter((job) => job.status === "succeeded").length : null,
		failed: fresh ? jobs.filter((job) => job.status === "failed").length : null,
		ambiguous: fresh ? jobs.filter((job) => job.status === "ambiguous").length : null,
	}
}

function workersFor(jobs: RepositoryCampaignJob[]): RepositoryProgressSnapshot["workers"] {
	return jobs.flatMap((job) => job.progress ? [{ workerId: job.progress.workerId, jobId: job.id, advisoryId: job.advisoryId,
		executionKind: job.progress.executionKind, status: job.status, stage: job.progress.stage, goal: job.progress.goal,
		currentTask: job.progress.currentTask, completedSteps: [...job.progress.completedSteps], requiredSteps: [...job.progress.requiredSteps],
		lastActionAt: job.progress.lastActionAt, heartbeatAt: job.progress.heartbeatAt, leaseExpiresAt: job.progress.leaseExpiresAt,
		blocker: job.progress.blocker, nextStep: job.progress.nextStep, evidenceRefs: structuredClone(job.progress.evidenceRefs),
		boardRef: job.progress.boardRef ?? null, usage: usage(job) }] : [])
}

function executionKind(liveJobs: RepositoryCampaignJob[], developmentJobs: RepositoryCampaignJob[]): RepositoryProgressSnapshot["executionKind"] {
	if (liveJobs.length && developmentJobs.length) return "unavailable"
	if (liveJobs.length) return "live-cve"
	return developmentJobs.length ? "development-checkpoint" : "unavailable"
}

function resolveReadiness(campaign: Record<string, unknown>, override?: RepositoryRuntimeReadiness): {
	state: RepositoryProgressSnapshot["readiness"]["state"]; reasons: string[]
} {
	const reasons = Array.isArray(campaign.readinessReasons) ? campaign.readinessReasons.filter((x): x is string => typeof x === "string") : []
	if (override && override.state !== "ready") reasons.push(...override.reasons)
	return { state: override && override.state !== "ready" ? override.state : readinessState(campaign), reasons }
}

function budgetView(definition: RepositoryCampaignDefinition, budget: FleetRepositoryBudgetSnapshot | undefined, observedAt: number): RepositoryProgressSnapshot["budget"] {
	if (budget && budgetIsFresh(definition, budget, observedAt)) return {
		source: "fleet-v2-ledger", updatedAt: budget.asOfMs, state: "measured",
		global: { limitMicros: budget.limitMicros, limitTokens: budget.limitTokens, committedMicros: budget.committedMicros, committedTokens: budget.committedTokens },
		monthly: { ...budget.monthly }, campaignLifetime: { ...budget.campaignLifetime }, legacyLifetime: { ...budget.legacyLifetime },
		repositoryLifetime: { ...budget.repositoryLifetime },
		control: { campaignId: budget.campaignId, enabled: budget.globalEnabled, canAdmit: budget.canAdmit,
			epoch: budget.controlEpoch, runId: budget.runId, runExpiresAtMs: budget.runExpiresAtMs },
		repository: { id: budget.repositoryId, slug: budget.repository, sourceRevision: budget.sourceRevision,
			policySha256: budget.policySha256, model: budget.model, profileId: budget.profileId,
			enabled: budget.repositoryEnabled, epoch: budget.repositoryEpoch },
	}
	const nullCampaign = { limitMicros: null, limitTokens: null, settledMicros: null, reservedMicros: null, ambiguousMicros: null, settledTokens: null, reservedTokens: null, ambiguousTokens: null }
	const nullLifetime = { settledMicros: null, reservedMicros: null, ambiguousMicros: null, settledTokens: null, reservedTokens: null, ambiguousTokens: null }
	return {
		source: "unavailable", updatedAt: null, state: "unavailable",
		global: { limitMicros: null, limitTokens: null, committedMicros: null, committedTokens: null },
		monthly: { month: null, limitMicros: null, settledMicros: null, reservedMicros: null, ambiguousMicros: null },
		campaignLifetime: { ...nullCampaign }, legacyLifetime: { ...nullLifetime }, repositoryLifetime: { ...nullCampaign },
		control: { campaignId: null, enabled: null, canAdmit: null, epoch: null, runId: null, runExpiresAtMs: null },
		repository: { id: null, slug: null, sourceRevision: null, policySha256: null, model: null, profileId: null, enabled: null, epoch: null },
	}
}

export function repositoryProgressSnapshot(
	definition: RepositoryCampaignDefinition,
	campaign: Record<string, unknown>,
	jobs: RepositoryCampaignJob[],
	observedAt = Date.now(),
	options: { fleetBudget?: FleetRepositoryBudgetSnapshot; runtimeReadiness?: RepositoryRuntimeReadiness } = {},
): RepositoryProgressSnapshot {
	const liveJobs = jobs.filter((job) => job.progress?.executionKind === "live-cve")
	const developmentJobs = jobs.filter((job) => job.progress?.executionKind === "development-checkpoint")
	const visibleJobs = [...liveJobs, ...developmentJobs].slice(-100)
	const freshness = freshnessFor(jobs, observedAt)
	const resolved = resolveReadiness(campaign, options.runtimeReadiness)
	return {
		schemaVersion: 1,
		campaignId: definition.id,
		executionKind: executionKind(liveJobs, developmentJobs),
		observedAt,
		repository: { id: definition.id, name: definition.name, slug: definition.repository ?? null },
		state: resolved.state === "blocked-prerequisite" || resolved.state === "blocked-access" ? resolved.state : campaignState(campaign.state),
		readiness: { state: resolved.state, reasons: [...new Set(resolved.reasons)].slice(0, 32) },
		freshness,
		budget: budgetView(definition, options.fleetBudget, observedAt),
		workers: workersFor(visibleJobs),
		counts: countsFor(visibleJobs, freshness.state),
	}
}
