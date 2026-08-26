/**
 * Timeline-model support for the dashboard's session detail view — reduces
 * the flat chronological event feed (the same data served by
 * `GET /api/session/:id/events`) into a per-iteration "shape" model: what
 * kind of work each iteration did (read/write/exec/search by dominant tool
 * type), the running tool-mix totals, and the structural markers
 * (checkpoints, condensation, pause/resume, decisions) that the horizontal
 * timeline view renders.
 *
 * Like `src/dashboard/chat-thread.ts` this module is deliberately pure (no
 * DOM, no fetch): the classification/bucketing is the part worth
 * unit-testing, and keeping it here lets
 * `src/dashboard/__tests__/timeline.test.ts` exercise it with fixture event
 * arrays. `src/dashboard/page.ts` carries its own inline vanilla-JS twin of
 * `buildTimeline` (no build step means the page cannot import this file) —
 * keep the two in sync.
 *
 * Classification (the four buckets the project owner's tool-mix question
 * needs as real numbers): `read` = file/symbol reading, `search` =
 * semantic codebase search (its own bucket so "N searches" is a real count,
 * colored a read-adjacent hue on the timeline), `write` = editing tools,
 * `exec` = shell execution. Anything else is `other`. An iteration with no
 * tool calls at all is `none` (a faint empty cell).
 */

import type { EventRecord } from "../engine/events.js"

export type ToolCategory = "read" | "write" | "exec" | "search" | "other" | "none"

const READ_TOOLS = new Set([
	"read_file",
	"list_files",
	"outline",
	"go_to_definition",
	"find_references",
	"import_graph",
])
const WRITE_TOOLS = new Set(["write_to_file", "apply_diff", "search_replace", "edit_file", "set_indentation"])
const EXEC_TOOLS = new Set(["execute_command"])
const SEARCH_TOOLS = new Set(["codebase_search"])

/** The single bucket a tool contributes to (never more than one). */
export function classifyTool(tool: string): Exclude<ToolCategory, "none"> {
	if (READ_TOOLS.has(tool)) return "read"
	if (WRITE_TOOLS.has(tool)) return "write"
	if (EXEC_TOOLS.has(tool)) return "exec"
	if (SEARCH_TOOLS.has(tool)) return "search"
	return "other"
}

/**
 * Tie-break priority when two categories have the same call count in one
 * iteration: a write that appears once alongside a read that appears once is
 * still the iteration's point, so writes beat reads at equal counts.
 */
const TIE_BREAK: Array<Exclude<ToolCategory, "none">> = ["write", "exec", "search", "read", "other"]

export interface ToolUsage {
	name: string
	count: number
}

export interface IterationSummary {
	iteration: number
	/** Dominant bucket for this iteration's tool calls; "none" when it made none. */
	category: ToolCategory
	toolCalls: ToolUsage[]
	toolCount: number
	firstTs: number
	lastTs: number
	inputTokens: number
	outputTokens: number
	cachedTokens: number
	/** True when any tool_result in this iteration reported an error. */
	hasError: boolean
}

export type MarkerKind =
	| "start"
	| "checkpoint"
	| "condensed"
	| "paused"
	| "resumed"
	| "decision"
	| "end"

export interface TimelineMarker {
	kind: MarkerKind
	ts: number
	iteration?: number
	/** checkpoint_saved / condensed / session_end carry extra payload fields. */
	[field: string]: unknown
}

export interface ToolMixTotals {
	read: number
	write: number
	exec: number
	search: number
	other: number
	toolCalls: number
	inputTokens: number
	outputTokens: number
	cachedTokens: number
}

export interface TimelineModel {
	sessionId: string
	task?: string
	model?: string
	mode?: string
	/** One summary per iteration that produced events, in iteration order. */
	iterations: IterationSummary[]
	/** Structural markers in chronological order (start/checkpoint/condensed/pause/…). */
	markers: TimelineMarker[]
	totals: ToolMixTotals
}

