import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority,
	type RepositoryCampaignDefinition, type RepositoryCampaignJob,
	type RepositoryAdvisoryIntakeRecord } from "../repository-campaigns.js"
import { repositoryProgressSnapshot } from "../repository-progress.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const qualified = {
	sourceAudited: true, workerQualified: true, recipeQualified: true,
		evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true,
}
const definitions: RepositoryCampaignDefinition[] = [
	{ id: "headlesscode-internal", name: "HeadlessCode",
		sourceRevision: "a".repeat(40), policySha256: "1".repeat(64),
			workerProfile: "mock-worker",
		recipeDigest: "b".repeat(64), evaluatorDigest: "c".repeat(64),
			model: "synthetic-fixture-only", dataAccessProfile: "fixture-only",
				qualification: qualified },
	{ id: "fleet-security-watch", name: "Fleet Security Watch",
		sourceRevision: "d".repeat(40), policySha256: "2".repeat(64),
			workerProfile: "mock-worker",
		recipeDigest: "e".repeat(64), evaluatorDigest: "f".repeat(64),
			model: "synthetic-fixture-only", dataAccessProfile: "fixture-only",
				qualification: qualified },
	{ id: "missing-worker", name: "Missing Worker", sourceRevision: null,
		workerProfile: null,
		recipeDigest: null, evaluatorDigest: null, model: null,
			dataAccessProfile: null,
		qualification: { ...qualified, sourceAudited: false,
			workerQualified: false, recipeQualified: false, evaluatorQualified: false,
				modelApproved: false, dataApproved: false, accessApproved: false } },
]

type CampaignStatusSnapshot = {
	budget: { available: boolean; reservedMicros: number; reservedTokens: number; settledMicros: number; settledTokens: number; ambiguousMicros: number; ambiguousTokens: number }
	campaigns: Array<Record<string,
		unknown> & { id: string; epoch: number; enabled: boolean; readiness: string; readinessReasons: string[]; settledMicros: number; settledTokens: number; exhausted: boolean }>
	jobs: Array<RepositoryCampaignJob & { progress: NonNullable<RepositoryCampaignJob["progress"]> }>
	intakeRecords: RepositoryAdvisoryIntakeRecord[]
}

function readStatus(value: Record<string, unknown>): CampaignStatusSnapshot {
	return value as unknown as CampaignStatusSnapshot
}

async function statusAt(store: RepositoryCampaignStore,
	at?: Date): Promise<CampaignStatusSnapshot> {
	return readStatus(await store.status(at))
}

function campaignRow(status: CampaignStatusSnapshot,
	id: string): CampaignStatusSnapshot["campaigns"][number] {
	const row = status.campaigns.find((campaign) => campaign.id === id)
	assert.ok(row)
	return row
}

function jobRow(status: CampaignStatusSnapshot,
	id: string): RepositoryCampaignJob {
	const row = status.jobs.find((job) => job.id === id)
	assert.ok(row)
	return row
}

async function queueJob(store: RepositoryCampaignStore, id: string,
	advisoryId: string, now: Date,
		limit = 50_000): Promise<RepositoryCampaignJob> {
	await store.setCampaignBudget(id, limit, limit, now)
	await store.start(id, now)
	return store.enqueue(id, advisoryId, now)
}

async function campaignEpoch(store: RepositoryCampaignStore, id: string,
	now: Date): Promise<number> {
	const campaign = (await statusAt(store,
		now)).campaigns.find((row) => row.id === id)
	assert.ok(campaign)
	return campaign.epoch
}

async function assertNotClaimable(store: RepositoryCampaignStore, now: Date,
	reason: string): Promise<void> {
	assert.equal(await store.claimNext("headlesscode-internal",
		{ micros: 1, tokens: 1 }, now), undefined, reason)
}

