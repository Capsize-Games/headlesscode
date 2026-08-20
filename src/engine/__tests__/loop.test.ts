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

import {
	HeadlessSession,
	DEFAULT_READ_ONLY_STALL_LIMIT,
	isReadOnlyEquivalentShellCommand,
	stripSupersededReasoning,
	truncateHistory,
	TRUNCATION_BATCH_SIZE,
} from "../loop.js"
import { OpenRouterError } from "../../llm/openrouter.js"
import { createHeadlessExecutor, createReadOnlyHeadlessExecutor } from "../../tools/executor.js"
import { createCheckpointService } from "../../checkpoints/service.js"
import { parseToolCall } from "../parser.js"
import { readUsageFile } from "../usage.js"
import { reportFilePath } from "../reports.js"
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

/** ONE assistant message carrying SEVERAL tool calls (a single-turn batch). */
function toolCallBatch(calls: Array<{ name: string; args: unknown }>): ChatMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: calls.map(({ name, args }) => ({
			id: `call_${Math.random().toString(36).slice(2)}`,
			type: "function",
			function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
		})),
	}
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

/**
	* Fake client for the Part E live-pricing tests: returns real token usage on
	* every call and (optionally) a fake `fetchModelInfo` so the session's
	* eager live lookup resolves a price. `info === undefined` models a client
	* with NO live-pricing support — the fallback path.
	*/
