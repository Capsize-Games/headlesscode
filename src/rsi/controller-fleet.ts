import { setTimeout as delay } from "node:timers/promises"
import type { EvaluatorRuntimeIdentity } from "./evaluator-runtime.js"
import {
	openRouterAllocatedEnvironment,
	openRouterBrokerLimitsFromEnvironment,
	openRouterProfileForModel,
	RSI_DEFAULT_OPENROUTER_PROFILE_ID,
} from "./inference-broker.js"
import type {
	OpenRouterDenialSummary,
	OpenRouterEndpointPriceSnapshot,
} from "./inference-broker.js"
import type {
	FleetJob,
	FleetJobPayload,
	PostgresRsiJobQueue,
} from "./postgres-queue.js"
import type {
	CandidateRecord,
	RsiConfig,
	RsiRunRecord,
	TrialResult,
	WorkerHarnessExecution,
} from "./types.js"
import {
	effectiveWorkerHarnessMode,
	validWorkerHarnessRuntimeIdentity,
	workerHarnessCliPath,
} from "./worker-harness.js"

export async function waitForFleetJob(queue: PostgresRsiJobQueue, jobId: string, timeoutMs: number, runtimeDeadlineMs?: number): Promise<FleetJob> {
	const deadline = Math.min(Date.now() + timeoutMs, runtimeDeadlineMs ?? Number.POSITIVE_INFINITY)
	for (;;) {
		const job = await queue.getJob(jobId)
		if (!job) throw new Error(`fleet job ${jobId} disappeared`)
		if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job
		if (Date.now() >= deadline) break
		await delay(500)
	}
	const reason = runtimeDeadlineMs !== undefined && Date.now() >= runtimeDeadlineMs ? "RSI run runtime ceiling" : "coordinator wait timeout"
	await queue.cancel(jobId, reason)
	const teardownDeadline = Date.now() + 60_000
	while (Date.now() < teardownDeadline) {
		const job = await queue.getJob(jobId)
		if (!job) throw new Error(`fleet job ${jobId} disappeared during cancellation`)
		if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job
		await delay(200)
	}
	throw new Error(`fleet job ${jobId} exceeded ${reason}; cancellation is pending worker teardown and its lease remains capacity-reserved`)
}

export function fleetRuntimeDeadlineMs(config: RsiConfig, run: RsiRunRecord): number | undefined {
	return config.maxRuntimeMs === undefined ? undefined : Date.parse(run.startedAt) + config.maxRuntimeMs
}

export function fleetPayload(config: RsiConfig, candidate: CandidateRecord, snapshot: { content: Buffer; snapshotCommit: string; snapshotTreeDigest?: string }, options: { campaignId?: string; boundedInference?: boolean; includeWorkerHarness?: boolean; proofCampaign?: FleetJobPayload["proofCampaign"]; remainingCampaignMs?: number; evaluatorRuntime?: Pick<EvaluatorRuntimeIdentity, "imageDigest" | "policySha256"> } = {}): FleetJobPayload {
	const provider = config.roles?.worker?.provider === "openrouter" ? "openrouter" : "ollama"
	const openRouterProfile = provider === "openrouter" ? openRouterProfileForModel(candidate.model, config.roles?.worker?.openRouterProfile) : undefined
	const inferenceLimits = provider === "openrouter" && options.boundedInference
		? openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(process.env, "mutation"), options.campaignId ?? "", {
			maxCalls: config.maxIterations,
			...(config.maxTokens ? { maxOutputTokensPerCall: config.maxTokens } : {}),
			maxDurationMs: Math.max(1, Math.min(config.commandTimeoutMs, options.remainingCampaignMs ?? config.commandTimeoutMs)),
		})
		: undefined
	const effectiveMode = effectiveWorkerHarnessMode(config.workerHarnessMode ?? "fixed-control", candidate.generation)
	const runtime = config.workerHarnessRuntime
	if (config.workerHarnessMode && options.includeWorkerHarness && (!runtime || !validWorkerHarnessRuntimeIdentity(runtime) || !snapshot.snapshotTreeDigest)) throw new Error("worker harness job lacks its frozen runtime and sanitized snapshot identity")
	return {
		schemaVersion: 1,
		snapshotSha256: "", // replaced with the verified artifact digest before enqueue
		snapshotBytes: snapshot.content.byteLength,
		snapshotCommit: snapshot.snapshotCommit,
		task: config.mutationTask,
		model: candidate.model,
		provider,
		...(openRouterProfile && openRouterProfile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID ? { openRouterProfile: openRouterProfile.id } : {}),
		...(options.proofCampaign ? { proofCampaign: options.proofCampaign } : {}),
		...(inferenceLimits ? { inferenceLimits } : {}),
		...(options.evaluatorRuntime ? { evaluatorRuntime: { ...options.evaluatorRuntime } } : {}),
		maxIterations: config.maxIterations,
		timeoutMs: config.commandTimeoutMs,
		protectedPaths: config.protectedPaths,
		candidate: {
			id: candidate.id, generation: candidate.generation, parent: candidate.parent,
			...(config.workerHarnessMode && options.includeWorkerHarness ? { baseCommit: candidate.baseCommit } : {}),
			mutationKind: candidate.mutationKind, hypothesis: candidate.hypothesis,
			modelCandidateId: candidate.modelCandidateId, computePolicy: config.computePolicy,
		},
		regressionCommand: config.regressionCommand,
		evalCommands: config.evalCommands,
		...(config.workerHarnessMode && options.includeWorkerHarness ? { workerHarness: {
			runMode: config.workerHarnessMode,
			mode: effectiveMode,
			...(config.workerHarnessPairId ? { pairId: config.workerHarnessPairId } : {}),
			parentCommit: candidate.baseCommit,
			snapshotTreeDigest: snapshot.snapshotTreeDigest!,
			runtime: runtime!,
			executedCliPath: workerHarnessCliPath(effectiveMode),
		} } : {}),
	}
}

