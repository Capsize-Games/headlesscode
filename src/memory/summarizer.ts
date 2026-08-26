/**
 * Session summarization — Phase 3 deterministic stand-in.
 *
 * `extractSessionSummary` converts a `SessionResult` (+ the session's tool-call
 * history) into a persisted `SessionSummary`, and `buildRollingSummary` turns a
 * list of session summaries into a compact markdown recap so a session can
 * carry context forward WITHOUT keeping the infinite raw history (the
 * AgentMemory equivalent).
 *
 * This is a DETERMINISTIC stand-in: the summary text is the session's final
 * answer (or failure reason), files/commands are derived from the tool-call
 * history, and facts are extracted with keyword heuristics. An LLM-based
 * extractor (the spec's Phase 3.1 "summarize session" endpoint) can be plugged
 * in later via the `SummarizeWithLlm` hook — NO LLM is required for the
 * default path or for tests.
 */

import type { ChatMessage, LlmClient, SessionResult } from "../engine/types.js"
import type { MemoryFact, SessionSummary } from "./types.js"

/** Maximum number of facts extracted from one session result. */
export const MAX_FACTS_PER_SESSION = 8
/** Maximum length of an extracted fact's content. */
export const MAX_FACT_CHARS = 500
/** Default number of sessions kept in a rolling summary. */
export const DEFAULT_ROLLING_MAX_ENTRIES = 10

/**
 * Optional LLM-based summarization hook (Phase 3.1 placeholder).
 *
 * `(llmClient, transcript) => Promise<summaryText>`. Not wired into the
 * deterministic path; documented as the swap-in point for the future
 * AIRunner/UwUChat summarize-session endpoint.
 */
export type SummarizeWithLlm = (llmClient: LlmClient, transcript: string) => Promise<string>

/**
 * Default summarizer: returns the transcript unchanged (deterministic, no
 * LLM). Callers that want the LLM hook may implement/replace this.
 */
export class NoopSummarizer {
	summarize(transcript: string): string {
		return transcript
	}
}

export interface ExtractSummaryOptions {
	taskText: string
	mode?: string
	project: string
	/**
	 * Full session message history (system/user/assistant/tool) — used to
	 * derive `filesTouched` + `commandsRun` from the executed tool calls.
	 * When omitted, those lists are empty (callers that have the history
	 * should always pass it).
	 */
	messages?: ChatMessage[]
}

/**
 * Build a `SessionSummary` from a session result + its tool history.
 *
 * Deterministic, no LLM required:
 *   - summary  = attempt_completion result text, or the final assistant text,
 *                or the failure error message;
 *   - outcome  = success | failure from `result.status`;
 *   - filesTouched  = paths from write_to_file / read_file (and cwd of
 *                     execute_command) calls in the message history;
 *   - commandsRun   = command strings from execute_command calls;
 *   - facts    = heuristic extraction from the result text (see
 *                `extractFacts`), capped at MAX_FACTS_PER_SESSION.
 */