export function buildTimeline(events: EventRecord[]): TimelineModel {
	const model: TimelineModel = {
		sessionId: events[0]?.sessionId ?? "",
		iterations: [],
		markers: [],
		totals: { read: 0, write: 0, exec: 0, search: 0, other: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
	}

	/** iteration -> category counts for tool_calls seen so far (insertion order). */
	const categoryCounts = new Map<number, Map<Exclude<ToolCategory, "none">, number>>()
	/** iteration -> distinct tool name -> call count. */
	const toolCounts = new Map<number, Map<string, number>>()
	const iterMeta = new Map<number, { firstTs: number; lastTs: number; inputTokens: number; outputTokens: number; cachedTokens: number; hasError: boolean }>()

	// The feed's ts is an ISO string; the model works in epoch ms so the UI can
	// position cells/markers on a real time axis. Non-timestamp feeds degrade
	// to event order (each event gets a strictly increasing fallback value).
	let tsFallback = 0
	const toTs = (t: unknown): number => {
		if (typeof t === "number") return t
		const ms = typeof t === "string" ? Date.parse(t) : NaN
		if (Number.isFinite(ms)) return ms
		return tsFallback++
	}

	const ensureIteration = (iteration: number): void => {
		if (!iterMeta.has(iteration)) {
			iterMeta.set(iteration, { firstTs: Number.MAX_SAFE_INTEGER, lastTs: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, hasError: false })
		}
	}

	for (const event of events) {
		const ts = toTs(event.ts)
		switch (event.type) {
			case "session_start":
				model.task = typeof event.task === "string" ? event.task : undefined
				model.model = typeof event.model === "string" ? event.model : undefined
				model.mode = typeof event.mode === "string" ? event.mode : undefined
				model.markers.push({ kind: "start", ts })
				break
			case "session_end":
				model.markers.push({ kind: "end", ts, status: event.status })
				break
			case "iteration_start": {
				if (event.iteration === undefined) break
				ensureIteration(event.iteration)
				const meta = iterMeta.get(event.iteration)!
				meta.firstTs = Math.min(meta.firstTs, ts)
				meta.lastTs = Math.max(meta.lastTs, ts)
				break
			}
			case "llm_response": {
				const iteration = event.iteration
				if (iteration === undefined) break
				ensureIteration(iteration)
				const meta = iterMeta.get(iteration)!
				meta.firstTs = Math.min(meta.firstTs, ts)
				meta.lastTs = Math.max(meta.lastTs, ts)
				const input = typeof event.inputTokens === "number" ? event.inputTokens : 0
				const output = typeof event.outputTokens === "number" ? event.outputTokens : 0
				const cached = typeof event.cachedTokens === "number" ? event.cachedTokens : 0
				meta.inputTokens += input
				meta.outputTokens += output
				meta.cachedTokens += cached
				model.totals.inputTokens += input
				model.totals.outputTokens += output
				model.totals.cachedTokens += cached
				break
			}
			case "tool_call": {
				const iteration = event.iteration
				if (iteration === undefined) break
				ensureIteration(iteration)
				const meta = iterMeta.get(iteration)!
				meta.firstTs = Math.min(meta.firstTs, ts)
				meta.lastTs = Math.max(meta.lastTs, ts)
				const tool = typeof event.tool === "string" ? event.tool : "unknown"
				const category = classifyTool(tool)
				const counts = categoryCounts.get(iteration) ?? new Map()
				counts.set(category, (counts.get(category) ?? 0) + 1)
				categoryCounts.set(iteration, counts)
				const tools = toolCounts.get(iteration) ?? new Map()
				tools.set(tool, (tools.get(tool) ?? 0) + 1)
				toolCounts.set(iteration, tools)
				model.totals[category] += 1
				model.totals.toolCalls += 1
				break
			}
			case "tool_result": {
				const iteration = event.iteration
				if (iteration !== undefined && iterMeta.has(iteration) && event.isError === true) {
					iterMeta.get(iteration)!.hasError = true
				}
				break
			}
			case "checkpoint_saved":
				model.markers.push({ kind: "checkpoint", ts, iteration: event.iteration })
				break
			case "condensed":
				model.markers.push({
					kind: "condensed",
					ts,
					iteration: event.iteration,
					messagesBefore: event.messagesBefore,
					messagesAfter: event.messagesAfter,
					inputTokens: event.inputTokens,
					outputTokens: event.outputTokens,
					cachedTokens: event.cachedTokens,
				})
				break
			case "paused":
				model.markers.push({ kind: "paused", ts, iteration: event.iteration, reason: event.reason })
				break
			case "resumed":
				model.markers.push({ kind: "resumed", ts, iteration: event.iteration, reason: event.reason })
				break
			case "decision_blocked":
				model.markers.push({ kind: "decision", ts, question: event.question })
				break
			case "decision_answered":
				model.markers.push({ kind: "decision", ts, answer: event.answer, timedOut: event.timedOut })
				break
			default:
				break
		}
	}

	// Materialize iterations in ascending iteration order (Map insertion order).
	for (const [iteration, meta] of iterMeta) {
		const counts = categoryCounts.get(iteration) ?? new Map()
		const tools = toolCounts.get(iteration) ?? new Map()
		const dominant: ToolCategory =
			counts.size === 0
				? "none"
				: [...counts.entries()].sort(
						(a, b) => b[1] - a[1] || TIE_BREAK.indexOf(a[0]) - TIE_BREAK.indexOf(b[0]),
					)[0][0]
		model.iterations.push({
			iteration,
			category: dominant,
			toolCalls: [...tools.entries()]
				.map(([name, count]) => ({ name, count }))
				.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
			toolCount: [...tools.values()].reduce((sum, n) => sum + n, 0),
			firstTs: meta.firstTs === Number.MAX_SAFE_INTEGER ? 0 : meta.firstTs,
			lastTs: meta.lastTs,
			inputTokens: meta.inputTokens,
			outputTokens: meta.outputTokens,
			cachedTokens: meta.cachedTokens,
			hasError: meta.hasError,
		})
	}

	return model
}
