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

import { HeadlessSession } from "../loop.js"
import { createHeadlessExecutor } from "../../tools/executor.js"
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
		this.requests.push(request)
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

async function makeSession(options: {
	task: string
	client: LlmClient
	workspaceRoot: string
	maxIterations?: number
	consecutiveErrorLimit?: number
	windowSize?: number
	budget?: SessionBudget
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
		// isn't testing checkpoints, so keep tests hermetic and fast.
		checkpoints: false,
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
		// Tools sent to the LLM are exactly the implemented subset.
		const toolNames = client.requests[0].tools?.map((t) => (t.type === "function" ? t.function.name : t.type))
		assert.ok(toolNames?.includes("read_file"), "read_file should be exposed")
		assert.ok(toolNames?.includes("attempt_completion"), "attempt_completion should be exposed")
		assert.ok(!toolNames?.includes("apply_diff"), "apply_diff stub should NOT be exposed to the model")
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
		// Model keeps calling an unimplemented stub tool (apply_diff).
		const client = new FakeLlmClient([
			() => toolCall("apply_diff", { path: "a.ts", diff: "ignored" }),
			() => toolCall("apply_diff", { path: "a.ts", diff: "ignored" }),
			() => toolCall("apply_diff", { path: "a.ts", diff: "ignored" }),
			() => toolCall("apply_diff", { path: "a.ts", diff: "ignored" }),
		])
		const session = await makeSession({
			task: "apply a diff",
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
		assert.match(toolMsgs[0]?.content ?? "", /not implemented/)
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
		// Model keeps calling an unimplemented stub tool (apply_diff) → bounded
		// failure (status "error") after `consecutiveErrorLimit` mistakes.
		const client = new FakeLlmClient([
			() => toolCall("apply_diff", { path: "a.ts", diff: "x" }),
			() => toolCall("apply_diff", { path: "a.ts", diff: "x" }),
			() => toolCall("apply_diff", { path: "a.ts", diff: "x" }),
		])
		const session = await makeSession({
			task: "apply a diff",
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

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["scenario 1: write_to_file + attempt_completion -> success, file written", testScenario1WriteThenCompletion],
	["scenario 2: execute_command + text answer -> success with text result", testScenario2CommandThenTextAnswer],
	["scenario 3: erroring tool x3 -> bounded failure", testScenario3ErroringToolBoundedFailure],
	["scenario 4: malformed JSON args -> parser fallback exercised", testScenario4MalformedJsonArgs],
	["path-traversal guard rejects escaping paths", testPathTraversalGuard],
	["max iterations -> bounded failure", testMaxIterationsBound],
	["live snapshot: created + updated in place during a running session's iterations", testLiveSnapshotCreatedAndUpdatedDuringIterations],
	["live snapshot: removed on successful completion", testLiveSnapshotRemovedOnSuccess],
	["live snapshot: removed when the session ends with an error", testLiveSnapshotRemovedOnError],
	["live snapshot: removed when the session is aborted by budget limits", testLiveSnapshotRemovedOnBudgetExceeded],
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
