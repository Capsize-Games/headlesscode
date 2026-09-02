/**
 * Tests for the opt-in local exploration phase (src/engine/local-explore.ts +
 * its HeadlessSession wiring in src/engine/loop.ts) — plans/local-explore-phase-experiment.md.
 *
 * Plain assert-based script (no test framework, no network, no API key) run
 * via `npm test` → `tsx src/engine/__tests__/local-explore.test.ts`.
 *
 * Coverage per plans/local-explore-phase-experiment.md:
 *   - iteration cap enforcement (the phase stops at maxIterations);
 *   - context-budget cap enforcement, BOTH gates: stop before a request that
 *     would exceed the budget (pre-call) and stop when a huge tool result
 *     would push the NEXT request over it (post-tool);
 *   - early `attempt_completion` termination (the "I'm done exploring, hand
 *     off" signal);
 *   - text-only-reply termination;
 *   - empty-reply nudge + recovery, and the consecutive-mistake fail-open;
 *   - Ollama-unreachable fail-open at BOTH levels: the phase returns
 *     terminatedBy "error" with a null handoff, and a real HeadlessSession
 *     with a throwing local client proceeds normally with ZERO local-phase
 *     content in the cloud history;
 *   - the handoff message is clearly labeled and distinguishable from real
 *     cloud-model history;
 *   - HEADLESSCODE_LOCAL_EXPLORE unset/false is a complete no-op (env gate +
 *     CLI flag + byte-identical cloud sessions);
 *   - the narrowed tool set: read_file, list_files, codebase_search and
 *     attempt_completion are available; execute_command and every write tool
 *     are genuinely unavailable in the local-phase executor (codebase_search
 *     is available because its embedding call is cloud-side, not local VRAM);
 *   - the real Ollama client's wire format (arguments as OBJECTS outbound,
 *     object→string normalization inbound, think:false, stream:false,
 *     num_ctx).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../loop.js"
import { createLocalExploreExecutor } from "../../tools/executor.js"
import { parseArgs, resolveEvidenceRequiredCompletion } from "../../cli.js"
import {
	buildLocalExploreHandoffMessage,
	buildLocalExploreTools,
	DEFAULT_LOCAL_EXPLORE_MODEL,
	isLocalExploreEnabled,
	LOCAL_EXPLORE_ENV,
	LocalExploreError,
	OllamaLocalChatClient,
	resolveLocalExploreContextTokens,
	resolveLocalExploreMaxIterations,
	resolveLocalExploreModel,
	resolveLocalExploreTimeoutMs,
	runLocalExplorePhase,
} from "../local-explore.js"
import type { LocalChatClient, LocalChatResponse, LocalExploreOptions, LocalExploreRequest } from "../local-explore.js"
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmResponse } from "../types.js"

// ─── Fakes ───────────────────────────────────────────────────────────────────

class FakeLocalClient implements LocalChatClient {
	calls = 0
	requests: LocalExploreRequest[] = []

	constructor(private readonly script: Array<LocalChatResponse | ((req: LocalExploreRequest) => LocalChatResponse)>) {}

	async chat(request: LocalExploreRequest): Promise<LocalChatResponse> {
		this.calls++
		this.requests.push(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLocalClient: script exhausted (local model kept calling)")
		}
		return typeof step === "function" ? step(request) : step
	}
}

function localToolCall(name: string, args: unknown, id = "local_call"): LocalChatResponse {
	const call: ChatToolCall = {
		id,
		type: "function",
		function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
	}
	return { message: { role: "assistant", content: null, tool_calls: [call] }, usage: { promptTokens: 10, completionTokens: 5 } }
}

function localEmptyReply(): LocalChatResponse {
	return { message: { role: "assistant", content: "" }, usage: { promptTokens: 10, completionTokens: 5 } }
}

function localTextReply(content: string): LocalChatResponse {
	return { message: { role: "assistant", content }, usage: { promptTokens: 10, completionTokens: 5 } }
}

class ThrowingLocalClient implements LocalChatClient {
	calls = 0
	constructor(private readonly error: Error) {}
	async chat(): Promise<LocalChatResponse> {
		this.calls++
		throw this.error
	}
}

/** Cloud-side fake (mirrors loop.test.ts's FakeLlmClient). */
class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []
	constructor(private readonly script: Array<ChatMessage | ((req: LlmRequest) => ChatMessage)>) {}
	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (cloud model kept calling)")
		}
		return { message: typeof step === "function" ? step(request) : step }
	}
}

