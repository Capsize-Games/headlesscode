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
import {
	makeCurlRepairV2Definition,
} from "./curl-repair-v2-campaign-fixture.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const boardRef = boardReference("a".repeat(64))

function boardReference(result: string): string {
	const card = "1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7"
	const base = `http://127.0.0.1:8078/api/cards/${card}`
	return `${base}#hc-repository-result-v2:${result}`
}

function authority(activeRun: boolean): RepositoryBudgetAuthority {
	const definition = makeCurlRepairV2Definition()
	const now = Date.now()
	return {
		...authorityControl(activeRun, now),
		...authorityRunScope(activeRun, definition, now),
		...authorityLedgers(),
	}
}

function authorityControl(
	activeRun: boolean,
	now: number,
): RepositoryBudgetAuthority {
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
	}
}

function authorityRunScope(
	activeRun: boolean,
	definition: ReturnType<typeof makeCurlRepairV2Definition>,
	now: number,
): Partial<RepositoryBudgetAuthority> {
	return {
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
	}
}

function authorityLedgers(): Partial<RepositoryBudgetAuthority> {
	const zero = zeroLedger()
	return {
		monthly: authorityMonthly(),
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

function zeroLedger(): NonNullable<
	RepositoryBudgetAuthority["legacyLifetime"]
> {
	return {
		settledMicros: 0,
		reservedMicros: 0,
		ambiguousMicros: 0,
		settledTokens: 0,
		reservedTokens: 0,
		ambiguousTokens: 0,
	}
}

function authorityMonthly(): NonNullable<RepositoryBudgetAuthority["monthly"]> {
	return {
		month: new Date().toISOString().slice(0, 7),
		limitMicros: 5_000_000,
		settledMicros: 0,
		reservedMicros: 0,
		ambiguousMicros: 0,
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

type BoardRefClaim = NonNullable<
	Awaited<ReturnType<RepositoryCampaignStore["claimNext"]>>
>

async function v2BoardReferenceSurvivesClaimFinishAndReload(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-v2-boardref-"))
	const file = path.join(root, "state.json")
	const box = { current: false }
	const store = new RepositoryCampaignStore(
		file,
		[makeCurlRepairV2Definition()],
		() => authority(box.current),
	)
	try {
		await startBoardRefRun(store)
		box.current = true
		const claim = await claimBoardRefRun(store)
		await finishBoardRefClaim(store, claim)
		await assertBoardRefReloaded(file, box, claim)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function startBoardRefRun(store: RepositoryCampaignStore): Promise<void> {
	await store.setCampaignBudget(
		CURL_REPAIR_V2_CAMPAIGN_ID,
		CURL_REPAIR_V2_LIFETIME_ALLOCATION.micros,
		CURL_REPAIR_V2_LIFETIME_ALLOCATION.tokens,
	)
	await store.start(CURL_REPAIR_V2_CAMPAIGN_ID)
	await store.observeKnownRepairAdvisoryV2(pinnedIntake())
}

async function claimBoardRefRun(
	store: RepositoryCampaignStore,
): Promise<BoardRefClaim> {
	const claim = await store.claimNext(
		CURL_REPAIR_V2_CAMPAIGN_ID,
		CURL_REPAIR_V2_RESERVATION,
		new Date(),
		{ executionKind: "live-cve" },
	)
	if (!claim) throw new Error("boardref fixture produced no claim")
	return claim
}

async function finishBoardRefClaim(
	store: RepositoryCampaignStore,
	claim: BoardRefClaim,
): Promise<void> {
	await assert.rejects(
		store.updateClaimProgress(claim, progress("https://example.com")),
		/campaign progress update is invalid/,
	)
	await store.updateClaimProgress(claim, progress(boardRef))
	await store.finish(claim, {
		status: "succeeded",
		actualMicros: 0,
		actualTokens: 0,
		progress: { boardRef },
	})
}

async function assertBoardRefReloaded(
	file: string,
	box: { current: boolean },
	claim: BoardRefClaim,
): Promise<void> {
	const reopened = new RepositoryCampaignStore(
		file,
		[makeCurlRepairV2Definition()],
		() => authority(box.current),
	)
	const view = await reopened.recoveryView(claim.job.id)
	assert.equal(view.job?.progress?.boardRef, boardRef)
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
		completedSteps: [
			"intake", "deduplicate", "investigate", "prepare-candidate", "verify",
		],
		boardRef: ref,
	}
}

const tests: readonly SuiteTest[] = [
	[
		"v2 board reference survives a claim, finish, and reload",
		v2BoardReferenceSurvivesClaimFinishAndReload,
	],
]

await runMain("repository-campaign-v2-boardref", tests)
