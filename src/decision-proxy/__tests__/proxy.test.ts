/**
 * Tests for the decision-proxy agent (src/decision-proxy/proxy.ts + its CLI
 * wiring) — plans/decision-proxy-agent.md. Plain assert-based script (no test
 * framework, no network, no API key) run via `npm test` →
 * `tsx src/decision-proxy/__tests__/proxy.test.ts`.
 *
 * Coverage:
 *   - sentinel parsing (parseProxyResponse): answer / uncertain / malformed /
 *     markdown-fenced JSON / empty;
 *   - original-task-text resolution (resolveTaskText): --task verbatim wins,
 *     --task-file read verbatim, orchestrator-state task_file lookup, and the
 *     "nothing available" case;
 *   - `_decision-proxy` mode-models.json key resolution (extraKeys pattern);
 *   - processQuestion's three outcomes + the fail-closed paths: uncertain
 *     writes nothing, LLM error writes nothing, malformed response writes
 *     nothing, missing task text skips the LLM call entirely, and a marker
 *     that is no longer current is never answered (no stale-answer poisoning);
 *   - the poll loop end-to-end: marker in → `[decision-proxy] <answer>` file
 *     out, single LLM call even while the marker persists, and the audit log
 *     records the outcome;
 *   - the env gate (HEADLESSCODE_DECISION_PROXY) and the CLI arg parser.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { Logger } from "../../engine/logger.js"
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse } from "../../engine/types.js"
import {
	DECISION_PROXY_ANSWER_PREFIX,
	buildProxyUserPrompt,
	isDecisionProxyEnabled,
	markerKey,
	parseProxyResponse,
	processQuestion,
	readNeedsDecisionMarker,
	resolveDecisionProxyLlmTimeout,
	resolveDecisionProxyModel,
	resolveDecisionProxyPollInterval,
	resolveTaskText,
	runDecisionProxy,
	type DecisionProxyOptions,
	type NeedsDecisionMarker,
} from "../proxy.js"
import { parseDecisionProxyArgs } from "../cli.js"

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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) {
			return
		}
		await sleep(20)
	}
	throw new Error("waitFor: condition not met within timeout")
}

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** Minimal fake LLM client — mirrors src/engine/__tests__/loop.test.ts. */
class FakeLlmClient implements LlmClient {
	requests: LlmRequest[] = []

	constructor(private readonly script: Array<ChatMessage | ((req: LlmRequest) => ChatMessage)>) {}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		const step = this.script.shift()
		if (!step) {
			throw new Error("FakeLlmClient: script exhausted (model kept calling)")
		}
		const message = typeof step === "function" ? step(request) : step
		return { message }
	}

	get callCount(): number {
		return this.requests.length
	}
}

function textReply(content: string): ChatMessage {
	return { role: "assistant", content }
}

function proxyBaseOptions(ws: string, client: LlmClient): DecisionProxyOptions {
	return {
		workspaceRoot: ws,
		task: "Improve the codebase-search index builder in src/codesearch/index.ts. Do not touch any other subsystem.",
		model: "test/proxy-model",
		llmClient: client,
		logger: new Logger({ level: "silent" }),
	}
}

async function writeMarker(ws: string, question: string, suggestions?: string[]): Promise<string> {
	const askedAt = new Date().toISOString()
	await fs.writeFile(
		path.join(ws, NEEDS_DECISION),
		JSON.stringify({ question, ...(suggestions ? { suggestions } : {}), askedAt }, null, 2) + "\n",
		"utf-8",
	)
	return askedAt
}

// ─── (1) sentinel parsing ───────────────────────────────────────────────────

async function testParseAnswer(): Promise<void> {
	const parsed = parseProxyResponse('{"answer": "Work only on src/codesearch/index.ts"}')
	assert.equal(parsed.kind, "answered")
	if (parsed.kind === "answered") {
		assert.equal(parsed.answer, "Work only on src/codesearch/index.ts")
	}
}

