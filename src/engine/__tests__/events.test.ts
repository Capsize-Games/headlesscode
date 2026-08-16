/**
 * Tests for the per-session structured event feed (src/engine/events.ts) +
 * its wiring in src/engine/loop.ts (live worker monitoring). Plain assert-
 * based script (no test framework), run via `npm test` ->
 * `tsx src/engine/__tests__/events.test.ts`.
 *
 * Runs a real HeadlessSession with a scripted fake LlmClient (the loop.test.ts
 * pattern) and asserts the events .jsonl file contains the expected event
 * sequence in order, and that long content is actually truncated, not dumped
 * in full — with ONE deliberate exception (issue #34): the final
 * `attempt_completion` report is the one field that is NOT truncated, since
 * it IS the report (see src/engine/events.ts).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../loop.js"
import { eventsDir, eventsFilePath, readEventsFile, EVENT_TRUNCATE_CHARS, truncateField } from "../events.js"
import { readLimitFromEnv } from "../../tools/executor.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"

// ─── Fake LLM client (mirrors src/engine/__tests__/loop.test.ts) ────────────

class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []

	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly usagePerCall?: { promptTokens: number; completionTokens: number; cachedTokens?: number },
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		// Snapshot messages: the loop mutates the SAME array across iterations
		// (assistant/tool pushes, T1 reasoning strip), so without a copy every
		// recorded request aliases to the array's final state — the same
		// aliasing loop.test.ts's fake already guards against.
		this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) })
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (model kept calling)")
		}
		return {
			message: step(request),
			...(!this.usagePerCall ? {} : { usage: { ...this.usagePerCall } }),
		}
	}
}

/**
 * Streaming fake: when `request.stream` is true, invokes `request.onStreamChunk`
 * incrementally (the way OpenRouterClient.streamChatCompletion does) BEFORE
 * returning the fully-assembled message — the loop's `llm_stream_chunk` events
 * must fire as the chunks arrive, ahead of the single `llm_response` summary.
 */
class StreamingFakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []
	/** How many chunks each call actually emitted (per request index). */
	chunkCounts: number[] = []

	constructor(
		private readonly script: Array<
			(req: LlmRequest) => { message: ChatMessage; chunks: Array<{ kind: "text" | "reasoning" | "tool"; chunk: string }> }
		>,
		private readonly usagePerCall?: { promptTokens: number; completionTokens: number },
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("StreamingFakeLlmClient: script exhausted (model kept calling)")
		}
		const { message, chunks } = step(request)
		let count = 0
		if (request.stream && request.onStreamChunk) {
			for (const c of chunks) {
				count++
				request.onStreamChunk(c.kind, c.chunk)
			}
		}
		this.chunkCounts.push(count)
		return {
			message,
			...(!this.usagePerCall ? {} : { usage: { ...this.usagePerCall } }),
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

async function makeSession(options: {
	task: string
	client: LlmClient
	workspaceRoot: string
	maxIterations?: number
	stream?: boolean
}) {
	const session = new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: options.maxIterations ?? 10,
		checkpoints: false,
		stream: options.stream,
	})
	return session
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/**
 * The dashboard's session-launch endpoint generates the session id FIRST and
 * passes it to the CLI via --session-id (HeadlessSessionConfig.sessionId).
 * Prove the override is honored: the events feed must land at exactly that
 * id, not a fresh UUID — otherwise the browser's immediate open of
 * /api/session/:id/events would point at a file that never gets written.
 */
