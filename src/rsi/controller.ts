import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { appendRun, checkpointRun as archiveCheckpointRun, findActiveRun, findRun, readArchive } from "./archive.js"
import { parseRsiArgs, rsiHelp } from "./config.js"
import { generateCurriculumProposals, validateCurriculumProposals, writeCurriculumProposals } from "./curriculum.js"
import { evaluateCandidate } from "./evaluator.js"
import { computeFitness, compareFitness, comparePairedEvaluation } from "./fitness.js"
import { baseModelCandidate, createCombination } from "./models.js"
import { runMutation } from "./mutation.js"
import { formatRunReport } from "./reports.js"
import { mutationSnapshotProtectedPathViolations, protectedPathViolations } from "./sandbox.js"
import { resolveRoles } from "./roles.js"
import { newExperimentJob, paretoFront, selectParentChoices, transitionJob } from "./selection.js"
import { captureCandidateTrajectory, exportTrajectoryDatasets } from "./trajectory.js"
import { decideAdaptiveContinuation } from "./adaptive.js"
import { createOpenShellCommandRunner, resolveRsiEvaluatorRuntimeIdentity } from "./openshell.js"
import type { EvaluatorRuntimeIdentity } from "./evaluator-runtime.js"
import { adversarialEvaluationArtifactIdentity, createAdversarialEvaluationSnapshotBundle, createEvaluationSnapshotBundle, createMutationSnapshotBundle, createMutationSnapshotIdentity, applyFleetMutationPatch } from "./openshell.js"
import { ADVERSARIAL_COMMAND, ADVERSARIAL_PROMPT_VERSION, ADVERSARIAL_TESTS_PATH, buildAdversarialPrompt, parseAdversarialReview, requestAdversarialReview, sha256 } from "./adversarial.js"
import { fleetJobMatches, fleetPayloadDigest, PostgresRsiJobQueue, fleetQueuePolicy, requiredFleetJobLeaseMs, type FleetJob, type FleetJobIdentity, type FleetJobPayload } from "./postgres-queue.js"
import type { AdversarialReviewRecord, CandidateRecord, EvaluationSummary, ExperimentJob, RsiArchive, RsiConfig, RsiHooks, RsiRunRecord, TrajectoryRecord, TrialResult, WorkerHarnessExecution } from "./types.js"
import {
	candidateCommits,
	changedFiles,
	createCandidateWorktree,
	newCandidate,
	removeCandidateWorktree,
	resolveBaseCommit,
} from "./workspace.js"
import { loadBenchmark } from "./benchmark/runner.js"
import { openRouterAllocatedEnvironment, openRouterBrokerLimitsFromEnvironment, openRouterCampaignBudgetAllocation, openRouterProfileForModel, RSI_DEFAULT_OPENROUTER_PROFILE_ID } from "./inference-broker.js"
import type { OpenRouterDenialSummary, OpenRouterEndpointPriceSnapshot } from "./inference-broker.js"
import { candidateProofDecision, compareDevelopmentAttempts, developmentCells, freezeDevelopmentProofProtocol } from "./development-proof.js"
import type { DevelopmentTaskCell } from "./development-proof.js"
import type { BenchmarkAttempt } from "./benchmark/types.js"
import type { BenchmarkManifest } from "./benchmark/types.js"
import { runDevelopmentBenchmarkForCommit } from "./development-benchmark.js"
import { workerHarnessConfigDigest, workerHarnessRuntimeIdentityFromEnvironment, validWorkerHarnessRuntimeIdentity, effectiveWorkerHarnessMode } from "./worker-harness.js"
import { workerHarnessCliPath } from "./worker-harness.js"
import { PostgresProofCampaign, proofCampaignManifestDigest, type ProofCampaignArmLease, type ProofCampaignManifest } from "./proof-campaign.js"
import { runProofConfirmation } from "./proof-confirmation.js"
import { loadHiddenVerifierConfig } from "./hidden-config.js"
import { createOpenShellHiddenCaseRunner } from "./hidden-openshell-runner.js"
import type { HiddenEvaluationOptions } from "./evaluator.js"
import { canonicalJson, evaluatorBaseTreeIdentity, evaluatorGenerationDecisionDigest, evaluatorIntegrityDigest, evaluatorSourceIdentity, hasEvaluatorIntegrityManifests, loadEvaluatorIntegrityTrust, readEvaluatorIntegrityManifest, signEvaluatorIntegrity, verifyEvaluatorIntegrity, writeEvaluatorIntegrityManifest } from "./evaluation-integrity.js"
import type { EvaluatorIntegrityPayload, EvaluatorIntegrityTrust } from "./evaluation-integrity.js"

function log(hooks: RsiHooks, line: string): void {
	(hooks.log ?? ((message) => process.stdout.write(`${message}\n`)))(line)
}

type IntegrityOutput = NonNullable<RsiRunRecord["evaluatorIntegrity"]>["outputs"][number]

function trialOutputRecords(candidateId: string, taskId: string, trial: TrialResult): IntegrityOutput[] {
	return [{
		candidateId,
		taskId,
		outputSha256: evaluatorIntegrityDigest({ command: trial.command, exitCode: trial.exitCode, stdout: trial.stdout, stderr: trial.stderr, timedOut: trial.timedOut ?? false }),
		...(trial.outputArtifactSha256 ? { artifactSha256: trial.outputArtifactSha256, artifactBytes: trial.outputArtifactBytes } : {}),
	}]
}

function evaluationOutputRecords(candidateId: string, evaluation: EvaluationSummary): IntegrityOutput[] {
	const trials: Array<{ taskId: string; trial: TrialResult }> = [
		{ taskId: "regression", trial: evaluation.regression },
		...(evaluation.typecheck ? [{ taskId: "typecheck", trial: evaluation.typecheck }] : []),
		...evaluation.visible.map((trial, index) => ({ taskId: `visible-${index}`, trial })),
		...evaluation.hidden.map((trial, index) => ({ taskId: `hidden-${index}`, trial })),
	]
	return trials.flatMap(({ taskId, trial }) => trialOutputRecords(candidateId, taskId, trial))
}

function adversarialOutputRecords(review: AdversarialReviewRecord): IntegrityOutput[] {
	const refs: Array<[string, string | undefined]> = [
		["prompt", review.promptArtifactSha256], ["result", review.resultArtifactSha256],
		["error", review.errorArtifactSha256], ["tests", review.testArtifactSha256],
		["snapshot", review.snapshotArtifactSha256],
		...review.testResults.map((test, index): [string, string | undefined] => [`test-output-${index}`, test.outputArtifactSha256]),
	]
	return refs.filter((entry): entry is [string, string] => !!entry[1]).map(([taskId, artifactSha256]) => ({
		candidateId: review.candidateId,
		taskId: `adversarial-${taskId}`,
		outputSha256: artifactSha256,
		artifactSha256,
	}))
}

function verifyArchivedIntegrityOutputs(run: RsiRunRecord, signedOutputs: IntegrityOutput[]): void {
	const expected: IntegrityOutput[] = []
	if (run.baselineEvaluation) expected.push(...evaluationOutputRecords("baseline", run.baselineEvaluation))
	for (const candidate of run.candidates) {
		if (candidate.result) expected.push(...trialOutputRecords(candidate.id, "regression", candidate.result))
	}
	for (const review of run.adversarialReviews ?? []) expected.push(...adversarialOutputRecords(review))
	const signed = new Map(signedOutputs.map((entry) => [`${entry.candidateId}\0${entry.taskId}`, entry]))
	for (const output of expected) {
		const recorded = signed.get(`${output.candidateId}\0${output.taskId}`)
		if (!recorded || canonicalJson(recorded) !== canonicalJson(output)) throw new Error(`archived evaluator output differs from signed identity: ${output.candidateId}/${output.taskId}`)
	}
	for (const output of signedOutputs) {
		if (output.candidateId === "baseline" && !run.baselineEvaluation) throw new Error("signed baseline evaluator outputs are missing from the RSI archive")
		if (output.candidateId !== "baseline" && output.taskId === "regression" && !run.candidates.some((candidate) => candidate.id === output.candidateId && candidate.result)) {
			throw new Error(`signed regression output is missing from the RSI archive: ${output.candidateId}`)
		}
	}
}

function mergeIntegrityOutputs(record: NonNullable<RsiRunRecord["evaluatorIntegrity"]>, outputs: IntegrityOutput[]): void {
	const byTask = new Map(record.outputs.map((entry) => [`${entry.candidateId}\0${entry.taskId}`, entry]))
	for (const output of outputs) {
		const key = `${output.candidateId}\0${output.taskId}`
		const existing = byTask.get(key)
		if (existing && canonicalJson(existing) !== canonicalJson(output)) throw new Error(`evaluator output identity changed for ${output.candidateId}/${output.taskId}`)
		byTask.set(key, output)
	}
	record.outputs = [...byTask.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId) || left.taskId.localeCompare(right.taskId))
}

function evaluatorArchiveStateDigest(run: RsiRunRecord): string {
	const state = JSON.parse(JSON.stringify({
		baselineEvaluation: run.baselineEvaluation ?? null,
		baselineFitness: run.baselineFitness ?? null,
		candidates: run.candidates,
		adversarialReviews: run.adversarialReviews ?? [],
		selected: run.selected ?? null,
		selectedCandidates: run.selectedCandidates ?? [],
	})) as Record<string, unknown>
	return evaluatorIntegrityDigest(state)
}

async function verifyIntegrityArtifacts(queue: PostgresRsiJobQueue | undefined, outputs: IntegrityOutput[]): Promise<void> {
	const references = outputs.filter((entry) => entry.artifactSha256)
	if (references.length > 0 && !queue) throw new Error("evaluator integrity artifact verification requires the configured RSI artifact store")
	for (const reference of references) {
		const bytes = await queue!.getArtifact(reference.artifactSha256!)
		if (createHash("sha256").update(bytes).digest("hex") !== reference.artifactSha256 || reference.artifactBytes !== undefined && bytes.byteLength !== reference.artifactBytes) {
			throw new Error(`evaluator output artifact differs from its signed identity: ${reference.candidateId}/${reference.taskId}`)
		}
	}
}

async function persistEvaluatorIntegrity(
	config: RsiConfig,
	run: RsiRunRecord,
	trust: EvaluatorIntegrityTrust | undefined,
	input: Record<string, unknown>,
): Promise<void> {
	const record = run.evaluatorIntegrity
	if (!record) throw new Error("evaluator integrity record was not initialized")
	if (!trust) {
		record.status = "unsealed"
		return
	}
	const payload: EvaluatorIntegrityPayload = {
		schemaVersion: 1,
		runId: run.runId,
		input,
		inputSha256: evaluatorIntegrityDigest(input),
		archiveStateSha256: evaluatorArchiveStateDigest(run),
		outputs: record.outputs,
		generations: record.generations,
		...(record.selectedCandidateId ? { selectedCandidateId: record.selectedCandidateId } : {}),
	}
	const saved = await writeEvaluatorIntegrityManifest(config.archiveDir, run.runId, signEvaluatorIntegrity(trust, payload))
	record.status = "sealed"
	record.keyId = trust.keyId
	record.inputSha256 = payload.inputSha256
	record.archiveStateSha256 = payload.archiveStateSha256
	record.manifestPath = saved.path
	record.manifestSha256 = saved.sha256
}

async function verifyResumedEvaluatorIntegrity(
	config: RsiConfig,
	run: RsiRunRecord,
	trust: EvaluatorIntegrityTrust | undefined,
	input: Record<string, unknown>,
	attested: boolean,
): Promise<void> {
	const existing = run.evaluatorIntegrity
	const hasSealArtifacts = await hasEvaluatorIntegrityManifests(config.archiveDir, run.runId)
	if ((!existing || existing.status !== "sealed") && hasSealArtifacts) throw new Error("evaluator integrity seal artifacts exist but archive metadata is missing or downgraded; refusing unsealed resume")
	if (!existing) {
		if (attested) throw new Error("attested RSI resume requires a signed evaluator integrity manifest; this historical run is unsealed")
		if (trust) throw new Error("cannot retroactively seal a historical RSI run; start a new run with evaluator integrity trust configured")
		return
	}
	const currentInputSha256 = evaluatorIntegrityDigest(input)
	if (existing.status === "sealed") {
		if (!trust) throw new Error("sealed RSI run cannot resume without its independently pinned evaluator integrity trust")
		if (!existing.manifestSha256 || existing.manifestPath !== path.posix.join("evaluator-integrity", `${run.runId}.${existing.manifestSha256}.json`)) throw new Error("evaluator integrity manifest pointer is malformed")
		const saved = await readEvaluatorIntegrityManifest(config.archiveDir, run.runId, existing.manifestSha256)
		if (saved.sha256 !== existing.manifestSha256) throw new Error("evaluator integrity manifest bytes changed since the run was checkpointed")
		const envelope = verifyEvaluatorIntegrity(trust, saved.envelope)
		const payload = envelope.payload as Partial<EvaluatorIntegrityPayload>
		if (payload.schemaVersion !== 1 || payload.runId !== run.runId || payload.inputSha256 !== currentInputSha256 || canonicalJson(payload.input) !== canonicalJson(input)) throw new Error("evaluator source, base tree, configuration, commands, or inputs changed since the signed RSI snapshot")
		if (payload.archiveStateSha256 !== evaluatorArchiveStateDigest(run) || existing.archiveStateSha256 !== payload.archiveStateSha256) throw new Error("archived evaluator state changed since its last signed checkpoint")
		if (canonicalJson(payload.outputs) !== canonicalJson(existing.outputs) || canonicalJson(payload.generations) !== canonicalJson(existing.generations) || payload.selectedCandidateId !== existing.selectedCandidateId) throw new Error("signed evaluator outputs or selection differ from the RSI archive checkpoint")
		if (existing.keyId !== trust.keyId || existing.inputSha256 !== currentInputSha256) throw new Error("evaluator integrity trust or manifest identity differs from the frozen run identity")
		verifyArchivedIntegrityOutputs(run, existing.outputs)
		for (const generation of existing.generations) {
			const generationCandidates = run.candidates.filter((candidate) => candidate.generation === generation.generation)
			const accepted = generationCandidates.filter((candidate) => candidate.status === "accepted")
			const expectedSelectedIds = paretoFront(accepted).map((candidate) => candidate.id)
			const expectedSelected = [...accepted].sort((left, right) => compareFitness(right.fitness, left.fitness))[0]?.id
			const reviews = (run.adversarialReviews ?? []).filter((review) => generationCandidates.some((candidate) => candidate.id === review.candidateId))
			if (canonicalJson(generation.selectedCandidateIds) !== canonicalJson(expectedSelectedIds) || generation.selectedCandidateId !== expectedSelected ||
				generation.decisionsSha256 !== evaluatorGenerationDecisionDigest(generationCandidates, reviews, expectedSelected)) {
				throw new Error(`archived evaluator decisions differ from the signed selection for generation ${generation.generation}`)
			}
		}
		const latestGeneration = existing.generations.at(-1)
		if ((latestGeneration && canonicalJson(latestGeneration.selectedCandidateIds) !== canonicalJson(run.selectedCandidates ?? [])) || existing.selectedCandidateId !== run.selected) throw new Error("selected candidates differ from the signed evaluator selection")
		return
	}
	if (trust) throw new Error("cannot retroactively seal an unsealed RSI run; start a new run with evaluator integrity trust configured")
	if (attested) throw new Error("attested RSI resume requires an independently signed evaluator integrity manifest")
}

function isTerminal(candidate: CandidateRecord): boolean {
	return candidate.status === "accepted" || candidate.status === "rejected" || candidate.status === "failed"
}

