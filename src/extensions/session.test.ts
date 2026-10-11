import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { HeadlessSession } from "../engine/loop.js"
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse } from "../engine/types.js"
import { createHeadlessExecutor } from "../tools/executor.js"
import { createExtension, extensionBundleDigest, type ExtensionBundle } from "./registry.js"
import type { SkillRegistry } from "../skills/registry.js"
import { appendExtensionTools } from "./tools.js"
import { selectToolsForMode } from "../engine/prompt.js"
import { eventsDir, readEventsFile } from "../engine/events.js"

const scratch = path.join(process.cwd(), ".headlesscode", "scratch")

function tool(name: string, args: Record<string, unknown>, id: string): ChatMessage {
	return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
}

function skillRegistry(): SkillRegistry {
	return {
		skills: [],
		problems: [],
		get: () => undefined,
		activate: () => undefined,
		readReference: () => { throw new Error("no captured skills") },
	}
}

class ScriptedClient implements LlmClient {
	readonly requests: LlmRequest[] = []
	private index = 0
	constructor(private readonly responses: ChatMessage[]) {}
	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push({ ...request, messages: request.messages.slice(), tools: request.tools?.slice() })
		const message = this.responses[this.index++]
		if (!message) throw new Error("scripted client ran out of responses")
		return { message }
	}
}

function createCall(bundle: ExtensionBundle): Record<string, unknown> {
	return {
		action: "create",
		id: null,
		digest: null,
		manifest: bundle.manifest,
		files: bundle.files,
	}
}

async function testCodingSessionCreatesAndUsesPinnedSkillToolAndMcp(): Promise<void> {
	await fs.mkdir(scratch, { recursive: true })
	const workspaceRoot = await fs.mkdtemp(path.join(scratch, "extension-session-"))
	try {
		execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot })
		execFileSync("git", ["config", "user.name", "Fixture"], { cwd: workspaceRoot })
		execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: workspaceRoot })
		execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "baseline"], { cwd: workspaceRoot })
		const skillBundle: ExtensionBundle = {
			manifest: { schemaVersion: 1, id: "fixture-skill", kind: "skill", description: "Captured test guidance" },
			files: { "SKILL.md": "---\nname: fixture-skill\ndescription: Captured test guidance\n---\nUse the pinned fixture instructions.\n", "references/example.md": "Reference content" },
		}
		const toolBundle: ExtensionBundle = {
			manifest: { schemaVersion: 1, id: "fixture-tool", kind: "tool", description: "Returns its input", entrypoint: "index.mjs", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
			files: { "index.mjs": "export async function run(input) { return { echoed: input.value } }\n" },
		}
		const mcpBundle: ExtensionBundle = {
			manifest: { schemaVersion: 1, id: "fixture-mcp", kind: "mcp", description: "Fixture MCP server", entrypoint: "server.mjs" },
			files: {
				"server.mjs": [
					'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"',
					'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"',
				'import { z } from "zod"',
				'const server = new McpServer({ name: "fixture", version: "1" })',
				'server.registerTool("double", { inputSchema: { value: z.number() } }, async ({ value }) => ({ content: [{ type: "text", text: String(value * 2) }] }))',
				'await server.connect(new StdioServerTransport())',
			].join("\n"),
			},
		}
		const skillDigest = extensionBundleDigest(skillBundle)
		const toolDigest = extensionBundleDigest(toolBundle)
		const mcpDigest = extensionBundleDigest(mcpBundle)
		const client = new ScriptedClient([
			tool("extension_manage", createCall(skillBundle), "create-skill"),
			tool("extension_call", { id: "fixture-skill", digest: skillDigest, input: {}, tool_name: null }, "use-skill"),
			tool("extension_manage", createCall(toolBundle), "create-tool"),
			tool("extension_call", { id: "fixture-tool", digest: toolDigest, input: { value: "kept" }, tool_name: null }, "use-tool"),
			tool("extension_manage", createCall(mcpBundle), "create-mcp"),
			tool("extension_call", { id: "fixture-mcp", digest: mcpDigest, input: { value: 21 }, tool_name: "double" }, "use-mcp"),
			tool("attempt_completion", { result: "extensions completed" }, "complete"),
		])
		const executor = createHeadlessExecutor(workspaceRoot, {
			permissions: { allowedCommands: [], deniedCommands: [], protectedFiles: [".env", "*.key", "*.pem"], allowProtectedWrites: false },
		})
		const codeTools = appendExtensionTools(selectToolsForMode("code", []), { canWrite: true, canExecute: true, explicitAllowlist: false })
		const result = await new HeadlessSession({
			workspaceRoot,
			mode: "code",
			taskText: "Create and use the three supplied extensions.",
			model: "fixture",
			llmClient: client,
			executor,
			tools: codeTools,
			customModes: [],
			skillRegistry: skillRegistry(),
			systemPromptOverride: "stable fixture prompt",
			checkpoints: false,
			maxIterations: 8,
		}).run()
		assert.equal(result.status, "success")
		assert.equal(client.requests.length, 7)
		const catalogs = client.requests.map((request) => JSON.stringify(request.tools?.filter((entry) => ["extension_manage", "extension_call"].includes(entry.function.name))))
		assert.equal(new Set(catalogs).size, 1, "extension schemas remain fixed after creating revisions")
		assert.ok(client.requests.every((request) => request.messages[0]?.content === "stable fixture prompt"), "creating extensions does not rewrite the system prompt")
		const toolMessages = client.requests.flatMap((request) => request.messages).filter((message) => message.role === "tool")
		assert.ok(toolMessages.some((message) => message.content?.includes("Use the pinned fixture instructions.")))
		assert.ok(toolMessages.some((message) => message.content?.includes('"echoed":"kept"')))
		assert.ok(toolMessages.some((message) => message.content?.includes('"text":"42"')))
		const eventFile = path.join(eventsDir(workspaceRoot), (await fs.readdir(eventsDir(workspaceRoot))).find((name) => name.endsWith(".jsonl")) ?? "")
		const events = await readEventsFile(eventFile)
		for (const [kind, id, digest] of [["skill", "fixture-skill", skillDigest], ["tool", "fixture-tool", toolDigest], ["mcp", "fixture-mcp", mcpDigest]]) {
			assert.ok(events.some((event) => event.type === "tool_result" && (event.extension as { kind?: string; id?: string; digest?: string } | undefined)?.kind === kind && (event.extension as { id?: string })?.id === id && (event.extension as { digest?: string })?.digest === digest))
		}
	} finally {
		await fs.rm(workspaceRoot, { recursive: true, force: true })
	}
}

