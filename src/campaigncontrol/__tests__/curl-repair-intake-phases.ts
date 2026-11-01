import assert from "node:assert/strict"
import * as path from "node:path"
import type { ActiveCampaignRun } from "../store.js"
import {
	RepositoryCampaignStore, type RepositoryCampaignJob,
} from "../repository-campaigns.js"
import {
	CURL_REPAIR_ADAPTER_ID, CURL_REPAIR_RESERVATION,
} from "../repository-curl-repair.js"
import type {
	RegisteredRepositoryWorker,
} from "../repository-coordinator.js"
import { RepositoryCampaignCoordinator } from "../repository-coordinator.js"
import {
	bindRepositoryWorkerRegistrations,
	type RepositoryPipelineAdapterFactory,
} from "../repository-worker-registry.js"
import type {
	RepositoryBudgetAuthority,
} from "../repository-campaigns.js"
import {
	authority, definition, registration, repairFactory, runLease,
	waitForTerminal,
} from "./curl-repair-intake-fixtures.js"
import {
	makeCurlDebianAdvisoryTestFixture,
} from "./curl-historical-repair-fixture.js"
import type {
	IntakeCounters, RepairAdvisoryInput,
} from "./curl-repair-intake-factories.js"

export function syntheticAuthority(): RepositoryBudgetAuthority {
	return {
		mode: "synthetic-test",
		available: true,
		limitMicros: 20_000,
		limitTokens: 108_000,
		committedMicros: 0,
		committedTokens: 0,
	}
}

export async function openIntakeStore(
	root: string,
	run: ActiveCampaignRun,
): Promise<RepositoryCampaignStore> {
	const store = new RepositoryCampaignStore(
		path.join(root, "state.json"), [definition], () => authority(run))
	await store.setCampaignBudget(definition.id, 2_000, 18_000)
	await store.start(definition.id)
	return store
}

export async function openSyntheticStore(
	root: string,
): Promise<RepositoryCampaignStore> {
	const store = new RepositoryCampaignStore(
		path.join(root, "state.json"), [definition],
		() => syntheticAuthority())
	await store.setCampaignBudget(definition.id, 2_000, 18_000)
	await store.start(definition.id)
	return store
}

export function reopenStore(
	store: RepositoryCampaignStore,
): RepositoryCampaignStore {
	return new RepositoryCampaignStore(store.path, [definition],
		() => syntheticAuthority())
}

export function bindIntakeWorker(
	store: RepositoryCampaignStore,
	factories: Map<string, RepositoryPipelineAdapterFactory>,
): RegisteredRepositoryWorker {
	const [worker] = bindRepositoryWorkerRegistrations([definition],
		[registration], factories, { store })
	assert.ok(worker?.advisoryIntake)
	assert.equal(worker.advisoryIntake.source,
		"debian-tracker-repair-snapshot")
	return worker
}

export function bindSourceBlockedWorker(
	store: RepositoryCampaignStore,
	onPoll: () => void,
): RegisteredRepositoryWorker {
	const [worker] = bindRepositoryWorkerRegistrations([definition],
		[registration], new Map([[CURL_REPAIR_ADAPTER_ID,
			repairFactory({
				loadAdvisory: async () => {
					onPoll()
					return makeCurlDebianAdvisoryTestFixture()
				},
				verifySource: async () => {
					throw new Error("private Curl source no longer " +
						"matches the audited pin")
				},
			})]]), { store })
	assert.ok(worker)
	return worker
}

export function startIntakeCoordinator(
	store: RepositoryCampaignStore,
	worker: RegisteredRepositoryWorker,
	run: ActiveCampaignRun,
): RepositoryCampaignCoordinator {
	return new RepositoryCampaignCoordinator(store, [worker],
		100, runLease(run))
}

export async function tickAndAssertSettled(
	store: RepositoryCampaignStore,
	coordinator: RepositoryCampaignCoordinator,
): Promise<RepositoryCampaignJob> {
	await coordinator.tick()
	const job = await waitForTerminal(store)
	await assertSettledRepair(store, coordinator, job)
	return job
}

async function assertSettledIntakeRecord(
	store: RepositoryCampaignStore,
	job: RepositoryCampaignJob,
): Promise<void> {
	const firstStatus = await store.status() as {
		jobs: RepositoryCampaignJob[]
		intakeRecords: Array<{ source?: string; jobId: string | null }>
	}
	assert.equal(firstStatus.jobs.length, 1)
	assert.equal(firstStatus.intakeRecords[0]?.source,
		"debian-tracker-repair-snapshot")
	assert.equal(firstStatus.intakeRecords[0]?.jobId, job.id)
}

