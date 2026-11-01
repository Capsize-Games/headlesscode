import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { CURL_CAMPAIGN_ID, CURL_FIXED_ADVISORY, CURL_PROFILE_ID, CURL_PRIVATE_SOURCE_REVISION } from "./repository-curl-evaluator.js"
import type { VettedAdvisorySnapshot } from "./repository-worker.js"

export { CURL_CAMPAIGN_ID, CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"

export const CURL_DEBIAN_SNAPSHOT_PATH = path.join(os.homedir(), ".local/state/fleet-security-watch/automation/repository-campaign-evidence/curl-92390-fixed-v1/debian-advisory-snapshot.json")
export const CURL_DEBIAN_SNAPSHOT_SHA256 = "10873aa601187dce589fc89644de2a32237e94d87c102a05cfeff95101add363"
export const CURL_DEBIAN_SOURCE_HTML_SHA256 = "24ad6d771dc9c007a77c96cb786b93ddcf7111b9ec7644cbf0c7c11f2586c54e"
export const CURL_DEBIAN_PUBLIC_BASE_REVISION = "ce57339379d82d29637b4752979e54128b6b2348"
export const CURL_DEBIAN_INTRODUCED_REVISION = "80675818e0417be8c991513b328c5507e93b47e5"
export const CURL_DEBIAN_FIXED_REVISION = "c24a69d8cd368de4e25e3540bf0b7b000a31d5a7"
export const CURL_DEBIAN_SOURCE_URL = "https://security-tracker.debian.org/tracker/CVE-2026-92390"
export const CURL_DEBIAN_SUMMARY = "Certain interim HTTP responses or header ordering can bypass curl’s existing-file protection when remote header filenames are enabled. The cited upstream commit fixes this behavior."
export const CURL_DEBIAN_AFFECTED_RANGE = `Git introduced=${CURL_DEBIAN_INTRODUCED_REVISION}; fixed=${CURL_DEBIAN_FIXED_REVISION}`
const MAX_SNAPSHOT_BYTES = 8 * 1024
const MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000
const FIELD_NAMES = ["advisoryId", "affectedRange", "fixedRevision", "introducedRevision", "observedAt", "publicBaseRevision", "schemaVersion", "sourceHtmlSha256", "sourceUrl", "summary"]

interface CurlDebianSnapshot {
	schemaVersion: 1
	advisoryId: typeof CURL_FIXED_ADVISORY
	sourceUrl: typeof CURL_DEBIAN_SOURCE_URL
	sourceHtmlSha256: typeof CURL_DEBIAN_SOURCE_HTML_SHA256
	publicBaseRevision: typeof CURL_DEBIAN_PUBLIC_BASE_REVISION
	introducedRevision: typeof CURL_DEBIAN_INTRODUCED_REVISION
	fixedRevision: typeof CURL_DEBIAN_FIXED_REVISION
	summary: typeof CURL_DEBIAN_SUMMARY
	affectedRange: typeof CURL_DEBIAN_AFFECTED_RANGE
	observedAt: string
}

export interface KnownCurlDebianAdvisory extends VettedAdvisorySnapshot {
	publicBaseRevision: string
	sourceHtmlSha256: string
	introducedRevision: string
	fixedRevision: string
	observedAt: string
}

/** Load the one owner-pinned Debian tracker snapshot. This never queries the network or queues work. */
export async function loadKnownCurlDebianAdvisory(now = Date.now()): Promise<KnownCurlDebianAdvisory> {
	const parent = path.dirname(CURL_DEBIAN_SNAPSHOT_PATH)
	const parentStat = await fs.lstat(parent)
	const fileStat = await fs.lstat(CURL_DEBIAN_SNAPSHOT_PATH)
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0 || (parentStat.mode & 0o500) !== 0o500 ||
		(typeof process.getuid === "function" && parentStat.uid !== process.getuid()) || !fileStat.isFile() || fileStat.isSymbolicLink() ||
		fileStat.size > MAX_SNAPSHOT_BYTES || (fileStat.mode & 0o777) !== 0o400 || (typeof process.getuid === "function" && fileStat.uid !== process.getuid()) ||
		await fs.realpath(parent) !== parent || await fs.realpath(CURL_DEBIAN_SNAPSHOT_PATH) !== CURL_DEBIAN_SNAPSHOT_PATH) {
		throw new Error("pinned Debian advisory snapshot is unavailable")
	}
	const bytes = await fs.readFile(CURL_DEBIAN_SNAPSHOT_PATH)
	return parseKnownCurlDebianSnapshot(bytes, CURL_DEBIAN_SNAPSHOT_SHA256, now)
}

/** Parser exported for deterministic tests; production always supplies the compiled immutable digest. */
export function parseKnownCurlDebianSnapshot(bytes: Uint8Array, expectedSha256: string, now = Date.now()): KnownCurlDebianAdvisory {
	if (!Number.isSafeInteger(now) || bytes.byteLength < 2 || bytes.byteLength > MAX_SNAPSHOT_BYTES ||
		!/^[a-f0-9]{64}$/.test(expectedSha256) || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
		throw new Error("pinned Debian advisory snapshot digest is invalid")
	}
	let value: unknown
	try { value = JSON.parse(Buffer.from(bytes).toString("utf8")) } catch { throw new Error("pinned Debian advisory snapshot is invalid JSON") }
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== FIELD_NAMES.join(",")) {
		throw new Error("pinned Debian advisory snapshot schema is invalid")
	}
	const row = value as Record<string, unknown>
	if (row.schemaVersion !== 1 || row.advisoryId !== CURL_FIXED_ADVISORY || row.sourceUrl !== CURL_DEBIAN_SOURCE_URL ||
		row.sourceHtmlSha256 !== CURL_DEBIAN_SOURCE_HTML_SHA256 || row.publicBaseRevision !== CURL_DEBIAN_PUBLIC_BASE_REVISION ||
		row.introducedRevision !== CURL_DEBIAN_INTRODUCED_REVISION || row.fixedRevision !== CURL_DEBIAN_FIXED_REVISION ||
		row.summary !== CURL_DEBIAN_SUMMARY || row.affectedRange !== CURL_DEBIAN_AFFECTED_RANGE || typeof row.observedAt !== "string" ||
		!/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00))$/.test(row.observedAt)) {
		throw new Error("pinned Debian advisory snapshot facts do not match the compiled profile")
	}
	const observedAt = Date.parse(row.observedAt)
	if (!Number.isFinite(observedAt) || observedAt > now + 5 * 60_000 || now - observedAt > MAX_SNAPSHOT_AGE_MS) {
		throw new Error("pinned Debian advisory snapshot is stale")
	}
	return { advisoryId: CURL_FIXED_ADVISORY, sourceUrl: CURL_DEBIAN_SOURCE_URL, snapshotSha256: expectedSha256,
		summary: CURL_DEBIAN_SUMMARY, affectedRange: CURL_DEBIAN_AFFECTED_RANGE, fixedVersion: null, verificationCheckIds: [CURL_PROFILE_ID],
		publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION, sourceHtmlSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
		introducedRevision: CURL_DEBIAN_INTRODUCED_REVISION, fixedRevision: CURL_DEBIAN_FIXED_REVISION, observedAt: String(row.observedAt) }
}

export function isKnownCurlAdvisoryQualification(campaignId: string, advisoryId: string): boolean {
	return campaignId === CURL_CAMPAIGN_ID && advisoryId === CURL_FIXED_ADVISORY
}
