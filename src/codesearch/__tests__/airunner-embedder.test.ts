/**
 * Unit tests for src/codesearch/airunner-embedder.ts — the local AIRunner
 * embedding backend.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codesearch/__tests__/airunner-embedder.test.ts`.
 *
 * A fake local HTTP server stands in for the AIRunner server (mirroring the
 * project's mock-server pattern); NO real AIRunner instance is required. The
 * fake serves POST /api/v1/embed/text like the real endpoint:
 * `{"texts": string[]}` → `{"model": "intfloat/e5-large", "embeddings": number[][]}`,
 * so the request/response shape and the one-request-per-batch behavior are
 * exercised for real.
 */

import assert from "node:assert/strict"
import * as http from "node:http"
import type { AddressInfo } from "node:net"

import {
	AIRUNNER_EMBEDDING_MODEL_ENV,
	AIRUNNER_URL_ENV,
	AirunnerEmbedError,
	AirunnerEmbedder,
	DEFAULT_AIRUNNER_EMBEDDING_MODEL,
	DEFAULT_AIRUNNER_URL,
	resolveAirunnerEmbeddingModel,
	resolveAirunnerUrl,
} from "../airunner-embedder.js"

/** Deterministic fake vector for a text (dim 8), so tests can assert content. */
function fakeVector(text: string): number[] {
	const v = new Array<number>(8).fill(0)
	for (const ch of text) {
		v[ch.charCodeAt(0) % 8] += 1
	}
	return v
}

/** A tiny AIRunner-like HTTP server; returns a port and a requests log. */
function startFakeAirunner(
	handler: (body: unknown, req: http.IncomingMessage) => unknown | Promise<unknown>,
	status = 200,
): Promise<{
	port: number
	requests: Array<{ body: unknown; headers: http.IncomingHttpHeaders }>
	close: () => Promise<void>
}> {
	const requests: Array<{ body: unknown; headers: http.IncomingHttpHeaders }> = []
	const server = http.createServer((req, res) => {
		let raw = ""
		req.on("data", (c) => {
			raw += c
		})
		req.on("end", () => {
			let body: unknown = {}
			try {
				body = JSON.parse(raw || "{}")
			} catch {
				// leave {}
			}
			requests.push({ body, headers: req.headers })
			const result = handler(body, req)
			const payload = JSON.stringify(result)
			res.writeHead(status, { "Content-Type": "application/json" })
			res.end(payload)
		})
	})
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo
			resolve({ port, requests, close: () => new Promise((r) => server.close(() => r())) })
		})
	})
}

async function testBatchIsOneRequestManyEmbeddings(): Promise<void> {
	const inputs = ["hello world", "second input"]
	const fake = await startFakeAirunner((body) => {
		const b = body as { texts?: unknown }
		assert.ok(Array.isArray(b.texts), "AIRunner request uses `texts` (an array, batch)")
		assert.equal((body as { input?: unknown }).input, undefined, "AIRunner request must NOT use Ollama's `input` field")
		return {
			model: "intfloat/e5-large",
			embeddings: (b.texts as string[]).map(fakeVector),
		}
	})
	try {
		const embedder = new AirunnerEmbedder("intfloat/e5-large", `http://127.0.0.1:${fake.port}`)
		const result = await embedder.embedBatch(inputs)

		assert.equal(result.embeddings.length, 2, "one embedding per input")
		assert.deepEqual(result.embeddings[0], fakeVector(inputs[0]), "first vector matches the first input")
		assert.deepEqual(result.embeddings[1], fakeVector(inputs[1]), "second vector matches the second input")
		assert.equal(result.model, "intfloat/e5-large")
		// Batch proven: exactly ONE HTTP request carried both inputs.
		assert.equal(fake.requests.length, 1, "a batch of N inputs is ONE HTTP request, not N")
		const sentTexts = (fake.requests[0].body as { texts?: unknown }).texts
		assert.deepEqual(sentTexts, inputs, "the request body carried the whole batch")
		// No usage/cost object is expected from AIRunner — the embedder reports
		// approximate prompt tokens (vector length) and never feeds the budget.
		assert.equal(typeof result.promptTokens, "number")
		assert.ok(result.promptTokens > 0)
	} finally {
		await fake.close()
	}
}

async function testSingleInputStillOneRequest(): Promise<void> {
	const fake = await startFakeAirunner(() => ({
		model: "intfloat/e5-large",
		embeddings: [fakeVector("only one")],
	}))
	try {
		const embedder = new AirunnerEmbedder("intfloat/e5-large", `http://127.0.0.1:${fake.port}`)
		const result = await embedder.embedBatch(["only one"])
		assert.equal(result.embeddings.length, 1)
		assert.equal(fake.requests.length, 1)
	} finally {
		await fake.close()
	}
}

async function testEmptyBatchNoRequest(): Promise<void> {
	const fake = await startFakeAirunner(() => ({ embeddings: [] }))
	try {
		const embedder = new AirunnerEmbedder("intfloat/e5-large", `http://127.0.0.1:${fake.port}`)
		const result = await embedder.embedBatch([])
		assert.deepEqual(result.embeddings, [])
		assert.equal(fake.requests.length, 0, "empty batch must not hit the server")
	} finally {
		await fake.close()
	}
}

