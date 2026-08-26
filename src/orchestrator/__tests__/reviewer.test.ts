/**
 * Unit tests for src/orchestrator/reviewer.ts — verdict parsing from the
 * reviewer's final report. Plain assert-based, no network. Run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { parseReviewResult, runReview, runReviewWithRetries } from "../reviewer.js"
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
	return toolCall("attempt_completion", { result: `Reviewed everything.\n\n${verdictLine}` })
}

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
 * a production issue/PR had BOTH a "### Verified clean" section (listing
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
			"- `server/src/services/tests`: **3 failed, 928 passed, 9 deselected, 8 errors**.",
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

/**
 * 2026-08-05 production incident (a THIRD variant of the same bug class,
 * caught immediately after fixing the second, live, on a real review of
 * a production PR): a genuinely clean review explained that two minor,
 * out-of-scope observations did NOT need action using the word "reopen"
 * itself — "(pre-existing / out of scope, no reopen)" and "Staying
 * closed. No reopening warranted." — with the bare `\breopen(ed)?\b`
 * marker (the fix from the PREVIOUS incident) still tripping on this,
 * because it has no negation-awareness at all. A negation lookbehind
 * would only protect this exact phrasing (the same mistake made for
 * "failed" last time); the real fix is structural: `reopen(ed)` only
 * counts as a finding when it's an actual "### Reopened" heading or is
 * tied to a specific issue number, both of which the reviewer's own
 * required report format always uses for a REAL reopen, and an
 * incidental aside never does.
 */
async function testNoReopenAsideDoesNotMarkFinding(): Promise<void> {
	const result = parseReviewResult(
		[
			"## Independent review — VERIFIED CLEAN",
			"",
			"Independently reproduced every checkable claim.",
			"",
			"### Non-blocking observations (pre-existing / out of scope, no reopen)",
			'1. `poll-worktree.sh` compares against uppercase "CLOSED" but gh returns lowercase — pre-existing on master.',
			"2. A benign gitignored log gets one extra line on stall — doc nit only.",
			"",
			"Staying closed. No reopening warranted.",
		].join("\n"),
	)
	assert.equal(result.verdict, "clean", "an aside merely mentioning 'reopen' while explicitly NOT reopening must stay clean")
	assert.deepEqual(result.findings, [])
}

async function testBareWrongRegressionDoesNotMarkFinding(): Promise<void> {
	// "wrong"/"regression"/"does not" as ordinary prose, no reopen anywhere.
	const result = parseReviewResult(
		"Nothing was wrong with the approach; there is no regression, and the fix does not touch server code. Verified clean.",
	)
	assert.equal(result.verdict, "clean")
}

// ─── Structured VERDICT line: the primary path, no heuristics involved ───────

async function testStructuredVerdictCleanWinsOverContradictoryProse(): Promise<void> {
	// The exact shape of incident #1 (eb1407c): a "verified clean" section
	// alongside language that used to look like a finding — but now with the
	// required structured line, which is authoritative regardless.
	const result = parseReviewResult(
		[
			"### Verified clean",
			"- Everything reproduced. Some baselines show 12 failed, 1187 passed (pre-existing).",
			"",
			"VERDICT: CLEAN",
		].join("\n"),
	)
	assert.equal(result.verdict, "clean")
}

async function testStructuredVerdictFindingWinsEvenWithCleanLanguageEverywhere(): Promise<void> {
	const result = parseReviewResult(
		[
			"### Verified clean (all reproduced personally)",
			"- Several claims checked out fine.",
			"",
			"### Reopened",
			"- **#83** reopened for a real problem.",
			"",
			"VERDICT: FINDING",
		].join("\n"),
	)
	assert.equal(result.verdict, "finding")
}

async function testStructuredVerdictIgnoresBaselineFailedCounts(): Promise<void> {
	// Incident #2 (7535f1f) shape, plus the required line.
	const result = parseReviewResult(
		[
			"No findings. Baselines: 12 failed, 1187 passed, 10 errors (pre-existing on master).",
			"",
			"VERDICT: CLEAN",
		].join("\n"),
	)
	assert.equal(result.verdict, "clean")
}

async function testStructuredVerdictIgnoresNoReopenAside(): Promise<void> {
	// Incident #3 (f816ca9) shape, plus the required line.
	const result = parseReviewResult(
		[
			"### Non-blocking observations (pre-existing / out of scope, no reopen)",
			"1. A benign nit.",
			"",
			"Staying closed. No reopening warranted.",
			"",
			"VERDICT: CLEAN",
		].join("\n"),
	)
	assert.equal(result.verdict, "clean")
}

