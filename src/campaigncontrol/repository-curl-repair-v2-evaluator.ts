import { createHash } from "node:crypto"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import {
	evaluateCurlHistoricalRepairCandidate,
	type CurlHistoricalRepairReceipt,
} from "./repository-curl-repair-evaluator.js"
import type { CurlHistoricalRepairCandidate } from "./repository-curl-repair.js"
import {
	CURL_REPAIR_V2_EVALUATOR_DIGEST,
	CURL_REPAIR_V2_PROFILE_ID,
	CURL_REPAIR_V2_TEST_IDS,
} from "./repository-curl-repair-v2-profile.js"
import type {
	CurlRepairV2EvaluatorReceipt,
	CurlRepairV2StageReceipt,
	CurlRepairV2WorkerReceipt,
} from "./repository-curl-repair-v2-execution.js"

export interface CurlHistoricalRepairV2Receipt {
	schemaVersion: 2
	disposition: "historical-fix-qualified"
	proofMode: "fresh-job-bound-isolated-regression"
	scope: "historical-public-regression-only"
	advisoryId: typeof CURL_FIXED_ADVISORY
	profileId: CurlHistoricalRepairReceipt["profileId"]
	sourceRevision: CurlHistoricalRepairReceipt["sourceRevision"]
	sourceTreeSha: string
	candidateRevision: CurlHistoricalRepairReceipt["candidateRevision"]
	candidateTreeSha: string
	patchSha256: string
	sourceEnvelopeSha256: string
	artifactManifestSha256: string
	protectedProof: CurlHistoricalRepairReceipt["protectedProof"]
	execution: {
		profileId: typeof CURL_REPAIR_V2_PROFILE_ID
		evaluatorDigest: typeof CURL_REPAIR_V2_EVALUATOR_DIGEST
		jobId: string
		claimId: string
		epoch: number
		workerReceiptSha256: string
		evaluatorReceiptSha256: string
		candidateArtifactSha256: string
		imageDigest: string
		testIds: typeof CURL_REPAIR_V2_TEST_IDS
		testResults: { "3037": "pass"; "3038": "pass"; "5033": "pass" }
		sanitizerClean: true
		cleanupConfirmed: true
	}
	evidenceSha256: string
}

export async function evaluateCurlHistoricalRepairV2(input: {
	candidate: CurlHistoricalRepairCandidate
	jobId: string
	claimId: string
	epoch: number
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
	evaluateBase?: typeof evaluateCurlHistoricalRepairCandidate
}): Promise<CurlHistoricalRepairV2Receipt> {
	const base = await (input.evaluateBase ?? evaluateCurlHistoricalRepairCandidate)({
		candidate: input.candidate, jobId: input.jobId,
	})
	validateExecution(input, base)
	return makeReceipt(input, base)
}

function validateExecution(input: {
	jobId: string
	claimId: string
	epoch: number
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
}, base: CurlHistoricalRepairReceipt): void {
	const worker = input.worker.receipt
	const evaluation = input.evaluator.receipt
	if (worker.job_id !== input.jobId || worker.claim_id !== input.claimId || worker.epoch !== input.epoch ||
		evaluation.job_id !== input.jobId || evaluation.claim_id !== input.claimId || evaluation.epoch !== input.epoch ||
		evaluation.worker_receipt_sha256 !== input.worker.receiptFileSha256 ||
		evaluation.candidate_artifact_sha256 !== worker.artifact_sha256 ||
		evaluation.test_ids.some((testId, index) => testId !== CURL_REPAIR_V2_TEST_IDS[index]) ||
		Object.values(evaluation.test_results).some((result) => result !== "pass") ||
		!evaluation.sanitizer_clean || !evaluation.cleanup_confirmed ||
		base.disposition !== "historical-fix-qualified") {
		throw new Error("Curl v2 execution receipt failed its claim and candidate bindings")
	}
}

function makeReceipt(input: {
	candidate: CurlHistoricalRepairCandidate
	jobId: string
	claimId: string
	epoch: number
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
}, base: CurlHistoricalRepairReceipt): CurlHistoricalRepairV2Receipt {
	const receiptBase = receiptBaseFor(input, base)
	return { ...receiptBase, evidenceSha256: sha256(canonical(receiptBase)) }
}

function receiptBaseFor(input: {
	candidate: CurlHistoricalRepairCandidate
	jobId: string
	claimId: string
	epoch: number
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
}, base: CurlHistoricalRepairReceipt): Omit<CurlHistoricalRepairV2Receipt, "evidenceSha256"> {
	return {
		schemaVersion: 2 as const,
		disposition: "historical-fix-qualified" as const,
		proofMode: "fresh-job-bound-isolated-regression" as const,
		scope: base.scope,
		advisoryId: base.advisoryId,
		profileId: base.profileId,
		sourceRevision: base.sourceRevision,
		sourceTreeSha: base.sourceTreeSha,
		candidateRevision: base.candidateRevision,
		candidateTreeSha: base.candidateTreeSha,
		patchSha256: base.patchSha256,
		sourceEnvelopeSha256: base.sourceEnvelopeSha256,
		artifactManifestSha256: base.artifactManifestSha256,
		protectedProof: base.protectedProof,
		execution: executionFor(input),
	}
}

function executionFor(input: {
	jobId: string
	claimId: string
	epoch: number
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
}): CurlHistoricalRepairV2Receipt["execution"] {
	const evaluation = input.evaluator.receipt
	return {
		profileId: CURL_REPAIR_V2_PROFILE_ID,
		evaluatorDigest: CURL_REPAIR_V2_EVALUATOR_DIGEST,
		jobId: input.jobId,
		claimId: input.claimId,
		epoch: input.epoch,
		workerReceiptSha256: input.worker.receiptFileSha256,
		evaluatorReceiptSha256: input.evaluator.receiptFileSha256,
		candidateArtifactSha256: evaluation.candidate_artifact_sha256,
		imageDigest: evaluation.image_digest,
		testIds: CURL_REPAIR_V2_TEST_IDS,
		testResults: evaluation.test_results,
		sanitizerClean: true,
		cleanupConfirmed: true,
	}
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex") }

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}
