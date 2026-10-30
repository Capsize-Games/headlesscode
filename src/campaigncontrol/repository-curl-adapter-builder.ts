import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { createRepositoryBudgetAuthorityReader } from
	"./repository-budget-authority.js"
import { CAMPAIGN_CONTROL_FILE } from "./paths.js"
import { CURL_CANDIDATE_TREE_SHA, CURL_FIXED_ADVISORY, CURL_CAMPAIGN_ID,
	CURL_PRIVATE_SOURCE_REVISION, evaluatePinnedCurlCandidate,
		makeCurlProtectedEvaluationRequest } from "./repository-curl-evaluator.js"
import { writePrivateCurlDeliveryReceipt } from
	"./repository-curl-private-delivery.js"
import type { RepositoryWorkerRegistration,
	RepositoryPipelineAdapterFactoryContext } from
		"./repository-worker-registration.js"
import type { RepositoryWorkerPipelineAdapters, RepositoryPreparedWorkspace,
	RepositoryVerificationReceipt, RepositoryPrivateDeliveryReceipt } from
		"./repository-worker-pipeline.js"
import { runRepositoryWorkerThroughBroker } from "./repository-worker.js"
import { verifyPinnedGitWorktreeTree } from "./repository-source-tree.js"
import { writeRepositoryWorkerDiagnostic } from
	"./repository-worker-diagnostics.js"
import { loadKnownCurlDebianAdvisory } from
	"./repository-known-advisory.js"
import { resolveContainedRuntimeProfile } from "../security/profile.js"
import { CURL_PRIVATE_SOURCE_ROOT, MODEL, PROFILE_ID, WORKER_PROFILE } from
	"./repository-curl-profile.js"
import type { CurlRuntimeDependencies, CurlRuntimePaths,
	CurlRuntimeServices, CurlPipelineAdapterBuildInput } from
		"./repository-curl-runtime-dependencies.js"
import { prepareCurlWorkspace } from "./repository-curl-workspace.js"
import { validateAdvisory } from "./repository-curl-source.js"
import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"

export function resolveCurlRuntimePaths(
	dependencies: CurlRuntimeDependencies,
): CurlRuntimePaths {
	const projectRoot =
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
	return {
		sourceRoot: path.resolve(dependencies.sourceRoot ?? CURL_PRIVATE_SOURCE_ROOT),
		projectRoot: path.resolve(dependencies.projectRoot ?? projectRoot),
	}
}

export function resolveCurlRuntimeServices(
	definition: RepositoryCampaignDefinition,
	dependencies: CurlRuntimeDependencies,
): CurlRuntimeServices {
	const reader = dependencies.createBudgetAuthorityReader ??
		createRepositoryBudgetAuthorityReader
	const authority = dependencies.readBudgetAuthority ?? reader([definition],
		CAMPAIGN_CONTROL_FILE)
	return {
		authority,
		lookup: dependencies.lookupAdvisory ?? lookupKnownAdvisory,
		verifyTree: dependencies.verifyTree ?? verifyPinnedGitWorktreeTree,
		resolveProfile: dependencies.resolveProfile ?? resolveContainedRuntimeProfile,
		runWorker: dependencies.runWorker ?? runRepositoryWorkerThroughBroker,
		evaluate: dependencies.evaluate ?? evaluatePinnedCurlCandidate,
		writeDelivery: dependencies.writeDelivery ?? writePrivateCurlDeliveryReceipt,
	}
}

async function lookupKnownAdvisory(
	advisoryId: string,
	definition: RepositoryCampaignDefinition,
):
	Promise<Awaited<ReturnType<NonNullable<
		CurlRuntimeDependencies["lookupAdvisory"]>>>> {
	if (definition.id !== CURL_CAMPAIGN_ID || advisoryId !== CURL_FIXED_ADVISORY) {
		throw new Error("Curl advisory is outside the fixed qualification scope")
	}
	return await loadKnownCurlDebianAdvisory()
}

export function buildCurlPipelineAdapters(
	input: CurlPipelineAdapterBuildInput,
): RepositoryWorkerPipelineAdapters {
	const { registration, context } = input
	return {
		workerProfile: registration.workerProfile,
		recipeDigest: registration.recipeDigest,
		evaluatorDigest: registration.evaluatorDigest,
		model: registration.model,
		executionKind: "live-cve",
		reservation: { ...registration.reservation },
		recordFailureDiagnostic: makeFailureRecorder(context),
		lookupAdvisory: makeAdvisoryLookup(input),
		prepareWorkspace: makeWorkspacePreparer(input),
		evaluate: makeEvaluator(input),
		deliverPrivate: makePrivateDelivery(input),
	}
}

function makeFailureRecorder(
	context: RepositoryPipelineAdapterFactoryContext,
): RepositoryWorkerPipelineAdapters["recordFailureDiagnostic"] {
	return async (input) => await
		writeRepositoryWorkerDiagnostic(context.store.path, {
		claim: input.claim, stage: input.stage, error: input.error,
	})
}

