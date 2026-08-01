/**
 * Unit tests for src/codesearch/ollama-embedder.ts — the local Ollama
 * embedding backend.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/codesearch/__tests__/ollama-embedder.test.ts`.
 *
 * A fake local HTTP server stands in for Ollama (mirroring the project's
 * mock-server pattern — see scripts/e2e/mock-openrouter.mjs); NO real Ollama
 * instance is required. The fake serves POST /api/embed exactly like the real
 * Ollama API (verified live 2026-08-01: `{model, input: [...]}` →
 * `{model, embeddings: number[][], ...}`), so the request/response shape and
 * the one-request-per-batch behavior are exercised for real.
 */

import assert from "node:assert/strict"
import * as http from "node:http"
import type { AddressInfo } from "node:net"

import {
	DEFAULT_OLLAMA_EMBEDDING_MODEL,
	DEFAULT_OLLAMA_URL,
	OLLAMA_EMBEDDING_MODEL_ENV,
	OLLAMA_URL_ENV,
	OllamaEmbedError,
	OllamaEmbedder,
	resolveOllamaEmbeddingModel,
	resolveOllamaUrl,
} from "../ollama-embedder.js"

/** Deterministic fake vector for a text (dim 8), so tests can assert content. */
function fakeVector(text: string): number[] {
	const v = new Array<number>(8).fill(0)
	for (const ch of text) {
		v[ch.charCodeAt(0) % 8] += 1
	}
	return v
}

/** A tiny Ollama-like HTTP server; returns a port and a requests log. */
function startFakeOllama(handler: (body: unknown, req: http.IncomingMessage) => unknown | Promise<unknown>): Promise<{
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
			res.writeHead(200, { "Content-Type": "application/json" })
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
	const fake = await startFakeOllama((body) => {
		const b = body as { model?: string; input?: unknown }
		assert.equal(b.model, "qwen3-embedding:8b", "model sent in the request body")
		assert.ok(Array.isArray(b.input), "input is an array (batch)")
		return {
			model: "qwen3-embedding:8b",
			embeddings: (b.input as string[]).map(fakeVector),
			total_duration: 80_000_000,
			load_duration: 50_000_000,
			prompt_eval_count: 6,
		}
	})
	try {
		const embedder = new OllamaEmbedder("qwen3-embedding:8b", `http://127.0.0.1:${fake.port}`)
		const result = await embedder.embedBatch(inputs)

		assert.equal(result.embeddings.length, 2, "one embedding per input")
		assert.deepEqual(result.embeddings[0], fakeVector(inputs[0]), "first vector matches the first input")
		assert.deepEqual(result.embeddings[1], fakeVector(inputs[1]), "second vector matches the second input")
		assert.equal(result.model, "qwen3-embedding:8b")
		// Batch proven: exactly ONE HTTP request carried both inputs.
		assert.equal(fake.requests.length, 1, "a batch of N inputs is ONE HTTP request, not N")
		const sentInputs = (fake.requests[0].body as { input?: unknown }).input
		assert.deepEqual(sentInputs, inputs, "the request body carried the whole batch")
		// No usage/cost object is expected from Ollama — the embedder reports
		// approximate prompt tokens (vector length) and never feeds the budget.
		assert.equal(typeof result.promptTokens, "number")
		assert.ok(result.promptTokens > 0)
	} finally {
		await fake.close()
	}
}

async function testSingleInputStillOneRequest(): Promise<void> {
	const fake = await startFakeOllama(() => ({
		model: "qwen3-embedding:8b",
		embeddings: [fakeVector("only one")],
	}))
	try {
		const embedder = new OllamaEmbedder("qwen3-embedding:8b", `http://127.0.0.1:${fake.port}`)
		const result = await embedder.embedBatch(["only one"])
		assert.equal(result.embeddings.length, 1)
		assert.equal(fake.requests.length, 1)
	} finally {
		await fake.close()
	}
}

async function testEmptyBatchNoRequest(): Promise<void> {
	const fake = await startFakeOllama(() => ({ embeddings: [] }))
	try {
		const embedder = new OllamaEmbedder("qwen3-embedding:8b", `http://127.0.0.1:${fake.port}`)
		const result = await embedder.embedBatch([])
		assert.deepEqual(result.embeddings, [])
		assert.equal(fake.requests.length, 0, "empty batch must not hit the server")
	} finally {
		await fake.close()
	}
}

