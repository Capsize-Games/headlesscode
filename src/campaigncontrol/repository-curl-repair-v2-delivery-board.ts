import type { ClaimedRepositoryJob } from "./repository-campaigns.js"
import {
	CURL_PRIVATE_BOARD_API_URL,
	CURL_PRIVATE_BOARD_CARD_ID,
} from "./repository-curl-profile.js"
import { fixedBoardTransport } from "./repository-curl-private-board.js"
import type { CurlPrivateBoardTransport } from
	"./repository-curl-private-types.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from
	"./repository-campaign-ids.js"
import {
	CURL_REPAIR_V2_POLICY_SHA256,
	CURL_REPAIR_V2_REPOSITORY_ID,
} from "./repository-curl-repair-v2-profile.js"
import type { CurlRepairV2DeliveryInput } from
	"./repository-curl-repair-v2-delivery-validation.js"
import type {
	CurlRepairV2DeliveryDependencies,
	CurlRepairV2DeliveryResult,
	VerifiedCurlRepairV2Delivery,
} from "./repository-curl-repair-v2-private-delivery-types.js"
import {
	writeDeliveryState,
	type CurlRepairV2DeliveryState,
} from "./repository-curl-repair-v2-delivery-state.js"
import {
	currentClaimFailure,
	requireClaimCurrent,
} from "./repository-curl-repair-v2-delivery-current.js"
import { canonical, sha256 } from
	"./repository-curl-repair-v2-delivery-digest.js"

export function buildV2DeliveryMarker(
	claim: ClaimedRepositoryJob,
	candidateSha256: string,
): string {
	const identity = {
		campaignId: claim.job.campaignId,
		jobId: claim.job.id,
		policySha256: CURL_REPAIR_V2_POLICY_SHA256,
		candidateSha256,
	}
	return `hc-repository-result-v2:${sha256(canonical(identity))}`
}

interface BoardDeliveryTask {
	record: CurlRepairV2DeliveryState
	input: CurlRepairV2DeliveryInput
	statePath: string
	lock: import("node:fs").promises.FileHandle
	dependencies: CurlRepairV2DeliveryDependencies
	board: CurlPrivateBoardTransport
}

export function createPendingRecord(
	verified: VerifiedCurlRepairV2Delivery,
): CurlRepairV2DeliveryState {
	return {
		schemaVersion: 2,
		campaignId: CURL_REPAIR_V2_CAMPAIGN_ID,
		repositoryId: CURL_REPAIR_V2_REPOSITORY_ID,
		jobId: verified.claim.job.id,
		firstClaimId: verified.claim.claimId,
		firstEpoch: verified.claim.epoch,
		policySha256: CURL_REPAIR_V2_POLICY_SHA256,
		candidateSha256: verified.candidateSha256,
		evidenceSha256: verified.receipt.evidenceSha256,
		marker: verified.marker,
		deliveryStatus: "pending",
		boardRef: null,
		updatedAt: Date.now(),
	}
}

export function assertPriorDeliveryMatches(
	prior: CurlRepairV2DeliveryState,
	verified: VerifiedCurlRepairV2Delivery,
): void {
	const deliveredRef = prior.deliveryStatus === "delivered"
		? boardReference(prior.marker)
		: null
	if (prior.jobId !== verified.claim.job.id ||
		prior.campaignId !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		prior.repositoryId !== CURL_REPAIR_V2_REPOSITORY_ID ||
		prior.policySha256 !== CURL_REPAIR_V2_POLICY_SHA256 ||
		prior.candidateSha256 !== verified.candidateSha256 ||
		prior.marker !== verified.marker || prior.boardRef !== deliveredRef ||
		!/^[a-f0-9]{64}$/.test(prior.evidenceSha256)) {
		throw new Error("stored Curl v2 delivery conflicts with this job evidence")
	}
}

export async function deliverBoardReceipt(
	record: CurlRepairV2DeliveryState,
	input: CurlRepairV2DeliveryInput,
	statePath: string,
	lock: import("node:fs").promises.FileHandle,
	dependencies: CurlRepairV2DeliveryDependencies,
): Promise<CurlRepairV2DeliveryResult> {
	const board = dependencies.board ?? fixedBoardTransport()
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	const exists = await board.hasMarker(record.marker, lock)
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	if (exists) return await saveDelivered(record, input, statePath, dependencies)
	return await sendComment({
		record, input, statePath, lock, dependencies, board,
	})
}


