import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { resolveFleetBudgetBridgeRelease } from "../rsi/fleet-budget-ledger.js"
import {
	CURL_REPAIR_V2_HELPER_SHA256,
} from "./repository-curl-repair-v2-profile.js"

import { CURL_REPAIR_PRIVATE_SOURCE_ROOT } from "./repository-curl-repair.js"
import {
	type CurlRepairV2ClaimIdentity,
	type CurlRepairV2EvaluatorReceipt,
	type CurlRepairV2StageReceipt,
	type CurlRepairV2WorkerReceipt,
} from "./repository-curl-repair-v2-receipt-types.js"
import {
	isEvaluatorReceipt,
	isWorkerReceipt,
} from "./repository-curl-repair-v2-receipts.js"
import {
	ensurePrivateRoot, evidenceRoot, readReceipt,
} from "./repository-curl-repair-v2-evidence-store.js"
import {
	runBoundedStageProcess,
} from "./repository-curl-repair-v2-stage-process.js"
import {
	assertEvidenceMatches,
	expectedHashesAreValid,
	type CurlRepairV2ExpectedHashes,
} from "./repository-curl-repair-v2-evidence-binding.js"

export type * from "./repository-curl-repair-v2-receipt-types.js"

const HELPER = "operations/campaign_curl_historical_repair_v2.py"
const MODULE = "operations.campaign_curl_historical_repair_v2"
const BQ = "/opt/capsize-build-queue/venv/bin/bq"
const BQ_CONFIG = "/etc/capsize-build-queue/config.toml"
const PYTHON = "/usr/bin/python3"

export async function prepareCurlRepairV2Candidate(
	claim: CurlRepairV2ClaimIdentity,
	signal: AbortSignal,
): Promise<CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>> {
	validateClaim(claim)
	const release = await verifiedRelease()
	await ensurePrivateRoot(evidenceRoot())
	await runStage("prepare", claim, release, signal, 90_000)
	await runStage("verify-worker", claim, release, signal, 20_000)
	return await readReceipt(claim, "worker-receipt.json", isWorkerReceipt)
}

export async function evaluateCurlRepairV2Candidate(
	claim: CurlRepairV2ClaimIdentity,
	signal: AbortSignal,
): Promise<CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>> {
	validateClaim(claim)
	const release = await verifiedRelease()
	await runStage("evaluate", claim, release, signal, 820_000)
	await runStage("verify-evaluator", claim, release, signal, 20_000)
	const result = await readReceipt(
		claim, "evaluation-receipt.json", isEvaluatorReceipt,
	)
	const worker = await readReceipt(claim, "worker-receipt.json", isWorkerReceipt)
	if (result.receipt.worker_receipt_sha256 !== worker.receiptFileSha256 ||
		result.receipt.candidate_artifact_sha256 !== worker.receipt.artifact_sha256) {
		throw new Error("Curl v2 evaluator receipt does not match worker artifact")
	}
	return result
}

/** Reauthenticate signed stage receipts immediately before delivery. */
export async function verifyCurlRepairV2Evidence(
	claim: CurlRepairV2ClaimIdentity,
	expected: CurlRepairV2ExpectedHashes,
	signal: AbortSignal = new AbortController().signal,
): Promise<{
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
}> {
	return await verifyEvidence(claim, expected, signal)
}

async function verifyEvidence(
	claim: CurlRepairV2ClaimIdentity,
	expected: CurlRepairV2ExpectedHashes,
	signal: AbortSignal,
): Promise<{
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
}> {
	validateClaim(claim)
	if (!expectedHashesAreValid(expected)) {
		throw new Error("Curl v2 expected evidence hashes are invalid")
	}
	const release = await verifiedRelease()
	const receipts = await readFreshEvidence(claim, release, signal)
	const { worker, evaluator } = receipts
	assertEvidenceMatches(worker, evaluator, expected)
	return { worker, evaluator }
}

async function readFreshEvidence(
	claim: CurlRepairV2ClaimIdentity,
	release: string,
	signal: AbortSignal,
): Promise<{
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
}> {
	await runStage("verify-worker", claim, release, signal, 20_000)
	assertNotStopped(signal)
	await runStage("verify-evaluator", claim, release, signal, 20_000)
	assertNotStopped(signal)
	const worker = await readReceipt(claim, "worker-receipt.json", isWorkerReceipt)
	assertNotStopped(signal)
	const evaluator = await readReceipt(
		claim, "evaluation-receipt.json", isEvaluatorReceipt,
	)
	assertNotStopped(signal)
	return { worker, evaluator }
}

function assertNotStopped(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new Error("Curl v2 evidence verification was stopped")
	}
}

function validateClaim(claim: CurlRepairV2ClaimIdentity): void {
	if (!claim || !/^[a-f0-9-]{36}$/.test(claim.jobId) ||
		!/^[a-f0-9-]{36}$/.test(claim.claimId) ||
		!Number.isSafeInteger(claim.epoch) || claim.epoch < 1) {
		throw new Error("Curl v2 job claim identity is invalid")
	}
}

async function verifiedRelease(): Promise<string> {
	const { releaseRoot } = await resolveFleetBudgetBridgeRelease()
	const manifestPath = path.join(releaseRoot, "release-manifest.json")
	const manifest = JSON.parse(
		await fs.readFile(manifestPath, "utf8"),
	) as Record<string, unknown>
	const files = manifest.files
	if (!files || typeof files !== "object" || Array.isArray(files) ||
		(files as Record<string, unknown>)[HELPER] !== CURL_REPAIR_V2_HELPER_SHA256) {
		throw new Error("verified Fleet release lacks the pinned Curl v2 helper")
	}
	const helper = path.join(releaseRoot, HELPER)
	const helperInfo = await fs.lstat(helper)
	if (!helperInfo.isFile() || helperInfo.isSymbolicLink() ||
		await fs.realpath(helper) !== helper) {
		throw new Error("verified Fleet Curl v2 helper is not a release file")
	}
	return releaseRoot
}

async function runStage(
	stage: string,
	claim: CurlRepairV2ClaimIdentity,
	releaseRoot: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<void> {
	if (signal.aborted) throw new Error("Curl v2 worker stopped before " + stage)
	const command = makeCommand(stage, claim)
	await runBuildQueue(command, releaseRoot, claim, signal, timeoutMs)
}

function makeCommand(
	stage: string,
	claim: CurlRepairV2ClaimIdentity,
): string[] {
	const name = `curl-hist-v2-${stage}-${claim.jobId.slice(0, 8)}`
	return [
		BQ, "--config", BQ_CONFIG, "run", "--job", name, PYTHON, "-B", "-m",
		MODULE, stage, "--source-root", CURL_REPAIR_PRIVATE_SOURCE_ROOT,
		"--state-root", evidenceRoot(), "--job-id", claim.jobId,
		"--claim-id", claim.claimId, "--epoch", String(claim.epoch),
	]
}

async function runBuildQueue(
	command: string[],
	cwd: string,
	claim: CurlRepairV2ClaimIdentity,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<void> {
	const cancelPath = path.join(
		evidenceRoot(), "curl-historical-v2", claim.jobId, "cancel.request",
	)
	await runBoundedStageProcess(
		command, cwd, cancelPath, signal, timeoutMs, fixedEnvironment(cwd),
	)
}

function fixedEnvironment(releaseRoot: string): NodeJS.ProcessEnv {
	return {
		HOME: os.homedir(), PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
		PYTHONPATH: releaseRoot, PYTHONNOUSERSITE: "1",
		PYTHONDONTWRITEBYTECODE: "1",
	}
}
