/**
 * Unit tests for src/dashboard/timeline.ts's `buildTimeline` / `classifyTool` —
 * the pure bucketing that turns the flat event feed into the per-iteration
 * "shape" model (dominant tool category, running tool-mix totals, structural
 * markers) that the dashboard's timeline view renders. Plain assert-based
 * script (no test framework), run via `npm test` ->
 * `tsx src/dashboard/__tests__/timeline.test.ts`.
 *
 * Fixtures mirror realistic feed mixes: heavy exploration, heavy editing, a
 * pause/resume pair, a decision-blocked/answered pair, and a condensation
 * point.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { buildTimeline, classifyTool } from "../timeline.js"
import type { EventRecord } from "../../engine/events.js"
import { runMain } from "../../test-runner.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let tsCounter = 1_000_000_000_000
function t(): string {
	tsCounter += 1_000
	return new Date(tsCounter).toISOString()
}

function event(type: string, extra: Record<string, unknown> = {}): EventRecord {
	return { ts: t(), sessionId: "session-1", type, ...extra }
}

/** Build a full iteration's worth of events around the given tool calls. */
function iteration(iter: number, tools: Array<[string, string]>, over: Record<string, unknown> = {}): EventRecord[] {
	const ev: EventRecord[] = [event("iteration_start", { iteration: iter })]
	ev.push(
		event("llm_response", {
			iteration: iter,
			hadToolCalls: tools.length > 0,
			inputTokens: over.inputTokens ?? 0,
			outputTokens: over.outputTokens ?? 0,
			cachedTokens: over.cachedTokens ?? 0,
		}),
	)
	for (const [tool, args] of tools) {
		ev.push(event("tool_call", { iteration: iter, tool, args }))
		ev.push(
			event("tool_result", {
				iteration: iter,
				tool,
				isError: tool === "execute_command" && args.includes("failing"),
				result: "…",
			}),
		)
	}
	return ev
}

// ─── classifyTool ────────────────────────────────────────────────────────────

async function testClassifyToolBuckets(): Promise<void> {
	assert.equal(classifyTool("read_file"), "read")
	assert.equal(classifyTool("list_files"), "read")
	assert.equal(classifyTool("outline"), "read")
	assert.equal(classifyTool("go_to_definition"), "read")
	assert.equal(classifyTool("write_to_file"), "write")
	assert.equal(classifyTool("apply_diff"), "write")
	assert.equal(classifyTool("search_replace"), "write")
	assert.equal(classifyTool("edit_file"), "write")
	assert.equal(classifyTool("set_indentation"), "write")
	assert.equal(classifyTool("execute_command"), "exec")
	// codebase_search is its own bucket so "N searches" is a real number.
	assert.equal(classifyTool("codebase_search"), "search")
	// Anything unrecognized (future tools) degrades to "other".
	assert.equal(classifyTool("browser_action"), "other")
	assert.equal(classifyTool("some_future_tool"), "other")
}

// ─── Heavy exploration → editing (the shape the owner wants to SEE) ─────────

async function testExplorationThenEditingShape(): Promise<void> {
	const events: EventRecord[] = [
		event("session_start", { mode: "code", model: "deepseek/deepseek-v4-flash", task: "implement feature" }),
		event("checkpoint_saved", { iteration: 0 }),
		...iteration(1, [
			["codebase_search", "event feed"],
			["read_file", "src/engine/events.ts"],
			["list_files", "src"],
			["codebase_search", "condensation"],
			["read_file", "src/engine/loop.ts"],
		], { inputTokens: 1000, outputTokens: 50, cachedTokens: 500 }),
		event("checkpoint_saved", { iteration: 1 }),
		...iteration(2, [
			["read_file", "src/a.ts"],
			["read_file", "src/b.ts"],
			["read_file", "src/c.ts"],
		], { inputTokens: 2000, outputTokens: 100, cachedTokens: 1000 }),
		event("checkpoint_saved", { iteration: 2 }),
		...iteration(3, [
			["write_to_file", "src/new.ts"],
			["apply_diff", "src/a.ts"],
		], { inputTokens: 500, outputTokens: 200, cachedTokens: 0 }),
		event("checkpoint_saved", { iteration: 3 }),
	]

	const model = buildTimeline(events)
	assert.equal(model.sessionId, "session-1")
	assert.equal(model.task, "implement feature")
	assert.equal(model.model, "deepseek/deepseek-v4-flash")
	assert.equal(model.mode, "code")

	// The shape: exploration for 2 iterations, then editing from iteration 3.
	assert.deepEqual(
		model.iterations.map((i) => i.category),
		["read", "read", "write"],
	)
	assert.deepEqual(
		model.iterations.map((i) => i.iteration),
		[1, 2, 3],
	)

	// Dominant category is by call count; ties break read → search by priority.
	const iter1 = model.iterations[0]
	assert.deepEqual(iter1.toolCalls, [
		{ name: "codebase_search", count: 2 },
		{ name: "read_file", count: 2 },
		{ name: "list_files", count: 1 },
	])
	assert.equal(iter1.toolCount, 5)

	// Running tool-mix totals: reads 5 + 3, searches 2, writes 2, no commands.
	assert.deepEqual(
		{ read: model.totals.read, write: model.totals.write, exec: model.totals.exec, search: model.totals.search, other: model.totals.other },
		{ read: 6, write: 2, exec: 0, search: 2, other: 0 },
	)
	assert.equal(model.totals.toolCalls, 10)

	// Token overlay: per-iteration sums roll up into totals.
	assert.deepEqual(
		model.iterations.map((i) => [i.inputTokens, i.outputTokens, i.cachedTokens]),
		[[1000, 50, 500], [2000, 100, 1000], [500, 200, 0]],
	)
	assert.deepEqual(
		[model.totals.inputTokens, model.totals.outputTokens, model.totals.cachedTokens],
		[3500, 350, 1500],
	)

	// Markers: session start, then one checkpoint per iteration incl. baseline.
	assert.deepEqual(
		model.markers.map((m) => m.kind),
		["start", "checkpoint", "checkpoint", "checkpoint", "checkpoint"],
	)
	assert.equal(model.markers[1].iteration, 0, "baseline checkpoint")
}

