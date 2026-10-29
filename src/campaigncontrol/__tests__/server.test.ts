import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { request, type Server } from "node:http"
import { CampaignControlStore, type CampaignControlState } from "../store.js"
import { startCampaignControlServer, type CampaignMutation } from "../server.js"
import { readCampaignRsiStatus, type CampaignRsiStatus } from "../rsi.js"
import type { ProviderRsiStatus } from "../provider-rsi.js"
import type { CampaignJobReport, CampaignReadinessReport } from "../runner.js"
import { RepositoryCampaignStore, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const currentMonth = () => new Date().toISOString().slice(0, 7)

async function fixture(token?: string, readRsi?: () => Promise<CampaignRsiStatus>,
	readJobs?: () => Promise<CampaignJobReport>): Promise<{
	root: string
	store: CampaignControlStore
	server: Server
	base: string
	mutations: Array<{ action: CampaignMutation; micros?: number }>
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-campaign-server-"))
	const staticRoot = path.join(root, "dist")
	await fs.mkdir(path.join(staticRoot, "assets"), { recursive: true })
	await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>Campaign UI</title>")
	await fs.writeFile(path.join(staticRoot, "assets", "app.js"), "document.body.dataset.ready='true'")
	await fs.writeFile(path.join(staticRoot, "secret.json"), "not served")
	const store = new CampaignControlStore(path.join(root, "control.json"))
	const now = new Date()
	await store.setBudgetLimit(2_000_000, now)
	await store.setEnabled(true, now)
	await store.updateBudgetProjection({ month: currentMonth(), settledMicros: 250_000,
		reservedMicros: 125_000, ambiguousMicros: 75_000 }, now)
	const mutations: Array<{ action: CampaignMutation; micros?: number }> = []
	const server = await startCampaignControlServer({
		port: 0, staticRoot, store, controlPath: store.path, adapterPath: path.join(root, "adapter.json"),
		token,
		loadAdapter: async () => ({ releaseRoot: root, stateRoot: root, releaseDigest: "a".repeat(64) }),
		readBudget: async () => ({ month: currentMonth(), settledMicros: 250_000,
			reservedMicros: 125_000, ambiguousMicros: 75_000 }),
		readJobs: readJobs ?? (async () => ({ jobs: [], jobDetailsAvailable: false })),
		readRsi: readRsi ?? (async () => ({ mode: "offline-synthetic-only", status: "not-run",
			activation: "not-performed", limits: { modelCalls: 0, spendUsd: 0,
				comparisons: 1, maxDurationSeconds: 30, maxFixtures: 500 }, history: [] })),
		mutate: async (action, micros) => {
			mutations.push({ action, ...(micros === undefined ? {} : { micros }) })
			if (action === "on" || action === "off") return store.setEnabled(action === "on")
			return store.setBudgetLimit(micros!)
		},
	})
	const address = server.address()
	assert.ok(address && typeof address !== "string")
	return { root, store, server, base: `http://127.0.0.1:${address.port}`, mutations }
}

async function testApiShowsProfileCoverageAndCompletionCounts(): Promise<void> {
	const readiness: CampaignReadinessReport = { schemaVersion: 1, configuredCount: 2, qualifiedCount: 1,
		profiles: [{ profileId: "curl-profile-v1", state: "qualified" },
			{ profileId: "expat-profile-v1", state: "qualification-pending" }],
		completion: { pendingHumanReview: 1, pendingHumanApproval: 0, failed: 0, deliveryPending: 1 } }
	const f = await fixture(undefined, undefined, async () => ({ jobs: [], jobDetailsAvailable: false, readiness }))
	try {
		const response = await fetch(`${f.base}/api/campaign-control`)
		assert.equal(response.status, 200)
		const body = await response.json() as Record<string, any>
		assert.equal(body.readiness.available, true)
		assert.equal(body.readiness.configuredCount, 2)
		assert.equal(body.readiness.qualifiedCount, 1)
		assert.equal(body.readiness.completion.pendingHumanReview, 1)
		assert.equal(JSON.stringify(body.readiness).includes(f.root), false)
	} finally { await close(f) }
}

async function close(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
	await new Promise<void>((resolve, reject) => f.server.close((error) => error ? reject(error) : resolve()))
	await fs.rm(f.root, { recursive: true, force: true })
}

async function rawGet(url: string, headers: Record<string, string>): Promise<number> {
	const target = new URL(url)
	return new Promise((resolve, reject) => {
		const req = request({ hostname: "127.0.0.1", port: Number(target.port), path: target.pathname,
			method: "GET", headers }, (res) => {
			res.resume()
			res.once("end", () => resolve(res.statusCode ?? 0))
		})
		req.once("error", reject)
		req.end()
	})
}

async function testLoopbackApiReportsActualBudgetAndNoFabricatedJobs(): Promise<void> {
	const f = await fixture()
	try {
		const response = await fetch(`${f.base}/api/campaign-control`)
		assert.equal(response.status, 200)
		const body = await response.json() as Record<string, any>
		assert.equal(body.control.enabled, true)
		assert.equal(body.budget.limitMicros, 2_000_000)
		assert.equal(body.budget.settledMicros, 250_000)
		assert.equal(body.budget.reservedMicros, 125_000)
		assert.equal(body.budget.ambiguousMicros, 75_000)
		assert.equal(body.budget.remainingMicros, 1_550_000)
		assert.equal(body.jobs.length, 0)
		assert.equal(body.jobDetailsAvailable, false)
		assert.equal(body.rsi.mode, "offline-synthetic-only")
		assert.equal(body.rsi.status, "not-run")
		assert.equal(body.rsi.limits.modelCalls, 0)
		assert.deepEqual(body.readiness, { available: false })
		assert.equal(JSON.stringify(body).includes(f.root), false)
	} finally { await close(f) }
}

async function testApiIncludesPrivateRsiSummaryWithoutEvidenceBody(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-campaign-rsi-api-"))
	const rsiFile = path.join(root, "status.json")
	const digest = "d".repeat(64)
	await fs.writeFile(rsiFile, JSON.stringify({ schemaVersion: 1, history: [{
		updatedAt: "2026-10-29T08:00:00Z", experimentId: "offline-api-test",
		baselineCommit: "b".repeat(40), candidateCommit: "c".repeat(40),
		baselineSourceDigest: "a".repeat(64), candidateSourceDigest: "e".repeat(64),
		evaluatorDigest: digest, inputDigest: digest, evidenceDigest: digest,
		eligible: true, baselineCorrect: 3, candidateCorrect: 4,
	}] }), { mode: 0o600 })
	const f = await fixture(undefined, () => readCampaignRsiStatus(rsiFile))
	try {
		const response = await fetch(`${f.base}/api/campaign-control`)
		const body = await response.json() as Record<string, any>
		assert.equal(body.rsi.status, "evaluated")
		assert.equal(body.rsi.history[0].candidateCorrect, 4)
		assert.equal(body.rsi.history[0].evidenceDigest, digest)
		assert.equal("rawEvidence" in body.rsi.history[0], false)
		assert.equal(JSON.stringify(body.rsi).includes(root), false)
	} finally { await close(f); await fs.rm(root, { recursive: true, force: true }) }
}

async function testOnOffAndBudgetUseExactActionsAndBoundedUsd(): Promise<void> {
	const f = await fixture()
	try {
		const off = await fetch(`${f.base}/api/campaign-control`, { method: "POST",
			headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "off" }) })
		assert.equal(off.status, 200)
		assert.equal((await off.json() as any).control.enabled, false)
		const on = await fetch(`${f.base}/api/campaign-control`, { method: "POST",
			headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "on" }) })
		assert.equal(on.status, 200)
		const budget = await fetch(`${f.base}/api/campaign-control`, { method: "POST",
			headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "budget", budgetUsd: "1.234567" }) })
		assert.equal(budget.status, 200)
		assert.equal((await budget.json() as any).control.budgetLimitMicros, 1_234_567)
		assert.deepEqual(f.mutations, [
			{ action: "off" }, { action: "on" }, { action: "budget", micros: 1_234_567 },
		])
	} finally { await close(f) }
}