function cloudTextReply(content: string): ChatMessage {
	return { role: "assistant", content }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeTmpWorkspace(files: Record<string, string> = {}): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-explore-test-"))
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel)
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, content, "utf-8")
	}
	return dir
}

const SHORT_SYSTEM_PROMPT = "You explore."

async function runPhase(options: {
	workspaceRoot: string
	client: LocalChatClient
	taskText?: string
	maxIterations?: number
	contextTokens?: number
	systemPrompt?: string
	maxHandoffChars?: number
}) {
	return runLocalExplorePhase({
		workspaceRoot: options.workspaceRoot,
		taskText: options.taskText ?? "find where the task is handled",
		client: options.client,
		maxIterations: options.maxIterations,
		contextTokens: options.contextTokens,
		systemPrompt: options.systemPrompt ?? SHORT_SYSTEM_PROMPT,
		maxHandoffChars: options.maxHandoffChars,
	})
}

async function makeSession(options: {
	workspaceRoot: string
	client: LlmClient
	task: string
	localExplore?: boolean | LocalExploreOptions
}) {
	const session = new HeadlessSession({
		workspaceRoot: options.workspaceRoot,
		mode: "code",
		model: "fake-model",
		taskText: options.task,
		llmClient: options.client,
		maxIterations: 10,
		consecutiveErrorLimit: 3,
		windowSize: 40,
		checkpoints: false,
		localExplore: options.localExplore,
	})
	return session
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = []

function test(name: string, fn: () => Promise<void> | void) {
	tests.push({ name, fn })
}

// 1. Iteration cap enforcement: a local model that never stops must be cut
// off at maxIterations, and the partial transcript must still be handed off.
test("iteration cap stops the phase and still hands off what was gathered", async () => {
	const ws = await makeTmpWorkspace({ "src/index.ts": "export const x = 1\n" })
	const client = new FakeLocalClient([
		localToolCall("list_files", { recursive: true }),
		localToolCall("list_files", { recursive: true }),
		localToolCall("list_files", { recursive: true }),
	])
	const result = await runPhase({ workspaceRoot: ws, client, maxIterations: 3 })

	assert.equal(result.terminatedBy, "iteration-cap")
	assert.equal(result.iterations, 3)
	assert.equal(client.calls, 3)
	assert.equal(client.requests.length, 3)
	assert.ok(result.detail?.includes("iteration cap (3) reached"), `detail: ${result.detail}`)
	// Seed (2) + 3 × (assistant call + tool result).
	assert.equal(result.messages.length, 2 + 3 * 2)
	assert.ok(result.handoffMessage, "handoff present even on iteration cap")
	assert.ok(result.handoffMessage!.content!.includes("called list_files"), "transcript includes the tool calls")
})

// 2a. Context-budget enforcement, PRE-CALL gate: the phase must stop BEFORE
// sending a request that would exceed the budget — zero model calls made.
test("context budget stops the phase before the first request would exceed it", async () => {
	const ws = await makeTmpWorkspace()
	const client = new FakeLocalClient([localToolCall("list_files", {})])
	// A 10_000-char system prompt alone estimates ≈2_500 tokens » 50 budget.
	const result = await runPhase({ workspaceRoot: ws, client, contextTokens: 50, systemPrompt: "x".repeat(10_000) })

	assert.equal(result.terminatedBy, "context-budget")
	assert.equal(result.iterations, 0)
	assert.equal(client.calls, 0, "no request may be sent once the budget is already exceeded")
	assert.ok(result.estimatedPromptTokens > 50, `estimated ${result.estimatedPromptTokens} tokens > 50 budget`)
	assert.equal(result.handoffMessage, null, "nothing was gathered — nothing to hand off")
})

// 2b. Context-budget enforcement, POST-TOOL gate: a single huge tool result
// can jump the budget even though the request that triggered it was under it;
// the phase must stop before any NEXT request would exceed the ceiling.
test("context budget stops the phase after a huge tool result, before the next request", async () => {
	const ws = await makeTmpWorkspace({ "big.txt": "y".repeat(2_000) })
	const client = new FakeLocalClient([localToolCall("read_file", { path: "big.txt" })])
	const result = await runPhase({ workspaceRoot: ws, client, contextTokens: 100 })

	assert.equal(result.terminatedBy, "context-budget")
	// The first iteration ran the read and then broke before the NEXT request;
	// `iterations` counts completed non-terminating iterations, so it is 0.
	assert.equal(result.iterations, 0)
	assert.equal(client.calls, 1, "the second request (which would exceed the budget) is never sent")
	assert.ok(result.estimatedPromptTokens > 100, `estimated ${result.estimatedPromptTokens} tokens > 100 budget`)
	// The read DID happen before the gate tripped — that content is worth handing off.
	assert.ok(result.handoffMessage, "transcript with the completed read is handed off")
	assert.ok(result.handoffMessage!.content!.includes("read_file"), "transcript includes the read_file call")
})

// 3. Early attempt_completion: the explicit "I'm done exploring, hand off"
// signal terminates the phase and its result text lands in the handoff.
test("attempt_completion terminates early with its report in the handoff", async () => {
const ws = await makeTmpWorkspace()
const client = new FakeLocalClient([localToolCall("attempt_completion", { result: "Found it: src/engine/loop.ts handles the loop." })])
const result = await runPhase({ workspaceRoot: ws, client })

assert.equal(result.terminatedBy, "attempt_completion")
assert.equal(result.iterations, 0) // terminated on the first iteration
assert.equal(result.messages.length, 3) // system + user + assistant
	assert.ok(result.handoffMessage)
	assert.ok(result.handoffMessage!.content!.includes("Found it: src/engine/loop.ts handles the loop."))
	assert.ok(result.handoffMessage!.content!.includes("attempt_completion:"))
})

// 4. Text-only reply: the model answers directly — its text is the findings.
test("text-only reply terminates the phase and hands off the text", async () => {
	const ws = await makeTmpWorkspace()
	const client = new FakeLocalClient([localTextReply("Here is what I found: the entry point is src/index.ts.")])
	const result = await runPhase({ workspaceRoot: ws, client })

	assert.equal(result.terminatedBy, "text-only-reply")
	assert.equal(result.iterations, 0) // terminated on the first iteration
	assert.ok(result.handoffMessage)
	assert.ok(result.handoffMessage!.content!.includes("Here is what I found: the entry point is src/index.ts."))
})

// 5. Empty reply → nudge → model recovers and finishes cleanly.
test("empty reply is nudged and the model can recover", async () => {
	const ws = await makeTmpWorkspace()
	const client = new FakeLocalClient([localEmptyReply(), localToolCall("attempt_completion", { result: "Recovered after the nudge." })])
	const result = await runPhase({ workspaceRoot: ws, client })

	assert.equal(result.terminatedBy, "attempt_completion")
	assert.equal(result.iterations, 1) // the empty iteration + the terminating one
	const nudge = result.messages.find((m) => m.role === "user" && (m.content ?? "").includes("no tool calls and no text"))
	assert.ok(nudge, "a nudge message was injected after the empty reply")
})

// 6. Consecutive empty replies are a local-model failure — fail open.
test("consecutive empty replies abandon the phase (fail open)", async () => {
	const ws = await makeTmpWorkspace()
	const client = new FakeLocalClient([localEmptyReply(), localEmptyReply(), localEmptyReply()])
	const result = await runPhase({ workspaceRoot: ws, client })

	assert.equal(result.terminatedBy, "error")
	assert.equal(result.iterations, 2) // third empty trips the mistake limit on the last iteration
	// seed(2) + 3 assistants + 2 nudges — the third empty breaks BEFORE a nudge.
	assert.equal(result.messages.length, 7)
	assert.ok(result.detail?.includes("empty replies"))
	assert.equal(result.handoffMessage, null, "a failed phase contributes zero local content")
})

// 7. Ollama unreachable (phase level): terminate with "error", null handoff.
test("Ollama-unreachable fails open at the phase level", async () => {
	const ws = await makeTmpWorkspace()
	const client = new ThrowingLocalClient(new LocalExploreError("fetch failed: connection refused to localhost:11434"))
	const result = await runPhase({ workspaceRoot: ws, client })

	assert.equal(result.terminatedBy, "error")
	assert.equal(result.iterations, 0)
	assert.ok(result.detail?.includes("connection refused"), `detail: ${result.detail}`)
	assert.equal(result.handoffMessage, null)
})

// 8. Ollama unreachable (session level): the session proceeds normally with
// zero local-phase content — byte-identical cloud history to a session where
// the phase was never enabled.
test("Ollama-unreachable fails open at the session level — session proceeds cloud-only", async () => {
	const ws = await makeTmpWorkspace({ "src/index.ts": "export const x = 1\n" })

	const controlClient = new FakeLlmClient([cloudTextReply("The entry point is src/index.ts.")])
	const control = await makeSession({ workspaceRoot: ws, task: "Explain the entry point.", client: controlClient })
	const controlResult = await control.run()

	const failingClient = new FakeLlmClient([cloudTextReply("The entry point is src/index.ts.")])
	const failing = await makeSession({
		workspaceRoot: ws,
		task: "Explain the entry point.",
		client: failingClient,
		localExplore: { workspaceRoot: ws, client: new ThrowingLocalClient(new LocalExploreError("connection refused")) },
	})
	const failingResult = await failing.run()

	assert.equal(failingResult.status, "success")
	assert.equal(failingResult.result, controlResult.result)
	// Cloud history must be byte-identical: no "[Local exploration phase" message.
	const serialize = (r: LlmRequest[]) => JSON.stringify(r.map((x) => x.messages))
	assert.equal(serialize(failingClient.requests), serialize(controlClient.requests))
	assert.ok(!serialize(failingClient.requests).includes("[Local exploration phase"), "no local-phase content leaked into cloud history")
})

// 9. A session where the local phase RUNS successfully must fold the labeled
// handoff into the cloud context at index 2.
test("a successful local phase folds a labeled handoff into the cloud's first request", async () => {
	const ws = await makeTmpWorkspace({ "src/index.ts": "export const x = 1\n" })
	const localClient = new FakeLocalClient([localToolCall("attempt_completion", { result: "Found src/index.ts." })])
	const cloudClient = new FakeLlmClient([cloudTextReply("Done.")])

	const session = await makeSession({
		workspaceRoot: ws,
		task: "Where is the entry point?",
		client: cloudClient,
		localExplore: { workspaceRoot: ws, client: localClient },
	})
	const result = await session.run()

	assert.equal(result.status, "success")
	assert.equal(localClient.calls, 1, "the local phase ran exactly once")
	// NOTE: loop.ts passes state.messages by reference, so the array the cloud
	// client captured at request time has since grown with the model's reply —
	// only inspect the FIRST three seeded messages.
	const firstCloudMessages = cloudClient.requests[0].messages as unknown as ChatMessage[]
	assert.ok(firstCloudMessages.length >= 3)
	assert.equal(firstCloudMessages[0].role, "system")
	assert.equal(firstCloudMessages[1].role, "user")
	const handoff = firstCloudMessages[2]
	assert.equal(handoff.role, "user")
	assert.ok(handoff.content!.startsWith("[Local exploration phase"), "handoff is clearly labeled")
	assert.ok(handoff.content!.includes("=== LOCAL EXPLORATION TRANSCRIPT ==="))
	assert.ok(handoff.content!.includes("This is NOT your own prior work"))
	assert.ok(handoff.content!.includes("Found src/index.ts."))
})

// 10. Handoff label test (standalone): distinguishability from cloud history.
test("handoff message is clearly labeled and distinguishable from cloud history", () => {
	const handoff = buildLocalExploreHandoffMessage({
		terminatedBy: "attempt_completion",
		iterations: 2,
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: "task" },
			{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
			{ role: "tool", content: "contents of a.ts", tool_call_id: "c1", name: "read_file" },
			{ role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "attempt_completion", arguments: '{"result":"a.ts is the answer"}' } }] },
		],
		detail: undefined,
	})

	assert.ok(handoff)
	const content = handoff!.content!
	assert.ok(content.startsWith("[Local exploration phase"))
	assert.ok(content.includes("This is NOT your own prior work"), "explicitly not the cloud model's own turns")
	assert.ok(content.includes("=== LOCAL EXPLORATION TRANSCRIPT ==="))
	assert.ok(content.includes("=== END LOCAL EXPLORATION TRANSCRIPT ==="))
	assert.ok(content.includes('called read_file({"path":"a.ts"})'))
	assert.ok(content.includes("[tool result for read_file] contents of a.ts"))
	assert.ok(content.includes("attempt_completion: a.ts is the answer"))
	assert.ok(!content.includes("[Condensed summary"), "not confused with the condensation label")
})

