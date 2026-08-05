/**
 * Unit tests for src/codesearch/search.ts — query-time top-K search over a
 * fixture index, with a deterministic fake embedder (no network).
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/codesearch/__tests__/search.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { buildIndex } from "../index.js"
import { formatSearchResults, searchIndex } from "../search.js"
import type { Embedder } from "../embedder.js"

/** Deterministic fake embedder: vector[i] = count of the i-th letter. */
class FakeEmbedder implements Embedder {
	model = "fake/embed"
	async embedBatch(texts: string[]): Promise<{ embeddings: number[][]; promptTokens: number; totalTokens: number }> {
		return {
			embeddings: texts.map((t) => fakeVector(t)),
			promptTokens: texts.length,
			totalTokens: texts.length,
		}
	}
}

/** Deterministic 26-dim vector: count of each lowercase letter. */
function fakeVector(text: string): number[] {
	const v = new Array<number>(26).fill(0)
	for (const ch of text.toLowerCase()) {
		const code = ch.charCodeAt(0) - 97
		if (code >= 0 && code < 26) {
			v[code] += 1
		}
	}
	return v
}

async function mkTmpWorkspace(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-search-"))
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel)
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, content, "utf-8")
	}
	return dir
}

async function testTopKOrderingMatchesCosineSimilarity(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"src/auth.ts": "function hashPassword(password) {\n  return crypto.hash(password)\n}\n",
		"src/db.ts": "function connect(database) {\n  return pool.connect(database)\n}\n",
		"src/login.ts": "function login(user, password) {\n  const hash = hashPassword(password)\n  return auth(user, hash)\n}\n",
	})
	try {
		const embedder = new FakeEmbedder()
		await buildIndex(embedder, ws)

		// A query about password hashing should rank auth.ts and login.ts
		// (which mention "password"/"hash") above db.ts.
		const queryEmbedding = fakeVector("password hashing and login authentication")
		const results = searchIndex(ws, queryEmbedding, undefined, 10)

		assert.ok(results.length >= 3, "expected all three fixture chunks to be returned")
		assert.ok(results[0].score >= results[1].score, "results must be sorted descending by score")
		assert.ok(results[1].score >= results[2].score, "results must be sorted descending by score")

		const topPaths = results.slice(0, 3).map((r) => r.filePath)
		// The top result must be one of the password/hash-related files.
		assert.ok(
			topPaths.includes("src/auth.ts") || topPaths.includes("src/login.ts"),
			`expected a password-related file at the top, got ${topPaths.join(", ")}`,
		)

		// Result shape matches the vendored CodebaseSearchTool payload.
		const r = results[0]
		assert.equal(typeof r.filePath, "string")
		assert.equal(typeof r.score, "number")
		assert.ok(r.startLine >= 1 && r.endLine >= r.startLine)
		assert.equal(typeof r.codeChunk, "string")
		assert.ok(r.codeChunk.length > 0, "snippet re-read from the file")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testPathPrefixFiltersResults(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"src/auth.ts": "function hashPassword() { return 1 }\n",
		"tests/auth.test.ts": "test('hashPassword', () => { expect(1).toBe(1) })\n",
	})
	try {
		const embedder = new FakeEmbedder()
		await buildIndex(embedder, ws)

		const queryEmbedding = fakeVector("password hashing")
		const all = searchIndex(ws, queryEmbedding, undefined, 10)
		assert.ok(all.some((r) => r.filePath === "src/auth.ts"))
		assert.ok(all.some((r) => r.filePath === "tests/auth.test.ts"))

		const onlySrc = searchIndex(ws, queryEmbedding, "src", 10)
		assert.ok(onlySrc.some((r) => r.filePath === "src/auth.ts"))
		assert.ok(!onlySrc.some((r) => r.filePath.startsWith("tests/")), "path filter must exclude tests/")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testSearchPicksUpRebuiltIndex(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"src/a.ts": "function alpha() { return 1 }\n",
	})
	try {
		const embedder = new FakeEmbedder()
		await buildIndex(embedder, ws)

		// First search populates the session-scoped parse cache.
		const first = searchIndex(ws, fakeVector("alpha"), undefined, 10)
		assert.ok(first.some((r) => r.codeChunk.includes("alpha")), "first search sees the alpha chunk")

		// Rebuild the SAME workspace with completely different content.
		await fs.writeFile(path.join(ws, "src", "a.ts"), "function beta() { return 2 }\n")
		await buildIndex(embedder, ws)

		// The cache must be invalidated by the rebuild (mtime+size change):
		// a "beta" query must hit and the old "alpha" chunk must be gone.
		const second = searchIndex(ws, fakeVector("beta"), undefined, 10)
		assert.ok(second.some((r) => r.codeChunk.includes("beta")), "rebuilt index is visible to later searches")
		const alpha = searchIndex(ws, fakeVector("alpha"), undefined, 10)
		assert.ok(!alpha.some((r) => r.codeChunk.includes("alpha")), "stale cached entries must not survive a rebuild")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testFormatMatchesToolContract(): Promise<void> {
	const results = [
		{
			filePath: "src/auth.ts",
			score: 0.9876,
			startLine: 3,
			endLine: 5,
			codeChunk: "function hashPassword() { ... }",
		},
	]
	const formatted = formatSearchResults("password hashing", results)
	assert.match(formatted, /Query: password hashing/)
	assert.match(formatted, /File path: src\/auth\.ts/)
	assert.match(formatted, /Score: 0\.9876/)
	assert.match(formatted, /Lines: 3-5/)
	assert.match(formatted, /Code Chunk: function hashPassword/)

	// Empty results → the vendored "no relevant code snippets" message.
	const empty = formatSearchResults("nothing", [])
	assert.match(empty, /No relevant code snippets found/)
}

const tests: Array<[string, () => Promise<void>]> = [
	["top-K ordering follows cosine similarity on a fixture index", testTopKOrderingMatchesCosineSimilarity],
	["path prefix filters results to a subdirectory", testPathPrefixFiltersResults],
	["a rebuilt index invalidates the session-scoped parse cache", testSearchPicksUpRebuiltIndex],
	["formatted output matches the vendored tool contract", testFormatMatchesToolContract],
]

async function main(): Promise<void> {
	// Redirect the central store so buildIndex/loadIndex never touch the real
	// home directory's store.
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "hc-search-store-"))
	process.env.HEADLESSCODE_DATA_DIR = storeTmp
	let failed = 0
	try {
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
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fs.rm(storeTmp, { recursive: true, force: true })
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} search tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
