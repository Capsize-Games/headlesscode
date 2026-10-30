import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_PUBLIC_BASE_REVISION, CURL_DEBIAN_SNAPSHOT_SHA256,
	CURL_DEBIAN_SOURCE_HTML_SHA256, CURL_DEBIAN_SOURCE_URL } from "../repository-known-advisory.js"
import { CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_EVALUATOR_DIGEST,
	CURL_REPAIR_POLICY_SHA256, CURL_REPAIR_PROFILE_ID, CURL_REPAIR_RECIPE_DIGEST,
	CURL_REPAIR_REPOSITORY_ID, CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_TARGET_REPOSITORY } from "../repository-curl-repair.js"
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

const tests: readonly SuiteTest[] = [
	["known Curl historical repair is stored only under the separate repair campaign", repairQueueUsesOnlyItsSeparateCampaignIdentity],
]

await runMain("repository-curl-repair-store", tests)
