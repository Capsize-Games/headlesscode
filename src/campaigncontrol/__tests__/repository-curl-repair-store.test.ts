import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_PUBLIC_BASE_REVISION, CURL_DEBIAN_SNAPSHOT_SHA256,
	CURL_DEBIAN_SOURCE_HTML_SHA256, CURL_DEBIAN_SOURCE_URL } from "../repository-known-advisory.js"
import { CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_EVALUATOR_DIGEST,
	CURL_REPAIR_POLICY_SHA256, CURL_REPAIR_PROFILE_ID, CURL_REPAIR_RECIPE_DIGEST,
	CURL_REPAIR_REPOSITORY_ID, CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_TARGET_REPOSITORY,
	CURL_REPAIR_RESERVATION } from "../repository-curl-repair.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const definition: RepositoryCampaignDefinition = {
	id: CURL_REPAIR_CAMPAIGN_ID, name: "Historical Curl repair",
	repositoryId: CURL_REPAIR_REPOSITORY_ID, repository: CURL_REPAIR_TARGET_REPOSITORY,
	sourceRevision: CURL_REPAIR_SOURCE_REVISION, policySha256: CURL_REPAIR_POLICY_SHA256,
	workerProfile: CURL_REPAIR_PROFILE_ID, recipeDigest: CURL_REPAIR_RECIPE_DIGEST,
	evaluatorDigest: CURL_REPAIR_EVALUATOR_DIGEST, model: "none",
	dataAccessProfile: "public-source-and-published-advisory-only",
	qualification: { sourceAudited: true, workerQualified: true, recipeQualified: true,
		evaluatorQualified: true, modelApproved: true, dataApproved: true, accessApproved: true },
}

function syntheticAuthority(): RepositoryBudgetAuthority {
	return { mode: "synthetic-test", available: true, limitMicros: 100_000, limitTokens: 100_000,
		committedMicros: 0, committedTokens: 0 }
}

