import assert from "node:assert/strict"
import { parseKnownCurlDebianSnapshot, CURL_DEBIAN_AFFECTED_RANGE,
	CURL_DEBIAN_FIXED_REVISION,
	CURL_DEBIAN_INTRODUCED_REVISION, CURL_DEBIAN_PUBLIC_BASE_REVISION,
		CURL_DEBIAN_SOURCE_HTML_SHA256,
	CURL_DEBIAN_SNAPSHOT_SHA256, CURL_DEBIAN_SOURCE_URL, CURL_DEBIAN_SUMMARY,
		CURL_FIXED_ADVISORY } from "../repository-known-advisory.js"
import { RepositoryCampaignStore,
	type RepositoryBudgetAuthority, type RepositoryCampaignDefinition,
	type RepositoryCampaignJob,
	type RepositoryAdvisoryIntakeRecord } from "../repository-campaigns.js"
import { runMain, type SuiteTest } from "../../test-runner.js"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

type CampaignStatusSnapshot = {
	jobs: RepositoryCampaignJob[]
	intakeRecords: RepositoryAdvisoryIntakeRecord[]
}

function readStatus(value: Record<string, unknown>): CampaignStatusSnapshot {
	return value as unknown as CampaignStatusSnapshot
}

function snapshot(now: number): Record<string, unknown> {
	return { schemaVersion: 1, advisoryId: CURL_FIXED_ADVISORY,
		sourceUrl: CURL_DEBIAN_SOURCE_URL,
		sourceHtmlSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
			publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
		introducedRevision: CURL_DEBIAN_INTRODUCED_REVISION,
			fixedRevision: CURL_DEBIAN_FIXED_REVISION,
		summary: CURL_DEBIAN_SUMMARY, affectedRange: CURL_DEBIAN_AFFECTED_RANGE,
			observedAt: new Date(now).toISOString() }
}

async function parserBindsExactFreshFacts(): Promise<void> {
	const now = Date.now()
	const bytes = Buffer.from(JSON.stringify(snapshot(now)))
	const digest = createHash("sha256").update(bytes).digest("hex")
	const result = parseKnownCurlDebianSnapshot(bytes, digest, now)
	assert.equal(result.advisoryId, CURL_FIXED_ADVISORY)
	assert.equal(result.snapshotSha256, digest)
	assert.equal(result.sourceHtmlSha256, CURL_DEBIAN_SOURCE_HTML_SHA256)
	assert.equal(result.fixedRevision, CURL_DEBIAN_FIXED_REVISION)
	assert.deepEqual(result.verificationCheckIds, ["curl-92390-fixed-v1"])
}

async function parserRejectsModifiedAndStaleFacts(): Promise<void> {
	const now = Date.now()
	const wrongSource = Buffer.from(JSON.stringify({ ...snapshot(now),
		sourceUrl: "https://example.invalid/" }))
	assert.throws(() => parseKnownCurlDebianSnapshot(wrongSource,
		createHash("sha256").update(wrongSource).digest("hex"), now),
			/facts do not match/)
	const extra = Buffer.from(JSON.stringify({ ...snapshot(now),
		detail: "unreviewed" }))
	assert.throws(() => parseKnownCurlDebianSnapshot(extra,
		createHash("sha256").update(extra).digest("hex"), now), /schema/)
	const staleAt = now - 31 * 24 * 60 * 60 * 1000
	const stale = Buffer.from(JSON.stringify(snapshot(staleAt)))
	assert.throws(() => parseKnownCurlDebianSnapshot(stale,
		createHash("sha256").update(stale).digest("hex"), now), /stale/)
	const tampered = Buffer.from(JSON.stringify(snapshot(now)))
	assert.throws(() => parseKnownCurlDebianSnapshot(tampered, "0".repeat(64),
		now), /digest/)
}

type QualificationAuthority = (
	campaignId?: string,
) => RepositoryBudgetAuthority

type QualificationRecord = Parameters<
	RepositoryCampaignStore["enqueueKnownQualification"]
