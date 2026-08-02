/**
 * OpenAI-format tool schemas for the four code-intelligence tools.
 *
 * NEW design work, NOT a port: no code-intelligence tools exist in the
 * upstream Zoo Code sources this project vendors (the vendored
 * `search_files` is a regex-based text search, not a symbol resolver). The
 * schema SHAPE follows the vendored native-tools conventions exactly (see
 * src/vendor/zoo-code/src/core/prompts/tools/native-tools/codebase_search.ts):
 * `type: "function"`, `strict: true`, `additionalProperties: false`, a long
 * prose description with Parameters/Examples, one const per parameter
 * description. The implementation lives in src/codeintel/.
 *
 * Parameter-shape rationale (the spec's "design around what the API needs"):
 * `getDefinitionAtPosition` / `getReferencesAtPosition` take a character
 * OFFSET, not a line — so `line` alone is genuinely ambiguous on a line with
 * several symbols. `character` (1-based column) is the precise answer;
 * `symbol` (the name) is the cheap alternative the model can supply without
 * counting columns; with neither, the first identifier on the line is used.
 */

import type OpenAI from "openai"

// ─── outline ─────────────────────────────────────────────────────────────────

const OUTLINE_DESCRIPTION = `List every top-level (and one level of nested) declaration in a source file — functions, classes, interfaces, types, enums, namespaces, consts, and class/interface members — as one compact line per symbol: "<line> <kind> <signature>". Signatures only, no bodies, so this is a cheap structural map of a file WITHOUT reading it in full.

Use this instead of read_file when you only need a file's structure (symbol names, kinds, and line numbers) to plan where to read or what to call.

Only works on TypeScript/JavaScript source files (.ts/.tsx/.mts/.cts/.js/.jsx). Non-TS files return a clear "not supported" result.

Parameters:
- path: (required) Path to the source file, relative to the workspace root.

Example: { "path": "src/engine/loop.ts" }`

const OUTLINE_PATH_PARAMETER_DESCRIPTION = `Path to the source file to outline, relative to the workspace root`

