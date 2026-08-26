/**
 * Recursive task decomposition (`new_task`) tests.
 *
 * The headless-native design: `new_task` is implemented as a SYNCHRONOUS,
 * in-process nested `HeadlessSession` call — the parent BLOCKS on the child
 * like a function call, gets the child's outcome back as this tool call's
 * result, and its own loop continues on the next iteration. No new process,
 * no worktree, no parallelism (see plans/recursive-orchestrator-mode.md).
 *
 * These tests script ONE shared fake LlmClient for parent + child turns (the
 * same DI pattern as loop.test.ts — the child session inherits the parent's
 * llmClient, so the script is consumed in execution order across the nested
 * call), and assert the containment guarantees that are the actual point of
 * the feature: shared budget, bounded child iterations, depth cap, honest
 * failure surfacing, and one shared checkpoint history.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../loop.js"
import { eventsDir, readEventsFile, type EventRecord } from "../events.js"
import { createCheckpointService } from "../../checkpoints/service.js"
import type { SessionBudget } from "../../budget/budget.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"

// ─── Scripted fake LLM client (parent + child share it) ──────────────────────

interface ScriptStep {
	message: ChatMessage
	/** Optional token usage for THIS call — budget tests need real usage. */
	usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number }
}

/**
 * Like loop.test.ts's FakeLlmClient but each script step can carry token
 * usage. Budget sharing can't be proven with a usage-less client — a child
 * that spends nothing would be indistinguishable from a non-shared tracker.
 */
class ScriptedLlmClient implements LlmClient {
	requests: LlmRequest[] = []

	constructor(
		private readonly script: ScriptStep[],
		private readonly onRequest?: (req: LlmRequest) => void,
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		this.onRequest?.(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("ScriptedLlmClient: script exhausted (model kept calling)")
		}
		return step.usage ? { message: step.message, usage: step.usage } : { message: step.message }
	}
}

