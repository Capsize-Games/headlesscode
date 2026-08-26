/**
 * `import_graph` analysis: (a) what a file imports, resolved to real file
 * paths (not raw specifiers), and (b) what imports it (reverse lookup).
 *
 * Static analysis of `ts.ImportDeclaration` / `ts.ExportDeclaration` /
 * `ts.ImportEqualsDeclaration` nodes — imports are syntactic, not
 * type-dependent, so this needs no type-checking: specifiers are resolved
 * with `ts.resolveModuleName` against the cached program's compiler options
 * (so `paths` aliases like `vscode` → the shim resolve exactly as the
 * compiler would).
 *
 * The whole-program import map is built ONCE per loaded program and cached
 * alongside it (see CodeIntelCache): reverse lookups never rescan the
 * project per call.
 */

import * as path from "node:path"
import * as ts from "typescript"

import type { CodeIntel } from "./program.js"

export interface ImportEdge {
	/** Raw module specifier as written in source (e.g. "./foo" or "vscode"). */
	specifier: string
	/** Real resolved file path (undefined when resolution fails). */
	resolved: string | undefined
	/** True for `export ... from` re-exports. */
	isReExport: boolean
	/** True for `import type` / `export type`. */
	isTypeOnly: boolean
}

export interface ImportGraph {
	/** Per absolute file path: everything it imports. */
	imports: Map<string, ImportEdge[]>
	/** Per resolved file path: every absolute file path that imports it. */
	importedBy: Map<string, string[]>
}

/** Resolve a module specifier the same way the compiler would. */
function resolveSpecifier(
	intel: CodeIntel,
	containingFile: string,
	specifier: string,
): string | undefined {
	const result = ts.resolveModuleName(specifier, containingFile, intel.compilerOptions, {
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		getCurrentDirectory: () => path.dirname(containingFile),
		directoryExists: ts.sys.directoryExists,
	})
	return result.resolvedModule?.resolvedFileName
}

/**
 * Build (or return the cached) import graph for the program. The graph is a
 * pure function of the program's source files, so it is computed once and
 * reused until the program itself is rebuilt.
 */
export function getImportGraph(intel: CodeIntel): ImportGraph {
	const cached = (intel as { __importGraph?: ImportGraph }).__importGraph
	if (cached !== undefined) {
		return cached
	}

	const imports = new Map<string, ImportEdge[]>()
	const importedBy = new Map<string, string[]>()

	const addReverseEdge = (resolved: string | undefined, importer: string): void => {
		if (resolved === undefined) {
			return
		}
		const list = importedBy.get(resolved) ?? []
		if (!list.includes(importer)) {
			list.push(importer)
			importedBy.set(resolved, list)
		}
	}

	for (const sourceFile of intel.program.getSourceFiles()) {
		const fileImports: ImportEdge[] = []

		const collect = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node)) {
				if (ts.isStringLiteral(node.moduleSpecifier)) {
					const specifier = node.moduleSpecifier.text
					const resolved = resolveSpecifier(intel, sourceFile.fileName, specifier)
					fileImports.push({
						specifier,
						resolved,
						isReExport: false,
						// The flag lives on the import clause, not the declaration.
						isTypeOnly: node.importClause?.isTypeOnly === true,
					})
					addReverseEdge(resolved, sourceFile.fileName)
				}
			} else if (ts.isExportDeclaration(node)) {
				// ExportDeclaration.moduleSpecifier is optional (`export {}`).
				if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
					const specifier = node.moduleSpecifier.text
					const resolved = resolveSpecifier(intel, sourceFile.fileName, specifier)
					fileImports.push({
						specifier,
						resolved,
						isReExport: true,
						isTypeOnly: node.isTypeOnly === true,
					})
					addReverseEdge(resolved, sourceFile.fileName)
				}
			} else if (ts.isImportEqualsDeclaration(node)) {
				const ref = node.moduleReference
				if (ts.isExternalModuleReference(ref) && ref.expression !== undefined && ts.isStringLiteral(ref.expression)) {
					const specifier = ref.expression.text
					const resolved = resolveSpecifier(intel, sourceFile.fileName, specifier)
					fileImports.push({
						specifier,
						resolved,
						isReExport: false,
						isTypeOnly: false,
					})
					addReverseEdge(resolved, sourceFile.fileName)
				}
			}
		}

		ts.forEachChild(sourceFile, (node) => collect(node))
		if (fileImports.length > 0) {
			imports.set(sourceFile.fileName, fileImports)
		}
	}

	const graph: ImportGraph = { imports, importedBy }
	;(intel as { __importGraph?: ImportGraph }).__importGraph = graph
	return graph
}

/** Absolute path → workspace-relative (posix) for display; absolute if outside. */
function displayPath(workspaceRoot: string, p: string): string {
	const rel = path.relative(workspaceRoot, p)
	return rel === "" || rel.startsWith("..") ? p : rel.split(path.sep).join("/")
}

/** Render the import graph for one file. */
export function formatImportGraph(
	workspaceRoot: string,
	fileName: string,
	graph: ImportGraph,
): string {
	const out: string[] = []

	const edges = graph.imports.get(fileName) ?? []
	out.push(`imports (${edges.length}):`)
	if (edges.length === 0) {
		out.push("  (none)")
	}
	for (const edge of edges) {
		const target = edge.resolved !== undefined ? displayPath(workspaceRoot, edge.resolved) : `(unresolved: ${edge.specifier})`
		const typeOnly = edge.isTypeOnly ? "type " : ""
		const reExport = edge.isReExport ? "export " : "import "
		out.push(`  ${reExport}${typeOnly}${edge.specifier} -> ${target}`)
	}

	const importers = graph.importedBy.get(fileName) ?? []
	out.push(`imported by (${importers.length}):`)
	if (importers.length === 0) {
		out.push("  (none)")
	}
	for (const importer of importers.sort()) {
		out.push(`  ${displayPath(workspaceRoot, importer)}`)
	}

	return out.join("\n")
}
