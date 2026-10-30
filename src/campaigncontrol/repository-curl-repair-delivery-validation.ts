import * as deliveryModel from "./repository-curl-repair-delivery-model.js"
import * as repairPin from "./repository-curl-repair.js"
import * as evaluator from "./repository-curl-repair-evaluator.js"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import { isDigest, isSha } from "./repository-curl-repair-delivery-store.js"
import {
	canonical,
	sha256,
} from "./repository-curl-repair-delivery-primitives.js"

type Candidate = repairPin.CurlHistoricalRepairCandidate
type Receipt = evaluator.CurlHistoricalRepairReceipt
type DeliveryInput = deliveryModel.CurlRepairDeliveryInput
type DeliveryIdentity = deliveryModel.DeliveryIdentity
const maxPatchBytes = deliveryModel.MAX_PATCH_BYTES

export function validateInput(input: DeliveryInput): DeliveryIdentity {
	assertDeliveryInput(input)
	return makeDeliveryIdentity(
		input,
		input.claim.job.id,
		input.receipt.evidenceSha256,
	)
}

function assertDeliveryInput(input: DeliveryInput): void {
	const claim = input?.claim
	const candidate = input?.candidate
	const receipt = input?.receipt
	if (
		!claim ||
		!candidate ||
		!receipt ||
		!isValidClaim(claim) ||
		!isValidCandidate(candidate) ||
		!isValidReceipt(receipt, candidate)
	) {
		throw new Error(
			"Curl repair delivery input is outside its compiled claim, source, " +
				"artifact and receipt bounds",
		)
	}
	assertPatchEncoding(candidate)
}

function assertPatchEncoding(candidate: Candidate): void {
	const patch = Buffer.from(candidate.patchBase64, "base64")
	if (
		patch.length !== candidate.patchBytes ||
		patch.toString("base64") !== candidate.patchBase64
	)
		throw new Error("Curl repair source patch encoding is invalid")
}

function makeDeliveryIdentity(
	input: DeliveryInput,
	jobId: string,
	receiptSha256: string,
): DeliveryIdentity {
	const claim = input.claim
	const candidate = input.candidate
	const identitySha256 = identityDigest(input, jobId, receiptSha256)
	return {
		jobId,
		patchSha256: candidate.patchSha256,
		receiptSha256,
		identitySha256,
		key: deliveryKey(claim, jobId, candidate.patchSha256),
	}
}

function identityDigest(
	input: DeliveryInput,
	jobId: string,
	receiptSha256: string,
): string {
	const { claim, candidate } = input
	return sha256(
		canonical(identityPayload(claim, candidate, jobId, receiptSha256)),
	)
}

function identityPayload(
	claim: deliveryModel.CurlRepairClaim,
	candidate: Candidate,
	jobId: string,
	receiptSha256: string,
): Record<string, unknown> {
	return {
		...claimIdentityFields(claim, jobId),
		...candidateIdentityFields(candidate, receiptSha256),
	}
}

function claimIdentityFields(
	claim: deliveryModel.CurlRepairClaim,
	jobId: string,
): Record<string, unknown> {
	return {
		campaignId: claim.job.campaignId,
		jobId,
		advisoryId: claim.job.advisoryId,
		claimId: claim.claimId,
		epoch: claim.epoch,
	}
}

function candidateIdentityFields(
	candidate: Candidate,
	receiptSha256: string,
): Record<string, unknown> {
	return {
		sourceRevision: candidate.sourceRevision,
		candidateRevision: candidate.candidateRevision,
		candidateTreeSha: candidate.candidateTreeSha,
		patchSha256: candidate.patchSha256,
		envelopeSha256: candidate.sourceEnvelopeSha256,
		artifactManifestSha256: candidate.artifactManifestSha256,
		receiptSha256,
	}
}

