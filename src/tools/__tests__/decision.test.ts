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

import { createHeadlessExecutor, createReadOnlyHeadlessExecutor } from "../executor.js"
import { BudgetTracker } from "../../budget/budget.js"
import { HeadlessSession } from "../../engine/loop.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../../engine/types.js"
import type { PermissionsConfig } from "../../permissions/config.js"

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

// ─── (b2) BUG-3: an answer written in the narrow window between the poll
// loop's LAST read-miss and the deadline must still be cleaned up, or it
// poisons a LATER, unrelated escalation ─────────────────────────────────────

async function testTimeoutAlsoCleansUpAStaleAnswerFile(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-decision-stale-answer-")
	try {
		// A single poll iteration: the loop reads (miss) at t=0, then sleeps the
		// full timeout window and exits WITHOUT reading again (Date.now() >=
		// deadline by the time the sleep resolves). Writing the answer file
		// partway through that sleep reproduces the exact race BUG-3 describes:
		// the write lands after the last read but before the timeout path's
		// cleanup runs.
		const executor = createHeadlessExecutor(ws, { decisionTimeoutMs: 80, decisionPollIntervalMs: 80 })

		const execPromise = executor.execute("ask_followup_question", {
			question: "Should I delete the old branch?",
			follow_up: [{ text: "Yes", mode: null }],
		})
		// Land the write mid-window — after the loop's only read, before the
		// deadline the loop is sleeping out.
		void (async () => {
			await sleep(40)
			await fs.writeFile(path.join(ws, DECISION_ANSWER), "Yes, delete it\n", "utf-8")
		})()

		// Do NOT assert on whether this resolves as "timedOut" or "answered" —
		// under real timer/scheduling jitter, the poll loop can legitimately
		// execute a second read before the deadline and find the race-landed
		// answer, which is a valid outcome of a genuine real-time race, not a
		// bug (this was the actual cause of this test's ~15-20% flake rate).
		// escalateDecision's "answered" branch unlinks both marker files too,
		// exactly like the timedOut branch — so the real regression guard
		// below (BUG-3: no stale answer file survives) holds either way.
		await execPromise

		assert.equal(
			await exists(path.join(ws, DECISION_ANSWER)),
			false,
			"BUG-3: a decision-answer file written just after the poll deadline must be unlinked, whichever path the race resolves through",
		)
		assert.equal(await exists(path.join(ws, NEEDS_DECISION)), false)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

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

// ─── Permissions enforcement (session-level) ────────────────────────────────

/** Minimal fake LLM client — mirrors src/engine/__tests__/loop.test.ts. */
class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []

	constructor(private readonly script: Array<(req: LlmRequest) => ChatMessage>) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (model kept calling)")
		}
		return { message: step(request) }
	}
}