async function assertRestartKeepsClaimAmbiguous(
	store: RepositoryCampaignStore,
	queued: RepositoryCampaignJob,
	claim: NonNullable<Awaited<ReturnType<RepositoryCampaignStore["claimNext"]>>>,
	now: Date,
): Promise<void> {
	const restarted = new RepositoryCampaignStore(store.path, definitions)
	await assertNotClaimable(restarted, now,
		"running job is not dispatched twice after restart")
	assert.equal(await restarted.recoverInterrupted(now), 1)
	await assertNotClaimable(restarted, now,
		"ambiguous job remains held for review")
	const state = await statusAt(restarted, now)
	assert.equal(jobRow(state, queued.id).status, "ambiguous")
	assert.equal(state.budget.ambiguousMicros, 50_000)
	assert.equal(state.budget.ambiguousTokens, 50_000)
	await assert.rejects(restarted.finish(claim, { status: "succeeded",
		actualMicros: 1, actualTokens: 1 }, now), /stale/)
}

async function assertStartIsIdempotent(store: RepositoryCampaignStore,
	id: string, now: Date): Promise<void> {
	const epoch = await campaignEpoch(store, id, now)
	await store.start(id, now)
	assert.equal(await campaignEpoch(store, id, now), epoch)
}

async function fixture(initialLimit = 70_000): Promise<{ root: string; store: RepositoryCampaignStore; setLimit(value: RepositoryBudgetAuthority): void }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(),
		"hcl-repository-campaigns-"))
	let authority: RepositoryBudgetAuthority = { mode: "synthetic-test",
		available: true, limitMicros: initialLimit, limitTokens: initialLimit,
			committedMicros: 0, committedTokens: 0 }
	return { root, store: new RepositoryCampaignStore(path.join(root,
		"repository-campaigns.json"), definitions, () => authority),
			setLimit: (value) => { authority = value } }
}

