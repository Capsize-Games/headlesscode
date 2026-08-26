/**
 * Tests for dashboard-initiated pause/resume (src/engine/loop.ts's
 * `checkPauseRequested` + the `.harness.pause-requested` marker protocol).
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/engine/__tests__/pause.test.ts`.
 *
 * Mirrors the decision-escalation budget-pause test's fake-clock pattern
 * (src/tools/__tests__/decision.test.ts) plus the loop.test.ts scripted-fake
 * LlmClient pattern. Poll intervals and max-pause durations are all short
 * (tens of ms), never the production defaults (5s poll / 2h max).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { HeadlessSession } from "../loop.js"
import { BudgetTracker } from "../../budget/budget.js"
import { eventsDir, eventsFilePath, readEventsFile } from "../events.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"

const PAUSE_REQUESTED = ".harness.pause-requested"
const PAUSED = ".harness.paused"

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

/** Poll until `check()` returns true (default 5s timeout). */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await check()) {
			return
		}
		await sleep(20)
	}
	throw new Error("waitFor timed out")
}

// ─── Fake LLM client ─────────────────────────────────────────────────────────

class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []
	/**
	 * onCall fires before each createChatCompletion resolves. `call` is the
	 * 1-based call count. Tests use it to write the pause marker during the
	 * FIRST call so iteration 2's checkPauseRequested finds it.
	 */
	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly onCall?: (call: number) => Promise<void> | void,
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		const call = this.requests.length
		if (this.onCall) {
			await this.onCall(call)
		}
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (model kept calling)")
		}
		return { message: step(request) }
	}
}