function proofCandidateSlot(generation: number, index: number): string { return `g${generation}-candidate-${index}` }
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
		analysisVersion: args.proofProtocol.schemaVersion.toString(), settings: { phaseMode: engineeringOnly ? "engineering-only" : "paired-confirmation", configDigest: workerHarnessConfigDigest(args.config, { baseCommit: args.baseCommit, model: args.model, provider: args.provider, proofProtocolDigest: args.proofProtocol.protocolDigest }), effectiveConfig: Object.fromEntries(Object.entries(args.config).filter(([key]) => !["workerHarnessMode", "workerHarnessPhase", "workerHarnessEngineeringOnly", "workerHarnessPairId", "workerHarnessRunId", "resumeRunId", "candidateIdNamespace", "workerHarnessParentCommit", "workerHarnessSnapshotTreeDigest", "hiddenSuitePath", "hiddenPublicKeyPath", "hiddenPrivateKeyPath", "hiddenNonceStorePath", "evaluatorSigningKeyPath", "evaluatorTrustedPublicKeyPath"].includes(key))), candidateCounts, taskWallBoundMs, evaluationCells: ["regression", "typecheck", ...args.config.evalCommands.map((_, index) => `visible-${index}`)], developmentTaskIdentities: benchmarkTasks.map((task) => ({ id: task.id, family: task.family, seed: task.seed, startDigest: task.startDigest, verifierDigest: task.verifierDigest, ceilings: task.ceilings })), confirmationTaskIdentities: engineeringOnly ? [] : confirmationTasks.map((task) => ({ id: task.id, family: task.family, seed: task.seed, startDigest: task.startDigest, verifierDigest: task.verifierDigest, ceilings: task.ceilings })), inferenceCeilings: { maxInputTokensPerCall: benchmarkLimits.maxInputTokensPerCall, maxOutputTokensPerCall: benchmarkLimits.maxOutputTokensPerCall, maxCallsPerAttempt: benchmarkLimits.maxCalls, maxTotalTokens: benchmarkLimits.maxTotalTokens, maxCallSpendUsd: benchmarkLimits.maxCallSpendUsd, maxJobSpendUsd: benchmarkLimits.maxJobSpendUsd, maxInputPricePerMillionUsd: benchmarkLimits.maxInputPricePerMillionUsd, maxOutputPricePerMillionUsd: benchmarkLimits.maxOutputPricePerMillionUsd }, inferenceCampaignIds: { mutation: mutationCampaignId, benchmark: benchmarkCampaignId }, inferenceAllocationsUsd: { mutation: mutationLimits.maxCampaignSpendUsd, benchmark: benchmarkLimits.maxCampaignSpendUsd } },
	}
}

export function proofBrokerCampaignId(rootCampaignId: string, allocation: "mutation" | "benchmark"): string {
	if (!rootCampaignId.trim()) throw new Error("proof campaign ID is required to derive broker campaign identity")
	return `${rootCampaignId}:${allocation}`
}

export async function reconcileProofCampaignJob(queue: PostgresRsiJobQueue, existing: FleetJob | undefined, expected: FleetJobIdentity, lease: ProofCampaignArmLease): Promise<FleetJob | undefined> {
	if (!existing || fleetJobMatches(existing, expected)) return existing
	if (existing.status === "queued") {
		const rebound = await queue.rebindQueuedProofJob(existing.jobId, expected, lease)
		if (fleetJobMatches(rebound, expected)) return rebound
	}
	throw new Error("existing proof campaign job is not the same completed result or a safely rebindable queued job")
}

export async function rebuildFinishedProofCampaignArchive(args: {
	run: RsiRunRecord
	config: RsiConfig
	snapshot: Record<string, unknown>
	manifest: ProofCampaignManifest
	armId: string
	now: () => string
}): Promise<RsiRunRecord> {
	const campaign = args.snapshot.campaign as Record<string, unknown> | undefined
	const arms = args.snapshot.arms as Array<Record<string, unknown>> | undefined
	const arm = arms?.find((entry) => entry.arm_id === args.armId)
	const expectedDigest = proofCampaignManifestDigest(args.manifest)
	if (!campaign || !arm || arm.state !== "finished" || String(campaign.manifest_sha256).trim() !== expectedDigest) throw new Error("finished proof campaign snapshot does not match the frozen manifest and arm")
	if (arm.run_id !== args.run.runId || args.run.candidates.some((candidate) => !isTerminal(candidate))) throw new Error("finished proof campaign arm cannot rebuild an incomplete or foreign run archive")
	if (args.manifest.phaseMode === "engineering-only") {
		const events = args.snapshot.events as Array<Record<string, unknown>> | undefined
		if (!events?.some((event) => event.arm_id === args.armId && event.event_type === "engineering-development-finished") || args.run.proofConfirmation || args.run.confirmationAttempts?.length) throw new Error("engineering-only recovery must have a terminal development event and no confirmation evidence")
	} else await verifyFinishedConfirmationCheckpoint(args.run, args.config.archiveDir, args.snapshot, args.manifest, args.armId)
	args.run.proofCampaign = { manifest: args.manifest, manifestSha256: expectedDigest, campaignId: args.manifest.campaignId, armId: args.armId, epoch: Number(arm.epoch), state: "finished", ledgerSnapshot: args.snapshot }
	const selections = (args.snapshot.events as Array<Record<string, unknown>>).filter((event) => event.arm_id === args.armId && event.event_type === "generation-selected").sort((left, right) => Number(left.sequence) - Number(right.sequence))
	const finalSelection = selections.at(-1)?.payload as { generation?: number; selectedCandidateIds?: string[] } | undefined
	if (finalSelection && Number.isSafeInteger(finalSelection.generation)) {
		args.run.selectedCandidates = (finalSelection.selectedCandidateIds ?? []).map((slot) => {
			const generationCandidates = args.run.candidates.filter((candidate) => candidate.generation === finalSelection.generation)
			const index = Number(/candidate-(\d+)$/.exec(slot)?.[1] ?? -1)
			return generationCandidates[index]?.id ?? ""
		}).filter(Boolean)
		args.run.selected ??= [...args.run.candidates.filter((candidate) => candidate.status === "accepted")].sort((a, b) => compareFitness(b.fitness, a.fitness))[0]?.id
	}
	args.run.finishedAt ??= args.now()
	const recoveredReportPath = `${args.config.archiveDir}/${args.run.runId}.md`
	await fs.mkdir(args.config.archiveDir, { recursive: true })
	await fs.writeFile(recoveredReportPath, formatRunReport(args.run, args.config), "utf8")
	args.run.reports = [...new Set([...args.run.reports, recoveredReportPath])]
	await appendRun(args.config.archiveDir, args.run)
	return args.run
}

async function verifyFinishedConfirmationCheckpoint(run: RsiRunRecord, archiveDir: string, snapshot: Record<string, unknown>, manifest: ProofCampaignManifest, armId: string): Promise<void> {
	const events = snapshot.events as Array<Record<string, unknown>> | undefined
	const attempts = snapshot.attempts as Array<Record<string, unknown>> | undefined
	const selection = events?.filter((event) => event.arm_id === armId && event.event_type === "final-harness-selected")
	const payload = selection?.length === 1 ? selection[0]!.payload as { generation?: number; candidateId?: string; commit?: string } : undefined
	const saved = run.proofConfirmation
	if (!payload || !saved || saved.selectedHarness.slotId !== payload.candidateId || saved.selectedHarness.generation !== payload.generation || saved.selectedHarness.commit !== payload.commit || saved.rootHarness.commit !== manifest.rootCommit || run.confirmationEvidence !== "complete") throw new Error("finished campaign recovery requires a matching checkpointed final-harness selection and confirmation result")
	const cells = manifest.schedule.filter((cell) => cell.armId === armId && cell.phase === "confirmation" && (cell.candidateId === "root-control" || (cell.candidateId === payload.candidateId && cell.generation === payload.generation)))
	const byCandidateKind = (candidateId: string, kind: string) => cells.filter((cell) => cell.candidateId === candidateId && cell.attemptKind === kind)
	const selectedRows = byCandidateKind(String(payload.candidateId), payload.candidateId === "root-control" ? "fixed-control" : "confirmation")
	const rootRows = byCandidateKind("root-control", "fixed-control")
	const rowFor = (cell: typeof cells[number]) => attempts?.filter((row) => row.arm_id === armId && Number(row.generation) === cell.generation && row.candidate_id === cell.candidateId && row.task_id === cell.taskId && row.seed === cell.seed && row.attempt_kind === cell.attemptKind && row.status === "completed") ?? []
	const expectedSelectedRows = selectedRows.flatMap((cell) => rowFor(cell))
	const expectedRootRows = rootRows.flatMap((cell) => rowFor(cell))
	const orderedIds = (rows: Array<Record<string, unknown>>) => rows.map((row) => String(row.broker_job_id)).sort()
	if (expectedSelectedRows.length !== selectedRows.length || expectedRootRows.length !== rootRows.length || JSON.stringify(orderedIds(expectedSelectedRows)) !== JSON.stringify([...saved.selectedHarness.attemptIds].sort()) || JSON.stringify(orderedIds(expectedRootRows)) !== JSON.stringify([...saved.rootHarness.attemptIds].sort())) throw new Error("finished campaign recovery checkpoint does not name the completed selected and root confirmation cells")
	const artifacts = new Map((run.confirmationAttempts ?? []).map((attempt) => [attempt.attemptId, attempt]))
	for (const row of [...expectedSelectedRows, ...expectedRootRows]) {
		const attemptId = String(row.broker_job_id)
		const attempt = artifacts.get(attemptId)
		const expectedProfile = attempt ? openRouterProfileForModel(attempt.model.id, run.proofCampaign?.manifest.model.profileId) : undefined
		const profileIdMatches = expectedProfile?.id === RSI_DEFAULT_OPENROUTER_PROFILE_ID ? attempt?.inferenceReceipt?.profileId === undefined || attempt?.inferenceReceipt?.profileId === expectedProfile.id : attempt?.inferenceReceipt?.profileId === expectedProfile?.id
		if (!attempt || attempt.validity !== "valid" || !attempt.proofQualified || attempt.resourceAccounting !== "supervisor-enforced" || !attempt.inferenceReceipt?.qualified || !profileIdMatches || attempt.inferenceReceipt.endpointProvider !== expectedProfile?.endpointProvider || attempt.inferenceReceipt.returnedProviders?.join(",") !== expectedProfile?.endpointProvider || createHash("sha256").update(JSON.stringify(attempt)).digest("hex") !== String(row.result_sha256).trim()) throw new Error(`finished campaign recovery attempt ${attemptId} does not match its verified durable result`)
		const storedRefs = row.artifact_refs as Record<string, { sha256?: string }> | undefined
		if (!storedRefs || Object.entries(attempt.artifactRefs).some(([name, digest]) => storedRefs[name]?.sha256 !== digest)) throw new Error(`finished campaign recovery attempt ${attemptId} has different artifact references`)
		const candidateId = String(row.candidate_id)
		const kind = String(row.attempt_kind)
		const outputRoot = path.join(archiveDir, "confirmation", manifest.campaignId, armId, candidateId, kind, "harness", attempt.harnessCommit)
		for (const digest of Object.values(attempt.artifactRefs)) {
			if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`finished campaign recovery attempt ${attemptId} has a malformed artifact digest`)
			const artifact = path.join(outputRoot, "artifacts", "sha256", digest.slice(0, 2), digest)
			const stat = await fs.lstat(artifact)
			if (!stat.isFile() || stat.isSymbolicLink() || createHash("sha256").update(await fs.readFile(artifact)).digest("hex") !== digest) throw new Error(`finished campaign recovery artifact ${digest} is missing or changed`)
		}
	}
}

/** Rebuild only the durable development-phase checkpoint after its DB commit. */
export async function rebuildEvaluatedProofCampaignArchive(args: {
	run: RsiRunRecord
	config: RsiConfig
	snapshot: Record<string, unknown>
	manifest: ProofCampaignManifest
	armId: string
	now: () => string
}): Promise<RsiRunRecord> {
	const campaign = args.snapshot.campaign as Record<string, unknown> | undefined
	const arms = args.snapshot.arms as Array<Record<string, unknown>> | undefined
	const events = args.snapshot.events as Array<Record<string, unknown>> | undefined
	const arm = arms?.find((entry) => entry.arm_id === args.armId)
	const expectedDigest = proofCampaignManifestDigest(args.manifest)
	const finishEvent = events?.some((event) => event.arm_id === args.armId && event.event_type === "development-phase-finished" && (event.payload as { remainingPhase?: unknown })?.remainingPhase === "confirmation")
	if (!campaign || !arm || !finishEvent || arm.phase !== "confirmation" || !["evaluated", "selected", "rejected"].includes(String(arm.state)) || String(campaign.manifest_sha256).trim() !== expectedDigest) throw new Error("evaluated proof campaign snapshot does not match the frozen manifest and development completion")
	if (arm.run_id !== args.run.runId || args.run.candidates.some((candidate) => !isTerminal(candidate))) throw new Error("evaluated proof campaign arm cannot rebuild from an incomplete or foreign run checkpoint")
	const expectedMode = args.armId === args.manifest.armAssignment.fixedControl ? "fixed-control" : "self-hosted"
	if (args.run.workerHarnessPairId !== args.manifest.campaignId || args.run.workerHarnessMode !== expectedMode) throw new Error("evaluated proof campaign checkpoint has a foreign paired-run identity")
	if (arm.lease_expires_at && new Date(String(arm.lease_expires_at)).getTime() > Date.now()) throw new Error("evaluated proof campaign arm has an active coordinator; refusing read-only recovery during confirmation work")
	args.run.proofCampaign = { manifest: args.manifest, manifestSha256: expectedDigest, campaignId: args.manifest.campaignId, armId: args.armId, epoch: Number(arm.epoch), state: "evaluated", ledgerSnapshot: args.snapshot }
	args.run.finishedAt ??= args.now()
	const reportPath = `${args.config.archiveDir}/${args.run.runId}.md`
	await fs.mkdir(args.config.archiveDir, { recursive: true })
	await fs.writeFile(reportPath, formatRunReport(args.run, args.config), "utf8")
	args.run.reports = [...new Set([...args.run.reports, reportPath])]
	await appendRun(args.config.archiveDir, args.run)
	return args.run
}

class CandidateLineageError extends Error {}

export function validateCandidateParent(candidate: CandidateRecord, run: RsiRunRecord, config: RsiConfig, protocol: NonNullable<RsiRunRecord["developmentProofProtocol"]>): void {
	if (candidate.parent === "baseline") {
		if (candidate.baseCommit !== run.baseCommit || candidate.parentCommit !== run.baseCommit) throw new CandidateLineageError("baseline child does not use the frozen run base commit")
		return
	}
	const parent = run.candidates.find((entry) => entry.id === candidate.parent)
	if (!parent || parent.status !== "accepted" || parent.developmentProof?.accepted !== true || parent.developmentProof.runId !== run.runId || parent.developmentProof.protocolDigest !== protocol.protocolDigest || !parent.fitness || Object.values(parent.fitness.hardGates).some((passed) => passed === false)) {
		throw new CandidateLineageError(`candidate parent ${candidate.parent} is missing, rejected, from another run/protocol, or fails hard gates`)
	}
	const parentCommit = parent.commits[0]
	if (!parentCommit || candidate.baseCommit !== parentCommit || candidate.parentCommit !== parentCommit) throw new CandidateLineageError(`candidate parent ${candidate.parent} commit does not match its mutation base`)
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", run.baseCommit, parentCommit], { cwd: config.repoRoot, stdio: "ignore" })
	} catch { throw new CandidateLineageError(`candidate parent ${candidate.parent} is outside the frozen run base lineage`) }
	const inheritedPaths = execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", run.baseCommit, parentCommit], { cwd: config.repoRoot, encoding: "buffer" }) as Buffer
	const violations = mutationSnapshotProtectedPathViolations(inheritedPaths.toString("utf8").split("\0").filter(Boolean), config.protectedPaths)
	if (violations.length > 0) throw new CandidateLineageError(`candidate parent ${candidate.parent} inherits protected path changes: ${violations.join(", ")}`)
}

