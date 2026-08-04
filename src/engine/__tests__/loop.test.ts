/**
 * Loop + executor tests for the Phase 1 headless harness.
 *
 * Plain assert-based script (no test framework, no network, no API key) run
 * via `npm test` → `tsx src/engine/__tests__/loop.test.ts`.
 *
 * The loop is tested end-to-end with a fake LlmClient injected through the
 * constructor (DI) — the loop never hardcodes OpenRouter.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { HeadlessSession, truncateHistory, TRUNCATION_BATCH_SIZE } from "../loop.js"
import { createHeadlessExecutor } from "../../tools/executor.js"
import { createCheckpointService } from "../../checkpoints/service.js"
import { parseToolCall } from "../parser.js"
import { readUsageFile } from "../usage.js"
import type { SessionBudget } from "../../budget/budget.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"

// ─── Fake LLM client ─────────────────────────────────────────────────────────

class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []

	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly onRequest?: (req: LlmRequest) => void,
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		// Snapshot messages: the loop mutates the SAME array across iterations
		// (assistant/tool pushes, condensation, nudge injection). Without a copy,
		// every recorded request aliases to the array's final state — making the
		// read-only nudge appear in requests that predate its injection.
		this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) })
		this.onRequest?.(request)
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

function textReply(content: string): ChatMessage {
	return { role: "assistant", content }
}

/**
 * Live-snapshot probe client: reports a fixed token usage per call and, from
 * the second call on, runs `probe()` BEFORE returning — at that point the
 * previous iteration's `*.live.json` snapshot must already be on disk (it is
 * written right after each iteration's LLM call). Used to observe the live
 * snapshot mid-run without exposing the session's private sessionId.
 */
class LiveProbeClient implements LlmClient {
	calls = 0

	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly probe: () => Promise<void>,
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.calls++
		if (this.calls > 1) {
			await this.probe()
		}
		const step = this.script.shift()
		if (!step) {
			throw new Error("LiveProbeClient: script exhausted (model kept calling)")
		}
		return {
			message: step(request),
			usage: { promptTokens: 100, completionTokens: 50 },
		}
	}
}

/** Read the single `*.live.json` snapshot in a usage dir (asserts it exists). */
async function readLiveSnapshot(usageDir: string): Promise<Record<string, unknown>> {
	const entries = await fs.readdir(usageDir)
	const live = entries.find((e) => e.endsWith(".live.json"))
	assert.ok(live, `expected a *.live.json snapshot in ${usageDir}, found: ${entries.join(", ") || "(empty)"}`)
	return JSON.parse(await fs.readFile(path.join(usageDir, live), "utf-8")) as Record<string, unknown>
}

/** Assert a live snapshot is gone and a single final `.jsonl` record remains. */
async function assertCompletedCleanup(ws: string, expectedStatus: string): Promise<void> {
	const usageDir = path.join(ws, ".headlesscode", "usage")
	const entries = await fs.readdir(usageDir)
	assert.ok(entries.some((e) => e.endsWith(".jsonl")), "final .jsonl record written")
	assert.ok(!entries.some((e) => e.endsWith(".live.json")), "live snapshot removed on completion")
	const jsonl = entries.find((e) => e.endsWith(".jsonl"))
	assert.ok(jsonl, "found the .jsonl file")
	const records = await readUsageFile(path.join(usageDir, jsonl))
	assert.equal(records.length, 1)
	assert.equal(records[0].status, expectedStatus)
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

/** Poll `process.kill(pid, 0)` until the process is gone (throws) or timeout. */
async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0)
		} catch {
			return // gone
		}
		await sleep(50)
	}
	throw new Error(`process ${pid} still alive after ${timeoutMs}ms`)
}

