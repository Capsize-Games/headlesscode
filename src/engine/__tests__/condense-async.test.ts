/**
 * Tests for async/background condensation (plans/smart-condensation-async.md
 * part 2): the condensation LLM call fires BEFORE the hard threshold, in the
 * background against an immutable snapshot, while the main loop keeps
 * appending. On resolve the summary is spliced into the LIVE history at the
 * re-resolved boundary; a slow/failed background never suppresses the
 * synchronous hard-threshold fallback; a session ending before resolution
 * discards the in-flight result but keeps its usage in the BudgetTracker.
 *
 * Plain assert-based script (no test framework, no network, no API key) run
 * via `npm test` → `tsx src/engine/__tests__/condense-async.test.ts`.
 * Mirrors the FakeLlmClient pattern of condense.test.ts, extended with
 * controllable condensation-response timing (deferred / auto-resolve after N
 * main calls) so the async race conditions are deterministic.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../loop.js"
import { DEFAULT_WINDOW_SIZE } from "../loop.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"
import { BudgetTracker } from "../../budget/budget.js"

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * FakeLlmClient + controllable condensation timing: condensation responses
 * can be DEFERRED (resolved later by the test via `resolveCondense`), or
 * auto-resolved once a given number of MAIN calls have been served (so a
 * background condensation lands after the conversation has grown). Main-call
 * usage is fixed (with per-request overrides, index-aligned with `requests`),
 * condensation usage is its own fixed value — the async tests drive the
 * early/hard thresholds through those token counts, exactly like the
 * synchronous condense tests do.
 */
class AsyncCondenseClient implements LlmClient {
	requests: LlmRequest[] = []
	/** Number of "condensation-style" calls (no tools, system is the condense prompt). */
	condenseCalls = 0
	/** Usage reported for EVERY main response. */
	usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number }
	/** Per-request usage override (index-aligned with `requests`). */
	usageOverrides: Array<{ promptTokens?: number; completionTokens?: number; cachedTokens?: number } | undefined> = []
	/** Usage reported for EVERY condensation response. */
	condenseUsage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number }
	/** Defer the first N condensation responses (test resolves them via `resolveCondense`). */
	private deferCondenseCalls: number
	private deferredCount = 0
	/**
	 * When set, the currently-deferred condensation auto-resolves (with
	 * `condenseReply`) once this many MAIN calls have been served.
	 */
	autoResolveCondenseAfterMainCalls: number | null = null
	/** Reply text for auto-resolved / immediate condensation responses. */
	condenseReply = "BACKGROUND SUMMARY"
	private mainCount = 0
	private pendingCondenseResolve: ((msg: ChatMessage) => void) | null = null

	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } = {},
		condenseUsage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } = {
			promptTokens: 1000,
			completionTokens: 100,
		},
		deferCondenseCalls = 0,
	) {
		this.usage = usage
		this.condenseUsage = condenseUsage
		this.deferCondenseCalls = deferCondenseCalls
	}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		const isCondense =
			!request.tools &&
			request.messages[0]?.role === "system" &&
			typeof request.messages[0]?.content === "string" &&
			request.messages[0].content.includes("conversation-compression engine")
		const idx = this.requests.length
		this.requests.push(request)
		if (isCondense) {
			this.condenseCalls++
			const condenseUsage = this.condenseUsage
			if (this.deferredCount < this.deferCondenseCalls) {
				this.deferredCount++
				// Deferred: the response resolves only when the test (or the
				// auto-resolve trigger) calls back — simulating a background
				// condensation still in flight while the main loop runs on.
				return new Promise<LlmResponse>((resolve) => {
					this.pendingCondenseResolve = (msg) => resolve({ message: msg, usage: condenseUsage })
					this.maybeAutoResolveCondense()
				})
			}
			return { message: textReply(this.condenseReply), usage: condenseUsage }
		}
		const step = this.script.shift()
		if (!step) {
			throw new Error("AsyncCondenseClient: script exhausted (model kept calling)")
		}
		this.mainCount++
		this.maybeAutoResolveCondense()
		const usage = this.usageOverrides[idx] ?? this.usage
		return { message: step(request), usage }
	}

	/** Resolve the currently-deferred condensation with the given summary text. */
	resolveCondense(summary: string): void {
		const resolve = this.pendingCondenseResolve
		if (!resolve) {
			throw new Error("resolveCondense: no deferred condensation pending")
		}
		this.pendingCondenseResolve = null
		resolve(textReply(summary))
	}

	private maybeAutoResolveCondense(): void {
		if (
			this.pendingCondenseResolve !== null &&
			this.autoResolveCondenseAfterMainCalls !== null &&
			this.mainCount >= this.autoResolveCondenseAfterMainCalls
		) {
			const resolve = this.pendingCondenseResolve
			this.pendingCondenseResolve = null
			resolve(textReply(this.condenseReply))
		}
	}
}

