import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createRepositoryBudgetAuthorityReader } from "../repository-budget-authority.js"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_PUBLIC_BASE_REVISION, CURL_DEBIAN_SNAPSHOT_SHA256,
	CURL_DEBIAN_SOURCE_HTML_SHA256, CURL_DEBIAN_SOURCE_URL, CURL_FIXED_ADVISORY } from "../repository-known-advisory.js"
import { CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_EVALUATOR_DIGEST, CURL_REPAIR_POLICY_SHA256,
	CURL_REPAIR_PROFILE_ID, CURL_REPAIR_RECIPE_DIGEST, CURL_REPAIR_REPOSITORY_ID,
	CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_TARGET_REPOSITORY } from "../repository-curl-repair.js"
import { CampaignControlStore } from "../store.js"
import { FleetRepositoryBudgetLedger, type FleetRepositoryBudgetScope,
	} from "../../rsi/fleet-repository-budget-ledger.js"
import type { FleetRepositoryBudgetLedgerOptions } from "../../rsi/fleet-repository-budget-ledger.js"
import type { OpenRouterBrokerGrant, OpenRouterCallReservation } from "../../rsi/inference-broker.js"
import type { ActiveCampaignRun } from "../store.js"
import { runMain, type SuiteTest } from "../../test-runner.js"
import { requiredFleetTestRoot } from "./fleet-test-source.js"

const key = "offline-budget-only-key-identity-source"
const keyIdentity = createHash("sha256").update(key).digest("hex")
const zeroUsage = { settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0,
	settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0 }
const qualified = { sourceAudited: true, workerQualified: true, recipeQualified: true,
	evaluatorQualified: true, modelApproved: true, dataApproved: true, accessApproved: true }
const definition: RepositoryCampaignDefinition = { id: CURL_REPAIR_CAMPAIGN_ID, name: "Historical Curl repair",
	repositoryId: CURL_REPAIR_REPOSITORY_ID, repository: CURL_REPAIR_TARGET_REPOSITORY,
	sourceRevision: CURL_REPAIR_SOURCE_REVISION, policySha256: CURL_REPAIR_POLICY_SHA256,
	workerProfile: CURL_REPAIR_PROFILE_ID, recipeDigest: CURL_REPAIR_RECIPE_DIGEST,
	evaluatorDigest: CURL_REPAIR_EVALUATOR_DIGEST, model: "none", dataAccessProfile: "public-source-and-published-advisory-only",
	qualification: qualified }
const budgetScope: FleetRepositoryBudgetScope = { repositoryCampaignId: definition.id,
	repositoryId: definition.repositoryId!, repository: definition.repository!, sourceRevision: definition.sourceRevision!,
	policySha256: definition.policySha256!, model: "none", profileId: "no-model", repositoryEpoch: 1 }
const run = { id: "no-model-repair-run-1", epoch: 2, startedAt: Date.now(), expiresAt: Date.now() + 300_000 }

function snapshotReply(message: Record<string, unknown>, activeRun: ActiveCampaignRun = run): Record<string, unknown> {
	const snapshotOnly = message.op === "repository-budget-snapshot" || (message.model === "none" && message.profileId === "no-model")
	const budgetOnlyRun = message.model === "none" && message.profileId === "no-model" && message.op === "repository-budget-status"
	const now = Date.now()
	return { schemaVersion: 2, available: !snapshotOnly, ...(snapshotOnly ? { snapshotOnly: true } : {}), asOfMs: now,
		campaignId: "fleet-security-watch", globalEnabled: true, canAdmit: true, controlEpoch: activeRun.epoch,
		runId: budgetOnlyRun ? activeRun.id : snapshotOnly ? null : activeRun.id,
		runExpiresAtMs: budgetOnlyRun ? activeRun.expiresAt : snapshotOnly ? null : activeRun.expiresAt,
		repositoryCampaignId: message.repositoryCampaignId, repositoryId: message.repositoryId,
		repository: message.repository, sourceRevision: message.sourceRevision, policySha256: message.policySha256,
		model: message.model, profileId: message.profileId, repositoryEnabled: true, repositoryEpoch: budgetScope.repositoryEpoch,
		monthly: { month: new Date().toISOString().slice(0, 7), limitMicros: 5_000_000,
			settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 },
		campaignLifetime: { limitMicros: 20_000, limitTokens: 108_000, ...zeroUsage },
		legacyLifetime: { ...zeroUsage },
		repositoryLifetime: { limitMicros: 1_000, limitTokens: 7_000, ...zeroUsage },
		externalCommittedMicros: 0, externalCommittedTokens: 0 }
}

