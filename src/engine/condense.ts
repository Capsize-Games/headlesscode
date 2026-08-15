/**
 * Token-budget-aware context condensation — Phase 3 of the history-
 * management plan (replaces the sliding-window placeholder's information
 * loss; see `truncateHistory`'s doc comment in src/engine/loop.ts, which
 * explicitly called this out as the future token-based pass).
 *
 * ─── What this does ──────────────────────────────────────────────────────────
 *
 * When the LAST request's real prompt-token count (from
 * `LlmResponse.usage.promptTokens` — the same number that drives
 * `BudgetTracker`/`totalInputTokens`) crosses a configurable fraction of the
 * model's real context window, the oldest complete turns are summarized by an
 * LLM into ONE compact synthetic `role: "user"` message, and the recent,
 * uncompressed tail is kept verbatim after it. This is strictly better than
 * `truncateHistory`'s drop-oldest eviction for genuinely long sessions: the
 * stale turns are compressed instead of destroyed, so the model does not
 * silently lose (and later re-derive at full cost) earlier file reads,
 * command outputs, or decisions.
 *
 * ─── Why `role: "user"` for the synthetic message ───────────────────────────
 *
 * The condensed message replaces a chunk of assistant/tool/user turns, so it
 * must be a role the API accepts after a `tool` message and before another
 * assistant turn. `role: "user"` is the only one of the four roles that is
 * always legal there: `system` is only legal as message[0], and `assistant`
 * / `tool` would break the tool-call-group protocol (DeepSeek's official
 * endpoint 400s on orphaned `tool` messages — see truncateHistory's 2026-08-01
 * fix). A `user` message is exactly how other harnesses (including Zoo Code's
 * own rollback/summary paths) inject synthetic context, and it lets the
 * model's next turn respond to the summary as new instructions.
 *
 * ─── Stable prefix / prompt caching (constraint 5) ──────────────────────────
 *
 * The caller (HeadlessSession) REPLACES its working message state with the
 * condensed array, and tracks a `condensedUpTo` marker (2 = nothing condensed
 * yet; 3 = the summary now sits at index 2). Re-condensation is then gated on
 * the UNCONDENSED TAIL having grown past `MIN_CONDENSE_TAIL_GROWTH` messages
 * since the last pass — so the sent prefix ([system, firstUser, summary, ...
 * recent tail]) stays byte-identical across many subsequent calls and only
 * changes at a re-condensation point, exactly like `truncateHistory`'s fixed
 * batch eviction (batch, don't reslice every call).
 *
 * ─── Failure contract (non-fatal, matches the repo idiom) ───────────────────
 *
 * The condensation LLM call is an auxiliary subsystem: if it fails (timeout,
 * provider error, unusable summary), `maybeCondense` resolves to null and the
 * caller falls back to `truncateHistory` for that call. It never fails or
 * blocks the session. The ONE thing that is NOT non-fatal is cost accounting:
 * a successful condensation call's usage is fed into the same BudgetTracker +
 * running totals as the main session (constraint 2 of
 * plans/context-condensation.md), and a BudgetExceededError from that
 * accounting propagates so the session aborts exactly as if a main call had
 * tripped the cap.
 */

import type { ChatMessage, LlmClient, LlmRequest, LlmResponse } from "./types.js"
import type { Logger } from "./logger.js"

/**
 * Default fraction of the model's context window at which condensation
 * triggers. 0.75 (75%) balances two failure modes:
 *   - too LOW (e.g. 0.5): condensation fires on sessions that could have
 *     finished comfortably inside the window, paying an LLM call + latency for
 *     nothing (the whole point of keeping the sliding-window fallback);
 *   - too HIGH (e.g. 0.95): the model's real usable context is smaller than
 *     the advertised number (system prompt + tool schemas + the summary call's
 *     own request + a long reasoning generation all compete for the same
 *     window), so waiting that long risks a provider-side context-overflow
 *     error on the very next request.
 * 0.75 leaves a full quarter of the window as headroom for the next
 * iteration's growth after condensation, which (combined with the
 * batch-once-stable semantics above) keeps the condensed prefix stable across
 * many subsequent calls instead of re-condensing every turn.
 */
export const DEFAULT_CONDENSE_THRESHOLD_FRACTION = 0.75

