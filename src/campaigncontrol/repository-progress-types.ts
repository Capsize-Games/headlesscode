import type {
	RepositoryCampaignJob,
	RepositoryEvidenceRef,
} from "./repository-campaigns.js"
import type {
	FleetRepositoryBudgetSnapshot as LedgerBudgetSnapshot,
} from "../rsi/fleet-repository-budget-ledger.js"

export type ProgressFreshness = "fresh" | "stale" | "unavailable"
export type ProgressState =
	| "ready"
	| "running"
	| "waiting"
	| "stopping"
	| "stopped"
	| "budget-exhausted"
	| "blocked-prerequisite"
	| "blocked-access"
	| "failed"
	| "unavailable"

export type FleetRepositoryBudgetSnapshot =
	Omit<LedgerBudgetSnapshot, "mode"> & {
	mode: LedgerBudgetSnapshot["mode"] |
		"fleet-v2-budget-only"
}

export interface RepositoryProgressBudget {
	source: "fleet-v2-ledger" | "unavailable"
	updatedAt: number | null
	state: "measured" | "unavailable"
	global: {
		limitMicros: number | null
		limitTokens: number | null
		committedMicros: number | null
		committedTokens: number | null
	}
	monthly: {
		month: string | null
		limitMicros: number | null
		settledMicros: number | null
		reservedMicros: number | null
		ambiguousMicros: number | null
	}
	campaignLifetime: RepositoryProgressLifetime
	legacyLifetime: RepositoryProgressUsage
	repositoryLifetime: RepositoryProgressLifetime
	control: {
		campaignId: string | null
		enabled: boolean | null
		canAdmit: boolean | null
		epoch: number | null
		runId: string | null
		runExpiresAtMs: number | null
	}
	repository: {
		id: string | null
		slug: string | null
		sourceRevision: string | null
		policySha256: string | null
		model: string | null
		profileId: string | null
		enabled: boolean | null
		epoch: number | null
	}
}

export interface RepositoryProgressUsage {
	settledMicros: number | null
	reservedMicros: number | null
	ambiguousMicros: number | null
	settledTokens: number | null
	reservedTokens: number | null
	ambiguousTokens: number | null
}

export interface RepositoryProgressLifetime extends RepositoryProgressUsage {
	limitMicros: number | null
	limitTokens: number | null
}

export interface RepositoryProgressWorker {
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
	usage: RepositoryProgressWorkerUsage
}

export interface RepositoryProgressWorkerUsage extends RepositoryProgressUsage {
	source: "repository-claim" | "fleet-v2-ledger" | "unavailable"
	state: "reserved" | "measured" | "ambiguous" | "unavailable"
}

export interface RepositoryProgressCounts {
	source: "repository-campaign-store" | "unavailable"
	queued: number | null
	running: number | null
	blocked: number | null
	completed: number | null
	failed: number | null
	ambiguous: number | null
}

export interface RepositoryProgressSnapshot {
	schemaVersion: 1
	campaignId: string
	executionKind: "development-checkpoint" | "live-cve" | "unavailable"
	observedAt: number
	repository: { id: string; name: string; slug: string | null }
	state: ProgressState
	readiness: {
		state:
			| "ready"
			| "blocked-prerequisite"
			| "blocked-access"
			| "budget-exhausted"
			| "unavailable"
		reasons: string[]
	}
	freshness: {
		state: ProgressFreshness
		lastHeartbeatAt: number | null
		leaseExpiresAt: number | null
	}
	budget: RepositoryProgressBudget
	workers: RepositoryProgressWorker[]
	counts: RepositoryProgressCounts
}

export interface RepositoryRuntimeReadiness {
	state: "ready" | "blocked-prerequisite" | "blocked-access"
	reasons: string[]
}
