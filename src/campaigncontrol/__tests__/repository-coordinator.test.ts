import type { ActiveCampaignRun } from "../store.js"
import { RepositoryCampaignCoordinator } from "../repository-coordinator.js"
import { runMain, type SuiteTest } from "../../test-runner.js"
import {
	definition, fixtureRoot, gate, liveAuthority, openBudgetedStore,
	openEnqueuedStore, removeRoot, syntheticAuthority,
} from "./coordinator-fixtures.js"
import {
	eventWorker, rejectingWorker,
} from "./coordinator-workers.js"
import {
	abortableSendRig, gatedPrepareWorker, type PreparationCounters,
} from "./coordinator-stop-workers.js"
import { deliveryLoopWorker } from "./coordinator-delivery.js"
import {
	assertBlockedIntake, blockedIntakeWorker, busyLease,
	driveBusyLeaseRetry, driveLeaseLifecycle, drivePublishedIntake,
	driveRestartedIntake, nullLease, publishedIntakeWorker,
	publishedRecord, recordingLease,
} from "./coordinator-intake.js"
import {
	assertEvaluatorRejection, assertNoReplay, driveDeliveryLoop,
	driveStopDuringPreparation, driveStoppedSendRun, settleStoppedSend,
} from "./coordinator-phases.js"

async function testDeliveryLoop(): Promise<void> {
	const root = await fixtureRoot("hcl-camp-")
	const calls: string[] = []
	const entered = gate(), release = gate()
	const store = await openEnqueuedStore(root, () => syntheticAuthority(),
		"CVE-2026-1260", 80_000, 80_000)
	const worker = deliveryLoopWorker(root, store, calls,
		{ entered, release })
	const coordinator = new RepositoryCampaignCoordinator(store, [worker],
		100)
	try {
		await coordinator.start()
		await driveDeliveryLoop(store, entered.promise, release, calls)
	} finally {
		await coordinator.stop()
		await removeRoot(root)
	}
}

async function testEvaluatorRejection(): Promise<void> {
	const root = await fixtureRoot("hcl-camp-")
	const calls: string[] = []
	const store = await openEnqueuedStore(root, () => syntheticAuthority(),
		"CVE-2026-1260", 80_000, 80_000)
	const worker = rejectingWorker(root, calls)
	const coordinator = new RepositoryCampaignCoordinator(store, [worker],
		100)
	try {
		await coordinator.start()
		await assertEvaluatorRejection(store, calls)
	} finally {
		await coordinator.stop()
		await removeRoot(root)
	}
}

async function testStopDuringPreparation(): Promise<void> {
	const root = await fixtureRoot("hcl-camp-stop-before-worker-")
	const entered = gate()
	const release = gate()
	const counters: PreparationCounters = { contained: 0, cleanup: 0,
		evaluations: 0, deliveries: 0 }
	const store = await openEnqueuedStore(root, () => syntheticAuthority(),
		"CVE-2026-1260", 80_000, 80_000)
	const worker = gatedPrepareWorker(root, { entered, release }, counters)
	const coordinator = new RepositoryCampaignCoordinator(store, [worker],
		100)
	try {
		await coordinator.start()
		await driveStopDuringPreparation(store, coordinator,
			{ entered, release }, counters)
	} finally {
		release.resolve()
		await coordinator.stop()
		await removeRoot(root)
	}
}

async function testStopAfterSend(): Promise<void> {
	const root = await fixtureRoot("hcl-camp-stop-after-send-")
	const store = await openEnqueuedStore(root, () => syntheticAuthority(),
		"CVE-2026-1260", 80_000, 80_000)
	const rig = abortableSendRig(root, store)
	const coordinator = new RepositoryCampaignCoordinator(store,
		[rig.worker], 100)
	try {
		await coordinator.start()
		await driveStoppedSendRun(store, coordinator, rig.claim,
			rig.gates, rig.counters)
		await settleStoppedSend(store, rig.gates.release, rig.counters)
		await assertNoReplay(store, rig.counters.sends)
	} finally {
		rig.gates.release.resolve()
		await coordinator.stop()
		await removeRoot(root)
	}
}

