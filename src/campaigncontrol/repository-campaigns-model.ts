export const REPOSITORY_CAMPAIGN_BUDGET_CAP_MICROS = 5_000_000
// Keep the mock subcap within Fleet's fixed 108k-token ceiling.
export const REPOSITORY_CAMPAIGN_BUDGET_CAP_TOKENS = 108_000
export const MAX_CAMPAIGNS = 32
export const MAX_JOBS = 500
export const MAX_INTAKE_RECORDS = 5_000
export const MAX_HISTORY = 200
export const MOCK_DISPATCH_TIMEOUT_MS = 30_000
export const REPOSITORY_WORKER_LEASE_MS = 120_000
export const REPOSITORY_PROGRESS_FRESH_MS = 60_000
export const REPOSITORY_CAMPAIGN_STEPS = [
	"intake",
	"deduplicate",
	"investigate",
	"prepare-candidate",
	"verify",
	"deliver",
] as const
export type RepositoryCampaignStep = typeof REPOSITORY_CAMPAIGN_STEPS[number]

export interface RepositoryEvidenceRef {
	id: string
	kind:
		| "intake"
		| "candidate"
		| "test-receipt"
		| "delivery"
		| "diagnostic"
		| "no-call-proof"
		| "billing-proof"
	label: string
}

export interface RepositoryJobProgress {
	executionKind: "development-checkpoint" | "live-cve"
	workerId: string
	goal: string
	currentTask: string
	stage: RepositoryCampaignStep
	completedSteps: RepositoryCampaignStep[]
	requiredSteps: RepositoryCampaignStep[]
	lastActionAt: number
	heartbeatAt: number
	leaseExpiresAt: number
	blocker: string | null
	nextStep: string | null
	evidenceRefs: RepositoryEvidenceRef[]
	/** Fixed local board ref, present after verified private delivery. */
	boardRef?: string | null
}

export const PRIVATE_BOARD_REF = new RegExp(
	"^http://127\\.0\\.0\\.1:8078/api/cards/" +
	"1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7" +
	"#hc-repository-result-v1:[a-f0-9]{64}$",
)

export interface RepositoryCampaignDefinition {
	id: string
	name: string
	repositoryId?: string
	repository?: string
	sourceRevision: string | null
	policySha256?: string
	workerProfile: string | null
	recipeDigest: string | null
	evaluatorDigest: string | null
	model: string | null
	dataAccessProfile: string | null
	qualification: {
		sourceAudited: boolean
		workerQualified: boolean
		recipeQualified: boolean
		evaluatorQualified: boolean
		modelApproved: boolean
		dataApproved: boolean
		accessApproved: boolean
	}
}

export interface RepositoryBudgetAuthority {
	mode:
		| "synthetic-test"
		| "fleet-v2"
		| "fleet-v2-readonly"
		| "fleet-v2-budget-only"
		| "unavailable"
	available: boolean
	snapshotOnly?: boolean
	limitMicros: number
	limitTokens: number
	committedMicros: number
	committedTokens: number
	/** Fresh authority projection fields are present only for mode=fleet-v2. */
	asOfMs?: number
	campaignId?: string
	globalEnabled?: boolean
	canAdmit?: boolean
	controlEpoch?: number
	runId?: string | null
	runExpiresAtMs?: number | null
	repositoryCampaignId?: string
	repositoryId?: string
	repository?: string
	sourceRevision?: string
	policySha256?: string
	model?: string
	profileId?: string
	repositoryEnabled?: boolean
	repositoryEpoch?: number
	monthly?: {
		month: string
		limitMicros: number
		settledMicros: number
		reservedMicros: number
		ambiguousMicros: number
	}
	campaignLifetime?: RepositoryUsageSnapshot & {
		limitTokens: number
		settledTokens: number
		reservedTokens: number
		ambiguousTokens: number
	}
	legacyLifetime?: RepositoryUsageCounters
	repositoryLifetime?: RepositoryUsageSnapshot & {
		limitTokens: number
		settledTokens: number
		reservedTokens: number
		ambiguousTokens: number
	}
}

interface RepositoryUsageCounters {
	settledMicros: number
	reservedMicros: number
	ambiguousMicros: number
	settledTokens: number
	reservedTokens: number
	ambiguousTokens: number
}

interface RepositoryUsageSnapshot extends RepositoryUsageCounters {
	limitMicros: number
}

export interface RepositoryCampaignJob {
	id: string
	campaignId: string
	advisoryId: string
	status:
		| "queued"
		| "running"
		| "cancelled"
		| "succeeded"
		| "failed"
		| "ambiguous"
	epoch: number
	createdAt: number
	updatedAt: number
	month: string
	claimId?: string
	reservedMicros: number
	settledMicros: number
	reservedTokens: number
	settledTokens: number
	progress?: RepositoryJobProgress
	detail?: string
	purpose?: "qualification" | "repair"
	/** Owner-authorized lineage for fixed Curl retry paths. */
	retryOf?: string
}

export type ObservedAdvisoryInput = {
	campaignId: string
	publicBaseRevision: string
	advisoryId: string
	snapshotSha256: string
	eligible: boolean
}
type RepositoryProgressUpdate = {
	stage: RepositoryCampaignStep
	currentTask: string
	completedSteps: RepositoryCampaignStep[]
	blocker?: string | null
	nextStep?: string | null
	evidenceRefs?: RepositoryEvidenceRef[]
	boardRef?: string | null
}
type RepositoryFinishProgress = {
	currentTask?: string
	blocker?: string | null
	nextStep?: string | null
	boardRef?: string | null
}
type RepositoryFinishResult = {
	status: "succeeded" | "failed" | "ambiguous"
	actualMicros?: number
	actualTokens?: number
	progress?: RepositoryFinishProgress
}
type RecoveredFinishResult = {
	status: "succeeded" | "failed"
	actualMicros: number
	actualTokens: number
	proofSha256?: string
	proofKind?: "no-call-proof" | "billing-proof"
}

export interface RepositoryAdvisoryIntakeRecord {
	campaignId: string
	publicBaseRevision: string
	advisoryId: string
	snapshotSha256: string
	disposition: "eligible" | "unsupported-profile"
	firstSeenAt: number
	lastSeenAt: number
	jobId: string | null
	source?:
		| "osv-commit-query"
		| "debian-tracker-snapshot"
		| "debian-tracker-repair-snapshot"
		| "debian-tracker-repair-v2-snapshot"
	sourceUrl?: string
	sourceContentSha256?: string
}

