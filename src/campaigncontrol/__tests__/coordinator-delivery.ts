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
import { digest, readStatus, type Gate } from "./coordinator-fixtures.js"
import { offlineLookup, pipelineShell } from "./coordinator-workers.js"

export interface DeliveryLoopControls {
	entered: Gate
	release: Gate
}

export interface DeliveryContext {
	root: string
	calls: string[]
	claim: ClaimedRepositoryJob
	controls: DeliveryLoopControls
}

type DeliveryResult = Awaited<ReturnType<
	RepositoryPreparedWorkspace["runContained"]>>

function failedDeliveryResult(): DeliveryResult {
	return {
		ok: false,
		durationMs: 4,
		outputSha256: digest("5"),
		actualMicros: 7,
		actualTokens: 9,
		failureDiagnostic: "fixture worker failure",
	}
}

function passedDeliveryResult(): DeliveryResult {
	return {
		ok: true,
		durationMs: 12,
		outputSha256: digest("f"),
		actualMicros: 0,
		actualTokens: 0,
	}
}

async function runDeliveryContained(
	ctx: DeliveryContext,
): Promise<DeliveryResult> {
	ctx.calls.push("contained-worker")
	if (ctx.claim.job.advisoryId === "CVE-2026-1261") {
		return failedDeliveryResult()
	}
	ctx.controls.entered.resolve()
	await ctx.controls.release.promise
	return passedDeliveryResult()
}

export async function buildDeliveryWorkspace(
	ctx: DeliveryContext,
): Promise<RepositoryPreparedWorkspace> {
	ctx.calls.push("prepare")
	return {
		worktree: ctx.root,
		taskSha256: digest("e"),
		runContained: () => runDeliveryContained(ctx),
		async candidateSha256(): ReturnType<
			RepositoryPreparedWorkspace["candidateSha256"]> {
			return digest("1")
		},
		async cleanup(): Promise<void> { ctx.calls.push("cleanup") },
	}
}

export async function deliveryEvaluate(
	store: RepositoryCampaignStore,
	calls: string[],
): ReturnType<RepositoryWorkerPipelineAdapters["evaluate"]> {
	calls.push("evaluator")
	const status = readStatus(await store.status())
	const active = status.jobs.find(
		(item) => item.advisoryId === "CVE-2026-1260")!
	assert.equal(active.progress?.stage, "verify")
	assert.equal(active.progress?.currentTask,
		"Run the protected registered evaluator")
	assert.equal(
		active.progress?.completedSteps.includes("prepare-candidate"), true)
	return {
		passed: true,
		evidenceSha256: digest("2"),
		detail: "private bounded fixture result",
	}
}

export function deliveryBoardRef(): string {
	return "http://127.0.0.1:8078/api/cards/" +
		"1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7" +
		`#hc-repository-result-v1:${digest("4")}`
}

async function deliveryIntake(
	advisoryId: string,
	calls: string[],
): ReturnType<RepositoryWorkerPipelineAdapters["lookupAdvisory"]> {
	calls.push("intake")
	return offlineLookup(advisoryId)
}

async function deliveryDispatch(
	calls: string[],
): ReturnType<RepositoryWorkerPipelineAdapters["deliverPrivate"]> {
	calls.push("delivery")
	return {
		accepted: true,
		evidenceSha256: digest("3"),
		boardRef: deliveryBoardRef(),
	}
}

export function deliveryLoopWorker(
	root: string,
	store: RepositoryCampaignStore,
	calls: string[],
	controls: DeliveryLoopControls,
): RegisteredRepositoryWorker {
	return pipelineShell("development-checkpoint", {
		lookupAdvisory: (advisoryId) => deliveryIntake(advisoryId, calls),
		prepareWorkspace: ({ claim }): Promise<RepositoryPreparedWorkspace> =>
			buildDeliveryWorkspace({ root, calls, claim, controls }),
		evaluate: () => deliveryEvaluate(store, calls),
		deliverPrivate: () => deliveryDispatch(calls),
	})
}
