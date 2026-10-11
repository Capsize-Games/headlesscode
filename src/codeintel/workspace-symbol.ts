/**
 * `workspace_symbol`: substring search over named declarations in the
 * workspace's own files (projectFiles only — never node_modules/lib .d.ts).
 *
 * Vertical slice: analyzer + handler + schema live here; the generic
 * result helpers come from ./handlers.js.
 */

import type OpenAI from "openai"
import * as ts from "typescript"

import type { ToolContext, ToolResult } from "../engine/types.js"
import { makeRelativizer } from "./go-to-definition.js"
import { err, ok } from "./handlers.js"
import {
	getCodeIntelCache, scriptKindFromFileName, type CodeIntel,
} from "./program.js"

export interface SymbolMatch {
	fileName: string
	line: number
	kind: string
	name: string
}

/** Default and hard cap for matches returned per call. */
export const DEFAULT_SYMBOL_LIMIT = 30
export const MAX_SYMBOL_LIMIT = 100

/** Map a declaration node to a short human kind label. */
function kindOf(node: ts.Node): string | undefined {
	if (ts.isFunctionDeclaration(node)) return "function"
	if (ts.isClassDeclaration(node)) return "class"
	if (ts.isInterfaceDeclaration(node)) return "interface"
	if (ts.isTypeAliasDeclaration(node)) return "type"
	if (ts.isEnumDeclaration(node)) return "enum"
	if (ts.isModuleDeclaration(node)) return "namespace"
	if (ts.isMethodDeclaration(node)) return "method"
	if (ts.isMethodSignature(node)) return "method"
	if (ts.isConstructorDeclaration(node)) return "constructor"
	if (ts.isPropertyDeclaration(node)) return "property"
	if (ts.isPropertySignature(node)) return "property"
	if (ts.isGetAccessorDeclaration(node)) return "getter"
	if (ts.isSetAccessorDeclaration(node)) return "setter"
	return undefined
}

/** True for kinds whose members are worth searching one level deep. */
function isContainerKind(kind: string | undefined): boolean {
	return (
		kind === "class" ||
		kind === "interface" ||
		kind === "namespace" ||
		kind === "enum"
	)
}

/** Append one match anchored at `anchor` within `sourceFile`. */
function pushMatch(
	out: SymbolMatch[],
	sourceFile: ts.SourceFile,
	kind: string,
	name: string,
	anchor: ts.Node,
): void {
	const start = anchor.getStart(sourceFile)
	const pos = ts.getLineAndCharacterOfPosition(sourceFile, start)
	out.push({ fileName: sourceFile.fileName, line: pos.line + 1, kind, name })
}

/** Record the node when it is a named declaration matching the query. */
function collectNode(
	node: ts.Node,
	sourceFile: ts.SourceFile,
	queryLower: string,
	out: SymbolMatch[],
): void {
	const kind = kindOf(node)
	const name = (node as { name?: ts.Node }).name
	if (kind === undefined || name === undefined || !ts.isIdentifier(name)) {
		return
	}
	if (!name.text.toLowerCase().includes(queryLower)) {
		return
	}
	pushMatch(out, sourceFile, kind, name.text, name)
}

/** Collect each identifier-bound name a variable statement declares. */
function collectVariables(
	stmt: ts.VariableStatement,
	sourceFile: ts.SourceFile,
	queryLower: string,
	out: SymbolMatch[],
): void {
	const flags = stmt.declarationList.flags
	const isConst = (flags & ts.NodeFlags.Const) !== 0
	const isLet = (flags & ts.NodeFlags.Let) !== 0
	const kind = isConst ? "const" : isLet ? "let" : "var"
	for (const decl of stmt.declarationList.declarations) {
		const name = ts.isIdentifier(decl.name) ? decl.name : undefined
		if (name === undefined || !name.text.toLowerCase().includes(queryLower)) {
			continue
		}
		pushMatch(out, sourceFile, kind, name.text, name)
	}
}

/** Collect matches from one statement; recurse into containers only. */
function walkTree(
	node: ts.Node,
	sourceFile: ts.SourceFile,
	queryLower: string,
	out: SymbolMatch[],
): void {
	if (ts.isVariableStatement(node)) {
		collectVariables(node, sourceFile, queryLower, out)
		return
	}
	collectNode(node, sourceFile, queryLower, out)
	if (isContainerKind(kindOf(node))) {
		ts.forEachChild(node, (child) =>
			walkTree(child, sourceFile, queryLower, out),
		)
	}
}

