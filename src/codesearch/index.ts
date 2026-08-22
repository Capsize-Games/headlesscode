/**
 * Persisted codebase-search index: storage + incremental build.
 *
 * Storage: the CENTRAL per-project data store's
 * `codesearch/index.jsonl` (see src/project-store.ts) — one JSON line per
 * chunk — { file, startLine, endLine, embedding, hash } (see
 * src/codesearch/types.ts). Plain JSONL, no vector DB: brute-force cosine
 * over every stored vector at query time is the deliberate scope for this
 * project's scale. SCALING LIMIT (documented, accepted): cosine search is
 * O(N) over all chunks in the index, so on very large repos (hundreds of
 * thousands of chunks) queries get slow. A real vector DB (pgvector/Qdrant)
 * or an HNSW index is the known future path if that ever becomes a problem
 * — it is deliberately NOT solved here.
 *
 * The JSONL itself is read and written STREAMING (bounded blocks / batches),
 * never as one monolithic string: a 2560-dim embedding is ~21KB serialized,
 * so a repo like airunner (37k chunks) produces a ~780MB index that far
 * exceeds V8's ~1GB max string length if materialized whole (see the
 * `Invalid string length` crash this guards against). Stored embedding
 * floats are rounded to 6 decimal places (float32-grade precision — cosine
 * similarity is unaffected, and it cuts each vector's serialized size by
 * ~60%).
 *
 * Build semantics: the content hash lets a re-index skip unchanged chunks
 * instead of re-embedding the whole repo every time (the cost-control
 * mechanism). A chunk is re-embedded only when its content changed, is new,
 * or was previously indexed with a DIFFERENT backend or model (a switch
 * would otherwise leave a mixed-dimension index that compares apples to
 * oranges — local `qwen3-embedding:8b` = 4096 dims vs cloud
 * `qwen/qwen3-embedding-4b` = 2560 dims). Chunks whose file was deleted are
 * dropped from the new index.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { chunkFile, type Chunk } from "./chunk.js"
import {
	DEFAULT_EMBEDDING_BACKEND,
	EMBEDDING_BACKENDS,
	METADATA_BACKEND_KEY,
	METADATA_MODEL_KEY,
	type Embedder,
	type EmbeddingBackend,
} from "./embedder.js"
import { walkSourceFiles } from "./files.js"
import { resolveProjectDataDir } from "../project-store.js"
import { INDEX_RELATIVE_PATH, type IndexEntry } from "./types.js"

export interface IndexBuildResult {
	/** Total files scanned (source files found by the walker). */
	filesScanned: number
	/** Chunks embedded in this build. */
	chunksEmbedded: number
	/** Chunks skipped because their content hash was unchanged (and model same). */
	chunksSkipped: number
	/** Chunks dropped because their file disappeared. */
	chunksRemoved: number
	/** Total chunks in the written index. */
	totalChunks: number
	/** Real prompt tokens consumed by embedding (for cost reporting). */
	promptTokens: number
	/** Model used for embedding. */
	model: string
	/** Backend used for embedding (openrouter | ollama). */
	backend: EmbeddingBackend
}

/** Absolute path of the index file for a workspace (central project store). */
export function indexFilePath(workspaceRoot: string): string {
	return path.join(resolveProjectDataDir(workspaceRoot), INDEX_RELATIVE_PATH)
}

/** Legacy workspace-relative index path (pre-central-store), for grace reads. */
export function legacyIndexFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".headlesscode", INDEX_RELATIVE_PATH)
}

/**
 * Size of each read block when loading the index. A bounded block keeps peak
 * memory flat regardless of index size; reading the whole file as one string
 * is impossible above V8's ~1GB string cap anyway.
 */
const LOAD_BLOCK_SIZE = 64 * 1024 * 1024

/** Parse one JSONL line into an IndexEntry; undefined for blank/malformed lines. */
function parseIndexLine(line: string): IndexEntry | undefined {
	const trimmed = line.trim()
	if (trimmed === "") {
		return undefined
	}
	try {
		const parsed = JSON.parse(trimmed) as Partial<IndexEntry>
		if (
			typeof parsed.file === "string" &&
			typeof parsed.startLine === "number" &&
			typeof parsed.endLine === "number" &&
			Array.isArray(parsed.embedding) &&
			parsed.embedding.every((v) => typeof v === "number") &&
			typeof parsed.hash === "string"
		) {
			// Entries written before the Ollama/AIRunner backends existed
			// carry no `backend` field — they were necessarily built with the
			// only backend that existed then (openrouter). Any other backend
			// value passes through as-is (validated against EMBEDDING_BACKENDS).
			const backend =
				typeof parsed.backend === "string" && (EMBEDDING_BACKENDS as readonly string[]).includes(parsed.backend)
					? (parsed.backend as EmbeddingBackend)
					: "openrouter"
			return { ...parsed, backend } as IndexEntry
		}
		// Malformed lines are skipped (loose validation, matching the
		// project's read-side idiom — see src/memory/local.ts's readJsonl).
	} catch {
		// skip unparseable line
	}
	return undefined
}