async function testStructuredVerdictIsCaseInsensitiveAndTrimsWhitespace(): Promise<void> {
	const result = parseReviewResult(["Some report text.", "", "verdict: finding  "].join("\n"))
	assert.equal(result.verdict, "finding")
}

async function testMissingStructuredVerdictFallsBackToHeuristic(): Promise<void> {
	// No "VERDICT: ..." line at all -> falls back to the existing heuristic
	// path (already covered by the other tests in this file, but confirm
	// the fallback actually engages rather than defaulting blindly).
	const result = parseReviewResult("Reopened issue #27: a real bug, file:line evidence here.")
	assert.equal(result.verdict, "finding")
}

// ─── runReviewWithRetries: end-to-end against a real HeadlessSession ─────────
//
// 2026-08-05 incident: a review SESSION failure (crash/budget/mistake-limit)
// was reported as `verdict: "finding"` — indistinguishable from a real code
// problem — so the orchestrator spawned a pointless worker rework cycle to
// "fix" a placeholder error message. Fixed by introducing a distinct "error"
// verdict and a retry wrapper that only retries on session failures, never
// on a real clean/finding verdict. These tests exercise the REAL
// HeadlessSession (via an injected FakeLlmClient, no network) rather than
// just the string-parsing heuristic, since the bug was in how a failed
// SESSION gets classified, not in text parsing.

async function makeWorkspace(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-review-retry-"))
}

/**
 * Raised directly 2026-08-05: "frustrating that i can't see the review logs
 * the same way i can the harness logs... i don't like having to hunt them
 * down." Review/QA run IN-PROCESS inside orchestrate (unlike a worker,
 * spawned as a subprocess with stdout redirected to harness.log by
 * run-worker.sh), so there was no plain, tailable log file — only the
 * structured `.headlesscode/events/*.jsonl` feed. Fixed by mirroring every
 * log line to <worktree>/review.log, same convention as harness.log
 * (append-only across retries/rework re-reviews, run-separator per session).
 */
