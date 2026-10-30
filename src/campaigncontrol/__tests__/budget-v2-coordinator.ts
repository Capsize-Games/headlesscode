import assert from "node:assert/strict"
import * as path from "node:path"
import {
	createRepositoryCampaignBudgetBinding,
} from "../repository-budget-binding.js"
import {
	RepositoryCampaignCoordinator,
} from "../repository-coordinator.js"
import {
	RepositoryCampaignStore, type ClaimedRepositoryJob,
	type RepositoryBudgetAuthority, type RepositoryCampaignDefinition,
	type RepositoryCampaignJob,
} from "../repository-campaigns.js"
import {
	createRepositoryWorkerPipeline,
	type RepositoryPreparedWorkspace,
	type RepositoryWorkerPipelineAdapters,
} from "../repository-worker-pipeline.js"
import {
	FleetRepositoryBudgetLedger,
} from "../../rsi/fleet-repository-budget-ledger.js"
import {
	definitions, deferred, grant, keyIdentity, MODEL, privateDir,
	reservation, scope, settlement,
	type Fixture,
} from "./budget-v2-fixtures.js"
import type { RunGate } from "./budget-v2-bindings.js"

export function pipelineAuthority(): RepositoryBudgetAuthority {
	return { mode: "synthetic-test", available: true,
		limitMicros: 20_000, limitTokens: 20_000,
		committedMicros: 0, committedTokens: 0 }
}

export function pipelineDefinitions(): RepositoryCampaignDefinition[] {
	return definitions.map((definition) => ({ ...definition,
		workerProfile: `fixture-${definition.id}` }))
}

export async function pipelineRoot(f: Fixture): Promise<string> {
	const root = path.join(f.root, "coordinated-pipelines")
	await privateDir(root)
	return root
}

export async function openPipelineStore(
	root: string,
	pipeline: RepositoryCampaignDefinition[],
): Promise<RepositoryCampaignStore> {
	const store = new RepositoryCampaignStore(
		path.join(root, "campaigns.json"), pipeline, pipelineAuthority)
	for (const id of ["repo-a", "repo-b"] as const) {
		await store.setCampaignBudget(id, 10_000, 10_000)
		await store.start(id)
		await store.enqueue(id,
			id === "repo-a" ? "CVE-2026-92340" : "CVE-2026-92341")
	}
	return store
}

export interface CoordinatorRunState {
	prepared: number
	sendsA: number
	sendsB: number
	evaluatorCalls: number
	deliveryCalls: number
	root: string
	store: RepositoryCampaignStore
	invoke: Fixture["invoke"]
	requestStartHandoff: Fixture["requestStartHandoff"]
	bothPrepared: RunGate<void>
	allowA: RunGate<void>
	allowB: RunGate<void>
	aSent: RunGate<void>
	aResponse: RunGate<Response>
}

export function newCoordinatorRun(
	f: Fixture,
	root: string,
	store: RepositoryCampaignStore,
): CoordinatorRunState {
	return {
		prepared: 0, sendsA: 0, sendsB: 0, evaluatorCalls: 0,
		deliveryCalls: 0, root, store, invoke: f.invoke,
		requestStartHandoff: f.requestStartHandoff,
		bothPrepared: deferred<void>(), allowA: deferred<void>(),
		allowB: deferred<void>(), aSent: deferred<void>(),
		aResponse: deferred<Response>(),
	}
}

function pipelineSend(
	id: "repo-a" | "repo-b",
	run: CoordinatorRunState,
): () => Promise<Response> {
	return async () => {
		if (id === "repo-a") {
			run.sendsA += 1
			run.aSent.resolve(undefined)
			return await run.aResponse.promise
		}
		run.sendsB += 1
		return new Response("unexpected fixture send")
	}
}

type PipelineCallGrant = Parameters<ReturnType<
	typeof createRepositoryCampaignBudgetBinding>["register"]>[0]
type PipelineCallReservation = Parameters<ReturnType<
	typeof createRepositoryCampaignBudgetBinding>["reserve"]>[1]

interface PipelineCall {
	binding: ReturnType<typeof createRepositoryCampaignBudgetBinding>
	grant: PipelineCallGrant
	call: PipelineCallReservation
}

export async function bindPipelineCall(
	run: CoordinatorRunState,
	id: "repo-a" | "repo-b",
	claim: ClaimedRepositoryJob,
): Promise<PipelineCall> {
	const binding = createRepositoryCampaignBudgetBinding({
		store: run.store, claim, scope: scope(id),
		expectedKeyIdentity: keyIdentity, invoke: run.invoke,
		requestStartHandoff: run.requestStartHandoff,
	})
	const brokerGrant = grant(claim.job.id)
	const call = reservation(`coordinator-${id}-${claim.job.id}`)
	await binding.register(brokerGrant)
	await binding.reserve(brokerGrant, call)
	return { binding, grant: brokerGrant, call }
}