async function testUnreachableServerActionableError(): Promise<void> {
	// A port with nothing listening — fetch gets ECONNREFUSED.
	const embedder = new OllamaEmbedder("qwen3-embedding:8b", "http://127.0.0.1:1")
	let caught: unknown
	try {
		await embedder.embedBatch(["hello"])
	} catch (err) {
		caught = err
	}
	assert.ok(caught instanceof OllamaEmbedError, "unreachable must throw OllamaEmbedError")
	const message = (caught as Error).message
	assert.match(message, /Ollama backend selected/, "names the selected backend")
	assert.match(message, /unreachable/, "says unreachable, not a generic network error")
	assert.match(message, /ollama serve/, "actionable: asks whether ollama serve is running")
}

async function testModelNotFoundActionableError(): Promise<void> {
	// A real Ollama answers HTTP 404 with `{"error": "model \"...\" not found,
	// try pulling it first"}` — the embedder must surface that actionably.
	const server = http.createServer((_req, res) => {
		const payload = JSON.stringify({ error: 'model "nope:1" not found, try pulling it first' })
		res.writeHead(404, { "Content-Type": "application/json" })
		res.end(payload)
	})
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
	const { port } = server.address() as AddressInfo
	try {
		const embedder = new OllamaEmbedder("nope:1", `http://127.0.0.1:${port}`)
		let caught: unknown
		try {
			await embedder.embedBatch(["hello"])
		} catch (err) {
			caught = err
		}
		assert.ok(caught instanceof OllamaEmbedError)
		const message = (caught as Error).message
		assert.match(message, /not pulled/, "tells the user the model is not pulled")
		assert.match(message, /ollama pull nope:1/, "actionable: gives the pull command")
	} finally {
		await new Promise<void>((r) => server.close(() => r()))
	}
}

async function testMalformedResponseError(): Promise<void> {
	const fake = await startFakeOllama(() => ({ model: "qwen3-embedding:8b", embeddings: "not-an-array" }))
	try {
		const embedder = new OllamaEmbedder("qwen3-embedding:8b", `http://127.0.0.1:${fake.port}`)
		let caught: unknown
		try {
			await embedder.embedBatch(["hello"])
		} catch (err) {
			caught = err
		}
		assert.ok(caught instanceof OllamaEmbedError)
		assert.match((caught as Error).message, /embeddings response contained/, "surfaces the shape mismatch")
	} finally {
		await fake.close()
	}
}

async function testEnvResolution(): Promise<void> {
	// Defaults match the project owner's real local setup.
	assert.equal(DEFAULT_OLLAMA_URL, "http://localhost:11434")
	assert.equal(DEFAULT_OLLAMA_EMBEDDING_MODEL, "qwen3-embedding:8b")

	const env: NodeJS.ProcessEnv = {
		[OLLAMA_URL_ENV]: "http://127.0.0.1:9999",
		[OLLAMA_EMBEDDING_MODEL_ENV]: "custom-model:latest",
	}
	assert.equal(resolveOllamaUrl(env), "http://127.0.0.1:9999")
	assert.equal(resolveOllamaEmbeddingModel(env), "custom-model:latest")

	// Trailing slashes are normalized (localhost:11434/ == localhost:11434).
	const embedder = new OllamaEmbedder("m", "http://localhost:11434/")
	assert.equal((embedder as unknown as { baseUrl: string }).baseUrl, "http://localhost:11434")
}

const tests: Array<[string, () => Promise<void>]> = [
	["a batch of N inputs is ONE HTTP request returning N embeddings (verified shape)", testBatchIsOneRequestManyEmbeddings],
	["a single input is one request", testSingleInputStillOneRequest],
	["empty batch short-circuits without a request", testEmptyBatchNoRequest],
	["unreachable server → clear actionable error (not a generic network error)", testUnreachableServerActionableError],
	["missing model → clear actionable error with the pull command", testModelNotFoundActionableError],
	["malformed response → OllamaEmbedError naming the shape problem", testMalformedResponseError],
	["Ollama URL/model env vars resolve with sensible defaults", testEnvResolution],
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
	console.log(`\nAll ${tests.length} ollama-embedder tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