function ledgerOptions(scope = budgetScope, invoked: Record<string, unknown>[] = []): FleetRepositoryBudgetLedgerOptions {
	return { expectedKeyIdentity: keyIdentity, scope, invoke: async (message) => { invoked.push(message); return snapshotReply(message) } }
}

async function noModelScopeReadsSnapshotsButCannotUseInferenceGrantPaths(): Promise<void> {
	const calls: Record<string, unknown>[] = []
	const ledger = new FleetRepositoryBudgetLedger(ledgerOptions(budgetScope, calls))
	const cold = await ledger.budgetSnapshotOnly()
	assert.equal(cold.mode, "fleet-v2-readonly")
	assert.equal(cold.model, "none")
	assert.equal(cold.profileId, "no-model")
	assert.equal(cold.available, false)
	assert.equal(cold.repositoryLifetime.limitMicros, 1_000)
	const live = await ledger.budgetSnapshot()
	assert.equal(live.mode, "fleet-v2-readonly")
	assert.equal(live.model, "none")
	assert.equal(live.profileId, "no-model")
	assert.equal(live.available, false)
	assert.deepEqual(calls.map((message) => message.op), ["repository-budget-snapshot", "repository-budget-status"])

	const grant = { jobId: "repair-no-model-job", leaseToken: "fixture-lease", capability: "fixture-capability",
		model: "none", profileId: "no-model", apiKeyIdentity: keyIdentity,
		limits: { campaignId: "fleet-security-watch", maxCalls: 1, maxInputTokensPerCall: 1, maxOutputTokensPerCall: 1,
			maxTotalTokens: 1, maxDurationMs: 1_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024,
			maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 1, maxCallSpendUsd: 0.000001,
			maxJobSpendUsd: 0.000001, maxCampaignSpendUsd: 0.02 } } as unknown as OpenRouterBrokerGrant
	const reservation: OpenRouterCallReservation = { callId: "repair-no-model-call", requestSha256: "a".repeat(64),
		reservedUsd: 0.000001, reservedTokens: 1, startedAt: new Date().toISOString() }
	let sends = 0
	await assert.rejects(ledger.register(grant), /grant differs/)
	await assert.rejects(ledger.reserve(grant, reservation), /grant differs/)
	await assert.rejects(ledger.requestStart(grant, reservation, async () => { sends++; return new Response("sent") }, () => { sends++ }), /grant differs/)
	await assert.rejects(ledger.proveNoCall(grant.jobId, 1), /budget-only/)
	assert.equal(sends, 0, "none/no-model cannot register, reserve, start, or send inference")
	assert.equal(calls.length, 2, "grant operations are rejected before any bridge call")
}

