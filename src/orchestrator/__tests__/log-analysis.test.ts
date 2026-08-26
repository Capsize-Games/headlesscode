/**
 * Unit tests for src/orchestrator/log-analysis.ts — deterministic session
 * log analysis (tool stats, stall detection, repeated-command detection).
 * Plain assert-based, no network, no real worktree — writes synthetic
 * events.jsonl files under a temp dir via appendEvent. Run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { appendEvent, type EventRecord } from "../../engine/events.js"
import { analyzeWorktreeSessions, formatAnalysisReport, listSessionIds } from "../log-analysis.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeTempWorkspace(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "log-analysis-test-"))
}

async function writeEvents(workspaceRoot: string, sessionId: string, records: Partial<EventRecord>[]): Promise<void> {
	for (const r of records) {
		await appendEvent(workspaceRoot, sessionId, {
			ts: new Date().toISOString(),
			sessionId,
			type: "tool_call",
			...r,
		} as EventRecord)
	}
}

function ts(offsetMs: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offsetMs).toISOString()
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testNoEventsDirReturnsUndefined(): Promise<void> {
	const dir = await makeTempWorkspace()
	const result = await analyzeWorktreeSessions(dir)
	assert.equal(result, undefined)
}

async function testToolCallAndErrorCounts(): Promise<void> {
	const dir = await makeTempWorkspace()
	await writeEvents(dir, "s1", [
		{ ts: ts(0), type: "tool_call", tool: "read_file", iteration: 1, args: "foo.ts" },
		{ ts: ts(1000), type: "tool_result", tool: "read_file", isError: false, iteration: 1, result: "ok" },
		{ ts: ts(2000), type: "tool_call", tool: "execute_command", iteration: 2, args: "npm test" },
		{ ts: ts(3000), type: "tool_result", tool: "execute_command", isError: true, iteration: 2, result: "boom" },
	])
	const result = await analyzeWorktreeSessions(dir)
	assert.ok(result)
	assert.equal(result?.toolCallCounts.read_file, 1)
	assert.equal(result?.toolCallCounts.execute_command, 1)
	assert.equal(result?.toolErrorCounts.execute_command, 1)
	assert.equal(result?.errorSamples.length, 1)
	assert.equal(result?.errorSamples[0]?.message, "boom")
	assert.equal(result?.maxIteration, 2)
}

async function testStallDetection(): Promise<void> {
	const dir = await makeTempWorkspace()
	await writeEvents(dir, "s1", [
		{ ts: ts(0), type: "iteration_start", iteration: 1 },
		// 20-minute gap, exceeds the 15-minute default threshold.
		{ ts: ts(20 * 60 * 1000), type: "iteration_start", iteration: 2 },
	])
	const result = await analyzeWorktreeSessions(dir)
	assert.ok(result)
	assert.equal(result?.stalls.length, 1)
	assert.equal(result?.stalls[0]?.afterIteration, 1)
	assert.ok(result?.findings.some((f) => f.includes("stall")))
}

async function testNoStallBelowThreshold(): Promise<void> {
	const dir = await makeTempWorkspace()
	await writeEvents(dir, "s1", [
		{ ts: ts(0), type: "iteration_start", iteration: 1 },
		{ ts: ts(5 * 60 * 1000), type: "iteration_start", iteration: 2 },
	])
	const result = await analyzeWorktreeSessions(dir)
	assert.ok(result)
	assert.equal(result?.stalls.length, 0)
}

async function testRepeatedCommandDetection(): Promise<void> {
	const dir = await makeTempWorkspace()
	const events: Partial<EventRecord>[] = []
	for (let i = 0; i < 4; i++) {
		events.push({
			ts: ts(i * 1000),
			type: "tool_call",
			tool: "execute_command",
			iteration: i + 1,
			args: "docker compose run --rm --no-deps server python -m pytest",
		})
	}
	events.push({ ts: ts(9000), type: "tool_call", tool: "execute_command", iteration: 5, args: "git status" })
	await writeEvents(dir, "s1", events)
	const result = await analyzeWorktreeSessions(dir)
	assert.ok(result)
	assert.equal(result?.repeatedCommands.length, 1)
	assert.equal(result?.repeatedCommands[0]?.count, 4)
	assert.match(result?.repeatedCommands[0]?.command ?? "", /docker compose run/)
	assert.ok(result?.findings.some((f) => f.includes("invoked 4 times")))
}

async function testRepeatedCommandBelowThresholdNotFlagged(): Promise<void> {
	const dir = await makeTempWorkspace()
	await writeEvents(dir, "s1", [
		{ ts: ts(0), type: "tool_call", tool: "execute_command", iteration: 1, args: "git status" },
		{ ts: ts(1000), type: "tool_call", tool: "execute_command", iteration: 2, args: "git status" },
	])
	const result = await analyzeWorktreeSessions(dir)
	assert.ok(result)
	assert.equal(result?.repeatedCommands.length, 0)
}

async function testMergesMultipleSessionsInWorktree(): Promise<void> {
	const dir = await makeTempWorkspace()
	await writeEvents(dir, "s1-original", [
		{ ts: ts(0), type: "tool_call", tool: "read_file", iteration: 1, args: "a.ts" },
	])
	await writeEvents(dir, "s2-rework", [
		{ ts: ts(1000), type: "tool_call", tool: "read_file", iteration: 1, args: "b.ts" },
	])
	const sessionIds = await listSessionIds(dir)
	assert.equal(sessionIds.length, 2)
	const result = await analyzeWorktreeSessions(dir)
	assert.ok(result)
	assert.equal(result?.sessionIds.length, 2)
	assert.equal(result?.totalEvents, 2)
	assert.equal(result?.toolCallCounts.read_file, 2)
}

async function testTokenUsageSummed(): Promise<void> {
	const dir = await makeTempWorkspace()
	await writeEvents(dir, "s1", [
		{ ts: ts(0), type: "llm_response", iteration: 1, hadToolCalls: false, inputTokens: 100, outputTokens: 10, cachedTokens: 50 },
		{ ts: ts(1000), type: "llm_response", iteration: 2, hadToolCalls: false, inputTokens: 200, outputTokens: 20, cachedTokens: 100 },
	])
	const result = await analyzeWorktreeSessions(dir)
	assert.ok(result)
	assert.equal(result?.tokenUsage.inputTokens, 300)
	assert.equal(result?.tokenUsage.outputTokens, 30)
	assert.equal(result?.tokenUsage.cachedTokens, 150)
}

async function testFormatAnalysisReportIsReadable(): Promise<void> {
	const dir = await makeTempWorkspace()
	await writeEvents(dir, "s1", [
		{ ts: ts(0), type: "tool_call", tool: "read_file", iteration: 1, args: "a.ts" },
	])
	const result = await analyzeWorktreeSessions(dir)
	assert.ok(result)
	const report = formatAnalysisReport(result!)
	assert.match(report, /Sessions: 1/)
	assert.match(report, /Tool calls: read_file=1/)
	assert.match(report, /Findings: none/)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: [string, () => Promise<void>][] = [
	["missing events dir -> undefined", testNoEventsDirReturnsUndefined],
	["tool call + error counts", testToolCallAndErrorCounts],
	["stall detected above threshold", testStallDetection],
	["no stall below threshold", testNoStallBelowThreshold],
	["repeated command detected + flagged", testRepeatedCommandDetection],
	["repeated command below threshold not flagged", testRepeatedCommandBelowThresholdNotFlagged],
	["merges multiple sessions in one worktree", testMergesMultipleSessionsInWorktree],
	["token usage summed across events", testTokenUsageSummed],
	["formatAnalysisReport renders readable text", testFormatAnalysisReportIsReadable],
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
	console.log(`\nAll ${tests.length} log-analysis tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