async function testUnknownFieldsInvalidBudgetAndCrossOriginAreRejected(): Promise<void> {
	const f = await fixture()
	try {
		const headers = { "content-type": "application/json" }
		const extra = await fetch(`${f.base}/api/campaign-control`, { method: "POST", headers,
			body: JSON.stringify({ action: "on", command: "arbitrary" }) })
		assert.equal(extra.status, 400)
		const over = await fetch(`${f.base}/api/campaign-control`, { method: "POST", headers,
			body: JSON.stringify({ action: "budget", budgetUsd: "5.000001" }) })
		assert.equal(over.status, 400)
		assert.equal(await rawGet(`${f.base}/api/campaign-control`, { host: "attacker.example" }), 421)
		const wrongOrigin = await fetch(`${f.base}/api/campaign-control`, { headers: { origin: "http://attacker.example" } })
		assert.equal(wrongOrigin.status, 403)
		assert.equal(f.mutations.length, 0)
	} finally { await close(f) }
}

async function testOptionalBearerTokenGatesApiButNotStaticEntry(): Promise<void> {
	const f = await fixture("test-token")
	try {
		assert.equal((await fetch(`${f.base}/`)).status, 200)
		assert.equal((await fetch(`${f.base}/api/campaign-control`)).status, 401)
		assert.equal((await fetch(`${f.base}/api/campaign-control`, {
			headers: { authorization: "Bearer test-token" },
		})).status, 200)
	} finally { await close(f) }
}

