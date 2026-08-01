#!/usr/bin/env node
/**
 * mock-openrouter.mjs — tiny OpenRouter chat-completions mock for the
 * headlesscode Phase 1 end-to-end test.
 *
 * Node built-ins only (http, fs, path) — no dependencies.
 *
 * Serves: POST /api/v1/chat/completions  (the client posts to
 * `{OPENROUTER_BASE_URL}/api/v1/chat/completions`, so run the harness with
 * `OPENROUTER_BASE_URL=http://127.0.0.1:<this port>`).
 *
 * Validates the `Authorization: Bearer <key>` header is present (any value is
 * accepted — the CLI only requires OPENROUTER_API_KEY to be set).
 *
 * Behavior is driven by a state machine, keyed off MOCK_SCENARIO:
 *
 *   success (default) — scripts the REAL loop end-to-end:
 *     the response for a request is chosen from the REQUEST'S OWN message
 *     history (history_tool_calls), NOT a global counter, so several workers
 *     can share one mock server concurrently (Phase 2 parallel e2e):
 *       history_tool_calls == 0 -> read_file on the buggy source
 *       history_tool_calls <= 2 -> write_to_file (fix content derived from
 *                                  the fixture repo) + execute_command (verify)
 *       history_tool_calls >= 3 -> attempt_completion (result summary)
 *     requests beyond that -> HTTP 500 (the loop must terminate at
 *     attempt_completion; any further request means the harness is
 *     misbehaving).
 *
 *   review-clean / review-finding — Phase 2 reviewer scenario: the model
 *     only gets read-only tools (read_file etc.) and terminates with an
 *     attempt_completion that either verifies everything clean or reopens
 *     with findings. The e2e runner asserts write_to_file never appears in
 *     the review request's tool list.
 *
 *   error-loop — always returns an erroring tool call (apply_diff, an
 *     unimplemented stub in the harness executor) so the loop trips its
 *     consecutive-mistake bound and the CLI exits 1 (bounded failure,
 *     verified end-to-end).
 *
 *   qa-pass / qa-fail — Phase 4 QA scenario: the model only gets read +
 *     command tools (execute_command runs the fixture test) and terminates
 *     with an attempt_completion that either passes with evidence or fails
 *     noting what broke. The e2e runner asserts verdict parsing and that
 *     write_to_file never appears in the QA request's tool list.
 *
 *   qa-orchestrate — Phase 4 auto scenario: ONE mock server serves a full
 *     `orchestrate --qa` round by classifying each request from its own
 *     content: tools include write_to_file -> worker (success script);
 *     system prompt has "independent reviewer" -> review-clean; otherwise ->
 *     QA pass script.
 *
 * Environment:
 *   PORT               listen port (default 0 = OS-assigned random port).
 *                      The actual port is printed to stdout in the
 *                      "[mock] listening on http://127.0.0.1:<port>" line.
 *   MOCK_SCENARIO      success | error-loop | review-clean | review-finding |
 *                      qa-pass | qa-fail | qa-orchestrate (default success)
 *   MOCK_FIXTURE_ROOT  path to the fixture repo; the write_to_file content is
 *                      derived by patching this repo's buggy source so the
 *                      e2e runner can assert the fix landed byte-for-byte.
 *   MOCK_BUGGY_FILE    relative path of the buggy source (default src/greet.js)
 *   MOCK_VERIFY_CMD    command the agent should run to verify the fix
 *                      (default: run the fixture's greet test inline)
 *
 * Logging: every request prints one line to stdout (captured by the e2e
 * runner for assertions), e.g.
 *   [mock] request #2 messages=4 tool_defs=6 history_tool_calls=1 tools=read_file,... model=deepseek/deepseek-chat
 */

import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const PORT = Number(process.env.PORT || 0)
const SCENARIO = process.env.MOCK_SCENARIO || "success"
const FIXTURE_ROOT = process.env.MOCK_FIXTURE_ROOT
const BUGGY_FILE = process.env.MOCK_BUGGY_FILE || "src/greet.js"

const DEFAULT_VERIFY_CMD =
	"node -e \"const { greet } = require('./src/greet.js'); const assert = require('node:assert'); assert.strictEqual(greet('World'), 'Hello, World'); console.log('greet verified OK')\""
const VERIFY_CMD = process.env.MOCK_VERIFY_CMD || DEFAULT_VERIFY_CMD

