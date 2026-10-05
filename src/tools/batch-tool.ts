/**
 * OpenAI-format tool schema for `batch` (see ./batch.ts for the handler).
 * Kept separate so batch.ts stays under the file-size limit.
 *
 * `strict` is false: sub-call `args` are free-form per-tool objects,
 * which strict schemas cannot express. Sub-calls are validated at
 * runtime instead.
 */

import type OpenAI from "openai"

const BATCH_DESCRIPTION = `Run up to 10 tool calls as one batch and get every result back in a single turn, as labeled "[i/N] <tool> — ok|error" sections plus a final "<N> sub-calls: <X> ok, <Y> error(s)" counts line. Read-only sub-calls run concurrently; edits run in submission order; results come back in submission order.

Use this to fetch several independent reads (files, outlines, definitions, diagnostics) in one turn instead of paying a full turn per read. Order matters when sub-calls touch the same file: an edit-then-read sees post-edit content, a read-then-edit sees pre-edit content.

These tools cannot be sub-calls — call them as their own top-level turn instead: batch (no nesting), new_task, switch_mode, ask_followup_question, attempt_completion. Unknown or executor-unavailable tools become per-section errors; siblings still run.

Parameters:
- calls: (required) Array of 1-10 { "tool": "<name>", "args": { ...per-tool args... } } entries.
- stop_on_error: (optional) When true, remaining in-order sub-calls are skipped after the first failure (default false).

Example: { "calls": [{ "tool": "read_file", "args": { "path": "src/a.ts" } }, { "tool": "outline", "args": { "path": "src/b.ts" } }] }`

const BATCH_CALLS_PARAMETER_DESCRIPTION = `Array of 1-10 tool calls to run, each { "tool": "<name>", "args": { ... } }`
const BATCH_SUB_TOOL_PARAMETER_DESCRIPTION = `Name of the tool to call for this sub-call`
const BATCH_SUB_ARGS_PARAMETER_DESCRIPTION = `Arguments for this sub-call, exactly as the named tool takes them`
const BATCH_STOP_ON_ERROR_PARAMETER_DESCRIPTION = `Skip remaining in-order sub-calls after the first failure (default false)`

export const batchTool = {
	type: "function",
	function: {
		name: "batch",
		description: BATCH_DESCRIPTION,
		strict: false,
		parameters: {
			type: "object",
			properties: {
				calls: {
					type: "array",
					description: BATCH_CALLS_PARAMETER_DESCRIPTION,
					items: {
						type: "object",
						properties: {
							tool: {
								type: "string",
								description: BATCH_SUB_TOOL_PARAMETER_DESCRIPTION,
							},
							args: {
								type: "object",
								description: BATCH_SUB_ARGS_PARAMETER_DESCRIPTION,
							},
						},
						required: ["tool", "args"],
						additionalProperties: false,
					},
				},
				stop_on_error: {
					type: ["boolean", "null"],
					description: BATCH_STOP_ON_ERROR_PARAMETER_DESCRIPTION,
				},
			},
			required: ["calls", "stop_on_error"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
