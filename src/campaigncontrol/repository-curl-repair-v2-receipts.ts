import {
	CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE, CURL_REPAIR_SOURCE_REVISION,
} from "./repository-curl-repair.js"
import {
	CURL_REPAIR_V2_IMAGE_DIGEST, CURL_REPAIR_V2_PROFILE_ID,
} from "./repository-curl-repair-v2-profile.js"
import type {
	CurlRepairV2ClaimIdentity, CurlRepairV2EvaluatorReceipt,
	CurlRepairV2WorkerReceipt,
} from "./repository-curl-repair-v2-receipt-types.js"

export function isWorkerReceipt(
	value: unknown,
	claim: CurlRepairV2ClaimIdentity,
): value is CurlRepairV2WorkerReceipt {
	if (!record(value)) return false
	return hasWorkerClaim(value, claim) && hasWorkerArtifact(value)
}

function hasWorkerClaim(
	value: Record<string, unknown>,
	claim: CurlRepairV2ClaimIdentity,
): boolean {
	return value.schema_version === 2 &&
		value.profile === CURL_REPAIR_V2_PROFILE_ID &&
		value.job_id === claim.jobId && value.claim_id === claim.claimId &&
		value.epoch === claim.epoch && value.stage === "candidate-preparation" &&
		value.source_revision === CURL_REPAIR_SOURCE_REVISION &&
		value.base_revision === CURL_REPAIR_HISTORICAL_BASE
}

function hasWorkerArtifact(value: Record<string, unknown>): boolean {
	return value.candidate_revision === CURL_REPAIR_CANDIDATE_REVISION &&
		value.candidate_tree === CURL_REPAIR_CANDIDATE_TREE_SHA &&
		value.image_digest === CURL_REPAIR_V2_IMAGE_DIGEST &&
		digest(value.artifact_sha256) &&
		numberInRange(value.artifact_bytes, 1, 200_000_000) &&
		digest(value.worker_recipe_sha256) && value.cleanup_confirmed === true &&
		numberInRange(value.created_at_unix, 1, Number.MAX_SAFE_INTEGER) &&
		digest(value.signature)
}

export function isEvaluatorReceipt(
	value: unknown,
	claim: CurlRepairV2ClaimIdentity,
): value is CurlRepairV2EvaluatorReceipt {
	if (!record(value)) return false
	return hasClaimFields(value, claim) && hasEvaluatorFields(value)
}

function hasClaimFields(
	value: Record<string, unknown>,
	claim: CurlRepairV2ClaimIdentity,
): boolean {
	return value.schema_version === 2 &&
		value.profile === CURL_REPAIR_V2_PROFILE_ID &&
		value.job_id === claim.jobId && value.claim_id === claim.claimId &&
		value.epoch === claim.epoch &&
		value.stage === "candidate-evaluation"
}

function hasEvaluatorFields(value: Record<string, unknown>): boolean {
	return hasEvaluatorCandidate(value) && hasEvaluatorProof(value)
}

function hasEvaluatorCandidate(value: Record<string, unknown>): boolean {
	return value.candidate_revision === CURL_REPAIR_CANDIDATE_REVISION &&
		value.candidate_tree === CURL_REPAIR_CANDIDATE_TREE_SHA &&
		value.image_digest === CURL_REPAIR_V2_IMAGE_DIGEST &&
		JSON.stringify(value.test_ids) === "[3037,3038,5033]" &&
		validResults(value.test_results)
}

function hasEvaluatorProof(value: Record<string, unknown>): boolean {
	return value.sanitizer_clean === true && value.cleanup_confirmed === true &&
		numberInRange(value.created_at_unix, 1, Number.MAX_SAFE_INTEGER) &&
		digest(value.worker_receipt_sha256) &&
		digest(value.candidate_artifact_sha256) &&
		digest(value.container_output_sha256) && digest(value.script_sha256) &&
		digest(value.signature)
}

function validResults(value: unknown): boolean {
	return record(value) && value["3037"] === "pass" &&
		value["3038"] === "pass" && value["5033"] === "pass"
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
}

function digest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function numberInRange(value: unknown, minimum: number,
	maximum: number): value is number {
	return Number.isSafeInteger(value) && Number(value) >= minimum &&
		Number(value) <= maximum
}
