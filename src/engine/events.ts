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
 *   paused / resumed / session_end
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
	) {}

	/** Append a raw event record (non-fatal). */
	emit(type: string, fields: Record<string, unknown> = {}): Promise<void> {
		const record: EventRecord = {
			ts: new Date().toISOString(),
			sessionId: this.sessionId,
			type,
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

	/** iteration 0 = the session's baseline checkpoint (before iteration 1). */
	checkpointSaved(iteration: number): Promise<void> {
		return this.emit("checkpoint_saved", { iteration })
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