async function testRunReviewWritesATailableLogFile(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		const client = new FakeLlmClient([() => attemptCompletion("VERDICT: CLEAN")])
		await runReview({ workspaceRoot: ws, llmClient: client, maxIterations: 5 })
		const logContent = await fs.readFile(path.join(ws, "review.log"), "utf-8")
		assert.match(logContent, /===== headlesscode review start:/, "run-separator line present")
		assert.match(logContent, /INFO\s+\[loop\] session start/, "real loop log lines mirrored to the file")

		// A second call (e.g. a retry, or re-review after rework) must APPEND,
		// not truncate — matching harness.log's own convention.
		const client2 = new FakeLlmClient([() => attemptCompletion("VERDICT: CLEAN")])
		await runReview({ workspaceRoot: ws, llmClient: client2, maxIterations: 5 })
		const logContent2 = await fs.readFile(path.join(ws, "review.log"), "utf-8")
		assert.ok(logContent2.length > logContent.length, "second session must append, not overwrite")
		assert.equal(
			(logContent2.match(/===== headlesscode review start:/g) ?? []).length,
			2,
			"two sessions -> two run-separator lines",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** Issue #123: the review session's task text must designate the workspace
 * scratch dir and explicitly forbid /tmp — reviewers were the worst /tmp
 * offenders in round-2026-08-17, so the instruction is injected per-session
 * (not only in the checklist doc). */
async function testRunReviewTaskTextForbidsTmpAndPointsAtWorkspaceScratch(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		const client = new FakeLlmClient([() => attemptCompletion("VERDICT: CLEAN")])
		await runReview({ workspaceRoot: ws, llmClient: client, maxIterations: 5 })
		assert.match(
			client.lastRequestText,
			/\.headlesscode\/scratch\//,
			"review session task text points scratch at the workspace dir",
		)
		assert.match(
			client.lastRequestText,
			/NEVER write to `\/tmp`/,
			"review session task text explicitly forbids /tmp",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
	* Issue #34: the reviewer's COMPLETE final report is persisted per session
	* (`<workspaceRoot>/.headlesscode/reports/<sessionId>.md`) and surfaced on
	* the ReviewResult so the orchestrator can point the state file at it — the
	* full reasoning behind a verdict is one file-read away, not a re-run away.
	*/
async function testRunReviewSurfacesFullReportPath(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		const client = new FakeLlmClient([() => attemptCompletion("VERDICT: CLEAN")])
		const result = await runReview({ workspaceRoot: ws, llmClient: client, maxIterations: 5 })
		assert.equal(result.verdict, "clean")
		assert.ok(result.reportPath, "ReviewResult must carry the full-report path")
		const reportFile = await fs.readFile(result.reportPath!, "utf-8")
		assert.match(reportFile, /Reviewed everything\./)
		assert.match(reportFile, /VERDICT: CLEAN/)
		assert.ok(result.reportPath!.includes(`.headlesscode${path.sep}reports${path.sep}`))
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRunReviewWithRetriesReturnsCleanImmediately(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		const client = new FakeLlmClient([() => attemptCompletion("VERDICT: CLEAN")])
		const result = await runReviewWithRetries({ workspaceRoot: ws, llmClient: client, maxIterations: 5 }, 2)
		assert.equal(result.verdict, "clean")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRunReviewWithRetriesRetriesAfterSessionError(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		// First "session" (3 calls): read_file on a nonexistent path 3x in a
		// row -> a real tool error each time -> bounded-failure after
		// consecutiveErrorLimit's default (3), reported as verdict "error".
		// Second "session" (the retry): a clean attempt_completion.
		const client = new FakeLlmClient([
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
			() => attemptCompletion("VERDICT: CLEAN"),
		])
		const result = await runReviewWithRetries({ workspaceRoot: ws, llmClient: client, maxIterations: 5 }, 2)
		assert.equal(result.verdict, "clean", "the retry's real clean verdict must win, not the first attempt's error")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRunReviewWithRetriesExhaustsRetries(): Promise<void> {
	const ws = await makeWorkspace()
	try {
		// Every attempt (1 initial + 2 retries = 3 total) hits the same
		// bounded-failure via a nonexistent read_file, 3 calls each.
		const failingAttempt = (): Array<() => ChatMessage> => [
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
			() => toolCall("read_file", { path: "does/not/exist.txt" }),
		]
		const client = new FakeLlmClient([...failingAttempt(), ...failingAttempt(), ...failingAttempt()])
		const result = await runReviewWithRetries({ workspaceRoot: ws, llmClient: client, maxIterations: 5 }, 2)
		assert.equal(result.verdict, "error", "after exhausting retries, the caller must get the final error back")
		assert.ok(result.findings[0]?.includes("review session error"), "error findings should be labeled as such")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
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
	["a 'no reopen' aside explaining nothing needs action stays clean", testNoReopenAsideDoesNotMarkFinding],
	["structured VERDICT: CLEAN wins over contradictory prose", testStructuredVerdictCleanWinsOverContradictoryProse],
	["structured VERDICT: FINDING wins even with clean language everywhere", testStructuredVerdictFindingWinsEvenWithCleanLanguageEverywhere],
	["structured VERDICT: CLEAN ignores baseline 'N failed' counts", testStructuredVerdictIgnoresBaselineFailedCounts],
	["structured VERDICT: CLEAN ignores a 'no reopen' aside", testStructuredVerdictIgnoresNoReopenAside],
	["structured verdict line is case-insensitive and trims whitespace", testStructuredVerdictIsCaseInsensitiveAndTrimsWhitespace],
	["missing structured verdict falls back to the heuristic", testMissingStructuredVerdictFallsBackToHeuristic],
	["bare 'wrong'/'regression'/'does not' in clean prose does not mark a finding", testBareWrongRegressionDoesNotMarkFinding],
	["runReview writes a tailable review.log, appended across sessions (not truncated)", testRunReviewWritesATailableLogFile],
	["runReview task text designates workspace scratch and forbids /tmp (issue #123)", testRunReviewTaskTextForbidsTmpAndPointsAtWorkspaceScratch],
	["runReview surfaces the complete final report path (issue #34)", testRunReviewSurfacesFullReportPath],
	["runReviewWithRetries: a normal clean verdict returns immediately, no retry", testRunReviewWithRetriesReturnsCleanImmediately],
	["runReviewWithRetries: retries after a review-session error and succeeds on the 2nd attempt", testRunReviewWithRetriesRetriesAfterSessionError],
	["runReviewWithRetries: exhausts retries and returns the final error verdict", testRunReviewWithRetriesExhaustsRetries],
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