async function testStaticServerDoesNotExposeUnlistedFiles(): Promise<void> {
	const f = await fixture()
	try {
		const index = await fetch(`${f.base}/`)
		assert.equal(index.status, 200)
		assert.equal(index.headers.get("content-security-policy")?.includes("default-src 'self'"), true)
		assert.equal(await (await fetch(`${f.base}/assets/app.js`)).text(), "document.body.dataset.ready='true'")
		assert.equal((await fetch(`${f.base}/secret.json`)).status, 404)
		assert.equal((await fetch(`${f.base}/assets/%2e%2e/secret.json`)).status, 404)
	} finally { await close(f) }
}

async function testRepositoryCampaignApiIsAdditiveAndReportsMockReadiness(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repository-campaign-api-"))
	const definitions: RepositoryCampaignDefinition[] = [{ id: "headlesscode-internal", name: "HeadlessCode", repositoryId: "headlesscode-internal", repository: "Capsize-Games/headlesscode-internal",
		sourceRevision: null, workerProfile: null, recipeDigest: null, evaluatorDigest: null, model: null, dataAccessProfile: null,
		qualification: { sourceAudited: false, workerQualified: false, recipeQualified: false, evaluatorQualified: false,
			modelApproved: false, dataApproved: false, accessApproved: false } }]
	const repositoryCampaigns = new RepositoryCampaignStore(path.join(root, "repository-campaigns.json"), definitions)
	const f = await fixture()
	const extended = await startCampaignControlServer({
		port: 0, staticRoot: path.join(f.root, "dist"), store: f.store, controlPath: f.store.path, repositoryCampaigns,
		loadAdapter: async () => ({ releaseRoot: f.root, stateRoot: f.root, releaseDigest: "a".repeat(64) }),
		readBudget: async () => ({ month: currentMonth(), settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 }),
		readJobs: async () => ({ jobs: [], jobDetailsAvailable: false }),
		readRsi: async () => ({ mode: "offline-synthetic-only", status: "not-run", activation: "not-performed",
			limits: { modelCalls: 0, spendUsd: 0, comparisons: 1, maxDurationSeconds: 30, maxFixtures: 500 }, history: [] }),
		readProviderRsi: async (): Promise<ProviderRsiStatus> => ({ mode: "provider-synthetic-only", model: "meta/muse-spark-1.3-contributor",
			activation: "not-performed", maxSpendMicros: 20_000, history: [] }),
	})
	const address = extended.address(); assert.ok(address && typeof address !== "string")
	const base = `http://127.0.0.1:${address.port}`
	try {
		const legacy = await fetch(`${base}/api/campaign-control`)
		assert.equal(legacy.status, 200, "existing Fleet endpoint remains available")
		const initialResponse = await fetch(`${base}/api/repository-campaigns`)
		assert.equal(initialResponse.status, 200)
		const initial = await initialResponse.json() as any
		assert.equal(initial.mode, "offline-synthetic-only")
		assert.equal(initial.modelCalls, 0)
		assert.equal(initial.controlPlaneOnly, true)
		assert.equal(initial.budget.authority, "synthetic-test")
		assert.equal(initial.budget.adapter, "none")
		assert.equal(initial.budget.available, false)
		assert.equal(initial.budget.limitMicros, 0, "repository campaigns do not create a separate spend allowance")
		assert.equal(initial.campaigns[0].readiness, "blocked-prerequisite")
		assert.ok(initial.campaigns[0].readinessReasons.includes("authoritative-broker-budget"))
		const start = await fetch(`${base}/api/repository-campaigns`, { method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "start", campaignId: "headlesscode-internal" }) })
		assert.equal(start.status, 409)
		assert.match((await start.json() as any).error, /audited-private-source/)
		const invalid = await fetch(`${base}/api/repository-campaigns`, { method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "run", campaignId: "headlesscode-internal", command: "ignored" }) })
		assert.equal(invalid.status, 400)
	} finally {
		await new Promise<void>((resolve, reject) => extended.close((error) => error ? reject(error) : resolve()))
		await close(f); await fs.rm(root, { recursive: true, force: true })
	}
}

