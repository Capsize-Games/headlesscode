import type { ClaimedRepositoryJob } from "./repository-campaigns.js"
import {
	evaluateCurlHistoricalRepairV2,
	type CurlHistoricalRepairV2Receipt,
} from "./repository-curl-repair-v2-evaluator.js"
import {
	verifyCurlRepairV2Evidence,
	type CurlRepairV2ClaimIdentity,
	type CurlRepairV2EvaluatorReceipt,
	type CurlRepairV2StageReceipt,
	type CurlRepairV2WorkerReceipt,
} from "./repository-curl-repair-v2-execution.js"
import { assertV2DeliveryInput } from
	"./repository-curl-repair-v2-delivery-validation.js"
import type {
	CurlRepairV2DeliveryDependencies,
	CurlRepairV2DeliveryInput,
	VerifiedCurlRepairV2Delivery,
} from "./repository-curl-repair-v2-private-delivery-types.js"
import { requireClaimCurrent } from
	"./repository-curl-repair-v2-delivery-current.js"
import { buildV2DeliveryMarker } from
	"./repository-curl-repair-v2-delivery-board.js"
import { sameCanonical } from
	"./repository-curl-repair-v2-delivery-digest.js"

const MAX_ARTIFACT_AGE_MS = 1_200_000

export async function verifyFreshDeliveryInput(
	input: CurlRepairV2DeliveryInput,
	dependencies: CurlRepairV2DeliveryDependencies,
): Promise<VerifiedCurlRepairV2Delivery> {
	const metadata = assertV2DeliveryInput(input)
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	const verify = dependencies.verifyEvidence ?? verifyCurlRepairV2Evidence
	const stages = await verifySignedStages(input, metadata.receipt, verify)
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	assertStageReceipts(stages.worker, stages.evaluator, metadata)
	const receipt = await rebuildAggregate(input, dependencies, metadata, stages)
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	if (!sameCanonical(receipt, metadata.receipt)) {
		throw new Error("Curl v2 delivery receipt changed after signed verification")
	}
	return verifiedDelivery(input, receipt)
}

async function verifySignedStages(
	input: CurlRepairV2DeliveryInput,
	receipt: CurlHistoricalRepairV2Receipt,
	verify: typeof verifyCurlRepairV2Evidence,
): Promise<{ worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>;
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt> }> {
	return await verify(
		claimIdentity(input.claim),
		expectedReceiptHashes(receipt),
		input.signal,
	)
}

function verifiedDelivery(
	input: CurlRepairV2DeliveryInput,
	receipt: CurlHistoricalRepairV2Receipt,
): VerifiedCurlRepairV2Delivery {
	return {
		candidateSha256: input.candidateSha256,
		claim: input.claim,
		marker: buildV2DeliveryMarker(input.claim, input.candidateSha256),
		receipt,
	}
}

function claimIdentity(claim: ClaimedRepositoryJob): CurlRepairV2ClaimIdentity {
	return { jobId: claim.job.id, claimId: claim.claimId, epoch: claim.epoch }
}

function expectedReceiptHashes(
	receipt: CurlHistoricalRepairV2Receipt,
): Parameters<typeof verifyCurlRepairV2Evidence>[1] {
	return {
		workerReceiptSha256: receipt.execution.workerReceiptSha256,
		evaluatorReceiptSha256: receipt.execution.evaluatorReceiptSha256,
		candidateArtifactSha256: receipt.execution.candidateArtifactSha256,
	}
}

function assertStageReceipts(
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>,
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>,
	metadata: ReturnType<typeof assertV2DeliveryInput>,
): void {
	if (!sameCanonical(worker, metadata.worker) ||
		!sameCanonical(evaluator, metadata.evaluator)) {
		throw new Error("Curl v2 stage receipt changed before private delivery")
	}
	assertStageFreshness(worker, evaluator)
}

function assertStageFreshness(
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>,
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>,
): void {
	const now = Date.now()
	const times = [
		worker.receipt.created_at_unix,
		evaluator.receipt.created_at_unix,
	]
	const stale = times.some((value) => !Number.isSafeInteger(value) ||
		value * 1000 > now + 60_000 ||
		now - value * 1000 > MAX_ARTIFACT_AGE_MS)
	if (stale) {
		throw new Error("Curl v2 signed worker or evaluator receipt is stale")
	}
}

async function rebuildAggregate(
	input: CurlRepairV2DeliveryInput,
	dependencies: CurlRepairV2DeliveryDependencies,
	metadata: ReturnType<typeof assertV2DeliveryInput>,
	stages: {
		worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
		evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
	},
): Promise<CurlHistoricalRepairV2Receipt> {
	return await evaluateCurlHistoricalRepairV2({
		candidate: metadata.candidate,
		jobId: input.claim.job.id,
		claimId: input.claim.claimId,
		epoch: input.claim.epoch,
		worker: stages.worker,
		evaluator: stages.evaluator,
		...baseEvaluator(dependencies),
	})
}

function baseEvaluator(
	dependencies: CurlRepairV2DeliveryDependencies,
	): {
		evaluateBase: NonNullable<
			CurlRepairV2DeliveryDependencies["evaluateBase"]
		>
	} | Record<string, never> {
	return dependencies.evaluateBase
		? { evaluateBase: dependencies.evaluateBase }
		: {}
}
