import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../loop.js"
import { createHeadlessExecutor } from "../../tools/executor.js"
import { eventsDir, eventsFilePath, readEventsFile } from "../events.js"
import type { ChatMessage, IterationBoundaryHook, IterationBoundaryIntervention, LlmClient, LlmRequest, LlmResponse } from "../types.js"

function tool(name: string, args: Record<string, unknown>, id: string): ChatMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
	}
}

class Client implements LlmClient {
	readonly requests: LlmRequest[] = []
	private call = 0
	constructor(private readonly completionCall = 3) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push({ ...request, messages: request.messages.slice() })
		this.call++
		return {
			message:
				this.call < this.completionCall
					? tool("write_to_file", { path: `result-${this.call}.txt`, content: "ok" }, `write-${this.call}`)
					: tool("attempt_completion", { result: "done" }, "complete-1"),
		}
	}
}

async function sessionEvents(workspaceRoot: string) {
	const [file] = await fs.readdir(eventsDir(workspaceRoot))
	return readEventsFile(eventsFilePath(workspaceRoot, file.replace(/\.jsonl$/, "")))
}

async function testBoundaryHook() {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-boundary-"))
	try {
		const client = new Client()
		const snapshots: unknown[] = []
		const session = new HeadlessSession({
			workspaceRoot,
			mode: "code",
			taskText: "write a result",
			model: "fake",
			llmClient: client,
			checkpoints: false,
			maxIterations: 3,
			iterationBoundaryHook: async (snapshot) => {
				snapshots.push(snapshot)
				if (snapshot.iteration === 2) return { id: "monitor-1", templateId: "generic-review" }
				return undefined
			},
		})
		const result = await session.run()
		assert.equal(result.status, "success")
		assert.equal(snapshots.length, 2)
		const second = snapshots[1] as { toolCalls: readonly { name: string; isError: boolean }[] }
		assert.deepEqual(second.toolCalls.map((call) => [call.name, call.isError]), [["write_to_file", false]])
		const secondRequest = client.requests[1]
		assert.equal(secondRequest.messages.at(-1)?.content, "Pause and review your approach before continuing.")

		const events = await sessionEvents(workspaceRoot)
		assert.ok(events.some((event) => event.type === "iteration_intervention_queued" && event.interventionId === "monitor-1"))
		assert.ok(events.some((event) => event.type === "iteration_intervention_applied" && event.interventionId === "monitor-1"))
	} finally {
		await fs.rm(workspaceRoot, { recursive: true, force: true })
	}
}

async function testMalformedAndDuplicateInterventionsAbstain() {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-boundary-invalid-"))
	try {
		const client = new Client(4)
		let calls = 0
		const session = new HeadlessSession({
			workspaceRoot,
			mode: "code",
			taskText: "write a result",
			model: "fake",
			llmClient: client,
			checkpoints: false,
			maxIterations: 4,
			iterationBoundaryHook: () => {
				calls++
				if (calls === 1) return { id: "same", templateId: "generic-review" }
				if (calls === 2) return { id: "same", templateId: "generic-review" }
				return { id: "bad", templateId: "arbitrary-text" as never }
			},
		})
		await session.run()
		const events = await sessionEvents(workspaceRoot)
		assert.ok(events.some((event) => event.reason === "duplicate"))
		assert.ok(events.some((event) => event.reason === "malformed"))
		assert.equal(client.requests[1].messages.at(-1)?.content, "Pause and review your approach before continuing.")
	} finally {
		await fs.rm(workspaceRoot, { recursive: true, force: true })
	}
}

async function testTimeoutCannotApplyAfterCompletion() {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-boundary-timeout-"))
	try {
		let release!: (value: IterationBoundaryIntervention) => void
		const pending = new Promise<IterationBoundaryIntervention>((resolve) => { release = resolve })
		const client = new Client(2)
		const result = await new HeadlessSession({ workspaceRoot, mode: "code", taskText: "write a result", model: "fake", llmClient: client,
			checkpoints: false, maxIterations: 2, iterationBoundaryTimeoutMs: 5, iterationBoundaryHook: () => pending }).run()
		assert.equal(result.status, "success")
		const before = await sessionEvents(workspaceRoot)
		assert.ok(before.some((event) => event.reason === "timeout"))
		release({ id: "late", templateId: "generic-review" })
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.deepEqual(await sessionEvents(workspaceRoot), before, "late monitor result cannot append events or reopen the terminal session")
		assert.equal(client.requests.length, 2)
		assert.ok(client.requests.every((request) => !request.messages.some((message) => message.content === "Pause and review your approach before continuing.")))
	} finally { await fs.rm(workspaceRoot, { recursive: true, force: true }) }
}

