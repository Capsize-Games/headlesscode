import type { BenchmarkManifest, BenchmarkTask } from "./benchmark/types.js"
import type { OpenRouterBrokerLimits } from "./inference-broker.js"
import { proofCampaignTaskWallBoundMs } from "./controller.js"
import type { RsiConfig } from "./types.js"

export interface ProofRoleLimits extends OpenRouterBrokerLimits {}
export interface ProofDemonstrationPlan {
	engineering: ProofDemonstrationArmPlan
	campaign: ProofDemonstrationArmPlan
	totalReservedSpendUsd: number
	totalRootSpendCeilingUsd: number
	engineeringRootSpendCeilingUsd: number
	campaignRootsSpendCeilingUsd: number
	totalPriceDerivedSpendCeilingUsd: number
	totalRootPriceDerivedSpendCeilingUsd: number
	totalCalls: number
	totalTokens: number
	totalTaskWallMs: number
}
export interface ProofDemonstrationArmPlan {
	phase: "engineering" | "campaign"
	generations: number
	population: number
	mutationJobs: number
	verificationJobs: number
	developmentProofCells: number
	confirmationScheduleCells: number
	confirmationDisposition: "not-frozen-until-engineering-passes" | "executed-after-development"
	confirmationNotSelectedCells: number
	paidConfirmationCells: number
	rootControlCells: number
	deferredConfirmationReservationCells: number
	maximumCalls: number
	maximumTokens: number
	reservedSpendUsd: number
	rootSpendCeilingUsd: number
	priceDerivedSpendCeilingUsd: number
	rootPriceDerivedSpendCeilingUsd: number
	taskWallBoundMs: number
	developmentTaskIds: string[]
	confirmationTaskIds: string[]
}

function microsCeil(usd: number): number { return Math.ceil(usd * 1_000_000) }
function fromMicros(value: number): number { return value / 1_000_000 }

function worstTaskTokens(task: BenchmarkTask, limits: ProofRoleLimits): number {
	return Math.min(limits.maxTotalTokens, task.ceilings.maxCalls * (limits.maxInputTokensPerCall + task.ceilings.maxOutputTokensPerCall))
}

function worstJobPriceMicros(maxCalls: number, maxOutputTokens: number, limits: ProofRoleLimits): number {
	const inputPrice = limits.maxInputPricePerMillionUsd
	const outputPrice = limits.maxOutputPricePerMillionUsd
	const inputCapacity = maxCalls * limits.maxInputTokensPerCall
	const outputCapacity = maxCalls * maxOutputTokens
	let inputTokens: number
	let outputTokens: number
	if (inputPrice >= outputPrice) {
		inputTokens = Math.min(limits.maxTotalTokens, inputCapacity)
		outputTokens = Math.min(outputCapacity, Math.max(0, limits.maxTotalTokens - inputTokens))
	} else {
		outputTokens = Math.min(limits.maxTotalTokens, outputCapacity)
		inputTokens = Math.min(inputCapacity, Math.max(0, limits.maxTotalTokens - outputTokens))
	}
	return Math.ceil(inputTokens * inputPrice + outputTokens * outputPrice)
}

function assertPriceFeasible(label: string, calls: number, outputTokens: number, limits: ProofRoleLimits): number {
	const perJob = worstJobPriceMicros(calls, outputTokens, limits)
	const runtimeUnitPrice = Math.max(limits.maxInputPricePerMillionUsd, limits.maxOutputPricePerMillionUsd)
	const runtimePerCallTokens = Math.min(limits.maxTotalTokens, limits.maxInputTokensPerCall + outputTokens)
	const runtimeJobTokens = Math.min(limits.maxTotalTokens, calls * (limits.maxInputTokensPerCall + outputTokens))
	const runtimePerCall = Math.ceil(runtimePerCallTokens * runtimeUnitPrice)
	const runtimePerJob = Math.ceil(runtimeJobTokens * runtimeUnitPrice)
	if (runtimePerCall > limits.maxCallSpendUsd * 1_000_000) throw new Error(`${label} per-call spend cap is below the conservative runtime admission ceiling`)
	if (runtimePerJob / 1_000_000 > limits.maxJobSpendUsd) throw new Error(`${label} per-job spend cap is below the conservative runtime admission ceiling`)
	return perJob
}

