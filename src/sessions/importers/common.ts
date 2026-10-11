import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import { TextDecoder } from "node:util"
import type { SessionMessage, SessionProvider } from "../types.js"

export const IMPORT_LIMITS = {
	bytes: 32 * 1024 * 1024,
	lines: 100_000,
	lineBytes: 1024 * 1024,
	entries: 10_000,
	depth: 8,
	jsonDepth: 18,
	opaqueBytes: 64 * 1024,
	messages: 50_000,
	archiveContentBytes: 12 * 1024 * 1024,
} as const

export interface ParsedImport {
	title: string
	sessionId?: string
	messages: SessionMessage[]
	warnings: string[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function safeString(value: unknown, max = 64 * 1024): string | undefined {
	if (typeof value !== "string") return undefined
	return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`
}

export function jsonDepth(value: unknown, depth = 0): number {
	if (depth > IMPORT_LIMITS.jsonDepth) return depth
	if (Array.isArray(value)) return value.reduce<number>((max, item) => Math.max(max, jsonDepth(item, depth + 1)), depth)
	if (isRecord(value)) return Object.values(value).reduce<number>((max, item) => Math.max(max, jsonDepth(item, depth + 1)), depth)
	return depth
}

export function opaque(type: string, value: unknown): SessionMessage["opaque"] {
	const sanitized = sanitizeOpaque(value)
	let bounded = sanitized
	try {
		const json = JSON.stringify(sanitized)
		if (json && Buffer.byteLength(json) > IMPORT_LIMITS.opaqueBytes) bounded = { truncated: json.slice(0, IMPORT_LIMITS.opaqueBytes), originalBytes: Buffer.byteLength(json) }
	} catch {
		bounded = "[unserializable]"
	}
	return [{ type, value: bounded }]
}

export function sanitizeOpaque(value: unknown, depth = 0): unknown {
	if (depth > IMPORT_LIMITS.jsonDepth) return "[nested content omitted]"
	if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitizeOpaque(item, depth + 1))
	if (isRecord(value)) {
		const safe: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const [key, item] of Object.entries(value).slice(0, 256)) {
			if (key === "__proto__" || /token|secret|credential|approval|permission|sandbox|reasoning|budget|auth|api[_-]?key/i.test(key)) continue
			safe[key] = sanitizeOpaque(item, depth + 1)
		}
		return safe
	}
	if (typeof value === "string") return safeString(value, IMPORT_LIMITS.opaqueBytes)
	return value
}

export function hashSource(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex")
}

export async function assertNoSymlinkPath(filePath: string): Promise<void> {
	const absolute = path.resolve(filePath)
	const parsed = path.parse(absolute)
	let current = parsed.root
	for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part)
		let info: Awaited<ReturnType<typeof fs.lstat>>
		try { info = await fs.lstat(current) } catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT" || (cause as NodeJS.ErrnoException).code === "ENOTDIR") return
			throw cause
		}
		if (info.isSymbolicLink()) throw new Error(`Import path contains a symlink: ${current}`)
	}
}

export async function readBoundedPrefix(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
	signal?.throwIfAborted()
	const absolute = path.resolve(filePath)
	await assertNoSymlinkPath(absolute)
	const noFollow = typeof fs.constants?.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
	const handle = await fs.open(absolute, fs.constants.O_RDONLY | noFollow)
	try {
		const before = await handle.stat()
		if (!before.isFile()) throw new Error(`Import metadata source is not a regular file: ${filePath}`)
		const buffer = Buffer.alloc(maxBytes)
		let offset = 0
		while (offset < maxBytes) {
			signal?.throwIfAborted()
			const { bytesRead } = await handle.read(buffer, offset, maxBytes - offset, offset)
			if (bytesRead === 0) break
			offset += bytesRead
		}
		const after = await handle.stat()
		const current = await fs.lstat(absolute)
		if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || after.dev !== before.dev || after.ino !== before.ino) throw new Error("Import metadata source changed while being read; retry discovery.")
		return buffer.subarray(0, offset)
	} finally { await handle.close() }
}

export async function readBoundedFile(filePath: string, signal?: AbortSignal): Promise<{ bytes: Buffer; warnings: string[] }> {
	signal?.throwIfAborted()
	const absolute = path.resolve(filePath)
	await assertNoSymlinkPath(absolute)
	const beforePath = await fs.lstat(absolute)
	if (beforePath.isSymbolicLink()) throw new Error(`Import source must not be a symlink: ${filePath}`)
	const noFollow = typeof fs.constants?.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
	const handle = await fs.open(absolute, fs.constants.O_RDONLY | noFollow)
	try {
		const info = await handle.stat()
		if (!info.isFile()) throw new Error(`Import source is not a regular file: ${filePath}`)
		if (info.dev !== beforePath.dev || info.ino !== beforePath.ino) throw new Error("Import source changed while it was being opened; retry the import.")
		if (info.size > IMPORT_LIMITS.bytes) throw new Error(`Import source exceeds the ${IMPORT_LIMITS.bytes} byte limit`)
		const bytes = Buffer.alloc(info.size)
		let offset = 0
		while (offset < bytes.length) {
			signal?.throwIfAborted()
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
			if (!bytesRead) break
			offset += bytesRead
		}
		if (offset !== info.size) throw new Error("Import source changed while it was being read; retry the import.")
		const after = await handle.stat()
		if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) throw new Error("Import source changed while it was being read; retry the import.")
		const currentPath = await fs.lstat(absolute)
		if (currentPath.isSymbolicLink() || currentPath.dev !== info.dev || currentPath.ino !== info.ino) throw new Error("Import source path changed while it was being read; retry the import.")
		new TextDecoder("utf-8", { fatal: true }).decode(bytes)
		return { bytes, warnings: [] }
	} finally {
		await handle.close()
	}
}

export function parseJsonLines(bytes: Buffer, warnings: string[]): unknown[] {
	const text = bytes.toString("utf8")
	const records: unknown[] = []
	let offset = 0
	let index = 0
	while (offset <= text.length && index < IMPORT_LIMITS.lines) {
		const newline = text.indexOf("\n", offset)
	const end = newline < 0 ? text.length : newline
	const line = text.slice(offset, end).replace(/\r$/, "")
		offset = newline < 0 ? text.length + 1 : newline + 1
		index++
		if (!line?.trim()) continue
		if (Buffer.byteLength(line) > IMPORT_LIMITS.lineBytes) {
			warnings.push(`Line ${index} exceeds the ${IMPORT_LIMITS.lineBytes} byte limit and was ignored.`)
			continue
		}
		try {
			const value: unknown = JSON.parse(line)
			if (jsonDepth(value) > IMPORT_LIMITS.jsonDepth) {
				warnings.push(`Line ${index} is too deeply nested and was ignored.`)
				continue
			}
			records.push(value)
		} catch {
			warnings.push(`Line ${index} is malformed JSON and was ignored.`)
		}
	}
	if (index >= IMPORT_LIMITS.lines && offset < text.length) warnings.push(`Source has more than ${IMPORT_LIMITS.lines} lines; remaining records were ignored.`)
	return records
}

export function normalizeRole(value: unknown): SessionMessage["role"] | undefined {
	if (value === "system" || value === "developer" || value === "user" || value === "assistant" || value === "tool") return value
	return undefined
}

export function titleFrom(pathname: string, fallback: string): string {
	const name = path.basename(pathname).replace(/\.(jsonl|json)$/i, "")
	return (name && name.length > 0 ? name : fallback).slice(0, 256)
}

export function uniqueWarnings(warnings: string[]): string[] {
	const unique = [...new Set(warnings)].map((warning) => warning.slice(0, 1024))
	if (unique.length <= 900) return unique
	return [...unique.slice(0, 899), `${unique.length - 899} additional import warnings were omitted.`]
}

export function providerFrom(value: string): SessionProvider | undefined {
	return value === "claude" || value === "codex" || value === "muse" ? value : undefined
}