/** Matches the buggy line in the fixture source (see scripts/e2e-fixture/setup.sh). */
const BUG_LINE_RE = /return "" \/\/ BUG[^\n]*/

// ─── Fixture-derived fix content ────────────────────────────────────────────

function defaultBuggySource() {
	return [
		"/**",
		" * greet.js — fixture project for the headlesscode end-to-end test.",
		" *",
		" * Issue #29: greet() always returns an empty string instead of greeting",
		" * the given name.",
		" */",
		"function greet(name) {",
		'	return "" // BUG (issue #29): should be "Hello, " + name',
		"}",
		"",
		"module.exports = { greet }",
		"",
	].join("\n")
}

function loadBuggySource() {
	if (FIXTURE_ROOT) {
		const p = path.join(FIXTURE_ROOT, BUGGY_FILE)
		try {
			return fs.readFileSync(p, "utf-8")
		} catch (err) {
			console.error(`[mock] cannot read fixture source ${p}: ${err.message}; using built-in default`)
		}
	}
	return defaultBuggySource()
}

function buildFixedSource(buggy) {
	const fixed = buggy.replace(BUG_LINE_RE, 'return "Hello, " + name')
	if (fixed === buggy) {
		console.error(
			`[mock] WARNING: fixture source did not match the expected bug line (${BUG_LINE_RE}); writing source unchanged`,
		)
	}
	return fixed
}

const FIXED_SOURCE = buildFixedSource(loadBuggySource())

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function sendJson(res, status, body) {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
	})
	res.end(payload)
}

function toolCall(id, name, args) {
	return { id, type: "function", function: { name, arguments: JSON.stringify(args) } }
}

function chatResponse(model, message) {
	return {
		id: `chatcmpl-mock-${Date.now()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message,
				finish_reason: message.tool_calls && message.tool_calls.length > 0 ? "tool_calls" : "stop",
			},
		],
		usage: { prompt_tokens: 16, completion_tokens: 24, total_tokens: 40 },
	}
}

// ─── Scenario responses ─────────────────────────────────────────────────────

// Reviewer scenarios: the model only has read-only tools and terminates with
// an attempt_completion that is either a clean verification or a finding that
// reopens the issue.
function reviewCleanCompletionText() {
	return [
		"REVIEW CLEAN",
		"Verified for real: re-read the full diff, re-ran the project test (all passed), ",
		"boot check clean, no silent behavior changes. All claims in the closing report hold. ",
		"Nothing to change.",
	].join("\n")
}

function reviewCompletionText() {
	if (SCENARIO === "review-clean") {
		return reviewCleanCompletionText()
	}
	return [
		"## Findings",
		"- The closing report claims '15/15 tests passing' but the real result is 14 passed / 1 failed",
		"  (a missing import in the new module — see src/greet.test.js:3).",
		"",
		"## Verdict",
		"REOPENED issue #29: the report's baseline claim is false. Provide real passing output.",
	].join("\n")
}

// QA scenarios (Phase 4): the model only has read + command tools (no write)
// and terminates with an attempt_completion that either passes with evidence
// or fails noting what broke. The e2e runner asserts the verdict parsing and
// that write_to_file never appears in the QA session's tool list.
function qaPassCompletionText() {
	return [
		"QA PASS",
		"",
		"## Evidence",
		`- Ran execute_command: \`node src/greet.test.js\` — all 3 assertions passed (greet tests passed).`,
		"- Checked the fixture report equivalent: errors [], failedRequests [].",
		"",
		"Definition of done satisfied: changed behavior works, no errors found.",
	].join("\n")
}

function qaFailCompletionText() {
	return [
		"QA FAIL",
		"",
		"## Evidence",
		`- Ran execute_command: \`node src/greet.test.js\` — 1 assertion failed (expected 'Hello, World' got '').`,
		"",
		"Definition of done NOT satisfied: the changed behavior does not work.",
	].join("\n")
}

/**
 * QA session script (Phase 4): read + command tools only, then terminate with
 * an attempt_completion carrying the pass/fail evidence.
 */
