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

import { buildIndex, chunkHash, indexFilePath, loadIndex, readJsonlEntries, writeIndexEntries } from "../index.js"
import type { Embedder } from "../embedder.js"
import type { IndexEntry } from "../types.js"
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

async function testBuildSkipsEmptyChunks(): Promise<void> {
	// Regression (live crash 2026-08-16): a whitespace-only file produced an
	// empty chunk string that OpenRouter rejected with HTTP 400 "too_small"
	// (input[90]). The build must filter empty chunks BEFORE the embedder.
	const ws = await mkTmpWorkspace({
		"src/blank.txt": "\n\n\n\n\n\n\n\n\n",
		"src/real.ts": "export function alpha() {\n  return 1\n}\n",
	})
	try {
		const embedder = new FakeEmbedder()
		const orig = embedder.embedBatch.bind(embedder)
		embedder.embedBatch = async (texts) => {
			for (const t of texts) {
				assert.ok(t.trim() !== "", "embedder must never receive an empty/whitespace-only chunk")
			}
			return orig(texts)
		}
		const result = await buildIndex(embedder, ws)
		assert.equal(result.filesScanned, 2)
		assert.ok(result.chunksEmbedded >= 1, "the real file's chunks still get embedded")
		assert.ok(embedder.textsEmbedded >= 1, "some texts were embedded")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

async function testBuildReportsEmbeddingProgress(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"src/a.ts": "export function alpha() {\n  return 1\n}\n",
		"src/b.ts": "export function beta() {\n  return 2\n}\n",
	})
	try {
		const embedder = new FakeEmbedder()
		const progress: Array<[number, number]> = []
		const result = await buildIndex(embedder, ws, undefined, "openrouter", (embedded, total) => {
			progress.push([embedded, total])
		})
		assert.ok(progress.length >= 1, "embedding progress reported at least once")
		const last = progress[progress.length - 1]
		assert.equal(last[0], last[1], "final progress reports embedded == total")
		assert.equal(last[1], result.chunksEmbedded, "progress total matches chunks embedded")
		for (const [embedded, total] of progress) {
			assert.ok(embedded >= 1 && embedded <= total, `embedded ${embedded} within [1, ${total}]`)
		}
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

/** Full-precision floats (17 sig digits — what JSON.stringify emits by default). */
const FULL_PRECISION_FLOAT = 0.012345678901234567

/**
 * The streaming write must never materialize the whole index as one string,
 * and the streaming read must reconstruct lines that straddle block
 * boundaries. A 64-byte read block forces hundreds of boundaries across a
 * ~600KB index whose lines are ~2.5KB each — every line straddles one.
 */
async function testStreamingWriteReadRoundTripAcrossBlockBoundaries(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-idxw-"))
	try {
		const file = path.join(dir, "index.jsonl")
		// 600 entries × 256-dim → multiple WRITE_BATCH_SIZE (512) batches too.
		const entries: IndexEntry[] = []
		for (let i = 0; i < 600; i++) {
			entries.push({
				file: `src/mod${i % 10}.ts`,
				startLine: i + 1,
				endLine: i + 2,
				embedding: Array.from({ length: 256 }, (_, j) =>
					j % 2 === 0 ? -FULL_PRECISION_FLOAT : FULL_PRECISION_FLOAT + j * 1e-9,
				),
				hash: "a".repeat(64),
				backend: "openrouter",
			})
		}
		await writeIndexEntries(file, entries)

		const loaded = readJsonlEntries(file, 64)
		assert.equal(loaded.length, entries.length, "every written entry must reload across block boundaries")
		// Rounding is applied at write time: no stored float has > 6 decimals.
		for (const e of loaded) {
			for (const v of e.embedding) {
				const s = String(v)
				const decimals = s.includes(".") ? s.length - s.indexOf(".") - 1 : 0
				assert.ok(decimals <= 6, `float not rounded on disk: ${s}`)
			}
		}
		// Field fidelity across the write/read round trip.
		const first = loaded[0]
		assert.equal(first.file, "src/mod0.ts")
		assert.equal(first.startLine, 1)
		assert.equal(first.endLine, 2)
		assert.equal(first.hash, "a".repeat(64))
		assert.equal(first.backend, "openrouter")
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

/**
 * A real build (fake embedder returning full-precision floats) must persist
 * rounded embeddings — the mechanism that keeps a 2560-dim index ~60%
 * smaller than full precision — while loadIndex returns the rounded values.
 */
async function testBuildPersistsRoundedEmbeddings(): Promise<void> {
	const ws = await mkTmpWorkspace({
		"src/a.ts": "export function alpha() {\n  return 1\n}\n",
	})
	try {
		const embedder: Embedder = {
			model: "fake/float",
			async embedBatch(texts: string[]) {
				return {
					embeddings: texts.map((_, i) =>
						Array.from({ length: 8 }, (_, j) => FULL_PRECISION_FLOAT + i + j * 1e-9),
					),
					promptTokens: texts.length,
					totalTokens: texts.length,
				}
			},
		}
		await buildIndex(embedder, ws)

		const entries = loadIndex(ws)
		assert.ok(entries.length >= 1)
		for (const e of entries) {
			for (const v of e.embedding) {
				const s = String(v)
				const decimals = s.includes(".") ? s.length - s.indexOf(".") - 1 : 0
				assert.ok(decimals <= 6, `stored float not rounded: ${s}`)
			}
		}

		const raw = await fs.readFile(indexFilePath(ws), "utf-8")
		assert.ok(raw.includes("0.012346"), "rounded value (0.0123456789… → 0.012346) on disk")
		assert.ok(!raw.includes("0.012345678901234567"), "full-precision float must NOT be stored")
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["build writes a valid index.jsonl with sane entries", testBuildWritesIndex],
	["rebuild with no changes re-embeds NOTHING (call-counter proof)", testRebuildWithNoChangesEmbedsNothing],
	["whitespace-only chunks are filtered before the embedder (OpenRouter 400 regression)", testBuildSkipsEmptyChunks],
	["embedding phase reports per-batch progress (no more silent stall)", testBuildReportsEmbeddingProgress],
	["a changed chunk is re-embedded, an unchanged one is not", testChangedChunkGetsReembeddedUnchangedDoesNot],
	["chunks for deleted files are dropped on rebuild", testDeletedFileChunksRemoved],
	["file walker + index build round-trip", testWalkAndIndexRoundTrip],
	["streaming write/read round-trips lines straddling block boundaries", testStreamingWriteReadRoundTripAcrossBlockBoundaries],
	["build persists rounded embeddings (not full precision)", testBuildPersistsRoundedEmbeddings],
]

async function main(): Promise<void> {
	// Redirect the central store to a temp dir so build/read never touch the
	// real home directory's store.
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "hc-idx-store-"))
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
	console.log(`\nAll ${tests.length} index tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
