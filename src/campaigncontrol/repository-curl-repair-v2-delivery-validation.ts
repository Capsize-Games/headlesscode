import { createHash } from "node:crypto"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import type { ClaimedRepositoryJob, RepositoryCampaignDefinition } from
	"./repository-campaigns.js"
import type { CurlHistoricalRepairCandidate } from
	"./repository-curl-repair.js"
import { curlHistoricalRepairCandidateSha256,
	curlRepairSourceEnvelopeSha256, CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_CANDIDATE_TREE_SHA, CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_PATH, CURL_REPAIR_PATCH_SHA256,
	CURL_REPAIR_PROFILE_ID, CURL_REPAIR_SOURCE_REVISION,
	CURL_REPAIR_TARGET_REPOSITORY } from
	"./repository-curl-repair.js"
import type { CurlHistoricalRepairV2Receipt } from
	"./repository-curl-repair-v2-evaluator.js"
import type {
	CurlRepairV2EvaluatorReceipt,
	CurlRepairV2StageReceipt,
	CurlRepairV2WorkerReceipt,
} from "./repository-curl-repair-v2-execution.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from
	"./repository-campaign-ids.js"
import {
	CURL_REPAIR_V2_ACCESS_PROFILE,
	CURL_REPAIR_V2_EVALUATOR_DIGEST,
	CURL_REPAIR_V2_MODEL,
	CURL_REPAIR_V2_POLICY_SHA256,
	CURL_REPAIR_V2_PROFILE_ID,
	CURL_REPAIR_V2_RECIPE_DIGEST,
	CURL_REPAIR_V2_REPOSITORY_ID,
} from "./repository-curl-repair-v2-profile.js"

const CURL_REPAIR_HISTORICAL_BASE_TREE_SHA =
	"b1ea31bb7377dd2bfe08fd67af44860de57afc12"

export interface CurlRepairV2DeliveryInput {
	definition: RepositoryCampaignDefinition
	claim: ClaimedRepositoryJob
	candidateSha256: string
	verification: {
		passed: boolean
		evidenceSha256: string
		detail: string
		historicalRepairV2?: {
			candidate: CurlHistoricalRepairCandidate
			receipt: CurlHistoricalRepairV2Receipt
			worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
			evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
		}
	}
	signal: AbortSignal
}

export function assertV2DeliveryInput(input: CurlRepairV2DeliveryInput): {
	candidate: CurlHistoricalRepairCandidate
	receipt: CurlHistoricalRepairV2Receipt
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
} {
	const metadata = input.verification.historicalRepairV2
	assertDeliveryEnvelope(input, metadata)
	if (!metadata) throw new Error("Curl v2 delivery metadata is missing")
	assertCandidate(metadata.candidate, input.candidateSha256)
	assertReceipt({ metadata, input })
	return metadata
}

function assertDeliveryEnvelope(
	input: CurlRepairV2DeliveryInput,
	metadata: CurlRepairV2DeliveryInput["verification"]["historicalRepairV2"],
): void {
	assertDefinition(input.definition)
	assertClaim(input.claim)
	const verification = input.verification
	if (!verification.passed ||
		verification.detail !== "historical-fix-qualified" ||
		!isDigest(verification.evidenceSha256) || !metadata) {
		throw new Error(
			"Curl v2 delivery requires verified historical repair evidence",
		)
	}
}

function assertDefinition(definition: RepositoryCampaignDefinition): void {
	if (!definitionPinsMatch(definition) ||
		!Object.values(definition.qualification).every(Boolean)) {
		throw new Error(
			"Curl v2 delivery definition differs from the compiled policy",
		)
	}
}

function definitionPinsMatch(
	definition: RepositoryCampaignDefinition,
): boolean {
	return definition.id === CURL_REPAIR_V2_CAMPAIGN_ID &&
		definition.repositoryId === CURL_REPAIR_V2_REPOSITORY_ID &&
		definition.repository === CURL_REPAIR_TARGET_REPOSITORY &&
		definition.sourceRevision === CURL_REPAIR_SOURCE_REVISION &&
		definition.policySha256 === CURL_REPAIR_V2_POLICY_SHA256 &&
		definition.workerProfile === CURL_REPAIR_V2_PROFILE_ID &&
		definition.recipeDigest === CURL_REPAIR_V2_RECIPE_DIGEST &&
		definition.evaluatorDigest === CURL_REPAIR_V2_EVALUATOR_DIGEST &&
		definition.model === CURL_REPAIR_V2_MODEL &&
		definition.dataAccessProfile === CURL_REPAIR_V2_ACCESS_PROFILE
}

function claimIdentityMatches(claim: ClaimedRepositoryJob): boolean {
	return isUuid(claim.claimId) && Number.isSafeInteger(claim.epoch) &&
		claim.epoch >= 1 && isUuid(claim.job?.id)
}

function claimJobMatches(claim: ClaimedRepositoryJob): boolean {
	const job = claim.job
	return job.campaignId === CURL_REPAIR_V2_CAMPAIGN_ID &&
		job.advisoryId === CURL_FIXED_ADVISORY && job.purpose === "repair" &&
		job.status === "running" && job.epoch === claim.epoch
}

