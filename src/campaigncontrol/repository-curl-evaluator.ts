import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { resolveFleetBudgetBridgeRelease } from "../rsi/fleet-budget-ledger.js"

export const CURL_FIXED_ADVISORY = "CVE-2026-92390"
export const CURL_CAMPAIGN_ID = "curl-maintenance"
export const CURL_PROFILE_ID = "curl-92390-fixed-v1"
export const CURL_PRIVATE_SOURCE_REVISION = "ce57339379d82d29637b4752979e54128b6b2348"
export const CURL_CANDIDATE_TREE_SHA = "af27b838bb0ed82867d6b1c7655defe7a87511fc"
export const CURL_PATCH_SHA256 = "1d9caaffe517b4792b6b7350377bbe77bcd8ba28d54352fa615696fd707c7150"
export const CURL_PROOF_EVIDENCE_SHA256 = "d49021661a1807d3c0c991e72806c4deda5b29a177419454791b86fa0e052180"
export const CURL_RECEIPT_SHA256 = "e09bc19de4c667feac255e31d5068b96b11af2bf8a96882519602051dd0d5798"
export const CURL_ARTIFACT_MANIFEST_SHA256 = "8e48963669c8898efda99ddf3e770fe4712f63b3210e4f75d0820934b398a759"
export const CURL_PROOF_FILE_SHA256 = "871e9a4fd594c2614e1f5b9dc8d8f04479c1ce43a00174c02e14fe2a0c1e8d99"
export const CURL_POLICY_DIGEST = "cfa51dc0d6698440d877fde462fb44040f31d6384e7f14842c4d871515d42f25"
export const CURL_WORKER_DIGEST = "a9a304ff834e6f9d286e018398001626e8d41ba58119320eb41a847bd8815cf7"
export const CURL_EVALUATOR_DIGEST = "f93f779e79e0a214c33b4684df79a33c6ea07ab9a477c03baef31ddb49ac9560"
export const CURL_IMAGE_ID = "sha256:8924c5d2afd16f45d34a32f34de613ed7146a9557d07deb9edc83588d2dfdc04"

const FIXED_SOURCE = "operations/repository_campaign_evaluator_bridge.py"
const FIXED_SOURCE_SHA256 = "a979b1ed589f6ba76e81a245973ff3dfa056b186907225b9615e4548af31a3ca"
const REQUEST_KEYS = ["schemaVersion", "campaignId", "jobId", "advisoryId", "profileId", "sourceRevision", "candidateRevision",
	"candidateTreeSha", "candidateSha256", "patchSha256", "proofEvidenceSha256", "receiptSha256", "artifactManifestSha256"] as const
const EVIDENCE_KEYS = ["schemaVersion", "campaignId", "jobId", "advisoryId", "profileId", "sourceRevision", "candidateRevision",
	"candidateTreeSha", "candidateSha256", "patchSha256", "proofEvidenceSha256", "receiptSha256", "artifactManifestSha256",
	"proofFileSha256", "policyDigest", "workerDigest", "evaluatorDigest", "imageId", "accepted", "disposition", "reasonCode"] as const

export interface CurlProtectedEvaluationRequest {
	schemaVersion: 1
	campaignId: string
	jobId: string
	advisoryId: string
	profileId: string
	sourceRevision: string
	candidateRevision: string
	candidateTreeSha: string
	candidateSha256: string
	patchSha256: string
	proofEvidenceSha256: string
	receiptSha256: string
	artifactManifestSha256: string
}

export interface CurlProtectedEvaluationResult {
	schemaVersion: 1
	accepted: boolean
	disposition: "already-fixed" | "rejected" | "blocked"
	evidenceSha256: string
	reasonCode: string
}

