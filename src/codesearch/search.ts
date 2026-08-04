/**
 * Query-time search over the persisted codebase index.
 *
 * Embed the query (one call), brute-force cosine against every stored chunk,
 * return the top-K as file:startLine-endLine citations + a snippet — matching
 * the vendored codebase_search tool's expected result shape (see
 * src/vendor/zoo-code/src/core/tools/CodebaseSearchTool.ts and the native
 * tool's description).
 *
 * The index stores only { file, startLine, endLine, embedding, hash } — the
 * chunk TEXT is deliberately NOT duplicated into the index (it would roughly
 * double the file). The snippet is re-read from the file at query time from
 * the cited line range; if the file is gone or unreadable the citation is
 * still returned with an empty snippet.
 *
 * SCALING LIMIT (documented, accepted): brute-force cosine is O(N) per query
 * over all chunks in the index. Fine for this project's scale; a vector DB or
 * ANN index is the known future path for very large repos (see
 * src/codesearch/index.ts).
 *
 * LOAD CACHING: parsing the index JSONL is the dominant per-query cost — a
 * 37k-chunk index is ~860MB of JSONL that takes ~5s to stream-parse into
 * ~1.4GB of JS objects. A codebase_search query therefore pays that once per
 * SESSION (not per call): the parsed entries are cached keyed by
 * (path, mtimeMs, size), so a rebuild elsewhere invalidates the cache
 * automatically and repeated queries are ~instant.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { cosineSimilarity } from "./embedder.js"
import { indexFilePath, loadIndex } from "./index.js"
import { DEFAULT_TOP_K, type IndexEntry } from "./types.js"

/** One search result, matching the vendored CodebaseSearchTool's payload shape. */
export interface SearchResult {
	filePath: string
	score: number
	startLine: number
	endLine: number
	codeChunk: string
}

/** Best-effort read of the cited line range from the file on disk. */
function readSnippet(workspaceRoot: string, rel: string, startLine: number, endLine: number): string {
	try {
		const abs = path.join(path.resolve(workspaceRoot), rel)
		const content = fs.readFileSync(abs, "utf-8")
		const lines = content.split(/\r?\n/)
		const slice = lines.slice(startLine - 1, endLine)
		return slice.join("\n").trim()
	} catch {
		return ""
	}
}

// Module-level parsed-index cache (one entry per process — a session runs one
// workspace; keying by path+mtime+size also makes it correct for several).
let cachedIndexPath: string | undefined
let cachedIndexMtimeMs = -1
let cachedIndexSize = -1
let cachedEntries: IndexEntry[] = []

/** loadIndex with a session-scoped parse cache; invalidated by file change. */
function loadIndexCached(workspaceRoot: string): IndexEntry[] {
	const file = indexFilePath(workspaceRoot)
	let st: fs.Stats
	try {
		st = fs.statSync(file)
	} catch {
		// Index disappeared (or never existed) — drop the cache entry so a
		// later build of the same path is picked up fresh.
		cachedIndexPath = undefined
		return loadIndex(workspaceRoot)
	}
	if (cachedIndexPath === file && cachedIndexMtimeMs === st.mtimeMs && cachedIndexSize === st.size) {
		return cachedEntries
	}
	const entries = loadIndex(workspaceRoot)
	cachedIndexPath = file
	cachedIndexMtimeMs = st.mtimeMs
	cachedIndexSize = st.size
	cachedEntries = entries
	return entries
}

/** Search the persisted index for the chunks most similar to `query`. */
export function searchIndex(
	workspaceRoot: string,
	queryEmbedding: number[],
	pathPrefix?: string,
	topK: number = DEFAULT_TOP_K,
): SearchResult[] {
	const entries = loadIndexCached(workspaceRoot)
	const scored: Array<{ entry: IndexEntry; score: number }> = []

	for (const entry of entries) {
		if (pathPrefix) {
			const normalized = pathPrefix.replace(/\\/g, "/").replace(/\/+$/, "")
			if (!entry.file.startsWith(normalized + "/") && entry.file !== normalized) {
				continue
			}
		}
		const score = cosineSimilarity(queryEmbedding, entry.embedding)
		if (score > 0) {
			scored.push({ entry, score })
		}
	}

	scored.sort((a, b) => b.score - a.score)
	return scored.slice(0, Math.max(1, topK)).map(({ entry, score }) => ({
		filePath: entry.file,
		score,
		startLine: entry.startLine,
		endLine: entry.endLine,
		codeChunk: readSnippet(workspaceRoot, entry.file, entry.startLine, entry.endLine),
	}))
}

/**
 * Format search results for the tool result string, matching the vendored
 * CodebaseSearchTool's output layout (Query / Results / File path / Score /
 * Lines / Code Chunk).
 */
export function formatSearchResults(query: string, results: SearchResult[]): string {
	if (results.length === 0) {
		return `No relevant code snippets found for the query: "${query}"`
	}
	const blocks = results.map(
		(r) => `File path: ${r.filePath}
Score: ${r.score.toFixed(4)}
Lines: ${r.startLine}-${r.endLine}
Code Chunk: ${r.codeChunk}
`,
	)
	return `Query: ${query}
Results:

${blocks.join("\n")}`
}
