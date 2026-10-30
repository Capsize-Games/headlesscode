import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { RepositoryCampaignStore, type RepositoryCampaignJob } from
	"../repository-campaigns.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "../repository-campaign-ids.js"
import { runMain, type SuiteTest } from "../../test-runner.js"
import {
	authority,
	definition,
	makeFailedPrepare,
	proofSha256,
	type FailureFixture,
} from "./repository-curl-repair-v2-recovery-retry-fixture.js"

function confirmation(id: string): string {
	return `CONFIRM RETRY RECOVERED CURL V2 NO-CALL ${id}`
}

async function assertRetryInputsRejected(
	fixture: FailureFixture,
): Promise<void> {
	await assert.rejects(fixture.store.enqueueRecoveredCurlRepairV2Retry(
		fixture.parent.id, "", proofSha256), /confirmation and proof/)
	await assert.rejects(fixture.store.enqueueRecoveredCurlRepairV2Retry(
		fixture.parent.id, confirmation(fixture.parent.id), "8".repeat(64)),
		/retry parent/)
}

async function assertReloadedRetry(
	fixture: FailureFixture, child: RepositoryCampaignJob,
): Promise<void> {
	const reopened = new RepositoryCampaignStore(
		fixture.file, [definition], () => authority(false),
	)
	const status = await reopened.status() as {
		jobs: Array<Record<string, unknown>>
		intakeRecords: unknown[]
	}
	assert.equal(status.jobs.length, 2)
	assert.equal(status.jobs[0]?.status, "failed")
	assert.equal(status.jobs[1]?.retryOf, fixture.parent.id)
	assert.equal(status.jobs[1]?.id, child.id)
	assert.equal(status.intakeRecords.length, 1)
}

async function explicitRetryPersistsRootAndProof(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-v2-retry-"))
	try {
		const fixture = await makeFailedPrepare(root)
		await assertRetryInputsRejected(fixture)
		const child = await fixture.store.enqueueRecoveredCurlRepairV2Retry(
			fixture.parent.id, confirmation(fixture.parent.id), proofSha256,
		)
		assert.equal(child.retryOf, fixture.parent.id)
		await assert.rejects(fixture.store.enqueueRecoveredCurlRepairV2Retry(
			fixture.parent.id, confirmation(fixture.parent.id), proofSha256,
		), /already has a retry child/)
		await assertReloadedRetry(fixture, child)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function rejectCandidateParent(root: string): Promise<void> {
	const candidate = await makeFailedPrepare(
		path.join(root, "candidate"), true, true,
	)
	await assert.rejects(candidate.store.enqueueRecoveredCurlRepairV2Retry(
		candidate.parent.id, confirmation(candidate.parent.id), proofSha256,
	), /retry parent/)
}

async function legacyParentCanRetry(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-v2-legacy-retry-"))
	try {
		const fixture = await makeFailedPrepare(root, false, true)
		const child = await fixture.store.enqueueRecoveredCurlRepairV2Retry(
			fixture.parent.id, confirmation(fixture.parent.id), proofSha256,
		)
		assert.equal(child.retryOf, fixture.parent.id)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function rejectActiveJob(root: string): Promise<void> {
	const active = await makeFailedPrepare(path.join(root, "active"))
	await active.store.enqueue(CURL_REPAIR_V2_CAMPAIGN_ID, "CVE-2026-0001")
	await assert.rejects(active.store.enqueueRecoveredCurlRepairV2Retry(
		active.parent.id, confirmation(active.parent.id), proofSha256,
	), /another Curl v2 repair job is active/)
}

async function rejectStoppedCampaign(root: string): Promise<void> {
	const stopped = await makeFailedPrepare(path.join(root, "stopped"))
	await stopped.stop()
	await assert.rejects(stopped.store.enqueueRecoveredCurlRepairV2Retry(
		stopped.parent.id, confirmation(stopped.parent.id), proofSha256,
	), /ready authority/)
	const status = await stopped.store.status() as { jobs: unknown[] }
	assert.equal(status.jobs.length, 1)
}

async function retryRejectsUnsafeParents(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-v2-retry-guard-"))
	try {
		await rejectCandidateParent(root)
		await rejectActiveJob(root)
		await rejectStoppedCampaign(root)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

const tests: readonly SuiteTest[] = [
	[
		"v2 recovered no-call retry is explicit and reloadable",
		explicitRetryPersistsRootAndProof,
	],
	[
		"legacy v2 prepare failure is eligible only without candidate evidence",
		legacyParentCanRetry,
	],
	[
		"v2 retry rejects unsafe parents, active jobs, and Stop",
		retryRejectsUnsafeParents,
	],
]

await runMain("repository-curl-repair-v2-recovery-retry", tests)
