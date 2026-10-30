import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { constants, existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { createRepositoryCampaignBudgetBinding } from "../repository-budget-binding.js"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority,
	type RepositoryCampaignDefinition,
		type RepositoryCampaignJob } from "../repository-campaigns.js"
import { CampaignControlStore } from "../store.js"
import { FleetRepositoryBudgetLedger,
	type FleetRepositoryBudgetScope } from "../../rsi/fleet-repository-budget-ledger.js"
import type { OpenRouterBrokerGrant, OpenRouterCallReservation,
	OpenRouterCallSettlement,
		OpenRouterBrokerLimits } from "../../rsi/inference-broker.js"

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
patches = [patch.object(budget, "_provider_snapshot",
        return_value={"limit_micros": 5000000, "remaining_micros": 5000000,
        "usage_micros": 0})]
if month:
    patches.extend([patch.object(budget, "_utc_month", return_value=month),
        patch.object(budget, "read_control", side_effect=fixed_control),
        patch.object(control, "read_control", side_effect=fixed_control),
        patch.object(bridge, "read_control", side_effect=fixed_control)])
if fault == "settle-after":
    original = budget.BudgetAuthority.settle
    def settle_then_lose(self, **kwargs):
        result = original(self, **kwargs)
        if result: raise OSError("fixture lost settlement response after durable commit")
        return result
    patches.append(patch.object(budget.BudgetAuthority, "settle",
        settle_then_lose))
with patches[0]:
    from contextlib import ExitStack
    with ExitStack() as stack:
        for item in patches[1:]: stack.enter_context(item)
        print(json.dumps(bridge._authority().dispatch(json.load(sys.stdin)),
        separators=(",", ":")))
`
const pythonBridgeHandoff = `
import json, os, sys
from contextlib import ExitStack
from unittest.mock import patch
import operations.campaign_budget as budget
import operations.campaign_budget_bridge as bridge
import operations.campaign_control as control
month = os.environ.get("FLEET_TEST_MONTH")
crash_after_admit = os.environ.get("FLEET_TEST_CRASH_AFTER_ADMIT") == "1"
def fixed_control(path, **kwargs):
    with open(path, "r", encoding="utf-8") as stream: value = json.load(stream)
    if month: value["month"] = month
    return value
patches = [patch.object(budget, "_provider_snapshot",
        return_value={"limit_micros": 5000000, "remaining_micros": 5000000,
        "usage_micros": 0})]
if crash_after_admit:
    original = bridge.FleetBudgetBridge._repository_request_start
    def crash_after_request_start(self, message):
        result = original(self, message)
        os._exit(79)
    bridge.FleetBudgetBridge._repository_request_start = crash_after_request_start
if month:
    patches.extend([patch.object(budget, "_utc_month", return_value=month),
        patch.object(budget, "read_control", side_effect=fixed_control),
        patch.object(control, "read_control", side_effect=fixed_control),
        patch.object(bridge, "read_control", side_effect=fixed_control)])
with patches[0]:
    with ExitStack() as stack:
        for item in patches[1:]: stack.enter_context(item)
        bridge.main()
