import {
	createRepositoryWorkerPipeline,
	type RepositoryPreparedWorkspace,
	type RepositoryWorkerPipelineAdapters,
} from "../repository-worker-pipeline.js"
import type {
	RegisteredRepositoryWorker,
} from "../repository-coordinator.js"
import {
	definition, digest,
} from "./coordinator-fixtures.js"

export function adapterIdentity(): Pick<RepositoryWorkerPipelineAdapters,
	"workerProfile" | "recipeDigest" | "evaluatorDigest" | "model"> {
	return {
		workerProfile: definition.workerProfile!,
		recipeDigest: definition.recipeDigest!,
		evaluatorDigest: definition.evaluatorDigest!,
		model: definition.model!,
	}
}

export type PipelineMethods = Pick<RepositoryWorkerPipelineAdapters,
	"lookupAdvisory" | "prepareWorkspace" | "evaluate" |
	"deliverPrivate"> &
	Partial<Pick<RepositoryWorkerPipelineAdapters, "advisoryIntake">>

export function pipelineShell(
	executionKind: "development-checkpoint" | "live-cve",
	methods: PipelineMethods,
): RegisteredRepositoryWorker {
	return createRepositoryWorkerPipeline({
		...adapterIdentity(),
		executionKind,
		reservation: { micros: 10_000, tokens: 10_000 },
		...methods,
	})
}

async function eventIntake(
	advisoryId: string,
	events: string[],
	sourceUrl: string,
): ReturnType<RepositoryWorkerPipelineAdapters["lookupAdvisory"]> {
	events.push("intake")
	return {
		advisoryId,
		sourceUrl,
		snapshotSha256: digest("d"),
		summary: "Fixture",
		affectedRange: "< 1",
		fixedVersion: "1",
		verificationCheckIds: ["registered"],
	}
}

async function eventVerdict(
	events: string[],
): ReturnType<RepositoryWorkerPipelineAdapters["evaluate"]> {
	events.push("evaluate")
	return {
		passed: true,
		evidenceSha256: digest("2"),
		detail: "fixture",
	}
}

async function eventDelivery(
	events: string[],
): ReturnType<RepositoryWorkerPipelineAdapters["deliverPrivate"]> {
	events.push("deliver")
	return { accepted: true, evidenceSha256: digest("3") }
}

async function runEventContained(
	events: string[],
): Promise<Awaited<ReturnType<
	RepositoryPreparedWorkspace["runContained"]>>> {
	events.push("worker")
	return {
		ok: true,
		durationMs: 1,
		outputSha256: digest("f"),
		actualMicros: 1,
		actualTokens: 1,
	}
}

function eventPrepare(
	root: string,
	events: string[],
): RepositoryWorkerPipelineAdapters["prepareWorkspace"] {
	return async (): Promise<RepositoryPreparedWorkspace> => {
		return {
			worktree: root,
			taskSha256: digest("e"),
			runContained: () => runEventContained(events),
			async candidateSha256(): ReturnType<
				RepositoryPreparedWorkspace["candidateSha256"]> {
				return digest("1")
			},
		}
	}
}

export function eventWorker(
	root: string,
	events: string[],
	sourceUrl: string,
): RegisteredRepositoryWorker {
	return pipelineShell("live-cve", {
		lookupAdvisory: (advisoryId) => eventIntake(advisoryId, events,
			sourceUrl),
		prepareWorkspace: eventPrepare(root, events),
		evaluate: () => eventVerdict(events),
		deliverPrivate: () => eventDelivery(events),
	})
}

export async function offlineLookup(
	advisoryId: string,
): ReturnType<RepositoryWorkerPipelineAdapters["lookupAdvisory"]> {
	return {
		advisoryId,
		sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1260",
		snapshotSha256: digest("d"),
		summary: "Offline fixture only",
		affectedRange: "< 1.0",
		fixedVersion: "1.0",
		verificationCheckIds: ["fixture-check"],
	}
}

async function runRejectingContained(): Promise<Awaited<ReturnType<
	RepositoryPreparedWorkspace["runContained"]>>> {
	return {
		ok: true,
		durationMs: 5,
		outputSha256: digest("f"),
		actualMicros: 0,
		actualTokens: 0,
	}
}

function rejectingPrepare(
	root: string,
	calls: string[],
): RepositoryWorkerPipelineAdapters["prepareWorkspace"] {
	return async (): Promise<RepositoryPreparedWorkspace> => {
		return {
			worktree: root,
			taskSha256: digest("e"),
			runContained: runRejectingContained,
			async candidateSha256(): ReturnType<
				RepositoryPreparedWorkspace["candidateSha256"]> {
				return digest("1")
			},
			async cleanup(): Promise<void> { calls.push("cleanup") },
		}
	}
}

async function rejectingEvaluate(
	calls: string[],
): ReturnType<RepositoryWorkerPipelineAdapters["evaluate"]> {
	calls.push("evaluator")
	return {
		passed: false,
		evidenceSha256: digest("2"),
		detail: "fixture rejection",
	}
}

async function rejectingDeliver(
	calls: string[],
): ReturnType<RepositoryWorkerPipelineAdapters["deliverPrivate"]> {
	calls.push("delivery")
	return { accepted: true, evidenceSha256: digest("3") }
}

export function rejectingWorker(
	root: string,
	calls: string[],
): RegisteredRepositoryWorker {
	return pipelineShell("development-checkpoint", {
		lookupAdvisory: offlineLookup,
		prepareWorkspace: rejectingPrepare(root, calls),
		evaluate: () => rejectingEvaluate(calls),
		deliverPrivate: () => rejectingDeliver(calls),
	})
}
