/**
 * Unit tests for src/budget/budget.ts — the per-session BudgetTracker + the
 * HeadlessSession integration (status 'error', reason 'budget', budgetUsage).
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/budget/__tests__/budget.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../../engine/loop.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../../engine/types.js"
import {
	BudgetExceededError,
	BudgetTracker,
	sessionBudgetFromEnv,
	type SessionBudget,
} from "../budget.js"
import type { PricingTable } from "../cost.js"

// Cheap model for deterministic math: $1/1M in, $2/1M out → 1000 in + 1000 out
// = (1000*1 + 1000*2)/1e6 = $0.003 per call.
const TEST_PRICING: PricingTable = { "cheap/model": { input: 1, output: 2 } }
const TEST_MODEL = "cheap/model"

/** Controllable clock for duration tests. */
class FakeClock {
	private nowMs = 1_000_000
	now = (): number => this.nowMs
	advance(ms: number): void {
		this.nowMs += ms
	}
}

function costTracker(budget: SessionBudget, now?: () => number): BudgetTracker {
	return new BudgetTracker(budget, { now, pricing: TEST_PRICING })
}

// ─── Pure BudgetTracker tests ────────────────────────────────────────────────

async function testUnderBudgetOk(): Promise<void> {
	const clock = new FakeClock()
	const t = costTracker({ maxCostUsd: 1, maxDurationMs: 10_000, maxIterations: 10 }, clock.now)
	clock.advance(500)
	t.tick()
	t.record({ model: TEST_MODEL, inputTokens: 1000, outputTokens: 1000 })
	clock.advance(500)
	t.tick()
	t.record({ model: TEST_MODEL, inputTokens: 1000, outputTokens: 1000 })

	const check = t.check()
	assert.equal(check.ok, true, "well under budget -> ok")
	assert.equal(check.reason, undefined)
	assert.ok(Math.abs(check.costUsd - 0.006) < 1e-9, `cost accumulated to ${check.costUsd}`)
	assert.equal(check.elapsedMs, 1000)
	assert.equal(check.iterations, 2)
	assert.equal(t.totalCostUsd, 0.006)
	assert.equal(t.iterationCount, 2)
}

async function testCostTripsAtThreshold(): Promise<void> {
	const t = costTracker({ maxCostUsd: 0.005 })
	// $0.003 per call — two calls = $0.006 >= $0.005.
	t.tick()
	t.record({ model: TEST_MODEL, inputTokens: 1000, outputTokens: 1000 })
	t.tick()
	assert.throws(
		() => t.record({ model: TEST_MODEL, inputTokens: 1000, outputTokens: 1000 }),
		(err) => {
			assert.ok(err instanceof BudgetExceededError, "throws BudgetExceededError")
			assert.equal((err as BudgetExceededError).reason, "cost")
			assert.ok(Math.abs((err as BudgetExceededError).costUsd - 0.006) < 1e-9)
			return true
		},
	)
	const check = t.check()
	assert.equal(check.ok, false)
	assert.equal(check.reason, "cost")
	assert.ok(Math.abs(check.costUsd - 0.006) < 1e-9)
}

async function testCostTripsOnFirstRecord(): Promise<void> {
	// A cap below the cost of ONE call trips immediately after that call.
	const t = costTracker({ maxCostUsd: 0.001 })
	t.tick()
	assert.throws(() => t.record({ model: TEST_MODEL, inputTokens: 1000, outputTokens: 1000 }), /Budget exceeded: cost/)
	assert.equal(t.check().reason, "cost")
}

async function testTrackCostFalseNeverAccumulatesOrTrips(): Promise<void> {
	// Issue #144: local-backend sessions pass trackCost: false — cost must
	// stay 0 forever (never computed at all, not just discarded) and
	// maxCostUsd must never trip, even set low enough that it WOULD trip
	// immediately with tracking on (see testCostTripsOnFirstRecord above).
	const t = new BudgetTracker({ maxCostUsd: 0.001, maxDurationMs: 10_000, maxIterations: 10 }, { pricing: TEST_PRICING, trackCost: false })
	for (let i = 0; i < 5; i++) {
		t.tick()
		t.record({ model: TEST_MODEL, inputTokens: 1000, outputTokens: 1000 })
	}
	assert.equal(t.totalCostUsd, 0, "cost must stay exactly 0 with trackCost: false")
	assert.equal(t.check().ok, true, "a maxCostUsd cap that would otherwise trip immediately must never trip")
}

