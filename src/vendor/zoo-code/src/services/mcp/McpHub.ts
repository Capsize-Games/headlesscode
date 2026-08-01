/**
 * SHIM — replaces zoo-code/src/services/mcp/McpHub.ts.
 *
 * The real McpHub manages MCP server connections through the VS Code API
 * (SSE/stdio transports, global vs project config, connection lifecycle). A
 * headless harness has no MCP servers in Phase 1. This stub satisfies the type
 * surface used by the vendored prompt sections (capabilities.ts, system.ts)
 * and native-tool schemas (mcp_server.ts): `getServers()` and the server/tool
 * shapes those files read. Wiring real MCP transports is deferred.
 */

export interface McpToolLike {
	name: string
	description?: string
	inputSchema?: unknown
	enabledForPrompt?: boolean
}

export interface McpServerLike {
	name: string
	tools?: McpToolLike[]
}

export class McpHub {
	private servers: McpServerLike[]

	constructor(servers: McpServerLike[] = []) {
		this.servers = servers
	}

	getServers(): McpServerLike[] {
		return this.servers
	}

	dispose(): void {}
}
