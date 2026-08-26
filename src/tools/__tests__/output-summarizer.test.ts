/**
 * Unit tests for src/tools/output-summarizer.ts.
 *
 * Plain assert-based script (no test framework, no real Ollama required), run
 * via `npm test` -> `tsx src/tools/__tests__/output-summarizer.test.ts`.
 *
 * The fake Ollama server is a real `node:http` listener so the summarizer's
 * `fetch` hits a genuine HTTP endpoint (mirroring the e2e mock-OpenRouter
 * pattern) — no mocking of `fetch` itself.
 */

import assert from "node:assert/strict"
import * as http from "node:http"
import type { AddressInfo } from "node:net"

import {
	OllamaOutputSummarizer,
	SummarizerError,
	isLocalSummarizationEnabled,
	resolveOllamaUrl,
	resolveSummarizationModel,
	summarizeToolResult,
	truncateFallback,
	MAX_RESULT_CHARS_FOR_FALLBACK,
	DEFAULT_OLLAMA_URL,
	DEFAULT_SUMMARIZATION_MODEL,
	LOCAL_SUMMARIZATION_DEFAULT_ENABLED,
	LOCAL_SUMMARIZATION_ENV,
} from "../output-summarizer.js"

// ─── Fake Ollama server ───────────────────────────────────────────────────────

type FakeHandler = (req: http.IncomingMessage, body: string) => Promise<{ status: number; body: string }>

function startFakeServer(handler: FakeHandler): Promise<{ url: string; close: () => Promise<void>; requests: Array<{ path: string; body: string }> }> {
	const requests: Array<{ path: string; body: string }> = []
	const server = http.createServer((req, res) => {
		let raw = ""
		req.on("data", (chunk) => {
			raw += chunk.toString()
		})
		req.on("end", () => {
			requests.push({ path: req.url ?? "", body: raw })
			handler(req, raw)
				.then(({ status, body }) => {
					res.writeHead(status, { "Content-Type": "application/json" })
					res.end(body)
				})
				.catch(() => {
					res.writeHead(500, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ error: "fake server crashed" }))
				})
		})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () => new Promise((r) => server.close(() => r())),
				requests,
			})
		})
	})
}

const chatResponse = (content: string, extra: Record<string, unknown> = {}): string =>
	JSON.stringify({
		model: "fake-model",
		created_at: "2026-08-01T00:00:00Z",
		message: { role: "assistant", content },
		done: true,
		done_reason: "stop",
		...extra,
	})

// ─── (a) happy path: valid request/response round-trip ───────────────────────

async function testHappyPathSummarizes(): Promise<void> {
	const fake = await startFakeServer(async (_req, body) => {
		const parsed = JSON.parse(body)
		assert.equal(parsed.stream, false, "non-streaming request")
		assert.equal(parsed.model, "fake-model", "model propagated")
		assert.equal(typeof parsed.options?.temperature, "number", "temperature set")
		assert.ok(Array.isArray(parsed.messages), "messages is an array")
		assert.equal(parsed.messages[0]?.role, "system", "system message first")
		assert.match(parsed.messages[1]?.content ?? "", /OUTPUT BEGIN/, "user prompt embeds the output")
		return { status: 200, body: chatResponse("tests: 42 passed, 1 FAILED — types.test.ts") }
	})
	try {
		const summarizer = new OllamaOutputSummarizer({ baseUrl: fake.url, model: "fake-model", timeoutMs: 5_000 })
		const result = await summarizer.summarize("x".repeat(35_000))
		assert.match(result.summary, /types\.test\.ts/, "summary contains the needle")
		assert.equal(result.originalChars, 35_000, "originalChars reported")
		assert.equal(result.truncated, false, "not flagged truncated on done_reason stop")
		assert.ok(result.elapsedMs >= 0, "elapsedMs present")
		assert.equal(fake.requests.length, 1, "exactly one request")
		assert.equal(fake.requests[0]!.path, "/api/chat", "hits the chat endpoint")
	} finally {
		await fake.close()
	}
}

// ─── (b) non-2xx HTTP → throws, and executor fallback returns blunt truncation ─

