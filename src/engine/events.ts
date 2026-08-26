/**
 * Per-session structured event feed — live worker monitoring (Phase 1).
 *
 * Mirrors `src/engine/usage.ts`'s idiom exactly: append-only JSONL, one file
 * per session, loose validation on read, plain `node:fs` — no schema library.
 *
 *   <workspaceRoot>/.headlesscode/events/<sessionId>.jsonl
 *
 * Each line is one `EventRecord`:
 *
 *   { ts: ISO string, sessionId: string, type: string, ...fields }
 *
 * Event types emitted by HeadlessSession (see src/engine/loop.ts):
 *   session_start / iteration_start / llm_response / tool_call / tool_result
 *   checkpoint_saved / decision_blocked / decision_answered
 *   condensed / todo_updated / paused / resumed / session_end
 *   attempt_completion (issue #34): the session's FINAL report, emitted when
 *   the loop accepts completion (attempt_completion tool call OR the
 *   text-only success fallback) and carries the FULL report text — this is
 *   the deliberate exception to EVENT_TRUNCATE_CHARS: the report is exactly
 *   the content the model produced, so truncating it would reintroduce the
 *   observability gap it exists to close (a surprising review/QA verdict was
 *   previously unrecoverable without re-running the whole session). The
 *   full report is ALSO persisted to `<workspaceRoot>/.headlesscode/reports/
 *   <sessionId>.md` (see src/engine/reports.ts) so it survives even a feed
 *   that never gets polled.
 *   mode_switched (switch_mode: the session's own active mode changed in
 *   place — same session, new system prompt/tool set; see
 *   plans/switch-mode-headless.md)
 *   message_injected (live chat-UI control: a human wrote a new user message
 *   into the RUNNING session via the dashboard — POST /api/session/:id/message
 *   → `.harness.inject-message` marker; see loop.ts's checkInjectedMessage.
 *   The text has been appended to the session's live history as a plain
 *   user-role message and the next LLM call sees it)
 *
 * `condensed` is the one structural event that was originally only a log line
 * (`[condense] oldest turns condensed…` in src/engine/condense.ts) — the
 * dashboard's timeline view needs it as a real event to mark where the
 * session compressed its history, so it is emitted by HeadlessSession when a
 * condensation pass actually replaces the oldest turns.
 *
 * `todo_updated` (update_todo_list: full normalized checklist + counts —
 * done / inProgress / pending; the dashboard reads this to render live
 * planning state)
 *
 * Unlike the live usage snapshot (deleted at session end because the final
 * .jsonl record supersedes it), the event feed is a history/replay log and is
 * KEPT after the session ends — it is never deleted in session teardown.
 *
 * This module is the ONLY place that knows the on-disk events layout, so the
 * dashboard read side (`src/dashboard/aggregate.ts`'s `readSessionEvents`)
 * and the write side (`EventFeed` below) stay in sync.
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"

/** Cap on any single event field's string content (this feed is polled frequently). */
export const EVENT_TRUNCATE_CHARS = 500

/** One line of the per-session event feed. */
export interface EventRecord {
	ts: string
	sessionId: string
	type: string
	iteration?: number
	/**
	 * Recursive task decomposition (`new_task`): the id of the session that
	 * spawned this one, present on every event of a child session (absent on
	 * root sessions). Lets the dashboard render parent/child nesting without
	 * cross-referencing anything else — the lineage is stamped onto each
	 * record, so a child feed never needs its parent's feed to be readable.
	 */
	parentSessionId?: string
	/**
	 * Recursive task decomposition (`new_task`): this session's recursion
	 * depth (0 = root). Stamped onto every event alongside parentSessionId.
	 */
	recursionDepth?: number
	[field: string]: unknown
}

/** The events dir for a workspace: `<workspaceRoot>/.headlesscode/events`. */
export function eventsDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".headlesscode", "events")
}

/** The event feed file path for one session. */
export function eventsFilePath(workspaceRoot: string, sessionId: string): string {
	return path.join(eventsDir(workspaceRoot), `${sessionId}.jsonl`)
}