async function sendComment(
	task: BoardDeliveryTask,
): Promise<CurlRepairV2DeliveryResult> {
	const { record, input, board, lock, dependencies } = task
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	try {
		await board.addComment(deliveryComment(record, input), lock)
	} catch {
		// Readback below resolves a lost board acknowledgement.
	}
	return await confirmSentComment(task)
}

async function confirmSentComment(
	task: BoardDeliveryTask,
): Promise<CurlRepairV2DeliveryResult> {
	const { record, input, statePath, lock, dependencies, board } = task
	const afterSend = await currentClaimFailure(
		dependencies, input.claim, input.signal,
	)
	const confirmed = await board.hasMarker(record.marker, lock)
	return await settleConfirmation({ task, afterSend, confirmed })
}

async function settleConfirmation(result: {
	task: BoardDeliveryTask
	afterSend: Error | null
	confirmed: boolean
}): Promise<CurlRepairV2DeliveryResult> {
	if (!result.confirmed) {
		return pendingAfterSend(result.task.record, result.afterSend)
	}
	const { task, afterSend } = result
	return await saveSentResult(task.record, task.input, task.statePath,
		task.dependencies, afterSend)
}

function pendingAfterSend(
	record: CurlRepairV2DeliveryState,
	afterSend: Error | null,
): CurlRepairV2DeliveryResult {
	if (afterSend) throw afterSend
	return deliveryResult(record, false)
}

async function saveSentResult(
	record: CurlRepairV2DeliveryState,
	input: CurlRepairV2DeliveryInput,
	statePath: string,
	dependencies: CurlRepairV2DeliveryDependencies,
	afterSend: Error | null,
): Promise<CurlRepairV2DeliveryResult> {
	const result = await settleSentComment(
		record, input, statePath, dependencies, afterSend,
	)
	if (afterSend) throw afterSend
	return result
}

async function settleSentComment(
	record: CurlRepairV2DeliveryState,
	input: CurlRepairV2DeliveryInput,
	statePath: string,
	dependencies: CurlRepairV2DeliveryDependencies,
	afterSend: Error | null,
): Promise<CurlRepairV2DeliveryResult> {
	if (!afterSend) {
		await requireClaimCurrent(dependencies, input.claim, input.signal)
	}
	const delivered = deliveredRecord(record)
	await writeDeliveryState(statePath, delivered)
	if (!afterSend) {
		await requireClaimCurrent(dependencies, input.claim, input.signal)
	}
	return deliveryResult(delivered, true)
}

async function saveDelivered(
	record: CurlRepairV2DeliveryState,
	input: CurlRepairV2DeliveryInput,
	statePath: string,
	dependencies: CurlRepairV2DeliveryDependencies,
): Promise<CurlRepairV2DeliveryResult> {
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	const delivered = deliveredRecord(record)
	await writeDeliveryState(statePath, delivered)
	await requireClaimCurrent(dependencies, input.claim, input.signal)
	return deliveryResult(delivered, true)
}

function deliveredRecord(
	record: CurlRepairV2DeliveryState,
): CurlRepairV2DeliveryState {
	return {
		...record,
		deliveryStatus: "delivered",
		boardRef: boardReference(record.marker),
		updatedAt: Date.now(),
	}
}

export function deliveryResult(
	record: CurlRepairV2DeliveryState,
	accepted: boolean,
): CurlRepairV2DeliveryResult {
	const digest = sha256(canonical({
		campaignId: record.campaignId,
		jobId: record.jobId,
		policySha256: record.policySha256,
		candidateSha256: record.candidateSha256,
		evidenceSha256: record.evidenceSha256,
	}))
	return { accepted, evidenceSha256: digest, boardRef: record.boardRef }
}

function boardReference(marker: string): string {
	const card = `${CURL_PRIVATE_BOARD_API_URL}/cards/` +
		CURL_PRIVATE_BOARD_CARD_ID
	return `${card}#${marker}`
}

function deliveryComment(
	record: CurlRepairV2DeliveryState,
	input: CurlRepairV2DeliveryInput,
): string {
	const metadata = input.verification.historicalRepairV2
	if (!metadata) throw new Error("Curl v2 delivery metadata is missing")
	const receipt = metadata.receipt
	return [
		`[${record.marker}] ${receipt.advisoryId}:`,
		`historical public regression verified for job ${record.jobId}.`,
		`Candidate ${receipt.candidateRevision}`,
		`(tree ${receipt.candidateTreeSha});`,
		`policy ${record.policySha256}; evidence ${record.evidenceSha256}.`,
		`Claim ${record.firstClaimId}, epoch ${record.firstEpoch}.`,
		"The private target already contains this fix; no branch or PR was created.",
	].join(" ")
}
