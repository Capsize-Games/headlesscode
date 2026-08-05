/**
 * `rename_symbol` analysis: rename a symbol at (file, line[, character |
 * symbol]) to a new name across EVERY real usage site in the workspace, as
 * ONE atomic operation.
 *
 * Site enumeration reuses `findReferences` — the language service's real
 * `getReferencesAtPosition` resolution, never grep — so the same "which
 * identifiers are actually this symbol" correctness that `find_references`
 * already has applies to the edit side too. Nothing here re-parses or
 * guesses: the reference spans ARE the edit targets.
 *
 * Atomicity contract: either every site updates or none do.
 *   - All files are read and all new contents are COMPUTED before the first
 *     write, so a mismatch (file changed since the program snapshot) aborts
 *     with nothing written.
 *   - The writes then go file-by-file; if any write fails, every file
 *     already written is restored from its captured original before the
 *     error propagates. A partial rename leaving the codebase inconsistent
 *     is worse than the N-round-trip status quo this replaces.
 *
 * Scope guard (matches find_references/go_to_definition's boundary — see
 * src/codeintel/program.ts): TypeScript/JavaScript source files only, and
 * every site must resolve inside the workspace root. A reference outside
 * the workspace (e.g. into node_modules) REFUSES the whole rename rather
 * than silently skipping a site or editing outside the sandbox.
 */

import * as path from "node:path"
import * as ts from "typescript"

import { scriptKindFromFileName, type CodeIntel } from "./program.js"
import { identifierAtPosition } from "./position.js"
import { findReferences } from "./find-references.js"
import { readFile, writeFile } from "node:fs/promises"

/** A rename edit target, captured BEFORE any file is written. */
export interface RenameSite {
	fileName: string
	line: number
	/** Write access (declaration / assignment) vs read access. */
	isWriteAccess: boolean
	/** The line's text as it looked BEFORE the rename (for the result). */
	snippet: string
}

export interface RenameResult {
	oldName: string
	newName: string
	/** Every edited site, pre-rename text (sorted by file, then line). */
	sites: RenameSite[]
}

/** A valid TS identifier (what `new_name` must be). */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export function isValidIdentifier(name: string): boolean {
	return IDENTIFIER_RE.test(name)
}

/** Parse a file standalone (for files created after the program was loaded). */
function readStandalone(file: string): ts.SourceFile | undefined {
	const text = ts.sys.readFile(file)
	if (text === undefined) {
		return undefined
	}
	return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFromFileName(file))
}

