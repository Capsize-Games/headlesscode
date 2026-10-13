import { createHash } from "node:crypto"
import type { BenchmarkManifest } from "./benchmark/types.js"
import {
	openRouterAllocatedEnvironment,
	openRouterBrokerLimitsFromEnvironment,
	openRouterCampaignBudgetAllocation,
} from "./inference-broker.js"
import type { ProofCampaignManifest } from "./proof-campaign.js"
import { workerHarnessConfigDigest } from "./worker-harness.js"
import type { RsiConfig, RsiRunRecord } from "./types.js"

export function proofCandidateSlot(generation: number, index: number): string { return `g${generation}-candidate-${index}` }
export const RSI_CONFIRMATION_RETENTION_TASK_IDS = ["redirect-escape", "qa-baseline-counts", "strict-tool-schema", "dashboard-git-owner-api"] as const

export function proofCampaignTaskWallBoundMs(config: RsiConfig, plannedGenerations: number, developmentTasks: BenchmarkManifest["tasks"], confirmationTasks: BenchmarkManifest["tasks"], includeConfirmation = true): number {
	const slotsPerArm = plannedGenerations * config.population
	const candidateCountBothArms = 2 * slotsPerArm
	const candidateTaskMs = config.commandTimeoutMs * (3 + config.evalCommands.length)
		+ 3 * developmentTasks.reduce((sum, task) => sum + task.ceilings.timeoutMs, 0)
	const confirmationTaskMs = includeConfirmation ? 4 * confirmationTasks.reduce((sum, task) => sum + task.ceilings.timeoutMs, 0) : 0
	const bound = candidateCountBothArms * candidateTaskMs + confirmationTaskMs
	if (!Number.isSafeInteger(bound) || bound <= 0) throw new Error("proof campaign task-time ceiling exceeds safe integer accounting")
	return bound
}

export interface ProofCampaignSpendReservationMicros {
	mutation: number
	benchmark: number
	total: number
}

export function proofCampaignSpendReservationMicros(args: {
	mutationJobs: number
	mutationMaxJobSpendUsd: number
	mutationAllocationUsd: number
	benchmarkJobs: number
	benchmarkMaxJobSpendUsd: number
	benchmarkAllocationUsd: number
	totalAllocationUsd: number
	benchmarkShortfallMessage: string
}): ProofCampaignSpendReservationMicros {
	const floorMicros = (usd: number): number => {
		const micros = Math.floor(usd * 1_000_000)
		if (!Number.isSafeInteger(micros) || micros < 0) throw new Error("proof campaign spend allocation exceeds safe microUSD accounting")
		return micros
	}
	const reservationMicros = (jobs: number, perJobUsd: number): number => {
		const perJobMicros = Math.ceil(perJobUsd * 1_000_000)
		const totalMicros = jobs * perJobMicros
		if (!Number.isSafeInteger(jobs) || jobs < 0 || !Number.isSafeInteger(perJobMicros) || perJobMicros < 0 || !Number.isSafeInteger(totalMicros)) throw new Error("proof campaign job reservations exceed safe microUSD accounting")
		return totalMicros
	}
	const mutation = reservationMicros(args.mutationJobs, args.mutationMaxJobSpendUsd)
	const benchmark = reservationMicros(args.benchmarkJobs, args.benchmarkMaxJobSpendUsd)
	if (floorMicros(args.mutationAllocationUsd) < mutation) throw new Error("mutation broker campaign allocation is below the sum of frozen mutation job reservations")
	if (floorMicros(args.benchmarkAllocationUsd) < benchmark) throw new Error(args.benchmarkShortfallMessage)
	const total = mutation + benchmark
	if (!Number.isSafeInteger(total)) throw new Error("proof campaign job reservations exceed safe microUSD accounting")
	if (floorMicros(args.totalAllocationUsd) < total) throw new Error("proof campaign total allocation is below the sum of frozen job reservations")
	return { mutation, benchmark, total }
}

