/**
 * Tool handlers for the four code-intelligence tools (`outline`,
 * `go_to_definition`, `find_references`, `import_graph`).
 *
 * Thin layer over the shared analysis module (src/codeintel/program.ts +
 * the per-tool analyzers): argument parsing, path safety, the "not supported
 * for this file type" honesty rule, and result formatting. All four share ONE
 * cached `ts.Program` per workspace root — see program.ts for the caching +
 * mtime-invalidation contract.
 *
 * Non-TS/JS files NEVER produce a guessed answer: they get a clear
 * "[Error] ... not a supported file type" result. Missing files and files
 * that escaped the workspace root error the same way the rest of the
 * executor does.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as ts from "typescript"

import type { ToolContext, ToolResult } from "../engine/types.js"
import { resolveWithinWorkspace } from "../tools/executor.js"
import { getCodeIntelCache, isSupportedSource, scriptKindFromFileName } from "./program.js"
import { formatOutline, outlineSourceFile } from "./outline.js"
import { findDefinition, formatDefinitions, makeRelativizer } from "./go-to-definition.js"
import { findReferences, formatReferences } from "./find-references.js"
import { formatImportGraph, getImportGraph } from "./import-graph.js"
import { formatRenameResult, renameSymbol } from "./rename-symbol.js"

function ok(content: string): ToolResult {
	return { content, isError: false }
}

function err(content: string): ToolResult {
	return { content: `[Error] ${content}`, isError: true }
}

function requireStringArg(args: Record<string, unknown>, key: string, tool: string): string {
	const v = args[key]
	if (typeof v !== "string" || v.trim() === "") {
		throw new Error(`${tool}: missing or invalid string argument '${key}' (got ${JSON.stringify(v)})`)
	}
	return v
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key]
	if (v === undefined || v === null) {
		return undefined
	}
	if (typeof v !== "string") {
		return undefined
	}
	return v.trim() === "" ? undefined : v
}

/** Parse a 1-based line (required) or column (optional); invalid → throw/undefined. */
function lineArg(args: Record<string, unknown>, tool: string): number {
	const v = args["line"]
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`${tool}: invalid line '${JSON.stringify(v)}' — must be a 1-based line number`)
	}
	return n
}

function optionalCharacterArg(args: Record<string, unknown>): number | undefined {
	const v = args["character"]
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
	if (Number.isInteger(n) && n >= 1) {
		return n
	}
	return undefined
}

/** Path-safety-checked absolute target + existence/type/support validation. */
function resolveTarget(ctx: ToolContext, tool: string, p: string): string {
	const target = resolveWithinWorkspace(ctx.workspaceRoot, p)
	const rel = path.relative(ctx.workspaceRoot, target).split(path.sep).join("/") || path.basename(target)

	let stat: fs.Stats
	try {
		stat = fs.statSync(target)
	} catch {
		throw new Error(`${tool}: cannot stat '${rel}' — file does not exist`)
	}
	if (!stat.isFile()) {
		throw new Error(`${tool}: '${rel}' is not a file`)
	}
	if (!isSupportedSource(target)) {
		throw new Error(
			`${tool}: '${rel}' is not a supported file type — code-intelligence tools work on TypeScript/JavaScript source files only (.ts/.tsx/.mts/.cts/.js/.jsx)`,
		)
	}
	return target
}

/** The cached program intel for a workspace (load-or-reuse). */
function intelFor(ctx: ToolContext) {
	return getCodeIntelCache(ctx.workspaceRoot).get()
}

// ─── outline ─────────────────────────────────────────────────────────────────

export function outlineHandler(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
	const tool = "outline"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTarget(ctx, tool, filePath)
	const rel = path.relative(ctx.workspaceRoot, target).split(path.sep).join("/") || path.basename(target)

	const intel = intelFor(ctx)
	const sourceFile = intel.program.getSourceFile(target) ?? readStandalone(target)
	if (sourceFile === undefined) {
		return err(`${tool}: cannot parse '${rel}' as TypeScript`)
	}
	const entries = outlineSourceFile(sourceFile)
	return ok(`Outline of ${rel}:\n${formatOutline(entries)}`)
}

// ─── go_to_definition ────────────────────────────────────────────────────────

export function goToDefinitionHandler(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
	const tool = "go_to_definition"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTarget(ctx, tool, filePath)
	const line = lineArg(args, tool)
	const character = optionalCharacterArg(args)
	const symbol = optionalStringArg(args, "symbol")

	const intel = intelFor(ctx)
	const defs = findDefinition(intel, target, line, character, symbol)
	const rel = makeRelativizer(ctx.workspaceRoot)
	return ok(formatDefinitions(rel, defs))
}

// ─── find_references ─────────────────────────────────────────────────────────

export function findReferencesHandler(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
	const tool = "find_references"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTarget(ctx, tool, filePath)
	const line = lineArg(args, tool)
	const character = optionalCharacterArg(args)
	const symbol = optionalStringArg(args, "symbol")

	const intel = intelFor(ctx)
	const sites = findReferences(intel, target, line, character, symbol)
	const rel = makeRelativizer(ctx.workspaceRoot)
	return ok(formatReferences(rel, sites))
}

// ─── rename_symbol ───────────────────────────────────────────────────────────

export function renameSymbolHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
	const tool = "rename_symbol"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTarget(ctx, tool, filePath)
	const line = lineArg(args, tool)
	const character = optionalCharacterArg(args)
	const symbol = optionalStringArg(args, "symbol")
	const newName = requireStringArg(args, "new_name", tool)

	const intel = intelFor(ctx)
	// Throws (wrapped by ToolExecutor.execute as `Tool 'rename_symbol' failed:
	// …`) on any validation failure or a mid-write failure after rollback.
	return renameSymbol(intel, ctx.workspaceRoot, target, line, character, symbol, newName).then((result) =>
		ok(formatRenameResult(ctx.workspaceRoot, result)),
	)
}

// ─── import_graph ────────────────────────────────────────────────────────────

export function importGraphHandler(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
	const tool = "import_graph"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTarget(ctx, tool, filePath)

	const intel = intelFor(ctx)
	const graph = getImportGraph(intel)
	return ok(formatImportGraph(ctx.workspaceRoot, target, graph))
}

/** Parse a source file standalone (for files created after program load). */
function readStandalone(file: string): ts.SourceFile | undefined {
	const text = ts.sys.readFile(file)
	if (text === undefined) {
		return undefined
	}
	return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFromFileName(file))
}
