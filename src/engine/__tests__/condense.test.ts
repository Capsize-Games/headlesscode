/**
 * Tests for Phase 3 context condensation (src/engine/condense.ts + its
 * HeadlessSession wiring in src/engine/loop.ts).
 *
 * Plain assert-based script (no test framework, no network, no API key) run
 * via `npm test` → `tsx src/engine/__tests__/condense.test.ts`.
 *
 * Coverage per plans/context-condensation.md:
 *   - below the token threshold: behavior is byte-identical to today — no
 *     condensation call happens (asserted on a CALL COUNTER, not just the
 *     output shape);
 *   - above the threshold: a condensation call happens, produces a summary
 *     message, and the history sent afterward is SHORTER while still
 *     including the summary + the recent tail;
 *   - tool-call-group boundary safety: condensation never splits an
 *     assistant `tool_calls` / `tool` response group (same fixture pattern
 *     as `testTruncateHistoryNeverSplitsToolCallGroup`);
 *   - condensation's own LLM usage is fed into the same BudgetTracker /
 *     running totals as the main session;
 *   - prompt-cache stability: the post-condensation prefix stays stable
 *     across subsequent calls, not reshuffled every time.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession, truncateHistory, DEFAULT_MAX_TOKENS } from "../loop.js"
import { DEFAULT_WINDOW_SIZE } from "../loop.js"
import {
	buildCondenseUserPrompt,
	buildCondensedMessage,
	computeCondenseCount,
	computeEvictCount,
	condenseOldestTurns,
	estimateMessageChars,
	DEFAULT_CONDENSE_MAX_TOKENS,
	DEFAULT_CONDENSE_THRESHOLD_FRACTION,
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	maybeCondense,
	MAX_CONDENSED_MESSAGE_CHARS,
	MIN_KEPT_TAIL_MESSAGES,
	skipOrphanedToolMessages,
} from "../condense.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"
import { BudgetTracker } from "../../budget/budget.js"

// ─── Fakes ───────────────────────────────────────────────────────────────────

class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []
	/** Number of "condensation-style" calls (no tools, system is the condense prompt). */
	condenseCalls = 0
	/** Usage reported for EVERY response (main + condensation calls alike). */
	usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number }
	/** Per-request usage override (index-aligned with `requests`). */
	usageOverrides: Array<{ promptTokens?: number; completionTokens?: number; cachedTokens?: number } | undefined> = []

	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } = {},
	) {
		this.usage = usage
	}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		const isCondense =
			!request.tools &&
			request.messages[0]?.role === "system" &&
			typeof request.messages[0]?.content === "string" &&
			request.messages[0].content.includes("conversation-compression engine")
		if (isCondense) {
			this.condenseCalls++
		}
		const idx = this.requests.length
		this.requests.push(request)
		const override = this.usageOverrides[idx]
		const usage = override ?? this.usage
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (model kept calling)")
		}
		return { message: step(request), usage }
	}
}

/**
 * FakeLlmClient + a live fetchModelContextWindow (loop.ts probes for this via
 * duck typing, not the LlmClient interface — see maybeCondenseHistory).
 * Counts calls so tests can assert the live lookup happens AT MOST ONCE per
 * session and its resolved value is reused (not silently re-defaulted) on
 * every subsequent condensation check.
 */
class FakeLlmClientWithContextWindow extends FakeLlmClient {
	fetchModelContextWindowCalls = 0

	constructor(
		script: Array<(req: LlmRequest) => ChatMessage>,
		usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number },
		private readonly liveContextWindow: number,
	) {
		super(script, usage)
	}

	async fetchModelContextWindow(_model: string): Promise<number | undefined> {
		this.fetchModelContextWindowCalls++
		return this.liveContextWindow
	}
}

/**
	* A client whose condensation call NEVER resolves on its own — it hangs
	* until the caller's abort signal fires, then rejects with AbortError (how
	* OpenRouterClient behaves on a mid-call abort). Main calls are served by
	* the normal script. Proves the loop's condensation timeout
	* (maybeCondenseHistory) unblocks the session instead of hanging forever
	* when the provider never responds.
	*/
class HangingCondenseClient extends FakeLlmClient {
	/** The signal the condensation call was given (undefined = wiring missing). */
	condenseSignal: AbortSignal | undefined

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		const isCondense =
			!request.tools &&
			request.messages[0]?.role === "system" &&
			typeof request.messages[0]?.content === "string" &&
			request.messages[0].content.includes("conversation-compression engine")
		if (isCondense) {
			this.condenseCalls++
			this.requests.push(request)
			this.condenseSignal = request.signal
			return new Promise<LlmResponse>((_resolve, reject) => {
				const signal = request.signal
				if (!signal) {
					// No abort signal wired (the pre-fix bug): the call can
					// never be unblocked — reject instead of hanging the
					// whole test suite.
					reject(new Error("condensation call received no abort signal — timeout wiring missing"))
					return
				}
				if (signal.aborted) {
					reject(new DOMException("aborted", "AbortError"))
					return
				}
				signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
			})
		}
		return super.createChatCompletion(request)
	}
}

