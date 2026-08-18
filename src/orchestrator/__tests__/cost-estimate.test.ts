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
	CI_CONFIG_HIGHER_BOUND_MULTIPLIER,
	estimateGroups,
	estimateIssue,
	isCiConfigChange,
	isVerificationHeavy,
	lowConfidenceReason,
	MIN_SHAPE_SAMPLES,
	TEST_SHAPE_VERIFICATION_MULTIPLIER,
	VERIFICATION_MULTIPLIER_FULL_SAMPLES,
	verificationMultiplier,
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

// ─── Issue #124: verification-intensity multiplier ───────────────────────────

async function testIsVerificationHeavy(): Promise<void> {
	assert.equal(isVerificationHeavy("test", undefined), true, "test shape is verification-heavy by definition")
	assert.equal(isVerificationHeavy("split", undefined), false)
	assert.equal(
		isVerificationHeavy("coverage", issue(9, "COV-1: add GitHub Actions CI config")),
		true,
		"CI/GitHub Actions mention in the title marks the issue verification-heavy",
	)
	assert.equal(
		isVerificationHeavy("split", issue(10, "Split utils", "Adds a workflow that runs tests on a runner")),
		true,
		"workflow/runner mention in the body marks the issue verification-heavy",
	)
	assert.equal(isVerificationHeavy("docs", issue(11, "Document the API")), false)
}

async function testVerificationMultiplierTapersWithSamples(): Promise<void> {
	// Direct match: trusted as-is, no multiplier even for a test shape.
	assert.equal(verificationMultiplier("test", undefined, "direct", 1), 1, "direct match never scaled")
	// Not verification-heavy: no multiplier regardless of samples.
	assert.equal(verificationMultiplier("split", undefined, "shape", 3), 1)
	// Below MIN_SHAPE_SAMPLES the multiplier is CLAMPED at the full value —
	// regression (rework cycle 1): the old taper formula extrapolated below
	// MIN_SHAPE_SAMPLES, returning 3.5 at 1 sample and 3.0 at 2, above the
	// documented 2.5 cap. Thin-but-nonzero samples get the full scale, never
	// more.
	assertClose(
		verificationMultiplier("test", undefined, "shape", 1),
		TEST_SHAPE_VERIFICATION_MULTIPLIER,
		"1 sample clamps at the full multiplier, never above it",
	)
	assertClose(
		verificationMultiplier("test", undefined, "shape", 2),
		TEST_SHAPE_VERIFICATION_MULTIPLIER,
		"2 samples clamp at the full multiplier, never above it",
	)
	// Test shape at MIN_SHAPE_SAMPLES: full multiplier.
	assertClose(
		verificationMultiplier("test", undefined, "shape", MIN_SHAPE_SAMPLES),
		TEST_SHAPE_VERIFICATION_MULTIPLIER,
		"full multiplier at MIN_SHAPE_SAMPLES",
	)
	// Fully sampled: trusted as-is.
	assert.equal(
		verificationMultiplier("test", undefined, "shape", VERIFICATION_MULTIPLIER_FULL_SAMPLES),
		1,
		"no multiplier once real samples accumulate",
	)
	// Between the two: linear taper.
	const mid = verificationMultiplier("test", undefined, "shape", 4)
	assert.ok(mid > 1 && mid < TEST_SHAPE_VERIFICATION_MULTIPLIER, `mid-samples multiplier tapers (got ${mid})`)
	// No usable numeric estimate (0 samples): 1 (nothing to scale).
	assert.equal(verificationMultiplier("test", undefined, "shape", 0), 1)
}

