import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { createRepositoryCampaignBudgetBinding } from "../repository-budget-binding.js"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { FleetRepositoryBudgetLedger, type FleetRepositoryBudgetScope } from "../../rsi/fleet-repository-budget-ledger.js"
import type { OpenRouterBrokerGrant, OpenRouterCallReservation, OpenRouterCallSettlement } from "../../rsi/inference-broker.js"

const MODEL = "meta/muse-spark-1.3-contributor"
const PROFILE = "muse-spark-contributor"
const fakeKey = "offline-repository-budget-fixture-key"
const keyIdentity = createHash("sha256").update(fakeKey).digest("hex")
const sourceA = "1".repeat(40), sourceB = "2".repeat(40)
const policyA = "a".repeat(64), policyB = "b".repeat(64)
const pythonBridge = `
import json, os, sys
from unittest.mock import patch
import operations.campaign_budget as budget
import operations.campaign_budget_bridge as bridge
import operations.campaign_control as control
month = os.environ.get("FLEET_TEST_MONTH")
fault = os.environ.get("FLEET_TEST_FAULT")
def fixed_control(path, **kwargs):
    with open(path, "r", encoding="utf-8") as stream: value = json.load(stream)
    if month: value["month"] = month
    return value
patches = [patch.object(budget, "_provider_snapshot", return_value={"limit_micros": 5000000, "remaining_micros": 5000000, "usage_micros": 0})]
if month:
    patches.extend([patch.object(budget, "_utc_month", return_value=month), patch.object(budget, "read_control", side_effect=fixed_control), patch.object(control, "read_control", side_effect=fixed_control), patch.object(bridge, "read_control", side_effect=fixed_control)])
if fault == "settle-after":
    original = budget.BudgetAuthority.settle
    def settle_then_lose(self, **kwargs):
        result = original(self, **kwargs)
        if result: raise OSError("fixture lost settlement response after durable commit")
        return result
    patches.append(patch.object(budget.BudgetAuthority, "settle", settle_then_lose))
with patches[0]:
    from contextlib import ExitStack
    with ExitStack() as stack:
        for item in patches[1:]: stack.enter_context(item)
        print(json.dumps(bridge._authority().dispatch(json.load(sys.stdin)), separators=(",", ":")))
`
const fleetRoot = process.env.FLEET_SECURITY_WATCH_TEST_ROOT ?? path.resolve(process.cwd(), "../fleet-repository-budget-v2")
const fleetSourceAvailable = existsSync(path.join(fleetRoot, "operations/campaign_budget_bridge.py"))
const integrationSkip = fleetSourceAvailable ? false : "requires the Fleet source checkout; set FLEET_SECURITY_WATCH_TEST_ROOT in combined integration runs"

const qualification = { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definitions: RepositoryCampaignDefinition[] = [
	{ id: "repo-a", name: "Repository A", sourceRevision: sourceA, workerProfile: "fixture-worker", recipeDigest: "c".repeat(64),
		evaluatorDigest: "d".repeat(64), model: MODEL, dataAccessProfile: "fixture-data", qualification },
	{ id: "repo-b", name: "Repository B", sourceRevision: sourceB, workerProfile: "fixture-worker", recipeDigest: "e".repeat(64),
		evaluatorDigest: "f".repeat(64), model: MODEL, dataAccessProfile: "fixture-data", qualification },
]

function scope(id: "repo-a" | "repo-b", epoch = 1): FleetRepositoryBudgetScope {
	return id === "repo-a"
		? { repositoryCampaignId: id, repositoryId: "fixture-a", repository: "Capsize-Games/fixture-a", sourceRevision: sourceA,
			policySha256: policyA, model: MODEL, profileId: PROFILE, repositoryEpoch: epoch }
		: { repositoryCampaignId: id, repositoryId: "fixture-b", repository: "Capsize-Games/fixture-b", sourceRevision: sourceB,
			policySha256: policyB, model: MODEL, profileId: PROFILE, repositoryEpoch: epoch }
}

function limits(maxJobSpendUsd = 0.01, maxTotalTokens = 10_000) {
	return { campaignId: "fleet-security-watch", maxCalls: 3, maxInputTokensPerCall: 4_000, maxOutputTokensPerCall: 1_000,
		maxTotalTokens, maxDurationMs: 60_000, maxRequestBytes: 16_384, maxResponseBytes: 32_768,
		maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 2, maxCallSpendUsd: 0.01,
		maxJobSpendUsd, maxCampaignSpendUsd: 0.02 }
}

function grant(jobId: string, maxJobSpendUsd = 0.01, maxTotalTokens = 10_000): OpenRouterBrokerGrant {
	return { jobId, leaseToken: "synthetic-lease", capability: "synthetic-capability", model: MODEL, profileId: PROFILE,
		apiKeyIdentity: keyIdentity, limits: limits(maxJobSpendUsd, maxTotalTokens) }
}

function reservation(callId: string): OpenRouterCallReservation {
	return { callId, requestSha256: "9".repeat(64), reservedUsd: 0.01, reservedTokens: 5_000, startedAt: new Date().toISOString() }
}

function settlement(callId: string): OpenRouterCallSettlement & { callId: string } {
	return { callId, state: "complete", qualified: true, returnedModel: MODEL, returnedProvider: "meta",
		providerRequestId: "fixture-provider-receipt", promptTokens: 12, completionTokens: 7,
		costUsd: 0.0001, responseSha256: "8".repeat(64), completedAt: new Date().toISOString() }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => { resolve = done })
	return { promise, resolve }
}

