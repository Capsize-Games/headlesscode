import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type {
	RepositoryBudgetAuthority,
	RepositoryCampaignStep,
} from "../repository-campaigns.js"
import { RepositoryCampaignStore } from "../repository-campaigns.js"
import {
	CURL_DEBIAN_AFFECTED_RANGE,
	CURL_DEBIAN_PUBLIC_BASE_REVISION,
	CURL_DEBIAN_SNAPSHOT_SHA256,
	CURL_DEBIAN_SOURCE_HTML_SHA256,
	CURL_DEBIAN_SOURCE_URL,
} from "../repository-known-advisory.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "../repository-campaign-ids.js"
import {
	CURL_REPAIR_V2_LIFETIME_ALLOCATION,
	CURL_REPAIR_V2_RESERVATION,
} from "../repository-curl-repair-v2-profile.js"
import { makeCurlRepairV2Definition } from "./curl-repair-v2-campaign-fixture.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const boardRef = `http://127.0.0.1:8078/api/cards/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v2:${"a".repeat(64)}`

function authority(activeRun: boolean): RepositoryBudgetAuthority {
	const definition = makeCurlRepairV2Definition()
	const now = Date.now()
	const zero = {
		settledMicros: 0,
		reservedMicros: 0,
		ambiguousMicros: 0,
		settledTokens: 0,
		reservedTokens: 0,
		ambiguousTokens: 0,
	}
	return {
		mode: activeRun ? "fleet-v2-budget-only" : "fleet-v2-readonly",
		available: false,
		snapshotOnly: true,
		limitMicros: 20_000,
		limitTokens: 108_000,
		committedMicros: 0,
		committedTokens: 0,
		asOfMs: now,
		campaignId: "fleet-security-watch",
		globalEnabled: true,
		canAdmit: true,
		controlEpoch: 1,
		runId: activeRun ? "boardref-test-run" : null,
		runExpiresAtMs: activeRun ? now + 300_000 : null,
		repositoryCampaignId: definition.id,
		repositoryId: definition.repositoryId,
		repository: definition.repository,
		sourceRevision: definition.sourceRevision ?? undefined,
		policySha256: definition.policySha256,
		model: "none",
		profileId: "no-model",
		repositoryEnabled: true,
		repositoryEpoch: 1,
		monthly: {
			month: new Date().toISOString().slice(0, 7),
			limitMicros: 5_000_000,
			settledMicros: 0,
			reservedMicros: 0,
			ambiguousMicros: 0,
		},
		campaignLifetime: {
			limitMicros: 20_000,
			limitTokens: 108_000,
			...zero,
		},
		legacyLifetime: zero,
		repositoryLifetime: {
			limitMicros: CURL_REPAIR_V2_LIFETIME_ALLOCATION.micros,
			limitTokens: CURL_REPAIR_V2_LIFETIME_ALLOCATION.tokens,
			...zero,
		},
	}
}

function pinnedIntake(): {
	campaignId: string
	advisoryId: string
	publicBaseRevision: string
	snapshotSha256: string
	sourceUrl: string
	sourceContentSha256: string
	affectedRange: string
} {
	return {
		campaignId: CURL_REPAIR_V2_CAMPAIGN_ID,
		advisoryId: "CVE-2026-92390",
		publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
		snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
		sourceUrl: CURL_DEBIAN_SOURCE_URL,
		sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
		affectedRange: CURL_DEBIAN_AFFECTED_RANGE,
	}
}

async function v2BoardReferenceSurvivesClaimFinishAndReload(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-v2-boardref-"))
	const file = path.join(root, "state.json")
	let activeRun = false
	const store = new RepositoryCampaignStore(
		file,
		[makeCurlRepairV2Definition()],
		() => authority(activeRun),
	)
	try {
		await store.setCampaignBudget(
			CURL_REPAIR_V2_CAMPAIGN_ID,
			CURL_REPAIR_V2_LIFETIME_ALLOCATION.micros,
			CURL_REPAIR_V2_LIFETIME_ALLOCATION.tokens,
		)
		await store.start(CURL_REPAIR_V2_CAMPAIGN_ID)
		await store.observeKnownRepairAdvisoryV2(pinnedIntake())
		activeRun = true
		const claim = await store.claimNext(
			CURL_REPAIR_V2_CAMPAIGN_ID,
			CURL_REPAIR_V2_RESERVATION,
			new Date(),
			{ executionKind: "live-cve" },
		)
		assert.ok(claim)
		await assert.rejects(
			store.updateClaimProgress(claim!, progress("https://example.com")),
			/campaign progress update is invalid/,
		)
		await store.updateClaimProgress(claim!, progress(boardRef))
		await store.finish(claim!, {
			status: "succeeded",
			actualMicros: 0,
			actualTokens: 0,
			progress: { boardRef },
		})
		const reopened = new RepositoryCampaignStore(
			file,
			[makeCurlRepairV2Definition()],
			() => authority(activeRun),
		)
		const view = await reopened.recoveryView(claim!.job.id)
		assert.equal(view.job?.progress?.boardRef, boardRef)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

function progress(ref: string): {
	stage: "deliver"
	currentTask: string
	completedSteps: RepositoryCampaignStep[]
	boardRef: string
} {
	return {
		stage: "deliver" as const,
		currentTask: "Record the private result",
		completedSteps: ["intake", "deduplicate", "investigate", "prepare-candidate", "verify"],
		boardRef: ref,
	}
}

const tests: readonly SuiteTest[] = [
	["v2 board reference survives a claim, finish, and reload", v2BoardReferenceSurvivesClaimFinishAndReload],
]

await runMain("repository-campaign-v2-boardref", tests)
