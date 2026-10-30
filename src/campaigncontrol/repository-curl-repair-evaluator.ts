import { createHash } from "node:crypto"
import { CURL_CANDIDATE_TREE_SHA, CURL_FIXED_ADVISORY,
	CURL_PRIVATE_SOURCE_REVISION, evaluatePinnedCurlCandidate,
	makeCurlProtectedEvaluationRequest,
	type CurlProtectedEvaluationResult } from "./repository-curl-evaluator.js"
import { buildCurlHistoricalRepairCandidate, type CurlHistoricalRepairCandidate } from "./repository-curl-repair.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA, CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_SHA256, CURL_REPAIR_PROFILE_ID, CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256,
	CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
	CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256, CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
} from "./repository-curl-repair.js"

export interface CurlHistoricalRepairReceipt {
	schemaVersion: 1
	disposition: "historical-fix-qualified"
	proofMode: "reused-signed-offline-phase-evidence"
	scope: "historical-public-regression-only"
	advisoryId: typeof CURL_FIXED_ADVISORY
	profileId: typeof CURL_REPAIR_PROFILE_ID
	sourceRevision: typeof CURL_REPAIR_HISTORICAL_BASE
	sourceTreeSha: string
	candidateRevision: typeof CURL_REPAIR_CANDIDATE_REVISION
	candidateTreeSha: typeof CURL_REPAIR_CANDIDATE_TREE_SHA
	patchSha256: typeof CURL_REPAIR_PATCH_SHA256
	sourceEnvelopeSha256: string
	artifactManifestSha256: string
	protectedProof: {
		profileId: "curl-92390-fixed-v1"
		evaluatorDigest: typeof CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST
		evidenceSha256: typeof CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256
		receiptSha256: typeof CURL_REPAIR_PROTECTED_RECEIPT_SHA256
		artifactManifestSha256: typeof CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256
		evaluatorEvidenceSha256: string
	}
	evidenceSha256: string
}

/**
 * Derive a historical candidate receipt only from the fixed signed proof.
 * The protected proof checks b31 red, c24 reference green and ce573 fork/candidate
 * green for the same prescribed Curl tests. This function does not claim a new
 * test run, current host applicability, or a newly introduced fix.
 */
export async function evaluateCurlHistoricalRepairCandidate(input: {
	candidate: CurlHistoricalRepairCandidate
	jobId: string
	evaluateFixedProof?: typeof evaluatePinnedCurlCandidate
	/** Trusted offline fixture hook; production adapters omit this and verify the owner-private source by default. */
	buildCandidate?: typeof buildCurlHistoricalRepairCandidate
}): Promise<CurlHistoricalRepairReceipt> {
	const candidate = input?.candidate
	if (!candidate || input.jobId !== input.jobId?.toLowerCase() || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(input.jobId) ||
		candidate.schemaVersion !== 1 || candidate.advisoryId !== CURL_FIXED_ADVISORY || candidate.profileId !== CURL_REPAIR_PROFILE_ID ||
		candidate.sourceRevision !== CURL_REPAIR_HISTORICAL_BASE || candidate.candidateRevision !== CURL_REPAIR_CANDIDATE_REVISION ||
		candidate.candidateTreeSha !== CURL_REPAIR_CANDIDATE_TREE_SHA || candidate.patchSha256 !== CURL_REPAIR_PATCH_SHA256 ||
		candidate.protectedProof.evidenceSha256 !== CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256 ||
		candidate.protectedProof.receiptSha256 !== CURL_REPAIR_PROTECTED_RECEIPT_SHA256 ||
		candidate.protectedProof.artifactManifestSha256 !== CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256 ||
		candidate.protectedProof.evaluatorDigest !== CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST ||
		candidate.protectedProof.phases.join(",") !== "historical_base-red,reference_fix-green,fork_head-green,candidate-green") {
		throw new Error("historical Curl repair candidate is outside the compiled profile")
	}
	const expectedCandidate = await (input.buildCandidate ?? buildCurlHistoricalRepairCandidate)()
	if (canonical(candidate) !== canonical(expectedCandidate)) throw new Error("historical Curl source patch does not match the clean pinned checkout")
	const patch = Buffer.from(candidate.patchBase64, "base64")
	if (patch.length !== candidate.patchBytes || createHash("sha256").update(patch).digest("hex") !== CURL_REPAIR_PATCH_SHA256) {
		throw new Error("historical Curl source patch failed its content digest")
	}
	const protectedRequest = makeCurlProtectedEvaluationRequest({ campaignId: "curl-maintenance", jobId: input.jobId,
		advisoryId: CURL_FIXED_ADVISORY, candidateRevision: CURL_PRIVATE_SOURCE_REVISION, candidateTreeSha: CURL_CANDIDATE_TREE_SHA })
	const protectedResult = await (input.evaluateFixedProof ??
		evaluatePinnedCurlCandidate)(protectedRequest)
	if (!protectedResult.accepted ||
		protectedResult.disposition !== "already-fixed" ||
		protectedResult.reasonCode !== "fixed-proof-verified") {
		throw unverifiedProofError(protectedResult)
	}
	const receiptBase: Omit<CurlHistoricalRepairReceipt, "evidenceSha256"> = {
		schemaVersion: 1 as const,
		disposition: "historical-fix-qualified" as const,
		proofMode: "reused-signed-offline-phase-evidence" as const,
		scope: "historical-public-regression-only" as const,
		advisoryId: CURL_FIXED_ADVISORY,
		profileId: CURL_REPAIR_PROFILE_ID,
		sourceRevision: CURL_REPAIR_HISTORICAL_BASE,
		sourceTreeSha: candidate.sourceTreeSha,
		candidateRevision: CURL_REPAIR_CANDIDATE_REVISION,
		candidateTreeSha: CURL_REPAIR_CANDIDATE_TREE_SHA,
		patchSha256: CURL_REPAIR_PATCH_SHA256,
		sourceEnvelopeSha256: candidate.sourceEnvelopeSha256,
		artifactManifestSha256: candidate.artifactManifestSha256,
		protectedProof: { profileId: candidate.protectedProof.profileId, evaluatorDigest: candidate.protectedProof.evaluatorDigest,
			evidenceSha256: candidate.protectedProof.evidenceSha256, receiptSha256: candidate.protectedProof.receiptSha256,
			artifactManifestSha256: candidate.protectedProof.artifactManifestSha256,
			evaluatorEvidenceSha256: protectedResult.evidenceSha256 },
	}
	return { ...receiptBase, evidenceSha256: createHash("sha256").update(canonical(receiptBase)).digest("hex") }
}

function unverifiedProofError(
	result: CurlProtectedEvaluationResult,
): Error {
	return new Error("historical Curl repair requires " +
		"the independently verified fixed regression proof " +
		`(${result.disposition}/${result.reasonCode})`)
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}
