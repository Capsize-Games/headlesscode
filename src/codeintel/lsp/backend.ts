/**
 * Generic LSP-backed `CodeIntelBackend` (issue #59).
 *
 * Drives ANY LSP-compliant language server (pyright for Python today) over
 * stdio and implements the language-neutral interface from
 * src/codeintel/backend.ts via the standard LSP requests:
 *
 *   outline          → textDocument/documentSymbol
 *   goToDefinition   → textDocument/definition
 *   findReferences   → textDocument/references
 *   renameSymbol     → textDocument/rename
 *   importGraph      → NO standard LSP request exists. This backend throws a
 *                      clear "not supported for this language yet" error —
 *                      never a silent empty/wrong graph (the plan's explicit
 *                      requirement for the one gap in the mapping).
 *
 * Process lifecycle (per plans/multi-language-code-intel.md):
 *   - start(): spawn + initialize handshake; on ANY failure the caller
 *     disposes this backend and treats the language as "no backend
 *     available" (fail closed, scoped per-language rather than per-workspace).
 *   - The server dying mid-session: requests fail with a connection error;
 *     the FIRST death triggers one restart (all previously-open documents are
 *     re-opened, then the request is retried once); a SECOND death fails
 *     closed for the rest of the session — never retry forever.
 *   - dispose(): kills the child process. Wired into ToolExecutor.dispose via
 *     the CodeIntelService, so a session end never leaks a server process.
 *
 * Text documents: each queried file is didOpen'd (content snapshot) before
 * the first request and didChange'd (full sync, LSP sync kind 1) whenever its
 * on-disk content changes, so edits made mid-session are seen by the server.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import * as lsp from "vscode-languageserver-protocol"

import type { CodeIntelBackend, SymbolPosition } from "../backend.js"
import type { OutlineEntry } from "../outline.js"
import type { DefinitionSite } from "../go-to-definition.js"
import type { ReferenceSite } from "../find-references.js"
import type { ImportGraph } from "../import-graph.js"
import type { RenameResult, RenameSite } from "../rename-symbol.js"
import { LspClient, fileUriToPath, isConnectionError, pathToFileUri, type LspServerConfig } from "./client.js"

/** Minimal logger surface the backend needs (WARNs on lifecycle failures). */
export type LspBackendLogger = { warn: (message: string) => void }

/** Language the server analyzes (used only for messages). */
const PYTHON_IMPORT_GRAPH_GAP =
	"import_graph is not supported for this language yet: LSP has no standard import-graph request. " +
	"It works for TypeScript/JavaScript workspaces; for other languages use the import statements in the file."

/**
 * A generic LSP server wrapped behind the language-neutral backend interface.
 * One instance owns one server process for one (workspaceRoot, language) pair.
 */
export class LspCodeIntelBackend implements CodeIntelBackend {
	/** Currently-open documents: uri → { version, content } for didChange/didOpen. */
	private readonly documents = new Map<string, { version: number; content: string }>()
	private client: LspClient | undefined
	private startPromise: Promise<void> | undefined
	private restarted = false

	constructor(
		private readonly workspaceRoot: string,
		readonly language: string,
		private readonly spec: LspServerConfig,
		private readonly logger: LspBackendLogger,
	) {}

	/**
	 * Spawn + initialize. Idempotent; safe to call from concurrent first
	 * requests (the promise is shared). Throws on failure — the caller
	 * disposes this backend and fails closed.
	 */
	start(): Promise<void> {
		if (this.startPromise === undefined) {
			this.startPromise = this.doStart()
		}
		return this.startPromise
	}

	private async doStart(): Promise<void> {
		const client = new LspClient(this.spec, this.workspaceRoot)
		client.onExit(() => {
			this.client = undefined
			// Allow a mid-session restart to re-run doStart (startPromise is
			// otherwise permanently resolved from the first successful start).
			this.startPromise = undefined
		})
		try {
			await client.start(this.workspaceRoot)
		} catch (err) {
			this.startPromise = undefined
			client.dispose()
			throw err
		}
		this.client = client
	}

