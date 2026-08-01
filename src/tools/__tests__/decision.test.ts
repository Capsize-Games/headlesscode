/**
 * Unit tests for decision escalation (src/tools/executor.ts's
 * ask_followup_question handler) + the budget-clock pause/resume it drives
 * (src/budget/budget.ts's BudgetTracker.pauseClock/resumeClock). Plain
 * assert-based script (no test framework, no network), run via
 * `npm test` -> `tsx src/tools/__tests__/decision.test.ts`.
 *
 * Poll intervals and timeouts are all short (tens of ms), never the
 * production defaults (5s poll / 30min timeout), so this suite is fast.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { createHeadlessExecutor } from "../executor.js"
import { BudgetTracker } from "../../budget/budget.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

const NEEDS_DECISION = ".harness.needs-decision"
const DECISION_ANSWER = ".harness.decision-answer"

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

// ─── (a) answer arrives before timeout ──────────────────────────────────────

async function testAnswerArrivesBeforeTimeout(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-decision-answer-")
	try {
		const executor = createHeadlessExecutor(ws, { decisionTimeoutMs: 5_000, decisionPollIntervalMs: 20 })

		const execPromise = executor.execute("ask_followup_question", {
			question: "Which config file should I edit?",
			follow_up: [
				{ text: "./src/frontend-config.json", mode: null },
				{ text: "./config/frontend-config.json", mode: null },
			],
		})

		// Give the handler a moment to write the marker, then assert its shape.
		await sleep(60)
		const markerPath = path.join(ws, NEEDS_DECISION)
		assert.ok(await exists(markerPath), "needs-decision marker should exist while blocked")
		const markerRaw = JSON.parse(await fs.readFile(markerPath, "utf-8"))
		assert.equal(markerRaw.question, "Which config file should I edit?")
		assert.deepEqual(markerRaw.suggestions, ["./src/frontend-config.json", "./config/frontend-config.json"])
		assert.ok(typeof markerRaw.askedAt === "string" && !Number.isNaN(Date.parse(markerRaw.askedAt)))

		// Answer it.
		await fs.writeFile(path.join(ws, DECISION_ANSWER), "Use ./src/frontend-config.json\n", "utf-8")

		const result = await execPromise
		assert.equal(result.isError, false, "a real answer must be a NON-error tool result")
		assert.match(result.content, /Use \.\/src\/frontend-config\.json/, "the model should see the real answer text")

		assert.equal(await exists(markerPath), false, "needs-decision marker must be cleaned up")
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "decision-answer marker must be cleaned up")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) timeout elapses with no answer ─────────────────────────────────────

async function testTimeoutFallsBackToAutonomousDecision(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-decision-timeout-")
	try {
		const executor = createHeadlessExecutor(ws, { decisionTimeoutMs: 60, decisionPollIntervalMs: 15 })

		const result = await executor.execute("ask_followup_question", {
			question: "Should I delete the old branch?",
			follow_up: [{ text: "Yes", mode: null }],
		})

		// Exactly today's pre-escalation fallback text/isError.
		assert.equal(result.isError, true, "timeout must fall back to today's error behavior")
		assert.match(result.content, /non-interactive/i)
		assert.match(result.content, /must decide autonomously/i)
		assert.match(result.content, /Should I delete the old branch\?/)

		assert.equal(await exists(path.join(ws, NEEDS_DECISION)), false, "needs-decision marker must be cleaned up on timeout")
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "no decision-answer marker should exist")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c1) budget clock pause/resume excludes blocked time (pure) ───────────

async function testBudgetPauseResumeExcludesBlockedTime(): Promise<void> {
	let nowMs = 1_000_000
	const now = () => nowMs
	const tracker = new BudgetTracker({ maxDurationMs: 10_000 }, { now })

	now2(100) // 100ms of "real" work
	tracker.pauseClock()
	now2(5_000) // 5s blocked waiting on a human — must NOT count toward maxDurationMs
	tracker.resumeClock()
	now2(100) // another 100ms of real work

	function now2(ms: number): void {
		nowMs += ms
	}

	assert.equal(tracker.elapsedMs, 200, "blocked interval must be excluded from elapsedMs")
	// Well under the 10s cap despite ~5.2s of real wall-clock time having passed.
	assert.equal(tracker.check().ok, true)

	// Querying elapsedMs WHILE still paused also excludes the in-progress block.
	tracker.pauseClock()
	now2(3_000)
	assert.equal(tracker.elapsedMs, 200, "elapsedMs must exclude an in-progress (unresumed) block too")
	tracker.resumeClock()
	assert.equal(tracker.elapsedMs, 200, "resuming without further advance keeps elapsedMs unchanged")
}

// ─── (c2) the executor actually pauses/resumes the wired budget clock ──────

async function testExecutorWiresBudgetClockHooksAroundTheWait(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-decision-budget-wire-")
	try {
		const full = createHeadlessExecutor(ws, { decisionTimeoutMs: 5_000, decisionPollIntervalMs: 20 })

		const events: string[] = []
		full.setBudgetClockHooks(
			() => events.push("pause"),
			() => events.push("resume"),
		)

		const execPromise = full.execute("ask_followup_question", { question: "q?", follow_up: [{ text: "a", mode: null }] })
		await sleep(40)
		assert.deepEqual(events, ["pause"], "pauseBudgetClock must be called before the blocking wait")

		await fs.writeFile(path.join(ws, DECISION_ANSWER), "an answer", "utf-8")
		await execPromise

		assert.deepEqual(events, ["pause", "resume"], "resumeBudgetClock must be called once the wait ends")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["ask_followup_question: answer arrives before timeout -> non-error result, markers cleaned up", testAnswerArrivesBeforeTimeout],
	["ask_followup_question: timeout -> falls back to today's error, marker cleaned up", testTimeoutFallsBackToAutonomousDecision],
	["BudgetTracker: pauseClock/resumeClock excludes blocked time from elapsedMs", testBudgetPauseResumeExcludesBlockedTime],
	["ToolExecutor: wires pause/resume hooks around the ask_followup_question wait", testExecutorWiresBudgetClockHooksAroundTheWait],
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
	console.log(`\nAll ${tests.length} decision-escalation tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