async function testEstimateIssueTestShapeScalesCostNotIterations(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["test"], costUsd: 0.1, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["test"], costUsd: 0.2, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["test"], costUsd: 0.3, iterations: 60 }),
	]
	const estimate = estimateIssue(records, 99, "test", issue(99, "Add tests for the parser"))
	assert.equal(estimate.match, "shape")
	assert.equal(estimate.samples, 3)
	// Median per-issue cost $0.2 * 2.5 = $0.5; iterations NOT scaled.
	assertClose(estimate.costPerIssueUsd ?? 0, 0.2 * TEST_SHAPE_VERIFICATION_MULTIPLIER, "test-shape cost scaled up")
	assert.equal(estimate.iterationsPerIssue, 50, "iterations not scaled by the verification multiplier")
	assert.deepEqual(estimate.costPerIssueRangeUsd, [0.1 * 2.5, 0.3 * 2.5], "range scaled too")
	assertClose(estimate.verificationMultiplier ?? 0, TEST_SHAPE_VERIFICATION_MULTIPLIER, "multiplier recorded on the estimate")
}

async function testEstimateIssueCiMentionScalesEvenWithOtherShape(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["coverage"], costUsd: 0.1, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["coverage"], costUsd: 0.2, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["coverage"], costUsd: 0.3, iterations: 60 }),
	]
	// "COV-1"-style: a coverage-shaped issue whose remediation adds CI config.
	const estimate = estimateIssue(records, 99, "coverage", issue(99, "COV-1: add coverage with GitHub Actions CI"))
	assert.equal(estimate.match, "shape")
	assertClose(estimate.costPerIssueUsd ?? 0, 0.2 * TEST_SHAPE_VERIFICATION_MULTIPLIER, "CI-bearing issue cost scaled up")
}

async function testEstimateIssueWellSampledTestShapeNotScaled(): Promise<void> {
	const records = [1, 2, 3, 4, 5, 6, 7].map((n) =>
		record({ groupName: `g${n}`, issues: [n], shapes: ["test"], costUsd: 0.2, iterations: 50 }),
	)
	const estimate = estimateIssue(records, 99, "test", issue(99, "Add tests"))
	assert.equal(estimate.samples, 7)
	assertClose(estimate.costPerIssueUsd ?? 0, 0.2, "well-sampled test shape is trusted as-is")
	assert.equal(estimate.verificationMultiplier, 1)
}

async function testEstimateGroupsShowsVerificationMultiplier(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["test"], costUsd: 0.1, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["test"], costUsd: 0.2, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["test"], costUsd: 0.3, iterations: 60 }),
	]
	const issues = [issue(29, "Add tests for the API")]
	const groups = estimateGroups(records, [spec("w1", [29])], issues)
	assert.equal(groups[0]?.verificationMultiplier, TEST_SHAPE_VERIFICATION_MULTIPLIER)
	assertClose(groups[0]?.expectedCostUsd ?? 0, 0.2 * TEST_SHAPE_VERIFICATION_MULTIPLIER, "group cost includes the scaled issue")
	const lines = buildEstimateSection(groups, records.length)
	assert.match(lines[0] ?? "", /2\.50x verification multiplier/, "dry-run line names the multiplier")
}

