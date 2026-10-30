import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
	CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA, CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_PATH, CURL_REPAIR_PATCH_SHA256, CURL_REPAIR_PROFILE_ID,
	CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256, CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
	CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256, CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
	curlRepairSourceEnvelopeSha256, type CurlHistoricalRepairCandidate,
} from "../repository-curl-repair.js"
import { CURL_FIXED_ADVISORY } from "../repository-curl-evaluator.js"
import {
	CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_FIXED_REVISION, CURL_DEBIAN_INTRODUCED_REVISION,
	CURL_DEBIAN_PUBLIC_BASE_REVISION, CURL_DEBIAN_SNAPSHOT_SHA256, CURL_DEBIAN_SOURCE_HTML_SHA256,
	CURL_DEBIAN_SOURCE_URL, CURL_DEBIAN_SUMMARY, type KnownCurlDebianAdvisory,
} from "../repository-known-advisory.js"

const patchPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "curl-historical-repair", "b31-to-c24.patch")
const changedPaths = ["src/tool_cb_hdr.c", "tests/data/Makefile.am", "tests/data/test3037", "tests/data/test3038"]

export async function buildCurlHistoricalRepairTestFixture(): Promise<CurlHistoricalRepairCandidate> {
	const patch = await readFile(patchPath)
	const patchSha256 = createHash("sha256").update(patch).digest("hex")
	if (patchSha256 !== CURL_REPAIR_PATCH_SHA256) throw new Error("pinned Curl test patch fixture digest changed")
	const artifactManifestSha256 = digest(canonical({ schemaVersion: 1, role: "source_patch", path: CURL_REPAIR_PATCH_PATH,
		bytes: patch.length, sha256: patchSha256, baseRevision: CURL_REPAIR_HISTORICAL_BASE,
		candidateRevision: CURL_REPAIR_CANDIDATE_REVISION, candidateTreeSha: CURL_REPAIR_CANDIDATE_TREE_SHA,
		allChangedPaths: changedPaths }))
	return { schemaVersion: 1, advisoryId: CURL_FIXED_ADVISORY, profileId: CURL_REPAIR_PROFILE_ID,
		sourceRepository: "Capsize-Games/curl-maintenance", sourceRevision: CURL_REPAIR_HISTORICAL_BASE,
		sourceTreeSha: "b1ea31bb7377dd2bfe08fd67af44860de57afc12",
		candidateRevision: CURL_REPAIR_CANDIDATE_REVISION, candidateTreeSha: CURL_REPAIR_CANDIDATE_TREE_SHA,
		patchPath: CURL_REPAIR_PATCH_PATH, patchBase64: patch.toString("base64"), patchBytes: patch.length,
		patchSha256: patchSha256, sourceEnvelopeSha256: curlRepairSourceEnvelopeSha256(), artifactManifestSha256,
		protectedProof: { profileId: "curl-92390-fixed-v1", evaluatorId: "package-regression-v1",
			evaluatorDigest: CURL_REPAIR_PROTECTED_EVALUATOR_DIGEST,
			evidenceSha256: CURL_REPAIR_PROTECTED_PROOF_EVIDENCE_SHA256,
			receiptSha256: CURL_REPAIR_PROTECTED_RECEIPT_SHA256,
			artifactManifestSha256: CURL_REPAIR_PROTECTED_ARTIFACT_MANIFEST_SHA256,
			phases: ["historical_base-red", "reference_fix-green", "fork_head-green", "candidate-green"] as const },
	}
}

export function makeCurlDebianAdvisoryTestFixture(): KnownCurlDebianAdvisory {
	return { advisoryId: CURL_FIXED_ADVISORY, sourceUrl: CURL_DEBIAN_SOURCE_URL,
		snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256, summary: CURL_DEBIAN_SUMMARY,
		affectedRange: CURL_DEBIAN_AFFECTED_RANGE, fixedVersion: null, verificationCheckIds: ["curl-92390-fixed-v1"],
		publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION, sourceHtmlSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
		introducedRevision: CURL_DEBIAN_INTRODUCED_REVISION, fixedRevision: CURL_DEBIAN_FIXED_REVISION,
		observedAt: new Date().toISOString() }
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex") }
