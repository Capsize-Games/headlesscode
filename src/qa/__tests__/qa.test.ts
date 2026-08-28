/**
 * Unit tests for src/qa/qa.ts — QA verdict/evidence parsing from the QA
 * session's final report. Plain assert-based, no network. Run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { parseQaResult, runQa, runQaWithRetries } from "../qa.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../../engine/types.js"

// ─── Fake LLM client (same pattern as engine/__tests__/loop.test.ts) ─────────

class FakeLlmClient implements LlmClient {
	/** Captured system/task prompt text for the session (assert-able in tests). */
	public lastRequestText = ""
	constructor(private readonly script: Array<() => ChatMessage>) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.lastRequestText = request.messages.map((m) => m.content ?? "").join("\n")
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (model kept calling)")
		}
		return { message: step() }
	}
}

function toolCall(name: string, args: unknown): ChatMessage {
	const call: ChatToolCall = {
		id: `call_${Math.random().toString(36).slice(2)}`,
		type: "function",
		function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
	}
	return { role: "assistant", content: null, tool_calls: [call] }
}

function attemptCompletion(verdictLine: string): ChatMessage {
	return toolCall("attempt_completion", { result: `QA complete.\n\n${verdictLine}` })
}

async function makeWorkspace(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-qa-retry-"))
}

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
	// The qa-agent's definition of done style: "no errors found" +
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

/**
 * 2026-08-05 production incident (same class of bug as reviewer.ts's
 * parseReviewResult, found in the same session): a genuinely passing QA
 * report citing real baseline test counts ("12 failed, 1187 passed" —
 * pre-existing failures on master, unrelated to the change under QA)
 * contains the bare word "failed". The old fail-marker regex's negative
 * lookbehind `(?<!no\s)failed` only protects the exact phrase "no failed"
 * — it does nothing for "12 failed", the actual shape baseline reporting
 * takes — and fail always wins over pass in this function, so the whole
 * report was force-classified "fail" despite QA PASS being stated
 * explicitly. Caught live while this exact QA session was running.
 */
async function testBaselineFailedCountsDoNotFalselyFailAPassingQaReport(): Promise<void> {
	const result = parseQaResult(
		[
			"QA PASS",
			"",
			"## Evidence",
			"- App booted, exercised the changed behavior for real, all targeted checks pass.",
			"- Full-suite baselines (pre-existing on master, unrelated to this change):",
			"  `server/tests`: 12 failed, 1187 passed, 8 skipped, 10 errors.",
			"  `server/src/services/tests`: 3 failed, 928 passed, 8 errors.",
		].join("\n"),
	)
	assert.equal(
		result.verdict,
		"pass",
		"baseline 'N failed' test counts must never be mistaken for a QA failure of the actual change",
	)
}

// ─── Structured QA_VERDICT line: the primary path, no heuristics involved ────

async function testStructuredVerdictPassIgnoresBaselineFailedCounts(): Promise<void> {
	const result = parseQaResult(
		[
			"App booted, exercised the changed behavior for real, all targeted checks pass.",
			"Baselines (pre-existing, unrelated): 12 failed, 1187 passed, 10 errors.",
			"",
			"QA_VERDICT: PASS",
		].join("\n"),
	)
	assert.equal(result.verdict, "pass")
}

async function testStructuredVerdictFailWinsEvenWithPassLanguage(): Promise<void> {
	const result = parseQaResult(
		["All existing tests still pass, but the new feature itself does not work.", "", "QA_VERDICT: FAIL"].join(
			"\n",
		),
	)
	assert.equal(result.verdict, "fail")
}

async function testStructuredVerdictIsCaseInsensitiveAndTrimsWhitespace(): Promise<void> {
	const result = parseQaResult(["Report body.", "", "qa_verdict: pass  "].join("\n"))
	assert.equal(result.verdict, "pass")
}

async function testMissingStructuredQaVerdictFallsBackToHeuristic(): Promise<void> {
	const result = parseQaResult("QA PASS — no failures found across the suite, verified OK.")
	assert.equal(result.verdict, "pass")
}

/**
 * 2026-08-28 production incident: a QA session correctly reported it
 * COULD NOT run any checks (tooling unavailable) and concluded it must
 * fail, but explained itself using the phrase "a QA PASS requires..." —
 * the bare `\bqa\s*pass\b` match fired on that substring even though it
 * was never a real verdict declaration, silently flipping a correct
 * failure report to "pass". "QA PASS"/"QA FAIL" must LEAD a line to count
 * as a real verdict declaration in the fallback, same as the structured
 * QA_VERDICT: line above already requires.
 */
async function testExplanatoryQaPassMentionInFailureProseDoesNotFlipToPass(): Promise<void> {
	const result = parseQaResult(
		"The workspace's `git` tool is unavailable... I cannot boot the app, run any test suite, or exercise " +
			"specific behavior without a working shell. Per the operating instructions, a QA PASS requires all " +
			"checks to have run clean; with the core tooling unavailable, I must fail rather than guess.\n\n" +
			"Evidence:\n- git diff origin/master...HEAD --stat -> no output\n\nFinal baseline: tooling unavailable; no checks ran.",
	)
	assert.equal(result.verdict, "fail")
}

// ─── runQaWithRetries: end-to-end against a real HeadlessSession ────────────
//
// 2026-08-05 incident (QA-side twin of the reviewer.ts incident): a QA
// SESSION failure (crash/budget/mistake-limit) is correctly reported as
// verdict "error" by runQa — but nothing retried it, so cli.ts recorded an
// empty-evidence "failed" QA and settled the round with no human ever
// notified. Fixed with a retry wrapper that only retries on session
// failures, never on a real pass/fail. These exercise the REAL
// HeadlessSession (via an injected FakeLlmClient, no network).