async function testDurationTrips(): Promise<void> {
	const clock = new FakeClock()
	const t = costTracker({ maxDurationMs: 100 }, clock.now)
	clock.advance(101)
	// tick() re-checks elapsed before every call.
	assert.throws(() => t.tick(), (err) => {
		assert.ok(err instanceof BudgetExceededError)
		assert.equal((err as BudgetExceededError).reason, "duration")
		return true
	})
	assert.equal(t.check().ok, false)
	assert.equal(t.check().reason, "duration")
	assert.equal(t.check().elapsedMs, 101)
}

async function testIterationsCap(): Promise<void> {
	const t = costTracker({ maxIterations: 2 })
	t.tick()
	t.tick()
	assert.throws(() => t.tick(), (err) => {
		assert.ok(err instanceof BudgetExceededError)
		assert.equal((err as BudgetExceededError).reason, "iterations")
		return true
	})
	assert.equal(t.check().reason, "iterations")
	assert.equal(t.check().iterations, 3)
}

async function testCheckReasons(): Promise<void> {
	// check() reports the FIRST tripped limit in order: duration > iterations > cost.
	const clock = new FakeClock()
	const both = costTracker({ maxDurationMs: 50, maxIterations: 1, maxCostUsd: 0.001 }, clock.now)
	clock.advance(60)
	{
		const c = both.check()
		assert.equal(c.ok, false)
		assert.equal(c.reason, "duration")
	}
	// Cost-only reason when no other limit is set (record throws, check flags).
	const cost = costTracker({ maxCostUsd: 0.001 })
	cost.tick()
	assert.throws(() => cost.record({ model: TEST_MODEL, inputTokens: 1000, outputTokens: 1000 }), /Budget exceeded: cost/)
	assert.equal(cost.check().reason, "cost")
	// No limits at all -> always ok.
	const none = costTracker({})
	none.tick()
	none.record({ model: TEST_MODEL, inputTokens: 10_000_000, outputTokens: 10_000_000 })
	assert.equal(none.check().ok, true)
}

async function testSessionBudgetFromEnv(): Promise<void> {
	const savedCost = process.env.HEADLESSCODE_MAX_COST_USD
	const savedDuration = process.env.HEADLESSCODE_MAX_DURATION_MS
	try {
		delete process.env.HEADLESSCODE_MAX_COST_USD
		delete process.env.HEADLESSCODE_MAX_DURATION_MS
		assert.equal(sessionBudgetFromEnv(), undefined, "no env -> no budget")

		process.env.HEADLESSCODE_MAX_COST_USD = "0.05"
		assert.deepEqual(sessionBudgetFromEnv(), { maxCostUsd: 0.05 })

		process.env.HEADLESSCODE_MAX_DURATION_MS = "60000"
		assert.deepEqual(sessionBudgetFromEnv(), { maxCostUsd: 0.05, maxDurationMs: 60000 })

		process.env.HEADLESSCODE_MAX_COST_USD = "not-a-number"
		assert.deepEqual(sessionBudgetFromEnv(), { maxDurationMs: 60000 }, "invalid cost ignored, duration kept")
	} finally {
		if (savedCost === undefined) {
			delete process.env.HEADLESSCODE_MAX_COST_USD
		} else {
			process.env.HEADLESSCODE_MAX_COST_USD = savedCost
		}
		if (savedDuration === undefined) {
			delete process.env.HEADLESSCODE_MAX_DURATION_MS
		} else {
			process.env.HEADLESSCODE_MAX_DURATION_MS = savedDuration
		}
	}
}

// ─── HeadlessSession integration ─────────────────────────────────────────────

class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []
	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly usage: { promptTokens: number; completionTokens: number },
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (model kept calling)")
		}
		return {
			message: step(request),
			usage: {
				promptTokens: this.usage.promptTokens,
				completionTokens: this.usage.completionTokens,
				totalTokens: this.usage.promptTokens + this.usage.completionTokens,
			},
		}
	}
}

