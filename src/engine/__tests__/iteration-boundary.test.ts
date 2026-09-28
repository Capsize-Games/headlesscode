import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../loop.js"
import { eventsDir, eventsFilePath, readEventsFile } from "../events.js"
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse } from "../types.js"

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

await testBoundaryHook()
await testMalformedAndDuplicateInterventionsAbstain()
console.log("iteration-boundary tests passed")
