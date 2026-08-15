/**
 * switch_mode tests (plans/switch-mode-headless.md).
 *
 * The headless-native design: switch_mode changes the CURRENT session's OWN
 * active mode IN PLACE — same message history, same iteration count, same
 * budget, just a new system prompt / tool set from that point forward. It is
 * deliberately NOT new_task (no child session, no new process).
 *
 * The approval gate is real: unless autoApproveModeSwitch is set (config/CLI/
 * env opt-in, OFF by default), the switch is escalated through the SAME
 * `.harness.needs-decision` / `.harness.decision-answer` marker pair as
 * ask_followup_question and fails CLOSED on denial/timeout (the session stays
 * in its current mode). These tests script ONE fake LlmClient (same DI
 * pattern as new-task.test.ts) and assert on what the client actually
 * received, session state, transcript markers, event-feed records and marker
 * file lifecycle.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { HeadlessSession } from "../loop.js"
import { eventsDir, readEventsFile, type EventRecord } from "../events.js"
import { createReadOnlyHeadlessExecutor } from "../../tools/executor.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"

const NEEDS_DECISION = ".harness.needs-decision"
const DECISION_ANSWER = ".harness.decision-answer"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

// ─── Scripted fake LLM client (records every request) ───────────────────────

interface ScriptStep {
	message: ChatMessage
}

class ScriptedLlmClient implements LlmClient {
	requests: LlmRequest[] = []

	constructor(
		private readonly script: ScriptStep[],
		private readonly onRequest?: (req: LlmRequest) => void,
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		this.onRequest?.(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("ScriptedLlmClient: script exhausted (model kept calling)")
		}
		return { message: step.message }
	}
}

function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2)}`): ChatMessage {
	const call: ChatToolCall = { id, type: "function", function: { name, arguments: JSON.stringify(args) } }
	return { role: "assistant", content: null, tool_calls: [call] }
}

/** One assistant message with MULTIPLE tool calls in the same turn. */
function multiToolCall(calls: Array<{ name: string; args: unknown }>): ChatMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: calls.map((c, i) => {
			const call: ChatToolCall = {
				id: `call_multi_${Math.random().toString(36).slice(2)}_${i}`,
				type: "function",
				function: { name: c.name, arguments: JSON.stringify(c.args) },
			}
			return call
		}),
	}
}

async function makeSession(options: {
	task: string
	client: LlmClient
	workspaceRoot: string
	maxIterations?: number
	consecutiveErrorLimit?: number
	/** switch_mode: opt-in auto-approval (default OFF — the approval gate). */
	autoApproveModeSwitch?: boolean
	/** switch_mode: hard cap on total switches (default DEFAULT_MAX_MODE_SWITCHES). */
	maxModeSwitches?: number
	/** Decision-escalation timeout/poll overrides (short in tests). */
	decisionTimeoutMs?: number
	decisionPollIntervalMs?: number
}) {
	const session = new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: options.maxIterations ?? 10,
		consecutiveErrorLimit: options.consecutiveErrorLimit ?? 3,
		windowSize: 40,
		autoApproveModeSwitch: options.autoApproveModeSwitch ?? false,
		maxModeSwitches: options.maxModeSwitches,
		decisionTimeoutMs: options.decisionTimeoutMs,
		decisionPollIntervalMs: options.decisionPollIntervalMs,
		checkpoints: false,
	})
	return session
}

/** The tool message in `messages` that replies to the given call id. */
function findToolResult(messages: ChatMessage[], callId: string): ChatMessage | undefined {
	return messages.find((m) => m.role === "tool" && m.tool_call_id === callId)
}

/** The id of the session's switch_mode call (from its assistant message). */
function findSwitchModeCallId(messages: ChatMessage[]): string {
	const assistant = messages.find(
		(m) =>
			m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.function.name === "switch_mode"),
	)
	assert.ok(assistant, "expected an assistant message with a switch_mode call")
	const call = assistant.tool_calls!.find((c) => c.function.name === "switch_mode")
	assert.ok(call, "expected a switch_mode tool call")
	return call.id
}