	async outline(file: string): Promise<OutlineEntry[]> {
		return this.withClient(async (client, uri) => {
			const result = (await client.sendRequest(lsp.DocumentSymbolRequest.type, { textDocument: { uri } })) as
				| lsp.DocumentSymbol[]
				| lsp.SymbolInformation[]
				| null
			return toOutlineEntries(result ?? [])
		}, file)
	}

	async goToDefinition(file: string, position: SymbolPosition): Promise<DefinitionSite[]> {
		return this.withClient(async (client, uri) => {
			const lspPosition = await this.resolvePosition(file, position)
			if (lspPosition === undefined) {
				return []
			}
			const result = (await client.sendRequest(lsp.DefinitionRequest.type, {
				textDocument: { uri },
				position: lspPosition,
			})) as unknown
			return toDefinitionSites(file, result)
		}, file)
	}

	async findReferences(file: string, position: SymbolPosition): Promise<ReferenceSite[]> {
		return this.withClient(async (client, uri) => {
			const lspPosition = await this.resolvePosition(file, position)
			if (lspPosition === undefined) {
				return []
			}
			const result = (await client.sendRequest(lsp.ReferencesRequest.type, {
				textDocument: { uri },
				position: lspPosition,
				context: { includeDeclaration: true },
			})) as lsp.Location[] | null
			return toReferenceSites(result ?? [])
		}, file)
	}

	async importGraph(): Promise<ImportGraph> {
		throw new Error(PYTHON_IMPORT_GRAPH_GAP)
	}

	async renameSymbol(file: string, position: SymbolPosition, newName: string): Promise<RenameResult> {
		return this.withClient(async (client, uri) => {
			const lspPosition = await this.resolvePosition(file, position)
			if (lspPosition === undefined) {
				throw new Error(`no identifier found at ${relative(this.workspaceRoot, file)}:${position.line} — nothing to rename`)
			}
			if (newName.trim() === "" || /\s/.test(newName)) {
				throw new Error(`'${newName}' is not a valid identifier — use a plain name like 'renamedFoo'`)
			}
			const edit = (await client.sendRequest(lsp.RenameRequest.type, {
				textDocument: { uri },
				position: lspPosition,
				newName,
			})) as lsp.WorkspaceEdit | null
			if (edit === null || edit === undefined) {
				throw new Error(
					`the language server for '${this.language}' returned no rename edits — the symbol may not be renameable or the new name may be invalid`,
				)
			}
			return applyWorkspaceEdit(this.workspaceRoot, file, edit)
		}, file)
	}

	async dispose(): Promise<void> {
		const client = this.client
		this.client = undefined
		this.documents.clear()
		client?.dispose()
	}

	// ─── internals ──────────────────────────────────────────────────────────────

	/**
	 * Run a request against the live client. Guarantees the target document is
	 * open (didOpen/didChange as needed) before the request, and implements the
	 * restart-once contract: a process death mid-request triggers one restart
	 * (re-opening every previously open document) and a single retry.
	 */
	private async withClient<T>(fn: (client: LspClient, uri: string) => Promise<T>, file: string): Promise<T> {
		const uri = pathToFileUri(file)
		const attempt = async (client: LspClient): Promise<T> => {
			this.syncDocument(client, uri, file)
			return fn(client, uri)
		}
		const first = await this.ensureClient()
		try {
			return await attempt(first)
		} catch (err) {
			if (isConnectionError(err) && !this.restarted && this.client === undefined) {
				// The server died mid-request: restart once and retry.
				this.logger.warn(`code-intel: language server for '${this.language}' died mid-session — restarting once`)
				this.restarted = true
				const fresh = await this.ensureClient()
				return attempt(fresh)
			}
			throw err
		}
	}