// 11. Handoff truncation: oversized transcripts are capped with a marker.
test("handoff transcript is capped at maxHandoffChars", async () => {
	const ws = await makeTmpWorkspace()
	const client = new FakeLocalClient([localToolCall("attempt_completion", { result: "z".repeat(5_000) })])
	const result = await runPhase({ workspaceRoot: ws, client, maxHandoffChars: 500 })

	assert.ok(result.handoffMessage)
	assert.ok(result.handoffMessage!.content!.includes("transcript truncated at 500 chars"))
	// Uncapped this would be ~5,400 chars; the cap keeps it to ~1,003 (the
	// label header/footer/marker account for the ~500-char overhead).
	assert.ok(result.handoffMessage!.content!.length < 1_200)
})

// 12. HEADLESSCODE_LOCAL_EXPLORE env gate: unset/false/0 → OFF; 1/true → ON.
test("HEADLESSCODE_LOCAL_EXPLORE env gate: unset/false is off, true/1 is on", () => {
	assert.equal(isLocalExploreEnabled({}), false)
	assert.equal(isLocalExploreEnabled({ [LOCAL_EXPLORE_ENV]: "" }), false)
	assert.equal(isLocalExploreEnabled({ [LOCAL_EXPLORE_ENV]: "0" }), false)
	assert.equal(isLocalExploreEnabled({ [LOCAL_EXPLORE_ENV]: "false" }), false)
	assert.equal(isLocalExploreEnabled({ [LOCAL_EXPLORE_ENV]: "FALSE" }), false)
	assert.equal(isLocalExploreEnabled({ [LOCAL_EXPLORE_ENV]: "1" }), true)
	assert.equal(isLocalExploreEnabled({ [LOCAL_EXPLORE_ENV]: "true" }), true)
	assert.equal(isLocalExploreEnabled({ [LOCAL_EXPLORE_ENV]: "yes" }), true)
})