function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2)}`): ChatMessage {
	const call: ChatToolCall = { id, type: "function", function: { name, arguments: JSON.stringify(args) } }
	return { role: "assistant", content: null, tool_calls: [call] }
}

/** One assistant message with MULTIPLE tool calls in the same turn. */
function multiToolCall(calls: Array<{ name: string; args: unknown }>): ChatMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: calls.map((c, i) => {
			const call: ChatToolCall = {
				id: `call_multi_${Math.random().toString(36).slice(2)}_${i}`,
				type: "function",
				function: { name: c.name, arguments: JSON.stringify(c.args) },
			}
			return call
		}),
	}
}

async function makeSession(options: {
	task: string
	client: LlmClient
	workspaceRoot: string
	maxIterations?: number
	consecutiveErrorLimit?: number
	budget?: SessionBudget
	/** Checkpoints on/off + shadow-git storage dir (default off — hermetic). */
	checkpoints?: boolean
	checkpointDir?: string
	maxRecursionDepth?: number
}) {
	const session = new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: options.maxIterations ?? 10,
		consecutiveErrorLimit: options.consecutiveErrorLimit ?? 3,
		windowSize: 40,
		budget: options.budget ?? null,
		maxRecursionDepth: options.maxRecursionDepth,
		checkpoints: options.checkpoints ?? false,
		checkpointDir: options.checkpointDir,
	})
	return session
}

/** The tool message in `messages` that replies to the given call id. */
function findToolResult(messages: ChatMessage[], callId: string): ChatMessage | undefined {
	return messages.find((m) => m.role === "tool" && m.tool_call_id === callId)
}

/** The id of the parent's new_task call (from its assistant message). */
function findNewTaskCallId(messages: ChatMessage[]): string {
	const assistant = messages.find(
		(m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.function.name === "new_task"),
	)
	assert.ok(assistant, "expected an assistant message with a new_task call")
	const call = assistant.tool_calls!.find((c) => c.function.name === "new_task")
	assert.ok(call, "expected a new_task tool call")
	return call.id
}

/** All per-session event feeds for a workspace, keyed by sessionId. */
async function readAllEventFeeds(ws: string): Promise<Map<string, EventRecord[]>> {
	const dir = eventsDir(ws)
	const files = await fs.readdir(dir)
	const map = new Map<string, EventRecord[]>()
	for (const file of files) {
		if (!file.endsWith(".jsonl")) continue
		const records = await readEventsFile(path.join(dir, file))
		const sessionId = records[0]?.sessionId ?? file.replace(/\.jsonl$/, "")
		map.set(sessionId, records)
	}
	return map
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testChildCompletesAndResultFlowsBack(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-newtask-ok-"))
	try {
		// One shared script consumed in execution order: the parent's first
		// turn delegates, the child writes a file and completes, then the
		// parent completes.
		const client = new ScriptedLlmClient([
			{ message: toolCall("new_task", { mode: "code", message: "write child.txt", todos: null }) },
			{ message: toolCall("write_to_file", { path: "child.txt", content: "written by child" }) },
			{ message: toolCall("attempt_completion", { result: "Child done: wrote child.txt" }) },
			{ message: toolCall("attempt_completion", { result: "Parent done after delegation" }) },
		])
		const session = await makeSession({ task: "delegate a sub-step", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Parent done after delegation")
		// The child ran in the SAME workspace and its edit is on disk.
		assert.equal(await fs.readFile(path.join(ws, "child.txt"), "utf-8"), "written by child")
		// The child's final answer came back as the new_task tool's result.
		const callId = findNewTaskCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "new_task tool result should be in the parent's history")
		assert.match(toolMsg.content ?? "", /Child done: wrote child\.txt/)
		assert.doesNotMatch(toolMsg.content ?? "", /^\[Error\]/, "a successful child is NOT an error result")

		// Event feed integration: parent + child each get their OWN .jsonl
		// feed (no collision), and the child's records carry the lineage
		// fields for the dashboard to render nesting later.
		const feeds = await readAllEventFeeds(ws)
		assert.equal(feeds.size, 2, `expected 2 session feeds (parent+child), got ${[...feeds.keys()].join(", ")}`)
		const childId = [...feeds.keys()].find((id) => feeds.get(id)!.some((r) => r.recursionDepth === 1))
		const parentId = [...feeds.keys()].find((id) => id !== childId)
		assert.ok(parentId && childId, "expected one root and one child session feed")
		const childRecords = feeds.get(childId)!
		assert.ok(childRecords.length > 0)
		for (const record of childRecords) {
			assert.equal(record.parentSessionId, parentId, "every child event stamps its parent session id")
			assert.equal(record.recursionDepth, 1, "every child event stamps its recursion depth")
		}
		const parentRecords = feeds.get(parentId)!
		assert.ok(parentRecords.length > 0)
		for (const record of parentRecords) {
			assert.equal(record.parentSessionId, undefined, "root events carry no parentSessionId")
			assert.equal(record.recursionDepth, undefined, "root events carry no recursionDepth")
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRecursionDepthCapIsRecoverableToolError(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-newtask-depth-"))
	try {
		// root (depth 0) → child (depth 1) → grandchild (depth 2). The
		// grandchild is AT the default cap (2), so its own new_task call is
		// refused — as a normal tool error, never a crash, and the session
		// continues normally afterward.
		const client = new ScriptedLlmClient([
			{ message: toolCall("new_task", { mode: "code", message: "delegate a", todos: null }) },
			{ message: toolCall("new_task", { mode: "code", message: "delegate b", todos: null }) },
			{ message: toolCall("new_task", { mode: "code", message: "delegate c", todos: null }) },
			{ message: toolCall("attempt_completion", { result: "grandchild done despite refusal" }) },
			{ message: toolCall("attempt_completion", { result: "child got grandchild's result" }) },
			{ message: toolCall("attempt_completion", { result: "root done" }) },
		])
		const session = await makeSession({ task: "delegate recursively", client, workspaceRoot: ws })
		const result = await session.run()

		// The refusal is a recoverable mistake, not fatal: the whole tree
		// still completes.
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "root done")

		// The refusal surfaced as a real new_task tool error one level down:
		// each level has its own event feed, and the refused call was
		// recorded as an error tool_result.
		const feeds = await readAllEventFeeds(ws)
		assert.equal(feeds.size, 3, `expected 3 session feeds (root+child+grandchild), got ${feeds.size}`)
		const refusals = [...feeds.values()]
			.flat()
			.filter((r) => r.type === "tool_result" && r.tool === "new_task" && r.isError === true)
		assert.ok(refusals.length >= 1, "expected the refused new_task to be recorded as an error tool result")
		assert.match(String(refusals[0]?.result ?? ""), /max recursion depth reached/)
		// The grandchild's feed is at depth 2 with the child as its parent.
		const grandchildRecords = [...feeds.values()].find((records) =>
			records.some((r) => r.recursionDepth === 2),
		)
		assert.ok(grandchildRecords, "expected a depth-2 (grandchild) session feed")
		assert.ok(grandchildRecords.every((r) => r.recursionDepth === 2), "all grandchild events at depth 2")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testBudgetSharedBetweenParentAndChild(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-newtask-budget-"))
	try {
		// The PARENT's own LLM call (turn 1) reports NO usage; only the CHILD's
		// single call reports tokens. With a shared tracker, the child's spend
		// must trip the ONE cap — the parent aborts even though it spent $0
		// itself. A non-shared (per-session) budget could never catch this.
		const client = new ScriptedLlmClient([
			{ message: toolCall("new_task", { mode: "code", message: "spend", todos: null }) },
			{
				message: toolCall("attempt_completion", { result: "child spent" }),
				// 100 prompt @ $2/MTok + 50 completion @ $8/MTok = $0.0006
				// ("fake-model" is not in the pricing table → FALLBACK_MODEL_PRICE).
				usage: { promptTokens: 100, completionTokens: 50 },
			},
		])
		const session = await makeSession({
			task: "delegate spend",
			client,
			workspaceRoot: ws,
			budget: { maxCostUsd: 0.0005 },
		})
		const result = await session.run()

		assert.equal(result.status, "error", `expected budget abort, got ${JSON.stringify(result)}`)
		assert.equal(result.reason, "budget")
		// The TOTAL spend is the child's: ~$0.0006, far above the parent's own
		// $0.00 — proving the child's usage landed in the SAME tracker.
		const cost = result.budgetUsage?.costUsd ?? 0
		assert.ok(cost >= 0.0006 - 1e-9, `total cost should include the child's spend, got $${cost}`)
		assert.ok(cost < 0.001, `total cost should be just the one child call, got $${cost}`)

		// The parent's history shows the honest child-failure error, with the
		// budget reason and the total spend — not a fabricated success.
		const callId = findNewTaskCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "expected a new_task tool result in parent history")
		assert.match(toolMsg.content ?? "", /Budget exceeded/)
		assert.match(toolMsg.content ?? "", /total parent\+child spend \$0\.000600/)
		assert.doesNotMatch(toolMsg.content ?? "", /child spent/, "a failed child must not be reported as a success")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNewTaskMustBeCalledAlone(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-newtask-alone-"))
	try {
		const client = new ScriptedLlmClient([
			{
				message: multiToolCall([
					{ name: "new_task", args: { mode: "code", message: "delegate", todos: null } },
					{ name: "write_to_file", args: { path: "sibling.txt", content: "sibling wrote this" } },
				]),
			},
			{ message: toolCall("attempt_completion", { result: "done after sibling" }) },
		])
		const session = await makeSession({ task: "delegate plus sibling", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		// The sibling call STILL executed.
		assert.equal(await fs.readFile(path.join(ws, "sibling.txt"), "utf-8"), "sibling wrote this")
		// new_task was refused with the vendored description's "alone" error.
		const callId = findNewTaskCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "expected a new_task tool result in parent history")
		assert.match(toolMsg.content ?? "", /MUST be called alone/)
		// No child session ever spawned: the events dir holds ONLY the parent.
		const feeds = await readAllEventFeeds(ws)
		assert.equal(feeds.size, 1, `no child may spawn when new_task is refused, got ${feeds.size} feeds`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testChildCheckpointSharesParentHistory(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-newtask-ckpt-"))
	const checkpointDir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-newtask-ckpt-repo-"))
	try {
		const client = new ScriptedLlmClient([
			{ message: toolCall("new_task", { mode: "code", message: "write child.txt", todos: null }) },
			{ message: toolCall("write_to_file", { path: "child.txt", content: "from child" }) },
			{ message: toolCall("attempt_completion", { result: "child wrote it" }) },
			{ message: toolCall("write_to_file", { path: "parent.txt", content: "from parent" }) },
			{ message: toolCall("attempt_completion", { result: "parent done" }) },
		])
		const session = await makeSession({
			task: "delegate a write",
			client,
			workspaceRoot: ws,
			checkpoints: true,
			checkpointDir,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(await fs.readFile(path.join(ws, "child.txt"), "utf-8"), "from child")
		assert.equal(await fs.readFile(path.join(ws, "parent.txt"), "utf-8"), "from parent")

		// The child reuses the PARENT's composite checkpoint service, so both
		// sessions' snapshots live in ONE task history, not two disconnected
		// ones (checkpoints are keyed by workspaceRoot, not by session).
		const tasksDir = path.join(checkpointDir, "tasks")
		const taskIds = await fs.readdir(tasksDir)
		assert.equal(taskIds.length, 1, `expected exactly one checkpoint task (shared), got: ${taskIds.join(", ")}`)
		const svc = createCheckpointService({ taskId: taskIds[0], workspaceRoot: ws, checkpointDir })
		await svc.init()
		const entries = await svc.list()
		// root baseline + child baseline + child iteration + root iterations.
		assert.ok(entries.length >= 4, `expected shared baseline + iteration checkpoints, got ${entries.length}`)
		// Lineage tags visible in `headlesscode checkpoints list`: the root's
		// commits read `Task: <rootId>, …`, the child's read
		// `Task: <rootId>/<childId>, …` (session ids are UUIDs — no slashes).
		assert.ok(
			entries.some((e) => /^Task: [^/]+, Time: /.test(e.message)),
			"root checkpoint should be tagged with the root lineage (no slash)",
		)
		assert.ok(
			entries.some((e) => /^Task: [^/]+\/[^/]+, Time: /.test(e.message)),
			"child checkpoint should be tagged with the parent/child lineage",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

async function testChildBoundedFailureIsHonest(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-newtask-fail-"))
	try {
		// The child makes 3 consecutive errors (unknown tool) → bounded
		// failure. The parent must receive an HONEST error result, not a
		// fabricated success, and must be able to continue.
		const client = new ScriptedLlmClient([
			{ message: toolCall("new_task", { mode: "code", message: "will fail", todos: null }) },
			{ message: toolCall("no_such_tool", { query: "x" }) },
			{ message: toolCall("no_such_tool", { query: "x" }) },
			{ message: toolCall("no_such_tool", { query: "x" }) },
			{ message: toolCall("attempt_completion", { result: "handled the child failure" }) },
		])
		const session = await makeSession({ task: "delegate a doomed step", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected the parent to recover, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "handled the child failure")
		const callId = findNewTaskCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "expected a new_task tool result in parent history")
		assert.match(
			toolMsg.content ?? "",
			/^\[Error\] new_task child session \(mode 'code'\) failed: Bounded failure: 3 consecutive mistakes/,
		)
		assert.match(toolMsg.content ?? "", /The child made 3 tool call\(s\) over 3 iteration\(s\)/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["new_task: child completes and its result flows back to the parent", testChildCompletesAndResultFlowsBack],
	["new_task: recursion depth cap refuses as a recoverable tool error (parent continues)", testRecursionDepthCapIsRecoverableToolError],
	["new_task: budget is SHARED — child spend trips the one cap (total parent+child)", testBudgetSharedBetweenParentAndChild],
	["new_task: called alongside another tool is refused, sibling still executes", testNewTaskMustBeCalledAlone],
	["new_task: child edits checkpoint into the SAME shadow-git history, lineage-tagged", testChildCheckpointSharesParentHistory],
	["new_task: child bounded failure surfaces as an honest error, not fabricated success", testChildBoundedFailureIsHonest],
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
