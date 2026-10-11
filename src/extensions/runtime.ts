import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

import { Client } from "@modelcontextprotocol/sdk/client"
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js"
import type { ToolContext } from "../engine/types.js"
import { checkCommand } from "../permissions/commands.js"
import { extensionBundleDigest, type ExtensionRevision } from "./registry.js"
import { BoundedStdioTransport, OwnedChildProcess, type OwnedProcessOptions } from "./bounded-stdio-transport.js"

export interface ExtensionRuntimeLimits {
	callTimeoutMs: number
	maxInputBytes: number
	maxOutputBytes: number
	maxProtocolBytes: number
	maxTools: number
	maxStderrBytes: number
}

export interface ExtensionDescription {
	id: string
	kind: ExtensionRevision["manifest"]["kind"]
	revision: string
	description: string
	inputSchema?: Record<string, unknown>
	tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }>
}

export interface ExtensionCallOptions {
	permissions: ToolContext["permissions"]
	signal?: AbortSignal
	toolName?: string
}

export interface SessionExtensionRuntimeOptions {
	workspaceRoot: string
	permissions: ToolContext["permissions"]
	limits?: Partial<ExtensionRuntimeLimits>
}

const DEFAULT_LIMITS: ExtensionRuntimeLimits = Object.freeze({
	callTimeoutMs: 30_000,
	maxInputBytes: 64 * 1024,
	maxOutputBytes: 256 * 1024,
	maxProtocolBytes: 512 * 1024,
	maxTools: 32,
	maxStderrBytes: 32 * 1024,
})
const HARD_LIMITS: ExtensionRuntimeLimits = Object.freeze({
	callTimeoutMs: 120_000,
	maxInputBytes: 256 * 1024,
	maxOutputBytes: 1024 * 1024,
	maxProtocolBytes: 2 * 1024 * 1024,
	maxTools: 64,
	maxStderrBytes: 128 * 1024,
})
const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_SKILL_REFERENCE_BYTES = 128 * 1024
const NODE_ADAPTER_PATH = fileURLToPath(new URL("./node-adapter.mjs", import.meta.url))
const deferMcpSchemaValidation = {
	getValidator: () => (input: unknown) => ({ valid: true, data: input, errorMessage: undefined }),
} as unknown as jsonSchemaValidator
let stageRevisionBarrierForTests: (() => Promise<void>) | undefined

interface StagedRevision {
	directory: string
	entrypoint?: string
	cleanup(): Promise<void>
}

function boundedLimits(input: Partial<ExtensionRuntimeLimits> | undefined): ExtensionRuntimeLimits {
	const limits = { ...DEFAULT_LIMITS, ...input }
	for (const key of Object.keys(HARD_LIMITS) as Array<keyof ExtensionRuntimeLimits>) {
		const value = limits[key]
		if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) throw new Error(`extension runtime ${key} is outside its hard bound`)
	}
	return limits
}

function jsonBytes(value: unknown, maxBytes: number, label: string): Buffer {
	if (!finiteJsonValue(value)) throw new Error(`${label} must contain only finite JSON values`)
	let encoded: string | undefined
	try { encoded = JSON.stringify(value) } catch { throw new Error(`${label} must be JSON serializable`) }
	if (encoded === undefined) throw new Error(`${label} must be JSON serializable`)
	const bytes = Buffer.from(encoded, "utf8")
	if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeded its ${maxBytes}-byte bound`)
	return bytes
}

function finiteJsonValue(value: unknown, seen = new Set<object>(), depth = 0): boolean {
	if (depth > 32) return false
	if (value === null || typeof value === "string" || typeof value === "boolean") return true
	if (typeof value === "number") return Number.isFinite(value)
	if (typeof value !== "object" || seen.has(value)) return false
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
	seen.add(value)
	let children: unknown[]
	if (Array.isArray(value)) {
		const keys = Reflect.ownKeys(value)
		if (keys.length !== value.length + 1 || !keys.includes("length") || Array.from({ length: value.length }, (_, index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			return descriptor !== undefined && descriptor.enumerable && Object.hasOwn(descriptor, "value")
		}).some((present) => !present)) {
			seen.delete(value)
			return false
		}
		children = value
	} else {
		const keys = Reflect.ownKeys(value)
		const validKeys = keys.every((key) => {
			if (typeof key !== "string") return false
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			return descriptor !== undefined && descriptor.enumerable && Object.hasOwn(descriptor, "value")
		})
		if (!validKeys) {
			seen.delete(value)
			return false
		}
		children = Object.values(value as Record<string, unknown>)
	}
	const valid = children.every((item) => finiteJsonValue(item, seen, depth + 1))
	seen.delete(value)
	return valid
}

function quoteShellArgument(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`
}