/**
 * Append one event record to a session's feed. Creates the events dir if
 * needed. Callers are expected to wrap this in try/catch and treat failures
 * as non-fatal (see `EventFeed`); this function itself does not swallow
 * errors, so it fails loudly for direct callers/tests.
 */
export async function appendEvent(workspaceRoot: string, sessionId: string, record: EventRecord): Promise<void> {
	const file = eventsFilePath(workspaceRoot, sessionId)
	await fsp.mkdir(path.dirname(file), { recursive: true })
	await fsp.appendFile(file, JSON.stringify(record) + "\n", "utf-8")
}

/**
 * Read + loosely validate one event feed JSONL file. Malformed /
 * partially-written lines are skipped; a missing file yields an empty array
 * (never throws for ENOENT — matches the usage store's `readUsageFile` idiom).
 */
export async function readEventsFile(file: string): Promise<EventRecord[]> {
	let raw: string
	try {
		raw = await fsp.readFile(file, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw error
	}
	const records: EventRecord[] = []
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		try {
			const parsed = JSON.parse(trimmed) as Partial<EventRecord>
			if (
				typeof parsed.ts === "string" &&
				typeof parsed.sessionId === "string" &&
				typeof parsed.type === "string"
			) {
				records.push(parsed as EventRecord)
			}
		} catch {
			// Loose validation: skip malformed / partially-written lines.
		}
	}
	return records
}

/** A string field that was possibly truncated to `EVENT_TRUNCATE_CHARS`. */
export interface TruncatedField {
	text: string
	truncated: boolean
}

/** Truncate a long string for the event feed, flagging when it was cut. */
export function truncateField(value: string, max = EVENT_TRUNCATE_CHARS): TruncatedField {
	if (value.length <= max) {
		return { text: value, truncated: false }
	}
	return { text: value.slice(0, max), truncated: true }
}

/**
 * The session's structured event writer. Every emit is non-fatal: a failure
 * to append is reported via the injected `onError` callback (the loop wires
 * it to `logger.warn`, matching the established memory/usage/checkpoint
 * try/catch idiom) and never affects the session.
 *
 * Emits are serialized through an internal promise chain so fire-and-forget
 * calls (e.g. decision events surfaced from inside a tool handler) still
 * append to the same file in emission order.
 */
export class EventFeed {
	private queue: Promise<void> = Promise.resolve()

	constructor(
		private readonly workspaceRoot: string,
		private readonly sessionId: string,
		private readonly onError: (eventType: string, error: unknown) => void,
		/**
		 * Recursive task decomposition (`new_task`): the parent session's id
		 * and this session's recursion depth, stamped onto EVERY record so a
		 * child feed is self-describing. Absent on root sessions (no-op).
		 */
		private readonly lineage?: { parentSessionId?: string; recursionDepth?: number },
	) {}

	/** Append a raw event record (non-fatal). */
	emit(type: string, fields: Record<string, unknown> = {}): Promise<void> {
		const record: EventRecord = {
			ts: new Date().toISOString(),
			sessionId: this.sessionId,
			type,
			...(this.lineage?.parentSessionId ? { parentSessionId: this.lineage.parentSessionId } : {}),
			...(this.lineage?.recursionDepth !== undefined ? { recursionDepth: this.lineage.recursionDepth } : {}),
			...fields,
		}
		const task = this.queue.then(() => appendEvent(this.workspaceRoot, this.sessionId, record))
		// Keep the chain alive even when a write fails (the error is reported
		// to onError; later events must still be attempted).
		this.queue = task.catch(() => undefined)
		return task
	}

	sessionStart(fields: { mode: string; model: string; workspaceRoot: string; taskText: string }): Promise<void> {
		const task = truncateField(fields.taskText)
		return this.emit("session_start", {
			mode: fields.mode,
			model: fields.model,
			workspaceRoot: fields.workspaceRoot,
			task: task.text,
			...(task.truncated ? { taskTruncated: true } : {}),
		})
	}

	iterationStart(iteration: number, historyMessageCount: number): Promise<void> {
		return this.emit("iteration_start", { iteration, historyMessageCount })
	}

