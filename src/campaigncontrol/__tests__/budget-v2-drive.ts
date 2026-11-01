import assert from "node:assert/strict"
import {
	createRepositoryCampaignBudgetBinding,
} from "../repository-budget-binding.js"
import {
	RepositoryCampaignStore, type RepositoryCampaignJob,
} from "../repository-campaigns.js"
import type {
	RepositoryCampaignCoordinator,
} from "../repository-coordinator.js"
import {
	deferred, grant, keyIdentity, readCampaignBudgetStatus, reservation,
	scope, type CampaignBudgetStatus, type Fixture,
} from "./budget-v2-fixtures.js"
import type {
	OrderedStopGates, RunGate,
} from "./budget-v2-bindings.js"
import {
	FleetRepositoryBudgetLedger,
} from "../../rsi/fleet-repository-budget-ledger.js"
import type {
	CoordinatorRunState,
} from "./budget-v2-coordinator.js"

export async function waitTerminalJobs(
	store: RepositoryCampaignStore,
): Promise<RepositoryCampaignJob[]> {
	for (let i = 0; i < 300; i += 1) {
		const jobs = (await store.status()).jobs as RepositoryCampaignJob[]
		if (jobs.length === 2 && jobs.every((job) => job.status !== "queued" &&
			job.status !== "running")) return jobs
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("synthetic coordinated jobs did not reach terminal states")
}

export async function awaitAmbiguousJob(
	store: RepositoryCampaignStore,
): Promise<void> {
	for (let i = 0; i < 300; i += 1) {
		const jobs = (await store.status()).jobs as RepositoryCampaignJob[]
		if (jobs.some((job) => job.status === "ambiguous")) return
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("synthetic coordinated jobs did not reach ambiguity")
}

export function requireStatusJob(
	status: CampaignBudgetStatus,
	jobId: string,
): CampaignBudgetStatus["jobs"][number] {
	const job = status.jobs.find((item) => item.id === jobId)
	assert.ok(job)
	return job
}

export async function reconcileAmbiguous(
	binding: ReturnType<typeof createRepositoryCampaignBudgetBinding>,
	grantValue: Fixture["grants"]["repo-a"],
	store: RepositoryCampaignStore,
): Promise<CampaignBudgetStatus> {
	await store.recoverInterrupted()
	const reconciled = await binding.reconcile(grantValue)
	assert.deepEqual(reconciled.calls.map((row) => row.state),
		["ambiguous"])
	return readCampaignBudgetStatus(await store.status())
}

export async function recoverAmbiguousJob(
	store: RepositoryCampaignStore,
	jobId: string,
): Promise<CampaignBudgetStatus> {
	await store.recoverInterrupted()
	const status = readCampaignBudgetStatus(await store.status())
	const job = requireStatusJob(status, jobId)
	assert.equal(job.status, "ambiguous")
	return status
}

export async function fenceSecondPipeline(
	run: CoordinatorRunState,
	store: RepositoryCampaignStore,
	f: Fixture,
	coordinator: RepositoryCampaignCoordinator,
): Promise<void> {
	run.allowA.resolve(undefined)
	await run.aSent.promise
	for (const id of ["repo-a", "repo-b"] as const) {
		await store.stop(id)
		coordinator.stopCampaign(id)
	}
	await f.setControl({ globalEnabled: false, repoAEnabled: false,
		repoBEnabled: false })
	run.allowB.resolve(undefined)
	await awaitAmbiguousJob(store)
}

export async function settleFirstPipeline(
	run: CoordinatorRunState,
	coordinator: RepositoryCampaignCoordinator,
): Promise<RepositoryCampaignJob[]> {
	run.aResponse.resolve(new Response("already-sent fixture response"))
	const terminal = await waitTerminalJobs(run.store)
	await coordinator.stop()
	assert.equal(run.sendsA, 1,
		"the already-started synthetic request is allowed to settle")
	assert.equal(run.evaluatorCalls, 0)
	assert.equal(run.deliveryCalls, 0)
	assert.ok(terminal.some((job) => job.status === "failed" &&
		(job as { settledMicros?: number }).settledMicros === 100))
	assert.ok(terminal.some((job) => job.status === "ambiguous"),
		"the stopped unsent repository retains its unmeasured reservation")
	return terminal
}

export async function fenceAndSettle(
	run: CoordinatorRunState,
	store: RepositoryCampaignStore,
	f: Fixture,
	coordinator: RepositoryCampaignCoordinator,
): Promise<RepositoryCampaignJob[]> {
	await fenceSecondPipeline(run, store, f, coordinator)
	assert.equal(run.sendsB, 0,
		"Stop and the changed Fleet epoch prevent the second request")
	return settleFirstPipeline(run, coordinator)
}

export async function reconcileCrashedHandoff(
	f: Fixture,
	id: "repo-a",
): Promise<CampaignBudgetStatus> {
	return reconcileAmbiguous(f.bindings[id], f.grants[id], f.store)
}

export async function stopCoordinatorQuietly(
	coordinator: RepositoryCampaignCoordinator,
	run: CoordinatorRunState,
): Promise<void> {
	run.allowA.resolve(undefined)
	run.allowB.resolve(undefined)
	run.aResponse.resolve(new Response("fixture cleanup"))
	await coordinator.stop()
}

export function assertConsumedSnapshot(
	snapshot: Awaited<ReturnType<FleetRepositoryBudgetLedger["budgetSnapshot"]>>,
): void {
	assert.equal(snapshot.mode, "fleet-v2")
	assert.equal(snapshot.repositoryCampaignId, "repo-a")
	assert.equal(snapshot.repositoryLifetime.limitMicros, 10_000)
	assert.equal(snapshot.repositoryLifetime.settledMicros, 100)
	assert.equal(snapshot.campaignLifetime.limitMicros, 20_000)
	assert.equal(snapshot.campaignLifetime.settledMicros, 200)
	assert.equal(snapshot.legacyLifetime.settledMicros, 0)
	assert.equal(snapshot.committedMicros, 0)
	assert.equal(snapshot.available, true)
}

export async function assertExtraLedgerConsumed(f: Fixture): Promise<void> {
	const extra = new FleetRepositoryBudgetLedger({
		expectedKeyIdentity: keyIdentity, scope: scope("repo-a"),
		invoke: f.invoke, assertDispatchFence: async () => undefined,
	})
	assertConsumedSnapshot(await extra.budgetSnapshot())
	const extraGrant = grant("extra-repository-a-job", 0.01, 10_000)
	await extra.register(extraGrant)
	await assert.rejects(extra.reserve(extraGrant,
		{ ...reservation("extra-call"), reservedUsd: 0.01,
			reservedTokens: 2 }),
		/repository lifetime budget exhausted/)
}

export function orderedStopGates(): OrderedStopGates {
	return { admissionEntered: deferred<void>(),
		releaseAdmission: deferred<void>(), sendStarted: deferred<void>(),
		releaseResponse: deferred<Response>() }
}

export function beginOrderedSend(
	binding: ReturnType<typeof createRepositoryCampaignBudgetBinding>,
	grantValue: Fixture["grants"]["repo-a"],
	call: ReturnType<typeof reservation>,
	sendStarted: RunGate<void>,
	releaseResponse: RunGate<Response>,
): Promise<Response> {
	return binding.requestStartGate((): Promise<Response> => {
		sendStarted.resolve()
		return releaseResponse.promise
	}, { grant: grantValue, reservation: call })
}