function deliveryKey(
	claim: deliveryModel.CurlRepairClaim,
	jobId: string,
	patchSha256: string,
): string {
	return sha256(
		`${claim.job.campaignId}:${jobId}:${claim.claimId}:` +
			`${claim.epoch}:${patchSha256}`,
	)
}

function isValidClaim(claim: deliveryModel.CurlRepairClaim): boolean {
	return (
		claim.claimId === claim.claimId.toLowerCase() &&
		/^[a-f0-9-]{36}$/.test(claim.claimId) &&
		Number.isSafeInteger(claim.epoch) &&
		claim.epoch >= 1 &&
		claim.job?.campaignId === "curl-historical-repair" &&
		claim.job.advisoryId === CURL_FIXED_ADVISORY &&
		/^[a-z0-9][a-z0-9._-]{0,95}$/.test(claim.job.id) &&
		claim.job.epoch === claim.epoch &&
		claim.job.status === "running"
	)
}

function isValidCandidate(candidate: Candidate): boolean {
	return (
		isExpectedCandidateSource(candidate) &&
		isExpectedCandidatePatch(candidate) &&
		isValidCandidateProof(candidate)
	)
}

function isExpectedCandidateSource(candidate: Candidate): boolean {
	return (
		candidate.sourceRepository ===
			repairPin.CURL_REPAIR_TARGET_REPOSITORY &&
		candidate.sourceRevision === repairPin.CURL_REPAIR_HISTORICAL_BASE &&
		candidate.sourceTreeSha === "b1ea31bb7377dd2bfe08fd67af44860de57afc12"
	)
}

function isExpectedCandidatePatch(candidate: Candidate): boolean {
	return (
		candidate.candidateRevision ===
			repairPin.CURL_REPAIR_CANDIDATE_REVISION &&
		candidate.candidateTreeSha ===
			repairPin.CURL_REPAIR_CANDIDATE_TREE_SHA &&
		candidate.patchPath === repairPin.CURL_REPAIR_PATCH_PATH &&
		candidate.patchSha256 === repairPin.CURL_REPAIR_PATCH_SHA256
	)
}

function isValidCandidateProof(candidate: Candidate): boolean {
	return (
		Number.isSafeInteger(candidate.patchBytes) &&
		candidate.patchBytes >= 1 &&
		candidate.patchBytes <= maxPatchBytes &&
		typeof candidate.patchBase64 === "string" &&
		candidate.patchBase64.length <= Math.ceil((maxPatchBytes * 4) / 3) &&
		isDigest(candidate.sourceEnvelopeSha256) &&
		isDigest(candidate.artifactManifestSha256)
	)
}

function isValidReceipt(receipt: Receipt, candidate: Candidate): boolean {
	return (
		isDigest(receipt.evidenceSha256) &&
		receipt.profileId === repairPin.CURL_REPAIR_PROFILE_ID &&
		receipt.sourceRevision === candidate.sourceRevision &&
		receipt.sourceTreeSha === candidate.sourceTreeSha &&
		receipt.candidateRevision === candidate.candidateRevision &&
		receipt.candidateTreeSha === candidate.candidateTreeSha &&
		receipt.patchSha256 === candidate.patchSha256 &&
		receipt.sourceEnvelopeSha256 === candidate.sourceEnvelopeSha256 &&
		receipt.artifactManifestSha256 === candidate.artifactManifestSha256 &&
		receipt.protectedProof?.evaluatorDigest ===
			repairPin.CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST
	)
}

import { FixedCurlGitAdapter } from "./repository-curl-repair-delivery-git.js"
export { FixedCurlGitAdapter } from "./repository-curl-repair-delivery-git.js"

import {
	FixedCurlGitHubAdapter,
	matchesPullRequest,
	repairPullRequestBody,
	repairPullRequestTitle,
} from "./repository-curl-repair-delivery-github.js"
export {
	FixedCurlGitHubAdapter,
} from "./repository-curl-repair-delivery-github.js"
