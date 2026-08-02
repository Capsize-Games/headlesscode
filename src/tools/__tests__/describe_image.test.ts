/**
 * Unit tests for the describe_image tool handler (src/vision/tool.ts), which
 * reuses resolveWithinWorkspace's path-safety guard and reports real usage
 * through ToolContext.onAuxLlmUsage.
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` -> `tsx src/tools/__tests__/describe_image.test.ts`.
 *
 * The handler is exercised against a REAL local `node:http` fake OpenRouter
 * server reached through the standard env vars (OPENROUTER_BASE_URL +
 * HEADLESSCODE_OPENROUTER_API_KEY) — the same config a real session uses — so the whole
 * describeImage -> HTTP -> description/usage path is tested for real, not
 * stubbed.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { AddressInfo } from "node:net"

import { createHeadlessExecutor } from "../executor.js"
import type { AuxLlmUsage } from "../../engine/types.js"

const SCRIPTED_CONTENT =
	"A dashboard titled 'Q3 Revenue Dashboard' shows $42,318.50 (+12.4%), Active users 1,284 (-3.1%), Error rate 0.07%."

function startFakeVisionServer(): Promise<{
	port: number
	lastBody: () => { model?: string; messages?: Array<{ content?: unknown }> }
	close: () => Promise<void>
}> {
	let lastBody: { model?: string; messages?: Array<{ content?: unknown }> } = {}
	const server = http.createServer((req, res) => {
		let raw = ""
		req.on("data", (chunk) => (raw += chunk))
		req.on("end", () => {
			lastBody = JSON.parse(raw) as { model?: string; messages?: Array<{ content?: unknown }> }
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(
				JSON.stringify({
					id: "gen-test-2",
					model: "google/gemma-3-12b-it",
					choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: SCRIPTED_CONTENT } }],
					usage: { prompt_tokens: 500, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 7 } },
				}),
			)
		})
	})
	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port
			resolve({
				port,
				lastBody: () => lastBody,
				close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
			})
		})
	})
}

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeFixtureImage(ws: string): Promise<void> {
	await fs.writeFile(path.join(ws, "fixture.png"), Buffer.from("fake-png-bytes-for-describe-image-tool"))
}

async function withVisionEnv(port: number, fn: () => Promise<void>): Promise<void> {
	const prevBase = process.env.OPENROUTER_BASE_URL
	const prevKey = process.env.HEADLESSCODE_OPENROUTER_API_KEY
	process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`
	process.env.HEADLESSCODE_OPENROUTER_API_KEY = "test-key"
	try {
		await fn()
	} finally {
		if (prevBase === undefined) {
			delete process.env.OPENROUTER_BASE_URL
		} else {
			process.env.OPENROUTER_BASE_URL = prevBase
		}
		if (prevKey === undefined) {
			delete process.env.HEADLESSCODE_OPENROUTER_API_KEY
		} else {
			process.env.HEADLESSCODE_OPENROUTER_API_KEY = prevKey
		}
	}
}

// ─── (a) round trip: real path -> real HTTP call -> real description ─────────

async function testRoundTrip(): Promise<void> {
	const server = await startFakeVisionServer()
	const ws = await mkTmpWorkspace("hc-describe-image-rt-")
	try {
		await writeFixtureImage(ws)
		await withVisionEnv(server.port, async () => {
			const executor = createHeadlessExecutor(ws)
			const result = await executor.execute("describe_image", { path: "fixture.png" })

			assert.equal(result.isError, false, `describe_image must succeed, got: ${result.content}`)
			assert.ok(result.content.startsWith("describe_image: fixture.png\n"), "must report which file was described")
			assert.match(result.content, /\$42,318\.50/, "must include the real description text from the vision call")

			// The request the fake server received must be a multimodal image_url
			// call against the default vision model.
			const body = server.lastBody()
			assert.equal(body.model, "google/gemma-3-12b-it", "must use the default vision model")
			const content = body.messages?.[1]?.content as Array<{ type?: string; image_url?: { url?: string } }> | undefined
			assert.ok(Array.isArray(content), "must send a multimodal content array")
			assert.ok(
				content?.some((part) => part.type === "image_url" && (part.image_url?.url ?? "").startsWith("data:image/png;base64,")),
				"must send the image as a base64 image_url part",
			)
		})
	} finally {
		await server.close()
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (b) usage is reported through onAuxLlmUsage (budget/usage accounting) ───

async function testUsageForwarded(): Promise<void> {
	const server = await startFakeVisionServer()
	const ws = await mkTmpWorkspace("hc-describe-image-usage-")
	try {
		await writeFixtureImage(ws)
		const captured: AuxLlmUsage[] = []
		await withVisionEnv(server.port, async () => {
			const executor = createHeadlessExecutor(ws, { onAuxLlmUsage: (usage) => captured.push(usage) })
			const result = await executor.execute("describe_image", { path: "fixture.png" })
			assert.equal(result.isError, false, `describe_image must succeed, got: ${result.content}`)

			assert.equal(captured.length, 1, "the captioning call must report its usage exactly once")
			// Real token numbers from the fake response, not a hardcoded stub.
			assert.equal(captured[0].model, "google/gemma-3-12b-it")
			assert.equal(captured[0].inputTokens, 500)
			assert.equal(captured[0].outputTokens, 42)
			assert.equal(captured[0].cachedTokens, 7)
		})
	} finally {
		await server.close()
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (c) path safety + missing-file errors ───────────────────────────────────

async function testPathEscapeRejected(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-describe-image-escape-")
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("describe_image", { path: "../outside.png" })
		assert.equal(result.isError, true, "a path escaping the workspace must be rejected")
		assert.match(result.content, /escapes the workspace/, `must name the traversal, got: ${result.content}`)
		assert.match(result.content, /\[Error\]/, "must carry the [Error] marker")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testMissingFileError(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-describe-image-missing-")
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("describe_image", { path: "no-such-image.png" })
		assert.equal(result.isError, true, "a missing file must be an error")
		assert.match(result.content, /no such file/, `must say the file is missing, got: ${result.content}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testBadArgumentRejected(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-describe-image-arg-")
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("describe_image", { path: 42 })
		assert.equal(result.isError, true, "a non-string path must be an error")
		assert.match(result.content, /missing or invalid string argument 'path'/, `got: ${result.content}`)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["describe_image: round trip returns a real vision description", testRoundTrip],
	["describe_image: usage flows through onAuxLlmUsage", testUsageForwarded],
	["describe_image: path escaping the workspace is rejected", testPathEscapeRejected],
	["describe_image: missing file is a clear error", testMissingFileError],
	["describe_image: bad path argument is a clear error", testBadArgumentRejected],
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
	console.log(`\nAll ${tests.length} describe_image tests passed`)
	process.exit(0)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