function assertCommandPermitted(command: string, permissions: ToolContext["permissions"], workspaceRoot: string): void {
	const refusal = checkCommand(command, permissions.allowedCommands, permissions.deniedCommands, { workspaceRoot })
	if (refusal) throw new Error(`extension execution denied by command permissions (${refusal.kind})`)
}

function childEnvironment(protocolFd?: number): Record<string, string> {
	const pathValue = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter)
	return { PATH: pathValue, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...(protocolFd === undefined ? {} : { HEADLESSCODE_EXTENSION_PROTOCOL_FD: String(protocolFd) }) }
}

function processOptions(entrypoint: string, workspaceRoot: string, adapter = false): OwnedProcessOptions {
	return {
		command: process.execPath,
		args: adapter ? [NODE_ADAPTER_PATH] : [entrypoint],
		cwd: workspaceRoot,
		env: childEnvironment(adapter ? 3 : undefined),
		stdio: adapter ? ["pipe", "ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
	}
}

function fixedCommand(entrypoint: string, adapter = false): string {
	return `node ${adapter ? `${quoteShellArgument(NODE_ADAPTER_PATH)} ` : ""}${quoteShellArgument(entrypoint)}`
}

function callSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
}

function assertOwnedProcessGroupSupported(platform: NodeJS.Platform): void {
	if (platform === "win32") throw new Error("executable extensions are unavailable on Windows because descendant process-tree teardown cannot be guaranteed")
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("extension operation was cancelled")
}

function safeRelativePath(value: string): boolean {
	return value.length > 0 && !path.posix.isAbsolute(value) && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."))
}

function validateRevision(revision: ExtensionRevision, workspaceRoot: string): void {
	if (!revision || !revision.manifest || typeof revision.digest !== "string" || !/^[a-f0-9]{64}$/.test(revision.digest)) throw new Error("extension revision identity is malformed")
	if (path.resolve(revision.workspaceRoot) !== path.resolve(workspaceRoot)) throw new Error("extension revision belongs to a different workspace")
	const expectedDirectory = path.resolve(workspaceRoot, ".agents", "headlesscode", "extensions", revision.manifest.id, revision.digest)
	if (path.resolve(revision.directory) !== expectedDirectory) throw new Error("extension revision directory does not match its pinned identity")
	const computedDigest = extensionBundleDigest({ manifest: revision.manifest, files: revision.files })
	if (computedDigest !== revision.digest) throw new Error("extension revision digest does not match its captured file map")
}

