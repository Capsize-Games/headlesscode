import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
	RepositoryCampaignStore, type ClaimedRepositoryJob,
	type RepositoryBudgetAuthority, type RepositoryCampaignJob,
	type RepositoryEvidenceRef, type RepositoryCampaignDefinition,
} from "../repository-campaigns.js"
import {
	CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_PUBLIC_BASE_REVISION,
	CURL_DEBIAN_SNAPSHOT_SHA256, CURL_DEBIAN_SOURCE_HTML_SHA256,
	CURL_DEBIAN_SOURCE_URL,
} from "../repository-known-advisory.js"
import {
	CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_RESERVATION,
} from "../repository-curl-repair.js"
import { repairDefinition } from "./repository-curl-repair-support.js"
import {
	fleetAuthority, type FleetAuthorityState,
} from "./repository-curl-repair-store-authority.js"

export const definition = repairDefinition()

export interface RetryScenario {
	root: string
	store: RepositoryCampaignStore
	state: FleetAuthorityState
	parent: RepositoryCampaignJob
	claim: ClaimedRepositoryJob; evidenceRefs: RepositoryEvidenceRef[]
}

export type RepairAdvisoryInput =
	Parameters<RepositoryCampaignStore["enqueueKnownRepair"]>[0]

export function repairAdvisoryInput(): RepairAdvisoryInput {
	return {
		campaignId: definition.id, advisoryId: "CVE-2026-92390",
		publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
		snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
		sourceUrl: CURL_DEBIAN_SOURCE_URL,
		sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
		affectedRange: CURL_DEBIAN_AFFECTED_RANGE,
	}
}

export async function openRetryScenario(): Promise<RetryScenario> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repair-retry-"))
	const file = path.join(root, "state.json")
	const state: FleetAuthorityState = {
		snapshotProvisioning: false,
		globalEnabled: true,
		liveRunId: "retry_test_run",
	}
	const store = new RepositoryCampaignStore(file, [definition],
		() => fleetAuthority(state, definition))
	await store.setCampaignBudget(definition.id, 1_000, 7_000)
	await store.start(definition.id)
	const { parent, claim } = await observeLiveClaim(store)
	return {
		root, store, state, parent, claim,
		evidenceRefs: deliveryEvidenceRefs(),
	}
}

export function fixedFleetAuthority(
	definition: RepositoryCampaignDefinition,
): RepositoryBudgetAuthority {
	return fleetAuthority({
		snapshotProvisioning: false,
		globalEnabled: true,
		liveRunId: "retry_test_run",
	}, definition)
}

export async function observeLiveClaim(
	store: RepositoryCampaignStore,
): Promise<{ parent: RepositoryCampaignJob; claim: ClaimedRepositoryJob }> {
	const parent = (await store.observeKnownRepairAdvisory(
		repairAdvisoryInput())).job
	const claim = await store.claimNext(
		definition.id, CURL_REPAIR_RESERVATION, new Date(),
		{ executionKind: "live-cve" })
	assert.ok(claim)
	return { parent, claim: claim! }
}

export function deliveryEvidenceRefs(): RepositoryEvidenceRef[] {
	return [
		{ kind: "intake", id: "1".repeat(64), label: "pinned Debian intake" },
		{ kind: "candidate", id: "2".repeat(64),
			label: "compiled historical candidate" },
		{ kind: "test-receipt", id: "3".repeat(64),
			label: "protected evaluator receipt" },
		{ kind: "diagnostic", id: "4".repeat(64),
			label: "private delivery diagnostic" },
	]
}

export async function updateDeliverProgress(
	store: RepositoryCampaignStore,
	claim: ClaimedRepositoryJob,
	evidenceRefs: RepositoryEvidenceRef[],
): Promise<void> {
	await store.updateClaimProgress(claim, {
		stage: "deliver",
		currentTask: "Record the verified result through private delivery",
		completedSteps: ["intake", "deduplicate", "investigate",
			"prepare-candidate", "verify"],
		blocker: "registered-pipeline-step-failed",
		nextStep:
			"review the private bounded diagnostic before any recovery",
		evidenceRefs, })
}

export async function finishFailedDelivery(
	store: RepositoryCampaignStore,
	claim: ClaimedRepositoryJob,
	actual?: { micros: number; tokens: number },
): Promise<void> {
	await store.finish(claim, {
		status: "failed",
		...(actual === undefined ? {} : {
			actualMicros: actual.micros,
			actualTokens: actual.tokens,
		}),
		progress: {
			currentTask: "Record the verified result through private delivery",
			blocker: "registered-pipeline-step-failed",
			nextStep:
				"review the private bounded diagnostic before any recovery",
		}, })
}