class UsageClient implements LlmClient {
	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly info: { price?: { input: number; output: number; cacheRead?: number } } | undefined,
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		const step = this.script.shift()
		if (!step) {
			throw new Error("UsageClient: script exhausted (model kept calling)")
		}
		return { message: step(request), usage: { promptTokens: 100, completionTokens: 50 } }
	}

	async fetchModelInfo(): Promise<{ price?: { input: number; output: number; cacheRead?: number } } | undefined> {
		return this.info
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
	/** Mode slug (default "code"). Read-only modes disable the commit guard. */
	mode?: string
	maxIterations?: number
	consecutiveErrorLimit?: number
	windowSize?: number
	budget?: SessionBudget
	/** Graded reasoning effort for deepseek/* models (issue #30). */
	reasoningEffort?: string
	/** Checkpoints on/off + shadow-git storage dir (default off — see below). */
	checkpoints?: boolean
	checkpointDir?: string
	/** Explicit session id override (see HeadlessSessionConfig.sessionId). */
	sessionId?: string
	requireExplicitCompletion?: boolean
}) {
	const session = new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: options.mode ?? "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: options.maxIterations ?? 10,
		consecutiveErrorLimit: options.consecutiveErrorLimit ?? 3,
		windowSize: options.windowSize ?? 40,
		budget: options.budget ?? null,
		reasoningEffort: options.reasoningEffort,
		requireExplicitCompletion: options.requireExplicitCompletion,
		// Checkpoints are default-on and would otherwise write real shadow-git
		// commits to ~/.headlesscode/checkpoints on every test run; this suite
		// isn't testing checkpoints (except the one that is), so keep tests
		// hermetic and fast. The checkpoint test passes a tmp checkpointDir.
		checkpoints: options.checkpoints ?? false,
		checkpointDir: options.checkpointDir,
		sessionId: options.sessionId,
	})
	return session
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testReasoningEffortFlowsIntoRequests(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-re-"))
	try {
		const client = new FakeLlmClient([() => textReply("Done.")])
		const session = await makeSession({ task: "say done", client, workspaceRoot: ws, reasoningEffort: "high" })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(
			client.requests[0]?.reasoningEffort,
			"high",
			"the session's configured reasoningEffort must be on every LLM request",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReasoningEffortEnvFallbackWhenNotConfigured(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-re2-"))
	const prev = process.env.HEADLESSCODE_REASONING_EFFORT
	process.env.HEADLESSCODE_REASONING_EFFORT = "xhigh"
	try {
		const client = new FakeLlmClient([() => textReply("Done.")])
		const session = await makeSession({ task: "say done", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.requests[0]?.reasoningEffort, "xhigh", "unset config falls back to the env var")
	} finally {
		if (prev === undefined) {
			delete process.env.HEADLESSCODE_REASONING_EFFORT
		} else {
			process.env.HEADLESSCODE_REASONING_EFFORT = prev
		}
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReasoningEffortAbsentByDefault(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-re3-"))
	try {
		const client = new FakeLlmClient([() => textReply("Done.")])
		const session = await makeSession({ task: "say done", client, workspaceRoot: ws })
		await session.run()
		assert.equal(
			client.requests[0]?.reasoningEffort,
			undefined,
			"zero config -> no reasoningEffort on requests (endpoint default applies)",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

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

// Issue #97 (COV-8): reports.ts is imported by loop.ts and runs in every
// loop test via persistFinalReport, but until now the written report FILE's
// content was never asserted anywhere — mirrors the handoff assertion above
// (testIterationCapHandoffSummary) but for the `.headlesscode/reports/` path
// instead of `.headlesscode/handoff-summary.md`.
async function testFinalReportPersistedWithFullText(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-report-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "Done: implemented the widget and verified with tests." }),
		])
		const session = await makeSession({ task: "implement widget", client, workspaceRoot: ws, sessionId: "report-test-session" })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const content = await fs.readFile(reportFilePath(ws, "report-test-session"), "utf-8")
		assert.equal(content, "Done: implemented the widget and verified with tests.")
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

// A local model giving up mid-task and dumping prose was observed live
// (2026-08-19 baseline run against Qwen2.5-Coder-14B) getting recorded as
// `session succeeded` with zero files touched — requireExplicitCompletion
// closes that gap by refusing the bare-text-reply pragmatic-success
// fallback and nudging the model to retry or call attempt_completion.
async function testRequireExplicitCompletionRefusesTextOnlyReply(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rec-"))
	try {
		const client = new FakeLlmClient([
			() => textReply("I looked at the file but couldn't figure out the edit."),
			() => toolCall("attempt_completion", { result: "Done: wrote the fallback file." }),
		])
		const session = await makeSession({
			task: "write a file",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done: wrote the fallback file.")
		assert.equal(client.requests.length, 2, "the text-only reply must not end the session early")
		const nudge = session.state.messages.find(
			(m) => m.role === "user" && (m.content ?? "").includes("does not end the session"),
		)
		assert.ok(nudge, "expected a nudge telling the model text alone isn't completion")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRequireExplicitCompletionBoundedFailureWhenNeverCompletes(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rec2-"))
	try {
		const client = new FakeLlmClient([
			() => textReply("Still thinking."),
			() => textReply("Still thinking."),
			() => textReply("Still thinking."),
		])
		const session = await makeSession({
			task: "write a file",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
			consecutiveErrorLimit: 3,
		})
		const result = await session.run()

		assert.equal(result.status, "error", `expected bounded failure, got ${JSON.stringify(result)}`)
		assert.match(result.error ?? "", /consecutive empty replies/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Qwen2.5-Coder-14B was observed live (2026-08-19) reasoning correctly
// about a tool call, then writing it as prose instead of using the native
// tool_calls channel — e.g. a fenced ```json block containing
// {"name": "write_to_file", "arguments": {...}}. requireExplicitCompletion
// sessions now recover and execute a text-embedded call, but ONLY when its
// name matches a real tool in the session's catalog.
async function testRecoversTextEmbeddedToolCallForRealTool(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-embed-"))
	try {
		const client = new FakeLlmClient([
			() =>
				textReply(
					'I will write the file now.\n\n```json\n{"name": "write_to_file", "arguments": {\'path\': \'hello.txt\', \'content\': \'hi there\'}}\n```',
				),
			() => toolCall("attempt_completion", { result: "Done: wrote hello.txt" }),
		])
		const session = await makeSession({
			task: "write a hello file",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const content = await fs.readFile(path.join(ws, "hello.txt"), "utf-8")
		assert.equal(content, "hi there", "the text-embedded call must have actually executed write_to_file")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// A different observed shape (same 2026-08-19 session): the model
// narrating in past tense that it already called a tool — no JSON blob at
// all, just "[Called tool "read_file" with arguments {...}]" — when no
// such call was ever made. Still recovered and actually executed, same
// real-tool-name safety gate as the JSON shape.
async function testRecoversNarratedToolCall(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-embed3-"))
	try {
		await fs.writeFile(path.join(ws, "notes.txt"), "line one\nline two\n")
		const client = new FakeLlmClient([
			() =>
				textReply(
					"I'll check the file first.\n\n[Called tool \"read_file\" with arguments {'path': 'notes.txt', 'mode': 'slice'}]",
				),
			() => toolCall("attempt_completion", { result: "Done: read notes.txt" }),
		])
		const session = await makeSession({
			task: "look at notes.txt",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const toolMsg = session.state.messages.find((m) => m.role === "tool")
		assert.ok(toolMsg, "expected a real tool message from the recovered read_file call")
		assert.match(toolMsg?.content ?? "", /line one/, "the recovered call must have actually read the file")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDoesNotExecuteEmbeddedCallForUnknownToolName(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-embed2-"))
	try {
		const client = new FakeLlmClient([
			() => textReply('Here is my plan: {"name": "delete_everything", "arguments": {"path": "/"}}'),
			() => toolCall("attempt_completion", { result: "Done: recovered from the bad suggestion" }),
		])
		const session = await makeSession({
			task: "write a hello file",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(
			client.requests.length,
			2,
			"an unknown tool name must not be executed — the reply is nudged like any other text-only reply",
		)
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

// ─── Main-loop retry on a transient provider error ───────────────────────────
// A hard-pinned model (deepseek/*, allow_fallbacks: false) has no fallback
// provider to smooth over a blip, so callMainLlm retries ONCE on a
// classified-transient error (isRetryableOpenRouterError) before giving up —
// see the doc comment on callMainLlm in loop.ts. Observed live: an HTTP 520
// mid-session used to kill the entire session outright with iteration
// budget otherwise untouched.

async function testMainLlmCallRetriesOnceOnTransientProviderError(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-main-retry-"))
	try {
		let calls = 0
		const client = new FakeLlmClient([
			() => {
				calls++
				throw new OpenRouterError("Provider returned error", 520)
			},
			() => {
				calls++
				return toolCall("attempt_completion", { result: "done after retry" })
			},
		])
		const session = await makeSession({ task: "retry me", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success after the retry, got ${JSON.stringify(result)}`)
		assert.equal(calls, 2, "expected exactly one retry (2 total calls) for a single transient failure")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMainLlmCallFailsAfterRetryAlsoFails(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-main-retry-fail-"))
	try {
		let calls = 0
		const client = new FakeLlmClient([
			() => {
				calls++
				throw new OpenRouterError("Provider returned error", 520)
			},
			() => {
				calls++
				throw new OpenRouterError("Provider returned error", 520)
			},
		])
		const session = await makeSession({ task: "retry me twice", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "error", "a second consecutive failure must still fail the session (only one retry)")
		assert.equal(calls, 2, "exactly two attempts — no unbounded retry loop")
		assert.equal(result.iterations, 1, "the session never advanced past iteration 1")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMainLlmCallDoesNotRetryDeterministicError(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-main-no-retry-"))
	try {
		let calls = 0
		const client = new FakeLlmClient([
			() => {
				calls++
				throw new OpenRouterError("Invalid API key", 401)
			},
			() => {
				calls++
				return toolCall("attempt_completion", { result: "should never be reached" })
			},
		])
		const session = await makeSession({ task: "auth failure", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "error", "a deterministic 401 must fail immediately")
		assert.equal(calls, 1, "no retry attempted for a non-retryable error")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testIterationCapHandoffSummary(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-handoff-"))
	try {
		// 4 tool-call iterations to exhaust maxIterations, then ONE more script
		// step: the loop's own condensation call for the handoff write (see
		// writeIterationCapHandoff in loop.ts), which must get a real text
		// answer back (condenseOldestTurns rejects an empty/tool-call reply).
		const client = new FakeLlmClient([
			...Array.from({ length: 4 }, (_, i) => () => toolCall("execute_command", { command: `node -e 'console.log(${i})'` })),
			() => ({ role: "assistant", content: "Read useConversations.ts; the fix belongs in refresh()." }),
		])
		const session = await makeSession({ task: "loop forever", client, workspaceRoot: ws, maxIterations: 4 })
		const result = await session.run()
		assert.equal(result.status, "error", `expected max-iterations failure, got ${JSON.stringify(result)}`)

		const handoffPath = path.join(ws, ".headlesscode", "handoff-summary.md")
		const content = await fs.readFile(handoffPath, "utf-8")
		assert.match(content, /Handoff summary/)
		assert.match(content, /Read useConversations\.ts; the fix belongs in refresh\(\)\./)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testIterationCapHandoffSummaryNonFatalWhenCondenseCallFails(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-handoff-short-"))
	try {
		// maxIterations: 1, and the script has exactly ONE step (consumed by
		// that one iteration) — none left for the handoff write's own
		// condensation call, which now retries ONCE (a live round hit DeepSeek's
		// pinned endpoint erroring transiently on this exact call — see
		// writeIterationCapHandoff), so BOTH the first attempt and the retry
		// throw "script exhausted". That failure must still be swallowed
		// (non-fatal): the session's own max-iterations result is unaffected
		// and no handoff file is written.
		const client = new FakeLlmClient([() => toolCall("execute_command", { command: "true" })])
		const session = await makeSession({ task: "short", client, workspaceRoot: ws, maxIterations: 1 })
		const result = await session.run()
		assert.equal(result.status, "error")
		assert.match(result.error ?? "", /Max iterations/)

		await assert.rejects(fs.access(path.join(ws, ".headlesscode", "handoff-summary.md")))
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testIterationCapHandoffSummaryRetriesOnceAfterCondenseFailure(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-handoff-retry-"))
	try {
		// First condensation attempt throws (simulating the live DeepSeek
		// "no allowed providers" blip); the retry succeeds and the handoff
		// summary is written from the retry's response.
		let condenseAttempts = 0
		const client = new FakeLlmClient([
			...Array.from({ length: 4 }, (_, i) => () => toolCall("execute_command", { command: `node -e 'console.log(${i})'` })),
			() => {
				condenseAttempts++
				throw new Error("simulated transient provider error")
			},
			() => {
				condenseAttempts++
				return { role: "assistant" as const, content: "Retry succeeded: root cause is in refresh()." }
			},
		])
		const session = await makeSession({ task: "loop forever", client, workspaceRoot: ws, maxIterations: 4 })
		const result = await session.run()
		assert.equal(result.status, "error")
		assert.equal(condenseAttempts, 2, "expected exactly one retry after the first condensation failure")

		const content = await fs.readFile(path.join(ws, ".headlesscode", "handoff-summary.md"), "utf-8")
		assert.match(content, /Retry succeeded: root cause is in refresh\(\)\./)
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

async function testReadOnlyNudgeInjectedWhenUnindexed(): Promise<void> {
	// Regression (round w3, issue #103, 2026-08-16): the guardrail was gated
	// on hasCodebaseIndex() and so was INERT on the unindexed workspaces where
	// grep-spirals are worst — ~200 pure read-only iterations replaced one
	// run_tests call. The nudge must now fire there too, leading with progress
	// (run_tests) since there is no codebase_search to point at.
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
		assert.deepEqual(
			requestsContainingNudge(client.requests),
			[8, 9],
			"unindexed workspace still gets the nudge after 8 read-only iterations (and it persists for the rest of the session)",
		)
		const nudgeMsg = client.requests[8].messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.includes(NUDGE_FRAGMENT),
		)
		assert.ok(nudgeMsg && typeof nudgeMsg.content === "string", "nudge message present in the 9th request")
		assert.ok(nudgeMsg.content.includes("run_tests"), "unindexed nudge leads with run_tests (no index to point at)")
		assert.ok(!nudgeMsg.content.includes("codebase_search"), "unindexed nudge must not suggest codebase_search")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyNudgeTriggeredByGrepStyleExecuteCommand(): Promise<void> {
	const ws = await makeIndexedWorkspace("headlesscode-nudge-grep-", 1)
	try {
		// A live round (issue: harness slowness investigation) measured
		// execute_command grep/ls/sed one-liners as the DOMINANT exploration
		// pattern, far more than read_file/list_files — this guardrail must
		// count that pattern too, not just the literal read_file/list_files
		// tool names (see isReadOnlyEquivalentShellCommand).
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "grep -rn content . | head -20" }),
			() => toolCall("execute_command", { command: "ls ." }),
			() => toolCall("execute_command", { command: "cat f1.txt" }),
			() => toolCall("execute_command", { command: "sed -n '1,1p' f1.txt" }),
			() => toolCall("execute_command", { command: "git log --oneline -5 || true" }),
			() => toolCall("execute_command", { command: "git status --short || true" }),
			() => toolCall("execute_command", { command: "echo simulated-docker-compose-ps" }),
			() => toolCall("execute_command", { command: "find . -name '*.txt' | head" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.deepEqual(
			requestsContainingNudge(client.requests),
			[8],
			"8 consecutive read-only-equivalent execute_command calls should trip the nudge, same as read_file",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyNudgeNotTrippedByMutatingExecuteCommand(): Promise<void> {
	const ws = await makeIndexedWorkspace("headlesscode-nudge-mutating-", 1)
	try {
		// Same 8-call length as the triggering case above, but one call is a
		// real mutation (docker compose UP, not ps) — the whole streak must
		// never count, exactly like a write_to_file resets it.
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "grep -rn content . | head -20" }),
			() => toolCall("execute_command", { command: "ls ." }),
			() => toolCall("execute_command", { command: "echo hi > mutated.txt" }), // mutating: writes a file
			() => toolCall("execute_command", { command: "sed -n '1,1p' f1.txt" }),
			() => toolCall("execute_command", { command: "git log --oneline -5 || true" }),
			() => toolCall("execute_command", { command: "git status --short || true" }),
			() => toolCall("execute_command", { command: "find . -name '*.txt' | head" }),
			() => toolCall("execute_command", { command: "cat f1.txt" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.deepEqual(requestsContainingNudge(client.requests), [], "one mutating command in the streak must suppress the nudge")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Read-only stagnation stall limit ────────────────────────────────────────

async function testReadOnlyStallLimitTerminates(): Promise<void> {
	// The w3 failure shape, on an unindexed workspace: ~200 consecutive
	// grep-style read-only iterations. The hard stall limit (default 75) must
	// end the session with a bounded failure long before the iteration cap.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-stall-"))
	try {
		const client = new FakeLlmClient([
			...Array.from({ length: 90 }, (_, i) => () =>
				toolCall("execute_command", { command: `grep -rn 'pat${i}' . | head` })),
		])
		const session = await makeSession({ task: "verify forever", client, workspaceRoot: ws, maxIterations: 250 })
		const result = await session.run()

		assert.equal(result.status, "error", `expected bounded failure, got ${JSON.stringify(result)}`)
		assert.match(result.error ?? "", /read-only stagnation/)
		assert.equal(
			result.iterations,
			DEFAULT_READ_ONLY_STALL_LIMIT,
			`stall fires exactly at iteration ${DEFAULT_READ_ONLY_STALL_LIMIT}`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyStallLimitNotTrippedByProductiveInterleave(): Promise<void> {
	// 40 read-only, one edit, 40 read-only: neither streak approaches the 75
	// stall limit, so the session must complete normally (a soft nudge per
	// streak is expected — it never hard-stops a productive session).
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-stall-reset-"))
	try {
		const client = new FakeLlmClient([
			// `grep | head` pipelines exit 0 even with no matches, so no tool
			// errors and no consecutive-mistake noise (unlike read_file on a
			// path that does not exist).
			...Array.from({ length: 40 }, (_, i) => () =>
				toolCall("execute_command", { command: `grep -rn 'pat${i}' . | head` })),
			() => toolCall("write_to_file", { path: "out.txt", content: "reset" }),
			...Array.from({ length: 40 }, (_, i) => () =>
				toolCall("execute_command", { command: `grep -rn 'pat${i}' . | head` })),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore then write", client, workspaceRoot: ws, maxIterations: 250 })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── isReadOnlyEquivalentShellCommand (unit-level) ───────────────────────────

async function testIsReadOnlyEquivalentShellCommandClassifiesCorrectly(): Promise<void> {
	const readOnly = [
		"grep -rn foo src",
		"ls -la src",
		"cat file.txt",
		"sed -n '1,10p' file.txt",
		"git log --oneline -5",
		"git diff HEAD~1",
		"git status --short",
		"docker compose ps",
		"docker ps -a",
		"find . -name '*.ts' | head -20",
		"cd src && grep -rn foo . && cat bar.ts",
		"grep -rn foo src 2>&1 | head",
		"git log --oneline -5 || true", // a bare `||` must not split into a stray non-allow-listed "true" segment
	]
	const mutating = [
		"sed -i 's/foo/bar/' file.txt",
		"git commit -m x",
		"git checkout -b new-branch",
		"docker compose up -d",
		"docker run --rm image",
		"rm -rf node_modules",
		"echo hi > out.txt",
		"grep foo src && rm bar.txt", // one mutating segment taints the whole compound command
		"npm install",
		"echo hi >> out.txt",
	]
	for (const cmd of readOnly) {
		assert.equal(isReadOnlyEquivalentShellCommand(cmd), true, `expected read-only: ${cmd}`)
	}
	for (const cmd of mutating) {
		assert.equal(isReadOnlyEquivalentShellCommand(cmd), false, `expected NOT read-only: ${cmd}`)
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

/**
	* (S1) A turn whose every call is read-only must NOT pay a per-iteration
	* shadow-git checkpoint: pure read/explore turns skip the snapshot entirely.
	* Fixture mirrors testCheckpointTriggeredByApplyDiffOnly (baseline + per-turn
	* snapshots); here the history must hold ONLY the baseline.
	*/
async function testReadOnlyTurnDoesNotTriggerCheckpoint(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-ckpt-readonly-"))
	const checkpointDir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ckpt-loop-"))
	try {
		await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf-8")
		const client = new FakeLlmClient([
			() => toolCall("read_file", { path: "a.txt" }),
			() => toolCall("attempt_completion", { result: "read only, done" }),
		])
		const session = await makeSession({
			task: "read a file",
			client,
			workspaceRoot: ws,
			checkpoints: true,
			checkpointDir,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		// Shadow-git history holds ONLY the baseline — the read-only turn was
		// skipped (the apply_diff checkpoint test above asserts a NON-read-only
		// turn still snapshots, so the two tests bracket the skip). list() is
		// [shadow-git initial commit, baseline snapshot] — no per-iteration
		// snapshot, which would make it 3.
		const tasksDir = path.join(checkpointDir, "tasks")
		const taskIds = await fs.readdir(tasksDir)
		assert.equal(taskIds.length, 1, `expected exactly one checkpoint task, got: ${taskIds.join(", ")}`)
		const svc = createCheckpointService({ taskId: taskIds[0], workspaceRoot: ws, checkpointDir })
		await svc.init()
		const entries = await svc.list()
		assert.equal(
			entries.length,
			2,
			`read-only turn must not add an iteration checkpoint (initial commit + baseline only), got ${entries.length}`,
		)
		assert.ok(!entries.some((e) => (e.message ?? "").includes("iteration")), "no per-iteration snapshot message")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

/**
 * (T2/T3 step 2) The non-vendored tool appends are gated on the session's
 * executor: a read-only reviewer/QA executor registers browser_action but NOT
 * describe_image, so its advertised catalog must exclude describe_image (a
 * schema it would only error on) while keeping browser_action; the default
 * executor advertises both.
 */
async function testToolCatalogGatedOnExecutorHandlers(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-toolgate-"))
	try {
		const roClient = new FakeLlmClient([() => toolCall("attempt_completion", { result: "done" })])
		const roSession = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "inspect",
			llmClient: roClient,
			maxIterations: 3,
			executor: createReadOnlyHeadlessExecutor(ws),
			checkpoints: false,
		})
		const roResult = await roSession.run()
		assert.equal(roResult.status, "success", `expected success, got ${JSON.stringify(roResult)}`)
		const roNames = roSession.state.tools.map((t) => (t.type === "function" ? t.function.name : t.type))
		assert.ok(roNames.includes("browser_action"), "read-only executor CAN browse — browser_action stays advertised")
		assert.ok(!roNames.includes("describe_image"), "read-only executor has no describe_image handler — schema not advertised")

		const fullClient = new FakeLlmClient([() => toolCall("attempt_completion", { result: "done" })])
		const fullSession = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "inspect",
			llmClient: fullClient,
			maxIterations: 3,
			checkpoints: false,
		})
		const fullResult = await fullSession.run()
		assert.equal(fullResult.status, "success", `expected success, got ${JSON.stringify(fullResult)}`)
		const fullNames = fullSession.state.tools.map((t) => (t.type === "function" ? t.function.name : t.type))
		assert.ok(fullNames.includes("browser_action"), "default executor advertises browser_action")
		assert.ok(fullNames.includes("describe_image"), "default executor advertises describe_image")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── truncateHistory — batch eviction (cache-stability regression) ───────────

function fakeMsg(i: number): ChatMessage {
	return { role: i % 2 === 0 ? "assistant" : "tool", content: `msg-${i}`, name: i % 2 === 0 ? undefined : "tool" }
}

/**
 * (T1) stripSupersededReasoning keeps reasoning only on the most-recent
 * assistant message; every earlier assistant message has it removed, and tool /
 * user messages are never touched.
 */
async function testStripSupersededReasoningKeepsOnlyMostRecent(): Promise<void> {
	const messages: ChatMessage[] = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "task" },
		{ role: "assistant", content: "first", reasoning: "reas-1" },
		{ role: "tool", tool_call_id: "c1", name: "read_file", content: "ok" },
		{ role: "assistant", content: "second", reasoning: "reas-2" },
	]
	stripSupersededReasoning(messages)
	assert.equal(messages[2].reasoning, undefined, "superseded assistant reasoning is stripped")
	assert.equal(messages[4].reasoning, "reas-2", "the most-recent assistant keeps its reasoning")
	assert.equal(messages[3].role, "tool", "tool messages are never touched")
	assert.equal(messages[1].role, "user", "user messages are never touched")
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

// Diff markers built via concatenation (not literal template text) so the
// harness's own diff parser never mistakes them for real SEARCH/REPLACE
// markers in this test file.
function diffBlock(search: string, replace: string): string {
	const searchMarker = "<<<<<<<" + " SEARCH"
	const replaceMarker = "======="
	const endMarker = ">>>>>>>" + " REPLACE"
	return `${searchMarker}\n-------\n${search}${replaceMarker}\n${replace}${endMarker}`
}

// ─── Same-file multi-edit batch diagnosis ────────────────────────────────────

async function testSameFileBatchFailureGetsDiagnosis(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-samefile-"))
	try {
		await fs.writeFile(path.join(ws, "notes.txt"), "alpha\nbeta\ngamma\n", "utf-8")
		// ONE turn with TWO apply_diff calls to the SAME file. The second's
		// SEARCH text matches the PRE-first-edit content, so it fails after
		// the first edit has already landed on disk.
		const client = new FakeLlmClient([
			() =>
				toolCallBatch([
					{ name: "apply_diff", args: { path: "notes.txt", diff: diffBlock("alpha\n", "ALPHA\n") } },
					{ name: "apply_diff", args: { path: "notes.txt", diff: diffBlock("alpha\nbeta\n", "alpha\nbeta\ninserted\n") } },
				]),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "edit notes.txt twice", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const applyDiffResults = session.state.messages.filter((m) => m.role === "tool" && m.name === "apply_diff")
		assert.equal(applyDiffResults.length, 2, "both apply_diff calls executed")
		const failed = applyDiffResults.find((m) => (m.content ?? "").includes("unable to apply diff"))
		assert.ok(failed, "the second call must fail (stale SEARCH text)")
		assert.match(
			failed?.content ?? "",
			/already edited by an earlier tool call in this same turn/,
			"the failure carries the same-file-in-batch diagnosis, not just the generic mismatch",
		)
		assert.match(
			failed?.content ?? "",
			/SEARCH\/REPLACE blocks in ONE apply_diff call/,
			"the diagnosis points at the fix (single-call batching)",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Create a temp workspace that is a real git repo with one committed tracked
 * file (`notes.txt`), so the commit-before-finishing guardrail has something
 * real to check. Returns the workspace path, or null when git is unavailable.
 */
async function mkGitWorkspace(): Promise<string | null> {
	const { execFileSync } = await import("node:child_process")
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" })
	} catch {
		return null
	}
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-git-"))
	execFileSync("git", ["init", "-q"], { cwd: ws })
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: ws })
	execFileSync("git", ["config", "user.name", "Test"], { cwd: ws })
	await fs.writeFile(path.join(ws, "notes.txt"), "hello\n", "utf-8")
	execFileSync("git", ["add", "notes.txt"], { cwd: ws })
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: ws })
	return ws
}

/**
 * (S3) A turn whose calls are all read-only runs them CONCURRENTLY; the tool
 * results must still be fed back in assistant.tool_calls order (the
 * assistant→tool adjacency contract), regardless of execution order.
 */
async function testParallelReadOnlyCallsFeedResultsInOrder(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-parread-"))
	try {
		await fs.writeFile(path.join(ws, "a.txt"), "AAA\n", "utf-8")
		await fs.writeFile(path.join(ws, "b.txt"), "BBB\n", "utf-8")
		await fs.writeFile(path.join(ws, "c.txt"), "CCC\n", "utf-8")
		const client = new FakeLlmClient([
			// ONE turn with THREE read_file calls (the parallelizable group).
			() =>
				toolCallBatch([
					{ name: "read_file", args: { path: "a.txt" } },
					{ name: "read_file", args: { path: "b.txt" } },
					{ name: "read_file", args: { path: "c.txt" } },
				]),
			() => toolCall("attempt_completion", { result: "read all three" }),
		])
		const session = await makeSession({ task: "read three files", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const toolMsgs = session.state.messages.filter((m) => m.role === "tool" && m.name === "read_file")
		assert.equal(toolMsgs.length, 3, "all three reads produced a tool message")
		const assistantMsg = session.state.messages.find((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) === 3)
		assert.ok(assistantMsg?.tool_calls, "found the assistant message with all three tool_calls")
		for (let i = 0; i < 3; i++) {
			assert.equal(
				toolMsgs[i].tool_call_id,
				assistantMsg.tool_calls![i].id,
				`tool message ${i} must reference tool_call ${i} (submission order preserved under concurrency)`,
			)
		}
		// Each read returned ITS OWN file's content (no cross-talk from the
		// concurrent executions).
		assert.match(toolMsgs[0].content ?? "", /AAA/)
		assert.match(toolMsgs[1].content ?? "", /BBB/)
		assert.match(toolMsgs[2].content ?? "", /CCC/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Commit-before-finishing guardrail ───────────────────────────────────────

async function testCompletionNudgedOnUncommittedChanges(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip commit-guard test (git not installed)")
		return
	}
	try {
		// Edit the tracked file, then try to finish WITHOUT committing.
		const client = new FakeLlmClient([
			() => toolCall("apply_diff", { path: "notes.txt", diff: diffBlock("hello\n", "hello world\n") }),
			() => toolCall("attempt_completion", { result: "done editing" }),
			() => toolCall("attempt_completion", { result: "done editing (retried)" }),
		])
		const session = await makeSession({ task: "edit notes.txt", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "done editing (retried)", "the retried completion is the one accepted")
		assert.equal(result.iterations, 3, "the deferred completion consumed one extra iteration")
		const completionMsgs = session.state.messages.filter((m) => m.role === "tool" && m.name === "attempt_completion")
		assert.equal(completionMsgs.length, 1, "only the deferred completion produced a tool message")
		assert.match(
			completionMsgs[0]?.content ?? "",
			/uncommitted tracked-file changes/,
			"the corrective nudge names the situation",
		)
		assert.match(completionMsgs[0]?.content ?? "", /git commit/, "it points at git commit")
		assert.match(completionMsgs[0]?.content ?? "", /attempt_completion again/, "it is a retry nudge, not a hard block")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCompletionAcceptedWhenClean(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip commit-guard test (git not installed)")
		return
	}
	try {
		// Nothing edited: the guard must not fire for a clean tree.
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "nothing to do" }),
		])
		const session = await makeSession({ task: "do nothing", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "nothing to do")
		assert.equal(result.iterations, 1, "no nudge, no extra iteration")
		const nudges = session.state.messages.filter((m) => (m.content ?? "").includes("uncommitted tracked-file changes"))
		assert.equal(nudges.length, 0, "a clean tree must not be nudged")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCompletionRefusedWhenBundledWithSiblings(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip bundled-completion test (git not installed)")
		return
	}
	try {
		// One turn: attempt_completion bundled alongside a real write. The
		// write must execute for real; the completion must be refused so the
		// model is forced to check the write's actual result before finishing.
		const client = new FakeLlmClient([
			() =>
				toolCallBatch([
					{ name: "write_to_file", args: { path: "hello.txt", content: "hello" } },
					{ name: "attempt_completion", args: { result: "done (premature)" } },
				]),
			() => toolCall("attempt_completion", { result: "done for real" }),
		])
		const session = await makeSession({ task: "write then finish", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "done for real", "the premature bundled completion must not be accepted")
		assert.equal(
			await fs.readFile(path.join(ws, "hello.txt"), "utf-8"),
			"hello",
			"the sibling write must execute for real, not be discarded",
		)
		const completionMsgs = session.state.messages.filter((m) => m.role === "tool" && m.name === "attempt_completion")
		assert.equal(completionMsgs.length, 1, "only the refused bundled completion produced a tool message")
		assert.match(
			completionMsgs[0]?.content ?? "",
			/alongside other tool calls/,
			"the refusal explains why it was not accepted",
		)
		assert.match(
			completionMsgs[0]?.content ?? "",
			/Re-issue attempt_completion ALONE/,
			"the refusal tells the model how to retry correctly",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCompletionAcceptedAfterCommit(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip commit-guard test (git not installed)")
		return
	}
	try {
		// Edit, commit via execute_command, then finish: no nudge.
		const client = new FakeLlmClient([
			() => toolCall("apply_diff", { path: "notes.txt", diff: diffBlock("hello\n", "hello world\n") }),
			() => toolCall("execute_command", { command: "git add notes.txt && git commit -q -m \"edit notes\"" }),
			() => toolCall("attempt_completion", { result: "committed and done" }),
		])
		const session = await makeSession({ task: "edit and commit", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "committed and done")
		const nudges = session.state.messages.filter((m) => (m.content ?? "").includes("uncommitted tracked-file changes"))
		assert.equal(nudges.length, 0, "committing before finishing means no nudge")
		// The commit actually landed.
		const { execFileSync } = await import("node:child_process")
		const log = execFileSync("git", ["log", "--oneline"], { cwd: ws, encoding: "utf-8" })
		assert.match(log, /edit notes/, "the model's commit landed in the repo")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNoNudgeInReadOnlyMode(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip commit-guard test (git not installed)")
		return
	}
	try {
		// Uncommitted tracked change present, but the mode is READ-ONLY (ask
		// has no edit group) — the guard must be scoped out entirely.
		await fs.writeFile(path.join(ws, "notes.txt"), "changed without a commit\n", "utf-8")
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "investigation only" }),
		])
		const session = await makeSession({ task: "investigate", client, workspaceRoot: ws, mode: "ask" })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.iterations, 1, "read-only mode accepts completion immediately")
		const nudges = session.state.messages.filter((m) => (m.content ?? "").includes("uncommitted tracked-file changes"))
		assert.equal(nudges.length, 0, "read-only modes never get the commit nudge")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDifferentFileBatchFailureGetsNoDiagnosis(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-diffile-"))
	try {
		await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf-8")
		await fs.writeFile(path.join(ws, "b.txt"), "hello\n", "utf-8")
		// ONE turn with TWO apply_diff calls to DIFFERENT files. The second
		// fails for an unrelated reason (no match) — it must NOT get the
		// same-file-in-batch diagnosis.
		const client = new FakeLlmClient([
			() =>
				toolCallBatch([
					{ name: "apply_diff", args: { path: "a.txt", diff: diffBlock("hello\n", "hi\n") } },
					{ name: "apply_diff", args: { path: "b.txt", diff: diffBlock("goodbye\n", "bye\n") } },
				]),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "edit two files", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const applyDiffResults = session.state.messages.filter((m) => m.role === "tool" && m.name === "apply_diff")
		const failed = applyDiffResults.find((m) => (m.content ?? "").includes("unable to apply diff"))
		assert.ok(failed, "the second call fails (no match in b.txt)")
		assert.doesNotMatch(
			failed?.content ?? "",
			/already edited by an earlier tool call/,
			"different-file failures must NOT get the same-file diagnosis",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Part E: live pricing feeds the session's BudgetTracker ──────────────────

async function testBudgetUsesLivePricingWhenAvailable(): Promise<void> {
	// A live price that DIFFERS from the hardcoded table must win: the
	// session's cost accounting reflects the live value, not the default.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-liveprice-"))
	try {
		const client = new UsageClient([() => toolCall("attempt_completion", { result: "done" })], {
			price: { input: 9, output: 9 },
		})
		const session = await makeSession({ task: "finish", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success")
		// 100 prompt + 50 completion tokens at $9/1M = (900 + 450)/1e6.
		const expected = (100 * 9 + 50 * 9) / 1_000_000
		assert.ok(
			Math.abs((result.budgetUsage?.costUsd ?? 0) - expected) < 1e-9,
			`expected live-priced cost $${expected}, got $${result.budgetUsage?.costUsd}`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testBudgetFallsBackToHardcodedTableWithoutLivePricing(): Promise<void> {
	// A client with NO live-pricing support (fetchModelInfo absent/undefined)
	// must behave EXACTLY as before live pricing existed: "fake-model" isn't
	// in DEFAULT_PRICING_TABLE, so the conservative FALLBACK_MODEL_PRICE
	// ($2/$8 per 1M) applies — no crash, no $0, no live value.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-fallbackprice-"))
	try {
		const client = new UsageClient([() => toolCall("attempt_completion", { result: "done" })], undefined)
		const session = await makeSession({ task: "finish", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success")
		const expected = (100 * 2 + 50 * 8) / 1_000_000
		assert.ok(
			Math.abs((result.budgetUsage?.costUsd ?? 0) - expected) < 1e-9,
			`expected fallback-priced cost $${expected}, got $${result.budgetUsage?.costUsd}`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["reasoning effort: configured value flows onto every request", testReasoningEffortFlowsIntoRequests],
	["reasoning effort: unset config falls back to the env var", testReasoningEffortEnvFallbackWhenNotConfigured],
	["reasoning effort: absent by default (endpoint default applies)", testReasoningEffortAbsentByDefault],
	["scenario 1: write_to_file + attempt_completion -> success, file written", testScenario1WriteThenCompletion],
	["final report: attempt_completion result persisted verbatim to .headlesscode/reports/<sessionId>.md", testFinalReportPersistedWithFullText],
	["scenario 2: execute_command + text answer -> success with text result", testScenario2CommandThenTextAnswer],
	[
		"requireExplicitCompletion: text-only reply is nudged, not accepted, until attempt_completion",
		testRequireExplicitCompletionRefusesTextOnlyReply,
	],
	[
		"requireExplicitCompletion: repeated text-only replies -> bounded failure, never a fabricated success",
		testRequireExplicitCompletionBoundedFailureWhenNeverCompletes,
	],
	[
		"requireExplicitCompletion: a tool call written as prose is recovered and actually executed",
		testRecoversTextEmbeddedToolCallForRealTool,
	],
	[
		"requireExplicitCompletion: an embedded call naming an unknown tool is never executed",
		testDoesNotExecuteEmbeddedCallForUnknownToolName,
	],
	[
		"requireExplicitCompletion: a narrated 'Called tool X' claim is recovered and actually executed",
		testRecoversNarratedToolCall,
	],
	["scenario 3: erroring tool x3 -> bounded failure", testScenario3ErroringToolBoundedFailure],
	["scenario 4: malformed JSON args -> parser fallback exercised", testScenario4MalformedJsonArgs],
	["path-traversal guard rejects escaping paths", testPathTraversalGuard],
	["max iterations -> bounded failure", testMaxIterationsBound],
	["main LLM call retries once on a transient provider error then succeeds", testMainLlmCallRetriesOnceOnTransientProviderError],
	["main LLM call fails after the retry also fails (no unbounded retry loop)", testMainLlmCallFailsAfterRetryAlsoFails],
	["main LLM call does not retry a deterministic 401", testMainLlmCallDoesNotRetryDeterministicError],
	["max iterations -> handoff summary written for the next continuation", testIterationCapHandoffSummary],
	["max iterations -> handoff write is non-fatal when its own condense call fails", testIterationCapHandoffSummaryNonFatalWhenCondenseCallFails],
	["max iterations -> handoff write retries once after a transient condense failure", testIterationCapHandoffSummaryRetriesOnceAfterCondenseFailure],
	["blind tree-walking: nudge after N consecutive read-only iterations (indexed ws)", testReadOnlyNudgeTriggered],
	["blind tree-walking: a productive tool call resets the streak", testReadOnlyNudgeResetsOnProductiveCall],
	["blind tree-walking: nudge fires on unindexed workspaces too, leading with run_tests", testReadOnlyNudgeInjectedWhenUnindexed],
	["blind tree-walking: grep/ls/sed/git/docker-ps execute_command streak trips the nudge same as read_file", testReadOnlyNudgeTriggeredByGrepStyleExecuteCommand],
	["blind tree-walking: one mutating execute_command in the streak suppresses the nudge", testReadOnlyNudgeNotTrippedByMutatingExecuteCommand],
	["read-only stagnation: a long pure-read streak ends in bounded failure before the iteration cap", testReadOnlyStallLimitTerminates],
	["read-only stagnation: an edit in the middle resets the streak (no false stall)", testReadOnlyStallLimitNotTrippedByProductiveInterleave],
	["isReadOnlyEquivalentShellCommand: classifies read-only vs. mutating shell commands", testIsReadOnlyEquivalentShellCommandClassifiesCorrectly],
	["live snapshot: created + updated in place during a running session's iterations", testLiveSnapshotCreatedAndUpdatedDuringIterations],
	["live snapshot: removed on successful completion", testLiveSnapshotRemovedOnSuccess],
	["live snapshot: removed when the session ends with an error", testLiveSnapshotRemovedOnError],
	["live snapshot: removed when the session is aborted by budget limits", testLiveSnapshotRemovedOnBudgetExceeded],
	["execute_command: a timed-out call does NOT count toward the consecutive-mistake limit", testTimeoutDoesNotCountAsMistake],
	["execute_command: session end reaps backgrounded children (no orphans left behind)", testSessionEndReapsBackgroundedChildren],
	["checkpoints: apply_diff-only iteration still triggers a checkpoint", testCheckpointTriggeredByApplyDiffOnly],
	["checkpoints: (S1) an all-read-only turn does NOT trigger a checkpoint", testReadOnlyTurnDoesNotTriggerCheckpoint],
	["same-file batch: a second same-file edit failure gets the stale-SEARCH diagnosis", testSameFileBatchFailureGetsDiagnosis],
	["parallel reads: (S3) three read_file calls feed tool results back in tool_calls order", testParallelReadOnlyCallsFeedResultsInOrder],
	["same-file batch: a failure on a DIFFERENT file gets no diagnosis", testDifferentFileBatchFailureGetsNoDiagnosis],
	["commit guard: attempt_completion with uncommitted tracked changes gets one nudge, then is accepted", testCompletionNudgedOnUncommittedChanges],
	["commit guard: a clean tree is never nudged", testCompletionAcceptedWhenClean],
	["attempt_completion bundled with other tool calls is refused; the siblings execute for real", testCompletionRefusedWhenBundledWithSiblings],
	["commit guard: committing before finishing means no nudge", testCompletionAcceptedAfterCommit],
	["commit guard: read-only modes never get the nudge", testNoNudgeInReadOnlyMode],
	["stripSupersededReasoning: (T1) keeps only the most-recent assistant reasoning", testStripSupersededReasoningKeepsOnlyMostRecent],
	["tool catalog: (T2/T3) non-vendored appends gated on the session executor's handlers", testToolCatalogGatedOnExecutorHandlers],
	["truncateHistory: no-op below the window", testTruncateHistoryNoOpBelowWindow],
	["truncateHistory: evicts in TRUNCATION_BATCH_SIZE-sized batches", testTruncateHistoryEvictsInBatches],
	["truncateHistory: never splits an assistant tool_calls / tool response group", testTruncateHistoryNeverSplitsToolCallGroup],
	["truncateHistory: prefix stays stable across a batch (cache-eligible)", testTruncateHistoryStablePrefixBetweenBatches],
	["Part E: live pricing feeds the session's BudgetTracker", testBudgetUsesLivePricingWhenAvailable],
	["Part E: no live pricing → hardcoded table fallback, unchanged behavior", testBudgetFallsBackToHardcodedTableWithoutLivePricing],
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
