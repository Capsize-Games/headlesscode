import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import {
	RepositoryCampaignStore, type ClaimedRepositoryJob,
	type RepositoryBudgetAuthority, type RepositoryCampaignDefinition,
} from "../repository-campaigns.js"
import {
	FleetRepositoryBudgetLedger, type FleetRepositoryBudgetScope,
} from "../../rsi/fleet-repository-budget-ledger.js"
import {
	CURL_REPAIR_V2_CAMPAIGN_ID,
} from "../repository-campaign-ids.js"
import {
	CURL_REPAIR_V2_POLICY_SHA256, CURL_REPAIR_V2_REPOSITORY_ID,
	CURL_REPAIR_V2_SOURCE_REVISION, CURL_REPAIR_V2_TARGET_REPOSITORY,
} from "../repository-curl-repair-v2-profile.js"
import {
	definitions, grant, keyIdentity, readCampaignBudgetStatus, scope,
	type Fixture,
} from "./budget-v2-fixtures.js"

export function primaryDefinition(): RepositoryCampaignDefinition {
	const definition = definitions[0]
	assert.ok(definition)
	return definition
}

export function assertNoCallProofKeys(
	result: Record<string, unknown>,
): void {
	assert.deepEqual(Object.keys(result).sort(), [
		"asOfMs", "campaignId", "counts", "disposition", "grant",
		"jobId", "keyIdentity", "model", "policySha256", "profileId",
		"proved", "repository", "repositoryCampaignId",
		"repositoryEpoch", "repositoryId", "schemaVersion",
		"sourceRevision",
	].sort())
}

export function proveNoCallLedger(f: Fixture): FleetRepositoryBudgetLedger {
	return new FleetRepositoryBudgetLedger({
		expectedKeyIdentity: keyIdentity, scope: scope("repo-a"),
		invoke: async (message) => {
			const result = await f.invoke(message)
			if (message.op === "repository-no-call-proof") {
				assertNoCallProofKeys(result)
			}
			return result
		},
	})
}

export async function assertEmptyNoCall(
	ledger: FleetRepositoryBudgetLedger,
): Promise<void> {
	const empty = await ledger.proveNoCall("prepare-failed-job", 1)
	assert.equal(empty.proved, true)
	assert.equal(empty.disposition, "no-recorded-provider-activity")
	assert.equal(empty.grant, null)
	assert.deepEqual(empty.counts, { grants: 0, calls: 0, denials: 0 })
	assert.equal(empty.jobId, "prepare-failed-job")
	assert.ok(Math.abs(Date.now() - empty.asOfMs) < 10_000)
}

export async function assertGrantedNoCall(
	ledger: FleetRepositoryBudgetLedger,
	jobId: string,
): Promise<void> {
	await ledger.register(grant(jobId))
	const after = await ledger.proveNoCall(jobId, 1)
	assert.equal(after.proved, false)
	assert.equal(after.disposition, "grant-not-expired")
	assert.deepEqual(after.counts, { grants: 1, calls: 0, denials: 0 })
}

export async function assertExpiredGrantProof(
	ledger: FleetRepositoryBudgetLedger,
	jobId: string,
	bridgeDb: string,
): Promise<void> {
	const before = createHash("sha256").update(
		await fs.readFile(bridgeDb)).digest("hex")
	const expired = await ledger.proveNoCall(jobId, 1)
	const after = createHash("sha256").update(
		await fs.readFile(bridgeDb)).digest("hex")
	assert.equal(expired.proved, true)
	assert.equal(expired.disposition, "expired-unused-grant")
	assert.deepEqual(expired.counts, { grants: 1, calls: 0, denials: 0 })
	assert.ok(expired.grant && expired.grant.deadlineAtMs <= expired.asOfMs)
	assert.equal(before, after,
		"HCL proof read does not mutate the Fleet SQLite ledger")
}

export function v2ZeroCallScope(): FleetRepositoryBudgetScope {
	return { repositoryCampaignId: CURL_REPAIR_V2_CAMPAIGN_ID,
		repositoryId: CURL_REPAIR_V2_REPOSITORY_ID,
		repository: CURL_REPAIR_V2_TARGET_REPOSITORY,
		sourceRevision: CURL_REPAIR_V2_SOURCE_REVISION,
		policySha256: CURL_REPAIR_V2_POLICY_SHA256,
		model: "none", profileId: "no-model", repositoryEpoch: 7 }
}

export function v2ZeroCallPayload(): Record<string, unknown> {
	return { schemaVersion: 2, proved: true,
		disposition: "no-recorded-provider-activity",
		asOfMs: Date.now(), grant: null, campaignId: "fleet-security-watch",
		...v2ZeroCallScope(), keyIdentity, jobId: "infra-failed-v2",
		counts: { grants: 0, calls: 0, denials: 0 },
		globalEnabled: false, canAdmit: false, activeRunId: null,
		controlEpoch: 9, repositoryEnabled: true }
}

export function rejectedZeroCallLedger(
	invalid: Record<string, unknown>,
): FleetRepositoryBudgetLedger {
	return new FleetRepositoryBudgetLedger({
		expectedKeyIdentity: keyIdentity, scope: v2ZeroCallScope(),
		invoke: async () => invalid })
}

