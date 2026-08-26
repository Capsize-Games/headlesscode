/**
 * `set_indentation` schema (issue #141) — sets ONE line's leading
 * indentation to an exact tab count. The handler lives in executor.ts
 * (setIndentationHandler) alongside edit_file/write_to_file, since it needs
 * the same private path-safety/protected-file helpers those tools already
 * use; this file only holds the schema, mirroring run-tests.ts's split.
 *
 * All 3 parameters are required — deliberately, unlike run_tests's optional
 * paths/timeout: a tool with any optional parameter hits a known
 * llama.cpp/llama-cpp-python grammar-constrained-decoding bug that corrupts
 * structured tool calls (see prompt.ts's patchEditFileToolForLocalModels
 * doc comment). Keeping every parameter required sidesteps that bug
 * category entirely, on top of this tool's main point — see executor.ts's
 * setIndentationHandler doc comment for the real motivation (a local model
 * struggling to compose two multi-line strings differing only in tab
 * count, not a matching-strictness problem).
 */

import type OpenAI from "openai"

export const SET_INDENTATION_NAME = "set_indentation"

const SET_INDENTATION_DESCRIPTION = `Change ONE line's leading indentation to an exact number of tabs, without touching the rest of the line or any other line. Use this for a pure indentation/whitespace-only fix instead of edit_file — edit_file requires typing out the full line twice (once in old_string, once in new_string) differing only in leading whitespace, which is easy to get subtly wrong. This tool takes a plain line number and a plain tab count instead.

Only fixes indentation made of TABS. If the file uses space-based indentation, use edit_file instead.

Example: { "path": "src/foo.ts", "line": 42, "tabs": 3 } sets line 42's leading whitespace to exactly 3 tabs (\\t\\t\\t), replacing however many tabs/spaces were there before.`

const SI_PATH_PARAMETER_DESCRIPTION = `File path, relative to the workspace root.`
const SI_LINE_PARAMETER_DESCRIPTION = `1-indexed line number to change. Use read_file first to confirm it.`
const SI_TABS_PARAMETER_DESCRIPTION = `Exact number of leading tab characters the line should have after this call (0 removes all leading indentation).`

export const setIndentationTool = {
	type: "function",
	function: {
		name: SET_INDENTATION_NAME,
		description: SET_INDENTATION_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: SI_PATH_PARAMETER_DESCRIPTION },
				line: { type: "integer", description: SI_LINE_PARAMETER_DESCRIPTION },
				tabs: { type: "integer", description: SI_TABS_PARAMETER_DESCRIPTION },
			},
			required: ["path", "line", "tabs"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
