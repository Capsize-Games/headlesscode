/**
 * Chat-thread rendering support for the dashboard's session detail view —
 * groups the flat chronological event feed (the same data served by
 * `GET /api/session/:id/events`) into conversation "turns" so the page can
 * render it as a chat thread (assistant bubble + inline tool calls + results)
 * instead of a flat event log.
 *
 * This module is deliberately pure (no DOM, no fetch): the grouping is the
 * one piece of the feature that's worth unit-testing, and keeping it here
 * lets `src/dashboard/__tests__/chat-thread.test.ts` exercise it with fixture
 * event arrays. All DOM work stays in `src/dashboard/page.ts`'s inline
 * vanilla JS, matching that page's no-framework style.
 *
 * Grouping rules (per the existing event ordering in `src/engine/events.ts`):
 *   - An assistant "turn" STARTS at an `iteration_start` event (a fresh
 *     iteration = a fresh assistant turn).
 *   - The `llm_response` event and the `tool_call`/`tool_result` pairs that
 *     follow it belong to that turn, until the next `iteration_start`.
 *   - `tool_result` events are attached to the preceding `tool_call` in the
 *     same turn (tool name + same iteration), forming a call/result pair.
 *   - `decision_blocked` starts a turn (a new question the model asked the
 *     human); the matching `decision_answered` is rendered as an inline
 *     system marker within that same turn.
 *   - `llm_stream_chunk` events belong to the current turn (streamed chunks
 *     arrive BETWEEN iteration_start and llm_response). They must NOT close
 *     the turn — the turn would fragment into one system marker per chunk.
 *   - Everything else (`checkpoint_saved`, `paused`, `resumed`, `llm_error`,
 *     `session_end`, …) is a system-level marker rendered as a small inline
 *     chip between turns, not a chat bubble.
 */

import type { EventRecord } from "../engine/events.js"

/** The chat-relevant payloads extracted from a flat event feed. */
export type ChatBlock =
	| { kind: "system"; event: EventRecord }
	| { kind: "turn"; iteration?: number; turnStart: EventRecord; events: EventRecord[] }

export interface ChatGrouping {
	/** Message list (the user's original task), only present when the feed has a session_start. */
	task?: string
	/** The blocks in feed order: turns + system markers interleaved. */
	blocks: ChatBlock[]
}

/** The user's task text from a session_start event ("" when absent). */
function taskFromSessionStart(e: EventRecord): string {
	if (e.type !== "session_start") return ""
	return typeof e.task === "string" ? e.task : ""
}

/** A tool_call event's short argument summary — mirrors loop.ts's summarizeToolArg style. */
export function summarizeArg(e: EventRecord): string {
	if (e.type !== "tool_call") return ""
	const raw = typeof e.args === "string" ? e.args : ""
	// The feed already carries a server-side short summary (path/command), so
	// this is a belt-and-braces re-summary for robustness only.
	const trimmed = raw.trim()
	if (trimmed.length <= 80) return trimmed
	return trimmed.slice(0, 80) + "…"
}

/**
 * Group a flat, chronological event array into chat blocks. Pure: no DOM, no
 * I/O, no mutation of the input. Malformed/unknown event types fall through
 * to system markers (the flat log remains the source of truth for anything
 * this grouping doesn't understand).
 */
export function groupEventsIntoChat(events: EventRecord[]): ChatGrouping {
	const blocks: ChatBlock[] = []
	let task = ""
	let current: { iteration?: number; turnStart: EventRecord; events: EventRecord[] } | undefined

	const closeTurn = (): void => {
		if (current) {
			blocks.push({ kind: "turn", iteration: current.iteration, turnStart: current.turnStart, events: current.events })
			current = undefined
		}
	}

	for (const e of events) {
		switch (e.type) {
			case "session_start": {
				task = taskFromSessionStart(e)
				blocks.push({ kind: "system", event: e })
				break
			}
			case "iteration_start":
				closeTurn()
				current = { iteration: e.iteration, turnStart: e, events: [] }
				break
			case "decision_blocked":
				// A new question = a new "turn" (it's a fresh user→assistant
				// exchange); the answer arrives as a later decision_answered.
				closeTurn()
				current = { iteration: e.iteration, turnStart: e, events: [] }
				break
			case "tool_result": {
				// Attach to the preceding tool_call in the same turn, if any.
				if (current && current.events.length > 0) {
					const last = current.events[current.events.length - 1]
					if (last.type === "tool_call") {
						current.events.push(e)
						break
					}
				}
				// Orphaned result (no call in the current turn): system marker.
				blocks.push({ kind: "system", event: e })
				break
			}
			case "session_end":
			case "llm_error":
			case "checkpoint_saved":
			case "paused":
			case "resumed":
				closeTurn()
				blocks.push({ kind: "system", event: e })
				break
			case "llm_response":
			case "tool_call":
			case "decision_answered":
			case "llm_stream_chunk":
				// Belongs to the current turn when there is one; otherwise a
				// lone marker (a feed that starts mid-session).
				if (current) {
					current.events.push(e)
				} else {
					blocks.push({ kind: "system", event: e })
				}
				break
			default:
				// Unknown type: keep it as a system marker rather than hiding it.
				closeTurn()
				blocks.push({ kind: "system", event: e })
				break
		}
	}
	closeTurn()

	return { task: task || undefined, blocks }
}
