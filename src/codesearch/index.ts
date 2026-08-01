/**
 * Persisted codebase-search index: storage + incremental build.
 *
 * Storage: `<workspaceRoot>/.headlesscode/codesearch/index.jsonl`, one JSON
 * line per chunk — { file, startLine, endLine, embedding, hash } (see
 * src/codesearch/types.ts). Plain JSONL, no vector DB: brute-force cosine
 * over every stored vector at query time is the deliberate scope for this
 * project's scale. SCALING LIMIT (documented, accepted): cosine search is
 * O(N) over all chunks in the index, so on very large repos (hundreds of
 * thousands of chunks) queries get slow and the flat file grows. A real
 * vector DB (pgvector/Qdrant) or an HNSW index is the known future path if
 * that ever becomes a problem — it is deliberately NOT solved here.
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
	METADATA_BACKEND_KEY,
	METADATA_MODEL_KEY,
	type Embedder,
	type EmbeddingBackend,
} from "./embedder.js"
import { walkSourceFiles } from "./files.js"
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

/** Absolute path of the index file for a workspace. */
export function indexFilePath(workspaceRoot: string): string {
	return path.join(path.resolve(workspaceRoot), INDEX_RELATIVE_PATH)
}

/** Load all entries from the index file ([] when missing/unreadable). */
export function loadIndex(workspaceRoot: string): IndexEntry[] {
	const file = indexFilePath(workspaceRoot)
	let raw: string
	try {
		raw = fs.readFileSync(file, "utf-8")
	} catch {
		return []
	}
	const entries: IndexEntry[] = []
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (trimmed === "") {
			continue
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
				// Entries written before the Ollama backend existed carry no
				// `backend` field — they were necessarily built with the only
				// backend that existed then (openrouter).
				const backend = parsed.backend === "ollama" ? "ollama" : "openrouter"
				entries.push({ ...parsed, backend } as IndexEntry)
			}
			// Malformed lines are skipped (loose validation, matching the
			// project's read-side idiom — see src/memory/local.ts's readJsonl).
		} catch {
			// skip unparseable line
		}
	}
	return entries
}

/** Absolute path of the index METADATA file (sibling of index.jsonl). */
export function indexMetadataFilePath(workspaceRoot: string): string {
	return indexFilePath(workspaceRoot) + ".meta.json"
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
		return undefined
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const backend = parsed[METADATA_BACKEND_KEY] === "ollama" ? "ollama" : "openrouter"
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
	}

	// Deterministic order for the on-disk file (stable across rebuilds).
	newEntries.sort((a, b) => (a.file === b.file ? a.startLine - b.startLine : a.file.localeCompare(b.file)))

	const file = indexFilePath(root)
	await fsp.mkdir(path.dirname(file), { recursive: true })
	const lines = newEntries.map((e) => JSON.stringify(e)).join("\n") + "\n"
	await fsp.writeFile(file, lines, "utf-8")
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
