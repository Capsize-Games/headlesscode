import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import { CURL_REPAIR_CAMPAIGN_ID } from "./repository-campaign-ids.js"

export { CURL_REPAIR_CAMPAIGN_ID } from "./repository-campaign-ids.js"

const execFileAsync = promisify(execFile)

export const CURL_REPAIR_PROFILE_ID = "curl-92390-historical-repair-v1"
export const CURL_REPAIR_ADAPTER_ID = "curl-92390-historical-repair-runtime-v1"
export const CURL_REPAIR_REPOSITORY_ID = "curl-maintenance-repair"
export const CURL_REPAIR_HISTORICAL_BASE = "b31c35238d5488fa00185c319f7059938cb474d5"
export const CURL_REPAIR_CANDIDATE_REVISION = "c24a69d8cd368de4e25e3540bf0b7b000a31d5a7"
export const CURL_REPAIR_CANDIDATE_TREE_SHA = "957080ee0bf28efb6f2db01ca0f3065bf216d23a"
export const CURL_REPAIR_SOURCE_REVISION = "ce57339379d82d29637b4752979e54128b6b2348"
export const CURL_REPAIR_SOURCE_TREE_SHA = "af27b838bb0ed82867d6b1c7655defe7a87511fc"
export const CURL_REPAIR_PATCH_SHA256 = "1d9caaffe517b4792b6b7350377bbe77bcd8ba28d54352fa615696fd707c7150"
export const CURL_REPAIR_PATCH_PATH = "src/tool_cb_hdr.c"
export const CURL_REPAIR_ALLOWED_PATHS = Object.freeze([
	"src/tool_cb_hdr.c", "tests/data/Makefile.am", "tests/data/test3037", "tests/data/test3038", "tests/data/test5033",
])
export const CURL_REPAIR_TEST_IDS = Object.freeze(["3037", "3038", "5033"])
export const CURL_REPAIR_TARGET_REPOSITORY = "Capsize-Games/curl-maintenance"
export const CURL_REPAIR_TARGET_BASE = CURL_REPAIR_SOURCE_REVISION
export const CURL_REPAIR_PROTECTED_PROFILE = "curl-92390-fixed-v1"
export const CURL_REPAIR_PROTECTED_EVALUATOR = "package-regression-v1"
export const CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST = "f93f779e79e0a214c33b4684df79a33c6ea07ab9a477c03baef31ddb49ac9560"
export const CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256 = "d49021661a1807d3c0c991e72806c4deda5b29a177419454791b86fa0e052180"
export const CURL_REPAIR_PROTECTED_RECEIPT_SHA256 = "e09bc19de4c667feac255e31d5068b96b11af2bf8a96882519602051dd0d5798"
export const CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256 = "8e48963669c8898efda99ddf3e770fe4712f63b3210e4f75d0820934b398a759"
export const CURL_REPAIR_DELIVERY_POLICY_SHA256_PIN = "43549dbb21dd6677777b276855d6ee5445b5c2fb39cbe8988b951f32d7ecec69"
export const CURL_REPAIR_RESERVATION = Object.freeze({ micros: 1, tokens: 1 })
export const CURL_REPAIR_PRIVATE_SOURCE_ROOT = path.join(os.homedir(), ".local", "share", "headlesscode", "repository-sources", "curl-maintenance")

const REPAIR_PROFILE_PINS = Object.freeze({
	campaignId: CURL_REPAIR_CAMPAIGN_ID,
	repositoryId: CURL_REPAIR_REPOSITORY_ID,
	repository: CURL_REPAIR_TARGET_REPOSITORY,
	sourceRevision: CURL_REPAIR_SOURCE_REVISION,
	historicalBase: CURL_REPAIR_HISTORICAL_BASE,
	candidateRevision: CURL_REPAIR_CANDIDATE_REVISION,
	candidateTreeSha: CURL_REPAIR_CANDIDATE_TREE_SHA,
	patchSha256: CURL_REPAIR_PATCH_SHA256,
	advisoryId: CURL_FIXED_ADVISORY,
	profileId: CURL_REPAIR_PROFILE_ID,
	workerProfile: CURL_REPAIR_PROFILE_ID,
	model: "none",
	modelCalls: 0,
	reservation: CURL_REPAIR_RESERVATION,
	lifetimeMicrosCeiling: 2_000,
	lifetimeTokensCeiling: 18_000,
	allowedPaths: CURL_REPAIR_ALLOWED_PATHS,
	testIds: CURL_REPAIR_TEST_IDS,
	protectedProfile: CURL_REPAIR_PROTECTED_PROFILE,
	protectedEvaluatorDigest: CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
	protectedProofEvidenceSha256: CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
	protectedReceiptSha256: CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
	protectedArtifactManifestSha256: CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256,
	scope: "historical-public-regression-only",
	privateDelivery: "verified-private-fork-draft-only",
	deliveryPolicySha256: CURL_REPAIR_DELIVERY_POLICY_SHA256_PIN,
})

