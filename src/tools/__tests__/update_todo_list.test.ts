/**
 * Unit tests for the update_todo_list tool activation:
 *
 *   - the handler (src/tools/executor.ts): accepts a valid checklist, rejects
 *     malformed input, and replaces session todo state across multiple calls
 *     (mark done / add items — the vendored tool's documented behavior);
 *   - the `todo_updated` event (src/engine/events.ts + the loop's onTodoEvent
 *     wiring): emitted with the right shape on every call, truncated when the
 *     checklist exceeds EVENT_TRUNCATE_CHARS;
 *   - registration: update_todo_list is genuinely advertised to the model in
 *     code mode (selectToolsForMode) with the vendored schema + description,
 *     and is NOT leaked to the read-only reviewer/QA executors as a stub.
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` -> `tsx src/tools/__tests__/update_todo_list.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	createHeadlessExecutor,
	createReadOnlyHeadlessExecutor,
	parseTodoList,
	type TodoListSnapshot,
} from "../executor.js"
import { HeadlessSession } from "../../engine/loop.js"
import { summarizeToolArg } from "../../engine/loop.js"
import { selectToolsForMode } from "../../engine/prompt.js"
import { EventFeed, eventsDir, eventsFilePath, readEventsFile } from "../../engine/events.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../../engine/types.js"
import { reviewTools } from "../../orchestrator/reviewer.js"
import { qaTools } from "../../qa/qa.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Minimal scripted LLM client (no streaming) for the end-to-end event test. */
class FakeLlmClient implements LlmClient {
	readonly requests: LlmRequest[] = []
	private readonly script: Array<() => ChatMessage>
	constructor(script: Array<() => ChatMessage>) {
		this.script = script
	}
	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (model kept calling)")
		}
		return { message: step() }
	}
}

function toolCall(name: string, args: unknown): ChatMessage {
	const call: ChatToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }
	return { role: "assistant", content: null, tool_calls: [call] }
}

