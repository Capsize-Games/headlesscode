/**
 * Unit tests for src/orchestrator/cost-estimate.ts — the cost-history-based
 * task cost estimator (issue #16): per-shape aggregation and per-group
 * expected cost/iteration estimates for `orchestrate --dry-run`. Plain
 * assert-based, pure functions only (no fs, no network). Run via `npm test`.
 */

import assert from "node:assert/strict"

import type { CostHistoryRecord } from "../cost-history.js"
import type { SplitIssue, WorktreeSpec } from "../split.js"
import {
	aggregateByShape,
	buildEstimateSection,
	estimateGroups,
	estimateIssue,
	MIN_SHAPE_SAMPLES,
} from "../cost-estimate.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Float-tolerant equality (medians of e.g. [0.2, 0.4] land on 0.30000000000000004). */
function assertClose(actual: number, expected: number, msg = ""): void {
	assert.ok(Math.abs(actual - expected) <= 1e-9, `${msg} expected ${actual} ~= ${expected}`)
}

function record(overrides: Partial<CostHistoryRecord> = {}): CostHistoryRecord {
	return {
		recordedAt: "2026-08-05T00:00:00.000Z",
		repo: "/tmp/repo",
		groupName: "w1",
		issues: [27],
		shapes: ["split"],
		status: "done",
		costUsd: 0.2,
		inputTokens: 2000,
		outputTokens: 200,
		cachedTokens: 0,
		iterations: 40,
		continuationCount: 0,
		reworkCount: 0,
		...overrides,
	}
}

function issue(number: number, title: string, body?: string): SplitIssue {
	return { number, title, body }
}

function spec(name: string, issues: number[]): WorktreeSpec {
	return { name, issues, taskFile: `${name}-issue${issues.join("-")}.md` }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testAggregateByShapeGroupsAndSkipsShapeless(): Promise<void> {
	const records = [
		record({ groupName: "g1", issues: [27], shapes: ["split"], costUsd: 0.2, iterations: 40, continuationCount: 0, reworkCount: 1 }),
		record({ groupName: "g2", issues: [28], shapes: ["split"], costUsd: 0.4, iterations: 60, continuationCount: 1, reworkCount: 0 }),
		record({ groupName: "g3", issues: [30], shapes: ["docs"], costUsd: 0.1, iterations: 20 }),
		// Written before issue #16's shapes field existed — must not contribute.
		record({ groupName: "g4", issues: [31], shapes: undefined, costUsd: 5.0 }),
	]
	const stats = aggregateByShape(records)
	assert.equal(stats.length, 2, "shapeless records must not create a shape bucket")
	const split = stats.find((s) => s.shape === "split")
	assert.ok(split, "split shape present")
	assert.equal(split?.samples, 2)
	assert.equal(split?.costMinUsd, 0.2)
	assertClose(split?.costMedianUsd ?? 0, 0.3, "median of [0.2, 0.4]")
	assert.equal(split?.costMaxUsd, 0.4)
	assertClose(split?.costPerIssueMedianUsd ?? 0, 0.3, "single-issue records: per-issue == group cost")
	assert.equal(split?.iterationsMedian, 50)
	assert.equal(split?.continuationRate, 0.5, "mean continuation cycles per group")
	assert.equal(split?.reworkRate, 0.5)
	const docs = stats.find((s) => s.shape === "docs")
	assert.equal(docs?.samples, 1)
	assert.equal(docs?.costMedianUsd, 0.1)
	// Sorted by samples descending: split (2) before docs (1).
	assert.equal(stats[0]?.shape, "split")
}

async function testAggregateByShapeMixedGroupCountsOncePerShape(): Promise<void> {
	// A group covering a split issue AND a docs issue is evidence about both
	// shapes — but must not be double-counted for either.
	const records = [record({ groupName: "g1", issues: [29, 36], shapes: ["split", "docs"], costUsd: 0.6, iterations: 90 })]
	const stats = aggregateByShape(records)
	assert.equal(stats.length, 2)
	for (const s of stats) {
		assert.equal(s.samples, 1, "a mixed group contributes once per shape")
		assert.equal(s.costPerIssueMedianUsd, 0.3, "per-issue cost normalizes across the group's 2 issues")
	}
}

async function testEstimateIssueDirectMatchBeatsShapeMatch(): Promise<void> {
	// Issue 7 was worked on before (a direct record); generic-shape records
	// also exist. The direct record must win even though it's a single sample.
	const records = [
		record({ groupName: "past", issues: [7], shapes: ["generic"], costUsd: 0.5, iterations: 70 }),
		record({ groupName: "a", issues: [1], shapes: ["generic"], costUsd: 0.1, iterations: 30 }),
		record({ groupName: "b", issues: [2], shapes: ["generic"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "c", issues: [3], shapes: ["generic"], costUsd: 0.3, iterations: 50 }),
	]
	const direct = estimateIssue(records, 7, "generic")
	assert.equal(direct.match, "direct")
	assert.equal(direct.samples, 1)
	assert.equal(direct.costPerIssueUsd, 0.5)
	assert.deepEqual(direct.costPerIssueRangeUsd, [0.5, 0.5])

	const byShape = estimateIssue(records, 8, "generic")
	assert.equal(byShape.match, "shape")
	assert.equal(byShape.samples, 4)
	assert.equal(byShape.costPerIssueUsd, 0.25, "median of the 4 generic records' per-issue costs")
	assert.deepEqual(byShape.costPerIssueRangeUsd, [0.1, 0.5])
}

async function testEstimateIssueShapeNeedsMinSamples(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [1], shapes: ["split"], costUsd: 0.1 }),
		record({ groupName: "b", issues: [2], shapes: ["split"], costUsd: 0.2 }),
	]
	const estimate = estimateIssue(records, 99, "split")
	assert.equal(estimate.match, "shape", "a partial sample set still reports the shape match...")
	assert.equal(estimate.samples, 2)
	assert.equal(estimate.costPerIssueUsd, undefined, "...but offers NO numbers below MIN_SHAPE_SAMPLES")
	assert.equal(MIN_SHAPE_SAMPLES, 3)
}

