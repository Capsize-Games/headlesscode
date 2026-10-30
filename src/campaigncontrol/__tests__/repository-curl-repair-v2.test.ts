import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
	evaluateCurlHistoricalRepairCandidate,
} from "../repository-curl-repair-evaluator.js"
import {
	evaluateCurlHistoricalRepairV2,
} from "../repository-curl-repair-v2-evaluator.js"
import type {
	CurlRepairV2EvaluatorReceipt,
	CurlRepairV2WorkerReceipt,
} from "../repository-curl-repair-v2-execution.js"
import {
	CURL_REPAIR_V2_CAMPAIGN_ID,
} from "../repository-campaign-ids.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE, CURL_REPAIR_PATCH_SHA256,
	CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_SOURCE_TREE_SHA,
} from "../repository-curl-repair.js"
import {
	CURL_REPAIR_V2_IMAGE_DIGEST, CURL_REPAIR_V2_PROFILE_ID,
	CURL_REPAIR_V2_TEST_IDS, CURL_REPAIR_V2_EVALUATOR_DIGEST,
} from "../repository-curl-repair-v2-profile.js"
import {
	buildCurlHistoricalRepairTestFixture,
} from "./curl-historical-repair-fixture.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const claim = {
	jobId: "11111111-1111-4111-8111-111111111111",
	claimId: "22222222-2222-4222-8222-222222222222",
	epoch: 7,
}
const workerHash = sha256("worker receipt")
const evaluatorHash = sha256("evaluator receipt")
const artifactHash = sha256("candidate archive")

function workerReceipt(): CurlRepairV2WorkerReceipt {
	return { schema_version: 2, profile: CURL_REPAIR_V2_PROFILE_ID,
		job_id: claim.jobId, claim_id: claim.claimId, epoch: claim.epoch,
		stage: "candidate-preparation", source_revision: CURL_REPAIR_SOURCE_REVISION,
		base_revision: CURL_REPAIR_HISTORICAL_BASE,
		candidate_revision: CURL_REPAIR_CANDIDATE_REVISION,
		candidate_tree: CURL_REPAIR_CANDIDATE_TREE_SHA,
		image_digest: CURL_REPAIR_V2_IMAGE_DIGEST, artifact_sha256: artifactHash,
		artifact_bytes: 12, worker_recipe_sha256: sha256("recipe"),
		cleanup_confirmed: true, created_at_unix: 1, signature: sha256("signature") }
}

function evaluatorReceipt(): CurlRepairV2EvaluatorReceipt {
	return { schema_version: 2, profile: CURL_REPAIR_V2_PROFILE_ID,
		job_id: claim.jobId, claim_id: claim.claimId, epoch: claim.epoch,
		stage: "candidate-evaluation",
		candidate_revision: CURL_REPAIR_CANDIDATE_REVISION,
		candidate_tree: CURL_REPAIR_CANDIDATE_TREE_SHA,
		image_digest: CURL_REPAIR_V2_IMAGE_DIGEST, worker_receipt_sha256: workerHash,
		candidate_artifact_sha256: artifactHash, test_ids: [3037, 3038, 5033],
		test_results: { "3037": "pass", "3038": "pass", "5033": "pass" },
		sanitizer_clean: true, cleanup_confirmed: true,
		container_output_sha256: sha256("output"), script_sha256: sha256("script"),
		created_at_unix: 1, signature: sha256("signature") }
}

async function baseReceipt(
	candidate: Awaited<ReturnType<typeof buildCurlHistoricalRepairTestFixture>>,
): Promise<Awaited<ReturnType<typeof evaluateCurlHistoricalRepairCandidate>>> {
	return await evaluateCurlHistoricalRepairCandidate({
		candidate, jobId: claim.jobId,
		buildCandidate: async () => candidate,
		evaluateFixedProof: async () => ({ schemaVersion: 1, accepted: true,
			disposition: "already-fixed",
		evidenceSha256: sha256("proof"),
			reasonCode: "fixed-proof-verified" }) })
}

async function v2EvidenceBindsFreshStagesToPinnedProof(): Promise<void> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	const result = await evaluateCurlHistoricalRepairV2({ candidate,
		...claim,
		worker: { receipt: workerReceipt(), receiptFileSha256: workerHash },
		evaluator: { receipt: evaluatorReceipt(), receiptFileSha256: evaluatorHash },
		evaluateBase: async () => await baseReceipt(candidate) })
	assert.equal(result.disposition, "historical-fix-qualified")
	assert.equal(result.proofMode, "fresh-job-bound-isolated-regression")
	assert.equal(
		result.execution.evaluatorDigest,
		CURL_REPAIR_V2_EVALUATOR_DIGEST,
	)
	assert.deepEqual(result.execution.testIds, CURL_REPAIR_V2_TEST_IDS)
	assert.equal(result.execution.candidateArtifactSha256, artifactHash)
	assert.match(result.evidenceSha256, /^[a-f0-9]{64}$/)
	assert.equal(CURL_REPAIR_V2_CAMPAIGN_ID, "curl-historical-repair-v2")
	assert.equal(candidate.patchSha256, CURL_REPAIR_PATCH_SHA256)
}

async function v2EvidenceRejectsDetachedClaimOrWorkerArtifact(): Promise<void> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	await assert.rejects(evaluateCurlHistoricalRepairV2({
		candidate,
		...claim, claimId: "33333333-3333-4333-8333-333333333333",
		worker: { receipt: workerReceipt(), receiptFileSha256: workerHash },
		evaluator: { receipt: evaluatorReceipt(), receiptFileSha256: evaluatorHash },
		evaluateBase: async () => await baseReceipt(candidate),
	}), /execution receipt bindings are invalid/)
}

async function historicalTreeDoesNotUseReviewedCheckoutTree(): Promise<void> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	assert.equal(candidate.sourceRevision, CURL_REPAIR_HISTORICAL_BASE)
	assert.equal(
		candidate.sourceTreeSha,
		"b1ea31bb7377dd2bfe08fd67af44860de57afc12",
	)
	assert.notEqual(candidate.sourceTreeSha, CURL_REPAIR_SOURCE_TREE_SHA)
	await assert.rejects(evaluateCurlHistoricalRepairCandidate({
		candidate: { ...candidate, sourceTreeSha: CURL_REPAIR_SOURCE_TREE_SHA },
		jobId: claim.jobId,
		buildCandidate: async () => candidate,
		evaluateFixedProof: async () => ({
			schemaVersion: 1, accepted: true, disposition: "already-fixed",
			evidenceSha256: sha256("proof"), reasonCode: "fixed-proof-verified",
		}),
	}), /does not match the clean pinned checkout/)
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}

const tests: readonly SuiteTest[] = [
	[
		"v2 receipt binds fresh isolated regression stages to the pinned proof",
		v2EvidenceBindsFreshStagesToPinnedProof,
	],
	[
		"v2 receipt rejects detached claim and worker artifact",
		v2EvidenceRejectsDetachedClaimOrWorkerArtifact,
	],
	[
		"historical source tree stays distinct from the reviewed checkout tree",
		historicalTreeDoesNotUseReviewedCheckoutTree,
	],
]

await runMain("repository-curl-repair-v2", tests)