async function testStopDiscardsPendingIntervention() {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-boundary-stop-"))
	try {
		const controller = new AbortController()
		let entered!: () => void
		const started = new Promise<void>((resolve) => { entered = resolve })
		let release!: (value: IterationBoundaryIntervention) => void
		const pending = new Promise<IterationBoundaryIntervention>((resolve) => { release = resolve })
		const client = new Client(2)
		const running = new HeadlessSession({ workspaceRoot, mode: "code", taskText: "write a result", model: "fake", llmClient: client,
			checkpoints: false, maxIterations: 2, signal: controller.signal, iterationBoundaryTimeoutMs: 60_000,
			iterationBoundaryHook: () => { entered(); return pending } }).run()
		await started
		controller.abort("operator stopped the session")
		const result = await Promise.race([running, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stop waited for monitor timeout")), 1_000).unref())])
		assert.equal(result.status, "error")
		const before = await sessionEvents(workspaceRoot)
		assert.ok(before.some((event) => event.type === "iteration_intervention_abstained" && event.reason === "session-ended"))
		release({ id: "after-stop", templateId: "generic-review" })
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.deepEqual(await sessionEvents(workspaceRoot), before)
		assert.ok(!before.some((event) => event.type === "iteration_intervention_applied"))
		assert.equal(client.requests.length, 1, "stopping at a boundary prevents the next inference")
	} finally { await fs.rm(workspaceRoot, { recursive: true, force: true }) }
}

async function testImmutableObservationAndFixedAuthority() {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-boundary-authority-"))
	try {
		const requests: LlmRequest[] = []
		const client: LlmClient = { async createChatCompletion(request) {
			requests.push({ ...request, messages: request.messages.slice() })
			return { message: requests.length === 1 ? tool("write_to_file", { path: "result.txt", content: "ok", extra: { nested: ["original"] } }, "write") : tool("attempt_completion", { result: "done" }, "complete") }
		} }
		const result = await new HeadlessSession({ workspaceRoot, mode: "code", taskText: "write a result", model: "fake", llmClient: client,
			checkpoints: false, maxIterations: 2, iterationBoundaryHook: (snapshot) => {
				assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.toolCalls) && Object.isFrozen(snapshot.toolCalls[0]))
				const nested = snapshot.toolCalls[0].arguments.extra as { nested: string[] }
				assert.ok(Object.isFrozen(nested) && Object.isFrozen(nested.nested), "nested observation arguments must be immutable")
				assert.throws(() => { nested.nested[0] = "mutated" }, TypeError)
				return { id: "fixed", templateId: "generic-review", text: "arbitrary injected prompt", maxIterations: Infinity, tools: [], permissions: { allowAll: true }, model: "unauthorized" }
			} }).run()
		assert.equal(result.status, "success")
		assert.equal(requests[1].model, "fake")
		assert.deepEqual(requests[1].tools, requests[0].tools)
		assert.equal(requests[1].messages.at(-1)?.content, "Pause and review your approach before continuing.")
		assert.ok(!JSON.stringify(requests[1]).includes("arbitrary injected prompt"))
		assert.equal(await fs.readFile(path.join(workspaceRoot, "result.txt"), "utf8"), "ok")
	} finally { await fs.rm(workspaceRoot, { recursive: true, force: true }) }
}

async function testInterventionCannotExtendBudget() {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-boundary-budget-"))
	try {
		const client = new Client(3)
		const result = await new HeadlessSession({ workspaceRoot, mode: "code", taskText: "write a result", model: "fake", llmClient: client,
			checkpoints: false, maxIterations: 4, budget: { maxIterations: 2 }, iterationBoundaryHook: () => ({
				id: "budget-extension", templateId: "generic-review", budget: { maxIterations: Infinity }, maxIterations: Infinity,
			}) }).run()
		assert.equal(result.status, "error")
		assert.equal(result.reason, "budget")
		assert.equal(client.requests.length, 2, "the monitor cannot authorize inference beyond the supervisor budget")
		assert.ok(!await fs.stat(path.join(workspaceRoot, "result-3.txt")).catch(() => undefined))
	} finally { await fs.rm(workspaceRoot, { recursive: true, force: true }) }
}