async function testRepositoryDraftCreateAndConfigureNeverSelfCertifyReadiness(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repository-campaign-draft-api-"))
	const repositoryCampaigns = new RepositoryCampaignStore(path.join(root, "repository-campaigns.json"), [])
	const f = await fixture()
	const server = await startCampaignControlServer({ port: 0, staticRoot: path.join(f.root, "dist"), store: f.store,
		repositoryCampaigns, loadAdapter: async () => ({ releaseRoot: f.root, stateRoot: f.root, releaseDigest: "a".repeat(64) }),
		readBudget: async () => ({ month: currentMonth(), settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 }),
		readJobs: async () => ({ jobs: [], jobDetailsAvailable: false }),
		readRsi: async () => ({ mode: "offline-synthetic-only", status: "not-run", activation: "not-performed",
			limits: { modelCalls: 0, spendUsd: 0, comparisons: 1, maxDurationSeconds: 30, maxFixtures: 500 }, history: [] }),
		readProviderRsi: async (): Promise<ProviderRsiStatus> => ({ mode: "provider-synthetic-only", model: "meta/muse-spark-1.3-contributor",
			activation: "not-performed", maxSpendMicros: 20_000, history: [] }),
	})
	const address = server.address(); assert.ok(address && typeof address !== "string")
	const base = `http://127.0.0.1:${address.port}`
	try {
		const headers = { "content-type": "application/json" }
		const created = await fetch(`${base}/api/repository-campaigns`, { method: "POST", headers,
			body: JSON.stringify({ action: "create", id: "sample-repo", name: "Sample repo", repository: "Capsize-Games/sample" }) })
		assert.equal(created.status, 200)
		const configured = await fetch(`${base}/api/repository-campaigns`, { method: "POST", headers,
			body: JSON.stringify({ action: "configure", campaignId: "sample-repo", sourceRevision: "a".repeat(40), requestedModelProfile: "muse-spark-contributor" }) })
		assert.equal(configured.status, 200)
		const detail = await fetch(`${base}/api/repository-campaigns/sample-repo`)
		assert.equal(detail.status, 200)
		const body = await detail.json() as any
		assert.equal(body.campaign.readiness, "blocked-prerequisite")
		assert.deepEqual(body.campaign.readinessReasons, ["owner-provisioned-enrollment-review"])
		assert.equal(body.campaign.sourceRevision, "a".repeat(40))
		assert.equal(JSON.stringify(body).includes("workerQualified"), false, "client configuration cannot set trusted qualification")
		const page1 = await fetch(`${base}/api/repository-campaigns/sample-repo/history?cursor=0&limit=1`)
		assert.equal(page1.status, 200)
		const history1 = await page1.json() as any
		assert.equal(history1.items.length, 1)
		assert.equal(history1.nextCursor, 1)
		const page2 = await fetch(`${base}/api/repository-campaigns/sample-repo/history?cursor=1&limit=1`)
		assert.equal((await page2.json() as any).items[0].action, "configured")
		const forced = await fetch(`${base}/api/repository-campaigns`, { method: "POST", headers,
			body: JSON.stringify({ action: "configure", campaignId: "sample-repo", sourceRevision: "a".repeat(40),
				requestedModelProfile: "muse-spark-contributor", workerQualified: true, modelApproved: true }) })
		assert.equal(forced.status, 400)
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
		await close(f); await fs.rm(root, { recursive: true, force: true })
	}
}