async function makeSession(options: {
	task: string
	client: LlmClient
	workspaceRoot: string
	maxIterations?: number
	consecutiveErrorLimit?: number
	windowSize?: number
	budget?: SessionBudget
	/** Checkpoints on/off + shadow-git storage dir (default off — see below). */
	checkpoints?: boolean
	checkpointDir?: string
}) {
	const session = new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: options.maxIterations ?? 10,
		consecutiveErrorLimit: options.consecutiveErrorLimit ?? 3,
		windowSize: options.windowSize ?? 40,
		budget: options.budget ?? null,
		// Checkpoints are default-on and would otherwise write real shadow-git
		// commits to ~/.headlesscode/checkpoints on every test run; this suite
		// isn't testing checkpoints (except the one that is), so keep tests
		// hermetic and fast. The checkpoint test passes a tmp checkpointDir.
		checkpoints: options.checkpoints ?? false,
		checkpointDir: options.checkpointDir,
	})
	return session
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testScenario1WriteThenCompletion(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-s1-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "sub/dir/hello.txt", content: "hello world" }),
			() => toolCall("attempt_completion", { result: "Done: wrote sub/dir/hello.txt" }),
		])
		const session = await makeSession({ task: "write a hello file", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.match(result.result ?? "", /hello\.txt/)
		// The file was actually written via the executor.
		const content = await fs.readFile(path.join(ws, "sub", "dir", "hello.txt"), "utf-8")
		assert.equal(content, "hello world")
		// The system prompt was built from the vendored builder.
		assert.ok(session.state.systemPrompt.length > 100, "system prompt should be built")
		assert.ok(session.state.systemPrompt.includes("TOOL USE"), "system prompt should contain TOOL USE section")
		// Tools sent to the LLM are exactly the implemented subset (the three
		// surgical edit tools are implemented and therefore advertised too).
		const toolNames = client.requests[0].tools?.map((t) => (t.type === "function" ? t.function.name : t.type))
		assert.ok(toolNames?.includes("read_file"), "read_file should be exposed")
		assert.ok(toolNames?.includes("attempt_completion"), "attempt_completion should be exposed")
		assert.ok(toolNames?.includes("apply_diff"), "apply_diff should be exposed (implemented)")
		assert.ok(toolNames?.includes("search_replace"), "search_replace should be exposed (implemented)")
		assert.ok(toolNames?.includes("edit_file"), "edit_file should be exposed (implemented)")
		assert.ok(toolNames?.includes("codebase_search"), "codebase_search should be exposed (implemented)")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testScenario2CommandThenTextAnswer(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-s2-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "node -e 'console.log(1+1)'" }),
			() => textReply("All done. The command produced 2."),
		])
		const session = await makeSession({ task: "run a command", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "All done. The command produced 2.")
		// The execute_command tool result was fed back as a tool message.
		const toolMsg = session.state.messages.find((m) => m.role === "tool")
		assert.ok(toolMsg, "expected a tool message in history")
		assert.match(toolMsg?.content ?? "", /2/, "command output should be in the tool result")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testScenario3ErroringToolBoundedFailure(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-s3-"))
	try {
		// Model keeps calling codebase_search with no index built yet — the
		// handler returns a clear "not indexed" error, so the loop still hits
		// its consecutive-mistake bound (the tool is real, the workspace just
		// has no index).
		const client = new FakeLlmClient([
			() => toolCall("codebase_search", { query: "x" }),
			() => toolCall("codebase_search", { query: "x" }),
			() => toolCall("codebase_search", { query: "x" }),
			() => toolCall("codebase_search", { query: "x" }),
		])
		const session = await makeSession({
			task: "search the codebase",
			client,
			workspaceRoot: ws,
			consecutiveErrorLimit: 3,
		})
		const result = await session.run()

		assert.equal(result.status, "error", "expected bounded failure")
		assert.match(result.error ?? "", /Bounded failure|consecutive/)
		assert.equal(result.iterations, 3, "should fail after exactly 3 consecutive errors")
		// Tool results were fed back as error tool messages.
		const toolMsgs = session.state.messages.filter((m) => m.role === "tool")
		assert.equal(toolMsgs.length, 3)
		assert.match(toolMsgs[0]?.content ?? "", /no codebase index|not indexed/i)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testScenario4MalformedJsonArgs(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-s4-"))
	try {
		// Malformed arguments -> parser fallback should recover something or mark
		// a parse error; either way the loop continues and completes.
		const client = new FakeLlmClient([
			() => toolCall("read_file", `{"path": "foo.txt", "offset": `), // truncated JSON
			() => toolCall("attempt_completion", { result: "recovered from malformed args" }),
		])
		const session = await makeSession({ task: "read a file", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.match(result.result ?? "", /recovered/)

		// Direct parser fallback check: truncated JSON recovers `path`.
		const parsed = parseToolCall(
			{ id: "c1", type: "function", function: { name: "read_file", arguments: `{"path": "foo.txt", "offset": ` } },
			0,
		)
		assert.equal(parsed.parseError, undefined, "fallback should recover partial args")
		assert.equal(parsed.args["path"], "foo.txt")

		// Totally garbage arguments -> parseError set.
		const garbage = parseToolCall(
			{ id: "c2", type: "function", function: { name: "read_file", arguments: "not json at all {{{" } },
			0,
		)
		assert.ok(garbage.parseError, "garbage args should be marked as a parse error")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPathTraversalGuard(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-pt-"))
	try {
		const executor = createHeadlessExecutor(ws)

		// read_file with "../outside" must be rejected.
		const read = await executor.execute("read_file", { path: "../outside.txt" })
		assert.equal(read.isError, true)
		assert.match(read.content, /escapes the workspace|Error/)

		// write_to_file with an escaping path must be rejected.
		const write = await executor.execute("write_to_file", { path: "../evil.txt", content: "x" })
		assert.equal(write.isError, true)

		// Absolute path outside the root must be rejected.
		const abs = await executor.execute("read_file", { path: "/etc/passwd" })
		assert.equal(abs.isError, true)

		// A path inside the root still works.
		await executor.execute("write_to_file", { path: "ok.txt", content: "fine" })
		const inside = await executor.execute("read_file", { path: "ok.txt" })
		assert.equal(inside.isError, false)
		assert.match(inside.content, /fine/)

		// list_files also guards.
		const list = await executor.execute("list_files", { path: "../" })
		assert.equal(list.isError, true)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMaxIterationsBound(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-mi-"))
	try {
		// Model keeps succeeding (distinct successful commands, so no
		// consecutive-mistake trigger) but never calls attempt_completion nor
		// replies with a final text answer — the loop must stop at maxIterations.
		const client = new FakeLlmClient(
			Array.from({ length: 20 }, (_, i) => () =>
				toolCall("execute_command", { command: `node -e 'console.log(${i})'` }),
			),
		)
		const session = await makeSession({ task: "loop forever", client, workspaceRoot: ws, maxIterations: 4 })
		const result = await session.run()
		assert.equal(result.status, "error", `expected max-iterations failure, got ${JSON.stringify(result)}`)
		assert.match(result.error ?? "", /Max iterations/)
		assert.equal(result.iterations, 4)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Blind tree-walking guardrail (P1.6) ─────────────────────────────────────

const NUDGE_FRAGMENT = "You've made several read/exploration calls"

/** Indexed fixture: files f1..fn plus a non-empty `.headlesscode/codesearch/index.jsonl`. */
async function makeIndexedWorkspace(prefix: string, n: number): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
	await fs.mkdir(path.join(ws, ".headlesscode", "codesearch"), { recursive: true })
	for (let i = 1; i <= n; i++) {
		await fs.writeFile(path.join(ws, `f${i}.txt`), `content ${i}\n`)
	}
	// Non-empty is all hasCodebaseIndex() requires — the guardrail only
	// checks existence, it never queries the index.
	await fs.writeFile(path.join(ws, ".headlesscode", "codesearch", "index.jsonl"), '{"dummy":true}\n')
	return ws
}

function requestsContainingNudge(requests: LlmRequest[]): number[] {
	return requests
		.map((r, i) => (r.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(NUDGE_FRAGMENT)) ? i : -1))
		.filter((i) => i >= 0)
}

async function testReadOnlyNudgeTriggered(): Promise<void> {
	const ws = await makeIndexedWorkspace("headlesscode-nudge-", 9)
	try {
		// 8 consecutive read_file iterations (distinct paths, so no
		// identical-repeat mistakes) then completion. The nudge must be
		// injected at the end of iteration 8 and visible in the 9th request.
		const client = new FakeLlmClient([
			...Array.from({ length: 8 }, (_, i) => () => toolCall("read_file", { path: `f${i + 1}.txt` })),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.ok(client.requests.length >= 9, `expected >=9 requests, got ${client.requests.length}`)
		const nudged = requestsContainingNudge(client.requests)
		assert.deepEqual(nudged, [8], "nudge should appear exactly once, in the request after the 8th read-only iteration")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyNudgeResetsOnProductiveCall(): Promise<void> {
	const ws = await makeIndexedWorkspace("headlesscode-nudge-reset-", 12)
	try {
		// 4 read-only (below threshold), a write_to_file resets the streak,
		// then 8 more read-only re-trigger the nudge. The write at iteration
		// 5 means the second streak ends at iteration 13, so the nudge shows
		// up in request 14 (index 13).
		const client = new FakeLlmClient([
			() => toolCall("read_file", { path: "f1.txt" }),
			() => toolCall("read_file", { path: "f2.txt" }),
			() => toolCall("read_file", { path: "f3.txt" }),
			() => toolCall("read_file", { path: "f4.txt" }),
			() => toolCall("write_to_file", { path: "out.txt", content: "reset" }),
			...Array.from({ length: 8 }, (_, i) => () => toolCall("read_file", { path: `f${i + 5}.txt` })),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore", client, workspaceRoot: ws, maxIterations: 20 })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const nudged = requestsContainingNudge(client.requests)
		assert.deepEqual(nudged, [13], "nudge should fire only AFTER the write_to_file reset, on the second 8-call streak")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyNudgeNotInjectedWhenUnindexed(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-nudge-noindex-"))
	try {
		for (let i = 1; i <= 9; i++) {
			await fs.writeFile(path.join(ws, `f${i}.txt`), `content ${i}\n`)
		}
		const client = new FakeLlmClient([
			...Array.from({ length: 9 }, (_, i) => () => toolCall("read_file", { path: `f${i + 1}.txt` })),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.deepEqual(requestsContainingNudge(client.requests), [], "no nudge when the workspace has no codebase-search index")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Live (in-progress) usage snapshot lifecycle ─────────────────────────────

async function testLiveSnapshotCreatedAndUpdatedDuringIterations(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-live-"))
	try {
		const usageDir = path.join(ws, ".headlesscode", "usage")
		let probes = 0
		const client = new LiveProbeClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "hello" }),
				() => toolCall("write_to_file", { path: "b.txt", content: "world" }),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			async () => {
				probes++
				const snap = await readLiveSnapshot(usageDir)
				assert.equal(snap.status, "running")
				assert.equal(typeof snap.sessionId, "string")
				assert.ok(String(snap.sessionId).length > 0)
				assert.equal(snap.workspaceRoot, ws)
				assert.equal(snap.mode, "code")
				assert.equal(snap.model, "fake-model")
				assert.equal(snap.endedAt, undefined, "live snapshot has no endedAt")
				assert.equal(typeof snap.costUsd, "number")
				if (probes === 1) {
					// Probe runs before call 2: the iteration-1 snapshot.
					assert.equal(snap.iterations, 1)
					assert.equal(snap.inputTokens, 100)
					assert.equal(snap.outputTokens, 50)
				} else {
					// Probe runs before call 3: overwritten in place for iteration 2.
					assert.equal(snap.iterations, 2)
					assert.equal(snap.inputTokens, 200)
					assert.equal(snap.outputTokens, 100)
				}
			},
		)
		const session = await makeSession({ task: "write two files", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(probes, 2, "probe ran before both the 2nd and 3rd LLM calls")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testLiveSnapshotRemovedOnSuccess(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-live-succ-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "write a file", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		await assertCompletedCleanup(ws, "success")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testLiveSnapshotRemovedOnError(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-live-err-"))
	try {
		// Model keeps calling an unimplemented stub tool (codebase_search) →
		// bounded failure (status "error") after `consecutiveErrorLimit` mistakes.
		const client = new FakeLlmClient([
			() => toolCall("codebase_search", { query: "x" }),
			() => toolCall("codebase_search", { query: "x" }),
			() => toolCall("codebase_search", { query: "x" }),
		])
		const session = await makeSession({
			task: "search the codebase",
			client,
			workspaceRoot: ws,
			consecutiveErrorLimit: 3,
		})
		const result = await session.run()
		assert.equal(result.status, "error", `expected bounded failure, got ${JSON.stringify(result)}`)
		await assertCompletedCleanup(ws, "error")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testLiveSnapshotRemovedOnBudgetExceeded(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-live-budget-"))
	try {
		// Budget maxIterations: 1 → iteration 1 runs (live snapshot written),
		// iteration 2's pre-call tick() trips the budget → status "error",
		// reason "budget".
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "write a file",
			client,
			workspaceRoot: ws,
			budget: { maxIterations: 1 },
		})
		const result = await session.run()
		assert.equal(result.status, "error", `expected budget abort, got ${JSON.stringify(result)}`)
		assert.equal(result.reason, "budget")
		await assertCompletedCleanup(ws, "budget")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── execute_command timeout semantics ───────────────────────────────────────

async function testTimeoutDoesNotCountAsMistake(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-timeout-"))
	try {
		// consecutiveErrorLimit: 1 means a SINGLE mistaken tool call ends the
		// session in bounded failure. The execute_command times out (its child
		// is left running in the background) and must NOT count as a mistake —
		// so the session still reaches attempt_completion and succeeds.
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "node -e 'setTimeout(()=>{},5000)'", timeout: 1 }),
			() => toolCall("attempt_completion", { result: "backgrounded it and moved on" }),
		])
		const session = await makeSession({
			task: "start a long process and continue",
			client,
			workspaceRoot: ws,
			consecutiveErrorLimit: 1,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `timeout must not be a mistake, got ${JSON.stringify(result)}`)
		assert.match(result.result ?? "", /backgrounded/)
		// The tool message fed back to the model is the timeout marker, and it
		// must NOT be an error message (no "[Error]" prefix).
		const toolMsg = session.state.messages.find((m) => m.role === "tool")
		assert.ok(toolMsg, "expected a tool message in history")
		assert.match(toolMsg?.content ?? "", /timed out after 1s/, "timeout marker must be fed back to the model")
		assert.doesNotMatch(toolMsg?.content ?? "", /^\[Error\]/, "a timeout must not look like an error to the model")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSessionEndReapsBackgroundedChildren(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-reap-"))
	try {
		// The execute_command times out and its child is left running in the
		// background (it would write a marker after 60s). The session then
		// completes normally. At session end the teardown hook (dispose in
		// run()'s finally) must hard-kill the backgrounded child — NOT leave
		// it orphaned past its session.
		const marker = path.join(ws, "leftover-marker.txt")
		const client = new FakeLlmClient([
			() =>
				toolCall("execute_command", {
					command:
						`node -e 'console.log("pid=" + process.pid); ` +
						`setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "done"), 60000)'`,
					timeout: 1,
				}),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "start then finish", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		// Recover the backgrounded pid from the tool result fed back to the model.
		const toolMsg = session.state.messages.find((m) => m.role === "tool")
		const pidMatch = toolMsg?.content?.match(/pid=(\d+)/)
		assert.ok(pidMatch, "tool result should contain the backgrounded pid")
		const pid = Number(pidMatch[1])
		assert.ok(Number.isInteger(pid) && pid > 0, "could not extract the backgrounded pid")

		// The session has ended: the child must have been killed by the
		// teardown hook, so it is no longer alive and can never write its marker.
		await waitForProcessExit(pid)
		assert.equal(await exists(marker), false, "killed backgrounded child must never write its marker")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
	* The loop's checkpoint trigger used to key off the executor having
	* `write_to_file` registered — an iteration that used ONLY `apply_diff` (no
	* write_to_file call at all) would slip through uncheckpointed. Regression:
	* a session whose model edits via apply_diff alone must still snapshot.
	*
	* The diff markers are assembled at runtime (`<".repeat(7)` etc.) so the
	* literal SEARCH/REPLACE sequences don't appear in this file's source.
	*/
async function testCheckpointTriggeredByApplyDiffOnly(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-ckpt-applydiff-"))
	const checkpointDir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ckpt-loop-"))
	try {
		// Seed a file the model will edit via apply_diff only.
		await fs.writeFile(path.join(ws, "greeting.txt"), "hello world\n", "utf-8")

		const diff = [
			"<".repeat(7) + " SEARCH",
			":start_line:1",
			"-------",
			"hello world",
			"=======",
			"hello brave new world",
			">".repeat(7) + " REPLACE",
		].join("\n")
		const client = new FakeLlmClient([
			() => toolCall("apply_diff", { path: "greeting.txt", diff }),
			() => toolCall("attempt_completion", { result: "Done: edited greeting.txt" }),
		])
		const session = await makeSession({
			task: "edit greeting.txt",
			client,
			workspaceRoot: ws,
			checkpoints: true,
			checkpointDir,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		// The diff was actually applied to disk.
		assert.equal(await fs.readFile(path.join(ws, "greeting.txt"), "utf-8"), "hello brave new world\n")

		// The shadow-git checkpoint repo for this session must exist and hold
		// more than the baseline snapshot (baseline + post-iteration snapshot).
		const tasksDir = path.join(checkpointDir, "tasks")
		const taskIds = await fs.readdir(tasksDir)
		assert.equal(taskIds.length, 1, `expected exactly one checkpoint task, got: ${taskIds.join(", ")}`)
		const svc = createCheckpointService({ taskId: taskIds[0], workspaceRoot: ws, checkpointDir })
		await svc.init()
		const entries = await svc.list()
		assert.ok(entries.length >= 2, `expected baseline + iteration checkpoints, got ${entries.length}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

// ─── truncateHistory — batch eviction (cache-stability regression) ───────────

function fakeMsg(i: number): ChatMessage {
	return { role: i % 2 === 0 ? "assistant" : "tool", content: `msg-${i}`, name: i % 2 === 0 ? undefined : "tool" }
}

async function testTruncateHistoryNoOpBelowWindow(): Promise<void> {
	const messages = [fakeMsg(0), fakeMsg(1), fakeMsg(2), fakeMsg(3)]
	const result = truncateHistory(messages, 40)
	assert.deepEqual(result, messages, "below the window, history is returned untouched")
}

async function testTruncateHistoryEvictsInBatches(): Promise<void> {
	const windowSize = 10
	// system + firstUser + 20 more = 22 total, well over the window.
	const messages = [fakeMsg(0), fakeMsg(1), ...Array.from({ length: 20 }, (_, i) => fakeMsg(i + 2))]
	const result = truncateHistory(messages, windowSize)
	// overflow = 20 - (10 - 2) = 12 -> evictCount = ceil(12/10)*10 = 20 (a full batch beyond
	// the raw overflow, not just the minimum 12) -- kept tail is system+firstUser+0 of `rest`.
	assert.equal(result.length, 2, `expected only system+firstUser kept, got ${result.length}`)
	assert.equal(result[0], messages[0])
	assert.equal(result[1], messages[1])
}

/**
 * 2026-08-01 regression: real sessions have an irregular number of tool
 * calls per turn (1-3), so a raw positional batch cut can land in the middle
 * of an assistant `tool_calls` + its `tool` response group -- evicting the
 * assistant message but keeping its orphaned `tool` response(s). DeepSeek's
 * official endpoint rejects that with HTTP 400. Builds a history shaped like
 * the real failing session (varying call counts per turn) and asserts the
 * kept tail never starts with a `role: "tool"` message.
 */
async function testTruncateHistoryNeverSplitsToolCallGroup(): Promise<void> {
	const system = fakeMsg(0)
	const firstUser = fakeMsg(1)
	const rest: ChatMessage[] = []
	const callCounts = [1, 3, 2, 1, 2, 3, 1, 1, 2, 3, 1, 2]
	for (const n of callCounts) {
		const calls: ChatToolCall[] = Array.from({ length: n }, (_, i) => ({
			id: `call_${rest.length}_${i}`,
			type: "function",
			function: { name: "read_file", arguments: "{}" },
		}))
		rest.push({ role: "assistant", content: null, tool_calls: calls })
		for (const c of calls) {
			rest.push({ role: "tool", content: "ok", tool_call_id: c.id, name: "read_file" })
		}
	}
	const messages = [system, firstUser, ...rest]
	for (let windowSize = 4; windowSize < messages.length; windowSize++) {
		const result = truncateHistory(messages, windowSize)
		if (result.length > 2) {
			assert.notEqual(
				result[2].role,
				"tool",
				`windowSize=${windowSize}: kept tail starts with an orphaned tool message`,
			)
		}
	}
}

/**
 * The actual regression this batching fixes: once truncation is active, the
 * prefix sent to the model must stay IDENTICAL across multiple consecutive
 * calls (not re-slice a different window every single time), so provider-
 * side prompt caching can actually accrue. Simulates a growing conversation
 * one message at a time (as HeadlessSession's real loop does) and asserts
 * the truncated result is byte-identical (via deepEqual) across a whole
 * batch's worth of growth, only changing at the batch boundary.
 */
async function testTruncateHistoryStablePrefixBetweenBatches(): Promise<void> {
	const windowSize = 20
	const system = fakeMsg(0)
	const firstUser = fakeMsg(1)
	const results: ChatMessage[][] = []
	let messages = [system, firstUser]
	// Grow one message at a time well past the window, capturing each truncated result.
	for (let i = 2; i < 2 + 40; i++) {
		messages = [...messages, fakeMsg(i)]
		results.push(truncateHistory(messages, windowSize))
	}
	// A genuinely growing conversation can never produce byte-identical
	// results call-to-call (new content is always appended) -- what caching
	// actually needs is that the RETAINED PREFIX doesn't shift: each new
	// result should be the previous one PLUS new messages appended at the
	// end, not a window whose oldest kept message also changes every call
	// (that was the original bug -- `rest.slice(-(windowSize-2))` shifts
	// its start index on every single call once truncation is active).
	// Find the longest run of consecutive calls where every result is a
	// prefix-preserving extension of the one before it, and confirm at
	// least one such run is TRUNCATION_BATCH_SIZE calls long.
	function isPrefixExtension(prev: ChatMessage[], next: ChatMessage[]): boolean {
		if (next.length < prev.length) return false
		return prev.every((m, i) => m === next[i])
	}
	let longestStableRun = 1
	let currentRun = 1
	for (let i = 1; i < results.length; i++) {
		const extends_ = isPrefixExtension(results[i - 1], results[i])
		currentRun = extends_ ? currentRun + 1 : 1
		longestStableRun = Math.max(longestStableRun, currentRun)
	}
	assert.ok(
		longestStableRun >= TRUNCATION_BATCH_SIZE,
		`expected a run of at least ${TRUNCATION_BATCH_SIZE} consecutive prefix-preserving (cache-eligible) calls, longest was ${longestStableRun}`,
	)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["scenario 1: write_to_file + attempt_completion -> success, file written", testScenario1WriteThenCompletion],
	["scenario 2: execute_command + text answer -> success with text result", testScenario2CommandThenTextAnswer],
	["scenario 3: erroring tool x3 -> bounded failure", testScenario3ErroringToolBoundedFailure],
	["scenario 4: malformed JSON args -> parser fallback exercised", testScenario4MalformedJsonArgs],
	["path-traversal guard rejects escaping paths", testPathTraversalGuard],
	["max iterations -> bounded failure", testMaxIterationsBound],
	["blind tree-walking: nudge after N consecutive read-only iterations (indexed ws)", testReadOnlyNudgeTriggered],
	["blind tree-walking: a productive tool call resets the streak", testReadOnlyNudgeResetsOnProductiveCall],
	["blind tree-walking: no nudge when the workspace is unindexed", testReadOnlyNudgeNotInjectedWhenUnindexed],
	["live snapshot: created + updated in place during a running session's iterations", testLiveSnapshotCreatedAndUpdatedDuringIterations],
	["live snapshot: removed on successful completion", testLiveSnapshotRemovedOnSuccess],
	["live snapshot: removed when the session ends with an error", testLiveSnapshotRemovedOnError],
	["live snapshot: removed when the session is aborted by budget limits", testLiveSnapshotRemovedOnBudgetExceeded],
	["execute_command: a timed-out call does NOT count toward the consecutive-mistake limit", testTimeoutDoesNotCountAsMistake],
	["execute_command: session end reaps backgrounded children (no orphans left behind)", testSessionEndReapsBackgroundedChildren],
	["checkpoints: apply_diff-only iteration still triggers a checkpoint", testCheckpointTriggeredByApplyDiffOnly],
	["truncateHistory: no-op below the window", testTruncateHistoryNoOpBelowWindow],
	["truncateHistory: evicts in TRUNCATION_BATCH_SIZE-sized batches", testTruncateHistoryEvictsInBatches],
	["truncateHistory: never splits an assistant tool_calls / tool response group", testTruncateHistoryNeverSplitsToolCallGroup],
	["truncateHistory: prefix stays stable across a batch (cache-eligible)", testTruncateHistoryStablePrefixBetweenBatches],
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
	console.log(`\nAll ${tests.length} tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
