/**
 * Tests for mid-session message injection (src/engine/loop.ts's
 * `checkInjectedMessage` + the `.harness.inject-message` marker protocol,
 * written by the dashboard's POST /api/session/:id/message — see
 * plans/live-message-injection-for-chat-uis.md).
 *
 * Mirrors src/engine/__tests__/pause.test.ts's scripted-fake LlmClient
 * pattern: the marker is written from the fake client's onCall hook (i.e.
 * while an LLM call is "in flight"), so the check at the top of the NEXT
 * iteration picks it up.
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/engine/__tests__/inject-message.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../loop.js"
import { eventsDir, eventsFilePath, readEventsFile } from "../events.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"

const INJECT_MESSAGE = ".harness.inject-message"
const INJECTED_TEXT = "Wait — switch to the other approach first, then continue."

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

// ─── Fake LLM client (mirrors pause.test.ts) ─────────────────────────────────

class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []
	/**
	 * onCall fires before each createChatCompletion resolves. `call` is the
	 * 1-based call count. Tests use it to write the inject marker during the
	 * FIRST call so iteration 2's checkInjectedMessage finds it.
	 */
	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly onCall?: (call: number) => Promise<void> | void,
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		// Snapshot the message array: the loop passes its LIVE history array
		// (no copy), then appends the assistant reply to it after the call
		// resolves — without the slice, later assertions would see a mutated
		// array, not what the model actually received.
		this.requests.push({ ...request, messages: request.messages.slice() })
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

function makeSession(ws: string, client: LlmClient) {
	return new HeadlessSession({
		workspaceRoot: ws,
		mode: "code",
		model: "fake-model",
		taskText: "write files",
		llmClient: client,
		maxIterations: 10,
		checkpoints: false,
	})
}

/** Read the session's event feed (the temp dir has exactly one session). */
async function readSessionEvents(ws: string) {
	const files = await fs.readdir(eventsDir(ws))
	const sessionId = files[0].replace(/\.jsonl$/, "")
	return readEventsFile(eventsFilePath(ws, sessionId))
}

/** Write a (valid) inject marker with the given text. */
async function writeMarker(ws: string, text: string): Promise<void> {
	const marker = JSON.stringify({ text, injectedAt: new Date().toISOString() }) + "\n"
	await fs.writeFile(path.join(ws, INJECT_MESSAGE), marker, "utf-8")
}

// ─── (a) mid-session injection lands in history + reaches the next LLM call ──

/**
 * A marker written during call 1 must be picked up at the top of iteration 2
 * (the safe boundary: after the prior turn's COMPLETE tool-call group, before
 * the next LLM request). The injected message appears in the exact right
 * position in the array the fake client receives for call 2, and the marker
 * is cleaned up.
 */
async function testInjectedMessageAppearsInHistoryAndNextRequest(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-inject-mid-"))
	try {
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			async (call) => {
				if (call === 1) {
					// Write the inject marker while the FIRST iteration's LLM
					// call is in flight — iteration 2's checkInjectedMessage
					// then finds it and appends it before the next request.
					await writeMarker(ws, INJECTED_TEXT)
				}
			},
		)
		const session = makeSession(ws, client)
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		// The marker was consumed: gone after pick-up.
		assert.equal(await exists(path.join(ws, INJECT_MESSAGE)), false, "inject marker must be removed after pick-up")

		// Position: [system, user(task), assistant(tool_calls), tool(result),
		// user(injected)] — the injected message comes AFTER the prior turn's
		// complete tool-call group and BEFORE the next LLM request.
		assert.equal(client.requests.length, 2, "expected exactly 2 LLM requests")
		const second = client.requests[1].messages
		assert.equal(second[second.length - 1].role, "user", "the injected message must be the last message in the next request")
		assert.equal(second[second.length - 1].content, INJECTED_TEXT)
		assert.equal(second[second.length - 2].role, "tool", "the injected message must come after the prior turn's tool results")
		assert.equal(second[second.length - 3].role, "assistant", "the tool result must be preceded by the assistant tool_calls message")
		// No orphaned tool_calls group: the assistant tool_calls message at
		// index 2 has its tool result directly after it (nothing interleaved).
		assert.ok(Array.isArray(second[2].tool_calls) && second[2].tool_calls.length > 0, "index 2 is the assistant tool_calls message")
		assert.equal(second[3].role, "tool", "the tool result directly follows the assistant tool_calls message")

		// A message_injected event was emitted with the text, so the UI can
		// render the message inline.
		const events = await readSessionEvents(ws)
		const injected = events.find((e) => e.type === "message_injected")
		assert.ok(injected, "a message_injected event must be emitted")
		assert.equal(injected.text, INJECTED_TEXT)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) a marker present before session start is picked up at iteration 1 ───