/**
 * Read a JSONL file's entries in bounded blocks ([] when missing/unreadable).
 *
 * `blockSize` is a test seam — production uses LOAD_BLOCK_SIZE. A line is
 * never split across blocks (partial content is carried in a pending buffer),
 * so lines arbitrarily larger than the block size still load correctly. One
 * accepted imperfection: a multi-byte UTF-8 char straddling a block boundary
 * decodes as a replacement char and the line is dropped by the loose
 * validation above — irrelevant in practice because index lines are almost
 * entirely ASCII (only file paths are strings).
 */
export function readJsonlEntries(file: string, blockSize: number = LOAD_BLOCK_SIZE): IndexEntry[] {
	let fd: number
	try {
		fd = fs.openSync(file, "r")
	} catch {
		return []
	}
	const entries: IndexEntry[] = []
	const buffer = Buffer.alloc(blockSize)
	let pending = ""
	let offset = 0
	try {
		for (;;) {
			const bytesRead = fs.readSync(fd, buffer, 0, blockSize, offset)
			if (bytesRead === 0) {
				break
			}
			offset += bytesRead
			pending += buffer.subarray(0, bytesRead).toString("utf-8")
			let nl = pending.indexOf("\n")
			while (nl !== -1) {
				const entry = parseIndexLine(pending.slice(0, nl))
				if (entry) {
					entries.push(entry)
				}
				pending = pending.slice(nl + 1)
				nl = pending.indexOf("\n")
			}
		}
		// Final line when the file doesn't end in a newline.
		if (pending.trim() !== "") {
			const entry = parseIndexLine(pending)
			if (entry) {
				entries.push(entry)
			}
		}
	} finally {
		fs.closeSync(fd)
	}
	return entries
}

/** Load all entries from the index file ([] when missing/unreadable). */
export function loadIndex(workspaceRoot: string): IndexEntry[] {
	const central = indexFilePath(workspaceRoot)
	if (!fs.existsSync(central)) {
		// Pre-migration grace: a legacy workspace-relative index is still
		// READABLE (though not writable) until the real-machine migration
		// moves it into the central store.
		const legacy = legacyIndexFilePath(workspaceRoot)
		if (fs.existsSync(legacy)) {
			return readJsonlEntries(legacy)
		}
	}
	return readJsonlEntries(central)
}

/** Absolute path of the index METADATA file (sibling of index.jsonl). */
export function indexMetadataFilePath(workspaceRoot: string): string {
	return indexFilePath(workspaceRoot) + ".meta.json"
}

/** Legacy workspace-relative index metadata path (pre-central-store grace). */
export function legacyIndexMetadataFilePath(workspaceRoot: string): string {
	return legacyIndexFilePath(workspaceRoot) + ".meta.json"
}

/** The backend + model an on-disk index was built with. */
export interface IndexMetadata {
	/** Embedding backend that built the index. */
	backend: EmbeddingBackend
	/** Embedding model that built the index. */
	model: string
}

/** Load the metadata sibling file; undefined when missing/unreadable/malformed. */
export function loadIndexMetadata(workspaceRoot: string): IndexMetadata | undefined {
	let raw: string
	try {
		raw = fs.readFileSync(indexMetadataFilePath(workspaceRoot), "utf-8")
	} catch {
		// Pre-migration grace: read the legacy sibling when the central one is
		// absent (see loadIndex).
		try {
			raw = fs.readFileSync(legacyIndexMetadataFilePath(workspaceRoot), "utf-8")
		} catch {
			return undefined
		}
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		// Generic 3-way mapping driven off EMBEDDING_BACKENDS, NOT a hardcoded
		// binary (ollama ?: openrouter) ternary — an index built with the
		// airunner backend would otherwise be silently misread as openrouter.
		const rawBackend = parsed[METADATA_BACKEND_KEY]
		const backend =
			typeof rawBackend === "string" && (EMBEDDING_BACKENDS as readonly string[]).includes(rawBackend)
				? (rawBackend as EmbeddingBackend)
				: "openrouter"
		const model = typeof parsed[METADATA_MODEL_KEY] === "string" ? parsed[METADATA_MODEL_KEY] : undefined
		if (model === undefined) {
			return undefined
		}
		return { backend, model }
	} catch {
		return undefined
	}
}