async function testNonFiniteMalformedAndThrowingMonitor() {
	for (const hook of [(() => ({ id: Infinity, templateId: "generic-review" })), (() => ({ id: "bad", templateId: NaN })), (() => { throw new Error("monitor unavailable") })] as unknown as IterationBoundaryHook[]) {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-boundary-abstain-"))
		try {
			const client = new Client(2)
			const result = await new HeadlessSession({ workspaceRoot, mode: "code", taskText: "write a result", model: "fake", llmClient: client,
				checkpoints: false, maxIterations: 2, iterationBoundaryHook: hook }).run()
			assert.equal(result.status, "success")
			const events = await sessionEvents(workspaceRoot)
			assert.ok(events.some((event) => event.type === "iteration_intervention_abstained"))
			assert.ok(!events.some((event) => event.type === "iteration_intervention_applied"))
			assert.equal(client.requests[1].messages.at(-1)?.role, "tool")
		} finally { await fs.rm(workspaceRoot, { recursive: true, force: true }) }
	}
}

async function testNoHookPreservesWireAndEvents() {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-boundary-none-"))
	try {
		const run = async (explicitUndefined: boolean) => {
			const client = new Client(2)
			const events: Array<{ type: string; iteration: unknown }> = []
			const result = await new HeadlessSession({ workspaceRoot, mode: "code", taskText: "write a result", model: "fake", llmClient: client,
				checkpoints: false, maxIterations: 2, sessionId: "no-monitor", ...(explicitUndefined ? { iterationBoundaryHook: undefined } : {}),
				eventHook: (type, fields) => { events.push({ type, iteration: fields.iteration }) } }).run()
			assert.equal(result.status, "success")
			assert.ok(!events.some((event) => event.type.startsWith("iteration_intervention")))
			assert.ok(client.requests[0].cacheRoutingKey)
			assert.ok(client.requests.every((request) => request.cacheRoutingKey === client.requests[0].cacheRoutingKey))
			return { requests: client.requests.map(({ signal, onStreamChunk, cacheRoutingKey, ...request }) => request), events }
		}
		const baseline = await run(false)
		await fs.rm(workspaceRoot, { recursive: true, force: true })
		await fs.mkdir(workspaceRoot)
		assert.deepEqual(await run(true), baseline)
	} finally { await fs.rm(workspaceRoot, { recursive: true, force: true }) }
}

async function testNestedBatchObservationOrderAndImmutability() {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-boundary-batch-"))
	try {
		const executor = createHeadlessExecutor(workspaceRoot)
		let releaseSlow!: () => void
		const fastFinished = new Promise<void>((resolve) => { releaseSlow = resolve })
		const finished: string[] = []
		executor.register("read_file", async (args) => {
			if (args.path === "slow.txt") {
				await fastFinished
				await new Promise<void>((resolve) => setImmediate(resolve))
			} else releaseSlow()
			finished.push(String(args.path))
			return { content: String(args.path), isError: false }
		})
		const observations: Array<{ names: string[]; paths: unknown[]; immutable: boolean }> = []
		let requests = 0
		const client: LlmClient = { async createChatCompletion() {
			requests++
			return { message: requests === 1 ? tool("batch", { calls: [
				{ tool: "read_file", args: { path: "slow.txt", extra: { values: ["first"] } } },
				{ tool: "read_file", args: { path: "fast.txt", extra: { values: ["second"] } } },
			] }, "batch-1") : tool("attempt_completion", { result: "done" }, "complete") }
		} }
		const result = await new HeadlessSession({ workspaceRoot, mode: "code", taskText: "read the files", model: "fake", llmClient: client,
			executor, checkpoints: false, maxIterations: 2, iterationBoundaryHook: (snapshot) => {
				observations.push({ names: snapshot.toolCalls.map((call) => call.name), paths: snapshot.toolCalls.map((call) => call.arguments.path),
					immutable: snapshot.toolCalls.every((call) => {
						if (call.name === "batch") {
							const calls = call.arguments.calls as Array<{ args: { extra: { values: string[] } } }>
							return Object.isFrozen(calls) && Object.isFrozen(calls[0].args.extra.values)
						}
						const extra = call.arguments.extra as { values: string[] }
						return Object.isFrozen(extra) && Object.isFrozen(extra.values)
					}) })
			} }).run()
		assert.equal(result.status, "success")
		assert.deepEqual(finished, ["fast.txt", "slow.txt"], "reads actually finished out of submission order")
		assert.deepEqual(observations, [{ names: ["read_file", "read_file", "batch"], paths: ["slow.txt", "fast.txt", undefined], immutable: true }])
	} finally { await fs.rm(workspaceRoot, { recursive: true, force: true }) }
}

await testBoundaryHook()
await testMalformedAndDuplicateInterventionsAbstain()
await testTimeoutCannotApplyAfterCompletion()
await testImmutableObservationAndFixedAuthority()
await testNestedBatchObservationOrderAndImmutability()
await testInterventionCannotExtendBudget()
await testNonFiniteMalformedAndThrowingMonitor()
await testNoHookPreservesWireAndEvents()
await testStopDiscardsPendingIntervention()
console.log("iteration-boundary tests passed")
