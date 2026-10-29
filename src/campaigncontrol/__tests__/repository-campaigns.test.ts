import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const qualified = {
	sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true,
}
const definitions: RepositoryCampaignDefinition[] = [
	{ id: "headlesscode-internal", name: "HeadlessCode", sourceRevision: "a".repeat(40), workerProfile: "mock-worker",
		recipeDigest: "b".repeat(64), evaluatorDigest: "c".repeat(64), model: "synthetic-fixture-only", dataAccessProfile: "fixture-only", qualification: qualified },
	{ id: "fleet-security-watch", name: "Fleet Security Watch", sourceRevision: "d".repeat(40), workerProfile: "mock-worker",
		recipeDigest: "e".repeat(64), evaluatorDigest: "f".repeat(64), model: "synthetic-fixture-only", dataAccessProfile: "fixture-only", qualification: qualified },
	{ id: "missing-worker", name: "Missing Worker", sourceRevision: null, workerProfile: null,
		recipeDigest: null, evaluatorDigest: null, model: null, dataAccessProfile: null,
		qualification: { ...qualified, sourceAudited: false, workerQualified: false, recipeQualified: false, evaluatorQualified: false, modelApproved: false, dataApproved: false, accessApproved: false } },
]

async function fixture(initialLimit = 70_000): Promise<{ root: string; store: RepositoryCampaignStore; setLimit(value: RepositoryBudgetAuthority): void }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repository-campaigns-"))
	let authority: RepositoryBudgetAuthority = { mode: "synthetic-test", available: true, limitMicros: initialLimit, limitTokens: initialLimit, committedMicros: 0, committedTokens: 0 }
	return { root, store: new RepositoryCampaignStore(path.join(root, "repository-campaigns.json"), definitions, () => authority), setLimit: (value) => { authority = value } }
}

