import type {
	RepositoryCampaignDefinition,
} from "./repository-campaigns.js"
import type {
	RepositoryPipelineAdapterFactoryContext,
	RepositoryWorkerRegistration,
} from "./repository-worker-registration.js"
import type {
	RepositoryPrivateDeliveryReceipt,
} from "./repository-worker-pipeline.js"
import type {
	buildCurlHistoricalRepairCandidate,
} from "./repository-curl-repair.js"
import type {
	prepareCurlRepairV2Candidate,
	evaluateCurlRepairV2Candidate,
} from "./repository-curl-repair-v2-execution.js"
import type {
	evaluateCurlHistoricalRepairCandidate,
} from "./repository-curl-repair-evaluator.js"

export interface CurlRepairV2RuntimeDependencies {
	sourceRoot?: string
	buildCandidate?: typeof buildCurlHistoricalRepairCandidate
	prepare?: typeof prepareCurlRepairV2Candidate
	evaluate?: typeof evaluateCurlRepairV2Candidate
	evaluateBase?: typeof evaluateCurlHistoricalRepairCandidate
	deliverRepair?: (input: {
		claim: import("./repository-campaigns.js").ClaimedRepositoryJob
		definition: RepositoryCampaignDefinition
		candidateSha256: string
		verification: import(
			"./repository-worker-pipeline.js"
		).RepositoryVerificationReceipt
		signal: AbortSignal
	}) => Promise<RepositoryPrivateDeliveryReceipt>
	verifySource?: (sourceRoot: string) => Promise<void>
}

export interface CurlRepairV2AdapterScope {
	registration: RepositoryWorkerRegistration
	definition: RepositoryCampaignDefinition
	context: RepositoryPipelineAdapterFactoryContext
	dependencies: CurlRepairV2RuntimeDependencies
	sourceRoot: string
	buildCandidate: NonNullable<CurlRepairV2RuntimeDependencies["buildCandidate"]>
	prepare: NonNullable<CurlRepairV2RuntimeDependencies["prepare"]>
	evaluate: NonNullable<CurlRepairV2RuntimeDependencies["evaluate"]>
	verifySource: NonNullable<CurlRepairV2RuntimeDependencies["verifySource"]>
}