async function testEstimateIssueNoMatch(): Promise<void> {
	const estimate = estimateIssue([], 42, "docs")
	assert.equal(estimate.match, "none")
	assert.equal(estimate.samples, 0)
	assert.equal(estimate.costPerIssueUsd, undefined)
}

async function testEstimateGroupsSumsPerIssueIntoGroup(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["split"], costUsd: 0.4, iterations: 60 }),
	]
	const issues = [issue(29, "Split the big file into modules"), issue(36, "Decompose views.py too")]
	const groups = estimateGroups(records, [spec("w1", [29, 36])], issues)
	assert.equal(groups.length, 1)
	const g = groups[0]
	assert.equal(g.expectedCostUsd, 0.6, "two split issues at $0.30 per-issue median")
	assert.deepEqual(g.costRangeUsd, [0.4, 0.8], "sum of per-issue min/max across the two issues")
	assert.equal(g.expectedIterations, 100, "two issues at 50 iterations median")
	assert.deepEqual(g.shapes, ["split"])
	assert.equal(g.unmatched, 0)
}

async function testEstimateGroupsPartialMatchReportsUnmatched(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["split"], costUsd: 0.4, iterations: 60 }),
	]
	const issues = [issue(29, "Split the big file"), issue(12, "Add docs for the API")]
	const groups = estimateGroups(records, [spec("w1", [29, 12])], issues)
	assert.equal(groups[0]?.unmatched, 1, "the docs issue has no matching history")
	assert.equal(groups[0]?.expectedCostUsd, 0.3, "only the matched split issue contributes")
}

async function testBuildEstimateSectionEmptyHistory(): Promise<void> {
	const issues = [issue(1, "Fix the thing")]
	const groups = estimateGroups([], [spec("w1", [1])], issues)
	const lines = buildEstimateSection(groups, 0)
	assert.equal(lines.length, 1)
	assert.match(lines[0] ?? "", /no cost history recorded yet/)
}

async function testBuildEstimateSectionSufficientData(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["split"], costUsd: 0.4, iterations: 60 }),
	]
	const issues = [issue(29, "Split the big file into modules")]
	const groups = estimateGroups(records, [spec("w1", [29])], issues)
	const lines = buildEstimateSection(groups, records.length)
	assert.equal(lines.length, 2)
	assert.match(lines[0] ?? "", /w1 \(issues 29 — split\): expected ~\$0\.2000–\$0\.4000 · ~40–60 iterations · 3 sample\(s\)/)
	assert.match(lines[1] ?? "", /continuation\/rework: 0\.0 \/ 0\.0 cycles per group avg/)
}

async function testBuildEstimateSectionInsufficientData(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
	]
	const issues = [issue(29, "Split the big file into modules")]
	const groups = estimateGroups(records, [spec("w1", [29])], issues)
	const lines = buildEstimateSection(groups, records.length)
	assert.match(lines[0] ?? "", /insufficient data \(2 sample\(s\), need 3\) — no estimate yet/)
}

async function testBuildEstimateSectionNoHistoryForShape(): Promise<void> {
	// History exists overall, but nothing matches this issue's shape.
	const records = [record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 })]
	const issues = [issue(12, "Add docs for the API")]
	const groups = estimateGroups(records, [spec("w1", [12])], issues)
	const lines = buildEstimateSection(groups, records.length)
	assert.match(lines[0] ?? "", /no history for this shape yet/)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["aggregateByShape groups by shape, skips shapeless records, computes medians/rates", testAggregateByShapeGroupsAndSkipsShapeless],
	["aggregateByShape counts a mixed-shape group once per shape, normalizes per issue", testAggregateByShapeMixedGroupCountsOncePerShape],
	["estimateIssue: exact issue-number history beats shape matching", testEstimateIssueDirectMatchBeatsShapeMatch],
	["estimateIssue: shape matching needs MIN_SHAPE_SAMPLES before offering numbers", testEstimateIssueShapeNeedsMinSamples],
	["estimateIssue: no matching history -> match none", testEstimateIssueNoMatch],
	["estimateGroups sums per-issue medians into a group range", testEstimateGroupsSumsPerIssueIntoGroup],
	["estimateGroups reports unmatched issues as partial", testEstimateGroupsPartialMatchReportsUnmatched],
	["buildEstimateSection: empty history -> single no-history note", testBuildEstimateSectionEmptyHistory],
	["buildEstimateSection: sufficient data -> expected range + rates", testBuildEstimateSectionSufficientData],
	["buildEstimateSection: sparse data -> explicit insufficient-data note", testBuildEstimateSectionInsufficientData],
	["buildEstimateSection: unrelated shapes -> no-history-for-this-shape note", testBuildEstimateSectionNoHistoryForShape],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} cost-estimate tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
