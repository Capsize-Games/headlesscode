import type { CurlPrivateDeliveryInput } from
	"./repository-curl-private-types.js"
import { isDigest, isUuid } from "./repository-curl-private-guards.js"
import { CURL_CAMPAIGN_ID, CURL_FIXED_ADVISORY, CURL_PRIVATE_SOURCE_REVISION,
	CURL_CANDIDATE_TREE_SHA } from "./repository-curl-evaluator.js"

export function assertDeliveryInput(input: CurlPrivateDeliveryInput): void {
	assertCampaignInput(input)
	assertClaimInput(input)
	assertEvidenceInput(input)
	assertSourceInput(input)
}

function assertCampaignInput(input: CurlPrivateDeliveryInput): void {
	if (input.campaignId !== CURL_CAMPAIGN_ID ||
		input.advisoryId !== CURL_FIXED_ADVISORY) {
		throw new Error("private Curl delivery record is invalid")
	}
}

function assertClaimInput(input: CurlPrivateDeliveryInput): void {
	if (!isUuid(input.jobId) || !isUuid(input.claimId) ||
		!Number.isSafeInteger(input.epoch) || input.epoch < 1) {
		throw new Error("private Curl delivery record is invalid")
	}
}

function assertEvidenceInput(input: CurlPrivateDeliveryInput): void {
	if (!isDigest(input.candidateSha256) || !isDigest(input.verificationSha256) ||
		input.disposition !== "already-fixed") {
		throw new Error("private Curl delivery record is invalid")
	}
}

function assertSourceInput(input: CurlPrivateDeliveryInput): void {
	if (input.sourceRevision !== CURL_PRIVATE_SOURCE_REVISION ||
		input.sourceTreeSha256 !== CURL_CANDIDATE_TREE_SHA) {
		throw new Error("private Curl delivery record is invalid")
	}
}
