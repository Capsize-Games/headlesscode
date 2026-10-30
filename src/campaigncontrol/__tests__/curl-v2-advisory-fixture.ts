import { createHash } from "node:crypto"
import {
	parseKnownCurlDebianSnapshot, CURL_DEBIAN_AFFECTED_RANGE,
	CURL_DEBIAN_FIXED_REVISION, CURL_DEBIAN_INTRODUCED_REVISION,
	CURL_DEBIAN_PUBLIC_BASE_REVISION, CURL_DEBIAN_SNAPSHOT_SHA256,
	CURL_DEBIAN_SOURCE_HTML_SHA256, CURL_DEBIAN_SOURCE_URL,
	CURL_DEBIAN_SUMMARY, CURL_FIXED_ADVISORY,
	type KnownCurlDebianAdvisory,
} from "../repository-known-advisory.js"

/** Build exact parser-validated facts without reading the operator's HOME. */

export function buildVettedCurlDebianAdvisoryFixture():
	KnownCurlDebianAdvisory {
	const bytes = fixtureBytes()
	const digest = createHash("sha256").update(bytes).digest("hex")
	if (digest !== CURL_DEBIAN_SNAPSHOT_SHA256) {
		throw new Error("Curl advisory fixture digest changed")
	}
	return parseKnownCurlDebianSnapshot(
		bytes, digest, Date.parse("2026-10-30T12:00:00Z"),
	)
}

function fixtureBytes(): Buffer {
	const snapshot = {
		advisoryId: CURL_FIXED_ADVISORY,
		affectedRange: CURL_DEBIAN_AFFECTED_RANGE,
		fixedRevision: CURL_DEBIAN_FIXED_REVISION,
		introducedRevision: CURL_DEBIAN_INTRODUCED_REVISION,
		observedAt: "2026-10-29T22:34:23.039960+00:00",
		publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
		schemaVersion: 1,
		sourceHtmlSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
		sourceUrl: CURL_DEBIAN_SOURCE_URL,
		summary: CURL_DEBIAN_SUMMARY,
	}
	return Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`)
}
