/**
 * `find_implementations` analysis + handler + tool schema: implementations
 * of the interface, abstract, or base-class member at (file, line[,
 * character | symbol]) via `getImplementationAtPosition` — never grep.
 * Results mirror go_to_definition: "rel:line:col kind name — snippet".
 *
 * Vertical slice: analyzer + handler + schema live here; the generic
 * handler helpers come from ./handlers.js.
 */
import type OpenAI from "openai"
import * as ts from "typescript"
import type { ToolContext, ToolResult } from "../engine/types.js"
import {
	intelFor,
	lineArg,
	optionalCharacterArg,
	optionalStringArg,
	readStandalone,
	requireStringArg,
	resolveTarget,
} from "./handlers.js"
import { identifierAtPosition } from "./position.js"
import { type CodeIntel } from "./program.js"
import { makeRelativizer } from "./go-to-definition.js"

export interface ImplementationSite {
	fileName: string
	line: number
	character: number
	kind: string
	name: string
	snippet: string
}
/** Read an implementation's line text from the program or disk. */
function snippetFor(intel: CodeIntel, file: string, line: number): string {
	const sourceFile = intel.program.getSourceFile(file)
	const text = sourceFile?.text ?? (ts.sys.readFile(file) ?? "")
	const found = text.split(/\r?\n/)[line - 1] ?? ""
	const trimmed = found.trim()
	return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed
}
/** The query file's parse, from the program or standalone. */
function sourceFileFor(intel: CodeIntel, file: string): ts.SourceFile {
	const sourceFile = intel.program.getSourceFile(file) ?? readStandalone(file)
	if (sourceFile === undefined) throw new Error("file is not in the program")
	return sourceFile
}
/** The identifier under `offset`, or "" when the offset misses a name. */
function nameAtOffset(sourceFile: ts.SourceFile, offset: number): string {
	let found = ""
	const touches = (node: ts.Identifier): boolean =>
		offset >= node.getStart(sourceFile) && offset <= node.getEnd()
	const visit = (node: ts.Node): void => {
		if (found === "" && ts.isIdentifier(node) && touches(node)) found = node.text
		else ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return found
}
/** One site from a raw implementation location (own-file anchor). */
function toSite(
	intel: CodeIntel,
	loc: ts.ImplementationLocation,
): ImplementationSite | undefined {
	const defSource = intel.program.getSourceFile(loc.fileName)
		?? readStandalone(loc.fileName)
	if (defSource === undefined) return undefined
	const at = ts.getLineAndCharacterOfPosition(defSource, loc.textSpan.start)
	return {
		fileName: loc.fileName, line: at.line + 1, character: at.character + 1,
		kind: loc.kind, name: nameAtOffset(defSource, loc.textSpan.start),
		snippet: snippetFor(intel, loc.fileName, at.line + 1),
	}
}
/** Collect + sort the implementation sites for one identifier. */
function collectSites(
	intel: CodeIntel,
	file: string,
	sourceFile: ts.SourceFile,
	id: ts.Identifier,
): ImplementationSite[] {
	intel.includeExtraFile(file)
	const start = id.getStart(sourceFile)
	const ls = intel.languageService
	const found = ls.getImplementationAtPosition(file, start) ?? []
	const sites: ImplementationSite[] = []
	for (const loc of found) {
		const site = toSite(intel, loc)
		if (site !== undefined) sites.push(site)
	}
	const byFile = (a: ImplementationSite, b: ImplementationSite): number =>
		a.fileName.localeCompare(b.fileName) || a.line - b.line
	return sites.sort(byFile)
}
/**
 * Find implementations of the symbol at `line` (1-based) in `file`.
 * `character` (1-based column) and/or `symbol` (name) disambiguate when
 * the line holds multiple identifiers.
 */
export function findImplementations(
	intel: CodeIntel,
	file: string,
	line: number,
	character: number | undefined,
	symbol: string | undefined,
): ImplementationSite[] {
	const sourceFile = sourceFileFor(intel, file)
	const id = identifierAtPosition(sourceFile, line, character, symbol)
	if (id === undefined) return []
	return collectSites(intel, file, sourceFile, id)
}
/** One result line: rel:line:col kind name — snippet. */
function lineFor(
	rel: (p: string) => string,
	site: ImplementationSite,
): string {
	const at = `${rel(site.fileName)}:${site.line}:${site.character}`
	return `${at} ${site.kind} ${site.name} — ${site.snippet}`
}
const NO_IMPLEMENTATIONS = "No implementations found for that symbol "
	+ "(try an interface, abstract, or base-class member)."
/** Render sites exactly like go_to_definition lines (or no-results text). */
export function formatImplementations(
	rel: (p: string) => string,
	sites: ImplementationSite[],
): string {
	if (sites.length === 0) return NO_IMPLEMENTATIONS
	return sites.map((s) => lineFor(rel, s)).join("\n")
}
export function findImplementationsHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
): ToolResult {
	const tool = "find_implementations"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTarget(ctx, tool, filePath)
	const line = lineArg(args, tool)
	const character = optionalCharacterArg(args)
	const symbol = optionalStringArg(args, "symbol")
	const intel = intelFor(ctx)
	const sites = findImplementations(intel, target, line, character, symbol)
	const rel = makeRelativizer(ctx.workspaceRoot)
	return { content: formatImplementations(rel, sites), isError: false }
}

const FIND_IMPLEMENTATIONS_DESCRIPTION = `Find the implementations of the
interface, abstract, or base-class member at a given line, using the
TypeScript compiler's real implementation resolution (not grep). Returns
"<file>:<line>:<column> <kind> <name> — <snippet>" lines, one per member.

Use this to answer "who implements or overrides this member?".

Only works on TypeScript/JavaScript source files. A symbol with no
implementations returns a clear "no implementations found" message.

Parameters:
- path: (required) Source file with the symbol, relative to workspace root.
- line: (required) 1-based line number of the symbol.
- character: (optional) 1-based column; omit to use symbol or first identifier.
- symbol: (optional) Disambiguating name; ignored when character is given.

Example: { "path": "src/shapes.ts", "line": 2, "symbol": "area" }`
const FI_PATH_DESC = `Source file with the symbol, relative to workspace root`
const FI_LINE_DESC = `1-based line number of the symbol`
const FI_CHAR_DESC = `1-based column; omit to use symbol or first identifier`
const FI_SYMBOL_DESC = `Disambiguating name; ignored when character is given`
export const findImplementationsTool = {
	type: "function",
	function: {
		name: "find_implementations",
		description: FIND_IMPLEMENTATIONS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: FI_PATH_DESC },
				line: { type: "integer", description: FI_LINE_DESC },
				character: { type: ["integer", "null"], description: FI_CHAR_DESC },
				symbol: { type: ["string", "null"], description: FI_SYMBOL_DESC },
			},
			required: ["path", "line", "character", "symbol"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