	llmResponse(fields: {
		iteration: number
		hadToolCalls: boolean
		textPreview?: string
		/** Reasoning/"thinking" text (streaming-and-reasoning), truncated like other large fields. */
		reasoningPreview?: string
		inputTokens?: number
		outputTokens?: number
		cachedTokens?: number
	}): Promise<void> {
		const text = fields.textPreview ? truncateField(fields.textPreview) : undefined
		const reasoning = fields.reasoningPreview ? truncateField(fields.reasoningPreview) : undefined
		return this.emit("llm_response", {
			iteration: fields.iteration,
			hadToolCalls: fields.hadToolCalls,
			...(text ? { textPreview: text.text, ...(text.truncated ? { textTruncated: true } : {}) } : {}),
			...(reasoning
				? { reasoningPreview: reasoning.text, ...(reasoning.truncated ? { reasoningTruncated: true } : {}) }
				: {}),
			...(fields.inputTokens !== undefined ? { inputTokens: fields.inputTokens } : {}),
			...(fields.outputTokens !== undefined ? { outputTokens: fields.outputTokens } : {}),
			...(fields.cachedTokens !== undefined ? { cachedTokens: fields.cachedTokens } : {}),
		})
	}

	/**
	 * One incremental chunk of a streamed LLM response (streaming-and-reasoning,
	 * opt-in). Distinct from the single `llm_response` summary event which still
	 * fires once at the end of the call with final totals — this is the
	 * live-typing feed. `kind` is "text" | "reasoning" | "tool" so the dashboard
	 * can render reasoning text differently from the answer text. Truncated like
	 * every other large field.
	 */
	llmStreamChunk(fields: {
		iteration: number
		kind: "text" | "reasoning" | "tool"
		chunk: string
	}): Promise<void> {
		const c = truncateField(fields.chunk)
		return this.emit("llm_stream_chunk", {
			iteration: fields.iteration,
			kind: fields.kind,
			chunk: c.text,
			...(c.truncated ? { chunkTruncated: true } : {}),
		})
	}

	toolCall(fields: { iteration: number; tool: string; args: string; argsTruncated: boolean }): Promise<void> {
		return this.emit("tool_call", {
			iteration: fields.iteration,
			tool: fields.tool,
			args: fields.args,
			...(fields.argsTruncated ? { argsTruncated: true } : {}),
		})
	}

	toolResult(fields: {
		iteration: number
		tool: string
		isError: boolean
		result: string
		resultTruncated: boolean
	}): Promise<void> {
		return this.emit("tool_result", {
			iteration: fields.iteration,
			tool: fields.tool,
			isError: fields.isError,
			result: fields.result,
			...(fields.resultTruncated ? { resultTruncated: true } : {}),
		})
	}

	/**
	 * The session's final report (issue #34). Emitted when the loop accepts
	 * completion — the one tool call that matters most for understanding a
	 * review/QA/worker verdict was previously invisible to the feed because
	 * attempt_completion short-circuits before the tool-execution loop (no
	 * tool_call/tool_result pair is ever recorded for it). `result` is the
	 * FULL report text, deliberately NOT truncated (the only event field that
	 * ignores EVENT_TRUNCATE_CHARS — see the module doc comment for why); the
	 * full report is also persisted to `.headlesscode/reports/<sessionId>.md`
	 * by the loop, so the feed and the file are two views of the same text.
	 */
	attemptCompletion(fields: { iteration: number; result: string }): Promise<void> {
		return this.emit("attempt_completion", {
			iteration: fields.iteration,
			result: fields.result,
		})
	}

	/** iteration 0 = the session's baseline checkpoint (before iteration 1). */
	checkpointSaved(iteration: number): Promise<void> {
		return this.emit("checkpoint_saved", { iteration })
	}

