import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { projectKeyFor, projectStoreRoot, resolveProjectIdentity } from "../project-store.js"
import type { CreateSessionInput, SessionArchive, SessionMessage, SessionSummary } from "./types.js"

export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_MESSAGES = 50_000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ROLES = new Set(["system", "developer", "user", "assistant", "tool"])

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(message: string): never { throw new Error(`session archive: ${message}`) }
function validId(id: string): void { if (!ID.test(id)) fail("invalid session ID") }
function text(value: unknown, name: string, max = 2 * 1024 * 1024): void {
	if (typeof value !== "string" || value.length > max) fail(`invalid ${name}`)
}
function timestamp(value: unknown, name: string): void {
	text(value, name, 64)
	if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) fail(`invalid ${name}`)
}
function boundedJson(value: unknown, depth = 0): void {
	if (depth > 24) fail("JSON nesting exceeds 24 levels")
	if (value === null || typeof value === "boolean") return
	if (typeof value === "number" && Number.isFinite(value)) return
	if (typeof value === "string") { text(value, "JSON string"); return }
	if (Array.isArray(value)) {
		if (value.length > MAX_MESSAGES) fail("JSON array too large")
		for (const item of value) boundedJson(item, depth + 1)
		return
	}
	if (record(value)) {
		for (const [key, item] of Object.entries(value)) {
			text(key, "JSON key", 1024)
			boundedJson(item, depth + 1)
		}
		return
	}
	fail("content must be serializable JSON")
}

export function validateMessages(value: unknown): asserts value is SessionMessage[] {
	if (!Array.isArray(value) || value.length > MAX_MESSAGES) fail("invalid messages")
	for (const message of value) {
		if (!record(message) || typeof message.role !== "string" || !ROLES.has(message.role)) fail("invalid message role")
		if (message.content !== null) text(message.content, "message content")
		if (message.timestamp !== undefined) timestamp(message.timestamp, "message timestamp")
		if (message.toolCallId !== undefined) text(message.toolCallId, "tool call ID", 1024)
		if (message.toolCalls !== undefined) {
			if (!Array.isArray(message.toolCalls) || message.toolCalls.length > 256) fail("invalid tool calls")
			for (const call of message.toolCalls) {
				if (!record(call)) fail("invalid tool call")
				text(call.id, "tool call ID", 1024)
				text(call.name, "tool name", 1024)
				text(call.arguments, "tool arguments")
			}
		}
		if (message.opaque !== undefined) {
			if (!Array.isArray(message.opaque) || message.opaque.length > 256) fail("invalid opaque content")
			for (const item of message.opaque) {
				if (!record(item)) fail("invalid opaque item")
				text(item.type, "opaque type", 1024)
				boundedJson(item.value)
			}
		}
	}
}

export function validateArchive(value: unknown): asserts value is SessionArchive {
	if (!record(value) || value.version !== 1) fail("unsupported archive version")
	text(value.id, "session ID", 36)
	validId(String(value.id))
	if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) fail("invalid revision")
	text(value.workspaceRoot, "workspace", 8192)
	if (!path.isAbsolute(String(value.workspaceRoot))) fail("workspace must be absolute")
	text(value.title, "title", 256)
	timestamp(value.createdAt, "created timestamp")
	timestamp(value.updatedAt, "updated timestamp")
	validateMessages(value.messages)
	if (!Array.isArray(value.warnings) || value.warnings.length > 1000) fail("invalid warnings")
	for (const warning of value.warnings) text(warning, "warning", 8192)
	if (value.provenance !== undefined) {
		const p = value.provenance
		if (!record(p) || !["headlesscode", "claude", "codex", "muse"].includes(String(p.provider))) fail("invalid provenance provider")
		for (const key of ["sessionId", "sourcePath", "parentSessionId"] as const) if (p[key] !== undefined) text(p[key], key, 8192)
		if (p.sha256 !== undefined && (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256))) fail("invalid source digest")
		if (p.importedAt !== undefined) timestamp(p.importedAt, "import timestamp")
	}
	boundedJson(value)
}

function encoded(archive: SessionArchive): string {
	validateArchive(archive)
	const json = JSON.stringify(archive, null, 2) + "\n"
	if (Buffer.byteLength(json) > MAX_ARCHIVE_BYTES) fail("record exceeds 16 MiB")
	return json
}

async function checkPath(directory: string, create: boolean): Promise<boolean> {
	const absolute = path.resolve(directory)
	const components = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean)
	let cursor = path.parse(absolute).root
	for (const component of components) {
		cursor = path.join(cursor, component)
		let stat
		try { stat = await fsp.lstat(cursor) } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			if (!create) return false
			try { await fsp.mkdir(cursor, { mode: 0o700 }) } catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError
			}
			stat = await fsp.lstat(cursor)
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) fail("storage path must contain real directories only")
	}
	return true
}

export class SessionStore {
	readonly directory: string
	readonly workspaceRoot: string
	private readonly onWarning?: (message: string) => void