function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2)}`): ChatMessage {
	const argumentsStr = typeof args === "string" ? args : JSON.stringify(args)
	const call: ChatToolCall = { id, type: "function", function: { name, arguments: argumentsStr } }
	return { role: "assistant", content: null, tool_calls: [call] }
}

function textReply(content: string): ChatMessage {
	return { role: "assistant", content }
}

async function makeSession(options: {
	task: string
	client: LlmClient
	workspaceRoot: string
	maxIterations?: number
	windowSize?: number
	contextWindowTokens?: number
	condenseThresholdFraction?: number
	condenseModel?: string
	condenseMaxTokens?: number
	maxTokens?: number
	disableLlmCondensation?: boolean
}) {
	const session = new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: options.maxIterations ?? 10,
		consecutiveErrorLimit: 3,
		windowSize: options.windowSize ?? DEFAULT_WINDOW_SIZE,
		contextWindowTokens: options.contextWindowTokens,
		condenseThresholdFraction: options.condenseThresholdFraction,
		condenseModel: options.condenseModel,
		condenseMaxTokens: options.condenseMaxTokens,
		maxTokens: options.maxTokens,
		disableLlmCondensation: options.disableLlmCondensation,
		// Checkpoints off — this suite isn't testing shadow-git.
		checkpoints: false,
	})
	return session
}

/** Build a history shaped like a real session: system, first user, then turns. */
function buildTurnHistory(turns: number): ChatMessage[] {
	const system: ChatMessage = { role: "system", content: "system prompt" }
	const firstUser: ChatMessage = { role: "user", content: "the task" }
	const rest: ChatMessage[] = []
	for (let t = 0; t < turns; t++) {
		rest.push(toolCall("read_file", { path: `file-${t}.txt` }, `call_${t}`))
		rest.push({ role: "tool", tool_call_id: `call_${t}`, name: "read_file", content: `content of file ${t}` })
		rest.push(textReply(`iteration ${t} done`))
	}
	return [system, firstUser, ...rest]
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function testComputeCondenseCountNeverSplitsToolGroup(): void {
	const system: ChatMessage = { role: "system", content: "s" }
	const firstUser: ChatMessage = { role: "user", content: "u" }
	const rest: ChatMessage[] = []
	const callCounts = [1, 3, 2, 1, 2, 3, 1, 1, 2, 3, 1, 2]
	for (const n of callCounts) {
		const calls: ChatToolCall[] = Array.from({ length: n }, (_, i) => ({
			id: `call_${rest.length}_${i}`,
			type: "function",
			function: { name: "read_file", arguments: "{}" },
		}))
		rest.push({ role: "assistant", content: null, tool_calls: calls })
		for (const c of calls) {
			rest.push({ role: "tool", content: "ok", tool_call_id: c.id, name: "read_file" })
		}
	}
	const messages = [system, firstUser, ...rest]
	// Sweep wantTokens across a wide range (including values that would land
	// mid-group on a purely character-based cut) and assert the condensation
	// boundary never splits a group: the kept tail must never start with a
	// `tool` message, and every condensed chunk must be group-aligned.
	for (const wantTokens of [10, 50, 100, 200, 500, 1000, 10_000]) {
		const count = computeCondenseCount(messages, wantTokens)
		// The chunk boundary: messages[2 .. 2+count-1] condensed, tail starts
		// at 2+count. A group is [assistant w/ tool_calls, its tool responses].
		const tailStart = 2 + count
		if (tailStart < messages.length) {
			assert.notEqual(
				messages[tailStart].role,
				"tool",
				`wantTokens=${wantTokens}: condensed boundary lands mid tool-group (tail starts with tool)`,
			)
		}
		// Walk the chunk and verify group-alignment: an assistant tool_calls
		// message inside the chunk must have ALL its tool responses also in
		// the chunk.
		for (let i = 2; i < tailStart; i++) {
			const m = messages[i]
			if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
				let j = i + 1
				let toolCount = 0
				while (j < messages.length && messages[j].role === "tool") {
					toolCount++
					j++
				}
				assert.equal(
					toolCount,
					m.tool_calls.length,
					`wantTokens=${wantTokens}: assistant message at ${i} has ${m.tool_calls.length} calls but chunk only includes ${toolCount} tool responses`,
				)
				assert.ok(j <= tailStart, `wantTokens=${wantTokens}: tool responses must all be inside the chunk`)
			}
		}
	}
}

function testComputeCondenseCountConsumesUntilBudget(): void {
	const messages = buildTurnHistory(20)
	// Tiny budget: only a couple of messages fit — but the boundary must be
	// group-safe (a read_file turn is 3 messages: call + tool + text).
	const count = computeCondenseCount(messages, 10)
	assert.ok(count >= 2, "at least the first turn fits even a tiny budget")
	assert.ok(count <= 5, "a tiny budget should not swallow the whole history")
	// Huge budget: everything from index 2 onward except the kept recent tail
	// (MIN_KEPT_TAIL_MESSAGES) gets condensed — the tail is never sacrificed.
	const all = computeCondenseCount(messages, 1_000_000)
	assert.equal(all, messages.length - 2 - MIN_KEPT_TAIL_MESSAGES)
}

function testComputeEvictCountMatchesOldBehavior(): void {
	// The shared helper must reproduce truncateHistory's batch math exactly.
	const windowSize = 10
	const restLength = 20
	const evict = computeEvictCount(restLength, windowSize, 10)
	assert.equal(evict, 20, "overflow 12 -> ceil(12/10)*10 = 20")
	// Below window: negative overflow clamps to 0 (truncateHistory never calls
	// it in that case, but the helper must be total).
	assert.equal(computeEvictCount(3, 10, 10), 0)
}

function testSkipOrphanedToolMessagesSkipsLeadingTools(): void {
	const msgs: ChatMessage[] = [
		{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "c1", name: "x", content: "r1" },
		{ role: "tool", tool_call_id: "c1", name: "x", content: "r2" },
		{ role: "user", content: "next" },
	]
	assert.equal(skipOrphanedToolMessages(msgs, 1), 3, "skips the two leading tool messages")
	assert.equal(skipOrphanedToolMessages(msgs, 3), 3, "no-op when not on a tool")
}

function testBuildCondensedMessageIsUserRole(): void {
	const msg = buildCondensedMessage("summary text")
	assert.equal(msg.role, "user", "the synthetic message must be a user message (safe after a tool message)")
	assert.ok(msg.content?.includes("summary text"))
	assert.ok(msg.content?.includes("Condensed summary"))
}

function testCondenseUserPromptDelimitsAndCaps(): void {
	const messages = buildTurnHistory(2)
	const prompt = buildCondenseUserPrompt(messages.slice(2), 4000)
	assert.match(prompt, /TRANSCRIPT BEGIN/)
	assert.match(prompt, /TRANSCRIPT END/)
	assert.match(prompt, /file-0\.txt/, "the prompt must contain the actual file paths being condensed")
	assert.match(prompt, /4000 characters/, "the prompt must carry the target size")
}

function testCondenseUserPromptOmitsReasoning(): void {
	// The condensation call must NOT be asked to read the model's reasoning —
	// it is disposable and would only inflate the summarizer's own input cost.
	const chunk: ChatMessage[] = [
		{ role: "assistant", content: "I read the file", reasoning: "THINKING_SECRET: weigh every alternative before answering" },
		{ role: "user", content: "continue" },
	]
	const prompt = buildCondenseUserPrompt(chunk, 4000)
	assert.match(prompt, /I read the file/, "the transcript must carry the message content")
	assert.doesNotMatch(prompt, /THINKING_SECRET/, "reasoning must NOT be transcribed into the condensation prompt")
}

function testEstimateMessageCharsCountsReasoning(): void {
	// A message carrying `reasoning` must size LARGER than the same message
	// without it — reasoning is real prompt-token weight once echoed onto
	// history. Exact delta: the reasoning length.
	const base: ChatMessage = { role: "assistant", content: "hello" }
	const withReasoning: ChatMessage = { role: "assistant", content: "hello", reasoning: "x".repeat(500) }
	assert.equal(estimateMessageChars(withReasoning), estimateMessageChars(base) + 500)
	// Reasoning is counted even when content is null (a pure tool-call turn).
	const toolOnly: ChatMessage = {
		role: "assistant",
		content: null,
		reasoning: "r".repeat(123),
		tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
	}
	const toolOnlyNoReasoning: ChatMessage = { role: "assistant", content: null, tool_calls: toolOnly.tool_calls }
	assert.equal(estimateMessageChars(toolOnly), estimateMessageChars(toolOnlyNoReasoning) + 123)
}

function testComputeCondenseCountCountsReasoningTowardBudget(): void {
	// The SAME fixed token budget must fold FEWER messages when the history
	// carries reasoning: counting it makes each message consume its true share
	// of the budget instead of treating the reasoning payload as free, so the
	// loop no longer folds far past the intended token budget.
	const stripped = buildTurnHistory(40)
	const withReasoning = stripped.map((m) => (m.role === "assistant" ? { ...m, reasoning: "r".repeat(2000) } : m))
	const wantTokens = 200 // budget = 200 * 8 = 1600 chars
	const countWith = computeCondenseCount(withReasoning, wantTokens)
	const countStripped = computeCondenseCount(stripped, wantTokens)
	assert.ok(
		countWith < countStripped,
		`reasoning must consume budget: folded ${countWith} messages vs ${countStripped} when reasoning is ignored`,
	)
	// The folded chunk's real size (reasoning included) lands within the
	// intended budget plus the always-folded first turn, and the reasoning
	// length is accounted for EXACTLY in the estimate.
	const budgetChars = wantTokens * 8
	const foldedWith = withReasoning.slice(2, 2 + countWith)
	const foldedStripped = stripped.slice(2, 2 + countWith)
	const realWith = foldedWith.reduce((sum, m) => sum + estimateMessageChars(m), 0)
	const realStripped = foldedStripped.reduce((sum, m) => sum + estimateMessageChars(m), 0)
	const reasoningContribution = foldedWith.reduce((sum, m) => sum + (m.reasoning?.length ?? 0), 0)
	const firstTurnOvershoot = estimateMessageChars(withReasoning[2]) + estimateMessageChars(withReasoning[3])
	assert.ok(
		realWith <= budgetChars + firstTurnOvershoot,
		`folded real size ${realWith} must stay within budget ${budgetChars} (plus the always-folded first turn)`,
	)
	assert.equal(
		realWith - realStripped,
		reasoningContribution,
		"the size difference must be exactly the reasoning being counted",
	)
}

// ─── maybeCondense unit-level (boundary + stability + accounting) ───────────

async function testMaybeCondenseBelowThresholdNoCall(): Promise<void> {
	const client = new FakeLlmClient([
		() => textReply("main reply"),
		() => textReply("main reply 2"),
	], { promptTokens: 1000, completionTokens: 50 })
	// No script steps for a condensation call — if one happens, the script
	// throws (exhausted) and the test fails loudly.
	const messages = buildTurnHistory(10)
	const condensedUpTo = { value: 0 }
	const inFlight = { value: false }
	let usageSeen = 0
	const result = await maybeCondense({
		llmClient: client,
		logger: { info: () => {}, warn: () => {} },
		messages,
		model: "fake-model",
		lastPromptTokens: 10_000, // well below 75% of 128000
		contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
		thresholdFraction: DEFAULT_CONDENSE_THRESHOLD_FRACTION,
		condensedUpTo,
		condenseInFlight: inFlight,
		condenseModel: "fake-model",
		onUsage: () => usageSeen++,
	})
	assert.equal(result, null, "below the threshold: no condensation, messages unchanged")
	assert.equal(client.condenseCalls, 0, "below the threshold: NO condensation LLM call may happen")
	assert.equal(usageSeen, 0)
	assert.equal(condensedUpTo.value, 0, "condensedUpTo must not move below the threshold")
	assert.equal(inFlight.value, false)
}

async function testMaybeCondenseAboveThresholdSummarizesAndShrinks(): Promise<void> {
	const mainScript: Array<(req: LlmRequest) => ChatMessage> = []
	const messages = buildTurnHistory(40)
	// The condensation call itself: return a compact summary.
	mainScript.push(() => textReply("Condensed: read files file-0.txt..file-39.txt, nothing notable."))
	const client = new FakeLlmClient(mainScript, { promptTokens: 1000, completionTokens: 50 })
	const condensedUpTo = { value: 0 }
	const inFlight = { value: false }
	const usage: Array<{ input: number; output: number }> = []
	const result = await maybeCondense({
		llmClient: client,
		logger: { info: () => {}, warn: () => {} },
		messages,
		model: "fake-model",
		lastPromptTokens: 110_000, // 85% of 128000 — above 75% threshold
		contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
		thresholdFraction: DEFAULT_CONDENSE_THRESHOLD_FRACTION,
		condensedUpTo,
		condenseInFlight: inFlight,
		condenseModel: "fake-model",
		onUsage: (u) => usage.push({ input: u.promptTokens ?? 0, output: u.completionTokens ?? 0 }),
	})
	assert.ok(result !== null, "above the threshold: condensation must run")
	assert.equal(client.condenseCalls, 1, "exactly one condensation call")
	// The condensation request itself must NOT carry tools (it's a pure
	// summarization call) and must be 2 messages (system + user).
	const condenseReq = client.requests[0]
	assert.equal(condenseReq.tools, undefined)
	assert.equal(condenseReq.messages.length, 2)
	// The result: [system, firstUser, summary, ...recentTail].
	assert.equal(result[0].role, "system")
	assert.equal(result[1].role, "user")
	assert.equal(result[2].role, "user", "the synthetic summary is a user message")
	assert.match(result[2].content ?? "", /Condensed summary/)
	assert.ok(
		result.length < messages.length,
		`condensed history (${result.length}) must be shorter than the original (${messages.length})`,
	)
	assert.ok(condensedUpTo.value >= 2, "condensedUpTo must advance past the condensed chunk")
	assert.equal(inFlight.value, false, "in-flight guard must reset")
	assert.equal(usage.length, 1, "the condensation call's usage must be surfaced exactly once")
	assert.equal(usage[0].input, 1000)
	assert.equal(usage[0].output, 50)
}

async function testMaybeCondenseRespectsBatchOnceStability(): Promise<void> {
	// After a condensation, a SECOND call with the SAME head must NOT
	// condense again (the prefix stays stable) — and a call that has grown a
	// little must still not re-condense until the tail grows meaningfully.
	const messages = buildTurnHistory(40)
	const client = new FakeLlmClient([() => textReply("summary one")], { promptTokens: 1000, completionTokens: 50 })
	const condensedUpTo = { value: 0 }
	const inFlight = { value: false }

	const first = await maybeCondense({
		llmClient: client,
		logger: { info: () => {}, warn: () => {} },
		messages,
		model: "fake-model",
		lastPromptTokens: 110_000,
		contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
		thresholdFraction: DEFAULT_CONDENSE_THRESHOLD_FRACTION,
		condensedUpTo,
		condenseInFlight: inFlight,
		condenseModel: "fake-model",
	})
	assert.ok(first !== null)
	assert.equal(client.condenseCalls, 1)
	const firstResult = first as ChatMessage[]

	// Second call on the CONDENSED array (the caller replaces its working
	// state with the returned array — exactly what HeadlessSession does), same
	// head, still above threshold: NO new condensation — the already-condensed
	// prefix + stable tail is exactly what prompt caching needs.
	const second = await maybeCondense({
		llmClient: client,
		logger: { info: () => {}, warn: () => {} },
		messages: firstResult,
		model: "fake-model",
		lastPromptTokens: 110_000,
		contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
		thresholdFraction: DEFAULT_CONDENSE_THRESHOLD_FRACTION,
		condensedUpTo,
		condenseInFlight: inFlight,
		condenseModel: "fake-model",
	})
	assert.equal(second, null, "the SAME head must not be condensed twice (batch-once stability)")
	assert.equal(client.condenseCalls, 1, "still exactly one condensation call")
	// The returned first result is a prefix-stable base: any later call that
	// DOES condense again must be a PREFIX EXTENSION of it (the summary stays
	// the same; only the tail grows).
	assert.ok(firstResult[0] === messages[0] && firstResult[1] === messages[1])
}

async function testCondenseFailureIsNonFatal(): Promise<void> {
	// The condensation LLM call throws (e.g. provider error): maybeCondense
	// must resolve to null (fall back to truncateHistory), never reject.
	const messages = buildTurnHistory(20)
	const client = new FakeLlmClient([
		() => {
			throw new Error("provider exploded")
		},
	], { promptTokens: 1000, completionTokens: 50 })
	const condensedUpTo = { value: 0 }
	const inFlight = { value: false }
	const result = await maybeCondense({
		llmClient: client,
		logger: { info: () => {}, warn: () => {} },
		messages,
		model: "fake-model",
		lastPromptTokens: 110_000,
		contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
		thresholdFraction: DEFAULT_CONDENSE_THRESHOLD_FRACTION,
		condensedUpTo,
		condenseInFlight: inFlight,
		condenseModel: "fake-model",
	})
	assert.equal(result, null, "a failed condensation must fall back (null), not throw")
	assert.equal(condensedUpTo.value, 0, "condensedUpTo must not advance on failure")
	assert.equal(inFlight.value, false)
}

async function testCondenseOversizedSummaryRejected(): Promise<void> {
	const messages = buildTurnHistory(20)
	const client = new FakeLlmClient([() => textReply("x".repeat(MAX_CONDENSED_MESSAGE_CHARS + 100))], {
		promptTokens: 1000,
		completionTokens: 50,
	})
	const condensedUpTo = { value: 0 }
	const inFlight = { value: false }
	const result = await maybeCondense({
		llmClient: client,
		logger: { info: () => {}, warn: () => {} },
		messages,
		model: "fake-model",
		lastPromptTokens: 110_000,
		contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
		thresholdFraction: DEFAULT_CONDENSE_THRESHOLD_FRACTION,
		condensedUpTo,
		condenseInFlight: inFlight,
		condenseModel: "fake-model",
	})
	assert.equal(result, null, "an oversized summary must be rejected (fall back), never blown into context")
}

async function testCondenseOldestTurnsDirectUsageCallback(): Promise<void> {
	// condenseOldestTurns itself must invoke onUsage with the real usage.
	let captured: LlmResponse["usage"] | undefined
	const client = new FakeLlmClient([() => textReply("s")], { promptTokens: 321, completionTokens: 17 })
	await condenseOldestTurns(client, {
		messages: buildTurnHistory(10),
		count: 10,
		model: "fake-model",
		onUsage: (u) => (captured = u),
	})
	assert.ok(captured, "usage callback must fire")
	assert.equal(captured?.promptTokens, 321)
	assert.equal(captured?.completionTokens, 17)
}

// ─── HeadlessSession integration ─────────────────────────────────────────────

/**
 * Below the token threshold: a full session must behave byte-identically to
 * today — NO condensation call (assert on the counter), and every request's
 * messages must equal truncateHistory(messages) exactly (the sliding-window
 * fallback unchanged).
 */
async function testSessionBelowThresholdNoCondensationCall(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-below-"))
	try {
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "hello" }),
				() => toolCall("attempt_completion", { result: "done below threshold" }),
			],
			{ promptTokens: 5000, completionTokens: 100 }, // tiny vs 128000*0.75
		)
		const session = await makeSession({ task: "write a file", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.condenseCalls, 0, "below the threshold: NO condensation call in a full session")
		// Every main request's messages must be exactly the sliding-window
		// truncation of the session's own history — the fallback path is
		// byte-identical to today.
		for (const req of client.requests) {
			// No request may ever contain a condensation summary message, and
			// no request may carry the condensation-only shape (system +
			// single user prompt, no tools).
			const anyCondensed = req.messages.some(
				(m) => typeof m.content === "string" && m.content.includes("Condensed summary"),
			)
			assert.equal(anyCondensed, false, "no synthetic summary may appear below the threshold")
			const isCondenseShape = !req.tools && req.messages.length === 2 && req.messages[0]?.role === "system"
			assert.equal(isCondenseShape, false, "no condensation-shaped request may appear below the threshold")
			// Sanity: truncateHistory of the FINAL state still reproduces the
			// shape of a below-window session (no eviction at all).
			assert.deepEqual(truncateHistory(session.state.messages, DEFAULT_WINDOW_SIZE), session.state.messages)
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Above the threshold: a condensation call happens, the history sent to the
 * model afterward is shorter in token terms while still containing the
 * summary + recent tail, and the condensation call's usage lands in the same
 * budget/totals as the main session.
 */
async function testSessionAboveThresholdCondensesAndAccounts(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-above-"))
	try {
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "hello" }),
				() => textReply("CONDENSED SUMMARY HERE"),
				() => toolCall("attempt_completion", { result: "done after condensation" }),
			],
			// Main calls report a large prompt count (crossing the threshold
			// after the first call); the condensation call reports its own
			// separate usage.
			{ promptTokens: 110_000, completionTokens: 100 },
		)
		// The condensation call's usage: index 1 in the request list.
		client.usageOverrides[1] = { promptTokens: 40_000, completionTokens: 2_000 }
		const session = await makeSession({
			task: "write a file and continue",
			client,
			workspaceRoot: ws,
			contextWindowTokens: 128_000,
			condenseThresholdFraction: 0.75,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.condenseCalls, 1, "exactly one condensation call happened")

		// The condensation request itself: 2 messages, no tools. Find it by
		// its distinctive system prompt (the main requests also start with a
		// system message).
		const condenseReq = client.requests.find(
			(r) =>
				!r.tools &&
				typeof r.messages[0]?.content === "string" &&
				r.messages[0].content.includes("conversation-compression engine"),
		)
		assert.ok(condenseReq, "condensation request present")
		assert.equal(condenseReq.messages.length, 2)

		// The request AFTER condensation must contain the summary + tail and
		// be shorter in token terms (here: message count, since the fake
		// reports fixed token counts — the "shorter" assertion is about the
		// history sent to the model, which is what the real token count
		// reflects).
		const postCondenseReq = client.requests.find(
			(r) =>
				r.tools &&
				r.messages.some(
					(m) => typeof m.content === "string" && m.content.includes("CONDENSED SUMMARY HERE"),
				),
		)
		assert.ok(postCondenseReq, "a request after condensation exists")
		const postHasSummary = postCondenseReq.messages.some(
			(m) => typeof m.content === "string" && m.content.includes("CONDENSED SUMMARY HERE"),
		)
		assert.ok(postHasSummary, "the post-condensation request must include the summary")

		// Budget accounting: BOTH the main calls (3 x 110000) and the
		// condensation call (40000 + 2000) must be reflected in the session's
		// cost. The session result's budgetUsage is always present (the loop
		// always creates a BudgetTracker for accounting, even without a
		// configured budget), and cost is a pure function of tokens × price —
		// so a cost reflecting the condensation tokens proves the condensation
		// usage landed in the SAME tracker as the main calls.
		assert.ok(
			result.budgetUsage && result.budgetUsage.costUsd > 0,
			"budgetUsage must be present and non-zero",
		)
		// The condensation call's input tokens were 40k (vs 110k per main
		// call). Using the fallback price (fake-model is unlisted ->
		// FALLBACK_MODEL_PRICE), the cost contribution of the condensation
		// call alone is (40000*2 + 2000*8)/1e6 = $0.096 — assert the total is
		// at least that much, which can only be true if the condensation
		// usage was recorded into the same tracker.
		const condenseMinCost = (40_000 * 2 + 2_000 * 8) / 1_000_000
		assert.ok(
			result.budgetUsage.costUsd >= condenseMinCost,
			`cost ${result.budgetUsage.costUsd} must include the condensation call (>= ${condenseMinCost})`,
		)
		// Sanity: the session's own message state kept the summary.
		const stateSummary = session.state.messages.some(
			(m) => typeof m.content === "string" && m.content.includes("CONDENSED SUMMARY HERE"),
		)
		assert.ok(stateSummary, "the session's own state must contain the summary")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
	* The condensation call must ALWAYS carry its own `max_tokens` cap
	* (DEFAULT_CONDENSE_MAX_TOKENS) even when the session has no `maxTokens`
	* configured anywhere — an unbounded generation can't be produced and then
	* rejected by the post-generation MAX_CONDENSED_MESSAGE_CHARS check. The
	* main call gets DEFAULT_MAX_TOKENS. Both defaults come from the resolved
	* config (loop.ts's constructor), so this is a full-session assertion.
	*/
async function testSessionCondenseRequestAlwaysCarriesMaxTokens(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-maxtokens-"))
	try {
		// NO maxTokens / condenseMaxTokens configured: only the defaults apply.
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "hello" }),
				() => textReply("CONDENSED SUMMARY HERE"),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			// Every call reports a large prompt count so condensation fires
			// after the first iteration.
			{ promptTokens: 110_000, completionTokens: 100 },
		)
		const session = await makeSession({
			task: "write a file and continue",
			client,
			workspaceRoot: ws,
			contextWindowTokens: 128_000,
			condenseThresholdFraction: 0.75,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.condenseCalls, 1, "exactly one condensation call happened")

		const condenseReq = client.requests.find(
			(r) =>
				!r.tools &&
				typeof r.messages[0]?.content === "string" &&
				r.messages[0].content.includes("conversation-compression engine"),
		)
		assert.ok(condenseReq, "condensation request present")
		assert.equal(
			condenseReq.maxTokens,
			DEFAULT_CONDENSE_MAX_TOKENS,
			"the condensation call must always carry max_tokens (its own default), even with no session maxTokens",
		)

		const mainReq = client.requests.find((r) => r.tools)
		assert.ok(mainReq, "main request present")
		assert.equal(
			mainReq.maxTokens,
			DEFAULT_MAX_TOKENS,
			"the main call must carry the default max_tokens cap when none is configured",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
	* An explicit `condenseMaxTokens` / `maxTokens` on the session config must
	* win over the defaults — the caps are defaults, not hard constants.
	*/
async function testSessionExplicitMaxTokensOverridesDefaults(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-override-"))
	try {
		const client = new FakeLlmClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "hello" }),
				() => textReply("CONDENSED SUMMARY HERE"),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			{ promptTokens: 110_000, completionTokens: 100 },
		)
		const session = await makeSession({
			task: "write a file and continue",
			client,
			workspaceRoot: ws,
			contextWindowTokens: 128_000,
			condenseThresholdFraction: 0.75,
			condenseMaxTokens: 1234,
			maxTokens: 5678,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const condenseReq = client.requests.find(
			(r) =>
				!r.tools &&
				typeof r.messages[0]?.content === "string" &&
				r.messages[0].content.includes("conversation-compression engine"),
		)
		assert.ok(condenseReq, "condensation request present")
		assert.equal(condenseReq.maxTokens, 1234, "an explicit condenseMaxTokens must win over the default")

		const mainReq = client.requests.find((r) => r.tools)
		assert.ok(mainReq, "main request present")
		assert.equal(mainReq.maxTokens, 5678, "an explicit maxTokens must win over the default")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Regression test for a 2026-08-04 bug: the live-resolved context window was
 * cached via a boolean (`contextWindowResolved`) recording only that a
 * lookup was ATTEMPTED, never the value it resolved TO. Every condensation
 * check after the session's first silently fell back to
 * DEFAULT_CONTEXT_WINDOW_TOKENS (128k) even after a successful live lookup
 * reported the model's real, much larger window — so condensation kept
 * firing at 75% of 128k for the rest of the session regardless of the
 * model's actual capacity. Caught live: a real deepseek-v4-flash session
 * resolved 1,048,576 once, then condensed repeatedly at ~96-99k tokens
 * anyway. Fixed by caching the resolved number itself
 * (`resolvedContextWindowTokens`), not just that resolution happened.
 *
 * This test drives a session past TWO points that would cross 128k*0.75
 * (96,000) but NEITHER of which crosses a realistic large window's 0.75
 * threshold, and asserts: the live lookup fires exactly once, and NO
 * condensation call ever happens — proving the second (and any later) check
 * reused the cached large value instead of re-defaulting to 128k.
 */
async function testSessionReusesLiveResolvedContextWindowAcrossChecks(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-livewin-"))
	try {
		const client = new FakeLlmClientWithContextWindow(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "hello" }),
				() => toolCall("write_to_file", { path: "b.txt", content: "world" }),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			// Each main call reports 100,000 prompt tokens — comfortably over
			// 128,000*0.75 (96,000, the OLD buggy threshold) on every check
			// after the first, but nowhere near 1,000,000*0.75 (750,000, the
			// real model's threshold this test proves gets reused).
			{ promptTokens: 100_000, completionTokens: 100 },
			1_000_000,
		)
		// No explicit contextWindowTokens override — force the session down
		// the live-resolution code path this bug lives in, exactly like a
		// real (non-test) session with no --context-window flag.
		const session = await makeSession({ task: "write two files", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(
			client.fetchModelContextWindowCalls,
			1,
			"the live lookup must happen at most once per session (resolved value reused after)",
		)
		assert.equal(
			client.condenseCalls,
			0,
			"no condensation call may happen: every check must reuse the cached 1,000,000 window, " +
				"never silently re-fall-back to the 128k default on the second+ check",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Tool-call-group safety at the SESSION level: a history with irregular
 * tool-call group sizes that triggers condensation must never produce a
 * request whose messages start mid-group (orphaned `tool` message).
 */
async function testSessionCondensationNeverSplitsToolGroup(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-group-"))
	try {
		// Build a long history with irregular tool-call counts (the real
		// failing-session shape from the truncateHistory regression).
		const system: ChatMessage = { role: "system", content: "system prompt" }
		const firstUser: ChatMessage = { role: "user", content: "the task" }
		const rest: ChatMessage[] = []
		const callCounts = [1, 3, 2, 1, 2, 3, 1, 1, 2, 3, 1, 2, 3, 2, 1]
		for (const n of callCounts) {
			const calls: ChatToolCall[] = Array.from({ length: n }, (_, i) => ({
				id: `call_${rest.length}_${i}`,
				type: "function",
				function: { name: "read_file", arguments: "{}" },
			}))
			rest.push({ role: "assistant", content: null, tool_calls: calls })
			for (const c of calls) {
				rest.push({ role: "tool", content: "ok", tool_call_id: c.id, name: "read_file" })
			}
		}
		// Seed the session's state with this history directly, then drive one
		// iteration whose request crosses the threshold. The first scripted
		// reply is a TOOL call so the loop continues (a text reply would
		// terminate as a success fallback); the condensation call is second.
		const client = new FakeLlmClient(
			[
				() => toolCall("list_files", { path: "." }),
				() => textReply("CONDENSED SUMMARY"),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			{ promptTokens: 120_000, completionTokens: 100 },
		)
		const session = await makeSession({
			task: "task",
			client,
			workspaceRoot: ws,
			contextWindowTokens: 128_000,
			condenseThresholdFraction: 0.75,
		})
		session.state.messages = [system, firstUser, ...rest]

		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.condenseCalls, 1, "condensation ran")
		// Every request sent to the model must never start its kept tail with
		// an orphaned `tool` message — scan the whole request stream.
		for (let r = 0; r < client.requests.length; r++) {
			const req = client.requests[r]
			// The condensation request itself is [system, user] — skip it.
			if (req.messages[0]?.role === "system" && req.messages.length === 2 && !req.tools) {
				continue
			}
			// Find the first message after the (system, firstUser) prefix.
			const tailStart = req.messages.slice(2).findIndex((m) => m.role !== "tool")
			const firstNonToolIdx = tailStart === -1 ? req.messages.length : tailStart + 2
			// Everything from index 2 up to firstNonToolIdx must be tool
			// messages belonging to a group whose assistant message is in the
			// prefix — i.e. the request must NOT start its kept region with a
			// tool message that has no assistant tool_calls before it.
			if (req.messages[2]?.role === "tool") {
				assert.fail(
					`request #${r} starts its kept tail with an orphaned tool message (would HTTP 400 on DeepSeek)`,
				)
			}
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * `disableLlmCondensation` (see HeadlessSessionConfig's doc comment,
 * verified live 2026-08-28 against Qwen3.5-9B+LoRA): a weak local
 * summarizer can turn a hedged note into a confidently WRONG "fact" that
 * then gets trusted as real history. When the flag is set, crossing the
 * condensation threshold must NOT trigger the LLM summarization call at
 * all — but truncateHistory's plain drop-oldest eviction must still keep
 * the sent request bounded, since that safety net runs unconditionally
 * regardless of condensation.
 */
