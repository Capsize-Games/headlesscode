import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_PATCH_SHA256,
} from "./repository-curl-repair.js"
import type {
	BlockedDeliveryContext,
	CurlRepairClaim,
	CurlRepairDeliveryReceipt,
	DeliveryIdentity,
	DeliveryState,
} from "./repository-curl-repair-delivery-model.js"
import { BRANCH_PREFIX } from "./repository-curl-repair-delivery-model.js"
import {
	canonical,
	sha256,
} from "./repository-curl-repair-delivery-primitives.js"
import { writeState } from "./repository-curl-repair-delivery-store.js"

type EntryIdentity = { identitySha256: string; receiptSha256: string }
type DeliveryEntry = DeliveryState["entries"][string]
type EntryState = DeliveryEntry["state"]
type EntryInput = {
	identity: EntryIdentity
	claim: CurlRepairClaim
	state: EntryState
	privateRef: string | null
	branch?: string
}

export async function saveBlocked(
	context: BlockedDeliveryContext,
	reasonCode: string,
	stateName: DeliveryState["entries"][string]["state"] = "blocked",
): Promise<CurlRepairDeliveryReceipt> {
	const entry = {
		...makeEntry(context.identity, context.claim, stateName, null),
		reasonCode,
	}
	context.state.entries[context.key] = entry
	await writeState(context.statePath, context.state)
	return { ...receiptFromState(entry), reasonCode }
}

export function makeEntry(
	identity: EntryIdentity,
	claim: CurlRepairClaim,
	state: EntryState,
	privateRef: string | null,
	branch?: string,
): DeliveryEntry {
	return buildEntry(identity, claim, state, privateRef, branch)
}

function buildEntry(
	identity: EntryIdentity,
	claim: CurlRepairClaim,
	state: EntryState,
	privateRef: string | null,
	branch?: string,
): DeliveryEntry {
	return entryRecord({ identity, claim, state, privateRef, branch })
}

function entryRecord(input: EntryInput): DeliveryEntry {
	const { identity, claim, state, privateRef, branch } = input
	return {
		identitySha256: identity.identitySha256,
		claimId: claim.claimId,
		epoch: claim.epoch,
		jobId: claim.job.id,
		branch: branch ?? BRANCH_PREFIX + CURL_REPAIR_PATCH_SHA256.slice(0, 16),
		candidateRevision: CURL_REPAIR_CANDIDATE_REVISION,
		receiptSha256: identity.receiptSha256,
		state,
		reasonCode: state,
		privateRef,
		updatedAt: Date.now(),
	}
}

export function receiptFromState(
	entry: DeliveryState["entries"][string],
): CurlRepairDeliveryReceipt {
	const accepted = isAcceptedDelivery(entry.state)
	const record = receiptRecord(entry, accepted)
	return {
		accepted,
		disposition: record.disposition,
		evidenceSha256: sha256(canonical(record)),
		privateRef: entry.privateRef,
		reasonCode: accepted
			? "verified-private-delivery-recorded"
			: entry.reasonCode,
	}
}

function isAcceptedDelivery(
	state: DeliveryState["entries"][string]["state"],
): boolean {
	return state === "already-fixed" || state === "draft-ready"
}

type ReceiptRecord = {
	disposition: CurlRepairDeliveryReceipt["disposition"]
	[key: string]: unknown
}

function receiptRecord(
	entry: DeliveryState["entries"][string],
	accepted: boolean,
): ReceiptRecord {
	return {
		schemaVersion: 1,
		identitySha256: entry.identitySha256,
		claimId: entry.claimId,
		epoch: entry.epoch,
		jobId: entry.jobId,
		candidateRevision: entry.candidateRevision,
		receiptSha256: entry.receiptSha256,
		disposition: deliveryDisposition(entry.state, accepted),
		reasonCode: entry.reasonCode,
		privateRef: entry.privateRef,
		updatedAt: entry.updatedAt,
	}
}

function deliveryDisposition(
	state: DeliveryState["entries"][string]["state"],
	accepted: boolean,
): CurlRepairDeliveryReceipt["disposition"] {
	if (state === "already-fixed") return "already-fixed"
	return accepted ? "draft-ready" : "blocked"
}

export function isBranchReady(
	entry: DeliveryState["entries"][string],
): boolean {
	return [
		"branch-pushed",
		"pr-intent",
		"pr-uncertain",
		"draft-ready",
	].includes(entry.state)
}
