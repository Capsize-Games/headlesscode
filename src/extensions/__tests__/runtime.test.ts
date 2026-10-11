import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { createExtension, loadExtension, type ExtensionBundle, type ExtensionRevision } from "../registry.js"
import { SessionExtensionRuntime } from "../runtime.js"
import type { ToolContext } from "../../engine/types.js"

const scratchRoot = path.join(process.cwd(), ".headlesscode", "scratch")
const permissions = (deniedCommands: string[] = []): ToolContext["permissions"] => ({
	allowedCommands: ["node"],
	deniedCommands,
	protectedFiles: [],
	allowProtectedWrites: false,
})

async function createFixture(workspaceRoot: string, bundle: ExtensionBundle): Promise<ExtensionRevision> {
	await createExtension(workspaceRoot, bundle, { authorizeWrite: () => true })
	return await loadExtension(workspaceRoot, bundle.manifest.id, (await import("../registry.js")).extensionBundleDigest(bundle))
}

function toolBundle(id: string, source: string): ExtensionBundle {
	return {
		manifest: {
			schemaVersion: 1, id, kind: "tool", description: "Fixture native tool", entrypoint: "index.mjs",
			inputSchema: {
				"$schema": "https://json-schema.org/draft/2020-12/schema",
				type: "object", properties: { mode: { type: "string", enum: ["echo", "hang", "descendant", "error", "large", "nan", "undefined", "null"] }, text: { type: "string", maxLength: 128 }, pidFile: { type: "string" } },
				required: ["mode"], additionalProperties: false,
			},
		},
		files: { "index.mjs": source },
	}
}

function mcpBundle(id: string, source: string): ExtensionBundle {
	return { manifest: { schemaVersion: 1, id, kind: "mcp", description: "Fixture MCP server", entrypoint: "server.mjs" }, files: { "server.mjs": source } }
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try { await fs.access(file); return } catch { await delay(20) }
	}
	throw new Error(`timed out waiting for fixture file: ${file}`)
}

async function processIsGone(pid: number): Promise<boolean> {
	const deadline = Date.now() + 2_000
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0)
			if (process.platform === "linux") {
				const status = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
				if (status.split(" ")[2] === "Z") return true
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
			throw error
		}
		await delay(20)
	}
	return false
}

async function testNativeHelperBoundsPermissionsAndCapturedRevision(workspaceRoot: string): Promise<void> {
	const marker = path.join(workspaceRoot, "should-not-run")
	const source = `import { writeFileSync } from "node:fs";
export async function run(input) {
 if (input.mode === "error") throw new Error("fixture failure");
 if (input.mode === "large") return { value: "x".repeat(2000) };
 if (input.mode === "nan") return { value: Number.NaN };
 if (input.mode === "undefined") return { value: undefined };
 if (input.mode === "null") return null;
 if (input.mode === "hang") await new Promise(() => {});
 if (input.mode === "descendant") {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(input.pidFile, String(child.pid));
  await new Promise(() => {});
 }
 if (input.mode === "marker") writeFileSync(${JSON.stringify(marker)}, "ran");
 return { value: input.text ?? "", apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, home: process.env.HOME ?? null };
}`
	const bundle = toolBundle("native-fixture", source)
	const revision = await createFixture(workspaceRoot, bundle)
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 4_000, maxOutputBytes: 512 } })
	const originalEnvironment = new Map(["HEADLESSCODE_OPENROUTER_API_KEY", "NODE_OPTIONS", "HOME", "PATH"].map((key) => [key, process.env[key]]))
	try {
		process.env.HEADLESSCODE_OPENROUTER_API_KEY = "poison-secret"
		process.env.NODE_OPTIONS = "--require=poisoned.js"
		process.env.HOME = "/poisoned/home"
		process.env.PATH = "/poisoned/path"
		const description = await runtime.describe(revision)
		assert.equal(description.kind, "tool")
		assert.equal(description.revision, revision.digest)
		const result = await runtime.call(revision, { mode: "echo", text: "hello" }, { permissions: permissions() }) as Record<string, unknown>
		assert.deepEqual(result, { value: "hello", apiKey: null, nodeOptions: null, home: null }, "generated helper receives no provider key, caller NODE_OPTIONS, HOME, or inherited path")
		await assert.rejects(runtime.call(revision, { mode: "echo", text: "x".repeat(129) }, { permissions: permissions() }), /schema mismatch/)
		await assert.rejects(runtime.call(revision, { mode: "error" }, { permissions: permissions() }), /fixture failure/)
		await assert.rejects(runtime.call(revision, { mode: "large" }, { permissions: permissions() }), /output bound/)
		await assert.rejects(runtime.call(revision, { mode: "nan" }, { permissions: permissions() }), /finite JSON/)
		await assert.rejects(runtime.call(revision, { mode: "undefined" }, { permissions: permissions() }), /finite JSON/)
		assert.equal(await runtime.call(revision, { mode: "null" }, { permissions: permissions() }), null, "JSON null remains a valid extension result")
		await assert.rejects(runtime.call(revision, { mode: "marker" }, { permissions: permissions(["node"]) }), /denied by command permissions/)
		assert.equal(await fs.stat(marker).then(() => true, () => false), false, "command denial happens before generated entrypoint execution")
		const abortController = new AbortController()
		abortController.abort()
		await assert.rejects(runtime.call(revision, { mode: "echo" }, { permissions: permissions(), signal: abortController.signal }), /cancelled/)

		const storedEntrypoint = path.join(revision.directory, "index.mjs")
		await fs.writeFile(storedEntrypoint, "export function run() { return { value: 'drifted' } }\n")
		const captured = await runtime.call(revision, { mode: "echo", text: "captured" }, { permissions: permissions() }) as Record<string, unknown>
		assert.equal(captured.value, "captured", "child executes read-only staged bytes from the verified revision map, not later registry-path drift")
		const tampered = { ...revision, files: { ...revision.files, "index.mjs": "export function run(){return null}\n" } } as ExtensionRevision
		await assert.rejects(runtime.call(tampered, { mode: "echo" }, { permissions: permissions() }), /digest does not match/)
	} finally {
		await runtime.dispose()
		for (const [key, value] of originalEnvironment) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
}

