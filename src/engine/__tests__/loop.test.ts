/**
 * Loop + executor tests for the Phase 1 headless harness.
 *
 * Plain assert-based script (no test framework, no network, no API key) run
 * via `npm test` → `tsx src/engine/__tests__/loop.test.ts`.
 *
 * The loop is tested end-to-end with a fake LlmClient injected through the
 * constructor (DI) — the loop never hardcodes OpenRouter.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import {
	HeadlessSession,
	DEFAULT_READ_ONLY_STALL_LIMIT,
	DEFAULT_IDENTICAL_CALL_STALL_LIMIT,
	DEFAULT_IDENTICAL_CALL_REPEAT_PENALTY_BOOST,
	DEFAULT_MAX_MODE_SWITCHES,
	DEFAULT_MAX_RECURSION_DEPTH,
	DEFAULT_MAX_TOKENS,
	DEFAULT_MIN_CHILD_ITERATIONS,
	isReadOnlyEquivalentShellCommand,
	stripSupersededReasoning,
	truncateHistory,
	TRUNCATION_BATCH_SIZE,
} from "../loop.js"
import { OpenRouterError } from "../../llm/openrouter.js"
import { createHeadlessExecutor, createReadOnlyHeadlessExecutor } from "../../tools/executor.js"
import { createCheckpointService } from "../../checkpoints/service.js"
import { parseToolCall } from "../parser.js"
import { readUsageFile } from "../usage.js"
import { reportFilePath } from "../reports.js"
import type { SessionBudget } from "../../budget/budget.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"

// ─── Fake LLM client ─────────────────────────────────────────────────────────

class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []

	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly onRequest?: (req: LlmRequest) => void,
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		// Snapshot messages: the loop mutates the SAME array across iterations
		// (assistant/tool pushes, condensation, nudge injection). Without a copy,
		// every recorded request aliases to the array's final state — making the
		// read-only nudge appear in requests that predate its injection.
		this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) })
		this.onRequest?.(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (model kept calling)")
		}
		return { message: step(request) }
	}
}

function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2)}`): ChatMessage {
	const argumentsStr = typeof args === "string" ? args : JSON.stringify(args)
	const call: ChatToolCall = { id, type: "function", function: { name, arguments: argumentsStr } }
	return { role: "assistant", content: null, tool_calls: [call] }
}

/** ONE assistant message carrying SEVERAL tool calls (a single-turn batch). */
function toolCallBatch(calls: Array<{ name: string; args: unknown }>): ChatMessage {
	return {
		role: "assistant",
		content: null,
		tool_calls: calls.map(({ name, args }) => ({
			id: `call_${Math.random().toString(36).slice(2)}`,
			type: "function",
			function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
		})),
	}
}

function textReply(content: string): ChatMessage {
	return { role: "assistant", content }
}

/**
 * Live-snapshot probe client: reports a fixed token usage per call and, from
 * the second call on, runs `probe()` BEFORE returning — at that point the
 * previous iteration's `*.live.json` snapshot must already be on disk (it is
 * written right after each iteration's LLM call). Used to observe the live
 * snapshot mid-run without exposing the session's private sessionId.
 */
class LiveProbeClient implements LlmClient {
	calls = 0

	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly probe: () => Promise<void>,
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.calls++
		if (this.calls > 1) {
			await this.probe()
		}
		const step = this.script.shift()
		if (!step) {
			throw new Error("LiveProbeClient: script exhausted (model kept calling)")
		}
		return {
			message: step(request),
			usage: { promptTokens: 100, completionTokens: 50 },
		}
	}
}

/**
	* Fake client for the Part E live-pricing tests: returns real token usage on
	* every call and (optionally) a fake `fetchModelInfo` so the session's
	* eager live lookup resolves a price. `info === undefined` models a client
	* with NO live-pricing support — the fallback path.
	*/
class UsageClient implements LlmClient {
	constructor(
		private readonly script: Array<(req: LlmRequest) => ChatMessage>,
		private readonly info: { price?: { input: number; output: number; cacheRead?: number } } | undefined,
	) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		const step = this.script.shift()
		if (!step) {
			throw new Error("UsageClient: script exhausted (model kept calling)")
		}
		return { message: step(request), usage: { promptTokens: 100, completionTokens: 50 } }
	}

	async fetchModelInfo(): Promise<{ price?: { input: number; output: number; cacheRead?: number } } | undefined> {
		return this.info
	}
}

/** Read the single `*.live.json` snapshot in a usage dir (asserts it exists). */
async function readLiveSnapshot(usageDir: string): Promise<Record<string, unknown>> {
	const entries = await fs.readdir(usageDir)
	const live = entries.find((e) => e.endsWith(".live.json"))
	assert.ok(live, `expected a *.live.json snapshot in ${usageDir}, found: ${entries.join(", ") || "(empty)"}`)
	return JSON.parse(await fs.readFile(path.join(usageDir, live), "utf-8")) as Record<string, unknown>
}

/** Assert a live snapshot is gone and a single final `.jsonl` record remains. */
async function assertCompletedCleanup(ws: string, expectedStatus: string): Promise<void> {
	const usageDir = path.join(ws, ".headlesscode", "usage")
	const entries = await fs.readdir(usageDir)
	assert.ok(entries.some((e) => e.endsWith(".jsonl")), "final .jsonl record written")
	assert.ok(!entries.some((e) => e.endsWith(".live.json")), "live snapshot removed on completion")
	const jsonl = entries.find((e) => e.endsWith(".jsonl"))
	assert.ok(jsonl, "found the .jsonl file")
	const records = await readUsageFile(path.join(usageDir, jsonl))
	assert.equal(records.length, 1)
	assert.equal(records[0].status, expectedStatus)
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

/** Poll `process.kill(pid, 0)` until the process is gone (throws) or timeout. */
async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0)
		} catch {
			return // gone
		}
		await sleep(50)
	}
	throw new Error(`process ${pid} still alive after ${timeoutMs}ms`)
}

