import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
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
import { isEvaluatorReceipt, isWorkerReceipt } from "./repository-curl-repair-v2-receipts.js"

export type * from "./repository-curl-repair-v2-receipt-types.js"

function digest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

const HELPER = "operations/campaign_curl_historical_repair_v2.py"
const MODULE = "operations.campaign_curl_historical_repair_v2"
const STATE_ROOT = path.join(os.homedir(), ".local/state/fleet-security-watch/automation",
	"repository-campaign-evidence/curl-92390-historical-v2")
const BQ = "/opt/capsize-build-queue/venv/bin/bq"
const BQ_CONFIG = "/etc/capsize-build-queue/config.toml"
const PYTHON = "/usr/bin/python3"
const MAX_RECEIPT_BYTES = 32_768

export async function prepareCurlRepairV2Candidate(
	claim: CurlRepairV2ClaimIdentity,
	signal: AbortSignal,
): Promise<CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>> {
	validateClaim(claim)
	const release = await verifiedRelease()
	await ensurePrivateRoot(STATE_ROOT)
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
	const result = await readReceipt(claim, "evaluation-receipt.json", isEvaluatorReceipt)
	const worker = await readReceipt(claim, "worker-receipt.json", isWorkerReceipt)
	if (result.receipt.worker_receipt_sha256 !== worker.receiptFileSha256 ||
		result.receipt.candidate_artifact_sha256 !== worker.receipt.artifact_sha256) {
		throw new Error("Curl v2 evaluator receipt is detached from the worker artifact")
	}
	return result
}

/** Reauthenticate the original signed stage receipts immediately before delivery. */
export async function verifyCurlRepairV2Evidence(claim: CurlRepairV2ClaimIdentity,
	expected: { workerReceiptSha256: string; evaluatorReceiptSha256: string; candidateArtifactSha256: string },
	signal: AbortSignal = new AbortController().signal,
): Promise<{
	worker: CurlRepairV2StageReceipt<CurlRepairV2WorkerReceipt>
	evaluator: CurlRepairV2StageReceipt<CurlRepairV2EvaluatorReceipt>
}> {
	validateClaim(claim)
	if (![expected.workerReceiptSha256, expected.evaluatorReceiptSha256,
		expected.candidateArtifactSha256].every((value) => digest(value))) {
		throw new Error("Curl v2 expected evidence hashes are invalid")
	}
	const release = await verifiedRelease()
	await runStage("verify-worker", claim, release, signal, 20_000)
	if (signal.aborted) throw new Error("Curl v2 evidence verification was stopped")
	await runStage("verify-evaluator", claim, release, signal, 20_000)
	if (signal.aborted) throw new Error("Curl v2 evidence verification was stopped")
	const worker = await readReceipt(claim, "worker-receipt.json", isWorkerReceipt)
	if (signal.aborted) throw new Error("Curl v2 evidence verification was stopped")
	const evaluator = await readReceipt(claim, "evaluation-receipt.json", isEvaluatorReceipt)
	if (signal.aborted) throw new Error("Curl v2 evidence verification was stopped")
	if (worker.receiptFileSha256 !== expected.workerReceiptSha256 ||
		evaluator.receiptFileSha256 !== expected.evaluatorReceiptSha256 ||
		worker.receipt.artifact_sha256 !== expected.candidateArtifactSha256 ||
		evaluator.receipt.worker_receipt_sha256 !== worker.receiptFileSha256 ||
		evaluator.receipt.candidate_artifact_sha256 !== worker.receipt.artifact_sha256) {
		throw new Error("Curl v2 signed evidence changed before private delivery")
	}
	return { worker, evaluator }
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
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>
	const files = manifest.files
	if (!files || typeof files !== "object" || Array.isArray(files) ||
		(files as Record<string, unknown>)[HELPER] !== CURL_REPAIR_V2_HELPER_SHA256) {
		throw new Error("verified Fleet release lacks the pinned Curl v2 helper")
	}
	const helper = path.join(releaseRoot, HELPER)
	const helperInfo = await fs.lstat(helper)
	if (!helperInfo.isFile() || helperInfo.isSymbolicLink() || await fs.realpath(helper) !== helper) {
		throw new Error("verified Fleet Curl v2 helper is not a release file")
	}
	return releaseRoot
}

async function runStage(stage: string, claim: CurlRepairV2ClaimIdentity,
	releaseRoot: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
	if (signal.aborted) throw new Error("Curl v2 worker stopped before " + stage)
	const command = makeCommand(stage, claim)
	await runBuildQueue(command, releaseRoot, claim, signal, timeoutMs)
}