async function testHttpErrorFallsBackToBluntTruncation(): Promise<void> {
	const fake = await startFakeServer(async () => ({ status: 503, body: "unavailable" }))
	try {
		const summarizer = new OllamaOutputSummarizer({ baseUrl: fake.url, model: "fake-model" })
		const raw = "A".repeat(40_000)
		await assert.rejects(() => summarizer.summarize(raw), SummarizerError)
		// The executor-facing wrapper must NOT throw — it falls back.
		const output = await summarizeToolResult(raw, summarizer, { debug: () => {}, warn: () => {} })
		assert.ok(output.includes("output truncated at"), "fell back to blunt truncation")
		assert.ok(output.startsWith("A".repeat(MAX_RESULT_CHARS_FOR_FALLBACK)), "blunt cut at the cap")
	} finally {
		await fake.close()
	}
}

// ─── (c) malformed/non-JSON 200 body → throws (fallback at executor level) ───

async function testMalformedBodyThrows(): Promise<void> {
	const fake = await startFakeServer(async () => ({ status: 200, body: "<html>not json</html>" }))
	try {
		const summarizer = new OllamaOutputSummarizer({ baseUrl: fake.url, model: "fake-model" })
		await assert.rejects(() => summarizer.summarize("B".repeat(31_000)), SummarizerError)
	} finally {
		await fake.close()
	}
}

// ─── (d) missing message.content → throws (qwen thinking-model trap) ─────────

async function testMissingContentThrows(): Promise<void> {
	const fake = await startFakeServer(async () => ({
		status: 200,
		body: JSON.stringify({ model: "qwen3:8b", message: { role: "assistant", thinking: "thinking…" }, done: true, done_reason: "stop" }),
	}))
	try {
		const summarizer = new OllamaOutputSummarizer({ baseUrl: fake.url, model: "qwen3:8b" })
		await assert.rejects(() => summarizer.summarize("C".repeat(31_000)), SummarizerError)
	} finally {
		await fake.close()
	}
}

// ─── (e) request includes think:false (qwen3-class models need it) ───────────

async function testRequestSendsThinkFalse(): Promise<void> {
	const fake = await startFakeServer(async (_req, body) => {
		const parsed = JSON.parse(body)
		assert.equal(parsed.think, false, "think:false must be sent for qwen3-class models")
		return { status: 200, body: chatResponse("ok") }
	})
	try {
		const summarizer = new OllamaOutputSummarizer({ baseUrl: fake.url, model: "qwen3:8b" })
		await summarizer.summarize("D".repeat(31_000))
	} finally {
		await fake.close()
	}
}

// ─── (f) done_reason length → truncated flag surfaced in the header ──────────