async function makeSession(options: {
	task: string
	client: LlmClient
	workspaceRoot: string
	/** Mode slug (default "code"). Read-only modes disable the commit guard. */
	mode?: string
	maxIterations?: number
	consecutiveErrorLimit?: number
	windowSize?: number
	budget?: SessionBudget
	/** Graded reasoning effort for deepseek/* models (issue #30). */
	reasoningEffort?: string
	maxTokens?: number
	/** Checkpoints on/off + shadow-git storage dir (default off — see below). */
	checkpoints?: boolean
	checkpointDir?: string
	/** Explicit session id override (see HeadlessSessionConfig.sessionId). */
	sessionId?: string
	requireExplicitCompletion?: boolean
	verifyBeforeCompletion?: boolean
	evidenceRequiredCompletion?: boolean
	requireArtifactBeforeCompletion?: boolean
	requireArtifactPathPattern?: string
	requireArtifactMinCitations?: number
	requireArtifactSections?: string[]
	maxModeSwitches?: number
	autoApproveModeSwitch?: boolean
	recursionDepth?: number
	maxRecursionDepth?: number
}) {
	const session = new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: options.mode ?? "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: options.maxIterations ?? 10,
		consecutiveErrorLimit: options.consecutiveErrorLimit ?? 3,
		windowSize: options.windowSize ?? 40,
		budget: options.budget ?? null,
		reasoningEffort: options.reasoningEffort,
		maxTokens: options.maxTokens,
		requireExplicitCompletion: options.requireExplicitCompletion,
		verifyBeforeCompletion: options.verifyBeforeCompletion,
		evidenceRequiredCompletion: options.evidenceRequiredCompletion,
		requireArtifactBeforeCompletion: options.requireArtifactBeforeCompletion,
		requireArtifactPathPattern: options.requireArtifactPathPattern,
		requireArtifactMinCitations: options.requireArtifactMinCitations,
		requireArtifactSections: options.requireArtifactSections,
		maxModeSwitches: options.maxModeSwitches,
		autoApproveModeSwitch: options.autoApproveModeSwitch,
		recursionDepth: options.recursionDepth,
		maxRecursionDepth: options.maxRecursionDepth,
		// Checkpoints are default-on and would otherwise write real shadow-git
		// commits to ~/.headlesscode/checkpoints on every test run; this suite
		// isn't testing checkpoints (except the one that is), so keep tests
		// hermetic and fast. The checkpoint test passes a tmp checkpointDir.
		checkpoints: options.checkpoints ?? false,
		checkpointDir: options.checkpointDir,
		sessionId: options.sessionId,
	})
	return session
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testReasoningEffortFlowsIntoRequests(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-re-"))
	try {
		const client = new FakeLlmClient([() => textReply("Done.")])
		const session = await makeSession({ task: "say done", client, workspaceRoot: ws, reasoningEffort: "high" })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(
			client.requests[0]?.reasoningEffort,
			"high",
			"the session's configured reasoningEffort must be on every LLM request",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReasoningEffortEnvFallbackWhenNotConfigured(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-re2-"))
	const prev = process.env.HEADLESSCODE_REASONING_EFFORT
	process.env.HEADLESSCODE_REASONING_EFFORT = "xhigh"
	try {
		const client = new FakeLlmClient([() => textReply("Done.")])
		const session = await makeSession({ task: "say done", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.requests[0]?.reasoningEffort, "xhigh", "unset config falls back to the env var")
	} finally {
		if (prev === undefined) {
			delete process.env.HEADLESSCODE_REASONING_EFFORT
		} else {
			process.env.HEADLESSCODE_REASONING_EFFORT = prev
		}
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReasoningEffortAbsentByDefault(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-re3-"))
	try {
		const client = new FakeLlmClient([() => textReply("Done.")])
		const session = await makeSession({ task: "say done", client, workspaceRoot: ws })
		await session.run()
		assert.equal(
			client.requests[0]?.reasoningEffort,
			undefined,
			"zero config -> no reasoningEffort on requests (endpoint default applies)",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── maxTokens request wiring (issue #151 coverage gap) ──────────────────────
// DEFAULT_MAX_TOKENS (loop.ts:233) sits on the same request-building line as
// reasoningEffort (loop.ts:3072-3074) but had zero test coverage — confirmed
// by grepping this file for "maxTokens": no hits before this pair.

async function testMaxTokensFlowsIntoRequests(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-mt-"))
	try {
		const client = new FakeLlmClient([() => textReply("Done.")])
		const session = await makeSession({ task: "say done", client, workspaceRoot: ws, maxTokens: 4096 })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(
			client.requests[0]?.maxTokens,
			4096,
			"the session's configured maxTokens must be on every LLM request",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMaxTokensDefaultsWhenNotConfigured(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-mt2-"))
	try {
		const client = new FakeLlmClient([() => textReply("Done.")])
		const session = await makeSession({ task: "say done", client, workspaceRoot: ws })
		await session.run()
		assert.equal(
			client.requests[0]?.maxTokens,
			DEFAULT_MAX_TOKENS,
			"zero config -> DEFAULT_MAX_TOKENS on requests",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testScenario1WriteThenCompletion(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-s1-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "sub/dir/hello.txt", content: "hello world" }),
			() => toolCall("attempt_completion", { result: "Done: wrote sub/dir/hello.txt" }),
		])
		const session = await makeSession({ task: "write a hello file", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.match(result.result ?? "", /hello\.txt/)
		// The file was actually written via the executor.
		const content = await fs.readFile(path.join(ws, "sub", "dir", "hello.txt"), "utf-8")
		assert.equal(content, "hello world")
		// The system prompt was built from the vendored builder.
		assert.ok(session.state.systemPrompt.length > 100, "system prompt should be built")
		assert.ok(session.state.systemPrompt.includes("TOOL USE"), "system prompt should contain TOOL USE section")
		// Tools sent to the LLM are exactly the implemented subset (the three
		// surgical edit tools are implemented and therefore advertised too).
		const toolNames = client.requests[0].tools?.map((t) => (t.type === "function" ? t.function.name : t.type))
		assert.ok(toolNames?.includes("read_file"), "read_file should be exposed")
		assert.ok(toolNames?.includes("attempt_completion"), "attempt_completion should be exposed")
		assert.ok(toolNames?.includes("apply_diff"), "apply_diff should be exposed (implemented)")
		assert.ok(toolNames?.includes("search_replace"), "search_replace should be exposed (implemented)")
		assert.ok(toolNames?.includes("edit_file"), "edit_file should be exposed (implemented)")
		assert.ok(toolNames?.includes("codebase_search"), "codebase_search should be exposed (implemented)")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Issue #97 (COV-8): reports.ts is imported by loop.ts and runs in every
// loop test via persistFinalReport, but until now the written report FILE's
// content was never asserted anywhere — mirrors the handoff assertion above
// (testIterationCapHandoffSummary) but for the `.headlesscode/reports/` path
// instead of `.headlesscode/handoff-summary.md`.
async function testFinalReportPersistedWithFullText(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-report-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "Done: implemented the widget and verified with tests." }),
		])
		const session = await makeSession({ task: "implement widget", client, workspaceRoot: ws, sessionId: "report-test-session" })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const content = await fs.readFile(reportFilePath(ws, "report-test-session"), "utf-8")
		assert.equal(content, "Done: implemented the widget and verified with tests.")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testScenario2CommandThenTextAnswer(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-s2-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "node -e 'console.log(1+1)'" }),
			() => textReply("All done. The command produced 2."),
		])
		const session = await makeSession({ task: "run a command", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "All done. The command produced 2.")
		// The execute_command tool result was fed back as a tool message.
		const toolMsg = session.state.messages.find((m) => m.role === "tool")
		assert.ok(toolMsg, "expected a tool message in history")
		assert.match(toolMsg?.content ?? "", /2/, "command output should be in the tool result")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// A local model giving up mid-task and dumping prose was observed live
// (2026-08-19 baseline run against Qwen2.5-Coder-14B) getting recorded as
// `session succeeded` with zero files touched — requireExplicitCompletion
// closes that gap by refusing the bare-text-reply pragmatic-success
// fallback and nudging the model to retry or call attempt_completion.
async function testRequireExplicitCompletionRefusesTextOnlyReply(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rec-"))
	try {
		const client = new FakeLlmClient([
			() => textReply("I looked at the file but couldn't figure out the edit."),
			() => toolCall("attempt_completion", { result: "Done: wrote the fallback file." }),
		])
		const session = await makeSession({
			task: "write a file",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done: wrote the fallback file.")
		assert.equal(client.requests.length, 2, "the text-only reply must not end the session early")
		const nudge = session.state.messages.find(
			(m) => m.role === "user" && (m.content ?? "").includes("does not end the session"),
		)
		assert.ok(nudge, "expected a nudge telling the model text alone isn't completion")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// A local model was observed live (2026-08-20 against Qwen3-14B) writing a
// tool call as narrated prose that ALSO hallucinated a fake surrounding
// exchange — "[Called tool X with arguments {...}]\n\n[Result of X]:
// <thousands of characters of plausible-looking fake tool output>" — instead
// of a real native tool_calls entry. extractEmbeddedToolCall recovers the
// real call from inside that text (see its doc comment), but the recovered
// call used to be persisted to history with the ENTIRE hallucinated blob
// still attached as the message's content. Every reproduction of that showed
// the daemon hang mid-generation on the VERY NEXT request that included this
// message — a shape no real training data has (an assistant turn that is
// simultaneously plain narration AND a tool call). Fixed: the persisted
// message's content is cleared once a call is recovered from it, matching
// how a genuine native tool-call message looks (content: null).
async function testEmbeddedToolCallRecoveryClearsHallucinatedNarrationFromHistory(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-embedded-"))
	try {
		const narratedBlob =
			'[Called tool "read_file" with arguments {\'path\': \'src/engine/condense.ts\'}]\n\n' +
			'[Result of "read_file"]: File: src/engine/condense.ts\n' +
			"92 |  */\n93 | export const DEFAULT_CONDENSE_THRESHOLD_FRACTION = 0.75\n".repeat(50)
		const client = new FakeLlmClient([
			() => textReply(narratedBlob),
			() => toolCall("attempt_completion", { result: "Done." }),
		])
		const session = await makeSession({
			task: "read a file",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(client.requests.length, 2, "the recovered call must not end the session early")

		// The SECOND request's history is what the fix targets: the persisted
		// assistant message from turn 1 must carry the recovered tool call but
		// NOT the raw hallucinated narration.
		const secondRequestMessages = client.requests[1].messages
		const recoveredAssistantMsg = secondRequestMessages.find(
			(m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function?.name === "read_file"),
		)
		assert.ok(recoveredAssistantMsg, "expected the recovered read_file call in the persisted history")
		assert.equal(
			recoveredAssistantMsg?.content,
			null,
			"the hallucinated narration must be cleared from the persisted message, not sent back on the next turn",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Verified live 2026-08-20: the local daemon's own synthetic diagnostic
// string ("The model produced an empty reply...", NOT model-authored text)
// was being persisted into history verbatim and fed back to the model on
// the next turn — the daemon's rendered prompt was confirmed byte-for-byte
// IDENTICAL across three consecutive requests during this exact pattern, a
// stable self-reinforcing trap. Same failure family as the narrated-tool-
// call fix above (c274ddc): synthetic non-model text must never be
// persisted as if the model said it.
async function testEmptyReplyFallbackTextIsNotPersistedToHistory(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-empty-fallback-"))
	try {
		const client = new FakeLlmClient([
			() => textReply("The model produced an empty reply for this request. No changes were applied."),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "do something",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		await session.run()

		const secondRequestMessages = client.requests[1].messages
		const fallbackAssistantMsg = secondRequestMessages.find(
			(m) => m.role === "assistant" && (!m.tool_calls || m.tool_calls.length === 0),
		)
		assert.ok(fallbackAssistantMsg, "expected the text-only assistant turn in the persisted history")
		assert.equal(
			fallbackAssistantMsg?.content,
			null,
			"the synthetic empty-reply fallback text must be cleared, not sent back to the model on the next turn",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Verified live 2026-08-20 (trial 41): clearing the synthetic fallback text
// from history (see the test above) was NOT enough on its own — the
// injected nudge message itself was just as static, and truncateHistory
// evicting/re-adding a fixed-size pair every cycle reproduced a byte-for-
// byte-identical rendered prompt regardless of what the persisted content
// specifically was. The nudge must vary per occurrence to structurally
// prevent the trap from re-forming.
async function testNonCompletingReplyNudgeVariesAcrossRepeatedOccurrences(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-nudge-vary-"))
	try {
		const client = new FakeLlmClient([
			() => textReply(""),
			() => textReply(""),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "do something",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		await session.run()

		const nudges = session.state.messages
			.filter((m) => m.role === "user" && (m.content ?? "").includes("contained no tool calls"))
			.map((m) => m.content)
		assert.equal(nudges.length, 2, "expected one nudge per non-completing reply")
		assert.notEqual(nudges[0], nudges[1], "repeated nudges must not be byte-identical")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRequireExplicitCompletionBoundedFailureWhenNeverCompletes(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rec2-"))
	try {
		const client = new FakeLlmClient([
			() => textReply("Still thinking."),
			() => textReply("Still thinking."),
			() => textReply("Still thinking."),
		])
		const session = await makeSession({
			task: "write a file",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
			consecutiveErrorLimit: 3,
		})
		const result = await session.run()

		assert.equal(result.status, "error", `expected bounded failure, got ${JSON.stringify(result)}`)
		assert.match(result.error ?? "", /consecutive empty replies/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// A local model was observed live (2026-08-20, both Qwen2.5-Coder-14B and
// Qwen3-14B) calling attempt_completion for real and claiming success (e.g.
// "typecheck and tests passed") while the last execute_command it actually
// ran was still failing, without ever re-running it — verifyBeforeCompletion
// refuses that completion instead of accepting a claim the session's own
// last command result already contradicts.
async function testVerifyBeforeCompletionRefusesAfterFailedCommand(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-vbc-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "exit 1" }),
			() => toolCall("attempt_completion", { result: "Done (but tests are still red)." }),
			() => toolCall("execute_command", { command: "true" }),
			() => toolCall("attempt_completion", { result: "Done for real." }),
		])
		const session = await makeSession({
			task: "fix the build",
			client,
			workspaceRoot: ws,
			verifyBeforeCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done for real.")
		assert.equal(client.requests.length, 4, "the false completion must not end the session early")
		const nudge = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("was NOT accepted"),
		)
		assert.ok(nudge, "expected a nudge telling the model its last command failed")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Verified live 2026-08-20 against Qwen3-14B: the guardrail above used to
// spend a one-per-session nudge budget (mirroring the unrelated commit-nudge
// pattern), which meant a SECOND fabricated completion later in the same
// session — after a fresh execute_command failure, once the one nudge was
// already used — went through unchecked, even though the last command was
// still genuinely failing (confirmed by re-running tsc/tests directly: both
// failed exactly as the pre-nudge command had). The guardrail must refuse
// EVERY time the last execute_command failed and nothing since succeeded,
// however many times that takes in one session.
async function testVerifyBeforeCompletionRefusesEveryFailureNotJustTheFirst(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-vbc3-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "exit 1" }),
			() => toolCall("attempt_completion", { result: "Done (first fabricated claim)." }),
			// A non-execute_command tool call between the two fabricated
			// completions — mirrors the live trial (an edit_file attempt), so
			// lastExecuteCommandFailed is never cleared by a real re-verification.
			() => toolCall("read_file", { path: "notes.txt" }),
			() => toolCall("attempt_completion", { result: "Done (second fabricated claim)." }),
			() => toolCall("execute_command", { command: "true" }),
			() => toolCall("attempt_completion", { result: "Done for real." }),
		])
		const session = await makeSession({
			task: "fix the build",
			client,
			workspaceRoot: ws,
			verifyBeforeCompletion: true,
		})
		await fs.writeFile(path.join(ws, "notes.txt"), "hello\n", "utf-8")
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done for real.")
		assert.equal(client.requests.length, 6, "both fabricated completions must be refused, not just the first")
		const nudges = session.state.messages.filter(
			(m) => m.role === "tool" && (m.content ?? "").includes("was NOT accepted"),
		)
		assert.equal(nudges.length, 2, "expected a nudge on EACH fabricated completion attempt, not just the first")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testVerifyBeforeCompletionAcceptsAfterSuccessfulCommand(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-vbc2-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "true" }),
			() => toolCall("attempt_completion", { result: "Done, verified." }),
		])
		const session = await makeSession({
			task: "fix the build",
			client,
			workspaceRoot: ws,
			verifyBeforeCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done, verified.")
		assert.equal(client.requests.length, 2, "a completion after a successful command needs no nudge")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Live round 4 of the 2026-08-21 full-cycle demo (local Qwen3-14B): a
// session's last several real tool calls before attempt_completion were 4
// straight FAILED edit_file calls (bad old_string match) — never a
// successful one — yet it claimed "I've implemented the optimization."
// lastExecuteCommandFailed didn't catch it because it only tracks
// execute_command; edit_file/write_to_file failures were invisible to
// verifyBeforeCompletion. This mirrors testVerifyBeforeCompletionRefusesAfterFailedCommand
// but for the write-tool path.
async function testVerifyBeforeCompletionRefusesAfterFailedEdit(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-vbc-edit-"))
	try {
		await fs.writeFile(path.join(ws, "notes.txt"), "hello\n", "utf-8")
		const client = new FakeLlmClient([
			() =>
				toolCall("edit_file", {
					file_path: "notes.txt",
					old_string: "this text does not appear in the file",
					new_string: "replacement",
				}),
			() => toolCall("attempt_completion", { result: "Done (but the edit never actually applied)." }),
			() =>
				toolCall("edit_file", {
					file_path: "notes.txt",
					old_string: "hello",
					new_string: "goodbye",
				}),
			() => toolCall("attempt_completion", { result: "Done for real." }),
		])
		const session = await makeSession({
			task: "update notes.txt",
			client,
			workspaceRoot: ws,
			verifyBeforeCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done for real.")
		assert.equal(client.requests.length, 4, "the false completion must not end the session early")
		const nudge = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("was NOT accepted"),
		)
		assert.ok(nudge, "expected a nudge telling the model its last edit_file call failed")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// 2026-09-02: real, confirmed bug — lastWriteToolFailed only updates when
// edit_file/write_to_file/set_indentation is called AGAIN, so it stayed
// permanently true for the REST of the session once any such call failed,
// even after the model correctly re-read the file and determined no
// further edit was actually needed. Verified live: a session asked to add
// a /health endpoint read the file, correctly found the endpoint already
// existed and worked, and every subsequent honest attempt_completion was
// deferred anyway with a stale "fix the issue, make the edit succeed"
// message — 15+ consecutive identical deferrals with no way out. Fix: a
// successful read_file of the EXACT file the write call failed on clears
// the flag.
async function testVerifyBeforeCompletionClearsAfterReReadingSameFile(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-vbc-reread-"))
	try {
		await fs.writeFile(path.join(ws, "server.py"), "def health():\n    return 'ok'\n", "utf-8")
		const client = new FakeLlmClient([
			() =>
				toolCall("edit_file", {
					file_path: "server.py",
					old_string: "this text does not appear in the file",
					new_string: "replacement",
				}),
			// Real re-verification of the SAME file the edit failed on — the
			// model correctly concludes no edit is needed.
			() => toolCall("read_file", { path: "server.py" }),
			() => toolCall("attempt_completion", { result: "The /health endpoint already exists; no edit needed." }),
		])
		const session = await makeSession({
			task: "add a /health endpoint",
			client,
			workspaceRoot: ws,
			verifyBeforeCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected the re-read to clear the stale failure, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "The /health endpoint already exists; no edit needed.")
		assert.equal(client.requests.length, 3, "must be accepted on the first attempt after the re-read, no extra deferral round-trip")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// A read of a DIFFERENT file must NOT clear the flag — only re-verifying
// the exact file that failed to edit counts as real evidence.
async function testVerifyBeforeCompletionStaysSetAfterReadingADifferentFile(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-vbc-reread-other-"))
	try {
		await fs.writeFile(path.join(ws, "server.py"), "def health():\n    return 'ok'\n", "utf-8")
		await fs.writeFile(path.join(ws, "other.py"), "x = 1\n", "utf-8")
		const client = new FakeLlmClient([
			() =>
				toolCall("edit_file", {
					file_path: "server.py",
					old_string: "this text does not appear in the file",
					new_string: "replacement",
				}),
			() => toolCall("read_file", { path: "other.py" }),
			() => toolCall("attempt_completion", { result: "Done (but server.py was never actually fixed)." }),
			() =>
				toolCall("edit_file", {
					file_path: "server.py",
					old_string: "def health():",
					new_string: "def health(): # fixed",
				}),
			() => toolCall("attempt_completion", { result: "Done for real." }),
		])
		const session = await makeSession({
			task: "fix server.py",
			client,
			workspaceRoot: ws,
			verifyBeforeCompletion: true,
			consecutiveErrorLimit: 20,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done for real.")
		assert.equal(client.requests.length, 5, "reading a different file must not clear the stale failure")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// 2026-09-02 (same-day follow-up to the re-read clearing above): the re-read
// escape hatch assumes a model that re-reads the file it failed to edit has
// concluded "no edit needed" and is about to finish honestly. Verified live
// (followthrough sweep, "add an entry to a JSON array" case): edit_file
// failed, the model re-read tasks.json exactly as the hatch expects, then
// called attempt_completion claiming *"I added {...} to the tasks array in
// tasks.json"* — an edit it never landed. The re-read had cleared the flag
// so the fabricated completion sailed through. Fix: when the flag was
// cleared by a re-read ONLY (no successful write since) AND the completion
// prose still asserts an edit was made, defer it.
async function testVerifyBeforeCompletionDefersEditClaimAfterReReadOnly(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-vbc-reread-claim-"))
	try {
		await fs.writeFile(path.join(ws, "tasks.json"), '{\n  "tasks": [\n    {"id": 6, "name": "build"}\n  ]\n}\n', "utf-8")
		const client = new FakeLlmClient([
			() =>
				toolCall("edit_file", {
					file_path: "tasks.json",
					// Deliberately does not appear in the file — this edit fails.
					old_string: '{"id": 6, "name": "build"},\n    {"id": 7, "name": "lint"}',
					new_string: '{"id": 6, "name": "build"},\n    {"id": 7, "name": "lint"},\n    {"id": 8}',
				}),
			// Re-reads the exact file the edit failed on — the shape the
			// re-read hatch treats as "concluded no edit needed".
			() => toolCall("read_file", { path: "tasks.json" }),
			// ...but then claims the edit was actually made.
			() =>
				toolCall("attempt_completion", {
					result: 'I added {"id": 7, "name": "lint"} to the tasks array in tasks.json.',
				}),
			// After the deferral: actually land the edit, then finish honestly.
			() =>
				toolCall("edit_file", {
					file_path: "tasks.json",
					old_string: '    {"id": 6, "name": "build"}\n',
					new_string: '    {"id": 6, "name": "build"},\n    {"id": 7, "name": "lint"}\n',
				}),
			() => toolCall("attempt_completion", { result: 'Added the {"id": 7, "name": "lint"} entry to tasks.json.' }),
		])
		const session = await makeSession({
			task: "add an entry to the JSON array",
			client,
			workspaceRoot: ws,
			verifyBeforeCompletion: true,
			consecutiveErrorLimit: 20,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, 'Added the {"id": 7, "name": "lint"} entry to tasks.json.')
		assert.equal(client.requests.length, 5, "the edit-claim completion must be deferred until a real write lands")
		const written = await fs.readFile(path.join(ws, "tasks.json"), "utf-8")
		assert.match(written, /"id": 7/, "the entry must actually be on disk before the completion is accepted")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// The companion to the test above: a re-read followed by an HONEST "no edit
// was needed" completion (no change verb) must still be accepted on the
// first try — the narrow prose check must not swallow the legitimate case
// the re-read hatch was built for.
async function testVerifyBeforeCompletionAcceptsHonestNoOpAfterReReadOnly(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-vbc-reread-noop-"))
	try {
		await fs.writeFile(path.join(ws, "server.py"), "def health():\n    return 'ok'\n", "utf-8")
		const client = new FakeLlmClient([
			() =>
				toolCall("edit_file", {
					file_path: "server.py",
					old_string: "this text does not appear in the file",
					new_string: "replacement",
				}),
			() => toolCall("read_file", { path: "server.py" }),
			() =>
				toolCall("attempt_completion", {
					result: "The /health endpoint already exists and returns 'ok'; no change was required.",
				}),
		])
		const session = await makeSession({
			task: "add a /health endpoint",
			client,
			workspaceRoot: ws,
			verifyBeforeCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `honest no-op completion must pass, got ${JSON.stringify(result)}`)
		assert.equal(client.requests.length, 3, "no extra deferral round-trip for an honest no-op")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// 2026-09-02: real, confirmed gap — a verifyBeforeCompletion deferral for a
// failure that genuinely never gets fixed had NO bounded-failure kill-switch
// at all (unlike the identical-tool-call-streak case issue #26 already
// covers), so it could spin all the way to the iteration cap on unchanging
// identical deferrals with zero new information each turn. Verified live
// this could run 15+ turns burning real tokens/time for nothing.
async function testVerifyBeforeCompletionBoundedFailureOnRepeatedIdenticalDeferral(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-vbc-spin-"))
	try {
		await fs.writeFile(path.join(ws, "server.py"), "def health():\n    return 'ok'\n", "utf-8")
		const client = new FakeLlmClient([
			() =>
				toolCall("edit_file", {
					file_path: "server.py",
					old_string: "this text does not appear in the file",
					new_string: "replacement",
				}),
			// The model just keeps re-attempting completion with no
			// corrective action and no re-read — the failure never gets a
			// chance to be genuinely resolved or re-verified.
			...Array.from({ length: 10 }, () => () => toolCall("attempt_completion", { result: "Done." })),
		])
		const session = await makeSession({
			task: "fix server.py",
			client,
			workspaceRoot: ws,
			verifyBeforeCompletion: true,
			consecutiveErrorLimit: 3,
		})
		const result = await session.run()

		assert.equal(result.status, "error", `expected a bounded failure instead of spinning, got ${JSON.stringify(result)}`)
		assert.match((result as { error: string }).error, /consecutive completion deferrals/)
		assert.ok(
			client.requests.length < 10,
			`must stop well before exhausting all 11 scripted responses, made ${client.requests.length} requests`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Issue #143: verified live 2026-08-21 (twice, word-for-word identical
// both times) — a session claimed "I have completed the task... and
// implemented the identified modification" having called only
// list_files/read_file/update_todo_list/a failed ask_followup_question.
// No execute_command, write_to_file, or edit_file call ever happened.
// requireArtifactBeforeCompletion must refuse that, then accept once a
// real artifact-producing call actually occurs — even a FAILED one (an
// attempt still proves the session tried; lastWriteToolFailed/
// lastExecuteCommandFailed above separately catch a failed attempt).
async function testRequireArtifactBeforeCompletionRefusesWithNoRealToolCall(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-artifact-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("list_files", { path: "." }),
			() => toolCall("attempt_completion", { result: "I have implemented the fix." }),
			() => toolCall("execute_command", { command: "true" }),
			() => toolCall("attempt_completion", { result: "Done for real." }),
		])
		const session = await makeSession({
			task: "fix something",
			client,
			workspaceRoot: ws,
			requireArtifactBeforeCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done for real.")
		assert.equal(client.requests.length, 4, "the false completion must not end the session early")
		const nudge = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("was NOT accepted"),
		)
		assert.ok(nudge, "expected a nudge telling the model it has not made any real change yet")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRequireArtifactBeforeCompletionAcceptsAfterFailedAttempt(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-artifact2-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "exit 1" }),
			() => toolCall("attempt_completion", { result: "Done, I tried the command." }),
		])
		const session = await makeSession({
			task: "run something",
			client,
			workspaceRoot: ws,
			requireArtifactBeforeCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done, I tried the command.")
		assert.equal(
			client.requests.length,
			2,
			"a failed-but-real attempt already satisfies requireArtifactBeforeCompletion; only verifyBeforeCompletion (a separate flag, off here) would still refuse",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// 2026-09-02: verified live (fabrication sweep, e1000 case) — a session
// that NEVER calls a real artifact tool but keeps re-issuing
// attempt_completion (generating a large inline "report" each turn) spun
// 17+ iterations / 971s before the duration cap killed it, because the
// requireArtifactBeforeCompletion deferral had no bounded-failure
// kill-switch of its own. It must end as a bounded failure once the
// deferral repeats consecutiveErrorLimit times.
async function testRequireArtifactBeforeCompletionBoundedFailureOnRepeatedDeferral(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-artifact-spin-"))
	try {
		const client = new FakeLlmClient([
			...Array.from({ length: 12 }, () => () => toolCall("attempt_completion", { result: "The gate passed, report below." })),
		])
		const session = await makeSession({
			task: "add the driver and run the gate",
			client,
			workspaceRoot: ws,
			requireArtifactBeforeCompletion: true,
			consecutiveErrorLimit: 3,
		})
		const result = await session.run()

		assert.equal(result.status, "error", `expected a bounded failure instead of spinning, got ${JSON.stringify(result)}`)
		assert.match((result as { error: string }).error, /no artifact-producing tool call ever made/)
		assert.ok(
			client.requests.length < 12,
			`must stop well before exhausting all 12 scripted responses, made ${client.requests.length}`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Research-harness primitive (product direction 2026-08-21): a session can
// call SOME write tool (satisfying requireArtifactBeforeCompletion above)
// while never producing the ACTUAL expected deliverable. Live-observed: a
// stage-1 research session kept claiming "analysis complete" with no file
// ever written to plans/research/. requireArtifactPathPattern checks the
// REAL filesystem for a specific glob, not tool-call bookkeeping.
async function testRequireArtifactPathPatternRefusesUntilRealFileExists(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-artifact-path-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "Analysis complete, no changes needed." }),
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content: "# A real finding\n\nSome real content.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the research doc." }),
		])
		const session = await makeSession({
			task: "research something and write a finding",
			client,
			workspaceRoot: ws,
			requireArtifactPathPattern: "plans/research/*.md",
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Wrote the research doc.")
		assert.equal(client.requests.length, 3, "the premature completion must not end the session early")
		const nudge = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("was NOT accepted"),
		)
		assert.ok(nudge, "expected a nudge naming the missing file pattern")
		const realFile = await fs.readFile(path.join(ws, "plans/research/finding.md"), "utf-8")
		assert.ok(realFile.includes("Some real content."), "the real file must actually exist with real content")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRequireArtifactPathPatternAcceptsAnEmptyDirWrongFile(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-artifact-path2-"))
	try {
		const client = new FakeLlmClient([
			() =>
				toolCall("write_to_file", {
					path: "plans/research/notes.txt",
					content: "wrong extension, should not satisfy the .md glob",
				}),
			() => toolCall("attempt_completion", { result: "Done (wrong file)." }),
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content: "# Real finding\n",
				}),
			() => toolCall("attempt_completion", { result: "Done for real." }),
		])
		const session = await makeSession({
			task: "research something",
			client,
			workspaceRoot: ws,
			requireArtifactPathPattern: "plans/research/*.md",
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done for real.")
		assert.equal(
			client.requests.length,
			4,
			"a wrong-extension file in the same directory must not satisfy the glob",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Product direction 2026-08-21: file-existence alone can still be a
// contentless stub — requireArtifactMinCitations forces the deliverable
// to contain real file:line-shaped evidence (e.g. "src/engine/loop.ts:42"),
// not just a title and unverified prose.
// Citations must point at REAL files that genuinely exist in the session's
// own workspace (issue #152: a citation-shaped string used to count toward
// requireArtifactMinCitations even when the file didn't exist) — creates
// two small real fixture files a test's citations can verifiably reference.
async function writeCitationFixtureFiles(ws: string): Promise<void> {
	await fs.mkdir(path.join(ws, "src"), { recursive: true })
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
	await fs.writeFile(path.join(ws, "src", "example.ts"), lines(60))
	await fs.writeFile(path.join(ws, "src", "other.ts"), lines(150))
}

async function testRequireArtifactMinCitationsRefusesAStubDoc(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-citations-"))
	try {
		await writeCitationFixtureFiles(ws)
		const client = new FakeLlmClient([
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content: "# A finding\n\nSomething is probably wrong somewhere, I think.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the stub." }),
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content:
						"# A finding\n\nReal evidence: src/example.ts:42 shows the bug, " +
						"and src/other.ts:100-110 confirms it.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the real doc." }),
		])
		const session = await makeSession({
			task: "research something and cite real evidence",
			client,
			workspaceRoot: ws,
			requireArtifactPathPattern: "plans/research/*.md",
			requireArtifactMinCitations: 2,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Wrote the real doc.")
		assert.equal(client.requests.length, 4, "the citation-less stub must not satisfy the gate")
		const nudge = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("Your NEXT tool call must be edit_file"),
		)
		assert.ok(nudge, "expected a nudge specifically naming the missing-citations reason and the required next action")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Live-verified 2026-08-21: a real, well-cited document can still be a
// general SURVEY rather than the specific scoped proposal the task asked
// for. requireArtifactSections forces required headings/content to exist,
// not just citations.
async function testRequireArtifactSectionsRefusesASurveyWithoutAProposal(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-sections-"))
	try {
		await writeCitationFixtureFiles(ws)
		const client = new FakeLlmClient([
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content: "# Survey\n\nsrc/example.ts:42 does a thing. src/other.ts:10 does another.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the survey." }),
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content:
						"# Finding\n\nsrc/example.ts:42 has a bug, confirmed against src/other.ts:10.\n\n" +
						"## What to build\n\nFix the bug.\n\n## What NOT to do\n\nDon't touch anything else.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the real proposal." }),
		])
		const session = await makeSession({
			task: "research something and propose a concrete fix",
			client,
			workspaceRoot: ws,
			requireArtifactPathPattern: "plans/research/*.md",
			requireArtifactMinCitations: 2,
			requireArtifactSections: ["What to build", "What NOT to do"],
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Wrote the real proposal.")
		assert.equal(client.requests.length, 4, "a cited-but-sectionless survey must not satisfy the gate")
		const nudge = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("missing required section"),
		)
		assert.ok(nudge, "expected a nudge naming the missing sections")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Artifact-rejection guardrail (issue #152) ───────────────────────────────
// requireArtifactMinCitations/Sections check presence, not truth — a session
// can patch in exactly the missing surface feature (a citation-shaped
// string, a required heading) without ever re-reading anything. This
// guardrail (DEFAULT_ARTIFACT_REJECTION_NUDGE_THRESHOLD) tracks consecutive
// rejections since the last real read_file call and escalates to an
// explicit nudge naming the pattern.

async function testArtifactRejectionNudgeFiresWithoutRereading(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-artifact-nudge-"))
	try {
		await writeCitationFixtureFiles(ws)
		const client = new FakeLlmClient([
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content: "# A finding\n\nSomething is probably wrong somewhere, I think.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the stub." }), // rejection 1 (0 citations)
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content: "# A finding\n\nsrc/example.ts:1 shows something.\n",
				}),
			() => toolCall("attempt_completion", { result: "Added one citation." }), // rejection 2 -> nudge fires
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content:
						"# A finding\n\nReal evidence: src/example.ts:42 shows the bug, " +
						"and src/other.ts:100-110 confirms it.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the real doc." }),
		])
		const session = await makeSession({
			task: "research something and cite real evidence",
			client,
			workspaceRoot: ws,
			requireArtifactPathPattern: "plans/research/*.md",
			requireArtifactMinCitations: 2,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Wrote the real doc.")
		const nudge = session.state.messages.find(
			(m) => m.role === "user" && (m.content ?? "").includes("read_file call in between"),
		)
		assert.ok(nudge, "expected the artifact-rejection nudge after 2 consecutive rejections with no read_file")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testArtifactRejectionNudgeSuppressedByARealRead(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-artifact-nudge-reset-"))
	try {
		await writeCitationFixtureFiles(ws)
		const client = new FakeLlmClient([
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content: "# A finding\n\nSomething is probably wrong somewhere, I think.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the stub." }), // rejection 1 (0 citations)
			() => toolCall("read_file", { path: "src/example.ts" }), // real re-diagnosis -> resets the streak
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content: "# A finding\n\nsrc/example.ts:1 shows something.\n",
				}),
			() => toolCall("attempt_completion", { result: "Added one citation." }), // rejection 2, but streak was reset
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content:
						"# A finding\n\nReal evidence: src/example.ts:42 shows the bug, " +
						"and src/other.ts:100-110 confirms it.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the real doc." }),
		])
		const session = await makeSession({
			task: "research something and cite real evidence",
			client,
			workspaceRoot: ws,
			requireArtifactPathPattern: "plans/research/*.md",
			requireArtifactMinCitations: 2,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		const nudge = session.state.messages.find(
			(m) => m.role === "user" && (m.content ?? "").includes("read_file call in between"),
		)
		assert.ok(!nudge, "a real read_file between rejections must suppress the nudge")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Issue #152: a citation-shaped string used to count toward
// requireArtifactMinCitations even when the cited file was completely
// fabricated (didn't exist at all) — live-verified 2026-08-21 that a real
// document passed this gate with citations carrying real line numbers but
// WRONG file paths pointing at nothing. countVerifiedCitations now checks
// each citation's file:line genuinely exists before counting it.
async function testRequireArtifactMinCitationsRejectsFabricatedFileCitations(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-fakecite-"))
	try {
		await writeCitationFixtureFiles(ws)
		const client = new FakeLlmClient([
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content:
						"# A finding\n\nFabricated evidence: src/does/not/exist.ts:42 shows the bug, " +
						"and src/also/fake.ts:10-20 confirms it. Two citation-shaped strings, zero real files.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the fabricated-citation doc." }),
			() =>
				toolCall("write_to_file", {
					path: "plans/research/finding.md",
					content:
						"# A finding\n\nReal evidence: src/example.ts:42 shows the bug, " +
						"and src/other.ts:100-110 confirms it.\n",
				}),
			() => toolCall("attempt_completion", { result: "Wrote the real doc." }),
		])
		const session = await makeSession({
			task: "research something and cite real evidence",
			client,
			workspaceRoot: ws,
			requireArtifactPathPattern: "plans/research/*.md",
			requireArtifactMinCitations: 2,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Wrote the real doc.")
		assert.equal(
			client.requests.length,
			4,
			"citation-shaped strings pointing at files that don't exist must NOT satisfy the gate, even with real line numbers",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Qwen2.5-Coder-14B was observed live (2026-08-19) reasoning correctly
// about a tool call, then writing it as prose instead of using the native
// tool_calls channel — e.g. a fenced ```json block containing
// {"name": "write_to_file", "arguments": {...}}. requireExplicitCompletion
// sessions now recover and execute a text-embedded call, but ONLY when its
// name matches a real tool in the session's catalog.
async function testRecoversTextEmbeddedToolCallForRealTool(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-embed-"))
	try {
		const client = new FakeLlmClient([
			() =>
				textReply(
					'I will write the file now.\n\n```json\n{"name": "write_to_file", "arguments": {\'path\': \'hello.txt\', \'content\': \'hi there\'}}\n```',
				),
			() => toolCall("attempt_completion", { result: "Done: wrote hello.txt" }),
		])
		const session = await makeSession({
			task: "write a hello file",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const content = await fs.readFile(path.join(ws, "hello.txt"), "utf-8")
		assert.equal(content, "hi there", "the text-embedded call must have actually executed write_to_file")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// A different observed shape (same 2026-08-19 session): the model
// narrating in past tense that it already called a tool — no JSON blob at
// all, just "[Called tool "read_file" with arguments {...}]" — when no
// such call was ever made. Still recovered and actually executed, same
// real-tool-name safety gate as the JSON shape.
async function testRecoversNarratedToolCall(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-embed3-"))
	try {
		await fs.writeFile(path.join(ws, "notes.txt"), "line one\nline two\n")
		const client = new FakeLlmClient([
			() =>
				textReply(
					"I'll check the file first.\n\n[Called tool \"read_file\" with arguments {'path': 'notes.txt', 'mode': 'slice'}]",
				),
			() => toolCall("attempt_completion", { result: "Done: read notes.txt" }),
		])
		const session = await makeSession({
			task: "look at notes.txt",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const toolMsg = session.state.messages.find((m) => m.role === "tool")
		assert.ok(toolMsg, "expected a real tool message from the recovered read_file call")
		assert.match(toolMsg?.content ?? "", /line one/, "the recovered call must have actually read the file")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDoesNotExecuteEmbeddedCallForUnknownToolName(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-embed2-"))
	try {
		const client = new FakeLlmClient([
			() => textReply('Here is my plan: {"name": "delete_everything", "arguments": {"path": "/"}}'),
			() => toolCall("attempt_completion", { result: "Done: recovered from the bad suggestion" }),
		])
		const session = await makeSession({
			task: "write a hello file",
			client,
			workspaceRoot: ws,
			requireExplicitCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(
			client.requests.length,
			2,
			"an unknown tool name must not be executed — the reply is nudged like any other text-only reply",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testScenario3ErroringToolBoundedFailure(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-s3-"))
	try {
		// Model keeps calling codebase_search with no index built yet — the
		// handler returns a clear "not indexed" error, so the loop still hits
		// its consecutive-mistake bound (the tool is real, the workspace just
		// has no index).
		const client = new FakeLlmClient([
			() => toolCall("codebase_search", { query: "x" }),
			() => toolCall("codebase_search", { query: "x" }),
			() => toolCall("codebase_search", { query: "x" }),
			() => toolCall("codebase_search", { query: "x" }),
		])
		const session = await makeSession({
			task: "search the codebase",
			client,
			workspaceRoot: ws,
			consecutiveErrorLimit: 3,
		})
		const result = await session.run()

		assert.equal(result.status, "error", "expected bounded failure")
		assert.match(result.error ?? "", /Bounded failure|consecutive/)
		assert.equal(result.iterations, 3, "should fail after exactly 3 consecutive errors")
		// Tool results were fed back as error tool messages.
		const toolMsgs = session.state.messages.filter((m) => m.role === "tool")
		assert.equal(toolMsgs.length, 3)
		assert.match(toolMsgs[0]?.content ?? "", /no codebase index|not indexed/i)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testScenario4MalformedJsonArgs(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-s4-"))
	try {
		// Malformed arguments -> parser fallback should recover something or mark
		// a parse error; either way the loop continues and completes.
		const client = new FakeLlmClient([
			() => toolCall("read_file", `{"path": "foo.txt", "offset": `), // truncated JSON
			() => toolCall("attempt_completion", { result: "recovered from malformed args" }),
		])
		const session = await makeSession({ task: "read a file", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.match(result.result ?? "", /recovered/)

		// Direct parser fallback check: truncated JSON recovers `path`.
		const parsed = parseToolCall(
			{ id: "c1", type: "function", function: { name: "read_file", arguments: `{"path": "foo.txt", "offset": ` } },
			0,
		)
		assert.equal(parsed.parseError, undefined, "fallback should recover partial args")
		assert.equal(parsed.args["path"], "foo.txt")

		// Totally garbage arguments -> parseError set.
		const garbage = parseToolCall(
			{ id: "c2", type: "function", function: { name: "read_file", arguments: "not json at all {{{" } },
			0,
		)
		assert.ok(garbage.parseError, "garbage args should be marked as a parse error")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPathTraversalGuard(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-pt-"))
	try {
		const executor = createHeadlessExecutor(ws)

		// read_file with "../outside" must be rejected.
		const read = await executor.execute("read_file", { path: "../outside.txt" })
		assert.equal(read.isError, true)
		assert.match(read.content, /escapes the workspace|Error/)

		// write_to_file with an escaping path must be rejected.
		const write = await executor.execute("write_to_file", { path: "../evil.txt", content: "x" })
		assert.equal(write.isError, true)

		// Absolute path outside the root must be rejected.
		const abs = await executor.execute("read_file", { path: "/etc/passwd" })
		assert.equal(abs.isError, true)

		// A path inside the root still works.
		await executor.execute("write_to_file", { path: "ok.txt", content: "fine" })
		const inside = await executor.execute("read_file", { path: "ok.txt" })
		assert.equal(inside.isError, false)
		assert.match(inside.content, /fine/)

		// list_files also guards.
		const list = await executor.execute("list_files", { path: "../" })
		assert.equal(list.isError, true)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMaxIterationsBound(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-mi-"))
	try {
		// Model keeps succeeding (distinct successful commands, so no
		// consecutive-mistake trigger) but never calls attempt_completion nor
		// replies with a final text answer — the loop must stop at maxIterations.
		const client = new FakeLlmClient(
			Array.from({ length: 20 }, (_, i) => () =>
				toolCall("execute_command", { command: `node -e 'console.log(${i})'` }),
			),
		)
		const session = await makeSession({ task: "loop forever", client, workspaceRoot: ws, maxIterations: 4 })
		const result = await session.run()
		assert.equal(result.status, "error", `expected max-iterations failure, got ${JSON.stringify(result)}`)
		assert.match(result.error ?? "", /Max iterations/)
		assert.equal(result.iterations, 4)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Main-loop retry on a transient provider error ───────────────────────────
// A hard-pinned model (deepseek/*, allow_fallbacks: false) has no fallback
// provider to smooth over a blip, so callMainLlm retries ONCE on a
// classified-transient error (isRetryableOpenRouterError) before giving up —
// see the doc comment on callMainLlm in loop.ts. Observed live: an HTTP 520
// mid-session used to kill the entire session outright with iteration
// budget otherwise untouched.

async function testMainLlmCallRetriesOnceOnTransientProviderError(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-main-retry-"))
	try {
		let calls = 0
		const client = new FakeLlmClient([
			() => {
				calls++
				throw new OpenRouterError("Provider returned error", 520)
			},
			() => {
				calls++
				return toolCall("attempt_completion", { result: "done after retry" })
			},
		])
		const session = await makeSession({ task: "retry me", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success after the retry, got ${JSON.stringify(result)}`)
		assert.equal(calls, 2, "expected exactly one retry (2 total calls) for a single transient failure")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMainLlmCallFailsAfterRetryAlsoFails(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-main-retry-fail-"))
	try {
		let calls = 0
		const client = new FakeLlmClient([
			() => {
				calls++
				throw new OpenRouterError("Provider returned error", 520)
			},
			() => {
				calls++
				throw new OpenRouterError("Provider returned error", 520)
			},
		])
		const session = await makeSession({ task: "retry me twice", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "error", "a second consecutive failure must still fail the session (only one retry)")
		assert.equal(calls, 2, "exactly two attempts — no unbounded retry loop")
		assert.equal(result.iterations, 1, "the session never advanced past iteration 1")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMainLlmCallDoesNotRetryDeterministicError(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-main-no-retry-"))
	try {
		let calls = 0
		const client = new FakeLlmClient([
			() => {
				calls++
				throw new OpenRouterError("Invalid API key", 401)
			},
			() => {
				calls++
				return toolCall("attempt_completion", { result: "should never be reached" })
			},
		])
		const session = await makeSession({ task: "auth failure", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "error", "a deterministic 401 must fail immediately")
		assert.equal(calls, 1, "no retry attempted for a non-retryable error")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testIterationCapHandoffSummary(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-handoff-"))
	try {
		// 4 tool-call iterations to exhaust maxIterations, then ONE more script
		// step: the loop's own condensation call for the handoff write (see
		// writeIterationCapHandoff in loop.ts), which must get a real text
		// answer back (condenseOldestTurns rejects an empty/tool-call reply).
		const client = new FakeLlmClient([
			...Array.from({ length: 4 }, (_, i) => () => toolCall("execute_command", { command: `node -e 'console.log(${i})'` })),
			() => ({ role: "assistant", content: "Read useConversations.ts; the fix belongs in refresh()." }),
		])
		const session = await makeSession({ task: "loop forever", client, workspaceRoot: ws, maxIterations: 4 })
		const result = await session.run()
		assert.equal(result.status, "error", `expected max-iterations failure, got ${JSON.stringify(result)}`)

		const handoffPath = path.join(ws, ".headlesscode", "handoff-summary.md")
		const content = await fs.readFile(handoffPath, "utf-8")
		assert.match(content, /Handoff summary/)
		assert.match(content, /Read useConversations\.ts; the fix belongs in refresh\(\)\./)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testIterationCapHandoffSummaryNonFatalWhenCondenseCallFails(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-handoff-short-"))
	try {
		// maxIterations: 1, and the script has exactly ONE step (consumed by
		// that one iteration) — none left for the handoff write's own
		// condensation call, which now retries ONCE (a live round hit DeepSeek's
		// pinned endpoint erroring transiently on this exact call — see
		// writeIterationCapHandoff), so BOTH the first attempt and the retry
		// throw "script exhausted". That failure must still be swallowed
		// (non-fatal): the session's own max-iterations result is unaffected
		// and no handoff file is written.
		const client = new FakeLlmClient([() => toolCall("execute_command", { command: "true" })])
		const session = await makeSession({ task: "short", client, workspaceRoot: ws, maxIterations: 1 })
		const result = await session.run()
		assert.equal(result.status, "error")
		assert.match(result.error ?? "", /Max iterations/)

		await assert.rejects(fs.access(path.join(ws, ".headlesscode", "handoff-summary.md")))
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testIterationCapHandoffSummaryRetriesOnceAfterCondenseFailure(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-handoff-retry-"))
	try {
		// First condensation attempt throws (simulating the live DeepSeek
		// "no allowed providers" blip); the retry succeeds and the handoff
		// summary is written from the retry's response.
		let condenseAttempts = 0
		const client = new FakeLlmClient([
			...Array.from({ length: 4 }, (_, i) => () => toolCall("execute_command", { command: `node -e 'console.log(${i})'` })),
			() => {
				condenseAttempts++
				throw new Error("simulated transient provider error")
			},
			() => {
				condenseAttempts++
				return { role: "assistant" as const, content: "Retry succeeded: root cause is in refresh()." }
			},
		])
		const session = await makeSession({ task: "loop forever", client, workspaceRoot: ws, maxIterations: 4 })
		const result = await session.run()
		assert.equal(result.status, "error")
		assert.equal(condenseAttempts, 2, "expected exactly one retry after the first condensation failure")

		const content = await fs.readFile(path.join(ws, ".headlesscode", "handoff-summary.md"), "utf-8")
		assert.match(content, /Retry succeeded: root cause is in refresh\(\)\./)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Blind tree-walking guardrail (P1.6) ─────────────────────────────────────

const NUDGE_FRAGMENT = "You've made several read/exploration calls"

/** Indexed fixture: files f1..fn plus a non-empty `.headlesscode/codesearch/index.jsonl`. */
async function makeIndexedWorkspace(prefix: string, n: number): Promise<string> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
	await fs.mkdir(path.join(ws, ".headlesscode", "codesearch"), { recursive: true })
	for (let i = 1; i <= n; i++) {
		await fs.writeFile(path.join(ws, `f${i}.txt`), `content ${i}\n`)
	}
	// Non-empty is all hasCodebaseIndex() requires — the guardrail only
	// checks existence, it never queries the index.
	await fs.writeFile(path.join(ws, ".headlesscode", "codesearch", "index.jsonl"), '{"dummy":true}\n')
	return ws
}

function requestsContainingNudge(requests: LlmRequest[]): number[] {
	return requests
		.map((r, i) => (r.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(NUDGE_FRAGMENT)) ? i : -1))
		.filter((i) => i >= 0)
}

async function testReadOnlyNudgeTriggered(): Promise<void> {
	const ws = await makeIndexedWorkspace("headlesscode-nudge-", 9)
	try {
		// 8 consecutive read_file iterations (distinct paths, so no
		// identical-repeat mistakes) then completion. The nudge must be
		// injected at the end of iteration 8 and visible in the 9th request.
		const client = new FakeLlmClient([
			...Array.from({ length: 8 }, (_, i) => () => toolCall("read_file", { path: `f${i + 1}.txt` })),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.ok(client.requests.length >= 9, `expected >=9 requests, got ${client.requests.length}`)
		const nudged = requestsContainingNudge(client.requests)
		assert.deepEqual(nudged, [8], "nudge should appear exactly once, in the request after the 8th read-only iteration")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyNudgeResetsOnProductiveCall(): Promise<void> {
	const ws = await makeIndexedWorkspace("headlesscode-nudge-reset-", 12)
	try {
		// 4 read-only (below threshold), a write_to_file resets the streak,
		// then 8 more read-only re-trigger the nudge. The write at iteration
		// 5 means the second streak ends at iteration 13, so the nudge shows
		// up in request 14 (index 13).
		const client = new FakeLlmClient([
			() => toolCall("read_file", { path: "f1.txt" }),
			() => toolCall("read_file", { path: "f2.txt" }),
			() => toolCall("read_file", { path: "f3.txt" }),
			() => toolCall("read_file", { path: "f4.txt" }),
			() => toolCall("write_to_file", { path: "out.txt", content: "reset" }),
			...Array.from({ length: 8 }, (_, i) => () => toolCall("read_file", { path: `f${i + 5}.txt` })),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore", client, workspaceRoot: ws, maxIterations: 20 })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const nudged = requestsContainingNudge(client.requests)
		assert.deepEqual(nudged, [13], "nudge should fire only AFTER the write_to_file reset, on the second 8-call streak")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyNudgeInjectedWhenUnindexed(): Promise<void> {
	// Regression (round w3, issue #103, 2026-08-16): the guardrail was gated
	// on hasCodebaseIndex() and so was INERT on the unindexed workspaces where
	// grep-spirals are worst — ~200 pure read-only iterations replaced one
	// run_tests call. The nudge must now fire there too, leading with progress
	// (run_tests) since there is no codebase_search to point at.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-nudge-noindex-"))
	try {
		for (let i = 1; i <= 9; i++) {
			await fs.writeFile(path.join(ws, `f${i}.txt`), `content ${i}\n`)
		}
		const client = new FakeLlmClient([
			...Array.from({ length: 9 }, (_, i) => () => toolCall("read_file", { path: `f${i + 1}.txt` })),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.deepEqual(
			requestsContainingNudge(client.requests),
			[8, 9],
			"unindexed workspace still gets the nudge after 8 read-only iterations (and it persists for the rest of the session)",
		)
		const nudgeMsg = client.requests[8].messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.includes(NUDGE_FRAGMENT),
		)
		assert.ok(nudgeMsg && typeof nudgeMsg.content === "string", "nudge message present in the 9th request")
		assert.ok(nudgeMsg.content.includes("run_tests"), "unindexed nudge leads with run_tests (no index to point at)")
		assert.ok(!nudgeMsg.content.includes("codebase_search"), "unindexed nudge must not suggest codebase_search")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyNudgeTriggeredByGrepStyleExecuteCommand(): Promise<void> {
	const ws = await makeIndexedWorkspace("headlesscode-nudge-grep-", 1)
	try {
		// A live round (issue: harness slowness investigation) measured
		// execute_command grep/ls/sed one-liners as the DOMINANT exploration
		// pattern, far more than read_file/list_files — this guardrail must
		// count that pattern too, not just the literal read_file/list_files
		// tool names (see isReadOnlyEquivalentShellCommand).
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "grep -rn content . | head -20" }),
			() => toolCall("execute_command", { command: "ls ." }),
			() => toolCall("execute_command", { command: "cat f1.txt" }),
			() => toolCall("execute_command", { command: "sed -n '1,1p' f1.txt" }),
			() => toolCall("execute_command", { command: "git log --oneline -5 || true" }),
			() => toolCall("execute_command", { command: "git status --short || true" }),
			() => toolCall("execute_command", { command: "echo simulated-docker-compose-ps" }),
			() => toolCall("execute_command", { command: "find . -name '*.txt' | head" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.deepEqual(
			requestsContainingNudge(client.requests),
			[8],
			"8 consecutive read-only-equivalent execute_command calls should trip the nudge, same as read_file",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyNudgeNotTrippedByMutatingExecuteCommand(): Promise<void> {
	const ws = await makeIndexedWorkspace("headlesscode-nudge-mutating-", 1)
	try {
		// Same 8-call length as the triggering case above, but one call is a
		// real mutation (docker compose UP, not ps) — the whole streak must
		// never count, exactly like a write_to_file resets it.
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "grep -rn content . | head -20" }),
			() => toolCall("execute_command", { command: "ls ." }),
			() => toolCall("execute_command", { command: "echo hi > mutated.txt" }), // mutating: writes a file
			() => toolCall("execute_command", { command: "sed -n '1,1p' f1.txt" }),
			() => toolCall("execute_command", { command: "git log --oneline -5 || true" }),
			() => toolCall("execute_command", { command: "git status --short || true" }),
			() => toolCall("execute_command", { command: "find . -name '*.txt' | head" }),
			() => toolCall("execute_command", { command: "cat f1.txt" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.deepEqual(requestsContainingNudge(client.requests), [], "one mutating command in the streak must suppress the nudge")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Read-only stagnation stall limit ────────────────────────────────────────

async function testReadOnlyStallLimitTerminates(): Promise<void> {
	// The w3 failure shape, on an unindexed workspace: ~200 consecutive
	// grep-style read-only iterations. The hard stall limit (default 75) must
	// end the session with a bounded failure long before the iteration cap.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-stall-"))
	try {
		const client = new FakeLlmClient([
			...Array.from({ length: 90 }, (_, i) => () =>
				toolCall("execute_command", { command: `grep -rn 'pat${i}' . | head` })),
		])
		const session = await makeSession({ task: "verify forever", client, workspaceRoot: ws, maxIterations: 250 })
		const result = await session.run()

		assert.equal(result.status, "error", `expected bounded failure, got ${JSON.stringify(result)}`)
		assert.match(result.error ?? "", /read-only stagnation/)
		assert.equal(
			result.iterations,
			DEFAULT_READ_ONLY_STALL_LIMIT,
			`stall fires exactly at iteration ${DEFAULT_READ_ONLY_STALL_LIMIT}`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testReadOnlyStallLimitNotTrippedByProductiveInterleave(): Promise<void> {
	// 40 read-only, one edit, 40 read-only: neither streak approaches the 75
	// stall limit, so the session must complete normally (a soft nudge per
	// streak is expected — it never hard-stops a productive session).
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-stall-reset-"))
	try {
		const client = new FakeLlmClient([
			// `grep | head` pipelines exit 0 even with no matches, so no tool
			// errors and no consecutive-mistake noise (unlike read_file on a
			// path that does not exist).
			...Array.from({ length: 40 }, (_, i) => () =>
				toolCall("execute_command", { command: `grep -rn 'pat${i}' . | head` })),
			() => toolCall("write_to_file", { path: "out.txt", content: "reset" }),
			...Array.from({ length: 40 }, (_, i) => () =>
				toolCall("execute_command", { command: `grep -rn 'pat${i}' . | head` })),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "explore then write", client, workspaceRoot: ws, maxIterations: 250 })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Identical-consecutive-call guardrail ────────────────────────────────────
// Live evidence across several separate nights: a local model repeating the
// SAME tool call with the SAME arguments turn after turn — apply_diff with
// an identical failing diff, ask_followup_question with the identical
// generic question, and (2026-08-20, the trial that motivated this specific
// guardrail) list_files "." succeeding identically 86 times in a row before
// the much looser read-only-stall limit (75) finally caught it. Distinct
// from that guardrail: fires on non-read-only tools too, fires on a SUCCESS
// streak, and its threshold is tight since there's no legitimate reason for
// a truly identical back-to-back repeat to run long.

async function testIdenticalCallStallLimitTerminates(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-identical-"))
	try {
		const client = new FakeLlmClient([
			...Array.from({ length: 10 }, () => () => toolCall("list_files", { path: "." })),
		])
		const session = await makeSession({ task: "look around forever", client, workspaceRoot: ws, maxIterations: 250 })
		const result = await session.run()

		assert.equal(result.status, "error", `expected bounded failure, got ${JSON.stringify(result)}`)
		assert.match(result.error ?? "", /identical call repeated/)
		assert.equal(
			result.iterations,
			DEFAULT_IDENTICAL_CALL_STALL_LIMIT,
			`stall fires exactly at iteration ${DEFAULT_IDENTICAL_CALL_STALL_LIMIT}, not the much looser read-only limit`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testIdenticalCallStallLimitFiresOnWriteToolToo(): Promise<void> {
	// The apply_diff-repeating-the-identical-failing-diff shape: a WRITE tool,
	// erroring every time, repeated verbatim. The read-only-stall guardrail
	// would never catch this (apply_diff is not a read-only tool) — this one
	// must. A generous consecutiveErrorLimit isolates that it's specifically
	// the identical-call guard firing here, not the generic mistake limit
	// (which would otherwise legitimately fire first, at 3, since every
	// repeat is also an error — see the identical AND erroring case).
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-identical-write-"))
	try {
		const client = new FakeLlmClient([
			...Array.from({ length: 10 }, () => () => toolCall("apply_diff", { path: "nope.ts", diff: "broken" })),
		])
		const session = await makeSession({
			task: "keep retrying the same bad diff",
			client,
			workspaceRoot: ws,
			maxIterations: 250,
			consecutiveErrorLimit: 20,
		})
		const result = await session.run()

		assert.equal(result.status, "error", `expected bounded failure, got ${JSON.stringify(result)}`)
		assert.match(result.error ?? "", /identical call repeated/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Sampling-level companion to the text nudge (see
// DEFAULT_IDENTICAL_CALL_REPEAT_PENALTY_BOOST's doc comment): the request
// that immediately follows a detected repeat streak must itself carry the
// boosted repeat_penalty, not just an injected message — verified here at
// the request-shape level since the fake client can't demonstrate whether
// a real backend's sampling actually changes behavior.
async function testIdenticalCallStreakBoostsRepeatPenaltyOnRetry(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-identical-boost-"))
	try {
		const client = new FakeLlmClient([
			...Array.from({ length: 3 }, () => () => toolCall("list_files", { path: "." })),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "look around then finish",
			client,
			workspaceRoot: ws,
			maxIterations: 250,
		})
		await session.run()

		const boosts = client.requests.map((r) => r.repeatPenalty)
		// Iterations 1-2 (the first two identical list_files calls) see no
		// override yet — the streak only reaches the nudge threshold (2)
		// AFTER iteration 2 completes. From iteration 3 onward (the request
		// made once the streak is already >= threshold) every request must
		// carry the boost.
		assert.equal(boosts[0], undefined, "no boost on the very first call")
		assert.equal(boosts[1], undefined, "no boost yet on the 2nd call — streak becomes >= threshold only after it")
		assert.equal(
			boosts[2],
			DEFAULT_IDENTICAL_CALL_REPEAT_PENALTY_BOOST,
			"3rd call (streak already at threshold) must carry the boosted repeat_penalty",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Harder companion to the repeat_penalty boost (see callMainLlm's doc
// comment): verified live 2026-08-20 that repeat_penalty alone — at 1.3
// AND 1.8 — does not reliably stop this model repeating one tool call.
// Once the guard is active, the repeated tool's schema must be removed
// from the request's own `tools` array entirely, not merely discouraged.
async function testIdenticalCallStreakExcludesTheRepeatedToolOnRetry(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-identical-exclude-"))
	try {
		const client = new FakeLlmClient([
			...Array.from({ length: 3 }, () => () => toolCall("list_files", { path: "." })),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "look around then finish",
			client,
			workspaceRoot: ws,
			maxIterations: 250,
		})
		await session.run()

		const hasListFiles = client.requests.map((r) => (r.tools ?? []).some((t) => t.function.name === "list_files"))
		assert.equal(hasListFiles[0], true, "list_files still offered on the very first call")
		assert.equal(hasListFiles[1], true, "list_files still offered on the 2nd call — streak becomes >= threshold only after it")
		assert.equal(hasListFiles[2], false, "3rd call (streak already at threshold): list_files must be excluded entirely")
		const hasAttemptCompletion = client.requests.map((r) =>
			(r.tools ?? []).some((t) => t.function.name === "attempt_completion"),
		)
		assert.ok(
			hasAttemptCompletion.every(Boolean),
			"attempt_completion must never be excluded — it is the model's only escape hatch",
		)

		// tool_choice: "required" is wired (LlmRequest.toolChoice) but
		// deliberately NOT applied by callMainLlm — see its doc comment for
		// why: verified live to be inert for tool selection on this daemon's
		// handler, and implicated in a SEPARATE frozen-prompt artifact
		// unrelated to conversation history. Must never be set until that's
		// resolved.
		const toolChoices = client.requests.map((r) => r.toolChoice)
		assert.ok(
			toolChoices.every((tc) => tc === undefined),
			"tool_choice must never be forced — see callMainLlm's doc comment for why",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Verified live 2026-08-20: once the identical-call guard's tool exclusion
// kicked in, a trial's follow-up requests kept carrying the boosted
// repeat_penalty turn after turn even though the model had already stopped
// making tool calls entirely (shifted to text-only replies) — because the
// STREAK state only ever updates inside the `calls.length > 0` branch. This
// produced a run of consecutive genuinely-EMPTY generations. A text-only
// reply is definitionally not a repeat of the previous tool-call batch, so
// the streak (and the penalty boost it drives) must reset when one happens.
// The TOOL EXCLUSION itself is a separate, deliberately more persistent
// mechanism (see excludedToolCooldowns) and is NOT expected to clear here —
// that's covered by testToolExclusionCooldownOutlivesAStreakReset below.
async function testTextOnlyReplyResetsTheIdenticalCallGuard(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-identical-textreset-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("list_files", { path: "." }),
			() => toolCall("list_files", { path: "." }),
			// 3rd call: streak >= threshold, boost/exclusion active — but the
			// model replies with text instead of any tool call at all.
			() => textReply("thinking about what to do next..."),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "look around then finish",
			client,
			workspaceRoot: ws,
			maxIterations: 250,
			requireExplicitCompletion: true,
		})
		await session.run()

		// The 4th request is the one made right after the text-only reply —
		// the STREAK must have reset by then, not still be applying the
		// penalty boost from a streak that stopped incrementing two turns ago
		// (the tool exclusion itself is expected to persist — see above).
		const fourthRequest = client.requests[3]
		assert.equal(fourthRequest.repeatPenalty, undefined, "repeat_penalty boost must not still be active after a text-only reply")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Companion to the above: the exclusion cooldown is deliberately NOT reset
// by a text-only reply — verified live 2026-08-20 (trial 36) that without
// a cooldown, the model returns to the same denied tool on its very next
// real action and re-triggers exclusion 2 turns later, an indefinite
// exclude/retry oscillation (48+ cycles observed with no cooldown).
async function testToolExclusionCooldownOutlivesAStreakReset(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-identical-cooldown-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("list_files", { path: "." }),
			() => toolCall("list_files", { path: "." }),
			// 3rd call: streak >= threshold, exclusion active — model replies
			// with text, which resets the STREAK (see the test above) but must
			// NOT lift the exclusion immediately.
			() => textReply("thinking about what to do next..."),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "look around then finish",
			client,
			workspaceRoot: ws,
			maxIterations: 250,
			requireExplicitCompletion: true,
		})
		await session.run()

		const fourthRequest = client.requests[3]
		assert.ok(
			!(fourthRequest.tools ?? []).some((t) => t.function.name === "list_files"),
			"list_files must stay excluded through the cooldown — the streak resetting must not immediately lift it",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Tool-cooldown exact expiration (issue #151 coverage gap) ────────────────
// The test above only checks the tool STAYS excluded one turn after the
// cooldown starts — it never checks the cooldown's actual DURATION
// (DEFAULT_IDENTICAL_CALL_TOOL_COOLDOWN_TURNS = 4). Per the decay loop in
// loop.ts (runIterations): each request-build first decays every entry by 1,
// deleting it once `remaining <= 1` — so a cooldown set to 4 keeps the tool
// excluded on the 4 subsequent request-builds and is gone by the 5th,
// PROVIDED nothing re-triggers the identical-call guard in between (a
// continued streak refreshes it back to 4 instead of decaying — covered by
// the test above, not this one).

async function testToolExclusionCooldownExpiresAfterExactTurnCount(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cooldown-expiry-"))
	try {
		for (let i = 1; i <= 4; i++) {
			await fs.writeFile(path.join(ws, `f${i}.txt`), `content ${i}\n`)
		}
		const client = new FakeLlmClient([
			() => toolCall("list_files", { path: "." }),
			() => toolCall("list_files", { path: "." }),
			// Request 3 is built with list_files already excluded (streak hit
			// threshold after the 2 calls above) — the cooldown is set to 4 here.
			// Requests 3-6 must do something else so the guard never re-triggers
			// and the cooldown decays naturally: 4 -> 3 -> 2 -> 1 -> gone.
			() => toolCall("read_file", { path: "f1.txt" }),
			() => toolCall("read_file", { path: "f2.txt" }),
			() => toolCall("read_file", { path: "f3.txt" }),
			() => toolCall("read_file", { path: "f4.txt" }),
			// Request 7: the cooldown decayed past 1 on request 6's build and
			// was deleted before request 7 was built — list_files must be back.
			() => toolCall("list_files", { path: "." }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "look around, read some files, look around again",
			client,
			workspaceRoot: ws,
			maxIterations: 20,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		for (let i = 2; i <= 5; i++) {
			assert.ok(
				!(client.requests[i]?.tools ?? []).some((t) => t.function.name === "list_files"),
				`request index ${i} (turn ${i + 1}) must still exclude list_files — cooldown has not decayed to 0 yet`,
			)
		}
		assert.ok(
			(client.requests[6]?.tools ?? []).some((t) => t.function.name === "list_files"),
			"request index 6 (turn 7) must offer list_files again — the cooldown has fully decayed by now",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Verified live 2026-08-20 against Qwen3-14B: with list_files excluded from
// the request's own `tools` array (the identical-call guardrail's tool
// exclusion), llama.cpp's grammar constraint correctly refused to emit a
// genuine tool_calls entry for it — but the model narrated the SAME call as
// prose instead ("[Called tool \"list_files\" with arguments {...}]"), and
// extractEmbeddedToolCall's validation against the session's full default
// catalog (this.state.tools) let it through anyway, fully circumventing the
// exclusion. Fixed: validate against the tools actually offered on the
// request that just ran, not the unfiltered catalog.
async function testExcludedToolCannotBeRecoveredFromNarratedText(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-excluded-recovery-"))
	try {
		const narratedListFiles = '[Called tool "list_files" with arguments {\'path\': \'.\'}]'
		const client = new FakeLlmClient([
			() => toolCall("list_files", { path: "." }),
			() => toolCall("list_files", { path: "." }),
			// 3rd call: streak is now >= threshold, list_files is excluded from
			// the request's tools — the model narrates it as text instead.
			() => textReply(narratedListFiles),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "look around then finish",
			client,
			workspaceRoot: ws,
			maxIterations: 250,
			requireExplicitCompletion: true,
		})
		await session.run()

		// The LAST request's own message history is the complete accumulated
		// conversation — checking only it avoids double-counting the same
		// earlier tool-result messages that reappear in every later request.
		const finalMessages = client.requests[client.requests.length - 1].messages
		const listFilesCalls = finalMessages.filter((m) => m.role === "tool" && m.name === "list_files").length
		assert.equal(listFilesCalls, 2, "the narrated 3rd list_files call must NOT be recovered/executed as a real call")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Verified live 2026-08-21: a generic "try something different" nudge did
// NOT change the model's next action — it repeated the same call again
// right past the nudge, across several trials. Naming the concrete next
// todo-list step explicitly is a much more specific instruction.
async function testIdenticalCallNudgeNamesTheNextTodoStep(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-identical-todo-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("update_todo_list", { todos: "[x] Edit the file\n[ ] Write the test file\n[ ] Run tests" }),
			...Array.from({ length: 5 }, () => () => toolCall("list_files", { path: "." })),
		])
		const session = await makeSession({ task: "get distracted", client, workspaceRoot: ws, maxIterations: 250 })
		await session.run()

		const nudge = session.state.messages.find(
			(m) => m.role === "user" && (m.content ?? "").includes("times in a row with IDENTICAL arguments"),
		)
		assert.ok(nudge, "expected the identical-call nudge to have fired")
		assert.match(
			nudge?.content as string,
			/Write the test file/,
			"the nudge should name the concrete next pending todo step, not just generic advice",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testIdenticalCallStreakResetByAnyDifferentCall(): Promise<void> {
	// A genuine edit/verify/edit/verify workflow: `npx tsc --noEmit` repeats
	// several times but NEVER back-to-back — a different call (write_to_file)
	// always sits between two verification calls. Must never trip.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-identical-reset-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "a.ts", content: "v1" }),
			() => toolCall("execute_command", { command: "npx tsc --noEmit" }),
			() => toolCall("write_to_file", { path: "a.ts", content: "v2" }),
			() => toolCall("execute_command", { command: "npx tsc --noEmit" }),
			() => toolCall("write_to_file", { path: "a.ts", content: "v3" }),
			() => toolCall("execute_command", { command: "npx tsc --noEmit" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "iterate to a clean build", client, workspaceRoot: ws, maxIterations: 250 })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Repeated-tool-failure guardrail (issue #146) ────────────────────────────
// identicalCallStreak (above) only fires on byte-identical repeats. These
// tests exercise the varied-args sibling: the SAME tool failing repeatedly
// with DIFFERENT arguments each time — real edit_file calls against a real
// workspace file (not a mocked executor), each with a different, still-wrong
// old_string, so every attempt genuinely errors and no two attempts are
// identical.

async function testToolFailureNudgeFiresOnVariedArgsRepeatedFailure(): Promise<void> {
	// Threshold is 2 (see DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD's doc comment
	// for why it must stay strictly below DEFAULT_CONSECUTIVE_ERROR_LIMIT's
	// default of 3 — live-verified 2026-08-21 via
	// scripts/eval-suite/scenario-146-repeated-tool-failure.sh: at 3, the
	// generic consecutive-mistake check always wins the race and ends the
	// session first, so this guardrail's own nudge never gets a turn to fire
	// under default settings). No consecutiveErrorLimit override needed here
	// for that reason — the default (3) is exactly what makes the 2-failure
	// threshold meaningful: the nudge must land BEFORE the hard stop.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-toolfail-"))
	try {
		await fs.writeFile(path.join(ws, "target.ts"), "export const value = 1\n")
		const client = new FakeLlmClient([
			() => toolCall("edit_file", { file_path: "target.ts", old_string: "wrong attempt 1", new_string: "x" }),
			() => toolCall("edit_file", { file_path: "target.ts", old_string: "wrong attempt 2", new_string: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "fix the file", client, workspaceRoot: ws, maxIterations: 250 })
		await session.run()

		const failedEdits = client.requests
			.flatMap((r) => r.messages)
			.filter((m) => m.role === "tool" && m.name === "edit_file" && typeof m.content === "string" && /no match found/i.test(m.content))
		assert.ok(failedEdits.length >= 2, `expected at least 2 real edit_file failures, got ${failedEdits.length}`)

		const nudge = session.state.messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.includes("all failed, even though the arguments were"),
		)
		assert.ok(nudge, "expected the repeated-tool-failure nudge to have fired despite varied args")
		assert.match(nudge?.content as string, /edit_file/, "nudge should name the failing tool")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testToolFailureStreakDoesNotFireOnIdenticalCallGuardAlone(): Promise<void> {
	// Sanity check for the "varied args" framing itself: a single failure
	// (below this guardrail's threshold of 2) must not fire it, proving the
	// nudge isn't just piggybacking on some other guardrail's threshold.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-toolfail-under-"))
	try {
		await fs.writeFile(path.join(ws, "target.ts"), "export const value = 1\n")
		const client = new FakeLlmClient([
			() => toolCall("edit_file", { file_path: "target.ts", old_string: "wrong attempt 1", new_string: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "fix the file", client, workspaceRoot: ws, maxIterations: 250 })
		await session.run()

		const nudge = session.state.messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.includes("all failed, even though the arguments were"),
		)
		assert.equal(nudge, undefined, "1 failure is below the threshold (2) — must not fire yet")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testToolFailureStreakResetsOnRediagnosticReadFile(): Promise<void> {
	// 1 failure, then a REAL read_file on the SAME target path (genuine
	// re-diagnosis), then 1 more failure — the streak must restart after the
	// read, so it never reaches the threshold (2) even though 2 real
	// failures happened across the session (which, WITHOUT the reset,
	// would be exactly enough to fire — see the main firing test above).
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-toolfail-reset-"))
	try {
		await fs.writeFile(path.join(ws, "target.ts"), "export const value = 1\n")
		const client = new FakeLlmClient([
			() => toolCall("edit_file", { file_path: "target.ts", old_string: "wrong attempt 1", new_string: "x" }),
			// read_file's real arg is `path`, NOT `file_path` (edit_file/
			// write_to_file's arg name) — using the wrong name here would make
			// this call fail too, which would still pass the assertion below for
			// the wrong reason (a differently-named failing tool also resets the
			// streak) without ever exercising the SAME-TARGET re-diagnosis path
			// this test is actually meant to cover.
			() => toolCall("read_file", { path: "target.ts" }),
			() => toolCall("edit_file", { file_path: "target.ts", old_string: "wrong attempt 2", new_string: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "fix the file", client, workspaceRoot: ws, maxIterations: 250 })
		await session.run()

		const readFileFailed = client.requests
			.flatMap((r) => r.messages)
			.some((m) => m.role === "tool" && m.name === "read_file" && typeof m.content === "string" && /error/i.test(m.content))
		assert.equal(readFileFailed, false, "the re-diagnosis read_file call itself must succeed for real (sanity check on the test setup)")

		const nudge = session.state.messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.includes("all failed, even though the arguments were"),
		)
		assert.equal(nudge, undefined, "a real read_file on the same target between failures must reset the streak")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testToolFailureStreakResetsOnSuccess(): Promise<void> {
	// 1 failure, then a REAL successful edit_file call, then 1 more failure —
	// never 2 consecutive failures, so the threshold (2) is never reached,
	// even though 2 real failures happened across the session.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-toolfail-success-"))
	try {
		await fs.writeFile(path.join(ws, "target.ts"), "export const value = 1\n")
		const client = new FakeLlmClient([
			() => toolCall("edit_file", { file_path: "target.ts", old_string: "wrong attempt 1", new_string: "x" }),
			() => toolCall("edit_file", { file_path: "target.ts", old_string: "export const value = 1", new_string: "export const value = 2" }),
			() => toolCall("edit_file", { file_path: "target.ts", old_string: "wrong attempt 2", new_string: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "fix the file", client, workspaceRoot: ws, maxIterations: 250 })
		await session.run()

		const succeededEdit = client.requests
			.flatMap((r) => r.messages)
			.some((m) => m.role === "tool" && m.name === "edit_file" && typeof m.content === "string" && !/no match found/i.test(m.content))
		assert.ok(succeededEdit, "the middle edit_file call must succeed for real (sanity check on the test setup)")

		const nudge = session.state.messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.includes("all failed, even though the arguments were"),
		)
		assert.equal(nudge, undefined, "a real successful edit_file call in between must reset the streak")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// Issue #153: the nudge's own advice ("use read_file") must not recommend a
// tool that's currently excluded by the SEPARATE identical-call cooldown —
// live-verified 2026-08-21 that this collision made a real session fabricate
// a fake tool call for the unavailable tool. Two identical read_file calls
// first trip that cooldown, THEN two varied-args edit_file failures fire
// this guardrail's nudge — it must not tell the model to do the one thing
// it currently cannot do.
async function testToolFailureNudgeAdaptsWhenReadFileIsOnCooldown(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-toolfail-cooldown-"))
	try {
		await fs.writeFile(path.join(ws, "target.ts"), "export const value = 1\n")
		const client = new FakeLlmClient([
			() => toolCall("read_file", { path: "target.ts" }),
			() => toolCall("read_file", { path: "target.ts" }),
			() => toolCall("edit_file", { file_path: "target.ts", old_string: "wrong attempt 1", new_string: "x" }),
			() => toolCall("edit_file", { file_path: "target.ts", old_string: "wrong attempt 2", new_string: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "fix the file", client, workspaceRoot: ws, maxIterations: 250 })
		await session.run()

		const readFileExcluded = client.requests.some((r) => !(r.tools ?? []).some((t) => t.function.name === "read_file"))
		assert.ok(readFileExcluded, "sanity check: read_file must actually have been excluded by the identical-call cooldown at some point")

		const nudge = session.state.messages.find(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.includes("all failed, even though the arguments were"),
		)
		assert.ok(nudge, "expected the repeated-tool-failure nudge to have fired")
		assert.match(
			nudge?.content as string,
			/read_file is temporarily unavailable/,
			"nudge must not recommend read_file while it's excluded by the identical-call cooldown",
		)
		assert.doesNotMatch(
			nudge?.content as string,
			/^Your.*use read_file to see/s,
			"nudge must not use the normal 'use read_file' phrasing while it's unavailable",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Mode-switch cap guardrail (issue #151 coverage gap) ────────────────────
// switch_mode (loop.ts:4656) hard-caps total in-place mode switches per
// session at DEFAULT_MAX_MODE_SWITCHES (5) — checked BEFORE the approval
// gate so a capped-out session never even escalates. Confirmed zero test
// coverage under any name (grepped loop.test.ts for "switch_mode",
// "modeSwitch", "MAX_MODE_SWITCHES": no hits) before this was added.

async function testMaxModeSwitchesCapsAtThreshold(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-mode-switch-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("switch_mode", { mode_slug: "architect", reason: "look around" }),
			() => toolCall("switch_mode", { mode_slug: "code", reason: "back to editing" }),
			() => toolCall("switch_mode", { mode_slug: "architect", reason: "look around" }),
			() => toolCall("switch_mode", { mode_slug: "code", reason: "back to editing" }),
			() => toolCall("switch_mode", { mode_slug: "architect", reason: "look around" }),
			// 6th switch: modeSwitchCount is already 5 (== DEFAULT_MAX_MODE_SWITCHES),
			// so this one must be refused as a normal tool error, not escalated.
			() => toolCall("switch_mode", { mode_slug: "code", reason: "one too many" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "switch modes repeatedly",
			client,
			workspaceRoot: ws,
			maxIterations: 20,
			autoApproveModeSwitch: true,
		})
		const result = await session.run()

		assert.equal(
			result.status,
			"success",
			`the cap is a recoverable tool error, not a fatal one — session should still reach attempt_completion; got ${JSON.stringify(result)}`,
		)

		const toolResults = session.state.messages.filter((m) => m.role === "tool")
		const capped = toolResults.find((m) => (m.content ?? "").includes("max mode switches reached"))
		assert.ok(capped, "expected the 6th switch_mode call to hit the max-switches cap")
		assert.match(
			capped?.content as string,
			new RegExp(
				`max mode switches reached \\(${DEFAULT_MAX_MODE_SWITCHES} >= max ${DEFAULT_MAX_MODE_SWITCHES}\\)`,
			),
			"cap message must report the real count and the real configured max",
		)

		const successfulSwitches = toolResults.filter(
			(m) => (m.content ?? "").startsWith("Switched to mode"),
		)
		assert.equal(
			successfulSwitches.length,
			DEFAULT_MAX_MODE_SWITCHES,
			`exactly ${DEFAULT_MAX_MODE_SWITCHES} switches should succeed before the cap fires`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMaxModeSwitchesCapDoesNotFireBelowThreshold(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-mode-switch-ok-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("switch_mode", { mode_slug: "architect", reason: "look around" }),
			() => toolCall("switch_mode", { mode_slug: "code", reason: "back to editing" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "switch modes twice",
			client,
			workspaceRoot: ws,
			maxIterations: 20,
			autoApproveModeSwitch: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const capped = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("max mode switches reached"),
		)
		assert.ok(!capped, "the cap must not fire when the switch count stays below the threshold")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Recursion-depth cap guardrail (issue #151 coverage gap) ────────────────
// new_task (loop.ts:4471) hard-caps how deep a session tree can delegate at
// DEFAULT_MAX_RECURSION_DEPTH (2) — a normal, recoverable tool error, not a
// crash. Confirmed zero test coverage: new_task has no test in this file at
// all under any name (grepped for "new_task"/"newTask": no hits).

async function testMaxRecursionDepthRefusesDelegationAtCap(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-recursion-cap-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("new_task", { mode: "code", message: "delegate one more level" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		// Already AT the cap: recursionDepth === maxRecursionDepth, so this
		// session's own new_task call must be refused immediately.
		const session = await makeSession({
			task: "try to delegate at max depth",
			client,
			workspaceRoot: ws,
			maxIterations: 10,
			recursionDepth: DEFAULT_MAX_RECURSION_DEPTH,
		})
		const result = await session.run()

		assert.equal(
			result.status,
			"success",
			`the depth cap is a recoverable tool error, not fatal — session should still reach attempt_completion; got ${JSON.stringify(result)}`,
		)
		const capped = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("max recursion depth reached"),
		)
		assert.ok(capped, "expected new_task to be refused once recursionDepth reaches the cap")
		assert.match(
			capped?.content as string,
			new RegExp(
				`max recursion depth reached \\(depth ${DEFAULT_MAX_RECURSION_DEPTH} >= max ${DEFAULT_MAX_RECURSION_DEPTH}\\)`,
			),
			"cap message must report the real depth and the real configured max",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMaxRecursionDepthAllowsDelegationBelowCap(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-recursion-ok-"))
	try {
		// Shared FakeLlmClient script: new_task synchronously spawns and runs a
		// full child session against the SAME script queue before the parent's
		// next turn, so the child's own attempt_completion must be queued
		// between the parent's two calls.
		const client = new FakeLlmClient([
			() => toolCall("new_task", { mode: "code", message: "do a subtask" }),
			() => toolCall("attempt_completion", { result: "child done" }), // child, depth 1
			() => toolCall("attempt_completion", { result: "parent done" }), // parent, resumed
		])
		const session = await makeSession({
			task: "delegate one level below the cap",
			client,
			workspaceRoot: ws,
			maxIterations: 10,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const capped = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("max recursion depth reached"),
		)
		assert.ok(!capped, "the depth cap must not fire for a delegation below the threshold")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Child-iteration floor (issue #151 coverage gap) ─────────────────────────
// new_task's child iteration budget is
// max(minChildIterations, floor(remaining * childIterationFraction)),
// clamped to remaining (handleNewTask, loop.ts). Zero test coverage —
// confirmed by grepping this file for "childIteration"/"minChildIterations":
// no hits before this test. With a small parent maxIterations, the
// fraction-based share rounds below DEFAULT_MIN_CHILD_ITERATIONS (3), so the
// floor must win regardless of the exact `remaining` value at call time.

async function testMinChildIterationsFloorApplies(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-child-floor-"))
	try {
		// Parent maxIterations=5: remaining is 4 or 5 depending on exactly
		// when currentIteration is read, but floor(4*0.5)=2 and
		// floor(5*0.5)=2 are both below minChildIterations(3) either way —
		// the floor wins regardless, so this test doesn't depend on that
		// exact off-by-one. The child never completes (distinct successful
		// execute_command calls, same shape as testMaxIterationsBound, so no
		// OTHER guardrail fires first) and must hit its own bounded
		// max-iterations failure at exactly 3.
		const client = new FakeLlmClient([
			() => toolCall("new_task", { mode: "code", message: "do a subtask that never finishes" }),
			() => toolCall("execute_command", { command: "node -e 'console.log(0)'" }), // child iter 1
			() => toolCall("execute_command", { command: "node -e 'console.log(1)'" }), // child iter 2
			() => toolCall("execute_command", { command: "node -e 'console.log(2)'" }), // child iter 3, hits its cap
			// Hitting its own iteration cap makes the CHILD issue one more
			// internal LLM call to write its handoff summary (loop.ts's
			// writeHandoffSummary path) — a real request that must be
			// answered on the same shared script queue, discovered live
			// while writing this test (an earlier version without this
			// entry threw "script exhausted" because this call silently ate
			// the entry meant for the parent's resumption below).
			() => textReply("Session hit its iteration cap after exploring."),
			() => toolCall("attempt_completion", { result: "parent done" }), // parent, resumed
		])
		const session = await makeSession({
			task: "delegate a subtask with a tight parent budget",
			client,
			workspaceRoot: ws,
			maxIterations: 5,
		})
		const result = await session.run()

		assert.equal(
			result.status,
			"success",
			`the child's own bounded failure is recoverable — the parent should still finish; got ${JSON.stringify(result)}`,
		)
		const childFailure = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("new_task child session"),
		)
		assert.ok(childFailure, "expected new_task to report the child's bounded failure to the parent")
		assert.match(
			childFailure?.content as string,
			new RegExp(`over ${DEFAULT_MIN_CHILD_ITERATIONS} iteration\\(s\\)`),
			`the child must be capped at exactly DEFAULT_MIN_CHILD_ITERATIONS (${DEFAULT_MIN_CHILD_ITERATIONS}), not a fraction-derived value below the floor`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── isReadOnlyEquivalentShellCommand (unit-level) ───────────────────────────

async function testIsReadOnlyEquivalentShellCommandClassifiesCorrectly(): Promise<void> {
	const readOnly = [
		"grep -rn foo src",
		"ls -la src",
		"cat file.txt",
		"sed -n '1,10p' file.txt",
		"git log --oneline -5",
		"git diff HEAD~1",
		"git status --short",
		"docker compose ps",
		"docker ps -a",
		"find . -name '*.ts' | head -20",
		"cd src && grep -rn foo . && cat bar.ts",
		"grep -rn foo src 2>&1 | head",
		"git log --oneline -5 || true", // a bare `||` must not split into a stray non-allow-listed "true" segment
	]
	const mutating = [
		"sed -i 's/foo/bar/' file.txt",
		"git commit -m x",
		"git checkout -b new-branch",
		"docker compose up -d",
		"docker run --rm image",
		"rm -rf node_modules",
		"echo hi > out.txt",
		"grep foo src && rm bar.txt", // one mutating segment taints the whole compound command
		"npm install",
		"echo hi >> out.txt",
	]
	for (const cmd of readOnly) {
		assert.equal(isReadOnlyEquivalentShellCommand(cmd), true, `expected read-only: ${cmd}`)
	}
	for (const cmd of mutating) {
		assert.equal(isReadOnlyEquivalentShellCommand(cmd), false, `expected NOT read-only: ${cmd}`)
	}
}

// ─── Live (in-progress) usage snapshot lifecycle ─────────────────────────────

async function testLiveSnapshotCreatedAndUpdatedDuringIterations(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-live-"))
	try {
		const usageDir = path.join(ws, ".headlesscode", "usage")
		let probes = 0
		const client = new LiveProbeClient(
			[
				() => toolCall("write_to_file", { path: "a.txt", content: "hello" }),
				() => toolCall("write_to_file", { path: "b.txt", content: "world" }),
				() => toolCall("attempt_completion", { result: "done" }),
			],
			async () => {
				probes++
				const snap = await readLiveSnapshot(usageDir)
				assert.equal(snap.status, "running")
				assert.equal(typeof snap.sessionId, "string")
				assert.ok(String(snap.sessionId).length > 0)
				assert.equal(snap.workspaceRoot, ws)
				assert.equal(snap.mode, "code")
				assert.equal(snap.model, "fake-model")
				assert.equal(snap.endedAt, undefined, "live snapshot has no endedAt")
				assert.equal(typeof snap.costUsd, "number")
				if (probes === 1) {
					// Probe runs before call 2: the iteration-1 snapshot.
					assert.equal(snap.iterations, 1)
					assert.equal(snap.inputTokens, 100)
					assert.equal(snap.outputTokens, 50)
				} else {
					// Probe runs before call 3: overwritten in place for iteration 2.
					assert.equal(snap.iterations, 2)
					assert.equal(snap.inputTokens, 200)
					assert.equal(snap.outputTokens, 100)
				}
			},
		)
		const session = await makeSession({ task: "write two files", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(probes, 2, "probe ran before both the 2nd and 3rd LLM calls")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testLiveSnapshotRemovedOnSuccess(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-live-succ-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "write a file", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		await assertCompletedCleanup(ws, "success")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testLiveSnapshotRemovedOnError(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-live-err-"))
	try {
		// Model keeps calling an unimplemented stub tool (codebase_search) →
		// bounded failure (status "error") after `consecutiveErrorLimit` mistakes.
		const client = new FakeLlmClient([
			() => toolCall("codebase_search", { query: "x" }),
			() => toolCall("codebase_search", { query: "x" }),
			() => toolCall("codebase_search", { query: "x" }),
		])
		const session = await makeSession({
			task: "search the codebase",
			client,
			workspaceRoot: ws,
			consecutiveErrorLimit: 3,
		})
		const result = await session.run()
		assert.equal(result.status, "error", `expected bounded failure, got ${JSON.stringify(result)}`)
		await assertCompletedCleanup(ws, "error")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testLiveSnapshotRemovedOnBudgetExceeded(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-live-budget-"))
	try {
		// Budget maxIterations: 1 → iteration 1 runs (live snapshot written),
		// iteration 2's pre-call tick() trips the budget → status "error",
		// reason "budget".
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "a.txt", content: "x" }),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({
			task: "write a file",
			client,
			workspaceRoot: ws,
			budget: { maxIterations: 1 },
		})
		const result = await session.run()
		assert.equal(result.status, "error", `expected budget abort, got ${JSON.stringify(result)}`)
		assert.equal(result.reason, "budget")
		await assertCompletedCleanup(ws, "budget")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── execute_command timeout semantics ───────────────────────────────────────

async function testTimeoutDoesNotCountAsMistake(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-timeout-"))
	try {
		// consecutiveErrorLimit: 1 means a SINGLE mistaken tool call ends the
		// session in bounded failure. The execute_command times out (its child
		// is left running in the background) and must NOT count as a mistake —
		// so the session still reaches attempt_completion and succeeds.
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "node -e 'setTimeout(()=>{},5000)'", timeout: 1 }),
			() => toolCall("attempt_completion", { result: "backgrounded it and moved on" }),
		])
		const session = await makeSession({
			task: "start a long process and continue",
			client,
			workspaceRoot: ws,
			consecutiveErrorLimit: 1,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `timeout must not be a mistake, got ${JSON.stringify(result)}`)
		assert.match(result.result ?? "", /backgrounded/)
		// The tool message fed back to the model is the timeout marker, and it
		// must NOT be an error message (no "[Error]" prefix).
		const toolMsg = session.state.messages.find((m) => m.role === "tool")
		assert.ok(toolMsg, "expected a tool message in history")
		assert.match(toolMsg?.content ?? "", /timed out after 1s/, "timeout marker must be fed back to the model")
		assert.doesNotMatch(toolMsg?.content ?? "", /^\[Error\]/, "a timeout must not look like an error to the model")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSessionEndReapsBackgroundedChildren(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-reap-"))
	try {
		// The execute_command times out and its child is left running in the
		// background (it would write a marker after 60s). The session then
		// completes normally. At session end the teardown hook (dispose in
		// run()'s finally) must hard-kill the backgrounded child — NOT leave
		// it orphaned past its session.
		const marker = path.join(ws, "leftover-marker.txt")
		const client = new FakeLlmClient([
			() =>
				toolCall("execute_command", {
					command:
						`node -e 'console.log("pid=" + process.pid); ` +
						`setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "done"), 60000)'`,
					timeout: 1,
				}),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "start then finish", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		// Recover the backgrounded pid from the tool result fed back to the model.
		const toolMsg = session.state.messages.find((m) => m.role === "tool")
		const pidMatch = toolMsg?.content?.match(/pid=(\d+)/)
		assert.ok(pidMatch, "tool result should contain the backgrounded pid")
		const pid = Number(pidMatch[1])
		assert.ok(Number.isInteger(pid) && pid > 0, "could not extract the backgrounded pid")

		// The session has ended: the child must have been killed by the
		// teardown hook, so it is no longer alive and can never write its marker.
		await waitForProcessExit(pid)
		assert.equal(await exists(marker), false, "killed backgrounded child must never write its marker")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
	* The loop's checkpoint trigger used to key off the executor having
	* `write_to_file` registered — an iteration that used ONLY `apply_diff` (no
	* write_to_file call at all) would slip through uncheckpointed. Regression:
	* a session whose model edits via apply_diff alone must still snapshot.
	*
	* The diff markers are assembled at runtime (`<".repeat(7)` etc.) so the
	* literal SEARCH/REPLACE sequences don't appear in this file's source.
	*/
async function testCheckpointTriggeredByApplyDiffOnly(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-ckpt-applydiff-"))
	const checkpointDir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ckpt-loop-"))
	try {
		// Seed a file the model will edit via apply_diff only.
		await fs.writeFile(path.join(ws, "greeting.txt"), "hello world\n", "utf-8")

		const diff = [
			"<".repeat(7) + " SEARCH",
			":start_line:1",
			"-------",
			"hello world",
			"=======",
			"hello brave new world",
			">".repeat(7) + " REPLACE",
		].join("\n")
		const client = new FakeLlmClient([
			() => toolCall("apply_diff", { path: "greeting.txt", diff }),
			() => toolCall("attempt_completion", { result: "Done: edited greeting.txt" }),
		])
		const session = await makeSession({
			task: "edit greeting.txt",
			client,
			workspaceRoot: ws,
			checkpoints: true,
			checkpointDir,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		// The diff was actually applied to disk.
		assert.equal(await fs.readFile(path.join(ws, "greeting.txt"), "utf-8"), "hello brave new world\n")

		// The shadow-git checkpoint repo for this session must exist and hold
		// more than the baseline snapshot (baseline + post-iteration snapshot).
		const tasksDir = path.join(checkpointDir, "tasks")
		const taskIds = await fs.readdir(tasksDir)
		assert.equal(taskIds.length, 1, `expected exactly one checkpoint task, got: ${taskIds.join(", ")}`)
		const svc = createCheckpointService({ taskId: taskIds[0], workspaceRoot: ws, checkpointDir })
		await svc.init()
		const entries = await svc.list()
		assert.ok(entries.length >= 2, `expected baseline + iteration checkpoints, got ${entries.length}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

/**
	* (S1) A turn whose every call is read-only must NOT pay a per-iteration
	* shadow-git checkpoint: pure read/explore turns skip the snapshot entirely.
	* Fixture mirrors testCheckpointTriggeredByApplyDiffOnly (baseline + per-turn
	* snapshots); here the history must hold ONLY the baseline.
	*/
async function testReadOnlyTurnDoesNotTriggerCheckpoint(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-ckpt-readonly-"))
	const checkpointDir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-ckpt-loop-"))
	try {
		await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf-8")
		const client = new FakeLlmClient([
			() => toolCall("read_file", { path: "a.txt" }),
			() => toolCall("attempt_completion", { result: "read only, done" }),
		])
		const session = await makeSession({
			task: "read a file",
			client,
			workspaceRoot: ws,
			checkpoints: true,
			checkpointDir,
		})
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		// Shadow-git history holds ONLY the baseline — the read-only turn was
		// skipped (the apply_diff checkpoint test above asserts a NON-read-only
		// turn still snapshots, so the two tests bracket the skip). list() is
		// [shadow-git initial commit, baseline snapshot] — no per-iteration
		// snapshot, which would make it 3.
		const tasksDir = path.join(checkpointDir, "tasks")
		const taskIds = await fs.readdir(tasksDir)
		assert.equal(taskIds.length, 1, `expected exactly one checkpoint task, got: ${taskIds.join(", ")}`)
		const svc = createCheckpointService({ taskId: taskIds[0], workspaceRoot: ws, checkpointDir })
		await svc.init()
		const entries = await svc.list()
		assert.equal(
			entries.length,
			2,
			`read-only turn must not add an iteration checkpoint (initial commit + baseline only), got ${entries.length}`,
		)
		assert.ok(!entries.some((e) => (e.message ?? "").includes("iteration")), "no per-iteration snapshot message")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await fs.rm(checkpointDir, { recursive: true, force: true })
	}
}

/**
 * (T2/T3 step 2) The non-vendored tool appends are gated on the session's
 * executor: a read-only reviewer/QA executor registers browser_action but NOT
 * describe_image, so its advertised catalog must exclude describe_image (a
 * schema it would only error on) while keeping browser_action; the default
 * executor advertises both.
 */
async function testToolCatalogGatedOnExecutorHandlers(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-toolgate-"))
	try {
		const roClient = new FakeLlmClient([() => toolCall("attempt_completion", { result: "done" })])
		const roSession = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "inspect",
			llmClient: roClient,
			maxIterations: 3,
			executor: createReadOnlyHeadlessExecutor(ws),
			checkpoints: false,
		})
		const roResult = await roSession.run()
		assert.equal(roResult.status, "success", `expected success, got ${JSON.stringify(roResult)}`)
		const roNames = roSession.state.tools.map((t) => (t.type === "function" ? t.function.name : t.type))
		assert.ok(roNames.includes("browser_action"), "read-only executor CAN browse — browser_action stays advertised")
		assert.ok(!roNames.includes("describe_image"), "read-only executor has no describe_image handler — schema not advertised")

		const fullClient = new FakeLlmClient([() => toolCall("attempt_completion", { result: "done" })])
		const fullSession = new HeadlessSession({
			workspaceRoot: ws,
			mode: "code",
			model: "fake-model",
			taskText: "inspect",
			llmClient: fullClient,
			maxIterations: 3,
			checkpoints: false,
		})
		const fullResult = await fullSession.run()
		assert.equal(fullResult.status, "success", `expected success, got ${JSON.stringify(fullResult)}`)
		const fullNames = fullSession.state.tools.map((t) => (t.type === "function" ? t.function.name : t.type))
		assert.ok(fullNames.includes("browser_action"), "default executor advertises browser_action")
		assert.ok(fullNames.includes("describe_image"), "default executor advertises describe_image")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── truncateHistory — batch eviction (cache-stability regression) ───────────

function fakeMsg(i: number): ChatMessage {
	return { role: i % 2 === 0 ? "assistant" : "tool", content: `msg-${i}`, name: i % 2 === 0 ? undefined : "tool" }
}

/**
 * (T1) stripSupersededReasoning keeps reasoning only on the most-recent
 * assistant message; every earlier assistant message has it removed, and tool /
 * user messages are never touched.
 */
async function testStripSupersededReasoningKeepsOnlyMostRecent(): Promise<void> {
	const messages: ChatMessage[] = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "task" },
		{ role: "assistant", content: "first", reasoning: "reas-1" },
		{ role: "tool", tool_call_id: "c1", name: "read_file", content: "ok" },
		{ role: "assistant", content: "second", reasoning: "reas-2" },
	]
	stripSupersededReasoning(messages)
	assert.equal(messages[2].reasoning, undefined, "superseded assistant reasoning is stripped")
	assert.equal(messages[4].reasoning, "reas-2", "the most-recent assistant keeps its reasoning")
	assert.equal(messages[3].role, "tool", "tool messages are never touched")
	assert.equal(messages[1].role, "user", "user messages are never touched")
}

async function testTruncateHistoryNoOpBelowWindow(): Promise<void> {
	const messages = [fakeMsg(0), fakeMsg(1), fakeMsg(2), fakeMsg(3)]
	const result = truncateHistory(messages, 40)
	assert.deepEqual(result, messages, "below the window, history is returned untouched")
}

async function testTruncateHistoryEvictsInBatches(): Promise<void> {
	const windowSize = 10
	// system + firstUser + 20 more = 22 total, well over the window.
	const messages = [fakeMsg(0), fakeMsg(1), ...Array.from({ length: 20 }, (_, i) => fakeMsg(i + 2))]
	const result = truncateHistory(messages, windowSize)
	// overflow = 20 - (10 - 2) = 12 -> evictCount = ceil(12/10)*10 = 20 (a full batch beyond
	// the raw overflow, not just the minimum 12) -- kept tail is system+firstUser+0 of `rest`.
	assert.equal(result.length, 2, `expected only system+firstUser kept, got ${result.length}`)
	assert.equal(result[0], messages[0])
	assert.equal(result[1], messages[1])
}

/**
 * 2026-08-01 regression: real sessions have an irregular number of tool
 * calls per turn (1-3), so a raw positional batch cut can land in the middle
 * of an assistant `tool_calls` + its `tool` response group -- evicting the
 * assistant message but keeping its orphaned `tool` response(s). DeepSeek's
 * official endpoint rejects that with HTTP 400. Builds a history shaped like
 * the real failing session (varying call counts per turn) and asserts the
 * kept tail never starts with a `role: "tool"` message.
 */
async function testTruncateHistoryNeverSplitsToolCallGroup(): Promise<void> {
	const system = fakeMsg(0)
	const firstUser = fakeMsg(1)
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
	for (let windowSize = 4; windowSize < messages.length; windowSize++) {
		const result = truncateHistory(messages, windowSize)
		if (result.length > 2) {
			assert.notEqual(
				result[2].role,
				"tool",
				`windowSize=${windowSize}: kept tail starts with an orphaned tool message`,
			)
		}
	}
}

/**
 * The actual regression this batching fixes: once truncation is active, the
 * prefix sent to the model must stay IDENTICAL across multiple consecutive
 * calls (not re-slice a different window every single time), so provider-
 * side prompt caching can actually accrue. Simulates a growing conversation
 * one message at a time (as HeadlessSession's real loop does) and asserts
 * the truncated result is byte-identical (via deepEqual) across a whole
 * batch's worth of growth, only changing at the batch boundary.
 */
async function testTruncateHistoryStablePrefixBetweenBatches(): Promise<void> {
	const windowSize = 20
	const system = fakeMsg(0)
	const firstUser = fakeMsg(1)
	const results: ChatMessage[][] = []
	let messages = [system, firstUser]
	// Grow one message at a time well past the window, capturing each truncated result.
	for (let i = 2; i < 2 + 40; i++) {
		messages = [...messages, fakeMsg(i)]
		results.push(truncateHistory(messages, windowSize))
	}
	// A genuinely growing conversation can never produce byte-identical
	// results call-to-call (new content is always appended) -- what caching
	// actually needs is that the RETAINED PREFIX doesn't shift: each new
	// result should be the previous one PLUS new messages appended at the
	// end, not a window whose oldest kept message also changes every call
	// (that was the original bug -- `rest.slice(-(windowSize-2))` shifts
	// its start index on every single call once truncation is active).
	// Find the longest run of consecutive calls where every result is a
	// prefix-preserving extension of the one before it, and confirm at
	// least one such run is TRUNCATION_BATCH_SIZE calls long.
	function isPrefixExtension(prev: ChatMessage[], next: ChatMessage[]): boolean {
		if (next.length < prev.length) return false
		return prev.every((m, i) => m === next[i])
	}
	let longestStableRun = 1
	let currentRun = 1
	for (let i = 1; i < results.length; i++) {
		const extends_ = isPrefixExtension(results[i - 1], results[i])
		currentRun = extends_ ? currentRun + 1 : 1
		longestStableRun = Math.max(longestStableRun, currentRun)
	}
	assert.ok(
		longestStableRun >= TRUNCATION_BATCH_SIZE,
		`expected a run of at least ${TRUNCATION_BATCH_SIZE} consecutive prefix-preserving (cache-eligible) calls, longest was ${longestStableRun}`,
	)
}

// Diff markers built via concatenation (not literal template text) so the
// harness's own diff parser never mistakes them for real SEARCH/REPLACE
// markers in this test file.
function diffBlock(search: string, replace: string): string {
	const searchMarker = "<<<<<<<" + " SEARCH"
	const replaceMarker = "======="
	const endMarker = ">>>>>>>" + " REPLACE"
	return `${searchMarker}\n-------\n${search}${replaceMarker}\n${replace}${endMarker}`
}

// ─── Same-file multi-edit batch diagnosis ────────────────────────────────────

async function testSameFileBatchFailureGetsDiagnosis(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-samefile-"))
	try {
		await fs.writeFile(path.join(ws, "notes.txt"), "alpha\nbeta\ngamma\n", "utf-8")
		// ONE turn with TWO apply_diff calls to the SAME file. The second's
		// SEARCH text matches the PRE-first-edit content, so it fails after
		// the first edit has already landed on disk.
		const client = new FakeLlmClient([
			() =>
				toolCallBatch([
					{ name: "apply_diff", args: { path: "notes.txt", diff: diffBlock("alpha\n", "ALPHA\n") } },
					{ name: "apply_diff", args: { path: "notes.txt", diff: diffBlock("alpha\nbeta\n", "alpha\nbeta\ninserted\n") } },
				]),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "edit notes.txt twice", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const applyDiffResults = session.state.messages.filter((m) => m.role === "tool" && m.name === "apply_diff")
		assert.equal(applyDiffResults.length, 2, "both apply_diff calls executed")
		const failed = applyDiffResults.find((m) => (m.content ?? "").includes("unable to apply diff"))
		assert.ok(failed, "the second call must fail (stale SEARCH text)")
		assert.match(
			failed?.content ?? "",
			/already edited by an earlier tool call in this same turn/,
			"the failure carries the same-file-in-batch diagnosis, not just the generic mismatch",
		)
		assert.match(
			failed?.content ?? "",
			/SEARCH\/REPLACE blocks in ONE apply_diff call/,
			"the diagnosis points at the fix (single-call batching)",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Create a temp workspace that is a real git repo with one committed tracked
 * file (`notes.txt`), so the commit-before-finishing guardrail has something
 * real to check. Returns the workspace path, or null when git is unavailable.
 */
async function mkGitWorkspace(): Promise<string | null> {
	const { execFileSync } = await import("node:child_process")
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" })
	} catch {
		return null
	}
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-git-"))
	execFileSync("git", ["init", "-q"], { cwd: ws })
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: ws })
	execFileSync("git", ["config", "user.name", "Test"], { cwd: ws })
	await fs.writeFile(path.join(ws, "notes.txt"), "hello\n", "utf-8")
	execFileSync("git", ["add", "notes.txt"], { cwd: ws })
	execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: ws })
	return ws
}

/**
 * (S3) A turn whose calls are all read-only runs them CONCURRENTLY; the tool
 * results must still be fed back in assistant.tool_calls order (the
 * assistant→tool adjacency contract), regardless of execution order.
 */
async function testParallelReadOnlyCallsFeedResultsInOrder(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-parread-"))
	try {
		await fs.writeFile(path.join(ws, "a.txt"), "AAA\n", "utf-8")
		await fs.writeFile(path.join(ws, "b.txt"), "BBB\n", "utf-8")
		await fs.writeFile(path.join(ws, "c.txt"), "CCC\n", "utf-8")
		const client = new FakeLlmClient([
			// ONE turn with THREE read_file calls (the parallelizable group).
			() =>
				toolCallBatch([
					{ name: "read_file", args: { path: "a.txt" } },
					{ name: "read_file", args: { path: "b.txt" } },
					{ name: "read_file", args: { path: "c.txt" } },
				]),
			() => toolCall("attempt_completion", { result: "read all three" }),
		])
		const session = await makeSession({ task: "read three files", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)

		const toolMsgs = session.state.messages.filter((m) => m.role === "tool" && m.name === "read_file")
		assert.equal(toolMsgs.length, 3, "all three reads produced a tool message")
		const assistantMsg = session.state.messages.find((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) === 3)
		assert.ok(assistantMsg?.tool_calls, "found the assistant message with all three tool_calls")
		for (let i = 0; i < 3; i++) {
			assert.equal(
				toolMsgs[i].tool_call_id,
				assistantMsg.tool_calls![i].id,
				`tool message ${i} must reference tool_call ${i} (submission order preserved under concurrency)`,
			)
		}
		// Each read returned ITS OWN file's content (no cross-talk from the
		// concurrent executions).
		assert.match(toolMsgs[0].content ?? "", /AAA/)
		assert.match(toolMsgs[1].content ?? "", /BBB/)
		assert.match(toolMsgs[2].content ?? "", /CCC/)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Commit-before-finishing guardrail ───────────────────────────────────────

async function testCompletionNudgedOnUncommittedChanges(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip commit-guard test (git not installed)")
		return
	}
	try {
		// Edit the tracked file, then try to finish WITHOUT committing.
		const client = new FakeLlmClient([
			() => toolCall("apply_diff", { path: "notes.txt", diff: diffBlock("hello\n", "hello world\n") }),
			() => toolCall("attempt_completion", { result: "done editing" }),
			() => toolCall("attempt_completion", { result: "done editing (retried)" }),
		])
		const session = await makeSession({ task: "edit notes.txt", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "done editing (retried)", "the retried completion is the one accepted")
		assert.equal(result.iterations, 3, "the deferred completion consumed one extra iteration")
		const completionMsgs = session.state.messages.filter((m) => m.role === "tool" && m.name === "attempt_completion")
		assert.equal(completionMsgs.length, 1, "only the deferred completion produced a tool message")
		assert.match(
			completionMsgs[0]?.content ?? "",
			/attempt_completion not accepted — the workspace has uncommitted/,
			"the corrective nudge names the situation",
		)
		assert.match(completionMsgs[0]?.content ?? "", /git commit/, "it points at git commit")
		assert.match(completionMsgs[0]?.content ?? "", /attempt_completion again/, "it is a retry nudge, not a hard block")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * Regression test: hasUncommittedTrackedChanges()'s blanket `??` exemption
 * used to let a session finish with a brand-new, never-`git add`ed file it
 * just wrote — e.g. "write tests for X" almost always produces a new file,
 * which shows up as untracked, not a tracked-file modification. Found live
 * dogfooding UwUChat's code mode: a session reported "success" after
 * writing a new test file it never committed. sessionWrittenPaths closes
 * this — an untracked path THIS session wrote via an edit tool still nudges.
 */
async function testCompletionNudgedOnNewUncommittedFile(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip commit-guard test (git not installed)")
		return
	}
	try {
		// write_to_file creates a brand-new file — untracked, not a
		// modification to the repo's existing tracked notes.txt.
		const client = new FakeLlmClient([
			() => toolCall("write_to_file", { path: "new_feature.txt", content: "brand new\n" }),
			() => toolCall("attempt_completion", { result: "wrote the new file" }),
			() => toolCall("attempt_completion", { result: "wrote the new file (retried)" }),
		])
		const session = await makeSession({ task: "add new_feature.txt", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "wrote the new file (retried)", "the retried completion is the one accepted")
		const completionMsgs = session.state.messages.filter((m) => m.role === "tool" && m.name === "attempt_completion")
		assert.equal(completionMsgs.length, 1, "only the deferred completion produced a tool message")
		assert.match(
			completionMsgs[0]?.content ?? "",
			/attempt_completion not accepted — the workspace has uncommitted/,
			"a new file the session itself wrote must still nudge, despite being untracked",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/**
 * A pre-existing untracked file the session never touched (genuine scratch
 * work left by something else, or simply not part of this task) must still
 * be exempted — only files THIS session wrote via an edit tool count.
 */
async function testNoNudgeForPreexistingUntrackedFile(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip commit-guard test (git not installed)")
		return
	}
	try {
		await fs.writeFile(path.join(ws, "scratch.txt"), "not part of this task\n", "utf-8")
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "nothing to do" }),
		])
		const session = await makeSession({ task: "do nothing", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.iterations, 1, "a pre-existing untracked file the session never wrote must not nudge")
		const nudges = session.state.messages.filter((m) => (m.content ?? "").includes("attempt_completion not accepted — the workspace has uncommitted"))
		assert.equal(nudges.length, 0, "pre-existing scratch files are still exempt")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCompletionAcceptedWhenClean(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip commit-guard test (git not installed)")
		return
	}
	try {
		// Nothing edited: the guard must not fire for a clean tree.
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "nothing to do" }),
		])
		const session = await makeSession({ task: "do nothing", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "nothing to do")
		assert.equal(result.iterations, 1, "no nudge, no extra iteration")
		const nudges = session.state.messages.filter((m) => (m.content ?? "").includes("attempt_completion not accepted — the workspace has uncommitted"))
		assert.equal(nudges.length, 0, "a clean tree must not be nudged")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCompletionRefusedWhenBundledWithSiblings(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip bundled-completion test (git not installed)")
		return
	}
	try {
		// One turn: attempt_completion bundled alongside a real write. The
		// write must execute for real; the completion must be refused so the
		// model is forced to check the write's actual result before finishing.
		// Commits hello.txt before the final completion — sessionWrittenPaths
		// would otherwise ALSO defer the second attempt_completion via the
		// (separate) commit guard, which isn't what this test is about.
		const client = new FakeLlmClient([
			() =>
				toolCallBatch([
					{ name: "write_to_file", args: { path: "hello.txt", content: "hello" } },
					{ name: "attempt_completion", args: { result: "done (premature)" } },
				]),
			() => toolCall("execute_command", { command: "git add hello.txt && git commit -q -m \"add hello\"" }),
			() => toolCall("attempt_completion", { result: "done for real" }),
		])
		const session = await makeSession({ task: "write then finish", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "done for real", "the premature bundled completion must not be accepted")
		assert.equal(
			await fs.readFile(path.join(ws, "hello.txt"), "utf-8"),
			"hello",
			"the sibling write must execute for real, not be discarded",
		)
		const completionMsgs = session.state.messages.filter((m) => m.role === "tool" && m.name === "attempt_completion")
		assert.equal(completionMsgs.length, 1, "only the refused bundled completion produced a tool message")
		assert.match(
			completionMsgs[0]?.content ?? "",
			/alongside other tool calls/,
			"the refusal explains why it was not accepted",
		)
		assert.match(
			completionMsgs[0]?.content ?? "",
			/Re-issue attempt_completion ALONE/,
			"the refusal tells the model how to retry correctly",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testCompletionAcceptedAfterCommit(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip commit-guard test (git not installed)")
		return
	}
	try {
		// Edit, commit via execute_command, then finish: no nudge.
		const client = new FakeLlmClient([
			() => toolCall("apply_diff", { path: "notes.txt", diff: diffBlock("hello\n", "hello world\n") }),
			() => toolCall("execute_command", { command: "git add notes.txt && git commit -q -m \"edit notes\"" }),
			() => toolCall("attempt_completion", { result: "committed and done" }),
		])
		const session = await makeSession({ task: "edit and commit", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "committed and done")
		const nudges = session.state.messages.filter((m) => (m.content ?? "").includes("attempt_completion not accepted — the workspace has uncommitted"))
		assert.equal(nudges.length, 0, "committing before finishing means no nudge")
		// The commit actually landed.
		const { execFileSync } = await import("node:child_process")
		const log = execFileSync("git", ["log", "--oneline"], { cwd: ws, encoding: "utf-8" })
		assert.match(log, /edit notes/, "the model's commit landed in the repo")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testNoNudgeInReadOnlyMode(): Promise<void> {
	const ws = await mkGitWorkspace()
	if (ws === null) {
		console.log("  skip commit-guard test (git not installed)")
		return
	}
	try {
		// Uncommitted tracked change present, but the mode is READ-ONLY (ask
		// has no edit group) — the guard must be scoped out entirely.
		await fs.writeFile(path.join(ws, "notes.txt"), "changed without a commit\n", "utf-8")
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "investigation only" }),
		])
		const session = await makeSession({ task: "investigate", client, workspaceRoot: ws, mode: "ask" })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.iterations, 1, "read-only mode accepts completion immediately")
		const nudges = session.state.messages.filter((m) => (m.content ?? "").includes("attempt_completion not accepted — the workspace has uncommitted"))
		assert.equal(nudges.length, 0, "read-only modes never get the commit nudge")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDifferentFileBatchFailureGetsNoDiagnosis(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-diffile-"))
	try {
		await fs.writeFile(path.join(ws, "a.txt"), "hello\n", "utf-8")
		await fs.writeFile(path.join(ws, "b.txt"), "hello\n", "utf-8")
		// ONE turn with TWO apply_diff calls to DIFFERENT files. The second
		// fails for an unrelated reason (no match) — it must NOT get the
		// same-file-in-batch diagnosis.
		const client = new FakeLlmClient([
			() =>
				toolCallBatch([
					{ name: "apply_diff", args: { path: "a.txt", diff: diffBlock("hello\n", "hi\n") } },
					{ name: "apply_diff", args: { path: "b.txt", diff: diffBlock("goodbye\n", "bye\n") } },
				]),
			() => toolCall("attempt_completion", { result: "done" }),
		])
		const session = await makeSession({ task: "edit two files", client, workspaceRoot: ws })
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		const applyDiffResults = session.state.messages.filter((m) => m.role === "tool" && m.name === "apply_diff")
		const failed = applyDiffResults.find((m) => (m.content ?? "").includes("unable to apply diff"))
		assert.ok(failed, "the second call fails (no match in b.txt)")
		assert.doesNotMatch(
			failed?.content ?? "",
			/already edited by an earlier tool call/,
			"different-file failures must NOT get the same-file diagnosis",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Part E: live pricing feeds the session's BudgetTracker ──────────────────

async function testBudgetUsesLivePricingWhenAvailable(): Promise<void> {
	// A live price that DIFFERS from the hardcoded table must win: the
	// session's cost accounting reflects the live value, not the default.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-liveprice-"))
	try {
		const client = new UsageClient([() => toolCall("attempt_completion", { result: "done" })], {
			price: { input: 9, output: 9 },
		})
		const session = await makeSession({ task: "finish", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success")
		// 100 prompt + 50 completion tokens at $9/1M = (900 + 450)/1e6.
		const expected = (100 * 9 + 50 * 9) / 1_000_000
		assert.ok(
			Math.abs((result.budgetUsage?.costUsd ?? 0) - expected) < 1e-9,
			`expected live-priced cost $${expected}, got $${result.budgetUsage?.costUsd}`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testBudgetFallsBackToHardcodedTableWithoutLivePricing(): Promise<void> {
	// A client with NO live-pricing support (fetchModelInfo absent/undefined)
	// must behave EXACTLY as before live pricing existed: "fake-model" isn't
	// in DEFAULT_PRICING_TABLE, so the conservative FALLBACK_MODEL_PRICE
	// ($2/$8 per 1M) applies — no crash, no $0, no live value.
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-fallbackprice-"))
	try {
		const client = new UsageClient([() => toolCall("attempt_completion", { result: "done" })], undefined)
		const session = await makeSession({ task: "finish", client, workspaceRoot: ws })
		const result = await session.run()
		assert.equal(result.status, "success")
		const expected = (100 * 2 + 50 * 8) / 1_000_000
		assert.ok(
			Math.abs((result.budgetUsage?.costUsd ?? 0) - expected) < 1e-9,
			`expected fallback-priced cost $${expected}, got $${result.budgetUsage?.costUsd}`,
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// GitHub issue #136: verifyBeforeCompletion's lastExecuteCommandFailed
// check says nothing about a completion that invents specific
// measurements nobody actually produced. Verified live 2026-08-21: a
// local session declared an infra POC complete with fabricated
// tokens/sec numbers, having never run the command that would produce
// them — the last command it DID run had succeeded, so the existing
// check never fired.
async function testVerifyBeforeCompletionRefusesUnsupportedMeasurementClaim(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-vbc-measure-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("execute_command", { command: "echo ready" }),
			() => toolCall("attempt_completion", { result: "Benchmark complete: 205.9 tokens/sec measured." }),
			() => toolCall("execute_command", { command: "echo real-result 205.9" }),
			() => toolCall("attempt_completion", { result: "Ran the real benchmark: 205.9 tokens/sec." }),
		])
		const session = await makeSession({
			task: "benchmark something",
			client,
			workspaceRoot: ws,
			verifyBeforeCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Ran the real benchmark: 205.9 tokens/sec.")
		assert.equal(client.requests.length, 4, "the unsupported claim must not end the session early")
		const nudge = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("was NOT accepted"),
		)
		assert.ok(nudge, "expected a nudge refusing the unsupported measurement claim")
		assert.match(
			nudge?.content ?? "",
			/measurement\/benchmark/,
			"the nudge names the unsupported-measurement reason, not the failed-command reason",
		)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Evidence-gated completion (fabrication fix, 2026-09-01) ─────────────────
//
// The FINAL_REPORT's central finding (§4): a real session reported "all three
// hard gates pass" with a fabricated serial-log excerpt ("E1000: 1 / E1000: 2")
// when the driver was never merged and the claimed Makefile target didn't
// exist. These tests reproduce that exact shape at the loop level with
// evidenceRequiredCompletion on:
//   (a) the claimed target doesn't exist → completion DEFERRED, model must
//       re-verify for real;
//   (b) the target exists but the re-run fails → completion DEFERRED, model
//       must fix and re-run;
//   (c) the target exists and the re-run passes → completion ACCEPTED, and
//       SessionResult.verification records the claim counts.

// (a) Fabricated gate claim, target does not exist → deferred.
async function testEvidenceRequiredRefusesNonexistentGateTarget(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-evid1-"))
	try {
		const client = new FakeLlmClient([
			() =>
				toolCall("attempt_completion", {
					result:
						"All three hard gates pass: make check passed cleanly, make qemu-e1000-smoke passed, and the serial log shows E1000: 1 then E1000: 2.",
				}),
			() => toolCall("execute_command", { command: "echo real-evidence" }),
			() => toolCall("attempt_completion", { result: "Done for real after verifying." }),
		])
		const session = await makeSession({
			task: "add the e1000 driver and confirm the gate",
			client,
			workspaceRoot: ws,
			evidenceRequiredCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done for real after verifying.")
		assert.equal(client.requests.length, 3, "the fabricated completion must not end the session early")
		const nudge = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("was NOT accepted"),
		)
		assert.ok(nudge, "expected a deferral nudge")
		assert.match(
			nudge?.content ?? "",
			/None of these could be independently confirmed/,
			"the nudge must name that the claims were not verified",
		)
		// The specific unverified claims must be named.
		assert.match(nudge?.content ?? "", /make qemu-e1000-smoke/, "the nudge names the fabricated target")
		assert.match(nudge?.content ?? "", /E1000: 1, E1000: 2/, "the nudge names the fabricated serial markers")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// (b) Claimed target exists but the real re-run fails → deferred.
async function testEvidenceRequiredRefusesFailingGateTarget(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-evid2-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "make qemu-e1000-smoke passed." }),
			() => toolCall("execute_command", { command: "echo still-need-real-verify" }),
			() => toolCall("attempt_completion", { result: "Done honestly." }),
		])
		const session = await makeSession({
			task: "confirm the gate",
			client,
			workspaceRoot: ws,
			evidenceRequiredCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done honestly.")
		assert.equal(client.requests.length, 3)
		const nudge = session.state.messages.find(
			(m) => m.role === "tool" && (m.content ?? "").includes("was NOT accepted"),
		)
		assert.ok(nudge, "expected a deferral nudge")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// (d) Finding 4 (review round 1): a text-only reply that CLAIMS a gate passed
// without any real run must NOT be accepted as success when
// evidenceRequiredCompletion is on — cloud sessions default
// requireExplicitCompletion OFF, so the old code accepted "all three hard
// gates pass…" prose with zero evidence. The text must run the SAME
// extract/verify gate as attempt_completion and defer on any unverifiable
// claim.
async function testEvidenceRequiredRefusesTextOnlyFabricatedGateClaim(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-evid4-"))
	try {
		const client = new FakeLlmClient([
			// Text-only reply claiming a gate passed with no real run behind it.
			() => textReply("All three hard gates pass: make check passed cleanly, make qemu-e1000-smoke passed."),
			() => toolCall("execute_command", { command: "echo real-evidence" }),
			() => toolCall("attempt_completion", { result: "Done for real after verifying." }),
		])
		const session = await makeSession({
			task: "confirm the gates pass",
			client,
			workspaceRoot: ws,
			evidenceRequiredCompletion: true,
			// requireExplicitCompletion OFF models the cloud session shape —
			// the exact bypass the finding described.
			requireExplicitCompletion: false,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "Done for real after verifying.")
		assert.equal(client.requests.length, 3, "the fabricated text-only claim must not end the session early")
		const nudge = session.state.messages.find(
			(m) => m.role === "user" && (m.content ?? "").includes("text-only reply was NOT accepted"),
		)
		assert.ok(nudge, "expected a text-only deferral nudge")
		assert.match(nudge?.content ?? "", /make qemu-e1000-smoke/, "the nudge names the fabricated target")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// (e) Finding 4 + non-blocking #2: a text-only reply whose claims ALL verify
// (real passing gate re-run) IS accepted — and the unverified_claim event
// lands on the feed (with truncation applied) when a claim is deferred.
async function testEvidenceRequiredAcceptsTextOnlyWithVerifiedClaims(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-evid5-"))
	try {
		await fs.writeFile(
			path.join(ws, "Makefile"),
			"check:\n\t@echo 'ALL CHECKS OK'\n",
			"utf-8",
		)
		const client = new FakeLlmClient([
			// Text-only reply whose command claim re-runs AND passes, with the
			// quoted marker present in the real output.
			() => textReply("make check passed with 'ALL CHECKS OK'."),
		])
		const session = await makeSession({
			task: "confirm the gate",
			client,
			workspaceRoot: ws,
			evidenceRequiredCompletion: true,
			requireExplicitCompletion: false,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(client.requests.length, 1, "a text-only reply whose claims verify needs no retry")
		assert.ok(result.verification, "the SessionResult must carry the verification field")
		assert.equal(result.verification?.claimsChecked, 1)
		assert.equal(result.verification?.claimsPassed, 1)
		assert.equal(result.verification?.claimsUnverified, 0)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// (f) Non-blocking #2: the unverified_claim event actually lands on the feed
// with the verification counts + the first unverified claim's detail.
async function testUnverifiedClaimEventLandsOnFeed(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-evid6-"))
	try {
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "make qemu-e1000-smoke passed." }),
			() => toolCall("attempt_completion", { result: "Done for real after verifying." }),
		])
		const session = await makeSession({
			task: "confirm the gate",
			client,
			workspaceRoot: ws,
			evidenceRequiredCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected eventual success, got ${JSON.stringify(result)}`)

		// The session id is private — recover it from the events dir (one file).
		const evDir = path.join(ws, ".headlesscode", "events")
		const files = await fs.readdir(evDir)
		assert.equal(files.length, 1, `expected one events file, got: ${files.join(", ")}`)
		const sessionId = files[0].replace(/\.jsonl$/, "")
		const records = (
			await fs.readFile(path.join(evDir, files[0]), "utf-8")
		)
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l) as Record<string, unknown>)

		const unverified = records.filter((r) => r.type === "unverified_claim")
		assert.equal(unverified.length, 1, "exactly one unverified_claim event must land on the feed")
		const ev = unverified[0]
		assert.equal(ev.claimsChecked, 1)
		assert.equal(ev.claimsPassed, 0)
		assert.equal(ev.claimsUnverified, 1)
		assert.ok(typeof ev.detail === "string" && (ev.detail as string).length > 0, "detail names the unverified claim")
		assert.match(String(ev.detail), /qemu-e1000-smoke/, "the detail names the fabricated target")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// (c) Claimed target exists AND the real re-run passes → accepted, with the
// verification field recording claim counts.
async function testEvidenceRequiredAcceptsRealPassingGate(): Promise<void> {
	const ws = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-evid3-"))
	try {
		// A REAL `make check` target that actually passes — the evidence gate
		// re-runs the exact claimed command, so the claim is only accepted
		// when the ground truth genuinely confirms it.
		await fs.writeFile(
			path.join(ws, "Makefile"),
			"check:\n\t@echo 'all checks passed'\n",
			"utf-8",
		)
		const client = new FakeLlmClient([
			() => toolCall("attempt_completion", { result: "make check passed cleanly." }),
		])
		const session = await makeSession({
			task: "confirm the gate",
			client,
			workspaceRoot: ws,
			evidenceRequiredCompletion: true,
		})
		const result = await session.run()

		assert.equal(result.status, "success", `expected success, got ${JSON.stringify(result)}`)
		assert.equal(result.result, "make check passed cleanly.")
		assert.equal(client.requests.length, 1, "a real passing gate needs no nudge")
		assert.ok(result.verification, "the SessionResult must carry the verification field")
		assert.equal(result.verification?.claimsChecked, 1)
		assert.equal(result.verification?.claimsPassed, 1)
		assert.equal(result.verification?.claimsUnverified, 0)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

import { resolvePerModeEnv } from "../../cli.js";

async function testResolvePerModeEnvFallback(): Promise<void> {
	// per-mode override wins
	assert.equal(
		resolvePerModeEnv("HEADLESSCODE_OLLAMA_URL", "deepseek-reviewer", {
			HEADLESSCODE_OLLAMA_URL__DEEPSEEK_REVIEWER: "http://127.0.0.1:11500",
			HEADLESSCODE_OLLAMA_URL: "http://localhost:11435",
		}),
		"http://127.0.0.1:11500",
	)
	// falls back to the global var when no per-mode override is set
	assert.equal(
		resolvePerModeEnv("HEADLESSCODE_OLLAMA_URL", "code", {
			HEADLESSCODE_OLLAMA_URL: "http://localhost:11435",
		}),
		"http://localhost:11435",
	)
	// undefined when neither is set
	assert.equal(resolvePerModeEnv("HEADLESSCODE_OLLAMA_URL", "code", {}), undefined)
}

const tests: Array<[string, () => Promise<void>]> = [
	["resolvePerModeEnv: per-mode override wins, falls back to global, undefined when neither set", testResolvePerModeEnvFallback],
	["reasoning effort: configured value flows onto every request", testReasoningEffortFlowsIntoRequests],
	["reasoning effort: unset config falls back to the env var", testReasoningEffortEnvFallbackWhenNotConfigured],
	["reasoning effort: absent by default (endpoint default applies)", testReasoningEffortAbsentByDefault],
	["scenario 1: write_to_file + attempt_completion -> success, file written", testScenario1WriteThenCompletion],
	["final report: attempt_completion result persisted verbatim to .headlesscode/reports/<sessionId>.md", testFinalReportPersistedWithFullText],
	["scenario 2: execute_command + text answer -> success with text result", testScenario2CommandThenTextAnswer],
	[
		"requireExplicitCompletion: text-only reply is nudged, not accepted, until attempt_completion",
		testRequireExplicitCompletionRefusesTextOnlyReply,
	],
	[
		"embedded tool call recovery clears hallucinated narration from persisted history",
		testEmbeddedToolCallRecoveryClearsHallucinatedNarrationFromHistory,
	],
	[
		"the daemon's synthetic empty-reply fallback text is not persisted to history",
		testEmptyReplyFallbackTextIsNotPersistedToHistory,
	],
	[
		"the non-completing-reply nudge varies across repeated occurrences",
		testNonCompletingReplyNudgeVariesAcrossRepeatedOccurrences,
	],
	[
		"requireExplicitCompletion: repeated text-only replies -> bounded failure, never a fabricated success",
		testRequireExplicitCompletionBoundedFailureWhenNeverCompletes,
	],
	[
		"requireExplicitCompletion: a tool call written as prose is recovered and actually executed",
		testRecoversTextEmbeddedToolCallForRealTool,
	],
	[
		"verifyBeforeCompletion: attempt_completion is refused when the last execute_command failed",
		testVerifyBeforeCompletionRefusesAfterFailedCommand,
	],
	[
		"verifyBeforeCompletion: attempt_completion is accepted right away after a successful execute_command",
		testVerifyBeforeCompletionAcceptsAfterSuccessfulCommand,
	],
	[
		"verifyBeforeCompletion: attempt_completion is refused when the last edit_file/write_to_file call failed (#round-4-demo)",
		testVerifyBeforeCompletionRefusesAfterFailedEdit,
	],
	[
		"verifyBeforeCompletion: a successful read_file of the SAME file clears a stale failed-edit deferral",
		testVerifyBeforeCompletionClearsAfterReReadingSameFile,
	],
	[
		"verifyBeforeCompletion: reading a DIFFERENT file does not clear a stale failed-edit deferral",
		testVerifyBeforeCompletionStaysSetAfterReadingADifferentFile,
	],
	[
		"verifyBeforeCompletion: a re-read-only clear + a completion still claiming the edit was made is deferred",
		testVerifyBeforeCompletionDefersEditClaimAfterReReadOnly,
	],
	[
		"verifyBeforeCompletion: a re-read-only clear + an honest no-op completion is still accepted first try",
		testVerifyBeforeCompletionAcceptsHonestNoOpAfterReReadOnly,
	],
	[
		"verifyBeforeCompletion: bounded failure instead of spinning on repeated identical deferrals",
		testVerifyBeforeCompletionBoundedFailureOnRepeatedIdenticalDeferral,
	],
	[
		"requireArtifactBeforeCompletion: refuses a completion claim with zero execute_command/write_to_file/edit_file calls (#143)",
		testRequireArtifactBeforeCompletionRefusesWithNoRealToolCall,
	],
	[
		"requireArtifactBeforeCompletion: accepts once a real (even failed) artifact-producing call has happened",
		testRequireArtifactBeforeCompletionAcceptsAfterFailedAttempt,
	],
	[
		"requireArtifactBeforeCompletion: repeated attempt_completion with no real tool call ends in bounded failure",
		testRequireArtifactBeforeCompletionBoundedFailureOnRepeatedDeferral,
	],
	[
		"requireArtifactPathPattern: refuses completion until a real file matching the glob actually exists on disk",
		testRequireArtifactPathPatternRefusesUntilRealFileExists,
	],
	[
		"requireArtifactPathPattern: a wrong-extension file in the same directory does not satisfy the glob",
		testRequireArtifactPathPatternAcceptsAnEmptyDirWrongFile,
	],
	[
		"requireArtifactMinCitations: refuses a contentless stub, accepts once real file:line citations exist",
		testRequireArtifactMinCitationsRefusesAStubDoc,
	],
	[
		"requireArtifactMinCitations (#152): rejects citation-shaped strings pointing at files that don't exist",
		testRequireArtifactMinCitationsRejectsFabricatedFileCitations,
	],
	[
		"requireArtifactSections: refuses a cited-but-sectionless survey, accepts once required sections exist",
		testRequireArtifactSectionsRefusesASurveyWithoutAProposal,
	],
	[
		"verifyBeforeCompletion: refuses every fabricated completion in a session, not just the first",
		testVerifyBeforeCompletionRefusesEveryFailureNotJustTheFirst,
	],
	[
		"verifyBeforeCompletion: refuses an unsupported measurement/benchmark claim (#136)",
		testVerifyBeforeCompletionRefusesUnsupportedMeasurementClaim,
	],
	[
		"evidence-gated completion: refuses a fabricated gate claim when the claimed target doesn't exist",
		testEvidenceRequiredRefusesNonexistentGateTarget,
	],
	[
		"evidence-gated completion: refuses a gate claim whose real re-run fails",
		testEvidenceRequiredRefusesFailingGateTarget,
	],
	[
		"evidence-gated completion: accepts a real passing gate and records the verification field",
		testEvidenceRequiredAcceptsRealPassingGate,
	],
	[
		"evidence-gated completion: refuses a text-only fabricated gate claim (Finding 4)",
		testEvidenceRequiredRefusesTextOnlyFabricatedGateClaim,
	],
	[
		"evidence-gated completion: accepts a text-only reply whose claims verify",
		testEvidenceRequiredAcceptsTextOnlyWithVerifiedClaims,
	],
	[
		"evidence-gated completion: unverified_claim event lands on the feed",
		testUnverifiedClaimEventLandsOnFeed,
	],
	[
		"requireExplicitCompletion: an embedded call naming an unknown tool is never executed",
		testDoesNotExecuteEmbeddedCallForUnknownToolName,
	],
	[
		"requireExplicitCompletion: a narrated 'Called tool X' claim is recovered and actually executed",
		testRecoversNarratedToolCall,
	],
	["scenario 3: erroring tool x3 -> bounded failure", testScenario3ErroringToolBoundedFailure],
	["scenario 4: malformed JSON args -> parser fallback exercised", testScenario4MalformedJsonArgs],
	["path-traversal guard rejects escaping paths", testPathTraversalGuard],
	["max iterations -> bounded failure", testMaxIterationsBound],
	["main LLM call retries once on a transient provider error then succeeds", testMainLlmCallRetriesOnceOnTransientProviderError],
	["main LLM call fails after the retry also fails (no unbounded retry loop)", testMainLlmCallFailsAfterRetryAlsoFails],
	["main LLM call does not retry a deterministic 401", testMainLlmCallDoesNotRetryDeterministicError],
	["max iterations -> handoff summary written for the next continuation", testIterationCapHandoffSummary],
	["max iterations -> handoff write is non-fatal when its own condense call fails", testIterationCapHandoffSummaryNonFatalWhenCondenseCallFails],
	["max iterations -> handoff write retries once after a transient condense failure", testIterationCapHandoffSummaryRetriesOnceAfterCondenseFailure],
	["blind tree-walking: nudge after N consecutive read-only iterations (indexed ws)", testReadOnlyNudgeTriggered],
	["blind tree-walking: a productive tool call resets the streak", testReadOnlyNudgeResetsOnProductiveCall],
	["blind tree-walking: nudge fires on unindexed workspaces too, leading with run_tests", testReadOnlyNudgeInjectedWhenUnindexed],
	["blind tree-walking: grep/ls/sed/git/docker-ps execute_command streak trips the nudge same as read_file", testReadOnlyNudgeTriggeredByGrepStyleExecuteCommand],
	["blind tree-walking: one mutating execute_command in the streak suppresses the nudge", testReadOnlyNudgeNotTrippedByMutatingExecuteCommand],
	["read-only stagnation: a long pure-read streak ends in bounded failure before the iteration cap", testReadOnlyStallLimitTerminates],
	["read-only stagnation: an edit in the middle resets the streak (no false stall)", testReadOnlyStallLimitNotTrippedByProductiveInterleave],
	["identical-call stall: the same call repeated verbatim ends in bounded failure quickly", testIdenticalCallStallLimitTerminates],
	["identical-call stall: fires on a repeated WRITE tool call too, not just reads", testIdenticalCallStallLimitFiresOnWriteToolToo],
	["identical-call stall: a text-only reply resets the streak (no frozen penalty boost)", testTextOnlyReplyResetsTheIdenticalCallGuard],
	["identical-call stall: the tool-exclusion cooldown outlives a streak reset", testToolExclusionCooldownOutlivesAStreakReset],
	["tool-exclusion cooldown (#151): expires after exactly DEFAULT_IDENTICAL_CALL_TOOL_COOLDOWN_TURNS turns", testToolExclusionCooldownExpiresAfterExactTurnCount],
	["artifact-rejection nudge (#152): fires after 2 consecutive rejections with no read_file in between", testArtifactRejectionNudgeFiresWithoutRereading],
	["artifact-rejection nudge (#152): suppressed when a real read_file happens between rejections", testArtifactRejectionNudgeSuppressedByARealRead],
	["identical-call stall: streak at/past threshold boosts repeat_penalty on the retry request", testIdenticalCallStreakBoostsRepeatPenaltyOnRetry],
	["identical-call stall: streak at/past threshold excludes the repeated tool on the retry request", testIdenticalCallStreakExcludesTheRepeatedToolOnRetry],
	["identical-call stall: an excluded tool cannot be recovered back in via narrated-text extraction", testExcludedToolCannotBeRecoveredFromNarratedText],
	["identical-call stall: a genuine edit/verify/edit/verify interleave never trips it", testIdenticalCallStreakResetByAnyDifferentCall],
	["identical-call nudge: names the concrete next todo-list step, not just generic advice", testIdenticalCallNudgeNamesTheNextTodoStep],
	["repeated-tool-failure (#146): nudge fires after 2 real failures with VARIED args (identicalCallStreak never trips)", testToolFailureNudgeFiresOnVariedArgsRepeatedFailure],
	["repeated-tool-failure (#146): 1 failure (below threshold) does not fire the nudge", testToolFailureStreakDoesNotFireOnIdenticalCallGuardAlone],
	["repeated-tool-failure (#146): a real read_file on the same target between failures resets the streak", testToolFailureStreakResetsOnRediagnosticReadFile],
	["repeated-tool-failure (#146): a real successful edit_file call between failures resets the streak", testToolFailureStreakResetsOnSuccess],
	["repeated-tool-failure (#153): nudge adapts its wording when read_file is excluded by the identical-call cooldown", testToolFailureNudgeAdaptsWhenReadFileIsOnCooldown],
	["isReadOnlyEquivalentShellCommand: classifies read-only vs. mutating shell commands", testIsReadOnlyEquivalentShellCommandClassifiesCorrectly],
	["live snapshot: created + updated in place during a running session's iterations", testLiveSnapshotCreatedAndUpdatedDuringIterations],
	["live snapshot: removed on successful completion", testLiveSnapshotRemovedOnSuccess],
	["live snapshot: removed when the session ends with an error", testLiveSnapshotRemovedOnError],
	["live snapshot: removed when the session is aborted by budget limits", testLiveSnapshotRemovedOnBudgetExceeded],
	["execute_command: a timed-out call does NOT count toward the consecutive-mistake limit", testTimeoutDoesNotCountAsMistake],
	["execute_command: session end reaps backgrounded children (no orphans left behind)", testSessionEndReapsBackgroundedChildren],
	["checkpoints: apply_diff-only iteration still triggers a checkpoint", testCheckpointTriggeredByApplyDiffOnly],
	["checkpoints: (S1) an all-read-only turn does NOT trigger a checkpoint", testReadOnlyTurnDoesNotTriggerCheckpoint],
	["same-file batch: a second same-file edit failure gets the stale-SEARCH diagnosis", testSameFileBatchFailureGetsDiagnosis],
	["parallel reads: (S3) three read_file calls feed tool results back in tool_calls order", testParallelReadOnlyCallsFeedResultsInOrder],
	["same-file batch: a failure on a DIFFERENT file gets no diagnosis", testDifferentFileBatchFailureGetsNoDiagnosis],
	["commit guard: attempt_completion with uncommitted tracked changes gets one nudge, then is accepted", testCompletionNudgedOnUncommittedChanges],
	["commit guard: a brand-new file the session wrote also nudges, even though it's untracked", testCompletionNudgedOnNewUncommittedFile],
	["commit guard: a pre-existing untracked file the session never touched is still exempt", testNoNudgeForPreexistingUntrackedFile],
	["commit guard: a clean tree is never nudged", testCompletionAcceptedWhenClean],
	["attempt_completion bundled with other tool calls is refused; the siblings execute for real", testCompletionRefusedWhenBundledWithSiblings],
	["commit guard: committing before finishing means no nudge", testCompletionAcceptedAfterCommit],
	["commit guard: read-only modes never get the nudge", testNoNudgeInReadOnlyMode],
	["stripSupersededReasoning: (T1) keeps only the most-recent assistant reasoning", testStripSupersededReasoningKeepsOnlyMostRecent],
	["tool catalog: (T2/T3) non-vendored appends gated on the session executor's handlers", testToolCatalogGatedOnExecutorHandlers],
	["truncateHistory: no-op below the window", testTruncateHistoryNoOpBelowWindow],
	["truncateHistory: evicts in TRUNCATION_BATCH_SIZE-sized batches", testTruncateHistoryEvictsInBatches],
	["truncateHistory: never splits an assistant tool_calls / tool response group", testTruncateHistoryNeverSplitsToolCallGroup],
	["truncateHistory: prefix stays stable across a batch (cache-eligible)", testTruncateHistoryStablePrefixBetweenBatches],
	["Part E: live pricing feeds the session's BudgetTracker", testBudgetUsesLivePricingWhenAvailable],
	["Part E: no live pricing → hardcoded table fallback, unchanged behavior", testBudgetFallsBackToHardcodedTableWithoutLivePricing],
	["mode-switch cap (#151): the 6th switch is refused once modeSwitchCount reaches DEFAULT_MAX_MODE_SWITCHES", testMaxModeSwitchesCapsAtThreshold],
	["mode-switch cap (#151): switching below the threshold never trips it", testMaxModeSwitchesCapDoesNotFireBelowThreshold],
	["maxTokens (#151): the session's configured maxTokens is on every LLM request", testMaxTokensFlowsIntoRequests],
	["maxTokens (#151): zero config falls back to DEFAULT_MAX_TOKENS", testMaxTokensDefaultsWhenNotConfigured],
	["child-iteration floor (#151): a tight parent budget still caps the child at DEFAULT_MIN_CHILD_ITERATIONS", testMinChildIterationsFloorApplies],
	["recursion-depth cap (#151): new_task is refused once recursionDepth reaches DEFAULT_MAX_RECURSION_DEPTH", testMaxRecursionDepthRefusesDelegationAtCap],
	["recursion-depth cap (#151): a delegation below the cap runs the child session for real and never trips it", testMaxRecursionDepthAllowsDelegationBelowCap],
]

// Issue #140: a real live-network test (Part E, OpenRouter pricing fetch)
// can leave a stray async op (retry, dangling timer) that rejects AFTER
// all tests already ran and passed — Node's default unhandledRejection
// handling then crashes the process with a nonzero exit, so the harness
// reports isError:true for a run that objectively passed every test.
// Log it (so a real regression is still visible) without letting it flip
// the exit code once tests are done.
let testsFinished = false
process.on("unhandledRejection", (reason) => {
	if (testsFinished) {
		console.error("[test runner] unhandled rejection after tests completed (non-fatal, stray async op):", reason)
		return
	}
	throw reason
})

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
	testsFinished = true
	process.exitCode = 0
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
