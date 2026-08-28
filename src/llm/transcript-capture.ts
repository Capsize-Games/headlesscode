/**
 * Opt-in, full-fidelity LLM call transcript capture — the prerequisite for
 * ever fine-tuning/distilling on this project's own sessions.
 *
 * `.headlesscode/events/*.jsonl` (see src/engine/loop.ts's eventFeed) is a
 * lightweight MONITORING log, not a training-data source: verified live
 * 2026-08-27 that a `write_to_file` tool call there logs only the target
 * file path, never the content the model actually generated. It answers
 * "what happened" (which is all it was ever built for) but not "what did
 * the model actually write" — the second one is what imitation-based
 * fine-tuning needs. This module captures the real thing: the exact
 * `LlmRequest.messages` sent and the exact `LlmResponse` received, for
 * every call, from both providers (OllamaClient and OpenRouterClient) —
 * so a DeepSeek session's successful trajectory and a Qwen session's
 * failing one on the same task become directly comparable training pairs.
 *
 * Off by default (matches this project's convention for every experimental
 * feature — see e.g. HEADLESSCODE_LOCAL_EXPLORE's own doc comment). Opt in
 * with HEADLESSCODE_CAPTURE_TRANSCRIPT_DIR set to a directory; one JSONL
 * file per provider per UTC day, so a long-running orchestrate invocation
 * doesn't produce thousands of tiny files. Capture failures are swallowed
 * (never allowed to break a real LLM call over a logging side effect).
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { ChatMessage, ChatTool, LlmResponse } from "../engine/types.js"

export const TRANSCRIPT_CAPTURE_DIR_ENV = "HEADLESSCODE_CAPTURE_TRANSCRIPT_DIR"

export function isTranscriptCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env[TRANSCRIPT_CAPTURE_DIR_ENV]?.trim())
}

export interface TranscriptContext {
	/** "ollama" | "openrouter" — which client made this call. */
	provider: "ollama" | "openrouter"
	/** Resolved model id actually used for the call. */
	model: string
	/** Session/task identifiers, when the caller has them, purely for later
	 *  filtering/joining against harness.log — never required. */
	sessionId?: string
	mode?: string
	workspaceRoot?: string
}

export interface TranscriptOutcome {
	/** Full engine-level request messages, exactly as sent (post-condensation,
	 *  pre-wire-format-translation — the same shape fed back into the next
	 *  turn, which is what a training example needs to reproduce). */
	messages: ChatMessage[]
	tools?: ChatTool[]
	temperature?: number
	/** Present on success. */
	response?: LlmResponse
	/** Present on failure — the error message, not a thrown object. */
	error?: string
	durationMs: number
}

/**
 * Append one call's full request/response to today's capture file for this
 * provider. Fire-and-forget: never throws, never awaited by the caller —
 * a capture failure must not affect the real LLM call it's recording.
 */
export function captureTranscript(context: TranscriptContext, outcome: TranscriptOutcome): void {
	const dir = process.env[TRANSCRIPT_CAPTURE_DIR_ENV]?.trim()
	if (!dir) {
		return
	}
	try {
		fs.mkdirSync(dir, { recursive: true })
		const day = new Date().toISOString().slice(0, 10)
		const filePath = path.join(dir, `${context.provider}-${day}.jsonl`)
		const record = {
			ts: new Date().toISOString(),
			...context,
			...outcome,
		}
		fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8")
	} catch {
		// Never let a capture failure affect the real call.
	}
}
