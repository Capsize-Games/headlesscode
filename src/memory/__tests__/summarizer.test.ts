/**
 * Unit tests for src/memory/summarizer.ts — deterministic session summary
 * extraction + rolling recap. Plain assert-based (no framework).
 * Run via `npm test` → `tsx src/memory/__tests__/summarizer.test.ts`.
 */

import assert from "node:assert/strict"

import { buildRollingSummary, extractFacts, extractSessionSummary } from "../summarizer.js"
import type { ChatMessage, SessionResult } from "../../engine/types.js"
import type { SessionSummary } from "../types.js"

function toolMessage(name: string, content: string): ChatMessage {
	return { role: "tool", tool_call_id: `c_${Math.random()}`, name, content }
}

/** Assistant message with a tool call — the REAL shape the loop stores. */
function assistantToolCall(name: string, args: Record<string, unknown>): ChatMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: [
			{ id: `call_${Math.random()}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
		],
	}
}

function fakeResult(overrides: Partial<SessionResult> = {}): SessionResult {
	return {
		status: "success",
		result: "Done.",
		iterations: 3,
		toolCalls: 4,
		...overrides,
	}
}

function fakeSession(overrides: Partial<SessionSummary> = {}, createdAt?: string): SessionSummary {
	return {
		id: "summary_x",
		project: "proj",
		task: "task",
		outcome: "success",
		summary: "summary",
		facts: [],
		filesTouched: [],
		commandsRun: [],
		createdAt: createdAt ?? "2026-08-01T00:00:00.000Z",
		...overrides,
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

function testExtractionPopulatesFilesCommandsFacts(): void {
	const messages: ChatMessage[] = [
		assistantToolCall("write_to_file", { path: "src/client.ts", content: "x" }),
		assistantToolCall("read_file", { path: "README.md", offset: 1 }),
		assistantToolCall("execute_command", { command: "npm test" }),
		assistantToolCall("execute_command", { command: "npm run lint", cwd: "packages/core" }),
		// Fallback path: a tool message whose content is itself JSON args.
		toolMessage("read_file", JSON.stringify({ path: "FALLBACK.md", offset: 1 })),
	]
	const result = fakeResult({
		status: "success",
		result:
			"Convention: always run the test suite before pushing.\n" +
			"Note: the config loader lives in src/config.ts.",
	})

	const summary = extractSessionSummary(result, {
		taskText: "harden the test workflow",
		mode: "code",
		project: "proj",
		messages,
	})

	assert.equal(summary.outcome, "success")
	assert.equal(summary.project, "proj")
	assert.equal(summary.mode, "code")
	assert.match(summary.summary, /always run the test suite/)
	assert.ok(summary.filesTouched.includes("src/client.ts"), "write_to_file path recorded")
	assert.ok(summary.filesTouched.includes("README.md"), "read_file path recorded")
	assert.ok(summary.filesTouched.includes("FALLBACK.md"), "tool-message fallback path recorded")
	assert.ok(summary.filesTouched.includes("packages/core"), "execute_command cwd recorded as touched")
	assert.ok(summary.commandsRun.includes("npm test"), "execute_command recorded")
	assert.ok(summary.commandsRun.includes("npm run lint"), "second command recorded")
	assert.ok(summary.facts.length >= 1, "facts extracted from result text")
	assert.equal(summary.facts[0].kind, "convention")
	assert.ok(summary.facts[0].content.includes("always run the test suite"))
	assert.ok(summary.createdAt, "createdAt timestamp present")
}

function testOutcomeMappingFailure(): void {
	const result = fakeResult({ status: "error", error: "Bounded failure: 3 consecutive tool errors", result: undefined })
	const summary = extractSessionSummary(result, { taskText: "t", project: "proj" })
	assert.equal(summary.outcome, "failure")
	assert.match(summary.summary, /Bounded failure/)
}

function testExtractFactsKindMappingAndCap(): void {
	// "things that didn't work" map to kind 'failure'.
	const facts = extractFacts("Never use the old scheduler — it breaks the queue.", { taskText: "t", project: "p" })
	assert.equal(facts[0].kind, "failure")
	assert.ok(facts[0].content.length <= 500, "fact content capped at 500 chars")

	// Cap: many keyword lines → at most MAX_FACTS_PER_SESSION.
	const manyLines = Array.from(
		{ length: 20 },
		(_, i) => `Convention number ${i}: always double-check the ${i}-th edge case.`,
	).join("\n")
	const capped = extractFacts(manyLines, { taskText: "t", project: "p" })
	assert.ok(capped.length <= 8, `facts capped at 8, got ${capped.length}`)

	// Dedupe: identical lines collapse.
	const duped = extractFacts("Rule: keep it simple.\nRule: keep it simple.", { taskText: "t", project: "p" })
	assert.equal(duped.length, 1)
}

function testRollingSummaryCapsEntries(): void {
	const sessions = Array.from({ length: 15 }, (_, i) =>
		fakeSession({ id: `s${i}`, outcome: i % 2 === 0 ? "success" : "failure" }, `2026-08-01T00:${String(i).padStart(2, "0")}:00.000Z`),
	)
	const recap = buildRollingSummary(sessions, 10)
	const entries = recap.split("\n").filter((l) => l.startsWith("**") && l.includes("outcome:"))
	assert.equal(entries.length, 10, "rolling recap keeps at most maxEntries sessions")
	// Most recent first: first entry is the newest session.
	assert.ok(recap.indexOf("00:14:00") < recap.indexOf("00:13:00"))
}

function testRollingSummaryEmpty(): void {
	const recap = buildRollingSummary([], 10)
	assert.match(recap, /No prior sessions recorded/)
}

function testRollingSummaryIncludesKeyFacts(): void {
	const session = fakeSession({ facts: [{ id: "f1", project: "proj", kind: "convention", content: "always lint", tags: ["convention"], createdAt: "x" }] })
	const recap = buildRollingSummary([session])
	assert.match(recap, /\[convention\] always lint/)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => void]> = [
	["extraction populates filesTouched/commandsRun/facts", testExtractionPopulatesFilesCommandsFacts],
	["outcome mapping: error result → failure", testOutcomeMappingFailure],
	["extractFacts kind mapping (failure), cap + dedupe", testExtractFactsKindMappingAndCap],
	["rolling summary caps entries and orders newest first", testRollingSummaryCapsEntries],
	["rolling summary on empty history", testRollingSummaryEmpty],
	["rolling summary renders key facts", testRollingSummaryIncludesKeyFacts],
]

function main(): void {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			fn()
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
	console.log(`\nAll ${tests.length} summarizer tests passed`)
}

main()