function makeAdvisoryLookup(input: CurlPipelineAdapterBuildInput):
	RepositoryWorkerPipelineAdapters["lookupAdvisory"] {
	return async (advisoryId, definition) => {
		if (definition.id !== input.definition.id || advisoryId !==
			CURL_FIXED_ADVISORY) {
			throw new
				Error("Curl advisory identity does not match the registered profile")
		}
		const advisory = await input.services.lookup(advisoryId, definition)
		validateAdvisory(advisory)
		return advisory
	}
}

function makeWorkspacePreparer(input: CurlPipelineAdapterBuildInput):
	RepositoryWorkerPipelineAdapters["prepareWorkspace"] {
	const { definition, context, dependencies, paths, services } = input
	return async (claimInput) => await prepareCurlWorkspace(claimInput, {
		definition, context, dependencies, sourceRoot: paths.sourceRoot,
		projectRoot: paths.projectRoot, authority: services.authority,
		verifyTree: services.verifyTree, resolveProfile: services.resolveProfile,
		runWorker: services.runWorker,
	})
}

function makeEvaluator(input: CurlPipelineAdapterBuildInput):
	RepositoryWorkerPipelineAdapters["evaluate"] {
	return async (evaluation) => {
		assertEvaluationIdentity(input, evaluation)
		const candidate = evaluation.workspace as RepositoryPreparedWorkspace & {
			candidateSha256(): Promise<string>
		}
		if (await candidate.candidateSha256() !== evaluation.candidateSha256) {
			throw new Error("Curl candidate digest changed before protected evaluation")
		}
		const request = makeBoundEvaluationRequest(input, evaluation)
		const result = await input.services.evaluate(request)
		return {
			passed: result.accepted && result.disposition === "already-fixed",
			evidenceSha256: result.evidenceSha256,
			detail: result.reasonCode,
		}
	}
}

function assertEvaluationIdentity(input: CurlPipelineAdapterBuildInput,
	evaluation: Parameters<RepositoryWorkerPipelineAdapters["evaluate"]>[0]):
		void {
	if (evaluation.definition.id !== input.definition.id ||
		evaluation.claim.job.campaignId !== input.definition.id ||
		evaluation.advisory.advisoryId !== CURL_FIXED_ADVISORY) {
		throw new
			Error("Curl evaluation identity does not match the registered profile")
	}
}

function makeBoundEvaluationRequest(
	input: CurlPipelineAdapterBuildInput,
	evaluation:
		Pick<Parameters<RepositoryWorkerPipelineAdapters["evaluate"]>[0], "claim"
			| "advisory" | "candidateSha256">,
): ReturnType<typeof makeCurlProtectedEvaluationRequest> {
	const request = makeCurlProtectedEvaluationRequest({
		campaignId: input.definition.id, jobId: evaluation.claim.job.id,
		advisoryId: evaluation.advisory.advisoryId,
		candidateRevision: CURL_PRIVATE_SOURCE_REVISION,
		candidateTreeSha: CURL_CANDIDATE_TREE_SHA,
	})
	if (request.candidateSha256 !== evaluation.candidateSha256) {
		throw new Error("Curl protected candidate digest is not source-bound")
	}
	return request
}

function makePrivateDelivery(input: CurlPipelineAdapterBuildInput):
	RepositoryWorkerPipelineAdapters["deliverPrivate"] {
	return async (delivery) => {
		assertDeliveryIdentity(input, delivery)
		const request = makeBoundEvaluationRequest(input, delivery)
		await input.context.store.assertClaimCurrent(delivery.claim)
		return await input.services.writeDelivery(input.context.store.path, {
			campaignId: input.definition.id, jobId: delivery.claim.job.id,
			claimId: delivery.claim.claimId, epoch: delivery.claim.epoch,
			advisoryId: delivery.advisory.advisoryId,
			candidateSha256: request.candidateSha256,
			verificationSha256: delivery.verification.evidenceSha256,
			disposition: "already-fixed", sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
			sourceTreeSha256: CURL_CANDIDATE_TREE_SHA,
		})
	}
}

function assertDeliveryIdentity(input: CurlPipelineAdapterBuildInput,
	delivery:
		Parameters<RepositoryWorkerPipelineAdapters["deliverPrivate"]>[0]): void {
	const receipt: RepositoryVerificationReceipt = delivery.verification
	if (delivery.definition.id !== input.definition.id ||
		delivery.claim.job.campaignId !== input.definition.id ||
		delivery.advisory.advisoryId !== CURL_FIXED_ADVISORY ||
		!receipt.passed || !/^[a-f0-9]{64}$/.test(receipt.evidenceSha256)) {
		throw new
				Error("Curl private delivery is not bound to a verified " +
					"fixed-profile result")
	}
}