async function stageRevision(revision: ExtensionRevision, workspaceRoot: string, signal?: AbortSignal): Promise<StagedRevision> {
	validateRevision(revision, workspaceRoot)
	const extensionRoot = path.resolve(workspaceRoot, ".agents", "headlesscode", "extensions")
	if (await fs.realpath(extensionRoot) !== extensionRoot) throw new Error("extension staging root traverses a symlink")
	const stage = await fs.mkdtemp(path.join(extensionRoot, ".runtime-"))
	const directories = new Set<string>([stage])
	try {
		if (stageRevisionBarrierForTests) await stageRevisionBarrierForTests()
		if (signal) throwIfAborted(signal)
		for (const [relative, content] of Object.entries(revision.files)) {
			if (signal) throwIfAborted(signal)
			if (!safeRelativePath(relative)) throw new Error("extension bundle contains an unsafe file path")
			const destination = path.resolve(stage, relative)
			if (!destination.startsWith(`${stage}${path.sep}`)) throw new Error("extension file escaped its staging directory")
			const parent = path.dirname(destination)
			let cursor = stage
			for (const part of path.relative(stage, parent).split(path.sep).filter(Boolean)) {
				cursor = path.join(cursor, part)
				if (!directories.has(cursor)) {
					await fs.mkdir(cursor, { mode: 0o700 })
					directories.add(cursor)
				}
			}
			await fs.writeFile(destination, content, { encoding: "utf8", mode: 0o400, flag: "wx" })
			const actual = await fs.readFile(destination, "utf8")
			if (actual !== content) throw new Error("staged extension bytes differ from the captured revision")
		}
		for (const directory of [...directories].sort((a, b) => b.length - a.length)) await fs.chmod(directory, 0o500)
		const stagedFiles: Record<string, string> = Object.create(null) as Record<string, string>
		for (const relative of Object.keys(revision.files)) stagedFiles[relative] = await fs.readFile(path.join(stage, relative), "utf8")
		if (extensionBundleDigest({ manifest: revision.manifest, files: stagedFiles }) !== revision.digest) throw new Error("staged extension digest differs from its pinned revision")
		const entrypoint = revision.manifest.entrypoint ? path.join(stage, revision.manifest.entrypoint) : undefined
		return {
			directory: stage,
			...(entrypoint ? { entrypoint } : {}),
			cleanup: async () => {
				for (const directory of [...directories].sort((a, b) => a.length - b.length)) await fs.chmod(directory, 0o700).catch(() => undefined)
				await fs.rm(stage, { recursive: true, force: true })
			},
		}
	} catch (error) {
		for (const directory of [...directories].sort((a, b) => a.length - b.length)) await fs.chmod(directory, 0o700).catch(() => undefined)
		await fs.rm(stage, { recursive: true, force: true })
		throw error
	}
}

/**
 * Executes pinned extensions out of process with bounded JSON and an owned
 * process group on supported POSIX hosts. This is a same-user host process
 * boundary, not OS isolation; RSI callers must use the already-contained
 * worker guest. Executable extensions fail closed on Windows because this
 * runtime cannot guarantee descendant process-tree teardown there.
 */
export class SessionExtensionRuntime {
	readonly workspaceRoot: string
	readonly limits: ExtensionRuntimeLimits
	private readonly permissions: ToolContext["permissions"]
	private readonly children = new Set<OwnedChildProcess>()
	private readonly transports = new Set<BoundedStdioTransport>()
	private readonly operations = new Map<AbortController, Promise<unknown>>()
	private disposed = false
	private disposalPromise: Promise<void> | undefined

	constructor(options: SessionExtensionRuntimeOptions) {
		this.workspaceRoot = path.resolve(options.workspaceRoot)
		this.permissions = options.permissions
		this.limits = boundedLimits(options.limits)
	}

	describe(revision: ExtensionRevision): Promise<ExtensionDescription> {
		return this.runOperation(undefined, async (operationSignal) => {
			validateRevision(revision, this.workspaceRoot)
			const base: ExtensionDescription = {
				id: revision.manifest.id,
				kind: revision.manifest.kind,
				revision: revision.digest,
				description: revision.manifest.description,
				...(revision.manifest.inputSchema ? { inputSchema: revision.manifest.inputSchema } : {}),
			}
			if (revision.manifest.kind !== "mcp") return base
			assertOwnedProcessGroupSupported(process.platform)
			const staged = await stageRevision(revision, this.workspaceRoot, operationSignal)
			try {
				throwIfAborted(operationSignal)
				if (!staged.entrypoint) throw new Error("MCP extension has no entrypoint")
				const signal = callSignal(operationSignal, this.limits.callTimeoutMs)
				const info = await this.connectMcp(staged.entrypoint, signal, this.permissions)
				try {
					const tools = await info.client.listTools({}, this.requestOptions(info.signal))
					return { ...base, tools: this.validateMcpTools(tools.tools) }
				} finally { await this.closeMcp(info) }
			} finally { await staged.cleanup() }
		})
	}