async function repairQueueUsesOnlyItsSeparateCampaignIdentity(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repair-store-"))
	const file = path.join(root, "state.json")
	try {
		const store = new RepositoryCampaignStore(file, [definition], syntheticAuthority)
		await store.setCampaignBudget(CURL_REPAIR_CAMPAIGN_ID, 2_000, 18_000)
		await store.start(CURL_REPAIR_CAMPAIGN_ID)
		const input = { campaignId: CURL_REPAIR_CAMPAIGN_ID, advisoryId: "CVE-2026-92390",
			publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION, snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
			sourceUrl: CURL_DEBIAN_SOURCE_URL, sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
			affectedRange: CURL_DEBIAN_AFFECTED_RANGE }
		const job = await store.enqueueKnownRepair(input)
		assert.equal(job.campaignId, CURL_REPAIR_CAMPAIGN_ID)
		assert.equal(job.purpose, "repair")
		await assert.rejects(store.enqueueKnownRepair({ ...input, campaignId: "curl-maintenance" }), /owner-approved Curl snapshot/)
		await assert.rejects(store.enqueueKnownRepair(input), /already been recorded/)
		const reopened = new RepositoryCampaignStore(file, [definition], syntheticAuthority)
		const status = await reopened.status() as { jobs: Array<{ campaignId: string; purpose?: string }>; intakeRecords: Array<{ source?: string; jobId?: string }> }
		assert.deepEqual(status.jobs.map(({ campaignId, purpose }) => ({ campaignId, purpose })),
			[{ campaignId: CURL_REPAIR_CAMPAIGN_ID, purpose: "repair" }])
		assert.deepEqual(status.intakeRecords.map(({ source, jobId }) => ({ source, jobId })),
			[{ source: "debian-tracker-repair-snapshot", jobId: job.id }])
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function failedVerifiedDeliveryCanBeExplicitlyRetriedOnce(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repair-retry-"))
	const file = path.join(root, "state.json")
	const authority = (): RepositoryBudgetAuthority => {
		const now = Date.now(), zero = { settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0,
			settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0 }
		return { mode: "fleet-v2-budget-only", available: false, snapshotOnly: true, limitMicros: 20_000, limitTokens: 108_000,
			committedMicros: 0, committedTokens: 0, asOfMs: now, campaignId: "fleet-security-watch", globalEnabled: true,
			canAdmit: true, controlEpoch: 1, runId: "retry_test_run", runExpiresAtMs: now + 300_000,
			repositoryCampaignId: definition.id, repositoryId: definition.repositoryId, repository: definition.repository,
			sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!, model: "none", profileId: "no-model",
			repositoryEnabled: true, repositoryEpoch: 1,
			monthly: { month: new Date().toISOString().slice(0, 7), limitMicros: 5_000_000,
				settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 },
			campaignLifetime: { limitMicros: 20_000, limitTokens: 108_000, ...zero }, legacyLifetime: { ...zero },
			repositoryLifetime: { limitMicros: 1_000, limitTokens: 7_000, ...zero } }
	}
	try {
		const store = new RepositoryCampaignStore(file, [definition], authority)
		await store.setCampaignBudget(definition.id, 1_000, 7_000)
		await store.start(definition.id)
		const input = { campaignId: definition.id, advisoryId: "CVE-2026-92390", publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
			snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256, sourceUrl: CURL_DEBIAN_SOURCE_URL,
			sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256, affectedRange: CURL_DEBIAN_AFFECTED_RANGE }
		const parent = (await store.observeKnownRepairAdvisory(input)).job
		const claim = await store.claimNext(definition.id, CURL_REPAIR_RESERVATION, new Date(), { executionKind: "live-cve" })
		assert.ok(claim)
		const hex = (digit: string) => digit.repeat(64)
		const evidenceRefs = [
			{ kind: "intake" as const, id: hex("1"), label: "pinned Debian intake" },
			{ kind: "candidate" as const, id: hex("2"), label: "compiled historical candidate" },
			{ kind: "test-receipt" as const, id: hex("3"), label: "protected evaluator receipt" },
			{ kind: "diagnostic" as const, id: hex("4"), label: "private delivery diagnostic" },
		]
		await store.updateClaimProgress(claim!, { stage: "deliver", currentTask: "Record the verified result through private delivery",
			completedSteps: ["intake", "deduplicate", "investigate", "prepare-candidate", "verify"],
			blocker: "registered-pipeline-step-failed", nextStep: "review the private bounded diagnostic before any recovery", evidenceRefs })
		await store.finish(claim!, { status: "failed", progress: { currentTask: "Record the verified result through private delivery",
			blocker: "registered-pipeline-step-failed", nextStep: "review the private bounded diagnostic before any recovery" } })
		const child = await store.enqueueVerifiedHistoricalRepairRetry(parent.id,
			`CONFIRM RETRY HISTORICAL CURL DELIVERY ${parent.id}`, { candidateSha256: hex("2"), verificationSha256: hex("3") })
		assert.equal(child.retryOf, parent.id)
		assert.equal(child.purpose, "repair")
		assert.equal(child.status, "queued")
		const persisted = new RepositoryCampaignStore(file, [definition], authority)
		const status = await persisted.status() as { jobs: Array<{ id: string; status: string; retryOf?: string; purpose?: string }> }
		assert.deepEqual(status.jobs.map(({ id, status, retryOf }) => ({ id, status, retryOf })), [
			{ id: parent.id, status: "failed", retryOf: undefined }, { id: child.id, status: "queued", retryOf: parent.id }])
		await assert.rejects(persisted.enqueueVerifiedHistoricalRepairRetry(parent.id,
			`CONFIRM RETRY HISTORICAL CURL DELIVERY ${parent.id}`, { candidateSha256: hex("2"), verificationSha256: hex("3") }), /already has a retry child/)
		await assert.rejects(persisted.enqueueVerifiedHistoricalRepairRetry(parent.id, "", {
			candidateSha256: hex("2"), verificationSha256: hex("3") }), /confirmation and evidence are required/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["known Curl historical repair is stored only under the separate repair campaign", repairQueueUsesOnlyItsSeparateCampaignIdentity],
	["a failed zero-cost verified Curl delivery has one evidence-bound retry child", failedVerifiedDeliveryCanBeExplicitlyRetriedOnce],
]

await runMain("repository-curl-repair-store", tests)