/**
 * Search every project file for declarations whose name contains `query`
 * (case-insensitive). Returns ALL matches sorted by file then line; the
 * caller caps via `formatSymbolMatches`.
 */
export function searchWorkspaceSymbols(
	intel: CodeIntel,
	query: string,
): SymbolMatch[] {
	const queryLower = query.toLowerCase()
	const matches: SymbolMatch[] = []
	for (const file of intel.projectFiles) {
		const sourceFile = intel.program.getSourceFile(file) ?? readStandalone(file)
		if (sourceFile === undefined) {
			continue
		}
		ts.forEachChild(sourceFile, (child) =>
			walkTree(child, sourceFile, queryLower, matches),
		)
	}
	matches.sort(
		(a, b) => a.fileName.localeCompare(b.fileName) || a.line - b.line,
	)
	return matches
}

/** Parse a file standalone (for files created after the program load). */
function readStandalone(file: string): ts.SourceFile | undefined {
	const text = ts.sys.readFile(file)
	if (text === undefined) {
		return undefined
	}
	const kind = scriptKindFromFileName(file)
	return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
}

/** Render matches as `rel:line kind name` lines, capped at `limit`. */
export function formatSymbolMatches(
	rel: (p: string) => string,
	matches: SymbolMatch[],
	query: string,
	limit: number,
): string {
	if (matches.length === 0) {
		return `No symbols matching "${query}" found in the workspace.`
	}
	const shown = matches.slice(0, limit)
	const lines = shown.map(
		(m) => `${rel(m.fileName)}:${m.line} ${m.kind} ${m.name}`,
	)
	const overflow = matches.length - shown.length
	if (overflow > 0) {
		lines.push(`... truncated, ${overflow} more`)
	}
	return lines.join("\n")
}

/** Limit with a default of 30 and a hard cap of 100. */
function limitArg(args: Record<string, unknown>): number {
	const v = args["limit"]
	const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN
	if (Number.isInteger(n) && n >= 1) {
		return Math.min(n, MAX_SYMBOL_LIMIT)
	}
	return DEFAULT_SYMBOL_LIMIT
}

export function workspaceSymbolHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
): ToolResult {
	const tool = "workspace_symbol"
	const query = args["query"]
	if (typeof query !== "string" || query.trim() === "") {
		return err(`${tool}: 'query' must be a non-empty string`)
	}
	const trimmed = query.trim()
	const intel = getCodeIntelCache(ctx.workspaceRoot).get()
	const matches = searchWorkspaceSymbols(intel, trimmed)
	const rel = makeRelativizer(ctx.workspaceRoot)
	return ok(formatSymbolMatches(rel, matches, trimmed, limitArg(args)))
}

const WORKSPACE_SYMBOL_DESCRIPTION = `Search the whole workspace for symbols (functions, classes, interfaces, type aliases, enums, namespaces, variables, and class/interface members) whose name contains the query, case-insensitively. Returns compact "<file>:<line> <kind> <name>" lines sorted by file then line, capped at the limit with a clear truncation note. Searches the workspace's own source files only — never node_modules or lib .d.ts files.

Use this to locate a symbol by (partial) name without knowing which file defines it.

Parameters:
- query: (required) Name fragment to search for (case-insensitive substring, e.g. "user" matches fetchUser, UserCache, userCount).
- limit: (optional) Maximum matches to return (default 30, hard cap 100).

Example: { "query": "cache", "limit": 10 }`

const WS_QUERY_PARAMETER_DESCRIPTION = `Name fragment to search for (case-insensitive substring match against declaration names)`
const WS_LIMIT_PARAMETER_DESCRIPTION = `Maximum matches to return (default 30, hard cap 100)`

export const workspaceSymbolTool = {
	type: "function",
	function: {
		name: "workspace_symbol",
		description: WORKSPACE_SYMBOL_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: WS_QUERY_PARAMETER_DESCRIPTION },
				limit: {
					type: ["integer", "null"],
					description: WS_LIMIT_PARAMETER_DESCRIPTION,
				},
			},
			required: ["query", "limit"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
