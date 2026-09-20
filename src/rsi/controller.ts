import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { appendRun, checkpointRun, findActiveRun, readArchive } from "./archive.js"
import { parseRsiArgs, rsiHelp } from "./config.js"
import { generateCurriculumProposals, writeCurriculumProposals } from "./curriculum.js"
import { evaluateCandidate, runCommand } from "./evaluator.js"
import { computeFitness, compareFitness } from "./fitness.js"
import { baseModelCandidate, createCombination } from "./models.js"
import { runMutation } from "./mutation.js"
import { formatRunReport } from "./reports.js"
import { protectedPathViolations } from "./sandbox.js"
import { resolveRoles } from "./roles.js"
import { newExperimentJob, paretoFront, selectParentChoices, transitionJob } from "./selection.js"
import { captureCandidateTrajectory, exportTrajectoryDatasets } from "./trajectory.js"
import type { CandidateRecord, ExperimentJob, RsiArchive, RsiConfig, RsiHooks, RsiRunRecord, TrajectoryRecord } from "./types.js"
import {
	candidateCommits,
	changedFiles,
	createCandidateWorktree,
	newCandidate,
	removeCandidateWorktree,
	resolveBaseCommit,
} from "./workspace.js"

function log(hooks: RsiHooks, line: string): void {
	(hooks.log ?? ((message) => process.stdout.write(`${message}\n`)))(line)
}

function isTerminal(candidate: CandidateRecord): boolean {
	return candidate.status === "accepted" || candidate.status === "rejected" || candidate.status === "failed"
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
		candidates: [],
		reports: [],
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

export async function runRsi(config: RsiConfig, hooks: RsiHooks = {}): Promise<RsiRunRecord> {
	const now = hooks.now ?? (() => new Date().toISOString())
	const archive = await readArchive(config.archiveDir)
	const roles = resolveRoles(config.roles, process.env, config.model)
	const workerModel = roles.worker?.model ?? config.model
	const resumed = config.resumeRunId ? await findActiveRun(config.archiveDir, config.resumeRunId) : undefined
	if (config.resumeRunId && !resumed) throw new Error(`no active RSI run found for --resume ${config.resumeRunId}`)
	const baseCommit = resumed?.baseCommit ?? (await resolveBaseCommit(config))
	const run = resumed ?? initialRun({ ...config, model: workerModel, roles }, baseCommit, now())
	run.generations = config.generations
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
	run.parentChoices ??= {}
	if (resumed) recoverInterruptedCandidates(run, now())
	const runConfig: RsiConfig = { ...config, model: workerModel, roles, seed: `${config.seed}-${run.runId.slice(-8)}` }
	const trajectories: TrajectoryRecord[] = []

	if (!config.dryRun && !run.baseline) {
		run.baseline = await (hooks.runCommand ?? runCommand)("npm test", config.repoRoot, config.commandTimeoutMs)
		log(hooks, `[rsi] baseline: ${run.baseline.ok ? "pass" : "fail"}`)
		await checkpointRun(config.archiveDir, run)
	}

	for (let generation = 0; generation < config.generations; generation++) {
		let candidates = run.candidates.filter((candidate) => candidate.generation === generation)
		if (candidates.length === 0) {
			const merged = combinedArchive(archive, run)
			const choices = generation === 0
				? []
				: selectParentChoices(merged, run.parentSelectionPolicy ?? "champion-specialist-novelty", config.population)
			const fallbackBase = run.selected
				? run.candidates.find((candidate) => candidate.id === run.selected)?.commits[0] ?? run.baseCommit
				: run.baseCommit
			candidates = Array.from({ length: config.population }, (_, index) => {
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

		for (const candidate of candidates) {
			if (isTerminal(candidate)) continue
			let job = run.jobs.find((entry) => entry.candidateId === candidate.id && entry.kind === "mutation")
			if (!job) {
				job = newExperimentJob("mutation", { class: "LOCAL_GPU", units: 1, concurrencyKey: "ollama" }, now(), candidate.id)
				run.jobs.push(job)
			}
			candidate.status = "mutating"
			candidate.updatedAt = now()
			job = transitionJob(job, "running", now())
			replaceJob(run, job)
			await checkpointRun(config.archiveDir, run)
			let worktreeCreated = false
			try {
				await createCandidateWorktree(runConfig, candidate)
				worktreeCreated = true
				const mutation = await (hooks.runMutation ?? runMutation)(candidate, runConfig)
				if (!mutation.ok) {
					candidate.status = "failed"
					candidate.failure = mutation.error
					candidate.result = mutation.result
					candidate.updatedAt = now()
					job = transitionJob(job, "failed", now(), mutation.error)
					replaceJob(run, job)
					await captureCandidate(candidate, runConfig, run, trajectories, now(), hooks)
					log(hooks, `[rsi] ${candidate.id}: mutation failed${mutation.error ? `: ${mutation.error}` : ""}`)
					continue
				}
				candidate.status = "evaluating"
				candidate.changedFiles = await changedFiles(candidate.worktree, candidate.baseCommit)
				candidate.commits = await candidateCommits(candidate.worktree, candidate.baseCommit)
				candidate.protectedPathViolations = protectedPathViolations(candidate.changedFiles, config.protectedPaths)
				const evaluation = await evaluateCandidate(runConfig, candidate.worktree, candidate.baseCommit, hooks.runCommand ?? runCommand)
				candidate.changedFiles = evaluation.changedFiles
				candidate.commits = candidate.commits.length > 0 ? candidate.commits : await candidateCommits(candidate.worktree, candidate.baseCommit)
				candidate.result = evaluation.regression
				candidate.fitness = computeFitness({ ...evaluation, protectedPathViolation: candidate.protectedPathViolations.length > 0 })
				candidate.status = candidate.fitness.score > 0 ? "accepted" : "rejected"
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
				candidate.status = "failed"
				candidate.failure = error instanceof Error ? error.message : String(error)
				candidate.updatedAt = now()
				job = transitionJob(job, "failed", now(), candidate.failure)
				replaceJob(run, job)
				log(hooks, `[rsi] ${candidate.id}: lifecycle failed: ${candidate.failure}`)
			} finally {
				if (worktreeCreated && !config.keepWorktrees) {
					try {
						await removeCandidateWorktree(runConfig, candidate)
					} catch (error) {
						log(hooks, `[rsi] ${candidate.id}: worktree cleanup failed: ${String(error)}`)
					}
				}
				await checkpointRun(config.archiveDir, run)
			}
		}

		const accepted = candidates.filter((candidate) => candidate.status === "accepted")
		const front = paretoFront(accepted)
		const ranked = [...accepted].sort((a, b) => compareFitness(b.fitness, a.fitness))
		run.selectedCandidates = front.map((candidate) => candidate.id)
		if (ranked[0]) run.selected = ranked[0].id
		await checkpointRun(config.archiveDir, run)
	}

	const merged = combinedArchive(archive, run)
	const curriculum = generateCurriculumProposals(merged, now())
	run.curriculumTasks = curriculum
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