// ─── Editing, pause/resume, a decision, execution, an idle iteration ────────

async function testStructuralMarkersAndIdleIteration(): Promise<void> {
	const events: EventRecord[] = [
		...iteration(1, [
			["write_to_file", "src/x.ts"],
			["search_replace", "src/y.ts"],
		]),
		event("paused", { iteration: 1, reason: "budget limit" }),
		event("resumed", { iteration: 2, reason: "user continued" }),
		event("iteration_start", { iteration: 2 }),
		event("decision_blocked", { question: "proceed with refactor?" }),
		event("decision_answered", { answer: "yes" }),
		event("llm_response", { iteration: 2, hadToolCalls: false }),
		...iteration(3, [
			["execute_command", "npm test"],
			["execute_command", "npm test"],
			["execute_command", "npm run build"],
		]),
		// An iteration with no tool calls at all → a "none" cell.
		...iteration(4, []),
		event("session_end", { status: "completed", iterations: 4 }),
	]

	const model = buildTimeline(events)
	// The idle iteration 2 (decision only) and iteration 4 (pure thinking)
	// both render as empty cells, not as read/write/exec.
	assert.deepEqual(
		model.iterations.map((i) => i.category),
		["write", "none", "exec", "none"],
	)

	assert.deepEqual(
		model.markers.map((m) => m.kind),
		["paused", "resumed", "decision", "decision", "end"],
	)
	const [paused, resumed, q, a, end] = model.markers
	assert.equal(paused.reason, "budget limit")
	assert.equal(resumed.reason, "user continued")
	assert.equal(q.question, "proceed with refactor?")
	assert.equal(a.answer, "yes")
	assert.equal(end.status, "completed")

	assert.deepEqual(
		{ read: model.totals.read, write: model.totals.write, exec: model.totals.exec },
		{ read: 0, write: 2, exec: 3 },
	)
}

// ─── Condensation marker (the event added for this feature) ─────────────────

async function testCondensationMarker(): Promise<void> {
	const events: EventRecord[] = [
		event("session_start", { task: "long session" }),
		event("checkpoint_saved", { iteration: 0 }),
		...iteration(5, []),
		event("condensed", {
			iteration: 5,
			messagesBefore: 31,
			messagesAfter: 12,
			inputTokens: 1000,
			outputTokens: 200,
			cachedTokens: 0,
		}),
		...iteration(6, []),
	]

	const model = buildTimeline(events)
	const condensed = model.markers.find((m) => m.kind === "condensed")
	assert.ok(condensed, "condensed marker present")
	assert.equal(condensed!.iteration, 5)
	assert.equal(condensed!.messagesBefore, 31)
	assert.equal(condensed!.messagesAfter, 12)
	assert.equal(condensed!.inputTokens, 1000)
	// The iteration whose call triggered the condense is the one before it.
	assert.equal(model.iterations[0].iteration, 5)
	assert.equal(model.iterations[1].iteration, 6)
}

// ─── Dominant-category tie-breaking is deterministic ────────────────────────

