/**
 * Tool handlers for the code-intelligence tools (`outline`,
 * `go_to_definition`, `find_references`, `import_graph`, `rename_symbol`).
 *
 * Thin layer over the language-neutral backend seam (src/codeintel/backend.ts
 * + src/codeintel/service.ts): argument parsing, path safety, the "not
 * supported for this file type" honesty rule, and result formatting. Every
 * analysis call goes through a `CodeIntelBackend` resolved per-file by the
 * `CodeIntelService` — TypeScript/JavaScript via the ts.Program backend,
 * Python via the LSP/pyright backend — so a single session on a mixed
 * workspace dispatches each call to the right language's backend.
 *
 * Files whose language has no backend NEVER produce a guessed answer: they
 * get a clear "[Error] ... not a supported file type" result. Missing files
 * and files that escaped the workspace root error the same way the rest of
 * the executor does.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import type { ToolContext, ToolResult } from "../engine/types.js"
import { resolveWithinWorkspace } from "../tools/executor.js"
import type { CodeIntelService } from "./service.js"
import { formatOutline } from "./outline.js"
import { formatDefinitions, makeRelativizer } from "./go-to-definition.js"
import { formatReferences } from "./find-references.js"
import { formatImportGraph } from "./import-graph.js"
import { formatRenameResult } from "./rename-symbol.js"

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

/** Workspace-relative (posix) display path; absolute if somehow outside. */
function relPath(workspaceRoot: string, p: string): string {
	const rel = path.relative(workspaceRoot, p)
	return rel === "" || rel.startsWith("..") ? p : rel.split(path.sep).join("/")
}

/**
 * Path-safety-checked absolute target + existence/file validation. Language
 * support is deliberately NOT checked here — the CodeIntelService decides it
 * (per-file extension dispatch), so the "not supported" message can name the
 * workspace's actual backends instead of hard-coding TypeScript.
 */
function resolveTargetFile(ctx: ToolContext, tool: string, p: string): string {
	const target = resolveWithinWorkspace(ctx.workspaceRoot, p)
	const rel = relPath(ctx.workspaceRoot, target)

	let stat: fs.Stats
	try {
		stat = fs.statSync(target)
	} catch {
		throw new Error(`${tool}: cannot stat '${rel}' — file does not exist`)
	}
	if (!stat.isFile()) {
		throw new Error(`${tool}: '${rel}' is not a file`)
	}
	return target
}

/** The not-supported result for a file whose language has no backend here. */
function notSupportedResult(ctx: ToolContext, tool: string, target: string): ToolResult {
	const rel = relPath(ctx.workspaceRoot, target)
	return err(
		`${tool}: '${rel}' is not a supported file type for this workspace's code-intelligence tools — ` +
			`no backend is available for its language (this workspace's backends are determined by its detected languages; ` +
			`TypeScript/JavaScript and Python are supported when present)`,
	)
}

// ─── outline ─────────────────────────────────────────────────────────────────

export async function outlineHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
	service: CodeIntelService,
): Promise<ToolResult> {
	const tool = "outline"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTargetFile(ctx, tool, filePath)
	const rel = relPath(ctx.workspaceRoot, target)

	const backend = await service.resolveBackend(target)
	if (backend === undefined) {
		return notSupportedResult(ctx, tool, target)
	}
	const entries = await backend.outline(target)
	return ok(`Outline of ${rel}:\n${formatOutline(entries)}`)
}

// ─── go_to_definition ────────────────────────────────────────────────────────

export async function goToDefinitionHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
	service: CodeIntelService,
): Promise<ToolResult> {
	const tool = "go_to_definition"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTargetFile(ctx, tool, filePath)
	const line = lineArg(args, tool)
	const character = optionalCharacterArg(args)
	const symbol = optionalStringArg(args, "symbol")

	const backend = await service.resolveBackend(target)
	if (backend === undefined) {
		return notSupportedResult(ctx, tool, target)
	}
	const defs = await backend.goToDefinition(target, { line, character, symbol })
	const rel = makeRelativizer(ctx.workspaceRoot)
	return ok(formatDefinitions(rel, defs))
}

// ─── find_references ─────────────────────────────────────────────────────────

export async function findReferencesHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
	service: CodeIntelService,
): Promise<ToolResult> {
	const tool = "find_references"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTargetFile(ctx, tool, filePath)
	const line = lineArg(args, tool)
	const character = optionalCharacterArg(args)
	const symbol = optionalStringArg(args, "symbol")

	const backend = await service.resolveBackend(target)
	if (backend === undefined) {
		return notSupportedResult(ctx, tool, target)
	}
	const sites = await backend.findReferences(target, { line, character, symbol })
	const rel = makeRelativizer(ctx.workspaceRoot)
	return ok(formatReferences(rel, sites))
}

// ─── rename_symbol ───────────────────────────────────────────────────────────

export async function renameSymbolHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
	service: CodeIntelService,
): Promise<ToolResult> {
	const tool = "rename_symbol"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTargetFile(ctx, tool, filePath)
	const line = lineArg(args, tool)
	const character = optionalCharacterArg(args)
	const symbol = optionalStringArg(args, "symbol")
	const newName = requireStringArg(args, "new_name", tool)

	const backend = await service.resolveBackend(target)
	if (backend === undefined) {
		return notSupportedResult(ctx, tool, target)
	}
	// Throws (wrapped by ToolExecutor.execute as `Tool 'rename_symbol' failed:
	// …`) on any validation failure or a mid-write failure after rollback.
	const result = await backend.renameSymbol(target, { line, character, symbol }, newName)
	return ok(formatRenameResult(ctx.workspaceRoot, result))
}

// ─── import_graph ────────────────────────────────────────────────────────────

export async function importGraphHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
	service: CodeIntelService,
): Promise<ToolResult> {
	const tool = "import_graph"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTargetFile(ctx, tool, filePath)

	const backend = await service.resolveBackend(target)
	if (backend === undefined) {
		return notSupportedResult(ctx, tool, target)
	}
	const graph = await backend.importGraph()
	return ok(formatImportGraph(ctx.workspaceRoot, target, graph))
}