function textReply(content: string): ChatMessage {
	return { role: "assistant", content }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/**
 * The whole point of activation: code mode's advertised tool set must include
 * update_todo_list WITH the vendored schema and description (strict, required
 * `todos`, `additionalProperties: false`) — not a re-derived copy. This is
 * what guarantees the model actually sees the tool's own "when to use /
 * when NOT to use" guidance.
 */
async function testCodeModeAdvertisesUpdateTodoListWithVendoredSchema(): Promise<void> {
	const tools = selectToolsForMode("code", [])
	const tool = tools.find((t) => t.type === "function" && t.function.name === "update_todo_list")
	assert.ok(tool, "update_todo_list must be advertised in code mode's tool set")
	assert.ok(tool.type === "function" && tool.function.strict === true, "schema must keep the vendored strict: true")
	const fn = tool.type === "function" ? tool.function : null
	assert.ok(fn && fn.parameters && typeof fn.parameters === "object")
	const parameters = fn.parameters as { required?: string[]; properties?: Record<string, unknown>; additionalProperties?: boolean }
	assert.deepEqual(parameters.required, ["todos"], "todos must be the only required property")
	const todosProp = parameters.properties?.todos as { type?: string } | undefined
	assert.equal(todosProp?.type, "string")
	assert.equal(parameters.additionalProperties, false)
	assert.ok(
		fn?.description?.includes("Replace the entire TODO list"),
		"the vendored description (incl. its when-to-use guidance) must reach the model verbatim",
	)
}

/** The handler accepts a valid checklist, echoes it back, and stores session state. */
async function testHandlerAcceptsValidChecklistAndStoresState(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-todo-valid-")
	try {
		const executor = createHeadlessExecutor(ws)
		const todos = "- [x] Analyze requirements\n- [-] Implement core logic\n- [ ] Write tests\n- [ ] Update docs"
		const result = await executor.execute("update_todo_list", { todos })
		assert.equal(result.isError, false, `expected success, got: ${result.content}`)
		assert.ok(result.content.includes("1 completed"), `expected counts in echo, got: ${result.content}`)
		assert.ok(result.content.includes("1 in progress"), `expected counts in echo, got: ${result.content}`)
		assert.ok(result.content.includes("2 pending"), `expected counts in echo, got: ${result.content}`)
		assert.ok(result.content.includes("- [x] Analyze requirements"), "echo must include the checklist body")

		const state = executor.getTodoList()
		assert.ok(state, "session todo state must be stored")
		assert.deepEqual(state, {
			todos,
			done: 1,
			inProgress: 1,
			pending: 2,
		} satisfies TodoListSnapshot)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** Missing `todos` (required by the vendored schema) is rejected. */
async function testHandlerRejectsMissingTodos(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-todo-missing-")
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("update_todo_list", {})
		assert.equal(result.isError, true, "missing todos must be an error")
		assert.ok(result.content.includes("todos"), `error must name the missing arg, got: ${result.content}`)
		assert.equal(executor.getTodoList(), undefined, "no state change on a rejected call")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** A non-string `todos` (schema violation) is rejected. */
async function testHandlerRejectsNonStringTodos(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-todo-nonstring-")
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("update_todo_list", { todos: 42 })
		assert.equal(result.isError, true, "non-string todos must be an error")
		assert.ok(result.content.includes("todos"), `error must name the bad arg, got: ${result.content}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * A malformed checklist (prose with no checklist items) is handled sensibly:
 * accepted (not a crash), stored as-is, reported as 0/0/0 — so the model gets
 * clear feedback that its "list" has no actionable items.
 */
async function testHandlerHandlesMalformedChecklistSensibly(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-todo-malformed-")
	try {
		const executor = createHeadlessExecutor(ws)
		const prose = "This is not a checklist\nJust do the thing"
		const result = await executor.execute("update_todo_list", { todos: prose })
		assert.equal(result.isError, false, "prose must be accepted, not crash the tool")
		assert.ok(result.content.includes("0 completed"), `expected 0/0/0 counts, got: ${result.content}`)
		assert.ok(result.content.includes("0 in progress"))
		assert.ok(result.content.includes("0 pending"))
		const state = executor.getTodoList()
		assert.ok(state && state.todos === prose, "the submitted text is preserved in state")
		assert.deepEqual(
			{ done: state?.done, inProgress: state?.inProgress, pending: state?.pending },
			{ done: 0, inProgress: 0, pending: 0 },
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Multi-call behavior per the vendored tool contract: each call REPLACES the
 * whole list (mark items done, add new items in the same update), and the
 * onTodoEvent hook fires with the new state on every call.
 */
async function testStateUpdatesAcrossMultipleCalls(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-todo-multi-")
	try {
		const events: Array<{ todos: string; done: number; inProgress: number; pending: number }> = []
		const executor = createHeadlessExecutor(ws, { onTodoEvent: (fields) => events.push(fields) })

		const first = "- [x] Analyze requirements\n- [-] Implement core logic\n- [ ] Write tests\n- [ ] Update docs"
		const r1 = await executor.execute("update_todo_list", { todos: first })
		assert.equal(r1.isError, false)

		// Second call: implementation done, tests now in progress, new item added.
		const second =
			"- [x] Analyze requirements\n- [x] Implement core logic\n- [-] Write tests\n- [ ] Update docs\n- [ ] Add performance benchmarks"
		const r2 = await executor.execute("update_todo_list", { todos: second })
		assert.equal(r2.isError, false)

		const state = executor.getTodoList()
		assert.ok(state, "state must be present after two calls")
		assert.equal(state.todos, second, "the full list is REPLACED, not merged")
		assert.equal(state.done, 2, "analyze + implement now completed")
		assert.equal(state.inProgress, 1, "tests in progress")
		assert.equal(state.pending, 2, "docs + benchmarks pending")

		assert.equal(events.length, 2, "onTodoEvent fires on every call")
		assert.deepEqual(events[0], { todos: first, done: 1, inProgress: 1, pending: 2 })
		assert.deepEqual(events[1], { todos: second, done: 2, inProgress: 1, pending: 2 })
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * End-to-end: a real HeadlessSession that calls update_todo_list mid-flight
 * must write a `todo_updated` event with the right shape, ordered between the
 * tool_call and tool_result records for that iteration.
 */
async function testSessionEmitsTodoUpdatedEventWithRightShape(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-todo-event-")
	try {
		const todos = "- [x] Step one\n- [-] Step two\n- [ ] Step three"
		const client = new FakeLlmClient([
			() => toolCall("update_todo_list", { todos }),
			() => toolCall("attempt_completion", { result: "Done" }),
		])
		const session = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "do a multi-step thing",
			llmClient: client,
			maxIterations: 5,
			checkpoints: false,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const evDir = eventsDir(ws)
		const files = await fs.readdir(evDir)
		assert.equal(files.length, 1, `expected exactly one events file, got: ${files.join(", ")}`)
		const events = await readEventsFile(eventsFilePath(ws, files[0]!.replace(/\.jsonl$/, "")))

		const updated = events.filter((e) => e.type === "todo_updated")
		assert.equal(updated.length, 1, "exactly one todo_updated event for one tool call")
		const ev = updated[0]!
		assert.equal(typeof ev.ts, "string")
		assert.equal(typeof ev.sessionId, "string")
		assert.equal(ev.todos, todos, "the full normalized checklist is on the event")
		assert.equal(ev.done, 1)
		assert.equal(ev.inProgress, 1)
		assert.equal(ev.pending, 1)
		assert.equal(ev.todosTruncated, undefined, "no truncation flag for a short checklist")

		// Ordering: tool_call → todo_updated → tool_result for iteration 1.
		const types = events.map((e) => e.type)
		const toolCallIdx = types.findIndex((t) => t === "tool_call")
		const updatedIdx = types.indexOf("todo_updated")
		const toolResultIdx = types.findIndex((t) => t === "tool_result")
		assert.ok(toolCallIdx !== -1 && updatedIdx !== -1 && toolResultIdx !== -1)
		assert.ok(
			toolCallIdx < updatedIdx && updatedIdx < toolResultIdx,
			`todo_updated must sit between tool_call and tool_result, got order: ${types.join(" → ")}`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** Long checklists are truncated on the event feed with a flag, like every large field. */
async function testTodoUpdatedEventTruncatesLongChecklist(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-todo-truncate-")
	try {
		const longTodos = Array.from({ length: 60 }, (_, i) => `- [ ] task number ${i} with padding words`).join("\n")
		assert.ok(longTodos.length > 500, "test fixture must exceed the 500-char cap")

		const sessionId = "trunc-session"
		const feed = new EventFeed(ws, sessionId, () => {})
		await feed.todoUpdated({ todos: longTodos, done: 0, inProgress: 0, pending: 60 })

		const events = await readEventsFile(eventsFilePath(ws, sessionId))
		assert.equal(events.length, 1)
		const ev = events[0]!
		assert.equal(ev.type, "todo_updated")
		assert.equal(ev.todosTruncated, true)
		assert.equal(typeof ev.todos, "string")
		assert.equal((ev.todos as string).length, 500, "checklist clipped to EVENT_TRUNCATE_CHARS")
		assert.equal(ev.pending, 60, "counts are NOT truncated — they're cheap and precise")
		assert.equal(ev.done, 0)
		assert.equal(ev.inProgress, 0)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * The read-only executors must NOT gain the tool, and the reviewer/QA tool
 * lists must NOT advertise it — otherwise a stub leaks into those models'
 * tool sets (they use their own allowlists, so EXECUTABLE_TOOL_NAMES alone
 * must not change their surface).
 */
async function testReadOnlyExecutorsAndToolListsDoNotGainUpdateTodoList(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-todo-readonly-")
	try {
		const executor = createReadOnlyHeadlessExecutor(ws)
		const result = await executor.execute("update_todo_list", { todos: "- [ ] something" })
		assert.equal(result.isError, true, "read-only executor must not implement update_todo_list")
		assert.ok(result.content.includes("not implemented"), `expected stub error, got: ${result.content}`)

		assert.equal(
			reviewTools().some((t) => t.type === "function" && t.function.name === "update_todo_list"),
			false,
			"reviewer tool list must not advertise update_todo_list",
		)
		assert.equal(
			qaTools().some((t) => t.type === "function" && t.function.name === "update_todo_list"),
			false,
			"QA tool list must not advertise update_todo_list",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** parseTodoList is tolerant of marker styles and excludes non-item lines from counts. */
async function testParseTodoListTolerance(): Promise<void> {
	const parsed = parseTodoList("- [x] done\n* [X] also done\n+ [-] mid\n[ ] plain\nnot an item\n  - [ ] indented")
	assert.equal(parsed.items.length, 5)
	assert.equal(parsed.items.filter((i) => i.status === "completed").length, 2)
	assert.equal(parsed.items.filter((i) => i.status === "in_progress").length, 1)
	assert.equal(parsed.items.filter((i) => i.status === "pending").length, 2)
	assert.equal(parsed.normalized.split("\n").length, 6, "non-item lines are preserved in the normalized list")
}

/** The tool_call event's args summary shows a clipped checklist preview. */
async function testSummarizeToolArgForUpdateTodoList(): Promise<void> {
	const short = "- [x] a\n- [ ] b"
	assert.equal(summarizeToolArg("update_todo_list", { todos: short }), short)
	const long = "- [ ] " + "x".repeat(300)
	const summary = summarizeToolArg("update_todo_list", { todos: long })
	assert.equal(summary, long.slice(0, 200), "long checklists are clipped to 200 chars for the args preview")
	assert.equal(summarizeToolArg("update_todo_list", {}), undefined, "no todos arg → no preview")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["code mode advertises update_todo_list with the vendored schema", testCodeModeAdvertisesUpdateTodoListWithVendoredSchema],
	["handler accepts a valid checklist and stores session state", testHandlerAcceptsValidChecklistAndStoresState],
	["handler rejects missing todos", testHandlerRejectsMissingTodos],
	["handler rejects non-string todos", testHandlerRejectsNonStringTodos],
	["handler handles a malformed checklist sensibly", testHandlerHandlesMalformedChecklistSensibly],
	["state updates across multiple calls (mark done, add items, full replace)", testStateUpdatesAcrossMultipleCalls],
	["session emits todo_updated event with the right shape", testSessionEmitsTodoUpdatedEventWithRightShape],
	["todo_updated event truncates long checklists", testTodoUpdatedEventTruncatesLongChecklist],
	["read-only executors and tool lists do not gain update_todo_list", testReadOnlyExecutorsAndToolListsDoNotGainUpdateTodoList],
	["parseTodoList tolerates marker styles", testParseTodoListTolerance],
	["summarizeToolArg previews update_todo_list args", testSummarizeToolArgForUpdateTodoList],
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
	console.log(`\nAll ${tests.length} update_todo_list tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
