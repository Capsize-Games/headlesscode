/**
 * Lazy tool-catalog loading — opt-in (default OFF), gated to sessions that
 * need it: a small local model's context window can be dominated by the
 * FULL tool catalog before the task even starts (measured live 2026-08-19
 * against Qwen3-Coder-30B-A3B on an RTX 5080: 21 schemas = ~19.5K prompt
 * tokens against a ~24.5K real ceiling — under 5K tokens left for the
 * actual task). Cloud sessions (OpenRouter/DeepSeek) keep today's static
 * full catalog untouched: a stable prefix is what makes their prompt cache
 * cheap, and changing it per-call would hurt cache-hit rate for no local
 * benefit. This module only ever narrows what ONE session sends; it never
 * changes what a tool DOES.
 *
 * Same discovery-then-fetch shape published for MCP/tool-heavy agentic
 * workflows (dynamic tool gating + lazy schema loading): the model gets a
 * cheap index up front (`list_tools`) and pulls a tool's real schema into
 * its OWN next turn only once it decides it needs it (`request_tool`),
 * instead of paying for every schema on every turn regardless of use.
 */

import type { ChatTool } from "./types.js"

export const LAZY_TOOL_CATALOG_ENV = "HEADLESSCODE_LAZY_TOOL_CATALOG"

export function isLazyToolCatalogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env[LAZY_TOOL_CATALOG_ENV]
	return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
}

/**
 * Tools sent on every turn regardless of lazy-loading: the minimum needed
 * to read, edit, run commands, delegate, and finish a task. Everything else
 * in a session's full tool list is offered lazily via `list_tools` /
 * `request_tool` instead.
 *
 * `apply_diff` deliberately excluded (available lazily, not core) — its
 * SEARCH/REPLACE block format requires escaping literal `=======`/`<<<<<<<`
 * markers found in real file content, and a `:start_line:[line_number]`
 * header where `[line_number]` is a template placeholder to substitute a
 * real integer into. Verified live 2026-08-19 against Qwen2.5-Coder-14B:
 * it copied `:start_line:[line_number]` into a real call verbatim (treating
 * the placeholder as literal syntax) and separately failed to escape a
 * literal `=======` divider inside a file's own content across 4 consecutive
 * retries despite an explicit corrective error message each time. `edit_file`
 * and `search_replace` need none of this — plain old_string/new_string with
 * NO escaping rules and (edit_file) a fuzzy-match fallback — and stay core.
 */
export const CORE_TOOL_NAMES = new Set([
	"ask_followup_question",
	"attempt_completion",
	"execute_command",
	"list_files",
	"read_file",
	// search_replace deliberately excluded — same reasoning as apply_diff
	// above it in git history: search_replace requires an EXACT literal
	// match (see searchReplaceHandler, src/tools/executor.ts) with no
	// fallback, while edit_file has a 3-stage fallback chain (exact →
	// whitespace-tolerant → token-based) specifically built to survive the
	// whitespace/indentation drift a model's old_string commonly has.
	// Verified live 2026-08-20: given both tools, a local model picked
	// search_replace, hit exactly the whitespace-mismatch failure edit_file
	// exists to prevent, then spiralled into an unrelated list_files loop
	// instead of recovering — a harness/tool-catalog problem, not
	// necessarily a model capability ceiling. Still reachable via
	// request_tool for a session that genuinely needs it.
	"edit_file",
	// set_indentation deliberately core, not lazy (issue #141): it exists
	// specifically to give local sessions — the same sessions lazy-loading
	// targets — a way to fix a pure indentation mismatch without edit_file's
	// two-near-identical-multi-line-strings shape. Live-verified 2026-08-21:
	// gating it behind request_tool defeated the whole point — a model given
	// an explicit task-level instruction to use it still defaulted back to
	// (always-visible) edit_file 2/2 times, then on a 3rd trial DID try to
	// call it correctly but only as narrated text, never having pulled its
	// real schema in via request_tool first.
	"set_indentation",
	"write_to_file",
	// 2026-09-02: new_task, switch_mode, and update_todo_list demoted from
	// core to lazy — real usage data across 62 logged local-backend eval
	// sessions (grep "tool result: <name>" across eval_verifier_runs/*/
	// session.log) showed ZERO calls to any of these three, ever, while
	// still paying ~3,700 combined chars of their schemas on every single
	// turn of every session. Unlike set_indentation (which has a specific
	// documented live failure showing the model won't request_tool it when
	// it's actually needed), there is no equivalent evidence for these
	// three — no session in that corpus needed delegation (new_task), a
	// mode switch (switch_mode), or a multi-step plan register
	// (update_todo_list) at all, since these are single-file scratch
	// eval tasks. If a session genuinely needs one, it's still one
	// request_tool call away. Revisit if live data ever shows a session
	// that needed one of these three but never called request_tool for it
	// (the set_indentation failure shape) — that would argue for
	// re-promoting that specific tool back to core.
])

