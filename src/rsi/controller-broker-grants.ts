import {
	fleetPayloadDigest,
	type FleetJob,
	type FleetJobPayload,
} from "./postgres-queue.js"
import type { OpenRouterBrokerLimits } from "./inference-broker.js"
import type {
	PostgresProofCampaign,
	ProofAttemptReservation,
	ProofCampaignArmLease,
} from "./proof-campaign.js"
import type { CandidateRecord } from "./types.js"

export interface MutationGrantArgs {
	store: PostgresProofCampaign
	lease: ProofCampaignArmLease
	attemptKey: string
	slotId: string
	candidate: CandidateRecord
	seed: string
	payload: FleetJobPayload
	existing?: FleetJob | null
}

function grantDigest(
	payload: FleetJobPayload,
	existing: FleetJob | null | undefined,
): string {
	const live = existing?.status !== "completed"
	return fleetPayloadDigest(live ? payload : existing.payload)
}

function grantIdentity(
	args: MutationGrantArgs,
): ProofAttemptReservation["identity"] {
	const { slotId, candidate, seed } = args
	return {
		generation: candidate.generation,
		candidateId: slotId,
		taskId: "mutation",
		seed,
		attemptKind: "mutation",
	}
}

function grantReservation(
	args: MutationGrantArgs,
	requestSha256: string,
	limits: OpenRouterBrokerLimits,
): ProofAttemptReservation {
	const { attemptKey, candidate, existing } = args
	return {
		attemptKey,
		kind: "mutation",
		identity: grantIdentity(args),
		sourceCandidateId: candidate.id,
		requestSha256,
		calls: limits.maxCalls,
		tokens: limits.maxTotalTokens,
		spendUsd: limits.maxJobSpendUsd,
		...(existing ? { jobId: existing.jobId } : {}),
	}
}

export async function admitMutationGrant(
	args: MutationGrantArgs,
): Promise<void> {
	const { store, lease, attemptKey, payload, existing } = args
	const limits = payload.inferenceLimits
	if (!limits) {
		throw new Error("proof campaign mutation has no bounded broker limits")
	}
	const digest = grantDigest(payload, existing)
	const reservation = grantReservation(args, digest, limits)
	const admitted = await store.admit(lease, reservation)
	if (admitted.status !== "completed") {
		await store.markDispatched(lease, attemptKey, existing?.jobId)
	}
}