export async function assertSettledRepair(
	store: RepositoryCampaignStore,
	coordinator: RepositoryCampaignCoordinator,
	job: RepositoryCampaignJob,
): Promise<void> {
	assert.equal(job.purpose, "repair")
	assert.equal(job.status, "succeeded")
	assert.equal(job.settledMicros, 0)
	assert.equal(job.settledTokens, 0)
	await assertSettledIntakeRecord(store, job)
	assert.equal(coordinator.intakeStatus(definition.id).source,
		"debian-tracker-repair-snapshot")
	assert.equal(coordinator.intakeStatus(definition.id).coverage,
		"pinned-snapshot")
}

export interface RestartedIntake {
	store: RepositoryCampaignStore
	worker: RegisteredRepositoryWorker
	run: ActiveCampaignRun
	counters: IntakeCounters
	job: RepositoryCampaignJob
}

export async function restartAndAssertOnce(
	coordinator: RepositoryCampaignCoordinator,
	ctx: RestartedIntake,
): Promise<void> {
	await coordinator.stop()
	const restarted = new RepositoryCampaignCoordinator(ctx.store,
		[ctx.worker], 100, runLease(ctx.run))
	await restarted.tick()
	const secondStatus = await ctx.store.status() as {
		jobs: RepositoryCampaignJob[]
		intakeRecords: Array<{ jobId: string | null }>
	}
	assert.equal(ctx.counters.polls, 3, "loader runs for intake and restart")
	assert.equal(ctx.counters.sourceChecks, 4, "pin checked before claim")
	assert.equal(secondStatus.jobs.length, 1, "snapshot keeps one job")
	assert.equal(secondStatus.intakeRecords[0]?.jobId, ctx.job.id)
	assert.equal(ctx.counters.evaluatorCalls, 1, "no evaluator replay")
	assert.equal(ctx.counters.deliveryCalls, 1, "no delivery replay")
	await restarted.stop()
}

async function assertBlockedReadiness(
	coordinator: RepositoryCampaignCoordinator,
): Promise<void> {
	const readiness = coordinator.readiness(definition)
	assert.equal(readiness.state, "blocked-prerequisite")
	assert.deepEqual(readiness.reasons,
		["private-source-pin-changed-or-unavailable"])
	assert.equal(coordinator.intakeStatus(definition.id).source,
		"debian-tracker-repair-snapshot")
	assert.equal(coordinator.intakeStatus(definition.id).state,
		"unavailable")
}

export async function assertSourceBlocked(
	coordinator: RepositoryCampaignCoordinator,
	store: RepositoryCampaignStore,
	pollCalls: number,
): Promise<void> {
	await coordinator.tick()
	const status = await store.status() as {
		jobs: RepositoryCampaignJob[]
	}
	assert.equal(status.jobs[0]?.status, "queued",
		"source pin failure leaves queued work unclaimed")
	assert.equal(pollCalls, 0,
		"changed source blocks admission before the poll")
	await assertBlockedReadiness(coordinator)
	await coordinator.stop()
}

export type RepairObservation = Awaited<ReturnType<
	RepositoryCampaignStore["observeKnownRepairAdvisory"]>>

export async function assertAmbiguousNeverReplayed(
	store: RepositoryCampaignStore,
	jobId: string,
	input: RepairAdvisoryInput,
): Promise<void> {
	const reopened = reopenStore(store)
	const afterRestart = await reopened.observeKnownRepairAdvisory(input)
	const status = await reopened.status() as {
		jobs: RepositoryCampaignJob[]
	}
	assert.equal(afterRestart.job.id, jobId)
	assert.equal(status.jobs.length, 1)
	assert.equal(status.jobs[0]?.status, "ambiguous")
}

export async function interruptKnownRepair(
	store: RepositoryCampaignStore,
	input: RepairAdvisoryInput,
): Promise<{ first: RepairObservation; second: RepairObservation }> {
	const first = await store.observeKnownRepairAdvisory(input)
	assert.equal(first.queued, true)
	const claim = await store.claimNext(definition.id,
		CURL_REPAIR_RESERVATION)
	assert.ok(claim)
	assert.equal(await store.recoverInterrupted(), 1)
	const second = await store.observeKnownRepairAdvisory(input)
	return { first, second }
}