function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2)}`): ChatMessage {
	const argumentsStr = typeof args === "string" ? args : JSON.stringify(args)
	const call: ChatToolCall = { id, type: "function", function: { name, arguments: argumentsStr } }
	return { role: "assistant", content: null, tool_calls: [call] }
}

function makeSession(ws: string, client: LlmClient, extra: Record<string, unknown> = {}) {
	return new HeadlessSession({
		workspaceRoot: ws,
		mode: "code",
		model: "fake-model",
		taskText: "write files",
		llmClient: client,
		maxIterations: 10,
		checkpoints: false,
		...extra,
	})
}

// ─── (a) the loop actually blocks between iterations ─────────────────────────

/**
 * A marker written between iterations 1 and 2 must stop the loop: iteration
 * 2 is not reached until the marker is removed.
 */
async function testLoopBlocksUntilMarkerRemoved(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-pause-block-"))
	try {
		let iteration2Reached = false
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
				() => toolCall("write_to_file", { path: "b.txt", content: "y" }),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			async (call) => {
				if (call === 1) {
					// Write the pause marker while the FIRST iteration's LLM
					// call is in flight — the checkPauseRequested at the top
					// of iteration 2 then finds it and blocks.
					await fs.writeFile(path.join(ws, PAUSE_REQUESTED), new Date().toISOString() + "\n", "utf-8")
				}
				if (call === 2) {
					// The second LLM call only happens AFTER the pause marker
					// was removed — a blocked loop never gets here.
					iteration2Reached = true
				}
			},
		)
		const session = makeSession(ws, client, { maxPauseMs: 60_000, pausePollIntervalMs: 20 })

		// Run the session; the marker is written during call 1.
		const runPromise = session.run()

		// The loop must block: the .harness.paused status marker appears and
		// iteration 2 is NOT reached while the request marker is present.
		await waitFor(async () => exists(path.join(ws, PAUSED)), 5_000)
		await sleep(150)
		assert.equal(iteration2Reached, false, "loop must not reach iteration 2 while paused")
		assert.ok(await exists(path.join(ws, PAUSE_REQUESTED)), "pause request marker still present while blocked")

		// Resume: remove the marker. The loop unblocks and continues.
		await fs.rm(path.join(ws, PAUSE_REQUESTED))
		const result = await runPromise
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(iteration2Reached, true, "loop must reach iteration 2 after the marker is removed")
		assert.equal(await exists(path.join(ws, PAUSED)), false, ".harness.paused marker must be cleaned up on resume")

		// The feed records paused + resumed.
		const files = await fs.readdir(eventsDir(ws))
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const events = await readEventsFile(eventsFilePath(ws, sessionId))
		assert.ok(events.some((e) => e.type === "paused"), "a paused event must be emitted")
		assert.ok(events.some((e) => e.type === "resumed"), "a resumed event must be emitted")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) budget-duration clock excludes paused time ──────────────────────────

/**
 * The budget clock must freeze while paused: mirror the decision-escalation
 * budget-pause test's fake-clock pattern (BudgetTracker.pauseClock /
 * resumeClock exclude blocked intervals from elapsedMs).
 */
async function testPauseExcludesBlockedTimeFromBudgetClock(): Promise<void> {
	// The pure tracker primitive.
	let nowMs = 1_000_000
	const now = () => nowMs
	const tracker = new BudgetTracker({ maxDurationMs: 10_000 }, { now })

	nowMs += 100 // 100ms of "real" work
	tracker.pauseClock()
	nowMs += 5_000 // 5s paused — must NOT count toward maxDurationMs
	tracker.resumeClock()
	nowMs += 100 // another 100ms of real work

	assert.equal(tracker.elapsedMs, 200, "paused interval must be excluded from elapsedMs")

	// The loop-level wiring: a pause via .harness.pause-requested drives the
	// same pauseClock/resumeClock on the session's budget tracker. Run a real
	// session with a budget that would trip if paused wall-clock counted.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-pause-budget-"))
	try {
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			async (call) => {
				if (call === 1) {
					// Write the pause marker during call 1; iteration 2's
					// checkPauseRequested then finds it and blocks. The test
					// below holds the pause for ~400ms and removes it — the
					// session's maxDurationMs is 300ms, so WITHOUT the clock
					// freeze iteration 2's pre-call tick() would trip the
					// budget and abort. With the freeze it must not.
					await fs.writeFile(path.join(ws, PAUSE_REQUESTED), new Date().toISOString() + "\n", "utf-8")
				}
			},
		)
		const session = makeSession(ws, client, { budget: { maxDurationMs: 300 }, maxPauseMs: 60_000, pausePollIntervalMs: 20 })
		const runPromise = session.run()

		// Hold the pause for ~400ms (well past the 300ms budget cap), then
		// release it.
		await waitFor(async () => exists(path.join(ws, PAUSED)), 5_000)
		await sleep(400)
		await fs.rm(path.join(ws, PAUSE_REQUESTED))
		const result = await runPromise

		// Without the clock freeze this would be status "error" / reason
		// "budget" (the 400ms pause would trip the 300ms cap). With the
		// freeze, the paused time is excluded and the session succeeds.
		assert.equal(result.status, "success", `paused time must be excluded from the budget, got ${JSON.stringify(result)}`)
		assert.ok((result.budgetUsage?.elapsedMs ?? 0) < 300, "elapsedMs must stay under the 300ms cap despite the 400ms pause")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) auto-resume after the max pause duration ────────────────────────────

/**
 * A forgotten pause must never hang a worker forever: with a short injected
 * max, the loop auto-resumes and emits a resumed event noting the reason.
 */
async function testAutoResumeAfterMaxPauseDuration(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-pause-auto-"))
	try {
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			async (call) => {
				if (call === 1) {
					// Write the pause marker and NEVER remove it — the loop
					// must auto-resume after maxPauseMs (80ms).
					await fs.writeFile(path.join(ws, PAUSE_REQUESTED), new Date().toISOString() + "\n", "utf-8")
				}
			},
		)
		const session = makeSession(ws, client, { maxPauseMs: 80, pausePollIntervalMs: 15 })

		const started = Date.now()
		const result = await session.run()
		const elapsed = Date.now() - started
		assert.equal(result.status, "success", `auto-resume must let the session finish, got ${JSON.stringify(result)}`)
		assert.ok(elapsed < 5_000, `auto-resume should fire after ~80ms, took ${elapsed}ms`)
		// The pause marker was never removed by the test — the loop resumed
		// on its own, but the .harness.paused status marker is cleaned up.
		assert.equal(await exists(path.join(ws, PAUSED)), false, ".harness.paused must be removed after auto-resume")

		const files = await fs.readdir(eventsDir(ws))
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const events = await readEventsFile(eventsFilePath(ws, sessionId))
		const resumed = events.find((e) => e.type === "resumed")
		assert.ok(resumed, "a resumed event must be emitted on auto-resume")
		assert.match(String(resumed?.reason ?? ""), /auto-resume/i, "the resumed event must note the auto-resume reason")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d) no pause marker -> zero behavior change ─────────────────────────────

async function testNoMarkerMeansNoBlocking(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-pause-none-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = makeSession(ws, client)
		const result = await session.run()
		assert.equal(result.status, "success")
		assert.equal(await exists(path.join(ws, PAUSED)), false, "no .harness.paused marker without a pause request")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["pause: loop blocks between iterations while the marker is present, resumes on removal", testLoopBlocksUntilMarkerRemoved],
	["pause: budget-duration clock excludes paused time (fake clock + real session)", testPauseExcludesBlockedTimeFromBudgetClock],
	["pause: auto-resume fires after the max pause duration (forgotten pause never hangs)", testAutoResumeAfterMaxPauseDuration],
	["pause: no marker -> zero behavior change", testNoMarkerMeansNoBlocking],
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
	console.log(`\nAll ${tests.length} pause tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
