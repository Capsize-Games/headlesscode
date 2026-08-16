/**
 * Combined coverage for context-condensation + streaming used together in ONE
 * session — the interaction gap an independent review
 * (plans/review-todays-batch.md) identified after both features merged
 * sequentially. Each feature is individually well-tested (condense.test.ts,
 * events.test.ts); this suite is purely additive: it drives a real
 * HeadlessSession whose history crosses the condensation threshold (with the
 * irregular 1-3-call tool-call groups that caused the 2026-08-01 HTTP-400
 * incident, see truncateHistory's doc comment in src/engine/loop.ts) WHILE the
 * session is streaming (`stream: true`, incremental `llm_stream_chunk`
 * events), and asserts the two features' shared state — message history,
 * event feed ordering, budget/cost accounting — stays consistent.
 *
 * Plain assert-based script (no test framework, no network), run via `npm
 * test` -> `tsx src/engine/__tests__/condense-streaming.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession, DEFAULT_WINDOW_SIZE } from "../loop.js"
import { eventsDir, eventsFilePath, readEventsFile, type EventRecord } from "../events.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"

// ─── Fakes ────────────────────────────────────────────────────────────────────

type StreamChunk = { kind: "text" | "reasoning" | "tool"; chunk: string }
type Step = (req: LlmRequest) => { message: ChatMessage; chunks: StreamChunk[] }

/**
 * Streaming fake that also recognizes the condensation request shape (no
 * tools, system message = the conversation-compression prompt) and asserts the
 * condensation call is NOT streamed — `condenseOldestTurns` issues a plain
 * blocking request, so if it ever became streamed its chunks would interleave
 * with the main session's stream in the event feed. That contract failing is
 * exactly the interaction bug this suite exists to catch, so it must fail
 * loudly, not silently.
 */
class CondenseAwareStreamingClient implements LlmClient {
	requests: LlmRequest[] = []
	condenseCalls = 0
	usageOverrides: Array<
		{ promptTokens?: number; completionTokens?: number; cachedTokens?: number } | undefined
	> = []

	constructor(
		private readonly script: Step[],
		private readonly usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } = {
			promptTokens: 1000,
			completionTokens: 100,
		},
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		const isCondense =
			!request.tools &&
			request.messages[0]?.role === "system" &&
			typeof request.messages[0]?.content === "string" &&
			request.messages[0].content.includes("conversation-compression engine")
		if (isCondense) {
			this.condenseCalls++
			assert.equal(request.stream, undefined, "condensation request must be blocking (not streamed)")
			assert.equal(request.onStreamChunk, undefined, "condensation request must not carry onStreamChunk")
		}
		const idx = this.requests.length
		// Snapshot the messages: the loop passes its live state.messages array
		// (spliced in place by condensation), so store a copy of the array to
		// freeze what was ACTUALLY sent on this call — matching what a real API
		// client would serialize.
		this.requests.push({ ...request, messages: request.messages.slice() })
		const step = this.script.shift()
		if (!step) {
			throw new Error("CondenseAwareStreamingClient: script exhausted (model kept calling)")
		}
		const { message, chunks } = step(request)
		// Stream the chunks incrementally BEFORE returning the assembled message
		// (the OpenRouterClient.streamChatCompletion pattern), only for main
		// requests that asked for streaming.
		if (request.stream && request.onStreamChunk) {
			for (const c of chunks) {
				request.onStreamChunk(c.kind, c.chunk)
			}
		}
		const override = this.usageOverrides[idx]
		const usage = override ?? this.usage
		return { message, ...(!usage ? {} : { usage }) }
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toolCall(name: string, args: Record<string, unknown>, id = "call_" + name): ChatMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: [
			{
				id,
				type: "function",
				function: { name, arguments: JSON.stringify(args) },
			} as ChatToolCall,
		],
	}
}

