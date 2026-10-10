import * as fs from "node:fs/promises"
import path from "node:path"
import { SessionStore } from "../store.js"
import type { CreateSessionInput, SessionArchive, SessionProvider } from "../types.js"
import { parseClaudeRecords } from "./claude.js"
import { parseCodexRecords } from "./codex.js"
import { discoverImportFiles, type DiscoverOptions, type DiscoveredImport } from "./discover.js"
import { hashSource, IMPORT_LIMITS, parseJsonLines, readBoundedFile, titleFrom, uniqueWarnings, type ParsedImport } from "./common.js"
import { parseMuseExport, parseMuseRecords } from "./muse.js"

export { discoverImportFiles }
export type { DiscoverOptions, DiscoveredImport, ParsedImport }
export { parseClaudeRecords } from "./claude.js"
export { parseCodexRecords } from "./codex.js"
export { parseMuseExport, parseMuseRecords } from "./muse.js"

function boundMessages(parsed: ParsedImport): void {
	let used = 0
	const kept = [] as ParsedImport["messages"]
	let truncated = false
	for (const original of parsed.messages.slice(0, IMPORT_LIMITS.messages)) {
		const message = { ...original }
		if (typeof message.content === "string" && message.content.length > 1_000_000) {
			message.content = `${message.content.slice(0, 1_000_000)}… [truncated by importer]`
			truncated = true
		}
		if (message.toolCalls) message.toolCalls = message.toolCalls.slice(0, 256).map((call) => ({ ...call, arguments: call.arguments.slice(0, 1_000_000) }))
		if (message.opaque) message.opaque = message.opaque.slice(0, 16)
		const size = Buffer.byteLength(JSON.stringify(message))
		if (used + size > IMPORT_LIMITS.archiveContentBytes) { truncated = true; break }
		kept.push(message)
		used += size
	}
	if (parsed.messages.length > kept.length) truncated = true
	parsed.messages = kept
	if (truncated) parsed.warnings.push("Imported history was truncated to fit bounded archive limits; the original source file is unchanged.")
}

export async function parseImportFile(provider: Exclude<SessionProvider, "headlesscode">, filePath: string, signal?: AbortSignal): Promise<{ parsed: ParsedImport; sha256: string; warnings: string[] }> {
	if (provider !== "claude" && provider !== "codex" && provider !== "muse") throw new Error(`Unsupported import provider: ${String(provider)}`)
	const absolute = path.resolve(filePath)
	const { bytes, warnings: readWarnings } = await readBoundedFile(absolute, signal)
	const warnings = [...readWarnings]
	let parsed: ParsedImport
	if (provider === "muse" && path.extname(absolute).toLowerCase() === ".json") {
		let value: unknown
		try { value = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("Muse JSON export is malformed. Expected a schema v1 JSON document.") }
		parsed = parseMuseExport(value)
	} else {
		const records = parseJsonLines(bytes, warnings)
		switch (provider) {
			case "claude": parsed = parseClaudeRecords(records); break
			case "codex": parsed = parseCodexRecords(records); break
			case "muse": parsed = parseMuseRecords(records); break
		}
	}
	if (!parsed.messages.length) throw new Error(`${provider} source contained no supported conversation records. Select a supported transcript or export file.`)
	boundMessages(parsed)
	warnings.push(...parsed.warnings)
	parsed.warnings = uniqueWarnings(warnings)
	if (!parsed.title || parsed.title.startsWith("Imported ")) parsed.title = `Imported ${provider} conversation: ${titleFrom(absolute, "session")}`.slice(0, 256)
	return { parsed, sha256: hashSource(bytes), warnings: parsed.warnings }
}

export async function importFile(provider: Exclude<SessionProvider, "headlesscode">, filePath: string, workspaceRoot: string, signal?: AbortSignal): Promise<{ archive: SessionArchive; warnings: string[] }> {
	const absoluteWorkspace = await fs.realpath(path.resolve(workspaceRoot)).catch(() => path.resolve(workspaceRoot))
	const { parsed, sha256, warnings } = await parseImportFile(provider, filePath, signal)
	const input: CreateSessionInput = {
		title: parsed.title,
		messages: parsed.messages,
		warnings: uniqueWarnings(["Imported history is unverified historical context; recorded tools and approvals are not replayed.", ...warnings]),
		provenance: {
			provider,
			...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
			sourcePath: path.resolve(filePath),
			sha256,
			importedAt: new Date().toISOString(),
		},
	}
	const store = new SessionStore(absoluteWorkspace)
	const archive = await store.create(input)
	return { archive, warnings: archive.warnings }
}