	/** The live client, starting it lazily on first use (idempotent). */
	private async ensureClient(): Promise<LspClient> {
		if (this.client !== undefined) {
			return this.client
		}
		if (this.restarted) {
			// Second death (or a death while restarting): fail closed.
			throw new Error(
				`language server for '${this.language}' failed again after a mid-session restart — code-intelligence for ${this.language} files is disabled for the rest of this session`,
			)
		}
		await this.start()
		if (this.client === undefined) {
			throw new Error(`language server for '${this.language}' failed to start — no code-intelligence backend available`)
		}
		// Re-open every document the session had open before the death.
		for (const [openUri, doc] of this.documents) {
			this.sendDidOpen(this.client, openUri, doc.content)
		}
		return this.client
	}

	/** Ensure the server has the file's CURRENT content (didOpen or didChange). */
	private syncDocument(client: LspClient, uri: string, file: string): void {
		const content = readFileContent(file)
		if (content === undefined) {
			return
		}
		const existing = this.documents.get(uri)
		if (existing === undefined) {
			this.sendDidOpen(client, uri, content)
			return
		}
		if (existing.content !== content) {
			existing.version += 1
			existing.content = content
			// Full-document sync (LSP textDocumentSyncKind.Full = 1): send the
			// whole new content, no incremental diff bookkeeping.
			client.sendNotification(lsp.DidChangeTextDocumentNotification.type, {
				textDocument: { uri, version: existing.version },
				contentChanges: [{ text: content }],
			})
		}
	}

	private sendDidOpen(client: LspClient, uri: string, content: string): void {
		const existing = this.documents.get(uri)
		const version = existing === undefined ? 1 : existing.version + 1
		this.documents.set(uri, { version, content })
		client.sendNotification(lsp.DidOpenTextDocumentNotification.type, {
			textDocument: {
				uri,
				languageId: this.language,
				version,
				text: content,
			},
		})
	}

	/**
	 * Resolve the tools' (line[, character|symbol]) position shape to a
	 * concrete LSP position the server will answer about, by reading the file:
	 *   - character (1-based column) given: the identifier touching it
	 *   - symbol given: the identifier on the line whose text matches
	 *   - neither: the first identifier on the line
	 * This mirrors the TypeScript side's identifierAtPosition semantics
	 * (src/codeintel/position.ts) without needing a per-language parser — the
	 * server does the real symbol resolution; this only has to aim at it.
	 */
	private async resolvePosition(file: string, position: SymbolPosition): Promise<lsp.Position | undefined> {
		const text = readFileContent(file)
		if (text === undefined || position.line < 1) {
			return undefined
		}
		const lines = text.split(/\r?\n/)
		const line0 = position.line - 1
		const lineText = lines[line0]
		if (lineText === undefined) {
			return undefined
		}

		if (position.character !== undefined && position.character >= 1) {
			const char0 = position.character - 1
			const token = tokenAt(lineText, char0)
			if (token !== undefined) {
				return { line: line0, character: token.start }
			}
		}
		if (position.symbol !== undefined && position.symbol.trim() !== "") {
			const idx = indexOfWord(lineText, position.symbol)
			if (idx !== -1) {
				return { line: line0, character: idx }
			}
			return undefined
		}
		const first = firstToken(lineText)
		if (first === undefined) {
			return undefined
		}
		return { line: line0, character: first.start }
	}
}

// ─── LSP result → tool shape mapping ─────────────────────────────────────────

/** SymbolKind → the outline tool's compact kind labels. */
function kindLabel(kind: lsp.SymbolKind): string {
	switch (kind) {
		case lsp.SymbolKind.Module:
		case lsp.SymbolKind.Namespace:
		case lsp.SymbolKind.Package:
			return "namespace"
		case lsp.SymbolKind.Class:
		case lsp.SymbolKind.Struct:
			return "class"
		case lsp.SymbolKind.Interface:
			return "interface"
		case lsp.SymbolKind.Enum:
			return "enum"
		case lsp.SymbolKind.EnumMember:
			return "member"
		case lsp.SymbolKind.Method:
		case lsp.SymbolKind.Constructor:
			return "method"
		case lsp.SymbolKind.Property:
		case lsp.SymbolKind.Field:
			return "property"
		case lsp.SymbolKind.Function:
			return "function"
		case lsp.SymbolKind.Variable:
			return "var"
		case lsp.SymbolKind.Constant:
			return "const"
		case lsp.SymbolKind.TypeParameter:
			return "type"
		default:
			return "symbol"
	}
}

