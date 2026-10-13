import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { appendRun, checkpointRun as archiveCheckpointRun, findActiveRun, findRun, readArchive } from "./archive.js"
import { parseRsiArgs, rsiHelp } from "./config.js"
import { admitMutationGrant } from "./controller-broker-grants.js"
import { planGenerationCandidates } from "./controller-planning.js"
import { finalizeRunReporting } from "./controller-reporting.js"
import { evaluateCandidate } from "./evaluator.js"
import { computeFitness, comparePairedEvaluation } from "./fitness.js"
import { baseModelCandidate, createCombination } from "./models.js"
import { runMutation } from "./mutation.js"
import { formatRunReport } from "./reports.js"
import { mutationSnapshotProtectedPathViolations, protectedPathViolations } from "./sandbox.js"
import { resolveRoles } from "./roles.js"
import { newExperimentJob, transitionJob } from "./selection.js"
import { captureCandidateTrajectory } from "./trajectory.js"
import { decideAdaptiveContinuation } from "./adaptive.js"
import { createOpenShellCommandRunner, resolveRsiEvaluatorRuntimeIdentity } from "./openshell.js"
import type { EvaluatorRuntimeIdentity } from "./evaluator-runtime.js"
import { adversarialEvaluationArtifactIdentity, createAdversarialEvaluationSnapshotBundle, createEvaluationSnapshotBundle, createMutationSnapshotBundle, createMutationSnapshotIdentity, applyFleetMutationPatch } from "./openshell.js"
import { ADVERSARIAL_COMMAND, ADVERSARIAL_PROMPT_VERSION, ADVERSARIAL_TESTS_PATH, buildAdversarialPrompt, parseAdversarialReview, requestAdversarialReview, sha256 } from "./adversarial.js"
import { fleetJobMatches, fleetPayloadDigest, PostgresRsiJobQueue, fleetQueuePolicy, requiredFleetJobLeaseMs, type FleetJob, type FleetJobIdentity, type FleetJobPayload } from "./postgres-queue.js"
import type { AdversarialReviewRecord, CandidateRecord, EvaluationSummary, ExperimentJob, RsiArchive, RsiConfig, RsiHooks, RsiPreparationReceipt, RsiRunRecord, TrajectoryRecord, TrialResult, WorkerHarnessExecution } from "./types.js"
import {
	candidateCommits,
	changedFiles,
	createCandidateWorktree,
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
import { loadBoundProofBenchmarkFixtures } from "./benchmark/proof-fixtures.js"
import { workerHarnessConfigDigest, workerHarnessRuntimeIdentityFromEnvironment, validWorkerHarnessRuntimeIdentity, effectiveWorkerHarnessMode } from "./worker-harness.js"
import { workerHarnessCliPath } from "./worker-harness.js"
import { PostgresProofCampaign, proofCampaignManifestDigest, type ProofCampaignArmLease, type ProofCampaignManifest } from "./proof-campaign.js"
import { runProofConfirmation } from "./proof-confirmation.js"
import { loadHiddenVerifierConfig } from "./hidden-config.js"
import { createOpenShellHiddenCaseRunner } from "./hidden-openshell-runner.js"
import type { HiddenEvaluationOptions } from "./evaluator.js"
import {
	canonicalJson,
	evaluatorBaseTreeIdentity,
	evaluatorIntegrityDigest,
	evaluatorSourceIdentity,
	hasEvaluatorIntegrityManifests,
	loadEvaluatorIntegrityTrust,
	readEvaluatorIntegrityManifest,
	signEvaluatorIntegrity,
	verifyEvaluatorIntegrity,
	writeEvaluatorIntegrityManifest,
} from "./evaluation-integrity.js"
import type { EvaluatorIntegrityPayload, EvaluatorIntegrityTrust } from "./evaluation-integrity.js"

function log(hooks: RsiHooks, line: string): void {
	(hooks.log ?? ((message) => process.stdout.write(`${message}\n`)))(line)
}

import {
	adversarialOutputRecords,
	evaluationOutputRecords,
	mergeIntegrityOutputs,
	verifyIntegrityArtifacts,
} from "./controller-integrity.js"
import { selectGenerationCandidates } from "./controller-selection.js"
import {
	buildEvaluatorIntegrityInput,
	persistEvaluatorIntegrity,
	verifyResumedEvaluatorIntegrity,
} from "./controller-integrity-seal.js"
import {
	CandidateLineageError,
	combinedArchive,
	initialRun,
	isTerminal,
	replaceJob,
	validateCandidateParent,
	validateDeterministicWorkerHarnessRunId,
} from "./controller-candidates.js"
import {
	createProofCampaignManifest,
	proofBrokerCampaignId,
	proofCandidateSlot,
} from "./controller-proof-manifest.js"
import {
	rebuildEvaluatedProofCampaignArchive,
	rebuildFinishedProofCampaignArchive,
	reconcileProofCampaignJob,
} from "./controller-proof-archive.js"
import {
	fleetEvaluationResult,
	fleetPayload,
	fleetRuntimeDeadlineMs,
	fleetWorkerHarnessExecution,
	recordFleetInferenceDenials,
	recordFleetInferenceUsage,
	validateCandidateWorkerHarnessExecution,
	waitForFleetJob,
} from "./controller-fleet.js"
export type { IntegrityOutput } from "./controller-integrity.js"
export {
	adversarialOutputRecords,
	evaluationOutputRecords,
	evaluatorArchiveStateDigest,
	mergeIntegrityOutputs,
	trialOutputRecords,
	verifyArchivedIntegrityOutputs,
	verifyIntegrityArtifacts,
} from "./controller-integrity.js"
export {
	buildEvaluatorIntegrityInput,
	persistEvaluatorIntegrity,
	verifyResumedEvaluatorIntegrity,
} from "./controller-integrity-seal.js"
export {
	CandidateLineageError,
	combinedArchive,
	initialRun,
	isTerminal,
	replaceJob,
	validateCandidateParent,
	validateDeterministicWorkerHarnessRunId,
} from "./controller-candidates.js"
export {
	createProofCampaignManifest,
	proofBrokerCampaignId,
	proofCampaignSpendReservationMicros,
	proofCampaignTaskWallBoundMs,
	proofCandidateSlot,
	RSI_CONFIRMATION_RETENTION_TASK_IDS,
} from "./controller-proof-manifest.js"
export type { ProofCampaignSpendReservationMicros } from "./controller-proof-manifest.js"
export {
	rebuildEvaluatedProofCampaignArchive,
	rebuildFinishedProofCampaignArchive,
	reconcileProofCampaignJob,
	verifyFinishedConfirmationCheckpoint,
} from "./controller-proof-archive.js"
export {
	fleetEvaluationResult,
	fleetPayload,
	fleetRuntimeDeadlineMs,
	fleetWorkerHarnessExecution,
	recordFleetInferenceDenials,
	recordFleetInferenceUsage,
	validateCandidateWorkerHarnessExecution,
	waitForFleetJob,
} from "./controller-fleet.js"

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

export function recoverInterruptedCandidates(run: RsiRunRecord, now: string): void {
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
	const proofFixturesRoot = config.proofBenchmarkFixtures?.root ?? path.join(packageRoot, "fixtures", "rsi-benchmark")
	const preparationStartedAt = process.hrtime.bigint()
	const preparationPhaseStartedAt = new Map<RsiPreparationReceipt["phase"], bigint>()
	const emitPreparationReceipt = async (phase: RsiPreparationReceipt["phase"], state: RsiPreparationReceipt["state"], manifestSha256?: string): Promise<void> => {
		if (!config.workerHarnessPairId) return
		const timestamp = process.hrtime.bigint()
		if (state === "started") preparationPhaseStartedAt.set(phase, timestamp)
		const phaseStart = preparationPhaseStartedAt.get(phase) ?? timestamp
		const elapsedMs = (value: bigint) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(Number(value) / 1_000_000)))
		const receipt: RsiPreparationReceipt = {
			schemaVersion: 1, kind: "rsi-preparation", phase, state, sourceCommit: baseCommit,
			seedSha256: createHash("sha256").update(config.seed).digest("hex"), campaignId: config.workerHarnessPairId,
			...((manifestSha256 ?? config.proofBenchmarkFixtures?.manifestSha256) ? { manifestSha256: manifestSha256 ?? config.proofBenchmarkFixtures!.manifestSha256 } : {}), phaseElapsedMs: state === "started" ? 0 : elapsedMs(timestamp - phaseStart),
			elapsedSinceStartMs: elapsedMs(timestamp - preparationStartedAt),
			readiness: phase === "campaign-acquire" && state === "completed" ? "campaign-acquired" : "preparing",
			inferenceAdmittedByReceipt: false,
		}
		if (hooks.onPreparationReceipt) await hooks.onPreparationReceipt(receipt)
		else log(hooks, `RSI_PREPARATION_RECEIPT ${JSON.stringify(receipt)}`)
	}
	const emitFailureReceipt = async (phase: RsiPreparationReceipt["phase"], manifestSha256?: string): Promise<void> => {
		try { await emitPreparationReceipt(phase, "failed", manifestSha256) } catch { /* preserve the original preparation error */ }
	}
	await emitPreparationReceipt("fixture-validation", "started")
	let loadedProofBenchmark: { manifest: BenchmarkManifest; manifestDigest: string }
	try {
		loadedProofBenchmark = config.proofBenchmarkFixtures
			? await loadBoundProofBenchmarkFixtures(config.proofBenchmarkFixtures, config.repoRoot)
			: hooks.runDevelopmentBenchmark
				? await fs.readFile(path.join(proofFixturesRoot, "manifest.json"), "utf8").then((rawManifest) => ({ manifest: JSON.parse(rawManifest) as BenchmarkManifest, manifestDigest: createHash("sha256").update(rawManifest).digest("hex") }))
				: await loadBenchmark(proofFixturesRoot, config.repoRoot)
	} catch (error) {
		await emitFailureReceipt("fixture-validation")
		throw error
	}
	await emitPreparationReceipt("fixture-validation", "completed", loadedProofBenchmark.manifestDigest)
	await emitPreparationReceipt("proof-protocol", "started", loadedProofBenchmark.manifestDigest)
	const proofProtocol = freezeDevelopmentProofProtocol(
		loadedProofBenchmark.manifest,
		loadedProofBenchmark.manifestDigest,
		{ provider: workerProvider, id: workerModel, sampling: { temperature: 0, think: false, seed: "provider-default" }, ...(workerOpenRouterProfile && workerOpenRouterProfile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID ? { profileId: workerOpenRouterProfile.id } : {}) },
		config.developmentProofRule,
	)
	await emitPreparationReceipt("proof-protocol", "completed", loadedProofBenchmark.manifestDigest)
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
		const requiredResourceClasses = ["CPU", workerProvider === "openshell-openrouter" ? "REMOTE_API" : "LOCAL_GPU"] as const
		await fleetQueue.assertResourceClassCoverage(requiredResourceClasses)
	}
	if (config.workerHarnessPairId && !config.dryRun) {
		if (!config.workerHarnessMode || !workerHarnessRuntime || !fleetQueue) throw new Error("restart-safe paired worker-harness campaigns require an explicit arm, frozen runtime identity, and PostgreSQL fleet queue")
				if (config.workerHarnessEngineeringOnly && (requestedPhase !== "development" || config.resumeRunId && resumed?.proofCampaign?.manifest.phaseMode !== "engineering-only")) throw new Error("engineering-only execution cannot resume or enter a confirmation campaign")
		await emitPreparationReceipt("campaign-manifest", "started", loadedProofBenchmark.manifestDigest)
		const manifest = createProofCampaignManifest({ config: runConfig, campaignId: config.workerHarnessPairId, baseCommit, model: workerModel, provider: workerProvider, ...(workerOpenRouterProfile && workerOpenRouterProfile.id !== RSI_DEFAULT_OPENROUTER_PROFILE_ID ? { openRouterProfileId: workerOpenRouterProfile.id } : {}), runtime: workerHarnessRuntime, developmentManifest: loadedProofBenchmark.manifest, developmentManifestDigest: loadedProofBenchmark.manifestDigest, plannedGenerations, proofProtocol })
		await emitPreparationReceipt("campaign-manifest", "completed", loadedProofBenchmark.manifestDigest)
		await emitPreparationReceipt("campaign-observation", "started", loadedProofBenchmark.manifestDigest)
		let priorSnapshot: Record<string, unknown> | undefined
		try {
			campaignStore = fleetQueue.proofCampaignCoordinator()
			priorSnapshot = await campaignStore.snapshotIfExists(config.workerHarnessPairId)
		} catch (error) {
			await emitFailureReceipt("campaign-observation", loadedProofBenchmark.manifestDigest)
			throw error
		}
		await emitPreparationReceipt("campaign-observation", "completed", loadedProofBenchmark.manifestDigest)
		if (hooks.runDevelopmentBenchmark) throw new Error("paired proof campaigns cannot use an injected benchmark hook that bypasses durable campaign admission and settlement")
		const priorArm = (priorSnapshot?.arms as Array<Record<string, unknown>> | undefined)?.find((entry) => entry.arm_id === workerHarnessMode)
		if (priorArm?.state === "finished") {
			return rebuildFinishedProofCampaignArchive({ run, config, snapshot: priorSnapshot!, manifest, armId: workerHarnessMode, now })
		}
		if (priorArm?.phase === "confirmation" && requestedPhase !== "confirmation") {
			return rebuildEvaluatedProofCampaignArchive({ run, config, snapshot: priorSnapshot!, manifest, armId: workerHarnessMode, now })
		}
		await emitPreparationReceipt("campaign-acquire", "started", loadedProofBenchmark.manifestDigest)
		try {
			campaignLease = await campaignStore.acquire(manifest, workerHarnessMode, run.runId, `${process.pid}:${randomUUID()}`)
		} catch (error) {
			await emitPreparationReceipt("campaign-acquire", "failed", loadedProofBenchmark.manifestDigest)
			throw error
		}
		await emitPreparationReceipt("campaign-acquire", "completed", loadedProofBenchmark.manifestDigest)
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
			candidates = await planGenerationCandidates({
				archive,
				run,
				config,
				runConfig,
				generation,
				now,
				log: (message) => log(hooks, message),
				checkpoint: checkpointWithEvaluatorIntegrity,
			})
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
						await admitMutationGrant({
							store: campaignStore,
							lease: campaignLease,
							attemptKey,
							slotId,
							candidate,
							seed: runConfig.seed,
							payload,
							existing,
						})
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

		const selection = selectGenerationCandidates({
			candidates,
			generation,
			adversarialReviews: run.adversarialReviews ?? [],
		})
		run.selectedCandidates = selection.selectedCandidates
		if (selection.selected !== undefined) run.selected = selection.selected
		const integrityRecord = run.evaluatorIntegrity!
		const previousGeneration = integrityRecord.generations.find((entry) => entry.generation === generation)
		const sealed = previousGeneration
			&& canonicalJson(previousGeneration) !== canonicalJson(selection.selection)
		if (sealed) {
			const what = "evaluator selection changed for already sealed"
				+ ` generation ${generation}`
			throw new Error(what)
		}
		if (!previousGeneration) integrityRecord.generations.push(selection.selection)
		if (run.selected) integrityRecord.selectedCandidateId = run.selected
		else delete integrityRecord.selectedCandidateId
		await verifyIntegrityArtifacts(fleetQueue, integrityRecord.outputs)
		await persistEvaluatorIntegrity(runConfig, run, integrityTrust, integrityInput)
		await checkpointWithEvaluatorIntegrity()
		if (campaignStore && campaignLease) {
			await assertCampaignLease()
			const slotOf = (entry: CandidateRecord): string =>
				proofCandidateSlot(entry.generation, candidates.indexOf(entry))
			const selectedSlots = selection.front.map(slotOf)
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

	const finishedEarly = await finalizeRunReporting({
		run,
		config,
		runConfig,
		archive,
		trajectories,
		fleetQueue: fleetQueue || undefined,
		evaluatorRuntime,
		campaign: campaignStore && campaignLease
			? {
				store: campaignStore, lease: campaignLease,
				assertLease: assertCampaignLease,
			}
			: undefined,
		now,
		checkpoint: checkpointWithEvaluatorIntegrity,
	})
	if (finishedEarly) return run

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

