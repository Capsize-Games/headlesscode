import assert from "node:assert/strict"
import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_SHA256,
	CURL_REPAIR_SOURCE_REVISION,
} from "../repository-curl-repair.js"
import type { SuiteTest } from "../../test-runner.js"
import { runMain } from "../../test-runner.js"
import * as RepairEvaluator from "../repository-curl-repair-evaluator.js"
import {
	acceptedProofStub,
	alteredCandidate,
	assertProofPhases,
	assertQualifiedReceipt,
	buildCurlHistoricalRepairTestFixture,
	rejectedProofStub,
} from "./repository-curl-repair-support.js"

async function offlineFixtureEncodesThePinnedHistoricalSourcePatch(): Promise<
	void
> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	assert.equal(candidate.sourceRevision, CURL_REPAIR_HISTORICAL_BASE)
	assert.equal(candidate.candidateRevision, CURL_REPAIR_CANDIDATE_REVISION)
	assert.equal(candidate.candidateTreeSha, CURL_REPAIR_CANDIDATE_TREE_SHA)
	assert.equal(candidate.patchSha256, CURL_REPAIR_PATCH_SHA256)
	assert.equal(
		Buffer.from(candidate.patchBase64, "base64").length,
		candidate.patchBytes,
	)
	assert.ok(candidate.sourceEnvelopeSha256.match(/^[a-f0-9]{64}$/))
	assert.ok(candidate.artifactManifestSha256.match(/^[a-f0-9]{64}$/))
	assertProofPhases(candidate.protectedProof.phases)
}

async function receiptNeedsAcceptedProtectedProof(): Promise<
	void
> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	const state = { calls: 0, revision: "" }
	const receipt =
		await RepairEvaluator.evaluateCurlHistoricalRepairCandidate({
			candidate,
			jobId: "repair-fixture-001",
			buildCandidate: async () => candidate,
			evaluateFixedProof: acceptedProofStub(
				candidate,
				state,
				"a".repeat(64),
			),
		})
	assert.equal(state.calls, 1)
	assert.equal(state.revision, CURL_REPAIR_SOURCE_REVISION)
	assertQualifiedReceipt(receipt)
}

async function unacceptedProofCannotQualify(): Promise<void> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	await assert.rejects(
		RepairEvaluator.evaluateCurlHistoricalRepairCandidate({
			candidate,
			jobId: "repair-fixture-002",
			buildCandidate: async () => candidate,
			evaluateFixedProof: rejectedProofStub("b".repeat(64)),
		}),
		/independently verified fixed regression proof/,
	)
}

async function rejectedProofReportsItsDisposition(): Promise<void> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	await assert.rejects(
		RepairEvaluator.evaluateCurlHistoricalRepairCandidate({
			candidate,
			jobId: "repair-fixture-004",
			buildCandidate: async () => candidate,
			evaluateFixedProof: rejectedProofStub("b".repeat(64)),
		}),
		/fixed regression proof \(blocked\/proof-invalid\)/,
	)
}

async function alteredPatchCannotBorrowProtectedProof(): Promise<void> {
	const candidate = await buildCurlHistoricalRepairTestFixture()
	const state = { calls: 0, revision: "" }
	const altered = alteredCandidate(candidate)
	await assert.rejects(
		RepairEvaluator.evaluateCurlHistoricalRepairCandidate({
			candidate: altered,
			jobId: "repair-fixture-003",
			buildCandidate: async () => candidate,
			evaluateFixedProof: acceptedProofStub(
				candidate,
				state,
				"c".repeat(64),
			),
		}),
		/outside the compiled profile|does not match the clean pinned checkout/,
	)
	assert.equal(state.calls, 0)
}

const tests: readonly SuiteTest[] = [
	[
		"offline fixture encodes only the pinned historical b31-to-c24 source patch",
		offlineFixtureEncodesThePinnedHistoricalSourcePatch,
	],
	[
		"historical receipt requires an accepted protected-proof adapter",
		receiptNeedsAcceptedProtectedProof,
	],
	[
		"unaccepted fixed proof cannot qualify a historical receipt",
		unacceptedProofCannotQualify,
	],
	[
		"rejected proof reports its disposition and reason",
		rejectedProofReportsItsDisposition,
	],
	[
		"modified Curl patches cannot borrow the protected proof",
		alteredPatchCannotBorrowProtectedProof,
	],
]

await runMain("repository-curl-repair", tests)