async function testParseAnswerTrimsWhitespace(): Promise<void> {
	const parsed = parseProxyResponse('  {"answer": "  pick ./src/frontend-config.json  "}  ')
	assert.equal(parsed.kind, "answered")
	if (parsed.kind === "answered") {
		assert.equal(parsed.answer, "pick ./src/frontend-config.json")
	}
}

async function testParseUncertain(): Promise<void> {
	const parsed = parseProxyResponse('{"uncertain": true}')
	assert.equal(parsed.kind, "uncertain")
}

async function testParseMarkdownFencedJson(): Promise<void> {
	// Models sometimes wrap JSON in a code fence — one fence pair is tolerated.
	const parsed = parseProxyResponse('```json\n{"answer": "Yes"}\n```')
	assert.equal(parsed.kind, "answered")
	if (parsed.kind === "answered") {
		assert.equal(parsed.answer, "Yes")
	}
}

async function testParseMalformed(): Promise<void> {
	const cases = [
		"",
		"   ",
		"I think you should edit the config file", // free text, not JSON
		'{"answer": ""}', // empty answer
		'{"answer": 42}', // non-string answer
		'{"uncertain": "yes"}', // wrong uncertain type
		"[1, 2, 3]", // array, not object
		"null",
		'{"answer": "unterminated',
	]
	for (const c of cases) {
		const parsed = parseProxyResponse(c)
		assert.equal(parsed.kind, "malformed", `expected malformed for ${JSON.stringify(c)}`)
	}
	// A contradictory "uncertain AND answer" response must abstain (fail
	// closed — never let doubt become a written answer), not answer.
	assert.equal(parseProxyResponse('{"uncertain": true, "answer": "both"}').kind, "uncertain")
}

// ─── (2) original task text resolution ──────────────────────────────────────

