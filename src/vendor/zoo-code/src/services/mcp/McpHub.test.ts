import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { McpHub } from "./McpHub.js"

const fixture = fileURLToPath(new URL("../../../../tests/fixtures/mcp-stdio-server.mjs", import.meta.url))
const directory = await mkdtemp(resolve(tmpdir(), "headlesscode-mcp-hub-"))
const configPath = resolve(directory, "mcp.json")
const pidPath = resolve(directory, "fixture.pid")
await writeFile(configPath, JSON.stringify({
	mcpServers: {
		unavailable: { command: resolve(directory, "does-not-exist") },
		fixture: { command: process.execPath, args: [fixture], env: { MCP_FIXTURE_PID_FILE: pidPath } },
	},
}))

const hub = await McpHub.connect(configPath)
try {
	assert.equal(hub.getServers().length, 1, JSON.stringify(hub.getConnectionErrors()))
	assert.equal(hub.getServers()[0].name, "fixture")
	assert.match(hub.getConnectionErrors()[0] ?? "", /^unavailable:/)
	assert.equal(await hub.callTool("fixture", "echo", { message: "connected" }), "connected")
	await assert.rejects(hub.callTool("fixture", "fail", {}), /fixture failure/)
	assert.equal(hub.getServers()[0].tools?.length, 3)
	const outputPath = resolve(directory, "late-output")
	const cancelledPath = resolve(directory, "cancelled")
	const controller = new AbortController()
	const pending = hub.callTool("fixture", "delayed_write", { output: outputPath, cancelled: cancelledPath }, controller.signal)
	await delay(50)
	controller.abort()
	await assert.rejects(pending)
	assert.equal(await readFile(cancelledPath, "utf8"), "cancelled")
	await assert.rejects(access(outputPath))
	const fixturePid = Number(await readFile(pidPath, "utf8"))
	assert.ok(Number.isSafeInteger(fixturePid) && fixturePid > 0)
	for (let attempt = 0; attempt < 100; attempt++) {
		try { process.kill(fixturePid, 0) } catch (error) {
			assert.equal((error as NodeJS.ErrnoException).code, "ESRCH")
			break
		}
		if (attempt === 99) assert.fail("aborted stdio MCP child remained alive")
		await delay(10)
	}
	console.log("ok - MCP hub routes stdio calls, reports errors, forwards cancellation, and closes its child")
} finally {
	await hub.dispose()
	await rm(directory, { recursive: true, force: true })
}