async function testEstimateGroupsDoesNotSurfaceUnappliedMultiplier(): Promise<void> {
	// A mixed group: 1 test-shaped record (thin — below MIN_SHAPE_SAMPLES, so
	// the test issue contributes NO cost) + 3 split-shaped records (usable,
	// scaled 1.0). Regression (rework cycle 1): the old code surfaced the max
	// per-issue multiplier (3.5 at 1 sample) next to a cost it never scaled —
	// the "3.50x" on the dry-run line was a false claim exceeding the cap.
	const records = [
		record({ groupName: "t1", issues: [100], shapes: ["test"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "a", issues: [101], shapes: ["split"], costUsd: 0.1, iterations: 40 }),
		record({ groupName: "b", issues: [102], shapes: ["split"], costUsd: 0.2, iterations: 50 }),
		record({ groupName: "c", issues: [103], shapes: ["split"], costUsd: 0.3, iterations: 60 }),
	]
	const issues = [issue(29, "Add tests for the API"), issue(5, "Split the big file into modules")]
	const groups = estimateGroups(records, [spec("w1", [29, 5])], issues)
	const g = groups[0]
	assert.equal(g?.unmatched, 1, "the thin test issue contributes no usable cost")
	assertClose(g?.expectedCostUsd ?? 0, 0.2, "only the split issue contributes ($0.2 median, unscaled)")
	assert.equal(g?.verificationMultiplier, undefined, "no multiplier surfaces — nothing usable was scaled")
	const lines = buildEstimateSection(groups, records.length)
	assert.doesNotMatch(lines[0] ?? "", /verification multiplier/, "dry-run line must not claim a multiplier that never scaled the cost")
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

// ─── Issue #125: CI/config-change higher bound ───────────────────────────────

async function testIsCiConfigChangeMatchesTitleAndBody(): Promise<void> {
	assert.ok(isCiConfigChange(issue(1, "Add CI workflow for tests")), "title 'CI workflow'")
	assert.ok(isCiConfigChange(issue(2, "Fix the GitHub Actions runner config")), "title 'Actions runner'")
	assert.ok(
		isCiConfigChange(issue(3, "Bump deps", "The workflow file at .github/workflows/ci.yml needs updating")),
		"body 'workflow'",
	)
	assert.ok(!isCiConfigChange(issue(4, "Refactor user auth")), "plain refactor")
	assert.ok(!isCiConfigChange(issue(5, "Handle transactions safely")), "'transactions' contains 'actions' but is not CI")
}

async function testCiConfigIssueGetsFlaggedHigherBound(): Promise<void> {
	// 3 split records: the CI issue's shape estimate is a normal per-issue
	// median; its flagged higher bound is that median * multiplier, and the
	// group total's higher bound replaces the CI issue's contribution. The
	// title keeps the "split" shape ("Split ... actions ...") so it matches
	// the split records and trips CI_CONFIG_RE (\bactions\b) WITHOUT also
	// tripping CI_MENTION_RE's verification-heavy signal (issue #124), which
	// requires "github actions"/"ci"/"workflow"/"runner" as a unit — this
	// isolates the #125 flagged-bound behavior from the #124 cost multiplier
	// so the two independently-stacking features can each be tested alone.
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["split"], costUsd: 0.4, iterations: 60 }),
	]
	const issues = [issue(29, "Split the release actions into modules")]
	const groups = estimateGroups(records, [spec("w1", [29])], issues)
	const g = groups[0]
	const perIssue = g?.perIssue[0]
	assert.equal(perIssue?.ciConfig, true, "CI/config issue is flagged")
	assert.equal(perIssue?.costPerIssueUsd, 0.3, "plain shape estimate is still the split median")
	assertClose(
		perIssue?.higherBoundUsd ?? 0,
		0.3 * CI_CONFIG_HIGHER_BOUND_MULTIPLIER,
		"per-issue higher bound = median * multiplier",
	)
	assertClose(g?.higherBoundUsd ?? 0, 0.3 * CI_CONFIG_HIGHER_BOUND_MULTIPLIER, "group higher bound rolls the flagged issue in")
	assert.equal(g?.expectedCostUsd, 0.3, "expectedCostUsd stays the plain median")
}

async function testCiConfigHigherBoundMixesWithNonCiIssues(): Promise<void> {
	// One CI issue + one plain issue: the group higher bound = CI bound +
	// plain median; the plain expected total is the sum of both medians.
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["split"], costUsd: 0.4, iterations: 60 }),
	]
	const issues = [issue(29, "Split the release actions into modules"), issue(36, "Split the big file into modules")]
	const groups = estimateGroups(records, [spec("w1", [29, 36])], issues)
	const g = groups[0]
	assertClose(g?.expectedCostUsd ?? 0, 0.6, "both medians sum into the plain total")
	assertClose(
		g?.higherBoundUsd ?? 0,
		0.3 * CI_CONFIG_HIGHER_BOUND_MULTIPLIER + 0.3,
		"CI issue contributes its higher bound, the plain issue its median",
	)
}

async function testBuildEstimateSectionShowsCiHigherBound(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["split"], costUsd: 0.4, iterations: 60 }),
	]
	const issues = [issue(29, "Split the release actions into modules")]
	const groups = estimateGroups(records, [spec("w1", [29])], issues)
	const lines = buildEstimateSection(groups, records.length)
	assert.ok(
		lines.some((l) => l.includes("CI/config work: higher bound ~$0.9000")),
		`higher bound rendered on the estimate line: ${lines.join(" | ")}`,
	)
}