function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2)}`): ChatMessage {
	const argumentsStr = typeof args === "string" ? args : JSON.stringify(args)
	const call: ChatToolCall = { id, type: "function", function: { name, arguments: argumentsStr } }
	return { role: "assistant", content: null, tool_calls: [call] }
}

function textReply(content: string): ChatMessage {
	return { role: "assistant", content }
}

/** A session with the async-condensation config baked in (checkpoints off). */
function makeAsyncSession(options: {
	task: string
	client: LlmClient
	workspaceRoot: string
	budgetTracker?: BudgetTracker
	maxIterations?: number
	contextWindowTokens?: number
	condenseThresholdFraction?: number
	condenseEarlyFireFraction?: number
}) {
	return new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: options.maxIterations ?? 10,
		consecutiveErrorLimit: 3,
		windowSize: DEFAULT_WINDOW_SIZE,
		contextWindowTokens: options.contextWindowTokens ?? 128_000,
		condenseThresholdFraction: options.condenseThresholdFraction ?? 0.75,
		condenseEarlyFireFraction: options.condenseEarlyFireFraction ?? 0.6,
		// Internal plumbing so the test can inspect cost accounting after a
		// background call that resolves AFTER the session returned.
		budgetTracker: options.budgetTracker,
		// Checkpoints off — this suite isn't testing shadow-git.
		checkpoints: false,
	})
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function contentIncludes(m: ChatMessage, needle: string): boolean {
	return typeof m.content === "string" && m.content.includes(needle)
}

/** Flush microtasks + one macrotask so a just-resolved promise's .then chain runs. */
async function flushAsync(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/**
 * The core async behavior: a condensation response that resolves AFTER several
 * more main-loop iterations have appended new messages must splice the summary
 * into the now-longer history at the correct (re-resolved) boundary — the
 * messages appended after the snapshot survive the splice, the pre-snapshot
 * chunk is replaced, and the splice lands before the session's completion
 * request is built.
 */
async function testBackgroundCondenseSplicesAtReResolvedBoundary(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-async-splice-"))
	try {
		const client = new AsyncCondenseClient(
			[
				() => toolCall("list_files", { path: "." }),
				() => toolCall("list_files", { path: "." }),
				() => toolCall("list_files", { path: "." }),
				() => toolCall("attempt_completion", { result: "done after background condensation" }),
			],
			// 80_000 prompt tokens: inside the early window [76_800, 96_000)
			// for a 128k window with early-fire 0.6 / hard 0.75 — the
			// background fires, the synchronous path never does.
			{ promptTokens: 80_000, completionTokens: 100 },
			{ promptTokens: 5_000, completionTokens: 100 },
		)
		// The background condense resolves once 3 MAIN calls have been served
		// (iter1 + iter2 + iter3) — i.e. AFTER the loop appended two more turns
		// past the snapshot point.
		client.autoResolveCondenseAfterMainCalls = 3
		client.condenseReply = "BACKGROUND SUMMARY"
		const session = makeAsyncSession({ task: "background condensation", client, workspaceRoot: ws })

		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.condenseCalls, 1, "exactly ONE condensation call (the background early-fire)")

		const messages = session.state.messages
		// The summary replaced [2, 2+count) of the fire-time history.
		assert.ok(contentIncludes(messages[2] ?? {}, "Condensed summary"), "the summary must sit at index 2")
		assert.ok(
			contentIncludes(messages[2] ?? {}, "BACKGROUND SUMMARY"),
			"the background summary text must be the one that landed",
		)
		// The pre-snapshot chunk (iteration 1's tool result) is condensed away.
		assert.ok(
			!messages.some((m) => contentIncludes(m, "list_files") && m.role === "tool" && m.content?.includes('"path"')),
			"the pre-snapshot turn must be condensed away",
		)
		// The turns appended AFTER the snapshot (iterations 2 and 3) must be
		// intact in the tail — the splice was re-resolved against the now-longer
		// live history, never allowed to eat messages past the snapshot boundary.
		const toolResults = messages.filter((m) => m.role === "tool")
		assert.ok(toolResults.length >= 2, `the appended turns must survive the splice (got ${toolResults.length} tool results)`)
		// The session's final (completion) request must already contain the
		// summary at index 2 — the splice landed before it was built.
		const lastReq = client.requests[client.requests.length - 1]
		assert.ok(
			lastReq.messages.some((m) => contentIncludes(m, "BACKGROUND SUMMARY")),
			"the request after the background splice must include the summary",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * The load-bearing safety property: a background condensation that NEVER
 * resolves (still in flight when the main calls jump past the HARD threshold)
 * must NOT suppress the synchronous path — the sync condensation still fires
 * exactly as it would today (condenseCalls == 2), the session never exceeds
 * the real window, and the late-resolving background result is discarded (not
 * applied on top of the sync splice) while its usage still lands in the
 * BudgetTracker.
 */
async function testHardFallbackFiresDespitePendingBackground(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-async-hardfallback-"))
	try {
		const client = new AsyncCondenseClient(
			[
				() => toolCall("list_files", { path: "." }),
() => toolCall("list_files", { path: "./" }),
() => toolCall("list_files", { path: "src" }),
() => toolCall("list_files", { path: "src/" }),
() => toolCall("attempt_completion", { result: "done after hard fallback" }),
			],
			{ promptTokens: 80_000, completionTokens: 100 },
			{ promptTokens: 5_000, completionTokens: 100 },
			1, // defer the FIRST (background) condensation — never auto-resolved
		)
		// Iteration 3's main call jumps above the hard threshold (96_000):
		// the sync path must fire on the NEXT iteration even though the
		// background job is still pending.
		client.usageOverrides[3] = { promptTokens: 100_000, completionTokens: 100 }
		// The sync condensation call (the SECOND condense call — the first is
		// deferred) would otherwise reply with the default condenseReply, which
		// collides with the "BACKGROUND SUMMARY" needle used below to detect a
		// wrongly-spliced background result. Give it DISTINCT text so the
		// discard assertion can actually discriminate the two summaries.
		client.condenseReply = "SYNC CONDENSE SUMMARY"
		const tracker = new BudgetTracker({})
		const session = makeAsyncSession({ task: "hard fallback", client, workspaceRoot: ws, budgetTracker: tracker })

		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(
			client.condenseCalls,
			2,
			"the synchronous path must fire exactly as today even with a background job still in flight",
		)

		// The sync summary landed; the background summary must NOT be applied
		// on top of it (it resolves only now, after the session ended).
		const messages = session.state.messages
		assert.ok(contentIncludes(messages[2] ?? {}, "Condensed summary"), "the sync condensation produced a summary at index 2")
		assert.ok(
			!messages.some((m) => contentIncludes(m, "BACKGROUND SUMMARY")),
			"the late-resolving background result must be discarded, not spliced over the sync condensation",
		)

		// Resolve the still-pending background condensation AFTER the session
		// ended: its usage must land in the same BudgetTracker even though its
		// result is discarded (condensation spend is never invisible).
		const costAtSessionEnd = result.budgetUsage?.costUsd ?? 0
		client.resolveCondense("BACKGROUND SUMMARY")
		await flushAsync()
		const backgroundCondenseCost = (5_000 * 2 + 100 * 8) / 1_000_000 // $2/M input, $8/M output (fallback price)
		assert.ok(
			tracker.check().costUsd >= costAtSessionEnd + backgroundCondenseCost,
			`the discarded background call's usage must still land in the tracker ` +
				`(tracker ${tracker.check().costUsd} >= session-end ${costAtSessionEnd} + ${backgroundCondenseCost})`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Session ends (attempt_completion) before the background condensation
 * resolves: the in-flight result is discarded — never applied to the message
 * array that attempt_completion already consumed — but its usage still lands
 * in the BudgetTracker.
 */
