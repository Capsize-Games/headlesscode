#!/usr/bin/env node
/**
 * Standalone Phase 3 context-condensation live demo (not part of npm test).
 *
 * Drives the REAL CLI (src/cli.ts) through the REAL HTTP path against a local
 * mock OpenRouter that:
 *   - serves /api/v1/models/<id>/endpoints (the context-window lookup the
 *     session uses to decide WHEN to condense) — reporting 128000 tokens;
 *   - returns REAL token counts in usage (prompt_tokens grows with the
 *     history so the threshold actually crosses);
 *   - logs every request's message count + prompt-token count so the demo can
 *     show the before/after of a triggered condensation.
 *
 * Scenario: the mock model reads a file, then (once the summary is in the
 * request history) terminates with attempt_completion. The session's
 * --condense-threshold is lowered (0.6) and the fixture history is seeded via
 * a task that makes the loop run long enough for the fake prompt-token count
 * to cross 60% of 128000.
 *
 * Usage: node scripts/e2e/condense-demo.mjs
 * Requires: no API key, no network (mock only). Outputs the request log.
 */

import http from "node:http"
import { execFileSync, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))

// ─── Mock OpenRouter ─────────────────────────────────────────────────────────

function toolCall(id, name, args) {
	return { id, type: "function", function: { name, arguments: JSON.stringify(args) } }
}

/** Fake prompt-token count: grows with the request's message count. */
function fakePromptTokens(messages) {
	// ~1100 tokens per message so a ~90-message history crosses the
	// threshold; the condensed summary message is nearly free (it replaced a
	// big chunk), so count it as ~200 tokens, and count the (system+first
	// user) prefix at a fixed 3000.
	let tokens = 3000
	for (const m of messages.slice(2)) {
		if (typeof m.content === "string" && m.content.includes("Condensed summary")) {
			tokens += 200
		} else {
			tokens += 1100
		}
	}
	return tokens
}

let requestCount = 0
const seenRequests = []