/**
 * documentSymbol can return nested DocumentSymbol[] (client asked for
 * hierarchical support) or flat SymbolInformation[]. Both map to the same
 * compact `line kind signature` lines the TS outline produces.
 */
function toOutlineEntries(result: lsp.DocumentSymbol[] | lsp.SymbolInformation[]): OutlineEntry[] {
	const entries: OutlineEntry[] = []
	for (const symbol of result) {
		if (isDocumentSymbol(symbol)) {
			pushDocumentSymbol(symbol, 0, entries)
		} else {
			// SymbolInformation: flat, with containerName for the parent.
			entries.push({
				line: symbol.location.range.start.line + 1,
				kind: kindLabel(symbol.kind),
				signature: symbol.name,
				depth: symbol.containerName !== undefined && symbol.containerName !== "" ? 1 : 0,
			})
		}
	}
	return entries
}

function isDocumentSymbol(symbol: lsp.DocumentSymbol | lsp.SymbolInformation): symbol is lsp.DocumentSymbol {
	return (symbol as lsp.DocumentSymbol).range !== undefined
}

function pushDocumentSymbol(symbol: lsp.DocumentSymbol, depth: number, entries: OutlineEntry[]): void {
	const detail = symbol.detail !== undefined && symbol.detail !== "" ? ` ${symbol.detail}` : ""
	entries.push({
		line: symbol.range.start.line + 1,
		kind: kindLabel(symbol.kind),
		signature: `${symbol.name}${detail}`,
		depth,
	})
	for (const child of symbol.children ?? []) {
		pushDocumentSymbol(child, depth + 1, entries)
	}
}

/**
 * definition returns Location | Location[] | LocationLink[] | null. LocationLink
 * is preferred when present (its targetSelectionRange is the exact name span).
 */
function toDefinitionSites(fromFile: string, result: unknown): DefinitionSite[] {
	const locations = normalizeLocations(result)
	const seen = new Set<string>()
	const sites: DefinitionSite[] = []
	for (const loc of locations) {
		const fileName = fileUriToPath(loc.uri)
		const nameRange = loc.selectionRange ?? loc.range
		const line = nameRange.start.line + 1
		const character = nameRange.start.character + 1
		const key = `${fileName}:${line}:${character}`
		if (seen.has(key)) {
			continue
		}
		seen.add(key)
		const fileText = readFileContent(fileName) ?? ""
		const snippet = lineSnippet(fileText, nameRange.start.line)
		sites.push({
			fileName,
			line,
			character,
			kind: "definition",
			name: textAtRange(fileText, nameRange),
			snippet,
		})
	}
	// Deterministic order, matching the TS side's sort.
	sites.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.line - b.line)
	return sites
}

/** Normalize the three definition response shapes into Location-ish entries. */
function normalizeLocations(result: unknown): Array<{ uri: string; range: lsp.Range; selectionRange?: lsp.Range }> {
	if (result === null || result === undefined) {
		return []
	}
	if (Array.isArray(result)) {
		return result.map((entry) => {
			if (isLocationLink(entry)) {
				return { uri: entry.targetUri, range: entry.targetRange, selectionRange: entry.targetSelectionRange }
			}
			return entry as { uri: string; range: lsp.Range }
		})
	}
	if (isLocationLink(result)) {
		return [{ uri: result.targetUri, range: result.targetRange, selectionRange: result.targetSelectionRange }]
	}
	return [result as { uri: string; range: lsp.Range }]
}

function isLocationLink(entry: unknown): entry is lsp.LocationLink {
	const candidate = entry as lsp.LocationLink
	return typeof candidate === "object" && candidate !== null && candidate.targetUri !== undefined
}

