import type { RepositoryWorkerPipelineAdapters } from
	"./repository-worker-pipeline.js"
import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type { FleetRepositoryBudgetScope } from
	"../rsi/fleet-repository-budget-ledger.js"
import type { CurlRuntimeDependencies,
	CurlRuntimeServices } from "./repository-curl-runtime-dependencies.js"
import type { RepositoryPipelineAdapterFactoryContext } from
	"./repository-worker-registration.js"
import type { CurlRuntimeConfig } from "./repository-curl-runtime-config.js"
import { type resolveContainedRuntimeProfile } from "../security/profile.js"
import { type startContainedEvidenceService } from
	"../security/contained-evidence-service.js"
import { type verifyPinnedGitWorktreeTree } from "./repository-source-tree.js"
import { type runRepositoryWorkerThroughBroker } from "./repository-worker.js"

export type CurlPrepareInput =
	Parameters<RepositoryWorkerPipelineAdapters["prepareWorkspace"]>[0]

export interface CurlWorkspaceDependencies {
	definition: RepositoryCampaignDefinition
	context: RepositoryPipelineAdapterFactoryContext
	dependencies: CurlRuntimeDependencies
	sourceRoot: string
	projectRoot: string
	authority: CurlRuntimeServices["authority"]
	verifyTree: CurlRuntimeServices["verifyTree"]
	resolveProfile: CurlRuntimeServices["resolveProfile"]
	runWorker: CurlRuntimeServices["runWorker"]
}

export interface CurlWorkspaceAuthorization {
	scope: FleetRepositoryBudgetScope
	apiKey: string
	expectedKeyIdentity: string
	runtimeConfig: CurlRuntimeConfig
	hostRuntimeEnv: NodeJS.ProcessEnv
	bindHost: string
	leaseToken: string
}

export interface CurlWorkspaceResources {
	worktree: string
	profile: ReturnType<typeof resolveContainedRuntimeProfile>
	taskSha256: string
	cleanup: () => Promise<void>
}


export interface CandidateDigestDependencies {
	input: CurlPrepareInput
	sourceRoot: string
	worktree: string
	taskSha256: string
	verifyTree: CurlWorkspaceDependencies["verifyTree"]
	isRemoved: () => boolean
	setRemoved: (value: boolean) => void
}