async function testResolveTaskFromCliFlag(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-taskflag-")
	try {
		const resolved = resolveTaskText(ws, { task: "  verbatim task  " })
		assert.ok(resolved !== null)
		assert.equal(resolved?.source, "cli-task")
		assert.equal(resolved?.text, "  verbatim task  ")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testResolveTaskFromTaskFile(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-taskfile-")
	try {
		await fs.writeFile(path.join(ws, "task.md"), "Original task from a file, verbatim.\nSecond line.", "utf-8")
		const resolved = resolveTaskText(ws, { taskFile: "task.md" })
		assert.ok(resolved !== null)
		assert.equal(resolved?.source, `task-file:${path.join(ws, "task.md")}`)
		assert.equal(resolved?.text, "Original task from a file, verbatim.\nSecond line.")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testResolveTaskFromOrchestratorState(): Promise<void> {
	// Simulate a round: <repo>/.worktrees/.orchestrator-state.json names a
	// group with worktree .worktrees/w1 and task_file plans/parallel-tasks/…
	// The proxy watches <repo>/.worktrees/w1 and must find the task file.
	const repo = await mkTmpWorkspace("hc-proxy-orch-")
	try {
		const wt = path.join(repo, ".worktrees", "w1")
		await fs.mkdir(wt, { recursive: true })
		await fs.mkdir(path.join(repo, "plans", "parallel-tasks"), { recursive: true })
		await fs.writeFile(path.join(repo, "plans", "parallel-tasks", "w1-issue27.md"), "Fix the greet bug (#27)", "utf-8")
		await fs.writeFile(
			path.join(repo, ".worktrees", ".orchestrator-state.json"),
			JSON.stringify({
				batch: "test",
				updated: new Date().toISOString(),
				groups: [{ name: "w1", worktree: ".worktrees/w1", task_file: "plans/parallel-tasks/w1-issue27.md", status: "running" }],
			}),
			"utf-8",
		)

		const resolved = resolveTaskText(wt, {})
		assert.ok(resolved !== null, "orchestrator-state lookup should find the task file")
		assert.equal(resolved?.source, `orchestrator:${path.join(repo, "plans", "parallel-tasks", "w1-issue27.md")}`)
		assert.equal(resolved?.text, "Fix the greet bug (#27)")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testResolveTaskNone(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-notask-")
	try {
		assert.equal(resolveTaskText(ws, {}), null)
		assert.equal(resolveTaskText(ws, { task: "   " }), null) // blank task flag ignored
		assert.equal(resolveTaskText(ws, { taskFile: "does-not-exist.md" }), null)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (3) `_decision-proxy` model key ────────────────────────────────────────

async function testResolveModelPrefersDecisionProxyKey(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-model-")
	try {
		await fs.mkdir(path.join(ws, ".headlesscode"), { recursive: true })
		await fs.writeFile(
			path.join(ws, ".headlesscode", "mode-models.json"),
			JSON.stringify({
				"_decision-proxy": "qwen/qwen3-8b",
				code: "deepseek/deepseek-v4-flash",
				_default: "deepseek/deepseek-v4-flash",
			}),
			"utf-8",
		)
		assert.equal(resolveDecisionProxyModel(ws, {}, undefined), "qwen/qwen3-8b")
		assert.equal(resolveDecisionProxyModel(ws, {}, "explicit/override"), "explicit/override")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testResolveModelFallsBackWithoutKey(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-model2-")
	try {
		await fs.mkdir(path.join(ws, ".headlesscode"), { recursive: true })
		await fs.writeFile(
			path.join(ws, ".headlesscode", "mode-models.json"),
			JSON.stringify({ code: "deepseek/deepseek-v4-flash", _default: "deepseek/deepseek-default" }),
			"utf-8",
		)
		assert.equal(resolveDecisionProxyModel(ws, {}, undefined), "deepseek/deepseek-v4-flash") // code entry wins over _default
		await fs.writeFile(
			path.join(ws, ".headlesscode", "mode-models.json"),
			JSON.stringify({ _default: "deepseek/deepseek-default" }),
			"utf-8",
		)
		assert.equal(resolveDecisionProxyModel(ws, {}, undefined), "deepseek/deepseek-default")
		await fs.rm(path.join(ws, ".headlesscode"), { recursive: true, force: true })
		assert.equal(resolveDecisionProxyModel(ws, { OPENROUTER_MODEL: "env/fallback" }, undefined), "env/fallback")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (4) processQuestion outcomes ───────────────────────────────────────────

async function testProcessQuestionAnsweredWritesPrefixedAnswer(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-answered-")
	try {
		const client = new FakeLlmClient([textReply('{"answer": "Work only on src/codesearch/index.ts"}')])
		const askedAt = await writeMarker(ws, "Should I touch other subsystems?")
		const marker = (await readNeedsDecisionMarker(ws))!

		const result = await processQuestion(proxyBaseOptions(ws, client), marker)

		assert.equal(result.outcome, "answered")
		assert.equal(client.callCount, 1)
		assert.ok(result.latencyMs >= 0)
		const answer = await fs.readFile(path.join(ws, DECISION_ANSWER), "utf-8")
		assert.equal(answer, `${DECISION_PROXY_ANSWER_PREFIX}Work only on src/codesearch/index.ts`)
		// The user prompt must contain the ORIGINAL task verbatim + the question.
		const req = client.requests[0]
		const user = req.messages[1]
		assert.equal(user.role, "user")
		assert.match(String(user.content), /Improve the codebase-search index builder/)
		assert.match(String(user.content), /Should I touch other subsystems\?/)
		// The exact answer the model sees (trimmed by the worker) carries the prefix.
		assert.ok(!answer.endsWith("\n"), "answer file should not have a trailing newline (matches headlesscode-answer.sh)")
		assert.equal(markerKey(marker), `${askedAt}\u0000Should I touch other subsystems?`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testProcessQuestionUncertainWritesNothing(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-uncertain-")
	try {
		const client = new FakeLlmClient([textReply('{"uncertain": true}')])
		await writeMarker(ws, "How much memory budget should I target?")
		const marker = (await readNeedsDecisionMarker(ws))!

		const result = await processQuestion(proxyBaseOptions(ws, client), marker)

		assert.equal(result.outcome, "uncertain")
		assert.equal(client.callCount, 1)
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "uncertain must write nothing")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testProcessQuestionLlmErrorWritesNothing(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-error-")
	try {
		const client = new FakeLlmClient([
			() => {
				throw new Error("upstream 500")
			},
			() => {
				throw new Error("upstream 500")
			},
		])
		await writeMarker(ws, "Which file?")
		const marker = (await readNeedsDecisionMarker(ws))!

		const result = await processQuestion(proxyBaseOptions(ws, client), marker)

		assert.equal(result.outcome, "errored")
		assert.match(result.detail ?? "", /upstream 500/)
		assert.equal(client.callCount, 2, "a thrown error is retried once before failing open")
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "an LLM error must fail open (write nothing)")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testProcessQuestionRetriesEmptyFirstResponse(): Promise<void> {
	// A reasoning model can return HTTP 200 with EMPTY content on the first
	// completion (observed live in the decision-proxy pilot). The proxy must
	// retry the SAME one-shot prompt once and use the second response.
	const ws = await mkTmpWorkspace("hc-proxy-retry-")
	try {
		const client = new FakeLlmClient([() => textReply(""), () => textReply('{"answer": "src/codesearch/chunk.ts"}')])
		await writeMarker(ws, "Which file is in scope?")
		const marker = (await readNeedsDecisionMarker(ws))!

		const result = await processQuestion(proxyBaseOptions(ws, client), marker)

		assert.equal(result.outcome, "answered")
		assert.equal(client.callCount, 2, "empty first response must be retried once")
		const answer = await fs.readFile(path.join(ws, DECISION_ANSWER), "utf-8")
		assert.equal(answer, "[decision-proxy] src/codesearch/chunk.ts")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testProcessQuestionGivesUpAfterAllRetriesEmpty(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-retryfail-")
	try {
		const client = new FakeLlmClient([() => textReply(""), () => textReply("")])
		await writeMarker(ws, "Which file?")
		const marker = (await readNeedsDecisionMarker(ws))!

		const result = await processQuestion(proxyBaseOptions(ws, client), marker)

		assert.equal(result.outcome, "errored")
		assert.match(result.detail ?? "", /empty LLM response \(attempt 2\/2\)/)
		assert.equal(client.callCount, 2)
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "all-empty responses must fail open (write nothing)")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testProcessQuestionMalformedWritesNothing(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-malformed-")
	try {
		const client = new FakeLlmClient([textReply("Sure, go ahead and do whatever you think is best.")])
		await writeMarker(ws, "Which file?")
		const marker = (await readNeedsDecisionMarker(ws))!

		const result = await processQuestion(proxyBaseOptions(ws, client), marker)

		assert.equal(result.outcome, "errored", "a non-JSON response must NOT be treated as license to answer")
		assert.match(result.detail ?? "", /malformed proxy response/)
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testProcessQuestionNoTaskSkipsLlm(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-notask-q-")
	try {
		const client = new FakeLlmClient([]) // script empty: any call would throw
		await writeMarker(ws, "Any question at all?")
		const marker = (await readNeedsDecisionMarker(ws))!

		const result = await processQuestion({ ...proxyBaseOptions(ws, client), task: undefined }, marker)

		assert.equal(result.outcome, "uncertain")
		assert.equal(client.callCount, 0, "with no original task text the LLM must never be called")
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testProcessQuestionStaleMarkerNeverAnswered(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-stale-")
	try {
		const client = new FakeLlmClient([textReply('{"answer": "Work only on src/codesearch/index.ts"}')])
		// A marker object for Q1 that is NOT the one on disk (a fresh Q2 marker):
		// answering now would poison Q2 with Q1's stale answer.
		const staleMarker: NeedsDecisionMarker = { question: "Should I touch other subsystems?", askedAt: "2026-08-01T00:00:00.000Z" }
		await writeMarker(ws, "A completely different question", ["yes"])

		const result = await processQuestion(proxyBaseOptions(ws, client), staleMarker)

		assert.equal(result.outcome, "errored")
		assert.match(result.detail ?? "", /marker disappeared/)
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "a stale marker must never be answered")

		// Same when the marker is GONE entirely (worker timed out / moved on).
		await fs.unlink(path.join(ws, NEEDS_DECISION))
		const gone = await processQuestion(proxyBaseOptions(ws, client), staleMarker)
		assert.equal(gone.outcome, "errored")
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (5) the poll loop end-to-end ───────────────────────────────────────────

async function testRunDecisionProxyAnswersAndLogs(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-loop-")
	const controller = new AbortController()
	let done: Promise<void> = Promise.resolve()
	try {
		// The CLI creates the log dir before constructing the Logger — mirror that here.
		const logDir = path.join(ws, ".headlesscode")
		await fs.mkdir(logDir, { recursive: true })
		const logFile = path.join(logDir, "decision-proxy.log")
		const client = new FakeLlmClient([textReply('{"answer": "Yes — src/codesearch/index.ts only"}')])
		done = runDecisionProxy(
			{ ...proxyBaseOptions(ws, client), pollIntervalMs: 15, logger: new Logger({ level: "info", filePath: logFile }) },
			controller.signal,
		)

		await writeMarker(ws, "Should I limit changes to the index builder?", ["yes", "no"])
		await waitFor(async () => exists(path.join(ws, DECISION_ANSWER)))

		const answer = await fs.readFile(path.join(ws, DECISION_ANSWER), "utf-8")
		assert.equal(answer, "[decision-proxy] Yes — src/codesearch/index.ts only")
		assert.equal(client.callCount, 1, "the loop must answer with exactly one LLM call")

		// The audit log records the question + outcome (reconstructable history).
		const log = await fs.readFile(logFile, "utf-8")
		assert.match(log, /decision-proxy started/)
		assert.match(log, /decision-proxy question/)
		assert.match(log, /Should I limit changes to the index builder\?/)
		assert.match(log, /"outcome":\s*"answered"/)

		// Simulate the worker consuming the answer (deletes both markers), then stop.
		await fs.unlink(path.join(ws, NEEDS_DECISION))
		await fs.unlink(path.join(ws, DECISION_ANSWER))
		controller.abort()
		await done
		assert.match(await fs.readFile(logFile, "utf-8"), /decision-proxy stopped/)
	} finally {
		controller.abort()
		await done.catch(() => {})
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRunDecisionProxyDoesNotReprocessSameMarker(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-proxy-dedup-")
	const controller = new AbortController()
	let done: Promise<void> = Promise.resolve()
	try {
		const client = new FakeLlmClient([textReply('{"uncertain": true}')])
		done = runDecisionProxy(
			{ ...proxyBaseOptions(ws, client), pollIntervalMs: 15, logger: new Logger({ level: "silent" }) },
			controller.signal,
		)

		await writeMarker(ws, "A question the task does not answer")
		// Let the loop run several poll cycles while the marker persists (the
		// worker keeps waiting up to its timeout). It must handle the marker
		// exactly ONCE — not burn an LLM call every poll.
		await sleep(200)
		assert.equal(client.callCount, 1, "a persistent marker must not be re-processed every poll")
		assert.equal(await exists(path.join(ws, DECISION_ANSWER)), false, "uncertain writes nothing")

		controller.abort()
		await done
	} finally {
		controller.abort()
		await done.catch(() => {})
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (6) env gate + CLI args ────────────────────────────────────────────────

async function testEnvGate(): Promise<void> {
	assert.equal(isDecisionProxyEnabled({}), false)
	assert.equal(isDecisionProxyEnabled({ HEADLESSCODE_DECISION_PROXY: "0" }), false)
	assert.equal(isDecisionProxyEnabled({ HEADLESSCODE_DECISION_PROXY: "false" }), false)
	assert.equal(isDecisionProxyEnabled({ HEADLESSCODE_DECISION_PROXY: "" }), false)
	assert.equal(isDecisionProxyEnabled({ HEADLESSCODE_DECISION_PROXY: "1" }), true)
	assert.equal(isDecisionProxyEnabled({ HEADLESSCODE_DECISION_PROXY: "true" }), true)
	assert.equal(isDecisionProxyEnabled({ HEADLESSCODE_DECISION_PROXY: "TRUE" }), true)
}

async function testEnvResolvers(): Promise<void> {
	assert.equal(resolveDecisionProxyPollInterval({}), 5_000)
	assert.equal(resolveDecisionProxyPollInterval({ HEADLESSCODE_DECISION_PROXY_POLL_INTERVAL_MS: "250" }), 250)
	assert.throws(() => resolveDecisionProxyPollInterval({ HEADLESSCODE_DECISION_PROXY_POLL_INTERVAL_MS: "abc" }))
	assert.equal(resolveDecisionProxyLlmTimeout({}), 60_000)
	assert.equal(resolveDecisionProxyLlmTimeout({ HEADLESSCODE_DECISION_PROXY_LLM_TIMEOUT_MS: "5000" }), 5_000)
}

async function testCliArgParsing(): Promise<void> {
	const { options, error } = parseDecisionProxyArgs([
		"--workspace",
		"/tmp/ws",
		"--task",
		"verbatim task",
		"--model=x/y",
		"--poll-interval-ms=100",
		"--llm-timeout-ms",
		"2000",
		"--log-file",
		"/tmp/proxy.log",
	])
	assert.equal(error, undefined)
	assert.equal(options.workspace, "/tmp/ws")
	assert.equal(options.task, "verbatim task")
	assert.equal(options.model, "x/y")
	assert.equal(options.pollIntervalMs, 100)
	assert.equal(options.llmTimeoutMs, 2000)
	assert.equal(options.logFile, "/tmp/proxy.log")

	const bad = parseDecisionProxyArgs(["--poll-interval-ms", "nope"])
	assert.match(bad.error ?? "", /poll-interval-ms/)
	const help = parseDecisionProxyArgs(["--help"])
	assert.equal(help.options.help, true)
	const unknown = parseDecisionProxyArgs(["--frobnicate"])
	assert.match(unknown.error ?? "", /Unknown/)
}

// ─── run ────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["parse: answer", testParseAnswer],
		["parse: answer trims", testParseAnswerTrimsWhitespace],
		["parse: uncertain", testParseUncertain],
		["parse: markdown-fenced JSON", testParseMarkdownFencedJson],
		["parse: malformed variants", testParseMalformed],
		["task text: --task flag", testResolveTaskFromCliFlag],
		["task text: --task-file", testResolveTaskFromTaskFile],
		["task text: orchestrator state", testResolveTaskFromOrchestratorState],
		["task text: none available", testResolveTaskNone],
		["model: _decision-proxy key wins", testResolveModelPrefersDecisionProxyKey],
		["model: fallback chain without key", testResolveModelFallsBackWithoutKey],
		["processQuestion: answered writes prefixed answer", testProcessQuestionAnsweredWritesPrefixedAnswer],
		["processQuestion: uncertain writes nothing", testProcessQuestionUncertainWritesNothing],
		["processQuestion: LLM error retried once then writes nothing", testProcessQuestionLlmErrorWritesNothing],
		["processQuestion: empty first response retried, second answer used", testProcessQuestionRetriesEmptyFirstResponse],
		["processQuestion: all-retries-empty fails open", testProcessQuestionGivesUpAfterAllRetriesEmpty],
		["processQuestion: malformed writes nothing", testProcessQuestionMalformedWritesNothing],
		["processQuestion: no task skips LLM", testProcessQuestionNoTaskSkipsLlm],
		["processQuestion: stale marker never answered", testProcessQuestionStaleMarkerNeverAnswered],
		["loop: answers end-to-end + audit log", testRunDecisionProxyAnswersAndLogs],
		["loop: persistent marker not reprocessed", testRunDecisionProxyDoesNotReprocessSameMarker],
		["env gate", testEnvGate],
		["env resolvers", testEnvResolvers],
		["CLI arg parsing", testCliArgParsing],
	]

	let passed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			passed++
			console.log(`  ok    ${name}`)
		} catch (err) {
			console.error(`  FAIL  ${name}`)
			console.error(err instanceof Error ? err.stack : String(err))
			process.exitCode = 1
			return
		}
	}
	console.log(`\nAll ${passed} tests passed`)
}

void run()
