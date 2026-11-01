import assert from "node:assert/strict"
import type { ActiveCampaignRun } from "../store.js"
import { RepositoryCampaignCoordinator } from "../repository-coordinator.js"
import { runMain, type SuiteTest } from "../../test-runner.js"
import {
	buildCurlHistoricalRepairTestFixture,
	makeCurlDebianAdvisoryTestFixture,
} from "./curl-historical-repair-fixture.js"
import { runLease } from "./curl-repair-intake-fixtures.js"
import {
	freshCounters, intakeFactories, repairAdvisoryInput,
} from "./curl-repair-intake-factories.js"
import {
	assertAmbiguousNeverReplayed, assertSourceBlocked, bindIntakeWorker,
	bindSourceBlockedWorker, interruptKnownRepair, openIntakeStore,
	openSyntheticStore, restartAndAssertOnce, startIntakeCoordinator,
	tickAndAssertSettled,
} from "./curl-repair-intake-phases.js"
import { fixtureRoot, removeRoot } from "./coordinator-fixtures.js"

async function testIntakeSettlesOnce(): Promise<void> {
	const root = await fixtureRoot("hcl-repair-intake-")
	const counters = freshCounters()
	const candidate = await buildCurlHistoricalRepairTestFixture()
	const run: ActiveCampaignRun = { id: "44444444-4444-4444-8444-444444444444",
		epoch: 1, startedAt: Date.now(),
		expiresAt: Date.now() + 20 * 60_000 }
	const store = await openIntakeStore(root, run)
	const factories = intakeFactories(candidate,
		makeCurlDebianAdvisoryTestFixture(), counters)
	const worker = bindIntakeWorker(store, factories)
	const coordinator = startIntakeCoordinator(store, worker, run)
	try {
		const job = await tickAndAssertSettled(store, coordinator)
		await restartAndAssertOnce(coordinator,
			{ store, worker, run, counters, job })
	} finally {
		await removeRoot(root)
	}
}

async function testSourcePinBlocksClaims(): Promise<void> {
	const root = await fixtureRoot("hcl-repair-source-change-")
	const run: ActiveCampaignRun = { id: "55555555-5555-4555-8555-555555555555",
		epoch: 1, startedAt: Date.now(),
		expiresAt: Date.now() + 20 * 60_000 }
	const store = await openIntakeStore(root, run)
	await store.enqueueKnownRepair(repairAdvisoryInput())
	let pollCalls = 0
	const worker = bindSourceBlockedWorker(store, () => { pollCalls += 1 })
	const coordinator = new RepositoryCampaignCoordinator(store, [worker],
		100, runLease(run))
	try {
		await assertSourceBlocked(coordinator, store, pollCalls)
	} finally {
		await removeRoot(root)
	}
}

async function testAmbiguousObservationNeverReplays(): Promise<void> {
	const root = await fixtureRoot("hcl-repair-ambiguous-")
	try {
		const store = await openSyntheticStore(root)
		const { first, second } = await interruptKnownRepair(store,
			repairAdvisoryInput())
		assert.equal(second.changed, false)
		assert.equal(second.queued, false)
		assert.equal(second.job.status, "ambiguous")
		await assertAmbiguousNeverReplayed(store, first.job.id,
			repairAdvisoryInput())
	} finally {
		await removeRoot(root)
	}
}

const tests: readonly SuiteTest[] = [
	["synthetic snapshot settles the already-fixed repair once across restart",
		testIntakeSettlesOnce],
	["changed source pin blocks new claims as a prerequisite failure",
		testSourcePinBlocksClaims],
	["ambiguous repair intake is never automatically replayed",
		testAmbiguousObservationNeverReplays],
]

await runMain("repository-curl-repair-intake", tests)
