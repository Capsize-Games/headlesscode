/**
 * Minimal real MCP stdio server used as a fixture by src/mcp/__tests__/client.test.ts.
 *
 * Built on the official @modelcontextprotocol/sdk — the same library the
 * production client uses, so the fixture exercises the real protocol, not a
 * fake process that merely speaks "enough of it". Exposes:
 *
 *   - one tool: `reverse` (reverses a string, with a deliberately broken
 *     `capitalize` sibling that throws so call-tool error handling is tested)
 *   - one resource: `test://greeting`
 *   - a persistent marker file (MCP_TEST_MARKER) written on startup and only
 *     removed by a clean shutdown — lets tests assert that dispose() really
 *     terminates the child (see client.test.ts).
 *
 * Registered via the low-level Server API (registerTool/registerResource are
 * the SDK's high-level helpers and are also exercised — see below) with
 * explicit capabilities, matching how the real McpHub drives the SDK.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import * as fs from "node:fs"

const marker = process.env.MCP_TEST_MARKER
if (marker) {
	fs.writeFileSync(marker, "started")
}

const server = new McpServer(
	{ name: "headlesscode-test-server", version: "1.0.0" },
	{ capabilities: { tools: {}, resources: {} } },
)

server.registerTool(
	"reverse",
	{
		description: "Reverse a string",
		inputSchema: { text: z.string() },
	},
	async (args: { text: string }) => {
		return { content: [{ type: "text", text: [...args.text].reverse().join("") }] }
	},
)

server.registerTool(
	"capitalize",
	{
		description: "Capitalize a string (always fails — error-handling fixture)",
		inputSchema: { text: z.string() },
	},
	async () => {
		throw new Error("fixture capitalize is deliberately broken")
	},
)

server.registerResource(
	"greeting",
	"test://greeting",
	{ description: "A test greeting resource", mimeType: "text/plain" },
	async () => ({ contents: [{ uri: "test://greeting", mimeType: "text/plain", text: "hello from fixture" }] }),
)

const transport = new StdioServerTransport()
await server.connect(transport)

// The SDK's stdio transport does not close itself when stdin reaches EOF, so
// close it explicitly: client.dispose() ends the child's stdin, which fires
// this handler, which is what triggers transport.onclose (marker cleanup)
// below. Without this the marker would never be removed on a clean shutdown.
process.stdin.on("end", () => {
	void transport.close()
})

transport.onclose = () => {
	if (marker) {
		try {
			fs.rmSync(marker)
		} catch {
			// already gone
		}
	}
}
