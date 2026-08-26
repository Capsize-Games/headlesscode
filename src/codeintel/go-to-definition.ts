/**
 * `go_to_definition` analysis: resolve a symbol at (file, line[, character |
 * symbol]) to its real definition site(s) via the type checker's actual
 * symbol resolution — the LanguageService's `getDefinitionAtPosition` — not a
 * text search.
 *
 * Handles the three hard cases the spec calls out:
 *   - definition in a `.d.ts` / vendored / `node_modules` location: returned
 *     as the real location, never refused for being outside `src/`
 *   - symbol with no resolvable definition (ambient / `any`-typed /
 *     genuinely unresolvable): a clear "could not resolve" result, not a crash
 *   - multiple candidate definitions (e.g. an overloaded function): ALL of
 *     them are returned, never one silently picked
 */

import * as path from "node:path"
import * as ts from "typescript"

import { scriptKindFromFileName, type CodeIntel } from "./program.js"
import { identifierAtPosition } from "./position.js"

export interface DefinitionSite {
	/** Absolute path of the defining file. */
	fileName: string
	/** 1-based line + 1-based column of the definition's name. */
	line: number
	character: number
	kind: string
	name: string
	/** Container (e.g. class/namespace) the definition lives in, if any. */
	containerName?: string
	/** The full text of the definition's line, for context without a read_file. */
	snippet: string
}

/** Read a definition's line text from the program or straight from disk. */
function snippetFor(intel: CodeIntel, fileName: string, line1based: number): string {
	const sourceFile = intel.program.getSourceFile(fileName)
	const text = sourceFile?.text ?? (ts.sys.readFile(fileName) ?? "")
	const lines = text.split(/\r?\n/)
	const line = lines[line1based - 1]
	if (line === undefined) {
		return ""
	}
	const trimmed = line.trim()
	return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed
}

/**
 * Resolve the definition(s) of the symbol at `line` (1-based) in `file`.
 * `character` (1-based column) and/or `symbol` (name) disambiguate when the
 * line holds multiple identifiers.
 */
export function findDefinition(
	intel: CodeIntel,
	file: string,
	line: number,
	character: number | undefined,
	symbol: string | undefined,
): DefinitionSite[] {
	const sourceFile = intel.program.getSourceFile(file) ?? readStandalone(file)
	if (sourceFile === undefined) {
		throw new Error(`file is not part of the loaded TypeScript program: ${file}`)
	}
	const identifier = identifierAtPosition(sourceFile, line, character, symbol)
	if (identifier === undefined) {
		return []
	}

	intel.includeExtraFile(file)
	const definitions = intel.languageService.getDefinitionAtPosition(file, identifier.getStart(sourceFile)) ?? []

	// The language service returns ONE definition per position — but an
	// overloaded function is one symbol with several declarations, and the spec
	// says return ALL candidates, never one silently picked. Expand through the
	// type checker's symbol: resolve alias imports to their target, then take
	// every declaration the symbol has.
	const checker = intel.program.getTypeChecker()
	let resolvedSymbol = checker.getSymbolAtLocation(identifier)
	if (resolvedSymbol !== undefined && (resolvedSymbol.flags & ts.SymbolFlags.Alias) !== 0) {
		resolvedSymbol = checker.getAliasedSymbol(resolvedSymbol)
	}
	const symbolDeclarations = (resolvedSymbol?.declarations ?? []).map(declarationSite)

	// Dedup by file+line: the language service's answer and the checker's
	// declaration list usually overlap (non-overloaded symbols appear once).
	const seen = new Set<string>()
	const sites: DefinitionSite[] = []
	const push = (site: DefinitionSite): void => {
		const key = `${site.fileName}:${site.line}:${site.character}`
		if (seen.has(key)) {
			return
		}
		seen.add(key)
		sites.push(site)
	}

	for (const def of definitions) {
		// Line/column must be computed against the DEFINITION's own file
		// (it may not even be in the program — e.g. a d.ts pulled from
		// node_modules is, but a definition in an untyped extra file is not).
		const defSourceFile = intel.program.getSourceFile(def.fileName) ?? readStandalone(def.fileName)
		if (defSourceFile === undefined) {
			continue
		}
		const lineAndChar = ts.getLineAndCharacterOfPosition(defSourceFile, def.textSpan.start)
		push({
			fileName: def.fileName,
			line: lineAndChar.line + 1,
			character: lineAndChar.character + 1,
			kind: def.kind,
			name: def.name,
			containerName: def.containerName,
			snippet: snippetFor(intel, def.fileName, lineAndChar.line + 1),
		})
	}
	for (const site of symbolDeclarations) {
		push(site)
	}
	return sites.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.line - b.line)
}

