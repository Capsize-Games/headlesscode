/**
 * Unit tests for the executor-level gating of local output summarization
 * (src/tools/executor.ts's summarizeCommandOutput, gated by
 * HEADLESSCODE_LOCAL_SUMMARIZATION).
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/tools/__tests__/local-summarization-gate.test.ts`.
 *
 * These run the REAL executeCommandHandler against a real shell + a fake
 * Ollama server, so they prove the actual wiring:
 *   - OFF by default => today's exact blunt truncation (no HTTP call at all)
 *     — the default is a pinned, measured decision
 *     (LOCAL_SUMMARIZATION_DEFAULT_ENABLED = false; r3-summarize round found
 *     oversized exec results are ~1.8% of real results, saving ~4k tokens/
 *     session at +2.5-3.4s latency per result — not worth a default flip),
 *     and an explicit "0"/"false" env forces it off even after a flip
 *   - ON + unreachable Ollama => falls back to blunt truncation, no error,
 *     no hang
 *   - ON + small result => never sent to the summarizer (no HTTP call)
 *   - ON + oversized result => summarized with the transparency header
 */

import assert from "node:assert/strict"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../executor.js"
import { MAX_RESULT_CHARS } from "../executor.js"
import { LOCAL_SUMMARIZATION_DEFAULT_ENABLED } from "../output-summarizer.js"

const SUMMARIZATION_ENV = "HEADLESSCODE_LOCAL_SUMMARIZATION"
const OLLAMA_URL_ENV = "HEADLESSCODE_OLLAMA_URL"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** A fake Ollama chat server that counts requests. */
function startFakeOllama(): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
	let requests = 0
	const server = http.createServer((req, res) => {
		requests++
		let raw = ""
		req.on("data", (c) => (raw += c.toString()))
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(
				JSON.stringify({
					model: "fake",
					message: { role: "assistant", content: "SUMMARY_OF_LARGE_OUTPUT fake summary" },
					done: true,
					done_reason: "stop",
				}),
			)
		})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve({ url: `http://127.0.0.1:${port}`, count: () => requests, close: () => new Promise((r) => server.close(() => r())) })
		})
	})
}

// Build a large command output (> MAX_RESULT_CHARS) deterministically.
function bigOutputCommand(): string {
	// `node -e` printing ~45KB of lines (well over the 30KB cap).
	return `node -e 'let s=""; for (let i=0;i<1500;i++) s += "noise line number " + i + " padding padding padding padding padding padding padding padding padding\\n"; process.stdout.write(s)'`
}

// ─── (a) OFF by default: exact blunt truncation, summarizer never called ─────