export async function rejectsRetry(
	store: RepositoryCampaignStore,
	jobId: string,
	candidateDigit: string,
	pattern: RegExp,
): Promise<void> {
	await assert.rejects(store.enqueueVerifiedHistoricalRepairRetry(
		jobId, `CONFIRM RETRY HISTORICAL CURL DELIVERY ${jobId}`,
		{
			candidateSha256: candidateDigit.repeat(64),
			verificationSha256: "3".repeat(64),
		}), pattern)
}

type StoredRepairStatus = {
	jobs: Array<{ campaignId: string; purpose?: string }>
	intakeRecords: Array<{ source?: string; jobId?: string }>
}

type RetryJobsStatus = {
	jobs: Array<{ id: string; status: string; retryOf?: string }>
}

export async function assertStoredRepair(
	store: RepositoryCampaignStore,
	jobId: string,
): Promise<void> {
	const status = await store.status() as StoredRepairStatus
	assert.deepEqual(status.jobs.map(
		({ campaignId, purpose }) => ({ campaignId, purpose })),
		[{ campaignId: CURL_REPAIR_CAMPAIGN_ID, purpose: "repair" }])
	assert.deepEqual(status.intakeRecords.map(
		({ source, jobId }) => ({ source, jobId })),
		[{ source: "debian-tracker-repair-snapshot", jobId }])
}

export async function rejectDuplicateRepair(
	store: RepositoryCampaignStore,
	input: RepairAdvisoryInput,
): Promise<void> {
	await assert.rejects(store.enqueueKnownRepair(
		{ ...input, campaignId: "curl-maintenance" }),
		/owner-approved Curl snapshot/)
	await assert.rejects(store.enqueueKnownRepair(input), /already been recorded/)
}

export function assertPersistedJobs(
	status: RetryJobsStatus,
	parent: RepositoryCampaignJob,
	child: RepositoryCampaignJob,
): void {
	assert.deepEqual(status.jobs.map(
		({ id, status, retryOf }) => ({ id, status, retryOf })), [
		{ id: parent.id, status: "failed", retryOf: undefined },
		{ id: child.id, status: "queued", retryOf: parent.id }])
}

export async function rejectSecondRetryRound(
	persisted: RepositoryCampaignStore,
	parent: RepositoryCampaignJob,
): Promise<void> {
	await rejectsRetry(persisted, parent.id, "2", /already has a retry child/)
	await assert.rejects(persisted.enqueueVerifiedHistoricalRepairRetry(
		parent.id, "", {
			candidateSha256: "2".repeat(64),
			verificationSha256: "3".repeat(64),
		}), /confirmation and evidence are required/)
}

export async function rejectUnregisteredRetry(
	persisted: RepositoryCampaignStore,
	child: RepositoryCampaignJob,
): Promise<void> {
	await assert.rejects(persisted.claimNext(
		definition.id, CURL_REPAIR_RESERVATION, new Date(),
		{ executionKind: "live-cve" }),
		/authoritative Fleet v2 registration/)
	await rejectsRetry(persisted, child.id, "2",
		/failed zero-cost verified Curl delivery/)
}

export async function rejectNonTargetRetry(
	scenario: RetryScenario,
	persisted: RepositoryCampaignStore,
	child: RepositoryCampaignJob,
): Promise<void> {
	scenario.state.snapshotProvisioning = false
	const paidClaim = await persisted.claimNext(
		definition.id, CURL_REPAIR_RESERVATION, new Date(),
		{ executionKind: "live-cve" })
	assert.ok(paidClaim)
	await updateDeliverProgress(
		persisted, paidClaim!, deliveryEvidenceRefs())
	await finishFailedDelivery(persisted, paidClaim!, { micros: 1, tokens: 1 })
	await assert.rejects(persisted.enqueueVerifiedHistoricalRepairRetry(
		child.id, `CONFIRM RETRY HISTORICAL CURL DELIVERY ${child.id}`,
		{
			candidateSha256: "2".repeat(64),
			verificationSha256: "3".repeat(64),
		}), /retry target is not the failed zero-cost verified Curl delivery attempt/)
}

export async function rejectRetryAcrossStores(
	scenario: RetryScenario,
	child: RepositoryCampaignJob,
): Promise<void> {
	const persisted = new RepositoryCampaignStore(
		path.join(scenario.root, "state.json"), [definition],
		() => fleetAuthority(scenario.state, definition))
	await rejectUnregisteredRetry(persisted, child)
	const status = await persisted.status() as RetryJobsStatus
	await assertPersistedJobs(status, scenario.parent, child)
	await rejectSecondRetryRound(persisted, scenario.parent)
	await rejectNonTargetRetry(scenario, persisted, child)
}