/** Validate a new batch of embeddings before it enters the index. */
function checkEmbeddingDimensions(batchEmbeddings: number[][], expectedDim: number | undefined, batchStart: number): void {
	const first = batchEmbeddings[0]
	if (!first) {
		return
	}
	const dim = first.length
	if (dim === 0) {
		throw new Error(
			`codebase index: embedder returned a zero-dimensional embedding for chunk ${batchStart + 1} — the model produced no usable vector`,
		)
	}
	if (expectedDim !== undefined && dim !== expectedDim) {
		throw new Error(
			`codebase index: embedder returned a ${dim}-dim vector where a ${expectedDim}-dim vector was expected (chunk ${batchStart + 1}) — ` +
				`the embedding model changed dimension mid-build?`,
		)
	}
	for (let j = 1; j < batchEmbeddings.length; j++) {
		if (batchEmbeddings[j].length !== dim) {
			throw new Error(
				`codebase index: embedder returned vectors of mixed dimensions (${dim} and ${batchEmbeddings[j].length}) in one batch — refusing to write a corrupt index`,
			)
		}
	}
}

/** sha256 hex of a chunk's text (the dedupe key). */
export function chunkHash(content: string): string {
	return crypto.createHash("sha256").update(content, "utf-8").digest("hex")
}

/** Group index entries by (file, startLine) for lookup during incremental build. */
function indexLookup(entries: IndexEntry[]): Map<string, IndexEntry> {
	const map = new Map<string, IndexEntry>()
	for (const entry of entries) {
		map.set(`${entry.file}:${entry.startLine}`, entry)
	}
	return map
}

/**
 * Significant decimal places stored per embedding float. Full double
 * precision is wasted here: embeddings are compared by cosine similarity,
 * which tolerates float32-grade precision (~7 sig figs) with no measurable
 * quality change, and each stored float costs ~1 char per significant digit
 * in the JSONL. Rounding to 6 places shrinks a 2560-dim vector's serialized
 * form by ~60% (53KB → 21KB), which is the difference between a ~780MB and
 * a ~1.9GB index on a repo the size of airunner.
 */
export const EMBEDDING_FLOAT_DECIMALS = 6

/** Round an entry's embedding for serialization (does not mutate the entry). */
function serializeEntry(entry: IndexEntry): IndexEntry {
	if (entry.embedding.every((v) => Math.abs(v * 10 ** EMBEDDING_FLOAT_DECIMALS - Math.round(v * 10 ** EMBEDDING_FLOAT_DECIMALS)) < 1e-9)) {
		// Already rounded to the storage precision (reused unchanged entries
		// from an earlier build) — skip the copy.
		return entry
	}
	const scale = 10 ** EMBEDDING_FLOAT_DECIMALS
	const embedding = entry.embedding.map((v) => Math.round(v * scale) / scale)
	return { ...entry, embedding }
}

/** How many lines to buffer before flushing to the index file's write stream. */
const WRITE_BATCH_SIZE = 512

/**
 * Write index entries to `file` as JSONL, streaming in bounded batches.
 *
 * Building one giant `entries.map(JSON.stringify).join("\n")` string crashes
 * with `Invalid string length` once the serialized index exceeds V8's ~1GB
 * string cap (reached at ~37k chunks × 2560-dim embeddings — see the header
 * comment). Each flushed batch is at most ~11MB (512 × ~21KB), so any repo
 * size works.
 */
export async function writeIndexEntries(file: string, entries: IndexEntry[]): Promise<void> {
	const stream = fs.createWriteStream(file, { encoding: "utf-8" })
	const writeError = new Promise<never>((_, reject) => {
		stream.once("error", reject)
	})
	try {
		for (let i = 0; i < entries.length; i += WRITE_BATCH_SIZE) {
			const batch = entries.slice(i, i + WRITE_BATCH_SIZE)
			const lines = batch.map((e) => JSON.stringify(serializeEntry(e))).join("\n") + "\n"
			if (!stream.write(lines)) {
				// Backpressure: wait for the stream to drain before writing more.
				await Promise.race([
					new Promise<void>((resolve) => stream.once("drain", resolve)),
					writeError,
				])
			}
		}
	} finally {
		await new Promise<void>((resolve) => stream.end(resolve))
		// Surface a write error (e.g. ENOSPC) instead of silently truncating.
		await Promise.race([
			new Promise<void>((resolve) => stream.once("close", resolve)),
			writeError,
		])
	}
}

/**
 * Build (or incrementally refresh) the codebase index for a workspace.
 *
 * @param embedder  embedder to use for changed/new chunks
 * @param workspaceRoot  workspace root
 * @param onProgress  optional progress callback (files scanned so far)
 */
