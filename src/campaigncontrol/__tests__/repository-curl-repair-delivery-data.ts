import { createHash } from "node:crypto"
import { CURL_FIXED_ADVISORY } from "../repository-curl-evaluator.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_PATH,
	CURL_REPAIR_PATCH_SHA256,
	CURL_REPAIR_PROFILE_ID,
	CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256,
	CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
	CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
	CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
	type CurlHistoricalRepairCandidate,
} from "../repository-curl-repair.js"
import type * as Evaluator from "../repository-curl-repair-evaluator.js"

const repo = "Capsize-Games/curl-maintenance"
type Candidate = CurlHistoricalRepairCandidate
type Receipt = Evaluator.CurlHistoricalRepairReceipt
type ReceiptProof = Receipt["protectedProof"]

export function digest(input: string): string {
	return createHash("sha256").update(input).digest("hex")
}
export function canonical(value: unknown): string {
	if (value === null || typeof value !== "object")
		return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
		.join(",")}}`
}

export function makeCandidate(): CurlHistoricalRepairCandidate {
	return {
		schemaVersion: 1,
		advisoryId: CURL_FIXED_ADVISORY,
		profileId: CURL_REPAIR_PROFILE_ID,
		sourceRepository: repo,
		sourceRevision: CURL_REPAIR_HISTORICAL_BASE,
		sourceTreeSha: "b1ea31bb7377dd2bfe08fd67af44860de57afc12",
		candidateRevision: CURL_REPAIR_CANDIDATE_REVISION,
		candidateTreeSha: CURL_REPAIR_CANDIDATE_TREE_SHA,
		patchPath: CURL_REPAIR_PATCH_PATH,
		patchBase64: Buffer.from("fixture-patch").toString("base64"),
		patchBytes: 13,
		patchSha256: CURL_REPAIR_PATCH_SHA256,
		sourceEnvelopeSha256: digest("envelope"),
		artifactManifestSha256: digest("manifest"),
		protectedProof: makeProtectedProof(),
	}
}

function makeProtectedProof(): CurlHistoricalRepairCandidate["protectedProof"] {
	return {
		profileId: "curl-92390-fixed-v1",
		evaluatorId: "package-regression-v1",
		evaluatorDigest: CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
		evidenceSha256: CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
		receiptSha256: CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
		artifactManifestSha256: CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256,
		phases: [
			"historical_base-red",
			"reference_fix-green",
			"fork_head-green",
			"candidate-green",
		] as const,
	}
}

export function makeReceipt(candidate: Candidate): Receipt {
	const base: Omit<Receipt, "evidenceSha256"> = {
		schemaVersion: 1,
		disposition: "historical-fix-qualified",
		proofMode: "reused-signed-offline-phase-evidence",
		scope: "historical-public-regression-only",
		advisoryId: CURL_FIXED_ADVISORY,
		profileId: CURL_REPAIR_PROFILE_ID,
		sourceRevision: candidate.sourceRevision,
		sourceTreeSha: candidate.sourceTreeSha,
		candidateRevision: candidate.candidateRevision,
		candidateTreeSha: candidate.candidateTreeSha,
		patchSha256: candidate.patchSha256,
		sourceEnvelopeSha256: candidate.sourceEnvelopeSha256,
		artifactManifestSha256: candidate.artifactManifestSha256,
		protectedProof: makeReceiptProof(),
	}
	return { ...base, evidenceSha256: digest(canonical(base)) }
}

function makeReceiptProof(): ReceiptProof {
	return {
		profileId: "curl-92390-fixed-v1",
		evaluatorDigest: CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
		evidenceSha256: CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
		receiptSha256: CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
		artifactManifestSha256: CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256,
		evaluatorEvidenceSha256: digest("protected-evidence"),
	}
}
