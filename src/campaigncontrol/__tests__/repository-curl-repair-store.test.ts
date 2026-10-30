import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
	RepositoryCampaignStore, type RepositoryBudgetAuthority,
	type RepositoryCampaignJob,
} from "../repository-campaigns.js"
import {
	CURL_REPAIR_CAMPAIGN_ID,
} from "../repository-curl-repair.js"
import { syntheticAuthority } from "./repository-curl-repair-store-authority.js"
import {
	assertStoredRepair, definition, finishFailedDelivery,
	fixedFleetAuthority, observeLiveClaim, openRetryScenario, rejectsRetry,
	rejectDuplicateRepair, rejectRetryAcrossStores, repairAdvisoryInput,
	type RetryScenario, updateDeliverProgress,
} from "./repository-curl-repair-store-phases.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

async function failDelivery(scenario: RetryScenario): Promise<void> {
	await updateDeliverProgress(
		scenario.store, scenario.claim, scenario.evidenceRefs)
	await finishFailedDelivery(scenario.store, scenario.claim)
	await rejectsRetry(scenario.store, scenario.parent.id, "9",
		/evidence differs/)
}

async function fenceInvalidSnapshot(
	scenario: RetryScenario,
): Promise<void> {
	scenario.state.globalEnabled = false
	await rejectsRetry(scenario.store, scenario.parent.id, "2",
		/Fleet v2 repository budget snapshot is invalid/)
	scenario.state.globalEnabled = true
}

async function fenceStoppedRetry(
	scenario: RetryScenario,
): Promise<void> {
	await scenario.store.stop(definition.id)
	await rejectsRetry(scenario.store, scenario.parent.id, "2",
		/started campaign/)
	await scenario.store.start(definition.id)
}

async function acceptProvisionedRetry(
	scenario: RetryScenario,
): Promise<RepositoryCampaignJob> {
	scenario.state.snapshotProvisioning = true
	const child = await scenario.store.enqueueVerifiedHistoricalRepairRetry(
		scenario.parent.id,
		`CONFIRM RETRY HISTORICAL CURL DELIVERY ${scenario.parent.id}`,
		{
			candidateSha256: "2".repeat(64),
			verificationSha256: "3".repeat(64),
		})
	assert.equal(child.retryOf, scenario.parent.id)
	assert.equal(child.purpose, "repair")
	assert.equal(child.status, "queued")
	return child
}

async function repairQueueUsesOnlyItsSeparateCampaignIdentity(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repair-store-"))
	try {
		const store = new RepositoryCampaignStore(
			path.join(root, "state.json"), [definition], syntheticAuthority)
		await store.setCampaignBudget(CURL_REPAIR_CAMPAIGN_ID, 2_000, 18_000)
		await store.start(CURL_REPAIR_CAMPAIGN_ID)
		const input = repairAdvisoryInput()
		const job = await store.enqueueKnownRepair(input)
		assert.equal(job.campaignId, CURL_REPAIR_CAMPAIGN_ID)
		assert.equal(job.purpose, "repair")
		await rejectDuplicateRepair(store, input)
		const reopened = new RepositoryCampaignStore(
			path.join(root, "state.json"), [definition], syntheticAuthority)
		await assertStoredRepair(reopened, job.id)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function
	failedVerifiedDeliveryCanBeExplicitlyRetriedOnce(
	): Promise<void> {
	const scenario = await openRetryScenario()
	try {
		await failDelivery(scenario)
		await fenceInvalidSnapshot(scenario)
		await fenceStoppedRetry(scenario)
		const child = await acceptProvisionedRetry(scenario)
		await rejectRetryAcrossStores(scenario, child)
	} finally {
		await fs.rm(scenario.root, { recursive: true, force: true })
	}
}

async function ambiguousRepairCannotBeRetried(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(),
		"hcl-repair-ambiguous-retry-"))
	const authority = (): RepositoryBudgetAuthority =>
		fixedFleetAuthority(definition)
	try {
		const store = new RepositoryCampaignStore(
			path.join(root, "state.json"), [definition], authority)
		await store.setCampaignBudget(definition.id, 1_000, 7_000)
		await store.start(definition.id)
		const { parent, claim } = await observeLiveClaim(store)
		await store.finish(claim, { status: "ambiguous" })
		await rejectsRetry(store, parent.id, "2",
			/retry target is not the failed zero-cost verified Curl delivery attempt/)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

const separateIdentityTitle =
	"known Curl historical repair is stored only under the separate " +
	"repair campaign"
const retryChildTitle =
	"a failed zero-cost verified Curl delivery has one evidence-bound retry child"
const ambiguousTitle = "an ambiguous Curl repair claim cannot be retried"

const tests: readonly SuiteTest[] = [
	[separateIdentityTitle,
		repairQueueUsesOnlyItsSeparateCampaignIdentity],
	[retryChildTitle, failedVerifiedDeliveryCanBeExplicitlyRetriedOnce],
	[ambiguousTitle, ambiguousRepairCannotBeRetried],
]

await runMain("repository-curl-repair-store", tests)