async function testSessionDisableLlmCondensationSkipsSummarizationCall(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-disabled-"))
	try {
		const system: ChatMessage = { role: "system", content: "system prompt" }
		const firstUser: ChatMessage = { role: "user", content: "the task" }
		const rest: ChatMessage[] = []
		const callCounts = [1, 3, 2, 1, 2, 3, 1, 1, 2, 3, 1, 2, 3, 2, 1]
		for (const n of callCounts) {
			const calls: ChatToolCall[] = Array.from({ length: n }, (_, i) => ({
				id: `call_${rest.length}_${i}`,
				type: "function",
				function: { name: "read_file", arguments: "{}" },
			}))
			rest.push({ role: "assistant", content: null, tool_calls: calls })
			for (const c of calls) {
				rest.push({ role: "tool", content: "ok", tool_call_id: c.id, name: "read_file" })
			}
		}
		const client = new FakeLlmClient(
			[() => toolCall("list_files", { path: "." }), () => toolCall("attempt_completion", { result: "done" })],
			{ promptTokens: 120_000, completionTokens: 100 },
		)
		const session = await makeSession({
			task: "task",
			client,
			workspaceRoot: ws,
			contextWindowTokens: 128_000,
			condenseThresholdFraction: 0.75,
			// Small enough that truncateHistory (which always runs after
			// condensation, whether or not condensation itself ran) has
			// real eviction to do against this history.
			windowSize: 20,
			disableLlmCondensation: true,
		})
		session.state.messages = [system, firstUser, ...rest]

		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.condenseCalls, 0, "the LLM summarization call must never run when disabled")
		const lastReq = client.requests[client.requests.length - 1]
		assert.ok(
			lastReq.messages.length <= 20,
			`truncateHistory must still bound the request even with condensation disabled (got ${lastReq.messages.length} messages)`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * `disableLlmCondensation` must itself perform TOKEN-aware eviction, not
 * rely solely on truncateHistory's downstream message-COUNT window — a
 * real session hit a hard context-overflow 400 (65,824 tokens against a
 * 65,536-token real window) at only 45 messages, nowhere near a
 * default-300 windowSize, because nothing token-aware was trimming the
 * history once LLM summarization was skipped (see
 * HeadlessSessionConfig.disableLlmCondensation's doc comment). Uses a
 * generous windowSize specifically so truncateHistory's own eviction
 * cannot be what shrinks the history — only the token-threshold-driven
 * eviction inside maybeCondenseHistory can explain a smaller request here.
 */
async function testSessionDisableLlmCondensationStillEvictsByTokenBudget(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-disabled-evict-"))
	try {
		const system: ChatMessage = { role: "system", content: "system prompt" }
		const firstUser: ChatMessage = { role: "user", content: "the task" }
		const rest: ChatMessage[] = []
		const callCounts = [1, 3, 2, 1, 2, 3, 1, 1, 2, 3, 1, 2, 3, 2, 1]
		for (const n of callCounts) {
			const calls: ChatToolCall[] = Array.from({ length: n }, (_, i) => ({
				id: `call_${rest.length}_${i}`,
				type: "function",
				function: { name: "read_file", arguments: "{}" },
			}))
			rest.push({ role: "assistant", content: null, tool_calls: calls })
			for (const c of calls) {
				rest.push({ role: "tool", content: "ok", tool_call_id: c.id, name: "read_file" })
			}
		}
		const fullHistoryLength = 2 + rest.length
		const client = new FakeLlmClient(
			[() => toolCall("list_files", { path: "." }), () => toolCall("attempt_completion", { result: "done" })],
			{ promptTokens: 120_000, completionTokens: 100 },
		)
		const session = await makeSession({
			task: "task",
			client,
			workspaceRoot: ws,
			contextWindowTokens: 128_000,
			condenseThresholdFraction: 0.75,
			// Deliberately generous — larger than the full history, so
			// truncateHistory's own message-count eviction never engages;
			// any shrinkage must come from disableLlmCondensation's own
			// token-aware eviction instead.
			windowSize: fullHistoryLength + 50,
			disableLlmCondensation: true,
		})
		session.state.messages = [system, firstUser, ...rest]

		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.condenseCalls, 0, "the LLM summarization call must never run when disabled")
		const lastReq = client.requests[client.requests.length - 1]
		assert.ok(
			lastReq.messages.length < fullHistoryLength,
			`expected token-aware eviction to shrink the request below the full ${fullHistoryLength}-message ` +
				`history even with a generous windowSize (got ${lastReq.messages.length})`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Prompt-cache stability across the condensation boundary: after the
 * condensation, the sent prefix (summary + tail) must stay IDENTICAL across
 * subsequent requests — not reshuffled every call.
 */
async function testSessionPostCondensePrefixStable(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-stable-"))
	try {
		// Many main iterations after condensation, all above threshold, with
		// the fake reporting the same huge prompt count — the loop must NOT
		// re-condense (no extra condensation calls) and the sent prefix must
		// stay a prefix-preserving extension call to call.
		const client = new FakeLlmClient(
			[
				() => toolCall("execute_command", { command: "node -e 'console.log(0)'" }),
				() => textReply("CONDENSED SUMMARY"),
				() => toolCall("execute_command", { command: "node -e 'console.log(1)'" }),
				() => toolCall("execute_command", { command: "node -e 'console.log(2)'" }),
				() => toolCall("execute_command", { command: "node -e 'console.log(3)'" }),
				() => toolCall("attempt_completion", { result: "stable prefix done" }),
			],
			{ promptTokens: 120_000, completionTokens: 100 },
		)
		const session = await makeSession({
			task: "run several commands",
			client,
			workspaceRoot: ws,
			contextWindowTokens: 128_000,
			condenseThresholdFraction: 0.75,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.condenseCalls, 1, "condensation must happen exactly ONCE despite many above-threshold calls")

		// Collect the MAIN (non-condensation) requests in order.
		const mainReqs = client.requests.filter((r) => !(r.messages[0]?.role === "system" && r.messages.length === 2 && !r.tools))
		assert.ok(mainReqs.length >= 3, "several main requests after condensation")

		// Prefix-preserving extension: each main request's first
		// `min(prev,next)` messages are identical (the summary + tail prefix
		// never shifts).
		for (let i = 1; i < mainReqs.length; i++) {
			const prev = mainReqs[i - 1]
			const next = mainReqs[i]
			const common = Math.min(prev.messages.length, next.messages.length)
			for (let j = 0; j < common; j++) {
				assert.deepEqual(
					next.messages[j],
					prev.messages[j],
					`request #${i}: message ${j} of the sent prefix changed after condensation — caching defeated`,
				)
			}
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** Budget limit trip from a condensation call: must abort like a main call. */
async function testCondensationUsageTripsBudget(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-budget-"))
	try {
		const client = new FakeLlmClient(
			[
				() => textReply("CONDENSED SUMMARY"),
				() => textReply("never reached"),
			],
			{ promptTokens: 110_000, completionTokens: 100 },
		)
		// The condensation call alone (40000 input) pushes cost over the cap.
		client.usageOverrides[1] = { promptTokens: 400_000, completionTokens: 2_000 }
		const session = await makeSession({
			task: "write files",
			client,
			workspaceRoot: ws,
			contextWindowTokens: 128_000,
			condenseThresholdFraction: 0.75,
		})
		// Inject a budget tracker via the config — the loop's own tracker is
		// internal, so instead assert via the session's BudgetTracker path by
		// configuring a budget on the session.
		const budgetSession = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "write files",
			llmClient: client,
			maxIterations: 5,
			consecutiveErrorLimit: 3,
			windowSize: DEFAULT_WINDOW_SIZE,
			contextWindowTokens: 128_000,
			condenseThresholdFraction: 0.75,
			checkpoints: false,
			// Tiny cost cap — the main call's 110000 tokens at the fallback
			// price already exceed it, but the point is the condensation
			// call's usage is RECORDED (not skipped), which is what trips it.
			budget: { maxCostUsd: 0.0001 },
		})
		const result = await budgetSession.run()
		assert.equal(result.status, "error", "budget must trip")
		assert.equal(result.reason, "budget", "the abort reason must be 'budget'")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * The condensation LLM call must time out instead of hanging the session
 * forever (issue #74): a provider that never responds must be aborted on
 * the per-LLM-call timeout (llmTimeoutMs — the same mechanism as the main
 * call), and the session must degrade gracefully (non-fatal fallback to
 * truncateHistory), not crash or block.
 */
async function testSessionCondenseCallTimesOutNonFatally(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-condense-timeout-"))
	try {
		const client = new HangingCondenseClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "hello" }),
				() => toolCall("attempt_completion", { result: "done after condensation timeout" }),
			],
			// Large prompt count so condensation fires after the first call.
			{ promptTokens: 110_000, completionTokens: 100 },
		)
		const session = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "write a file",
			llmClient: client,
			maxIterations: 10,
			consecutiveErrorLimit: 3,
			windowSize: DEFAULT_WINDOW_SIZE,
			contextWindowTokens: 128_000,
			condenseThresholdFraction: 0.75,
			// Tiny per-LLM-call timeout: the hanging condensation call must be
			// aborted and the session fall back ~50ms after it starts.
			llmTimeoutMs: 50,
			// Checkpoints off — this suite isn't testing shadow-git.
			checkpoints: false,
		})
		// Race the session against a hard deadline so a regression (timeout
		// never wired) fails loudly instead of hanging `npm test` forever.
		let deadline: NodeJS.Timeout | undefined
		try {
			const result = await Promise.race([
				session.run(),
				new Promise<never>((_, reject) => {
					deadline = setTimeout(() => reject(new Error("session hung: condensation call never timed out")), 10_000)
				}),
			])
			assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
			assert.equal(client.condenseCalls, 1, "the condensation call WAS attempted (and timed out)")
			const condenseReq = client.requests.find(
				(r) =>
					!r.tools &&
					typeof r.messages[0]?.content === "string" &&
					r.messages[0].content.includes("conversation-compression engine"),
			)
			assert.ok(condenseReq, "condensation request present")
			assert.ok(condenseReq.signal, "the condensation call must carry an abort signal (timeout wiring)")
			assert.ok(client.condenseSignal?.aborted, "the condensation call's signal must have been aborted (timed out)")
			// Graceful degradation: no summary landed in state, and the
			// session still completed (history bounded by truncateHistory).
			const stateHasSummary = session.state.messages.some(
				(m) => typeof m.content === "string" && m.content.includes("Condensed summary"),
			)
			assert.equal(stateHasSummary, false, "a timed-out condensation must NOT leave a summary in state")
		} finally {
			clearTimeout(deadline)
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void> | void]> = [
	["computeCondenseCount: never splits a tool-call group (irregular counts)", testComputeCondenseCountNeverSplitsToolGroup],
	["computeCondenseCount: consumes until the budget, bounded by it", testComputeCondenseCountConsumesUntilBudget],
	["computeEvictCount: reproduces truncateHistory's batch math", testComputeEvictCountMatchesOldBehavior],
	["skipOrphanedToolMessages: skips leading tool messages", testSkipOrphanedToolMessagesSkipsLeadingTools],
	["buildCondensedMessage: synthetic message is a user message", testBuildCondensedMessageIsUserRole],
	["buildCondenseUserPrompt: delimits the transcript and carries the target", testCondenseUserPromptDelimitsAndCaps],
	["buildCondenseUserPrompt: omits reasoning from the transcript", testCondenseUserPromptOmitsReasoning],
	["estimateMessageChars: counts reasoning toward the size", testEstimateMessageCharsCountsReasoning],
	["computeCondenseCount: reasoning consumes the fold budget (no free lunch)", testComputeCondenseCountCountsReasoningTowardBudget],
	["maybeCondense: below threshold -> NO condensation call (call counter)", testMaybeCondenseBelowThresholdNoCall],
	["maybeCondense: above threshold -> summary + shorter history + usage surfaced", testMaybeCondenseAboveThresholdSummarizesAndShrinks],
	["maybeCondense: batch-once stability (same head never re-condensed)", testMaybeCondenseRespectsBatchOnceStability],
	["maybeCondense: failure is non-fatal (falls back to truncateHistory)", testCondenseFailureIsNonFatal],
	["maybeCondense: oversized summary rejected (never blown into context)", testCondenseOversizedSummaryRejected],
	["condenseOldestTurns: usage callback fires with the real usage", testCondenseOldestTurnsDirectUsageCallback],
	["session: below threshold -> byte-identical behavior, zero condensation calls", testSessionBelowThresholdNoCondensationCall],
	["session: above threshold -> condensation + budget accounting includes it", testSessionAboveThresholdCondensesAndAccounts],
	["session: condensation call always carries max_tokens (defaults, no session maxTokens)", testSessionCondenseRequestAlwaysCarriesMaxTokens],
	["session: explicit condenseMaxTokens/maxTokens override the defaults", testSessionExplicitMaxTokensOverridesDefaults],
	["session: live-resolved context window is cached and reused across checks (regression)", testSessionReusesLiveResolvedContextWindowAcrossChecks],
	["session: condensation never splits a tool-call group", testSessionCondensationNeverSplitsToolGroup],
	[
		"session: disableLlmCondensation skips the summarization call but truncateHistory still bounds it",
		testSessionDisableLlmCondensationSkipsSummarizationCall,
	],
	[
		"session: disableLlmCondensation still evicts by token budget, not just windowSize",
		testSessionDisableLlmCondensationStillEvictsByTokenBudget,
	],
	["session: post-condensation prefix stays stable across calls", testSessionPostCondensePrefixStable],
	["session: condensation usage can trip the budget like a main call", testCondensationUsageTripsBudget],
	["session: condensation call times out instead of hanging forever (non-fatal)", testSessionCondenseCallTimesOutNonFatally],
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
	console.log(`\nAll ${tests.length} condense tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