async function testRepositoryProgressAndEvidenceRoutesAreReadOnlyAndSanitized(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repository-progress-api-"))
	const qualified = { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
		modelApproved: true, dataApproved: true, accessApproved: true }
	const definition: RepositoryCampaignDefinition = { id: "sample-repo", name: "Sample Repository", repositoryId: "capsize-sample-repo", repository: "Capsize/Sample", sourceRevision: "a".repeat(40), policySha256: "d".repeat(64),
		workerProfile: "fixed-fixture", recipeDigest: "b".repeat(64), evaluatorDigest: "c".repeat(64), model: "fixture-only",
		dataAccessProfile: "fixture-only", qualification: qualified }
	const repositoryCampaigns = new RepositoryCampaignStore(path.join(root, "repository-campaigns.json"), [definition], () => ({
		mode: "synthetic-test", available: true, limitMicros: 50_000, limitTokens: 50_000, committedMicros: 0, committedTokens: 0,
	}))
	const f = await fixture()
	await repositoryCampaigns.setCampaignBudget("sample-repo", 40_000, 40_000)
	await repositoryCampaigns.start("sample-repo")
	await repositoryCampaigns.enqueue("sample-repo", "CVE-2026-1260")
	const claim = await repositoryCampaigns.claimNext("sample-repo", { micros: 10_000, tokens: 10_000 })
	assert.ok(claim)
	const ref = { id: "d".repeat(64), kind: "candidate" as const, label: "Candidate digest" }
	const boardRef = `http://127.0.0.1:8078/api/cards/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v1:${"f".repeat(64)}`
	await repositoryCampaigns.updateClaimProgress(claim!, { stage: "prepare-candidate", currentTask: "Prepare isolated candidate", completedSteps: ["intake", "deduplicate", "investigate"], nextStep: "verify", evidenceRefs: [ref], boardRef })
	const server = await startCampaignControlServer({ port: 0, staticRoot: path.join(f.root, "dist"), store: f.store,
		repositoryCampaigns, loadAdapter: async () => ({ releaseRoot: f.root, stateRoot: f.root, releaseDigest: "a".repeat(64) }),
		readBudget: async () => ({ month: currentMonth(), settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 }),
		readJobs: async () => ({ jobs: [], jobDetailsAvailable: false }),
		readRsi: async () => ({ mode: "offline-synthetic-only", status: "not-run", activation: "not-performed",
			limits: { modelCalls: 0, spendUsd: 0, comparisons: 1, maxDurationSeconds: 30, maxFixtures: 500 }, history: [] }),
		readProviderRsi: async (): Promise<ProviderRsiStatus> => ({ mode: "provider-synthetic-only", model: "meta/muse-spark-1.3-contributor",
			activation: "not-performed", maxSpendMicros: 20_000, history: [] }),
	})
	const address = server.address(); assert.ok(address && typeof address !== "string")
	const base = `http://127.0.0.1:${address.port}`
	try {
		const response = await fetch(`${base}/api/repository-campaigns/sample-repo/progress`)
		assert.equal(response.status, 200)
		const body = await response.json() as any
		assert.equal(body.executionKind, "development-checkpoint")
		assert.deepEqual(body.repository, { id: "sample-repo", name: "Sample Repository", slug: "Capsize/Sample" })
		assert.equal(body.workers[0].workerId, claim!.job.progress?.workerId)
		assert.equal(body.workers[0].goal.includes("CVE-2026-1260"), true)
		assert.equal(body.workers[0].boardRef, boardRef)
		assert.equal(body.workers[0].usage.state, "unavailable")
		assert.equal(body.counts.source, "repository-campaign-store")
		assert.equal(body.counts.running, 1)
		const evidence = await fetch(`${base}/api/repository-campaigns/sample-repo/jobs/${claim!.job.id}/evidence/${ref.id}`)
		assert.equal(evidence.status, 200)
		assert.deepEqual(await evidence.json(), { schemaVersion: 1, campaignId: "sample-repo", jobId: claim!.job.id, evidence: ref })
		assert.equal((await fetch(`${base}/api/repository-campaigns/sample-repo/progress`, { method: "POST" })).status, 405)
		assert.equal((await fetch(`${base}/api/repository-campaigns/sample-repo/jobs/${claim!.job.id}/evidence/${"e".repeat(64)}`)).status, 404)
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
		await close(f); await fs.rm(root, { recursive: true, force: true })
	}
}

