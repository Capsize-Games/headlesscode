/**
 * Unit tests for src/qa/qa.ts — QA verdict/evidence parsing from the QA
 * session's final report. Plain assert-based, no network. Run via `npm test`.
 */

import assert from "node:assert/strict"

import { parseQaResult } from "../qa.js"

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testPassVerdictWithEvidenceSection(): Promise<void> {
	const result = parseQaResult(
		[
			"QA PASS",
			"",
			"## Evidence",
			"- Ran `node src/greet.test.js` via execute_command: all 3 assertions passed (greet tests passed).",
			"- Checked qa/last-report.json equivalent: errors [], failedRequests [].",
			"",
			"Definition of done satisfied: changed behavior works, no errors found.",
		].join("\n"),
	)
	assert.equal(result.verdict, "pass")
	assert.match(result.evidence, /greet\.test\.js/)
	assert.match(result.evidence, /assertions passed/)
}

async function testFailVerdictWithEvidenceSection(): Promise<void> {
	const result = parseQaResult(
		[
			"QA FAIL",
			"",
			"## Evidence",
			"- Ran `node src/greet.test.js` via execute_command: 1 assertion failed (expected 'Hello, World' got '').",
			"",
			"Definition of done NOT satisfied: the changed behavior does not work.",
		].join("\n"),
	)
	assert.equal(result.verdict, "fail")
	assert.match(result.evidence, /assertion failed/)
}

async function testFailClosedWhenUnmarked(): Promise<void> {
	// A report with no explicit QA PASS / QA FAIL must NOT pass (fail-closed:
	// QA gates a deploy, so an inconclusive report never lets one through).
	const result = parseQaResult("Ran the test suite and exercised the app. Evidence attached in the log.")
	assert.equal(result.verdict, "fail")
}

async function testPassWithRealCommandOutputText(): Promise<void> {
	// The airunner qa-agent's definition of done style: "no errors found" +
	// an explicit pass marker in prose.
	const result = parseQaResult(
		"Verified for real: ran npm test (12 passed / 12), no errors found in qa/last-report.json, wsEvents round-trip confirmed. All checks passed.",
	)
	assert.equal(result.verdict, "pass")
}

async function testFailOnErrorsArrayContent(): Promise<void> {
	const result = parseQaResult(
		"## Evidence\nqa/last-report.json shows errors: [Uncaught TypeError: cannot read properties of undefined]. Server log has a matching traceback.",
	)
	assert.equal(result.verdict, "fail")
}

async function testEvidenceFallsBackToFullSummary(): Promise<void> {
	const summary = "QA PASS\nRan node src/greet.test.js: passed 3/3. No errors found."
	const result = parseQaResult(summary)
	assert.equal(result.verdict, "pass")
	assert.equal(result.evidence, summary, "no Evidence section -> full summary is the evidence")
}

async function testPassMarkerDoesNotTripOnFailureWord(): Promise<void> {
	// "no failures found" is a PASS marker; a bare "failure" inside an
	// otherwise-clean sentence must not flip it to fail.
	const result = parseQaResult("QA PASS — no failures found across the suite, verified OK.")
	assert.equal(result.verdict, "pass")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["QA PASS + Evidence section -> pass", testPassVerdictWithEvidenceSection],
	["QA FAIL + Evidence section -> fail", testFailVerdictWithEvidenceSection],
	["unmarked report defaults to fail (fail-closed)", testFailClosedWhenUnmarked],
	["explicit pass markers in prose -> pass", testPassWithRealCommandOutputText],
	["errors array content -> fail", testFailOnErrorsArrayContent],
	["no Evidence section -> full summary is evidence", testEvidenceFallsBackToFullSummary],
	["pass marker survives 'no failures found' phrasing", testPassMarkerDoesNotTripOnFailureWord],
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
	console.log(`\nAll ${tests.length} QA parsing tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
