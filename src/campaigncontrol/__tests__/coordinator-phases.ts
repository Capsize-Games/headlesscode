import assert from "node:assert/strict"
import type {
	RepositoryCampaignCoordinator,
} from "../repository-coordinator.js"
import type {
	ClaimedRepositoryJob, RepositoryCampaignJob,
} from "../repository-campaigns.js"
import { RepositoryCampaignStore } from "../repository-campaigns.js"
import {
	definition, readStatus, waitForTerminal, type Gate,
} from "./coordinator-fixtures.js"
import { deliveryBoardRef } from "./coordinator-delivery.js"
import type {
	AbortCounters, AbortControls, PreparationCounters, PreparationGates,
} from "./coordinator-stop-workers.js"

export async function awaitLoopEntry(
	store: RepositoryCampaignStore,
	entered: Promise<void>,
): Promise<void> {
	await entered
	const pending = readStatus(await store.status()).jobs[0]!
	assert.equal(pending.progress?.stage, "prepare-candidate")
	assert.equal(pending.progress?.currentTask,
		"Run the registered contained worker")
	assert.equal(
		pending.progress?.completedSteps.includes("prepare-candidate"),
		false)
}

export async function assertLoopProgress(
	store: RepositoryCampaignStore,
	entered: Promise<void>,
	release: () => void,
	calls: string[],
): Promise<RepositoryCampaignJob> {
	await awaitLoopEntry(store, entered)
	release()
	const completed = await waitForTerminal(store)
	assert.equal(completed.status, "succeeded",
		JSON.stringify(completed.progress))
	assert.ok(completed.progress)
	assert.deepEqual(calls, ["intake", "prepare", "contained-worker",
		"evaluator", "delivery", "cleanup"])
	return completed
}

export function assertDeliveryReceipts(
	completed: RepositoryCampaignJob,
): void {
	assert.ok(completed.progress)
	assert.deepEqual(completed.progress.completedSteps,
		["intake", "deduplicate", "investigate", "prepare-candidate",
			"verify", "deliver"])
	assert.deepEqual(
		completed.progress.evidenceRefs.map((entry) => entry.kind),
		["intake", "candidate", "test-receipt", "delivery"])
	assert.equal(completed.progress.boardRef, deliveryBoardRef())
}

export async function driveDeliveryLoop(
	store: RepositoryCampaignStore,
	entered: Promise<void>,
	release: Gate,
	calls: string[],
): Promise<void> {
	const completed = await assertLoopProgress(store, entered,
		() => release.resolve(), calls)
	assertDeliveryReceipts(completed)
	await driveFailedRetry(store)
}

export async function assertEvaluatorRejection(
	store: RepositoryCampaignStore,
	calls: string[],
): Promise<void> {
	const failed = await waitForTerminal(store)
	assert.equal(failed.status, "failed")
	assert.ok(failed.progress)
	assert.deepEqual(calls, ["evaluator", "cleanup"])
	assert.equal(failed.progress.blocker,
		"protected-evaluator-rejected-candidate")
	assert.equal(failed.progress.evidenceRefs.some(
		(entry) => entry.kind === "delivery"), false)
}

export async function driveFailedRetry(
	store: RepositoryCampaignStore,
): Promise<void> {
	await store.enqueue(definition.id, "CVE-2026-1261")
	const failed = await waitForTerminal(store, "CVE-2026-1261")
	assert.equal(failed.status, "failed")
	assert.equal(failed.progress?.stage, "prepare-candidate")
	assert.equal(failed.progress?.currentTask,
		"Run the registered contained worker")
	assert.equal(
		failed.progress?.completedSteps.includes("prepare-candidate"),
		false)
	assert.equal(failed.settledMicros, 7)
	assert.equal(failed.settledTokens, 9)
}

export async function driveStopDuringPreparation(
	store: RepositoryCampaignStore,
	coordinator: RepositoryCampaignCoordinator,
	gates: PreparationGates,
	counters: PreparationCounters,
): Promise<void> {
	await gates.entered.promise
	await store.stop(definition.id)
	coordinator.stopCampaign(definition.id)
	gates.release.resolve()
	const stopped = await waitForTerminal(store)
	assert.equal(stopped.status, "ambiguous",
		"a pre-dispatch stop keeps its reserved hold until reconciliation")
	assert.equal(counters.contained, 0,
		"Stop prevents contained launch before the model-call path")
	assert.equal(counters.cleanup, 1,
		"prepared worktree and supervisor resources are cleaned")
}

export async function driveStoppedSendRun(
	store: RepositoryCampaignStore,
	coordinator: RepositoryCampaignCoordinator,
	claim: () => ClaimedRepositoryJob,
	gates: AbortControls,
	counters: AbortCounters,
): Promise<void> {
	await gates.entered.promise
	await store.stop(definition.id)
	coordinator.stopCampaign(definition.id)
	await gates.abort.promise
	await assert.rejects(store.withClaimRequestStart(claim(), async () => {
		counters.sends += 1
		return "forbidden"
	}), /stale or stopped/)
	assert.equal(counters.sends, 1, "the stop fence rejects every later call")
}

export async function settleStoppedSend(
	store: RepositoryCampaignStore,
	release: Gate,
	counters: AbortCounters,
): Promise<void> {
	release.resolve()
	const settled = await waitForTerminal(store)
	assert.equal(settled.status, "failed")
	assert.equal(settled.settledMicros, 7_000)
	assert.equal(settled.settledTokens, 9_000)
	assert.equal(counters.cleanups, 1)
	assert.equal(counters.evaluations, 0,
		"Stop prevents verification after the already-sent call settles")
	assert.equal(counters.deliveries, 0)
}

export async function assertNoReplay(
	store: RepositoryCampaignStore,
	sends: number,
): Promise<void> {
	const restarted = new RepositoryCampaignStore(store.path, [definition],
		() => ({
			mode: "synthetic-test",
			available: true,
			limitMicros: 100_000,
			limitTokens: 100_000,
			committedMicros: 0,
			committedTokens: 0,
		}))
	assert.equal(readStatus(await restarted.status()).jobs.length, 1)
	assert.equal(sends, 1, "restart does not replay the settled stopped job")
}
