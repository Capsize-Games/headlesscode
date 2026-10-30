import assert from "node:assert/strict"
import {
	type RepositoryPreparedWorkspace,
	type RepositoryWorkerPipelineAdapters,
} from "../repository-worker-pipeline.js"
import type {
	RegisteredRepositoryWorker,
} from "../repository-coordinator.js"
import type {
	ClaimedRepositoryJob, RepositoryCampaignStore,
} from "../repository-campaigns.js"
import { digest, gate, type Gate } from "./coordinator-fixtures.js"
import {
	offlineLookup, pipelineShell,
} from "./coordinator-workers.js"

export interface PreparationGates {
	entered: Gate
	release: Gate
}

export interface PreparationCounters {
	contained: number
	cleanup: number
	evaluations: number
	deliveries: number
}

async function runGatedContained(
	counters: PreparationCounters,
): Promise<Awaited<ReturnType<
	RepositoryPreparedWorkspace["runContained"]>>> {
	counters.contained += 1
	return {
		ok: true,
		durationMs: 1,
		outputSha256: digest("f"),
		actualMicros: 0,
		actualTokens: 0,
	}
}

function preparedGatedWorkspace(
	root: string,
	counters: PreparationCounters,
): RepositoryPreparedWorkspace {
	return {
		worktree: root,
		taskSha256: digest("e"),
		runContained: () => runGatedContained(counters),
		candidateSha256: async (): Promise<string> => digest("1"),
		cleanup: async (): Promise<void> => {
			counters.cleanup += 1
		},
	}
}

function gatedWorkspace(
	gates: PreparationGates,
	root: string,
	counters: PreparationCounters,
): Promise<RepositoryPreparedWorkspace> {
	gates.entered.resolve()
	return gates.release.promise.then(() => {
		return preparedGatedWorkspace(root, counters)
	})
}

export async function countedEvaluate(
	counters: { evaluations: number },
): ReturnType<RepositoryWorkerPipelineAdapters["evaluate"]> {
	counters.evaluations += 1
	return {
		passed: true,
		evidenceSha256: digest("2"),
		detail: "unexpected",
	}
}

export async function countedDeliver(
	counters: { deliveries: number },
): ReturnType<RepositoryWorkerPipelineAdapters["deliverPrivate"]> {
	counters.deliveries += 1
	return { accepted: true, evidenceSha256: digest("3") }
}

export function gatedPrepareWorker(
	root: string,
	gates: PreparationGates,
	counters: PreparationCounters,
): RegisteredRepositoryWorker {
	return pipelineShell("development-checkpoint", {
		lookupAdvisory: offlineLookup,
		prepareWorkspace: () => gatedWorkspace(gates, root, counters),
		evaluate: () => countedEvaluate(counters),
		deliverPrivate: () => countedDeliver(counters),
	})
}

export interface AbortControls {
	entered: Gate
	release: Gate
	abort: Gate
}

export interface AbortCounters {
	sends: number
	cleanups: number
	evaluations: number
	deliveries: number
}

export interface AbortContext {
	counters: AbortCounters
	controls: AbortControls
}

function settledAbortResult(): Awaited<ReturnType<
	RepositoryPreparedWorkspace["runContained"]>> {
	return {
		ok: false,
		durationMs: 20,
		outputSha256: digest("f"),
		actualMicros: 7_000,
		actualTokens: 9_000,
		failureDiagnostic: "Contained worker cancelled after request " +
			"start; exact fixture receipt settled",
	}
}

async function runAbortableSend(
	store: RepositoryCampaignStore,
	ctx: AbortContext,
	claim: ClaimedRepositoryJob,
	signal: AbortSignal,
): Promise<Awaited<ReturnType<
	RepositoryPreparedWorkspace["runContained"]>>> {
	signal.addEventListener("abort", () => ctx.controls.abort.resolve(), {
		once: true,
	})
	const started = await store.withClaimRequestStart(claim, async () => {
		ctx.counters.sends += 1
		ctx.controls.entered.resolve()
		await ctx.controls.release.promise
		return "settled-fixture-response"
	})
	assert.equal(started, "settled-fixture-response")
	return settledAbortResult()
}

function abortableWorkspace(
	root: string,
	store: RepositoryCampaignStore,
	ctx: AbortContext,
	claim: ClaimedRepositoryJob,
): RepositoryPreparedWorkspace {
	return {
		worktree: root,
		taskSha256: digest("e"),
		runContained: (signal: AbortSignal): Promise<Awaited<ReturnType<
			RepositoryPreparedWorkspace["runContained"]>>> => {
			return runAbortableSend(store, ctx, claim, signal)
		},
		candidateSha256: async (): Promise<string> => digest("1"),
		cleanup: async (): Promise<void> => {
			ctx.counters.cleanups += 1
		},
	}
}

export function abortableSendWorker(
	root: string,
	store: RepositoryCampaignStore,
	ctx: AbortContext,
	setClaim: (claim: ClaimedRepositoryJob) => void,
): RegisteredRepositoryWorker {
	return pipelineShell("development-checkpoint", {
		lookupAdvisory: offlineLookup,
		prepareWorkspace: ({ claim }): Promise<RepositoryPreparedWorkspace> => {
			setClaim(claim)
			return Promise.resolve(abortableWorkspace(
				root, store, ctx, claim))
		},
		evaluate: () => countedEvaluate(ctx.counters),
		deliverPrivate: () => countedDeliver(ctx.counters),
	})
}

function freshAbortGates(): AbortControls {
	return { entered: gate(), release: gate(), abort: gate() }
}

function freshAbortCounters(): AbortCounters {
	return { sends: 0, cleanups: 0, evaluations: 0, deliveries: 0 }
}

export interface AbortableSendRig {
	worker: RegisteredRepositoryWorker
	gates: AbortControls
	counters: AbortCounters
	claim(): ClaimedRepositoryJob
}

export function abortableSendRig(
	root: string,
	store: RepositoryCampaignStore,
): AbortableSendRig {
	const gates = freshAbortGates()
	const counters = freshAbortCounters()
	const ctx: AbortContext = { counters, controls: gates }
	let claim: ClaimedRepositoryJob | undefined
	const worker = abortableSendWorker(root, store, ctx,
		(value) => { claim = value })
	return {
		worker,
		gates,
		counters,
		claim: () => {
			assert.ok(claim)
			return claim
		},
	}
}
