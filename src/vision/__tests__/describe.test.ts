/**
 * Unit tests for the cloud vision captioning utility (src/vision/describe.ts).
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/vision/__tests__/describe.test.ts`.
 *
 * Every test runs describeImage against a REAL local `node:http` fake
 * OpenRouter server (no network access) that records the incoming request body
 * and returns a scripted multimodal response, so we can assert:
 *   - the request shape: model + a messages[] content ARRAY with a text part
 *     and an `image_url` part carrying the base64-encoded file bytes
 *   - description extraction from choices[0].message.content
 *   - usage extraction (real provider token counts) and that the same usage,
 *     fed through BudgetTracker.record(), produces the real pricing-math cost
 *     — the identical accounting path a regular LLM call goes through.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { AddressInfo } from "node:net"

import { describeImage, VisionError } from "../describe.js"
import { BudgetTracker } from "../../budget/budget.js"

/** Description the fake server returns, quoted in the tests below. */
const SCRIPTED_CONTENT =
	'A red error banner reads: "Failed to load data: Cannot read properties of undefined (reading \'map\')". ' +
	"The main content area is blank where a chart should be. A panel labeled 'Error summary' overlaps the top-right corner of the page."

/** A vision chat-completions response with the given usage numbers. */
function scriptedResponse(model: string, promptTokens: number, completionTokens: number, cachedTokens: number): object {
	return {
		id: "gen-test-1",
		model,
		choices: [
			{
				index: 0,
				finish_reason: "stop",
				message: { role: "assistant", content: SCRIPTED_CONTENT },
			},
		],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			prompt_tokens_details: { cached_tokens: cachedTokens },
		},
	}
}

/**
 * Start a local fake OpenRouter chat-completions server. `respond` maps the
 * parsed request body to { status, json }. Records the LATEST request body as
 * `lastBody` for request-shape assertions.
 */