/** Assistant message requesting `count` read_file calls in one tool-call group. */
function toolCallTurn(pathBase: string, count: number): ChatMessage {
	const calls: ChatToolCall[] = Array.from({ length: count }, (_, i) => ({
		id: `call_${pathBase}_${i}`,
		type: "function",
		function: { name: "read_file", arguments: JSON.stringify({ path: `${pathBase}-${i}.txt` }) },
	}))
	return { role: "assistant", content: null, tool_calls: calls }
}

/** Pre-create the files the read_file tool-call turns read (one per call). */
async function seedFiles(ws: string, callCounts: number[]): Promise<void> {
	for (let t = 0; t < callCounts.length; t++) {
		for (let i = 0; i < callCounts[t]; i++) {
			await fs.writeFile(path.join(ws, `file-${t}-${i}.txt`), `hello from file-${t}-${i}`, "utf-8")
		}
	}
}

/** One iteration whose only LLM turn is a tool-call group of `count` reads. */
function growthStep(t: number, count: number): Step {
	return () => ({
		chunks: [{ kind: "text", chunk: `step ${t}` }],
		message: toolCallTurn(`file-${t}`, count),
	})
}

/** Standard "Condensed summary of the earlier part..." user message. */
function condenseStep(): Step {
	return () => ({ chunks: [], message: { role: "assistant", content: "CONDENSED SUMMARY HERE" } })
}

function completionStep(): Step {
	return () => ({
		chunks: [
			{ kind: "reasoning", chunk: "Let me condense-aware-think" },
			{ kind: "text", chunk: "Streaming summary" },
			{ kind: "text", chunk: " to completion" },
		],
		message: {
			role: "assistant",
			content: "Streaming summary to completion",
			reasoning: "Let me condense-aware-think",
			tool_calls: [
				{
					id: "call_done",
					type: "function",
					function: { name: "attempt_completion", arguments: JSON.stringify({ result: "done after condensation+streaming" }) },
				} as ChatToolCall,
			],
		},
	})
}

/**
 * Builds the full script a session needs: one tool-call turn per iteration for
 * `callCounts`, then a condensation reply, then a streamed completion turn.
 */
function buildScript(callCounts: number[]): Step[] {
	const steps: Step[] = callCounts.map((count, t) => growthStep(t, count))
	steps.push(condenseStep())
	steps.push(completionStep())
	return steps
}

/**
 * Group-integrity assertion shared with the truncation tests in loop.test.ts:
 * no request's tail may start with an orphaned `tool` message (the HTTP-400
 * shape on DeepSeek), and every assistant tool-call group must have all its
 * `tool` responses immediately after it.
 */
function assertNoOrphanedToolTail(requests: LlmRequest[]): void {
	for (let r = 0; r < requests.length; r++) {
		const req = requests[r]
		if (req.messages.length > 2) {
			assert.notEqual(req.messages[2].role, "tool", `request #${r} keeps an orphaned tool message at the tail start`)
		}
		for (let i = 0; i < req.messages.length; i++) {
			const m = req.messages[i]
			if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
				let tools = 0
				let j = i + 1
				while (j < req.messages.length && req.messages[j].role === "tool") {
					tools++
					j++
				}
				assert.equal(tools, m.tool_calls.length, `request #${r}: assistant at index ${i} split from its tool responses`)
			}
		}
	}
}

/** Rough token-estimate proxy: total content/args/name characters. */
function estimateChars(messages: ChatMessage[]): number {
	let n = 0
	for (const m of messages) {
		n += typeof m.content === "string" ? m.content.length : 0
		if (m.tool_calls) {
			for (const c of m.tool_calls) n += c.function.arguments.length
		}
		if (typeof m.name === "string") n += m.name.length
	}
	return n
}

