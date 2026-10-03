import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { McpHub } from "./McpHub.js"

const fixture = fileURLToPath(new URL("../../../../tests/fixtures/mcp-stdio-server.mjs", import.meta.url))
const directory = await mkdtemp(resolve(tmpdir(), "headlesscode-mcp-hub-"))
const configPath = resolve(directory, "mcp.json")
await writeFile(configPath, JSON.stringify({
	mcpServers: {
		unavailable: { command: resolve(directory, "does-not-exist") },
		fixture: { command: process.execPath, args: [fixture] },
	},
}))

const hub = await McpHub.connect(configPath)
try {
	assert.equal(hub.getServers().length, 1)
	assert.equal(hub.getServers()[0].name, "fixture")
	assert.match(hub.getConnectionErrors()[0] ?? "", /^unavailable:/)
	assert.equal(await hub.callTool("fixture", "echo", { message: "connected" }), "connected")
	await assert.rejects(hub.callTool("fixture", "fail", {}), /fixture failure/)
	assert.equal(hub.getServers()[0].tools?.length, 2)
	console.log("ok - MCP hub connects stdio tools, isolates startup failures, routes calls, and reports tool errors")
} finally {
	await hub.dispose()
	await rm(directory, { recursive: true, force: true })
}
