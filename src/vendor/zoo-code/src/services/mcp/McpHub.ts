/**
 * Headless MCP client hub.
 *
 * The upstream VS Code hub is replaced by this runtime-neutral client. It
 * reads only the user-owned configuration path, avoiding execution of MCP
 * commands supplied by an untrusted workspace.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { buildMcpToolName, normalizeMcpToolName, toolNamesMatch } from "../../utils/mcp-name.js"

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

interface StdioServerConfig {
	type?: "stdio"
	command: string
	args?: string[]
	cwd?: string
	env?: Record<string, string>
}

interface HttpServerConfig {
	type: "http" | "streamable-http"
	url: string
	headers?: Record<string, string>
}

type ServerConfig = StdioServerConfig | HttpServerConfig

interface ConnectedServer extends McpServerLike {
	client: Client
	toolNames: Set<string>
}

interface McpConfig {
	mcpServers?: Record<string, ServerConfig>
}

const DEFAULT_CONFIG = resolve(homedir(), ".config/capsize-agent/mcp.json")
const MAX_SERVERS = 12
const MAX_TOOLS_PER_SERVER = 100

function expandEnvironment(value: string): string {
	return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => process.env[key] ?? "")
}

function expandRecord(values: Record<string, string> = {}): Record<string, string> {
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandEnvironment(value)]))
}

function isHttpConfig(config: ServerConfig): config is HttpServerConfig {
	return config.type === "http" || config.type === "streamable-http"
}

function parseConfig(raw: string): McpConfig {
	const parsed: unknown = JSON.parse(raw)
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("MCP config must be a JSON object")
	}
	const servers = (parsed as McpConfig).mcpServers
	if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
		throw new Error("mcpServers must be an object")
	}
	return parsed as McpConfig
}

/** Runtime connections and tool-call routing for one HeadlessCode session. */
export class McpHub {
	private readonly servers: ConnectedServer[] = []
	private readonly errors: string[] = []
	private closed = false

	static async connect(configPath = process.env.HEADLESSCODE_MCP_CONFIG ?? DEFAULT_CONFIG): Promise<McpHub> {
		const hub = new McpHub()
		let raw: string
		try {
			raw = await readFile(configPath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return hub
			hub.errors.push(`Could not read ${configPath}: ${String(error)}`)
			return hub
		}

		try {
			const config = parseConfig(raw)
			const entries = Object.entries(config.mcpServers ?? {})
			if (entries.length > MAX_SERVERS) throw new Error(`At most ${MAX_SERVERS} MCP servers are allowed`)
			for (const [name, server] of entries) await hub.connectServer(name, server)
		} catch (error) {
			hub.errors.push(`Invalid MCP configuration: ${String(error)}`)
		}
		return hub
	}

	private async connectServer(name: string, config: ServerConfig): Promise<void> {
		const client = new Client({ name: "headlesscode", version: "1.2.2" })
		try {
			if (isHttpConfig(config)) {
				const transport = new StreamableHTTPClientTransport(new URL(config.url), {
					requestInit: { headers: expandRecord(config.headers) },
				})
				await client.connect(transport)
			} else {
				if (!config.command?.trim()) throw new Error("stdio server requires a command")
				const transport = new StdioClientTransport({
					command: expandEnvironment(config.command),
					args: (config.args ?? []).map(expandEnvironment),
					cwd: config.cwd ? expandEnvironment(config.cwd) : undefined,
					env: expandRecord(config.env),
					stderr: "pipe",
				})
				await client.connect(transport)
			}
			const result = await client.listTools()
			if (result.tools.length > MAX_TOOLS_PER_SERVER) {
				throw new Error(`Server exposes more than ${MAX_TOOLS_PER_SERVER} tools`)
			}
			this.servers.push({
				name,
				client,
				tools: result.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
				})),
				toolNames: new Set(result.tools.map((tool) => tool.name)),
			})
		} catch (error) {
			this.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
			await client.close().catch(() => undefined)
		}
	}

	getServers(): McpServerLike[] {
		return this.servers
	}

	getConnectionErrors(): string[] {
		return [...this.errors]
	}

	async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
		const server = this.servers.find((candidate) => candidate.name === serverName)
		if (!server || !server.toolNames.has(toolName)) {
			throw new Error(`MCP tool is unavailable: ${serverName}/${toolName}`)
		}
		const result = await server.client.callTool({ name: toolName, arguments: args })
		const content: unknown = result.content
		const text = Array.isArray(content)
			? content.map((item: unknown) => {
					if (typeof item !== "object" || item === null) return "[non-text result]"
					const block = item as { type?: unknown; text?: unknown }
					return block.type === "text" && typeof block.text === "string"
						? block.text
						: `[${String(block.type ?? "unknown")} result]`
				}).join("\n")
			: ""
		if (result.isError) throw new Error(text || "MCP tool returned an error")
		if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
		return text || "MCP tool returned no text"
	}

	async callFunctionTool(functionName: string, args: Record<string, unknown>): Promise<string> {
		const normalized = normalizeMcpToolName(functionName)
		for (const server of this.servers) {
			for (const toolName of server.toolNames) {
				if (toolNamesMatch(buildMcpToolName(server.name, toolName), normalized)) {
					return this.callTool(server.name, toolName, args)
				}
			}
		}
		throw new Error(`MCP tool is unavailable: ${functionName}`)
	}

	async dispose(): Promise<void> {
		if (this.closed) return
		this.closed = true
		await Promise.all(this.servers.map((server) => server.client.close().catch(() => undefined)))
		this.servers.length = 0
	}
}
