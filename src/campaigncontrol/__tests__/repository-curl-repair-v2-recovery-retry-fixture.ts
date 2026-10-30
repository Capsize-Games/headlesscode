import assert from "node:assert/strict"
import * as path from "node:path"
import {
	RepositoryCampaignStore,
	type RepositoryBudgetAuthority,
	type RepositoryCampaignJob,
} from "../repository-campaigns.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "../repository-campaign-ids.js"
import {
	CURL_REPAIR_V2_LIFETIME_ALLOCATION,
	CURL_REPAIR_V2_RESERVATION,
} from "../repository-curl-repair-v2-profile.js"
import {
	CURL_DEBIAN_AFFECTED_RANGE,
	CURL_DEBIAN_PUBLIC_BASE_REVISION,
	CURL_DEBIAN_SNAPSHOT_SHA256,
	CURL_DEBIAN_SOURCE_HTML_SHA256,
	CURL_DEBIAN_SOURCE_URL,
	CURL_FIXED_ADVISORY,
} from "../repository-known-advisory.js"
import { makeCurlRepairV2Definition } from
	"./curl-repair-v2-campaign-fixture.js"

export const definition = makeCurlRepairV2Definition()
export const proofSha256 = "9".repeat(64)
const emptyUsage = {
	settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0,
	settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0,
}
const sharedAuthority: Omit<RepositoryBudgetAuthority,
	"mode" | "asOfMs" | "runId" | "runExpiresAtMs"> = {
	available: false, snapshotOnly: true, limitMicros: 20_000,
	limitTokens: 108_000, committedMicros: 0, committedTokens: 0,
	campaignId: "fleet-security-watch", globalEnabled: true,
	canAdmit: true, controlEpoch: 1,
	repositoryCampaignId: definition.id, repositoryId: definition.repositoryId,
	repository: definition.repository,
	sourceRevision: definition.sourceRevision ?? undefined,
	policySha256: definition.policySha256, model: "none", profileId: "no-model",
	repositoryEnabled: true, repositoryEpoch: 1,
	monthly: {
		month: new Date().toISOString().slice(0, 7),
		limitMicros: 5_000_000, settledMicros: 0, reservedMicros: 0,
		ambiguousMicros: 0,
	},
	campaignLifetime: { limitMicros: 20_000, limitTokens: 108_000, ...emptyUsage },
	legacyLifetime: emptyUsage,
	repositoryLifetime: {
		limitMicros: CURL_REPAIR_V2_LIFETIME_ALLOCATION.micros,
		limitTokens: CURL_REPAIR_V2_LIFETIME_ALLOCATION.tokens, ...emptyUsage,
	},
}
const refs = [
	{
		id: "1".repeat(64), kind: "intake" as const,
		label: "Vetted advisory snapshot",
	},
	{
		id: "2".repeat(64), kind: "diagnostic" as const,
		label: "Private bounded failure diagnostic",
	},
]
type ProgressPatch = Parameters<
	RepositoryCampaignStore["updateClaimProgress"]
>[1]
type AmbiguousFinish = Parameters<RepositoryCampaignStore["finish"]>[1]
type RecoveredResult = Parameters<
	RepositoryCampaignStore["settleRecoveredClaim"]
>[1]

export function authority(activeRun: boolean): RepositoryBudgetAuthority {
	const now = Date.now()
	return {
		...sharedAuthority,
		mode: activeRun ? "fleet-v2-budget-only" : "fleet-v2-readonly",
		asOfMs: now,
		runId: activeRun ? "recovery-retry-test" : null,
		runExpiresAtMs: activeRun ? now + 300_000 : null,
	}
}

export interface FailureFixture {
	file: string
	parent: RepositoryCampaignJob
	store: RepositoryCampaignStore
	stop(): Promise<void>
}

interface StoreFixture {
	file: string
	store: RepositoryCampaignStore
	setActiveRun(value: boolean): void
}

async function createStoreFixture(root: string): Promise<StoreFixture> {
	let activeRun = false
	const file = path.join(root, "campaigns.json")
	const store = new RepositoryCampaignStore(
		file, [definition], () => authority(activeRun),
	)
	const now = new Date()
	await store.setCampaignBudget(definition.id,
		CURL_REPAIR_V2_LIFETIME_ALLOCATION.micros,
		CURL_REPAIR_V2_LIFETIME_ALLOCATION.tokens, now)
	await store.start(definition.id, now)
	return { file, store, setActiveRun: (value) => { activeRun = value } }
}

export async function makeFailedPrepare(
	root: string, candidate = false,
): Promise<FailureFixture> {
	const fixture = await createStoreFixture(root)
	const now = new Date()
	const parent = await fixture.store.enqueueKnownRepairV2(pinnedInput(), now)
	fixture.setActiveRun(true)
	await failPrepareClaim(fixture.store, candidate, now)
	fixture.setActiveRun(false)
	return {
		file: fixture.file, parent, store: fixture.store,
		stop: async () => { await fixture.store.stop(definition.id) },
	}
}

async function failPrepareClaim(
	store: RepositoryCampaignStore, candidate: boolean, now: Date,
): Promise<void> {
	const claim = await store.claimNext(
		definition.id, CURL_REPAIR_V2_RESERVATION, now,
		{ executionKind: "live-cve" },
	)
	assert.ok(claim)
	await store.updateClaimProgress(claim!, failedPrepareProgress(candidate))
	await store.finish(claim!, ambiguousPrepareFailure())
	await store.settleRecoveredClaim(claim!, recoveredNoCall(),
		new Date(now.getTime() + 1))
}

function failedPrepareProgress(candidate: boolean): ProgressPatch {
	const candidateRef = {
		id: "3".repeat(64), kind: "candidate" as const,
		label: "Candidate source digest",
	}
	return {
		stage: "prepare-candidate" as const,
		currentTask: "Prepare the bounded isolated workspace",
		completedSteps: ["intake", "deduplicate", "investigate"],
		evidenceRefs: candidate ? [...refs, candidateRef] : refs,
	}
}

function ambiguousPrepareFailure(): AmbiguousFinish {
	return {
		status: "ambiguous" as const,
		progress: {
			currentTask: "Prepare the bounded isolated workspace",
			blocker: "registered-pipeline-step-failed",
			nextStep: "review the private bounded diagnostic before any recovery",
		},
	}
}

function recoveredNoCall(): RecoveredResult {
	return {
		status: "failed" as const, actualMicros: 0, actualTokens: 0,
		proofSha256,
	}
}

function pinnedInput(): Parameters<
	RepositoryCampaignStore["enqueueKnownRepairV2"]
>[0] {
	return {
		campaignId: CURL_REPAIR_V2_CAMPAIGN_ID, advisoryId: CURL_FIXED_ADVISORY,
		publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
		snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
		sourceUrl: CURL_DEBIAN_SOURCE_URL,
		sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
		affectedRange: CURL_DEBIAN_AFFECTED_RANGE,
	}
}
