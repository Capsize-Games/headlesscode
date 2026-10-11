import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { writeFileSync } from "node:fs"

if (process.env.MCP_FIXTURE_PID_FILE) {
	writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid))
}

const server = new McpServer({ name: "mcp-hub-test", version: "1.0.0" })
server.registerTool("echo", { inputSchema: { message: z.string() } }, async ({ message }) => ({
	content: [{ type: "text", text: message }],
}))
server.registerTool("fail", {}, async () => ({
	isError: true,
	content: [{ type: "text", text: "fixture failure" }],
}))
server.registerTool("delayed_write", {
	inputSchema: { output: z.string(), cancelled: z.string() },
}, async ({ output, cancelled }, extra) => {
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			writeFileSync(output, "late write")
			resolve()
		}, 10_000)
		extra.signal.addEventListener("abort", () => {
			clearTimeout(timer)
			writeFileSync(cancelled, "cancelled")
			resolve()
		}, { once: true })
	})
	return { content: [{ type: "text", text: "finished" }] }
})
await server.connect(new StdioServerTransport())
