/**
 * Unit tests for src/dashboard/chat-thread.ts's `groupEventsIntoChat` — the
 * pure grouping that turns the flat event feed into conversation turns for the
 * dashboard's chat-thread view. Plain assert-based script (no test framework),
 * run via `npm test` -> `tsx src/dashboard/__tests__/chat-thread.test.ts`.
 *
 * Covers the fixture cases the plan doc calls out: a normal turn, a turn with
 * multiple tool calls, an error tool result, a decision-blocked/answered
 * pair, and a pause/resume pair.
 */

import assert from "node:assert/strict"

import { groupEventsIntoChat, summarizeArg } from "../chat-thread.js"
import type { EventRecord } from "../../engine/events.js"

function event(type: string, extra: Record<string, unknown> = {}): EventRecord {
	return { ts: "2026-08-01T00:00:00.000Z", sessionId: "session-1", type, ...extra }
}

// ─── Helpers to inspect grouped output ──────────────────────────────────────

function turnsOf(group: ReturnType<typeof groupEventsIntoChat>): EventRecord[][] {
	return group.blocks.filter((b) => b.kind === "turn").map((b) => (b as { events: EventRecord[] }).events)
}

function systemsOf(group: ReturnType<typeof groupEventsIntoChat>): EventRecord[] {
	return group.blocks
		.filter((b) => b.kind === "system")
		.map((b) => (b as { event: EventRecord }).event)
}

// ─── A normal turn: iteration_start → llm_response → tool_call → tool_result ─

async function testNormalTurnGroupsIntoTurn(): Promise<void> {
	const events = [
		event("session_start", { task: "fix the bug" }),
		event("checkpoint_saved", { iteration: 0 }),
		event("iteration_start", { iteration: 1 }),
		event("llm_response", { iteration: 1, hadToolCalls: true, textPreview: "I'll look." }),
		event("tool_call", { iteration: 1, tool: "read_file", args: "src/a.ts" }),
		event("tool_result", { iteration: 1, tool: "read_file", isError: false, result: "contents" }),
	]

	const group = groupEventsIntoChat(events)
	assert.equal(group.task, "fix the bug")

	const blocks = group.blocks
	// session_start + checkpoint_saved are system blocks; the rest is one turn.
	assert.equal(blocks.length, 3, "two system blocks + one turn block")
	assert.equal(blocks[0].kind, "system")
	assert.equal(blocks[1].kind, "system")
	assert.equal(blocks[2].kind, "turn")

	const turn = blocks[2] as Extract<typeof blocks[number], { kind: "turn" }>
	assert.equal(turn.iteration, 1)
	// The turn carries everything after iteration_start: the llm_response, the
	// tool_call AND its tool_result (the result attaches to the preceding call).
	assert.deepEqual(
		turn.events.map((e) => e.type),
		["llm_response", "tool_call", "tool_result"],
	)
	// The tool_result must be attached to the preceding tool_call in the same
	// turn (same iteration, same tool) — not a standalone system marker.
	assert.equal(turn.events[1].tool, "read_file")
	assert.equal(turn.events[2].tool, "read_file")
}

// ─── A turn with MULTIPLE tool calls ────────────────────────────────────────

async function testMultipleToolCallsStayInOneTurn(): Promise<void> {
	const events = [
		event("iteration_start", { iteration: 2 }),
		event("llm_response", { iteration: 2, hadToolCalls: true, textPreview: "" }),
		event("tool_call", { iteration: 2, tool: "list_files", args: "." }),
		event("tool_result", { iteration: 2, tool: "list_files", isError: false, result: "a\nb" }),
		event("tool_call", { iteration: 2, tool: "read_file", args: "src/b.ts" }),
		event("tool_result", { iteration: 2, tool: "read_file", isError: false, result: "code" }),
	]

	const group = groupEventsIntoChat(events)
	const turns = turnsOf(group)
	assert.equal(turns.length, 1, "both tool calls belong to the SAME turn")
	assert.deepEqual(
		turns[0].map((e) => e.type),
		["llm_response", "tool_call", "tool_result", "tool_call", "tool_result"],
	)
	// Each result follows its own call in order.
	assert.equal(turns[0][1].tool, "list_files")
	assert.equal(turns[0][2].tool, "list_files")
	assert.equal(turns[0][3].tool, "read_file")
	assert.equal(turns[0][4].tool, "read_file")
}

// ─── An ERROR tool result stays attached to its call ────────────────────────

