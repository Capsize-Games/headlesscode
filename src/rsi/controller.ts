import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { appendRun, checkpointRun, findActiveRun, readArchive } from "./archive.js"
import { parseRsiArgs, rsiHelp } from "./config.js"
import { generateCurriculumProposals, validateCurriculumProposals, writeCurriculumProposals } from "./curriculum.js"
import { evaluateCandidate } from "./evaluator.js"
import { computeFitness, compareFitness, comparePairedEvaluation } from "./fitness.js"
import { baseModelCandidate, createCombination } from "./models.js"
import { runMutation } from "./mutation.js"
import { formatRunReport } from "./reports.js"
import { protectedPathViolations } from "./sandbox.js"
import { resolveRoles } from "./roles.js"
import { newExperimentJob, paretoFront, selectParentChoices, transitionJob } from "./selection.js"
import { captureCandidateTrajectory, exportTrajectoryDatasets } from "./trajectory.js"
import { decideAdaptiveContinuation } from "./adaptive.js"
import { createOpenShellCommandRunner } from "./openshell.js"
import { createAdversarialEvaluationSnapshotBundle, createEvaluationSnapshotBundle, createMutationSnapshotBundle, applyFleetMutationPatch } from "./openshell.js"
import { ADVERSARIAL_COMMAND, ADVERSARIAL_PROMPT_VERSION, ADVERSARIAL_TESTS_PATH, buildAdversarialPrompt, parseAdversarialReview, requestAdversarialReview, sha256 } from "./adversarial.js"
import { fleetJobMatches, PostgresRsiJobQueue, fleetQueuePolicy, requiredFleetJobLeaseMs, type FleetJob, type FleetJobIdentity, type FleetJobPayload } from "./postgres-queue.js"
import type { AdversarialReviewRecord, CandidateRecord, ExperimentJob, RsiArchive, RsiConfig, RsiHooks, RsiRunRecord, TrajectoryRecord, TrialResult } from "./types.js"
import {
	candidateCommits,
	changedFiles,
	createCandidateWorktree,
	newCandidate,
	removeCandidateWorktree,
	resolveBaseCommit,
} from "./workspace.js"
import { loadBenchmark } from "./benchmark/runner.js"
import { openRouterAllocatedEnvironment, openRouterBrokerLimitsFromEnvironment, RSI_OPENROUTER_MODEL } from "./inference-broker.js"
import { candidateProofDecision, compareDevelopmentAttempts, developmentCells, freezeDevelopmentProofProtocol } from "./development-proof.js"
import type { DevelopmentTaskCell } from "./development-proof.js"
import type { BenchmarkAttempt } from "./benchmark/types.js"
import type { BenchmarkManifest } from "./benchmark/types.js"
import { runDevelopmentBenchmarkForCommit } from "./development-benchmark.js"

function log(hooks: RsiHooks, line: string): void {
	(hooks.log ?? ((message) => process.stdout.write(`${message}\n`)))(line)
}

function isTerminal(candidate: CandidateRecord): boolean {
	return candidate.status === "accepted" || candidate.status === "rejected" || candidate.status === "failed"
}

class CandidateLineageError extends Error {}

