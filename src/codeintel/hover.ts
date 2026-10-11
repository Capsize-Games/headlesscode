/**
 * `type_at_position`: hover-type info for the symbol at (file, line[,
 * character | symbol]) via the language service's real
 * `getQuickInfoAtPosition` — signature plus JSDoc, never a guess. No
 * identifier there, or no quick info, yields a clear could-not-resolve
 * message, not an error or a crash.
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
	ok,
	optionalCharacterArg,
	optionalStringArg,
	readStandalone,
	requireStringArg,
	resolveTarget,
} from "./handlers.js"
import { identifierAtPosition } from "./position.js"
import { type CodeIntel } from "./program.js"

/** Hover text for one symbol: signature line + optional docs/tags. */
export interface HoverInfo {
	signature: string
	documentation: string
	tags: string[]
}

/** Join display parts into plain text (missing parts → ""). */
function textOf(parts: readonly ts.SymbolDisplayPart[] | undefined): string {
	return (parts ?? []).map((part) => part.text).join("")
}

/** The program's parse of `file`, or a standalone parse when absent. */
function sourceFileFor(intel: CodeIntel, file: string): ts.SourceFile {
	const source = intel.program.getSourceFile(file) ?? readStandalone(file)
	if (source === undefined) {
		throw new Error(
			`file is not part of the loaded TypeScript program: ${file}`,
		)
	}
	return source
}

/**
 * Hover info for the symbol at `line` (1-based) in `file`. `character`
 * (1-based column) and/or `symbol` (name) disambiguate multi-identifier
 * lines. Undefined when no identifier sits there or the checker has no
 * quick info for it.
 */
export function getHover(
	intel: CodeIntel,
	file: string,
	line: number,
	character: number | undefined,
	symbol: string | undefined,
): HoverInfo | undefined {
	const source = sourceFileFor(intel, file)
	const id = identifierAtPosition(source, line, character, symbol)
	if (id === undefined) {
		return undefined
	}
	intel.includeExtraFile(file)
	const pos = id.getStart(source)
	const quick = intel.languageService.getQuickInfoAtPosition(file, pos)
	if (quick === undefined) {
		return undefined
	}
	return {
		signature: textOf(quick.displayParts),
		documentation: textOf(quick.documentation),
		tags: (quick.tags ?? []).map(
			(tag) => `@${tag.name} ${textOf(tag.text)}`.trim(),
		),
	}
}

/** Render hover info: one signature line, then docs + tags when present. */
export function formatHover(hover: HoverInfo | undefined): string {
	if (hover === undefined) {
		return "Could not resolve type information for that symbol"
			+ " (there may be no identifier at that spot,"
			+ " or the type checker has no hover info for it)."
	}
	const lines = [hover.signature]
	if (hover.documentation !== "") {
		lines.push("", hover.documentation)
	}
	for (const tag of hover.tags) {
		lines.push(tag)
	}
	return lines.join("\n")
}

export function typeAtPositionHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
): ToolResult {
	const tool = "type_at_position"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTarget(ctx, tool, filePath)
	const line = lineArg(args, tool)
	const character = optionalCharacterArg(args)
	const symbol = optionalStringArg(args, "symbol")

	const intel = intelFor(ctx)
	return ok(formatHover(getHover(intel, target, line, character, symbol)))
}

const TYPE_AT_POSITION_DESCRIPTION = `Show the hover-type info for the symbol at a given line of a source file, using the TypeScript compiler's real quick info (not a guess): one signature line (e.g. "function add(a: number, b: number): number" or "const greeting: string") followed by the symbol's documentation comment and JSDoc tags when present.

Use this to learn a symbol's inferred or declared type and its docs without reading the defining file.

Only works on TypeScript/JavaScript source files. A spot with no identifier, or a symbol the checker has no info for, returns a clear "could not resolve" message.

Parameters:
- path: (required) Path to the source file containing the symbol, relative to the workspace root.
- line: (required) 1-based line number of the symbol.
- character: (optional) 1-based column of the symbol within the line. Needed when the line has multiple symbols and you want a specific one; omit to use the symbol name or the first identifier on the line.
- symbol: (optional) The symbol's name, used to disambiguate when the line has several identifiers (e.g. { "path": "src/foo.ts", "line": 12, "symbol": "bar" }). Ignored when character is given.

Example: hover the call on line 42: { "path": "src/engine/loop.ts", "line": 42, "symbol": "truncateHistory" }`

const TAP_PATH_PARAMETER_DESCRIPTION = `Path to the source file containing the symbol, relative to the workspace root`
const TAP_LINE_PARAMETER_DESCRIPTION = `1-based line number of the symbol`
const TAP_CHARACTER_PARAMETER_DESCRIPTION = `1-based column of the symbol within the line (disambiguates on multi-symbol lines); omit to use symbol name or the first identifier on the line`
const TAP_SYMBOL_PARAMETER_DESCRIPTION = `Symbol name to disambiguate when the line has several identifiers; ignored when character is given`

export const typeAtPositionTool = {
	type: "function",
	function: {
		name: "type_at_position",
		description: TYPE_AT_POSITION_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: TAP_PATH_PARAMETER_DESCRIPTION,
				},
				line: {
					type: "integer",
					description: TAP_LINE_PARAMETER_DESCRIPTION,
				},
				character: {
					type: ["integer", "null"],
					description: TAP_CHARACTER_PARAMETER_DESCRIPTION,
				},
				symbol: {
					type: ["string", "null"],
					description: TAP_SYMBOL_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "line", "character", "symbol"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
