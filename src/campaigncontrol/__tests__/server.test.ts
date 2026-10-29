import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { request, type Server } from "node:http"
import { CampaignControlStore, type CampaignControlState } from "../store.js"
import { startCampaignControlServer, type CampaignMutation } from "../server.js"
import { readCampaignRsiStatus, type CampaignRsiStatus } from "../rsi.js"
import type { CampaignJobReport, CampaignReadinessReport } from "../runner.js"
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

const tests: readonly SuiteTest[] = [
	["control API reports actual ledger totals and leaves package jobs explicitly unavailable", testLoopbackApiReportsActualBudgetAndNoFabricatedJobs],
	["control API exposes readiness coverage and completion counts", testApiShowsProfileCoverageAndCompletionCounts],
	["control API includes only private RSI summary metadata", testApiIncludesPrivateRsiSummaryWithoutEvidenceBody],
	["control actions use exact on/off/budget operations", testOnOffAndBudgetUseExactActionsAndBoundedUsd],
	["unknown fields, over-cap budget, wrong hosts, and cross-origin requests are rejected", testUnknownFieldsInvalidBudgetAndCrossOriginAreRejected],
	["optional bearer auth gates the API while leaving the app entry available", testOptionalBearerTokenGatesApiButNotStaticEntry],
	["static serving is confined to the built UI allowlist", testStaticServerDoesNotExposeUnlistedFiles],
]

runMain("campaign-control-server", tests)