interface Fixture {
	root: string
	home: string
	store: RepositoryCampaignStore
	claims: { "repo-a": NonNullable<Awaited<ReturnType<RepositoryCampaignStore["claimNext"]>>>; "repo-b": NonNullable<Awaited<ReturnType<RepositoryCampaignStore["claimNext"]>>> }
	bindings: Record<"repo-a" | "repo-b", ReturnType<typeof createRepositoryCampaignBudgetBinding>>
	grants: Record<"repo-a" | "repo-b", OpenRouterBrokerGrant>
	setFault(value?: string): void
	setMonth(value?: string): void
	invoke(message: Record<string, unknown>): Promise<Record<string, unknown>>
	setControl(value: { globalEnabled?: boolean; globalEpoch?: number; repoAEnabled?: boolean; repoAEpoch?: number; repoBEnabled?: boolean; repoBEpoch?: number }): Promise<void>
	cleanup(): Promise<void>
}

async function privateDir(directory: string): Promise<void> { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700) }

async function fixture(): Promise<Fixture> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-fleet-v2-")); await fs.chmod(home, 0o700)
	const campaign = path.join(home, ".local", "state", "fleet-security-watch", "automation", "campaign")
	const controlDir = path.join(home, ".local", "share", "headlesscode", "campaign-control")
	await privateDir(campaign); await privateDir(controlDir)
	const credential = path.join(campaign, "test-key"), config = path.join(campaign, "config.json")
	const controlFile = path.join(controlDir, "control.json")
	await fs.writeFile(credential, fakeKey, { mode: 0o600 }); await fs.chmod(credential, 0o600)
	await fs.writeFile(config, JSON.stringify({ schema_version: 1, enabled: true, repository: "/fixture", base_sha: "a".repeat(40),
		board_card: "1c25cecf", image_digest: "b".repeat(64), credential_file: credential, key_identity: keyIdentity }), { mode: 0o600 })
	await fs.chmod(config, 0o600)
	const scopes = (["repo-a", "repo-b"] as const).map((id) => {
		const s = scope(id)
		return { repositoryCampaignId: s.repositoryCampaignId, repositoryId: s.repositoryId, repository: s.repository,
			sourceRevision: s.sourceRevision, policySha256: s.policySha256, model: s.model, profileId: s.profileId,
			maxLifetimeSpendMicros: 10_000, maxLifetimeTokens: 10_000 }
	})
	await fs.writeFile(path.join(campaign, "repository-scopes.json"), JSON.stringify({ schemaVersion: 1, repositories: scopes }), { mode: 0o600 })
	await fs.chmod(path.join(campaign, "repository-scopes.json"), 0o600)
	let controlState = { globalEnabled: true, globalEpoch: 1, repoAEnabled: true, repoAEpoch: 1, repoBEnabled: true, repoBEpoch: 1 }
	let fault: string | undefined, month: string | undefined
	const writeControl = async () => {
		const now = Date.now()
		const value = { schemaVersion: 1, campaignId: "fleet-security-watch", enabled: controlState.globalEnabled,
			canAdmit: controlState.globalEnabled, epoch: controlState.globalEpoch, budgetLimitMicros: 5_000_000,
			month: new Date().toISOString().slice(0, 7), settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0,
			activeRun: { id: `fixture-run-${controlState.globalEpoch}`, epoch: controlState.globalEpoch, startedAt: now - 1000, expiresAt: now + 300_000 },
			repositoryCampaigns: {
				"repo-a": { enabled: controlState.repoAEnabled, epoch: controlState.repoAEpoch, repositoryId: "fixture-a", sourceRevision: sourceA, policySha256: policyA },
				"repo-b": { enabled: controlState.repoBEnabled, epoch: controlState.repoBEpoch, repositoryId: "fixture-b", sourceRevision: sourceB, policySha256: policyB },
			} }
		await fs.writeFile(controlFile, JSON.stringify(value), { mode: 0o600 }); await fs.chmod(controlFile, 0o600)
	}
	await writeControl()
	const invoke = async (message: Record<string, unknown>) => {
		const child = spawnSync("/usr/bin/python3", ["-c", pythonBridge], { input: JSON.stringify(message), encoding: "utf8", timeout: 10_000,
			env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: fleetRoot, PYTHONNOUSERSITE: "1",
				...(fault ? { FLEET_TEST_FAULT: fault } : {}), ...(month ? { FLEET_TEST_MONTH: month } : {}) } })
		fault = undefined
		if (child.error || child.status !== 0) throw new Error(`offline Fleet v2 bridge call failed closed (${child.status ?? child.error?.message ?? "spawn-error"}): ${(child.stderr ?? "").slice(0, 1200)}`)
		return JSON.parse(child.stdout.trim()) as Record<string, unknown>
	}
	const authority: RepositoryBudgetAuthority = { mode: "synthetic-test", available: true, limitMicros: 20_000,
		limitTokens: 20_000, committedMicros: 0, committedTokens: 0 }
	const root = path.join(home, "hcl")
	await privateDir(root)
	const store = new RepositoryCampaignStore(path.join(root, "repository-campaigns.json"), definitions, () => authority)
	const now = new Date("2026-10-29T12:00:00Z")
	for (const id of ["repo-a", "repo-b"] as const) {
		await store.setCampaignBudget(id, 10_000, 10_000, now)
		await store.start(id, now)
		await store.enqueue(id, id === "repo-a" ? "CVE-2026-1234" : "CVE-2026-1235", now)
	}
	const claimA = await store.claimNext("repo-a", { micros: 10_000, tokens: 10_000 }, now)
	const claimB = await store.claimNext("repo-b", { micros: 10_000, tokens: 10_000 }, now)
	assert.ok(claimA && claimB)
	const claims = { "repo-a": claimA, "repo-b": claimB }
	const grants = { "repo-a": grant(claimA.job.id), "repo-b": grant(claimB.job.id) }
	const bindings = Object.fromEntries((["repo-a", "repo-b"] as const).map((id) => [id, createRepositoryCampaignBudgetBinding({
		store, claim: claims[id], scope: scope(id), expectedKeyIdentity: keyIdentity, invoke,
		assertDispatchFence: async () => undefined,
	})])) as Fixture["bindings"]
	return { root, home, store, claims, grants, bindings, setFault(value) { fault = value }, setMonth(value) { month = value }, invoke,
		async setControl(next) { controlState = { ...controlState, ...next }; await writeControl() }, cleanup: () => fs.rm(home, { recursive: true, force: true }) }
}

