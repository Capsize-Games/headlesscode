import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { runMain } from "../../test-runner.js"
import { validateCurriculumOnFleet } from "../controller-curriculum-replay.js"
import {
	finalizeRunReporting,
	type ReportingCampaign,
} from "../controller-reporting.js"
import type { RsiArchive, RsiConfig, RsiRunRecord } from "../types.js"

function archive(): RsiArchive {
	return {
		schemaVersion: 2, updatedAt: "now", runs: [], activeRuns: [],
		candidates: [], modelCandidates: [], combinations: [], jobs: [],
		trajectoryRefs: [], curriculumTasks: [],
	}
}

function run(overrides: Partial<RsiRunRecord> = {}): RsiRunRecord {
	return {
		runId: "run-1",
		startedAt: "2026-01-01T00:00:00Z",
		model: "test-model",
		baseRef: "main",
		baseCommit: "abc123",
		generations: 0,
		candidates: [],
		reports: [],
		...overrides,
	} as RsiRunRecord
}

function config(
	archiveDir: string, overrides: Partial<RsiConfig> = {},
): RsiConfig {
	return {
		repoRoot: archiveDir,
		model: "test-model",
		archiveDir,
		worktreeDir: path.join(archiveDir, "worktrees"),
		baseRef: "main",
		seed: "s",
		dryRun: false,
		keepWorktrees: false,
		evalCommands: [],
		hiddenEvalCommands: [],
		protectedPaths: [],
		...overrides,
	} as unknown as RsiConfig
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-reporting-"))
	try {
		await fn(dir)
	} finally {
		await fsp.rm(dir, { recursive: true, force: true })
	}
}

function finalize(
	dir: string,
	r: RsiRunRecord,
	dryRun: boolean,
	campaign?: ReportingCampaign,
): Promise<boolean> {
	const cfg = config(dir, { dryRun })
	return finalizeRunReporting({
		run: r,
		config: cfg,
		runConfig: cfg,
		archive: archive(),
		trajectories: [],
		...(campaign ? { campaign } : {}),
		now: () => "2026-01-02T00:00:00Z",
		checkpoint: async () => {},
	})
}

function campaignRun(phaseMode?: string): RsiRunRecord {
	return run({
		proofCampaign: {
			manifest: phaseMode ? { phaseMode } : {},
			manifestSha256: "m",
			campaignId: "c",
			armId: "a",
			state: "running",
		} as RsiRunRecord["proofCampaign"],
	})
}

function fakeCampaign(snapshot: unknown): ReportingCampaign {
	return {
		store: {
			finishDevelopmentArm: async () => {},
			snapshot: async () => snapshot,
		} as never,
		lease: { campaignId: "c" } as never,
		assertLease: async () => {},
	}
}

async function dryRunWritesNothing(dir: string): Promise<void> {
	const r = run()
	const early = await finalize(dir, r, true)
	assert.equal(early, false)
	assert.deepEqual(r.curriculumTasks, [])
	assert.equal(fs.existsSync(path.join(dir, "run-1.md")), false)
}

async function normalPathDefersReport(dir: string): Promise<void> {
	const r = run()
	const early = await finalize(dir, r, false)
	assert.equal(early, false)
	assert.deepEqual(r.curriculumTasks, [])
	assert.equal(fs.existsSync(path.join(dir, "run-1.md")), false)
}

async function engineeringOnlyExitsEarly(dir: string): Promise<void> {
	const r = campaignRun("engineering-only")
	const campaign = fakeCampaign({ arms: 1 })
	const early = await finalize(dir, r, false, campaign)
	assert.equal(early, true)
	assert.equal(r.proofCampaign?.state, "finished")
	assert.deepEqual(r.proofCampaign?.ledgerSnapshot, { arms: 1 })
	assert.equal(fs.existsSync(path.join(dir, "run-1.md")), true)
}

async function evaluatedCampaignContinues(dir: string): Promise<void> {
	const r = campaignRun()
	const campaign = fakeCampaign({})
	const early = await finalize(dir, r, false, campaign)
	assert.equal(early, false)
	assert.equal(r.proofCampaign?.state, "evaluated")
}

async function emptyValidationShortCircuits(): Promise<void> {
	const validated = await validateCurriculumOnFleet({
		tasks: [], config: config("/tmp/x"), run: run(), queue: {} as never,
		now: () => "now", evaluatorRuntime: { imageDigest: "i", policySha256: "p" },
	})
	assert.deepEqual(validated, [])
}

const tests: Array<[string, () => Promise<void>]> = [
	["dry run writes nothing", () => withTmpDir(dryRunWritesNothing)],
	["normal path defers report", () => withTmpDir(normalPathDefersReport)],
	["engineering-only exits early", () => withTmpDir(engineeringOnlyExitsEarly)],
	["evaluated campaign continues", () => withTmpDir(evaluatedCampaignContinues)],
	["empty validation short-circuits", emptyValidationShortCircuits],
]

runMain("controller-reporting", tests)