async function testAggregateClaimsAreAtomicAcrossRepositories(): Promise<void> {
	const { root, store, setLimit } = await fixture(80_000)
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		for (const id of ["headlesscode-internal", "fleet-security-watch"]) {
			await store.setCampaignBudget(id, 40_000, 40_000, now)
			await store.start(id, now)
			await store.enqueue(id, "CVE-2026-1234", now)
		}
		setLimit({ mode: "synthetic-test", available: true, limitMicros: 80_000, limitTokens: 80_000, committedMicros: 30_000, committedTokens: 30_000 })
		const claims = await Promise.all([
			store.claimNext("headlesscode-internal", { micros: 40_000, tokens: 40_000 }, now),
			store.claimNext("fleet-security-watch", { micros: 40_000, tokens: 40_000 }, now),
		])
		assert.equal(claims.filter(Boolean).length, 1, "aggregate reservation serializes concurrent repository claims")
		assert.equal((await store.status(now) as any).budget.reservedMicros, 40_000)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testStopCancelsQueuedWorkAndFencesNewClaims(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		const startEpoch = ((await store.status(now) as any).campaigns.find((c: any) => c.id === "headlesscode-internal")).epoch
		await store.start("headlesscode-internal", now)
		assert.equal(((await store.status(now) as any).campaigns.find((c: any) => c.id === "headlesscode-internal")).epoch, startEpoch)
		const queued = await store.enqueue("headlesscode-internal", "CVE-2026-1235", now)
		await store.stop("headlesscode-internal", now)
		const stopEpoch = ((await store.status(now) as any).campaigns.find((c: any) => c.id === "headlesscode-internal")).epoch
		await store.stop("headlesscode-internal", now)
		assert.equal(((await store.status(now) as any).campaigns.find((c: any) => c.id === "headlesscode-internal")).epoch, stopEpoch)
		assert.equal((await store.claimNext("headlesscode-internal", { micros: 1, tokens: 1 }, now)), undefined)
		const state = await store.status(now) as any
		assert.equal(state.campaigns.find((c: any) => c.id === "headlesscode-internal").enabled, false)
		assert.equal(state.jobs.find((j: any) => j.id === queued.id).status, "cancelled")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testRestartTurnsLostClaimAmbiguousWithoutReplaying(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		const queued = await store.enqueue("headlesscode-internal", "CVE-2026-1236", now)
		const claim = await store.claimNext("headlesscode-internal", { micros: 50_000, tokens: 50_000 }, now)
		assert.ok(claim)
		const restarted = new RepositoryCampaignStore(store.path, definitions)
		assert.equal((await restarted.claimNext("headlesscode-internal", { micros: 1, tokens: 1 }, now)), undefined, "running job is not dispatched twice after restart")
		assert.equal(await restarted.recoverInterrupted(now), 1)
		assert.equal((await restarted.claimNext("headlesscode-internal", { micros: 1, tokens: 1 }, now)), undefined, "ambiguous job remains held for review")
		const state = await restarted.status(now) as any
		assert.equal(state.jobs.find((j: any) => j.id === queued.id).status, "ambiguous")
		assert.equal(state.budget.ambiguousMicros, 50_000)
		assert.equal(state.budget.ambiguousTokens, 50_000)
		await assert.rejects(restarted.finish(claim!, { status: "succeeded", actualMicros: 1, actualTokens: 1 }, now), /stale/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testMissingWorkerReadinessBlocksClaimsAndExposesGap(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await assert.rejects(store.start("missing-worker", now), /audited-private-source/)
		await store.enqueue("missing-worker", "CVE-2026-1237", now)
		assert.equal(await store.claimNext("missing-worker", { micros: 1, tokens: 1 }, now), undefined)
		const state = await store.status(now) as any
		assert.equal(state.campaigns.find((c: any) => c.id === "missing-worker").readiness, "blocked-prerequisite")
		assert.ok(state.campaigns.find((c: any) => c.id === "missing-worker").readinessReasons.includes("qualified-worker"))
		assert.equal(state.jobs[0].status, "queued")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testProductionDefaultBlocksEvenQualifiedRegistryWithoutBroker(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repository-no-broker-"))
	const store = new RepositoryCampaignStore(path.join(root, "repository-campaigns.json"), definitions)
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await assert.rejects(store.setCampaignBudget("headlesscode-internal", 100, 100, now), /authoritative Fleet allocation or broker authority is unavailable/)
		await assert.rejects(store.start("headlesscode-internal", now), /authoritative-broker-budget/)
		assert.equal((await store.status(now) as any).budget.available, false)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testRepeatedAdvisoryEnqueueIsIdempotentAndStopThenRestartUsesNewEpoch(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		const one = await store.enqueue("headlesscode-internal", "CVE-2026-1238", now)
		const duplicate = await store.enqueue("headlesscode-internal", "CVE-2026-1238", now)
		assert.equal(duplicate.id, one.id)
		await store.stop("headlesscode-internal", now)
		await store.start("headlesscode-internal", new Date(now.getTime() + 1))
		const second = await store.enqueue("headlesscode-internal", "CVE-2026-1238", new Date(now.getTime() + 2))
		assert.notEqual(second.id, one.id)
		assert.ok(second.epoch > one.epoch)
		const firstPage = await store.historyPage("headlesscode-internal", 0, 2, now)
		assert.equal(firstPage.items.length, 2)
		assert.equal(firstPage.nextCursor, 2)
		assert.ok(firstPage.nextCursor !== null)
		const nextPage = await store.historyPage("headlesscode-internal", firstPage.nextCursor, 2, now)
		assert.ok(nextPage.items.length > 0)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testLifetimeBudgetsSurviveMonthRolloverAndDoNotResume(): Promise<void> {
	const { root, store } = await fixture(70_000)
	try {
		const october = new Date("2026-10-31T23:59:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, october)
		await store.start("headlesscode-internal", october)
		await store.enqueue("headlesscode-internal", "CVE-2026-1239", october)
		const claim = await store.claimNext("headlesscode-internal", { micros: 50_000, tokens: 50_000 }, october)
		assert.ok(claim)
		await store.finish(claim!, { status: "succeeded", actualMicros: 50_000, actualTokens: 50_000 }, october)
		const november = await store.status(new Date("2026-11-01T00:01:00Z")) as any
		const campaign = november.campaigns.find((item: any) => item.id === "headlesscode-internal")
		assert.equal(campaign.settledMicros, 50_000)
		assert.equal(campaign.settledTokens, 50_000)
		assert.equal(campaign.exhausted, true)
		assert.equal(await store.claimNext("headlesscode-internal", { micros: 1, tokens: 1 }, new Date("2026-11-01T00:01:00Z")), undefined)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testStopHoldsInFlightReservationUntilMeasuredSettlement(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		await store.enqueue("headlesscode-internal", "CVE-2026-1240", now)
		const claim = await store.claimNext("headlesscode-internal", { micros: 20_000, tokens: 20_000 }, now)
		assert.ok(claim)
		await store.stop("headlesscode-internal", new Date(now.getTime() + 1))
		const stopped = await store.status(new Date(now.getTime() + 1)) as any
		assert.equal(stopped.budget.reservedMicros, 20_000)
		assert.equal(stopped.budget.reservedTokens, 20_000)
		await store.finish(claim!, { status: "succeeded", actualMicros: 9_000, actualTokens: 8_000 }, new Date(now.getTime() + 2))
		const settled = await store.status(new Date(now.getTime() + 2)) as any
		assert.equal(settled.budget.reservedMicros, 0)
		assert.equal(settled.budget.settledMicros, 9_000)
		assert.equal(settled.budget.settledTokens, 8_000)
		assert.equal(settled.campaigns.find((c: any) => c.id === "headlesscode-internal").enabled, false)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testRequestStartIsFencedAgainstStopButInFlightRequestCanSettle(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		await store.enqueue("headlesscode-internal", "CVE-2026-1242", now)
		const claim = await store.claimNext("headlesscode-internal", { micros: 20_000, tokens: 20_000 }, now)
		assert.ok(claim)
		let sendCount = 0
		let finishRequest!: (value: string) => void
		const pendingResponse = new Promise<string>((resolve) => { finishRequest = resolve })
		const response = store.withClaimRequestStart(claim!, () => { sendCount += 1; return pendingResponse })
		while (sendCount === 0) await new Promise((resolve) => setTimeout(resolve, 1))
		await store.stop("headlesscode-internal", new Date(now.getTime() + 1))
		await assert.rejects(store.withClaimRequestStart(claim!, async () => { sendCount += 1; return "never" }), /stale or stopped/)
		assert.equal(sendCount, 1, "Stop prevents a later send but does not cancel one already started")
		finishRequest("measured-response")
		assert.equal(await response, "measured-response")
		await store.finish(claim!, { status: "succeeded", actualMicros: 8_000, actualTokens: 9_000 }, new Date(now.getTime() + 2))
		const status = await store.status(new Date(now.getTime() + 2)) as any
		assert.equal(status.budget.reservedMicros, 0)
		assert.equal(status.budget.settledMicros, 8_000)
		assert.equal(status.campaigns.find((item: any) => item.id === "headlesscode-internal").enabled, false)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testInjectedMockDispatcherProcessesOnlyOneClaimedJob(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-29T12:00:00Z")
		await store.setCampaignBudget("headlesscode-internal", 50_000, 50_000, now)
		await store.start("headlesscode-internal", now)
		await store.enqueue("headlesscode-internal", "CVE-2026-1241", now)
		let calls = 0
		const dispatcher = async () => { calls += 1; return { status: "succeeded" as const, actualMicros: 10_000, actualTokens: 12_000 } }
		const result = await store.dispatchMockNext("headlesscode-internal", { micros: 20_000, tokens: 20_000 }, dispatcher, now)
		assert.equal(result?.status, "succeeded")
		assert.equal(calls, 1)
		assert.equal(await store.dispatchMockNext("headlesscode-internal", { micros: 20_000, tokens: 20_000 }, dispatcher, now), undefined)
		assert.equal(calls, 1, "empty queue does not trigger a second mock call")
		const status = await store.status(now) as any
		assert.equal(status.budget.settledMicros, 10_000)
		assert.equal(status.budget.settledTokens, 12_000)
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
]

runMain("repository-campaigns", tests)