export function recordFleetInferenceUsage(candidate: CandidateRecord, resultValue: unknown, payload: FleetJobPayload, jobId: string): void {
	candidate.modelProvider = `openshell-${payload.provider ?? "ollama"}`
	if ((payload.provider ?? "ollama") !== "openrouter") return
	if (!resultValue || typeof resultValue !== "object" || !payload.inferenceLimits) throw new Error("OpenRouter fleet mutation result is missing its broker identity")
	const result = resultValue as { provider?: unknown; model?: unknown; inferenceReceipt?: Record<string, unknown> }
	const receipt = result.inferenceReceipt
	const profile = openRouterProfileForModel(payload.model, payload.openRouterProfile)
	const profileIdMatches = profile.id === RSI_DEFAULT_OPENROUTER_PROFILE_ID ? receipt?.profileId === undefined || receipt.profileId === profile.id : receipt?.profileId === profile.id
	const price = receipt?.endpointPrice as OpenRouterEndpointPriceSnapshot | undefined
	const priceMatches = profile.id === RSI_DEFAULT_OPENROUTER_PROFILE_ID || Boolean(price && price.model === profile.model && price.provider === profile.endpointProvider && price.endpointTag === profile.endpointTag
		&& price.quantization === profile.quantization && profile.requiredParameters.every((parameter) => price.supportedParameters.includes(parameter))
		&& Number.isFinite(Date.parse(price.observedAt)) && /^[a-f0-9]{64}$/.test(price.responseSha256)
		&& Number.isFinite(price.inputPricePerMillionUsd) && price.inputPricePerMillionUsd > 0 && price.inputPricePerMillionUsd <= payload.inferenceLimits.maxInputPricePerMillionUsd
		&& Number.isFinite(price.outputPricePerMillionUsd) && price.outputPricePerMillionUsd > 0 && price.outputPricePerMillionUsd <= payload.inferenceLimits.maxOutputPricePerMillionUsd)
	if (result.provider !== "openrouter" || result.model !== payload.model || !receipt || receipt.provider !== "openrouter" || !profileIdMatches || !priceMatches || receipt.endpointProvider !== profile.endpointProvider || receipt.jobId !== jobId || receipt.campaignId !== payload.inferenceLimits.campaignId || receipt.model !== payload.model || receipt.accounting !== "supervisor-enforced" || receipt.qualified !== true || !Array.isArray(receipt.returnedModels) || receipt.returnedModels.length !== 1 || !profile.returnedModels.includes(String(receipt.returnedModels[0])) || !Array.isArray(receipt.returnedProviders) || receipt.returnedProviders.length !== 1 || receipt.returnedProviders[0] !== profile.endpointProvider) {
		throw new Error("OpenRouter fleet mutation result lacks a qualified receipt bound to the admitted provider, model, job and campaign")
	}
	const values = [receipt.calls, receipt.promptTokens, receipt.completionTokens, receipt.totalTokens, receipt.costUsd]
	if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) || !Number.isSafeInteger(receipt.calls) || !Number.isSafeInteger(receipt.promptTokens) || !Number.isSafeInteger(receipt.completionTokens) || !Number.isSafeInteger(receipt.totalTokens)) throw new Error("OpenRouter fleet mutation receipt contains malformed resource totals")
	if (!Array.isArray(receipt.denials) || !receipt.denials.every((entry) => entry && typeof entry === "object" && Number.isSafeInteger((entry as OpenRouterDenialSummary).statusCode) && (entry as OpenRouterDenialSummary).statusCode >= 400 && (entry as OpenRouterDenialSummary).statusCode <= 599 && Number.isSafeInteger((entry as OpenRouterDenialSummary).count) && (entry as OpenRouterDenialSummary).count >= 1 && /^[a-z-]+$/.test((entry as OpenRouterDenialSummary).reason))) throw new Error("OpenRouter fleet mutation receipt contains malformed denial summaries")
	candidate.inferenceUsage = {
		provider: "openrouter", endpointProvider: profile.endpointProvider, ...(profile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID ? { profileId: profile.id } : {}), model: payload.model, returnedModels: receipt.returnedModels as string[], returnedProviders: receipt.returnedProviders as string[], calls: receipt.calls as number,
		promptTokens: receipt.promptTokens as number, completionTokens: receipt.completionTokens as number, totalTokens: receipt.totalTokens as number,
		costUsd: receipt.costUsd as number, accounting: "supervisor-enforced", qualified: true, jobId,
		campaignId: payload.inferenceLimits.campaignId,
		denials: receipt.denials as OpenRouterDenialSummary[],
	}
}