async function testLeaseLifecycle(): Promise<void> {
	const root = await fixtureRoot("hcl-camp-run-")
	const run: ActiveCampaignRun = { id: "11111111-1111-4111-8111-111111111111",
		epoch: 4, startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
	const events: string[] = []
	const store = await openEnqueuedStore(root, () => liveAuthority(run),
		"CVE-2026-1260", 20_000, 20_000)
	const lease = recordingLease(run, events)
	const worker = eventWorker(root, events,
		"https://nvd.nist.gov/vuln/detail/CVE-2026-1260")
	const coordinator = new RepositoryCampaignCoordinator(store, [worker],
		100, lease)
	try {
		await coordinator.start()
		await driveLeaseLifecycle(store, events)
	} finally {
		await coordinator.stop()
		await removeRoot(root)
	}
}

async function testBusyLease(): Promise<void> {
	const root = await fixtureRoot("hcl-camp-busy-")
	const run: ActiveCampaignRun = { id: "22222222-2222-4222-8222-222222222222",
		epoch: 4, startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
	let busy = true
	const store = await openEnqueuedStore(root, () => liveAuthority(run),
		"CVE-2026-1261", 20_000, 20_000)
	const worker = eventWorker(root, [],
		"https://osv.dev/vulnerability/CVE-2026-1261")
	const lease = busyLease(run, () => busy)
	const coordinator = new RepositoryCampaignCoordinator(store, [worker],
		100, lease)
	try {
		await driveBusyLeaseRetry(coordinator, store, () => { busy = false })
	} finally {
		await coordinator.stop()
		await removeRoot(root)
	}
}

async function testPublishedIntake(): Promise<void> {
	const root = await fixtureRoot("hcl-camp-intake-")
	const run: ActiveCampaignRun = { id: "33333333-3333-4333-8333-333333333333",
		epoch: 4, startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
	const polls = { count: 0 }
	const store = await openBudgetedStore(root, () => liveAuthority(run),
		20_000, 20_000)
	const worker = publishedIntakeWorker(() => { polls.count += 1 },
		publishedRecord())
	const lease = nullLease()
	const coordinator = new RepositoryCampaignCoordinator(store, [worker],
		100, lease)
	try {
		await drivePublishedIntake(coordinator, store, polls)
		await coordinator.stop()
		await driveRestartedIntake(store, worker, lease,
			publishedRecord(), polls)
	} finally {
		await removeRoot(root)
	}
}

async function testBlockedSource(): Promise<void> {
	const root = await fixtureRoot("hcl-source-pin-osv-")
	const run: ActiveCampaignRun = { id: "44444444-4444-4444-8444-444444444444",
		epoch: 5, startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
	const polls = { count: 0 }
	const store = await openBudgetedStore(root, () => liveAuthority(run),
		20_000, 20_000)
	const worker = blockedIntakeWorker(() => { polls.count += 1 })
	const coordinator = new RepositoryCampaignCoordinator(store, [worker],
		100, nullLease())
	try {
		await assertBlockedIntake(coordinator, store, polls.count)
		await coordinator.stop()
	} finally {
		await removeRoot(root)
	}
}

const tests: readonly SuiteTest[] = [
	["registered repository pipeline runs intake, contained worker, evaluator, and private delivery in order",
		testDeliveryLoop],
	["protected evaluator rejection blocks private delivery",
		testEvaluatorRejection],
	["Stop during preparation prevents contained launch and cleans the prepared workspace",
		testStopDuringPreparation],
	["Stop after request start blocks later calls, preserves measured settlement, and does not replay",
		testStopAfterSend],
	["live worker obtains and releases a bounded global run lease",
		testLeaseLifecycle],
	["existing global run lease leaves queued work untouched", testBusyLease],
	["published advisory intake queues once, stays quiet when unchanged, and deduplicates after restart",
		testPublishedIntake],
	["a changed private source pin blocks ordinary OSV intake before polling",
		testBlockedSource],
]

await runMain("repository-coordinator", tests)