/**
 * The check runs at the top of EVERY iteration, including the first. A marker
 * written before run() starts (e.g. the dashboard raced a fast session) is
 * injected right after the initial task message — still safe (no tool-call
 * group exists yet).
 */
async function testInjectedMessageBeforeFirstIteration(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-inject-early-"))
	try {
		await writeMarker(ws, INJECTED_TEXT)
		const client = new FakeLlmClient([() => toolCall("attempt_completion", { result: "done" })])
		const session = makeSession(ws, client)
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(await exists(path.join(ws, INJECT_MESSAGE)), false, "inject marker must be removed after pick-up")

		assert.equal(client.requests.length, 1)
		const messages = client.requests[0].messages
		// [system, user(task), user(injected)]
		assert.equal(messages.length, 3)
		assert.equal(messages[2].role, "user")
		assert.equal(messages[2].content, INJECTED_TEXT)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) no marker -> zero behavior change ───────────────────────────────────

/**
 * A session with no inject marker behaves byte-identically to today: no extra
 * user message is appended to the next request, and no message_injected event
 * is emitted.
 */
async function testNoMarkerMeansNoInjection(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-inject-none-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = makeSession(ws, client)
		const result = await session.run()

		assert.equal(result.status, "success")
		assert.equal(await exists(path.join(ws, INJECT_MESSAGE)), false, "no marker file should exist")

		assert.equal(client.requests.length, 2)
		const second = client.requests[1].messages
		// Ends with the tool result — no injected user message.
		assert.equal(second[second.length - 1].role, "tool")
		assert.equal(second.length, 4, "exactly [system, user, assistant(tool_calls), tool] with no injection")
		const userMessages = second.filter((m) => m.role === "user")
		assert.equal(userMessages.length, 1, "only the original task message is a user message")

		const events = await readSessionEvents(ws)
		assert.ok(!events.some((e) => e.type === "message_injected"), "no message_injected event without a marker")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d) overwrite-with-latest (one pending message, no queue) ───────────────

/**
 * A second injection before the first is picked up OVERWRITES it (the policy
 * documented on the endpoint + marker): only the latest text is injected,
 * never both, never a queue.
 */
async function testOverwriteWithLatestPolicy(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-inject-overwrite-"))
	try {
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			async (call) => {
				if (call === 1) {
					// Two injections before iteration 2's check runs — the
					// second overwrites the first (same file, same as the
					// pause marker's write semantics).
					await writeMarker(ws, "first message (should be overwritten)")
					await writeMarker(ws, INJECTED_TEXT)
				}
			},
		)
		const session = makeSession(ws, client)
		const result = await session.run()

		assert.equal(result.status, "success")
		const second = client.requests[1].messages
		const last = second[second.length - 1]
		assert.equal(last.role, "user")
		assert.equal(last.content, INJECTED_TEXT, "only the LATEST pending injection is delivered")
		assert.ok(
			!second.some((m) => m.role === "user" && m.content === "first message (should be overwritten)"),
			"the overwritten first injection must never be delivered",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (e) malformed marker is removed and ignored, never wedges the loop ──────

/**
 * A corrupt marker must not inject garbage, must not re-error every iteration,
 * and must be cleaned up so the loop doesn't trip over it forever.
 */
async function testMalformedMarkerIsRemovedAndIgnored(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-inject-malformed-"))
	try {
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			async (call) => {
				if (call === 1) {
					await fs.writeFile(path.join(ws, INJECT_MESSAGE), "{ not valid json", "utf-8")
				}
			},
		)
		const session = makeSession(ws, client)
		const result = await session.run()

		assert.equal(result.status, "success", `a malformed marker must not break the session, got ${JSON.stringify(result)}`)
		assert.equal(await exists(path.join(ws, INJECT_MESSAGE)), false, "malformed marker must be removed after being ignored")

		assert.equal(client.requests.length, 2)
		const second = client.requests[1].messages
		assert.equal(second[second.length - 1].role, "tool", "no user message may be injected from a malformed marker")

		const events = await readSessionEvents(ws)
		assert.ok(!events.some((e) => e.type === "message_injected"), "no message_injected event for a malformed marker")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["inject: mid-session message lands in history (after the tool-call group) + reaches the next LLM request", testInjectedMessageAppearsInHistoryAndNextRequest],
	["inject: marker present before iteration 1 is picked up before the first request", testInjectedMessageBeforeFirstIteration],
	["inject: no marker -> zero behavior change (no extra user message, no event)", testNoMarkerMeansNoInjection],
	["inject: second injection before pick-up overwrites the first (no queue)", testOverwriteWithLatestPolicy],
	["inject: malformed marker is removed and ignored, never wedges the loop", testMalformedMarkerIsRemovedAndIgnored],
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
	console.log(`\nAll ${tests.length} inject-message tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