export const LIST_TOOLS_NAME = "list_tools"
export const REQUEST_TOOL_NAME = "request_tool"

export interface SplitTools {
	/** Always sent: the core set plus list_tools/request_tool themselves. */
	core: ChatTool[]
	/** Available on request only, keyed by tool name. */
	lazyByName: Map<string, ChatTool>
}

/** Split a session's full (already executor-gated) tool list into core + lazy. */
export function splitCoreAndLazyTools(allTools: ChatTool[]): SplitTools {
	const core: ChatTool[] = []
	const lazyByName = new Map<string, ChatTool>()
	for (const tool of allTools) {
		if (tool.type !== "function") {
			core.push(tool)
			continue
		}
		if (CORE_TOOL_NAMES.has(tool.function.name)) {
			core.push(tool)
		} else {
			lazyByName.set(tool.function.name, tool)
		}
	}
	return {
		core: [...core, buildListToolsTool(), buildRequestToolTool()],
		lazyByName,
	}
}

export function buildListToolsTool(): ChatTool {
	// 2026-09-02: built from CORE_TOOL_NAMES itself rather than a hand-
	// written duplicate list — the previous static string had already
	// drifted (it named apply_diff/search_replace as "always available",
	// which was never true; both are deliberately lazy, see
	// CORE_TOOL_NAMES's own comments) and would have drifted again the
	// moment core membership changed without this description changing
	// with it. request_tool/list_tools themselves are the delivery
	// mechanism, not part of the "core" the model chooses among, so they're
	// deliberately left out of this parenthetical (the tool's own name
	// already makes clear it exists).
	const coreList = [...CORE_TOOL_NAMES].join(", ")
	return {
		type: "function",
		function: {
			name: LIST_TOOLS_NAME,
			description:
				`List additional tools available in this session beyond the core set (${coreList} — ` +
				"always available, not listed here). Call request_tool with a name from this list " +
				"to make that tool callable on your NEXT turn.",
			parameters: { type: "object", properties: {}, required: [] },
		},
	}
}

export function buildRequestToolTool(): ChatTool {
	return {
		type: "function",
		function: {
			name: REQUEST_TOOL_NAME,
			description:
				"Make one additional tool (from list_tools' output) callable starting " +
				"on your NEXT turn. Costs nothing to call again if already active.",
			parameters: {
				type: "object",
				properties: { name: { type: "string", description: "Exact tool name from list_tools" } },
				required: ["name"],
			},
		},
	}
}

/** One line per lazy tool: name + its schema's own description, truncated. */
export function renderToolIndex(lazyByName: Map<string, ChatTool>): string {
	if (lazyByName.size === 0) {
		return "No additional tools are available in this session."
	}
	const lines = [...lazyByName.values()].map((tool) => {
		if (tool.type !== "function") {
			return `- ${tool.type}`
		}
		const description = (tool.function.description ?? "").split(/(?<=[.!?])\s/)[0] ?? ""
		return `- ${tool.function.name}: ${description.slice(0, 120)}`
	})
	return lines.join("\n")
}
