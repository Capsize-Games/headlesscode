/**
 * Memory wiring tests — HeadlessSession + LocalMemoryStore integration.
 *
 * Verifies the Phase 3 hooks attach without breaking the existing session API:
 *   1. A run with memory records a session summary + extracted facts.
 *   2. A second run with the same store recalls them into its first user
 *      message ("## PROJECT MEMORY" marker + fact content).
 *   3. Default (no memory) behavior is unchanged (no marker, no stats) — the
 *      pre-existing loop tests (src/engine/__tests__/loop.test.ts) cover the
 *      rest.
 *
 * Plain assert-based, fake LlmClient, no network. Run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../../engine/loop.js"
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse } from "../../engine/types.js"
import { LocalMemoryStore } from "../local.js"
import type { MemoryStore } from "../types.js"

const PROJECT = "wiring-project"

class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []
	constructor(private readonly script: Array<(req: LlmRequest) => ChatMessage>) {}
	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (model kept calling)")
		}
		return { message: step(request) }
	}
}

function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2)}`): ChatMessage {
	const argumentsStr = typeof args === "string" ? args : JSON.stringify(args)
	return {
		role: "assistant",
		content: null,
		tool_calls: [{ id, type: "function", function: { name, arguments: argumentsStr } }],
	}
}

async function runSession(options: {
	workspace: string
	task: string
	client: LlmClient
	memory?: MemoryStore | null
}): Promise<{ session: HeadlessSession; result: import("../../engine/types.js").SessionResult }> {
	const session = new HeadlessSession({
		workspaceRoot: options.workspace,
		mode: "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: 10,
		consecutiveErrorLimit: 3,
		windowSize: 40,
		memory: options.memory ?? null,
		project: PROJECT,
		// Checkpoints are default-on and would otherwise write real shadow-git
		// commits to ~/.headlesscode/checkpoints on every test run; this suite
		// isn't testing checkpoints, so keep tests hermetic and fast.
		checkpoints: false,
	})
	const result = await session.run()
	return { session, result }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testRecordsSessionAndFactsAfterCompletion(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-memw-"))
	const memDir = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-memw-mem-"))
	try {
		const store = new LocalMemoryStore({ dir: memDir })
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "notes.txt", content: "always run tests before committing" }),
			() => toolCall("execute_command", { command: "npm test" }),
			() =>
				toolCall("attempt_completion", {
					result: "Done. Convention: always run tests before committing. Note: the build is green.",
				}),
		])
		const { result, session } = await runSession({ workspace: ws, task: "add a note about testing", client, memory: store })

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		// Session + facts recorded into the store.
		const sessions = await store.listSessions(PROJECT)
		assert.equal(sessions.length, 1, "one session summary recorded")
		assert.equal(sessions[0].outcome, "success")
		assert.ok(sessions[0].filesTouched.includes("notes.txt"), "write_to_file path captured")
		assert.ok(sessions[0].commandsRun.includes("npm test"), "command captured")

		const facts = await store.listFacts(PROJECT)
		assert.ok(facts.length >= 1, "facts extracted and stored")
		assert.ok(facts.some((f) => f.content.includes("always run tests")), "fact content persisted")

		// Stats surfaced on the session for the CLI summary line.
		assert.ok(session.memoryStats, "memoryStats set when memory enabled")
		assert.equal(session.memoryStats?.recordedSessions, 1)
		assert.ok((session.memoryStats?.recordedFacts ?? 0) >= 1)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(memDir, { recursive: true, force: true })
	}
}

async function testSecondRunRecallsMemoryInPrompt(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-memw2-"))
	const memDir = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-memw2-mem-"))
	try {
		const store = new LocalMemoryStore({ dir: memDir })

		// Run 1 records a fact (keyword "always" → convention).
		const client1 = new FakeLlmClient([
			() =>
				toolCall("attempt_completion", {
					result: "Note: the API client uses retries. Convention: always retry on 429.",
				}),
		])
		const r1 = await runSession({ workspace: ws, task: "set up retry logic", client: client1, memory: store })
		assert.equal(r1.result.status, "success")
		const stored = await store.listFacts(PROJECT)
		assert.ok(stored.some((f) => f.content.includes("always retry on 429")), "fact stored by run 1")

		// Run 2 with the same store → recall injected into the first user message.
		const client2 = new FakeLlmClient([() => toolCall("attempt_completion", { result: "done" })])
		const r2 = await runSession({ workspace: ws, task: "retry on 429 in the API client", client: client2, memory: store })
		assert.equal(r2.result.status, "success")

		const firstUser = client2.requests[0].messages.find((m) => m.role === "user")
		assert.ok(firstUser?.content, "first user message present")
		assert.ok(
			firstUser?.content?.includes("## PROJECT MEMORY"),
			'"## PROJECT MEMORY" marker must appear in the request',
		)
		assert.ok(
			firstUser?.content?.includes("always retry on 429"),
			"recalled fact content must appear in the request",
		)
		assert.ok((r2.session.memoryStats?.recalledFacts ?? 0) >= 1, "run 2 stats report recalled facts")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(memDir, { recursive: true, force: true })
	}
}

async function testNoMemoryLeavesPromptUnchanged(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-memw3-"))
	try {
		const client = new FakeLlmClient([() => toolCall("attempt_completion", { result: "done" })])
		const { session } = await runSession({ workspace: ws, task: "no memory task", client })
		const firstUser = client.requests[0].messages.find((m) => m.role === "user")
		assert.ok(!firstUser?.content?.includes("## PROJECT MEMORY"), "no memory marker when memory is null")
		assert.equal(session.memoryStats, null, "memoryStats stays null when memory is off")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMemoryFailureDoesNotFailSession(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-memw4-"))
	try {
		// A store whose every method throws — memory must never fail the session.
		const broken: MemoryStore = {
			listFacts: async () => {
				throw new Error("boom list")
			},
			addFact: async () => {
				throw new Error("boom add")
			},
			queryRecall: async () => {
				throw new Error("boom recall")
			},
			recordSession: async () => {
				throw new Error("boom record")
			},
			listSessions: async () => {
				throw new Error("boom sessions")
			},
		}
		const client = new FakeLlmClient([() => toolCall("attempt_completion", { result: "done" })])
		const { result, session } = await runSession({ workspace: ws, task: "memory should not break this", client, memory: broken })
		assert.equal(result.status, "success", "session succeeds despite failing memory")
		assert.equal(session.memoryStats, null, "no stats when recording failed")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["records session summary + facts after completion", testRecordsSessionAndFactsAfterCompletion],
	["second run recalls memory into the first user message", testSecondRunRecallsMemoryInPrompt],
	["default (no memory) behavior unchanged", testNoMemoryLeavesPromptUnchanged],
	["memory failures are non-fatal to the session", testMemoryFailureDoesNotFailSession],
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
	console.log(`\nAll ${tests.length} memory-wiring tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