export const CURL_REPAIR_RECIPE_DIGEST = sha256(canonical({ recipe: "curl-regression-v1", base: CURL_REPAIR_HISTORICAL_BASE,
	candidate: CURL_REPAIR_CANDIDATE_REVISION, imageId: "sha256:8924c5d2afd16f45d34a32f34de613ed7146a9557d07deb9edc83588d2dfdc04",
	tests: CURL_REPAIR_TEST_IDS, network: "none", sanitizers: ["address", "undefined"] }))
export const CURL_REPAIR_EVALUATOR_DIGEST = sha256(canonical({ evaluator: "curl-historical-proof-phase-binding-v1",
	proofMode: "reused-signed-offline-phase-evidence", pins: REPAIR_PROFILE_PINS }))
export const CURL_REPAIR_POLICY = Object.freeze({ schemaVersion: 1, ...REPAIR_PROFILE_PINS,
	recipeDigest: CURL_REPAIR_RECIPE_DIGEST, evaluatorDigest: CURL_REPAIR_EVALUATOR_DIGEST,
	dataAccessProfile: "public-source-and-published-advisory-only", executionKind: "live-cve-no-model",
	budget: { maximumAllocationMicros: 2_000, maximumAllocationTokens: 18_000,
		jobReservationMicros: CURL_REPAIR_RESERVATION.micros, jobReservationTokens: CURL_REPAIR_RESERVATION.tokens },
})
export const CURL_REPAIR_POLICY_SHA256 = sha256(canonical(CURL_REPAIR_POLICY))

export interface CurlHistoricalRepairCandidate {
	schemaVersion: 1
	advisoryId: typeof CURL_FIXED_ADVISORY
	profileId: typeof CURL_REPAIR_PROFILE_ID
	sourceRepository: typeof CURL_REPAIR_TARGET_REPOSITORY
	sourceRevision: typeof CURL_REPAIR_HISTORICAL_BASE
	sourceTreeSha: string
	candidateRevision: typeof CURL_REPAIR_CANDIDATE_REVISION
	candidateTreeSha: typeof CURL_REPAIR_CANDIDATE_TREE_SHA
	patchPath: typeof CURL_REPAIR_PATCH_PATH
	patchBase64: string
	patchBytes: number
	patchSha256: typeof CURL_REPAIR_PATCH_SHA256
	sourceEnvelopeSha256: string
	artifactManifestSha256: string
	protectedProof: {
		profileId: typeof CURL_REPAIR_PROTECTED_PROFILE
		evaluatorId: typeof CURL_REPAIR_PROTECTED_EVALUATOR
		evaluatorDigest: typeof CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST
		evidenceSha256: typeof CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256
		receiptSha256: typeof CURL_REPAIR_PROTECTED_RECEIPT_SHA256
		artifactManifestSha256: typeof CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256
		phases: readonly ["historical_base-red", "reference_fix-green", "fork_head-green", "candidate-green"]
	}
}

export function curlRepairSourceEnvelopeSha256(): string {
	return sha256(canonical({ schemaVersion: 1, advisoryId: CURL_FIXED_ADVISORY, profileId: CURL_REPAIR_PROFILE_ID,
		sourceRepository: CURL_REPAIR_TARGET_REPOSITORY, sourceRevision: CURL_REPAIR_HISTORICAL_BASE,
		candidateRevision: CURL_REPAIR_CANDIDATE_REVISION, candidateTreeSha: CURL_REPAIR_CANDIDATE_TREE_SHA,
		patchPath: CURL_REPAIR_PATCH_PATH, patchSha256: CURL_REPAIR_PATCH_SHA256,
		tests: CURL_REPAIR_TEST_IDS, evaluator: CURL_REPAIR_PROTECTED_EVALUATOR,
		evaluatorDigest: CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
		proofEvidenceSha256: CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
		receiptSha256: CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
		artifactManifestSha256: CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256,
		limitations: ["historical-public-regression-only", "current-private-fork-already-contains-fix", "host-applicability-not-assessed"] }))
}

export function curlHistoricalRepairCandidateSha256(candidate: CurlHistoricalRepairCandidate): string {
	return sha256(canonical({ schemaVersion: candidate.schemaVersion, advisoryId: candidate.advisoryId,
		profileId: candidate.profileId, sourceRepository: candidate.sourceRepository,
		sourceRevision: candidate.sourceRevision, sourceTreeSha: candidate.sourceTreeSha,
		candidateRevision: candidate.candidateRevision, candidateTreeSha: candidate.candidateTreeSha,
		patchPath: candidate.patchPath, patchBytes: candidate.patchBytes, patchSha256: candidate.patchSha256,
		sourceEnvelopeSha256: candidate.sourceEnvelopeSha256, artifactManifestSha256: candidate.artifactManifestSha256,
		protectedProof: candidate.protectedProof }))
}

