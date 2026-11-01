import type {
	CurlRepairV2EvaluatorReceipt,
	CurlRepairV2StageReceipt,
	CurlRepairV2WorkerReceipt,
} from "./repository-curl-repair-v2-receipt-types.js"

export interface CurlRepairV2ExpectedHashes {
	workerReceiptSha256: string
	evaluatorReceiptSha256: string
	candidateArtifactSha256: string
}

export function expectedHashesAreValid(
	expected: CurlRepairV2ExpectedHashes,
): boolean {
	return [expected.workerReceiptSha256, expected.evaluatorReceiptSha256,
		expected.candidateArtifactSha256].every(isDigest)
}

export function assertEvidenceMatches(
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>,
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>,
	expected: CurlRepairV2ExpectedHashes,
): void {
	if (!matchesEvidence(worker, evaluator, expected)) {
		throw new Error("Curl v2 evidence changed before private delivery")
	}
}

function matchesEvidence(
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>,
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>,
	expected: CurlRepairV2ExpectedHashes,
): boolean {
	return worker.receiptFileSha256 === expected.workerReceiptSha256 &&
		evaluator.receiptFileSha256 === expected.evaluatorReceiptSha256 &&
		worker.receipt.artifact_sha256 === expected.candidateArtifactSha256 &&
		evaluator.receipt.worker_receipt_sha256 === worker.receiptFileSha256 &&
		evaluator.receipt.candidate_artifact_sha256 ===
			worker.receipt.artifact_sha256
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}