async function testUnreachableServerActionableError(): Promise<void> {
	// A port with nothing listening — fetch gets ECONNREFUSED.
	const embedder = new AirunnerEmbedder("intfloat/e5-large", "http://127.0.0.1:1")
	let caught: unknown
	try {
		await embedder.embedBatch(["hello"])
	} catch (err) {
		caught = err
	}
	assert.ok(caught instanceof AirunnerEmbedError, "unreachable must throw AirunnerEmbedError")
	const message = (caught as Error).message
	assert.match(message, /AIRunner backend selected/, "names the selected backend")
	assert.match(message, /unreachable/, "says unreachable, not a generic network error")
	assert.match(message, /AIRunner server running/, "actionable: asks whether the AIRunner server is running")
}

async function testNonOkStatusError(): Promise<void> {
	const server = http.createServer((_req, res) => {
		const payload = JSON.stringify({ error: "embedding model not loaded" })
		res.writeHead(503, { "Content-Type": "application/json" })
		res.end(payload)
	})
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
	const { port } = server.address() as AddressInfo
	try {
		const embedder = new AirunnerEmbedder("intfloat/e5-large", `http://127.0.0.1:${port}`)
		let caught: unknown
		try {
			await embedder.embedBatch(["hello"])
		} catch (err) {
			caught = err
		}
		assert.ok(caught instanceof AirunnerEmbedError)
		const message = (caught as Error).message
		assert.match(message, /HTTP 503/, "surfaces the HTTP status")
		assert.match(message, /embedding model not loaded/, "surfaces the server's error body")
	} finally {
		await new Promise<void>((r) => server.close(() => r()))
	}
}

async function testMalformedResponseError(): Promise<void> {
	const fake = await startFakeAirunner(() => ({ model: "intfloat/e5-large", embeddings: "not-an-array" }))
	try {
		const embedder = new AirunnerEmbedder("intfloat/e5-large", `http://127.0.0.1:${fake.port}`)
		let caught: unknown
		try {
			await embedder.embedBatch(["hello"])
		} catch (err) {
			caught = err
		}
		assert.ok(caught instanceof AirunnerEmbedError)
		assert.match((caught as Error).message, /embeddings response contained/, "surfaces the shape mismatch")
	} finally {
		await fake.close()
	}
}

async function testCountMismatchError(): Promise<void> {
	const fake = await startFakeAirunner(() => ({
		model: "intfloat/e5-large",
		embeddings: [fakeVector("only-one")],
	}))
	try {
		const embedder = new AirunnerEmbedder("intfloat/e5-large", `http://127.0.0.1:${fake.port}`)
		let caught: unknown
		try {
			await embedder.embedBatch(["a", "b"])
		} catch (err) {
			caught = err
		}
		assert.ok(caught instanceof AirunnerEmbedError)
		assert.match((caught as Error).message, /1 embeddings for 2 inputs/, "reports the count mismatch")
	} finally {
		await fake.close()
	}
}

async function testEnvResolution(): Promise<void> {
	// Defaults match AIRunner's standard local port + its native embedding model.
	assert.equal(DEFAULT_AIRUNNER_URL, "http://localhost:8080")
	assert.equal(DEFAULT_AIRUNNER_EMBEDDING_MODEL, "intfloat/e5-large")

	const env: NodeJS.ProcessEnv = {
		[AIRUNNER_URL_ENV]: "http://127.0.0.1:9999",
		[AIRUNNER_EMBEDDING_MODEL_ENV]: "custom-embedder",
	}
	assert.equal(resolveAirunnerUrl(env), "http://127.0.0.1:9999")
	assert.equal(resolveAirunnerEmbeddingModel(env), "custom-embedder")

	// Trailing slashes are normalized (localhost:8080/ == localhost:8080).
	const embedder = new AirunnerEmbedder("m", "http://localhost:8080/")
	assert.equal((embedder as unknown as { baseUrl: string }).baseUrl, "http://localhost:8080")
}

const tests: Array<[string, () => Promise<void>]> = [
	["a batch of N inputs is ONE HTTP request returning N embeddings", testBatchIsOneRequestManyEmbeddings],
	["a single input is one request", testSingleInputStillOneRequest],
	["empty batch short-circuits without a request", testEmptyBatchNoRequest],
	["unreachable server → clear actionable error (not a generic network error)", testUnreachableServerActionableError],
	["non-OK status → AirunnerEmbedError carrying the status + server error body", testNonOkStatusError],
	["malformed response → AirunnerEmbedError naming the shape problem", testMalformedResponseError],
	["embedding-count mismatch → AirunnerEmbedError with the exact counts", testCountMismatchError],
	["AIRunner URL/model env vars resolve with sensible defaults", testEnvResolution],
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
	console.log(`\nAll ${tests.length} airunner-embedder tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