// ─── Issue #126: LOW-CONFIDENCE warnings ─────────────────────────────────────

async function testLowConfidenceFlaggedWhenIssuesUnmatched(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["split"], costUsd: 0.4, iterations: 60 }),
	]
	const issues = [issue(29, "Split the big file"), issue(12, "Add docs for the API")]
	const groups = estimateGroups(records, [spec("w1", [29, 12])], issues)
	const g = groups[0]
	assert.equal(g?.unmatched, 1)
	assert.equal(g?.lowConfidence, true, "an unmatched issue's excluded cost makes the total low-confidence")
	assert.match(lowConfidenceReason(g), /1 issue\(s\) unmatched/)
	const lines = buildEstimateSection(groups, records.length)
	assert.ok(
		lines.some((l) => l.includes("⚠ LOW-CONFIDENCE") && l.includes("unmatched")),
		`unmatched low-confidence rendered: ${lines.join(" | ")}`,
	)
}

async function testLowConfidenceFlaggedOnNoHistoryForShape(): Promise<void> {
	const records = [record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 })]
	const issues = [issue(12, "Add docs for the API")]
	const groups = estimateGroups(records, [spec("w1", [12])], issues)
	const g = groups[0]
	assert.equal(g?.lowConfidence, true, "no usable history -> low-confidence")
	assert.match(lowConfidenceReason(g), /no history for this shape yet/)
	const lines = buildEstimateSection(groups, records.length)
	assert.ok(
		lines.some((l) => l.includes("⚠ LOW-CONFIDENCE") && l.includes("no history")),
		`no-history low-confidence rendered: ${lines.join(" | ")}`,
	)
}

async function testLowConfidenceFlaggedOnInsufficientSamples(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
	]
	const issues = [issue(29, "Split the big file into modules")]
	const groups = estimateGroups(records, [spec("w1", [29])], issues)
	const g = groups[0]
	assert.equal(g?.lowConfidence, true, "2 samples < MIN_SHAPE_SAMPLES -> low-confidence")
	assert.match(lowConfidenceReason(g), /insufficient history/)
	const lines = buildEstimateSection(groups, records.length)
	assert.ok(
		lines.some((l) => l.includes("⚠ LOW-CONFIDENCE")),
		`insufficient-samples low-confidence rendered: ${lines.join(" | ")}`,
	)
}

async function testLowConfidenceNotFlaggedWithEnoughSamples(): Promise<void> {
	const records = [
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["split"], costUsd: 0.4, iterations: 60 }),
	]
	const issues = [issue(29, "Split the big file into modules")]
	const groups = estimateGroups(records, [spec("w1", [29])], issues)
	const g = groups[0]
	assert.equal(g?.lowConfidence, false, "3 samples, all matched -> solid estimate")
	const lines = buildEstimateSection(groups, records.length)
	assert.ok(
		!lines.some((l) => l.includes("LOW-CONFIDENCE")),
		`no LOW-CONFIDENCE marker on a solid estimate: ${lines.join(" | ")}`,
	)
}