test("HCL binding sends v2 repository identities and both repositories consume the same legacy campaign lifetime pool", { skip: integrationSkip }, async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	for (const id of ["repo-a", "repo-b"] as const) {
		await f.bindings[id].register(f.grants[id])
		await f.bindings[id].reserve(f.grants[id], reservation(`fixture-call-${id}`))
	}
	let sends = 0
	for (const id of ["repo-a", "repo-b"] as const) {
		const r = reservation(`fixture-call-${id}`)
		const response = await f.bindings[id].requestStartGate(async () => { sends += 1; return new Response("fixture") }, { grant: f.grants[id], reservation: r })
		assert.equal(response.status, 200)
		await f.bindings[id].settle(f.grants[id], settlement(r.callId))
		await f.bindings[id].finishFromReceipt(f.grants[id], new Date("2026-10-29T12:01:00Z"))
	}
	assert.equal(sends, 2)
	const state = await f.store.status(new Date("2026-10-29T12:02:00Z")) as any
	assert.equal(state.budget.settledMicros, 200)
	assert.equal(state.budget.settledTokens, 38)
	assert.equal(state.budget.reservedMicros, 0)
	const extraLedger = new FleetRepositoryBudgetLedger({ expectedKeyIdentity: keyIdentity, scope: scope("repo-a"), invoke: f.invoke,
		assertDispatchFence: async () => undefined })
	const snapshot = await extraLedger.budgetSnapshot()
	assert.equal(snapshot.mode, "fleet-v2")
	assert.equal(snapshot.repositoryCampaignId, "repo-a")
	assert.equal(snapshot.repositoryLifetime.limitMicros, 10_000)
	assert.equal(snapshot.repositoryLifetime.settledMicros, 100)
	assert.equal(snapshot.campaignLifetime.limitMicros, 20_000)
	assert.equal(snapshot.campaignLifetime.settledMicros, 200)
	assert.equal(snapshot.legacyLifetime.settledMicros, 0)
	assert.equal(snapshot.committedMicros, 0)
	assert.equal(snapshot.available, true)
	const extraGrant = grant("extra-repository-a-job", 0.01, 10_000)
	await extraLedger.register(extraGrant)
	await assert.rejects(extraLedger.reserve(extraGrant, { ...reservation("extra-call"), reservedUsd: 0.01, reservedTokens: 2 }),
		/repository lifetime budget exhausted/)
})