function qaSessionResponse(model, historyToolCalls, pass) {
	if (historyToolCalls === 0) {
		// a. Run the project's test suite (command tool, no write tools).
		return chatResponse(model, {
			role: "assistant",
			content: null,
			tool_calls: [toolCall("call_mock_qa_verify", "execute_command", { command: "node src/greet.test.js" })],
		})
	}
	// b. Terminate with the verdict + evidence.
	return chatResponse(model, {
		role: "assistant",
		content: null,
		tool_calls: [
			toolCall("call_mock_qa_done", "attempt_completion", {
				result: pass ? qaPassCompletionText() : qaFailCompletionText(),
			}),
		],
	})
}

/**
 * Build the response for one request. The `success` / `review-*` / `qa-*`
 * scenarios key off the REQUEST'S OWN message history (history_tool_calls),
 * not the global REQUEST_COUNT, so multiple sessions can share one mock
 * server and each still advances through its own scripted sequence.
 *
 * `qa-orchestrate` is the Phase 4 auto scenario: ONE mock server serves a full
 * `orchestrate --qa` round by classifying each request from its own content:
 *   - tools include write_to_file        -> worker session (success script)
 *   - system prompt has "independent reviewer" -> review session (clean)
 *   - otherwise                          -> QA session (pass script)
 * This works because worker / reviewer / QA sessions are distinguishable by
 * the tools they expose and their system prompt, and they never run
 * concurrently within one orchestrate process.
 */
function buildScenarioResponse({ model, historyToolCalls, systemPrompt, toolNames }) {
	if (SCENARIO === "error-loop") {
		// Identical erroring tool call every time: the loop's consecutive-mistake
		// bound (default 3) must trip and the CLI must exit 1.
		const msg = {
			role: "assistant",
			content: null,
			tool_calls: [
				toolCall(`call_mock_e${REQUEST_COUNT}`, "apply_diff", {
					path: BUGGY_FILE,
					diff: "--- a/src/greet.js\n+++ b/src/greet.js\n@@ -1,3 +1,3 @@\n-fix\n+me\n",
				}),
			],
		}
		return chatResponse(model, msg)
	}

	if (SCENARIO === "review-clean" || SCENARIO === "review-finding") {
		if (historyToolCalls === 0) {
			// a. Inspect the changed file (read-only tool, no write tools).
			return chatResponse(model, {
				role: "assistant",
				content: null,
				tool_calls: [toolCall(`call_mock_review_read`, "read_file", { path: BUGGY_FILE })],
			})
		}
		// b. Terminate with the verdict (clean or finding/reopen).
		return chatResponse(model, {
			role: "assistant",
			content: null,
			tool_calls: [
				toolCall(`call_mock_review_done`, "attempt_completion", { result: reviewCompletionText() }),
			],
		})
	}

	if (SCENARIO === "qa-pass" || SCENARIO === "qa-fail") {
		return qaSessionResponse(model, historyToolCalls, SCENARIO === "qa-pass")
	}

	if (SCENARIO === "qa-orchestrate") {
		if (toolNames.includes("write_to_file")) {
			// Worker session -> the Phase 1/2 success script.
			if (historyToolCalls === 0) {
				return chatResponse(model, {
					role: "assistant",
					content: null,
					tool_calls: [toolCall("call_mock_read", "read_file", { path: BUGGY_FILE })],
				})
			}
			if (historyToolCalls <= 2) {
				return chatResponse(model, {
					role: "assistant",
					content: null,
					tool_calls: [
						toolCall("call_mock_write", "write_to_file", { path: BUGGY_FILE, content: FIXED_SOURCE }),
						toolCall("call_mock_verify", "execute_command", { command: VERIFY_CMD }),
					],
				})
			}
			return chatResponse(model, {
				role: "assistant",
				content: null,
				tool_calls: [
					toolCall("call_mock_done", "attempt_completion", {
						result: `Fixed issue #29: greet() in ${BUGGY_FILE} now returns "Hello, " + name. Read the source, patched the function with write_to_file, and verified the fix with execute_command.`,
					}),
				],
			})
		}
		if (/independent reviewer/i.test(systemPrompt)) {
			// Review session -> clean (the qa-orchestrate round must end with
			// every group reviewed clean so QA runs and the deploy gate opens).
			if (historyToolCalls === 0) {
				return chatResponse(model, {
					role: "assistant",
					content: null,
					tool_calls: [toolCall(`call_mock_review_read`, "read_file", { path: BUGGY_FILE })],
				})
			}
			return chatResponse(model, {
				role: "assistant",
				content: null,
				tool_calls: [
					toolCall(`call_mock_review_done`, "attempt_completion", {
						result: reviewCleanCompletionText(),
					}),
				],
			})
		}
		// Otherwise -> QA session (pass script).
		return qaSessionResponse(model, historyToolCalls, true)
	}

	// success scenario — keyed on this session's own history.
	if (historyToolCalls === 0) {
		// a. Read the buggy source file.
		return chatResponse(model, {
			role: "assistant",
			content: null,
			tool_calls: [toolCall("call_mock_read", "read_file", { path: BUGGY_FILE })],
		})
	}
	if (historyToolCalls <= 2) {
		// b. Fix the file (content derived from the fixture) and verify.
		return chatResponse(model, {
			role: "assistant",
			content: null,
			tool_calls: [
				toolCall("call_mock_write", "write_to_file", { path: BUGGY_FILE, content: FIXED_SOURCE }),
				toolCall("call_mock_verify", "execute_command", { command: VERIFY_CMD }),
			],
		})
	}
	// c. Terminate with a summary of the fix.
	return chatResponse(model, {
		role: "assistant",
		content: null,
		tool_calls: [
			toolCall("call_mock_done", "attempt_completion", {
				result: `Fixed issue #29: greet() in ${BUGGY_FILE} now returns "Hello, " + name. Read the source, patched the function with write_to_file, and verified the fix with execute_command.`,
			}),
		],
	})
}