export function planProofDemonstrationArm(args: {
	phase: "engineering" | "campaign"
	config: RsiConfig
	manifest: BenchmarkManifest
	mutationLimits: ProofRoleLimits
	benchmarkLimits: ProofRoleLimits
	generations: number
	population: number
}): ProofDemonstrationArmPlan {
	if (!Number.isSafeInteger(args.generations) || args.generations < 1 || !Number.isSafeInteger(args.population) || args.population < 1) throw new Error("proof plan generations and population must be positive integers")
	const development = args.manifest.tasks.filter((task) => task.split === "development")
	const confirmation = args.manifest.tasks.filter((task) => task.split === "confirmation")
	if (!development.length || !confirmation.length) throw new Error("proof plan requires development and confirmation task splits")
	const slotsPerArm = args.generations * args.population
	const candidateSlotsBothArms = 2 * slotsPerArm
	const mutationJobs = candidateSlotsBothArms
	const verificationJobs = candidateSlotsBothArms * (2 + args.config.evalCommands.length)
	const developmentProofCells = candidateSlotsBothArms * 3 * development.length
	const candidateConfirmationCells = candidateSlotsBothArms * confirmation.length
	const paidConfirmationCells = args.phase === "campaign" ? 2 * confirmation.length : 0
	const rootControlCells = args.phase === "campaign" ? 2 * confirmation.length : 0
	const deferredConfirmationReservationCells = 0
	const confirmationNotSelectedCells = args.phase === "campaign" ? candidateConfirmationCells - paidConfirmationCells : 0
	const confirmationScheduleCells = args.phase === "campaign" ? candidateConfirmationCells + 2 * confirmation.length : 0
	const mutationCalls = mutationJobs * args.mutationLimits.maxCalls
	const mutationTokensPerJob = Math.min(args.mutationLimits.maxTotalTokens, args.mutationLimits.maxCalls * (args.mutationLimits.maxInputTokensPerCall + args.mutationLimits.maxOutputTokensPerCall))
	const mutationPriceMicros = assertPriceFeasible("mutation", args.mutationLimits.maxCalls, args.mutationLimits.maxOutputTokensPerCall, args.mutationLimits)
	let maximumCalls = mutationCalls
	let maximumTokens = mutationJobs * mutationTokensPerJob
	let reservedSpendMicros = mutationJobs * microsCeil(args.mutationLimits.maxJobSpendUsd)
	let priceDerivedSpendMicros = mutationJobs * mutationPriceMicros
	let rootSpendMicros = reservedSpendMicros
	let rootPriceSpendMicros = priceDerivedSpendMicros
	const proofRoles = candidateSlotsBothArms * 3
	const taskCalls = (task: BenchmarkTask) => task.ceilings.maxCalls
	const taskPrice = (task: BenchmarkTask) => assertPriceFeasible(`benchmark task ${task.id}`, task.ceilings.maxCalls, task.ceilings.maxOutputTokensPerCall, args.benchmarkLimits)
	const devCallsPerRole = development.reduce((sum, task) => sum + taskCalls(task), 0)
	const devTokensPerRole = development.reduce((sum, task) => sum + worstTaskTokens(task, args.benchmarkLimits), 0)
	const devPriceMicrosPerRole = development.reduce((sum, task) => sum + taskPrice(task), 0)
	maximumCalls += proofRoles * devCallsPerRole
	maximumTokens += proofRoles * devTokensPerRole
	reservedSpendMicros += developmentProofCells * microsCeil(args.benchmarkLimits.maxJobSpendUsd)
	priceDerivedSpendMicros += proofRoles * devPriceMicrosPerRole
	rootSpendMicros = reservedSpendMicros
	rootPriceSpendMicros = priceDerivedSpendMicros
	if (args.phase === "campaign") {
		const finalAndRoot = 4 // selected final and root control, in both arms
		const confirmationCalls = confirmation.reduce((sum, task) => sum + taskCalls(task), 0) * finalAndRoot
		const confirmationTokens = confirmation.reduce((sum, task) => sum + worstTaskTokens(task, args.benchmarkLimits), 0) * finalAndRoot
		const confirmationPrice = confirmation.reduce((sum, task) => sum + taskPrice(task), 0) * finalAndRoot
		maximumCalls += confirmationCalls
		maximumTokens += confirmationTokens
		reservedSpendMicros += paidConfirmationCells + rootControlCells ? (paidConfirmationCells + rootControlCells) * microsCeil(args.benchmarkLimits.maxJobSpendUsd) : 0
		priceDerivedSpendMicros += confirmationPrice
		rootSpendMicros = reservedSpendMicros
		rootPriceSpendMicros = priceDerivedSpendMicros
	}
	if (![maximumCalls, maximumTokens, reservedSpendMicros, rootSpendMicros, priceDerivedSpendMicros, rootPriceSpendMicros].every(Number.isSafeInteger)) throw new Error("proof plan exceeds safe integer accounting")
	const taskWallBoundMs = proofCampaignTaskWallBoundMs(args.config, args.generations, development, confirmation, args.phase === "campaign")
	return {
		phase: args.phase, generations: args.generations, population: args.population,
		mutationJobs, verificationJobs, developmentProofCells, confirmationScheduleCells,
		confirmationDisposition: args.phase === "campaign" ? "executed-after-development" : "not-frozen-until-engineering-passes",
		confirmationNotSelectedCells, paidConfirmationCells, rootControlCells, deferredConfirmationReservationCells,
		maximumCalls, maximumTokens, reservedSpendUsd: fromMicros(reservedSpendMicros),
		rootSpendCeilingUsd: fromMicros(rootSpendMicros), priceDerivedSpendCeilingUsd: fromMicros(priceDerivedSpendMicros),
		rootPriceDerivedSpendCeilingUsd: fromMicros(rootPriceSpendMicros), taskWallBoundMs,
		developmentTaskIds: development.map((task) => task.id), confirmationTaskIds: args.phase === "campaign" ? confirmation.map((task) => task.id) : [],
	}
}