function assertClaim(claim: ClaimedRepositoryJob): void {
	if (!claim || !claimIdentityMatches(claim) || !claimJobMatches(claim)) {
		throw new Error("Curl v2 delivery claim is stale or outside its policy")
	}
}

function assertCandidate(
	candidate: CurlHistoricalRepairCandidate,
	sha256: string,
): void {
	assertCandidatePins(candidate, sha256)
	assertCandidatePatch(candidate)
}

function assertCandidatePins(
	candidate: CurlHistoricalRepairCandidate,
	sha256: string,
): void {
	const failed = [
		candidate.sourceRepository !== CURL_REPAIR_TARGET_REPOSITORY,
		candidate.sourceRevision !== CURL_REPAIR_HISTORICAL_BASE,
		candidate.candidateRevision !== CURL_REPAIR_CANDIDATE_REVISION,
		candidate.candidateTreeSha !== CURL_REPAIR_CANDIDATE_TREE_SHA,
		candidate.patchPath !== CURL_REPAIR_PATCH_PATH,
		candidate.patchSha256 !== CURL_REPAIR_PATCH_SHA256,
		candidate.sourceEnvelopeSha256 !== curlRepairSourceEnvelopeSha256(),
		candidate.sourceTreeSha !== CURL_REPAIR_HISTORICAL_BASE_TREE_SHA,
		!isDigest(candidate.artifactManifestSha256),
		!isDigest(sha256),
		curlHistoricalRepairCandidateSha256(candidate) !== sha256,
	]
	if (failed.some(Boolean)) throw new Error("Curl v2 candidate pins differ")
}

function assertCandidatePatch(candidate: CurlHistoricalRepairCandidate): void {
	const patch = Buffer.from(candidate.patchBase64, "base64")
	const invalidSize = candidate.patchBytes < 1 ||
		candidate.patchBytes > 2_000_000 || patch.length !== candidate.patchBytes
	const invalidEncoding = patch.toString("base64") !== candidate.patchBase64
	const actualSha = createHash("sha256").update(patch).digest("hex")
	if (invalidSize || invalidEncoding || actualSha !== CURL_REPAIR_PATCH_SHA256) {
		throw new Error("Curl v2 patch differs from its compiled source pin")
	}
}

function assertReceipt(args: {
	metadata: NonNullable<
		CurlRepairV2DeliveryInput["verification"]["historicalRepairV2"]>
	input: CurlRepairV2DeliveryInput
}): void {
	const { metadata, input } = args
	assertReceiptCandidate(metadata.receipt, metadata.candidate)
	assertReceiptExecution(metadata.receipt, input.claim, metadata)
	if (metadata.receipt.evidenceSha256 !== input.verification.evidenceSha256) {
		throw new Error("Curl v2 aggregate evidence digest differs")
	}
}

function assertReceiptCandidate(
	receipt: CurlHistoricalRepairV2Receipt,
	candidate: CurlHistoricalRepairCandidate,
): void {
	if (!receiptHeaderMatches(receipt) ||
		!receiptCandidateMatches(receipt, candidate)) {
		throw new Error("Curl v2 aggregate receipt differs from its candidate")
	}
}

function receiptHeaderMatches(receipt: CurlHistoricalRepairV2Receipt): boolean {
	return receipt.schemaVersion === 2 &&
		receipt.disposition === "historical-fix-qualified" &&
		receipt.proofMode === "fresh-job-bound-isolated-regression" &&
		receipt.scope === "historical-public-regression-only" &&
		receipt.advisoryId === CURL_FIXED_ADVISORY &&
		receipt.profileId === CURL_REPAIR_PROFILE_ID
}

function receiptCandidateMatches(
	receipt: CurlHistoricalRepairV2Receipt,
	candidate: CurlHistoricalRepairCandidate,
): boolean {
	return receipt.sourceRevision === candidate.sourceRevision &&
		receipt.sourceTreeSha === candidate.sourceTreeSha &&
		receipt.candidateRevision === candidate.candidateRevision &&
		receipt.candidateTreeSha === candidate.candidateTreeSha &&
		receipt.patchSha256 === candidate.patchSha256 &&
		receipt.sourceEnvelopeSha256 === candidate.sourceEnvelopeSha256 &&
		receipt.artifactManifestSha256 === candidate.artifactManifestSha256
}

function assertReceiptExecution(
	receipt: CurlHistoricalRepairV2Receipt,
	claim: ClaimedRepositoryJob,
	metadata: NonNullable<
		CurlRepairV2DeliveryInput["verification"]["historicalRepairV2"]>,
): void {
	const execution = receipt.execution
	if (execution.profileId !== CURL_REPAIR_V2_PROFILE_ID ||
		execution.evaluatorDigest !== CURL_REPAIR_V2_EVALUATOR_DIGEST ||
		execution.jobId !== claim.job.id ||
		execution.claimId !== claim.claimId || execution.epoch !== claim.epoch ||
		execution.workerReceiptSha256 !== metadata.worker.receiptFileSha256 ||
		execution.evaluatorReceiptSha256 !==
			metadata.evaluator.receiptFileSha256 ||
		!execution.sanitizerClean || !execution.cleanupConfirmed) {
		throw new Error("Curl v2 aggregate receipt is not bound to this job")
	}
}

function isUuid(value: unknown): value is string {
	return typeof value === "string" &&
		/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}