/**
 * The exact event-feed type sequence a session with `callCounts` tool-call
 * turns, `perTurnChunks` chunks per growth turn and `finalChunks` chunks on
 * the completion turn must produce. When condensation fires (iteration
 * `condenseIteration`, 0 = never), the `condensed` event lands immediately
 * after that iteration's `iteration_start` — the loop emits it from
 * maybeCondenseHistory before the main LLM call — so the feed reads as a
 * clean session_start → checkpoint_saved → per-iteration streamed-turn blocks
 * → (condensed) → final streamed completion → attempt_completion → session_end
 * (the attempt_completion event is issue #34's final-report event, emitted
 * before session_end when the loop accepts completion).
 *
 * (S1) These turns are all-read-only (read_file), so no per-iteration
 * checkpoint_saved is emitted — only the baseline at session start. (S3) The
 * tool_call events for a turn are scheduled up front and the tool_result
 * events after execution, so the feed batches each kind rather than
 * interleaving them per call.
 */
function expectedEventTypes(
 callCounts: number[],
 perTurnChunks: number[],
 finalChunks: number,
 condenseIteration = 0,
): string[] {
 const types: string[] = ["session_start", "checkpoint_saved"]
 const pushIteration = (k: number, chunks: number) => {
 	types.push("iteration_start")
 	if (k + 1 === condenseIteration) types.push("condensed")
 	for (let c = 0; c < chunks; c++) types.push("llm_stream_chunk")
 	types.push("llm_response")
 	for (let t = 0; t < callCounts[k]; t++) {
 		types.push("tool_call")
 	}
 	for (let t = 0; t < callCounts[k]; t++) {
 		types.push("tool_result")
 	}
 }
 for (let k = 0; k < callCounts.length; k++) pushIteration(k, perTurnChunks[k])
	types.push("iteration_start")
	if (callCounts.length + 1 === condenseIteration) types.push("condensed")
	for (let c = 0; c < finalChunks; c++) types.push("llm_stream_chunk")
	types.push("llm_response")
	types.push("attempt_completion")
	types.push("session_end")
	return types
}

function makeSession(options: {
	task: string
	client: LlmClient
	workspaceRoot: string
	checkpointDir?: string
}): HeadlessSession {
	return new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: 40,
		consecutiveErrorLimit: 3,
		windowSize: DEFAULT_WINDOW_SIZE,
		contextWindowTokens: 128_000,
		condenseThresholdFraction: 0.75,
		stream: true,
		checkpoints: options.checkpointDir !== undefined,
		checkpointDir: options.checkpointDir,
	})
}

