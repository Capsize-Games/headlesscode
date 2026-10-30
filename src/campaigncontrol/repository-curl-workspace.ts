import * as path from "node:path"
import type { CurlRuntimeConfig } from "./repository-curl-runtime-config.js"
import type { CurlPrepareInput, CurlWorkspaceDependencies,
	CurlWorkspaceAuthorization,
		CurlWorkspaceResources } from "./repository-curl-workspace-types.js"
import type { RepositoryPreparedWorkspace } from
	"./repository-worker-pipeline.js"
import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type { FleetRepositoryBudgetScope } from
	"../rsi/fleet-repository-budget-ledger.js"
import { resolveContainedRuntimeProfile } from "../security/profile.js"
import { readFleetBudgetKeyIdentity } from "../rsi/fleet-budget-ledger.js"
import { buildCurlPreparedWorkspace } from
	"./repository-curl-worker-workspace.js"
import { CURL_FIXED_ADVISORY, CURL_PRIVATE_SOURCE_REVISION,
	CURL_CANDIDATE_TREE_SHA } from "./repository-curl-evaluator.js"
import { CURL_PRIVATE_SOURCE_ROOT,
	CURL_CAMPAIGN_POLICY_SHA256 } from "./repository-curl-profile.js"
import { MODEL, PROFILE_ID } from "./repository-curl-profile.js"
import { makeRepositoryBudgetScope, assertWorkerCredential } from
	"./repository-curl-workspace-auth.js"
import { prepareCurlWorkspaceResources } from
	"./repository-curl-workspace-provision.js"
import { createRepositoryCampaignBudgetBinding } from
	"./repository-budget-binding.js"
import { restorePinnedWorktreeEolBytes } from "./repository-source-tree.js"
import { containedEvidenceSessionId,
	validateContainedSupervisorRoots } from "../security/supervisor.js"
import { startContainedEvidenceService } from
	"../security/contained-evidence-service.js"
import { readCurlRuntimeConfig } from "./repository-curl-runtime-config.js"
import { writeRepositoryWorkerTask } from "./repository-worker.js"
import { isFreshLiveAuthority,
	buildLimits } from "./repository-curl-authority.js"
import { sha256, removeOwnedWorktree, createPinnedWorktree, removeTaskFile,
	gitText } from "./repository-curl-source.js"
import { probeOpenShell, buildContainedHostEnvironment } from
	"./repository-curl-runtime-config.js"
import { readFleetOpenRouterCredential } from "./repository-curl-credentials.js"

class SingleWorkerGate {
	private tail: Promise<void> = Promise.resolve()
	async acquire(): Promise<() => void> {
		let releaseTurn!: () => void
		const turn = new Promise<void>((resolve) => { releaseTurn = resolve })
		const previous = this.tail
		this.tail = previous.then(() => turn)
		await previous
		let released = false
		return () => { if (!released) { released = true; releaseTurn() } }
	}
}

const curlWorkerGate = new SingleWorkerGate()

export async function prepareCurlWorkspace(input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies):
		Promise<RepositoryPreparedWorkspace> {
	assertQualificationInput(input, dependencies.definition)
	await dependencies.context.store.assertClaimCurrent(input.claim)
	const authorization = await authorizeCurlWorkspace(input, dependencies)
	const releaseGate = await curlWorkerGate.acquire()
	const resources = await prepareCurlWorkspaceResources(input, dependencies,
		authorization, releaseGate)
	return buildCurlPreparedWorkspace(input, dependencies, authorization,
		resources)
		.catch((error: unknown) => cleanupFailedWorkspace(resources, error))
}

async function cleanupFailedWorkspace(
	resources: CurlWorkspaceResources,
	error: unknown,
): Promise<never> {
	await resources.cleanup().catch(() => undefined)
	throw error
}

function assertQualificationInput(input: CurlPrepareInput,
	definition: RepositoryCampaignDefinition): void {
	if (input.definition.id !== definition.id ||
		input.claim.job.campaignId !== definition.id ||
		input.claim.job.advisoryId !== CURL_FIXED_ADVISORY ||
			input.claim.job.purpose !== "qualification") {
		throw new Error("Curl job identity does not match the registered profile")
	}
}

async function authorizeCurlWorkspace(
	input: CurlPrepareInput,
	dependencies: CurlWorkspaceDependencies,
): Promise<CurlWorkspaceAuthorization> {
	const { definition, dependencies: runtime, authority } = dependencies
	const budget = await authority(definition.id)
	if (!isFreshLiveAuthority(budget, definition)) {
		throw new
			Error("Curl execution requires a fresh active Fleet v2 repository budget")
	}
	const scope = makeRepositoryBudgetScope(definition, budget.repositoryEpoch!)
	const credentials = await loadWorkerCredential(runtime)
	const runtimeConfig = (runtime.loadRuntimeConfig ?? readCurlRuntimeConfig)()
	return makeWorkspaceAuthorization(input, scope, credentials, runtimeConfig)
}

async function loadWorkerCredential(
	runtime: CurlWorkspaceDependencies["dependencies"],
): Promise<{ apiKey: string; keyIdentity: string; expectedKeyIdentity:
	string }> {
	const credential = await (runtime.readCredential ??
		readFleetOpenRouterCredential)()
	const expectedKeyIdentity = await (runtime.readKeyIdentity ??
		readFleetBudgetKeyIdentity)()
	assertWorkerCredential(credential, expectedKeyIdentity)
	return { ...credential, expectedKeyIdentity }
}

function makeWorkspaceAuthorization(
	input: CurlPrepareInput,
	scope: FleetRepositoryBudgetScope,
	credentials: { apiKey: string; keyIdentity: string; expectedKeyIdentity:
		string },
	runtimeConfig: CurlRuntimeConfig,
): CurlWorkspaceAuthorization {
	const leaseToken = input.claim.claimId
	if (!/^[0-9a-f-]{36}$/.test(leaseToken)) {
		throw new Error("repository claim token is invalid")
	}
	return createWorkspaceAuthorization(scope, credentials, runtimeConfig,
		leaseToken)
}

function createWorkspaceAuthorization(
	scope: FleetRepositoryBudgetScope,
	credentials: { apiKey: string; expectedKeyIdentity: string },
	runtimeConfig: CurlRuntimeConfig,
	leaseToken: string,
): CurlWorkspaceAuthorization {
	return {
		scope,
		apiKey: credentials.apiKey,
		expectedKeyIdentity: credentials.expectedKeyIdentity,
		runtimeConfig,
		hostRuntimeEnv: buildContainedHostEnvironment(runtimeConfig),
		bindHost: runtimeConfig.brokerBindHost,
		leaseToken,
	}
}