	call(revision: ExtensionRevision, input: unknown, options: ExtensionCallOptions): Promise<unknown> {
		return this.runOperation(options.signal, async (operationSignal) => {
			const signal = callSignal(operationSignal, this.limits.callTimeoutMs)
			const scopedOptions = { ...options, signal }
			jsonBytes(input, this.limits.maxInputBytes, "extension input")
			validateRevision(revision, this.workspaceRoot)
			if (revision.manifest.kind === "skill") return this.callSkill(revision, input)
			assertOwnedProcessGroupSupported(process.platform)
			const staged = await stageRevision(revision, this.workspaceRoot, operationSignal)
			try {
				throwIfAborted(operationSignal)
				if (!staged.entrypoint) throw new Error("extension revision has no executable entrypoint")
				if (revision.manifest.kind === "tool") return await this.callTool(staged.entrypoint, input, revision.manifest.inputSchema, scopedOptions.permissions, signal)
				if (revision.manifest.kind === "mcp") {
					if (!options.toolName) throw new Error("MCP extension call requires an advertised tool name")
					return await this.callMcp(staged.entrypoint, input, options.toolName, scopedOptions.permissions, signal)
				}
				throw new Error("extension kind is unsupported")
			} finally { await staged.cleanup() }
		})
	}

	dispose(): Promise<void> {
		if (this.disposalPromise) return this.disposalPromise
		this.disposed = true
		const controllers = Array.from(this.operations.keys())
		const operations = Array.from(this.operations.values())
		this.disposalPromise = Promise.resolve().then(async () => {
			for (const controller of controllers) controller.abort()
			await Promise.allSettled(operations)
			await Promise.all([
				...Array.from(this.transports, (transport) => transport.close()),
				...Array.from(this.children, (child) => child.stop()),
			])
			this.transports.clear()
			this.children.clear()
		})
		return this.disposalPromise
	}