// 13. Env resolvers for the phase's tunables.
test("env resolvers pick up HEADLESSCODE_LOCAL_EXPLORE_* overrides", () => {
	assert.equal(resolveLocalExploreModel({}), DEFAULT_LOCAL_EXPLORE_MODEL)
	assert.equal(resolveLocalExploreModel({ HEADLESSCODE_LOCAL_EXPLORE_MODEL: "qwen3:8b" }), "qwen3:8b")
	assert.equal(resolveLocalExploreMaxIterations({}), 15)
	assert.equal(resolveLocalExploreMaxIterations({ HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS: "7" }), 7)
	assert.equal(resolveLocalExploreContextTokens({}), 131_072)
	assert.equal(resolveLocalExploreContextTokens({ HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS: "65536" }), 65_536)
	assert.equal(resolveLocalExploreTimeoutMs({}), 120_000)
	assert.equal(resolveLocalExploreTimeoutMs({ HEADLESSCODE_LOCAL_EXPLORE_TIMEOUT_MS: "5000" }), 5_000)
})

// 14. CLI flag: --local-explore turns the phase on; absent → off.
test("--local-explore CLI flag parses, absent is off", () => {
	assert.equal(parseArgs(["--local-explore", "--task", "x"]).options.localExplore, true)
	assert.equal(parseArgs(["--task", "x"]).options.localExplore, false)
	assert.equal(parseArgs([]).options.localExplore, false)
})