export function zeroCallInvalidVariants(
	payload: Record<string, unknown>,
): Array<Record<string, unknown>> {
	return [
		{ ...payload, globalEnabled: true },
		{ ...payload, activeRunId: "still-running" },
		{ ...payload, counts: { grants: 1, calls: 0, denials: 0 },
			proved: false, disposition: "activity-present" },
	]
}

export function assertZeroCallAdmitted(
	proof: Awaited<ReturnType<FleetRepositoryBudgetLedger["proveNoCall"]>>,
): void {
	assert.equal(proof.proved, true)
	assert.equal(proof.controlEpoch, 9)
	assert.equal(proof.repositoryEnabled, true)
	assert.equal(proof.globalEnabled, false)
	assert.equal(proof.activeRunId, null)
}

export type AuthorityReader = (
	campaignId?: string) => Promise<RepositoryBudgetAuthority>

export function coldReadAuthority(f: Fixture): AuthorityReader {
	return async () => {
		const state = await f.controlStore.snapshot()
		const row = state.repositoryCampaigns?.["repo-a"]
		assert.ok(row)
		const ledger = new FleetRepositoryBudgetLedger({
			expectedKeyIdentity: keyIdentity,
			scope: scope("repo-a", row.epoch), invoke: f.invoke })
		return state.activeRun ? await ledger.budgetSnapshot()
			: await ledger.budgetSnapshotOnly()
	}
}

export function readonlyAuthority(f: Fixture): AuthorityReader {
	return async () => {
		const ledger = new FleetRepositoryBudgetLedger({
			expectedKeyIdentity: keyIdentity, scope: scope("repo-a"),
			invoke: f.invoke })
		return ledger.budgetSnapshotOnly()
	}
}

export async function assertColdProvisioning(
	repoStore: RepositoryCampaignStore,
): Promise<void> {
	const initial = readCampaignBudgetStatus(await repoStore.status())
	assert.equal(initial.budget.authority, "fleet-v2-readonly")
	assert.equal(initial.budget.available, false)
	assert.equal(initial.budget.provisioningAvailable, true,
		"a read-only snapshot may provision while disabled")
}

export async function assertColdSnapshotOnly(f: Fixture): Promise<void> {
	const cold = await new FleetRepositoryBudgetLedger({
		expectedKeyIdentity: keyIdentity, scope: scope("repo-a"),
		invoke: f.invoke }).budgetSnapshotOnly()
	assert.equal(cold.snapshotOnly, true)
	assert.equal(cold.runId, null)
	assert.equal(cold.runExpiresAtMs, null)
}

export async function provisionColdClaim(
	repoStore: RepositoryCampaignStore,
	definition: RepositoryCampaignDefinition,
): Promise<void> {
	await repoStore.setCampaignBudget(definition.id, 10_000, 10_000)
	await repoStore.enqueue(definition.id, "CVE-2026-92390")
	await assert.rejects(repoStore.claimNext(definition.id,
		{ micros: 10_000, tokens: 10_000 }, new Date(),
		{ executionKind: "live-cve" }),
		/require authoritative Fleet v2 registration/)
	const ready = readCampaignBudgetStatus(await repoStore.status())
	assert.equal(ready.campaigns[0]?.enabled, false)
	assert.equal(ready.campaigns[0]?.readiness, "ready",
		"the read-only snapshot clears the budget prerequisite")
}

export interface ColdStart {
	runId: string
	claim: ClaimedRepositoryJob
}

export async function acquireColdRun(
	f: Fixture,
	repoStore: RepositoryCampaignStore,
	definition: RepositoryCampaignDefinition,
): Promise<ColdStart> {
	const global = await f.controlStore.snapshot()
	const run = await f.controlStore.beginAdmittedRunIfIdle(new Date(),
		300_000, global.epoch)
	assert.ok(run, "cold Start acquires a fresh bounded global run")
	await f.controlStore.setRepositoryCampaign(definition, true)
	await repoStore.start(definition.id)
	const bound = await coldReadAuthority(f)()
	assert.deepEqual([bound.mode, bound.runId], ["fleet-v2", run.id])
	const claim = await repoStore.claimNext(definition.id,
		{ micros: 10_000, tokens: 10_000 }, new Date(),
		{ executionKind: "live-cve" })
	assert.ok(claim,
		"one claim is admitted with the active run and repository epoch")
	return { runId: run.id, claim }
}

export async function stopColdCampaign(
	f: Fixture,
	repoStore: RepositoryCampaignStore,
	definition: RepositoryCampaignDefinition,
	started: ColdStart,
): Promise<void> {
	await repoStore.stop(definition.id)
	await f.controlStore.setRepositoryCampaign(definition, false)
	const stopped = await f.controlStore.snapshot()
	assert.equal(stopped.repositoryCampaigns?.[definition.id]?.enabled,
		false)
	assert.equal(stopped.repositoryCampaigns?.[definition.id]?.epoch, 3)
	await f.controlStore.finishRun(started.runId, "succeeded",
		"offline cold-start fixture completed")
	await repoStore.finish(started.claim, { status: "ambiguous" })
	const final = readCampaignBudgetStatus(await repoStore.status())
	assert.equal(final.campaigns[0]?.enabled, false)
}