async function testLowConfidenceFlaggedOnUnderSampledDirectMatch(): Promise<void> {
	// A direct issue-number match with a SINGLE record is offered (it IS
	// meaningful) but is an anecdote — low-confidence (issue #126).
	const records = [
		record({ groupName: "past", issues: [7], shapes: ["split"], costUsd: 0.5, iterations: 70 }),
		record({ groupName: "a", issues: [100], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		record({ groupName: "b", issues: [101], shapes: ["split"], costUsd: 0.3, iterations: 50 }),
		record({ groupName: "c", issues: [102], shapes: ["split"], costUsd: 0.4, iterations: 60 }),
	]
	const issues = [issue(7, "Re-open: add a CI workflow (was split before)")]
	const groups = estimateGroups(records, [spec("w1", [7])], issues)
	const g = groups[0]
	assert.equal(g?.perIssue[0]?.match, "direct")
	assert.equal(g?.perIssue[0]?.samples, 1)
	assert.equal(g?.lowConfidence, true, "single-record direct match is low-confidence")
	assert.match(lowConfidenceReason(g), /single-run anecdote/)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["aggregateByShape groups by shape, skips shapeless records, computes medians/rates", testAggregateByShapeGroupsAndSkipsShapeless],
	["aggregateByShape counts a mixed-shape group once per shape, normalizes per issue", testAggregateByShapeMixedGroupCountsOncePerShape],
	["estimateIssue: exact issue-number history beats shape matching", testEstimateIssueDirectMatchBeatsShapeMatch],
	["estimateIssue: shape matching needs MIN_SHAPE_SAMPLES before offering numbers", testEstimateIssueShapeNeedsMinSamples],
	["estimateIssue: no matching history -> match none", testEstimateIssueNoMatch],
	["isVerificationHeavy: test shape and CI mention detection (issue #124)", testIsVerificationHeavy],
	["verificationMultiplier: tapers from full multiplier to 1 as samples accumulate (issue #124)", testVerificationMultiplierTapersWithSamples],
	["estimateIssue: test shape scales COST, not iterations (issue #124)", testEstimateIssueTestShapeScalesCostNotIterations],
	["estimateIssue: CI/GitHub Actions mention scales cost even with another shape (issue #124)", testEstimateIssueCiMentionScalesEvenWithOtherShape],
	["estimateIssue: well-sampled test shape is trusted as-is (issue #124)", testEstimateIssueWellSampledTestShapeNotScaled],
	["estimateGroups: verification multiplier surfaces on the group + dry-run line (issue #124)", testEstimateGroupsShowsVerificationMultiplier],
	["estimateGroups: an unapplied multiplier (thin issue contributes no cost) never surfaces (rework cycle 1)", testEstimateGroupsDoesNotSurfaceUnappliedMultiplier],
	["estimateGroups sums per-issue medians into a group range", testEstimateGroupsSumsPerIssueIntoGroup],
	["estimateGroups reports unmatched issues as partial", testEstimateGroupsPartialMatchReportsUnmatched],
	["buildEstimateSection: empty history -> single no-history note", testBuildEstimateSectionEmptyHistory],
	["buildEstimateSection: sufficient data -> expected range + rates", testBuildEstimateSectionSufficientData],
	["buildEstimateSection: sparse data -> explicit insufficient-data note", testBuildEstimateSectionInsufficientData],
	["buildEstimateSection: unrelated shapes -> no-history-for-this-shape note", testBuildEstimateSectionNoHistoryForShape],
	["isCiConfigChange matches CI/actions/workflow/runner in title+body, rejects lookalikes", testIsCiConfigChangeMatchesTitleAndBody],
	["CI/config issue gets a flagged higher bound (per-issue and group, #125)", testCiConfigIssueGetsFlaggedHigherBound],
	["CI/config higher bound mixes with plain issues in the group total (#125)", testCiConfigHigherBoundMixesWithNonCiIssues],
	["buildEstimateSection renders the CI higher bound on the estimate line (#125)", testBuildEstimateSectionShowsCiHigherBound],
	["LOW-CONFIDENCE flagged + rendered when issues are unmatched (#126)", testLowConfidenceFlaggedWhenIssuesUnmatched],
	["LOW-CONFIDENCE flagged + rendered when no history for the shape (#126)", testLowConfidenceFlaggedOnNoHistoryForShape],
	["LOW-CONFIDENCE flagged + rendered when samples < MIN_SHAPE_SAMPLES (#126)", testLowConfidenceFlaggedOnInsufficientSamples],
	["no LOW-CONFIDENCE marker when the estimate is solid (#126)", testLowConfidenceNotFlaggedWithEnoughSamples],
	["LOW-CONFIDENCE flagged on an under-sampled direct match (#126)", testLowConfidenceFlaggedOnUnderSampledDirectMatch],
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