// 14b. Evidence-gated completion flag (fabrication fix, 2026-09-01):
// --require-evidence turns the gate on; absent → off.
test("--require-evidence CLI flag parses, absent is off", () => {
	assert.equal(parseArgs(["--require-evidence", "--task", "x"]).options.requireEvidence, true)
	assert.equal(parseArgs(["--task", "x"]).options.requireEvidence, false)
	assert.equal(parseArgs([]).options.requireEvidence, false)
})

// 14c. HEADLESSCODE_REQUIRE_EVIDENCE env var forces evidence-gated completion
// on even for a pure cloud session (plan A5: force the gate without code
// changes). The pure resolver honors flag, env var, and the local-backend
// default in that precedence order.
test("HEADLESSCODE_REQUIRE_EVIDENCE env forces the evidence gate on (review fix 1)", () => {
	const local = true
	const cloud = false
	// Env var alone turns it on for a CLOUD session (the exact case the old
	// expression missed — options.requireEvidence was the only cloud lever).
	assert.equal(resolveEvidenceRequiredCompletion(false, { HEADLESSCODE_REQUIRE_EVIDENCE: "1" }, cloud), true)
	assert.equal(resolveEvidenceRequiredCompletion(false, { HEADLESSCODE_REQUIRE_EVIDENCE: "true" }, cloud), true)
	// Unset → off for cloud.
	assert.equal(resolveEvidenceRequiredCompletion(false, {}, cloud), false)
	// Local backend default ON unless explicitly disabled.
	assert.equal(resolveEvidenceRequiredCompletion(false, {}, local), true)
	assert.equal(resolveEvidenceRequiredCompletion(false, { HEADLESSCODE_ALLOW_UNVERIFIED_COMPLETION: "1" }, local), false)
	// Explicit flag always wins, and beats the env override to OFF is impossible
	// (no --no-require-evidence) — but flag OR env is true.
	assert.equal(resolveEvidenceRequiredCompletion(true, {}, cloud), true)
	assert.equal(
		resolveEvidenceRequiredCompletion(true, { HEADLESSCODE_ALLOW_UNVERIFIED_COMPLETION: "1" }, local),
		true,
	)
})