/**
 * QA-side twin of the reviewer.ts fix, same incident: mirror every log
 * line to <worktree>/qa.log — a real, tailable file (matching harness.log's
 * convention), rather than only the structured events feed.
 */
async function testRunQaWritesATailableLogFile(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		const client = new FakeLlmClient([() => attemptCompletion("QA_VERDICT: PASS")])
		await runQa({ workspaceRoot: ws, llmClient: client, maxIterations: 5 })
		const logContent = await fs.readFile(path.join(ws, "qa.log"), "utf-8")
		assert.match(logContent, /===== headlesscode qa start:/, "run-separator line present")
		assert.match(logContent, /INFO\s+\[loop\] session start/, "real loop log lines mirrored to the file")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** Issue #123: the generic QA checklist must designate the workspace scratch
 * dir and explicitly forbid /tmp (a QA probe script written to /tmp is an
 * outside-workspace write, same containment rule as the reviewer). */
async function testRunQaGenericChecklistForbidsTmpAndPointsAtWorkspaceScratch(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		const client = new FakeLlmClient([() => attemptCompletion("QA_VERDICT: PASS")])
		// A workspace with no qa-agent mode -> GENERIC_QA_CHECKLIST is used
		// as the systemPromptOverride, so its text reaches the session prompt.
		await runQa({ workspaceRoot: ws, llmClient: client, maxIterations: 5, mode: "qa-agent" })
		assert.match(
			client.lastRequestText,
			/\.headlesscode\/scratch\//,
			"generic QA checklist points scratch at the workspace dir",
		)
		assert.match(
			client.lastRequestText,
			/NEVER write\s+to `\/tmp`/,
			"generic QA checklist explicitly forbids /tmp",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Issue #34: the QA session's COMPLETE final report is persisted per session
 * (`<workspaceRoot>/.headlesscode/reports/<sessionId>.md`) and surfaced on
 * the QaResult so the orchestrator can point the state file at it — the full
 * reasoning behind a QA verdict (e.g. why the `## Evidence` slice alone was
 * insufficient) is one file-read away, not a re-run away.
 */
async function testRunQaSurfacesFullReportPath(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		const client = new FakeLlmClient([() => attemptCompletion("QA_VERDICT: PASS")])
		const result = await runQa({ workspaceRoot: ws, llmClient: client, maxIterations: 5 })
		assert.equal(result.verdict, "pass")
		assert.ok(result.reportPath, "QaResult must carry the full-report path")
		const reportFile = await fs.readFile(result.reportPath!, "utf-8")
		assert.match(reportFile, /QA complete\./)
		assert.match(reportFile, /QA_VERDICT: PASS/)
		assert.ok(result.reportPath!.includes(`.headlesscode${path.sep}reports${path.sep}`))
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRunQaWithRetriesReturnsPassImmediately(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		const client = new FakeLlmClient([() => attemptCompletion("QA_VERDICT: PASS")])
		const result = await runQaWithRetries({ workspaceRoot: ws, llmClient: client, maxIterations: 5 }, 2)
		assert.equal(result.verdict, "pass")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRunQaWithRetriesRetriesAfterSessionError(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		// First "session" (3 calls): read_file on a nonexistent path 3x ->
		// bounded-failure -> verdict "error". Second "session" (the retry): a
		// real pass.
		const client = new FakeLlmClient([
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
			() => attemptCompletion("QA_VERDICT: PASS"),
		])
		const result = await runQaWithRetries({ workspaceRoot: ws, llmClient: client, maxIterations: 5 }, 2)
		assert.equal(result.verdict, "pass", "the retry's real pass must win, not the first attempt's error")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRunQaWithRetriesExhaustsRetries(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		const failingAttempt = (): Array<() => ChatMessage> => [
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
		]
		const client = new FakeLlmClient([...failingAttempt(), ...failingAttempt(), ...failingAttempt()])
		const result = await runQaWithRetries({ workspaceRoot: ws, llmClient: client, maxIterations: 5 }, 2)
		assert.equal(result.verdict, "error", "after exhausting retries, the caller must get the final error back")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
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
	["baseline 'N failed' test counts do not falsely fail a passing QA report", testBaselineFailedCountsDoNotFalselyFailAPassingQaReport],
	["structured QA_VERDICT: PASS ignores baseline 'N failed' counts", testStructuredVerdictPassIgnoresBaselineFailedCounts],
	["structured QA_VERDICT: FAIL wins even with pass language elsewhere", testStructuredVerdictFailWinsEvenWithPassLanguage],
	["structured qa verdict line is case-insensitive and trims whitespace", testStructuredVerdictIsCaseInsensitiveAndTrimsWhitespace],
	["missing structured QA_VERDICT falls back to the heuristic", testMissingStructuredQaVerdictFallsBackToHeuristic],
	[
		"explanatory 'a QA PASS requires...' inside a failure report does not flip to pass",
		testExplanatoryQaPassMentionInFailureProseDoesNotFlipToPass,
	],
	["runQa writes a tailable qa.log", testRunQaWritesATailableLogFile],
	["runQa generic checklist designates workspace scratch and forbids /tmp (issue #123)", testRunQaGenericChecklistForbidsTmpAndPointsAtWorkspaceScratch],
	["runQa surfaces the complete final report path (issue #34)", testRunQaSurfacesFullReportPath],
	["runQaWithRetries: a normal pass verdict returns immediately, no retry", testRunQaWithRetriesReturnsPassImmediately],
	["runQaWithRetries: retries after a QA-session error and succeeds on the 2nd attempt", testRunQaWithRetriesRetriesAfterSessionError],
	["runQaWithRetries: exhausts retries and returns the final error verdict", testRunQaWithRetriesExhaustsRetries],
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
