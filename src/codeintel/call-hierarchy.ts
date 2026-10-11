/**
 * `call_hierarchy` handler + tool schema: who calls the function at (file,
 * line[, character | symbol]) and what it calls. Analysis lives in
 * ./hierarchy-edges.js (collection) and ./hierarchy-query.js (BFS query +
 * rendering); the generic handler helpers come from ./handlers.js.
 */

import type OpenAI from "openai"

import type { ToolContext, ToolResult } from "../engine/types.js"
import { makeRelativizer } from "./go-to-definition.js"
import {
	intelFor,
	lineArg,
	ok,
	optionalCharacterArg,
	optionalStringArg,
	requireStringArg,
	resolveTarget,
} from "./handlers.js"
import {
	MAX_HIERARCHY_DEPTH,
	type HierarchyDirection,
} from "./hierarchy-edges.js"
import {
	findCallHierarchy,
	formatCallHierarchy,
	resolveHierarchyTarget,
} from "./hierarchy-query.js"

function directionArg(
	args: Record<string, unknown>,
	tool: string,
): HierarchyDirection {
	const v = args["direction"]
	if (v === undefined || v === null) {
		return "both"
	}
	if (v === "callers" || v === "callees" || v === "both") {
		return v
	}
	throw new Error(
		`${tool}: invalid direction '${JSON.stringify(v)}'`
			+ " — must be callers, callees, or both",
	)
}

function maxDepthArg(args: Record<string, unknown>): number {
	const v = args["max_depth"]
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
	if (!Number.isInteger(n) || n < 1) {
		return 3
	}
	return Math.min(n, MAX_HIERARCHY_DEPTH)
}

export function callHierarchyHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
): ToolResult {
	const tool = "call_hierarchy"
	const filePath = requireStringArg(args, "path", tool)
	const target = resolveTarget(ctx, tool, filePath)
	const line = lineArg(args, tool)
	const character = optionalCharacterArg(args)
	const symbol = optionalStringArg(args, "symbol")
	const direction = directionArg(args, tool)
	const maxDepth = maxDepthArg(args)
	const intel = intelFor(ctx)
	const resolved = resolveHierarchyTarget(
		intel,
		target,
		line,
		character,
		symbol,
	)
	if (resolved === undefined) {
		return ok(
			"Could not resolve a symbol at that position (it may be ambient,"
				+ " any-typed, or otherwise unresolvable by the type checker).",
		)
	}
	const sides = findCallHierarchy(intel, resolved, direction, maxDepth)
	const rel = makeRelativizer(ctx.workspaceRoot)
	const out = formatCallHierarchy(
		rel,
		resolved,
		sides.callers,
		sides.callees,
		direction,
	)
	return ok(out)
}

const CALL_HIERARCHY_DESCRIPTION = `Show who calls a function and what it calls, using the TypeScript compiler's real signature resolution (not a text search). Point at a function name (its definition or any call site) and get one "rel/path:line callerFn -> rel/path:line calleeFn" line per call edge, breadth-first up to max_depth. Unresolvable calls (any-typed, dynamic) are skipped silently.

Use this to answer "who calls this / what does this call" before changing a function.

Only works on TypeScript/JavaScript source files.

Parameters:
- path: (required) Path to the source file containing the symbol, relative to the workspace root.
- line: (required) 1-based line number of the symbol.
- character: (optional) 1-based column of the symbol within the line; omit to use symbol name or the first identifier on the line.
- symbol: (optional) Symbol name to disambiguate when the line has several identifiers; ignored when character is given.
- direction: (optional) "callers", "callees", or "both" (default).
- max_depth: (optional) How many levels to expand (default 3, hard cap 5).

Example: { "path": "src/engine/loop.ts", "line": 42, "symbol": "truncateHistory", "direction": "callers" }`

const CH_PATH_PARAMETER_DESCRIPTION = `Path to the source file containing the symbol, relative to the workspace root`
const CH_LINE_PARAMETER_DESCRIPTION = `1-based line number of the symbol`
const CH_CHARACTER_PARAMETER_DESCRIPTION = `1-based column of the symbol within the line; omit to use symbol name or the first identifier on the line`
const CH_SYMBOL_PARAMETER_DESCRIPTION = `Symbol name to disambiguate when the line has several identifiers; ignored when character is given`
const CH_DIRECTION_PARAMETER_DESCRIPTION = `Which side to expand: callers, callees, or both (default)`
const CH_MAX_DEPTH_PARAMETER_DESCRIPTION = `How many levels to expand (default 3, hard cap 5)`

export const callHierarchyTool = {
	type: "function",
	function: {
		name: "call_hierarchy",
		description: CALL_HIERARCHY_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: CH_PATH_PARAMETER_DESCRIPTION,
				},
				line: {
					type: "integer",
					description: CH_LINE_PARAMETER_DESCRIPTION,
				},
				character: {
					type: ["integer", "null"],
					description: CH_CHARACTER_PARAMETER_DESCRIPTION,
				},
				symbol: {
					type: ["string", "null"],
					description: CH_SYMBOL_PARAMETER_DESCRIPTION,
				},
				direction: {
					type: ["string", "null"],
					description: CH_DIRECTION_PARAMETER_DESCRIPTION,
				},
				max_depth: {
					type: ["integer", "null"],
					description: CH_MAX_DEPTH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "line", "character", "symbol", "direction", "max_depth"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