async function testHardTimeoutAndDescendantTeardown(workspaceRoot: string): Promise<void> {
	const revision = await createFixture(workspaceRoot, toolBundle("descendant-fixture", `import { writeFileSync } from "node:fs"; export async function run(input) { const { spawn } = await import("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); writeFileSync(input.pidFile, String(child.pid)); await new Promise(() => {}); }`))
	const pidFile = path.join(workspaceRoot, "descendant.pid")
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 500 } })
	try {
		const startedAt = Date.now()
		await assert.rejects(runtime.call(revision, { mode: "descendant", pidFile }, { permissions: permissions() }), /deadline exceeded|cancelled/)
		assert.ok(Date.now() - startedAt < 2_000, "hard timeout bounds uncooperative generated helpers")
		const childPidText = await fs.readFile(pidFile, "utf8")
		assert.match(childPidText, /^\d+$/)
		assert.equal(await processIsGone(Number(childPidText)), true, "timeout tears down descendants in the owned process group")
	} finally { await runtime.dispose() }
}

const MCP_SERVER_SOURCE = `import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "fixture-server", version: "1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 2 } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false } }] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: "text", text: "ok" }], structuredContent: { echo: params.arguments.text } }));
await server.connect(new StdioServerTransport());`

async function testMcpHandshakeSchemaAndCall(workspaceRoot: string): Promise<void> {
	const revision = await createFixture(workspaceRoot, mcpBundle("mcp-fixture", MCP_SERVER_SOURCE))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 5_000 } })
	try {
		const description = await runtime.describe(revision)
		assert.equal(description.tools?.length, 1)
		assert.equal(description.tools?.[0]?.name, "echo")
		assert.deepEqual(await runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" }), {
			content: [{ type: "text", text: "ok" }], structuredContent: { echo: "hello" },
		})
		await assert.rejects(runtime.call(revision, { text: "x" }, { permissions: permissions(), toolName: "echo" }), /does not match its schema/)
		await assert.rejects(runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "other" }), /not advertised/)
		await assert.rejects(runtime.call(revision, { text: "hello" }, { permissions: permissions(["node"]), toolName: "echo" }), /denied by command permissions/)
	} finally { await runtime.dispose() }
}

async function testMcpDuplicateNamesAndMalformedOversizedFrames(workspaceRoot: string): Promise<void> {
	const duplicate = MCP_SERVER_SOURCE.replace('tools: [{ name: "echo", description:', 'tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "echo", description:')
	const duplicateRevision = await createFixture(workspaceRoot, mcpBundle("mcp-duplicate", duplicate))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 2_000, maxProtocolBytes: 64 * 1024 } })
	try {
		await assert.rejects(runtime.describe(duplicateRevision), /duplicate tool names/)
		const malformed = await createFixture(workspaceRoot, mcpBundle("mcp-malformed", "process.stdout.write('not-json\\n'); setInterval(() => {}, 1000)"))
		await assert.rejects(runtime.describe(malformed), /protocol|JSON|MCP/i)
		const oversized = await createFixture(workspaceRoot, mcpBundle("mcp-oversized", "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { x: 'x'.repeat(100000) } }) + '\\n'); setInterval(() => {}, 1000)"))
		await assert.rejects(runtime.describe(oversized), /bound|buffer|protocol|closed|MCP/i)
	} finally { await runtime.dispose() }
}

async function testMcpCallTimeoutAndDisposal(workspaceRoot: string): Promise<void> {
	const hanging = MCP_SERVER_SOURCE.replace('server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: "text", text: "ok" }], structuredContent: { echo: params.arguments.text } }));', 'server.setRequestHandler(CallToolRequestSchema, async () => await new Promise(() => {}));')
	const revision = await createFixture(workspaceRoot, mcpBundle("mcp-hang", hanging))
	const runtime = new SessionExtensionRuntime({ workspaceRoot, permissions: permissions(), limits: { callTimeoutMs: 500 } })
	try {
		await assert.rejects(runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" }), /cancel|deadline|timeout/i)
		await assert.rejects(runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" }), /cancel|deadline|timeout/i)
		const inFlight = runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" })
		await delay(100)
		await runtime.dispose()
		await assert.rejects(inFlight, /cancel|closed|transport|disposed/i)
		await assert.rejects(runtime.call(revision, { text: "hello" }, { permissions: permissions(), toolName: "echo" }), /disposed/)
	} finally { await runtime.dispose() }
}

await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
const workspaceRoot = await fs.mkdtemp(path.join(scratchRoot, "extension-runtime-test-"))
try {
	await testNativeHelperBoundsPermissionsAndCapturedRevision(workspaceRoot)
	await testHardTimeoutAndDescendantTeardown(workspaceRoot)
	await testMcpHandshakeSchemaAndCall(workspaceRoot)
	await testMcpDuplicateNamesAndMalformedOversizedFrames(workspaceRoot)
	await testMcpCallTimeoutAndDisposal(workspaceRoot)
	process.stdout.write("Extension child runtime and bounded MCP transport tests passed\n")
} finally {
	await fs.rm(workspaceRoot, { recursive: true, force: true })
}
