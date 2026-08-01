/**
 * Tests for the per-session structured event feed (src/engine/events.ts) +
 * its wiring in src/engine/loop.ts (live worker monitoring). Plain assert-
 * based script (no test framework), run via `npm test` ->
 * `tsx src/engine/__tests__/events.test.ts`.
 *
 * Runs a real HeadlessSession with a scripted fake LlmClient (the loop.test.ts
 * pattern) and asserts the events .jsonl file contains the expected event
 * sequence in order, and that long content is actually truncated, not dumped
 * in full.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../loop.js"
import { eventsDir, eventsFilePath, readEventsFile, EVENT_TRUNCATE_CHARS, truncateField } from "../events.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"

// ─── Fake LLM client (mirrors src/engine/__tests__/loop.test.ts) ────────────

class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []

	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly usagePerCall?: { promptTokens: number; completionTokens: number; cachedTokens?: number },
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
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
}) {
	const session = new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: options.maxIterations ?? 10,
		checkpoints: false,
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
 *   session_end — plus the token usage incl. cachedTokens on llm_response.
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
		// execution loop, so iteration 2 emits no tool_call/tool_result.
		assert.deepEqual(types, [
			"session_start",
			"iteration_start",
			"llm_response",
			"tool_call",
			"tool_result",
			"iteration_start",
			"llm_response",
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

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	[
		"events: full lifecycle sequence (session_start … session_end) with token usage incl. cachedTokens",
		testEventSequenceWithToolThenCompletion,
	],
	["events: explicit sessionId override is honored (feed lands at the dashboard-chosen id)", testExplicitSessionIdOverrideIsHonored],
	["events: long tool results are truncated with a marker, never dumped in full", testLongContentIsTruncated],
	["events: feed file is KEPT after the session ends (unlike the live usage snapshot)", testEventFeedKeptAfterSessionEnds],
	["events: ask_followup_question mirrors decision_blocked/decision_answered on the feed", testDecisionEventsMirrorMarkerLifecycle],
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