function makeCommand(stage: string, claim: CurlRepairV2ClaimIdentity): string[] {
	const name = `curl-hist-v2-${stage}-${claim.jobId.slice(0, 8)}`
	return [BQ, "--config", BQ_CONFIG, "run", "--job", name, PYTHON, "-B", "-m", MODULE,
		stage, "--source-root", CURL_REPAIR_PRIVATE_SOURCE_ROOT, "--state-root", STATE_ROOT,
		"--job-id", claim.jobId, "--claim-id", claim.claimId, "--epoch", String(claim.epoch)]
}

async function runBuildQueue(command: string[], cwd: string, claim: CurlRepairV2ClaimIdentity,
	signal: AbortSignal, timeoutMs: number): Promise<void> {
	const cancelPath = path.join(STATE_ROOT, "curl-historical-v2", claim.jobId, "cancel.request")
	const child = spawn(command[0]!, command.slice(1), { cwd, env: fixedEnvironment(cwd),
		stdio: "ignore", shell: false, detached: false })
	await awaitChild(child, cancelPath, signal, timeoutMs)
}

function fixedEnvironment(releaseRoot: string): NodeJS.ProcessEnv {
	return { HOME: os.homedir(), PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
		PYTHONPATH: releaseRoot, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" }
}

async function awaitChild(child: ReturnType<typeof spawn>, cancelPath: string,
	signal: AbortSignal, timeoutMs: number): Promise<void> {
	let requested = false
	const requestCancel = async () => {
		if (requested) return
		requested = true
		await ensureCancelMarker(cancelPath)
	}
	const onAbort = () => { void requestCancel() }
	signal.addEventListener("abort", onAbort, { once: true })
	const timer = setTimeout(() => { void requestCancel() }, timeoutMs)
	const hardTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 30_000)
	try {
		const code = await waitForExit(child)
		if (signal.aborted || requested) throw new Error("Curl v2 stage was cancelled")
		if (code !== 0) throw new Error("Curl v2 fixed Fleet stage failed")
	} finally {
		clearTimeout(timer)
		clearTimeout(hardTimer)
		signal.removeEventListener("abort", onAbort)
	}
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", () => reject(new Error("Curl v2 Fleet stage could not start")))
		child.once("close", (code) => resolve(code))
	})
}

async function ensureCancelMarker(filePath: string): Promise<void> {
	await ensurePrivateRoot(path.dirname(filePath))
	try {
		const handle = await fs.open(filePath, "wx", 0o600)
		await handle.close()
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		const info = await fs.lstat(filePath)
		if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) {
			throw new Error("Curl v2 cancellation marker is unsafe")
		}
	}
}

async function ensurePrivateRoot(directory: string): Promise<void> {
	const absolute = path.resolve(directory)
	const home = path.resolve(os.homedir())
	if (!absolute.startsWith(home + path.sep)) throw new Error("Curl v2 state path is outside home")
	const homeInfo = await fs.lstat(home)
	if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink() ||
		(typeof process.getuid === "function" && homeInfo.uid !== process.getuid())) {
		throw new Error("Curl v2 home path is not owner-private")
	}
	let current = home
	for (const part of path.relative(home, absolute).split(path.sep).filter(Boolean)) {
		current = path.join(current, part)
		try { await fs.mkdir(current, { mode: 0o700 }) } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		}
		const info = await fs.lstat(current)
		if (!info.isDirectory() || info.isSymbolicLink() ||
			(typeof process.getuid === "function" && info.uid !== process.getuid())) {
			throw new Error("Curl v2 state path is not owner-private")
		}
		await fs.chmod(current, 0o700)
	}
}

async function readReceipt<T>(claim: CurlRepairV2ClaimIdentity, name: string,
	validate: (value: unknown, claim: CurlRepairV2ClaimIdentity) => value is T): Promise<CurlRepairV2StageReceipt<T>> {
	const filePath = path.join(STATE_ROOT, "curl-historical-v2", claim.jobId, name)
	const info = await fs.lstat(filePath)
	if (!info.isFile() || info.isSymbolicLink() ||
		(typeof process.getuid === "function" && info.uid !== process.getuid()) ||
		info.mode & 0o077 || info.size > MAX_RECEIPT_BYTES) throw new Error("Curl v2 receipt is not private")
	const bytes = await fs.readFile(filePath)
	const value: unknown = JSON.parse(bytes.toString("utf8"))
	if (!validate(value, claim)) throw new Error("Curl v2 receipt does not match the active claim")
	return { receipt: value, receiptFileSha256: createHash("sha256").update(bytes).digest("hex") }
}
