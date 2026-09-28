import * as fs from "node:fs/promises"
import * as path from "node:path"

import { TEMPLATE_TEXT } from "../../src/monitoring/controller.js"
import { extractMonitorFeatures, sha256 } from "../../src/monitoring/features.js"
import { fitFrozenPredictor, predictFromFeatures, type LabeledWindow } from "../../src/monitoring/predictor.js"
import type { FrozenPredictorArtifact, PilotArm, PilotBoundary, PilotManifest, PilotOutcome } from "../../src/monitoring/types.js"
import { fixtureHash, PILOT_FIXTURES, splitHash, validateFixtureSplits } from "./fixtures.js"
import { ExclusiveRunnerLock, PilotJournal } from "./journal.js"
import { runFixture, sampleRandomBoundary } from "./simulator.js"
import { analyzePilot, type PilotAnalysis } from "./analyze.js"

const MODEL_DIGEST = "scripted-restricted-model@sha256:monitor-pilot-v1"
const SEEDS = [101, 202] as const
const BUDGET = {
	maxCalls: 16 as const,
	maxTokens: 20_000 as const,
	maxWallMs: 5 * 60_000 as const,
	globalMaxTokens: 2_000_000 as const,
	globalMaxWallMs: 10 * 60 * 60_000 as const,
}
const DEVELOPMENT_RUNS = 16 * SEEDS.length
const HELDOUT_RUNS = 8 * SEEDS.length * 4
const TOTAL_SCHEDULED_RUNS = DEVELOPMENT_RUNS + HELDOUT_RUNS

interface DevelopmentCollection {
	outcomes: PilotOutcome[]
	trainRows: LabeledWindow[]
	calibrationRows: LabeledWindow[]
	calibrationScores: number[]
}

function devFixtures() {
	return PILOT_FIXTURES.filter((fixture) => fixture.split === "train" || fixture.split === "calibration")
}

function testFixtures() {
	return PILOT_FIXTURES.filter((fixture) => fixture.split === "test")
}

function assertBudgetAdmission(): void {
	const reservedTokens = TOTAL_SCHEDULED_RUNS * BUDGET.maxTokens
	if (reservedTokens > BUDGET.globalMaxTokens) throw new Error(`STOP: full pilot allowance exceeds global token ceiling (${reservedTokens})`)
	const reservedWallMs = TOTAL_SCHEDULED_RUNS * BUDGET.maxWallMs
	if (reservedWallMs > BUDGET.globalMaxWallMs) throw new Error(`STOP: full pilot allowance exceeds global wall ceiling (${reservedWallMs})`)
}