// 15. HEADLESSCODE_LOCAL_EXPLORE unset/false is a COMPLETE no-op at the
// session level: `undefined` and `false` produce byte-identical cloud
// history, and the local client is never constructed/called.
test("local explore disabled (unset/false) is a complete no-op", async () => {
	const ws = await makeTmpWorkspace({ "src/index.ts": "export const x = 1\n" })

	const unsetClient = new FakeLlmClient([cloudTextReply("src/index.ts.")])
	const unset = await makeSession({ workspaceRoot: ws, task: "Where is the entry point?", client: unsetClient })
	await unset.run()

	const disabledClient = new FakeLlmClient([cloudTextReply("src/index.ts.")])
	const disabled = await makeSession({
		workspaceRoot: ws,
		task: "Where is the entry point?",
		client: disabledClient,
		localExplore: false,
	})
	await disabled.run()

	const serialize = (r: LlmRequest[]) => JSON.stringify(r.map((x) => x.messages))
	assert.equal(serialize(disabledClient.requests), serialize(unsetClient.requests), "cloud history identical")
	assert.ok(!serialize(disabledClient.requests).includes("Local exploration"), "no local content")
})

// 16. Narrowed tool set: the local-phase executor exposes read_file,
// list_files, codebase_search, attempt_completion — every write tool and
// execute_command is genuinely unavailable, not just unused. codebase_search
// is available because its embedding call is cloud-side (OpenRouter), not a
// local model that would have to share VRAM with the exploration model.
test("local-phase executor exposes read_file / list_files / codebase_search / attempt_completion", async () => {
	const ws = await makeTmpWorkspace({ "a.txt": "hello" })
	const executor = createLocalExploreExecutor(ws)

	// The four available tools work.
	const read = await executor.execute("read_file", { path: "a.txt" })
	assert.equal(read.isError, false)
	assert.ok(read.content.includes("hello"))
	const list = await executor.execute("list_files", { recursive: true })
	assert.equal(list.isError, false)
	const complete = await executor.execute("attempt_completion", { result: "done" })
	assert.equal(complete.isError, false)
	assert.ok(complete.content.includes("done"))
	// codebase_search is registered (no index in the fixture → the actionable
	// no-index error, NOT the "not implemented" stub).
	const search = await executor.execute("codebase_search", { query: "hello" })
	assert.equal(search.isError, true)
	assert.ok(search.content.includes("no codebase index found"), search.content)

	// Everything else is a stub — genuinely unavailable.
	const unavailable = ["execute_command", "write_to_file", "apply_diff", "search_replace", "edit_file", "ask_followup_question"]
	for (const name of unavailable) {
		const res = await executor.execute(name, name === "execute_command" ? { command: "true" } : {})
		assert.equal(res.isError, true, `${name} must be an error`)
		assert.ok(res.content.includes("not implemented"), `${name}: ${res.content}`)
	}
	// The advertised tool list contains exactly the four allowed tools
	// (order follows the native tool registry — compare sorted).
	const names = buildLocalExploreTools()
		.map((t) => (t.type === "function" ? t.function.name : t.type))
		.sort()
	assert.deepEqual(names, ["attempt_completion", "codebase_search", "list_files", "read_file"].sort())
})