async function testRestrictedSessionDoesNotAdvertiseOrRegisterExtensionTools(): Promise<void> {
	await fs.mkdir(scratch, { recursive: true })
	const workspaceRoot = await fs.mkdtemp(path.join(scratch, "extension-restricted-"))
	try {
		const client = new ScriptedClient([
			tool("extension_manage", { action: "list", id: null, digest: null, manifest: null, files: null }, "forged-extension"),
			tool("attempt_completion", { result: "done" }, "complete"),
		])
		const result = await new HeadlessSession({
			workspaceRoot,
			mode: "reviewer",
			taskText: "Review only.",
			model: "fixture",
			llmClient: client,
			executor: createHeadlessExecutor(workspaceRoot, { permissions: { allowedCommands: [], deniedCommands: [], protectedFiles: [], allowProtectedWrites: false } }),
			skillRegistry: skillRegistry(),
			systemPromptOverride: "review only",
			tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }],
			checkpoints: false,
			maxIterations: 3,
		}).run()
		assert.equal(result.status, "success")
		assert.equal(client.requests[0]?.tools?.some((entry) => entry.function.name.startsWith("extension_")), false)
		const callResult = client.requests[1]?.messages.find((message) => message.role === "tool")
		assert.match(callResult?.content ?? "", /requires workspace write and command execution tools/)
	} finally {
		await fs.rm(workspaceRoot, { recursive: true, force: true })
	}
}

async function testSessionStopReapsMcpDescendant(): Promise<void> {
	await fs.mkdir(scratch, { recursive: true })
	const workspaceRoot = await fs.mkdtemp(path.join(scratch, "extension-stop-"))
	const pidFile = path.join(workspaceRoot, "server.pid")
	const controller = new AbortController()
	let running: Promise<unknown> | undefined
	try {
		const source = [
			'import { writeFileSync } from "node:fs"',
			'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"',
			'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"',
			`writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
			'const server = new McpServer({ name: "stop-fixture", version: "1" })',
			'server.registerTool("wait", {}, async () => await new Promise(() => {}))',
			'await server.connect(new StdioServerTransport())',
		].join("\n")
		const bundle: ExtensionBundle = {
			manifest: { schemaVersion: 1, id: "stop-mcp", kind: "mcp", description: "Hanging stop fixture", entrypoint: "server.mjs" },
			files: { "server.mjs": source },
		}
		const revision = await createExtension(workspaceRoot, bundle, { authorizeWrite: () => true })
		const client = new ScriptedClient([
			tool("extension_call", { id: revision.manifest.id, digest: revision.digest, input: {}, tool_name: "wait" }, "wait-call"),
		])
		const codeTools = appendExtensionTools(selectToolsForMode("code", []), { canWrite: true, canExecute: true, explicitAllowlist: false })
		running = new HeadlessSession({
			workspaceRoot,
			mode: "code",
			taskText: "Call the fixture and wait for the supervisor stop.",
			model: "fixture",
			llmClient: client,
			executor: createHeadlessExecutor(workspaceRoot, { permissions: { allowedCommands: [], deniedCommands: [], protectedFiles: [], allowProtectedWrites: false } }),
			tools: codeTools,
			customModes: [],
			skillRegistry: skillRegistry(),
			systemPromptOverride: "stable stop fixture",
			checkpoints: false,
			signal: controller.signal,
		}).run()
		let pid: number | undefined
		for (let attempt = 0; attempt < 500; attempt++) {
			try {
				const parsed = Number(await fs.readFile(pidFile, "utf8"))
				if (Number.isSafeInteger(parsed) && parsed > 0) { pid = parsed; break }
			} catch { /* child has not started */ }
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		assert.ok(pid, "MCP child should start and publish its own PID")
		controller.abort(new Error("test stop"))
		await running
		let exited = false
		for (let attempt = 0; attempt < 100; attempt++) {
			try { process.kill(pid!, 0) } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") { exited = true; break }
				throw error
			}
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		assert.equal(exited, true, "session teardown must reap the MCP server process")
	} finally {
		controller.abort()
		await running?.catch(() => undefined)
		await fs.rm(workspaceRoot, { recursive: true, force: true })
	}
}

await testCodingSessionCreatesAndUsesPinnedSkillToolAndMcp()
await testRestrictedSessionDoesNotAdvertiseOrRegisterExtensionTools()
await testSessionStopReapsMcpDescendant()
console.log("All extension session tests passed")