async function recoverInterruptedJournals(outputDir: string): Promise<void> {
	let entries: import("node:fs").Dirent[]
	try {
		entries = await fs.readdir(outputDir, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const journalPath = path.join(outputDir, entry.name, "journal.jsonl")
		try {
			await fs.stat(journalPath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
			throw error
		}
		const journal = new PilotJournal(journalPath)
		await journal.open()
		const active = journal.activeAttempts()
		if (active.length > 0) {
			const experimentId = journal.list()[0]?.experimentId ?? entry.name
			await journal.abortActiveAttempts(experimentId)
		}
	}
}

async function appendOutcome(journal: PilotJournal, outcome: PilotOutcome, boundaries: readonly PilotBoundary[], labels?: readonly (0 | 1)[]): Promise<void> {
	for (const [index, boundary] of boundaries.entries()) {
		await journal.append("boundary", outcome.experimentId, {
			boundary,
			...(labels?.[index] === undefined ? {} : { label: labels[index] }),
		}, { runId: outcome.runId, attemptId: outcome.attemptId, epoch: outcome.epoch })
	}
	for (const [index, prediction] of outcome.predictionRecords.entries()) {
		await journal.append("prediction", outcome.experimentId, { boundarySequence: boundaries[index]?.sequence, prediction }, {
			runId: outcome.runId, attemptId: outcome.attemptId, epoch: outcome.epoch,
		})
	}
	for (const intervention of outcome.interventions) {
		await journal.append("intervention", outcome.experimentId, intervention as unknown as Record<string, unknown>, {
			runId: outcome.runId, attemptId: outcome.attemptId, epoch: outcome.epoch,
		})
	}
	await journal.append("outcome", outcome.experimentId, outcome as unknown as Record<string, unknown>, {
		runId: outcome.runId,
		attemptId: outcome.attemptId,
		epoch: outcome.epoch,
	})
}

async function collectDevelopment(experimentId: string, journal: PilotJournal): Promise<DevelopmentCollection> {
	const outcomes: PilotOutcome[] = []
	const trainRows: LabeledWindow[] = []
	const calibrationRows: LabeledWindow[] = []
	const calibrationScores: number[] = []
	for (const fixture of devFixtures()) {
		for (const seed of SEEDS) {
			const runId = `development-${fixture.id}-${seed}`
			const attemptId = `${runId}-attempt-1`
			await journal.append("attempt_started", experimentId, { fixtureId: fixture.id, split: fixture.split, arm: "B", seed }, { runId, attemptId, epoch: 1 })
			const boundaries: PilotBoundary[] = []
			const outcome = runFixture({
				experimentId,
				runId,
				attemptId,
				arm: "B",
				fixture,
				repetitionSeed: seed,
				onBoundary: (boundary) => {
					boundaries.push(boundary)
				},
			})
			const rows: LabeledWindow[] = boundaries.map((boundary, index) => ({
				features: extractMonitorFeatures(boundary),
				label: outcome.detectionLabels[index] ?? 0,
				trajectoryId: runId,
				boundarySequence: boundary.sequence,
			}))
			await appendOutcome(journal, outcome, boundaries, rows.map((row) => row.label))
			outcomes.push(outcome)
			if (fixture.split === "train") trainRows.push(...rows)
			else {
				calibrationRows.push(...rows)
				calibrationScores.push(...rows.map((row) => row.label))
			}
		}
	}
	return { outcomes, trainRows, calibrationRows, calibrationScores }
}

function freezeManifest(experimentId: string, predictor: FrozenPredictorArtifact | undefined, randomSchedule?: { probability: number; distribution: readonly { boundarySequence: number; weight: number }[] }): PilotManifest {
	return {
		schemaVersion: 1,
		experimentId,
		createdAt: new Date().toISOString(),
		modelDigest: MODEL_DIGEST,
		modelSettings: { temperature: 0, maxOutputTokens: 2_048, provider: "restricted-scripted-model", samplingSeedSupport: false },
		fixtureHash: fixtureHash(),
		splitHash: splitHash(),
		templatesHash: sha256(TEMPLATE_TEXT),
		featureOrder: predictor?.featureOrder ?? [],
		...(predictor ? { predictorHash: predictor.artifactHash, threshold: predictor.threshold } : {}),
		armAssignments: ["B", "M", "R", "G"],
		seeds: [...SEEDS],
		budget: BUDGET,
		...(randomSchedule ? { randomProbability: randomSchedule.probability, randomBoundaryDistribution: randomSchedule.distribution } : {}),
	}
}

async function runHeldout(experimentId: string, journal: PilotJournal, predictor: FrozenPredictorArtifact, randomSchedule: { probability: number; distribution: readonly { boundarySequence: number; weight: number }[] }): Promise<PilotOutcome[]> {
	const outcomes: PilotOutcome[] = []
	for (const fixture of testFixtures()) {
		for (const seed of SEEDS) {
			for (const arm of ["B", "M", "R", "G"] as PilotArm[]) {
				const runId = `heldout-${fixture.id}-${seed}-${arm}`
				const attemptId = `${runId}-attempt-1`
				const randomBoundarySequence = arm === "R" ? sampleRandomBoundary(seed, randomSchedule.probability, randomSchedule.distribution) : undefined
				await journal.append("attempt_started", experimentId, { fixtureId: fixture.id, split: fixture.split, arm, seed }, { runId, attemptId, epoch: 1 })
				const boundaries: PilotBoundary[] = []
				const outcome = runFixture({
					experimentId,
					runId,
					attemptId,
					arm,
					fixture,
					repetitionSeed: seed,
					predictor,
					randomProbability: randomSchedule.probability,
					randomBoundarySequence,
					onBoundary: (boundary) => boundaries.push(boundary),
				})
				await appendOutcome(journal, outcome, boundaries)
				outcomes.push(outcome)
			}
		}
	}
	return outcomes
}

export interface PilotRunResult {
	readonly experimentId: string
	readonly outputDir: string
	readonly manifest: PilotManifest
	readonly predictor?: FrozenPredictorArtifact
	readonly development: readonly PilotOutcome[]
	readonly heldout: readonly PilotOutcome[]
	readonly analysis?: PilotAnalysis
}

export async function runPilot(outputDir = path.resolve(".headlesscode/monitor-pilot")): Promise<PilotRunResult> {
	validateFixtureSplits()
	assertBudgetAdmission()
	const lock = new ExclusiveRunnerLock(path.join(outputDir, "runner.lock"))
	await lock.acquire()
	try {
		await recoverInterruptedJournals(outputDir)
		const experimentId = `monitor-pilot-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`
		const experimentDir = path.join(outputDir, experimentId)
		await fs.mkdir(experimentDir, { recursive: true })
		const journal = new PilotJournal(path.join(experimentDir, "journal.jsonl"))
		await journal.open()
		await journal.append("budget_admitted", experimentId, {
			scheduledRuns: TOTAL_SCHEDULED_RUNS,
			reservedTokens: TOTAL_SCHEDULED_RUNS * BUDGET.maxTokens,
			reservedWallMs: TOTAL_SCHEDULED_RUNS * BUDGET.maxWallMs,
			globalMaxTokens: BUDGET.globalMaxTokens,
			globalMaxWallMs: BUDGET.globalMaxWallMs,
		})
		const developmentManifest = freezeManifest(experimentId, undefined)
		await fs.writeFile(path.join(experimentDir, "development-manifest.json"), `${JSON.stringify(developmentManifest, null, 2)}\n`)
		const development = await collectDevelopment(experimentId, journal)
		const positiveTrain = development.trainRows.filter((row) => row.label === 1)
		const positiveCalibration = development.calibrationRows.filter((row) => row.label === 1)
		const insufficientReason = positiveTrain.length < 20 || new Set(positiveTrain.map((row) => row.trajectoryId)).size < 8
			? "data-insufficient training labels"
			: positiveCalibration.length < 10 || new Set(positiveCalibration.map((row) => row.trajectoryId)).size < 4
				? "data-insufficient calibration labels"
				: undefined
		if (insufficientReason !== undefined) {
			await journal.append("pilot_stopped", experimentId, {
				reason: insufficientReason,
				positiveTrain: positiveTrain.length,
				positiveTrainTrajectories: new Set(positiveTrain.map((row) => row.trajectoryId)).size,
				positiveCalibration: positiveCalibration.length,
				positiveCalibrationTrajectories: new Set(positiveCalibration.map((row) => row.trajectoryId)).size,
			})
			await fs.writeFile(path.join(experimentDir, "final-report.json"), `${JSON.stringify({ experimentId, manifest: developmentManifest, status: "STOP", reason: insufficientReason }, null, 2)}\n`)
			return { experimentId, outputDir: experimentDir, manifest: developmentManifest, development: development.outcomes, heldout: [] }
		}
		const predictor = fitFrozenPredictor(development.trainRows, development.calibrationRows, {
			modelDigest: MODEL_DIGEST,
			templatesHash: sha256(TEMPLATE_TEXT),
		})
		const calibrationTriggers = development.calibrationRows.filter((row) => {
			const prediction = predictFromFeatures(predictor, row.features)
			return prediction.abstentionReason === undefined && prediction.probability >= predictor.threshold
		})
		const distributionCounts = new Map<number, number>()
		for (const row of calibrationTriggers) {
			if (row.boundarySequence !== undefined) distributionCounts.set(row.boundarySequence, (distributionCounts.get(row.boundarySequence) ?? 0) + 1)
		}
		const randomSchedule = {
			probability: calibrationTriggers.length / Math.max(1, development.calibrationRows.length),
			distribution: [...distributionCounts.entries()].sort(([left], [right]) => left - right).map(([boundarySequence, weight]) => ({ boundarySequence, weight })),
		}
		const manifest = freezeManifest(experimentId, predictor, randomSchedule)
		await fs.writeFile(path.join(experimentDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
		await fs.writeFile(path.join(experimentDir, "predictor.json"), `${JSON.stringify(predictor, null, 2)}\n`)
		await journal.append("predictor_frozen", experimentId, { predictorHash: predictor.artifactHash, threshold: predictor.threshold, manifestHash: sha256(manifest) })
		await journal.append("random_schedule_frozen", experimentId, randomSchedule as unknown as Record<string, unknown>)
		const heldout = await runHeldout(experimentId, journal, predictor, randomSchedule)
		const analysis = analyzePilot([...development.outcomes, ...heldout], predictor, randomSchedule.probability)
		await fs.writeFile(path.join(experimentDir, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`)
		await fs.writeFile(path.join(experimentDir, "final-report.json"), `${JSON.stringify({ experimentId, manifest, analysis }, null, 2)}\n`)
		return { experimentId, outputDir: experimentDir, manifest, predictor, development: development.outcomes, heldout, analysis }
	} finally {
		await lock.release()
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runPilot().then((result) => {
		console.log(JSON.stringify({ experimentId: result.experimentId, outputDir: result.outputDir, analysis: result.analysis }, null, 2))
	}).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