/**
 * Default fraction of the context window at which the ASYNC early-fire
 * background condensation kicks off (plans/smart-condensation-async.md part
 * 2). Must be BELOW the hard threshold fraction; at 0.6 vs a 0.75 hard
 * threshold it leaves a 15-percentage-point runway for the 55-80s (measured)
 * condensation call to resolve in the background while the main loop keeps
 * making forward progress.
 *
 * PROVISIONAL: part 1's real per-iteration conversation-size data (the
 * lastPromptTokens field added to the `[usage] running total` line) is what
 * this number is supposed to be derived from — the conversation-size point
 * where prompt-cache degradation becomes significant. That data requires a
 * real long session, which is a later round's natural by-product; until it
 * lands, 0.6 is a documented, TUNABLE interim value (--condense-early-fire),
 * not a magic constant imported from anywhere. Re-derive it from fresh data
 * before trusting it.
 */
export const DEFAULT_CONDENSE_EARLY_FIRE_FRACTION = 0.6

/**
 * Conservative default context window (tokens) when the real value cannot be
 * resolved from OpenRouter's models endpoint AND no override is configured.
 * Deliberately conservative (deepseek/deepseek-v4-flash's official endpoint
 * is 1,048,576 per the pricing pin — see src/budget/cost.ts), because the
 * real window is only ever used to decide WHEN to condense; a conservative
 * number triggers condensation earlier than strictly necessary, which is the
 * safe direction. The live value is fetched via OpenRouter's
 * `/api/v1/models/<id>/endpoints` the same way the pricing table was
 * verified (see `fetchModelContextWindow` in src/llm/openrouter.ts).
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000

/**
 * Soft target cap on the condensed summary message, in characters. The model
 * is asked to stay under this; the result is hard-truncated at
 * `MAX_CONDENSED_MESSAGE_CHARS` regardless (a runaway summary must never
 * blow the context budget this feature exists to protect).
 */
export const CONDENSE_TARGET_CHARS = 6_000

/** Hard cap on what the condensation response is ALLOWED to become. */
export const MAX_CONDENSED_MESSAGE_CHARS = 16_000

/**
 * Default cap on the condensation call's OUTPUT tokens. Always sent on the
 * wire (`max_tokens`) so a runaway reasoning generation can't burn unbounded
 * tokens and then get rejected anyway by the `MAX_CONDENSED_MESSAGE_CHARS`
 * post-generation check. 4096 is well above the 6,000-char target summary
 * (`CONDENSE_TARGET_CHARS`) for typical output while bounding the worst case.
 */
export const DEFAULT_CONDENSE_MAX_TOKENS = 4096

/** Cap on the raw oldest-turn chunk fed to the condensation call. */
export const MAX_CONDENSE_INPUT_CHARS = 200_000

/**
 * Minimum number of recent messages a condensation pass must LEAVE
 * uncompressed. The model needs fresh context to continue; a summary alone is
 * not enough. Also bounds how much a single pass can condense, which keeps
 * re-condensation infrequent (the tail must re-grow past this before the next
 * pass).
 */
export const MIN_KEPT_TAIL_MESSAGES = 10

/**
 * A re-condensation is only allowed once the uncompressed tail has grown by
 * this many messages past the previous condensation point (in addition to
 * re-crossing the token threshold). This is the "batch, don't reslice"
 * stability guarantee: between re-condensation points the sent prefix is
 * byte-identical across calls, so provider-side prompt caching can accrue.
 */
export const MIN_CONDENSE_TAIL_GROWTH = 2 * MIN_KEPT_TAIL_MESSAGES

/** System prompt for the condensation LLM call. */
export const CONDENSE_SYSTEM_PROMPT =
	"You are a conversation-compression engine for a software engineering agent. You will be given the " +
	"OLDEST part of an agent session transcript (the model's earlier tool calls + their results + its " +
	"notes). Your job is to compress it into a compact summary the agent can read INSTEAD of the original " +
	"turns. HARD RULES:\n" +
	"1. Preserve what a coding agent needs to continue WITHOUT re-deriving: files read and what was in them " +
	"(paths + key contents verbatim where short), commands run and their outputs/errors (error messages " +
	"VERBATIM), decisions made and why, facts learned, and anything marked IMPORTANT. Losing this forces " +
	"the agent to re-read/re-run at real cost.\n" +
	"2. NEVER invent or add content. If something is a guess, say it is a guess. Do not add conclusions the " +
	"transcript does not support.\n" +
	"3. Omit pure mechanics (e.g. a successful trivial command whose exact output no longer matters) — " +
	"prefer a one-line note over a long quote.\n" +
	"4. Output ONLY the compressed summary. No preamble like 'Here is the summary', no meta-commentary, " +
	"no advice."

