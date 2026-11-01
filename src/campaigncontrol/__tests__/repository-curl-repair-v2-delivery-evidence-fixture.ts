import { createHash } from "node:crypto"
import { evaluateCurlHistoricalRepairCandidate } from
	"../repository-curl-repair-evaluator.js"
import { evaluateCurlHistoricalRepairV2 } from
	"../repository-curl-repair-v2-evaluator.js"
import type { CurlRepairV2DeliveryInput } from
	"../repository-curl-repair-v2-delivery-validation.js"
import type { DeliveryFixture } from
	"./repository-curl-repair-v2-delivery-test-support.js"
import type { ClaimedRepositoryJob } from "../repository-campaigns.js"
import type {
	CurlHistoricalRepairCandidate,
} from "../repository-curl-repair.js"
import type { CurlHistoricalRepairV2Receipt } from
	"../repository-curl-repair-v2-evaluator.js"
import type {
	CurlRepairV2EvaluatorReceipt, CurlRepairV2WorkerReceipt,
} from "../repository-curl-repair-v2-execution.js"
import type { CurlRepairV2StageReceipt } from
	"../repository-curl-repair-v2-receipt-types.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE, CURL_REPAIR_SOURCE_REVISION,
	curlHistoricalRepairCandidateSha256,
} from "../repository-curl-repair.js"
import { CURL_FIXED_ADVISORY } from "../repository-curl-evaluator.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "../repository-campaign-ids.js"
import {
	CURL_REPAIR_V2_IMAGE_DIGEST, CURL_REPAIR_V2_POLICY,
	CURL_REPAIR_V2_POLICY_SHA256, CURL_REPAIR_V2_PROFILE_ID,
} from "../repository-curl-repair-v2-profile.js"
import { buildCurlHistoricalRepairTestFixture } from
	"./curl-historical-repair-fixture.js"

const jobId = "11111111-1111-4111-8111-111111111111"
const claimId = "22222222-2222-4222-8222-222222222222"
const epoch = 7

export async function makeDeliveryFixture(): Promise<DeliveryFixture> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	const inputClaim = makeClaim()
	const worker = makeWorker()
	const evaluator = makeEvaluator()
	const workerStage = { receipt: worker, receiptFileSha256: sha256("worker") }
	const evaluatorStage = {
		receipt: evaluator,
		receiptFileSha256: sha256("evaluator"),
	}
	const receipt = await makeReceipt(candidate, workerStage, evaluatorStage)
	const candidateSha256 = curlHistoricalRepairCandidateSha256(candidate)
	const input = makeInput({ claim: inputClaim, candidateSha256, candidate,
		receipt, worker: workerStage, evaluator: evaluatorStage })
	return { input, workerStage, evaluatorStage }
}

function makeClaim(): ClaimedRepositoryJob {
	return {
		job: { id: jobId, campaignId: CURL_REPAIR_V2_CAMPAIGN_ID,
			advisoryId: CURL_FIXED_ADVISORY, status: "running" as const,
			epoch, createdAt: 1, updatedAt: 1, month: "2026-10",
			reservedMicros: 0, settledMicros: 0, reservedTokens: 0,
			settledTokens: 0, purpose: "repair" as const },
		claimId, epoch,
	}
}

async function makeReceipt(
	candidate: CurlHistoricalRepairCandidate,
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>,
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>,
): Promise<CurlHistoricalRepairV2Receipt> {
	return await evaluateCurlHistoricalRepairV2({
		candidate, jobId, claimId, epoch, worker, evaluator,
		evaluateBase: async () => await evaluateCurlHistoricalRepairCandidate({
			candidate, jobId,
			buildCandidate: async () => candidate,
		evaluateFixedProof: async () => ({ schemaVersion: 1, accepted: true,
			disposition: "already-fixed", evidenceSha256: sha256("proof"),
			reasonCode: "fixed-proof-verified" }),
		}),
	})
}

function makeInput(args: {
	claim: ClaimedRepositoryJob,
	candidateSha256: string,
	candidate: CurlHistoricalRepairCandidate,
	receipt: CurlHistoricalRepairV2Receipt,
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>,
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>,
}): CurlRepairV2DeliveryInput {
	const { claim, candidateSha256, candidate, receipt, worker, evaluator } = args
	return {
		definition: makeDefinition(),
		claim, candidateSha256,
		verification: { passed: true, evidenceSha256: receipt.evidenceSha256,
			detail: "historical-fix-qualified",
			historicalRepairV2: { candidate, receipt, worker, evaluator } },
		signal: new AbortController().signal,
	}
}

function makeDefinition(): CurlRepairV2DeliveryInput["definition"] {
	return {
		id: CURL_REPAIR_V2_CAMPAIGN_ID, name: "test",
		repositoryId: "curl-maintenance-repair-v2",
		repository: "Capsize-Games/curl-maintenance",
		sourceRevision: CURL_REPAIR_SOURCE_REVISION,
		policySha256: CURL_REPAIR_V2_POLICY_SHA256,
		workerProfile: CURL_REPAIR_V2_PROFILE_ID,
		recipeDigest: CURL_REPAIR_V2_POLICY.recipeDigest,
		evaluatorDigest: CURL_REPAIR_V2_POLICY.evaluatorDigest,
		model: "none", dataAccessProfile: CURL_REPAIR_V2_POLICY.accessProfile,
		qualification: { sourceAudited: true, workerQualified: true,
			recipeQualified: true, evaluatorQualified: true, modelApproved: true,
			dataApproved: true, accessApproved: true },
	}
}

function makeWorker(): CurlRepairV2WorkerReceipt {
	return { schema_version: 2, profile: CURL_REPAIR_V2_PROFILE_ID,
		job_id: jobId, claim_id: claimId, epoch, stage: "candidate-preparation",
		source_revision: CURL_REPAIR_SOURCE_REVISION,
		base_revision: CURL_REPAIR_HISTORICAL_BASE,
		candidate_revision: CURL_REPAIR_CANDIDATE_REVISION,
		candidate_tree: CURL_REPAIR_CANDIDATE_TREE_SHA,
		image_digest: CURL_REPAIR_V2_IMAGE_DIGEST, artifact_sha256: sha256("archive"),
		artifact_bytes: 12, worker_recipe_sha256: sha256("recipe"),
		cleanup_confirmed: true, created_at_unix: Math.floor(Date.now() / 1000),
		signature: sha256("worker-signature") }
}

function makeEvaluator(): CurlRepairV2EvaluatorReceipt {
	const artifact = sha256("archive")
	return { schema_version: 2, profile: CURL_REPAIR_V2_PROFILE_ID,
		job_id: jobId, claim_id: claimId, epoch, stage: "candidate-evaluation",
		candidate_revision: CURL_REPAIR_CANDIDATE_REVISION,
		candidate_tree: CURL_REPAIR_CANDIDATE_TREE_SHA,
		image_digest: CURL_REPAIR_V2_IMAGE_DIGEST,
		worker_receipt_sha256: sha256("worker"),
		candidate_artifact_sha256: artifact, test_ids: [3037, 3038, 5033],
		test_results: { "3037": "pass", "3038": "pass", "5033": "pass" },
		sanitizer_clean: true, cleanup_confirmed: true,
		container_output_sha256: sha256("output"), script_sha256: sha256("script"),
		created_at_unix: Math.floor(Date.now() / 1000),
		signature: sha256("evaluator-signature") }
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}