export function planProofDemonstration(args: {
	config: RsiConfig
	manifest: BenchmarkManifest
	mutationLimits: ProofRoleLimits
	benchmarkLimits: ProofRoleLimits
}): ProofDemonstrationPlan {
	const engineering = planProofDemonstrationArm({ ...args, phase: "engineering", generations: 2, population: 2 })
	const campaign = planProofDemonstrationArm({ ...args, phase: "campaign", generations: 3, population: 2 })
	return {
		engineering, campaign,
		totalReservedSpendUsd: fromMicros(microsCeil(engineering.reservedSpendUsd) + 3 * microsCeil(campaign.reservedSpendUsd)),
		engineeringRootSpendCeilingUsd: fromMicros(microsCeil(engineering.rootSpendCeilingUsd)),
		campaignRootsSpendCeilingUsd: fromMicros(3 * microsCeil(campaign.rootSpendCeilingUsd)),
		totalRootSpendCeilingUsd: fromMicros(microsCeil(engineering.rootSpendCeilingUsd) + 3 * microsCeil(campaign.rootSpendCeilingUsd)),
		totalPriceDerivedSpendCeilingUsd: fromMicros(microsCeil(engineering.priceDerivedSpendCeilingUsd) + 3 * microsCeil(campaign.priceDerivedSpendCeilingUsd)),
		totalRootPriceDerivedSpendCeilingUsd: fromMicros(microsCeil(engineering.rootPriceDerivedSpendCeilingUsd) + 3 * microsCeil(campaign.rootPriceDerivedSpendCeilingUsd)),
		totalCalls: engineering.maximumCalls + 3 * campaign.maximumCalls,
		totalTokens: engineering.maximumTokens + 3 * campaign.maximumTokens,
		totalTaskWallMs: engineering.taskWallBoundMs + 3 * campaign.taskWallBoundMs,
	}
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
		.map(([key, item]) => [key, canonical(item)]))
	return value
}

export function assertFrozenProofDemonstrationPlanMatches(frozen: ProofDemonstrationPlan, args: Parameters<typeof planProofDemonstration>[0]): void {
	const recomputed = planProofDemonstration(args)
	if (JSON.stringify(canonical(frozen)) !== JSON.stringify(canonical(recomputed))) throw new Error("frozen proof budget plan differs from the recomputed schedule and resource ceilings")
}