async function testErrorToolResultStaysWithItsCall(): Promise<void> {
	const events = [
		event("iteration_start", { iteration: 3 }),
		event("llm_response", { iteration: 3, hadToolCalls: true, textPreview: "running" }),
		event("tool_call", { iteration: 3, tool: "execute_command", args: "rm -rf /" }),
		event("tool_result", { iteration: 3, tool: "execute_command", isError: true, result: "permission denied" }),
	]

	const group = groupEventsIntoChat(events)
	const turns = turnsOf(group)
	assert.equal(turns.length, 1)
	assert.equal(turns[0].length, 3)
	// The error result is attached to its call — the chat view must be able to
	// render it as a visually-distinct error result inside the same turn.
	const result = turns[0][2]
	assert.equal(result.isError, true)
	assert.equal(result.tool, "execute_command")
}

// ─── decision_blocked / decision_answered pair ──────────────────────────────

async function testDecisionBlockedAnsweredPair(): Promise<void> {
	const events = [
		event("iteration_start", { iteration: 4 }),
		event("llm_response", { iteration: 4, hadToolCalls: true, textPreview: "a question" }),
		event("tool_call", { iteration: 4, tool: "ask_followup_question", args: "proceed?" }),
		event("tool_result", { iteration: 4, tool: "ask_followup_question", isError: false, result: "waiting" }),
		event("decision_blocked", { question: "proceed?" }),
		event("decision_answered", { answer: "yes", timedOut: false }),
	]

	const group = groupEventsIntoChat(events)
	const turns = turnsOf(group)
	// The decision_blocked STARTS a fresh turn (a new user→assistant exchange),
	// so the pair is its own turn rather than being stuffed into iteration 4.
	// Like iteration_start, the decision_blocked is that turn's turnStart (the
	// boundary marker); the answer is the turn's content.
	assert.equal(turns.length, 2, "iteration turn + decision turn")
	assert.deepEqual(
		turns[1].map((e) => e.type),
		["decision_answered"],
	)
	// The blocked event is that turn's turnStart, so the chat view can render
	// the question as the user message and the answer as the reply.
	const decisionTurn = group.blocks.find(
		(b) => b.kind === "turn" && (b as { turnStart: EventRecord }).turnStart.type === "decision_blocked",
	)
	assert.ok(decisionTurn, "decision turn must exist")
	assert.equal((decisionTurn as { turnStart: EventRecord }).turnStart.question, "proceed?")
}

// ─── A pause/resume pair ────────────────────────────────────────────────────

async function testPauseResumePairAreSystemMarkers(): Promise<void> {
	const events = [
		event("iteration_start", { iteration: 5 }),
		event("llm_response", { iteration: 5, hadToolCalls: false, textPreview: "almost done" }),
		event("paused", { reason: "human asked" }),
		event("resumed", { reason: "ok go" }),
	]

	const group = groupEventsIntoChat(events)
	const systems = systemsOf(group)
	// The pause/resume pair closes the current turn and renders as small inline
	// system markers, NOT as chat bubbles.
	assert.equal(systems.filter((e) => e.type === "paused" || e.type === "resumed").length, 2)
	assert.deepEqual(
		systems.map((e) => e.type),
		["paused", "resumed"],
	)
	// The iteration turn still exists as its own turn before the markers.
	assert.equal(turnsOf(group).length, 1)
}

// ─── llm_stream_chunk events belong to the CURRENT turn ─────────────────────

async function testStreamChunksStayInCurrentTurn(): Promise<void> {
	const events = [
		event("iteration_start", { iteration: 2 }),
		event("llm_stream_chunk", { iteration: 2, kind: "reasoning", chunk: "think" }),
		event("llm_stream_chunk", { iteration: 2, kind: "reasoning", chunk: "ing" }),
		event("llm_stream_chunk", { iteration: 2, kind: "text", chunk: "Hello" }),
		event("llm_response", { iteration: 2, hadToolCalls: false, textPreview: "Hello", outputTokens: 5 }),
		event("tool_call", { iteration: 2, tool: "attempt_completion", args: "done" }),
		event("tool_result", { iteration: 2, tool: "attempt_completion", isError: false, result: "ok" }),
		event("session_end", { status: "success", iterations: 2 }),
	]

	const group = groupEventsIntoChat(events)
	const turns = turnsOf(group)
	// The stream chunks must NOT close the turn (they are not system markers):
	// everything from iteration_start through the tool_result is ONE turn.
	assert.equal(turns.length, 1, "stream chunks must stay in the current turn, not fragment it")
	assert.deepEqual(
		turns[0].map((e) => e.type),
		["llm_stream_chunk", "llm_stream_chunk", "llm_stream_chunk", "llm_response", "tool_call", "tool_result"],
	)
	assert.equal(turns[0][0].kind, "reasoning")
	assert.equal(turns[0][2].kind, "text")
	// No stream chunk leaks out as a system marker.
	assert.deepEqual(systemsOf(group).map((e) => e.type), ["session_end"])
}