async function mismatchedNoModelProfilesAndScopesAreRejected(): Promise<void> {
	const mixedModel = { ...budgetScope, profileId: "muse-spark-contributor" } as FleetRepositoryBudgetScope
	const mixedProfile = { ...budgetScope, model: "meta/muse-spark-1.3-contributor" } as FleetRepositoryBudgetScope
	const otherRepository = { ...budgetScope, repositoryId: "other-repository" }
	for (const scope of [mixedModel, mixedProfile, otherRepository]) {
		assert.throws(() => new FleetRepositoryBudgetLedger({ expectedKeyIdentity: keyIdentity, scope,
			invoke: async (message) => snapshotReply(message) }), /scope is invalid/)
	}
	const malformedRepair = { ...definition, model: "meta/muse-spark-1.3-contributor" }
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-no-model-profile-"))
	try {
		const controlPath = path.join(root, "control.json")
		const control = new CampaignControlStore(controlPath)
		await control.setBudgetLimit(5_000_000)
		await control.setEnabled(true)
		await control.setRepositoryCampaign(malformedRepair, true)
		const reader = createRepositoryBudgetAuthorityReader([malformedRepair], controlPath,
			{ readKeyIdentity: async () => keyIdentity, createLedger: (options) => new FleetRepositoryBudgetLedger({ ...options,
				invoke: async (message) => snapshotReply(message) }) })
		assert.equal((await reader(definition.id)).mode, "unavailable", "the repair identity cannot select a Muse profile by changing model")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function compiledRepairDefinitionGetsColdAndLiveAuthorityAndAZeroModelClaim(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-no-model-claim-"))
	try {
		const controlPath = path.join(root, "control.json")
		const control = new CampaignControlStore(controlPath)
		await control.setBudgetLimit(5_000_000)
		await control.setEnabled(true)
		await control.setRepositoryCampaign(definition, true)
		assert.equal((await control.snapshot()).repositoryCampaigns?.[definition.id]?.epoch, budgetScope.repositoryEpoch)
		const snapshotCalls: string[] = []
		let activeRun = run
		const reader = createRepositoryBudgetAuthorityReader([definition], controlPath, {
			readKeyIdentity: async () => keyIdentity,
			createLedger: (options) => new FleetRepositoryBudgetLedger({ ...options, invoke: async (message) => {
				snapshotCalls.push(String(message.op))
				return snapshotReply(message, activeRun)
			} }),
		})
		const store = new RepositoryCampaignStore(path.join(root, "repository-campaigns.json"), [definition], reader)
		const coldAuthority = await reader(definition.id)
		assert.equal(coldAuthority.mode, "fleet-v2-readonly", JSON.stringify(coldAuthority))
		await store.setCampaignBudget(definition.id, 1_000, 7_000)
		const cold = await store.status() as { budget: { authority: string; available: boolean; provisioningAvailable: boolean } }
		assert.equal(cold.budget.authority, "fleet-v2-readonly")
		assert.equal(cold.budget.available, false)
		assert.equal(cold.budget.provisioningAvailable, true)
		await store.start(definition.id)
		const intake = await store.observeKnownRepairAdvisory({ campaignId: definition.id, advisoryId: CURL_FIXED_ADVISORY,
			publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION, snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
			sourceUrl: CURL_DEBIAN_SOURCE_URL, sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
			affectedRange: CURL_DEBIAN_AFFECTED_RANGE })
		const runCreated = await control.beginAdmittedRunIfIdle(new Date(), 300_000, (await control.snapshot()).epoch)
		assert.ok(runCreated)
		activeRun = runCreated!
		const live = await reader(definition.id)
		assert.equal(live.mode, "fleet-v2-budget-only")
		assert.equal(live.snapshotOnly, true, "budget-only remains explicitly snapshot-only for provider authority")
		assert.equal(live.model, "none")
		assert.equal(live.profileId, "no-model")
		const claim = await store.claimNext(definition.id, { micros: 1, tokens: 1 }, new Date(), { executionKind: "live-cve" })
		assert.ok(claim, "the exact no-model repair job can claim its local zero-model reservation under a live Fleet run")
		assert.equal(claim.job.id, intake.job.id)
		assert.equal(claim.job.purpose, "repair")
		assert.deepEqual(snapshotCalls.slice(0, 2), ["repository-budget-snapshot", "repository-budget-snapshot"])
		assert.ok(snapshotCalls.includes("repository-budget-status"))
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function realPythonBudgetOnlyBridgeFeedsHclAuthorityAndLocalClaim(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-no-model-python-bridge-"))
	const campaignRoot = path.join(root, ".local", "state", "fleet-security-watch", "automation", "campaign")
	const controlPath = path.join(root, ".local", "share", "headlesscode", "campaign-control", "control.json")
	const fleetRoot = requiredFleetTestRoot()
	try {
		await fs.mkdir(campaignRoot, { recursive: true, mode: 0o700 })
		await fs.mkdir(path.dirname(controlPath), { recursive: true, mode: 0o700 })
		const credentialFile = path.join(campaignRoot, "offline-test-key")
		await fs.writeFile(credentialFile, key, { mode: 0o600 })
		await fs.writeFile(path.join(campaignRoot, "config.json"), JSON.stringify({ schema_version: 1, enabled: true,
			repository: "/offline-fixture", base_sha: CURL_REPAIR_SOURCE_REVISION, board_card: "fixture-card",
			image_digest: "a".repeat(64), credential_file: credentialFile, key_identity: keyIdentity }), { mode: 0o600 })
		await fs.writeFile(path.join(campaignRoot, "repository-scopes.json"), JSON.stringify({ schemaVersion: 1, repositories: [{
			repositoryCampaignId: definition.id, repositoryId: definition.repositoryId, repository: definition.repository,
			sourceRevision: definition.sourceRevision, policySha256: definition.policySha256, model: "none", profileId: "no-model",
			maxLifetimeSpendMicros: 1_000, maxLifetimeTokens: 7_000,
		}] }), { mode: 0o600 })
		const control = new CampaignControlStore(controlPath)
		await control.setBudgetLimit(5_000_000)
		await control.setEnabled(true)
		await control.setRepositoryCampaign(definition, true)
		const python = `import json,sys\nfrom unittest.mock import patch\nimport operations.campaign_budget as budget\nimport operations.campaign_budget_bridge as bridge\nwith patch.object(budget, "_provider_snapshot", return_value={"limit_micros":5000000,"remaining_micros":5000000,"usage_micros":0}):\n print(json.dumps(bridge._authority().dispatch(json.load(sys.stdin)),separators=(",",":")))\n`
		const invoke = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
			const result = spawnSync("/usr/bin/python3", ["-c", python], { input: JSON.stringify(message), encoding: "utf8", timeout: 10_000,
				env: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: fleetRoot, PYTHONNOUSERSITE: "1" } })
			if (result.error || result.status !== 0) throw new Error(`offline Python budget bridge failed: ${(result.stderr ?? "").slice(0, 1000)}`)
			return JSON.parse(result.stdout.trim()) as Record<string, unknown>
		}
		const reader = createRepositoryBudgetAuthorityReader([definition], controlPath, { readKeyIdentity: async () => keyIdentity,
			createLedger: (options) => new FleetRepositoryBudgetLedger({ ...options, invoke }) })
		const store = new RepositoryCampaignStore(path.join(root, "repository-campaigns.json"), [definition], reader)
		await store.setCampaignBudget(definition.id, 1_000, 7_000)
		const cold = await reader(definition.id)
		assert.equal(cold.mode, "fleet-v2-readonly", "real bridge provides a non-admitting cold budget snapshot")
		assert.equal(cold.snapshotOnly, true)
		assert.equal(cold.available, false)
		await store.start(definition.id)
		const job = await store.observeKnownRepairAdvisory({ campaignId: definition.id, advisoryId: CURL_FIXED_ADVISORY,
			publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION, snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
			sourceUrl: CURL_DEBIAN_SOURCE_URL, sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256, affectedRange: CURL_DEBIAN_AFFECTED_RANGE })
		const state = await control.snapshot()
		const active = await control.beginAdmittedRunIfIdle(new Date(), 300_000, state.epoch)
		assert.ok(active)
		const live = await reader(definition.id)
		assert.equal(live.mode, "fleet-v2-budget-only")
		assert.equal(live.available, false, "the Python authority never grants inference availability")
		assert.equal(live.runId, active!.id, "HCL binds its local claim mode to a current global run")
		const claim = await store.claimNext(definition.id, { micros: 1, tokens: 1 }, new Date(), { executionKind: "live-cve" })
		assert.ok(claim, "real bridge budget snapshot admits only the exact local no-model repair claim")
		assert.equal(claim.job.id, job.job.id)
		assert.equal(claim.job.purpose, "repair")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["the exact no-model scope reads budget snapshots but cannot register, reserve, or start inference", noModelScopeReadsSnapshotsButCannotUseInferenceGrantPaths],
	["mismatched no-model profiles and repositories are rejected", mismatchedNoModelProfilesAndScopesAreRejected],
	["the compiled repair profile gets read-only and live authority and claims its zero-model repair job", compiledRepairDefinitionGetsColdAndLiveAuthorityAndAZeroModelClaim],
	["the real Python budget-only bridge feeds HCL authority and a local no-model claim", realPythonBudgetOnlyBridgeFeedsHclAuthorityAndLocalClaim],
]

await runMain("repository-no-model-budget", tests)