async function testSessionEndBeforeBackgroundResolveDiscardsButAccounts(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-async-sessionend-"))
	try {
		const client = new AsyncCondenseClient(
			[
				() => toolCall("list_files", { path: "." }),
				() => toolCall("attempt_completion", { result: "done before the background resolved" }),
			],
			// In the early window: the background fires at iteration 2's top,
			// then the session completes immediately.
			{ promptTokens: 80_000, completionTokens: 100 },
			{ promptTokens: 7_000, completionTokens: 150 },
			1, // defer the background condensation — the session ends before it resolves
		)
		const tracker = new BudgetTracker({})
		const session = makeAsyncSession({ task: "session ends early", client, workspaceRoot: ws, budgetTracker: tracker })

		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.condenseCalls, 1, "the background condensation fired once")

		// The background is still in flight; the session already consumed the
		// messages via attempt_completion. Resolving it now must discard the
		// result (no condensation ever applied to the completed session)…
		assert.ok(
			!session.state.messages.some((m) => contentIncludes(m, "Condensed summary")),
			"nothing may be condensed after the session consumed its message array",
		)
		const costAtSessionEnd = result.budgetUsage?.costUsd ?? 0
		client.resolveCondense("BACKGROUND SUMMARY")
		await flushAsync()
		assert.ok(
			!session.state.messages.some((m) => contentIncludes(m, "Condensed summary")),
			"the in-flight result must be DISCARDED, never spliced into the completed session",
		)
		// …but its usage must still land in the same BudgetTracker.
		const backgroundCondenseCost = (7_000 * 2 + 150 * 8) / 1_000_000
		assert.ok(
			tracker.check().costUsd >= costAtSessionEnd + backgroundCondenseCost,
			`the discarded in-flight call's usage must still land in the tracker ` +
				`(tracker ${tracker.check().costUsd} >= session-end ${costAtSessionEnd} + ${backgroundCondenseCost})`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["async condense: late-resolving background splices at the re-resolved boundary in the longer history", testBackgroundCondenseSplicesAtReResolvedBoundary],
	["async condense: hard synchronous fallback still fires despite a pending background; late result discarded + accounted", testHardFallbackFiresDespitePendingBackground],
	["async condense: session-end before resolution discards the result but keeps its usage in the BudgetTracker", testSessionEndBeforeBackgroundResolveDiscardsButAccounts],
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
	console.log(`\nAll ${tests.length} condense-async tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
