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
 * accepted — the CLI only requires HEADLESSCODE_OPENROUTER_API_KEY to be set).
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
 *   exhaustion — issue #2 Part 2 (iteration-exhaustion auto-continue):
 *     the model NEVER terminates; every reply is a benign read_file on a
 *     DIFFERENT fixture file (a different path each iteration so the loop's
 *     identical-repeat mistake counter never trips). The harness therefore
 *     runs until its --max-iterations cap aborts the session with the exact
 *     "Max iterations (N) reached without task completion" error — the
 *     signal the orchestrator's continuation callback auto-continues on.
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
 *   permissions — command allow/deny + protected-file enforcement e2e
 *     (plans/permissions-parity.md): a fixed 3-step script regardless of
 *     what the harness actually does with each step, so the SAME scenario
 *     can prove both the default-refuse and --allow-protected-writes paths:
 *       history_tool_calls == 0 -> write_to_file targeting a protected path
 *                                  (.env) with distinctive content
 *       history_tool_calls == 1 -> execute_command with a command the e2e
 *                                  runner passes via --denied-commands
 *       history_tool_calls >= 2 -> attempt_completion (summary)
 *     The mock does not know or care whether either step was actually
 *     refused by the executor — the e2e runner asserts refusal/success by
 *     inspecting the real tool-result content fed back into the request
 *     history and the real file content on disk afterward.
 *
 *   plan-first — issue #49 (plan-first experiment) e2e. ONE server serves
 *     both the plan session and the code worker, dispatching per-request on
 *     the MODEL field: requests whose model == MOCK_PLAN_MODEL get the plan
 *     script (explore -> write PLAN.md -> attempt_completion), everything
 *     else gets the standard worker success script. The dispatch is robust
 *     because the fixture's mode-models.json maps the plan-first mode
 *     ("architect") to MOCK_PLAN_MODEL and "code" to the worker model, so
 *     the plan session and the code worker always carry different models.
 *       model == MOCK_PLAN_MODEL:
 *         history_tool_calls == 0 -> read_file (explore)
 *         history_tool_calls == 1 -> write_to_file PLAN.md (deterministic plan)
 *         history_tool_calls >= 2 -> attempt_completion
 *       otherwise -> the success script (worker)
 *
 *   decision — browser-control-plane e2e (plans/browser-control-plane.md):
 *     the model calls ask_followup_question ONCE, then (only once a real
 *     answer has been fed back into the request history as a tool result)
 *     terminates with attempt_completion. This is what the manual smoke
 *     test uses to prove the dashboard's start → decision_blocked → answer
 *     → decision_answered → continue loop end to end.
 *       history_tool_calls == 0 -> ask_followup_question
 *       any later request -> attempt_completion (the harness only reaches
 *                            it if the question was actually answered)
 *
 *   search-before-read — codebase_search-activation e2e
 *     (plans/codebase-search-activation.md): proves the code-mode guidance
 *     actually changes behavior. A realistically-scripted mock model: it
 *     reads the SYSTEM PROMPT and follows it (NOT the request's message
 *     history — a session can call tools in any order before terminating):
 *       prompt contains the codebase_search guidance
 *         -> the mock's first reply is codebase_search
 *       otherwise -> the mock's first reply is read_file
 *       after either -> attempt_completion (the response is crafted to be
 *       valid either way, so the run ALWAYS terminates cleanly at exit 0
 *       regardless of which tool the prompt steered the model to; the
 *       runner then inspects the mock's response log to see which tool
 *       the model actually reached for first)
 *     The prompt (not the tool list) is the discriminator because
 *     codebase_search is always advertised in code mode — the tool list
 *     alone cannot distinguish "guidance followed" from "tool merely
 *     available".
 *
 * Environment:
 *   PORT               listen port (default 0 = OS-assigned random port).
 *                      The actual port is printed to stdout in the
 *                      "[mock] listening on http://127.0.0.1:<port>" line.
 *   MOCK_SCENARIO      success | error-loop | exhaustion | review-clean |
 *                      review-finding | qa-pass | qa-fail | qa-orchestrate |
 *                      permissions | plan-first (default success)
 *   MOCK_PLAN_MODEL    model id the plan-first scenario dispatches on (default:
 *                      deepseek/architect-plan — the fixture maps the
 *                      architect mode to it in mode-models.json)
 *   MOCK_FIXTURE_ROOT  path to the fixture repo; the write_to_file content is
 *                      derived by patching this repo's buggy source so the
 *                      e2e runner can assert the fix landed byte-for-byte.
 *   MOCK_BUGGY_FILE    relative path of the buggy source (default src/greet.js)
 *   MOCK_VERIFY_CMD    command the agent should run to verify the fix
 *                      (default: run the fixture's greet test inline)
 *   MOCK_PROTECTED_WRITE_CONTENT  content the `permissions` scenario's
 *                      write_to_file step tries to write to `.env` (default
 *                      below) — the e2e runner checks for this exact string
 *                      to tell "the write actually landed" from "refused".
 *   MOCK_DENIED_COMMAND  command the `permissions` scenario's execute_command
 *                      step tries to run (default below) — the e2e runner
 *                      passes this same string via --denied-commands.
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
// Rework-loop e2e (plans/rework-loop.md): in the qa-orchestrate scenario, make
// the first N review sessions return a FINDING verdict instead of clean, so a
// real `orchestrate` run exercises a rework spawn end-to-end (worker success →
// review finding → rework worker → review clean).
const REWORK_REVIEWS = Number(process.env.REWORK_REVIEWS || 0)
// Issue #52 twin: make the first N QA sessions return a FAIL verdict instead
// of pass, so a real `orchestrate --qa` run exercises the QA-fail rework
// end-to-end (worker success → review clean → QA fail → rework worker →
// review clean → QA pass).
const REWORK_QA = Number(process.env.REWORK_QA || 0)

const DEFAULT_VERIFY_CMD =
	"node -e \"const { greet } = require('./src/greet.js'); const assert = require('node:assert'); assert.strictEqual(greet('World'), 'Hello, World'); console.log('greet verified OK')\""

// plan-first scenario (issue #49): the model id the plan session's requests
// carry (see the fixture's mode-models.json "architect" key). The dispatch
// keys on this — see buildScenarioResponse.
const PLAN_MODEL = process.env.MOCK_PLAN_MODEL || "deepseek/architect-plan"

// Deterministic plan the plan-first scenario's write_to_file writes to
// PLAN.md — the e2e runner asserts this exact text lands in the worktree's
// ORCHESTRATOR_TASK.md (appended by the spawner) to prove the plan phase ran
// and reached the code worker.
const PLAN_FIRST_PLAN_CONTENT = [
	"# Implementation plan (mock plan-first)",
	"",
	"1. Read src/greet.js and ORCHESTRATOR_TASK.md.",
	'2. Fix greet() to return "Hello, " + name (write_to_file on src/greet.js).',
	"3. Verify with `node src/greet.test.js` (execute_command).",
	"4. Commit and report via attempt_completion.",
	"",
].join("\n")

// permissions scenario (plans/permissions-parity.md e2e gap).
const PROTECTED_WRITE_CONTENT = process.env.MOCK_PROTECTED_WRITE_CONTENT || "MOCK_SECRET=should-never-land\n"
const DENIED_COMMAND = process.env.MOCK_DENIED_COMMAND || "curl http://169.254.169.254/latest/meta-data/"
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
	if (SCENARIO === "exhaustion") {
		// Never terminate. Cycle through DIFFERENT benign read_file targets so
		// the loop's identical-repeat mistake counter never trips — it runs
		// until the harness's --max-iterations cap aborts the session with the
		// exact "Max iterations" error (the orchestrator's auto-continue signal,
		// issue #2 Part 2).
		const files = [BUGGY_FILE, "README.md", "package.json"]
		const file = files[historyToolCalls % files.length]
		return chatResponse(model, {
			role: "assistant",
			content: null,
			tool_calls: [toolCall(`call_mock_exhaust_${REQUEST_COUNT}`, "read_file", { path: file })],
		})
	}

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

	if (SCENARIO === "permissions") {
		if (historyToolCalls === 0) {
			return chatResponse(model, {
				role: "assistant",
				content: null,
				tool_calls: [
					toolCall(`call_mock_perm_write`, "write_to_file", {
						path: ".env",
						content: PROTECTED_WRITE_CONTENT,
					}),
				],
			})
		}
		if (historyToolCalls === 1) {
			return chatResponse(model, {
				role: "assistant",
				content: null,
				tool_calls: [toolCall(`call_mock_perm_exec`, "execute_command", { command: DENIED_COMMAND })],
			})
		}
		return chatResponse(model, {
			role: "assistant",
			content: null,
			tool_calls: [
				toolCall(`call_mock_perm_done`, "attempt_completion", {
					result: "Attempted the protected write and the denied command; reporting whatever the tool results said.",
				}),
			],
		})
	}

	if (SCENARIO === "decision") {
		if (historyToolCalls === 0) {
			// Ask the human a question — the harness blocks on
			// .harness.needs-decision until someone writes
			// .harness.decision-answer (a terminal human, or the dashboard's
			// answer endpoint — which is what the browser-control-plane smoke
			// test exercises).
			return chatResponse(model, {
				role: "assistant",
				content: null,
				tool_calls: [
					toolCall(`call_mock_ask`, "ask_followup_question", {
						question: "Which config file should I edit?",
						follow_up: [
							{ text: "./src/frontend-config.json", mode: null },
							{ text: "./config/frontend-config.json", mode: null },
						],
					}),
				],
			})
		}
		// Only reached once the question was actually answered — the harness
		// only sends a follow-up request after the answer came back as a
		// normal tool result. Terminate cleanly.
		return chatResponse(model, {
			role: "assistant",
			content: null,
			tool_calls: [
				toolCall(`call_mock_done`, "attempt_completion", {
					result: "The human answered my question via the dashboard; proceeding and done.",
				}),
			],
		})
	}

	if (SCENARIO === "search-before-read") {
		// codebase_search-activation e2e: prove the code-mode guidance
		// actually changes behavior. A realistically-scripted mock model:
		// it reads the system prompt and follows it. The mock derives the
		// model's behavior from the PROMPT CONTENT (not the tool list —
		// codebase_search is always advertised in code mode, so the tool
		// list alone can't distinguish "guidance followed" from "tool
		// merely available").
		//   - The prompt tells the model to try codebase_search before
		//     whole-file reads -> the mock calls codebase_search first.
		//   - The prompt does NOT -> the mock falls back to read_file.
		// The mock NEVER errors — whichever path, the run terminates
		// cleanly at exit 0 and the runner inspects the request log to
		// see which tool the model actually reached for first.
		const promptHasGuidance =
			typeof systemPrompt === "string" && /codebase_search complements/i.test(systemPrompt)
		if (historyToolCalls === 0) {
			if (promptHasGuidance) {
				return chatResponse(model, {
					role: "assistant",
					content: null,
					tool_calls: [
						toolCall(`call_mock_search_${REQUEST_COUNT}`, "codebase_search", {
							query: "where is the greet function",
							path: null,
						}),
					],
				})
			}
			return chatResponse(model, {
				role: "assistant",
				content: null,
				tool_calls: [toolCall(`call_mock_read_${REQUEST_COUNT}`, "read_file", { path: BUGGY_FILE })],
			})
		}
		return chatResponse(model, {
			role: "assistant",
			content: null,
			tool_calls: [
				toolCall(`call_mock_done_${REQUEST_COUNT}`, "attempt_completion", {
					result: `Located the target code (tool call #1: ${
						promptHasGuidance ? "codebase_search" : "read_file"
					}) and inspected it.`,
				}),
			],
		})
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
			// Review session. Normally clean (so QA runs and the deploy gate
			// opens), but with REWORK_REVIEWS=N the first N review sessions
			// return a FINDING — proving a real rework spawn end-to-end: the
			// orchestrator re-runs a worker on the SAME worktree, the watcher
			// re-polls it to done, and the re-review comes back clean.
			if (historyToolCalls === 0) {
				reviewSessionCount++
				return chatResponse(model, {
					role: "assistant",
					content: null,
					tool_calls: [toolCall(`call_mock_review_read`, "read_file", { path: BUGGY_FILE })],
				})
			}
			const reworkThisReview = reviewSessionCount <= REWORK_REVIEWS
			return chatResponse(model, {
				role: "assistant",
				content: null,
				tool_calls: [
					toolCall(`call_mock_review_done`, "attempt_completion", {
						result: reworkThisReview ? reviewCompletionText() : reviewCleanCompletionText(),
					}),
				],
			})
		}
		// Otherwise -> QA session. With REWORK_QA=N the first N QA sessions
		// FAIL (issue #52's end-to-end path: the orchestrator auto-spawns a
		// QA-fail rework worker on the same worktree, and the re-run QA
		// passes); without it, QA always passes. Counted on the session's
		// FIRST request only (the review counter's pattern) — a QA session
		// makes two requests, and counting both would flip the verdict
		// mid-session. A tool-less request is the round's preflight probe,
		// NOT a QA session — it must not consume a QA slot (a real incident
		// in this e2e: the probe grabbed REWORK_QA's only fail slot, so the
		// first real QA session passed and the rework never spawned).
		if (toolNames === "") {
			return chatResponse(model, {
				role: "assistant",
				content: "mock: preflight probe acknowledged",
			})
		}
		if (historyToolCalls === 0) {
			qaSessionCount++
		}
		return qaSessionResponse(model, historyToolCalls, qaSessionCount > REWORK_QA)
	}

	if (SCENARIO === "plan-first") {
		// Issue #49: ONE server serves both the plan session and the code
		// worker, dispatching on the MODEL field (see the scenario doc
		// comment). The plan session gets explore -> write PLAN.md -> complete;
		// the worker falls through to the standard success script below.
		if (model === PLAN_MODEL) {
			if (historyToolCalls === 0) {
				return chatResponse(model, {
					role: "assistant",
					content: null,
					tool_calls: [toolCall("call_mock_plan_read", "read_file", { path: BUGGY_FILE })],
				})
			}
			if (historyToolCalls === 1) {
				return chatResponse(model, {
					role: "assistant",
					content: null,
					tool_calls: [
						toolCall("call_mock_plan_write", "write_to_file", {
							path: "PLAN.md",
							content: PLAN_FIRST_PLAN_CONTENT,
						}),
					],
				})
			}
			return chatResponse(model, {
				role: "assistant",
				content: null,
				tool_calls: [
					toolCall("call_mock_plan_done", "attempt_completion", {
						result: "Planning complete: wrote the implementation plan to PLAN.md at the workspace root.",
					}),
				],
			})
		}
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
// Counts REVIEW sessions seen by the qa-orchestrate scenario (incremented on
// each review session's first request). Used with REWORK_REVIEWS to decide
// which reviews return a finding vs. clean.
let reviewSessionCount = 0
// Counts QA sessions seen by the qa-orchestrate scenario (incremented on each
// QA session's first request). Used with REWORK_QA to decide which QA
// sessions return a fail vs. pass (issue #52).
let qaSessionCount = 0

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

		// Log the tool calls the mock emits as the model's reply — the e2e
		// runner asserts on THESE to prove what the (scripted) model actually
		// reached for, which the request's advertised tool list cannot show.
		const responseToolCalls = response.choices?.[0]?.message?.tool_calls ?? []
		const responseToolNames = responseToolCalls
			.map((tc) => (tc && tc.function && typeof tc.function.name === "string" ? tc.function.name : "?"))
			.join(",")
		console.log(
			`[mock] response #${REQUEST_COUNT} tool_calls=${responseToolNames || "-"}`,
		)

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