export const outlineTool = {
	type: "function",
	function: {
		name: "outline",
		description: OUTLINE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: OUTLINE_PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

// ─── go_to_definition ────────────────────────────────────────────────────────

const GO_TO_DEFINITION_DESCRIPTION = `Resolve the definition of the symbol at a given line of a source file, using the TypeScript compiler's real symbol resolution (not a text search). Returns the real definition location(s) as "<file>:<line>:<column> <kind> <name> — <snippet of the definition line>" — one entry per definition; overloaded functions return ALL definitions. Definitions in vendored/d.ts/node_modules files are returned as their real locations.

Use this to jump straight to where a symbol is actually defined instead of grep-ing for it.

Only works on TypeScript/JavaScript source files. A symbol with no resolvable definition (ambient, any-typed, etc.) returns a clear "could not resolve" message.

Parameters:
- path: (required) Path to the source file containing the symbol, relative to the workspace root.
- line: (required) 1-based line number of the symbol.
- character: (optional) 1-based column of the symbol within the line. Needed when the line has multiple symbols and you want a specific one; omit to use the symbol name or the first identifier on the line.
- symbol: (optional) The symbol's name, used to disambiguate when the line has several identifiers (e.g. { "path": "src/foo.ts", "line": 12, "symbol": "bar" }). Ignored when character is given.

Example: go to the definition of the call on line 42: { "path": "src/engine/loop.ts", "line": 42, "symbol": "truncateHistory" }`

const GTD_PATH_PARAMETER_DESCRIPTION = `Path to the source file containing the symbol, relative to the workspace root`
const GTD_LINE_PARAMETER_DESCRIPTION = `1-based line number of the symbol`
const GTD_CHARACTER_PARAMETER_DESCRIPTION = `1-based column of the symbol within the line (disambiguates on multi-symbol lines); omit to use symbol name or the first identifier on the line`
const GTD_SYMBOL_PARAMETER_DESCRIPTION = `Symbol name to disambiguate when the line has several identifiers; ignored when character is given`

export const goToDefinitionTool = {
	type: "function",
	function: {
		name: "go_to_definition",
		description: GO_TO_DEFINITION_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: GTD_PATH_PARAMETER_DESCRIPTION,
				},
				line: {
					type: "integer",
					description: GTD_LINE_PARAMETER_DESCRIPTION,
				},
				character: {
					type: "integer",
					description: GTD_CHARACTER_PARAMETER_DESCRIPTION,
				},
				symbol: {
					type: "string",
					description: GTD_SYMBOL_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "line"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

// ─── find_references ─────────────────────────────────────────────────────────

const FIND_REFERENCES_DESCRIPTION = `Find every real usage site of the symbol at a given line of a source file, using the TypeScript compiler's real reference resolution (not grep). Returns compact "<file>:<line> — <snippet of the line>" entries (the declaration site itself is included), so you can see all callers/uses without reading each file. Results are capped at 50 with a clear "N more references not shown" note — narrow your search to a more specific symbol if you need the rest.

Use this to answer "who uses this symbol / what would this change affect".

Only works on TypeScript/JavaScript source files.

Parameters:
- path: (required) Path to the source file containing the symbol, relative to the workspace root.
- line: (required) 1-based line number of the symbol.
- character: (optional) 1-based column of the symbol within the line; omit to use symbol name or the first identifier on the line.
- symbol: (optional) Symbol name to disambiguate when the line has several identifiers; ignored when character is given.

Example: { "path": "src/config/mode-models.ts", "line": 12, "symbol": "resolveModelForMode" }`

const FR_PATH_PARAMETER_DESCRIPTION = `Path to the source file containing the symbol, relative to the workspace root`
const FR_LINE_PARAMETER_DESCRIPTION = `1-based line number of the symbol`
const FR_CHARACTER_PARAMETER_DESCRIPTION = `1-based column of the symbol within the line (disambiguates on multi-symbol lines); omit to use symbol name or the first identifier on the line`
const FR_SYMBOL_PARAMETER_DESCRIPTION = `Symbol name to disambiguate when the line has several identifiers; ignored when character is given`

export const findReferencesTool = {
	type: "function",
	function: {
		name: "find_references",
		description: FIND_REFERENCES_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: FR_PATH_PARAMETER_DESCRIPTION,
				},
				line: {
					type: "integer",
					description: FR_LINE_PARAMETER_DESCRIPTION,
				},
				character: {
					type: "integer",
					description: FR_CHARACTER_PARAMETER_DESCRIPTION,
				},
				symbol: {
					type: "string",
					description: FR_SYMBOL_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "line"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

// ─── import_graph ────────────────────────────────────────────────────────────

const IMPORT_GRAPH_DESCRIPTION = `Show a file's import relationships: (a) everything it imports, resolved to the REAL file paths the TypeScript compiler resolves them to (tsconfig paths aliases like "vscode" -> src/vendor/zoo-code/shim/vscode.ts included), and (b) everything that imports it (reverse lookup across the whole program). Static analysis of import/export declarations — deterministic and fast (the program-wide import map is cached).

Use this to understand module dependencies before editing, or to find every file that depends on a module you're about to change.

Only works on TypeScript/JavaScript source files.

Parameters:
- path: (required) Path to the source file, relative to the workspace root.

Example: { "path": "src/tools/executor.ts" }`

const IG_PATH_PARAMETER_DESCRIPTION = `Path to the source file, relative to the workspace root`

export const importGraphTool = {
	type: "function",
	function: {
		name: "import_graph",
		description: IMPORT_GRAPH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: IG_PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

export const CODE_INTEL_TOOLS: readonly OpenAI.Chat.ChatCompletionTool[] = [
	outlineTool,
	goToDefinitionTool,
	findReferencesTool,
	importGraphTool,
]

export const CODE_INTEL_TOOL_NAMES: readonly string[] = [
	outlineTool.function.name,
	goToDefinitionTool.function.name,
	findReferencesTool.function.name,
	importGraphTool.function.name,
]