// ─── Server ─────────────────────────────────────────────────────────────────

let REQUEST_COUNT = 0

const server = http.createServer((req, res) => {
	if (req.method !== "POST") {
		sendJson(res, 405, { error: { message: `method ${req.method} not allowed` } })
		return
	}
	if (req.url !== "/api/v1/chat/completions") {
		sendJson(res, 404, { error: { message: `not found: ${req.url}` } })
		return
	}

	const auth = req.headers.authorization || ""
	if (!/^Bearer\s+\S+/.test(auth)) {
		sendJson(res, 401, { error: { message: "missing or invalid Authorization: Bearer header" } })
		return
	}

	let raw = ""
	req.on("data", (chunk) => {
		raw += chunk
	})
	req.on("end", () => {
		let body
		try {
			body = JSON.parse(raw || "{}")
		} catch (err) {
			sendJson(res, 400, { error: { message: `invalid JSON body: ${err.message}` } })
			return
		}

		const model = body.model || "mock-model"
		const messages = Array.isArray(body.messages) ? body.messages : []
		const tools = Array.isArray(body.tools) ? body.tools : []
		const historyToolCalls = messages.reduce(
			(n, m) => n + (Array.isArray(m.tool_calls) ? m.tool_calls.length : 0),
			0,
		)
		const toolNames = tools
			.filter((t) => t && t.function && typeof t.function.name === "string")
			.map((t) => t.function.name)
			.join(",")
		const systemPrompt =
			typeof messages[0]?.content === "string" ? messages[0].content : ""

		REQUEST_COUNT++
		console.log(
			`[mock] request #${REQUEST_COUNT} messages=${messages.length} tool_defs=${tools.length} history_tool_calls=${historyToolCalls} tools=${toolNames || "-"} model=${model}`,
		)

		// Safety net ONLY — per-session keying below terminates each session at
		// attempt_completion, so a request past #50 across ALL sessions means a
		// harness bug. (The Phase 1 global `> 3` guard is gone: several workers
		// legitimately share one mock server in the Phase 2 parallel e2e.)
		if (REQUEST_COUNT > 50) {
			sendJson(res, 500, {
				error: {
					message: `mock: more than 50 total requests — the loops should have terminated on attempt_completion`,
				},
			})
			return
		}

		const response = buildScenarioResponse({ model, historyToolCalls, systemPrompt, toolNames })
		if (response === null) {
			sendJson(res, 500, {
				error: { message: `mock: no scenario response for request #${REQUEST_COUNT}` },
			})
			return
		}
		sendJson(res, 200, response)
	})
})

server.on("error", (err) => {
	console.error(`[mock] server error: ${err.message}`)
	process.exit(1)
})

server.listen(PORT, "127.0.0.1", () => {
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : PORT
	console.log(`[mock] listening on http://127.0.0.1:${port} scenario=${SCENARIO}`)
})