export function recordFleetInferenceDenials(candidate: CandidateRecord, resultValue: unknown, payload: FleetJobPayload, jobId: string): void {
	if (payload.provider !== "openrouter" || !resultValue || typeof resultValue !== "object") return
	const result = resultValue as { provider?: unknown; model?: unknown; inferenceAudit?: { accounting?: unknown; jobId?: unknown; denials?: unknown } }
	const audit = result.inferenceAudit
	if (result.provider !== "openrouter" || result.model !== payload.model || audit?.accounting !== "incomplete" || audit.jobId !== jobId || !Array.isArray(audit.denials)) return
	const denials = audit.denials as OpenRouterDenialSummary[]
	if (!denials.every((entry) => entry && typeof entry === "object" && Number.isSafeInteger(entry.statusCode) && entry.statusCode >= 400 && entry.statusCode <= 599 && Number.isSafeInteger(entry.count) && entry.count >= 1 && /^[a-z-]+$/.test(entry.reason))) return
	candidate.inferenceDenials = structuredClone(denials)
}

export function fleetEvaluationResult(value: unknown): { regression: TrialResult; typecheck: TrialResult; visible: TrialResult[] } {
	if (!value || typeof value !== "object") throw new Error("fleet evaluation result is malformed")
	const result = value as {
		evaluation?: { regression?: unknown; typecheck?: unknown; visible?: unknown[] }
		outputArtifact?: { sha256?: unknown; bytes?: unknown }
	}
	const output = result.outputArtifact
	if (!output || typeof output.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(output.sha256) || !Number.isSafeInteger(output.bytes) || Number(output.bytes) < 1) {
		throw new Error("fleet evaluation output artifact reference is missing or malformed")
	}
	const compactTrial = (trial: unknown): TrialResult => {
		if (!trial || typeof trial !== "object") throw new Error("fleet evaluation trial is malformed")
		const item = trial as TrialResult
		if (typeof item.ok !== "boolean" || (item.exitCode !== null && !Number.isSafeInteger(item.exitCode)) || !Number.isFinite(item.durationMs) || item.durationMs < 0 || typeof item.command !== "string" || item.command.length > 512 || typeof item.stdout !== "string" || item.stdout.length > 2048 || typeof item.stderr !== "string" || item.stderr.length > 2048 || item.outputArtifactSha256 !== output.sha256 || item.outputArtifactBytes !== output.bytes) {
			throw new Error("fleet evaluation trial exceeds bounded result fields or lacks its output artifact reference")
		}
		return item
	}
	const evaluation = result.evaluation
	if (!evaluation || !Array.isArray(evaluation.visible)) throw new Error("fleet evaluation trial list is malformed")
	return { regression: compactTrial(evaluation.regression), typecheck: compactTrial(evaluation.typecheck), visible: evaluation.visible.map(compactTrial) }
}

export function fleetWorkerHarnessExecution(value: unknown, expected: FleetJobPayload): WorkerHarnessExecution | undefined {
	if (!expected.workerHarness) return undefined
	if (!value || typeof value !== "object") throw new Error("fleet mutation result omitted its worker harness identity")
	const execution = (value as { workerHarnessExecution?: WorkerHarnessExecution }).workerHarnessExecution
	const plan = expected.workerHarness
	if (!execution || execution.mode !== plan.mode || execution.parentCommit !== plan.parentCommit
		|| execution.snapshotTreeDigest !== plan.snapshotTreeDigest || execution.executedCliPath !== plan.executedCliPath
		|| JSON.stringify(execution.runtime) !== JSON.stringify(plan.runtime)
		|| !/^[a-f0-9]{40}$/.test(execution.snapshotCommit)) throw new Error("fleet mutation result does not match its frozen worker harness identity")
	return execution
}

export function validateCandidateWorkerHarnessExecution(candidate: CandidateRecord, run: RsiRunRecord, config: RsiConfig, execution?: WorkerHarnessExecution): void {
	if (!config.workerHarnessMode) return
	const expectedMode = effectiveWorkerHarnessMode(config.workerHarnessMode, candidate.generation)
	if (!execution || execution.mode !== expectedMode || execution.parentCommit !== candidate.baseCommit
		|| execution.executedCliPath !== workerHarnessCliPath(expectedMode)
		|| !/^[a-f0-9]{64}$/.test(execution.snapshotTreeDigest)
		|| !/^[a-f0-9]{40}$/.test(execution.snapshotCommit)
		|| JSON.stringify(execution.runtime) !== JSON.stringify(run.workerHarnessRuntime)) throw new Error("mutation result lacks the frozen worker harness execution identity")
	candidate.workerHarnessExecution = execution
}
