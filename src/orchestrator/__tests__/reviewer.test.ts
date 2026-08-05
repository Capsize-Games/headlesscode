/**
 * Unit tests for src/orchestrator/reviewer.ts — verdict parsing from the
 * reviewer's final report. Plain assert-based, no network. Run via `npm test`.
 */

import assert from "node:assert/strict"

import { parseReviewResult } from "../reviewer.js"

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testCleanVerdictExplicit(): Promise<void> {
	const result = parseReviewResult(
		[
			"REVIEW CLEAN",
			"Verified all claims: baselines 14/1161/30 (before) vs 14/1161/30 (after), boot check ROUTES:36, no stale refs.",
			"Everything checks out for issue #27.",
		].join("\n"),
	)
	assert.equal(result.verdict, "clean")
	assert.deepEqual(result.findings, [])
}

async function testFindingVerdictWithSection(): Promise<void> {
	const result = parseReviewResult(
		[
			"## Findings",
			"- token_usage_routes/_drilldown_routes.py = 369 lines (issue requires <250)",
			"- token_usage_routes/_pricing.py = 310 lines (issue requires <250)",
			"",
			"## Verdict",
			"REOPENED issue #27 with both findings.",
		].join("\n"),
	)
	assert.equal(result.verdict, "finding")
	assert.equal(result.findings.length, 2)
	assert.match(result.findings[0] ?? "", /_drilldown_routes/)
	assert.match(result.findings[1] ?? "", /_pricing/)
}

async function testFindingVerdictFromReopenMarker(): Promise<void> {
	const result = parseReviewResult(
		"Reopened issue #27: the query collapsed to WHERE false after the migration. Reproduce with: docker compose exec server ...",
	)
	assert.equal(result.verdict, "finding")
	assert.ok(result.findings.length >= 1)
}

async function testCleanVerdictDefaultWhenUnmarked(): Promise<void> {
	// A report that states neither reopens nor findings defaults to clean
	// (the reviewer only reopens for real problems).
	const result = parseReviewResult("All baselines confirmed. PR #40. No issues found.")
	assert.equal(result.verdict, "clean")
}

async function testCleanVerdictDoesNotTripOnCleanupWord(): Promise<void> {
	// "cleanup" must not count as a clean marker by itself, and a plain
	// "clean" mention is fine — but the verdict logic keys off explicit
	// review-clean markers.
	const result = parseReviewResult("Reviewed the cleanup round; verdict: clean, no findings.")
	assert.equal(result.verdict, "clean")
}

/**
 * 2026-08-05 production incident regression: a real reviewer report against
 * airunner issue #83/PR #88 had BOTH a "### Verified clean" section (listing
 * several claims that checked out) and a SEPARATE "### Reopened" section
 * naming one real problem (a dropped `--user` scope item). The old
 * `hasFindingMarker && !hasCleanMarker` logic let the ambient "verified
 * clean" text suppress the explicit reopen, misclassifying a genuinely
 * reopened review as "clean" — which would have skipped the entire rework
 * mechanism. A finding marker must always win.
 */
async function testFindingWinsOverCoincidentalCleanLanguage(): Promise<void> {
	const result = parseReviewResult(
		[
			"### Verified clean (all reproduced personally)",
			"- `./scripts/w1-pytest.sh server/tests/test_prompt_parts.py` -> `1 passed`.",
			"- Cold-stack first invocation -> `2/2 containers healthy`.",
			"",
			"### Reopened",
			"- **#83** reopened for the `--user \"$(id -u):$(id -g)\"` scope item: not implemented.",
		].join("\n"),
	)
	assert.equal(result.verdict, "finding", "an explicit reopen must win even alongside 'verified clean' text elsewhere")
	assert.ok(
		result.findings.some((f) => f.includes("reopened")),
		"the reopened item must be captured as a finding",
	)
}

/**
 * 2026-08-05 production incident (a second, distinct bug from the same
 * over-broad word list, caught minutes after fixing the first): a
 * genuinely CLEAN review — "No findings", "Issue left closed" — reported
 * real baseline test counts ("12 failed, 1187 passed, ... 8 errors",
 * pre-existing failures on master, unrelated to the change). The bare word
 * "failed" alone tripped the OLD finding-marker list, misclassifying a
 * clean review as a finding and spawning a completely unnecessary rework
 * cycle — real API spend fixing a problem that did not exist. "Failed" /
 * "wrong" / "regression" / "does not" are ordinary words that appear
 * constantly in normal baseline-reporting prose and must NEVER be finding
 * markers on their own; only `reopen(ed)` (the actual ground-truth action
 * the reviewer takes on GitHub) and an explicit "verdict: ... finding"
 * phrase are reliable.
 */
async function testBaselineFailedCountsDoNotFalselyTripAFinding(): Promise<void> {
	const result = parseReviewResult(
		[
			"## Independent review — CLEAN, issue stays closed",
			"",
			"Reviewed per review-mode procedure. No findings; the previous scope item is fully addressed.",
			"",
			"### Full-suite baselines I personally confirmed",
			"- `server/tests`: **12 failed, 1187 passed, 8 skipped, 39 deselected, 10 errors** — all pre-existing on master.",
			"- `server/src/airunner_services/tests`: **3 failed, 928 passed, 9 deselected, 8 errors**.",
			"",
			"Issue left closed.",
		].join("\n"),
	)
	assert.equal(
		result.verdict,
		"clean",
		"baseline 'N failed' test counts must never be mistaken for a real finding — this is normal, expected pre-existing-failure reporting",
	)
}

async function testBareWrongRegressionDoesNotMarkFinding(): Promise<void> {
	// "wrong"/"regression"/"does not" as ordinary prose, no reopen anywhere.
	const result = parseReviewResult(
		"Nothing was wrong with the approach; there is no regression, and the fix does not touch server code. Verified clean.",
	)
	assert.equal(result.verdict, "clean")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["explicit 'REVIEW CLEAN' -> clean", testCleanVerdictExplicit],
	["findings section + REOPENED -> finding", testFindingVerdictWithSection],
	["reopen marker in prose -> finding", testFindingVerdictFromReopenMarker],
	["unmarked report defaults to clean", testCleanVerdictDefaultWhenUnmarked],
	["verdict: clean with no findings -> clean", testCleanVerdictDoesNotTripOnCleanupWord],
	["a finding always wins over coincidental 'verified clean' text elsewhere", testFindingWinsOverCoincidentalCleanLanguage],
	["baseline 'N failed' test counts do not falsely trip a finding", testBaselineFailedCountsDoNotFalselyTripAFinding],
	["bare 'wrong'/'regression'/'does not' in clean prose does not mark a finding", testBareWrongRegressionDoesNotMarkFinding],
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
	console.log(`\nAll ${tests.length} reviewer tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
