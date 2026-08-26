/**
 * Unit tests for src/orchestrator/split.ts — the issue-splitting heuristics
 * ported from the multi-agent-orchestrator mode.
 *
 * Plain assert-based script (no test framework, no network) matching the
 * src/engine/__tests__/loop.test.ts style. Run via `npm test`.
 */

import assert from "node:assert/strict"

import {
	splitIssues,
	shapeOf,
	issueShape,
	issueSizeWarnings,
	topLevelSectionCount,
	GENERIC_GROUP_CAP,
	SAME_SHAPE_GROUP_CAP,
	MAX_GROUPS,
	ISSUE_SIZE_WARN_THRESHOLD,
} from "../split.js"
import type { SplitIssue } from "../split.js"

function issue(number: number, title: string, body?: string): SplitIssue {
	return { number, title, body }
}

function allIssueNumbers(specs: Array<{ issues: number[] }>): number[] {
	return specs.flatMap((s) => s.issues).sort((a, b) => a - b)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testEmptyIssues(): Promise<void> {
	const specs = splitIssues([])
	assert.deepEqual(specs, [])
}

async function testHotPathIsolation(): Promise<void> {
	// Two independent hot-path changes must NEVER share a worktree
	// (heuristic 1: never put two independent hot-path changes together).
	const issues = [
		issue(1, "Add auth token validation to request handling"),
		issue(2, "Migration for the new database schema"),
		issue(3, "Update the settings panel labels"),
	]
	const specs = splitIssues(issues)
	assert.equal(specs.length, 3, "hot-path issues each get their own worktree (generic issue gets one too)")
	for (const s of specs) {
		assert.ok(s.issues.length === 1, `every issue isolated in this round: ${JSON.stringify(s)}`)
		const hasHot = s.issues.includes(1) || s.issues.includes(2)
		assert.ok(!(hasHot && s.issues.length > 1), "no worktree bundles a hot-path issue with others")
	}
	assert.ok(specs.some((s) => s.issues.includes(1)), "issue 1 alone")
	assert.ok(specs.some((s) => s.issues.includes(2)), "issue 2 alone")
}

async function testHotPathKeywordFromBody(): Promise<void> {
	// The keyword scan covers the body too ("Read each issue body in full —
	// do not rely on titles alone to judge risk or scope").
	const issues = [
		issue(7, "Rewrite the frontend page", "Touches the encryption layer directly"),
		issue(8, "Fix typo in README"),
	]
	const specs = splitIssues(issues)
	assert.equal(specs.length, 2, "body-keyword hit is isolated")
	const cryptoSpec = specs.find((s) => s.issues.includes(7))
	assert.ok(cryptoSpec && cryptoSpec.issues.length === 1, "issue 7 isolated via body keyword")
}

async function testSameShapeGrouping(): Promise<void> {
	// Two "split this file" issues are the same shape → one worktree
	// (heuristic 2: group same-shape mechanical work together).
	const issues = [
		issue(10, "Split routes.py into focused modules"),
		issue(11, "Split utils.py into focused modules"),
		issue(12, "Add docs for the new API endpoints"),
	]
	const specs = splitIssues(issues)
	assert.equal(specs.length, 2, "two split-issues batch into one worktree, docs separate")
	const splitSpec = specs.find((s) => s.issues.includes(10) && s.issues.includes(11))
	assert.ok(splitSpec, "both /split/ issues in one group")
	assert.equal(splitSpec.issues.length, 2)
}

async function testSizeCapOnGenericGroup(): Promise<void> {
	// Generic (non-same-shape) work must not exceed ~2 issues per group
	// (heuristic 3: ~1 day of sequential work).
	const issues = Array.from({ length: GENERIC_GROUP_CAP * 2 }, (_, i) =>
		issue(100 + i, `Random chore number ${i + 1}`),
	)
	const specs = splitIssues(issues)
	for (const spec of specs) {
		assert.ok(
			spec.issues.length <= GENERIC_GROUP_CAP,
			`generic group '${spec.name}' exceeds the ~1-day cap: ${spec.issues.length} issues`,
		)
	}
}

async function testSameShapeCanExceedGenericCap(): Promise<void> {
	// Same-shape mechanical batches may carry more than the generic cap but
	// still respect the same-shape cap.
	const issues = Array.from({ length: SAME_SHAPE_GROUP_CAP + 1 }, (_, i) =>
		issue(200 + i, `Split file number ${i + 1} into modules`),
	)
	const specs = splitIssues(issues)
	const maxInGroup = Math.max(...specs.map((s) => s.issues.length))
	assert.ok(
		maxInGroup <= SAME_SHAPE_GROUP_CAP,
		`same-shape group exceeded cap ${SAME_SHAPE_GROUP_CAP}: got ${maxInGroup}`,
	)
}

async function testMaxGroupsPreference(): Promise<void> {
	// 6 non-hot, non-same-shape issues: 3 groups of 2 → fine (3 <= 4).
	const issues = Array.from({ length: 6 }, (_, i) => issue(300 + i, `Generic task ${i + 1}`))
	const specs = splitIssues(issues)
	assert.equal(specs.length, 3)
	assert.ok(specs.length <= MAX_GROUPS, `more than ${MAX_GROUPS} groups: ${specs.length}`)
	assert.ok(specs.length >= 2, "prefer at least 2 worktrees when there is enough work")
}

async function testNeverMoreThanMaxGroups(): Promise<void> {
	// 5 hot-path issues + a few same-shape ones → merged down to <= MAX_GROUPS
	// (heuristic 4: never 5+; merge small groups).
	const issues = [
		issue(400, "Fix auth request handling"),
		issue(401, "Database session leak in handler"),
		issue(402, "Encryption key migration"),
		issue(403, "Password reset flow"),
		issue(404, "Token refresh endpoint"),
		issue(405, "Split models.py into modules"),
		issue(406, "Split views.py into modules"),
	]
	const specs = splitIssues(issues)
	assert.ok(specs.length <= MAX_GROUPS, `expected <= ${MAX_GROUPS} groups, got ${specs.length}: ${JSON.stringify(specs)}`)
	// Merging must not lose any issue.
	const merged = allIssueNumbers(specs)
	assert.deepEqual(merged, issues.map((i) => i.number).sort((a, b) => a - b))
}

async function testNamesAndTaskFileConvention(): Promise<void> {
	const issues = [issue(27, "Decompose the five 1,000+ line files into focused modules")]
	const specs = splitIssues(issues)
	assert.equal(specs.length, 1)
	assert.equal(specs[0].name, "w1")
	assert.equal(specs[0].issues[0], 27)
	// convention: w1-issue27.md, w2-issue29-36.md
	assert.equal(specs[0].taskFile, "w1-issue27.md")

	const two = splitIssues([
		issue(29, "Split the 10 multi-class files into one-class-per-file"),
		issue(36, "Decompose remaining 25 files over 250 lines"),
	])
	assert.equal(two.length, 1)
	assert.equal(two[0].taskFile, "w1-issue29-36.md")
}

async function testDeterministicRegardlessOfInputOrder(): Promise<void> {
	const a = [
		issue(27, "Split big file"),
		issue(5, "Auth handler fix"),
		issue(12, "Add coverage for token utils"),
		issue(3, "Fix typo in docs"),
	]
	const b = [a[3], a[1], a[0], a[2]]
	const specsA = splitIssues(a)
	const specsB = splitIssues(b)
	assert.deepEqual(specsA, specsB, "split output must be order-independent")
}

// ─── shapeOf / issueShape (the cost-estimation taxonomy, issue #16) ─────────

async function testShapeOfMatchesMechanicalShapesFromTitle(): Promise<void> {
	assert.equal(shapeOf(issue(1, "Split routes.py into focused modules")), "split")
	assert.equal(shapeOf(issue(2, "Decompose the big file")), "split", "decompose is the same split shape")
	assert.equal(shapeOf(issue(3, "Add coverage for token utils")), "coverage")
	assert.equal(shapeOf(issue(4, "Write tests for the merge check")), "test")
	assert.equal(shapeOf(issue(5, "Add docs for the new API")), "docs")
	assert.equal(shapeOf(issue(6, "Refactor the model layer")), "refactor")
	assert.equal(shapeOf(issue(7, "Fix the flaky button")), "generic", "no mechanical pattern -> generic")
	// shapeOf is title-only: a hot keyword in the BODY must not change the
	// mechanical shape (issueShape handles hotness separately).
	assert.equal(shapeOf(issue(8, "Rewrite the frontend page", "Touches the encryption layer")), "generic")
}

async function testIssueShapeHotWinsOverMechanicalShape(): Promise<void> {
	// A hot-path issue stays "hot" even when its title matches a mechanical
	// shape — split.ts isolates it alone and its cost profile is its own.
	assert.equal(issueShape(issue(1, "Refactor auth request handling")), "hot")
	assert.equal(issueShape(issue(2, "Split the database migration file")), "hot")
	assert.equal(issueShape(issue(3, "Split routes.py into modules")), "split")
	assert.equal(issueShape(issue(4, "Fix a typo in the README")), "generic")
	// Hotness is detected from the body too, like the isolation heuristic.
	assert.equal(issueShape(issue(5, "Rewrite the settings panel", "Touches the encryption layer directly")), "hot")
}

// ─── Pre-flight issue-size check (issue #53) ─────────────────────────────────

async function testTopLevelSectionCount(): Promise<void> {
	// A numbered list of 3+ items is the classic "N independent pieces" shape.
	assert.equal(topLevelSectionCount("Three pieces:\n1. Build the index\n2. Wire the search\n3. Ship the dashboard"), 3)
	// Bulleted lists count too.
	assert.equal(topLevelSectionCount("- split the CLI\n- split the watcher\n- split the state file"), 3)
	// Headings carrying an explicit ordinal count as sections.
	assert.equal(topLevelSectionCount("## 1. Codemap phase one\n## 2. Cost tracking\n## 3. Rework loop"), 3)
	// Below the threshold: 1-2 items are not a warning.
	assert.equal(topLevelSectionCount("1. Do the thing\n2. Also this"), 2)
	// Empty / missing bodies are never flagged.
	assert.equal(topLevelSectionCount(undefined), 0)
	assert.equal(topLevelSectionCount(""), 0)
	assert.equal(topLevelSectionCount("Just prose."), 0)
	// Inline numbers in prose must never false-positive.
	assert.equal(topLevelSectionCount("Bump the runtime to 3.10 and fix the 1.50 bug (see #17)."), 0)
	// Nested list items (indented 4+) are NOT top-level sections.
	assert.equal(topLevelSectionCount("1. Client\n    - sub A\n    - sub B\n2. Server\n    - sub C\n3. Docs"), 3)
}

async function testIssueSizeWarningsOnlyFlagsThreePlusSections(): Promise<void> {
	const issues = [
		issue(17, "Codemap Phase 1", "Three pieces:\n1. Build the index\n2. Wire the search\n3. Ship the dashboard"),
		issue(80, "Client UI", "One screen, one registry entry"),
		issue(85, "Tiny fix", undefined),
	]
	const warnings = issueSizeWarnings(issues)
	assert.equal(warnings.length, 1, "only the 3+-section issue is flagged")
	assert.equal(warnings[0].number, 17, "flagged issue keeps its number")
	assert.equal(warnings[0].sections, 3)
	assert.equal(warnings[0].title, "Codemap Phase 1")
	assert.equal(ISSUE_SIZE_WARN_THRESHOLD, 3, "threshold is 3 per the issue's own ask")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["empty issues -> empty plan", testEmptyIssues],
	["hot-path issues isolated alone (heuristic 1)", testHotPathIsolation],
	["hot-path keyword detected from issue body", testHotPathKeywordFromBody],
	["same-shape mechanical work grouped (heuristic 2)", testSameShapeGrouping],
	["generic groups capped at ~1 day (heuristic 3)", testSizeCapOnGenericGroup],
	["same-shape groups may exceed generic cap", testSameShapeCanExceedGenericCap],
	["2-4 groups preference (heuristic 4)", testMaxGroupsPreference],
	["never more than 4 groups, all issues preserved", testNeverMoreThanMaxGroups],
	["task-file naming convention", testNamesAndTaskFileConvention],
	["deterministic regardless of input order", testDeterministicRegardlessOfInputOrder],
	["shapeOf matches mechanical shapes from the title", testShapeOfMatchesMechanicalShapesFromTitle],
	["issueShape marks hot-path issues hot (title or body, beats mechanical shape)", testIssueShapeHotWinsOverMechanicalShape],
	["topLevelSectionCount counts numbered/bulleted/ordinal-heading sections only (issue #53)", testTopLevelSectionCount],
	["issueSizeWarnings flags only 3+-section issues (issue #53)", testIssueSizeWarningsOnlyFlagsThreePlusSections],
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
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} split tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