/** references returns Location[]. isWriteAccess is not part of LSP — always read. */
function toReferenceSites(result: lsp.Location[]): ReferenceSite[] {
	const seen = new Set<string>()
	const sites: ReferenceSite[] = []
	for (const loc of result) {
		const fileName = fileUriToPath(loc.uri)
		const fileText = readFileContent(fileName) ?? ""
		const start = offsetAt(fileText, loc.range.start)
		const line = loc.range.start.line + 1
		const key = `${fileName}:${start}`
		if (seen.has(key)) {
			continue
		}
		seen.add(key)
		sites.push({
			fileName,
			line,
			character: loc.range.start.character + 1,
			start,
			isWriteAccess: false,
			snippet: lineSnippet(fileText, loc.range.start.line),
		})
	}
	sites.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.line - b.line)
	return sites
}

// ─── rename (WorkspaceEdit → atomic file writes) ─────────────────────────────

/**
 * Apply an LSP WorkspaceEdit to disk with the same atomicity contract as the
 * TypeScript rename (src/codeintel/rename-symbol.ts): every file is read and
 * every new content is COMPUTED before the first write; if any write fails,
 * every file already written is restored from its captured original.
 * References outside the workspace root REFUSE the rename outright (editing
 * outside the sandbox is never acceptable).
 */