>[0]

async function oneShotQualificationIsDurableAndSourceTyped(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(),
		"hcl-known-qualification-"))
	try {
		const definition = qualificationDefinition()
		const authority: QualificationAuthority = () => ({
			mode: "synthetic-test" as const, available: true,
			limitMicros: 20_000, limitTokens: 108_000,
			committedMicros: 0, committedTokens: 0,
		})
		const store = openQualificationStore(root, definition, authority)
		const record = qualificationRecord(definition)
		await runQualificationOnce(store, definition, record)
		await assertQualificationSurvivesRestart(
			store, root, definition, authority, record,
		)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

function qualificationDefinition(): RepositoryCampaignDefinition {
	return {
		id: "curl-maintenance",
		name: "Curl", repositoryId: "curl-maintenance",
		repository: "Capsize-Games/curl-maintenance",
		sourceRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
		policySha256: "a".repeat(64),
		workerProfile: "curl-published-advisory-v1", recipeDigest: "b".repeat(64),
		evaluatorDigest: "c".repeat(64), model: "meta/muse-spark-1.3-contributor",
		dataAccessProfile: "sanitized-advisory-only",
		qualification: {
			sourceAudited: true, workerQualified: true,
			recipeQualified: true, evaluatorQualified: true,
			modelApproved: true, dataApproved: true, accessApproved: true,
		},
	}
}

function openQualificationStore(
	root: string,
	definition: RepositoryCampaignDefinition,
	authority: QualificationAuthority,
): RepositoryCampaignStore {
	const statePath = path.join(root, "campaign.json")
	return new RepositoryCampaignStore(statePath, [definition], authority)
}

function qualificationRecord(
	definition: RepositoryCampaignDefinition,
): QualificationRecord {
	return {
		campaignId: definition.id,
		advisoryId: CURL_FIXED_ADVISORY,
		publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
		snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
		sourceUrl: CURL_DEBIAN_SOURCE_URL,
		sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
		affectedRange: CURL_DEBIAN_AFFECTED_RANGE,
	}
}

async function runQualificationOnce(
	store: RepositoryCampaignStore,
	definition: RepositoryCampaignDefinition,
	record: QualificationRecord,
): Promise<void> {
	await store.setCampaignBudget(definition.id, 20_000, 20_000)
	await store.start(definition.id)
	const job = await store.enqueueKnownQualification(record)
	assert.equal(job.purpose, "qualification")
}

async function assertQualificationSurvivesRestart(
	store: RepositoryCampaignStore,
	root: string,
	definition: RepositoryCampaignDefinition,
	authority: QualificationAuthority,
	record: QualificationRecord,
): Promise<void> {
	const status = readStatus(await store.status())
	assertQualificationIntake(status)
	const restarted = openQualificationStore(root, definition, authority)
	await assert.rejects(
		restarted.enqueueKnownQualification(record),
		/already been recorded/,
	)
	assert.equal(readStatus(await restarted.status()).jobs.length, 1)
}

function assertQualificationIntake(status: CampaignStatusSnapshot): void {
	assert.equal(status.jobs.length, 1)
	assert.equal(status.intakeRecords.length, 1)
	assert.equal(status.intakeRecords[0].source, "debian-tracker-snapshot")
	assert.equal(status.intakeRecords[0].sourceUrl, CURL_DEBIAN_SOURCE_URL)
	assert.equal(
		status.intakeRecords[0].sourceContentSha256,
		CURL_DEBIAN_SOURCE_HTML_SHA256,
	)
}

const tests: readonly SuiteTest[] = [
	["known Debian snapshot parser binds the exact pinned facts and freshness",
		parserBindsExactFreshFacts],
	["known Debian snapshot parser rejects altered, extra and stale facts",
		parserRejectsModifiedAndStaleFacts],
	["one-shot qualification is durable and remains distinct from OSV intake",
		oneShotQualificationIsDurableAndSourceTyped],
]

await runMain("repository-known-advisory", tests)
