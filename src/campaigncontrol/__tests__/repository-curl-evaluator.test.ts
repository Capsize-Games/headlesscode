import assert from "node:assert/strict"
import { CURL_CANDIDATE_TREE_SHA, CURL_PRIVATE_SOURCE_REVISION,
	CURL_FIXED_ADVISORY, CURL_PROFILE_ID,
		makeCurlProtectedEvaluationRequest } from "../repository-curl-evaluator.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

async function testCoreBuildsOnlyThePinnedFixedCurlEvaluationRequest(): Promise<void> {
	const request = makeCurlProtectedEvaluationRequest({ campaignId: "curl-maintenance", jobId: "fixture-job-1",
		advisoryId: CURL_FIXED_ADVISORY,
			candidateRevision: CURL_PRIVATE_SOURCE_REVISION,
				candidateTreeSha: CURL_CANDIDATE_TREE_SHA })
	assert.equal(request.profileId, CURL_PROFILE_ID)
	assert.equal(request.sourceRevision, CURL_PRIVATE_SOURCE_REVISION)
	assert.equal(request.candidateRevision, CURL_PRIVATE_SOURCE_REVISION)
	assert.equal(request.candidateTreeSha, CURL_CANDIDATE_TREE_SHA)
	assert.match(request.candidateSha256, /^[a-f0-9]{64}$/)
	assert.equal(request.patchSha256.length, 64)
	assert.equal(request.proofEvidenceSha256.length, 64)
	assert.equal(request.receiptSha256.length, 64)
	assert.equal(request.artifactManifestSha256.length, 64)
}

async function testCoreRefusesUnsupportedAdvisoriesAndCandidateRevisionsBeforeBridge(): Promise<void> {
	assert.throws(() => makeCurlProtectedEvaluationRequest({ campaignId: "curl-maintenance", jobId: "fixture-job-2",
		advisoryId: "CVE-2026-118370",
			candidateRevision: CURL_PRIVATE_SOURCE_REVISION,
				candidateTreeSha: CURL_CANDIDATE_TREE_SHA }), /outside the pinned/)
	assert.throws(() => makeCurlProtectedEvaluationRequest({ campaignId: "curl-maintenance", jobId: "fixture-job-3",
		advisoryId: CURL_FIXED_ADVISORY, candidateRevision: "d".repeat(40),
			candidateTreeSha: CURL_CANDIDATE_TREE_SHA }), /outside the pinned/)
}

const tests: readonly SuiteTest[] = [
	["Core emits only the pinned already-fixed Curl evaluator identity",
		testCoreBuildsOnlyThePinnedFixedCurlEvaluationRequest],
	["Core rejects unrelated advisory and source candidate identities before evaluator launch", testCoreRefusesUnsupportedAdvisoriesAndCandidateRevisionsBeforeBridge],
]

await runMain("repository-curl-evaluator", tests)
