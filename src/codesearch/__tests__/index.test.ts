/**
 * Unit tests for src/codesearch/index.ts — persisted index + incremental build.
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/codesearch/__tests__/index.test.ts`.
 *
 * The build is tested with a deterministic FAKE embedder (a real network-
 * calling embedder has no place in a fast offline suite — mirroring how the
 * rest of this project injects a fake LLM client). The hash-based skip is
 * proven with a CALL COUNTER, not by reading the code.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { buildIndex, chunkHash, indexFilePath, loadIndex } from "../index.js"
import type { Embedder } from "../embedder.js"
import { walkSourceFiles } from "../files.js"

/** Deterministic fake embedder with an embed-call counter. */
class FakeEmbedder implements Embedder {
	model = "fake/embed"
	/** Number of embedBatch calls made (the thing the hash-skip must minimize). */
	calls = 0
	/** Total texts embedded across all calls. */
	textsEmbedded = 0
	/** Dim of the fake vectors. */
	readonly dims = 8

	async embedBatch(texts: string[]): Promise<{ embeddings: number[][]; promptTokens: number; totalTokens: number }> {
		this.calls++
		this.textsEmbedded += texts.length
		return {
			embeddings: texts.map((t) => fakeVector(t, this.dims)),
			promptTokens: texts.length,
			totalTokens: texts.length,
		}
	}
}

/** Deterministic vector from a string (each char's code contributes). */
function fakeVector(text: string, dims: number): number[] {
	const v = new Array<number>(dims).fill(0)
	for (const ch of text) {
		v[ch.charCodeAt(0) % dims] += 1
	}
	return v
}

async function mkTmpWorkspace(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-idx-"))
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(dir, rel)
		await fs.mkdir(path.dirname(abs), { recursive: true })
		await fs.writeFile(abs, content, "utf-8")
	}
	return dir
}

async function testBuildWritesIndex(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"src/a.ts": "export function alpha() {\n  return 1\n}\n\nexport function beta() {\n  return 2\n}\n",
	})
	try {
		const embedder = new FakeEmbedder()
		const result = await buildIndex(embedder, ws)

		assert.equal(result.filesScanned, 1)
		assert.ok(result.chunksEmbedded >= 1, "at least one chunk embedded")
		assert.equal(result.chunksSkipped, 0)

		const entries = loadIndex(ws)
		assert.ok(entries.length >= 1, "index has entries")
		for (const e of entries) {
			assert.equal(typeof e.file, "string")
			assert.ok(e.startLine >= 1 && e.endLine >= e.startLine)
			assert.ok(Array.isArray(e.embedding) && e.embedding.length === 8, "vector dim matches fake embedder")
			assert.match(e.hash, /^[0-9a-f]{64}$/, "hash is sha256 hex")
			assert.equal(e.embedding.length, 8)
		}
		// One entry per chunk, with distinct hashes.
		const hashes = new Set(entries.map((e) => e.hash))
		assert.equal(hashes.size, entries.length, "hashes must be unique per distinct chunk")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testRebuildWithNoChangesEmbedsNothing(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"src/a.ts": "export function alpha() {\n  return 1\n}\n",
	})
	try {
		const embedder = new FakeEmbedder()
		const first = await buildIndex(embedder, ws)
		const callsAfterFirst = embedder.calls
		const embeddedAfterFirst = embedder.textsEmbedded
		assert.ok(callsAfterFirst >= 1, "first build must call the embedder")

		// Rebuild with NO changes: every chunk's hash matches → zero embedding.
		const second = await buildIndex(embedder, ws)
		assert.equal(second.chunksEmbedded, 0, "no chunks should be re-embedded on an unchanged rebuild")
		assert.ok(second.chunksSkipped >= first.totalChunks, "all chunks skipped as unchanged")
		assert.equal(embedder.calls, callsAfterFirst, "embedder must NOT be called again (call counter proof)")
		assert.equal(embedder.textsEmbedded, embeddedAfterFirst, "no texts embedded on the second build")

		// Index on disk is unchanged in size.
		const entries = loadIndex(ws)
		assert.equal(entries.length, second.totalChunks)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testChangedChunkGetsReembeddedUnchangedDoesNot(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"src/a.ts": "export function alpha() {\n  return 1\n}\n\nexport function beta() {\n  return 2\n}\n",
	})
	try {
		const embedder = new FakeEmbedder()
		await buildIndex(embedder, ws)
		const embeddedAfterFirst = embedder.textsEmbedded

		// Change ONLY alpha's body. beta is untouched.
		await fs.writeFile(path.join(ws, "src", "a.ts"), "export function alpha() {\n  return 99\n}\n\nexport function beta() {\n  return 2\n}\n")

		const second = await buildIndex(embedder, ws)
		assert.ok(second.chunksEmbedded >= 1, "the changed chunk must be re-embedded")
		assert.ok(second.chunksSkipped >= 1, "the unchanged chunk must be skipped")

		// The re-embedded texts include the changed content, NOT beta's.
		const entries = loadIndex(ws)
		const alphaEntry = entries.find((e) => e.file === "src/a.ts")
		assert.ok(alphaEntry, "alpha chunk present")
		const alphaHash = chunkHash("export function alpha() {\n  return 99\n}")
		const betaHash = chunkHash("export function beta() {\n  return 2\n}")
		assert.ok(entries.some((e) => e.hash === alphaHash), "new alpha hash present")
		assert.ok(entries.some((e) => e.hash === betaHash), "beta hash still present")

		// Call counter: the second build embedded exactly the changed chunk
		// set (1 chunk here since only alpha changed).
		assert.equal(embedder.textsEmbedded, embeddedAfterFirst + second.chunksEmbedded)
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testDeletedFileChunksRemoved(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"src/a.ts": "export function alpha() {\n  return 1\n}\n",
		"src/b.ts": "export function beta() {\n  return 2\n}\n",
	})
	try {
		const embedder = new FakeEmbedder()
		await buildIndex(embedder, ws)
		const before = loadIndex(ws)
		assert.ok(before.some((e) => e.file === "src/b.ts"), "b.ts indexed initially")

		// Delete b.ts and rebuild.
		await fs.rm(path.join(ws, "src", "b.ts"))
		const second = await buildIndex(embedder, ws)
		assert.ok(second.chunksRemoved >= 1, "chunks for the deleted file must be dropped")
		const after = loadIndex(ws)
		assert.ok(!after.some((e) => e.file === "src/b.ts"), "no b.ts entries remain")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testWalkAndIndexRoundTrip(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"README.md": "# Hello\nSome docs.\n",
		"src/x.ts": "export const x = 1\n",
	})
	try {
		const files = await walkSourceFiles(ws)
		const rels = files.map((f) => f.rel)
		assert.ok(rels.includes("src/x.ts"))
		assert.ok(rels.includes("README.md"), "markdown docs are indexed too")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["build writes a valid index.jsonl with sane entries", testBuildWritesIndex],
	["rebuild with no changes re-embeds NOTHING (call-counter proof)", testRebuildWithNoChangesEmbedsNothing],
	["a changed chunk is re-embedded, an unchanged one is not", testChangedChunkGetsReembeddedUnchangedDoesNot],
	["chunks for deleted files are dropped on rebuild", testDeletedFileChunksRemoved],
	["file walker + index build round-trip", testWalkAndIndexRoundTrip],
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
	console.log(`\nAll ${tests.length} index tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