/** Short kind label for a checker symbol declaration (overload expansion). */
function kindOfDeclaration(decl: ts.Declaration): string {
	if (ts.isFunctionDeclaration(decl)) return "function"
	if (ts.isClassDeclaration(decl)) return "class"
	if (ts.isInterfaceDeclaration(decl)) return "interface"
	if (ts.isTypeAliasDeclaration(decl)) return "type"
	if (ts.isEnumDeclaration(decl)) return "enum"
	if (ts.isModuleDeclaration(decl)) return "namespace"
	if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) return "method"
	if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) return "property"
	if (ts.isGetAccessorDeclaration(decl)) return "getter"
	if (ts.isSetAccessorDeclaration(decl)) return "setter"
	if (ts.isVariableDeclaration(decl)) {
		const list = decl.parent
		if (ts.isVariableDeclarationList(list)) {
			if (list.flags & ts.NodeFlags.Const) return "const"
			if (list.flags & ts.NodeFlags.Let) return "let"
			return "var"
		}
		return "variable"
	}
	return "declaration"
}

/** A definition site from a raw declaration node (name anchor, own file). */
function declarationSite(decl: ts.Declaration): DefinitionSite {
	const sourceFile = decl.getSourceFile()
	const nameNode = (decl as { name?: ts.Node }).name
	const anchor = nameNode ?? decl
	const lineAndChar = ts.getLineAndCharacterOfPosition(sourceFile, anchor.getStart(sourceFile))
	const lineText = sourceFile.text.split(/\r?\n/)[lineAndChar.line] ?? ""
	const trimmed = lineText.trim()
	return {
		fileName: sourceFile.fileName,
		line: lineAndChar.line + 1,
		character: lineAndChar.character + 1,
		kind: kindOfDeclaration(decl),
		name: nameNode !== undefined && ts.isIdentifier(nameNode) ? nameNode.text : "",
		snippet: trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed,
	}
}

/** Parse a file standalone (for files created after the program was loaded). */
function readStandalone(file: string): ts.SourceFile | undefined {
	const text = ts.sys.readFile(file)
	if (text === undefined) {
		return undefined
	}
	return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFromFileName(file))
}

/** Render definition sites as compact, dedup-friendly lines. */
export function formatDefinitions(rel: (p: string) => string, defs: DefinitionSite[]): string {
	if (defs.length === 0) {
		return "Could not resolve a definition for that symbol (it may be ambient, any-typed, or otherwise unresolvable by the type checker)."
	}
	return defs
		.map(
			(d) =>
				`${rel(d.fileName)}:${d.line}:${d.character} ${d.kind} ${d.name}${d.containerName ? ` (in ${d.containerName})` : ""} — ${d.snippet}`,
		)
		.join("\n")
}

/** Relative-path formatter used by the handlers (stable ordering across tools). */
export function makeRelativizer(workspaceRoot: string): (p: string) => string {
	return (p) => {
		const rel = path.relative(workspaceRoot, p)
		return rel === "" || rel.startsWith("..") ? p : rel.split(path.sep).join("/")
	}
}