test("Stop changes to either epoch before the dual request-start fence prevent the HTTP callback", { skip: integrationSkip }, async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	const id = "repo-a" as const, call = reservation("fixture-stop-call")
	await f.bindings[id].register(f.grants[id]); await f.bindings[id].reserve(f.grants[id], call)
	await f.setControl({ repoAEnabled: false, repoAEpoch: 2 })
	let sends = 0
	await assert.rejects(f.bindings[id].requestStartGate(async () => { sends += 1; return new Response("must not send") },
		{ grant: f.grants[id], reservation: call }), /outside|mismatched|stale|unavailable|current/)
	assert.equal(sends, 0)
})

test("Stop waits for Fleet request-start admission and send invocation, then proceeds before HTTP completion", { skip: integrationSkip }, async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	const id = "repo-a" as const, call = reservation("fixture-ordered-stop-call")
	const admissionEntered = deferred<void>(), releaseAdmission = deferred<void>()
	const sendStarted = deferred<void>(), releaseResponse = deferred<Response>()
	const invoke = async (message: Record<string, unknown>) => {
		if (message.op === "repository-request-start") {
			admissionEntered.resolve()
			await releaseAdmission.promise
		}
		return await f.invoke(message)
	}
	const binding = createRepositoryCampaignBudgetBinding({ store: f.store, claim: f.claims[id], scope: scope(id), expectedKeyIdentity: keyIdentity,
		invoke, assertDispatchFence: async () => undefined })
	await binding.register(f.grants[id]); await binding.reserve(f.grants[id], call)
	const request = binding.requestStartGate(() => { sendStarted.resolve(); return releaseResponse.promise }, { grant: f.grants[id], reservation: call })
	await admissionEntered.promise
	const stopped = f.store.stop(id)
	releaseAdmission.resolve()
	await sendStarted.promise
	await stopped
	releaseResponse.resolve(new Response("fixture response"))
	assert.equal((await request).status, 200)
})

test("restart reconciliation settles an exact late receipt after Stop and UTC month rollover", { skip: integrationSkip }, async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	const id = "repo-a" as const, call = reservation("fixture-restart-call")
	await f.bindings[id].register(f.grants[id]); await f.bindings[id].reserve(f.grants[id], call)
	let sends = 0
	await f.bindings[id].requestStartGate(async () => { sends += 1; return new Response("sent fixture") },
		{ grant: f.grants[id], reservation: call })
	assert.equal(sends, 1)
	f.setFault("settle-after")
	await assert.rejects(f.bindings[id].settle(f.grants[id], settlement(call.callId)), /offline Fleet v2 bridge call failed closed/)
	const restarted = new RepositoryCampaignStore(f.store.path, definitions, () => ({ mode: "synthetic-test", available: true,
		limitMicros: 20_000, limitTokens: 20_000, committedMicros: 0, committedTokens: 0 }))
	await restarted.recoverInterrupted(new Date("2026-10-30T00:00:00Z"))
	await f.setControl({ repoAEnabled: false, repoAEpoch: 2 })
	f.setMonth("2026-11")
	const recovered = createRepositoryCampaignBudgetBinding({ store: restarted, claim: f.claims[id], scope: scope(id), expectedKeyIdentity: keyIdentity,
		invoke: f.invoke, assertDispatchFence: async () => undefined })
	const result = await recovered.reconcile(f.grants[id], undefined, new Date("2026-11-01T00:00:00Z"))
	assert.deepEqual(result.calls.map((row) => row.state), ["settled"])
	const final = await restarted.status(new Date("2026-11-01T00:01:00Z")) as any
	const settled = final.jobs.find((job: any) => job.id === f.claims[id].job.id)
	assert.equal(settled.status, "succeeded")
	assert.equal(settled.settledMicros, 100)
	assert.equal(settled.settledTokens, 19)
	assert.equal(final.budget.ambiguousMicros, 10_000) // Repository B's interrupted hold remains fail-closed.
})