async function testAggregateClaimsAreAtomicAcrossRepositories(): Promise<void> {
	const { root, store, setLimit } = await fixture(80_000)
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		for (const id of ["headlesscode-internal",
			"fleet-security-watch"]) await queueJob(store, id, "CVE-2026-1234", now,
				40_000)
		setLimit({ mode: "synthetic-test", available: true, limitMicros: 80_000,
			limitTokens: 80_000, committedMicros: 30_000, committedTokens: 30_000 })
		const claims = await Promise.all([
			store.claimNext("headlesscode-internal", { micros: 40_000,
				tokens: 40_000 }, now),
			store.claimNext("fleet-security-watch", { micros: 40_000,
				tokens: 40_000 }, now),
		])
		assert.equal(claims.filter(Boolean).length, 1,
			"aggregate reservation serializes concurrent repository claims")
		assert.equal((await statusAt(store, now)).budget.reservedMicros, 40_000)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testStopCancelsQueuedWorkAndFencesNewClaims(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		const queued = await queueJob(store, "headlesscode-internal", "CVE-2026-1235",
			now)
		await assertStartIsIdempotent(store, "headlesscode-internal", now)
		await store.stop("headlesscode-internal", now)
		const stopEpoch = await campaignEpoch(store, "headlesscode-internal", now)
		await store.stop("headlesscode-internal", now)
		assert.equal(await campaignEpoch(store, "headlesscode-internal", now),
			stopEpoch)
		assert.equal((await store.claimNext("headlesscode-internal", { micros: 1,
			tokens: 1 }, now)), undefined)
		const state = await statusAt(store, now)
		assert.equal(campaignRow(state, "headlesscode-internal").enabled, false)
		assert.equal(jobRow(state, queued.id).status, "cancelled")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testRestartTurnsLostClaimAmbiguousWithoutReplaying(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		const queued = await queueJob(store, "headlesscode-internal", "CVE-2026-1236",
			now)
		const claim = await store.claimNext("headlesscode-internal",
			{ micros: 50_000, tokens: 50_000 }, now)
		assert.ok(claim)
		await assertRestartKeepsClaimAmbiguous(store, queued, claim!, now)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testMissingWorkerReadinessBlocksClaimsAndExposesGap(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await assert.rejects(store.start("missing-worker", now),
			/audited-private-source/)
		await store.enqueue("missing-worker", "CVE-2026-1237", now)
		assert.equal(await store.claimNext("missing-worker", { micros: 1,
			tokens: 1 }, now), undefined)
		const state = await statusAt(store, now)
		const campaign = campaignRow(state, "missing-worker")
		assert.equal(campaign.readiness, "blocked-prerequisite")
		assert.ok(campaign.readinessReasons.includes("qualified-worker"))
		assert.equal(state.jobs[0].status, "queued")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testProductionDefaultBlocksEvenQualifiedRegistryWithoutBroker(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(),
		"hcl-repository-no-broker-"))
	const store = new RepositoryCampaignStore(path.join(root,
		"repository-campaigns.json"), definitions)
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await assert.rejects(store.setCampaignBudget("headlesscode-internal", 100,
			100, now),
				/authoritative Fleet allocation or broker authority is unavailable/)
		await assert.rejects(store.start("headlesscode-internal", now),
			/authoritative-broker-budget/)
		assert.equal((await statusAt(store, now)).budget.available, false)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testRepeatedAdvisoryEnqueueIsIdempotentAndStopThenRestartUsesNewEpoch(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		const one = await store.enqueue("headlesscode-internal", "CVE-2026-1238", now)
		const duplicate = await store.enqueue("headlesscode-internal",
			"CVE-2026-1238", now)
		assert.equal(duplicate.id, one.id)
		await store.stop("headlesscode-internal", now)
		await store.start("headlesscode-internal", new Date(now.getTime() + 1))
		const second = await store.enqueue("headlesscode-internal",
			"CVE-2026-1238", new Date(now.getTime() + 2))
		assert.notEqual(second.id, one.id)
		assert.ok(second.epoch > one.epoch)
		const firstPage = await store.historyPage("headlesscode-internal", 0, 2, now)
		assert.equal(firstPage.items.length, 2)
		assert.equal(firstPage.nextCursor, 2)
		assert.ok(firstPage.nextCursor !== null)
		const nextPage = await store.historyPage("headlesscode-internal",
			firstPage.nextCursor, 2, now)
		assert.ok(nextPage.items.length > 0)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testLifetimeBudgetsSurviveMonthRolloverAndDoNotResume(): Promise<void> {
	const { root, store } = await fixture(70_000)
	try {
		const october = new Date("2026-10-31T23:59:00Z")
		await queueJob(store, "headlesscode-internal", "CVE-2026-1239", october)
		const claim = await store.claimNext("headlesscode-internal",
			{ micros: 50_000, tokens: 50_000 }, october)
		assert.ok(claim)
		await store.finish(claim!, { status: "succeeded", actualMicros: 50_000,
			actualTokens: 50_000 }, october)
		const november = await statusAt(store, new Date("2026-11-01T00:01:00Z"))
		const campaign = november.campaigns.find((item) => item.id === "headlesscode-internal")
		assert.ok(campaign)
		assert.equal(campaign.settledMicros, 50_000)
		assert.equal(campaign.settledTokens, 50_000)
		assert.equal(campaign.exhausted, true)
		assert.equal(await store.claimNext("headlesscode-internal", { micros: 1,
			tokens: 1 }, new Date("2026-11-01T00:01:00Z")), undefined)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testStopHoldsInFlightReservationUntilMeasuredSettlement(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		await store.enqueue("headlesscode-internal", "CVE-2026-1240", now)
		const claim = await store.claimNext("headlesscode-internal",
			{ micros: 20_000, tokens: 20_000 }, now)
		assert.ok(claim)
		await store.stop("headlesscode-internal", new Date(now.getTime() + 1))
		const stopped = await statusAt(store, new Date(now.getTime() + 1))
		assert.equal(stopped.budget.reservedMicros, 20_000)
		assert.equal(stopped.budget.reservedTokens, 20_000)
		await store.finish(claim!, { status: "succeeded", actualMicros: 9_000,
			actualTokens: 8_000 }, new Date(now.getTime() + 2))
		const settled = await statusAt(store, new Date(now.getTime() + 2))
		assert.equal(settled.budget.reservedMicros, 0)
		assert.equal(settled.budget.settledMicros, 9_000)
		assert.equal(settled.budget.settledTokens, 8_000)
		assert.equal(campaignRow(settled, "headlesscode-internal").enabled, false)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testRequestStartIsFencedAgainstStopButInFlightRequestCanSettle(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		await store.enqueue("headlesscode-internal", "CVE-2026-1242", now)
		const claim = await store.claimNext("headlesscode-internal",
			{ micros: 20_000, tokens: 20_000 }, now)
		assert.ok(claim)
		let sendCount = 0
		let finishRequest!: (value: string) => void
		const pendingResponse = new Promise<string>((resolve) => { finishRequest = resolve })
		const response = store.withClaimRequestStart(claim!,
			() => { sendCount += 1; return pendingResponse })
		while (sendCount === 0) await new Promise((resolve) => setTimeout(resolve, 1))
		await store.stop("headlesscode-internal", new Date(now.getTime() + 1))
		await assert.rejects(store.withClaimRequestStart(claim!,
			async () => { sendCount += 1; return "never" }), /stale or stopped/)
		assert.equal(sendCount, 1,
			"Stop prevents a later send but does not cancel one already started")
		finishRequest("measured-response")
		assert.equal(await response, "measured-response")
		await store.finish(claim!, { status: "succeeded", actualMicros: 8_000,
			actualTokens: 9_000 }, new Date(now.getTime() + 2))
		const status = await statusAt(store, new Date(now.getTime() + 2))
		assert.equal(status.budget.reservedMicros, 0)
		assert.equal(status.budget.settledMicros, 8_000)
		assert.equal(campaignRow(status, "headlesscode-internal").enabled, false)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testInjectedMockDispatcherProcessesOnlyOneClaimedJob(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await queueJob(store, "headlesscode-internal", "CVE-2026-1241", now)
		let calls = 0
		const dispatcher = async () => { calls += 1; return { status: "succeeded" as const, actualMicros: 10_000, actualTokens: 12_000 } }
		const result = await store.dispatchMockNext("headlesscode-internal",
			{ micros: 20_000, tokens: 20_000 }, dispatcher, now)
		assert.equal(result?.status, "succeeded")
		assert.equal(calls, 1)
		assert.equal(await store.dispatchMockNext("headlesscode-internal",
			{ micros: 20_000, tokens: 20_000 }, dispatcher, now), undefined)
		assert.equal(calls, 1, "empty queue does not trigger a second mock call")
		const status = await statusAt(store, now)
		assert.equal(status.budget.settledMicros, 10_000)
		assert.equal(status.budget.settledTokens, 12_000)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testClaimProgressIsDurableFencedAndEvidenceIsAppendOnly(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		await store.enqueue("headlesscode-internal", "CVE-2026-1250", now)
		const claim = await store.claimNext("headlesscode-internal",
			{ micros: 20_000, tokens: 20_000 }, now)
		assert.ok(claim)
		const ref = { id: "a".repeat(64), kind: "test-receipt" as const,
			label: "Offline test receipt" }
		const boardRef = `http://127.0.0.1:8078/api/cards/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v1:${"b".repeat(64)}`
		await store.updateClaimProgress(claim!, { stage: "verify", currentTask: "Run the fixed offline regression", completedSteps: ["intake", "deduplicate", "investigate", "prepare-candidate"], nextStep: "deliver", evidenceRefs: [ref], boardRef }, new Date(now.getTime() + 10))
		await store.heartbeat(claim!, new Date(now.getTime() + 20))
		const persisted = new RepositoryCampaignStore(store.path, definitions)
		const status = await persisted.status(new Date(now.getTime() + 21)) as unknown as CampaignStatusSnapshot
		const job = jobRow(status, claim!.job.id)
		assert.ok(job.progress)
		assert.equal(job.progress.executionKind, "development-checkpoint")
		assert.equal(job.progress.workerId.length, 36)
		assert.equal(job.progress.heartbeatAt, now.getTime() + 20)
		assert.equal(job.progress.leaseExpiresAt, now.getTime() + 20 + 120_000)
		assert.equal(job.progress.boardRef, boardRef)
		await assert.rejects(persisted.updateClaimProgress(claim!, { stage: "intake", currentTask: "Reset progress", completedSteps: [] }, new Date(now.getTime() + 30)), /cannot forget completed steps/)
		await assert.rejects(persisted.updateClaimProgress(claim!, { stage: "verify", currentTask: "Replace evidence", completedSteps: ["intake", "deduplicate", "investigate", "prepare-candidate"], evidenceRefs: [] }, new Date(now.getTime() + 31)), /evidence cannot be removed/)
		await assert.rejects(persisted.updateClaimProgress(claim!, { stage: "verify", currentTask: "Replace link", completedSteps: ["intake", "deduplicate", "investigate", "prepare-candidate"], boardRef: "https://example.com/" }, new Date(now.getTime() + 32)), /invalid/)
		await assert.rejects(persisted.updateClaimProgress(claim!, { stage: "verify", currentTask: "Replace link", completedSteps: ["intake", "deduplicate", "investigate", "prepare-candidate"], boardRef: null }, new Date(now.getTime() + 33)), /cannot be removed or changed/)
		const snapshot = repositoryProgressSnapshot(definitions[0]!, campaignRow(status, "headlesscode-internal"), status.jobs.filter((item) => item.campaignId === "headlesscode-internal"), now.getTime() + 21)
		assert.equal(snapshot.executionKind, "development-checkpoint")
		assert.equal(snapshot.freshness.state, "fresh")
		assert.equal(snapshot.workers[0]?.usage.state, "unavailable", "development checkpoint usage is not reported as real spend")
		assert.equal(snapshot.workers[0]?.evidenceRefs[0]?.id, ref.id)
		assert.equal(snapshot.workers[0]?.boardRef, boardRef)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testProgressSnapshotMarksExpiredLeaseStaleAndHidesCounts(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		await store.enqueue("headlesscode-internal", "CVE-2026-1251", now)
		const claim = await store.claimNext("headlesscode-internal", { micros: 20_000, tokens: 20_000 }, now)
		assert.ok(claim)
		const status = await statusAt(store, now)
		const snapshot = repositoryProgressSnapshot(definitions[0]!, campaignRow(status, "headlesscode-internal"), status.jobs, now.getTime() + 120_001)
		assert.equal(snapshot.freshness.state, "stale")
		assert.equal(snapshot.counts.source, "unavailable")
		assert.equal(snapshot.counts.running, null)
		assert.equal(snapshot.budget.source, "unavailable")
		assert.equal(snapshot.budget.monthly.reservedMicros, null)
		await assert.rejects(store.heartbeat(claim!, new Date(now.getTime() + 120_001)), /lease expired/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testSyntheticAuthorityCannotCreateLiveCveProgress(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		await store.enqueue("headlesscode-internal", "CVE-2026-1252", now)
		await assert.rejects(store.claimNext("headlesscode-internal", { micros: 1_000, tokens: 1_000 }, now, { executionKind: "live-cve" }), /authoritative Fleet v2/)
		const status = await statusAt(store, now)
		assert.equal(status.jobs[0].status, "queued")
		assert.equal(status.jobs[0].progress, undefined)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testPublishedAdvisoryIntakePersistsSourceDigestAndQueuesOnlySupportedRecordOnce(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		const source = "a".repeat(40)
		const digest = "b".repeat(64)
		const unsupported = await store.observePublishedAdvisory({ campaignId: "headlesscode-internal", publicBaseRevision: source,
			advisoryId: "CVE-2026-1234", snapshotSha256: "c".repeat(64), eligible: false }, now)
		assert.equal(unsupported.record.disposition, "unsupported-profile")
		assert.equal(unsupported.queued, false)
		const first = await store.observePublishedAdvisory({ campaignId: "headlesscode-internal", publicBaseRevision: source,
			advisoryId: "CVE-2026-1235", snapshotSha256: digest, eligible: true }, now)
		assert.equal(first.changed, true)
		assert.equal(first.queued, true)
		assert.ok(first.record.jobId)
		const restarted = new RepositoryCampaignStore(store.path, definitions)
		const duplicate = await restarted.observePublishedAdvisory({ campaignId: "headlesscode-internal", publicBaseRevision: source,
			advisoryId: "CVE-2026-1235", snapshotSha256: digest, eligible: true }, new Date(now.getTime() + 10))
		assert.equal(duplicate.changed, false)
		assert.equal(duplicate.queued, false)
		const status = await restarted.status(new Date(now.getTime() + 11)) as unknown as CampaignStatusSnapshot
		assert.equal(status.jobs.filter((job) => job.advisoryId === "CVE-2026-1235").length, 1)
		assert.equal(status.jobs.filter((job) => job.advisoryId === "CVE-2026-1234").length, 0)
		assert.equal(status.intakeRecords.length, 2)
		const intake = status.intakeRecords.find((row) => row.advisoryId === "CVE-2026-1234")
		assert.ok(intake)
		assert.equal(intake.disposition, "unsupported-profile")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testVerifiedNoCallProofSettlesOnlyTheAmbiguousClaimAndPersistsEvidence(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await queueJob(store, "headlesscode-internal", "CVE-2026-1236", now, 50_000)
		const claim = await store.claimNext("headlesscode-internal", { micros: 20_000, tokens: 20_000 }, now)
		assert.ok(claim)
		await store.finish(claim!, { status: "ambiguous" }, now)
		const restarted = new RepositoryCampaignStore(store.path, definitions)
		const proofSha256 = "9".repeat(64)
		await restarted.settleRecoveredClaim(claim!, { status: "failed", actualMicros: 0, actualTokens: 0, proofSha256 }, new Date(now.getTime() + 1))
		const verifiedRestart = new RepositoryCampaignStore(store.path, definitions)
		const state = await statusAt(verifiedRestart, new Date(now.getTime() + 2))
		const job = jobRow(state, claim!.job.id)
		assert.equal(job.status, "failed")
		assert.equal(job.settledMicros, 0)
		assert.equal(job.settledTokens, 0)
		assert.ok(job.progress)
		assert.ok(job.progress.evidenceRefs.some((ref) => ref.kind === "no-call-proof" && ref.id === proofSha256))
		assert.equal(state.budget.ambiguousMicros, 0)
		assert.equal(state.budget.ambiguousTokens, 0)
		await verifiedRestart.settleRecoveredClaim(claim!, { status: "failed", actualMicros: 0, actualTokens: 0, proofSha256 }, new Date(now.getTime() + 3))
		await assert.rejects(verifiedRestart.settleRecoveredClaim(claim!, { status: "failed", actualMicros: 0, actualTokens: 0, proofSha256: "8".repeat(64) }, new Date(now.getTime() + 4)), /ambiguous/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["aggregate budget reservations are atomic across repository campaigns", testAggregateClaimsAreAtomicAcrossRepositories],
	["stop cancels queued work and rejects new claims", testStopCancelsQueuedWorkAndFencesNewClaims],
	["restart marks lost claims ambiguous and never replays them", testRestartTurnsLostClaimAmbiguousWithoutReplaying],
	["missing worker readiness remains explicit and prevents dispatch", testMissingWorkerReadinessBlocksClaimsAndExposesGap],
	["production defaults deny admission without authoritative broker integration", testProductionDefaultBlocksEvenQualifiedRegistryWithoutBroker],
	["duplicate enqueue is idempotent and restart uses a new epoch", testRepeatedAdvisoryEnqueueIsIdempotentAndStopThenRestartUsesNewEpoch],
	["campaign lifetime token and spend totals survive monthly rollover without resuming", testLifetimeBudgetsSurviveMonthRolloverAndDoNotResume],
	["Stop keeps in-flight token and spend holds until measured settlement", testStopHoldsInFlightReservationUntilMeasuredSettlement],
	["request start is ordered with Stop and an already-started request remains settleable", testRequestStartIsFencedAgainstStopButInFlightRequestCanSettle],
	["injected mock dispatcher runs one queued job and does not poll an empty queue", testInjectedMockDispatcherProcessesOnlyOneClaimedJob],
	["claim progress persists under the claim lock and cannot forget evidence or completed steps", testClaimProgressIsDurableFencedAndEvidenceIsAppendOnly],
	["expired worker lease makes freshness and counts unavailable", testProgressSnapshotMarksExpiredLeaseStaleAndHidesCounts],
	["synthetic authority cannot create a live-CVE worker claim", testSyntheticAuthorityCannotCreateLiveCveProgress],
	["published advisory intake persists source digests, exposes unsupported rows, and deduplicates after restart", testPublishedAdvisoryIntakePersistsSourceDigestAndQueuesOnlySupportedRecordOnce],
	["verified no-call proof settles only its ambiguous claim and persists evidence", testVerifiedNoCallProofSettlesOnlyTheAmbiguousClaimAndPersistsEvidence],
]

runMain("repository-campaigns", tests)