// 17. Real Ollama client wire format (fake fetch): arguments are OBJECTS
// outbound (Ollama rejects the JSON-string form), objects are normalized to
// strings inbound, and think:false + stream:false + num_ctx are set.
test("Ollama client sends object arguments + think:false and normalizes responses", async () => {
	let capturedBody: Record<string, unknown> | undefined
	const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		assert.equal(String(input), "http://localhost:11434/api/chat")
		capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
		return new Response(
			JSON.stringify({
				message: {
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "call_abc",
							function: { index: 0, name: "read_file", arguments: { path: "package.json", offset: 0 } },
						},
					],
				},
				done: true,
				done_reason: "stop",
				prompt_eval_count: 42,
				eval_count: 7,
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)
	}

	const client = new OllamaLocalChatClient({ baseUrl: "http://localhost:11434/", timeoutMs: 5_000, fetchImpl })
	const response = await client.chat({
		model: "qwen3.5:9b",
		numCtx: 65_536,
		maxTokens: 2048,
		tools: [],
		messages: [
			{ role: "system", content: "s" },
			{ role: "user", content: "task" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "c1", type: "function", function: { name: "list_files", arguments: '{"recursive":true}' } },
				],
			},
			{ role: "tool", content: "some files", tool_call_id: "c1", name: "list_files" },
		],
	})

	// Outbound: object arguments, no string form; think/stream off; num_ctx set.
	const outMessages = capturedBody!.messages as Array<Record<string, unknown>>
	const outCall = (outMessages[2].tool_calls as Array<Record<string, unknown>>)[0]
	assert.deepEqual(outCall.function, { name: "list_files", arguments: { recursive: true } }, "arguments must be an OBJECT outbound")
	assert.equal(capturedBody!.think, false)
	assert.equal(capturedBody!.stream, false)
	assert.equal((capturedBody!.options as Record<string, unknown>).num_ctx, 65_536)
	assert.equal((capturedBody!.options as Record<string, unknown>).num_predict, 2048)
	assert.equal(capturedBody!.model, "qwen3.5:9b")

	// Inbound: object arguments normalized to a JSON string (harness format).
	assert.equal(response.message.tool_calls![0].function.name, "read_file")
	assert.equal(response.message.tool_calls![0].function.arguments, '{"path":"package.json","offset":0}')
	// Ollama sends content:"" when a tool call is made; the client passes it
	// through (the loop treats empty content as an empty reply → nudge).
	assert.equal(response.message.content, "")
	assert.deepEqual(response.usage, { promptTokens: 42, completionTokens: 7 })
})

// 18. Ollama client error handling: non-2xx and network failures become
// LocalExploreError (which the phase catches → fail open).
test("Ollama client wraps HTTP and network failures in LocalExploreError", async () => {
	const httpErrorClient = new OllamaLocalChatClient({
		baseUrl: "http://localhost:11434",
		timeoutMs: 5_000,
		fetchImpl: async () => new Response("model not found", { status: 404 }),
	})
	await assert.rejects(
		() => httpErrorClient.chat({ model: "m", numCtx: 1000, maxTokens: 10, tools: [], messages: [] }),
		(err) => err instanceof LocalExploreError && err.message.includes("HTTP 404"),
	)

	const netErrorClient = new OllamaLocalChatClient({
		baseUrl: "http://localhost:11434",
		timeoutMs: 5_000,
		fetchImpl: async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:11434")
		},
	})
	await assert.rejects(
		() => netErrorClient.chat({ model: "m", numCtx: 1000, maxTokens: 10, tools: [], messages: [] }),
		(err) => err instanceof LocalExploreError && err.message.includes("ECONNREFUSED"),
	)
})

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main() {
	let failed = 0
	for (const { name, fn } of tests) {
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
	console.log(`\nAll ${tests.length} local-explore tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
