/**
 * `find_references` analysis: every real usage site of the symbol at
 * (file, line[, character | symbol]) via the language service's real
 * reference finding — `getReferencesAtPosition` — never grep.
 *
 * Output is compact `file:line` entries plus a short snippet of the line
 * itself, so the model doesn't have to read each file just to see context.
 * Results are capped (see MAX_REFERENCES): a symbol with a huge number of
 * usages (e.g. a common utility) must not dump hundreds of lines back into
 * the model's context, which would defeat the point of the tool.
 */

import * as ts from "typescript"

import { scriptKindFromFileName, type CodeIntel } from "./program.js"
import { identifierAtPosition } from "./position.js"

export interface ReferenceSite {
	fileName: string
	line: number
	character: number
	/**
	 * Absolute character offset of the identifier's start within `fileName`
	 * (the language service's raw `textSpan.start`). The tools only need
	 * line/column for display, but `rename_symbol` needs the exact offset to
	 * edit the file — computed here once instead of re-derived per consumer.
	 */
	start: number
	/** Write access (assignment / declaration) vs read access. */
	isWriteAccess: boolean
	snippet: string
}

/** Hard cap on reference entries per call (keeps model context bounded). */
export const MAX_REFERENCES = 50

/** Read a line from the program's snapshot or straight from disk. */
function snippetFor(intel: CodeIntel, fileName: string, line1based: number): string {
	const sourceFile = intel.program.getSourceFile(fileName)
	const text = sourceFile?.text ?? (ts.sys.readFile(fileName) ?? "")
	const line = text.split(/\r?\n/)[line1based - 1]
	if (line === undefined) {
		return ""
	}
	const trimmed = line.trim()
	return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed
}

/** Parse a file standalone (for files created after the program was loaded). */
function readStandalone(file: string): ts.SourceFile | undefined {
	const text = ts.sys.readFile(file)
	if (text === undefined) {
		return undefined
	}
	return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFromFileName(file))
}

/**
 * Find all references to the symbol at `line` (1-based) in `file`.
 * `character` (1-based column) and/or `symbol` (name) disambiguate when the
 * line holds multiple identifiers. The result includes the declaration site
 * itself (the language service counts it as a "reference").
 */
export function findReferences(
	intel: CodeIntel,
	file: string,
	line: number,
	character: number | undefined,
	symbol: string | undefined,
): ReferenceSite[] {
	const sourceFile = intel.program.getSourceFile(file) ?? readStandalone(file)
	if (sourceFile === undefined) {
		throw new Error(`file is not part of the loaded TypeScript program: ${file}`)
	}
	const identifier = identifierAtPosition(sourceFile, line, character, symbol)
	if (identifier === undefined) {
		return []
	}

	intel.includeExtraFile(file)
	const references = intel.languageService.getReferencesAtPosition(file, identifier.getStart(sourceFile)) ?? []

	const seen = new Set<string>()
	const sites: ReferenceSite[] = []
	for (const ref of references) {
		const key = `${ref.fileName}:${ref.textSpan.start}`
		if (seen.has(key)) {
			continue
		}
		seen.add(key)
		// Line/column must be computed against the REFERENCE's own file, which
		// may differ from the file we started from (references span the program).
		const refSourceFile = intel.program.getSourceFile(ref.fileName)
		if (refSourceFile === undefined) {
			continue
		}
		const lineAndChar = ts.getLineAndCharacterOfPosition(refSourceFile, ref.textSpan.start)
		sites.push({
			fileName: ref.fileName,
			line: lineAndChar.line + 1,
			character: lineAndChar.character + 1,
			start: ref.textSpan.start,
			isWriteAccess: ref.isWriteAccess,
			snippet: snippetFor(intel, ref.fileName, lineAndChar.line + 1),
		})
	}
	sites.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.line - b.line)
	return sites
}

/** Render reference sites as compact `file:line — snippet` lines, capped. */
export function formatReferences(rel: (p: string) => string, sites: ReferenceSite[]): string {
	if (sites.length === 0) {
		return "No references found for that symbol."
	}
	const shown = sites.slice(0, MAX_REFERENCES)
	const lines = shown.map((r) => `${rel(r.fileName)}:${r.line}${r.isWriteAccess ? " (write)" : ""} — ${r.snippet}`)
	const overflow = sites.length - shown.length
	if (overflow > 0) {
		lines.push(`…${overflow} more reference(s) not shown — narrow your search to a more specific symbol`)
	}
	return lines.join("\n")
}