function replaceJob(run: RsiRunRecord, job: ExperimentJob): void {
	run.jobs ??= []
	const index = run.jobs.findIndex((entry) => entry.id === job.id)
	if (index >= 0) run.jobs[index] = job
	else run.jobs.push(job)
}

function combinedArchive(archive: RsiArchive, run: RsiRunRecord): RsiArchive {
	const currentIds = new Set(run.candidates.map((candidate) => candidate.id))
	return { ...archive, candidates: [...archive.candidates.filter((candidate) => !currentIds.has(candidate.id)), ...run.candidates] }
}

function validateDeterministicWorkerHarnessRunId(config: RsiConfig): void {
	if (config.workerHarnessRunId) {
		const suffix = config.workerHarnessMode === "fixed-control" ? "fixed" : config.workerHarnessMode === "self-hosted" ? "self" : undefined
		if (!config.workerHarnessPairId || !suffix || config.workerHarnessRunId !== `${config.workerHarnessPairId}-${suffix}` || !/^rsi-proof-[a-f0-9]{20}-(fixed|self)$/.test(config.workerHarnessRunId)) throw new Error("deterministic worker harness run ID must match its paired campaign and arm")
	}
	}

function initialRun(config: RsiConfig, baseCommit: string, now: string): RsiRunRecord {
	const modelCandidateId = config.modelCandidateId ?? "model-base"
	validateDeterministicWorkerHarnessRunId(config)
	return {
		runId: config.workerHarnessRunId ?? `rsi-${now.replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
		startedAt: now,
		model: config.model,
		baseRef: config.baseRef,
		baseCommit,
		generations: config.generations,
		parentSelectionPolicy: config.parentSelectionPolicy ?? "champion-specialist-novelty",
		selectedCandidates: [],
		parentChoices: {},
		modelCandidates: [baseModelCandidate(config.model, now, modelCandidateId)],
		combinations: [],
		jobs: [],
		trajectoryRefs: [],
		curriculumTasks: [],
		adversarialReviews: [],
		candidates: [],
		reports: [],
		confirmationEvidence: "unmeasured",
	}
}

async function buildEvaluatorIntegrityInput(args: {
	config: RsiConfig
	run: RsiRunRecord
	packageRoot: string
	roles: RsiConfig["roles"]
	workerModel: string
	workerProvider: string
	workerOpenRouterProfile?: string
	proofProtocol: ReturnType<typeof freezeDevelopmentProofProtocol>
	benchmarkManifestSha256: string
	evaluatorRuntime?: EvaluatorRuntimeIdentity
	hiddenVerifierIdentity?: RsiRunRecord["hiddenVerifierIdentity"]
	syntheticRuntimeIdentity?: boolean
}): Promise<Record<string, unknown>> {
	const source = await evaluatorSourceIdentity(args.packageRoot)
	const baseTreeSha256 = evaluatorBaseTreeIdentity(args.config.repoRoot, args.run.baseCommit)
	const config = args.config
	return {
		schemaVersion: 1,
		runId: args.run.runId,
		baseCommit: args.run.baseCommit,
		baseTreeSha256,
		evaluatorSource: source,
		imageIdentity: {
			requestedImage: args.evaluatorRuntime ? `headlesscode-openshell-rsi@${args.evaluatorRuntime.imageDigest}` : null,
			pinnedImageDigest: args.evaluatorRuntime?.imageDigest ?? null,
			identitySource: args.evaluatorRuntime?.identitySource ?? "not-executed-dry-run",
			workerHarnessRuntime: args.run.workerHarnessRuntime ?? null,
			gatewayAlias: process.env.OPENSHELL_GATEWAY ?? null,
		},
		evaluatorIsolationPolicy: args.evaluatorRuntime ? { source: args.evaluatorRuntime.policySource, sha256: args.evaluatorRuntime.policySha256 } : null,
		storageAndWorkspace: {
			repository: path.resolve(config.repoRoot),
			archive: path.resolve(config.archiveDir),
			worktrees: path.resolve(config.worktreeDir),
			trajectoryOutput: path.resolve(config.trajectoryDir ?? path.join(config.archiveDir, "trajectories")),
			curriculumOutput: path.resolve(config.curriculumDir ?? path.join(config.archiveDir, "curriculum")),
		},
		commands: {
			regression: config.regressionCommand,
			visible: [...config.evalCommands],
			hidden: [...config.hiddenEvalCommands],
		},
		effectiveArguments: {
			baseRef: config.baseRef,
			model: args.workerModel,
			provider: args.workerProvider,
			openRouterProfile: args.workerOpenRouterProfile ?? null,
			roles: args.roles ?? null,
			population: config.population,
			generations: args.run.generations,
			maxConcurrent: config.maxConcurrent,
			maxIterations: config.maxIterations,
			maxTokens: config.maxTokens ?? null,
			commandTimeoutMs: config.commandTimeoutMs,
			computePolicy: config.computePolicy ?? "single",
			maxTrajectories: config.maxTrajectories ?? null,
			maxTotalIterations: config.maxTotalIterations ?? null,
			maxRuntimeMs: config.maxRuntimeMs ?? null,
			seed: config.seed,
			mutationTask: config.mutationTask,
			mutationKind: config.mutationKind ?? "corrective",
			hypothesis: config.hypothesis ?? null,
			protectedPaths: [...config.protectedPaths].sort(),
			parentSelectionPolicy: config.parentSelectionPolicy ?? "champion-specialist-novelty",
			developmentProofRule: config.developmentProofRule ?? null,
			developmentProofProtocolSha256: args.proofProtocol.protocolDigest,
			workerHarness: {
				mode: args.run.workerHarnessMode ?? "fixed-control",
				pairId: args.run.workerHarnessPairId ?? null,
				configDigest: args.run.workerHarnessConfigDigest ?? null,
				plannedGenerations: args.run.workerHarnessPlannedGenerations ?? null,
				phase: config.workerHarnessPhase ?? null,
				engineeringOnly: config.workerHarnessEngineeringOnly ?? false,
			},
		},
		inputArtifacts: [
			{ id: "development-benchmark-manifest", sha256: args.benchmarkManifestSha256 },
			...(args.hiddenVerifierIdentity ? [{ id: "hidden-verifier-suite", sha256: args.hiddenVerifierIdentity.suiteSha256 }, { id: "hidden-verifier-public-key", sha256: args.hiddenVerifierIdentity.publicKeySha256 }, { id: "hidden-verifier-image", sha256: args.hiddenVerifierIdentity.imageDigest }] : []),
		],
	}
}

async function waitForFleetJob(queue: PostgresRsiJobQueue, jobId: string, timeoutMs: number, runtimeDeadlineMs?: number): Promise<FleetJob> {
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

function fleetRuntimeDeadlineMs(config: RsiConfig, run: RsiRunRecord): number | undefined {
	return config.maxRuntimeMs === undefined ? undefined : Date.parse(run.startedAt) + config.maxRuntimeMs
}

function fleetPayload(config: RsiConfig, candidate: CandidateRecord, snapshot: { content: Buffer; snapshotCommit: string; snapshotTreeDigest?: string }, options: { campaignId?: string; boundedInference?: boolean; includeWorkerHarness?: boolean; proofCampaign?: FleetJobPayload["proofCampaign"]; remainingCampaignMs?: number; evaluatorRuntime?: Pick<EvaluatorRuntimeIdentity, "imageDigest" | "policySha256"> } = {}): FleetJobPayload {
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

function recordFleetInferenceUsage(candidate: CandidateRecord, resultValue: unknown, payload: FleetJobPayload, jobId: string): void {
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

function recordFleetInferenceDenials(candidate: CandidateRecord, resultValue: unknown, payload: FleetJobPayload, jobId: string): void {
	if (payload.provider !== "openrouter" || !resultValue || typeof resultValue !== "object") return
	const result = resultValue as { provider?: unknown; model?: unknown; inferenceAudit?: { accounting?: unknown; jobId?: unknown; denials?: unknown } }
	const audit = result.inferenceAudit
	if (result.provider !== "openrouter" || result.model !== payload.model || audit?.accounting !== "incomplete" || audit.jobId !== jobId || !Array.isArray(audit.denials)) return
	const denials = audit.denials as OpenRouterDenialSummary[]
	if (!denials.every((entry) => entry && typeof entry === "object" && Number.isSafeInteger(entry.statusCode) && entry.statusCode >= 400 && entry.statusCode <= 599 && Number.isSafeInteger(entry.count) && entry.count >= 1 && /^[a-z-]+$/.test(entry.reason))) return
	candidate.inferenceDenials = structuredClone(denials)
}

function fleetEvaluationResult(value: unknown): { regression: TrialResult; typecheck: TrialResult; visible: TrialResult[] } {
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

function fleetWorkerHarnessExecution(value: unknown, expected: FleetJobPayload): WorkerHarnessExecution | undefined {
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

function validateCandidateWorkerHarnessExecution(candidate: CandidateRecord, run: RsiRunRecord, config: RsiConfig, execution?: WorkerHarnessExecution): void {
	if (!config.workerHarnessMode) return
	const expectedMode = effectiveWorkerHarnessMode(config.workerHarnessMode, candidate.generation)
	if (!execution || execution.mode !== expectedMode || execution.parentCommit !== candidate.baseCommit
		|| execution.executedCliPath !== workerHarnessCliPath(expectedMode)
		|| !/^[a-f0-9]{64}$/.test(execution.snapshotTreeDigest)
		|| !/^[a-f0-9]{40}$/.test(execution.snapshotCommit)
		|| JSON.stringify(execution.runtime) !== JSON.stringify(run.workerHarnessRuntime)) throw new Error("mutation result lacks the frozen worker harness execution identity")
	candidate.workerHarnessExecution = execution
}

async function validateCurriculumOnFleet(
	tasks: RsiRunRecord["curriculumTasks"],
	config: RsiConfig,
	run: RsiRunRecord,
	queue: PostgresRsiJobQueue,
	now: () => string,
	evaluatorRuntime: Pick<EvaluatorRuntimeIdentity, "imageDigest" | "policySha256">,
): Promise<NonNullable<RsiRunRecord["curriculumTasks"]>> {
	if (!tasks?.length) return []
	return validateCurriculumProposals(tasks, run.baseCommit, async (task, attempt, replayKey) => {
		const replayCandidate: CandidateRecord = {
			id: `${task.fixtureId}-replay-${attempt}`,
			generation: 0,
			parent: run.baseCommit,
			branch: `curriculum-${task.fixtureId}`,
			worktree: config.repoRoot,
			baseCommit: run.baseCommit,
			status: "evaluating",
			model: config.model,
			mutation: task.task,
			createdAt: now(),
			updatedAt: now(),
			commits: [],
			changedFiles: [],
			protectedPathViolations: [],
		}
		const idempotencyKey = `${run.runId}:${replayKey}`
		const snapshot = createEvaluationSnapshotBundle(config.repoRoot, run.baseCommit, config)
		const artifact = await queue.putArtifact(snapshot.content)
		const payload = fleetPayload(config, replayCandidate, snapshot, { evaluatorRuntime })
		payload.snapshotSha256 = artifact.sha256
		payload.task = `Replay registered curriculum fixture ${task.fixtureId}`
		payload.regressionCommand = "true"
		payload.evalCommands = [task.groundTruthCommand]
		const expected = {
			idempotencyKey,
			runId: run.runId,
			candidateId: replayCandidate.id,
			jobKind: "evaluation" as const,
			resourceClass: "CPU" as const,
			concurrencyKey: `curriculum:${task.fixtureId}`,
			artifactSha256: artifact.sha256,
			payload,
		}
		let job = await queue.getJobByIdempotencyKey(idempotencyKey)
		if (!job) {
			job = await queue.enqueue({
				idempotencyKey,
				runId: run.runId,
				candidateId: replayCandidate.id,
				jobKind: "evaluation",
				resourceClass: "CPU",
				concurrencyKey: expected.concurrencyKey,
				artifactSha256: artifact.sha256,
				payload,
			})
		}
		if (!fleetJobMatches(job, expected)) return { ok: false, exitCode: null, failure: "idempotent curriculum replay key refers to a stale or mismatched fleet job payload" }
		const completed = await waitForFleetJob(queue, job.jobId, requiredFleetJobLeaseMs("evaluation", config.commandTimeoutMs, 1) + 60_000, fleetRuntimeDeadlineMs(config, run))
		if (completed.status !== "completed" || !completed.result || typeof completed.result !== "object") return { ok: false, exitCode: null, failure: completed.error ?? `OpenShell curriculum replay ended ${completed.status}` }
		try {
			const evaluation = fleetEvaluationResult(completed.result)
			const trial = evaluation.visible[0]
			if (!trial) return { ok: false, exitCode: null, failure: "OpenShell curriculum replay returned no fixture trial" }
			return {
				ok: trial.ok,
				exitCode: trial.exitCode,
				outputSha256: trial.outputArtifactSha256,
				...(!trial.ok ? { failure: `fixture command exited ${trial.exitCode ?? "unknown"}` } : {}),
			}
		} catch (error) {
			return { ok: false, exitCode: null, failure: error instanceof Error ? error.message : String(error) }
		}
	}, now())
}

async function runAdversarialStage(
	candidate: CandidateRecord,
	evaluation: { regression: TrialResult; visible: TrialResult[] },
	config: RsiConfig,
	run: RsiRunRecord,
	queue: PostgresRsiJobQueue,
	hooks: RsiHooks,
	now: () => string,
	evaluatorRuntime: Pick<EvaluatorRuntimeIdentity, "imageDigest" | "policySha256">,
): Promise<AdversarialReviewRecord> {
	const role = config.roles?.adversary
	if (!role) throw new Error("adversary role is not configured")
	const base: AdversarialReviewRecord = {
		candidateId: candidate.id, role: "adversary", provider: role.provider, model: role.model,
		promptVersion: ADVERSARIAL_PROMPT_VERSION, promptSha256: "", promptArtifactSha256: "",
		createdAt: now(), status: "error", findings: [], testResults: [], penaltyPoints: 0,
	}
	let internalJob: ExperimentJob | undefined
	try {
		const workerRole = config.roles?.worker
		const workerModel = workerRole?.model ?? candidate.model
		if (!role.model?.trim() || role.model === workerModel) throw new Error("adversary role must use a different model from the configured worker role")
		const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-renames", candidate.baseCommit + "...HEAD"], { cwd: candidate.worktree, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 }).toString("utf8")
		if (!patch || Buffer.byteLength(patch) > 512 * 1024) throw new Error("candidate diff is empty or exceeds the 512 KiB reviewer input limit")
		const prompt = buildAdversarialPrompt(candidate, patch, evaluation)
		const promptBytes = Buffer.from(prompt)
		if (promptBytes.byteLength > 600 * 1024) throw new Error("adversarial prompt exceeds the 600 KiB limit")
		const promptArtifact = await queue.putArtifact(promptBytes)
		base.promptSha256 = sha256(promptBytes)
		base.promptArtifactSha256 = promptArtifact.sha256
		const raw = await (hooks.runAdversary ? hooks.runAdversary({ role, prompt }) : requestAdversarialReview(role, prompt))
		const resultBytes = Buffer.from(raw)
		const resultArtifact = await queue.putArtifact(resultBytes)
		base.resultSha256 = sha256(resultBytes)
		base.resultArtifactSha256 = resultArtifact.sha256
		const parsed = parseAdversarialReview(raw, candidate.changedFiles)
		base.summary = parsed.summary
		base.findings = parsed.findings
		base.penaltyPoints = Math.min(10, parsed.findings.reduce((points, finding) => points + (finding.severity === "major" ? 5 : 1), 0))
		const tests = Buffer.from(JSON.stringify({ schemaVersion: 1, tests: parsed.tests }))
		const testsArtifact = await queue.putArtifact(tests)
		base.testArtifactSha256 = testsArtifact.sha256
		const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidate.worktree, encoding: "utf8" }).trim()
		const snapshot = createAdversarialEvaluationSnapshotBundle(candidate.worktree, candidateCommit, config, tests)
		const snapshotArtifact = await queue.putArtifact(snapshot.content)
		base.snapshotArtifactSha256 = snapshotArtifact.sha256
		internalJob = newExperimentJob("adversarial", { class: "CPU", units: 1, concurrencyKey: "adversarial:" + candidate.id }, now(), candidate.id)
		run.jobs ??= []
		run.jobs.push(internalJob)
		const candidateId = candidate.id + "-adversarial"
		const payload = fleetPayload(config, { ...candidate, id: candidateId, baseCommit: snapshot.snapshotCommit }, snapshot, { evaluatorRuntime })
		payload.snapshotSha256 = snapshotArtifact.sha256
		payload.task = "Run supervisor-generated adversarial checks for " + candidate.id
		payload.regressionCommand = "true"
		payload.evalCommands = [ADVERSARIAL_COMMAND]
		payload.adversarialEvaluation = adversarialEvaluationArtifactIdentity(tests)
		const idempotencyKey = run.runId + ":" + candidate.id + ":adversarial:" + testsArtifact.sha256
		const expected = {
			idempotencyKey, runId: run.runId, candidateId, jobKind: "evaluation" as const,
			resourceClass: "CPU" as const, concurrencyKey: "adversarial:" + candidate.id,
			artifactSha256: snapshotArtifact.sha256, payload,
		}
		let job = await queue.getJobByIdempotencyKey(idempotencyKey)
		if (!job) job = await queue.enqueue({ ...expected, payload })
		if (!fleetJobMatches(job, expected)) throw new Error("existing adversarial evaluation idempotency key has mismatched test artifact or execution payload")
		const completed = await waitForFleetJob(queue, job.jobId, requiredFleetJobLeaseMs("evaluation", config.commandTimeoutMs, 1) + 60_000, fleetRuntimeDeadlineMs(config, run))
		if (completed.status !== "completed" || !completed.result || typeof completed.result !== "object") throw new Error(completed.error ?? "OpenShell adversarial tests ended " + completed.status)
		const result = fleetEvaluationResult(completed.result)
		const trial = result.visible[0]
		if (!trial) throw new Error("OpenShell adversarial job returned no test result")
		const passedIds = new Set(trial.stdout.split("\n").filter((line) => line.startsWith("PASS ")).map((line) => line.slice(5).trim()))
		base.testResults = parsed.tests.map((test) => ({ id: test.id, passed: trial.ok && passedIds.has(test.id), outputArtifactSha256: trial.outputArtifactSha256, ...(!trial.ok || !passedIds.has(test.id) ? { failure: trial.stdout.slice(0, 1000) || "OpenShell adversarial test failed with exit " + (trial.exitCode ?? "unknown") } : {}) }))
		base.jobId = job.jobId
		const allTestsPassed = trial.ok && base.testResults.length === parsed.tests.length && base.testResults.every((entry) => entry.passed)
		base.status = allTestsPassed ? "passed" : "failed"
		internalJob.status = allTestsPassed ? "completed" : "failed"
		internalJob.updatedAt = now()
		if (!allTestsPassed) internalJob.error = "adversarial test failure (" + (trial.exitCode ?? "unknown") + ")"
		return base
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		base.error = message.slice(0, 2000)
		base.status = "error"
		if (internalJob) {
			internalJob.status = "failed"
			internalJob.updatedAt = now()
			internalJob.error = base.error
		}
		try {
			const failureArtifact = await queue.putArtifact(Buffer.from(base.error))
			base.errorSha256 = sha256(base.error)
			base.errorArtifactSha256 = failureArtifact.sha256
		} catch { /* preserve the primary failure if artifact storage itself is unavailable */ }
		return base
	}
}

async function evaluateBaselineLocal(config: RsiConfig, baseCommit: string, runner: RsiHooks["runCommand"], hidden?: (root: string, jobId: string) => HiddenEvaluationOptions | undefined): Promise<NonNullable<RsiRunRecord["baselineEvaluation"]>> {
	const name = `rsi-baseline-${randomUUID().slice(0, 12)}`
	const baselineRoot = path.join(config.repoRoot, ".worktrees", name)
	execFileSync("git", ["worktree", "add", "--detach", baselineRoot, baseCommit], { cwd: config.repoRoot, stdio: "pipe" })
	try {
		return await evaluateCandidate(config, baselineRoot, baseCommit, runner, hidden?.(baselineRoot, "baseline"))
	} finally {
		execFileSync("git", ["worktree", "remove", "--force", baselineRoot], { cwd: config.repoRoot, stdio: "pipe" })
	}
}

async function evaluateBaselineFleet(
	config: RsiConfig,
	baseCommit: string,
	queue: PostgresRsiJobQueue,
	runId: string,
	hidden?: (root: string, jobId: string) => HiddenEvaluationOptions | undefined,
	runtimeDeadlineMs?: number,
	evaluatorRuntime?: Pick<EvaluatorRuntimeIdentity, "imageDigest" | "policySha256">,
): Promise<NonNullable<RsiRunRecord["baselineEvaluation"]>> {
	const idempotencyKey = `${runId}:baseline:evaluation`
	const snapshot = createEvaluationSnapshotBundle(config.repoRoot, baseCommit, config)
	const artifact = await queue.putArtifact(snapshot.content)
	const baseline: CandidateRecord = {
			id: "baseline",
			generation: 0,
			parent: "baseline",
			branch: "baseline",
			worktree: config.repoRoot,
			baseCommit,
			status: "evaluating",
			model: config.model,
			mutation: "Baseline visible evaluation",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			commits: [],
			changedFiles: [],
			protectedPathViolations: [],
		}
	if (!evaluatorRuntime) throw new Error("fleet baseline evaluation requires its frozen evaluator image and policy identity")
	const payload = fleetPayload(config, baseline, snapshot, { evaluatorRuntime })
	payload.snapshotSha256 = artifact.sha256
	const expected: FleetJobIdentity = {
		idempotencyKey, runId, candidateId: "baseline", jobKind: "evaluation",
		resourceClass: "CPU", concurrencyKey: "eval:baseline", artifactSha256: artifact.sha256, payload,
	}
	const existing = await queue.getJobByIdempotencyKey(idempotencyKey)
	const job = existing ?? await queue.enqueue(expected)
	if (!fleetJobMatches(job, expected)) throw new Error("existing baseline evaluation idempotency key has mismatched execution identity or payload")

	const completed = await waitForFleetJob(queue, job.jobId, requiredFleetJobLeaseMs("evaluation", config.commandTimeoutMs, config.evalCommands.length + 2) + 60_000, runtimeDeadlineMs)
	if (completed.status !== "completed" || !completed.result || typeof completed.result !== "object") throw new Error(completed.error ?? `fleet baseline evaluation ended ${completed.status}`)
	const evaluation = fleetEvaluationResult(completed.result)
	const trials = [evaluation.regression, evaluation.typecheck, ...evaluation.visible]
	let resultIndex = 0
	const baselineRoot = path.join(config.repoRoot, ".worktrees", `rsi-baseline-${randomUUID().slice(0, 12)}`)
	execFileSync("git", ["worktree", "add", "--detach", baselineRoot, baseCommit], { cwd: config.repoRoot, stdio: "pipe" })
	try {
		return await evaluateCandidate(config, baselineRoot, baseCommit, async () => trials[resultIndex++] as TrialResult, hidden?.(baselineRoot, "baseline"))
	} finally {
		execFileSync("git", ["worktree", "remove", "--force", baselineRoot], { cwd: config.repoRoot, stdio: "pipe" })
	}
}

function recoverInterruptedCandidates(run: RsiRunRecord, now: string): void {
	for (const candidate of run.candidates) {
		if (candidate.status === "mutating" || candidate.status === "evaluating") {
			candidate.status = "failed"
			candidate.failure = "run interrupted before candidate reached a terminal state"
			candidate.updatedAt = now
		}
	}
}

async function ensureCandidateWorktree(config: RsiConfig, candidate: CandidateRecord): Promise<{ created: boolean; commits: number }> {
	let created = false
	try {
		await fs.access(candidate.worktree)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		await createCandidateWorktree(config, candidate)
		created = true
	}
	const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: candidate.worktree, encoding: "utf8" }).trim()
	if (path.resolve(top) !== path.resolve(candidate.worktree)) throw new Error("candidate worktree path resolved outside its recorded location")
	const commits = Number(execFileSync("git", ["rev-list", "--count", `${candidate.baseCommit}..HEAD`], { cwd: candidate.worktree, encoding: "utf8" }).trim())
	if (!Number.isSafeInteger(commits) || commits < 0 || commits > 1) throw new Error("candidate worktree has an unexpected commit count while resuming")
	const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: candidate.worktree, encoding: "buffer" })
	if (status.byteLength > 0) throw new Error("candidate worktree has uncommitted state; refusing unsafe fleet resume")
	return { created, commits }
}

async function captureCandidate(
	candidate: CandidateRecord,
	config: RsiConfig,
	run: RsiRunRecord,
	trajectories: TrajectoryRecord[],
	now: string,
	hooks: RsiHooks,
): Promise<void> {
	try {
		const captured = await captureCandidateTrajectory(candidate, config, now)
		candidate.trajectory = captured.summary
		trajectories.push(captured.record)
		run.trajectoryRefs ??= []
		run.trajectoryRefs.push(captured.summary.path)
	} catch (error) {
		log(hooks, `[rsi] ${candidate.id}: trajectory capture failed: ${String(error)}`)
	}
}

export async function runRsi(config: RsiConfig, hooks: RsiHooks = {}, queueOverride?: PostgresRsiJobQueue): Promise<RsiRunRecord> {
	if (config.computePolicy === "adaptive-independent") {
		const trajectoryLimit = config.maxTrajectories ?? config.population + 1
		const iterationLimit = config.maxTotalIterations ?? trajectoryLimit * config.maxIterations
		if (config.population < 2 || config.generations !== 1 || trajectoryLimit < config.population || trajectoryLimit > config.population + 1 || iterationLimit < config.population * config.maxIterations || iterationLimit > trajectoryLimit * config.maxIterations) {
			throw new Error("invalid adaptive-independent budgets: require population >= 2, exactly one follow-up generation, and trajectory/iteration limits for only the initial cohort plus at most one candidate")
		}
		if (config.workerHarnessPairId) throw new Error("paired restart-safe proof campaigns require every frozen generation to run; adaptive early-stop is not admitted")
	}
	const now = hooks.now ?? (() => new Date().toISOString())
	const archive = await readArchive(config.archiveDir)
	const roles = resolveRoles(config.roles, process.env, config.model)
	const workerModel = roles.worker?.model ?? config.model
	const workerProvider = roles.worker?.provider === "openrouter" ? "openshell-openrouter" : "openshell-ollama"
	const workerOpenRouterProfile = workerProvider === "openshell-openrouter" ? openRouterProfileForModel(workerModel, roles.worker?.openRouterProfile) : undefined
	const workerHarnessMode = config.workerHarnessMode ?? "fixed-control"
	const workerHarnessRuntime = config.workerHarnessMode
		? config.workerHarnessRuntime ?? workerHarnessRuntimeIdentityFromEnvironment(process.env)
		: undefined
	if (workerHarnessRuntime && !validWorkerHarnessRuntimeIdentity(workerHarnessRuntime)) throw new Error("worker harness runtime identity is malformed")
	const requestedPhase = config.workerHarnessPhase ?? "development"
	if (config.workerHarnessEngineeringOnly && (!config.workerHarnessPairId || !config.workerHarnessMode || requestedPhase !== "development")) throw new Error("engineering-only paired runs require an explicit campaign, arm, and development phase")
	validateDeterministicWorkerHarnessRunId(config)
	const resumed = config.resumeRunId ? requestedPhase === "confirmation" ? await findRun(config.archiveDir, config.resumeRunId) : await findActiveRun(config.archiveDir, config.resumeRunId) : undefined
	if (config.resumeRunId && !resumed) throw new Error(`no active RSI run found for --resume ${config.resumeRunId}`)
	if (resumed && config.workerHarnessRunId && resumed.runId !== config.workerHarnessRunId) throw new Error("worker harness deterministic run identity differs from the resumed archive record")
	const baseCommit = resumed?.baseCommit ?? (await resolveBaseCommit(config))
	const run = resumed ?? initialRun({ ...config, model: workerModel, roles }, baseCommit, now())
	if (resumed && resumed.candidateIdNamespace !== undefined && resumed.candidateIdNamespace !== run.runId.slice(-8)) {
		throw new Error("candidate branch namespace differs from the durable run identity")
	}
	// Older ordinary runs have no persisted namespace and must retain their
	// original logical candidate IDs when resumed. New runs and paired runs use
	// a stable suffix of the durable run ID to distinguish physical branches.
	const candidateIdNamespace = resumed
		? resumed.candidateIdNamespace ?? (config.workerHarnessPairId ? run.runId.slice(-8) : undefined)
		: run.runId.slice(-8)
	if (candidateIdNamespace !== undefined) run.candidateIdNamespace = candidateIdNamespace
	if (!resumed && await hasEvaluatorIntegrityManifests(config.archiveDir, run.runId)) throw new Error("evaluator integrity seal artifacts already exist for this run ID without archive metadata; refusing to overwrite the prior seal")
	if (resumed && resumed.model !== workerModel) throw new Error("worker model differs from the frozen run identity")
	if (resumed?.openRouterProfileId && resumed.openRouterProfileId !== workerOpenRouterProfile?.id) throw new Error("OpenRouter profile differs from the frozen run identity")
	const stageCount = requestedPhase === "confirmation" ? 0 : config.computePolicy === "adaptive-independent" ? 2 : config.generations
	if (requestedPhase !== "confirmation") run.generations = stageCount
	run.model = workerModel
	if (workerOpenRouterProfile && workerOpenRouterProfile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID) run.openRouterProfileId = workerOpenRouterProfile.id
	run.parentSelectionPolicy = config.parentSelectionPolicy ?? run.parentSelectionPolicy ?? "champion-specialist-novelty"
	if (resumed && (run.workerHarnessMode ?? "fixed-control") !== workerHarnessMode) throw new Error("worker harness mode differs from the frozen run manifest")
	if (resumed && (run.workerHarnessPairId ?? undefined) !== config.workerHarnessPairId) throw new Error("worker harness pair ID differs from the frozen run manifest")
	if (resumed && workerHarnessRuntime && JSON.stringify(run.workerHarnessRuntime) !== JSON.stringify(workerHarnessRuntime)) throw new Error("worker harness runtime identity differs from the frozen run manifest")
	run.modelCandidates ??= [baseModelCandidate(config.model, now(), config.modelCandidateId ?? "model-base")]
	if (config.modelCandidates?.length) {
		run.modelCandidates = [...run.modelCandidates, ...config.modelCandidates.filter((model) => !run.modelCandidates!.some((entry) => entry.id === model.id))]
	}
	run.combinations ??= []
	run.jobs ??= []
	run.trajectoryRefs ??= []
	run.curriculumTasks ??= []
	run.adversarialReviews ??= []
	run.parentChoices ??= {}
	const runConfig: RsiConfig = {
		...config,
		model: workerModel,
		roles,
		seed: config.workerHarnessPairId ? config.seed : `${config.seed}-${run.runId.slice(-8)}`,
		candidateIdNamespace,
		...(workerHarnessRuntime ? { workerHarnessRuntime } : {}),
	}
	const loadedHiddenVerifier = await loadHiddenVerifierConfig(runConfig)
	if (resumed) {
		if (JSON.stringify(resumed.hiddenVerifierIdentity) !== JSON.stringify(loadedHiddenVerifier?.identity)) throw new Error("hidden verifier suite, evaluator image, or public key differs from the frozen run identity")
	} else if (loadedHiddenVerifier) {
		run.hiddenVerifierIdentity = loadedHiddenVerifier.identity
	}
	const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
	const evaluatorRuntime = config.dryRun
		? undefined
		: await resolveRsiEvaluatorRuntimeIdentity(process.env, hooks.syntheticRuntimeIdentity === true)
	const hiddenEvaluationFor = (candidateRoot: string, jobId: string): HiddenEvaluationOptions | undefined => loadedHiddenVerifier ? ({
		suite: loadedHiddenVerifier.suite,
		runner: createOpenShellHiddenCaseRunner({ candidateRoot, config: runConfig, signingKey: loadedHiddenVerifier.privateKey, imageDigest: loadedHiddenVerifier.imageDigest, evaluatorPolicySha256: evaluatorRuntime?.policySha256 ?? "" }),
		nonceStore: loadedHiddenVerifier.nonceStore,
		publicKey: loadedHiddenVerifier.publicKey,
		evaluatorImageDigest: loadedHiddenVerifier.imageDigest,
		sessionId: run.runId,
		jobId,
	}) : undefined
	const proofFixturesRoot = path.join(packageRoot, "fixtures", "rsi-benchmark")
	const loadedProofBenchmark = hooks.runDevelopmentBenchmark
		? await fs.readFile(path.join(proofFixturesRoot, "manifest.json"), "utf8").then((rawManifest) => ({ manifest: JSON.parse(rawManifest) as BenchmarkManifest, manifestDigest: createHash("sha256").update(rawManifest).digest("hex") }))
		: await loadBenchmark(proofFixturesRoot, config.repoRoot)
	const proofProtocol = freezeDevelopmentProofProtocol(
		loadedProofBenchmark.manifest,
		loadedProofBenchmark.manifestDigest,
		{ provider: workerProvider, id: workerModel, sampling: { temperature: 0, think: false, seed: "provider-default" }, ...(workerOpenRouterProfile && workerOpenRouterProfile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID ? { profileId: workerOpenRouterProfile.id } : {}) },
		config.developmentProofRule,
	)
	const plannedGenerations = resumed?.workerHarnessPlannedGenerations ?? stageCount
	if (resumed && (config.workerHarnessMode !== undefined || run.workerHarnessPairId !== undefined) && stageCount !== plannedGenerations) {
		throw new Error("worker harness planned generation count differs from the frozen paired experiment")
	}
	const pairedConfig = {
		...config,
		generations: plannedGenerations,
		roles,
		parentSelectionPolicy: run.parentSelectionPolicy,
	}
	const pairedDigest = workerHarnessConfigDigest(pairedConfig, {
		baseCommit,
		model: workerModel,
		provider: workerProvider,
		proofProtocolDigest: proofProtocol.protocolDigest,
	})
	if (resumed && (config.workerHarnessMode !== undefined || run.workerHarnessConfigDigest !== undefined) && run.workerHarnessConfigDigest !== pairedDigest) {
		throw new Error("worker harness paired experiment configuration differs from the frozen run manifest")
	}
	const conflictingArm = config.workerHarnessPairId
		? [...archive.runs, ...archive.activeRuns].find((entry) => entry.workerHarnessPairId === config.workerHarnessPairId && entry.runId !== run.runId && (entry.workerHarnessMode ?? "fixed-control") !== workerHarnessMode)
		: undefined
	if (conflictingArm && (conflictingArm.workerHarnessConfigDigest !== pairedDigest
		|| conflictingArm.workerHarnessPlannedGenerations !== plannedGenerations
		|| JSON.stringify(conflictingArm.workerHarnessRuntime) !== JSON.stringify(workerHarnessRuntime))) {
		throw new Error("paired fixed-control and self-hosted runs must use identical experiment settings and runtime identity")
	}
	run.workerHarnessMode = workerHarnessMode
	run.workerHarnessPairId = config.workerHarnessPairId
	run.workerHarnessConfigDigest = pairedDigest
	run.workerHarnessPlannedGenerations ??= plannedGenerations
	run.workerHarnessSamplingSeed = config.seed
	if (workerHarnessRuntime) run.workerHarnessRuntime = workerHarnessRuntime
	if (resumed && !resumed.developmentProofProtocol) throw new Error("cannot resume an RSI run without its frozen development proof protocol")
	if (resumed && resumed.developmentProofProtocol?.protocolDigest !== proofProtocol.protocolDigest) throw new Error("development proof protocol differs from the frozen protocol on this run")
	run.developmentProofProtocol ??= proofProtocol
	const integrityTrust = await loadEvaluatorIntegrityTrust(runConfig)
	const attestedRun = !config.dryRun && !!(config.workerHarnessPairId || config.workerHarnessMode || config.workerHarnessEngineeringOnly || config.hiddenSuitePath || config.hiddenEvalCommands.length || roles?.adversary)
	if (attestedRun && !integrityTrust) throw new Error("paired proof, hidden-evaluator, and adversarial qualification runs require independently pinned evaluator integrity trust")
	const integrityInput = await buildEvaluatorIntegrityInput({
		config: runConfig, run, packageRoot, roles, workerModel, workerProvider,
		...(workerOpenRouterProfile ? { workerOpenRouterProfile: workerOpenRouterProfile.id } : {}),
		proofProtocol, benchmarkManifestSha256: loadedProofBenchmark.manifestDigest,
		...(evaluatorRuntime ? { evaluatorRuntime } : {}),
		...(loadedHiddenVerifier ? { hiddenVerifierIdentity: loadedHiddenVerifier.identity } : {}),
		syntheticRuntimeIdentity: hooks.syntheticRuntimeIdentity === true,
	})
	const checkpointWithEvaluatorIntegrity = async (): Promise<void> => {
		await persistEvaluatorIntegrity(runConfig, run, integrityTrust, integrityInput)
		await archiveCheckpointRun(config.archiveDir, run)
	}
	if (resumed) {
		await verifyResumedEvaluatorIntegrity(runConfig, run, integrityTrust, integrityInput, attestedRun)
		if (!run.evaluatorIntegrity) run.evaluatorIntegrity = { status: "unsealed", outputs: [], generations: [] }
	} else {
		run.evaluatorIntegrity = {
			status: integrityTrust ? "sealed" : "unsealed",
			inputSha256: evaluatorIntegrityDigest(integrityInput),
			outputs: [],
			generations: [],
		}
		if (integrityTrust) await persistEvaluatorIntegrity(runConfig, run, integrityTrust, integrityInput)
	}
	if (requestedPhase !== "confirmation") run.confirmationEvidence = "unmeasured"
	run.confirmationAttempts ??= []
	const proofAttemptCache = new Map<string, Promise<BenchmarkAttempt[]>>()
	const runDevelopmentProof = async (harnessCommit: string, slotId: string, proofRole: "child" | "parent" | "base", sourceCandidateId = slotId): Promise<DevelopmentTaskCell[]> => {
		const evidenceRunId = `${run.runId}:${slotId}:${proofRole}`
		const cacheKey = `${evidenceRunId}\0${harnessCommit}`
		const cached = proofAttemptCache.get(cacheKey)
		if (cached) return developmentCells(await cached)
		try {
			execFileSync("git", ["merge-base", "--is-ancestor", run.baseCommit, harnessCommit], { cwd: config.repoRoot, stdio: "ignore" })
		} catch { throw new Error(`development proof harness ${harnessCommit} is outside run base lineage ${run.baseCommit}`) }
		const lineagePaths = execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", run.baseCommit, harnessCommit], { cwd: config.repoRoot, encoding: "buffer" }) as Buffer
		const lineageViolations = protectedPathViolations(lineagePaths.toString("utf8").split("\0").filter(Boolean), config.protectedPaths)
		if (lineageViolations.length > 0) throw new Error(`development proof harness changes protected paths relative to the run base: ${lineageViolations.join(", ")}`)
		const outputRoot = path.join(config.archiveDir, "development-proof", evidenceRunId, proofProtocol.protocolDigest)
		const pending = hooks.runDevelopmentBenchmark
			? hooks.runDevelopmentBenchmark({ harnessCommit, model: workerModel, outputRoot, protocol: proofProtocol })
			: runDevelopmentBenchmarkForCommit({
				repoRoot: config.repoRoot, fixturesRoot: proofFixturesRoot, outputRoot, harnessCommit, model: workerModel, provider: workerProvider,
				evaluatorPolicySha256: evaluatorRuntime?.policySha256,
			campaignId: campaignLease ? proofBrokerCampaignId(campaignLease.campaignId, "benchmark") : `proof-${evidenceRunId}-${proofProtocol.protocolDigest.slice(0, 16)}`,
			...(campaignLease ? {
				attemptNamespace: `${slotId}:${proofRole}`,
				inferenceLedgerPath: path.join(config.archiveDir, "development-proof", campaignLease.campaignId, "benchmark-openrouter-inference-ledger.json"),
				attemptLifecycle: {
					beforeAttempt: async ({ task, attemptId, campaignId: inferenceCampaignId, agentImage, model, sampling }) => {
						await assertCampaignLease()
						const remaining = Math.max(1, Date.parse(campaignLease!.deadlineAt) - Date.now())
						const limits = openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(process.env, "benchmark"), proofBrokerCampaignId(campaignLease!.campaignId, "benchmark"), { maxCalls: task.ceilings.maxCalls, maxOutputTokensPerCall: task.ceilings.maxOutputTokensPerCall, maxDurationMs: Math.max(1, Math.min(task.ceilings.timeoutMs, remaining)) })
							const request = { taskId: task.id, attemptId, campaignId: inferenceCampaignId, harnessCommit, agentImage, model, sampling, seed: task.seed, startDigest: task.startDigest, verifierDigest: task.verifierDigest, ceilings: task.ceilings }
							const requestSha256 = createHash("sha256").update(JSON.stringify(request)).digest("hex")
							const attemptKey = `development:${slotId}:${proofRole}:${attemptId}`
							const admitted = await campaignStore!.admit(campaignLease!, { attemptKey, brokerJobId: attemptId, kind: "development-proof", identity: { generation: Number(/^g(\d+)-/.exec(slotId)?.[1] ?? -1), candidateId: `${slotId}:${proofRole}`, taskId: task.id, seed: String(task.seed), attemptKind: "development-proof" }, sourceCandidateId, requestSha256, calls: limits.maxCalls, tokens: limits.maxTotalTokens, spendUsd: limits.maxJobSpendUsd })
							if (admitted.status !== "admitted") throw new Error("benchmark proof cell was already dispatched or completed but has no verified local attempt artifact; refusing to dispatch it again")
							await campaignStore!.markDispatched(campaignLease!, attemptKey)
							return requestSha256
						},
						settledAttempt: async ({ attempt }) => {
							const attemptKey = `development:${slotId}:${proofRole}:${attempt.attemptId}`
							if (!attempt.proofRequestSha256) throw new Error("verified benchmark replay is missing its durable campaign request digest")
						const limits = openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(process.env, "benchmark"), proofBrokerCampaignId(campaignLease!.campaignId, "benchmark"), { maxCalls: attempt.ceilings.maxCalls, maxOutputTokensPerCall: attempt.ceilings.maxOutputTokensPerCall, maxDurationMs: Math.max(1, Math.min(attempt.ceilings.timeoutMs, Date.parse(campaignLease!.deadlineAt) - Date.now())) })
							const admitted = await campaignStore!.admit(campaignLease!, {
								attemptKey, brokerJobId: attempt.attemptId, kind: "development-proof",
								identity: { generation: Number(/^g(\d+)-/.exec(slotId)?.[1] ?? -1), candidateId: `${slotId}:${proofRole}`, taskId: attempt.taskId, seed: String(attempt.seed), attemptKind: "development-proof" },
								sourceCandidateId, requestSha256: attempt.proofRequestSha256, calls: limits.maxCalls, tokens: limits.maxTotalTokens, spendUsd: limits.maxJobSpendUsd,
							})
							if (admitted.status === "admitted" || admitted.status === "dispatched") await campaignStore!.markDispatched(campaignLease!, attemptKey)
							else if (admitted.status !== "completed") throw new Error("benchmark proof cell cannot be settled after campaign recovery")
							const receipt = attempt.inferenceReceipt
							if (!receipt?.qualified) await campaignStore!.settle(campaignLease!, attemptKey, { status: "uncertain", error: "benchmark broker receipt is missing or unqualified" })
							else await campaignStore!.settle(campaignLease!, attemptKey, { status: "completed", resultSha256: createHash("sha256").update(JSON.stringify(attempt)).digest("hex"), artifactRefs: Object.fromEntries(Object.entries(attempt.artifactRefs).map(([key, value]) => [key, { sha256: value }])), actualCalls: receipt.calls, actualTokens: receipt.totalTokens ?? 0, actualSpendUsd: receipt.costUsd ?? 0 })
						},
					},
				} : {}),
			})
		proofAttemptCache.set(cacheKey, pending)
		return developmentCells(await pending)
	}
	const trajectories: TrajectoryRecord[] = []

	if (!config.dryRun && config.hiddenEvalCommands.length > 0) {
		throw new Error("RSI hidden evaluations are disabled until their evaluator assets can remain unavailable to candidate processes")
	}
	const fleetQueue = !config.dryRun && (queueOverride !== undefined || !hooks.runMutation)
		? queueOverride ?? PostgresRsiJobQueue.fromEnvironment(fleetQueuePolicy(process.env.HEADLESSCODE_RSI_QUEUE_NAME?.trim() || "rsi-default", config.maxConcurrent, process.env), process.env)
		: undefined
	if (resumed?.evaluatorIntegrity) await verifyIntegrityArtifacts(fleetQueue, resumed.evaluatorIntegrity.outputs)
	if (!config.dryRun && workerProvider === "openshell-openrouter" && !fleetQueue) throw new Error("RSI OpenRouter inference requires the supervised fleet broker path")
	if (!config.dryRun && config.roles?.adversary && !fleetQueue) throw new Error("RSI adversarial break tests require the OpenShell fleet evaluation path")
	const commandRunner = hooks.runCommand ?? (fleetQueue ? undefined : createOpenShellCommandRunner(runConfig, evaluatorRuntime))
	let campaignStore: PostgresProofCampaign | undefined
	let campaignLease: ProofCampaignArmLease | undefined
	let campaignHeartbeat: NodeJS.Timeout | undefined
	let campaignLeaseFailure: Error | undefined
	let heartbeatInFlight = false
	const assertCampaignLease = async (): Promise<void> => {
		if (!campaignStore || !campaignLease) return
		if (campaignLeaseFailure) throw campaignLeaseFailure
		if (Date.now() >= Date.parse(campaignLease.deadlineAt)) throw new Error("proof campaign hard runtime deadline expired; refusing further admission or selection")
		if (!await campaignStore.renew(campaignLease)) {
			campaignLeaseFailure = new Error("proof campaign coordinator lease was fenced; refusing result import or promotion")
			throw campaignLeaseFailure
		}
	}
	try {
	if (fleetQueue) {
		if (fleetQueue.artifactBackend !== "s3") throw new Error("RSI production runs require a shared S3-compatible artifact store")
		await fleetQueue.migrate()
		if (await fleetQueue.activeWorkerCount() < 1) throw new Error("no live OpenShell RSI worker is registered for the configured queue")
	}
	if (config.workerHarnessPairId && !config.dryRun) {
		if (!config.workerHarnessMode || !workerHarnessRuntime || !fleetQueue) throw new Error("restart-safe paired worker-harness campaigns require an explicit arm, frozen runtime identity, and PostgreSQL fleet queue")
				if (config.workerHarnessEngineeringOnly && (requestedPhase !== "development" || config.resumeRunId && resumed?.proofCampaign?.manifest.phaseMode !== "engineering-only")) throw new Error("engineering-only execution cannot resume or enter a confirmation campaign")
		const manifest = createProofCampaignManifest({ config: runConfig, campaignId: config.workerHarnessPairId, baseCommit, model: workerModel, provider: workerProvider, ...(workerOpenRouterProfile && workerOpenRouterProfile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID ? { openRouterProfileId: workerOpenRouterProfile.id } : {}), runtime: workerHarnessRuntime, developmentManifest: loadedProofBenchmark.manifest, developmentManifestDigest: loadedProofBenchmark.manifestDigest, plannedGenerations, proofProtocol })
		campaignStore = fleetQueue.proofCampaignCoordinator()
		if (hooks.runDevelopmentBenchmark) throw new Error("paired proof campaigns cannot use an injected benchmark hook that bypasses durable campaign admission and settlement")
		const priorSnapshot = await campaignStore.snapshotIfExists(config.workerHarnessPairId)
		const priorArm = (priorSnapshot?.arms as Array<Record<string, unknown>> | undefined)?.find((entry) => entry.arm_id === workerHarnessMode)
		if (priorArm?.state === "finished") {
			return rebuildFinishedProofCampaignArchive({ run, config, snapshot: priorSnapshot!, manifest, armId: workerHarnessMode, now })
		}
		if (priorArm?.phase === "confirmation" && requestedPhase !== "confirmation") {
			return rebuildEvaluatedProofCampaignArchive({ run, config, snapshot: priorSnapshot!, manifest, armId: workerHarnessMode, now })
		}
		campaignLease = await campaignStore.acquire(manifest, workerHarnessMode, run.runId, `${process.pid}:${randomUUID()}`)
		if (campaignLease.phase !== requestedPhase) throw new Error(`proof campaign lease is in ${campaignLease.phase}; requested ${requestedPhase}`)
		run.proofCampaign = { manifest, manifestSha256: campaignLease.manifestSha256, campaignId: campaignLease.campaignId, armId: campaignLease.armId, epoch: campaignLease.epoch, state: "running" }
		campaignHeartbeat = setInterval(() => {
			if (heartbeatInFlight || !campaignStore || !campaignLease) return
			heartbeatInFlight = true
			void campaignStore.renew(campaignLease).then((renewed) => {
				if (!renewed) campaignLeaseFailure = new Error("proof campaign coordinator heartbeat was fenced; refusing result import or promotion")
			}).catch((error) => { campaignLeaseFailure = error instanceof Error ? error : new Error(String(error)) }).finally(() => { heartbeatInFlight = false })
		}, 5_000)
		campaignHeartbeat.unref()
		await checkpointWithEvaluatorIntegrity()
	}
	if (resumed && !fleetQueue) recoverInterruptedCandidates(run, now())
	if (requestedPhase === "confirmation") {
		if (!campaignStore || !campaignLease || campaignLease.phase !== "confirmation" || !config.workerHarnessPairId || config.dryRun) throw new Error("confirmation execution requires a resumed, frozen, supervised paired proof campaign")
		const confirmation = await runProofConfirmation({ run, config, manifest: run.proofCampaign!.manifest, benchmark: loadedProofBenchmark.manifest, fixturesRoot: proofFixturesRoot, store: campaignStore, lease: campaignLease, assertLease: assertCampaignLease, model: workerModel, provider: "openshell-openrouter" })
		const attemptsById = new Map((run.confirmationAttempts ?? []).map((attempt) => [attempt.attemptId, attempt]))
		for (const attempt of confirmation.attempts) attemptsById.set(attempt.attemptId, attempt)
		run.confirmationAttempts = [...attemptsById.values()]
		run.proofConfirmation = {
			selectedHarness: { candidateId: confirmation.selectedHarnessCandidate, slotId: confirmation.selectedCandidateId, generation: confirmation.selectedGeneration, commit: confirmation.selectedCommit, attemptIds: confirmation.selectedAttempts.map((attempt) => attempt.attemptId) },
			rootHarness: { commit: run.baseCommit, attemptIds: confirmation.rootAttempts.map((attempt) => attempt.attemptId) },
		}
		run.confirmationEvidence = confirmation.attempts.length > 0 && confirmation.attempts.every((attempt) => attempt.validity === "valid" && attempt.proofQualified && attempt.inferenceReceipt?.qualified) ? "complete" : "incomplete"
		await assertCampaignLease()
		// Persist the exact attempts and selected/root identities before the
		// authoritative DB terminal transition. If the process dies after
		// finishArm but before appendRun, recovery can rebuild from this
		// checkpoint and the durable campaign snapshot without paid replay.
		run.proofCampaign = { ...run.proofCampaign!, state: "running", ledgerSnapshot: await campaignStore.snapshot(campaignLease.campaignId) }
		await checkpointWithEvaluatorIntegrity()
		await assertCampaignLease()
		await campaignStore.finishArm(campaignLease, [confirmation.selectedCandidateId])
		run.proofCampaign = { ...run.proofCampaign!, state: "finished", ledgerSnapshot: await campaignStore.snapshot(campaignLease.campaignId) }
		run.finishedAt = now()
		const confirmationReportPath = `${config.archiveDir}/${run.runId}.md`
		await fs.mkdir(config.archiveDir, { recursive: true })
		await fs.writeFile(confirmationReportPath, formatRunReport(run, config), "utf8")
		run.reports = [...new Set([...run.reports, confirmationReportPath])]
		await appendRun(config.archiveDir, run)
		return run
	}
	if (!config.dryRun && !run.baselineEvaluation) {
			run.baselineEvaluation = fleetQueue
			? await evaluateBaselineFleet(runConfig, baseCommit, fleetQueue, run.runId, hiddenEvaluationFor, fleetRuntimeDeadlineMs(runConfig, run), evaluatorRuntime)
			: await evaluateBaselineLocal(runConfig, baseCommit, commandRunner, hiddenEvaluationFor)
		run.baselineFitness = computeFitness(run.baselineEvaluation)
		run.baseline = run.baselineEvaluation.regression
		mergeIntegrityOutputs(run.evaluatorIntegrity!, evaluationOutputRecords("baseline", run.baselineEvaluation))
		await verifyIntegrityArtifacts(fleetQueue, run.evaluatorIntegrity!.outputs)
		await persistEvaluatorIntegrity(runConfig, run, integrityTrust, integrityInput)
		log(hooks, `[rsi] baseline: ${run.baseline.ok ? "pass" : "fail"}`)
		await checkpointWithEvaluatorIntegrity()
	}

	for (let generation = 0; generation < stageCount; generation++) {
		if (config.computePolicy === "adaptive-independent" && generation > 0) {
			let previousDecision = run.adaptiveSearch?.find((entry) => entry.generation === generation - 1)
			if (!previousDecision) {
				const priorCandidates = run.candidates.filter((candidate) => candidate.generation === generation - 1)
				previousDecision = decideAdaptiveContinuation({
					generation: generation - 1,
					generationCandidates: priorCandidates,
					allCandidates: run.candidates,
					config,
					elapsedMs: Math.max(0, Date.now() - Date.parse(run.startedAt)),
					decidedAt: now(),
				})
				run.adaptiveSearch ??= []
				run.adaptiveSearch.push(previousDecision)
				await checkpointWithEvaluatorIntegrity()
			}
			if (previousDecision.decision !== "continue") break
		}
		let candidates = run.candidates.filter((candidate) => candidate.generation === generation)
		if (candidates.length === 0) {
			if (generation > 0) {
				for (const prior of run.candidates.filter((entry) => entry.generation < generation && entry.status === "accepted").sort((left, right) => left.generation - right.generation)) {
					try {
						validateCandidateParent(prior, run, config, proofProtocol)
						const saved = prior.developmentProof!
						const childCommit = prior.commits[0]
						const expectedParentCommit = prior.parentCommit ?? prior.baseCommit
						if (!childCommit || saved.runId !== run.runId || saved.protocolDigest !== proofProtocol.protocolDigest) throw new CandidateLineageError("accepted parent has no current frozen development proof")
						if (saved.immediateParent.childCommit !== childCommit || saved.immediateParent.referenceCommit !== expectedParentCommit || saved.originalBase.childCommit !== childCommit || saved.originalBase.referenceCommit !== run.baseCommit) throw new CandidateLineageError("saved development proof references do not match the candidate, immediate parent, and run base")
						const priorIndex = run.candidates.filter((entry) => entry.generation === prior.generation).indexOf(prior)
						const priorSlot = proofCandidateSlot(prior.generation, priorIndex)
						const [childCells, parentCells, rootCells] = await Promise.all([
							runDevelopmentProof(childCommit, priorSlot, "child", prior.id),
							runDevelopmentProof(saved.immediateParent.referenceCommit, priorSlot, "parent", prior.id),
							runDevelopmentProof(saved.originalBase.referenceCommit, priorSlot, "base", prior.id),
						])
						const attemptIdsMatch = (expected: string[], cells: DevelopmentTaskCell[]) => JSON.stringify([...expected].sort()) === JSON.stringify(cells.map((cell) => cell.attemptId).sort())
						if (!attemptIdsMatch(saved.childAttemptIds, childCells) || !attemptIdsMatch(saved.parentAttemptIds, parentCells) || !attemptIdsMatch(saved.originalBaseAttemptIds, rootCells)) throw new CandidateLineageError("accepted parent attempt references do not match replayed benchmark artifacts")
						const immediateParent = compareDevelopmentAttempts({ protocol: proofProtocol, childCommit, referenceCommit: saved.immediateParent.referenceCommit, referenceKind: "immediate-parent", child: childCells, reference: parentCells })
						const originalBase = compareDevelopmentAttempts({ protocol: proofProtocol, childCommit, referenceCommit: saved.originalBase.referenceCommit, referenceKind: "original-base", child: childCells, reference: rootCells })
						prior.developmentProof = candidateProofDecision({ runId: run.runId, protocol: proofProtocol, child: childCells, parent: parentCells, originalBase: rootCells, immediateParent, originalBaseComparison: originalBase })
						if (!prior.developmentProof.accepted || prior.fitness?.score === 0 || Object.values(prior.fitness?.hardGates ?? {}).some((passed) => passed === false)) throw new CandidateLineageError("accepted parent no longer passes replayed proof or evaluator gates")
					} catch (error) {
						prior.status = "rejected"
						prior.failure = error instanceof Error ? error.message : String(error)
						log(hooks, `[rsi] ${prior.id}: excluded from parent pool after proof replay: ${prior.failure}`)
					}
				}
			}
			const merged = { ...combinedArchive(archive, run), candidates: run.candidates }
			const choices = generation === 0
				? []
				: selectParentChoices(merged, run.parentSelectionPolicy ?? "champion-specialist-novelty", config.population)
			const fallbackBase = run.selected
				? run.candidates.find((candidate) => candidate.id === run.selected)?.commits[0] ?? run.baseCommit
				: run.baseCommit
			const candidateCount = config.computePolicy === "adaptive-independent" && generation > 0 ? 1 : config.population
			candidates = Array.from({ length: candidateCount }, (_, index) => {
				const parentChoice = choices[index]
				const candidate = newCandidate(runConfig, generation, index, parentChoice?.baseCommit ?? fallbackBase, now(), parentChoice)
				if (parentChoice) run.parentChoices![candidate.id] = parentChoice.reason
				return candidate
			})
			run.candidates.push(...candidates)
			log(hooks, `[rsi] generation ${generation}: planning ${candidates.length} candidate(s) with policy ${run.parentSelectionPolicy}`)
			if (!config.dryRun) await checkpointWithEvaluatorIntegrity()
		} else {
			log(hooks, `[rsi] generation ${generation}: resuming ${candidates.length} persisted candidate(s)`)
		}
		if (config.dryRun) continue
		for (const candidate of candidates.filter((entry) => !isTerminal(entry))) {
			try { validateCandidateParent(candidate, run, config, proofProtocol) }
			catch (error) {
				if (!(error instanceof CandidateLineageError)) throw error
				candidate.status = "rejected"
				candidate.failure = error.message
				candidate.updatedAt = now()
				log(hooks, `[rsi] ${candidate.id}: rejected before mutation: ${candidate.failure}`)
			}
		}
		await checkpointWithEvaluatorIntegrity()

		const mutationJobs = new Map<string, FleetJob>()
		const evaluationJobs = new Map<string, FleetJob>()
		const managedWorktrees = new Set<string>()
		const mutationResource = runConfig.roles?.worker?.provider === "openrouter"
			? { class: "REMOTE_API" as const, units: 1, concurrencyKey: `openrouter:${runConfig.roles.worker.model}` }
			: { class: "LOCAL_GPU" as const, units: 1, concurrencyKey: "ollama" }
		if (fleetQueue) {
			try {
				for (const candidate of candidates) {
					if (isTerminal(candidate)) continue
					const worktree = await ensureCandidateWorktree(runConfig, candidate)
					managedWorktrees.add(candidate.id)
					const key = `${run.runId}:${candidate.id}:mutation`
					const slotId = proofCandidateSlot(candidate.generation, candidates.indexOf(candidate))
					const snapshot = createMutationSnapshotBundle(candidate.worktree, candidate.baseCommit, runConfig)
					const artifact = await fleetQueue.putArtifact(snapshot.content)
					const useOpenRouter = runConfig.roles?.worker?.provider === "openrouter"
					await assertCampaignLease()
					const remainingCampaignMs = campaignLease ? Math.max(1, Date.parse(campaignLease.deadlineAt) - Date.now()) : undefined
					const attemptKey = key
					const payload = fleetPayload(runConfig, candidate, snapshot, {
						campaignId: campaignLease ? proofBrokerCampaignId(campaignLease.campaignId, "mutation") : run.runId, boundedInference: true, includeWorkerHarness: true, remainingCampaignMs,
						...(campaignLease ? { proofCampaign: { campaignId: campaignLease.campaignId, armId: campaignLease.armId, epoch: campaignLease.epoch, manifestSha256: campaignLease.manifestSha256, cells: [{ attemptKey, slotId, attemptKind: "mutation" as const }] } } : {}),
					})
					payload.snapshotSha256 = artifact.sha256
					const resourceClass = useOpenRouter ? "REMOTE_API" as const : "LOCAL_GPU" as const
					const concurrencyKey = `${useOpenRouter ? "openrouter" : "ollama"}:${candidate.model}`
					const expected: FleetJobIdentity = {
						idempotencyKey: key, runId: run.runId, candidateId: candidate.id,
						jobKind: "mutation", resourceClass, concurrencyKey,
						artifactSha256: artifact.sha256, payload,
					}
					let existing = await fleetQueue.getJobByIdempotencyKey(key)
					if (campaignLease) existing = await reconcileProofCampaignJob(fleetQueue, existing, expected, campaignLease)
					if (existing && !fleetJobMatches(existing, expected)) throw new Error("existing idempotent mutation job has mismatched execution identity, snapshot, or task payload")
					if (campaignStore && campaignLease) {
						const limits = payload.inferenceLimits
						if (!limits) throw new Error("proof campaign mutation has no bounded broker limits")
						const requestSha256 = fleetPayloadDigest(existing?.status === "completed" ? existing.payload : payload)
						const admitted = await campaignStore.admit(campaignLease, {
							attemptKey, kind: "mutation", identity: { generation: candidate.generation, candidateId: slotId, taskId: "mutation", seed: runConfig.seed, attemptKind: "mutation" }, sourceCandidateId: candidate.id,
							requestSha256, calls: limits.maxCalls, tokens: limits.maxTotalTokens, spendUsd: limits.maxJobSpendUsd, ...(existing ? { jobId: existing.jobId } : {}),
						})
						if (admitted.status !== "completed") await campaignStore.markDispatched(campaignLease, attemptKey, existing?.jobId)
					}
					if (worktree.commits > 0) {
						const completed = existing
						if (completed?.candidateId !== candidate.id || completed.jobKind !== "mutation" || completed.status !== "completed" || !completed.result || typeof completed.result !== "object") {
							if (completed?.result) recordFleetInferenceDenials(candidate, completed.result, expected.payload, completed.jobId)
							throw new Error("candidate worktree contains an applied mutation commit without its completed idempotent fleet job")
						}
						const result = completed.result as { patchSha256?: string; patchBytes?: number }
						if (!result.patchSha256 || !Number.isSafeInteger(result.patchBytes) || Number(result.patchBytes) < 1) throw new Error("completed fleet mutation has no valid patch artifact reference for resume")
						recordFleetInferenceUsage(candidate, completed.result, expected.payload, completed.jobId)
						const patch = await fleetQueue.getArtifact(result.patchSha256)
						const appliedPatch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-renames", `${candidate.baseCommit}...HEAD`], { cwd: candidate.worktree, encoding: "buffer" })
						if (patch.byteLength !== result.patchBytes || appliedPatch.byteLength !== result.patchBytes || createHash("sha256").update(appliedPatch).digest("hex") !== result.patchSha256) {
							throw new Error("candidate worktree commit does not match the completed fleet mutation patch")
						}
						let recorded = run.jobs.find((entry) => entry.candidateId === candidate.id && entry.kind === "mutation")
						if (!recorded) {
							recorded = newExperimentJob("mutation", mutationResource, now(), candidate.id)
							run.jobs.push(recorded)
						}
						if (recorded.status !== "completed") replaceJob(run, transitionJob(recorded, "completed", now()))
						candidate.status = "evaluating"
						candidate.changedFiles = await changedFiles(candidate.worktree, candidate.baseCommit)
						candidate.commits = await candidateCommits(candidate.worktree, candidate.baseCommit)
						candidate.protectedPathViolations = protectedPathViolations(candidate.changedFiles, config.protectedPaths)
						candidate.updatedAt = now()
						await checkpointWithEvaluatorIntegrity()
						continue
					}
					const job = existing ?? await fleetQueue.enqueue(expected)
					if (!fleetJobMatches(job, expected)) throw new Error("enqueued mutation job does not match its expected execution identity or payload")
					if (campaignStore && campaignLease) await campaignStore.markDispatched(campaignLease, attemptKey, job.jobId)
					mutationJobs.set(candidate.id, job)
				}
			} catch (error) {
				for (const candidate of candidates.filter((entry) => managedWorktrees.has(entry.id))) {
					await removeCandidateWorktree(runConfig, candidate).catch(() => undefined)
				}
				throw error
			}
		}

		// Resolve every mutation first. Evaluation submission is a separate
		// generation-wide phase so CPU workers can claim the full ready set.
		for (const candidate of candidates) {
			if (isTerminal(candidate)) continue
			candidate.modelProvider ??= workerProvider
			let job = run.jobs.find((entry) => entry.candidateId === candidate.id && entry.kind === "mutation")
			if (!job) {
				job = newExperimentJob("mutation", mutationResource, now(), candidate.id)
				run.jobs.push(job)
			}
			try {
				const worktree = fleetQueue ? await ensureCandidateWorktree(runConfig, candidate) : { created: false, commits: 0 }
				managedWorktrees.add(candidate.id)
				if (worktree.commits === 0) {
					candidate.status = "mutating"
					candidate.updatedAt = now()
					if (job.status !== "running") job = transitionJob(job, "running", now())
					replaceJob(run, job)
					await checkpointWithEvaluatorIntegrity()
					if (fleetQueue) {
						const submitted = mutationJobs.get(candidate.id)
						if (!submitted) throw new Error("candidate mutation was not admitted to the RSI fleet queue")
						const completed = await waitForFleetJob(fleetQueue, submitted.jobId, config.commandTimeoutMs * 4 + 180_000, fleetRuntimeDeadlineMs(config, run))
						if (completed.status !== "completed" || !completed.result || typeof completed.result !== "object") {
							recordFleetInferenceDenials(candidate, completed.result, submitted.payload, completed.jobId)
							throw new Error(completed.error ?? `fleet mutation ended ${completed.status}`)
						}
						const result = completed.result as { patchSha256?: string; patchBytes?: number }
						if (!result.patchSha256 || !Number.isSafeInteger(result.patchBytes) || Number(result.patchBytes) < 1) throw new Error("fleet mutation result is missing its patch artifact reference")
						validateCandidateWorkerHarnessExecution(candidate, run, runConfig, fleetWorkerHarnessExecution(completed.result, submitted.payload))
						recordFleetInferenceUsage(candidate, completed.result, submitted.payload, completed.jobId)
						const patch = await fleetQueue.getArtifact(result.patchSha256)
						if (patch.byteLength !== result.patchBytes) throw new Error("fleet mutation patch length did not match result metadata")
						applyFleetMutationPatch(patch, candidate, runConfig)
					} else {
					await createCandidateWorktree(runConfig, candidate)
					managedWorktrees.add(candidate.id)
					const candidateRunConfig = runConfig.workerHarnessMode
						? {
							...runConfig,
							workerHarnessParentCommit: candidate.baseCommit,
							workerHarnessSnapshotTreeDigest: createMutationSnapshotIdentity(candidate.worktree, candidate.baseCommit, runConfig).snapshotTreeDigest,
						}
						: runConfig
					const mutation = await (hooks.runMutation ?? runMutation)(candidate, candidateRunConfig)
					validateCandidateWorkerHarnessExecution(candidate, run, runConfig, mutation.workerHarnessExecution)
					if (!mutation.ok) throw new Error(mutation.error ?? "RSI mutation failed")
				}
				job = transitionJob(job, "completed", now())
				replaceJob(run, job)
			}
			candidate.status = "evaluating"
			candidate.changedFiles = await changedFiles(candidate.worktree, candidate.baseCommit)
			candidate.commits = await candidateCommits(candidate.worktree, candidate.baseCommit)
			candidate.protectedPathViolations = protectedPathViolations(candidate.changedFiles, config.protectedPaths)
			candidate.updatedAt = now()
			await checkpointWithEvaluatorIntegrity()
		} catch (error) {
			candidate.status = "failed"
			candidate.failure = error instanceof Error ? error.message : String(error)
			candidate.updatedAt = now()
			job = transitionJob(job, "failed", now(), candidate.failure)
			replaceJob(run, job)
			await captureCandidate(candidate, runConfig, run, trajectories, now(), hooks)
			log(hooks, `[rsi] ${candidate.id}: mutation failed: ${candidate.failure}`)
			if (!config.keepWorktrees && managedWorktrees.has(candidate.id)) await removeCandidateWorktree(runConfig, candidate).catch(() => undefined)
			await checkpointWithEvaluatorIntegrity()
		}
		await checkpointWithEvaluatorIntegrity()
		}

		if (fleetQueue) {
			for (const candidate of candidates.filter((entry) => entry.status === "evaluating")) {
				try {
					const key = `${run.runId}:${candidate.id}:evaluation`
					const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidate.worktree, encoding: "utf8" }).trim()
					const snapshot = createEvaluationSnapshotBundle(candidate.worktree, head, runConfig)
					const artifact = await fleetQueue.putArtifact(snapshot.content)
					const slotId = proofCandidateSlot(candidate.generation, candidates.indexOf(candidate))
					const verificationTaskIds = ["regression", "typecheck", ...config.evalCommands.map((_, index) => `visible-${index}`)]
					const attemptKeys = verificationTaskIds.map((taskId) => `${run.runId}:${candidate.id}:evaluation:${taskId}`)
					if (!evaluatorRuntime) throw new Error("fleet candidate evaluation requires its frozen evaluator image and policy identity")
					const payload = fleetPayload(runConfig, candidate, snapshot, {
						evaluatorRuntime,
						...(campaignLease ? { proofCampaign: {
							campaignId: campaignLease.campaignId, armId: campaignLease.armId, epoch: campaignLease.epoch, manifestSha256: campaignLease.manifestSha256,
							cells: verificationTaskIds.map((taskId, index) => ({ attemptKey: attemptKeys[index]!, slotId, attemptKind: "verification" as const })),
						} } : {}),
					})
					payload.snapshotSha256 = artifact.sha256
					const expected: FleetJobIdentity = {
						idempotencyKey: key, runId: run.runId, candidateId: candidate.id,
						jobKind: "evaluation", resourceClass: "CPU", concurrencyKey: `eval:${candidate.id}`,
						artifactSha256: artifact.sha256, payload,
					}
					let existing = await fleetQueue.getJobByIdempotencyKey(key)
					if (campaignLease) existing = await reconcileProofCampaignJob(fleetQueue, existing, expected, campaignLease)
					if (existing && !fleetJobMatches(existing, expected)) throw new Error("existing idempotent evaluation job has mismatched execution identity, snapshot, or evaluation configuration")
					if (campaignStore && campaignLease) {
						const requestSha256 = fleetPayloadDigest(existing?.status === "completed" ? existing.payload : payload)
						for (let index = 0; index < verificationTaskIds.length; index++) {
							const taskId = verificationTaskIds[index]!
							const attemptKey = attemptKeys[index]!
							const admitted = await campaignStore.admit(campaignLease, {
								attemptKey, kind: "verification",
								identity: { generation: candidate.generation, candidateId: slotId, taskId, seed: runConfig.seed, attemptKind: "verification" }, sourceCandidateId: candidate.id,
								requestSha256, calls: 0, tokens: 0, spendUsd: 0, ...(existing ? { jobId: existing.jobId } : {}),
							})
							if (admitted.status !== "completed") await campaignStore.markDispatched(campaignLease, attemptKey, existing?.jobId)
						}
					}
					const job = existing ?? await fleetQueue.enqueue(expected)
					if (!fleetJobMatches(job, expected)) throw new Error("enqueued evaluation job does not match its expected execution identity or payload")
					evaluationJobs.set(candidate.id, job)
				} catch (error) {
					candidate.status = "failed"
					candidate.failure = error instanceof Error ? error.message : String(error)
					candidate.updatedAt = now()
					log(hooks, `[rsi] ${candidate.id}: evaluation admission failed: ${candidate.failure}`)
					if (!config.keepWorktrees && managedWorktrees.has(candidate.id)) await removeCandidateWorktree(runConfig, candidate).catch(() => undefined)
					await checkpointWithEvaluatorIntegrity()
				}
			}
		}

		for (const candidate of candidates.filter((entry) => entry.status === "evaluating")) {
			let job = run.jobs.find((entry) => entry.candidateId === candidate.id && entry.kind === "mutation")!
			try {
				let evaluation
				if (fleetQueue) {
					const submitted = evaluationJobs.get(candidate.id) ?? await fleetQueue.getJobByIdempotencyKey(`${run.runId}:${candidate.id}:evaluation`)
					if (!submitted) throw new Error("candidate evaluation was not admitted to the RSI fleet queue")
					const completed = await waitForFleetJob(fleetQueue, submitted.jobId, requiredFleetJobLeaseMs("evaluation", config.commandTimeoutMs, config.evalCommands.length + 2) + 60_000, fleetRuntimeDeadlineMs(config, run))
					if (completed.status !== "completed" || !completed.result || typeof completed.result !== "object") throw new Error(completed.error ?? `fleet evaluation ended ${completed.status}`)
					const visible = fleetEvaluationResult(completed.result)
					const trials = [visible.regression, visible.typecheck, ...visible.visible]
					let resultIndex = 0
					evaluation = await evaluateCandidate(runConfig, candidate.worktree, candidate.baseCommit, async () => trials[resultIndex++] as Awaited<ReturnType<NonNullable<typeof hooks.runCommand>>>, hiddenEvaluationFor(candidate.worktree, candidate.id))
				} else {
					evaluation = await evaluateCandidate(runConfig, candidate.worktree, candidate.baseCommit, commandRunner, hiddenEvaluationFor(candidate.worktree, candidate.id))
				}
				mergeIntegrityOutputs(run.evaluatorIntegrity!, evaluationOutputRecords(candidate.id, evaluation))
				await verifyIntegrityArtifacts(fleetQueue, run.evaluatorIntegrity!.outputs)
				if (runConfig.roles?.adversary) {
					if (!fleetQueue) throw new Error("adversarial break tests require an OpenShell fleet worker")
					if (!evaluatorRuntime) throw new Error("fleet adversarial evaluation requires its frozen evaluator image and policy identity")
					const review = await runAdversarialStage(candidate, evaluation, runConfig, run, fleetQueue, hooks, now, evaluatorRuntime)
					run.adversarialReviews ??= []
					run.adversarialReviews.push(review)
					mergeIntegrityOutputs(run.evaluatorIntegrity!, adversarialOutputRecords(review))
					await verifyIntegrityArtifacts(fleetQueue, run.evaluatorIntegrity!.outputs)
					evaluation.adversarialPass = review.status === "passed" && review.testResults.length > 0 && review.testResults.every((entry) => entry.passed)
					evaluation.adversarialPenalty = review.penaltyPoints
					await checkpointWithEvaluatorIntegrity()
				}
				candidate.changedFiles = evaluation.changedFiles
				candidate.commits = candidate.commits.length > 0 ? candidate.commits : await candidateCommits(candidate.worktree, candidate.baseCommit)
				candidate.result = evaluation.regression
				candidate.fitness = computeFitness({ ...evaluation, protectedPathViolation: candidate.protectedPathViolations.length > 0 })
				if (run.baselineEvaluation) candidate.pairedComparison = comparePairedEvaluation(run.baselineEvaluation, evaluation)
				const childCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidate.worktree, encoding: "utf8" }).trim()
				const parentCommit = candidate.parentCommit ?? candidate.baseCommit
				const parentCandidate = candidate.parent ? run.candidates.find((entry) => entry.id === candidate.parent) : undefined
				if (candidate.parent && candidate.parent !== "baseline" && !parentCandidate) throw new Error(`candidate ${candidate.id} has no durable parent record for proof lineage`)
				const campaignParentId = parentCandidate
					? proofCandidateSlot(parentCandidate.generation, run.candidates.filter((entry) => entry.generation === parentCandidate.generation).indexOf(parentCandidate))
					: "baseline"
				validateCandidateParent(candidate, run, config, proofProtocol)
				let campaignDependentAttemptKeys: string[] = []
				if (Object.values(candidate.fitness.hardGates).some((passed) => passed === false)) {
					const empty: DevelopmentTaskCell[] = []
					const immediateParent = compareDevelopmentAttempts({ protocol: proofProtocol, childCommit, referenceCommit: parentCommit, referenceKind: "immediate-parent", child: empty, reference: empty })
					const originalBase = compareDevelopmentAttempts({ protocol: proofProtocol, childCommit, referenceCommit: run.baseCommit, referenceKind: "original-base", child: empty, reference: empty })
					candidate.developmentProof = candidateProofDecision({ runId: run.runId, protocol: proofProtocol, child: empty, parent: empty, originalBase: empty, immediateParent, originalBaseComparison: originalBase })
					candidate.developmentProof.reason = "development benchmark skipped because regression, typecheck, or evaluator hard gate failed"
					if (campaignStore && campaignLease) {
						const slotId = proofCandidateSlot(candidate.generation, candidates.indexOf(candidate))
						const skippedKeys: string[] = []
					for (const role of ["child", "parent", "base"] as const) for (const task of proofProtocol.taskIdentities) {
						const candidateId = `${slotId}:${role}`
						const attemptKey = `skipped:${slotId}:${role}:${task.id}`
						const evidence = { candidateId, role, taskId: task.id, reason: candidate.developmentProof.reason, fitness: candidate.fitness, protocolDigest: proofProtocol.protocolDigest }
						await campaignStore.skipAfterHardGate(campaignLease, {
							attemptKey, identity: { generation: candidate.generation, candidateId, taskId: task.id, seed: String(task.seed), attemptKind: "development-proof" },
							requestSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"), reason: candidate.developmentProof.reason,
						})
						skippedKeys.push(attemptKey)
					}
					campaignDependentAttemptKeys = skippedKeys
				}
				} else {
					const slotId = proofCandidateSlot(candidate.generation, candidates.indexOf(candidate))
					const [childCells, parentCells, rootCells] = await Promise.all([
						runDevelopmentProof(childCommit, slotId, "child", candidate.id),
						runDevelopmentProof(parentCommit, slotId, "parent", candidate.id),
						runDevelopmentProof(run.baseCommit, slotId, "base", candidate.id),
					])
					const immediateParent = compareDevelopmentAttempts({ protocol: proofProtocol, childCommit, referenceCommit: parentCommit, referenceKind: "immediate-parent", child: childCells, reference: parentCells })
					const originalBase = compareDevelopmentAttempts({ protocol: proofProtocol, childCommit, referenceCommit: run.baseCommit, referenceKind: "original-base", child: childCells, reference: rootCells })
					candidate.developmentProof = candidateProofDecision({ runId: run.runId, protocol: proofProtocol, child: childCells, parent: parentCells, originalBase: rootCells, immediateParent, originalBaseComparison: originalBase })
					campaignDependentAttemptKeys = [
						...childCells.map((cell) => `development:${slotId}:child:${cell.attemptId}`),
						...parentCells.map((cell) => `development:${slotId}:parent:${cell.attemptId}`),
						...rootCells.map((cell) => `development:${slotId}:base:${cell.attemptId}`),
					]
				}
				candidate.status = candidate.fitness.score > 0 && candidate.developmentProof.accepted ? "accepted" : "rejected"
				if (campaignStore && campaignLease) {
					const slotId = proofCandidateSlot(candidate.generation, candidates.indexOf(candidate))
					const verificationKeys = ["regression", "typecheck", ...config.evalCommands.map((_, index) => `visible-${index}`)].map((taskId) => `${run.runId}:${candidate.id}:evaluation:${taskId}`)
					const decisionStatus = candidate.status === "accepted" ? "accepted" : "rejected"
					await campaignStore.recordDecision(campaignLease, {
						generation: candidate.generation, candidateId: slotId, parentId: campaignParentId, status: decisionStatus, childCommit, parentCommit,
						proof: { fitness: candidate.fitness, developmentProof: candidate.developmentProof, protocolDigest: proofProtocol.protocolDigest, skippedTaskKeys: campaignDependentAttemptKeys.filter((key) => key.startsWith("skipped:")) },
						attemptKeys: [`${run.runId}:${candidate.id}:mutation`, ...verificationKeys, ...campaignDependentAttemptKeys],
					})
				}
				candidate.updatedAt = now()
				const combination = createCombination(candidate.id, candidate.modelCandidateId ?? "model-base", now())
				combination.status = candidate.status === "accepted" ? "accepted" : "rejected"
				combination.fitness = candidate.fitness
				combination.metrics = candidate.fitness.metrics
				run.combinations.push(combination)
				job = transitionJob(job, "completed", now())
				replaceJob(run, job)
				await captureCandidate(candidate, runConfig, run, trajectories, now(), hooks)
				log(hooks, `[rsi] ${candidate.id}: ${candidate.status}, score=${candidate.fitness.score}`)
			} catch (error) {
				candidate.status = error instanceof CandidateLineageError ? "rejected" : "failed"
				candidate.failure = error instanceof Error ? error.message : String(error)
				candidate.updatedAt = now()
				job = transitionJob(job, "failed", now(), candidate.failure)
				replaceJob(run, job)
				await captureCandidate(candidate, runConfig, run, trajectories, now(), hooks)
				log(hooks, `[rsi] ${candidate.id}: evaluation failed: ${candidate.failure}`)
			} finally {
				if (!config.keepWorktrees && managedWorktrees.has(candidate.id)) {
					await removeCandidateWorktree(runConfig, candidate).catch((error) => log(hooks, `[rsi] ${candidate.id}: worktree cleanup failed: ${String(error)}`))
				}
				await checkpointWithEvaluatorIntegrity()
			}
		}

		if (campaignStore && campaignLease) {
			const snapshot = await campaignStore.snapshot(campaignLease.campaignId)
			const attempts = snapshot.attempts as Array<Record<string, unknown>>
			const decisions = snapshot.decisions as Array<Record<string, unknown>>
			let incompleteReason: string | undefined
			for (const candidate of candidates.filter((entry) => entry.status === "rejected" || entry.status === "failed")) {
				const slotId = proofCandidateSlot(candidate.generation, candidates.indexOf(candidate))
				if (decisions.some((decision) => decision.arm_id === campaignLease!.armId && decision.candidate_id === slotId)) continue
				const scheduled = (run.proofCampaign!.manifest.schedule).filter((cell) => cell.armId === campaignLease!.armId && cell.generation === candidate.generation && (cell.candidateId === slotId || cell.candidateId.startsWith(`${slotId}:`)))
				const keys: string[] = []
				let allSettled = true
				for (const cell of scheduled) {
					const existing = attempts.find((attempt) => attempt.arm_id === campaignLease!.armId && Number(attempt.generation) === cell.generation && attempt.candidate_id === cell.candidateId && attempt.task_id === cell.taskId && attempt.seed === cell.seed && attempt.attempt_kind === cell.attemptKind)
					if (existing?.status === "completed" || existing?.status === "skipped-after-hard-gate") {
						keys.push(String(existing.attempt_key))
						continue
					}
					if (!existing || existing.status === "admitted") {
						const attemptKey = existing ? String(existing.attempt_key) : `skipped:${cell.candidateId}:${cell.taskId}`
						const evidence = { candidateId: cell.candidateId, taskId: cell.taskId, reason: candidate.failure ?? "candidate rejected by a hard gate before dependent task dispatch", candidateStatus: candidate.status, runId: run.runId }
						await campaignStore.skipAfterHardGate(campaignLease, {
							attemptKey, identity: { generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind },
							requestSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"), reason: String(evidence.reason),
						})
						keys.push(attemptKey)
						continue
					}
					allSettled = false
					break
				}
				if (allSettled && scheduled.length > 0) {
					const childCommit = candidate.commits[0] ?? candidate.baseCommit
					const parentCandidate = candidate.parent ? run.candidates.find((entry) => entry.id === candidate.parent) : undefined
					if (candidate.parent && candidate.parent !== "baseline" && !parentCandidate) throw new Error(`candidate ${candidate.id} has no durable parent record for proof lineage`)
					const campaignParentId = parentCandidate
						? proofCandidateSlot(parentCandidate.generation, run.candidates.filter((entry) => entry.generation === parentCandidate.generation).indexOf(parentCandidate))
						: "baseline"
					await campaignStore.recordDecision(campaignLease, {
						generation: candidate.generation, candidateId: slotId, parentId: campaignParentId, status: candidate.status === "failed" ? "failed" : "rejected",
						childCommit, parentCommit: candidate.parentCommit ?? candidate.baseCommit,
						proof: { failure: candidate.failure ?? "candidate hard gate rejected before task dispatch", status: candidate.status, attemptKeys: keys }, attemptKeys: keys,
					})
				} else if (!allSettled && scheduled.length > 0) {
					const parentCommit = candidate.parentCommit ?? candidate.baseCommit
					const parentCandidate = candidate.parent ? run.candidates.find((entry) => entry.id === candidate.parent) : undefined
					if (candidate.parent && candidate.parent !== "baseline" && !parentCandidate) throw new Error(`candidate ${candidate.id} has no durable parent record for proof lineage`)
					const campaignParentId = parentCandidate
						? proofCandidateSlot(parentCandidate.generation, run.candidates.filter((entry) => entry.generation === parentCandidate.generation).indexOf(parentCandidate))
						: "baseline"
					await campaignStore.recordIncompleteCandidate(campaignLease, {
						generation: candidate.generation, candidateId: slotId, parentId: campaignParentId, parentCommit,
						reason: candidate.failure ?? "candidate has an unresolved scheduled proof attempt",
					})
					incompleteReason ??= `${slotId} has an unresolved scheduled campaign attempt; generation selection and arm finish were withheld`
				}
			}
			if (incompleteReason) {
				const ledgerSnapshot = await campaignStore.snapshot(campaignLease.campaignId)
				run.proofCampaign = { ...run.proofCampaign!, state: "incomplete", incompleteReason, ledgerSnapshot }
				run.finishedAt = now()
				const reportPath = `${config.archiveDir}/${run.runId}.md`
				await fs.mkdir(config.archiveDir, { recursive: true })
				await fs.writeFile(reportPath, formatRunReport(run, config), "utf8")
				run.reports = [...new Set([...run.reports, reportPath])]
				await appendRun(config.archiveDir, run)
				return run
			}
		}

		const accepted = candidates.filter((candidate) => candidate.status === "accepted")
		const front = paretoFront(accepted)
		const ranked = [...accepted].sort((a, b) => compareFitness(b.fitness, a.fitness))
		run.selectedCandidates = front.map((candidate) => candidate.id)
		if (ranked[0]) run.selected = ranked[0].id
		const generationSelection = {
			generation,
			selectedCandidateIds: [...run.selectedCandidates],
			...(ranked[0] ? { selectedCandidateId: ranked[0].id } : {}),
			decisionsSha256: evaluatorGenerationDecisionDigest(candidates, run.adversarialReviews ?? [], ranked[0]?.id),
		}
		const integrityRecord = run.evaluatorIntegrity!
		const previousGeneration = integrityRecord.generations.find((entry) => entry.generation === generation)
		if (previousGeneration && canonicalJson(previousGeneration) !== canonicalJson(generationSelection)) throw new Error(`evaluator selection changed for already sealed generation ${generation}`)
		if (!previousGeneration) integrityRecord.generations.push(generationSelection)
		if (run.selected) integrityRecord.selectedCandidateId = run.selected
		else delete integrityRecord.selectedCandidateId
		await verifyIntegrityArtifacts(fleetQueue, integrityRecord.outputs)
		await persistEvaluatorIntegrity(runConfig, run, integrityTrust, integrityInput)
		await checkpointWithEvaluatorIntegrity()
		if (campaignStore && campaignLease) {
			await assertCampaignLease()
			const selectedSlots = front.map((candidate) => proofCandidateSlot(candidate.generation, candidates.indexOf(candidate)))
			await campaignStore.selectGeneration(campaignLease, generation, selectedSlots)
		}
		if (config.computePolicy === "adaptive-independent") {
			run.adaptiveSearch ??= []
			const decision = decideAdaptiveContinuation({
				generation,
				generationCandidates: candidates,
				allCandidates: run.candidates,
				config,
				elapsedMs: Math.max(0, Date.now() - Date.parse(run.startedAt)),
				decidedAt: now(),
			})
			const existingDecision = run.adaptiveSearch.findIndex((entry) => entry.generation === generation)
			if (existingDecision >= 0) run.adaptiveSearch[existingDecision] = decision
			else run.adaptiveSearch.push(decision)
			log(hooks, `[rsi] adaptive search: ${decision.decision} after generation ${generation} (${decision.reason})`)
		}
		await checkpointWithEvaluatorIntegrity()
	}

	const merged = combinedArchive(archive, run)
	let curriculum = generateCurriculumProposals(merged, now())
	if (fleetQueue && !config.dryRun && curriculum.length > 0) {
		if (!evaluatorRuntime) throw new Error("fleet curriculum evaluation requires its frozen evaluator image and policy identity")
		curriculum = await validateCurriculumOnFleet(curriculum, runConfig, run, fleetQueue, now, evaluatorRuntime)
		run.curriculumTasks = curriculum
		await checkpointWithEvaluatorIntegrity()
	} else {
		run.curriculumTasks = curriculum
	}
	if (!config.dryRun && curriculum.length > 0) {
		await writeCurriculumProposals(curriculum, config.curriculumDir ?? `${config.archiveDir}/curriculum`)
	}
	if (!config.dryRun && trajectories.length > 0) {
		await exportTrajectoryDatasets(trajectories, `${config.trajectoryDir ?? `${config.archiveDir}/trajectories`}/datasets`)
	}
	if (campaignStore && campaignLease) {
		await assertCampaignLease()
		await campaignStore.finishDevelopmentArm(campaignLease)
		const snapshot = await campaignStore.snapshot(campaignLease.campaignId)
		const engineeringOnly = run.proofCampaign?.manifest.phaseMode === "engineering-only"
		run.proofCampaign = { ...run.proofCampaign!, state: engineeringOnly ? "finished" : "evaluated", ledgerSnapshot: snapshot }
		if (engineeringOnly) {
			run.finishedAt = now()
			const reportPath = `${config.archiveDir}/${run.runId}.md`
			await fs.mkdir(config.archiveDir, { recursive: true })
			await fs.writeFile(reportPath, formatRunReport(run, config), "utf8")
			run.reports = [...new Set([...run.reports, reportPath])]
			await appendRun(config.archiveDir, run)
			return run
		}
	}

	run.finishedAt = now()
	const report = formatRunReport(run, config)
	const reportPath = `${config.archiveDir}/${run.runId}.md`
	if (!config.dryRun) {
		await fs.mkdir(config.archiveDir, { recursive: true })
		await fs.writeFile(reportPath, report, "utf8")
		run.reports = [...new Set([...run.reports, reportPath])]
		await appendRun(config.archiveDir, run)
	} else {
		log(hooks, report.trimEnd())
	}
	return run
	} finally {
		if (campaignHeartbeat) clearInterval(campaignHeartbeat)
		if (fleetQueue) await fleetQueue.close()
	}
}

export function improveRunOutcome(run: Pick<RsiRunRecord, "runId" | "selected"> & { proofCampaign?: Pick<NonNullable<RsiRunRecord["proofCampaign"]>, "state"> }, dryRun: boolean): { output: string; exitCode: number } {
	if (run.proofCampaign?.state === "incomplete") {
		return {
			output: `[rsi] incomplete: ${run.runId}; historical-selected=${run.selected ?? "none"}\n`,
			exitCode: 1,
		}
	}
	return {
		output: `[rsi] complete: ${run.runId}; selected=${run.selected ?? "none"}\n`,
		exitCode: run.selected || dryRun ? 0 : 1,
	}
}

export async function improveMain(argv: string[]): Promise<number> {
	const parsed = parseRsiArgs(argv)
	if (parsed.help) {
		process.stdout.write(rsiHelp())
		return 0
	}
	if (parsed.error || !parsed.config) {
		process.stderr.write(`headlesscode improve: ${parsed.error ?? "invalid configuration"}\n`)
		return 2
	}
	try {
		const run = await runRsi(parsed.config)
		const outcome = improveRunOutcome(run, parsed.config.dryRun)
		process.stdout.write(outcome.output)
		return outcome.exitCode
	} catch (error) {
		process.stderr.write(`headlesscode improve: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
}