function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2)}`): ChatMessage {
	const call: ChatToolCall = { id, type: "function", function: { name, arguments: JSON.stringify(args) } }
	return { role: "assistant", content: null, tool_calls: [call] }
}

/** Zero-policy permissions: nothing configured, nothing protected, hatch off. */
const EMPTY_PERMISSIONS: PermissionsConfig = {
	allowedCommands: [],
	deniedCommands: [],
	protectedFiles: [],
	allowProtectedWrites: false,
}

/** The most recent `tool` message for a tool name, or null (scan backwards). */
function lastToolMessage(session: HeadlessSession, name: string): string | null {
	const messages = session.state.messages
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m.role === "tool" && m.name === name) {
			return m.content
		}
	}
	return null
}

// ─── (d1) a denied command is isError:true AND counts as a mistake ──────────

async function testDeniedCommandIsErrorAndCountsAsMistake(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-perm-denied-cmd-")
	try {
		// A NON-store target: `rm -rf /` would now be refused by the always-on
		// central-store protection (a parent of the store), not by the deny-list
		// — this test must exercise the deny-list refusal path specifically.
		const client = new FakeLlmClient([() => toolCall("execute_command", { command: "rm -rf /opt/scratch-x" })])
		const session = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "run a command",
			llmClient: client,
			maxIterations: 5,
			// One refusal must trip the bounded-failure bound: the refusal IS a mistake.
			consecutiveErrorLimit: 1,
			checkpoints: false,
			permissions: { ...EMPTY_PERMISSIONS, deniedCommands: ["rm"] },
		})

		const result = await session.run()
		assert.equal(result.status, "error", `expected bounded failure, got ${JSON.stringify(result)}`)
		// NOTE: the loop's boundedFailure template reads "1 consecutive
		// consecutive mistakes" (a pre-existing wording quirk in src/engine/loop.ts)
		// — match the stable prefix.
		assert.match(
			result.error ?? "",
			/Bounded failure: 1 consecutive/,
			"a permissions refusal must count toward the consecutive-mistake counter",
		)

		const toolMsg = lastToolMessage(session, "execute_command")
		assert.ok(toolMsg !== null, "the refusal result must be fed back to the model")
		assert.match(toolMsg ?? "", /refusing to run/, "refusal message should be explicit")
		assert.match(toolMsg ?? "", /denied by the permissions policy/, "refusal must explain why")
		assert.match(toolMsg ?? "", /rm -rf \//, "refusal must name the offending sub-command")
		assert.match(toolMsg ?? "", /denied pattern 'rm'/, "refusal must name the matched pattern")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d2) a protected-file write is isError:true AND counts as a mistake ────

async function testProtectedWriteIsErrorAndCountsAsMistake(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-perm-prot-write-")
	try {
		const client = new FakeLlmClient([() => toolCall("write_to_file", { path: ".env", content: "API_KEY=leaked" })])
		const session = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "write a config",
			llmClient: client,
			maxIterations: 5,
			consecutiveErrorLimit: 1,
			checkpoints: false,
			permissions: { ...EMPTY_PERMISSIONS, protectedFiles: [".env"] },
		})

		const result = await session.run()
		assert.equal(result.status, "error", `expected bounded failure, got ${JSON.stringify(result)}`)
		// See the note in testDeniedCommandIsErrorAndCountsAsMistake: the loop's
		// message reads "1 consecutive consecutive mistakes".
		assert.match(
			result.error ?? "",
			/Bounded failure: 1 consecutive/,
			"a protected-file refusal must count toward the consecutive-mistake counter",
		)

		const toolMsg = lastToolMessage(session, "write_to_file")
		assert.ok(toolMsg !== null, "the refusal result must be fed back to the model")
		assert.match(toolMsg ?? "", /refusing to write protected file '\.env'/, "refusal must name the file")
		assert.match(toolMsg ?? "", /protected pattern '\.env'/, "refusal must name the matched pattern")
		assert.match(toolMsg ?? "", /allow-protected-writes/, "refusal must mention the escape hatch")

		// The protected file must never be written.
		await assert.rejects(fs.access(path.join(ws, ".env")), "protected file must not exist after the refusal")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d3) the escape hatch actually bypasses protected-file enforcement ─────

async function testAllowProtectedWritesEscapeHatchWorks(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-perm-escape-")
	try {
		const executor = createHeadlessExecutor(ws, {
			permissions: { ...EMPTY_PERMISSIONS, protectedFiles: [".env"], allowProtectedWrites: true },
		})
		const result = await executor.execute("write_to_file", { path: ".env", content: "OK" })
		assert.equal(result.isError, false, "the escape hatch must permit the protected write")
		assert.match(result.content, /File written: \.env/)
		assert.equal(await fs.readFile(path.join(ws, ".env"), "utf-8"), "OK")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d4) reviewer/QA read-only executors gate execute_command too ──────────

async function testReadOnlyExecutorAlsoGatesCommands(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-perm-reviewer-")
	try {
		const executor = createReadOnlyHeadlessExecutor(ws, {
			permissions: { ...EMPTY_PERMISSIONS, deniedCommands: ["gh"] },
		})
		const denied = await executor.execute("execute_command", { command: "gh repo delete foo" })
		assert.equal(denied.isError, true, "reviewer/QA execute_command must be gated by the same allow/deny logic")
		assert.match(denied.content, /denied by the permissions policy/)

		const allowed = await executor.execute("execute_command", { command: "echo ok" })
		assert.equal(allowed.isError, false, "a non-denied command must still run for reviewer/QA")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["ask_followup_question: answer arrives before timeout -> non-error result, markers cleaned up", testAnswerArrivesBeforeTimeout],
	["ask_followup_question: timeout -> falls back to today's error, marker cleaned up", testTimeoutFallsBackToAutonomousDecision],
	["ask_followup_question: BUG-3 — a race-landed answer file is still cleaned up on timeout", testTimeoutAlsoCleansUpAStaleAnswerFile],
	["BudgetTracker: pauseClock/resumeClock excludes blocked time from elapsedMs", testBudgetPauseResumeExcludesBlockedTime],
	["ToolExecutor: wires pause/resume hooks around the ask_followup_question wait", testExecutorWiresBudgetClockHooksAroundTheWait],
	["permissions: denied execute_command is isError:true and counts as a mistake (session-level)", testDeniedCommandIsErrorAndCountsAsMistake],
	["permissions: protected-file write_to_file is isError:true and counts as a mistake (session-level)", testProtectedWriteIsErrorAndCountsAsMistake],
	["permissions: --allow-protected-writes escape hatch permits the protected write", testAllowProtectedWritesEscapeHatchWorks],
	["permissions: reviewer/QA read-only executor gates execute_command identically", testReadOnlyExecutorAlsoGatesCommands],
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
	console.log(`\nAll ${tests.length} executor tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