async function testExplicitSessionIdOverrideIsHonored(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-sid-"))
	try {
		const client = new FakeLlmClient([() => toolCall("attempt_completion", { result: "done" })])
		const session = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "do a thing",
			sessionId: "dashboard-chosen-id-123",
			llmClient: client,
			maxIterations: 5,
			checkpoints: false,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		// The events file must be exactly the overridden id, not a UUID.
		const evDir = eventsDir(ws)
		const files = await fs.readdir(evDir)
		assert.deepEqual(files, ["dashboard-chosen-id-123.jsonl"], `expected the overridden id, got: ${files.join(", ")}`)

		const events = await readEventsFile(eventsFilePath(ws, "dashboard-chosen-id-123"))
		assert.equal(events[0].sessionId, "dashboard-chosen-id-123")
		assert.equal(events[events.length - 1].type, "session_end")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * A real session (tool call once, then complete) must write an events file
 * with the full lifecycle sequence in order:
 *   session_start, iteration_start, llm_response, tool_call, tool_result,
 *   iteration_start, llm_response, attempt_completion, session_end — plus
 *   the token usage incl. cachedTokens on llm_response. attempt_completion
 *   short-circuits at step 6a before the tool-execution loop, so it emits
 *   its own full-text `attempt_completion` event rather than a
 *   tool_call/tool_result pair (issue #34).
 */
async function testEventSequenceWithToolThenCompletion(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-seq-"))
	try {
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "hello.txt", content: "hello world" }),
				() => toolCall("attempt_completion", { result: "Done: wrote hello.txt" }),
			],
			{ promptTokens: 120, completionTokens: 40, cachedTokens: 60 },
		)
		const session = await makeSession({ task: "write a hello file", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		// The session id is private — recover it from the events dir (one file).
		const evDir = eventsDir(ws)
		const files = await fs.readdir(evDir)
		assert.equal(files.length, 1, `expected exactly one events file, got: ${files.join(", ")}`)
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const events = await readEventsFile(eventsFilePath(ws, sessionId))

		const types = events.map((e) => e.type)
		// attempt_completion short-circuits at step 6a before the tool-
		// execution loop, so iteration 2 emits no tool_call/tool_result —
		// instead it emits its own full-text `attempt_completion` event.
		assert.deepEqual(types, [
			"session_start",
			"iteration_start",
			"llm_response",
			"tool_call",
			"tool_result",
			"iteration_start",
			"llm_response",
			"attempt_completion",
			"session_end",
		])

		// session_start carries mode/model/workspaceRoot + truncated task.
		const start = events[0]
		assert.equal(start.sessionId, sessionId)
		assert.equal(start.mode, "code")
		assert.equal(start.model, "fake-model")
		assert.equal(start.workspaceRoot, ws)
		assert.equal(start.task, "write a hello file")

		// llm_response carries token usage incl. cachedTokens.
		const llm1 = events[2]
		assert.equal(llm1.iteration, 1)
		assert.equal(llm1.hadToolCalls, true)
		assert.equal(llm1.inputTokens, 120)
		assert.equal(llm1.outputTokens, 40)
		assert.equal(llm1.cachedTokens, 60)

		// tool_call has a truncated argument summary (the path for file tools).
		const toolCallEvent = events[3]
		assert.equal(toolCallEvent.tool, "write_to_file")
		assert.equal(toolCallEvent.args, "hello.txt")

		// tool_result preview is present and NOT truncated for a short result.
		const toolResultEvent = events[4]
		assert.equal(toolResultEvent.tool, "write_to_file")
		assert.equal(toolResultEvent.isError, false)
		assert.match(String(toolResultEvent.result), /File written: hello\.txt/)

		// The `attempt_completion` event (issue #34) carries the FULL report
		// text — the completion call was previously invisible to the feed.
		const completionEvent = events[events.length - 2]
		assert.equal(completionEvent.type, "attempt_completion")
		assert.equal(completionEvent.iteration, 2)
		assert.equal(completionEvent.result, "Done: wrote hello.txt")
		assert.equal(completionEvent.resultTruncated, undefined, "the final report is never truncated")

		// And the complete report is persisted per session (issue #34), with
		// the path surfaced on the SessionResult for the orchestrator state.
		assert.ok(result.reportPath, "SessionResult must carry the report path")
		const reportFile = await fs.readFile(result.reportPath!, "utf-8")
		assert.equal(reportFile, "Done: wrote hello.txt", "report file contains the full final report")
		assert.ok(result.reportPath!.endsWith(`.headlesscode${path.sep}reports${path.sep}${sessionId}.md`))

		// session_end carries the final status/cost/tokens.
		const end = events[events.length - 1]
		assert.equal(end.status, "success")
		assert.equal(end.iterations, 2)
		assert.equal(typeof end.costUsd, "number")
		assert.equal(end.inputTokens, 240)
		assert.equal(end.outputTokens, 80)
		assert.equal(end.cachedTokens, 120)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Long content must be truncated with a `truncated` marker, never dumped in
 * full: a write_to_file call with a huge `content` arg (not summarized in
 * tool_call) and a tool result well past EVENT_TRUNCATE_CHARS.
 */
async function testLongContentIsTruncated(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-trunc-"))
	try {
		const hugeContent = "x".repeat(EVENT_TRUNCATE_CHARS + 500)
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "node -e 'console.log(1)'" }),
			() => textReply("Done."),
		])
		const session = await makeSession({ task: "run a command", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const evDir = eventsDir(ws)
		const files = await fs.readdir(evDir)
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const events = await readEventsFile(eventsFilePath(ws, sessionId))

		const toolCallEvent = events.find((e) => e.type === "tool_call")
		assert.ok(toolCallEvent, "expected a tool_call event")
		assert.equal(toolCallEvent?.tool, "execute_command")
		// The execute_command arg summary is capped at 200 chars by
		// summarizeToolArg, well within the event cap — never truncated.
		assert.equal(toolCallEvent?.args, "node -e 'console.log(1)'")
		assert.equal(toolCallEvent?.argsTruncated, undefined)

		// The tool result for `node -e 'console.log(1)'` is short; to prove
		// truncation actually happens on long results we assert the pure
		// helper truncates and flags, then feed a long result through a
		// session whose tool produces long output.
		const long = "y".repeat(EVENT_TRUNCATE_CHARS + 100)
		const truncated = truncateField(long)
		assert.equal(truncated.text.length, EVENT_TRUNCATE_CHARS)
		assert.equal(truncated.truncated, true)
		assert.equal(truncateField("short").truncated, false)

		// Real long result: write a big file, then read it back (the read_file
		// result is long) — the tool_result event must be capped.
		await fs.writeFile(path.join(ws, "big.txt"), hugeContent, "utf-8")
		const ws2 = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-trunc2-"))
		try {
			const client2 = new FakeLlmClient([
				() => toolCall("read_file", { path: "big.txt" }),
				() => toolCall("attempt_completion", { result: "read it" }),
			])
			const session2 = await makeSession({ task: "read big.txt", client: client2, workspaceRoot: ws2 })
			// Copy big.txt into ws2 so read_file sees it.
			await fs.copyFile(path.join(ws, "big.txt"), path.join(ws2, "big.txt"))
			const result2 = await session2.run()
			assert.equal(result2.status, "success", `expected success, got ${JSON.stringify(result2)}`)

			const files2 = await fs.readdir(eventsDir(ws2))
			const sessionId2 = files2[0].replace(/\.jsonl$/, "")
			const events2 = await readEventsFile(eventsFilePath(ws2, sessionId2))
			// read_file's tool_call args carry mode+range detail (observability
			// for whether sessions use targeted indentation reads vs. broad
			// slices) — the same summarizeToolArg helper as harness.log.
			const readCallEvent = events2.find((e) => e.type === "tool_call" && e.tool === "read_file")
			assert.ok(readCallEvent, "expected a read_file tool_call event")
			assert.equal(readCallEvent?.args, `big.txt [slice offset=1 limit=${readLimitFromEnv()}]`)
			assert.equal(readCallEvent?.argsTruncated, undefined)

			const toolResultEvent2 = events2.find((e) => e.type === "tool_result")
			assert.ok(toolResultEvent2, "expected a tool_result event")
			assert.equal(toolResultEvent2?.resultTruncated, true)
			assert.ok(
				String(toolResultEvent2?.result).length <= EVENT_TRUNCATE_CHARS,
				"tool_result preview must be capped at EVENT_TRUNCATE_CHARS",
			)
			// The full file content must NOT appear in the feed.
			assert.ok(!JSON.stringify(events2).includes(hugeContent), "full long content must never be dumped into the feed")
		} finally {
			await fs.rm(ws2, { recursive: true, force: true })
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
	* Issue #34 — the one deliberate exception to EVENT_TRUNCATE_CHARS: a LONG
	* final report must land in the feed in FULL (it IS the report), and the
	* complete text must be persisted to `.headlesscode/reports/<sessionId>.md`.
	* Regular tool_result previews stay truncated — the full-text behavior is
	* specific to the final report.
	*/
async function testAttemptCompletionEventCarriesFullReportText(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-report-"))
	try {
		// A genuinely large file so the read_file tool_result MUST be truncated
		// (proving the full-text exception is specific to the final report).
		const hugeContent = "z".repeat(EVENT_TRUNCATE_CHARS + 500)
		await fs.writeFile(path.join(ws, "big.txt"), hugeContent, "utf-8")
		const longReport =
			"## Findings\n\n" +
			"- Ran `npm test`: 3 files, all passed (evidence line " + "y".repeat(EVENT_TRUNCATE_CHARS + 300) + ")\n" +
			"- Baseline after: green.\n\n" +
			"VERDICT: CLEAN\n"
		const client = new FakeLlmClient([
			() => toolCall("read_file", { path: "big.txt" }),
			() => toolCall("attempt_completion", { result: longReport }),
		])
		const session = await makeSession({ task: "verify and report", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const files = await fs.readdir(eventsDir(ws))
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const events = await readEventsFile(eventsFilePath(ws, sessionId))

		// The attempt_completion event carries the report verbatim, untruncated.
		const completionEvent = events.find((e) => e.type === "attempt_completion")
		assert.ok(completionEvent, "expected an attempt_completion event")
		assert.equal(completionEvent?.result, longReport, "the final report is in the feed in FULL")
		assert.equal(completionEvent?.resultTruncated, undefined, "no truncation flag on the final report")

		// A regular tool_result preview from the same session is still capped —
		// the full-text exception is specific to the final report.
		const toolResultEvent = events.find((e) => e.type === "tool_result")
		assert.ok(toolResultEvent, "expected a tool_result event")
		assert.equal(toolResultEvent?.resultTruncated, true)
		assert.ok(
			String(toolResultEvent?.result).length <= EVENT_TRUNCATE_CHARS,
			"tool_result preview must stay capped at EVENT_TRUNCATE_CHARS",
		)

		// The complete report is persisted per session and surfaced on the result.
		assert.ok(result.reportPath, "SessionResult must carry the report path")
		const reportFile = await fs.readFile(result.reportPath!, "utf-8")
		assert.equal(reportFile, longReport, "report file contains the complete final report, not a 4000-char slice")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
	* The event feed survives the session's teardown: unlike the live usage
	* snapshot (deleted at completion), the events .jsonl file is KEPT after the
	* session ends.
	*/
async function testEventFeedKeptAfterSessionEnds(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-kept-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "write a file", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		// Events file still present after completion.
		const evDir = eventsDir(ws)
		const files = await fs.readdir(evDir)
		assert.ok(files.some((f) => f.endsWith(".jsonl")), "events .jsonl file must be kept after session end")
		const events = await readEventsFile(path.join(evDir, files[0]))
		assert.equal(events[events.length - 1].type, "session_end", "feed ends with session_end")

		// The live usage snapshot, by contrast, is deleted on completion.
		const usageDir = path.join(ws, ".headlesscode", "usage")
		const usageFiles = await fs.readdir(usageDir).catch(() => [] as string[])
		assert.ok(!usageFiles.some((f) => f.endsWith(".live.json")), "live usage snapshot removed (only .jsonl remains)")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * ask_followup_question mirrors its .harness.needs-decision marker lifecycle
 * on the event feed: a `decision_blocked` event when the marker is written,
 * and a `decision_answered` event when the answer arrives.
 */
async function testDecisionEventsMirrorMarkerLifecycle(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-decision-"))
	try {
		// The model asks a question; the test answers it by writing the
		// .harness.decision-answer marker after the first iteration begins.
		const client = new FakeLlmClient([
			() => toolCall("ask_followup_question", { question: "Which config?", follow_up: [{ text: "A", mode: null }] }),
			() => toolCall("attempt_completion", { result: "went with A" }),
		])
		const session = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "ask a question",
			llmClient: client,
			maxIterations: 10,
			checkpoints: false,
			// Short decision timeout + poll interval so a missed answer still
			// resolves fast and the 200ms answer is actually polled.
			decisionTimeoutMs: 5_000,
			decisionPollIntervalMs: 50,
		})

		// Answer the question shortly after the session starts (the marker is
		// written synchronously inside the ask_followup_question handler).
		const timer = setTimeout(async () => {
			await fs.writeFile(path.join(ws, ".harness.decision-answer"), "Go with A", "utf-8")
		}, 200)
		try {
			const result = await session.run()
			assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		} finally {
			clearTimeout(timer)
		}

		const files = await fs.readdir(eventsDir(ws))
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const events = await readEventsFile(eventsFilePath(ws, sessionId))
		const blocked = events.find((e) => e.type === "decision_blocked")
		assert.ok(blocked, "expected a decision_blocked event")
		assert.equal(blocked?.question, "Which config?")
		assert.deepEqual(blocked?.suggestions, ["A"])
		const answered = events.find((e) => e.type === "decision_answered")
		assert.ok(answered, "expected a decision_answered event")
		assert.equal(answered?.answer, "Go with A")
		assert.equal(answered?.timedOut, undefined, "answered in time -> no timedOut flag")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Reasoning capture + streaming (streaming-and-reasoning) ────────────────

/**
 * Reasoning content must flow from the raw response (message.reasoning, as
 * OpenRouter normalizes DeepSeek's reasoning_content) into the event feed:
 * an `llm_response` event carrying `reasoningPreview` (truncated like every
 * other large field), and NOT emitted at all when there's no reasoning.
 */
async function testReasoningFlowsToEventFeedTruncated(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-reason-"))
	try {
		const longReasoning = "x".repeat(EVENT_TRUNCATE_CHARS + 200)
		const client = new FakeLlmClient([
			// A tool-call-bearing first turn: a text-only reply would end the
			// session immediately, so there'd be no SECOND call to observe the
			// echoed reasoning on. carryReasoning() attaches the reasoning to the
			// assistant message.
			() => ({ ...toolCall("read_file", { path: "a.txt" }), reasoning: longReasoning }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "reason about it", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const evDir = eventsDir(ws)
		const files = await fs.readdir(evDir)
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const events = await readEventsFile(eventsFilePath(ws, sessionId))

		// The response event carries the reasoning preview, truncated + flagged.
		const llmResponse = events.find((e) => e.type === "llm_response")
		assert.ok(llmResponse, "expected an llm_response event")
		assert.equal(llmResponse?.reasoningPreview, "x".repeat(EVENT_TRUNCATE_CHARS))
		assert.equal(llmResponse?.reasoningTruncated, true)
		assert.equal(llmResponse?.hadToolCalls, true)
		// Tool-call turn: no text preview (undefined, not "" — the loop uses
		// `text || undefined`).
		assert.equal(llmResponse?.textPreview, undefined)
		// The FULL reasoning must never be dumped into the feed.
		assert.ok(!JSON.stringify(events).includes(longReasoning), "full reasoning must never be dumped into the feed")

		// The reasoning is echoed back onto the NEXT call's assistant history
		// (matches zoo-code: reasoning is prepended to apiConversationHistory,
		// and native DeepSeek drops prior reasoning if it isn't echoed).
		const second = client.requests[1]
		const echoed = second.messages.find(
			(m) => m.role === "assistant" && m.reasoning === longReasoning,
		)
		assert.ok(echoed, "reasoning must be echoed back on assistant history for the next call")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * (T1) Superseded reasoning is stripped from assistant history: on request 3
 * of a 3-turn session, turn-1's reasoning must be GONE while turn-2's (the
 * immediately-preceding assistant message) is still echoed — native DeepSeek
 * only needs reasoning on that one message, older echoes are pure token cost.
 */
async function testSupersededReasoningStrippedFromHistory(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-reason-strip-"))
	try {
		// Seed the files so the read_file turns succeed (no mistake-limit edge).
		await fs.writeFile(path.join(ws, "a.txt"), "aaa", "utf-8")
		await fs.writeFile(path.join(ws, "b.txt"), "bbb", "utf-8")
		const client = new FakeLlmClient([
			// Turn 1: tool call carrying reasoning-1.
			() => ({ ...toolCall("read_file", { path: "a.txt" }), reasoning: "reasoning-1" }),
			// Turn 2: tool call carrying reasoning-2.
			() => ({ ...toolCall("read_file", { path: "b.txt" }), reasoning: "reasoning-2" }),
			// Turn 3: completion.
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "three turns", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		// Request 3's history: turn-2's assistant message is the immediately
		// preceding one, so it keeps reasoning-2; turn-1's is superseded.
		const third = client.requests[2]
		assert.ok(third, "expected a third request")
		assert.ok(
			third.messages.some((m) => m.role === "assistant" && m.reasoning === "reasoning-2"),
			"the most-recent assistant message keeps its reasoning (DeepSeek requires it on the immediately-preceding message)",
		)
		assert.ok(
			!third.messages.some((m) => m.role === "assistant" && m.reasoning === "reasoning-1"),
			"superseded turn-1 reasoning is stripped from the request-3 history",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * A streamed session must emit `llm_stream_chunk` events incrementally (in
 * order, reasoning before text), and the final `llm_response` summary still
 * fires once with the assembled text + usage.
 */
async function testStreamedChunksEmitIncrementally(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-stream-"))
	try {
		const client = new StreamingFakeLlmClient([
			() => ({
				chunks: [
					{ kind: "reasoning" as const, chunk: "Let me think" },
					{ kind: "reasoning" as const, chunk: " harder" },
					{ kind: "text" as const, chunk: "Hello" },
					{ kind: "text" as const, chunk: " world" },
				],
				message: { role: "assistant" as const, content: "Hello world", reasoning: "Let me think harder" },
			}),
			() => ({ chunks: [], message: toolCall("attempt_completion", { result: "done" }) }),
		])
		const session = await makeSession({ task: "stream a reply", client, workspaceRoot: ws, stream: true })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const evDir = eventsDir(ws)
		const files = await fs.readdir(evDir)
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const events = await readEventsFile(eventsFilePath(ws, sessionId))

		const streamChunks = events.filter((e) => e.type === "llm_stream_chunk")
		assert.equal(streamChunks.length, 4, "each chunk is its own event")
		assert.deepEqual(
			streamChunks.map((e) => [e.kind, e.chunk]),
			[
				["reasoning", "Let me think"],
				["reasoning", " harder"],
				["text", "Hello"],
				["text", " world"],
			],
			"chunks arrive incrementally, in order, reasoning before text",
		)
		assert.equal(streamChunks.every((e) => e.iteration === 1), true)

		// The llm_response summary still fires ONCE with the assembled text.
		const llmResponses = events.filter((e) => e.type === "llm_response")
		assert.equal(llmResponses.length, 1)
		assert.equal(llmResponses[0].textPreview, "Hello world")
		assert.equal(llmResponses[0].reasoningPreview, "Let me think harder")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * A streamed TOOL-CALL turn: the streamed tool chunks emit as `llm_stream_chunk`
 * (kind "tool") events, and the turn still terminates via the tool call.
 */
async function testStreamedToolCallTurnEmitsToolChunks(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-stream-tool-"))
	try {
		const client = new StreamingFakeLlmClient([
			() => ({
				chunks: [
					{ kind: "tool" as const, chunk: '{"path"' },
					{ kind: "tool" as const, chunk: ':"a.txt","content":"x"}' },
				],
				message: toolCall("write_to_file", { path: "a.txt", content: "x" }),
			}),
			() => ({ chunks: [], message: toolCall("attempt_completion", { result: "done" }) }),
		])
		const session = await makeSession({ task: "write via stream", client, workspaceRoot: ws, stream: true })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const evDir = eventsDir(ws)
		const files = await fs.readdir(evDir)
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const events = await readEventsFile(eventsFilePath(ws, sessionId))

		const toolChunks = events.filter((e) => e.type === "llm_stream_chunk" && e.kind === "tool")
		assert.equal(toolChunks.length, 2)
		assert.deepEqual(
			toolChunks.map((e) => e.chunk),
			['{"path"', ':"a.txt","content":"x"}' ],
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
	* Cost accounting for a STREAMED response: the usage carried by the final
	* stream chunk (`completion_tokens` incl. reasoning tokens) must feed the
	* budget tracker exactly ONCE — the incremental llm_stream_chunk events are
	* purely visual and must never be counted, and the usage must not be missed
	* just because the response arrived as a stream.
	*/
async function testStreamedResponseUsageFeedsBudgetOnce(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-events-stream-cost-"))
	try {
		const client = new StreamingFakeLlmClient(
			[
				// First turn must be a TOOL call (a text-only reply would end the
				// session after call 1 — the loop's pragmatic-success path) so
				// that the second call's usage is also recorded and both
				// streamed responses feed the budget tracker exactly once each.
				() => ({
					chunks: [
						{ kind: "reasoning" as const, chunk: "think" },
						{ kind: "text" as const, chunk: "Hello" },
					],
					message: {
						role: "assistant" as const,
						content: "Hello",
						reasoning: "think",
						tool_calls: [
							{
								id: "call_1",
								type: "function" as const,
								function: { name: "write_to_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) },
							},
						],
					},
				}),
				() => ({ chunks: [], message: toolCall("attempt_completion", { result: "done" }) }),
			],
			// Reasoning tokens are billed as output (completion) tokens — this
			// is what a real OpenRouter streamed usage chunk reports.
			{ promptTokens: 100, completionTokens: 30 },
		)
		const session = await makeSession({ task: "stream with usage", client, workspaceRoot: ws, stream: true })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const evDir = eventsDir(ws)
		const files = await fs.readdir(evDir)
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const events = await readEventsFile(eventsFilePath(ws, sessionId))

		// The session_end totals reflect EXACTLY one record of the streamed
		// usage per call (2 calls → 200 in / 60 out) — no double-count from
		// the chunk events, no miss from the streaming path.
		const end = events[events.length - 1]
		assert.equal(end.type, "session_end")
		assert.equal(end.inputTokens, 200)
		assert.equal(end.outputTokens, 60)
		assert.equal(end.cachedTokens, 0)
		assert.equal(typeof end.costUsd, "number")

		// Each llm_response carries the same single usage record (not summed
		// across chunks).
		const responses = events.filter((e) => e.type === "llm_response")
		assert.equal(responses.length, 2)
		assert.equal(responses[0].outputTokens, 30)
		assert.equal(responses[1].outputTokens, 30)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	[
		"events: full lifecycle sequence (session_start … session_end) with token usage incl. cachedTokens",
		testEventSequenceWithToolThenCompletion,
	],
	["events: explicit sessionId override is honored (feed lands at the dashboard-chosen id)", testExplicitSessionIdOverrideIsHonored],
	["events: long tool results are truncated with a marker, never dumped in full", testLongContentIsTruncated],
	["events: final attempt_completion report lands in the feed in FULL + persisted to .headlesscode/reports (issue #34)", testAttemptCompletionEventCarriesFullReportText],
	["events: feed file is KEPT after the session ends (unlike the live usage snapshot)", testEventFeedKeptAfterSessionEnds],
	["events: ask_followup_question mirrors decision_blocked/decision_answered on the feed", testDecisionEventsMirrorMarkerLifecycle],
	["events: reasoning flows to the feed truncated + echoed on next call history", testReasoningFlowsToEventFeedTruncated],
	["events: (T1) superseded reasoning is stripped from assistant history, most-recent kept", testSupersededReasoningStrippedFromHistory],
	["events: streamed chunks emit incrementally, llm_response summary fires once", testStreamedChunksEmitIncrementally],
	["events: a streamed tool-call turn emits tool chunks + a single tool_call", testStreamedToolCallTurnEmitsToolChunks],
	["events: streamed response usage feeds the budget tracker exactly once (no double-count)", testStreamedResponseUsageFeedsBudgetOnce],
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
	console.log(`\nAll ${tests.length} events tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
