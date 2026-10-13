/**
 * Unit tests for the embedder leaf types (src/codesearch/embedder-types.ts,
 * issue #128).
 *
 * The Embedder/EmbedResult contracts move out of src/codesearch/embedder.ts
 * so the Ollama and AIRunner backends can share them without an import cycle
 * back into the factory module (the architecture checker counts even
 * type-only edges). The factory keeps re-exporting the same names.
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/codesearch/__tests__/embedder-types.test.ts`.
 */

import assert from "node:assert/strict"

import { AirunnerEmbedder } from "../airunner-embedder.js"
import { createEmbedder, OpenRouterEmbedder } from "../embedder.js"
import type { Embedder, EmbedResult } from "../embedder-types.js"
import { OllamaEmbedder } from "../ollama-embedder.js"

async function testBackendsSatisfyTheSharedInterface(): Promise<void> {
	const url = "http://localhost:1"
	const ollama: Embedder = new OllamaEmbedder("test-model", url)
	const airunner: Embedder = new AirunnerEmbedder("test-model", url)
	assert.equal(ollama.model, "test-model")
	assert.equal(airunner.model, "test-model")
	const empty: EmbedResult = {
		embeddings: [], model: "test-model", promptTokens: 0, totalTokens: 0,
	}
	assert.deepEqual(await ollama.embedBatch([]), empty)
	assert.deepEqual(await airunner.embedBatch([]), empty)
}

async function testFactorySelectsBackends(): Promise<void> {
	const url = "http://localhost:1"
	const oOpts = { ollamaModel: "m", ollamaUrl: url }
	const ollama = createEmbedder("ollama", oOpts, {})
	assert.ok(ollama instanceof OllamaEmbedder)
	const aOpts = { airunnerModel: "m", airunnerUrl: url }
	const airunner = createEmbedder("airunner", aOpts, {})
	assert.ok(airunner instanceof AirunnerEmbedder)
	const open = createEmbedder("openrouter", { model: "m" }, {})
	assert.ok(open instanceof OpenRouterEmbedder)
}

async function testBackendsRejectEmptyInput(): Promise<void> {
	const ollama = new OllamaEmbedder("m", "http://localhost:1")
	await assert.rejects(() => ollama.embedBatch(["   "]), /empty/)
	const airunner = new AirunnerEmbedder("m", "http://localhost:1")
	await assert.rejects(() => airunner.embedBatch([""]), /empty/)
}

async function runOne(name: string, fn: () => Promise<void>): Promise<boolean> {
	try {
		await fn()
		console.log(`  ok   ${name}`)
		return true
	} catch (error) {
		console.error(`  FAIL ${name}`)
		if (error instanceof Error) console.error(error.stack ?? error)
		else console.error(String(error))
		return false
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["backends satisfy interface", testBackendsSatisfyTheSharedInterface],
		["factory selects backends", testFactorySelectsBackends],
		["backends reject empty input", testBackendsRejectEmptyInput],
	]
	let failed = 0
	for (const [name, fn] of tests) {
		if (!(await runOne(name, fn))) failed++
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} embedder-types tests passed`)
}

main().catch((error) => {
	console.error("Test runner crashed:", error)
	process.exit(1)
})