type PipelineRunResult = Awaited<
	ReturnType<RepositoryPreparedWorkspace["runContained"]>>

async function runPipelineCall(
	id: "repo-a" | "repo-b",
	run: CoordinatorRunState,
	call: PipelineCall,
): Promise<PipelineRunResult> {
	await run.bothPrepared.promise
	await (id === "repo-a" ? run.allowA.promise : run.allowB.promise)
	const response = await call.binding.requestStartGate(
		pipelineSend(id, run), { grant: call.grant, reservation: call.call })
	assert.equal(response.status, 200)
	await call.binding.settle(call.grant, settlement(call.call.callId))
	return { ok: true, durationMs: 1,
		outputSha256: "1".repeat(64), actualMicros: 100, actualTokens: 19 }
}

export async function preparePipelineWorkspace(
	id: "repo-a" | "repo-b",
	run: CoordinatorRunState,
	claim: ClaimedRepositoryJob,
): Promise<RepositoryPreparedWorkspace> {
	const call = await bindPipelineCall(run, id, claim)
	run.prepared += 1
	if (run.prepared === 2) run.bothPrepared.resolve(undefined)
	return {
		worktree: run.root,
		taskSha256: "f".repeat(64),
		runContained: (): Promise<PipelineRunResult> =>
			runPipelineCall(id, run, call),
		candidateSha256: (): Promise<string> =>
			Promise.resolve("2".repeat(64)),
		cleanup: (): Promise<void> => Promise.resolve(),
	}
}

async function lookupFixtureAdvisory(advisoryId: string): ReturnType<
	RepositoryWorkerPipelineAdapters["lookupAdvisory"]> {
	return { advisoryId, sourceUrl: `https://fixture.invalid/${advisoryId}`,
		snapshotSha256: "e".repeat(64), summary: "Synthetic fixture",
		affectedRange: "< 1.0", fixedVersion: "1.0",
		verificationCheckIds: ["fixture-check"] }
}

async function noteUnexpectedEvaluation(
	run: CoordinatorRunState,
): ReturnType<RepositoryWorkerPipelineAdapters["evaluate"]> {
	run.evaluatorCalls += 1
	return { passed: true, evidenceSha256: "3".repeat(64),
		detail: "unexpected after Stop" }
}

async function noteUnexpectedDelivery(
	run: CoordinatorRunState,
): ReturnType<RepositoryWorkerPipelineAdapters["deliverPrivate"]> {
	run.deliveryCalls += 1
	return { accepted: true, evidenceSha256: "4".repeat(64) }
}

export function coordinatorPipelineAdapters(
	id: "repo-a" | "repo-b",
	run: CoordinatorRunState,
): RepositoryWorkerPipelineAdapters {
	return {
		workerProfile: `fixture-${id}`, model: MODEL,
		recipeDigest: (id === "repo-a" ? "c" : "e").repeat(64),
		evaluatorDigest: (id === "repo-a" ? "d" : "f").repeat(64),
		executionKind: "development-checkpoint",
		reservation: { micros: 10_000, tokens: 10_000 },
		lookupAdvisory: lookupFixtureAdvisory,
		prepareWorkspace: ({ claim }): Promise<RepositoryPreparedWorkspace> =>
			preparePipelineWorkspace(id, run, claim),
		evaluate: () => noteUnexpectedEvaluation(run),
		deliverPrivate: () => noteUnexpectedDelivery(run),
	}
}

export function openCoordinator(
	run: CoordinatorRunState,
	store: RepositoryCampaignStore,
): RepositoryCampaignCoordinator {
	const workers = (["repo-a", "repo-b"] as const).map((id) =>
		createRepositoryWorkerPipeline(coordinatorPipelineAdapters(id, run)))
	return new RepositoryCampaignCoordinator(store, workers, 100)
}

export async function assertSharedReservation(
	coordinator: RepositoryCampaignCoordinator,
	run: CoordinatorRunState,
	f: Fixture,
): Promise<FleetRepositoryBudgetLedger> {
	await coordinator.start()
	await run.bothPrepared.promise
	const ledger = new FleetRepositoryBudgetLedger({
		expectedKeyIdentity: keyIdentity, scope: scope("repo-a"),
		invoke: f.invoke,
	})
	const before = await ledger.budgetSnapshot()
	assert.equal(before.campaignLifetime.reservedMicros, 20_000,
		"both reservations consume the shared aggregate first")
	assert.equal(before.campaignLifetime.reservedTokens, 10_000)
	assert.equal(run.sendsA + run.sendsB, 0)
	return ledger
}
