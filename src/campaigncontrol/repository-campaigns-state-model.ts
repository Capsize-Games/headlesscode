import type {
	RepositoryAdvisoryIntakeRecord,
	RepositoryCampaignJob,
} from "./repository-campaigns-model.js"

export interface CampaignRecord {
	enabled: boolean
	epoch: number
	budgetLimitMicros: number
	budgetLimitTokens: number
	settledMicros: number
	reservedMicros: number
	ambiguousMicros: number
	settledTokens: number
	reservedTokens: number
	ambiguousTokens: number
}

export interface CampaignState {
	schemaVersion: 1
	month: string
	campaigns: Record<string, CampaignRecord>
	drafts: Record<string, {
		id: string
		repository: string
		name: string
		sourceRevision: string | null
		requestedModelProfile: string | null
	}>
	jobs: RepositoryCampaignJob[]
	intakeRecords: RepositoryAdvisoryIntakeRecord[]
	history: Array<{
		at: number
		campaignId: string
		action:
			| "drafted"
			| "configured"
			| "started"
			| "stopped"
			| "budget"
			| "budget-exhausted"
			| "claimed"
			| "completed"
			| "interrupted"
		epoch: number
		jobId?: string
	}>
}

export interface ClaimedRepositoryJob {
	job: RepositoryCampaignJob
	claimId: string
	epoch: number
}

export type MockRepositoryDispatcher = (job: RepositoryCampaignJob) => Promise<{
	status: "succeeded" | "failed" | "ambiguous"
	actualMicros?: number
	actualTokens?: number
}>
