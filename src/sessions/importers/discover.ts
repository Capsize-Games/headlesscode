import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SessionProvider } from "../types.js"
import { IMPORT_LIMITS, isRecord } from "./common.js"

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
		const handle = await fs.open(file, "r")
		try {
			const buffer = Buffer.alloc(IMPORT_LIMITS.lineBytes)
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
			const line = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0]
			const record: unknown = JSON.parse(line)
			if (!isRecord(record) || record.type !== "session_meta" || !isRecord(record.payload)) return undefined
			return typeof record.payload.cwd === "string" ? record.payload.cwd : undefined
		} finally { await handle.close() }
	} catch { return undefined }
}

async function museWorkspace(file: string): Promise<string | undefined> {
	try {
		const handle = await fs.open(file, "r")
		try {
			const buffer = Buffer.alloc(128 * 1024)
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
			const prefix = buffer.subarray(0, bytesRead).toString("utf8")
			const match = prefix.match(/"(?:workspace_root|workspaceRoot|workspace|cwd)"\s*:\s*"((?:\\.|[^"\\])*)"/)
			if (!match?.[1]) return undefined
			try { return JSON.parse(`"${match[1]}"`) as string } catch { return undefined }
		} finally { await handle.close() }
	} catch { return undefined }
}

export async function discoverImportFiles(provider: Exclude<SessionProvider, "headlesscode">, options: DiscoverOptions): Promise<DiscoveredImport[]> {
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
		let entries: import("node:fs").Dirent[]
		try {
			const stat = await fs.lstat(directory)
			if (stat.isSymbolicLink() || !stat.isDirectory()) return
		} catch { return }
		try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
		for (const entry of entries) {
			options.signal?.throwIfAborted()
			if (++visited > IMPORT_LIMITS.entries) { capped = true; return }
			if (entry.isSymbolicLink()) continue
			const file = path.join(directory, entry.name)
			if (entry.isDirectory()) { await walk(file, depth + 1); continue }
			if (!entry.isFile() || !(entry.name.endsWith(".jsonl") || (provider === "muse" && entry.name.endsWith(".json")))) continue
			try {
				const info = await fs.stat(file)
				if (info.size > IMPORT_LIMITS.bytes) continue
				if (provider === "codex" && !options.all) {
					const cwd = await codexCwd(file)
					if (!cwd || path.resolve(cwd) !== workspace) continue
				}
				if (provider === "muse" && !options.all) {
					const cwd = await museWorkspace(file)
					if (!cwd || path.resolve(cwd) !== workspace) continue
				}
				results.push({ provider, file, modifiedAt: info.mtime.toISOString(), bytes: info.size })
			} catch { /* entries can disappear during discovery */ }
		}
	}
	await walk(scopedRoot, 0)
	if (capped) throw new Error(`Discovery reached its ${IMPORT_LIMITS.entries} entry or ${IMPORT_LIMITS.depth} directory-depth limit; use --source-root to narrow the search.`)
	return results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.file.localeCompare(b.file))
}