/** True when `p` resolves inside `root` (path-safety mirror of safeTarget). */
function isInside(root: string, p: string): boolean {
	const rel = path.relative(root, p)
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/**
 * Rename the symbol at `line` (1-based) in `file` to `newName` everywhere it
 * is referenced across the workspace. Throws with a clear message on any
 * pre-write validation failure (bad new name, no references, a reference
 * outside the workspace, a span that no longer matches the old name) and on
 * a mid-write failure (after rolling back the files already written).
 */
export async function renameSymbol(
	intel: CodeIntel,
	workspaceRoot: string,
	file: string,
	line: number,
	character: number | undefined,
	symbol: string | undefined,
	newName: string,
): Promise<RenameResult> {
	const sourceFile = intel.program.getSourceFile(file) ?? readStandalone(file)
	if (sourceFile === undefined) {
		throw new Error(`file is not part of the loaded TypeScript program: ${file}`)
	}
	const identifier = identifierAtPosition(sourceFile, line, character, symbol)
	if (identifier === undefined) {
		throw new Error(`no identifier found at ${rel(workspaceRoot, file)}:${line} — nothing to rename`)
	}
	const oldName = identifier.text
	if (oldName === newName) {
		throw new Error(`new name must differ from the current name '${oldName}'`)
	}
	if (!isValidIdentifier(newName)) {
		throw new Error(`'${newName}' is not a valid TypeScript identifier — use a plain name like 'renamedFoo'`)
	}

	intel.includeExtraFile(file)
	const sites = findReferences(intel, file, line, character, symbol)
	if (sites.length === 0) {
		throw new Error(`no references found for '${oldName}' — nothing to rename`)
	}

	// Group the absolute edit offsets by file, refusing any site outside the
	// workspace BEFORE anything is read or written (all-or-nothing).
	const offsetsByFile = new Map<string, number[]>()
	for (const site of sites) {
		if (!isInside(workspaceRoot, site.fileName)) {
			throw new Error(
				`rename refused: reference to '${oldName}' at ${rel(workspaceRoot, site.fileName)}:${site.line} is outside the workspace root — renaming would edit outside the sandbox`,
			)
		}
		const list = offsetsByFile.get(site.fileName) ?? []
		list.push(site.start)
		offsetsByFile.set(site.fileName, list)
	}

	// Phase 1: read every target file. A read failure aborts with nothing
	// written — the file may have been deleted/renamed since the snapshot.
	const originals = new Map<string, string>()
	for (const fileName of offsetsByFile.keys()) {
		try {
			originals.set(fileName, await readFile(fileName, "utf-8"))
		} catch (err) {
			throw new Error(
				`rename aborted: cannot read ${rel(workspaceRoot, fileName)} for the rename: ${err instanceof Error ? err.message : String(err)}`,
			)
		}
	}

	// Phase 2: compute every updated content in memory. Each span must still
	// hold the old name — a mismatch means the file changed since the
	// reference snapshot (the program would normally have rebuilt, but be
	// defensive), and aborting here still writes nothing.
	const updated = new Map<string, string>()
	for (const [fileName, offsets] of offsetsByFile) {
		const text = originals.get(fileName)!
		// Descending order: later edits never shift earlier offsets.
		const sorted = [...offsets].sort((a, b) => b - a)
		let result = text
		for (const start of sorted) {
			const spanText = result.slice(start, start + oldName.length)
			if (spanText !== oldName) {
				throw new Error(
					`rename aborted: expected '${oldName}' at ${rel(workspaceRoot, fileName)} (offset ${start}) but found '${spanText}' — the file changed since the reference snapshot; re-read it and re-run the rename`,
				)
			}
			result = result.slice(0, start) + newName + result.slice(start + oldName.length)
		}
		updated.set(fileName, result)
	}

	// Phase 3: write every file; roll back the already-written ones on any
	// failure so no partial rename survives.
	const written: string[] = []
	try {
		for (const [fileName, content] of updated) {
			await writeFile(fileName, content, "utf-8")
			written.push(fileName)
		}
	} catch (err) {
		for (const fileName of written) {
			try {
				await writeFile(fileName, originals.get(fileName)!, "utf-8")
			} catch {
				// Best-effort rollback; the primary error below is the signal.
			}
		}
		throw new Error(
			`rename failed while writing ${rel(workspaceRoot, written[written.length - 1] ?? "(unknown)")}: ${
				err instanceof Error ? err.message : String(err)
			} — all files already written were rolled back to their original content`,
		)
	}

	const byFile = new Map<string, RenameSite[]>()
	for (const site of sites) {
		const list = byFile.get(site.fileName) ?? []
		list.push({
			fileName: site.fileName,
			line: site.line,
			isWriteAccess: site.isWriteAccess,
			snippet: site.snippet,
		})
		byFile.set(site.fileName, list)
	}
	const flat = [...byFile.values()]
		.flat()
		.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.line - b.line)

	return { oldName, newName, sites: flat }
}

/** Workspace-relative (posix) display path; absolute if somehow outside. */
function rel(workspaceRoot: string, p: string): string {
	const r = path.relative(workspaceRoot, p)
	return r === "" || r.startsWith("..") ? p : r.split(path.sep).join("/")
}

/** Render a rename result as compact `file:line — snippet` lines. */
export function formatRenameResult(workspaceRoot: string, result: RenameResult): string {
	const lines = result.sites.map((s) => `${rel(workspaceRoot, s.fileName)}:${s.line}${s.isWriteAccess ? " (write)" : ""} — ${s.snippet}`)
	return `Renamed '${result.oldName}' → '${result.newName}' across ${result.sites.length} site(s):\n${lines.join("\n")}`
}