const server = http.createServer((req, res) => {
	const send = (status, body) => {
		const payload = JSON.stringify(body)
		res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) })
		res.end(payload)
	}

	// Context-window lookup: the session calls this once on the first
	// iteration that has a token count.
	if (req.method === "GET" && req.url.startsWith("/api/v1/models/") && req.url.endsWith("/endpoints")) {
		send(200, { data: [{ id: "official", context_length: 128000 }] })
		return
	}

	if (req.method !== "POST" || req.url !== "/api/v1/chat/completions") {
		send(404, { error: { message: `not found: ${req.method} ${req.url}` } })
		return
	}

	let raw = ""
	req.on("data", (c) => (raw += c))
	req.on("end", () => {
		const body = JSON.parse(raw || "{}")
		const messages = Array.isArray(body.messages) ? body.messages : []
		const tools = Array.isArray(body.tools) ? body.tools : []
		const isCondense =
			tools.length === 0 && String(messages[0]?.content ?? "").includes("conversation-compression engine")
		const historyToolCalls = messages.reduce(
			(n, m) => n + (Array.isArray(m.tool_calls) ? m.tool_calls.length : 0),
			0,
		)
		requestCount++

		let reply
		if (isCondense) {
			// The condensation call: return a compact summary.
			reply = {
				role: "assistant",
				content:
					"Condensed: read src/greet.js (the buggy line is `return \"\" // BUG (issue #29)`), " +
					"the fix is to return \"Hello, \" + name. No other facts lost.",
			}
		} else if (requestCount < 24) {
			// Run MANY read iterations so the history grows past the token
			// threshold (each turn adds ~2-3 messages at ~1100 tokens each).
			// Keyed on the GLOBAL request count (not historyToolCalls, which
			// condensation resets) so the demo reliably reaches
			// attempt_completion after the condensation has been observed.
			reply = {
				role: "assistant",
				content: null,
				tool_calls: [toolCall(`call_mock_read_${requestCount}`, "read_file", { path: "src/greet.js" })],
			}
		} else {
			reply = {
				role: "assistant",
				content: null,
				tool_calls: [
					toolCall(`call_mock_done_${requestCount}`, "attempt_completion", {
						result: "Fixed issue #29: greet() returns \"Hello, \" + name.",
					}),
				],
			}
		}

		const promptTokens = fakePromptTokens(messages)
		const usage = { prompt_tokens: promptTokens, completion_tokens: 50, total_tokens: promptTokens + 50 }
		seenRequests.push({
			n: requestCount,
			condense: isCondense,
			msgs: messages.length,
			promptTokens,
			hasSummary: messages.some((m) => typeof m.content === "string" && m.content.includes("Condensed summary")),
		})
		console.log(
			`[mock] request #${requestCount} ${isCondense ? "CONDENSE" : "main    "} msgs=${messages.length} prompt_tokens=${promptTokens} hasSummary=${seenRequests[seenRequests.length - 1].hasSummary}`,
		)
		send(200, {
			id: `chatcmpl-${Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: body.model,
			choices: [{ index: 0, message: reply, finish_reason: reply.tool_calls ? "tool_calls" : "stop" }],
			usage,
		})
	})
})

server.listen(0, "127.0.0.1", async () => {
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	console.log(`[demo] mock listening on 127.0.0.1:${port}`)

	// ─── Fixture workspace ──────────────────────────────────────────────────
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "hc-condense-demo-"))
	fs.mkdirSync(path.join(ws, "src"), { recursive: true })
	fs.writeFileSync(
		path.join(ws, "src", "greet.js"),
		'function greet(name) {\n\treturn "" // BUG (issue #29): should be "Hello, " + name\n}\nmodule.exports = { greet }\n',
		"utf-8",
	)

	// ─── Run the real CLI ───────────────────────────────────────────────────
	const task =
		"Fix the greet function in src/greet.js so it returns \"Hello, \" + name (issue #29). " +
		"Explore thoroughly before editing."

	const args = [
		"src/cli.ts",
		"--task",
		task,
		"--mode",
		"code",
		"--workspace",
		ws,
		"--max-iterations",
		"30",
		// Lower the threshold + context window so the fake 1100-token/message
		// history crosses it within the run.
		"--condense-threshold",
		"0.6",
		"--context-window",
		"40000",
	]
	console.log(`[demo] running: npx tsx ${args.join(" ")}`)
	console.log("")

	const child = spawn("npx", ["tsx", ...args], {
		cwd: ROOT,
		env: {
			...process.env,
			OPENROUTER_BASE_URL: `http://127.0.0.1:${port}`,
			HEADLESSCODE_OPENROUTER_API_KEY: "demo-key",
		},
		stdio: ["ignore", "pipe", "pipe"],
	})
	let cliOut = ""
	child.stdout.on("data", (d) => (cliOut += d))
	child.stderr.on("data", (d) => (cliOut += d))
	const code = await new Promise((resolve) => {
		child.on("close", resolve)
	})
	server.close()

	console.log("")
	console.log("─── CLI output (tail) ───")
	console.log(cliOut.split("\n").filter((l) => !l.includes("INFO") && !l.includes("WARN")).slice(-12).join("\n"))

	console.log("")
	console.log("─── Request log (before/after condensation) ───")
	for (const r of seenRequests) {
		console.log(
			`  req #${String(r.n).padStart(2)}  ${r.condense ? "CONDENSE" : "main   "}  msgs=${String(r.msgs).padStart(3)}  prompt_tokens=${String(r.promptTokens).padStart(6)}  hasSummary=${r.hasSummary}`,
		)
	}

	const condenseReq = seenRequests.find((r) => r.condense)
	const afterCondense = seenRequests.filter((r) => !r.condense && r.n > (condenseReq?.n ?? 0))
	if (condenseReq && afterCondense.length > 0) {
		const beforeTokens = seenRequests
			.filter((r) => !r.condense && r.n < condenseReq.n)
			.slice(-1)[0]?.promptTokens
		const afterTokens = afterCondense[0].promptTokens
		console.log("")
		console.log("─── Before/after (real prompt-token counts) ───")
		console.log(`  last main request BEFORE condensation: ${beforeTokens} prompt tokens`)
		console.log(`  first main request AFTER  condensation: ${afterTokens} prompt tokens`)
		console.log(`  reduction: ${Math.max(0, Math.round((1 - afterTokens / beforeTokens) * 100))}% (${afterTokens - beforeTokens} tokens)`)
		console.log(`  condensation call itself: ${condenseReq.promptTokens} prompt tokens (accounted in the session budget)`)
		console.log(`  summary present in subsequent requests: ${afterCondense.every((r) => r.hasSummary)}`)
		console.log(`  CLI exit code: ${code}`)
	} else {
		console.log("")
		console.log("─── No condensation triggered (check the threshold / history size) ───")
	}

	fs.rmSync(ws, { recursive: true, force: true })
	process.exit(code === 0 ? 0 : 1)
})