/** The visible transcript marker a performed switch leaves behind. */
function findModeSwitchMarker(messages: ChatMessage[], to: string): ChatMessage | undefined {
	return messages.find(
		(m) => m.role === "user" && typeof m.content === "string" && m.content.includes(`[mode switched: code -> ${to}`),
	)
}

/** Tool names advertised to the model for one LLM request. */
function toolNames(req: LlmRequest): string[] {
	return (req.tools ?? []).map((t) => (t.type === "function" ? t.function.name : t.type))
}

/** All per-session event feeds for a workspace, keyed by sessionId. */
async function readAllEventFeeds(ws: string): Promise<Map<string, EventRecord[]>> {
	const dir = eventsDir(ws)
	const files = await fs.readdir(dir)
	const map = new Map<string, EventRecord[]>()
	for (const file of files) {
		if (!file.endsWith(".jsonl")) continue
		const records = await readEventsFile(path.join(dir, file))
		const sessionId = records[0]?.sessionId ?? file.replace(/\.jsonl$/, "")
		map.set(sessionId, records)
	}
	return map
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testAutoApproveSwitchesModeInPlace(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-auto-")
	try {
		const client = new ScriptedLlmClient([
			{ message: toolCall("switch_mode", { mode_slug: "ask", reason: "need read-only context" }) },
			{ message: toolCall("attempt_completion", { result: "done in ask mode" }) },
		])
		const session = await makeSession({
			task: "switch modes",
			client,
			workspaceRoot: ws,
			autoApproveModeSwitch: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		// The switch happened IN PLACE: same session, new mode.
		assert.equal(session.state.mode, "ask", "state.mode must be the new mode after an auto-approved switch")
		// Visible transcript marker + living system prompt updated, history NOT
		// silently rewritten (the marker is a real user message in history).
		const marker = findModeSwitchMarker(session.state.messages, "ask")
		assert.ok(marker, "a visible '[mode switched: code -> ask' marker must be in the transcript")
		assert.equal(session.state.messages[0]?.role, "system", "messages[0] is still the system message")
		assert.ok(
			(session.state.messages[0]?.content ?? "").length > 0 && session.state.messages[0]?.content !== "",
			"messages[0].content is the new system prompt",
		)
		// The switch result was a normal (non-error) tool result.
		const callId = findSwitchModeCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "switch_mode tool result should be in history")
		assert.match(toolMsg.content ?? "", /Switched to mode 'ask'/)
		assert.doesNotMatch(toolMsg.content ?? "", /^\[Error\]/, "an approved switch is NOT an error result")
		// Ordering contract: the marker must come AFTER the switch_mode tool
		// result — an assistant message with tool_calls has to be followed by
		// its tool messages with NOTHING between (strict providers like
		// DeepSeek 400 on it; a real API run caught this exact bug).
		const markerIdx = session.state.messages.indexOf(marker)
		const toolMsgIdx = session.state.messages.indexOf(toolMsg)
		assert.ok(
			markerIdx > toolMsgIdx,
			`marker (idx ${markerIdx}) must come after the switch_mode tool result (idx ${toolMsgIdx})`,
		)
		assert.equal(session.state.messages[markerIdx - 1]?.role, "tool", "the message before the marker is the tool result")

		// The NEXT LLM call was made with the NEW mode's tool list: code mode
		// advertised write_to_file, ask mode (read-only) does not — asserted on
		// what the client actually received, not just internal state.
		assert.ok(client.requests.length >= 2, `expected >=2 LLM calls, got ${client.requests.length}`)
		const first = toolNames(client.requests[0])
		const second = toolNames(client.requests[1])
		assert.ok(first.includes("write_to_file"), `code mode must advertise write_to_file, got: ${first.join(", ")}`)
		assert.ok(!second.includes("write_to_file"), `ask mode must NOT advertise write_to_file, got: ${second.join(", ")}`)
		assert.ok(second.includes("read_file"), `ask mode must advertise read_file, got: ${second.join(", ")}`)
		assert.ok(
			second.includes("switch_mode") && first.includes("switch_mode"),
			"switch_mode stays advertised in both modes",
		)

		// The mode_switched event fired with the right fields (autoApproved: true).
		const feeds = await readAllEventFeeds(ws)
		const records = [...feeds.values()].flat()
		const switched = records.find((r) => r.type === "mode_switched")
		assert.ok(switched, "expected a mode_switched event")
		assert.equal(switched.from, "code")
		assert.equal(switched.to, "ask")
		assert.equal(switched.reason, "need read-only context")
		assert.equal(switched.autoApproved, true)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testHumanApprovalApprovesSwitch(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-approve-")
	try {
		const client = new ScriptedLlmClient([
			{ message: toolCall("switch_mode", { mode_slug: "ask", reason: "handoff" }) },
			{ message: toolCall("attempt_completion", { result: "done" }) },
		])
		const session = await makeSession({
			task: "switch modes",
			client,
			workspaceRoot: ws,
			decisionTimeoutMs: 5_000,
			decisionPollIntervalMs: 20,
		})

		// Approve the switch mid-wait, exactly like scripts/headlesscode-answer.sh
		// does (the marker must exist first; a slightly delayed write is robust
		// either way — the poll loop re-reads the answer file every 20ms).
		const timer = setTimeout(() => {
			void fs.writeFile(path.join(ws, DECISION_ANSWER), "approve\n", "utf-8").catch(() => {})
		}, 60)

		const result = await session.run()
		clearTimeout(timer)

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(session.state.mode, "ask", "an approved switch must take effect")
		assert.ok(findModeSwitchMarker(session.state.messages, "ask"), "transcript marker must be present after approval")

		// autoApproved: false — this went through the human gate.
		const feeds = await readAllEventFeeds(ws)
		const records = [...feeds.values()].flat()
		const switched = records.find((r) => r.type === "mode_switched")
		assert.ok(switched, "expected a mode_switched event")
		assert.equal(switched.autoApproved, false)
		// The escalation itself was observable: decision_blocked then answered.
		assert.ok(records.some((r) => r.type === "decision_blocked"), "approval gate must emit decision_blocked")
		assert.ok(records.some((r) => r.type === "decision_answered"), "approval gate must emit decision_answered")

		// Marker files cleaned up.
		assert.equal(await exists(path.join(ws, NEEDS_DECISION)), false, "needs-decision marker cleaned up")
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "decision-answer marker cleaned up")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testProxyPrefixedApprovalApprovesSwitch(): Promise<void> {
	// The decision-proxy writes answers as "[decision-proxy] <answer>" so the
	// audit trail can distinguish them from human answers. The switch_mode
	// gate must strip that prefix before its exact approve/deny match —
	// otherwise a proxy-approved switch is misread as a denial.
	const ws = await mkTmpWorkspace("hc-switchmode-proxy-")
	try {
		const client = new ScriptedLlmClient([
			{ message: toolCall("switch_mode", { mode_slug: "ask", reason: "handoff" }) },
			{ message: toolCall("attempt_completion", { result: "done" }) },
		])
		const session = await makeSession({
			task: "switch modes",
			client,
			workspaceRoot: ws,
			decisionTimeoutMs: 5_000,
			decisionPollIntervalMs: 20,
		})

		const timer = setTimeout(() => {
			void fs.writeFile(path.join(ws, DECISION_ANSWER), "[decision-proxy] approve\n", "utf-8").catch(() => {})
		}, 60)

		const result = await session.run()
		clearTimeout(timer)

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(session.state.mode, "ask", "a [decision-proxy]-prefixed approve must take effect")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDenialRefusesSwitch(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-deny-")
	try {
		const client = new ScriptedLlmClient([
			{ message: toolCall("switch_mode", { mode_slug: "ask", reason: "handoff" }) },
			{ message: toolCall("attempt_completion", { result: "kept working in code mode" }) },
		])
		const session = await makeSession({
			task: "switch modes",
			client,
			workspaceRoot: ws,
			decisionTimeoutMs: 5_000,
			decisionPollIntervalMs: 20,
		})

		const timer = setTimeout(() => {
			void fs.writeFile(path.join(ws, DECISION_ANSWER), "deny\n", "utf-8").catch(() => {})
		}, 60)

		const result = await session.run()
		clearTimeout(timer)

		assert.equal(result.status, "success", `session must recover from a denial, got ${JSON.stringify(result)}`)
		// Denied: NO state change, NO transcript marker.
		assert.equal(session.state.mode, "code", "a denied switch must leave the session in its current mode")
		assert.equal(findModeSwitchMarker(session.state.messages, "ask"), undefined, "no transcript marker on denial")
		// The refusal surfaced as a real tool error the model could react to.
		const callId = findSwitchModeCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "expected a switch_mode tool result")
		assert.match(toolMsg.content ?? "", /^\[Error\] switch_mode: mode switch to 'ask' was denied/)
		// No mode_switched event.
		const feeds = await readAllEventFeeds(ws)
		const records = [...feeds.values()].flat()
		assert.equal(records.some((r) => r.type === "mode_switched"), false, "no mode_switched event on denial")
		assert.equal(await exists(path.join(ws, NEEDS_DECISION)), false, "markers cleaned up after denial")
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "markers cleaned up after denial")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testTimeoutDeniesSwitchAndCleansMarkers(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-timeout-")
	try {
		const client = new ScriptedLlmClient([
			{ message: toolCall("switch_mode", { mode_slug: "ask", reason: "handoff" }) },
			{ message: toolCall("attempt_completion", { result: "kept working in code mode" }) },
		])
		const session = await makeSession({
			task: "switch modes",
			client,
			workspaceRoot: ws,
			decisionTimeoutMs: 80,
			decisionPollIntervalMs: 15,
		})

		const result = await session.run()

		// Fail CLOSED on timeout: no answer within 80ms → refused, no state
		// change, markers cleaned up. (Deliberate divergence from
		// ask_followup_question's fail-open-on-timeout — see the plan.)
		assert.equal(result.status, "success", `session must recover from a timeout, got ${JSON.stringify(result)}`)
		assert.equal(session.state.mode, "code", "a timed-out switch must leave the session in its current mode")
		const callId = findSwitchModeCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "expected a switch_mode tool result")
		assert.match(toolMsg.content ?? "", /was not approved within the timeout/)
		assert.equal(findModeSwitchMarker(session.state.messages, "ask"), undefined, "no transcript marker on timeout")
		assert.equal(await exists(path.join(ws, NEEDS_DECISION)), false, "needs-decision marker cleaned up on timeout")
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "no answer marker ever existed")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testUnknownModeSlugFailsImmediately(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-unknown-")
	try {
		const client = new ScriptedLlmClient([
			{ message: toolCall("switch_mode", { mode_slug: "no_such_mode", reason: "x" }) },
			{ message: toolCall("attempt_completion", { result: "done" }) },
		])
		const session = await makeSession({ task: "switch modes", client, workspaceRoot: ws })

		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(session.state.mode, "code", "unknown mode must not change the session mode")
		const callId = findSwitchModeCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "expected a switch_mode tool result")
		assert.match(toolMsg.content ?? "", /unknown mode 'no_such_mode'/)
		// No escalation, no wait, no marker — the failure is immediate.
		assert.equal(await exists(path.join(ws, NEEDS_DECISION)), false, "no needs-decision marker written at all")
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "no answer marker")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testAlreadyInModeIsNoOp(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-already-")
	try {
		const client = new ScriptedLlmClient([
			{ message: toolCall("switch_mode", { mode_slug: "code", reason: "oops" }) },
			{ message: toolCall("attempt_completion", { result: "done" }) },
		])
		const session = await makeSession({ task: "switch modes", client, workspaceRoot: ws })

		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(session.state.mode, "code")
		const callId = findSwitchModeCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "expected a switch_mode tool result")
		assert.match(toolMsg.content ?? "", /already in mode 'code'/)
		assert.equal(await exists(path.join(ws, NEEDS_DECISION)), false, "no escalation for a no-op switch")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMaxModeSwitchesCapIsRecoverable(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-cap-")
	try {
		const client = new ScriptedLlmClient([
			{ message: toolCall("switch_mode", { mode_slug: "ask", reason: "first switch" }) },
			{ message: toolCall("switch_mode", { mode_slug: "code", reason: "second switch" }) },
			{ message: toolCall("attempt_completion", { result: "done despite cap" }) },
		])
		const session = await makeSession({
			task: "switch modes",
			client,
			workspaceRoot: ws,
			autoApproveModeSwitch: true,
			maxModeSwitches: 1,
		})

		const result = await session.run()
		// The cap is a normal, RECOVERABLE tool error — the session continues.
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(session.state.mode, "ask", "the first (in-cap) switch took effect; the second was refused")
		const assistant = session.state.messages.find(
			(m) =>
				m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.function.name === "switch_mode"),
		)
		assert.ok(assistant, "expected assistant messages with switch_mode calls")
		// The SECOND switch_mode call's result is the cap error.
		const toolMessages = session.state.messages.filter((m) => m.role === "tool" && m.name === "switch_mode")
		assert.equal(toolMessages.length, 2, "two switch_mode tool results (one success, one cap error)")
		assert.match(toolMessages[0]?.content ?? "", /Switched to mode 'ask'/)
		assert.match(toolMessages[1]?.content ?? "", /max mode switches reached/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSwitchModeRefusedWhenCalledAlongsideSiblings(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-alone-")
	try {
		const client = new ScriptedLlmClient([
			{
				message: multiToolCall([
					{ name: "switch_mode", args: { mode_slug: "ask", reason: "handoff" } },
					{ name: "write_to_file", args: { path: "sibling.txt", content: "sibling wrote this" } },
				]),
			},
			{ message: toolCall("attempt_completion", { result: "done after sibling" }) },
		])
		const session = await makeSession({
			task: "switch plus sibling",
			client,
			workspaceRoot: ws,
			autoApproveModeSwitch: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		// The sibling STILL executed (same semantics as new_task's refusal).
		assert.equal(await fs.readFile(path.join(ws, "sibling.txt"), "utf-8"), "sibling wrote this")
		// switch_mode was refused WITHOUT executing (no escalation → no marker).
		const callId = findSwitchModeCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "expected a switch_mode tool result")
		assert.match(toolMsg.content ?? "", /cannot run alongside other tools/)
		assert.equal(session.state.mode, "code", "the refused switch must not take effect")
		assert.equal(await exists(path.join(ws, NEEDS_DECISION)), false, "no escalation marker for a refused switch")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyExecutorStillStubsSwitchMode(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-readonly-")
	try {
		// The reviewer/QA (read-only) executor must keep switch_mode stubbed:
		// a review/QA session requesting a mode switch to gain edit tools would
		// be exactly the privilege escalation that executor exists to prevent.
		const executor = createReadOnlyHeadlessExecutor(ws)
		const result = await executor.execute("switch_mode", { mode_slug: "code", reason: "escalate" })
		assert.equal(result.isError, true, "read-only executor must refuse switch_mode")
		assert.match(result.content, /not implemented/i)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * A ScriptedLlmClient plus request-time snapshots of the system prompt
 * (messages[0].content) for the first `count` requests. The loop mutates
 * messages[0].content IN PLACE on a rebuild, so the raw request objects can't
 * be compared after the run — capture the string at request time instead
 * (strings are immutable, so each snapshot stays stable).
 */
function makeSnapshotClient(
	script: ScriptStep[],
	count: number,
): { client: ScriptedLlmClient; snapshots: (string | null | undefined)[] } {
	const snapshots: (string | null | undefined)[] = []
	const client = new ScriptedLlmClient(script, (req) => {
		if (snapshots.length < count) {
			snapshots.push(req.messages[0]?.content)
		}
	})
	return { client, snapshots }
}

async function testToolSetUnchangedSkipsPromptRebuild(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-sametools-")
	try {
		// code and debug share the same groups (read/edit/command/mcp), so the
		// target mode's tool set equals the current one. The system prompt must
		// NOT be rebuilt and messages[0] must NOT be replaced — rewriting it
		// would invalidate the provider's cached prompt prefix for the whole
		// session. Asserted on what the client actually received across the
		// switch boundary, not just internal state.
		const { client, snapshots } = makeSnapshotClient(
			[
				{ message: toolCall("switch_mode", { mode_slug: "debug", reason: "same groups as code" }) },
				{ message: toolCall("attempt_completion", { result: "done" }) },
			],
			2,
		)
		const session = await makeSession({
			task: "switch to debug",
			client,
			workspaceRoot: ws,
			autoApproveModeSwitch: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(session.state.mode, "debug", "state.mode must be the new mode")
		assert.equal(
			snapshots[1],
			snapshots[0],
			"messages[0] must be untouched when the target mode's tool set equals the current one",
		)
		// The switch still took effect in every other respect: mode label,
		// visible transcript marker, result text, and the mode_switched event.
		const marker = findModeSwitchMarker(session.state.messages, "debug")
		assert.ok(marker, "a visible '[mode switched: code -> debug' marker must be in the transcript")
		const callId = findSwitchModeCallId(session.state.messages)
		const toolMsg = findToolResult(session.state.messages, callId)
		assert.ok(toolMsg, "switch_mode tool result should be in history")
		assert.match(toolMsg.content ?? "", /tool set unchanged/)
		const feeds = await readAllEventFeeds(ws)
		const records = [...feeds.values()].flat()
		const switched = records.find((r) => r.type === "mode_switched")
		assert.ok(switched, "expected a mode_switched event")
		assert.equal(switched.from, "code")
		assert.equal(switched.to, "debug")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testToolSetChangeRebuildsPrompt(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-switchmode-difftools-")
	try {
		// code → ask changes the tool set (ask drops the edit/command tools),
		// so the system prompt IS rebuilt and messages[0] replaced — the
		// original behavior must be preserved when the tool set differs.
		const { client, snapshots } = makeSnapshotClient(
			[
				{ message: toolCall("switch_mode", { mode_slug: "ask", reason: "read-only" }) },
				{ message: toolCall("attempt_completion", { result: "done" }) },
			],
			2,
		)
		const session = await makeSession({
			task: "switch to ask",
			client,
			workspaceRoot: ws,
			autoApproveModeSwitch: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(session.state.mode, "ask")
		assert.notEqual(
			snapshots[1],
			snapshots[0],
			"messages[0] must be rebuilt when the target mode's tool set differs",
		)
		// The transcript marker is still present (the rebuild-skip logic must
		// not remove it on a real tool-set change).
		assert.ok(findModeSwitchMarker(session.state.messages, "ask"), "marker present after a real tool-set change")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["switch_mode: auto-approve switches mode in place (state, transcript marker, event, next LLM tool list)", testAutoApproveSwitchesModeInPlace],
	["switch_mode: human 'approve' answer approves the switch (autoApproved: false, markers cleaned)", testHumanApprovalApprovesSwitch],
	["switch_mode: '[decision-proxy] approve' (prefixed) still approves the switch", testProxyPrefixedApprovalApprovesSwitch],
	["switch_mode: 'deny' answer refuses with a tool error, no state change, no marker", testDenialRefusesSwitch],
	["switch_mode: timeout denies (fail closed) and cleans markers", testTimeoutDeniesSwitchAndCleansMarkers],
	["switch_mode: unknown mode_slug fails immediately with no escalation", testUnknownModeSlugFailsImmediately],
	["switch_mode: already-in-that-mode is a no-op, no escalation", testAlreadyInModeIsNoOp],
	["switch_mode: max-switches cap is a recoverable tool error (session continues)", testMaxModeSwitchesCapIsRecoverable],
	["switch_mode: called alongside siblings is refused, sibling still executes", testSwitchModeRefusedWhenCalledAlongsideSiblings],
	["switch_mode: read-only reviewer/QA executor still stubs it (regression)", testReadOnlyExecutorStillStubsSwitchMode],
	["switch_mode: identical target tool set skips the prompt rebuild (messages[0] untouched)", testToolSetUnchangedSkipsPromptRebuild],
	["switch_mode: differing target tool set rebuilds the prompt (messages[0] replaced)", testToolSetChangeRebuildsPrompt],
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
	console.log(`\nAll ${tests.length} tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