function startFakeVisionServer(
	respond: (body: Record<string, unknown>) => { status: number; json: object },
): Promise<{ port: number; lastBody: () => Record<string, unknown>; close: () => Promise<void> }> {
	let lastBody: Record<string, unknown> = {}
	const server = http.createServer((req, res) => {
		let raw = ""
		req.on("data", (chunk) => (raw += chunk))
		req.on("end", () => {
			lastBody = JSON.parse(raw) as Record<string, unknown>
			const { status, json } = respond(lastBody)
			res.writeHead(status, { "Content-Type": "application/json" })
			res.end(JSON.stringify(json))
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

async function mkTmpDir(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** The exact image bytes the fixture file contains (asserted to round-trip through base64). */
const IMAGE_BYTES = Buffer.from("fake-png-content-0123456789-abcdef")

async function writeFixtureImage(dir: string): Promise<string> {
	const p = path.join(dir, "fixture.png")
	await fs.writeFile(p, IMAGE_BYTES)
	return p
}

// ─── (a) request shape + description + usage extraction ──────────────────────

async function testRequestShapeAndExtraction(): Promise<void> {
	const server = await startFakeVisionServer(() => ({
		status: 200,
		json: scriptedResponse("google/gemma-3-12b-it", 1234, 87, 12),
	}))
	const dir = await mkTmpDir("hc-vision-shape-")
	try {
		const imagePath = await writeFixtureImage(dir)
		const result = await describeImage(imagePath, {
			baseUrl: `http://127.0.0.1:${server.port}`,
			apiKey: "test-key",
			model: "google/gemma-3-12b-it",
		})

		assert.equal(result.description, SCRIPTED_CONTENT, "description must be the provider's message content verbatim")

		// usage extraction: real numbers from the response, not a stub
		assert.equal(result.usage.model, "google/gemma-3-12b-it")
		assert.equal(result.usage.inputTokens, 1234)
		assert.equal(result.usage.outputTokens, 87)
		assert.equal(result.usage.cachedTokens, 12)

		// request shape: multimodal OpenAI-compatible content array
		const body = server.lastBody()
		assert.equal(body.model, "google/gemma-3-12b-it", "must send the requested model")
		const messages = body.messages as Array<{ role: string; content: unknown }>
		assert.equal(messages.length, 2)
		assert.equal(messages[0].role, "system")
		const content = messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>
		assert.ok(Array.isArray(content), "user message content must be an ARRAY (multimodal shape)")
		assert.equal(content.length, 2)
		assert.equal(content[0].type, "text")
		assert.match(content[0].text ?? "", /Describe this image/)
		assert.equal(content[1].type, "image_url")
		const url = content[1].image_url?.url ?? ""
		assert.ok(url.startsWith("data:image/png;base64,"), `image part must be a base64 data URL, got prefix: ${url.slice(0, 40)}`)
		const decoded = Buffer.from(url.slice("data:image/png;base64,".length), "base64")
		assert.deepEqual(decoded, IMAGE_BYTES, "the base64 payload must be exactly the image file's bytes")
	} finally {
		await server.close()
		await fs.rm(dir, { recursive: true, force: true })
	}
}

// ─── (b) usage feeds the same BudgetTracker path as a regular LLM call ───────

async function testUsageFeedsBudgetTracker(): Promise<void> {
	const server = await startFakeVisionServer(() => ({
		status: 200,
		json: scriptedResponse("google/gemma-3-12b-it", 1000, 200, 0),
	}))
	const dir = await mkTmpDir("hc-vision-budget-")
	try {
		const imagePath = await writeFixtureImage(dir)
		const { usage } = await describeImage(imagePath, {
			baseUrl: `http://127.0.0.1:${server.port}`,
			apiKey: "test-key",
		})

		// The identical recording path a main-loop call uses: BudgetTracker.record
		// with the provider's real token counts -> estimateCost from the pricing
		// table. gemma-3-12b-it is $0.05/M input, $0.15/M output (DEFAULT_PRICING_TABLE).
		const tracker = new BudgetTracker({})
		tracker.record({
			model: usage.model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cachedTokens: usage.cachedTokens,
		})
		const expectedCost = (1000 / 1_000_000) * 0.05 + (200 / 1_000_000) * 0.15
		assert.ok(Math.abs(tracker.totalCostUsd - expectedCost) < 1e-12, `cost must be real pricing math, got ${tracker.totalCostUsd}`)
		assert.equal(tracker.check().ok, true)
	} finally {
		await server.close()
		await fs.rm(dir, { recursive: true, force: true })
	}
}

// ─── (c) error paths ─────────────────────────────────────────────────────────

async function testEmptyFileError(): Promise<void> {
	const dir = await mkTmpDir("hc-vision-empty-")
	try {
		const empty = path.join(dir, "empty.png")
		await fs.writeFile(empty, Buffer.alloc(0))
		await assert.rejects(
			() => describeImage(empty, { baseUrl: "http://127.0.0.1:1", apiKey: "test-key" }),
			(err) => err instanceof VisionError && /is empty \(0 bytes\)/.test(err.message),
			"an empty image file must be a clear VisionError",
		)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testMissingFileError(): Promise<void> {
	await assert.rejects(
		() => describeImage("/nonexistent/definitely-missing.png", { baseUrl: "http://127.0.0.1:1", apiKey: "test-key" }),
		(err) => err instanceof VisionError && /cannot read image file/.test(err.message),
		"a missing image file must be a clear VisionError",
	)
}

async function testHttpErrorSurfacesStatus(): Promise<void> {
	const server = await startFakeVisionServer(() => ({
		status: 429,
		json: { error: { message: "Rate limit exceeded for model", code: 429 } },
	}))
	const dir = await mkTmpDir("hc-vision-http-")
	try {
		const imagePath = await writeFixtureImage(dir)
		await assert.rejects(
			() => describeImage(imagePath, { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "test-key" }),
			(err) => {
				if (!(err instanceof VisionError)) return false
				return err.status === 429 && /HTTP 429/.test(err.message) && /Rate limit exceeded/.test(err.message)
			},
			"a 4xx/5xx must surface as VisionError with status + body excerpt",
		)
	} finally {
		await server.close()
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testMissingContentError(): Promise<void> {
	const server = await startFakeVisionServer(() => ({
		status: 200,
		// 200 with no usable content (e.g. an empty completion)
		json: {
			id: "gen-empty",
			model: "google/gemma-3-12b-it",
			choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: null } }],
			usage: { prompt_tokens: 10, completion_tokens: 0 },
		},
	}))
	const dir = await mkTmpDir("hc-vision-nocontent-")
	try {
		const imagePath = await writeFixtureImage(dir)
		await assert.rejects(
			() => describeImage(imagePath, { baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "test-key" }),
			(err) => err instanceof VisionError && /no choices\[0\]\.message\.content/.test(err.message),
			"a 200 without message.content must be a clear VisionError",
		)
	} finally {
		await server.close()
		await fs.rm(dir, { recursive: true, force: true })
	}
}

async function testMissingApiKeyError(): Promise<void> {
	const prev = process.env.HEADLESSCODE_OPENROUTER_API_KEY
	delete process.env.HEADLESSCODE_OPENROUTER_API_KEY
	try {
		await assert.rejects(
			() => describeImage("x.png", { baseUrl: "http://127.0.0.1:1" }),
			(err) => err instanceof VisionError && /HEADLESSCODE_OPENROUTER_API_KEY is not set/.test(err.message),
			"no API key must be a clear VisionError, not a confusing network error",
		)
	} finally {
		if (prev === undefined) {
			delete process.env.HEADLESSCODE_OPENROUTER_API_KEY
		} else {
			process.env.HEADLESSCODE_OPENROUTER_API_KEY = prev
		}
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["describeImage: multimodal request shape + description/usage extraction", testRequestShapeAndExtraction],
	["describeImage: usage feeds BudgetTracker with real pricing math", testUsageFeedsBudgetTracker],
	["describeImage: empty file is a clear error", testEmptyFileError],
	["describeImage: missing file is a clear error", testMissingFileError],
	["describeImage: HTTP error surfaces status + body excerpt", testHttpErrorSurfacesStatus],
	["describeImage: 200 without message.content is a clear error", testMissingContentError],
	["describeImage: missing API key is a clear error", testMissingApiKeyError],
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
	console.log(`\nAll ${tests.length} vision describe tests passed`)
	process.exit(0)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
