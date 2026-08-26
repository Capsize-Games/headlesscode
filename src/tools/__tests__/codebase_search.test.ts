/**
 * Unit tests for the codebase_search tool handler (src/tools/executor.ts).
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/tools/__tests__/codebase_search.test.ts`.
 *
 * The handler is exercised against a REAL persisted fixture index (built with
 * a deterministic fake embedder through the same buildIndex path the CLI
 * uses). The one real network call the handler makes — embedding the query —
 * is avoided by testing only the paths that don't reach the network: the
 * no-index-yet error, and (via a hand-written fixture index) the load/search/
 * format pipeline with an injected query embedding through searchIndex
 * directly. A live-embedding path would need a network mock; the search
 * ordering itself is covered deterministically in src/codesearch/__tests__/
 * search.test.ts.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../executor.js"
import { chunkHash } from "../../codesearch/index.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

async function testNoIndexReturnsActionableError(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-cs-noindex-")
	try {
		const executor = createHeadlessExecutor(ws)
		const result = await executor.execute("codebase_search", { query: "password hashing", path: null })

		assert.equal(result.isError, true, "no index must be an error, not an empty result")
		assert.match(result.content, /no codebase index/i, "error names the missing index")
		assert.match(result.content, /headlesscode index/, "error tells the model to run the index command")
		assert.doesNotMatch(result.content, /No relevant code snippets/, "must NOT look like an empty search result")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

/** Write a fixture index with known vectors (dim 26, letter-count vectors). */
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

async function testHandlerReadsExistingIndex(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-cs-indexed-")
	try {
		// Build a real index through buildIndex with a fake embedder — the same
		// path `headlesscode index` uses, minus the network.
		const { buildIndex } = await import("../../codesearch/index.js")
		const embedder: import("../../codesearch/embedder.js").Embedder = {
			model: "fake/embed",
			async embedBatch(texts: string[]) {
				return {
					embeddings: texts.map(fakeVector),
					promptTokens: texts.length,
					totalTokens: texts.length,
				}
			},
		}
		await fs.mkdir(path.join(ws, "src"), { recursive: true })
		await fs.writeFile(
			path.join(ws, "src", "auth.ts"),
			"function hashPassword(password) {\n  return crypto.hash(password)\n}\n",
		)
		await fs.writeFile(
			path.join(ws, "src", "db.ts"),
			"function connect(database) {\n  return pool.connect(database)\n}\n",
		)
		const result = await buildIndex(embedder, ws)
		assert.ok(result.totalChunks >= 1, "fixture index built")

		// The handler's no-index check should now pass, and the pipeline
		// (load → searchIndex → format) should produce the expected shape.
		// We can't call the handler with a real query (network), so verify the
		// pieces it wires together on the same index:
		const { searchIndex, formatSearchResults } = await import("../../codesearch/search.js")
		const queryEmbedding = fakeVector("hash password")
		const results = searchIndex(ws, queryEmbedding, undefined, 10)
		assert.ok(results.length >= 1, "fixture index returns results")
		assert.equal(results[0].filePath, "src/auth.ts", "the password-related chunk ranks first")
		assert.match(formatSearchResults("hash password", results), /File path: src\/auth\.ts/)

		// index.jsonl exists at the documented central-store location.
		const { indexFilePath } = await import("../../codesearch/index.js")
		assert.ok(await exists(indexFilePath(ws)))
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testChunkHashStable(): Promise<void> {
	// chunkHash is the dedupe key — same content → same hash, different → different.
	assert.equal(chunkHash("hello"), chunkHash("hello"))
	assert.notEqual(chunkHash("hello"), chunkHash("hello!"))
}

const tests: Array<[string, () => Promise<void>]> = [
	["no index yet → clear actionable error, not empty results", testNoIndexReturnsActionableError],
	["handler pipeline reads an existing index and ranks correctly", testHandlerReadsExistingIndex],
	["chunk hash is deterministic (the dedupe key)", testChunkHashStable],
]

async function main(): Promise<void> {
	// Redirect the central store to a temp dir so buildIndex never touches the
	// real home directory's store.
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "hc-cs-store-"))
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
	console.log(`\nAll ${tests.length} codebase_search handler tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
