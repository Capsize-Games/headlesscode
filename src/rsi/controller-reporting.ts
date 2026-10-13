/**
 * End-of-run reporting for the RSI controller (issue #126):
 * curriculum validation/publication, trajectory dataset export,
 * campaign settlement, and the run report. Returns true when an
 * engineering-only campaign already finished the run (caller returns).
 */
import * as fs from "node:fs/promises"

import { appendRun } from "./archive.js"
import { combinedArchive } from "./controller-candidates.js"
import {
	validateCurriculumOnFleet,
	type EvaluatorId,
} from "./controller-curriculum-replay.js"
import {
	generateCurriculumProposals,
	writeCurriculumProposals,
} from "./curriculum.js"
import type { PostgresRsiJobQueue } from "./postgres-queue.js"
import type {
	PostgresProofCampaign,
	ProofCampaignArmLease,
} from "./proof-campaign.js"
import { formatRunReport } from "./reports.js"
import { exportTrajectoryDatasets } from "./trajectory.js"
import type {
	CurriculumTask,
	RsiArchive,
	RsiConfig,
	RsiRunRecord,
	TrajectoryRecord,
} from "./types.js"

export interface ReportingCampaign {
	store: PostgresProofCampaign
	lease: ProofCampaignArmLease
	assertLease: () => Promise<void>
}

export interface ReportingContext {
	run: RsiRunRecord
	config: RsiConfig
	runConfig: RsiConfig
	archive: RsiArchive
	trajectories: TrajectoryRecord[]
	fleetQueue?: PostgresRsiJobQueue
	evaluatorRuntime?: EvaluatorId
	campaign?: ReportingCampaign
	now: () => string
	checkpoint: () => Promise<void>
}

function needEvaluatorRuntime(
	runtime: EvaluatorId | undefined,
): asserts runtime is EvaluatorId {
	if (runtime) return
	throw new Error("fleet curriculum evaluation requires its frozen"
		+ " evaluator image and policy identity")
}

async function settleFleetCurriculum(
	ctx: ReportingContext,
): Promise<CurriculumTask[]> {
	const { run, config, runConfig, fleetQueue, evaluatorRuntime } = ctx
	const { now, checkpoint } = ctx
	const merged = combinedArchive(ctx.archive, run)
	const curriculum = generateCurriculumProposals(merged, now())
	const skip = !fleetQueue || config.dryRun || curriculum.length === 0
	if (skip) {
		run.curriculumTasks = curriculum
		return curriculum
	}
	needEvaluatorRuntime(evaluatorRuntime)
	const validated = await validateCurriculumOnFleet({ tasks: curriculum,
		config: runConfig, run, queue: fleetQueue, now, evaluatorRuntime })
	run.curriculumTasks = validated
	await checkpoint()
	return validated
}

async function persistRunOutputs(
	ctx: ReportingContext,
	curriculum: CurriculumTask[],
): Promise<void> {
	const { config, trajectories } = ctx
	if (config.dryRun) return
	if (curriculum.length > 0) {
		const dir = config.curriculumDir ?? `${config.archiveDir}/curriculum`
		await writeCurriculumProposals(curriculum, dir)
	}
	if (trajectories.length > 0) {
		const root = config.trajectoryDir ?? `${config.archiveDir}/trajectories`
		await exportTrajectoryDatasets(trajectories, `${root}/datasets`)
	}
}

async function finishCampaignArm(ctx: ReportingContext): Promise<boolean> {
	const { run, config, campaign, now } = ctx
	if (!campaign) return false
	await campaign.assertLease()
	await campaign.store.finishDevelopmentArm(campaign.lease)
	const snapshot = await campaign.store.snapshot(campaign.lease.campaignId)
	const manifest = run.proofCampaign?.manifest
	const engineeringOnly = manifest?.phaseMode === "engineering-only"
	const state = engineeringOnly ? "finished" : "evaluated"
	run.proofCampaign = { ...run.proofCampaign!, state, ledgerSnapshot: snapshot }
	if (!engineeringOnly) return false
	run.finishedAt = now()
	const reportPath = `${config.archiveDir}/${run.runId}.md`
	await fs.mkdir(config.archiveDir, { recursive: true })
	await fs.writeFile(reportPath, formatRunReport(run, config), "utf8")
	run.reports = [...new Set([...run.reports, reportPath])]
	await appendRun(config.archiveDir, run)
	return true
}

export async function finalizeRunReporting(
	ctx: ReportingContext,
): Promise<boolean> {
	const curriculum = await settleFleetCurriculum(ctx)
	await persistRunOutputs(ctx, curriculum)
	return finishCampaignArm(ctx)
}