async function testTruncatedFlagSurfaced(): Promise<void> {
	const fake = await startFakeServer(async () => ({
		status: 200,
		body: chatResponse("partial summary", { done_reason: "length" }),
	}))
	try {
		const summarizer = new OllamaOutputSummarizer({ baseUrl: fake.url, model: "fake-model" })
		const output = await summarizeToolResult("E".repeat(31_000), summarizer, { debug: () => {}, warn: () => {} })
		assert.match(output, /\[Output summarized by local model/, "transparency header present")
		assert.match(output, /may be incomplete/, "truncated flag surfaced in the header")
	} finally {
		await fake.close()
	}
}

// ─── (g) env-var gate + resolution helpers ───────────────────────────────────

async function testEnvGateAndResolvers(): Promise<void> {
	// The default is a pinned, explicit decision (r3-summarize measured the
	// trade: ~1.8% of real exec results are oversized, saving ~4k tokens/
	// session at +2.5-3.4s latency per result — not enough to flip ON for
	// everyone). Tests assert the CONSTANT so a deliberate default flip is a
	// visible one-line change that must update these assertions too.
	assert.equal(LOCAL_SUMMARIZATION_DEFAULT_ENABLED, false, "default stays OFF (measured decision, see constant comment)")
	assert.equal(isLocalSummarizationEnabled({}), LOCAL_SUMMARIZATION_DEFAULT_ENABLED, "unset env == the pinned default")
	assert.equal(isLocalSummarizationEnabled({}), false, "OFF by default")
	assert.equal(isLocalSummarizationEnabled({ HEADLESSCODE_LOCAL_SUMMARIZATION: "1" }), true, "1 enables")
	assert.equal(isLocalSummarizationEnabled({ HEADLESSCODE_LOCAL_SUMMARIZATION: "true" }), true, "true enables")
	assert.equal(isLocalSummarizationEnabled({ HEADLESSCODE_LOCAL_SUMMARIZATION: "TRUE" }), true, "case-insensitive enable")
	assert.equal(isLocalSummarizationEnabled({ HEADLESSCODE_LOCAL_SUMMARIZATION: "0" }), false, "0 forces off (opt-out)")
	assert.equal(isLocalSummarizationEnabled({ HEADLESSCODE_LOCAL_SUMMARIZATION: "false" }), false, "false forces off (opt-out)")
	assert.equal(isLocalSummarizationEnabled({ HEADLESSCODE_LOCAL_SUMMARIZATION: "garbage" }), false, "unrecognized value stays off")
	assert.equal(LOCAL_SUMMARIZATION_ENV, "HEADLESSCODE_LOCAL_SUMMARIZATION", "env var name pinned")

	assert.equal(resolveOllamaUrl({}), DEFAULT_OLLAMA_URL, "default Ollama URL")
	assert.equal(resolveOllamaUrl({ HEADLESSCODE_OLLAMA_URL: "http://10.0.0.1:11434/" }), "http://10.0.0.1:11434", "trailing slash stripped")
	assert.equal(resolveSummarizationModel({}), DEFAULT_SUMMARIZATION_MODEL, "default model")
	assert.equal(resolveSummarizationModel({ HEADLESSCODE_SUMMARIZATION_MODEL: "llama3.1:8b" }), "llama3.1:8b", "model env override")
}

// ─── (h) truncateFallback matches today's exact blunt-truncation behavior ────

async function testTruncateFallbackBehavior(): Promise<void> {
	const under = "short"
	assert.equal(truncateFallback(under), under, "under-cap content unchanged")
	const over = "x".repeat(40_000)
	const out = truncateFallback(over)
	assert.equal(out.slice(0, MAX_RESULT_CHARS_FOR_FALLBACK), "x".repeat(MAX_RESULT_CHARS_FOR_FALLBACK), "first 30000 chars are the raw content")
	assert.ok(out.endsWith("\n…[output truncated at 30000 chars to keep context bounded]"), "exact trailer")
}

// ─── (i) oversized summary (> MAX_SUMMARY_CHARS) throws (safety cap) ──────────

async function testOversizedSummaryRejected(): Promise<void> {
	const fake = await startFakeServer(async () => ({
		status: 200,
		body: chatResponse("Z".repeat(9_000)),
	}))
	try {
		const summarizer = new OllamaOutputSummarizer({ baseUrl: fake.url, model: "fake-model" })
		await assert.rejects(() => summarizer.summarize("F".repeat(31_000)), SummarizerError)
	} finally {
		await fake.close()
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["summarizer: happy path — request shape + summary extraction", testHappyPathSummarizes],
	["summarizer: HTTP error -> throws; executor wrapper falls back to blunt truncation", testHttpErrorFallsBackToBluntTruncation],
	["summarizer: malformed 200 body -> throws SummarizerError", testMalformedBodyThrows],
	["summarizer: missing message.content (thinking-model trap) -> throws", testMissingContentThrows],
	["summarizer: request sends think:false for qwen3-class models", testRequestSendsThinkFalse],
	["summarizer: done_reason 'length' surfaces 'may be incomplete' in the header", testTruncatedFlagSurfaced],
	["summarizer: env gate OFF by default + URL/model resolvers", testEnvGateAndResolvers],
	["summarizer: truncateFallback matches today's exact blunt truncation", testTruncateFallbackBehavior],
	["summarizer: oversized summary (> MAX_SUMMARY_CHARS) rejected", testOversizedSummaryRejected],
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
	console.log(`\nAll ${tests.length} output-summarizer tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
