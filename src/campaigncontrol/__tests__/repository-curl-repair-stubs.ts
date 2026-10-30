import assert from "node:assert/strict"
import {
	CURL_REPAIR_PATCH_SHA256,
	CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
} from "../repository-curl-repair.js"
import type {
	CurlProtectedEvaluationRequest,
	CurlProtectedEvaluationResult,
} from "../repository-curl-evaluator.js"
import type {
	CurlHistoricalRepairCandidate,
} from "../repository-curl-repair.js"
import type {
	CurlHistoricalRepairReceipt,
} from "../repository-curl-repair-evaluator.js"

export interface ProofStubState {
	calls: number
	revision: string
}

export function acceptedProofStub(
	candidate: CurlHistoricalRepairCandidate,
	state: ProofStubState,
	evidenceSha256: string,
): (
	request: CurlProtectedEvaluationRequest,
) => Promise<CurlProtectedEvaluationResult> {
	return async (request) => {
		state.calls += 1
		state.revision = request.candidateRevision
		return {
			schemaVersion: 1,
			accepted: true,
			disposition: "already-fixed",
			evidenceSha256,
			reasonCode: "fixed-proof-verified",
		}
	}
}

export function rejectedProofStub(
	evidenceSha256: string,
): () => Promise<CurlProtectedEvaluationResult> {
	return async () => ({
		schemaVersion: 1,
		accepted: false,
		disposition: "blocked",
		evidenceSha256,
		reasonCode: "proof-invalid",
	})
}

export function assertQualifiedReceipt(
	receipt: CurlHistoricalRepairReceipt,
): void {
	assert.equal(receipt.disposition, "historical-fix-qualified")
	assert.equal(receipt.proofMode, "reused-signed-offline-phase-evidence")
	assert.equal(receipt.scope, "historical-public-regression-only")
	assert.equal(
		receipt.protectedProof.evidenceSha256,
		CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
	)
	assert.match(receipt.evidenceSha256, /^[a-f0-9]{64}$/)
}

export interface DeliverRepairInput {
	candidate: { patchSha256: string }
	claim: { job: { purpose?: string } }
}

export interface DeliverRepairResult {
	accepted: true
	disposition: "already-fixed"
	evidenceSha256: string
	privateRef: null
	reasonCode: string
}

export function deliverRepairStub(
	calls: string[],
): (input: DeliverRepairInput) => Promise<DeliverRepairResult> {
	return async ({ candidate, claim }) => {
		assert.equal(candidate.patchSha256, CURL_REPAIR_PATCH_SHA256)
		assert.equal(claim.job.purpose, "repair")
		calls.push("already-fixed-delivery")
		return {
			accepted: true,
			disposition: "already-fixed",
			evidenceSha256: "d".repeat(64),
			privateRef: null,
			reasonCode: "candidate-already-in-private-base",
		}
	}
}
