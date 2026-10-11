import type { ChatTool } from "../engine/types.js"

const manifestSchema = {
	type: ["object", "null"],
		properties: {
			schemaVersion: { type: "integer", enum: [1] },
			id: { type: "string" },
			kind: { type: "string", enum: ["skill", "tool", "mcp"] },
			description: { type: "string" },
			entrypoint: { type: "string" },
			inputSchema: { type: "object", additionalProperties: true },
		},
		required: ["schemaVersion", "id", "kind", "description"],
	additionalProperties: false,
} as const

/** Fixed model-facing management interface. Extension metadata never changes this schema. */
export const EXTENSION_MANAGE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "extension_manage",
		description:
			"Create, list, inspect, or validate workspace extensions. Create/validate require a manifest object and a files object mapping relative paths to UTF-8 text. Inspect requires an exact id and digest from list/create/validate; it never selects a moving latest revision. Results include immutable revision digests.",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["create", "list", "inspect", "validate"] },
				id: { type: ["string", "null"], description: "Extension id for inspect; otherwise null." },
				digest: { type: ["string", "null"], description: "Exact SHA-256 revision for inspect; otherwise null." },
				manifest: manifestSchema,
				files: { type: ["object", "null"], additionalProperties: { type: "string" } },
			},
			required: ["action", "id", "digest", "manifest", "files"],
			additionalProperties: false,
		},
	},
}

/** Fixed gateway interface for immutable skill, Node-tool, and MCP revisions. */
export const EXTENSION_CALL_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "extension_call",
		description:
			"Call an exact workspace extension revision by id and SHA-256 digest. Pass input as a JSON object. Skill calls return captured instructions and references; for MCP extensions, tool_name selects an advertised server tool. Leave tool_name null for skills and Node tools.",
		strict: false,
		parameters: {
			type: "object",
			properties: {
				id: { type: "string" },
				digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
				input: { type: "object", additionalProperties: true },
				tool_name: { type: ["string", "null"] },
			},
			required: ["id", "digest", "input", "tool_name"],
			additionalProperties: false,
		},
	},
}

const extensionToolNames = new Set(["extension_manage", "extension_call"])

/**
 * Add the fixed extension interfaces only when the current mode already
 * exposes both workspace editing and command execution. An explicit tool
 * allowlist can opt in by naming an interface; it is never broadened.
 */
export function appendExtensionTools(
	tools: ChatTool[],
	options: { canWrite: boolean; canExecute: boolean; explicitAllowlist: boolean; explicitToolNames?: readonly string[] },
): ChatTool[] {
	if (!options.canWrite || !options.canExecute) return tools
	const byName = new Map(tools.filter((tool) => tool.type === "function").map((tool) => [tool.function.name, tool]))
	const explicitNames = new Set(options.explicitToolNames ?? [])
	const additions: ChatTool[] = []
	for (const extensionTool of [EXTENSION_MANAGE_TOOL, EXTENSION_CALL_TOOL]) {
		const name = extensionTool.function.name
		if (options.explicitAllowlist) {
			if (explicitNames.has(name)) additions.push(extensionTool)
		} else if (!byName.has(name)) {
			additions.push(extensionTool)
		}
	}
	const filtered = options.explicitAllowlist ? tools.filter((tool) => tool.type !== "function" || !extensionToolNames.has(tool.function.name)) : tools
	return additions.length ? [...filtered, ...additions] : filtered
}

export function isExtensionToolName(name: string): boolean {
	return extensionToolNames.has(name)
}