async function testCoordinatorLeavesUnregisteredCampaignBlocked(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repository-coordinator-api-"))
	const qualified = { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
		modelApproved: true, dataApproved: true, accessApproved: true }
	const definition: RepositoryCampaignDefinition = { id: "sample-repo", name: "Sample Repository", repositoryId: "capsize-sample-repo", repository: "Capsize/Sample", sourceRevision: "a".repeat(40), policySha256: "d".repeat(64),
		workerProfile: "fixed-fixture", recipeDigest: "b".repeat(64), evaluatorDigest: "c".repeat(64), model: "fixture-only",
		dataAccessProfile: "fixture-only", qualification: qualified }
	const repositoryCampaigns = new RepositoryCampaignStore(path.join(root, "repository-campaigns.json"), [definition], () => ({
		mode: "synthetic-test", available: true, limitMicros: 50_000, limitTokens: 50_000, committedMicros: 0, committedTokens: 0,
	}))
	await repositoryCampaigns.setCampaignBudget("sample-repo", 40_000, 40_000)
	await repositoryCampaigns.start("sample-repo")
	await repositoryCampaigns.enqueue("sample-repo", "CVE-2026-1260")
	const f = await fixture()
	const server = await startCampaignControlServer({ port: 0, staticRoot: path.join(f.root, "dist"), store: f.store,
		repositoryCampaigns, enableRepositoryCoordinator: true,
		loadAdapter: async () => ({ releaseRoot: f.root, stateRoot: f.root, releaseDigest: "a".repeat(64) }),
		readBudget: async () => ({ month: currentMonth(), settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 }),
		readJobs: async () => ({ jobs: [], jobDetailsAvailable: false }),
		readRsi: async () => ({ mode: "offline-synthetic-only", status: "not-run", activation: "not-performed",
			limits: { modelCalls: 0, spendUsd: 0, comparisons: 1, maxDurationSeconds: 30, maxFixtures: 500 }, history: [] }),
	})
	const address = server.address(); assert.ok(address && typeof address !== "string")
	try {
		const response = await fetch(`http://127.0.0.1:${address.port}/api/repository-campaigns/sample-repo/progress`)
		assert.equal(response.status, 200)
		const body = await response.json() as any
		assert.equal(body.readiness.state, "blocked-prerequisite")
		assert.deepEqual(body.readiness.reasons.slice(-3), ["contained-worker-adapter-unregistered", "protected-evaluator-unregistered", "private-delivery-adapter-unregistered"])
		assert.equal(body.state, "blocked-prerequisite")
		assert.equal(body.workers.length, 0, "the coordinator does not invent a worker record for an unregistered adapter")
		const listed = await (await fetch(`http://127.0.0.1:${address.port}/api/repository-campaigns`)).json() as any
		assert.equal(listed.campaigns[0].readiness, "blocked-prerequisite", "campaign list reflects runtime adapter availability")
		const start = await fetch(`http://127.0.0.1:${address.port}/api/repository-campaigns`, { method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "start", campaignId: "sample-repo" }) })
		assert.equal(start.status, 409, "Start is rejected while worker/evaluator/delivery adapters are unregistered")
		assert.match((await start.json() as any).error, /contained-worker-adapter-unregistered/)
		assert.equal((await repositoryCampaigns.status() as any).jobs[0].status, "queued", "no adapter means no claim")
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
		await close(f); await fs.rm(root, { recursive: true, force: true })
	}
}

const tests: readonly SuiteTest[] = [
	["control API reports actual ledger totals and leaves package jobs explicitly unavailable", testLoopbackApiReportsActualBudgetAndNoFabricatedJobs],
	["control API exposes readiness coverage and completion counts", testApiShowsProfileCoverageAndCompletionCounts],
	["control API includes only private RSI summary metadata", testApiIncludesPrivateRsiSummaryWithoutEvidenceBody],
	["control actions use exact on/off/budget operations", testOnOffAndBudgetUseExactActionsAndBoundedUsd],
	["unknown fields, over-cap budget, wrong hosts, and cross-origin requests are rejected", testUnknownFieldsInvalidBudgetAndCrossOriginAreRejected],
	["optional bearer auth gates the API while leaving the app entry available", testOptionalBearerTokenGatesApiButNotStaticEntry],
	["static serving is confined to the built UI allowlist", testStaticServerDoesNotExposeUnlistedFiles],
	["repository campaign API is additive and exposes mock mode and readiness", testRepositoryCampaignApiIsAdditiveAndReportsMockReadiness],
	["repository draft create and configure cannot self-certify readiness", testRepositoryDraftCreateAndConfigureNeverSelfCertifyReadiness],
	["repository progress and evidence routes are read-only, ownership-bound, and sanitized", testRepositoryProgressAndEvidenceRoutesAreReadOnlyAndSanitized],
	["repository coordinator reports missing adapters and does not claim queued work", testCoordinatorLeavesUnregisteredCampaignBlocked],
]

runMain("campaign-control-server", tests)