function canonical(value: Record<string, unknown>): string {
	return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex") }

export function makeCurlProtectedEvaluationRequest(input: { campaignId: string; jobId: string; advisoryId: string;
	candidateRevision: string; candidateTreeSha: string }): CurlProtectedEvaluationRequest {
	if (input.campaignId !== CURL_CAMPAIGN_ID || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(input.jobId) ||
		input.advisoryId !== CURL_FIXED_ADVISORY || input.candidateRevision !== CURL_PRIVATE_SOURCE_REVISION || input.candidateTreeSha !== CURL_CANDIDATE_TREE_SHA) {
		throw new Error("Curl protected evaluator request is outside the pinned already-fixed profile")
	}
	const fields = { sourceRevision: CURL_PRIVATE_SOURCE_REVISION, candidateTreeSha: CURL_CANDIDATE_TREE_SHA,
		patchSha256: CURL_PATCH_SHA256, profileId: CURL_PROFILE_ID, policyDigest: CURL_POLICY_DIGEST,
		workerDigest: CURL_WORKER_DIGEST, evaluatorDigest: CURL_EVALUATOR_DIGEST, imageId: CURL_IMAGE_ID,
		artifactManifestSha256: CURL_ARTIFACT_MANIFEST_SHA256, receiptSha256: CURL_RECEIPT_SHA256, proofEvidenceSha256: CURL_PROOF_EVIDENCE_SHA256 }
	const request: CurlProtectedEvaluationRequest = { schemaVersion: 1, campaignId: input.campaignId, jobId: input.jobId,
		advisoryId: input.advisoryId, profileId: CURL_PROFILE_ID, sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
		candidateRevision: input.candidateRevision, candidateTreeSha: input.candidateTreeSha,
		candidateSha256: sha256(canonical(fields)), patchSha256: CURL_PATCH_SHA256, proofEvidenceSha256: CURL_PROOF_EVIDENCE_SHA256,
		receiptSha256: CURL_RECEIPT_SHA256, artifactManifestSha256: CURL_ARTIFACT_MANIFEST_SHA256 }
	return request
}

function validateRequest(input: CurlProtectedEvaluationRequest): void {
	if (!input || Object.keys(input).sort().join(",") !== [...REQUEST_KEYS].sort().join(",") || input.schemaVersion !== 1 ||
		input.campaignId !== CURL_CAMPAIGN_ID || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(input.jobId) ||
		input.advisoryId !== CURL_FIXED_ADVISORY || input.profileId !== CURL_PROFILE_ID || input.sourceRevision !== CURL_PRIVATE_SOURCE_REVISION ||
		input.candidateRevision !== CURL_PRIVATE_SOURCE_REVISION || input.candidateTreeSha !== CURL_CANDIDATE_TREE_SHA ||
		input.patchSha256 !== CURL_PATCH_SHA256 || input.proofEvidenceSha256 !== CURL_PROOF_EVIDENCE_SHA256 ||
		input.receiptSha256 !== CURL_RECEIPT_SHA256 || input.artifactManifestSha256 !== CURL_ARTIFACT_MANIFEST_SHA256 ||
		!(/^[a-f0-9]{64}$/.test(input.candidateSha256))) throw new Error("Curl protected evaluator request failed compiled-pin validation")
}

/** Revalidate a candidate with the immutable Fleet profile helper; no request supplies a path or command. */
export async function evaluatePinnedCurlCandidate(input: CurlProtectedEvaluationRequest): Promise<CurlProtectedEvaluationResult> {
	validateRequest(input)
	const { releaseRoot } = await resolveFleetBudgetBridgeRelease()
	const manifest = JSON.parse(await fs.readFile(path.join(releaseRoot, "release-manifest.json"), "utf8")) as Record<string, unknown>
	const files = manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files) ? manifest.files as Record<string, unknown> : {}
	if (files[FIXED_SOURCE] !== FIXED_SOURCE_SHA256) throw new Error("verified Fleet release does not contain the pinned Curl evaluator")
	const helper = path.join(releaseRoot, FIXED_SOURCE)
	const helperInfo = await fs.lstat(helper)
	if (!helperInfo.isFile() || helperInfo.isSymbolicLink() || await fs.realpath(helper) !== helper) throw new Error("verified Fleet Curl evaluator is not a regular release member")
	const { stdout, code } = await runFixedPython(releaseRoot, JSON.stringify(input), 20_000)
	if (code !== 0) throw new Error("Fleet protected Curl evaluator did not complete successfully")
	let value: unknown
	try { value = JSON.parse(stdout) } catch { throw new Error("Fleet protected Curl evaluator response is invalid JSON") }
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "accepted,disposition,evidenceSha256,reasonCode,schemaVersion") {
		throw new Error("Fleet protected Curl evaluator response has an invalid shape")
	}
	const result = value as CurlProtectedEvaluationResult
	if (result.schemaVersion !== 1 || typeof result.accepted !== "boolean" || !["already-fixed", "rejected", "blocked"].includes(result.disposition) ||
		! /^[a-f0-9]{64}$/.test(result.evidenceSha256) || !/^[a-z][a-z0-9-]{1,63}$/.test(result.reasonCode)) throw new Error("Fleet protected Curl evaluator response failed validation")
	const evidence = Object.fromEntries(EVIDENCE_KEYS.map((key) => [key, key in input ? (input as unknown as Record<string, unknown>)[key] :
		key === "proofFileSha256" ? CURL_PROOF_FILE_SHA256 : key === "policyDigest" ? CURL_POLICY_DIGEST : key === "workerDigest" ? CURL_WORKER_DIGEST :
		key === "evaluatorDigest" ? CURL_EVALUATOR_DIGEST : key === "imageId" ? CURL_IMAGE_ID : key === "accepted" ? result.accepted :
		key === "disposition" ? result.disposition : result.reasonCode]))
	if (result.evidenceSha256 !== sha256(canonical(evidence))) throw new Error("Fleet protected Curl evaluator evidence digest does not match its verified claims")
	if (result.accepted && (result.disposition !== "already-fixed" || result.reasonCode !== "fixed-proof-verified")) throw new Error("Fleet evaluator accepted an unexpected Curl outcome")
	return result
}

async function runFixedPython(cwd: string, input: string, timeoutMs: number): Promise<{ stdout: string; code: number | null }> {
	return await new Promise((resolve, reject) => {
		const child = spawn("/usr/bin/python3", ["-B", "-m", "operations.repository_campaign_evaluator_bridge"], {
			cwd, env: { PATH: "/usr/bin:/bin", PYTHONPATH: cwd, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
			stdio: ["pipe", "pipe", "ignore"], shell: false, detached: process.platform !== "win32",
		})
		let stdout = "", bytes = 0, settled = false
		const done = (error?: Error, code: number | null = null) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve({ stdout, code }) }
		const timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGTERM") } catch { /* already exited */ }; done(new Error("Fleet protected evaluator timed out")) }, timeoutMs)
		timer.unref()
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length
			if (bytes > 16 * 1024) { try { if (child.pid) process.kill(-child.pid, "SIGKILL") } catch { /* already exited */ }; done(new Error("Fleet protected evaluator response exceeded its bound")); return }
			stdout += chunk.toString("utf8")
		})
		child.once("error", () => done(new Error("Fleet protected evaluator could not start")))
		child.once("close", (code) => done(undefined, code))
		child.stdin?.end(input + "\n")
	})
}
