import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import { type RepositoryWorkerPipelineAdapters } from
	"./repository-worker-pipeline.js"
import type { RepositoryWorkerRegistration,
	RepositoryPipelineAdapterFactoryContext } from
		"./repository-worker-registration.js"
import { verifyPinnedGitWorktreeTree } from "./repository-source-tree.js"
import { readFleetBudgetKeyIdentity } from "../rsi/fleet-budget-ledger.js"
import { createRepositoryBudgetAuthorityReader } from
	"./repository-budget-authority.js"
import { resolveContainedRuntimeProfile } from "../security/profile.js"
import { validateContainedSupervisorRoots } from "../security/supervisor.js"
import { startContainedEvidenceService } from
	"../security/contained-evidence-service.js"
import { evaluatePinnedCurlCandidate } from "./repository-curl-evaluator.js"
import { writePrivateCurlDeliveryReceipt,
	type CurlPrivateBoardTransport } from "./repository-curl-private-delivery.js"
import { readFleetOpenRouterCredential } from "./repository-curl-credentials.js"
import type { CurlRuntimeConfig } from "./repository-curl-runtime-config.js"
import { createPinnedWorktree,
	removeOwnedWorktree } from "./repository-curl-source.js"
import { type VettedAdvisorySnapshot,
	runRepositoryWorkerThroughBroker } from "./repository-worker.js"

type WorkerRun = Awaited<ReturnType<typeof runRepositoryWorkerThroughBroker>>

export interface CurlRuntimeDependencies {
	/** Test-only seam. Production always uses the compiled private source path. */
	sourceRoot?: string
	projectRoot?: string
	verifyTree?: typeof verifyPinnedGitWorktreeTree
	lookupAdvisory?: (advisoryId: string,
		definition: RepositoryCampaignDefinition) => Promise<VettedAdvisorySnapshot>
	runWorker?: (input: Parameters<typeof runRepositoryWorkerThroughBroker>[0])
		=> Promise<WorkerRun>
	evaluate?: typeof evaluatePinnedCurlCandidate
	readKeyIdentity?: typeof readFleetBudgetKeyIdentity
	readCredential?: typeof readFleetOpenRouterCredential
	resolveProfile?: typeof resolveContainedRuntimeProfile
	writeDelivery?: typeof writePrivateCurlDeliveryReceipt
	startEvidenceService?: typeof startContainedEvidenceService
	validateSupervisorRoots?: typeof validateContainedSupervisorRoots
	createWorktree?: typeof createPinnedWorktree
	removeWorktree?: typeof removeOwnedWorktree
	readBudgetAuthority?: ReturnType<typeof createRepositoryBudgetAuthorityReader>
	createBudgetAuthorityReader?: typeof createRepositoryBudgetAuthorityReader
	loadRuntimeConfig?: () => CurlRuntimeConfig
}


export interface CurlRuntimePaths {
	sourceRoot: string
	projectRoot: string
}

export interface CurlRuntimeServices {
	authority: ReturnType<typeof createRepositoryBudgetAuthorityReader>
	lookup: NonNullable<CurlRuntimeDependencies["lookupAdvisory"]>
	verifyTree: NonNullable<CurlRuntimeDependencies["verifyTree"]>
	resolveProfile: NonNullable<CurlRuntimeDependencies["resolveProfile"]>
	runWorker: NonNullable<CurlRuntimeDependencies["runWorker"]>
	evaluate: NonNullable<CurlRuntimeDependencies["evaluate"]>
	writeDelivery: NonNullable<CurlRuntimeDependencies["writeDelivery"]>
}

export interface CurlPipelineAdapterBuildInput {
	registration: RepositoryWorkerRegistration
	definition: RepositoryCampaignDefinition
	context: RepositoryPipelineAdapterFactoryContext
	dependencies: CurlRuntimeDependencies
	paths: CurlRuntimePaths
	services: CurlRuntimeServices
}
