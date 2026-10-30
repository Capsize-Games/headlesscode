import assert from "node:assert/strict"
import {
	createRepositoryCampaignBudgetBinding,
} from "../repository-budget-binding.js"
import {
	RepositoryCampaignStore, type RepositoryBudgetAuthority,
	type RepositoryCampaignDefinition, type RepositoryCampaignJob,
} from "../repository-campaigns.js"
import { repositoryProgressSnapshot } from "../repository-progress.js"
import {
	FleetRepositoryBudgetLedger,
} from "../../rsi/fleet-repository-budget-ledger.js"
import {
	definitions, keyIdentity, readCampaignBudgetStatus, reservation,
	scope, settlement,
	type CampaignBudgetStatus, type Fixture,
} from "./budget-v2-fixtures.js"

export async function registerAndReserveBoth(f: Fixture): Promise<void> {
	for (const id of ["repo-a", "repo-b"] as const) {
		await f.bindings[id].register(f.grants[id])
		await f.bindings[id].reserve(f.grants[id],
			reservation(`fixture-call-${id}`))
	}
}

export async function gateSettleFinishBoth(f: Fixture): Promise<number> {
	let sends = 0
	for (const id of ["repo-a", "repo-b"] as const) {
		const call = reservation(`fixture-call-${id}`)
		const gate = async (): Promise<Response> => {
			sends += 1
			return new Response("fixture")
		}
		const response = await f.bindings[id].requestStartGate(gate,
			{ grant: f.grants[id], reservation: call })
		assert.equal(response.status, 200)
		await f.bindings[id].settle(f.grants[id], settlement(call.callId))
		await f.bindings[id].finishFromReceipt(f.grants[id],
			new Date("2026-10-29T12:01:00Z"))
	}
	return sends
}

export async function assertSharedLifetimePool(f: Fixture): Promise<void> {
	const state = readCampaignBudgetStatus(await f.store.status(
		new Date("2026-10-29T12:02:00Z")))
	assert.equal(state.budget.settledMicros, 200)
	assert.equal(state.budget.settledTokens, 38)
	assert.equal(state.budget.reservedMicros, 0)
}

export interface RunGate<T> {
	promise: Promise<T>
	resolve(value: T): void
}

export function gatedHandoff(
	f: Fixture,
	entered: RunGate<void>,
	release: RunGate<void>,
): Fixture["requestStartHandoff"] {
	return async (message, onAdmitted): Promise<void> => {
		await f.requestStartHandoff(message, async (reply) => {
			entered.resolve(undefined)
			await release.promise
			await onAdmitted(reply)
		})
	}
}

export function abortingHandoff(f: Fixture): Fixture["requestStartHandoff"] {
	return (message, onAdmitted) => f.requestStartHandoff(message, () => {
		throw new Error("simulated Node termination before acknowledgement")
	})
}

export function bindTestClaim(
	f: Fixture,
	id: "repo-a",
	requestStartHandoff: Fixture["requestStartHandoff"],
): ReturnType<typeof createRepositoryCampaignBudgetBinding> {
	return createRepositoryCampaignBudgetBinding({ store: f.store,
		claim: f.claims[id], scope: scope(id),
		expectedKeyIdentity: keyIdentity, invoke: f.invoke,
		requestStartHandoff })
}

export async function refuseLiveClaim(
	repoStore: RepositoryCampaignStore,
	definition: RepositoryCampaignDefinition,
): Promise<void> {
	await assert.rejects(repoStore.claimNext(definition.id,
		{ micros: 1_000, tokens: 1_000 }, new Date(),
		{ executionKind: "live-cve" }),
		/require authoritative Fleet v2 registration/)
}

export interface OrderedStopGates {
	admissionEntered: RunGate<void>
	releaseAdmission: RunGate<void>
	sendStarted: RunGate<void>
	releaseResponse: RunGate<Response>
}

export async function finishOrderedStop(
	f: Fixture,
	id: "repo-a",
	gates: OrderedStopGates,
	request: Promise<Response>,
): Promise<void> {
	assert.equal(f.tryDispatchLock(), false,
		"global Stop cannot cross an admitted-but-not-yet-invoked send")
	const stopped = f.store.stop(id)
	gates.releaseAdmission.resolve(undefined)
	await gates.sendStarted.promise
	await stopped
	await f.setControl({ globalEnabled: false, globalEpoch: 2 })
	gates.releaseResponse.resolve(new Response("fixture response"))
	assert.equal((await request).status, 200)
}