export function extractSessionSummary(result: SessionResult, options: ExtractSummaryOptions): SessionSummary {
	const outcome: "success" | "failure" = result.status === "success" ? "success" : "failure"
	const summaryText =
		(result.result ?? "").trim() || (result.error ?? "").trim() || "Task completed without a final message"

	const { filesTouched, commandsRun } = deriveToolActivity(options.messages ?? [])

	return {
		id: `summary_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
		project: options.project,
		task: options.taskText.trim() || "(untitled task)",
		mode: options.mode,
		outcome,
		summary: summaryText.slice(0, 4000),
		facts: extractFacts(summaryText, options),
		filesTouched,
		commandsRun,
		createdAt: new Date().toISOString(),
	}
}

/**
 * Deterministic fact extraction from a session result text.
 *
 * Heuristic: split into lines, keep lines containing fact-ish keywords, map
 * them to a kind by keyword, cap content at MAX_FACT_CHARS, dedupe by content,
 * cap at MAX_FACTS_PER_SESSION. This is the Phase 3 stand-in for the LLM-based
 * extractor the spec's summarize endpoint will run.
 */
export function extractFacts(text: string, options: ExtractSummaryOptions): MemoryFact[] {
	const source = `session:${options.taskText.trim().slice(0, 80) || "extracted"}`
	const facts: MemoryFact[] = []
	const seen = new Set<string>()

	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/^[-*\d.\s)\]]+\s*/, "").trim()
		if (line.length < 12) {
			continue
		}
		const kind = classifyLine(line)
		if (!kind) {
			continue
		}
		const content = line.slice(0, MAX_FACT_CHARS)
		if (seen.has(content)) {
			continue
		}
		seen.add(content)
		facts.push({
			id: "", // assigned/project-scoped by the store on addFact
			project: options.project,
			kind,
			content,
			tags: keywordTags(line),
			source,
			createdAt: new Date().toISOString(),
		})
		if (facts.length >= MAX_FACTS_PER_SESSION) {
			break
		}
	}
	return facts
}

/**
 * Keyword → kind mapping (first match wins; priority: failure > decision >
 * convention > knowledge). "Things that didn't work" map to `failure`.
 */
const FACT_KEYWORD_RULES: Array<{ kind: MemoryFact["kind"]; regex: RegExp }> = [
	{
		kind: "failure",
		regex: /never|bug|break|broke|failed|doesn'?t work|didn'?t work|does not work|did not work|\bfix(ed|ing|es)?\b/i,
	},
	{
		kind: "decision",
		regex: /decision|decided|chose|migration|todo|xxx|we (will|should|now) (use|keep|adopt)/i,
	},
	{ kind: "convention", regex: /rule|convention|always/i },
	{ kind: "knowledge", regex: /note|remember/i },
]

export function classifyLine(line: string): MemoryFact["kind"] | null {
	for (const rule of FACT_KEYWORD_RULES) {
		if (rule.regex.test(line)) {
			return rule.kind
		}
	}
	return null
}

/** Tags derived from the matched keywords in a line (deduped, lowercased). */
function keywordTags(line: string): string[] {
	const words = line.toLowerCase().match(/[a-z]{3,}/g) ?? []
	const interesting = words.filter((w) =>
		["never", "always", "rule", "convention", "bug", "fix", "migration", "decision", "note", "todo", "xxx"].includes(w),
	)
	return [...new Set(interesting)]
}

/**
 * Derive filesTouched + commandsRun from the executed tool-call history.
 *
 * The PRIMARY source is assistant messages' `tool_calls` (the args the model
 * emitted) — the loop stores the executor's RESULT text in `tool` messages,
 * not the args, so they can't be parsed from there. A `tool`-message fallback
 * (content that is itself JSON args) is kept for robustness.
 */
function deriveToolActivity(messages: ChatMessage[]): { filesTouched: string[]; commandsRun: string[] } {
	const filesTouched: string[] = []
	const commandsRun: string[] = []
	const seenFiles = new Set<string>()
	const seenCommands = new Set<string>()

	const recordFile = (p: string): void => {
		const key = p.trim()
		if (key !== "" && !seenFiles.has(key)) {
			seenFiles.add(key)
			filesTouched.push(key)
		}
	}
	const recordCommand = (c: string): void => {
		const key = c.trim()
		if (key !== "" && !seenCommands.has(key)) {
			seenCommands.add(key)
			commandsRun.push(key)
		}
	}

	for (const message of messages) {
		if (message.role === "assistant" && message.tool_calls) {
			for (const call of message.tool_calls) {
				const name = call.function?.name
				let args: Record<string, unknown> = {}
				try {
					args = JSON.parse(call.function?.arguments ?? "") as Record<string, unknown>
				} catch {
					// Malformed args — best effort: skip this call.
				}
				recordToolActivity(name, args, recordFile, recordCommand)
			}
		} else if (message.role === "tool") {
			let args: Record<string, unknown> = {}
			try {
				args = JSON.parse(message.content ?? "") as Record<string, unknown>
			} catch {
				continue // tool results carry no args (real loop shape)
			}
			recordToolActivity(message.name, args, recordFile, recordCommand)
		}
	}
	return { filesTouched, commandsRun }
}

function recordToolActivity(
	name: string | undefined,
	args: Record<string, unknown>,
	recordFile: (p: string) => void,
	recordCommand: (c: string) => void,
): void {
	if (name === "write_to_file" || name === "read_file") {
		if (typeof args["path"] === "string") {
			recordFile(args["path"])
		}
	} else if (name === "execute_command") {
		if (typeof args["command"] === "string") {
			recordCommand(args["command"])
		}
		if (typeof args["cwd"] === "string") {
			recordFile(args["cwd"])
		}
	}
}

/**
 * Compact markdown recap of the last `maxEntries` sessions (most recent
 * first) — the AgentMemory equivalent: a session can carry this forward as
 * context instead of the full raw history.
 *
 * Deterministic ordering: sessions are sorted by `createdAt` desc, then the
 * most recent `maxEntries` are rendered.
 */
export function buildRollingSummary(sessions: SessionSummary[], maxEntries = DEFAULT_ROLLING_MAX_ENTRIES): string {
	const sorted = [...sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
	const recent = sorted.slice(0, maxEntries)

	if (recent.length === 0) {
		return "No prior sessions recorded for this project."
	}

	const lines: string[] = []
	lines.push(`### Rolling session recap (last ${recent.length} session${recent.length === 1 ? "" : "s"})`)
	for (const session of recent) {
		lines.push("")
		lines.push(`**${session.createdAt}** — outcome: ${session.outcome}${session.mode ? ` (mode: ${session.mode})` : ""}`)
		lines.push(`Task: ${session.task}`)
		lines.push(`Summary: ${session.summary}`)
		if (session.filesTouched.length > 0) {
			lines.push(`Files touched: ${session.filesTouched.join(", ")}`)
		}
		if (session.commandsRun.length > 0) {
			lines.push(`Commands run: ${session.commandsRun.join("; ")}`)
		}
		if (session.facts.length > 0) {
			lines.push("Key facts:")
			for (const fact of session.facts) {
				lines.push(`- [${fact.kind}] ${fact.content}`)
			}
		}
	}
	return lines.join("\n")
}
