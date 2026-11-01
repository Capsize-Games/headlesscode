import type {
	RepositoryPrivateDeliveryReceipt,
	RepositoryWorkerPipelineAdapters,
} from "./repository-worker-pipeline.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_SHA256,
} from "./repository-curl-repair.js"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "./repository-campaign-ids.js"
import type {
	CurlRepairV2AdapterScope,
} from "./repository-curl-repair-v2-runtime-types.js"
import type {
	CurlRepairV2DeliveryInput,
} from "./repository-curl-repair-v2-private-delivery-types.js"

type DeliverInput = Parameters<
	RepositoryWorkerPipelineAdapters["deliverPrivate"]
>[0]

export async function deliverCurlRepairV2Privately(
	scope: CurlRepairV2AdapterScope,
	input: DeliverInput,
): Promise<RepositoryPrivateDeliveryReceipt> {
	assertDelivery(scope, input)
	await scope.context.store.assertClaimCurrent(input.claim)
	const deliveryInput: CurlRepairV2DeliveryInput = {
		claim: input.claim,
		definition: input.definition,
		candidateSha256: input.candidateSha256,
		verification: input.verification,
		signal: input.signal,
	}
	if (scope.dependencies.deliverRepair) {
		return await scope.dependencies.deliverRepair(deliveryInput)
	}
	return await deliverWithFacade(deliveryInput, scope)
}

async function deliverWithFacade(
	input: CurlRepairV2DeliveryInput,
	scope: CurlRepairV2AdapterScope,
): Promise<RepositoryPrivateDeliveryReceipt> {
	const { deliverVerifiedCurlHistoricalRepairV2 } = await import(
		"./repository-curl-repair-v2-private-delivery.js"
	)
	return await deliverVerifiedCurlHistoricalRepairV2(input, {
		store: scope.context.store,
	})
}

function assertDelivery(
	scope: CurlRepairV2AdapterScope,
	input: DeliverInput,
): void {
	const repair = input.verification.historicalRepairV2
	if (!repair || !input.verification.passed ||
		!deliveryClaimMatches(repair, input) ||
		!candidateMatches(repair)) {
		throw new Error("Curl v2 private delivery is not bound to the candidate")
	}
}

function deliveryClaimMatches(
	repair: NonNullable<DeliverInput["verification"]["historicalRepairV2"]>,
	input: DeliverInput,
): boolean {
	return input.claim.job.purpose === "repair" &&
		input.claim.job.campaignId === CURL_REPAIR_V2_CAMPAIGN_ID &&
		input.definition.id === CURL_REPAIR_V2_CAMPAIGN_ID &&
		input.advisory.advisoryId === CURL_FIXED_ADVISORY &&
		repair.receipt.evidenceSha256 === input.verification.evidenceSha256
}

function candidateMatches(
	repair: NonNullable<DeliverInput["verification"]["historicalRepairV2"]>,
): boolean {
	return repair.candidate.sourceRevision === CURL_REPAIR_HISTORICAL_BASE &&
		repair.candidate.candidateRevision === CURL_REPAIR_CANDIDATE_REVISION &&
		repair.candidate.candidateTreeSha === CURL_REPAIR_CANDIDATE_TREE_SHA &&
		repair.candidate.patchSha256 === CURL_REPAIR_PATCH_SHA256
}