async function testTieBreakPriority(): Promise<void> {
	// One write + one read at equal counts → the write wins (it's the point).
	const mixed = buildTimeline([
		...iteration(1, [
			["read_file", "src/a.ts"],
			["write_to_file", "src/b.ts"],
		]),
	])
	assert.equal(mixed.iterations[0].category, "write")

	// One read + one search → search wins (TIE_BREAK order read < search).
	const readSearch = buildTimeline([
		...iteration(1, [
			["read_file", "src/a.ts"],
			["codebase_search", "x"],
		]),
	])
	assert.equal(readSearch.iterations[0].category, "search")

	// A failed tool result marks the iteration as errored, not the category.
	const errored = buildTimeline([
		...iteration(1, [["execute_command", "failing test"]]),
	])
	assert.equal(errored.iterations[0].category, "exec")
	assert.equal(errored.iterations[0].hasError, true)
}

// ─── Empty feed degrades gracefully ─────────────────────────────────────────

async function testEmptyFeed(): Promise<void> {
	const model = buildTimeline([])
	assert.equal(model.sessionId, "")
	assert.deepEqual(model.iterations, [])
	assert.deepEqual(model.markers, [])
	assert.equal(model.totals.toolCalls, 0)
}

// ─── shared built renderer stays in sync with timeline.ts ────────────────────
// The dashboard shim in src/dashboard/page.ts reads the canonical shared UI
// build from capsize-web/apps/headlesscode/dist. Check that built browser code,
// rather than the retired local page.ts implementation, against this timeline
// model. Keep this integration optional so a standalone CLI checkout still
// runs its tests when the sibling dashboard artifact is absent.

function extractSetMembers(source: string, varName: string): string[] {
	const match = new RegExp(`${varName}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`).exec(source)
	assert.ok(match, `expected to find "${varName} = new Set([...])" in the source`)
	const items = match[1].match(/"([^"]*)"/g) ?? []
	return items.map((s) => s.slice(1, -1)).sort()
}

const timelineSetPairs: Array<[string, string]> = [
	["READ_TOOLS", "TL_READ"],
	["WRITE_TOOLS", "TL_WRITE"],
	["EXEC_TOOLS", "TL_EXEC"],
	["SEARCH_TOOLS", "TL_SEARCH"],
]

function assertRendererParity(timelineSource: string, rendererSource: string): void {
	for (const [timelineVar, rendererVar] of timelineSetPairs) {
		assert.deepEqual(
			extractSetMembers(rendererSource, rendererVar),
			extractSetMembers(timelineSource, timelineVar),
			`shared renderer's ${rendererVar} has drifted from timeline.ts's ${timelineVar}`,
		)
	}
}

async function testSharedRendererToolSetsStayInSyncWithTimelineTs(): Promise<void> {
	const timelineSource = await fs.readFile(path.join(__dirname, "..", "timeline.ts"), "utf-8")
	const explicitRendererPath = process.env.CAPSIZE_HEADLESSCODE_RENDERER_JS
	const rendererPath = explicitRendererPath
		?? path.resolve(__dirname, "../../../../capsize-web/apps/headlesscode/dist/assets/headlesscode.js")
	let rendererSource: string
	try {
		rendererSource = await fs.readFile(rendererPath, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			if (explicitRendererPath) {
				throw new Error(`CAPSIZE_HEADLESSCODE_RENDERER_JS points to a missing shared renderer: ${rendererPath}`)
			}
			console.log(`SKIP dashboard timeline parity: optional shared renderer is absent at ${rendererPath}`)
			return
		}
		throw error
	}

	assertRendererParity(timelineSource, rendererSource)

	const driftedRenderer = rendererSource.replace(
		/(const TL_READ = new Set\(\[[^\]]*)\]/,
		'$1, "synthetic_drift"]',
	)
	assert.notEqual(driftedRenderer, rendererSource, "synthetic renderer fixture must change the TL_READ set")
	assert.throws(
		() => assertRendererParity(timelineSource, driftedRenderer),
		/shared renderer's TL_READ has drifted/,
		"the parity assertion must reject a drifted renderer fixture",
	)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["timeline: classifyTool buckets read/write/exec/search/other", testClassifyToolBuckets],
	["timeline: exploration-then-editing session produces the expected shape", testExplorationThenEditingShape],
	["timeline: pause/resume/decision/session_end markers + idle iterations", testStructuralMarkersAndIdleIteration],
	["timeline: condensation point becomes a marker with before/after counts", testCondensationMarker],
	["timeline: dominant-category ties break deterministically", testTieBreakPriority],
	["timeline: empty feed degrades gracefully", testEmptyFeed],
	["timeline: shared renderer TL_READ/WRITE/EXEC/SEARCH sets stay in sync with timeline.ts", testSharedRendererToolSetsStayInSyncWithTimelineTs],
]

runMain("dashboard timeline", tests)