// ─── A lone stream chunk (feed starts mid-stream) is a system marker ────────

async function testLoneStreamChunkIsSystemMarker(): Promise<void> {
	const group = groupEventsIntoChat([event("llm_stream_chunk", { iteration: 1, kind: "text", chunk: "orphan" })])
	const systems = systemsOf(group)
	assert.equal(systems.length, 1)
	assert.equal(systems[0].type, "llm_stream_chunk")
	assert.equal(turnsOf(group).length, 0)
}

// ─── session_end closes the last turn ───────────────────────────────────────

async function testSessionEndClosesTurnAndIsSystemMarker(): Promise<void> {
	const events = [
		event("iteration_start", { iteration: 6 }),
		event("llm_response", { iteration: 6, hadToolCalls: false, textPreview: "done" }),
		event("session_end", { status: "success", iterations: 6, costUsd: 0.01, inputTokens: 100, outputTokens: 50 }),
	]

	const group = groupEventsIntoChat(events)
	assert.equal(turnsOf(group).length, 1)
	const systems = systemsOf(group)
	assert.equal(systems.length, 1)
	assert.equal(systems[0].type, "session_end")
}

// ─── Empty / task-less / orphaned result ────────────────────────────────────

async function testEmptyFeedAndNoTask(): Promise<void> {
	assert.deepEqual(groupEventsIntoChat([]).blocks, [])
	const noTask = groupEventsIntoChat([event("session_start", {})])
	assert.equal(noTask.task, undefined)
	assert.equal(noTask.blocks.length, 1)
	assert.equal(noTask.blocks[0].kind, "system")
}

async function testOrphanedToolResultIsSystemMarker(): Promise<void> {
	const events = [
		event("tool_result", { iteration: 1, tool: "read_file", isError: false, result: "lonely" }),
		event("iteration_start", { iteration: 1 }),
		event("tool_call", { iteration: 1, tool: "read_file", args: "x.ts" }),
		event("tool_result", { iteration: 1, tool: "read_file", isError: false, result: "ok" }),
	]
	const group = groupEventsIntoChat(events)
	const systems = systemsOf(group)
	assert.equal(systems.length, 1, "only the orphaned result is a system marker")
	assert.equal(systems[0].type, "tool_result")
	assert.equal(turnsOf(group).length, 1)
}

// ─── summarizeArg ───────────────────────────────────────────────────────────

async function testSummarizeArg(): Promise<void> {
	assert.equal(summarizeArg(event("tool_call", { tool: "read_file", args: "src/a.ts" })), "src/a.ts")
	assert.equal(summarizeArg(event("tool_call", { tool: "execute_command", args: "npm test" })), "npm test")
	// Long args are capped at 80 chars with an ellipsis.
	const long = "x".repeat(200)
	const s = summarizeArg(event("tool_call", { tool: "execute_command", args: long }))
	assert.equal(s.length, 81)
	assert.ok(s.endsWith("…"))
	// Non-tool_call / missing args → empty string.
	assert.equal(summarizeArg(event("tool_result", { tool: "read_file" })), "")
	assert.equal(summarizeArg(event("tool_call", { tool: "read_file" })), "")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["chat-thread: a normal turn groups iteration+response+call+result into one turn", testNormalTurnGroupsIntoTurn],
	["chat-thread: multiple tool calls stay in one turn", testMultipleToolCallsStayInOneTurn],
	["chat-thread: an error tool result stays attached to its call", testErrorToolResultStaysWithItsCall],
	["chat-thread: decision_blocked/answered pair forms its own turn", testDecisionBlockedAnsweredPair],
	["chat-thread: pause/resume pair renders as system markers", testPauseResumePairAreSystemMarkers],
	["chat-thread: stream chunks stay in the current turn (no fragmentation)", testStreamChunksStayInCurrentTurn],
	["chat-thread: a lone stream chunk degrades to a system marker", testLoneStreamChunkIsSystemMarker],
	["chat-thread: session_end closes the turn and is a system marker", testSessionEndClosesTurnAndIsSystemMarker],
	["chat-thread: empty feed / no task degrade gracefully", testEmptyFeedAndNoTask],
	["chat-thread: an orphaned tool_result is a system marker", testOrphanedToolResultIsSystemMarker],
	["chat-thread: summarizeArg shortens long args, keeps short ones", testSummarizeArg],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} dashboard chat-thread tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