export async function buildIndex(
	embedder: Embedder,
	workspaceRoot: string,
	onProgress?: (scanned: number, total: number) => void,
	backend: EmbeddingBackend = DEFAULT_EMBEDDING_BACKEND,
	onEmbedProgress?: (embedded: number, total: number) => void,
): Promise<IndexBuildResult> {
	const root = path.resolve(workspaceRoot)
	const files = await walkSourceFiles(root)

	const oldEntries = loadIndex(root)
	const oldByKey = indexLookup(oldEntries)

	const newEntries: IndexEntry[] = []
	const chunksToEmbed: Array<{ chunk: Chunk; hash: string }> = []
	let chunksSkipped = 0
	let chunksRemoved = 0
	// Dimension of the vectors this build produces — checked once per batch
	// so a mid-build dimension change can never silently write a corrupt
	// (mixed-dimension) index.
	let embeddingDim: number | undefined

	// Track which old (file:startLine) keys survive so we can drop entries for
	// deleted/rewritten files.
	const survivingKeys = new Set<string>()

	for (let fi = 0; fi < files.length; fi++) {
		const file = files[fi]
		onProgress?.(fi + 1, files.length)
		const chunks = chunkFile(file.abs, file.rel)
		for (const chunk of chunks) {
			if (chunk.content.trim() === "") {
				// Whitespace-only chunks produce no useful vector and are
				// rejected outright by embedding providers (live crash
				// 2026-08-16: OpenRouter HTTP 400 "too_small" for an empty
				// string at input[90]). Skip entirely — and deliberately do
				// NOT add the key to survivingKeys, so a stale entry for it
				// (from an older build that didn't filter) is dropped on write.
				continue
			}
			const hash = chunkHash(chunk.content)
			const key = `${chunk.file}:${chunk.startLine}`
			survivingKeys.add(key)
			const old = oldByKey.get(key)
			if (old && old.hash === hash && old.embedding.length > 0 && (old.backend ?? "openrouter") === backend) {
				// Unchanged chunk, same content hash AND same backend → keep the
				// stored vector (backends produce different-dimension vectors, so
				// a stored vector from the other backend is never reusable).
				newEntries.push(old)
				chunksSkipped++
			} else {
				chunksToEmbed.push({ chunk, hash })
			}
		}
	}

	// Drop entries whose file:startLine no longer exists (deleted/rewritten).
	for (const entry of oldEntries) {
		if (!survivingKeys.has(`${entry.file}:${entry.startLine}`)) {
			chunksRemoved++
		}
	}

	// Embed all changed/new chunks in batches.
	let promptTokens = 0
	for (let i = 0; i < chunksToEmbed.length; ) {
		const batch = chunksToEmbed.slice(i, i + 128)
		const result = await embedder.embedBatch(batch.map((b) => b.chunk.content))
		promptTokens += result.promptTokens
		if (result.embeddings.length !== batch.length) {
			throw new Error(
				`codebase index: embedder returned ${result.embeddings.length} embeddings for ${batch.length} chunks`,
			)
		}
		checkEmbeddingDimensions(result.embeddings, embeddingDim, i)
		if (embeddingDim === undefined) {
			embeddingDim = result.embeddings[0]?.length
		}
		for (let j = 0; j < batch.length; j++) {
			newEntries.push({
				file: batch[j].chunk.file,
				startLine: batch[j].chunk.startLine,
				endLine: batch[j].chunk.endLine,
				embedding: result.embeddings[j],
				hash: batch[j].hash,
				backend,
			})
		}
		i += batch.length
		onEmbedProgress?.(Math.min(i, chunksToEmbed.length), chunksToEmbed.length)
	}

	// Deterministic order for the on-disk file (stable across rebuilds).
	newEntries.sort((a, b) => (a.file === b.file ? a.startLine - b.startLine : a.file.localeCompare(b.file)))

	const file = indexFilePath(root)
	await fsp.mkdir(path.dirname(file), { recursive: true })
	await writeIndexEntries(file, newEntries)
	// Sibling metadata records which backend/model built this index, so a
	// query can refuse a backend mismatch with a clear error instead of
	// comparing different-dimension vectors (see loadIndexMetadata).
	await fsp.writeFile(
		indexMetadataFilePath(root),
		JSON.stringify({ [METADATA_BACKEND_KEY]: backend, [METADATA_MODEL_KEY]: embedder.model }, null, 2) + "\n",
		"utf-8",
	)

	return {
		filesScanned: files.length,
		chunksEmbedded: chunksToEmbed.length,
		chunksSkipped,
		chunksRemoved,
		totalChunks: newEntries.length,
		promptTokens,
		model: embedder.model,
		backend,
	}
}
