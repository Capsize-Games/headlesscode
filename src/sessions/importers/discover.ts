import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SessionProvider } from "../types.js"
import { assertNoSymlinkPath, IMPORT_LIMITS, isRecord, readBoundedPrefix } from "./common.js"

export interface DiscoveredImport {
	provider: Exclude<SessionProvider, "headlesscode">
	file: string
	sessionId?: string
	modifiedAt: string
	bytes: number
}

export interface DiscoverOptions {
	workspaceRoot: string
	sourceRoot?: string
	all?: boolean
	signal?: AbortSignal
}

function defaultRoot(provider: Exclude<SessionProvider, "headlesscode">): string {
	const home = os.homedir()
	if (provider === "claude") return path.join(home, ".claude", "projects")
	if (provider === "codex") return path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions")
	const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
	return path.join(dataHome, "muse", "sessions")
}

function claudeWorkspaceRoot(root: string, workspaceRoot: string): string {
	const encoded = path.resolve(workspaceRoot).replace(/[:/\\]/g, "-")
	return path.join(root, encoded)
}

async function codexCwd(file: string): Promise<string | undefined> {
	try {
		const prefix = await readBoundedPrefix(file, IMPORT_LIMITS.lineBytes)
		const line = prefix.toString("utf8").split(/\r?\n/, 1)[0]
		const record: unknown = JSON.parse(line)
		if (!isRecord(record) || record.type !== "session_meta" || !isRecord(record.payload)) return undefined
		return typeof record.payload.cwd === "string" ? record.payload.cwd : undefined
	} catch { return undefined }
}

async function claudeCwd(file: string): Promise<string | undefined> {
	try {
		const prefix = await readBoundedPrefix(file, 128 * 1024)
		const text = prefix.toString("utf8")
		for (const line of text.split(/\r?\n/)) {
			if (!line || Buffer.byteLength(line) > IMPORT_LIMITS.lineBytes) continue
			let record: unknown
			try { record = JSON.parse(line) } catch { continue }
			if (!isRecord(record) || (record.type !== "user" && record.type !== "assistant") || typeof record.sessionId !== "string") continue
			if (typeof record.cwd === "string") return record.cwd
		}
	} catch { return undefined }
	return undefined
}

export async function discoverImportFiles(provider: Exclude<SessionProvider, "headlesscode">, options: DiscoverOptions): Promise<DiscoveredImport[]> {
	if (provider !== "claude" && provider !== "codex" && provider !== "muse") throw new Error(`Unsupported discovery provider: ${String(provider)}`)
	if (provider === "muse" && !options.all) throw new Error("Muse workspace metadata discovery is not supported by this importer; use --all with an explicit Muse source root, or import a selected file with --file.")
	if (provider === "muse" && options.all && !options.sourceRoot) throw new Error("Muse discovery with --all requires an explicit --source-root; otherwise import a selected file with --file.")
	options.signal?.throwIfAborted()
	const root = path.resolve(options.sourceRoot ?? defaultRoot(provider))
	const scopedRoot = provider === "claude" && !options.all && !options.sourceRoot ? claudeWorkspaceRoot(root, options.workspaceRoot) : root
	const results: DiscoveredImport[] = []
	let visited = 0
	let capped = false
	const workspace = path.resolve(options.workspaceRoot)
	const walk = async (directory: string, depth: number): Promise<void> => {
		options.signal?.throwIfAborted()
		if (depth > IMPORT_LIMITS.depth || visited >= IMPORT_LIMITS.entries) { capped = true; return }
		try {
			await assertNoSymlinkPath(directory)
			const stat = await fs.lstat(directory)
			if (stat.isSymbolicLink() || !stat.isDirectory()) return
		} catch { return }
		let directoryHandle: Awaited<ReturnType<typeof fs.opendir>>
		try { directoryHandle = await fs.opendir(directory) } catch { return }
		try {
			for await (const entry of directoryHandle) {
				options.signal?.throwIfAborted()
				if (++visited > IMPORT_LIMITS.entries) { capped = true; return }
				if (entry.isSymbolicLink()) continue
				const file = path.join(directory, entry.name)
				if (entry.isDirectory()) { await walk(file, depth + 1); continue }
				if (!entry.isFile() || !(entry.name.endsWith(".jsonl") || (provider === "muse" && entry.name.endsWith(".json")))) continue
				try {
					await assertNoSymlinkPath(file)
					const info = await fs.lstat(file)
					if (info.isSymbolicLink() || !info.isFile() || info.size > IMPORT_LIMITS.bytes) continue
					if (provider === "claude" && options.sourceRoot && !options.all) {
						const cwd = await claudeCwd(file)
						if (!cwd || path.resolve(cwd) !== workspace) continue
					}
					if (provider === "codex" && !options.all) {
						const cwd = await codexCwd(file)
						if (!cwd || path.resolve(cwd) !== workspace) continue
					}
					results.push({ provider, file, modifiedAt: info.mtime.toISOString(), bytes: info.size })
				} catch { /* entries can disappear during discovery */ }
			}
		} catch (cause) {
			if (options.signal?.aborted) options.signal.throwIfAborted()
			throw cause
		}
	}
	try { await assertNoSymlinkPath(scopedRoot) } catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT" && (cause as NodeJS.ErrnoException).code !== "ENOTDIR") throw cause
	}
	await walk(scopedRoot, 0)
	if (capped) throw new Error(`Discovery reached its ${IMPORT_LIMITS.entries} entry or ${IMPORT_LIMITS.depth} directory-depth limit; use --source-root to narrow the search.`)
	return results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.file.localeCompare(b.file))
}
