import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { RepositoryCampaignBudgetBinding, type RepositoryBudgetLedger } from "../repository-budget-binding.js"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import type { OpenRouterBrokerGrant, OpenRouterBrokerReceipt } from "../../rsi/inference-broker.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const qualification = { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definitions: RepositoryCampaignDefinition[] = [{ id: "test-repository", name: "Test Repository", sourceRevision: "a".repeat(40), policySha256: "1".repeat(64),
	workerProfile: "mock-worker", recipeDigest: "b".repeat(64), evaluatorDigest: "c".repeat(64), model: "fixture-only",
	dataAccessProfile: "fixture-only", qualification }]

async function fixture(): Promise<{ root: string; store: RepositoryCampaignStore; claim: NonNullable<Awaited<ReturnType<RepositoryCampaignStore["claimNext"]>>> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repository-budget-binding-"))
	const authority: RepositoryBudgetAuthority = { mode: "synthetic-test", available: true, limitMicros: 40_000,
		limitTokens: 40_000, committedMicros: 0, committedTokens: 0 }
	const store = new RepositoryCampaignStore(path.join(root, "campaigns.json"), definitions, () => authority)
	const now = new Date("2026-10-29T12:00:00Z")
	await store.setCampaignBudget("test-repository", 40_000, 40_000, now)
	await store.start("test-repository", now)
	await store.enqueue("test-repository", "CVE-2026-4321", now)
	const claim = await store.claimNext("test-repository", { micros: 20_000, tokens: 20_000 }, now)
	assert.ok(claim)
	return { root, store, claim }
}

function grant(jobId: string): OpenRouterBrokerGrant {
	return { jobId, leaseToken: "synthetic-lease", capability: "synthetic-capability", model: "meta/muse-spark-1.3-contributor",
		apiKeyIdentity: "d".repeat(64), profileId: "muse-spark-contributor",
		limits: { campaignId: "fleet-security-watch", maxCalls: 2, maxInputTokensPerCall: 4_000, maxOutputTokensPerCall: 1_000,
			maxTotalTokens: 20_000, maxDurationMs: 60_000, maxRequestBytes: 32_000, maxResponseBytes: 32_000,
			maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 1, maxCallSpendUsd: 0.01,
			maxJobSpendUsd: 0.02, maxCampaignSpendUsd: 0.02 } }
}

function mockLedger() {
	const calls: string[] = []
	const receipt: OpenRouterBrokerReceipt = { provider: "openrouter", endpointProvider: "fleet-budget-authority", jobId: "unused",
		campaignId: "fleet-security-watch", model: "meta/muse-spark-1.3-contributor", returnedModels: [], returnedProviders: [],
		calls: 1, promptTokens: 800, completionTokens: 100, totalTokens: 900, costUsd: 0.005, accounting: "supervisor-enforced",
		qualified: true, callReceipts: [], denials: [] }
	const ledger: RepositoryBudgetLedger = {
		async register(value) { calls.push("register"); return (value.issuedAtMs ?? Date.now()) + 60_000 },
		async recordDenial() { calls.push("denial") },
		async reserve() { calls.push("reserve") },
		async settle() { calls.push("settle") },
		async receipt(value) { calls.push("receipt"); return { ...receipt, jobId: value.jobId } },
		async requestStart() { calls.push("request-start") },
		async reconcile(value) { calls.push("reconcile"); return { calls: [], receipt: { ...receipt, jobId: value.jobId } } },
		async budgetSnapshot() { return {} as Awaited<ReturnType<RepositoryBudgetLedger["budgetSnapshot"]>> },
	}
	return { calls, ledger }
}

async function testRepositorySubcapIsDurableBeforeFleetReservationAndReceiptSettles(): Promise<void> {
	const f = await fixture()
	try {
		const mock = mockLedger()
		const binding = new RepositoryCampaignBudgetBinding(f.store, f.claim, mock.ledger)
		const jobGrant = grant(f.claim.job.id)
		await binding.register(jobGrant)
		await binding.reserve(jobGrant, { callId: "call-001", requestSha256: "e".repeat(64), reservedUsd: 0.01,
			reservedTokens: 5_000, startedAt: new Date().toISOString() })
		await binding.finishFromReceipt(jobGrant)
		const status = await f.store.status(new Date("2026-10-29T12:01:00Z")) as any
		assert.deepEqual(mock.calls, ["register", "reserve", "receipt"])
		assert.equal(status.budget.reservedMicros, 0)
		assert.equal(status.budget.settledMicros, 5_000)
		assert.equal(status.budget.settledTokens, 900)
	} finally { await fs.rm(f.root, { recursive: true, force: true }) }
}

async function testRepositoryBindingRejectsGrantOutsideClaimOrFixedFleetLifetimeCap(): Promise<void> {
	const f = await fixture()
	try {
		const mock = mockLedger()
		const binding = new RepositoryCampaignBudgetBinding(f.store, f.claim, mock.ledger)
		await assert.rejects(binding.register({ ...grant(f.claim.job.id), jobId: "another-job" }), /outside the claimed repository allocation/)
		await assert.rejects(binding.register({ ...grant(f.claim.job.id), limits: { ...grant(f.claim.job.id).limits, campaignId: "other-campaign" } }), /outside the claimed repository allocation/)
		await assert.rejects(binding.register({ ...grant(f.claim.job.id), limits: { ...grant(f.claim.job.id).limits, maxCampaignSpendUsd: 0.03 } }), /outside the claimed repository allocation/)
		assert.deepEqual(mock.calls, [], "invalid claims never reach the shared authority")
	} finally { await fs.rm(f.root, { recursive: true, force: true }) }
}

async function testStopAfterGlobalReservationFencesSendAndKeepsLocalHold(): Promise<void> {
	const f = await fixture()
	try {
		const mock = mockLedger()
		const binding = new RepositoryCampaignBudgetBinding(f.store, f.claim, mock.ledger)
		const jobGrant = grant(f.claim.job.id)
		await binding.register(jobGrant)
		await binding.reserve(jobGrant, { callId: "call-stop-1", requestSha256: "f".repeat(64), reservedUsd: 0.01,
			reservedTokens: 5_000, startedAt: new Date().toISOString() })
		await f.store.stop("test-repository")
		let sends = 0
		await assert.rejects(binding.requestStartGate(async () => { sends += 1; return new Response("unexpected") },
			{ grant: jobGrant, reservation: { callId: "call-stop-1", requestSha256: "f".repeat(64), reservedUsd: 0.01,
				reservedTokens: 5_000, startedAt: new Date().toISOString() } }), /stale or stopped/)
		const status = await f.store.status() as any
		assert.equal(sends, 0)
		assert.equal(mock.calls.filter((entry) => entry === "reserve").length, 1)
		assert.equal(status.budget.reservedMicros, 20_000, "the full job subcap stays held while global reservation is uncertain")
	} finally { await fs.rm(f.root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["repository subcap is claimed before Fleet reservation and measured Fleet receipt settles it", testRepositorySubcapIsDurableBeforeFleetReservationAndReceiptSettles],
	["repository budget binding rejects job, campaign, and lifetime-cap mismatches before authority access", testRepositoryBindingRejectsGrantOutsideClaimOrFixedFleetLifetimeCap],
	["Stop after Fleet reservation fences upstream send and retains the local budget hold", testStopAfterGlobalReservationFencesSendAndKeepsLocalHold],
]

runMain("repository-budget-binding", tests)