async function applyWorkspaceEdit(workspaceRoot: string, fromFile: string, edit: lsp.WorkspaceEdit): Promise<RenameResult> {
	const editsByFile = new Map<string, lsp.TextEdit[]>()
	for (const [uri, textEdits] of Object.entries(edit.changes ?? {})) {
		const file = fileUriToPath(uri)
		if (!isInside(workspaceRoot, file)) {
			throw new Error(
				`rename refused: the language server produced an edit in ${relative(workspaceRoot, file)}, outside the workspace root — renaming would edit outside the sandbox`,
			)
		}
		editsByFile.set(file, textEdits)
	}
	for (const change of edit.documentChanges ?? []) {
		if (isTextDocumentEdit(change)) {
			const file = fileUriToPath(change.textDocument.uri)
			if (!isInside(workspaceRoot, file)) {
				throw new Error(
					`rename refused: the language server produced an edit in ${relative(workspaceRoot, file)}, outside the workspace root — renaming would edit outside the sandbox`,
				)
			}
			const existing = editsByFile.get(file) ?? []
			// The protocol's TextEdit union also admits SnippetTextEdit; rename
			// servers return plain edits with newText, so keep only those.
			const plain = change.edits.filter((e): e is lsp.TextEdit => "newText" in e)
			editsByFile.set(file, [...existing, ...plain])
		}
	}
	if (editsByFile.size === 0) {
		throw new Error("the language server returned a rename edit with no changes")
	}

	// Phase 1: read every target file. A read failure aborts with nothing written.
	const originals = new Map<string, string>()
	for (const file of editsByFile.keys()) {
		try {
			originals.set(file, await fs.promises.readFile(file, "utf-8"))
		} catch (err) {
			throw new Error(
				`rename aborted: cannot read ${relative(workspaceRoot, file)} for the rename: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	// Phase 2: compute every updated content in memory (descending offsets so
	// later edits never shift earlier ones). The file may have changed since
	// the server's snapshot — a range that no longer fits aborts, writing nothing.
	const updated = new Map<string, string>()
	let oldName = ""
	let newName = ""
	for (const [file, textEdits] of editsByFile) {
		const text = originals.get(file)!
		const sorted = [...textEdits].sort((a, b) => offsetAt(text, b.range.start) - offsetAt(text, a.range.start))
		let result = text
		for (const textEdit of sorted) {
			const start = offsetAt(text, textEdit.range.start)
			const end = offsetAt(text, textEdit.range.end)
			if (start < 0 || end < start || end > result.length) {
				throw new Error(
					`rename aborted: an edit range in ${relative(workspaceRoot, file)} no longer fits the file — it changed since the language server analyzed it; re-read the file and re-run the rename`,
				)
			}
			const replaced = result.slice(start, end)
			if (oldName === "") {
				oldName = replaced
				newName = textEdit.newText
			}
			result = result.slice(0, start) + textEdit.newText + result.slice(end)
		}
		updated.set(file, result)
	}

	// Phase 3: write every file; roll back the already-written ones on any failure.
	const written: string[] = []
	try {
		for (const [file, content] of updated) {
			await fs.promises.writeFile(file, content, "utf-8")
			written.push(file)
		}
	} catch (err) {
		for (const file of written) {
			try {
				await fs.promises.writeFile(file, originals.get(file)!, "utf-8")
			} catch {
				// Best-effort rollback; the primary error below is the signal.
			}
		}
		throw new Error(
			`rename failed while writing ${relative(workspaceRoot, written[written.length - 1] ?? "(unknown)")}: ${
				err instanceof Error ? err.message : String(err)
			} — all files already written were rolled back to their original content`,
		)
	}

	const sites: RenameSite[] = []
	for (const [file, textEdits] of editsByFile) {
		for (const textEdit of textEdits) {
			sites.push({
				fileName: file,
				line: textEdit.range.start.line + 1,
				isWriteAccess: false,
				snippet: lineSnippet(originals.get(file) ?? "", textEdit.range.start.line),
			})
		}
	}
	sites.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.line - b.line)
	return { oldName, newName, sites }
}

function isTextDocumentEdit(change: lsp.TextDocumentEdit | lsp.CreateFile | lsp.RenameFile | lsp.DeleteFile): change is lsp.TextDocumentEdit {
	return (change as lsp.TextDocumentEdit).edits !== undefined
}

// ─── text helpers ────────────────────────────────────────────────────────────

/** Read a file's current content (undefined when unreadable/missing). */
function readFileContent(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf-8")
	} catch {
		return undefined
	}
}

/** The line's text at 0-based `line`, trimmed to 120 chars like the TS side. */
function lineSnippet(text: string, line: number): string {
	const lineText = text.split(/\r?\n/)[line]
	if (lineText === undefined) {
		return ""
	}
	const trimmed = lineText.trim()
	return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed
}

/** 0-based (line, character) → absolute character offset (-1 when out of range). */
function offsetAt(text: string, position: lsp.Position): number {
	const lines = text.split(/\r?\n/)
	if (position.line < 0 || position.line >= lines.length) {
		return -1
	}
	let offset = 0
	for (let i = 0; i < position.line; i++) {
		offset += lines[i]!.length + 1
	}
	return offset + Math.min(position.character, lines[position.line]!.length)
}

/** The identifier text covering an LSP range in a file's text. */
function textAtRange(text: string, range: lsp.Range): string {
	const lines = text.split(/\r?\n/)
	const line = lines[range.start.line]
	if (line === undefined) {
		return ""
	}
	const end = range.end.line === range.start.line ? range.end.character : line.length
	return line.slice(range.start.character, Math.max(range.start.character, Math.min(end, line.length))).trim()
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/

/** The identifier token touching a 0-based column, or undefined (whitespace). */
function tokenAt(line: string, char0: number): { start: number } | undefined {
	if (char0 < 0 || char0 >= line.length || !IDENTIFIER_CHAR.test(line[char0]!)) {
		return undefined
	}
	let start = char0
	while (start > 0 && IDENTIFIER_CHAR.test(line[start - 1]!)) {
		start--
	}
	return { start }
}

/** 0-based column of the first whole-word occurrence of `word` in the line. */
function indexOfWord(line: string, word: string): number {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const match = line.match(new RegExp(`\\b${escaped}\\b`))
	return match?.index ?? -1
}

/** The first identifier-like token on the line, or undefined. */
function firstToken(line: string): { start: number } | undefined {
	const match = line.match(/[A-Za-z_][A-Za-z0-9_]*/)
	return match?.index !== undefined ? { start: match.index } : undefined
}

/** True when `p` resolves inside `root` (lexical containment, like safeTarget). */
function isInside(root: string, p: string): boolean {
	const rel = path.relative(root, p)
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** Workspace-relative (posix) display path; absolute if somehow outside. */
function relative(workspaceRoot: string, p: string): string {
	const r = path.relative(workspaceRoot, p)
	return r === "" || r.startsWith("..") ? p : r.split(path.sep).join("/")
}
