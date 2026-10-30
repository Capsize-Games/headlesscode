import type { CURL_REPAIR_V2_IMAGE_DIGEST, CURL_REPAIR_V2_PROFILE_ID } from "./repository-curl-repair-v2-profile.js"
import type { CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_SOURCE_REVISION } from "./repository-curl-repair.js"

export interface CurlRepairV2ClaimIdentity {
	jobId: string
	claimId: string
	epoch: number
}

export interface CurlRepairV2StageReceipt<T> {
	receipt: T
	receiptFileSha256: string
}

export interface CurlRepairV2WorkerReceipt {
	schema_version: 2
	profile: typeof CURL_REPAIR_V2_PROFILE_ID
	job_id: string
	claim_id: string
	epoch: number
	stage: "candidate-preparation"
	source_revision: typeof CURL_REPAIR_SOURCE_REVISION
	base_revision: string
	candidate_revision: typeof CURL_REPAIR_CANDIDATE_REVISION
	candidate_tree: typeof CURL_REPAIR_CANDIDATE_TREE_SHA
	image_digest: typeof CURL_REPAIR_V2_IMAGE_DIGEST
	artifact_sha256: string
	artifact_bytes: number
	worker_recipe_sha256: string
	cleanup_confirmed: true
	created_at_unix: number
	signature: string
}

export interface CurlRepairV2EvaluatorReceipt {
	schema_version: 2
	profile: typeof CURL_REPAIR_V2_PROFILE_ID
	job_id: string
	claim_id: string
	epoch: number
	stage: "candidate-evaluation"
	candidate_revision: typeof CURL_REPAIR_CANDIDATE_REVISION
	candidate_tree: typeof CURL_REPAIR_CANDIDATE_TREE_SHA
	image_digest: typeof CURL_REPAIR_V2_IMAGE_DIGEST
	worker_receipt_sha256: string
	candidate_artifact_sha256: string
	test_ids: [3037, 3038, 5033]
	test_results: { "3037": "pass"; "3038": "pass"; "5033": "pass" }
	sanitizer_clean: true
	cleanup_confirmed: true
	container_output_sha256: string
	script_sha256: string
	created_at_unix: number
	signature: string
}