	constructor(workspaceRoot: string, options: { directory?: string; onWarning?: (message: string) => void } = {}) {
		this.workspaceRoot = path.resolve(workspaceRoot)
		this.directory = options.directory ? path.resolve(options.directory) : path.join(projectStoreRoot(), "projects", projectKeyFor(resolveProjectIdentity(workspaceRoot).keySource), "sessions")
		this.onWarning = options.onWarning ?? ((message) => process.stderr.write(`${message}\n`))
	}

	async create(input: CreateSessionInput = {}): Promise<SessionArchive> {
		const now = new Date().toISOString()
		const archive: SessionArchive = { version: 1, id: randomUUID(), revision: 0, workspaceRoot: this.workspaceRoot, title: input.title ?? "New session", createdAt: now, updatedAt: now, messages: input.messages ?? [], warnings: input.warnings ?? [], ...(input.provenance ? { provenance: input.provenance } : {}) }
		const json = encoded(archive)
		await this.withLock(archive.id, async () => {
			try { await fsp.lstat(this.file(archive.id)); fail("session already exists") } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
			await this.replace(archive.id, json)
		})
		return JSON.parse(json) as SessionArchive
	}

	async load(id: string): Promise<SessionArchive> {
		validId(id)
		await checkPath(this.directory, false)
		const handle = await fsp.open(this.file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
		try {
			const stat = await handle.stat()
			if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ARCHIVE_BYTES) fail("unsafe or oversized record")
			const buffer = Buffer.alloc(stat.size + 1)
			let count = 0
			while (count < buffer.length) {
				const read = await handle.read(buffer, count, buffer.length - count, count)
				if (read.bytesRead === 0) break
				count += read.bytesRead
			}
			const after = await handle.stat()
			if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("record changed during read; retry")
			const archive: unknown = JSON.parse(buffer.subarray(0, count).toString("utf8"))
			validateArchive(archive)
			if (archive.id !== id) fail("record ID does not match filename")
			return archive
		} finally { await handle.close() }
	}

	async list(): Promise<SessionSummary[]> {
		if (!await checkPath(this.directory, false)) return []
		const names = await fsp.readdir(this.directory)
		if (names.length > MAX_MESSAGES) fail("too many session directory entries")
		const summaries: SessionSummary[] = []
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue
			const id = name.slice(0, -5)
			try {
				const archive = await this.load(id)
				summaries.push({ id, title: archive.title, workspaceRoot: archive.workspaceRoot, createdAt: archive.createdAt, updatedAt: archive.updatedAt, messageCount: archive.messages.length, provider: archive.provenance?.provider ?? "headlesscode" })
			} catch { this.onWarning?.(`Skipped unreadable session record ${ID.test(id) ? id : "with an invalid filename"}`) }
		}
		return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
	}

	async save(archive: SessionArchive, expectedRevision: number): Promise<SessionArchive> {
		encoded(archive)
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || archive.revision !== expectedRevision) fail("invalid expected revision")
		return this.withLock(archive.id, async () => {
			const previous = await this.load(archive.id)
			if (previous.revision !== expectedRevision) fail("revision conflict; reload the session before saving")
			if (archive.workspaceRoot !== previous.workspaceRoot || archive.createdAt !== previous.createdAt || JSON.stringify(archive.provenance) !== JSON.stringify(previous.provenance)) fail("workspace, creation timestamp and provenance are immutable")
			const next = { ...archive, revision: expectedRevision + 1, updatedAt: new Date().toISOString() }
			const json = encoded(next)
			await this.replace(archive.id, json)
			return JSON.parse(json) as SessionArchive
		})
	}

	async fork(id: string): Promise<SessionArchive> {
		const previous = await this.load(id)
		return this.create({ title: previous.title, messages: previous.messages, warnings: previous.warnings, provenance: { ...(previous.provenance ?? { provider: "headlesscode" as const }), parentSessionId: id } })
	}

	private file(id: string): string { validId(id); return path.join(this.directory, `${id}.json`) }

	private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
		validId(id)
		await checkPath(this.directory, true)
		await fsp.chmod(this.directory, 0o700)
		const lock = path.join(this.directory, `${id}.lock`)
		let handle
		try { handle = await fsp.open(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600) } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("session writer is busy; retry after it finishes (inspect a leftover lock after a crashed writer)")
			throw error
		}
		try { return await operation() } finally { await handle.close(); await fsp.unlink(lock) }
	}

	private async replace(id: string, json: string): Promise<void> {
		const target = this.file(id)
		try {
			const stat = await fsp.lstat(target)
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("unsafe record destination")
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
		const temporary = path.join(this.directory, `.${id}.${randomUUID()}.part`)
		const handle = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
		try {
			try { await handle.writeFile(json, "utf8"); await handle.sync() } finally { await handle.close() }
			await fsp.rename(temporary, target)
			const directory = await fsp.open(this.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
			try { await directory.sync() } finally { await directory.close() }
		} finally { await fsp.unlink(temporary).catch(() => undefined) }
	}
}