async function readSessionEvents(ws: string): Promise<{ sessionId: string; events: EventRecord[] }> {
	const files = await fs.readdir(eventsDir(ws))
	const sessionId = files[0].replace(/\.jsonl$/, "")
	const events = await readEventsFile(eventsFilePath(ws, sessionId))
	return { sessionId, events }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

/**
 * THE combined scenario: history grows past the condensation threshold with
 * irregular 1-3-call tool-call groups (the real 2026-08-01 failing shape) and
 * the condensation fires on the SAME iteration whose own main LLM call is the
 * streamed completion turn — the closest possible coupling of the two
 * features' state changes. Checks, all in one run: condensation never splits a
 * tool-call group, the summary is well-formed and the post-condensation
 * request is shorter, streamed events/chunks match the assembled response, the
 * event feed is exactly ordered with no interleaving, and budget accounting
 * covers BOTH the condensation call and the streamed calls.
 */
async function testCondensationAndStreamingInOneSession(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-stream-"))
	const checkpointDir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-stream-ckpt-"))
	try {
		// 11 tool-call turns, group sizes 2,1,3,1,2,3,1,2,1,3,2 (21 read_file
		// calls, all executed by the real executor against seeded files).
		const callCounts = [2, 1, 3, 1, 2, 3, 1, 2, 1, 3, 2]
		await seedFiles(ws, callCounts)

		const client = new CondenseAwareStreamingClient(buildScript(callCounts))
		// Iteration 11's main call reports a huge prompt count → crosses the
		// 75% threshold → condensation runs at the START of iteration 12,
		// whose own main call is the streamed completion turn.
		client.usageOverrides[10] = { promptTokens: 120_000, completionTokens: 100 }
		client.usageOverrides[11] = { promptTokens: 40_000, completionTokens: 2_000 }

		const session = makeSession({ task: "read files then finish", client, workspaceRoot: ws, checkpointDir })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		// ── Condensation ran exactly once, on the streamed turn ──────────────
		assert.equal(client.condenseCalls, 1, "exactly one condensation call across the whole streamed session")
		const condenseReq = client.requests[11]
		assert.ok(condenseReq, "condensation request at index 11")
		assert.equal(condenseReq.messages.length, 2, "condensation request is [system, user] only")
		assert.equal(condenseReq.tools, undefined, "condensation request carries no tools")
		assert.equal(condenseReq.stream, undefined, "condensation call is blocking, not streamed")
		assert.equal(condenseReq.onStreamChunk, undefined)
		assert.match(condenseReq.messages[1].content ?? "", /TRANSCRIPT BEGIN/, "condensation prompt carries the transcript")

		// ── History sent to the model after condensation is shorter ──────────
		const preReq = client.requests[10]
		const postReq = client.requests[12]
		// The unindexed-workspace read-only nudge fires at iteration 8, adding
		// one user message to every subsequent request (all 11 turns here are
		// read_file-only, so it's 31+1 before and 12+1 after condensation).
		assert.equal(preReq.messages.length, 32, "pre-condensation request had 32 messages (full grown history incl. the read-only nudge)")
		assert.equal(postReq.messages.length, 13, "post-condensation request is shorter: system + task + summary + 10-message tail (nudge survives the condense window)")
		assert.equal(postReq.stream, true, "the post-condensation main call is still streamed")
		assert.equal(typeof postReq.onStreamChunk, "function")
		assert.equal(postReq.messages[2].role, "user", "summary lands at index 2 (no orphaned tool message)")
		assert.match(postReq.messages[2].content ?? "", /^\[Condensed summary of the earlier part of this session/, "summary is well-formed")
		assert.match(postReq.messages[2].content ?? "", /CONDENSED SUMMARY HERE/, "summary carries the fake model's text")
		assert.ok(estimateChars(postReq.messages) < estimateChars(preReq.messages), "token-estimate shorter after condensation")

		// The summary stayed in the session state, not just the request.
		assert.ok(
			session.state.messages.some((m) => typeof m.content === "string" && m.content.includes("CONDENSED SUMMARY HERE")),
			"session history keeps the condensed summary",
		)

		// ── Tool-call-group integrity across EVERY request ───────────────────
		assertNoOrphanedToolTail(client.requests)

		// ── Event feed: exact ordering, no interleaving, checkpoint spots ────
		const { events } = await readSessionEvents(ws)
		assert.deepEqual(
			events.map((e) => e.type),
			expectedEventTypes(callCounts, callCounts.map(() => 1), 3, 12),
			"full event sequence must be exactly ordered (incl. checkpoint_saved placement and the condensed event at iteration 12)",
		)

		const iterStarts = events.filter((e) => e.type === "iteration_start")
		assert.deepEqual(iterStarts.map((e) => e.iteration), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
		assert.deepEqual(
			iterStarts.map((e) => e.historyMessageCount),
			[2, 5, 7, 11, 13, 16, 20, 22, 26, 28, 32, 35],
			"iteration_start reports the PRE-condensation history (35 at iteration 12 — the nudge injected after iteration 8 shows from iteration 9 on)",
		)

		// The condensation moment itself: the condensed event lands immediately
		// after iteration 12's iteration_start, and the iteration's stream
		// chunks stay contiguous right after it — no other iteration's chunks
		// mixed in.
		const i12 = events.findIndex((e) => e.type === "iteration_start" && e.iteration === 12)
		assert.equal(events[i12 + 1].type, "condensed", "condensation is emitted at the start of iteration 12, before its stream")
		assert.deepEqual(
			events.slice(i12 + 2, i12 + 5).map((e) => e.type),
			["llm_stream_chunk", "llm_stream_chunk", "llm_stream_chunk"],
			"iteration 12's stream chunks are contiguous — nothing interleaves with the condensation",
		)
		assert.equal(events[i12 + 5].type, "llm_response")

		// The condensed event's payload: the message counts the timeline shows
		// (32 → 13) and the condensation call's own usage, so condensation
		// spend is visible in the feed, not just the session totals.
		const condensedEvents = events.filter((e) => e.type === "condensed")
		assert.equal(condensedEvents.length, 1, "exactly one condensed event across the session")
		assert.equal(condensedEvents[0].iteration, 12)
		assert.equal(condensedEvents[0].messagesBefore, 35, "history length at condensation time (matches the iteration_start count)")
		assert.equal(condensedEvents[0].messagesAfter, 13, "history length after condensation")
		assert.equal(condensedEvents[0].inputTokens, 40_000, "condensed event carries the condensation call's input tokens")
		assert.equal(condensedEvents[0].outputTokens, 2_000, "condensed event carries the condensation call's output tokens")

		// Streamed chunks match the assembled message exactly (the same
		// assertion streaming-and-reasoning makes in isolation).
		const chunks = events.filter((e) => e.type === "llm_stream_chunk")
		assert.equal(chunks.length, callCounts.length + 3, "one chunk per growth turn + 3 on the streamed completion turn")
		assert.deepEqual(
			chunks.filter((e) => e.iteration === 12).map((e) => [e.kind, e.chunk]),
			[
				["reasoning", "Let me condense-aware-think"],
				["text", "Streaming summary"],
				["text", " to completion"],
			],
		)

		const responses = events.filter((e) => e.type === "llm_response")
		assert.equal(responses.length, 12, "one llm_response per iteration, no extra from the condensation call")
		assert.equal(responses[11].iteration, 12)
		assert.equal(responses[11].textPreview, "Streaming summary to completion")
		assert.equal(responses[11].reasoningPreview, "Let me condense-aware-think")
		// The streamed call's own usage, NOT the condensation call's — the
		// condense usage must only land in the session totals (no double-count).
		assert.equal(responses[11].inputTokens, 1_000)
		assert.equal(responses[11].outputTokens, 100)
		assert.equal(responses[10].inputTokens, 120_000, "the threshold-crossing call reports its own usage")

		// Checkpoint events (S1): the baseline is saved at session start; every
		// tool-call iteration here is all-read-only (read_file), so the
		// read-only checkpoint skip means NO per-iteration snapshot is taken.
		assert.deepEqual(
			events.filter((e) => e.type === "checkpoint_saved").map((e) => e.iteration),
			[0],
			"all-read-only turns skip per-iteration checkpoints (S1); only the baseline remains",
		)

		// ── Budget/cost: condensation call AND streamed calls combined ───────
		const end = events[events.length - 1] as EventRecord & {
			costUsd: number
			inputTokens: number
			outputTokens: number
			cachedTokens: number
		}
		assert.equal(end.type, "session_end")
		// Main streamed calls: 10 x 1000/100 + 120000/100 (iter 11) + 1000/100
		// (iter 12) = 131000 in / 1200 out. Condensation call: 40000/2000.
		// Combined: 171000 in / 3200 out — the condensation usage is neither
		// dropped nor double-counted by streaming.
		assert.equal(end.inputTokens, 171_000, "session totals include condensation + all streamed calls")
		assert.equal(end.outputTokens, 3_200)
		assert.equal(end.cachedTokens, 0)
		const condenseMinCost = (40_000 * 2 + 2_000 * 8) / 1_000_000 // fallback price 2.0/8.0 per 1M
		const expectedCost = (171_000 * 2 + 3_200 * 8) / 1_000_000
		assert.ok(end.costUsd >= condenseMinCost, "cost reflects the condensation call's usage at minimum")
		assert.ok(Math.abs(end.costUsd - expectedCost) < 1e-9, `cost ${end.costUsd} must equal ${expectedCost}`)
		assert.ok(
			result.budgetUsage && Math.abs(result.budgetUsage.costUsd - expectedCost) < 1e-9,
			"result.budgetUsage agrees with the session_end cost",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

/**
 * Always-above-threshold session: every main call reports 120k prompt tokens,
 * so condensation fires on iteration 2 (the FIRST one is exempt from the
 * prefix-stability re-condense guard) and then stays dormant. With streaming
 * active the budget tracker must still receive each streamed response's usage
 * exactly once AND the condensation call's usage — proving the two accounting
 * paths don't interfere.
 */
async function testStreamedUsageAccountedExactlyWithCondensation(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-stream-cost-"))
	try {
		await seedFiles(ws, [1, 1, 1])
		const client = new CondenseAwareStreamingClient(
			[
				growthStep(0, 1),
				condenseStep(),
				growthStep(1, 1),
				growthStep(2, 1),
				() => ({ chunks: [], message: toolCall("attempt_completion", { result: "cost done" }) }),
			],
			{ promptTokens: 120_000, completionTokens: 100 },
		)
		client.usageOverrides[1] = { promptTokens: 40_000, completionTokens: 2_000 }

		const session = makeSession({ task: "cost accounting", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.condenseCalls, 1, "condensation fires exactly once despite every call being above threshold")
		assert.equal(client.requests.length, 5, "4 main calls + 1 condensation call")

		// Every post-condensation request carries the summary at index 2 and a
		// clean group boundary.
		for (let r = 2; r < client.requests.length; r++) {
			const req = client.requests[r]
			assert.equal(req.messages[2].role, "user", `post-condensation request #${r} starts its tail with the summary`)
			assert.ok(
				typeof req.messages[2].content === "string" && req.messages[2].content.includes("CONDENSED SUMMARY HERE"),
				`post-condensation request #${r} embeds the summary text`,
			)
		}
		assertNoOrphanedToolTail(client.requests)

		const { events } = await readSessionEvents(ws)
		const responses = events.filter((e) => e.type === "llm_response")
		assert.equal(responses.length, 4, "streamed main calls only — condensation call emits no llm_response")
		assert.equal(responses[1].inputTokens, 120_000, "the post-condensation main call reports ITS OWN usage, not the condense call's")
		assert.equal(events.filter((e) => e.type === "llm_stream_chunk").length, 3, "growth turns stream one chunk each")

		const end = events[events.length - 1] as EventRecord & {
			costUsd: number
			inputTokens: number
			outputTokens: number
			cachedTokens: number
		}
		assert.equal(end.type, "session_end")
		// 4 main calls x 120000/100 + 1 condensation call 40000/2000.
		const expectedCost = (520_000 * 2 + 2_400 * 8) / 1_000_000
		assert.equal(end.inputTokens, 520_000, "4 streamed responses x 120k + condensation 40k, no double-count")
		assert.equal(end.outputTokens, 2_400)
		assert.ok(Math.abs(end.costUsd - expectedCost) < 1e-9, `cost ${end.costUsd} must equal ${expectedCost}`)
		assert.ok(
			result.budgetUsage && Math.abs(result.budgetUsage.costUsd - expectedCost) < 1e-9,
			"result.budgetUsage agrees with the session_end cost",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	[
		"condense-streaming: condensation + streaming in one session (groups stay intact, feed ordered, budget combined)",
		testCondensationAndStreamingInOneSession,
	],
	[
		"condense-streaming: streamed usage + condensation usage accounted exactly once each",
		testStreamedUsageAccountedExactlyWithCondensation,
	],
]

let failed = 0
for (const [name, fn] of tests) {
	try {
		await fn()
		console.log(`  ok   ${name}`)
	} catch (error) {
		failed++
		console.error(`FAIL ${name}`)
		console.error(error instanceof Error ? error.stack : error)
	}
}
if (failed > 0) {
	process.exit(1)
}
console.log(`All ${tests.length} condense-streaming tests passed`)
