import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type { RepositoryWorkerPipelineAdapters } from "./repository-worker-pipeline.js"

export interface RepositoryWorkerRegistration {
	campaignId: string
	repositoryId: string
	repository: string
	sourceRevision: string
	policySha256: string
	workerProfile: string
	recipeDigest: string
	evaluatorDigest: string
	model: string
	profileId: string
	pipelineAdapterId: string
	executionKind: "live-cve"
	reservation: { micros: number; tokens: number }
}

export interface RepositoryPipelineAdapterFactoryContext {
	store: import("./repository-campaigns.js").RepositoryCampaignStore
}

export type RepositoryPipelineAdapterFactory = (
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
	context?: RepositoryPipelineAdapterFactoryContext,
) => RepositoryWorkerPipelineAdapters