function validateCandidateParent(candidate: CandidateRecord, run: RsiRunRecord, config: RsiConfig, protocol: NonNullable<RsiRunRecord["developmentProofProtocol"]>): void {
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
	const violations = protectedPathViolations(inheritedPaths.toString("utf8").split("\0").filter(Boolean), config.protectedPaths)
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

function initialRun(config: RsiConfig, baseCommit: string, now: string): RsiRunRecord {
	const modelCandidateId = config.modelCandidateId ?? "model-base"
	return {
		runId: `rsi-${now.replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
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

async function waitForFleetJob(queue: PostgresRsiJobQueue, jobId: string, timeoutMs: number): Promise<FleetJob> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const job = await queue.getJob(jobId)
		if (!job) throw new Error(`fleet job ${jobId} disappeared`)
		if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job
		await delay(500)
	}
	await queue.cancel(jobId, "coordinator wait timeout")
	throw new Error(`fleet job ${jobId} exceeded coordinator timeout`)
}

function fleetPayload(config: RsiConfig, candidate: CandidateRecord, snapshot: { content: Buffer; snapshotCommit: string }, options: { campaignId?: string; boundedInference?: boolean } = {}): FleetJobPayload {
	const provider = config.roles?.worker?.provider === "openrouter" ? "openrouter" : "ollama"
	if (provider === "openrouter" && candidate.model !== RSI_OPENROUTER_MODEL) throw new Error(`RSI OpenRouter worker model must be pinned to ${RSI_OPENROUTER_MODEL}`)
	const inferenceLimits = provider === "openrouter" && options.boundedInference
		? openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(process.env, "mutation"), options.campaignId ?? "", {
			maxCalls: config.maxIterations,
			...(config.maxTokens ? { maxOutputTokensPerCall: config.maxTokens } : {}),
			maxDurationMs: config.commandTimeoutMs,
		})
		: undefined
	return {
		schemaVersion: 1,
		snapshotSha256: "", // replaced with the verified artifact digest before enqueue
		snapshotBytes: snapshot.content.byteLength,
		snapshotCommit: snapshot.snapshotCommit,
		task: config.mutationTask,
		model: candidate.model,
		provider,
		...(inferenceLimits ? { inferenceLimits } : {}),
		maxIterations: config.maxIterations,
		timeoutMs: config.commandTimeoutMs,
		protectedPaths: config.protectedPaths,
		candidate: {
			id: candidate.id, generation: candidate.generation, parent: candidate.parent,
			mutationKind: candidate.mutationKind, hypothesis: candidate.hypothesis,
			modelCandidateId: candidate.modelCandidateId, computePolicy: config.computePolicy,
		},
		regressionCommand: config.regressionCommand,
		evalCommands: config.evalCommands,
	}
}

function recordFleetInferenceUsage(candidate: CandidateRecord, resultValue: unknown, payload: FleetJobPayload, jobId: string): void {
	candidate.modelProvider = `openshell-${payload.provider ?? "ollama"}`
	if ((payload.provider ?? "ollama") !== "openrouter") return
	if (!resultValue || typeof resultValue !== "object" || !payload.inferenceLimits) throw new Error("OpenRouter fleet mutation result is missing its broker identity")
	const result = resultValue as { provider?: unknown; model?: unknown; inferenceReceipt?: Record<string, unknown> }
	const receipt = result.inferenceReceipt
	if (result.provider !== "openrouter" || result.model !== payload.model || !receipt || receipt.provider !== "openrouter" || receipt.jobId !== jobId || receipt.campaignId !== payload.inferenceLimits.campaignId || receipt.model !== payload.model || receipt.accounting !== "supervisor-enforced" || receipt.qualified !== true || !Array.isArray(receipt.returnedModels) || receipt.returnedModels.length !== 1 || receipt.returnedModels[0] !== payload.model) {
		throw new Error("OpenRouter fleet mutation result lacks a qualified receipt bound to the admitted provider, model, job and campaign")
	}
	const values = [receipt.calls, receipt.promptTokens, receipt.completionTokens, receipt.totalTokens, receipt.costUsd]
	if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) || !Number.isSafeInteger(receipt.calls) || !Number.isSafeInteger(receipt.promptTokens) || !Number.isSafeInteger(receipt.completionTokens) || !Number.isSafeInteger(receipt.totalTokens)) throw new Error("OpenRouter fleet mutation receipt contains malformed resource totals")
	candidate.inferenceUsage = {
		provider: "openrouter", model: payload.model, returnedModels: receipt.returnedModels as string[], calls: receipt.calls as number,
		promptTokens: receipt.promptTokens as number, completionTokens: receipt.completionTokens as number, totalTokens: receipt.totalTokens as number,
		costUsd: receipt.costUsd as number, accounting: "supervisor-enforced", qualified: true, jobId,
		campaignId: payload.inferenceLimits.campaignId,
	}
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

async function validateCurriculumOnFleet(
	tasks: RsiRunRecord["curriculumTasks"],
	config: RsiConfig,
	run: RsiRunRecord,
	queue: PostgresRsiJobQueue,
	now: () => string,
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
		const payload = fleetPayload(config, replayCandidate, snapshot)
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
		const completed = await waitForFleetJob(queue, job.jobId, requiredFleetJobLeaseMs("evaluation", config.commandTimeoutMs, 1) + 60_000)
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
		const payload = fleetPayload(config, { ...candidate, id: candidateId, baseCommit: snapshot.snapshotCommit }, snapshot)
		payload.snapshotSha256 = snapshotArtifact.sha256
		payload.task = "Run supervisor-generated adversarial checks for " + candidate.id
		payload.regressionCommand = "true"
		payload.evalCommands = [ADVERSARIAL_COMMAND]
		const idempotencyKey = run.runId + ":" + candidate.id + ":adversarial:" + testsArtifact.sha256
		const expected = {
			idempotencyKey, runId: run.runId, candidateId, jobKind: "evaluation" as const,
			resourceClass: "CPU" as const, concurrencyKey: "adversarial:" + candidate.id,
			artifactSha256: snapshotArtifact.sha256, payload,
		}
		let job = await queue.getJobByIdempotencyKey(idempotencyKey)
		if (!job) job = await queue.enqueue({ ...expected, payload })
		if (!fleetJobMatches(job, expected)) throw new Error("existing adversarial evaluation idempotency key has mismatched test artifact or execution payload")
		const completed = await waitForFleetJob(queue, job.jobId, requiredFleetJobLeaseMs("evaluation", config.commandTimeoutMs, 1) + 60_000)
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

async function evaluateBaselineLocal(config: RsiConfig, baseCommit: string, runner: RsiHooks["runCommand"]): Promise<NonNullable<RsiRunRecord["baselineEvaluation"]>> {
	const name = `rsi-baseline-${randomUUID().slice(0, 12)}`
	const baselineRoot = path.join(config.repoRoot, ".worktrees", name)
	execFileSync("git", ["worktree", "add", "--detach", baselineRoot, baseCommit], { cwd: config.repoRoot, stdio: "pipe" })
	try {
		return await evaluateCandidate(config, baselineRoot, baseCommit, runner)
	} finally {
		execFileSync("git", ["worktree", "remove", "--force", baselineRoot], { cwd: config.repoRoot, stdio: "pipe" })
	}
}

async function evaluateBaselineFleet(
	config: RsiConfig,
	baseCommit: string,
	queue: PostgresRsiJobQueue,
	runId: string,
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
	const payload = fleetPayload(config, baseline, snapshot)
	payload.snapshotSha256 = artifact.sha256
	const expected: FleetJobIdentity = {
		idempotencyKey, runId, candidateId: "baseline", jobKind: "evaluation",
		resourceClass: "CPU", concurrencyKey: "eval:baseline", artifactSha256: artifact.sha256, payload,
	}
	const existing = await queue.getJobByIdempotencyKey(idempotencyKey)
	const job = existing ?? await queue.enqueue(expected)
	if (!fleetJobMatches(job, expected)) throw new Error("existing baseline evaluation idempotency key has mismatched execution identity or payload")

	const completed = await waitForFleetJob(queue, job.jobId, requiredFleetJobLeaseMs("evaluation", config.commandTimeoutMs, config.evalCommands.length + 2) + 60_000)
	if (completed.status !== "completed" || !completed.result || typeof completed.result !== "object") throw new Error(completed.error ?? `fleet baseline evaluation ended ${completed.status}`)
	const evaluation = fleetEvaluationResult(completed.result)
	const trials = [evaluation.regression, evaluation.typecheck, ...evaluation.visible]
	let resultIndex = 0
	const baselineRoot = path.join(config.repoRoot, ".worktrees", `rsi-baseline-${randomUUID().slice(0, 12)}`)
	execFileSync("git", ["worktree", "add", "--detach", baselineRoot, baseCommit], { cwd: config.repoRoot, stdio: "pipe" })
	try {
		return await evaluateCandidate(config, baselineRoot, baseCommit, async () => trials[resultIndex++] as TrialResult)
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
	}
	const now = hooks.now ?? (() => new Date().toISOString())
	const archive = await readArchive(config.archiveDir)
	const roles = resolveRoles(config.roles, process.env, config.model)
	const workerModel = roles.worker?.model ?? config.model
	const workerProvider = roles.worker?.provider === "openrouter" ? "openshell-openrouter" : "openshell-ollama"
	if (workerProvider === "openshell-openrouter" && workerModel !== RSI_OPENROUTER_MODEL) throw new Error(`RSI OpenRouter worker model must be pinned to ${RSI_OPENROUTER_MODEL}`)
	const resumed = config.resumeRunId ? await findActiveRun(config.archiveDir, config.resumeRunId) : undefined
	if (config.resumeRunId && !resumed) throw new Error(`no active RSI run found for --resume ${config.resumeRunId}`)
	const baseCommit = resumed?.baseCommit ?? (await resolveBaseCommit(config))
	const run = resumed ?? initialRun({ ...config, model: workerModel, roles }, baseCommit, now())
	const stageCount = config.computePolicy === "adaptive-independent" ? 2 : config.generations
	run.generations = stageCount
	run.model = workerModel
	run.parentSelectionPolicy = config.parentSelectionPolicy ?? run.parentSelectionPolicy ?? "champion-specialist-novelty"
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
	const runConfig: RsiConfig = { ...config, model: workerModel, roles, seed: `${config.seed}-${run.runId.slice(-8)}` }
	const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
	const proofFixturesRoot = path.join(packageRoot, "fixtures", "rsi-benchmark")
	const loadedProofBenchmark = hooks.runDevelopmentBenchmark
		? await fs.readFile(path.join(proofFixturesRoot, "manifest.json"), "utf8").then((rawManifest) => ({ manifest: JSON.parse(rawManifest) as BenchmarkManifest, manifestDigest: createHash("sha256").update(rawManifest).digest("hex") }))
		: await loadBenchmark(proofFixturesRoot, config.repoRoot)
	const proofProtocol = freezeDevelopmentProofProtocol(
		loadedProofBenchmark.manifest,
		loadedProofBenchmark.manifestDigest,
		{ provider: workerProvider, id: workerModel, sampling: { temperature: 0, think: false, seed: "provider-default" } },
		config.developmentProofRule,
	)
	if (resumed && !resumed.developmentProofProtocol) throw new Error("cannot resume an RSI run without its frozen development proof protocol")
	if (resumed && resumed.developmentProofProtocol?.protocolDigest !== proofProtocol.protocolDigest) throw new Error("development proof protocol differs from the frozen protocol on this run")
	run.developmentProofProtocol ??= proofProtocol
	run.confirmationEvidence = "unmeasured"
	const proofAttemptCache = new Map<string, Promise<BenchmarkAttempt[]>>()
	const runDevelopmentProof = async (harnessCommit: string, evidenceRunId = run.runId): Promise<DevelopmentTaskCell[]> => {
		const cacheKey = `${evidenceRunId}\0${harnessCommit}`
		const cached = proofAttemptCache.get(cacheKey)
		if (cached) return developmentCells(await cached)
		try {
			execFileSync("git", ["merge-base", "--is-ancestor", run.baseCommit, harnessCommit], { cwd: config.repoRoot, stdio: "ignore" })
		} catch { throw new Error(`development proof harness ${harnessCommit} is outside run base lineage ${run.baseCommit}`) }
		const lineagePaths = execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", run.baseCommit, harnessCommit], { cwd: config.repoRoot, encoding: "buffer" }) as Buffer
		const lineageViolations = protectedPathViolations(lineagePaths.toString("utf8").split("\0").filter(Boolean), config.protectedPaths)
		if (lineageViolations.length > 0) throw new Error(`development proof harness changes protected paths relative to the run base: ${lineageViolations.join(", ")}`)
		const pending = hooks.runDevelopmentBenchmark
			? hooks.runDevelopmentBenchmark({ harnessCommit, model: workerModel, outputRoot: path.join(config.archiveDir, "development-proof", evidenceRunId, proofProtocol.protocolDigest), protocol: proofProtocol })
			: runDevelopmentBenchmarkForCommit({ repoRoot: config.repoRoot, fixturesRoot: proofFixturesRoot, outputRoot: path.join(config.archiveDir, "development-proof", evidenceRunId, proofProtocol.protocolDigest), harnessCommit, model: workerModel, provider: workerProvider, campaignId: `proof-${evidenceRunId}-${proofProtocol.protocolDigest.slice(0, 16)}` })
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
	if (!config.dryRun && workerProvider === "openshell-openrouter" && !fleetQueue) throw new Error("RSI OpenRouter inference requires the supervised fleet broker path")
	if (!config.dryRun && config.roles?.adversary && !fleetQueue) throw new Error("RSI adversarial break tests require the OpenShell fleet evaluation path")
	const commandRunner = hooks.runCommand ?? (fleetQueue ? undefined : createOpenShellCommandRunner(runConfig))
	try {
	if (fleetQueue) {
		if (fleetQueue.artifactBackend !== "s3") throw new Error("RSI production runs require a shared S3-compatible artifact store")
		await fleetQueue.migrate()
		if (await fleetQueue.activeWorkerCount() < 1) throw new Error("no live OpenShell RSI worker is registered for the configured queue")
	}
	if (resumed && !fleetQueue) recoverInterruptedCandidates(run, now())
	if (!config.dryRun && !run.baselineEvaluation) {
		run.baselineEvaluation = fleetQueue
			? await evaluateBaselineFleet(runConfig, baseCommit, fleetQueue, run.runId)
			: await evaluateBaselineLocal(runConfig, baseCommit, commandRunner)
		run.baselineFitness = computeFitness(run.baselineEvaluation)
		run.baseline = run.baselineEvaluation.regression
		log(hooks, `[rsi] baseline: ${run.baseline.ok ? "pass" : "fail"}`)
		await checkpointRun(config.archiveDir, run)
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
				await checkpointRun(config.archiveDir, run)
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
						const [childCells, parentCells, rootCells] = await Promise.all([
							runDevelopmentProof(childCommit, saved.runId),
							runDevelopmentProof(saved.immediateParent.referenceCommit, saved.runId),
							runDevelopmentProof(saved.originalBase.referenceCommit, saved.runId),
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
			if (!config.dryRun) await checkpointRun(config.archiveDir, run)
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
		await checkpointRun(config.archiveDir, run)

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
					const snapshot = createMutationSnapshotBundle(candidate.worktree, candidate.baseCommit, runConfig)
					const artifact = await fleetQueue.putArtifact(snapshot.content)
					const useOpenRouter = runConfig.roles?.worker?.provider === "openrouter"
					const payload = fleetPayload(runConfig, candidate, snapshot, { campaignId: run.runId, boundedInference: true })
					payload.snapshotSha256 = artifact.sha256
					const resourceClass = useOpenRouter ? "REMOTE_API" as const : "LOCAL_GPU" as const
					const concurrencyKey = `${useOpenRouter ? "openrouter" : "ollama"}:${candidate.model}`
					const expected: FleetJobIdentity = {
						idempotencyKey: key, runId: run.runId, candidateId: candidate.id,
						jobKind: "mutation", resourceClass, concurrencyKey,
						artifactSha256: artifact.sha256, payload,
					}
					const existing = await fleetQueue.getJobByIdempotencyKey(key)
					if (existing && !fleetJobMatches(existing, expected)) throw new Error("existing idempotent mutation job has mismatched execution identity, snapshot, or task payload")
					if (worktree.commits > 0) {
						const completed = existing
						if (completed?.candidateId !== candidate.id || completed.jobKind !== "mutation" || completed.status !== "completed" || !completed.result || typeof completed.result !== "object") {
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
						await checkpointRun(config.archiveDir, run)
						continue
					}
					const job = existing ?? await fleetQueue.enqueue(expected)
					if (!fleetJobMatches(job, expected)) throw new Error("enqueued mutation job does not match its expected execution identity or payload")
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
					await checkpointRun(config.archiveDir, run)
					if (fleetQueue) {
						const submitted = mutationJobs.get(candidate.id)
						if (!submitted) throw new Error("candidate mutation was not admitted to the RSI fleet queue")
						const completed = await waitForFleetJob(fleetQueue, submitted.jobId, config.commandTimeoutMs * 4 + 180_000)
						if (completed.status !== "completed" || !completed.result || typeof completed.result !== "object") throw new Error(completed.error ?? `fleet mutation ended ${completed.status}`)
						const result = completed.result as { patchSha256?: string; patchBytes?: number }
						if (!result.patchSha256 || !Number.isSafeInteger(result.patchBytes) || Number(result.patchBytes) < 1) throw new Error("fleet mutation result is missing its patch artifact reference")
						recordFleetInferenceUsage(candidate, completed.result, submitted.payload, completed.jobId)
						const patch = await fleetQueue.getArtifact(result.patchSha256)
						if (patch.byteLength !== result.patchBytes) throw new Error("fleet mutation patch length did not match result metadata")
						applyFleetMutationPatch(patch, candidate, runConfig)
					} else {
					await createCandidateWorktree(runConfig, candidate)
					managedWorktrees.add(candidate.id)
					const mutation = await (hooks.runMutation ?? runMutation)(candidate, runConfig)
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
			await checkpointRun(config.archiveDir, run)
		} catch (error) {
			candidate.status = "failed"
			candidate.failure = error instanceof Error ? error.message : String(error)
			candidate.updatedAt = now()
			job = transitionJob(job, "failed", now(), candidate.failure)
			replaceJob(run, job)
			await captureCandidate(candidate, runConfig, run, trajectories, now(), hooks)
			log(hooks, `[rsi] ${candidate.id}: mutation failed: ${candidate.failure}`)
			if (!config.keepWorktrees && managedWorktrees.has(candidate.id)) await removeCandidateWorktree(runConfig, candidate).catch(() => undefined)
			await checkpointRun(config.archiveDir, run)
		}
		await checkpointRun(config.archiveDir, run)
		}

		if (fleetQueue) {
			for (const candidate of candidates.filter((entry) => entry.status === "evaluating")) {
				try {
					const key = `${run.runId}:${candidate.id}:evaluation`
					const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidate.worktree, encoding: "utf8" }).trim()
					const snapshot = createEvaluationSnapshotBundle(candidate.worktree, head, runConfig)
					const artifact = await fleetQueue.putArtifact(snapshot.content)
					const payload = fleetPayload(runConfig, candidate, snapshot)
					payload.snapshotSha256 = artifact.sha256
					const expected: FleetJobIdentity = {
						idempotencyKey: key, runId: run.runId, candidateId: candidate.id,
						jobKind: "evaluation", resourceClass: "CPU", concurrencyKey: `eval:${candidate.id}`,
						artifactSha256: artifact.sha256, payload,
					}
					const existing = await fleetQueue.getJobByIdempotencyKey(key)
					if (existing && !fleetJobMatches(existing, expected)) throw new Error("existing idempotent evaluation job has mismatched execution identity, snapshot, or evaluation configuration")
					const job = existing ?? await fleetQueue.enqueue(expected)
					if (!fleetJobMatches(job, expected)) throw new Error("enqueued evaluation job does not match its expected execution identity or payload")
					evaluationJobs.set(candidate.id, job)
				} catch (error) {
					candidate.status = "failed"
					candidate.failure = error instanceof Error ? error.message : String(error)
					candidate.updatedAt = now()
					log(hooks, `[rsi] ${candidate.id}: evaluation admission failed: ${candidate.failure}`)
					if (!config.keepWorktrees && managedWorktrees.has(candidate.id)) await removeCandidateWorktree(runConfig, candidate).catch(() => undefined)
					await checkpointRun(config.archiveDir, run)
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
					const completed = await waitForFleetJob(fleetQueue, submitted.jobId, requiredFleetJobLeaseMs("evaluation", config.commandTimeoutMs, config.evalCommands.length + 2) + 60_000)
					if (completed.status !== "completed" || !completed.result || typeof completed.result !== "object") throw new Error(completed.error ?? `fleet evaluation ended ${completed.status}`)
					const visible = fleetEvaluationResult(completed.result)
					const trials = [visible.regression, visible.typecheck, ...visible.visible]
					let resultIndex = 0
					evaluation = await evaluateCandidate(runConfig, candidate.worktree, candidate.baseCommit, async () => trials[resultIndex++] as Awaited<ReturnType<NonNullable<typeof hooks.runCommand>>>)
				} else {
					evaluation = await evaluateCandidate(runConfig, candidate.worktree, candidate.baseCommit, commandRunner)
				}
				if (runConfig.roles?.adversary) {
					if (!fleetQueue) throw new Error("adversarial break tests require an OpenShell fleet worker")
					const review = await runAdversarialStage(candidate, evaluation, runConfig, run, fleetQueue, hooks, now)
					run.adversarialReviews ??= []
					run.adversarialReviews.push(review)
					evaluation.adversarialPass = review.status === "passed" && review.testResults.length > 0 && review.testResults.every((entry) => entry.passed)
					evaluation.adversarialPenalty = review.penaltyPoints
					await checkpointRun(config.archiveDir, run)
				}
				candidate.changedFiles = evaluation.changedFiles
				candidate.commits = candidate.commits.length > 0 ? candidate.commits : await candidateCommits(candidate.worktree, candidate.baseCommit)
				candidate.result = evaluation.regression
				candidate.fitness = computeFitness({ ...evaluation, protectedPathViolation: candidate.protectedPathViolations.length > 0 })
				if (run.baselineEvaluation) candidate.pairedComparison = comparePairedEvaluation(run.baselineEvaluation, evaluation)
				const childCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidate.worktree, encoding: "utf8" }).trim()
				const parentCommit = candidate.parentCommit ?? candidate.baseCommit
				validateCandidateParent(candidate, run, config, proofProtocol)
				if (Object.values(candidate.fitness.hardGates).some((passed) => passed === false)) {
					const empty: DevelopmentTaskCell[] = []
					const immediateParent = compareDevelopmentAttempts({ protocol: proofProtocol, childCommit, referenceCommit: parentCommit, referenceKind: "immediate-parent", child: empty, reference: empty })
					const originalBase = compareDevelopmentAttempts({ protocol: proofProtocol, childCommit, referenceCommit: run.baseCommit, referenceKind: "original-base", child: empty, reference: empty })
					candidate.developmentProof = candidateProofDecision({ runId: run.runId, protocol: proofProtocol, child: empty, parent: empty, originalBase: empty, immediateParent, originalBaseComparison: originalBase })
					candidate.developmentProof.reason = "development benchmark skipped because regression, typecheck, or evaluator hard gate failed"
				} else {
					const [childCells, parentCells, rootCells] = await Promise.all([
						runDevelopmentProof(childCommit),
						runDevelopmentProof(parentCommit),
						runDevelopmentProof(run.baseCommit),
					])
					const immediateParent = compareDevelopmentAttempts({ protocol: proofProtocol, childCommit, referenceCommit: parentCommit, referenceKind: "immediate-parent", child: childCells, reference: parentCells })
					const originalBase = compareDevelopmentAttempts({ protocol: proofProtocol, childCommit, referenceCommit: run.baseCommit, referenceKind: "original-base", child: childCells, reference: rootCells })
					candidate.developmentProof = candidateProofDecision({ runId: run.runId, protocol: proofProtocol, child: childCells, parent: parentCells, originalBase: rootCells, immediateParent, originalBaseComparison: originalBase })
				}
				candidate.status = candidate.fitness.score > 0 && candidate.developmentProof.accepted ? "accepted" : "rejected"
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
				await checkpointRun(config.archiveDir, run)
			}
		}

		const accepted = candidates.filter((candidate) => candidate.status === "accepted")
		const front = paretoFront(accepted)
		const ranked = [...accepted].sort((a, b) => compareFitness(b.fitness, a.fitness))
		run.selectedCandidates = front.map((candidate) => candidate.id)
		if (ranked[0]) run.selected = ranked[0].id
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
		await checkpointRun(config.archiveDir, run)
	}

	const merged = combinedArchive(archive, run)
	let curriculum = generateCurriculumProposals(merged, now())
	if (fleetQueue && !config.dryRun && curriculum.length > 0) {
		curriculum = await validateCurriculumOnFleet(curriculum, runConfig, run, fleetQueue, now)
		run.curriculumTasks = curriculum
		await checkpointRun(config.archiveDir, run)
	} else {
		run.curriculumTasks = curriculum
	}
	if (!config.dryRun && curriculum.length > 0) {
		await writeCurriculumProposals(curriculum, config.curriculumDir ?? `${config.archiveDir}/curriculum`)
	}
	if (!config.dryRun && trajectories.length > 0) {
		await exportTrajectoryDatasets(trajectories, `${config.trajectoryDir ?? `${config.archiveDir}/trajectories`}/datasets`)
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
		if (fleetQueue) await fleetQueue.close()
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
		process.stdout.write(`[rsi] complete: ${run.runId}; selected=${run.selected ?? "none"}\n`)
		return run.selected || parsed.config.dryRun ? 0 : 1
	} catch (error) {
		process.stderr.write(`headlesscode improve: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
}