async function testOffByDefaultUsesBluntTruncation(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-summ-off-")
	const fake = await startFakeOllama()
	try {
		const oldEnv = { ...process.env }
		delete process.env[SUMMARIZATION_ENV]
		delete process.env[OLLAMA_URL_ENV]
		process.env[OLLAMA_URL_ENV] = fake.url // point at the fake anyway — must NOT be called
		try {
			const executor = createHeadlessExecutor(ws)
			const result = await executor.execute("execute_command", { command: bigOutputCommand() })

			assert.equal(result.isError, false, "normal completion, not an error")
			assert.match(result.content, /output truncated at \d+ chars to keep context bounded/, "blunt truncation trailer present")
			assert.ok(result.content.length > MAX_RESULT_CHARS, "truncated result still over the cap (cap + trailer)")
			assert.doesNotMatch(result.content, /\[Output summarized by local model/, "NO summary header when OFF")
			assert.equal(fake.count(), 0, "summarizer must not be called when OFF")
		} finally {
			process.env = oldEnv
		}
	} finally {
		await fake.close()
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (a2) default pinned OFF + explicit "0" opt-out stays OFF ────────────────

async function testDefaultPinnedOffAndOptOut(): Promise<void> {
	// The default is a measured decision (see the constant's comment in
	// src/tools/output-summarizer.ts); asserting it here means a deliberate
	// flip is a visible change that must update this test too.
	assert.equal(LOCAL_SUMMARIZATION_DEFAULT_ENABLED, false, "default pinned OFF (measured decision)")
	const ws = await mkTmpWorkspace("hc-summ-optout-")
	const fake = await startFakeOllama()
	try {
		const oldEnv = { ...process.env }
		// Explicit "0" must force the feature off even if the default ever
		// flips — the opt-out path the round's decision relies on.
		process.env[SUMMARIZATION_ENV] = "0"
		process.env[OLLAMA_URL_ENV] = fake.url
		try {
			const executor = createHeadlessExecutor(ws)
			const result = await executor.execute("execute_command", { command: bigOutputCommand() })

			assert.equal(result.isError, false, "normal completion")
			assert.match(result.content, /output truncated at \d+ chars to keep context bounded/, "blunt truncation trailer present")
			assert.doesNotMatch(result.content, /\[Output summarized by local model/, "NO summary header when opt-out")
			assert.equal(fake.count(), 0, "summarizer must not be called when explicitly opted out")
		} finally {
			process.env = oldEnv
		}
	} finally {
		await fake.close()
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) ON + unreachable Ollama: falls back to blunt truncation, no error ───

async function testOnWithUnreachableOllamaFallsBackCleanly(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-summ-dead-")
	try {
		const oldEnv = { ...process.env }
		process.env[SUMMARIZATION_ENV] = "1"
		// Point at a port with nothing listening.
		process.env[OLLAMA_URL_ENV] = "http://127.0.0.1:1"
		try {
			const executor = createHeadlessExecutor(ws)
			const started = Date.now()
			const result = await executor.execute("execute_command", { command: bigOutputCommand() })
			const elapsed = Date.now() - started

			assert.equal(result.isError, false, "an unreachable local model must NOT turn the result into an error")
			assert.match(result.content, /output truncated at \d+ chars to keep context bounded/, "fell back to blunt truncation")
			assert.doesNotMatch(result.content, /\[Output summarized by local model/, "no summary header on failure")
			assert.ok(elapsed < 15_000, `must not hang (took ${elapsed}ms)`)
		} finally {
			process.env = oldEnv
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) ON + malformed Ollama response: falls back cleanly, no error ────────

async function testOnWithMalformedResponseFallsBackCleanly(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-summ-malformed-")
	const fake = await startFakeOllama()
	// Override: return a malformed body for the one call.
	let malformed = false
	const server = http.createServer((req, res) => {
		malformed = true
		req.resume()
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end("<html>not json</html>")
		})
	})
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
	const { port } = server.address() as AddressInfo
	try {
		const oldEnv = { ...process.env }
		process.env[SUMMARIZATION_ENV] = "1"
		process.env[OLLAMA_URL_ENV] = `http://127.0.0.1:${port}`
		try {
			const executor = createHeadlessExecutor(ws)
			const result = await executor.execute("execute_command", { command: bigOutputCommand() })

			assert.equal(result.isError, false, "malformed response must not error the tool result")
			assert.match(result.content, /output truncated at \d+ chars to keep context bounded/, "fell back to blunt truncation")
			assert.equal(malformed, true, "the fake was actually hit")
		} finally {
			process.env = oldEnv
		}
	} finally {
		await new Promise((r) => server.close(r))
		await fake.close()
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (d) ON + small result: never sent to the summarizer ─────────────────────

async function testSmallResultNeverSummarized(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-summ-small-")
	const fake = await startFakeOllama()
	try {
		const oldEnv = { ...process.env }
		process.env[SUMMARIZATION_ENV] = "1"
		process.env[OLLAMA_URL_ENV] = fake.url
		try {
			const executor = createHeadlessExecutor(ws)
			const result = await executor.execute("execute_command", { command: "node -e 'console.log(40+2)'" })

			assert.equal(result.isError, false, "normal completion")
			assert.match(result.content, /42/, "output preserved")
			assert.doesNotMatch(result.content, /\[Output summarized by local model/, "no summary header for small output")
			assert.equal(fake.count(), 0, "summarizer must not be called for under-cap results")
		} finally {
			process.env = oldEnv
		}
	} finally {
		await fake.close()
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (e) ON + oversized result: summarized with the transparency header ──────

async function testOnOversizedResultIsSummarized(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-summ-on-")
	const fake = await startFakeOllama()
	try {
		const oldEnv = { ...process.env }
		process.env[SUMMARIZATION_ENV] = "1"
		process.env[OLLAMA_URL_ENV] = fake.url
		try {
			const executor = createHeadlessExecutor(ws)
			const result = await executor.execute("execute_command", { command: bigOutputCommand() })

			assert.equal(result.isError, false, "summarized result is a normal result")
			assert.match(result.content, /\[Output summarized by local model/, "transparency header present")
			assert.match(result.content, /SUMMARY_OF_LARGE_OUTPUT/, "summary content included")
			assert.ok(result.content.length < 2_000, "summarized result is compact")
			assert.equal(fake.count(), 1, "summarizer called exactly once")
		} finally {
			process.env = oldEnv
		}
	} finally {
		await fake.close()
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["OFF by default: execute_command oversized output uses today's exact blunt truncation, summarizer never called", testOffByDefaultUsesBluntTruncation],
	["default pinned OFF + explicit '0' opt-out stays OFF (no summarizer call)", testDefaultPinnedOffAndOptOut],
	["ON + Ollama unreachable: falls back to blunt truncation, no error, no hang", testOnWithUnreachableOllamaFallsBackCleanly],
	["ON + malformed Ollama response: falls back cleanly, no error", testOnWithMalformedResponseFallsBackCleanly],
	["ON + small result: never sent to the summarizer", testSmallResultNeverSummarized],
	["ON + oversized result: summarized with transparency header", testOnOversizedResultIsSummarized],
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
	console.log(`\nAll ${tests.length} local-summarization-gate tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