export function createProofCampaignManifest(args: {
	config: RsiConfig
	campaignId: string
	baseCommit: string
	model: string
	provider: string
	openRouterProfileId?: string
	runtime: NonNullable<RsiRunRecord["workerHarnessRuntime"]>
	developmentManifest: BenchmarkManifest
	developmentManifestDigest: string
	plannedGenerations: number
	proofProtocol: NonNullable<RsiRunRecord["developmentProofProtocol"]>
}): ProofCampaignManifest {
	const engineeringOnly = args.config.workerHarnessEngineeringOnly === true
	if (engineeringOnly && args.config.workerHarnessPhase === "confirmation") throw new Error("engineering-only proof runs cannot enter confirmation")
	if (args.provider !== "openshell-openrouter") throw new Error("restart-safe proof campaigns require supervisor-accounted OpenRouter inference")
	if (args.config.computePolicy === "adaptive-independent") throw new Error("restart-safe proof campaigns require every frozen generation to run; adaptive early-stop is not admitted")
	const benchmarkTasks = args.developmentManifest.tasks.filter((task) => task.split === "development")
	const confirmationTasks = args.developmentManifest.tasks.filter((task) => task.split === "confirmation")
	if (!benchmarkTasks.length || (!engineeringOnly && !confirmationTasks.length)) throw new Error("proof campaign requires nonempty development tasks and, unless engineering-only, confirmation tasks")
	if (!engineeringOnly && RSI_CONFIRMATION_RETENTION_TASK_IDS.some((taskId) => !confirmationTasks.some((task) => task.id === taskId))) throw new Error("frozen benchmark manifest is missing a preregistered confirmation retention task")
	const taskDigest = (tasks: typeof args.developmentManifest.tasks) => createHash("sha256").update(JSON.stringify(tasks)).digest("hex")
	const mutationCampaignId = proofBrokerCampaignId(args.campaignId, "mutation")
	const benchmarkCampaignId = proofBrokerCampaignId(args.campaignId, "benchmark")
	const mutationLimits = openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(process.env, "mutation"), mutationCampaignId, { maxCalls: args.config.maxIterations, ...(args.config.maxTokens ? { maxOutputTokensPerCall: args.config.maxTokens } : {}), maxDurationMs: args.config.commandTimeoutMs })
	const benchmarkEnv = openRouterAllocatedEnvironment(process.env, "benchmark")
	const benchmarkLimits = openRouterBrokerLimitsFromEnvironment(benchmarkEnv, benchmarkCampaignId, { maxDurationMs: Math.min(...benchmarkTasks.map((task) => task.ceilings.timeoutMs)) })
	const confirmationLimits = openRouterBrokerLimitsFromEnvironment(benchmarkEnv, benchmarkCampaignId, { maxDurationMs: Math.min(...confirmationTasks.map((task) => task.ceilings.timeoutMs)) })
	const jobCostCeiling = (limits: typeof mutationLimits, maxCalls: number, maxOutputTokensPerCall: number): number => {
		const perCallTokens = Math.min(limits.maxTotalTokens, limits.maxInputTokensPerCall + maxOutputTokensPerCall)
		const jobTokens = Math.min(limits.maxTotalTokens, maxCalls * (limits.maxInputTokensPerCall + maxOutputTokensPerCall))
		const unitPrice = Math.max(limits.maxInputPricePerMillionUsd, limits.maxOutputPricePerMillionUsd)
		const micros = (tokens: number) => Math.ceil(tokens * unitPrice)
		if (micros(perCallTokens) > limits.maxCallSpendUsd * 1_000_000) throw new Error("OpenRouter per-call spend cap is below the price ceiling for the admitted token ceiling")
		return micros(jobTokens) / 1_000_000
	}
	if (jobCostCeiling(mutationLimits, mutationLimits.maxCalls, mutationLimits.maxOutputTokensPerCall) > mutationLimits.maxJobSpendUsd) throw new Error("OpenRouter mutation job spend cap is below its admitted token and price ceilings")
	for (const task of benchmarkTasks) if (jobCostCeiling(benchmarkLimits, task.ceilings.maxCalls, task.ceilings.maxOutputTokensPerCall) > benchmarkLimits.maxJobSpendUsd) throw new Error(`OpenRouter benchmark job spend cap is below the frozen token and price ceiling for ${task.id}`)
	if (!engineeringOnly) for (const task of confirmationTasks) if (jobCostCeiling(confirmationLimits, task.ceilings.maxCalls, task.ceilings.maxOutputTokensPerCall) > confirmationLimits.maxJobSpendUsd) throw new Error(`OpenRouter confirmation job spend cap is below the frozen token and price ceiling for ${task.id}`)
	const candidateCounts = Array.from({ length: args.plannedGenerations }, (_, generation) => args.config.computePolicy === "adaptive-independent" && generation > 0 ? 1 : args.config.population)
	const schedule: ProofCampaignManifest["schedule"] = []
	for (const armId of ["fixed-control", "self-hosted"]) for (let generation = 0; generation < args.plannedGenerations; generation++) {
		for (let index = 0; index < candidateCounts[generation]!; index++) {
			const slot = proofCandidateSlot(generation, index)
			schedule.push({ armId, generation, candidateId: slot, taskId: "mutation", seed: args.config.seed, attemptKind: "mutation", phase: "development" })
			schedule.push({ armId, generation, candidateId: slot, taskId: "regression", seed: args.config.seed, attemptKind: "verification", phase: "development" })
			schedule.push({ armId, generation, candidateId: slot, taskId: "typecheck", seed: args.config.seed, attemptKind: "verification", phase: "development" })
			for (const [taskIndex] of args.config.evalCommands.entries()) schedule.push({ armId, generation, candidateId: slot, taskId: `visible-${taskIndex}`, seed: args.config.seed, attemptKind: "verification", phase: "development" })
			for (const role of ["child", "parent", "base"]) for (const task of benchmarkTasks) schedule.push({ armId, generation, candidateId: `${slot}:${role}`, taskId: task.id, seed: String(task.seed), attemptKind: "development-proof", phase: "development" })
		}
	}
	const finalGeneration = args.plannedGenerations - 1
	if (!engineeringOnly) for (const armId of ["fixed-control", "self-hosted"]) {
		for (let generation = 0; generation < args.plannedGenerations; generation++) {
			for (let index = 0; index < candidateCounts[generation]!; index++) for (const task of confirmationTasks) schedule.push({ armId, generation, candidateId: proofCandidateSlot(generation, index), taskId: task.id, seed: String(task.seed), attemptKind: "confirmation", phase: "confirmation" })
		}
		for (const task of confirmationTasks) schedule.push({ armId, generation: finalGeneration, candidateId: "root-control", taskId: task.id, seed: String(task.seed), attemptKind: "fixed-control", phase: "confirmation" })
	}
	const developmentCallsPerProofRole = benchmarkTasks.reduce((sum, task) => sum + task.ceilings.maxCalls, 0)
	const confirmationCalls = engineeringOnly ? 0 : 4 * confirmationTasks.reduce((sum, task) => sum + task.ceilings.maxCalls, 0) // selected final and root-control, for both arms
	const rootCalls = 2 * candidateCounts.reduce((sum, count) => sum + count * (mutationLimits.maxCalls + 3 * developmentCallsPerProofRole), 0) + confirmationCalls
	const developmentTokensPerProofRole = benchmarkTasks.reduce((sum, task) => sum + Math.min(benchmarkLimits.maxTotalTokens, task.ceilings.maxCalls * (benchmarkLimits.maxInputTokensPerCall + task.ceilings.maxOutputTokensPerCall)), 0)
	const confirmationTokensPerHarness = confirmationTasks.reduce((sum, task) => sum + Math.min(confirmationLimits.maxTotalTokens, task.ceilings.maxCalls * (confirmationLimits.maxInputTokensPerCall + task.ceilings.maxOutputTokensPerCall)), 0)
	const mutationTokens = Math.min(mutationLimits.maxTotalTokens, mutationLimits.maxCalls * (mutationLimits.maxInputTokensPerCall + mutationLimits.maxOutputTokensPerCall))
	const rootTokens = 2 * candidateCounts.reduce((sum, count) => sum + count * (mutationTokens + 3 * developmentTokensPerProofRole), 0) + (engineeringOnly ? 0 : 4 * confirmationTokensPerHarness)
	if (!Number.isSafeInteger(rootCalls) || !Number.isSafeInteger(rootTokens)) throw new Error("proof campaign root call or token ceiling exceeds safe integer accounting")
	const campaignBudget = openRouterCampaignBudgetAllocation(process.env)
	const slotsPerArm = candidateCounts.reduce((sum, count) => sum + count, 0)
	const mutationBudgetLimits = openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(process.env, "mutation"), mutationCampaignId)
	const benchmarkJobCount = 2 * slotsPerArm * 3 * benchmarkTasks.length + (engineeringOnly ? 0 : 4 * confirmationTasks.length)
	const reservations = proofCampaignSpendReservationMicros({
		mutationJobs: 2 * slotsPerArm, mutationMaxJobSpendUsd: mutationLimits.maxJobSpendUsd, mutationAllocationUsd: mutationBudgetLimits.maxCampaignSpendUsd,
		benchmarkJobs: benchmarkJobCount, benchmarkMaxJobSpendUsd: benchmarkLimits.maxJobSpendUsd, benchmarkAllocationUsd: benchmarkLimits.maxCampaignSpendUsd,
		totalAllocationUsd: campaignBudget.totalUsd,
		benchmarkShortfallMessage: engineeringOnly ? "benchmark broker campaign allocation is below development proof job reservations" : "benchmark broker campaign allocation is below development plus selected-final/root confirmation job reservations",
	})
	const taskWallBoundMs = proofCampaignTaskWallBoundMs(args.config, args.plannedGenerations, benchmarkTasks, confirmationTasks, !engineeringOnly)
	const maxRuntimeMs = args.config.maxRuntimeMs ?? 60 * 60_000
	if (maxRuntimeMs < taskWallBoundMs) throw new Error(`proof campaign runtime ceiling ${maxRuntimeMs}ms is below the summed frozen task-time ceiling ${taskWallBoundMs}ms`)
	return {
		schemaVersion: 1, phaseMode: engineeringOnly ? "engineering-only" : "paired-confirmation", campaignId: args.campaignId, rootCommit: args.baseCommit,
		benchmarkDigests: { manifest: args.developmentManifestDigest, development: taskDigest(benchmarkTasks), confirmation: taskDigest(engineeringOnly ? [] : confirmationTasks) },
		armAssignment: { fixedControl: "fixed-control", selfHosted: "self-hosted" },
		model: { provider: args.provider, id: args.model, ...(args.openRouterProfileId ? { profileId: args.openRouterProfileId } : {}), settings: { sampling: args.proofProtocol.model.sampling, roles: args.config.roles ?? {}, maxIterations: args.config.maxIterations, maxTokens: args.config.maxTokens ?? null } },
		seed: args.config.seed, taskOrder: ["mutation", "regression", "typecheck", ...args.config.evalCommands.map((_, index) => `visible-${index}`), ...benchmarkTasks.map((task) => task.id), ...(engineeringOnly ? [] : confirmationTasks.map((task) => task.id))], schedule,
		budgets: {
			attempt: { maxCalls: Math.max(mutationLimits.maxCalls, benchmarkLimits.maxCalls, ...(!engineeringOnly ? [confirmationLimits.maxCalls] : [])), maxTokens: Math.max(mutationLimits.maxTotalTokens, benchmarkLimits.maxTotalTokens, ...(!engineeringOnly ? [confirmationLimits.maxTotalTokens] : [])), maxSpendUsd: Math.max(mutationLimits.maxJobSpendUsd, benchmarkLimits.maxJobSpendUsd, ...(!engineeringOnly ? [confirmationLimits.maxJobSpendUsd] : [])), maxDurationMs: Math.max(args.config.commandTimeoutMs, ...benchmarkTasks.map((task) => task.ceilings.timeoutMs), ...(!engineeringOnly ? confirmationTasks.map((task) => task.ceilings.timeoutMs) : [])) },
			root: { maxCalls: rootCalls, maxTokens: rootTokens, maxSpendUsd: Math.min(campaignBudget.totalUsd, reservations.total / 1_000_000), maxRuntimeMs },
		},
		acceptanceRule: { ...args.proofProtocol.rule, confirmationRetentionTaskIds: engineeringOnly ? [] : [...RSI_CONFIRMATION_RETENTION_TASK_IDS], minimumSelfHostedCampaigns: 2, requiredSuccessiveTransitions: 2, clusterConfidence: 0.9 }, runtime: { imageDigest: args.runtime.imageDigest, harnessCommit: args.runtime.harnessCommit, dependencyLockDigest: args.runtime.dependencyLockDigest },
		analysisVersion: args.proofProtocol.schemaVersion.toString(), settings: { phaseMode: engineeringOnly ? "engineering-only" : "paired-confirmation", configDigest: workerHarnessConfigDigest(args.config, { baseCommit: args.baseCommit, model: args.model, provider: args.provider, proofProtocolDigest: args.proofProtocol.protocolDigest }), effectiveConfig: Object.fromEntries(Object.entries(args.config).filter(([key]) => !["workerHarnessMode", "workerHarnessPhase", "workerHarnessEngineeringOnly", "workerHarnessPairId", "workerHarnessRunId", "resumeRunId", "candidateIdNamespace", "workerHarnessParentCommit", "workerHarnessSnapshotTreeDigest", "hiddenSuitePath", "hiddenPublicKeyPath", "hiddenPrivateKeyPath", "hiddenNonceStorePath", "evaluatorSigningKeyPath", "evaluatorTrustedPublicKeyPath", "proofBenchmarkFixtures"].includes(key))), candidateCounts, taskWallBoundMs, evaluationCells: ["regression", "typecheck", ...args.config.evalCommands.map((_, index) => `visible-${index}`)], developmentTaskIdentities: benchmarkTasks.map((task) => ({ id: task.id, family: task.family, seed: task.seed, startDigest: task.startDigest, verifierDigest: task.verifierDigest, ceilings: task.ceilings })), confirmationTaskIdentities: engineeringOnly ? [] : confirmationTasks.map((task) => ({ id: task.id, family: task.family, seed: task.seed, startDigest: task.startDigest, verifierDigest: task.verifierDigest, ceilings: task.ceilings })), inferenceCeilings: { maxInputTokensPerCall: benchmarkLimits.maxInputTokensPerCall, maxOutputTokensPerCall: benchmarkLimits.maxOutputTokensPerCall, maxCallsPerAttempt: benchmarkLimits.maxCalls, maxTotalTokens: benchmarkLimits.maxTotalTokens, maxCallSpendUsd: benchmarkLimits.maxCallSpendUsd, maxJobSpendUsd: benchmarkLimits.maxJobSpendUsd, maxInputPricePerMillionUsd: benchmarkLimits.maxInputPricePerMillionUsd, maxOutputPricePerMillionUsd: benchmarkLimits.maxOutputPricePerMillionUsd }, inferenceCampaignIds: { mutation: mutationCampaignId, benchmark: benchmarkCampaignId }, inferenceAllocationsUsd: { mutation: mutationLimits.maxCampaignSpendUsd, benchmark: benchmarkLimits.maxCampaignSpendUsd } },
	}
}

export function proofBrokerCampaignId(rootCampaignId: string, allocation: "mutation" | "benchmark"): string {
	if (!rootCampaignId.trim()) throw new Error("proof campaign ID is required to derive broker campaign identity")
	return `${rootCampaignId}:${allocation}`
}
