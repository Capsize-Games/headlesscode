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
	mode: "fleet-v2"; available: boolean; limitMicros: number; limitTokens: number; committedMicros: number; committedTokens: number;
	asOfMs: number; campaignId: string; globalEnabled: boolean; canAdmit: boolean; controlEpoch: number; runId: string; runExpiresAtMs: number;
	repositoryCampaignId: string; repositoryId: string; repository: string; sourceRevision: string; policySha256: string;
	model: string; profileId: string; repositoryEnabled: boolean; repositoryEpoch: number;
	monthly: { month: string; limitMicros: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number };
	campaignLifetime: { limitMicros: number; limitTokens: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number };
	legacyLifetime: { settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number };
	repositoryLifetime: { limitMicros: number; limitTokens: number; settledMicros: number; reservedMicros: number; ambiguousMicros: number; settledTokens: number; reservedTokens: number; ambiguousTokens: number };
}

export interface RepositoryProgressSnapshot {
	schemaVersion: 1
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

export function repositoryProgressSnapshot(
	definition: RepositoryCampaignDefinition,
	campaign: Record<string, unknown>,
	jobs: RepositoryCampaignJob[],
	observedAt = Date.now(),
	fleetBudget?: FleetRepositoryBudgetSnapshot,
): RepositoryProgressSnapshot {
	const liveJobs = jobs.filter((job) => job.progress?.executionKind === "live-cve")
	const developmentJobs = jobs.filter((job) => job.progress?.executionKind === "development-checkpoint")
	const visibleJobs = [...liveJobs, ...developmentJobs].slice(-100)
	const active = visibleJobs.filter((job) => job.status === "running")
	const unknownActive = jobs.some((job) => job.status === "running" && !job.progress)
	const lastHeartbeat = active.length ? Math.max(...active.map((job) => job.progress!.heartbeatAt)) : null
	const leaseExpiry = active.length ? Math.min(...active.map((job) => job.progress!.leaseExpiresAt)) : null
	const freshness: ProgressFreshness = unknownActive ? "unavailable" : active.length === 0 ? "fresh" : active.some((job) =>
		observedAt - job.progress!.heartbeatAt > REPOSITORY_PROGRESS_FRESH_MS || observedAt > job.progress!.leaseExpiresAt) ? "stale" : "fresh"
	const budgetFresh = Boolean(fleetBudget && fleetBudget.mode === "fleet-v2" && fleetBudget.available &&
		Number.isSafeInteger(fleetBudget.asOfMs) && observedAt - fleetBudget.asOfMs <= REPOSITORY_PROGRESS_FRESH_MS &&
		fleetBudget.asOfMs <= observedAt + REPOSITORY_PROGRESS_FRESH_MS && fleetBudget.runExpiresAtMs > observedAt &&
		definition.repositoryId !== undefined && definition.repository !== undefined &&
		fleetBudget.repositoryCampaignId === definition.id && fleetBudget.repositoryId === definition.repositoryId &&
		fleetBudget.repository === definition.repository &&
		fleetBudget.sourceRevision === definition.sourceRevision && fleetBudget.model === definition.model &&
		fleetBudget.profileId === definition.workerProfile && /^[a-f0-9]{64}$/.test(fleetBudget.policySha256));
	const nullCampaign = { limitMicros: null, limitTokens: null, settledMicros: null, reservedMicros: null, ambiguousMicros: null, settledTokens: null, reservedTokens: null, ambiguousTokens: null }
	const nullLifetime = { settledMicros: null, reservedMicros: null, ambiguousMicros: null, settledTokens: null, reservedTokens: null, ambiguousTokens: null }
	const freshCounts = freshness === "fresh"
	const counts: RepositoryProgressSnapshot["counts"] = {
		source: freshCounts ? "repository-campaign-store" : "unavailable",
		queued: freshCounts ? visibleJobs.filter((job) => job.status === "queued").length : null,
		running: freshCounts ? active.length : null,
		blocked: freshCounts ? visibleJobs.filter((job) => job.progress?.blocker !== null && job.progress?.blocker !== undefined).length : null,
		completed: freshCounts ? visibleJobs.filter((job) => job.status === "succeeded").length : null,
		failed: freshCounts ? visibleJobs.filter((job) => job.status === "failed").length : null,
		ambiguous: freshCounts ? visibleJobs.filter((job) => job.status === "ambiguous").length : null,
	}
	return {
		schemaVersion: 1,
		executionKind: liveJobs.length && developmentJobs.length ? "unavailable" : liveJobs.length ? "live-cve" : developmentJobs.length ? "development-checkpoint" : "unavailable",
		observedAt,
		repository: { id: definition.id, name: definition.name, slug: definition.repository ?? null },
		state: campaignState(campaign.state),
		readiness: { state: readinessState(campaign), reasons: Array.isArray(campaign.readinessReasons) ? campaign.readinessReasons.filter((x): x is string => typeof x === "string") : [] },
		freshness: { state: freshness, lastHeartbeatAt: lastHeartbeat, leaseExpiresAt: leaseExpiry },
		budget: budgetFresh ? {
			source: "fleet-v2-ledger", updatedAt: fleetBudget!.asOfMs, state: "measured",
			global: { limitMicros: fleetBudget!.limitMicros, limitTokens: fleetBudget!.limitTokens, committedMicros: fleetBudget!.committedMicros, committedTokens: fleetBudget!.committedTokens },
			monthly: { ...fleetBudget!.monthly }, campaignLifetime: { ...fleetBudget!.campaignLifetime },
			legacyLifetime: { ...fleetBudget!.legacyLifetime }, repositoryLifetime: { ...fleetBudget!.repositoryLifetime },
			control: { campaignId: fleetBudget!.campaignId, enabled: fleetBudget!.globalEnabled, canAdmit: fleetBudget!.canAdmit,
				epoch: fleetBudget!.controlEpoch, runId: fleetBudget!.runId, runExpiresAtMs: fleetBudget!.runExpiresAtMs },
			repository: { id: fleetBudget!.repositoryId, slug: fleetBudget!.repository, sourceRevision: fleetBudget!.sourceRevision,
				policySha256: fleetBudget!.policySha256, model: fleetBudget!.model, profileId: fleetBudget!.profileId,
				enabled: fleetBudget!.repositoryEnabled, epoch: fleetBudget!.repositoryEpoch },
		} : {
			source: "unavailable", updatedAt: null, state: "unavailable",
			global: { limitMicros: null, limitTokens: null, committedMicros: null, committedTokens: null },
			monthly: { month: null, limitMicros: null, settledMicros: null, reservedMicros: null, ambiguousMicros: null },
			campaignLifetime: { ...nullCampaign }, legacyLifetime: { ...nullLifetime }, repositoryLifetime: { ...nullCampaign },
			control: { campaignId: null, enabled: null, canAdmit: null, epoch: null, runId: null, runExpiresAtMs: null },
			repository: { id: null, slug: null, sourceRevision: null, policySha256: null, model: null, profileId: null, enabled: null, epoch: null },
		},
		workers: visibleJobs.flatMap((job) => job.progress ? [{ workerId: job.progress.workerId, jobId: job.id, advisoryId: job.advisoryId,
			executionKind: job.progress.executionKind, status: job.status, stage: job.progress.stage, goal: job.progress.goal,
			currentTask: job.progress.currentTask, completedSteps: [...job.progress.completedSteps], requiredSteps: [...job.progress.requiredSteps],
			lastActionAt: job.progress.lastActionAt, heartbeatAt: job.progress.heartbeatAt, leaseExpiresAt: job.progress.leaseExpiresAt,
			blocker: job.progress.blocker, nextStep: job.progress.nextStep, evidenceRefs: structuredClone(job.progress.evidenceRefs), usage: usage(job) }] : []),
		counts,
	}
}
