import assert from "node:assert/strict"

import { runMain } from "../../test-runner.js"
import { initialRun } from "../controller-candidates.js"
import { planGenerationCandidates } from "../controller-planning.js"
import type {
	CandidateRecord,
	RsiArchive,
	RsiConfig,
	RsiRunRecord,
} from "../types.js"
import { candidate, metrics } from "./fixtures.js"

function config(overrides: Record<string, unknown> = {}): RsiConfig {
	return {
		model: "qwen",
		baseRef: "main",
		generations: 2,
		population: 3,
		seed: "seed",
		worktreeDir: "/tmp/rsi-test-worktrees",
		dryRun: false,
		...overrides,
	} as unknown as RsiConfig
}

function archive(candidates: CandidateRecord[]): RsiArchive {
	return { candidates } as unknown as RsiArchive
}

function run(cfg: RsiConfig): RsiRunRecord {
	return initialRun(cfg, "base", "2026-01-01T00:00:00Z")
}

interface Harness {
	logs: string[]
	calls: () => number
	log: (message: string) => void
	checkpoint: () => Promise<void>
}

function harness(): Harness {
	const logs: string[] = []
	let checkpoints = 0
	return {
		logs,
		calls: () => checkpoints,
		log: (message: string) => void logs.push(message),
		checkpoint: async () => void (checkpoints += 1),
	}
}

function plan(
	cfg: RsiConfig,
	r: RsiRunRecord,
	h: Harness,
	generation: number,
): Promise<CandidateRecord[]> {
	return planGenerationCandidates({
		archive: archive([]),
		run: r,
		config: cfg,
		runConfig: cfg,
		generation,
		now: () => "2026-01-01T00:00:00Z",
		log: h.log,
		checkpoint: h.checkpoint,
	})
}

async function generationZeroPlansPopulation(): Promise<void> {
	const cfg = config()
	const h = harness()
	const r = run(cfg)
	const planned = await plan(cfg, r, h, 0)
	assert.equal(planned.length, 3)
	assert.deepEqual(planned.map((entry) => entry.baseCommit),
		["base", "base", "base"])
	assert.equal(r.candidates.length, 3)
	assert.deepEqual(r.parentChoices, {})
	assert.equal(h.calls(), 1)
	assert.ok(h.logs[0].includes("planning 3 candidate(s)"))
}

async function selectedBaseFallsBackToFirstCommit(): Promise<void> {
	const cfg = config({ population: 1 })
	const h = harness()
	const r = run(cfg)
	r.candidates.push(candidate("a", metrics({}), 80))
	r.selected = "a"
	const planned = await plan(cfg, r, h, 0)
	assert.equal(planned[0].baseCommit, "commit-a")
}

async function laterGenerationRecordsParentChoices(): Promise<void> {
	const cfg = config({ population: 2, parentSelectionPolicy: "all-eligible" })
	const h = harness()
	const r = run(cfg)
	const prior = [
		candidate("a", metrics({}), 80), candidate("b", metrics({}), 82),
	]
	r.candidates.push(...prior)
	const planned = await plan(cfg, r, h, 1)
	assert.equal(planned.length, 2)
	assert.deepEqual(planned.map((entry) => entry.baseCommit),
		["commit-b", "commit-a"])
	assert.equal(Object.keys(r.parentChoices ?? {}).length, 2)
}

async function adaptiveIndependentPlansSingle(): Promise<void> {
	const cfg = config({ computePolicy: "adaptive-independent" })
	const h = harness()
	const planned = await plan(cfg, run(cfg), h, 1)
	assert.equal(planned.length, 1)
}

async function dryRunSkipsCheckpoint(): Promise<void> {
	const cfg = config({ dryRun: true })
	const h = harness()
	const r = run(cfg)
	const planned = await plan(cfg, r, h, 0)
	assert.equal(planned.length, 3)
	assert.equal(r.candidates.length, 3)
	assert.equal(h.calls(), 0)
}

const tests: Array<[string, () => Promise<void>]> = [
	["generation zero plans population", generationZeroPlansPopulation],
	["selected base falls back to first commit",
		selectedBaseFallsBackToFirstCommit],
	["later generation records parent choices",
		laterGenerationRecordsParentChoices],
	["adaptive independent plans single", adaptiveIndependentPlansSingle],
	["dry run skips checkpoint", dryRunSkipsCheckpoint],
]

runMain("controller-planning", tests)