/** Verify the owner-private source pin before automatic repair intake may admit work. */
export async function verifyCurlHistoricalRepairSourcePin(sourceRoot = CURL_REPAIR_PRIVATE_SOURCE_ROOT): Promise<void> {
	const root = path.resolve(sourceRoot)
	const info = await fs.promises.lstat(root)
	if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
		throw new Error("private Curl source checkout is unavailable")
	}
	const [head, tree, status, shallow] = await Promise.all([
		git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD^{tree}"),
		git(root, "status", "--porcelain"), git(root, "rev-parse", "--is-shallow-repository"),
	])
	if (head !== CURL_REPAIR_SOURCE_REVISION || tree !== CURL_REPAIR_SOURCE_TREE_SHA || status !== "" || shallow !== "false") {
		throw new Error("private Curl source pin changed or is not a clean full-history checkout")
	}
}

/** Extract only the one reviewed b31→c24 patch from a clean owner-private full-history checkout. */
export async function buildCurlHistoricalRepairCandidate(sourceRoot = path.join(os.homedir(), ".local/share/headlesscode/repository-sources/curl-maintenance")):
	Promise<CurlHistoricalRepairCandidate> {
	const root = path.resolve(sourceRoot)
	const info = await fs.promises.lstat(root)
	if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
		throw new Error("private Curl source checkout is unavailable")
	}
	const head = await git(root, "rev-parse", "HEAD")
	const status = await git(root, "status", "--porcelain")
	const shallow = await git(root, "rev-parse", "--is-shallow-repository")
	if (head !== CURL_REPAIR_SOURCE_REVISION || status !== "" || shallow !== "false") throw new Error("private Curl source checkout is not the pinned clean full-history source")
	const [historicalTree, candidateTree, sourceTree, parent, patch, names] = await Promise.all([
		git(root, "rev-parse", `${CURL_REPAIR_HISTORICAL_BASE}^{tree}`),
		git(root, "rev-parse", `${CURL_REPAIR_CANDIDATE_REVISION}^{tree}`),
		git(root, "rev-parse", `${CURL_REPAIR_SOURCE_REVISION}^{tree}`),
		git(root, "show", "-s", "--format=%P", CURL_REPAIR_CANDIDATE_REVISION),
		gitBytes(root, "diff", "--binary", CURL_REPAIR_HISTORICAL_BASE, CURL_REPAIR_CANDIDATE_REVISION),
		git(root, "diff", "--name-only", CURL_REPAIR_HISTORICAL_BASE, CURL_REPAIR_CANDIDATE_REVISION),
	])
	if (historicalTree !== "b1ea31bb7377dd2bfe08fd67af44860de57afc12" || candidateTree !== CURL_REPAIR_CANDIDATE_TREE_SHA ||
		sourceTree !== CURL_REPAIR_SOURCE_TREE_SHA || parent !== CURL_REPAIR_HISTORICAL_BASE ||
		sha256(patch) !== CURL_REPAIR_PATCH_SHA256 || !patch.length || patch.length > 2_000_000 ||
		!names.split("\n").filter(Boolean).length || names.split("\n").filter(Boolean).some((name) => !CURL_REPAIR_ALLOWED_PATHS.includes(name))) {
		throw new Error("historical Curl candidate differs from the reviewed source, tree, patch or path pins")
	}
	const artifactManifestSha256 = sha256(canonical({ schemaVersion: 1, role: "source_patch", path: CURL_REPAIR_PATCH_PATH,
		bytes: patch.length, sha256: sha256(patch), baseRevision: CURL_REPAIR_HISTORICAL_BASE,
		candidateRevision: CURL_REPAIR_CANDIDATE_REVISION, candidateTreeSha: CURL_REPAIR_CANDIDATE_TREE_SHA,
		allChangedPaths: names.split("\n").filter(Boolean).sort() }))
	return { schemaVersion: 1, advisoryId: CURL_FIXED_ADVISORY, profileId: CURL_REPAIR_PROFILE_ID,
		sourceRepository: CURL_REPAIR_TARGET_REPOSITORY, sourceRevision: CURL_REPAIR_HISTORICAL_BASE,
		sourceTreeSha: historicalTree, candidateRevision: CURL_REPAIR_CANDIDATE_REVISION,
		candidateTreeSha: CURL_REPAIR_CANDIDATE_TREE_SHA, patchPath: CURL_REPAIR_PATCH_PATH,
		patchBase64: patch.toString("base64"), patchBytes: patch.length, patchSha256: CURL_REPAIR_PATCH_SHA256,
		sourceEnvelopeSha256: curlRepairSourceEnvelopeSha256(), artifactManifestSha256,
		protectedProof: { profileId: CURL_REPAIR_PROTECTED_PROFILE, evaluatorId: CURL_REPAIR_PROTECTED_EVALUATOR,
			evaluatorDigest: CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
			evidenceSha256: CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
			receiptSha256: CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
			artifactManifestSha256: CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256,
			phases: ["historical_base-red", "reference_fix-green", "fork_head-green", "candidate-green"] },
	}
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}

function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex") }

async function git(root: string, ...args: string[]): Promise<string> { return (await gitBytes(root, ...args)).toString("utf8").trimEnd() }

async function gitBytes(root: string, ...args: string[]): Promise<Buffer> {
	const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout: 15_000, maxBuffer: 2_100_000, encoding: "buffer" })
	return Buffer.from(stdout)
}