function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2)}`): ChatMessage {
	const call: ChatToolCall = { id, type: "function", function: { name, arguments: JSON.stringify(args) } }
	return { role: "assistant", content: null, tool_calls: [call] }
}

function textReply(content: string): ChatMessage {
	return { role: "assistant", content }
}

/**
 * The session model "fake-budget-model" is not in the default pricing table,
 * so it falls back to FALLBACK_MODEL_PRICE (2/8 per 1M). With 1000/1000
 * tokens per call the cost is (1000*2 + 1000*8)/1e6 = $0.01 per call — a cap
 * of $0.005 trips on the FIRST recorded call deterministically.
 */
async function testSessionBudgetTripsMidRun(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-budget-session-"))
	try {
		// The model would otherwise succeed (read -> attempt_completion); the
		// budget trips before it can finish.
		const client = new FakeLlmClient(
			[
				() => toolCall("read_file", { path: "a.txt" }),
				() => toolCall("attempt_completion", { result: "would have succeeded" }),
			],
			{ promptTokens: 1000, completionTokens: 1000 },
		)
		const session = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-budget-model",
			taskText: "do the thing",
			maxIterations: 5,
			llmClient: client,
			budget: { maxCostUsd: 0.005 },
			checkpoints: false,
		})
		const result = await session.run()

		assert.equal(result.status, "error", `expected budget abort, got ${JSON.stringify(result)}`)
		assert.equal(result.reason, "budget", "reason is 'budget'")
		assert.match(result.error ?? "", /Budget exceeded: cost/)
		assert.equal(result.iterations, 1, "aborted after the first LLM call")
		assert.equal(result.toolCalls, 0)
		// budgetUsage is populated from the tracker.
		assert.ok(result.budgetUsage, "budgetUsage surfaced on the result")
		assert.ok(Math.abs((result.budgetUsage?.costUsd ?? 0) - 0.01) < 1e-9, "cost ≈ $0.01 for one call")
		assert.equal(result.budgetUsage?.iterations, 1)
		assert.equal(result.budgetUsage?.model, "fake-budget-model")
		assert.ok(result.budgetUsage && result.budgetUsage.elapsedMs >= 0)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSessionBudgetDefaultOff(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-budget-off-"))
	try {
		// No budget config -> no enforcement (still succeeds), but usage
		// accounting (workstream 3) is now UNCONDITIONAL: budgetUsage is always
		// present, with no limits tripped, reflecting the real accumulated
		// cost/tokens rather than being absent.
		const client = new FakeLlmClient(
			[
				() => toolCall("read_file", { path: "a.txt" }),
				() => textReply("done without a budget"),
			],
			{ promptTokens: 1000, completionTokens: 1000 },
		)
		const session = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-budget-model",
			taskText: "do the thing",
			maxIterations: 5,
			llmClient: client,
			checkpoints: false,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.ok(result.budgetUsage, "usage accounting is unconditional now -> budgetUsage always present")
		assert.equal(result.budgetUsage?.iterations, 2, "two LLM calls happened")
		assert.ok((result.budgetUsage?.costUsd ?? 0) > 0, "cost accumulated even with no budget configured")
		assert.equal(result.budgetUsage?.model, "fake-budget-model")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSessionBudgetIterationsCap(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-budget-iters-"))
	try {
		// Iteration cap 1: the second tick() trips BEFORE the second LLM call.
		const client = new FakeLlmClient(
			[
				() => toolCall("read_file", { path: "a.txt" }),
				() => toolCall("attempt_completion", { result: "too late" }),
			],
			{ promptTokens: 1000, completionTokens: 1000 },
		)
		const session = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-budget-model",
			taskText: "do the thing",
			maxIterations: 5,
			llmClient: client,
			budget: { maxIterations: 1 },
			checkpoints: false,
		})
		const result = await session.run()
		assert.equal(result.status, "error")
		assert.equal(result.reason, "budget")
		assert.match(result.error ?? "", /Budget exceeded: iterations/)
		assert.equal(client.requests.length, 1, "only one LLM call happened before the cap tripped")
		assert.ok(result.budgetUsage && result.budgetUsage.iterations >= 1)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["tracker: under budget -> ok with correct costUsd/elapsedMs/iterations", testUnderBudgetOk],
	["tracker: cost trips at the threshold (record throws, check flags)", testCostTripsAtThreshold],
	["tracker: cost trips on the first record below one call's cost", testCostTripsOnFirstRecord],
	["tracker: trackCost false never accumulates cost or trips maxCostUsd (#144)", testTrackCostFalseNeverAccumulatesOrTrips],
	["tracker: duration trips via a fake clock (tick re-checks elapsed)", testDurationTrips],
	["tracker: iterations cap trips on the (maxIterations+1)th tick", testIterationsCap],
	["tracker: check() reports the correct reason", testCheckReasons],
	["sessionBudgetFromEnv: env -> budget, unset/invalid handled", testSessionBudgetFromEnv],
	["session: budget trips mid-run -> status error, reason budget, budgetUsage populated", testSessionBudgetTripsMidRun],
	["session: budget default off -> success, budgetUsage still present (accounting is unconditional)", testSessionBudgetDefaultOff],
	["session: iterations cap trips before the next LLM call", testSessionBudgetIterationsCap],
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
	console.log(`\nAll ${tests.length} budget tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