	private async callSkill(revision: ExtensionRevision, input: unknown): Promise<unknown> {
		if (input !== undefined && input !== null && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input as object).length > 0)) throw new Error("skill extension accepts no call arguments")
		const instructions = revision.files["SKILL.md"]
		if (typeof instructions !== "string") throw new Error("skill revision is missing SKILL.md")
		const references = Object.entries(revision.files).filter(([name]) => name !== "SKILL.md")
		let referenceBytes = 0
		const boundedReferences = references.map(([relativePath, content]) => {
			referenceBytes += Buffer.byteLength(content, "utf8")
			if (referenceBytes > MAX_SKILL_REFERENCE_BYTES) throw new Error("skill references exceeded their output bound")
			return { path: relativePath, content }
		})
		const output = { instructions, references: boundedReferences }
		jsonBytes(output, this.limits.maxOutputBytes, "skill extension output")
		return output
	}

	private async callTool(entrypoint: string, input: unknown, inputSchema: Record<string, unknown> | undefined, permissions: ToolContext["permissions"], signal: AbortSignal): Promise<unknown> {
		assertCommandPermitted(fixedCommand(entrypoint, true), permissions, this.workspaceRoot)
		if (!inputSchema) throw new Error("native tool extension has no input schema")
		const callId = randomUUID()
		return await this.runAdapter({ operation: "invoke", callId, entrypoint: pathToFileURL(entrypoint).href, input, inputSchema, maxOutputBytes: this.limits.maxOutputBytes }, signal)
	}

	private async callMcp(entrypoint: string, input: unknown, toolName: string, permissions: ToolContext["permissions"], signal: AbortSignal): Promise<unknown> {
		const info = await this.connectMcp(entrypoint, signal, permissions)
		try {
			const listed = await info.client.listTools({}, this.requestOptions(info.signal))
			const tools = this.validateMcpTools(listed.tools)
			const selected = tools.find((tool) => tool.name === toolName)
			if (!selected) throw new Error("MCP tool name was not advertised by this extension")
			const inputValidation = await this.validateInChild(selected.inputSchema, input, info.signal)
			if (!inputValidation.valid) throw new Error(`MCP tool input does not match its schema: ${inputValidation.error ?? "schema mismatch"}`)
			const result = await info.client.callTool({ name: selected.name, arguments: input as Record<string, unknown> }, undefined, this.requestOptions(info.signal))
			if (result.isError === true) throw new Error("MCP extension tool returned an error")
			const boundedResult = JSON.parse(jsonBytes(result, this.limits.maxOutputBytes, "MCP output").toString("utf8")) as unknown
			if (selected.outputSchema) {
				if (!result.structuredContent) throw new Error("MCP tool declared outputSchema but returned no structuredContent")
				const outputValidation = await this.validateInChild(selected.outputSchema, result.structuredContent, info.signal)
				if (!outputValidation.valid) throw new Error(`MCP tool output does not match its schema: ${outputValidation.error ?? "schema mismatch"}`)
			}
			return boundedResult
		} finally { await this.closeMcp(info) }
	}

	private async validateInChild(schema: Record<string, unknown>, value: unknown, signal: AbortSignal): Promise<{ valid: boolean; error?: string }> {
		jsonBytes(schema, MAX_SCHEMA_BYTES, "extension schema")
		const result = await this.runAdapter({ operation: "validate", callId: randomUUID(), schema, value }, signal) as { valid?: unknown; error?: unknown }
		if (typeof result.valid !== "boolean") throw new Error("extension schema validator returned malformed output")
		return { valid: result.valid, ...(typeof result.error === "string" ? { error: result.error.slice(0, 1000) } : {}) }
	}

	private async runAdapter(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		if (signal.aborted) throw new Error("extension call was cancelled")
		const adapterInputLimit = Math.min(384 * 1024, this.limits.maxInputBytes + MAX_SCHEMA_BYTES + 8192)
		const input = jsonBytes(request, adapterInputLimit, "extension adapter input")
		let response: unknown
		let responseCount = 0
		let child: OwnedChildProcess | undefined
		const resultPromise = new Promise<unknown>((resolve, reject) => {
			child = new OwnedChildProcess(processOptions(NODE_ADAPTER_PATH, this.workspaceRoot, true), {
				signal,
				timeoutMs: this.limits.callTimeoutMs,
				maxProtocolBytes: Math.min(this.limits.maxProtocolBytes, this.limits.maxOutputBytes + 2048),
				maxStderrBytes: this.limits.maxStderrBytes,
				protocolFd: 3,
				onFailure: reject,
				onExit: () => { if (child) this.children.delete(child) },
				onProtocol: (line) => {
					responseCount++
					if (responseCount !== 1) throw new Error("extension adapter returned duplicate protocol results")
					let parsed: { ok?: unknown; result?: unknown; callId?: unknown; error?: unknown }
					try { parsed = JSON.parse(line) as typeof parsed } catch { throw new Error("extension adapter returned malformed JSON") }
					if (parsed.ok !== true) throw new Error(typeof parsed.error === "string" ? parsed.error.slice(0, 500) : "extension adapter failed")
				if (parsed.callId !== request.callId) throw new Error("extension adapter response identity did not match its request")
				if (!finiteJsonValue(parsed.result)) throw new Error("extension adapter result is not finite JSON")
				response = JSON.parse(jsonBytes(parsed.result, this.limits.maxOutputBytes, "extension output").toString("utf8")) as unknown
				child?.markProtocolComplete()
				},
			})
			this.children.add(child)
			void child.waitForSpawn().then(async () => {
				await child?.sendProtocol(`${input.toString("utf8")}\n`)
				child?.endInput()
				const exited = await child?.waitForClose(this.limits.callTimeoutMs)
				if (!exited) throw new Error("extension adapter did not exit within its deadline")
				if (child?.exitCode !== 0) throw child?.error ?? new Error("extension adapter exited unsuccessfully")
				if (responseCount !== 1) throw new Error("extension adapter returned no result")
				child?.markProtocolComplete()
				resolve(response)
			}).catch((error: unknown) => reject(error instanceof Error ? error : new Error("extension adapter failed")))
		})
		try { return await resultPromise } finally { if (child) { await child.stop(); this.children.delete(child) } }
	}

	private async connectMcp(entrypoint: string, signal: AbortSignal, permissions: ToolContext["permissions"]): Promise<{ client: Client; transport: BoundedStdioTransport; signal: AbortSignal }> {
		if (signal.aborted) throw new Error("extension call was cancelled")
		assertCommandPermitted(fixedCommand(entrypoint), permissions, this.workspaceRoot)
		const transport = new BoundedStdioTransport(processOptions(entrypoint, this.workspaceRoot), {
			maxBufferBytes: this.limits.maxProtocolBytes,
			timeoutMs: this.limits.callTimeoutMs,
			signal,
			maxStderrBytes: this.limits.maxStderrBytes,
		})
		const client = new Client({ name: "headlesscode-extension-runtime", version: "1" }, { jsonSchemaValidator: deferMcpSchemaValidation })
		this.transports.add(transport)
		try {
			await client.connect(transport, { signal, timeout: this.limits.callTimeoutMs, maxTotalTimeout: this.limits.callTimeoutMs })
			const server = client.getServerVersion()
			if (!server || typeof server.name !== "string" || server.name.length < 1 || server.name.length > 128 || typeof server.version !== "string" || server.version.length < 1 || server.version.length > 128) throw new Error("MCP server handshake identity is malformed")
			return { client, transport, signal }
		} catch (error) {
			await transport.close()
			this.transports.delete(transport)
			throw error
		}
	}

	private validateMcpTools(tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }>): Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }> {
		if (!Array.isArray(tools) || tools.length < 1 || tools.length > this.limits.maxTools) throw new Error("MCP server advertised an unsupported tool count")
		const names = new Set<string>()
		let schemasBytes = 0
		for (const tool of tools) {
			if (!tool || typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || names.has(tool.name)) throw new Error("MCP server advertised invalid or duplicate tool names")
			names.add(tool.name)
			if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) throw new Error("MCP tool input schema is malformed")
			schemasBytes += jsonBytes(tool.inputSchema, MAX_SCHEMA_BYTES, "MCP tool schema").byteLength
			if (tool.outputSchema) schemasBytes += jsonBytes(tool.outputSchema, MAX_SCHEMA_BYTES, "MCP output schema").byteLength
			if (schemasBytes > MAX_SCHEMA_BYTES) throw new Error("MCP tool schemas exceed their aggregate bound")
		}
		return tools
	}

	private requestOptions(signal: AbortSignal): { signal: AbortSignal; timeout: number; maxTotalTimeout: number } {
		return { signal, timeout: this.limits.callTimeoutMs, maxTotalTimeout: this.limits.callTimeoutMs }
	}

	private async closeMcp(info: { client: Client; transport: BoundedStdioTransport }): Promise<void> {
		try { await info.client.close() } finally {
			await info.transport.close()
			this.transports.delete(info.transport)
		}
	}

	private runOperation<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.disposed) return Promise.reject(new Error("extension runtime has been disposed"))
		const controller = new AbortController()
		const abort = () => controller.abort()
		if (signal?.aborted) controller.abort()
		else signal?.addEventListener("abort", abort, { once: true })
		const task = Promise.resolve().then(() => {
			throwIfAborted(controller.signal)
			return operation(controller.signal)
		})
		const tracked = task.finally(() => {
			this.operations.delete(controller)
			signal?.removeEventListener("abort", abort)
		})
		this.operations.set(controller, tracked)
		return tracked
	}
}

export const extensionRuntimeTestHooks = Object.freeze({
	validateRevision,
	fixedCommand,
	childEnvironment,
	stageRevision,
	assertOwnedProcessGroupSupported,
	setStageRevisionBarrierForTests: (barrier?: () => Promise<void>) => { stageRevisionBarrierForTests = barrier },
})
