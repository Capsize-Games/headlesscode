import assert from "node:assert/strict"
import { CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE, CURL_REPAIR_PATCH_SHA256, CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
	CURL_REPAIR_PROFILE_ID, CURL_REPAIR_SOURCE_REVISION } from "../repository-curl-repair.js"
import { evaluateCurlHistoricalRepairCandidate } from "../repository-curl-repair-evaluator.js"
import { createCurlHistoricalRepairAdapters } from "../repository-curl-repair-runtime.js"
import { createRepositoryWorkerPipeline } from "../repository-worker-pipeline.js"
import { CURL_REPAIR_ADAPTER_ID, CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_EVALUATOR_DIGEST,
	CURL_REPAIR_POLICY_SHA256, CURL_REPAIR_RECIPE_DIGEST,
	CURL_REPAIR_REPOSITORY_ID, CURL_REPAIR_RESERVATION,
	CURL_REPAIR_TARGET_REPOSITORY, CURL_REPAIR_PROTECTED_PROFILE } from "../repository-curl-repair.js"
import { CURL_FIXED_ADVISORY } from "../repository-curl-evaluator.js"
import type { RepositoryCampaignDefinition, ClaimedRepositoryJob, RepositoryCampaignStore } from "../repository-campaigns.js"
import type { RepositoryWorkerRegistration } from "../repository-worker-registration.js"
import type { SuiteTest } from "../../test-runner.js"
import { runMain } from "../../test-runner.js"
import { buildCurlHistoricalRepairTestFixture, makeCurlDebianAdvisoryTestFixture } from "./curl-historical-repair-fixture.js"

async function offlineFixtureEncodesThePinnedHistoricalSourcePatch(): Promise<void> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	assert.equal(candidate.sourceRevision, CURL_REPAIR_HISTORICAL_BASE)
	assert.equal(candidate.candidateRevision, CURL_REPAIR_CANDIDATE_REVISION)
	assert.equal(candidate.candidateTreeSha, CURL_REPAIR_CANDIDATE_TREE_SHA)
	assert.equal(candidate.patchSha256, CURL_REPAIR_PATCH_SHA256)
	assert.equal(Buffer.from(candidate.patchBase64, "base64").length, candidate.patchBytes)
	assert.ok(candidate.sourceEnvelopeSha256.match(/^[a-f0-9]{64}$/))
	assert.ok(candidate.artifactManifestSha256.match(/^[a-f0-9]{64}$/))
	assert.deepEqual(candidate.protectedProof.phases,
		["historical_base-red", "reference_fix-green", "fork_head-green", "candidate-green"])
}

async function historicalReceiptRequiresAnAcceptedProtectedProofAdapter(): Promise<void> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	let receivedCandidateRevision = ""
	let calls = 0
	const receipt = await evaluateCurlHistoricalRepairCandidate({ candidate, jobId: "repair-fixture-001",
		buildCandidate: async () => candidate,
		evaluateFixedProof: async (request) => {
			calls += 1
			receivedCandidateRevision = request.candidateRevision
			return { schemaVersion: 1, accepted: true, disposition: "already-fixed",
				evidenceSha256: "a".repeat(64), reasonCode: "fixed-proof-verified" }
		} })
	assert.equal(calls, 1)
	assert.equal(receivedCandidateRevision, CURL_REPAIR_SOURCE_REVISION)
	assert.equal(receipt.disposition, "historical-fix-qualified")
	assert.equal(receipt.proofMode, "reused-signed-offline-phase-evidence")
	assert.equal(receipt.scope, "historical-public-regression-only")
	assert.equal(receipt.sourceRevision, CURL_REPAIR_HISTORICAL_BASE)
	assert.equal(receipt.candidateRevision, CURL_REPAIR_CANDIDATE_REVISION)
	assert.equal(receipt.protectedProof.evidenceSha256, CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256)
	assert.match(receipt.evidenceSha256, /^[a-f0-9]{64}$/)
	await assert.rejects(evaluateCurlHistoricalRepairCandidate({ candidate, jobId: "repair-fixture-002",
		buildCandidate: async () => candidate,
		evaluateFixedProof: async () => ({ schemaVersion: 1, accepted: false, disposition: "blocked",
			evidenceSha256: "b".repeat(64), reasonCode: "proof-invalid" }) }), /independently verified fixed regression proof/)
}

async function rejectedProofReportsItsDisposition(): Promise<void> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	await assert.rejects(evaluateCurlHistoricalRepairCandidate({
		candidate, jobId: "repair-fixture-004",
		buildCandidate: async () => candidate,
		evaluateFixedProof: async () => ({ schemaVersion: 1,
			accepted: false, disposition: "blocked",
			evidenceSha256: "b".repeat(64),
			reasonCode: "proof-invalid" }),
	}), /fixed regression proof \(blocked\/proof-invalid\)/)
}