/** The synthetic message that stands in for the condensed chunk. */
export function buildCondensedMessage(summary: string): ChatMessage {
	return {
		role: "user",
		content: `[Condensed summary of the earlier part of this session — read this INSTEAD of the turns it replaces; it is a compression, not a quote.]\n\n${summary}`,
	}
}

/**
 * Build the user prompt for the condensation call: the oldest chunk, clearly
 * delimited, with an explicit target size.
 */
export function buildCondenseUserPrompt(chunk: ChatMessage[], targetChars: number): string {
	// Deliberately omit `reasoning` from the transcript: it is disposable (the
	// model already spent its generation on it) and reading it only inflates
	// this call's own input cost. estimateMessageChars still counts it for
	// SIZING — the summarizer just doesn't need to read it.
	const transcript = chunk
		.map((m) => {
			const head =
				m.role === "tool"
					? `[tool result for ${m.name ?? "tool"}]`
					: m.role === "assistant" && m.tool_calls
						? `[assistant tool_calls: ${m.tool_calls.map((c) => c.function?.name ?? "?").join(", ")}]`
						: `[${m.role}]`
			const body =
				typeof m.content === "string" && m.content.trim() !== ""
					? m.content
					: m.tool_calls
						? m.tool_calls
								.map((c) => `${c.function?.name ?? "?"}: ${(c.function?.arguments ?? "").slice(0, 400)}`)
								.join("\n")
						: "(no text)"
			return `${head}\n${body}`
		})
		.join("\n\n")

	return (
		`Compress the OLDEST part of this agent session transcript (${chunk.length} messages). ` +
		`Produce a summary of roughly ${targetChars} characters or fewer — enough that the agent can continue ` +
		`without re-reading or re-running what is summarized. Keep error messages and important file/command ` +
		`details verbatim.\n\n` +
		`=== TRANSCRIPT BEGIN ===\n${transcript}\n=== TRANSCRIPT END ===`
	)
}

/**
 * Choose how many messages to condense from the front of `messages` (from
 * `startIndex` onward — the caller passes 2 for a fresh condensation, which
 * folds the existing summary at index 2 back in on re-condensation).
 *
 * `wantTokens` is the number of tokens the condensed chunk is allowed to have
 * occupied before compression (derived from the context budget);
 * `conservativeCharsPerToken` is a deliberate over-estimate (a condensation
 * that frees TOO LITTLE is harmless — the next iteration simply re-checks;
 * one that frees TOO MUCH would drop the tool-group boundary invariants).
 *
 * The boundary lands on a clean turn boundary: the returned count never
 * splits an assistant `tool_calls` message from its `tool` response messages
 * (the 2026-08-01 DeepSeek HTTP 400 class of bug — see truncateHistory's doc
 * comment). Sharing this helper with `truncateHistory` (via
 * `computeEvictCount`/`skipOrphanedToolMessages`) means both the message-count
 * fallback and the token-aware path enforce the SAME invariant from ONE
 * implementation family.
 */
export function computeCondenseCount(
	messages: ChatMessage[],
	wantTokens: number,
	conservativeCharsPerToken = 8,
	startIndex = 2,
): number {
	if (messages.length < 4) {
		return 0
	}
	const budgetChars = Math.max(1, wantTokens) * conservativeCharsPerToken
	// Never condense the most recent `MIN_KEPT_TAIL_MESSAGES` messages (but
	// allow a tiny history to be condensed down to zero tail — the summary is
	// still strictly better than eviction).
	const keepTail = Math.min(MIN_KEPT_TAIL_MESSAGES, Math.max(0, messages.length - 4))
	const maxCount = Math.max(2, messages.length - startIndex - keepTail)
	let count = 0
	let chars = 0
	for (let i = startIndex; i < messages.length && count < maxCount; i++) {
		const m = messages[i]
		const mChars = estimateMessageChars(m)
		if (count > 0 && chars + mChars > budgetChars) {
			break
		}
		count++
		chars += mChars
		if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
			// Pull the whole tool group (the assistant call + its `tool`
			// responses) into the chunk — never stop mid-group, even if that
			// means the tail ends up a little smaller than keepTail.
			let j = i + 1
			while (j < messages.length && messages[j].role === "tool") {
				count++
				chars += estimateMessageChars(messages[j])
				j++
			}
			i = j - 1
		}
	}
	return count
}

/**
 * Shared token-budget math for BOTH condensation paths: how many tokens the
 * next request should target after condensation (half the hard threshold —
 * enough that we don't re-cross it every single call) and how many oldest
 * messages that corresponds to condensing (tool-call-group-safe, via
 * `computeCondenseCount`). The synchronous path (`maybeCondense`) and the
 * async early-fire path (HeadlessSession.fireBackgroundCondense) derive the
 * SAME boundary from the SAME helper — never two independent implementations
 * of the boundary rule.
 */