export function reopenCrashedStore(
	f: Fixture,
	authority: RepositoryBudgetAuthority,
): RepositoryCampaignStore {
	return new RepositoryCampaignStore(f.store.path, definitions,
		() => authority)
}

export async function rollMonthAfterSettleFault(
	f: Fixture,
	callId: string,
	authority: RepositoryBudgetAuthority,
): Promise<RepositoryCampaignStore> {
	f.setFault("settle-after")
	await assert.rejects(f.bindings["repo-a"].settle(f.grants["repo-a"],
		settlement(callId)), /offline Fleet v2 bridge call failed closed/)
	const restarted = reopenCrashedStore(f, authority)
	await restarted.recoverInterrupted(new Date("2026-10-30T00:00:00Z"))
	await f.setControl({ repoAEnabled: false, repoAEpoch: 2 })
	f.setMonth("2026-11")
	return restarted
}

export async function reconcileLateReceipt(
	f: Fixture,
	restarted: RepositoryCampaignStore,
): Promise<CampaignBudgetStatus> {
	const recovered = createRepositoryCampaignBudgetBinding({
		store: restarted, claim: f.claims["repo-a"], scope: scope("repo-a"),
		expectedKeyIdentity: keyIdentity, invoke: f.invoke,
		assertDispatchFence: async () => undefined })
	const result = await recovered.reconcile(f.grants["repo-a"], undefined,
		new Date("2026-11-01T00:00:00Z"))
	assert.deepEqual(result.calls.map((row) => row.state), ["settled"])
	return readCampaignBudgetStatus(await restarted.status(
		new Date("2026-11-01T00:01:00Z")))
}

export async function deduplicateRestartAdvisory(
	restarted: RepositoryCampaignStore,
	terminal: RepositoryCampaignJob[],
	id: "repo-a" | "repo-b",
): Promise<void> {
	const advisoryId = id === "repo-a" ? "CVE-2026-92340" : "CVE-2026-92341"
	const duplicate = await restarted.enqueue(id, advisoryId)
	const prior = terminal.find((job) => job.campaignId === id)
	assert.ok(prior)
	assert.equal(duplicate.id, prior.id,
		"the same advisory is deduplicated after process restart")
}

export async function assertRestartProgress(
	restarted: RepositoryCampaignStore,
	pipeline: RepositoryCampaignDefinition[],
	id: "repo-a" | "repo-b",
): Promise<void> {
	const status = await restarted.status() as unknown as {
		campaigns: Array<Record<string, unknown> & { id: string }>
		jobs: RepositoryCampaignJob[] }
	const definition = pipeline.find((item) => item.id === id)
	const campaign = status.campaigns.find((item) => item.id === id)
	assert.ok(definition && campaign)
	const progress = repositoryProgressSnapshot(definition, campaign,
		status.jobs.filter((job) => job.campaignId === id))
	assert.equal(progress.workers.length, 1,
		"per-repository worker progress remains visible after restart")
	assert.ok(progress.workers[0]?.goal && progress.workers[0]?.workerId)
	assert.ok(progress.workers[0]?.completedSteps.includes("intake"))
	assert.equal(progress.counts.failed ?? -1, id === "repo-a" ? 1 : 0)
	assert.equal(progress.counts.ambiguous ?? -1, id === "repo-b" ? 1 : 0)
}

export async function assertRestartPreserved(
	restarted: RepositoryCampaignStore,
	pipeline: RepositoryCampaignDefinition[],
	terminal: RepositoryCampaignJob[],
): Promise<void> {
	for (const id of ["repo-a", "repo-b"] as const) {
		await deduplicateRestartAdvisory(restarted, terminal, id)
		await assertRestartProgress(restarted, pipeline, id)
	}
}

export async function verifyRestartPreserved(
	authority: RepositoryBudgetAuthority,
	store: RepositoryCampaignStore,
	pipeline: RepositoryCampaignDefinition[],
	terminal: RepositoryCampaignJob[],
	ledger: FleetRepositoryBudgetLedger,
): Promise<void> {
	const restarted = new RepositoryCampaignStore(store.path, pipeline,
		() => authority)
	await assertRestartPreserved(restarted, pipeline, terminal)
	const afterRestart = await ledger.budgetSnapshotOnly()
	assert.equal(afterRestart.campaignLifetime.settledMicros, 100)
	assert.equal(afterRestart.campaignLifetime.reservedMicros, 10_000)
	const jobs = readCampaignBudgetStatus(await restarted.status()).jobs
	assert.equal(jobs.length, 2)
}
