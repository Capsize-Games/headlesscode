/**
 * Language-neutral code-intelligence backend seam (issue #59).
 *
 * The five code-intelligence tools (outline, go_to_definition,
 * find_references, import_graph, rename_symbol — src/codeintel/) were
 * originally hard-wired to TypeScript: every analyzer took a concrete
 * `CodeIntel` struct (src/codeintel/program.ts) whose fields are
 * `ts.Program` / `ts.LanguageService`, and the executor only registered the
 * tools when the workspace was detected as TypeScript. A Python-only (or
 * Rust/Go/anything-else) workspace got NONE of them — not hidden from the
 * prompt, actually absent from the executor.
 *
 * This file defines the seam that fixes that: `CodeIntelBackend` is the
 * language-neutral interface every analyzer talks through, and
 * `TypeScriptCodeIntelBackend` is the existing ts.Program implementation
 * wrapped behind it with ZERO behavior change (the actual analysis in
 * program.ts/outline.ts/find-references.ts/… is untouched; this class just
 * adapts the old concrete entry points to the interface).
 *
 * `CodeIntelService` (src/codeintel/service.ts) owns per-file backend
 * dispatch: it maps a target file's extension to the language backend that
 * owns it, so a single session on a mixed repo can call find_references on a
 * `.py` file (LSP/pyright backend) and then on a `.ts` file (this backend)
 * in the same turn.
 */

import * as ts from "typescript"

import { outlineSourceFile, type OutlineEntry } from "./outline.js"
import { findDefinition, type DefinitionSite } from "./go-to-definition.js"
import { findReferences as findReferencesInProgram, type ReferenceSite } from "./find-references.js"
import { getImportGraph, type ImportGraph } from "./import-graph.js"
import { renameSymbol as renameSymbolInProgram, type RenameResult } from "./rename-symbol.js"
import { scriptKindFromFileName, getCodeIntelCache } from "./program.js"

/**
 * Where a symbol sits in a file. Mirrors the tools' parameter shape: `line`
 * (1-based) is required; `character` (1-based column) and/or `symbol` (name)
 * disambiguate when the line holds several identifiers.
 */
export interface SymbolPosition {
	/** 1-based line number of the symbol. */
	line: number
	/** 1-based column of the symbol within the line (optional). */
	character?: number
	/** The symbol's name, used to disambiguate when the line has several identifiers. */
	symbol?: string
}

/**
 * Language-neutral code-intelligence backend. Every method returns the SAME
 * shapes the TypeScript analyzers already produced (OutlineEntry /
 * DefinitionSite / ReferenceSite / ImportGraph / RenameResult), so the tool
 * handlers and prompt formats are identical regardless of which backend
 * served a call.
 */
export interface CodeIntelBackend {
	/** Language tag this backend serves (e.g. "typescript", "python"). */
	readonly language: string
	/** Every top-level (and one level of nested) declaration in `file`. */
	outline(file: string): Promise<OutlineEntry[]>
	/** Resolve the definition(s) of the symbol at `position` in `file`. */
	goToDefinition(file: string, position: SymbolPosition): Promise<DefinitionSite[]>
	/** Every real usage site of the symbol at `position` in `file`. */
	findReferences(file: string, position: SymbolPosition): Promise<ReferenceSite[]>
	/**
	 * The whole-project import graph (per file: what it imports, resolved to
	 * real paths, plus reverse lookups). LSP has no standard request for this,
	 * so backends that cannot produce it throw a clear "not supported for this
	 * language yet" error — never a silent empty/wrong graph.
	 */
	importGraph(): Promise<ImportGraph>
	/**
	 * Rename the symbol at `position` in `file` to `newName` everywhere it is
	 * referenced, atomically (either every site updates or none do).
	 */
	renameSymbol(file: string, position: SymbolPosition, newName: string): Promise<RenameResult>
	/** Release process-level resources (kill a language-server child, etc.). */
	dispose(): Promise<void>
}

/**
 * The original TypeScript implementation, wrapped behind `CodeIntelBackend`.
 *
 * Deliberately mechanical: every method adapts the interface's parameters to
 * the existing analyzer entry points (src/codeintel/outline.ts,
 * find-references.ts, go-to-definition.ts, import-graph.ts, rename-symbol.ts)
 * backed by the shared cached `ts.Program` (src/codeintel/program.ts). The
 * analysis itself is byte-for-byte the old code path — this class exists to
 * prove the seam works, not to rewrite the analysis.
 */
export class TypeScriptCodeIntelBackend implements CodeIntelBackend {
	readonly language = "typescript"
	private cache: ReturnType<typeof getCodeIntelCache> | undefined

	constructor(private readonly workspaceRoot: string) {}

	/** The cached program intel for the workspace (load-or-reuse, mtime-invalidated). */
	private intel() {
		this.cache ??= getCodeIntelCache(this.workspaceRoot)
		return this.cache.get()
	}

	async outline(file: string): Promise<OutlineEntry[]> {
		const intel = this.intel()
		const sourceFile = intel.program.getSourceFile(file) ?? readStandalone(file)
		if (sourceFile === undefined) {
			throw new Error(`cannot parse '${file}' as TypeScript`)
		}
		return outlineSourceFile(sourceFile)
	}

	async goToDefinition(file: string, position: SymbolPosition): Promise<DefinitionSite[]> {
		return findDefinition(this.intel(), file, position.line, position.character, position.symbol)
	}

	async findReferences(file: string, position: SymbolPosition): Promise<ReferenceSite[]> {
		return findReferencesInProgram(this.intel(), file, position.line, position.character, position.symbol)
	}

	async importGraph(): Promise<ImportGraph> {
		return getImportGraph(this.intel())
	}

	async renameSymbol(file: string, position: SymbolPosition, newName: string): Promise<RenameResult> {
		return renameSymbolInProgram(
			this.intel(),
			this.workspaceRoot,
			file,
			position.line,
			position.character,
			position.symbol,
			newName,
		)
	}

	async dispose(): Promise<void> {
		// The ts.Program cache is process-lifetime (resetCodeIntelCaches is
		// the test-only escape hatch) — nothing to release here.
	}
}

/** Parse a source file standalone (for files created after program load). */
function readStandalone(file: string): ts.SourceFile | undefined {
	const text = ts.sys.readFile(file)
	if (text === undefined) {
		return undefined
	}
	return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFromFileName(file))
}