export function computeCondensePlan(
	messages: ChatMessage[],
	lastPromptTokens: number,
	contextWindowTokens: number,
	thresholdFraction: number,
): { targetTokens: number; wantTokens: number; count: number } {
	const targetTokens = Math.max(1, Math.floor(contextWindowTokens * thresholdFraction * 0.5))
	const wantTokens = Math.max(1, lastPromptTokens - targetTokens)
	const count = computeCondenseCount(messages, wantTokens)
	return { targetTokens, wantTokens, count }
}

/**
 * Shared tool-call-group-safe count computation for `truncateHistory`'s
 * message-count eviction: how many messages to drop from index 2 onward
 * (returned as a COUNT to drop, so the caller keeps system+firstUser).
 *
 * `evictCount` here means "drop this many of `rest`" — i.e. the kept tail
 * starts at `rest.slice(evictCount)` — matching the existing
 * `truncateHistory` contract exactly. The batch rounding (ceil to the next
 * multiple of `batchSize`) is what keeps the sent prefix stable between
 * eviction points.
 */
export function computeEvictCount(restLength: number, windowSize: number, batchSize: number): number {
	const overflow = restLength - (windowSize - 2)
	let evictCount = Math.ceil(overflow / batchSize) * batchSize
	if (evictCount <= 0) {
		evictCount = 0
	}
	return evictCount
}

/** Skip forward over leading `tool` messages (post-cut tail-start safety). */
export function skipOrphanedToolMessages(messages: ChatMessage[], from: number): number {
	let idx = from
	while (idx < messages.length && messages[idx].role === "tool") {
		idx++
	}
	return idx
}

/** Rough character-length estimate of one message (cheap, monotonic). */
export function estimateMessageChars(m: ChatMessage): number {
	let chars = typeof m.content === "string" ? m.content.length : 0
	// Reasoning is echoed onto outgoing history and costs real prompt tokens —
	// count it or sizing under-estimates reasoning-heavy sessions.
	chars += m.reasoning?.length ?? 0
	if (m.tool_calls) {
		for (const c of m.tool_calls) {
			chars += (c.function?.name?.length ?? 0) + (c.function?.arguments?.length ?? 0) + 8
		}
	}
	return chars + 4
}

/**
 * Run one condensation LLM call against `llmClient` (the session's client —
 * same endpoint/auth, possibly a cheaper model id; see `condenseModel` in
 * loop.ts). Returns the summary text. Throws on ANY failure — the caller
 * (`maybeCondense`) catches and falls back to `truncateHistory`.
 *
 * The returned usage is surfaced via the `onUsage` callback so the session
 * can feed it into the SAME BudgetTracker + running totals as the main
 * session (constraint 2 — condensation must never be invisible spend).
 */
export async function condenseOldestTurns(
	llmClient: LlmClient,
	options: {
		messages: ChatMessage[]
		count: number
		model: string
		maxTokens?: number
		signal?: AbortSignal
		onUsage?: (usage: NonNullable<LlmResponse["usage"]>) => void
	},
): Promise<string> {
	const chunk = options.messages.slice(2, 2 + options.count)
	const request: LlmRequest = {
		model: options.model,
		messages: [
			{ role: "system", content: CONDENSE_SYSTEM_PROMPT },
			{ role: "user", content: buildCondenseUserPrompt(chunk, CONDENSE_TARGET_CHARS) },
		],
		maxTokens: options.maxTokens,
		signal: options.signal,
	}
	const response = await llmClient.createChatCompletion(request)
	if (response.usage) {
		options.onUsage?.(response.usage)
	}
	const text = response.message.content
	if (typeof text !== "string" || text.trim() === "") {
		throw new Error("condensation returned an empty message content")
	}
	const trimmed = text.trim()
	if (trimmed.length > MAX_CONDENSED_MESSAGE_CHARS) {
		throw new Error(
			`condensation produced ${trimmed.length} chars (cap ${MAX_CONDENSED_MESSAGE_CHARS}) — falling back to message-count truncation`,
		)
	}
	return trimmed
}