	/**
	 * A context-condensation pass replaced the oldest turns with one synthetic
	 * summary message (see src/engine/condense.ts). Carries the iteration whose
	 * call triggered it, the message counts before/after, and the condensation
	 * call's own token usage when known (the dashboard timeline marks the
	 * point; the tokens make the spend visible — condensation was previously
	 * only a log line, invisible to the feed).
	 */
	condensed(fields: {
		iteration: number
		messagesBefore: number
		messagesAfter: number
		inputTokens?: number
		outputTokens?: number
		cachedTokens?: number
	}): Promise<void> {
		return this.emit("condensed", {
			iteration: fields.iteration,
			messagesBefore: fields.messagesBefore,
			messagesAfter: fields.messagesAfter,
			...(fields.inputTokens !== undefined ? { inputTokens: fields.inputTokens } : {}),
			...(fields.outputTokens !== undefined ? { outputTokens: fields.outputTokens } : {}),
			...(fields.cachedTokens !== undefined ? { cachedTokens: fields.cachedTokens } : {}),
		})
	}

	/**
	 * Todo-list state change (update_todo_list): the full normalized checklist
	 * (truncated like every other large field) plus done / in-progress /
	 * pending counts, so the dashboard can show live planning state and the
	 * history can show how the checklist evolved across the session.
	 */
	todoUpdated(fields: { todos: string; done: number; inProgress: number; pending: number }): Promise<void> {
		const t = truncateField(fields.todos)
		return this.emit("todo_updated", {
			todos: t.text,
			...(t.truncated ? { todosTruncated: true } : {}),
			done: fields.done,
			inProgress: fields.inProgress,
			pending: fields.pending,
		})
	}

	decisionBlocked(question: string, suggestions?: string[]): Promise<void> {
		const q = truncateField(question)
		return this.emit("decision_blocked", {
			question: q.text,
			...(q.truncated ? { questionTruncated: true } : {}),
			...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
		})
	}

	/** Answer received, or the wait timed out (timedOut: true) and the worker moved on. */
	decisionAnswered(answer?: string, timedOut = false): Promise<void> {
		const a = answer !== undefined ? truncateField(answer) : undefined
		return this.emit("decision_answered", {
			...(timedOut ? { timedOut: true } : {}),
			...(a ? { answer: a.text, ...(a.truncated ? { answerTruncated: true } : {}) } : {}),
		})
	}

	/**
	 * switch_mode changed the session's OWN active mode in place (same
	 * session/history/budget, new system prompt + tool set from this point
	 * forward — see plans/switch-mode-headless.md). autoApproved tells the
	 * dashboard whether the switch went through the human/orchestrator
	 * approval gate (false) or the off-by-default auto-approve opt-in (true).
	 */
	modeSwitched(fields: { from: string; to: string; reason: string; autoApproved: boolean }): Promise<void> {
		const reason = truncateField(fields.reason)
		return this.emit("mode_switched", {
			from: fields.from,
			to: fields.to,
			reason: reason.text,
			...(reason.truncated ? { reasonTruncated: true } : {}),
			autoApproved: fields.autoApproved,
		})
	}

	/**
	 * Mid-session message injection (live chat-UI control): a human wrote a
	 * new message into a RUNNING session (POST /api/session/:id/message →
	 * `.harness.inject-message` marker; see loop.ts's checkInjectedMessage).
	 * The text is a plain user-role message the session appended to its live
	 * history; the dashboard renders it inline as if the user had just typed
	 * it. Truncated like every other large field.
	 */
	messageInjected(fields: { text: string }): Promise<void> {
		const t = truncateField(fields.text)
		return this.emit("message_injected", {
			text: t.text,
			...(t.truncated ? { textTruncated: true } : {}),
		})
	}

	paused(reason?: string): Promise<void> {
		return this.emit("paused", { ...(reason ? { reason } : {}) })
	}

	resumed(reason?: string): Promise<void> {
		return this.emit("resumed", { ...(reason ? { reason } : {}) })
	}

	sessionEnd(fields: {
		status: string
		iterations: number
		costUsd: number
		inputTokens: number
		outputTokens: number
		cachedTokens: number
	}): Promise<void> {
		return this.emit("session_end", {
			status: fields.status,
			iterations: fields.iterations,
			costUsd: fields.costUsd,
			inputTokens: fields.inputTokens,
			outputTokens: fields.outputTokens,
			cachedTokens: fields.cachedTokens,
		})
	}
}