`
const fleetRoot = process.env.FLEET_SECURITY_WATCH_TEST_ROOT ?? path.resolve(process.cwd(), "../fleet-repository-budget-v2")
const fleetSourceAvailable = existsSync(path.join(fleetRoot,
	"operations/campaign_budget_bridge.py"))
const integrationSkip = fleetSourceAvailable ? false : "requires the Fleet source checkout; set FLEET_SECURITY_WATCH_TEST_ROOT in combined integration runs"

const qualification = { sourceAudited: true, workerQualified: true,
	recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definitions: RepositoryCampaignDefinition[] = [
	{ id: "repo-a", name: "Repository A", repositoryId: "fixture-a",
		repository: "Capsize-Games/fixture-a", sourceRevision: sourceA,
			policySha256: policyA, workerProfile: "fixture-worker",
				recipeDigest: "c".repeat(64),
		evaluatorDigest: "d".repeat(64), model: MODEL,
			dataAccessProfile: "fixture-data", qualification },
	{ id: "repo-b", name: "Repository B", repositoryId: "fixture-b",
		repository: "Capsize-Games/fixture-b", sourceRevision: sourceB,
			policySha256: policyB, workerProfile: "fixture-worker",
				recipeDigest: "e".repeat(64),
		evaluatorDigest: "f".repeat(64), model: MODEL,
			dataAccessProfile: "fixture-data", qualification },
]

function scope(id: "repo-a" | "repo-b", epoch = 1): FleetRepositoryBudgetScope {
	return id === "repo-a"
		? { repositoryCampaignId: id, repositoryId: "fixture-a",
			repository: "Capsize-Games/fixture-a", sourceRevision: sourceA,
			policySha256: policyA, model: MODEL, profileId: PROFILE,
				repositoryEpoch: epoch }
		: { repositoryCampaignId: id, repositoryId: "fixture-b",
			repository: "Capsize-Games/fixture-b", sourceRevision: sourceB,
			policySha256: policyB, model: MODEL, profileId: PROFILE,
				repositoryEpoch: epoch }
}

function limits(maxJobSpendUsd = 0.01,
	maxTotalTokens = 10_000): OpenRouterBrokerLimits {
	return { campaignId: "fleet-security-watch", maxCalls: 3,
		maxInputTokensPerCall: 4_000, maxOutputTokensPerCall: 1_000,
		maxTotalTokens, maxDurationMs: 60_000, maxRequestBytes: 16_384,
			maxResponseBytes: 32_768,
		maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 2,
			maxCallSpendUsd: 0.01,
		maxJobSpendUsd, maxCampaignSpendUsd: 0.02 }
}

function grant(jobId: string, maxJobSpendUsd = 0.01,
	maxTotalTokens = 10_000): OpenRouterBrokerGrant {
	return { jobId, leaseToken: "synthetic-lease",
		capability: "synthetic-capability", model: MODEL, profileId: PROFILE,
		apiKeyIdentity: keyIdentity, limits: limits(maxJobSpendUsd, maxTotalTokens) }
}

function reservation(callId: string): OpenRouterCallReservation {
	return { callId, requestSha256: "9".repeat(64), reservedUsd: 0.01,
		reservedTokens: 5_000, startedAt: new Date().toISOString() }
}

function settlement(callId: string): OpenRouterCallSettlement & { callId: string } {
	return { callId, state: "complete", qualified: true, returnedModel: MODEL,
		returnedProvider: "meta",
		providerRequestId: "fixture-provider-receipt", promptTokens: 12,
			completionTokens: 7,
		costUsd: 0.0001, responseSha256: "8".repeat(64),
			completedAt: new Date().toISOString() }
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
	controlStore: CampaignControlStore
	claims: { "repo-a": NonNullable<Awaited<ReturnType<RepositoryCampaignStore["claimNext"]>>>; "repo-b": NonNullable<Awaited<ReturnType<RepositoryCampaignStore["claimNext"]>>> }
	bindings: Record<"repo-a" | "repo-b",
		ReturnType<typeof createRepositoryCampaignBudgetBinding>>
	grants: Record<"repo-a" | "repo-b", OpenRouterBrokerGrant>
	setFault(value?: string): void
	setMonth(value?: string): void
	invoke(message: Record<string, unknown>): Promise<Record<string, unknown>>
	requestStartHandoff(message: Record<string, unknown>,
		onAdmitted: (reply: Record<string,
			unknown>) => void | Promise<void>): Promise<void>
	tryDispatchLock(): boolean
	crashNextHandoff(): void
	setControl(value: { globalEnabled?: boolean; globalEpoch?: number; repoAEnabled?: boolean; repoAEpoch?: number; repoBEnabled?: boolean; repoBEpoch?: number }): Promise<void>
	cleanup(): Promise<void>
}

type CampaignBudgetStatus = {
	budget: { ambiguousMicros: number; settledMicros: number; settledTokens: number; reservedMicros: number; authority: string; available: boolean; provisioningAvailable: boolean }
	campaigns: Array<{ enabled: boolean; readiness: string }>
	jobs: Array<RepositoryCampaignJob & { settledMicros: number; settledTokens: number }>
}

function readCampaignBudgetStatus(value: Record<string,
	unknown>): CampaignBudgetStatus {
	return value as unknown as CampaignBudgetStatus
}

async function privateDir(directory: string): Promise<void> { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700) }

async function fixture(options: { activeRun?: boolean; repositoryEnabled?: boolean } = {}): Promise<Fixture> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(),
		"hcl-fleet-v2-")); await fs.chmod(home, 0o700)
	const campaign = path.join(home, ".local", "state", "fleet-security-watch",
		"automation", "campaign")
	const controlDir = path.join(home, ".local", "share", "headlesscode",
		"campaign-control")
	await privateDir(campaign); await privateDir(controlDir)
	const credential = path.join(campaign, "test-key"),
		config = path.join(campaign, "config.json")
	const controlFile = path.join(controlDir, "control.json")
	await fs.writeFile(credential, fakeKey,
		{ mode: 0o600 }); await fs.chmod(credential, 0o600)
	await fs.writeFile(config, JSON.stringify({ schema_version: 1,
		enabled: true, repository: "/fixture", base_sha: "a".repeat(40),
		board_card: "1c25cecf", image_digest: "b".repeat(64),
			credential_file: credential, key_identity: keyIdentity }), { mode: 0o600 })
	await fs.chmod(config, 0o600)
	const scopes = (["repo-a", "repo-b"] as const).map((id) => {
		const s = scope(id)
		return { repositoryCampaignId: s.repositoryCampaignId,
			repositoryId: s.repositoryId, repository: s.repository,
			sourceRevision: s.sourceRevision, policySha256: s.policySha256,
				model: s.model, profileId: s.profileId,
			maxLifetimeSpendMicros: 10_000, maxLifetimeTokens: 10_000 }
	})
	await fs.writeFile(path.join(campaign, "repository-scopes.json"),
		JSON.stringify({ schemaVersion: 1, repositories: scopes }), { mode: 0o600 })
	await fs.chmod(path.join(campaign, "repository-scopes.json"), 0o600)
	const controlStore = new CampaignControlStore(controlFile)
	const controlDefinitions = new Map(definitions.map((definition) => [definition.id, definition]))
	let fault: string | undefined, month: string | undefined, crashHandoff = false
	await controlStore.setBudgetLimit(5_000_000)
	await controlStore.setEnabled(true)
	for (const definition of definitions) await controlStore.setRepositoryCampaign(definition, options.repositoryEnabled ?? true)
	const globalControl = await controlStore.snapshot()
	if (options.activeRun !== false) await controlStore.beginAdmittedRunIfIdle(new Date(), 300_000, globalControl.epoch)
	const invoke = async (message: Record<string, unknown>) => {
		const child = spawnSync("/usr/bin/python3", ["-c", pythonBridge],
			{ input: JSON.stringify(message), encoding: "utf8", timeout: 10_000,
			env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin",
				PYTHONPATH: fleetRoot, PYTHONNOUSERSITE: "1",
				...(fault ? { FLEET_TEST_FAULT: fault } : {}),
					...(month ? { FLEET_TEST_MONTH: month } : {}) } })
		fault = undefined
		if (child.error || child.status !== 0) throw new Error(`offline Fleet v2 bridge call failed closed (${child.status ?? child.error?.message ?? "spawn-error"}): ${(child.stderr ?? "").slice(0, 1200)}`)
		return JSON.parse(child.stdout.trim()) as Record<string, unknown>
	}
	const requestStartHandoff = async (message: Record<string, unknown>, onAdmitted: (reply: Record<string, unknown>) => void | Promise<void>) => {
		const lockPath = path.join(controlDir, "campaign-dispatch.lock")
		const lock = await fs.open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
		await lock.chmod(0o600)
		try { await new Promise<void>((resolve, reject) => {
			const child = spawn("/usr/bin/python3", ["-c", pythonBridgeHandoff], { stdio: ["pipe", "pipe", "ignore", lock.fd],
				env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: fleetRoot, PYTHONNOUSERSITE: "1",
					HEADLESSCODE_CAMPAIGN_LOCK_FD: "3", ...(month ? { FLEET_TEST_MONTH: month } : {}), ...(crashHandoff ? { FLEET_TEST_CRASH_AFTER_ADMIT: "1" } : {}) } })
			crashHandoff = false
			if (!child.stdout || !child.stdin) { child.kill("SIGKILL"); reject(new Error("fixture handoff pipes are unavailable")); return }
			const stdoutStream = child.stdout, stdinStream = child.stdin
			let stdout = "", admitted = false, handling = false, protocolError = false
			const timer = setTimeout(() => { protocolError = true; child.kill("SIGKILL") }, 10_000)
			stdoutStream.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8")
				if (Buffer.byteLength(stdout) > 64 * 1024) { protocolError = true; child.kill("SIGKILL"); return }
				if (admitted || handling) { protocolError = true; child.kill("SIGKILL"); return }
				const newline = stdout.indexOf("\n")
				if (newline < 0) return
				if (newline !== stdout.length - 1) { protocolError = true; child.kill("SIGKILL"); return }
				try {
					const reply = JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>
					handling = true
					void Promise.resolve(onAdmitted(reply)).then(() => {
						admitted = true
						stdinStream.write(reply.started === true ? "send-started\n" : "abort\n")
						stdinStream.end()
					}).catch(() => { protocolError = true; child.kill("SIGKILL") })
				} catch { protocolError = true; child.kill("SIGKILL") }
			})
			child.once("error", () => { protocolError = true; reject(new Error("fixture handoff spawn failed")) })
			child.once("close", (code) => {
				clearTimeout(timer)
				if (code !== 0 || !admitted || protocolError) reject(new Error("fixture request-start handoff failed"))
				else resolve()
			})
			stdinStream.write(JSON.stringify(message) + "\n")
		}) } finally { await lock.close() }
	}
	const tryDispatchLock = () => {
		const child = spawnSync("/usr/bin/python3", ["-c", "import fcntl,os,sys; fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600); exec('try:\\n fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\\nexcept BlockingIOError:\\n sys.exit(1)')" , path.join(controlDir, "campaign-dispatch.lock")],
			{ encoding: "utf8", timeout: 2_000 })
		return child.status === 0
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
		store, claim: claims[id], scope: scope(id), expectedKeyIdentity: keyIdentity, invoke, requestStartHandoff,
		assertDispatchFence: async () => undefined,
	})])) as Fixture["bindings"]
	return { root, home, store, controlStore, claims, grants, bindings, setFault(value): void { fault = value }, setMonth(value): void { month = value }, invoke, requestStartHandoff,
		tryDispatchLock,
		crashNextHandoff(): void { crashHandoff = true },
		async setControl(next): Promise<void> {
			if (next.globalEnabled !== undefined) await controlStore.setEnabled(next.globalEnabled)
			for (const [id, enabled] of [["repo-a", next.repoAEnabled], ["repo-b", next.repoBEnabled]] as const) {
				if (enabled !== undefined) await controlStore.setRepositoryCampaign(controlDefinitions.get(id)!, enabled)
			}
		}, cleanup: () => fs.rm(home, { recursive: true, force: true }) }
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
	const state = await f.store.status(new Date("2026-10-29T12:02:00Z")) as unknown as CampaignBudgetStatus
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

test("cold start reads Fleet budget without a run, then starts, claims, and stops through real HCL and Fleet stores", { skip: integrationSkip }, async (t) => {
	const f = await fixture({ activeRun: false, repositoryEnabled: false }); t.after(f.cleanup)
	const definition = definitions[0]!
	const readAuthority = async (): Promise<RepositoryBudgetAuthority> => {
		const state = await f.controlStore.snapshot()
		const row = state.repositoryCampaigns?.[definition.id]
		assert.ok(row)
		const ledger = new FleetRepositoryBudgetLedger({ expectedKeyIdentity: keyIdentity, scope: scope("repo-a", row.epoch), invoke: f.invoke })
		return state.activeRun ? await ledger.budgetSnapshot() : await ledger.budgetSnapshotOnly()
	}
	const repoStore = new RepositoryCampaignStore(path.join(f.root, "cold-start.json"), [definition], readAuthority)
	const initial = await repoStore.status() as unknown as CampaignBudgetStatus
	assert.equal(initial.budget.authority, "fleet-v2-readonly")
	assert.equal(initial.budget.available, false)
	assert.equal(initial.budget.provisioningAvailable, true,
		"a validated read-only snapshot may provision while this repository is disabled")
	const coldSnapshot = await new FleetRepositoryBudgetLedger({ expectedKeyIdentity: keyIdentity, scope: scope("repo-a"), invoke: f.invoke }).budgetSnapshotOnly()
	assert.equal(coldSnapshot.snapshotOnly, true)
	assert.equal(coldSnapshot.runId, null)
	assert.equal(coldSnapshot.runExpiresAtMs, null)
	await repoStore.setCampaignBudget(definition.id, 10_000, 10_000)
	await repoStore.enqueue(definition.id, "CVE-2026-92390")
	await assert.rejects(repoStore.claimNext(definition.id, { micros: 10_000, tokens: 10_000 }, new Date(), { executionKind: "live-cve" }),
		/require authoritative Fleet v2 registration/)
	const readyForStart = await repoStore.status() as unknown as CampaignBudgetStatus
	assert.equal(readyForStart.campaigns[0]?.enabled, false)
	assert.equal(readyForStart.campaigns[0]?.readiness, "ready",
		"the read-only snapshot clears the budget prerequisite before Start")
	const global = await f.controlStore.snapshot()
	const run = await f.controlStore.beginAdmittedRunIfIdle(new Date(), 300_000, global.epoch)
	assert.ok(run, "cold Start acquires a fresh bounded global run")
	await f.controlStore.setRepositoryCampaign(definition, true)
	await repoStore.start(definition.id)
	const runBound = await readAuthority()
	assert.equal(runBound.mode, "fleet-v2")
	assert.equal(runBound.runId, run!.id)
	const claim = await repoStore.claimNext(definition.id, { micros: 10_000, tokens: 10_000 }, new Date(), { executionKind: "live-cve" })
	assert.ok(claim, "one claim is admitted only with the real active run and repository epoch")
	await repoStore.stop(definition.id)
	await f.controlStore.setRepositoryCampaign(definition, false)
	const stopped = await f.controlStore.snapshot()
	assert.equal(stopped.repositoryCampaigns?.[definition.id]?.enabled, false)
	assert.equal(stopped.repositoryCampaigns?.[definition.id]?.epoch, 3)
	await f.controlStore.finishRun(run!.id, "succeeded", "offline cold-start fixture completed")
	await repoStore.finish(claim!, { status: "ambiguous" })
	const final = await repoStore.status() as unknown as CampaignBudgetStatus
	assert.ok(final.campaigns[0])
	assert.equal(final.campaigns[0].enabled, false)
})

test("read-only snapshot permits budget changes for an enabled repository but never dispatches", { skip: integrationSkip }, async (t) => {
	const f = await fixture({ activeRun: false, repositoryEnabled: true }); t.after(f.cleanup)
	const definition = definitions[0]!
	const readAuthority = async (): Promise<RepositoryBudgetAuthority> => {
		const ledger = new FleetRepositoryBudgetLedger({ expectedKeyIdentity: keyIdentity,
			scope: scope("repo-a"), invoke: f.invoke })
		return ledger.budgetSnapshotOnly()
	}
	const repoStore = new RepositoryCampaignStore(path.join(f.root, "readonly-enabled.json"), [definition], readAuthority)
	await repoStore.setCampaignBudget(definition.id, 10_000, 10_000)
	await repoStore.start(definition.id)
	const before = await repoStore.status() as unknown as CampaignBudgetStatus
	assert.equal(before.budget.available, false)
	assert.equal(before.budget.provisioningAvailable, true)
	assert.equal(before.campaigns[0]?.enabled, true)
	await repoStore.setCampaignBudget(definition.id, 9_000, 9_000)
	await repoStore.enqueue(definition.id, "CVE-2026-92390")
	await assert.rejects(repoStore.claimNext(definition.id, { micros: 1_000, tokens: 1_000 }, new Date(), { executionKind: "live-cve" }),
		/require authoritative Fleet v2 registration/)
})

test("Stop changes to either epoch before the dual request-start fence prevent the HTTP callback", { skip: integrationSkip }, async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	const id = "repo-a" as const, call = reservation("fixture-stop-call")
	await f.bindings[id].register(f.grants[id]); await f.bindings[id].reserve(f.grants[id], call)
	await f.setControl({ repoAEnabled: false, repoAEpoch: 2 })
	let sends = 0
	await assert.rejects(f.bindings[id].requestStartGate(async () => { sends += 1; return new Response("must not send") },
		{ grant: f.grants[id], reservation: call }), /outside|mismatched|stale|unavailable|current|handoff failed/)
	assert.equal(sends, 0)
})

test("Stop waits for Fleet request-start admission and send invocation, then proceeds before HTTP completion", { skip: integrationSkip }, async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	const id = "repo-a" as const, call = reservation("fixture-ordered-stop-call")
	const admissionEntered = deferred<void>(), releaseAdmission = deferred<void>()
	const sendStarted = deferred<void>(), releaseResponse = deferred<Response>()
	const requestStartHandoff = async (message: Record<string, unknown>, onAdmitted: (reply: Record<string, unknown>) => void | Promise<void>) =>
		await f.requestStartHandoff(message, async (reply) => {
			admissionEntered.resolve()
			await releaseAdmission.promise
			await onAdmitted(reply)
		})
	const binding = createRepositoryCampaignBudgetBinding({ store: f.store, claim: f.claims[id], scope: scope(id), expectedKeyIdentity: keyIdentity,
		invoke: f.invoke, requestStartHandoff })
	await binding.register(f.grants[id]); await binding.reserve(f.grants[id], call)
	const request = binding.requestStartGate(() => { sendStarted.resolve(); return releaseResponse.promise }, { grant: f.grants[id], reservation: call })
	await admissionEntered.promise
	assert.equal(f.tryDispatchLock(), false, "global Stop cannot cross an admitted-but-not-yet-invoked send")
	const stopped = f.store.stop(id)
	releaseAdmission.resolve()
	await sendStarted.promise
	await stopped
	await f.setControl({ globalEnabled: false, globalEpoch: 2 })
	releaseResponse.resolve(new Response("fixture response"))
	assert.equal((await request).status, 200)
})

test("Python crash after durable request-start is fail-closed and preserves both ambiguous holds", { skip: integrationSkip }, async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	const id = "repo-a" as const, call = reservation("fixture-python-crash-call")
	await f.bindings[id].register(f.grants[id]); await f.bindings[id].reserve(f.grants[id], call)
	f.crashNextHandoff()
	let sends = 0
	await assert.rejects(f.bindings[id].requestStartGate(async () => { sends += 1; return new Response("must not send") },
		{ grant: f.grants[id], reservation: call }), /handoff failed/)
	assert.equal(sends, 0)
	assert.equal(f.tryDispatchLock(), true, "parent closes the shared lock descriptor after the bridge crash")
	await f.store.recoverInterrupted()
	const result = await f.bindings[id].reconcile(f.grants[id])
	assert.deepEqual(result.calls.map((row) => row.state), ["ambiguous"])
	const status = await f.store.status() as unknown as CampaignBudgetStatus
	const job = status.jobs.find((item) => item.id === f.claims[id].job.id)
	assert.ok(job)
	assert.equal(job.status, "ambiguous")
	assert.equal(status.budget.ambiguousMicros, 20_000)
})

test("Node-side no-ack closes its shared lock descriptor and leaves the send reservation held", { skip: integrationSkip }, async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	const id = "repo-a" as const, call = reservation("fixture-no-ack-call")
	await f.bindings[id].register(f.grants[id]); await f.bindings[id].reserve(f.grants[id], call)
	const abortBeforeAck = (message: Record<string, unknown>) => f.requestStartHandoff(message, () => {
		throw new Error("simulated Node termination before request-start acknowledgement")
	})
	const binding = createRepositoryCampaignBudgetBinding({ store: f.store, claim: f.claims[id], scope: scope(id), expectedKeyIdentity: keyIdentity,
		invoke: f.invoke, requestStartHandoff: abortBeforeAck })
	let sends = 0
	await assert.rejects(binding.requestStartGate(async () => { sends += 1; return new Response("must not send") },
		{ grant: f.grants[id], reservation: call }), /handoff failed/)
	assert.equal(sends, 0)
	assert.equal(f.tryDispatchLock(), true)
	await f.store.recoverInterrupted()
	const reconciled = await binding.reconcile(f.grants[id])
	assert.deepEqual(reconciled.calls.map((row) => row.state), ["ambiguous"])
	const status = await f.store.status() as unknown as CampaignBudgetStatus
	assert.equal(status.budget.ambiguousMicros, 20_000)
})

test("immediately rejected fetch is observed during lock acknowledgement and keeps the claim recoverable", { skip: integrationSkip }, async (t) => {
	const f = await fixture(); t.after(f.cleanup)
	const id = "repo-a" as const, call = reservation("fixture-rejected-fetch-call")
	await f.bindings[id].register(f.grants[id]); await f.bindings[id].reserve(f.grants[id], call)
	const admitted = deferred<void>(), release = deferred<void>()
	const handoff = (message: Record<string, unknown>, onAdmitted: (reply: Record<string, unknown>) => void | Promise<void>) =>
		f.requestStartHandoff(message, async (reply) => { admitted.resolve(); await release.promise; await onAdmitted(reply) })
	const binding = createRepositoryCampaignBudgetBinding({ store: f.store, claim: f.claims[id], scope: scope(id), expectedKeyIdentity: keyIdentity,
		invoke: f.invoke, requestStartHandoff: handoff })
	const request = binding.requestStartGate(() => Promise.reject(new Error("synthetic fetch failure")), { grant: f.grants[id], reservation: call })
	await admitted.promise
	release.resolve()
	await assert.rejects(request, /synthetic fetch failure/)
	await f.store.recoverInterrupted()
	const status = await f.store.status() as unknown as CampaignBudgetStatus
	const job = status.jobs.find((item) => item.id === f.claims[id].job.id)
	assert.ok(job)
	assert.equal(job.status, "ambiguous")
	assert.equal(status.budget.ambiguousMicros, 20_000)
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
	const final = await restarted.status(new Date("2026-11-01T00:01:00Z")) as unknown as CampaignBudgetStatus
	const settled = final.jobs.find((job) => job.id === f.claims[id].job.id)
	assert.ok(settled)
	assert.equal(settled.status, "succeeded")
	assert.equal(settled.settledMicros, 100)
	assert.equal(settled.settledTokens, 19)
	assert.equal(final.budget.ambiguousMicros, 10_000) // Repository B's interrupted hold remains fail-closed.
})