/**
 * Non-fatal wrapper used by HeadlessSession: decide whether to condense and
 * do it. Returns the REPLACEMENT messages array (the oldest chunk replaced by
 * one synthetic summary at index 2) when condensation ran; null when it did
 * not run (below threshold, prefix still stable, or the call failed and the
 * fallback path should apply).
 *
 * The caller MUST replace its working state with the returned array and keep
 * `condensedUpTo.value` (mutated here) so the next call sees the already-
 * condensed prefix. `condenseInFlight.value` is mutated to true while the LLM
 * call is running and reset to false when it completes/fails — it guarantees
 * only one condensation call is ever in flight.
 */
export async function maybeCondense(options: {
	llmClient: LlmClient
	logger: Pick<Logger, "info" | "warn">
	messages: ChatMessage[]
	model: string
	lastPromptTokens: number
	contextWindowTokens: number
	thresholdFraction: number
	condensedUpTo: { value: number }
	condenseInFlight: { value: boolean }
	condenseModel: string
	condenseMaxTokens?: number
	condenseAbortSignal?: AbortSignal
	onUsage?: (usage: NonNullable<LlmResponse["usage"]>) => void
}): Promise<ChatMessage[] | null> {
	const {
		llmClient,
		logger,
		messages,
		lastPromptTokens,
		contextWindowTokens,
		thresholdFraction,
		condensedUpTo,
		condenseInFlight,
		condenseModel,
		condenseMaxTokens,
		condenseAbortSignal,
		onUsage,
	} = options

	// A failed/stale last request has no usable token count — never condense
	// on guesswork.
	if (!(lastPromptTokens > 0)) {
		return null
	}
	const threshold = Math.max(1, contextWindowTokens * thresholdFraction)
	if (lastPromptTokens < threshold) {
		return null
	}
	// Prefix stability: after a condensation, the summary sits at index 2 and
	// the tail must GROW meaningfully past it before we re-condense (otherwise
	// the sent prefix would be rewritten on every call, defeating provider-
	// side prompt caching — constraint 5). The FIRST condensation is exempt
	// (there is no prefix to preserve yet).
	const alreadyCondensed = condensedUpTo.value > 2
	if (alreadyCondensed && messages.length - condensedUpTo.value < MIN_CONDENSE_TAIL_GROWTH) {
		return null
	}
	if (condenseInFlight.value) {
		return null
	}
	condenseInFlight.value = true
	try {
		// Condense enough that the next request lands comfortably below the
		// threshold (target = half the threshold), so we don't re-cross it
		// every single call. MIN_KEPT_TAIL_MESSAGES in computeCondenseCount
		// keeps the recent tail verbatim regardless. Same shared math as the
		// async early-fire path (computeCondensePlan).
		const { count } = computeCondensePlan(messages, lastPromptTokens, contextWindowTokens, thresholdFraction)
		if (count < 2) {
			return null
		}
		logger.info("[condense] crossing token threshold — summarizing oldest turns", {
			lastPromptTokens,
			contextWindowTokens,
			threshold: Math.round(threshold),
			count,
			condenseModel,
		})
		let summary: string
		try {
			summary = await condenseOldestTurns(llmClient, {
				messages,
				count,
				// condenseModel (NOT model): the whole point of the `_condensation`
				// mode-models key / --condense-model flag is that this call may use
				// a cheaper model than the session's — and recordCondensationUsage
				// already accounts its cost under condenseModel. Routing the call
				// to `model` silently ignored the flag (call + accounting disagreed).
				model: condenseModel,
				maxTokens: condenseMaxTokens,
				signal: condenseAbortSignal,
				onUsage,
			})
		} catch (error) {
			// Non-fatal (matches the repo's auxiliary-subsystem idiom): a
			// failed condensation call falls back to truncateHistory for this
			// call. The ONE exception is a BudgetExceededError thrown by
			// onUsage's accounting (recordCondensationUsage in loop.ts) — that
			// must propagate so the session aborts exactly as if a main call
			// had tripped the cap, never silently under-report spend.
			if (error instanceof Error && error.name === "BudgetExceededError") {
				throw error
			}
			logger.warn("[condense] condensation call failed (non-fatal; falling back to message-count truncation)", {
				error: error instanceof Error ? error.message : String(error),
			})
			return null
		}
		// The summary always lands at index 2 (right after system+firstUser);
		// on re-condensation it FOLDS the previous summary back in, so there
		// is never more than one summary message in the array.
		condensedUpTo.value = 3
		const condensed: ChatMessage[] = [messages[0], messages[1], buildCondensedMessage(summary), ...messages.slice(2 + count)]
		logger.info("[condense] oldest turns condensed into one summary message", {
			condensedCount: count,
			historyBefore: messages.length,
			historyAfter: condensed.length,
		})
		return condensed
	} finally {
		condenseInFlight.value = false
	}
}