async function alteredPatchCannotBorrowProtectedProof(): Promise<void> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	let calls = 0
	const altered = { ...candidate, patchBase64: Buffer.from("not the reviewed patch").toString("base64") }
	await assert.rejects(evaluateCurlHistoricalRepairCandidate({ candidate: altered, jobId: "repair-fixture-003",
		buildCandidate: async () => candidate,
		evaluateFixedProof: async () => {
			calls += 1
			return { schemaVersion: 1, accepted: true, disposition: "already-fixed",
				evidenceSha256: "c".repeat(64), reasonCode: "fixed-proof-verified" }
		} }), /outside the compiled profile|does not match the clean pinned checkout/)
	assert.equal(calls, 0)
}

async function syntheticRepairPipelineNeverStartsAModelWorker(): Promise<void> {
	const calls: string[] = []
	const candidate = await buildCurlHistoricalRepairTestFixture()
	const definition: RepositoryCampaignDefinition = { id: CURL_REPAIR_CAMPAIGN_ID, name: "Historical Curl repair",
		repositoryId: CURL_REPAIR_REPOSITORY_ID, repository: CURL_REPAIR_TARGET_REPOSITORY,
		sourceRevision: CURL_REPAIR_SOURCE_REVISION, policySha256: CURL_REPAIR_POLICY_SHA256,
		workerProfile: CURL_REPAIR_PROFILE_ID, recipeDigest: CURL_REPAIR_RECIPE_DIGEST,
		evaluatorDigest: CURL_REPAIR_EVALUATOR_DIGEST, model: "none",
		dataAccessProfile: "public-source-and-published-advisory-only",
		qualification: { sourceAudited: true, workerQualified: true, recipeQualified: true,
			evaluatorQualified: true, modelApproved: true, dataApproved: true, accessApproved: true } }
	const registration: RepositoryWorkerRegistration = { campaignId: definition.id,
		repositoryId: definition.repositoryId!, repository: definition.repository!,
		sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!,
		workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
		evaluatorDigest: definition.evaluatorDigest!, model: "none", profileId: "no-model",
		pipelineAdapterId: CURL_REPAIR_ADAPTER_ID, executionKind: "live-cve",
		reservation: { ...CURL_REPAIR_RESERVATION } }
	const store = { path: "/private/test/state.json", async assertClaimCurrent() { calls.push("claim-check") } } as unknown as RepositoryCampaignStore
	const adapters = createCurlHistoricalRepairAdapters(registration, definition, { store }, {
		buildCandidate: async () => candidate,
		loadAdvisory: async () => makeCurlDebianAdvisoryTestFixture(),
		evaluateCandidate: async (input) => evaluateCurlHistoricalRepairCandidate({ ...input,
			buildCandidate: async () => candidate,
			evaluateFixedProof: async () => ({ schemaVersion: 1, accepted: true, disposition: "already-fixed",
				evidenceSha256: "a".repeat(64), reasonCode: "fixed-proof-verified" }) }),
		deliverRepair: async ({ candidate: evaluated, claim }) => {
			assert.equal(evaluated.patchSha256, CURL_REPAIR_PATCH_SHA256)
			assert.equal(claim.job.purpose, "repair")
			calls.push("already-fixed-delivery")
			return { accepted: true, disposition: "already-fixed", evidenceSha256: "d".repeat(64), privateRef: null, reasonCode: "candidate-already-in-private-base" }
		},
	})
	assert.equal(adapters.model, "none")
	assert.deepEqual(adapters.reservation, { micros: 1, tokens: 1 })
	const pipeline = createRepositoryWorkerPipeline(adapters)
	const claim = { claimId: "11111111-1111-4111-8111-111111111111", epoch: 2,
		job: { id: "repair-fixture-001", campaignId: CURL_REPAIR_CAMPAIGN_ID, advisoryId: CURL_FIXED_ADVISORY,
			purpose: "repair", status: "running", epoch: 2, createdAt: Date.now(), updatedAt: Date.now(), month: "2026-10",
			reservedMicros: 1, settledMicros: 0, reservedTokens: 1, settledTokens: 0 } } as unknown as ClaimedRepositoryJob
	const result = await pipeline.execute({ definition, claim, signal: new AbortController().signal, progress: async () => undefined })
	assert.equal(result.status, "succeeded")
	assert.equal(result.actualMicros, 0)
	assert.equal(result.actualTokens, 0)
	assert.equal(result.accounting, "measured")
	assert.deepEqual(calls, ["claim-check", "claim-check", "claim-check", "already-fixed-delivery"])
}

const tests: readonly SuiteTest[] = [
	["offline fixture encodes only the pinned historical b31-to-c24 source patch", offlineFixtureEncodesThePinnedHistoricalSourcePatch],
	["historical receipt requires an accepted protected-proof adapter", historicalReceiptRequiresAnAcceptedProtectedProofAdapter],
	["rejected proof reports its disposition and reason", rejectedProofReportsItsDisposition],
	["modified Curl patches cannot borrow the protected proof", alteredPatchCannotBorrowProtectedProof],
	["synthetic historical repair pipeline has no model worker and measures zero usage", syntheticRepairPipelineNeverStartsAModelWorker],
]

await runMain("repository-curl-repair", tests)
