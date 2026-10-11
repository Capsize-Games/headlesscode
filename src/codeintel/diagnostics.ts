/**
 * `get_diagnostics`: syntactic + semantic compiler diagnostics for one
 * workspace file, via the shared cached `ts.Program` — the same errors
 * `tsc` would report, one compact line each plus a summary.
 *
 * Vertical slice: analyzer + handler + schema live here; the generic
 * handler helpers come from ./handlers.js.
 */

import type OpenAI from "openai"
import * as ts from "typescript"

import type { ToolContext, ToolResult } from "../engine/types.js"
import { makeRelativizer } from "./go-to-definition.js"
import {
	err,
	intelFor,
	ok,
	requireStringArg,
	resolveTarget,
} from "./handlers.js"
import { scriptKindFromFileName, type CodeIntel } from "./program.js"

/** Hard cap on diagnostic entries per call (model context stays bounded). */
export const MAX_DIAGNOSTICS = 50

/**
 * Syntactic + semantic diagnostics for `sourceFile`, sorted by file
 * position. Files created after load are checked through the language service using
 * the same compiler options and their current disk contents.
 */
export function collectDiagnostics(
	intel: CodeIntel,
	sourceFile: ts.SourceFile,
): ts.Diagnostic[] {
	const inProgram =
		intel.program.getSourceFile(sourceFile.fileName) !== undefined
	if (!inProgram) {
		intel.includeExtraFile(sourceFile.fileName)
		return [
			...intel.languageService.getSyntacticDiagnostics(sourceFile.fileName),
			...intel.languageService.getSemanticDiagnostics(sourceFile.fileName),
		].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
	}
	const all = [
		...intel.program.getSyntacticDiagnostics(sourceFile),
		...intel.program.getSemanticDiagnostics(sourceFile),
	]
	return all.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
}

/** Render diagnostics as `rel:line:col TS<code> message` lines + summary. */
export function formatDiagnostics(
	rel: string,
	sourceFile: ts.SourceFile,
	diagnostics: readonly ts.Diagnostic[],
): string {
	const shown = diagnostics.slice(0, MAX_DIAGNOSTICS)
	const lines = shown.map((d) => formatOne(rel, sourceFile, d))
	const overflow = diagnostics.length - shown.length
	if (overflow > 0) {
		lines.push(`... truncated, ${overflow} more`)
	}
	lines.push(`${diagnostics.length} error(s) in ${rel}`)
	return lines.join("\n")
}

/** One diagnostic as `rel:line:col TS<code> flattened message`. */
function formatOne(
	rel: string,
	sourceFile: ts.SourceFile,
	diagnostic: ts.Diagnostic,
): string {
	const at = ts.getLineAndCharacterOfPosition(
		sourceFile,
		diagnostic.start ?? 0,
	)
	const flat = ts.flattenDiagnosticMessageText(
		diagnostic.messageText,
		" ",
	)
	const message = flat.replace(/[\r\n]+/g, " ")
	return `${rel}:${at.line + 1}:${at.character + 1} ` +
		`TS${diagnostic.code} ${message}`
}

/** Tool handler: diagnostics for one workspace-relative file path. */
export function getDiagnosticsHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
): ToolResult {
	const tool = "get_diagnostics"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTarget(ctx, tool, filePath)
	const rel = makeRelativizer(ctx.workspaceRoot)(target)
	const intel = intelFor(ctx)
	const sourceFile = loadSourceFile(intel, target)
	if (sourceFile === undefined) {
		return err(`${tool}: cannot parse '${rel}' as TypeScript`)
	}
	const diagnostics = collectDiagnostics(intel, sourceFile)
	return ok(formatDiagnostics(rel, sourceFile, diagnostics))
}

/** Program source file, or a standalone parse for post-load files. */
function loadSourceFile(
	intel: CodeIntel,
	target: string,
): ts.SourceFile | undefined {
	return intel.program.getSourceFile(target) ??
		readStandalone(intel, target)
}

/** Parse a file standalone against the program's compiler options. */
function readStandalone(
	intel: CodeIntel,
	file: string,
): ts.SourceFile | undefined {
	const text = ts.sys.readFile(file)
	if (text === undefined) {
		return undefined
	}
	return ts.createSourceFile(
		file,
		text,
		intel.compilerOptions.target ?? ts.ScriptTarget.Latest,
		true,
		scriptKindFromFileName(file),
	)
}

// ─── get_diagnostics tool schema ─────────────────────────────────────────────

const GET_DIAGNOSTICS_DESCRIPTION = `Report the TypeScript compiler errors in one source file — syntactic plus semantic diagnostics, the same errors tsc would report — as one compact line per error ("<file>:<line>:<col> TS<code> <message>") plus a final "<N> error(s) in <file>" summary. Results are capped at 50 entries with a clear "... truncated, M more" note.

Use this to check a file for type errors and syntax errors without running a build.

Only works on TypeScript/JavaScript source files (.ts/.tsx/.mts/.cts/.js/.jsx). Non-TS files return a clear "not supported" result.

Parameters:
- path: (required) Path to the source file to check, relative to the workspace root.

Example: { "path": "src/engine/loop.ts" }`

const GET_DIAGNOSTICS_PATH_PARAMETER_DESCRIPTION = `Path to the source file to check, relative to the workspace root`

export const getDiagnosticsTool = {
	type: "function",
	function: {
		name: "get_diagnostics",
		description: GET_DIAGNOSTICS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: GET_DIAGNOSTICS_PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
