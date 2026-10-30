import { CURL_REPAIR_CANDIDATE_REVISION } from "./repository-curl-repair.js"
import type { DeliveryState } from "./repository-curl-repair-delivery-model.js"
import {
	BRANCH_PREFIX,
	STATE_SCHEMA,
} from "./repository-curl-repair-delivery-model.js"
import {
	isDigest,
	isRecord,
} from "./repository-curl-repair-delivery-primitives.js"

export function isDeliveryState(value: unknown): value is DeliveryState {
	if (
		!isRecord(value) ||
		value.schemaVersion !== STATE_SCHEMA ||
		!isRecord(value.entries)
	) {
		return false
	}
	return Object.entries(value.entries).every(([key, row]) =>
		isValidStateEntry(key, row),
	)
}

function isValidStateEntry(key: string, value: unknown): boolean {
	if (!isDigest(key) || !isRecord(value)) return false
	return hasValidEntryIdentity(value) && hasValidEntryState(value)
}

function hasValidEntryIdentity(item: Record<string, unknown>): boolean {
	return (
		hasExactEntryKeys(item) &&
		isDigest(item.identitySha256) &&
		isDigest(item.receiptSha256) &&
		isValidClaimId(item.claimId) &&
		isValidEpoch(item.epoch) &&
		isValidJobId(item.jobId)
	)
}

function hasExactEntryKeys(item: Record<string, unknown>): boolean {
	return Object.keys(item).sort().join(",") === expectedEntryKeys()
}

function expectedEntryKeys(): string {
	return [
		"branch",
		"candidateRevision",
		"claimId",
		"epoch",
		"identitySha256",
		"jobId",
		"privateRef",
		"reasonCode",
		"receiptSha256",
		"state",
		"updatedAt",
	].join(",")
}

function hasValidEntryState(item: Record<string, unknown>): boolean {
	return (
		item.candidateRevision === CURL_REPAIR_CANDIDATE_REVISION &&
		typeof item.branch === "string" &&
		validBranch(item.branch) &&
		isValidReason(item.reasonCode) &&
		isValidPrivateRef(item.privateRef) &&
		isValidDeliveryStateName(item.state) &&
		isValidUpdatedAt(item.updatedAt)
	)
}

function isValidClaimId(value: unknown): boolean {
	return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value)
}

function isValidEpoch(value: unknown): boolean {
	return Number.isSafeInteger(value) && Number(value) >= 1
}

function isValidJobId(value: unknown): boolean {
	return (
		typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(value)
	)
}

function isValidReason(value: unknown): boolean {
	return typeof value === "string" && /^[a-z0-9-]{1,96}$/.test(value)
}

function isValidPrivateRef(value: unknown): boolean {
	return value === null || (typeof value === "string" && value.length <= 256)
}

function isValidDeliveryStateName(value: unknown): boolean {
	return [
		"already-fixed",
		"push-intent",
		"branch-uncertain",
		"branch-pushed",
		"pr-intent",
		"pr-uncertain",
		"draft-ready",
		"blocked",
	].includes(String(value))
}

function isValidUpdatedAt(value: unknown): boolean {
	return Number.isSafeInteger(value) && Number(value) >= 0
}

function validBranch(branch: string): boolean {
	return new RegExp(
		`^${BRANCH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-f0-9]{16}$`,
	).test(branch)
}
