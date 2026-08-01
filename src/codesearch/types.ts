/**
 * Shared types for the codebase semantic-search subsystem
 * (src/codesearch/ — chunker, cloud embedder, persisted index, and the
 * `codebase_search` tool handler that consumes it).
 *
 * This is a deliberately separate subsystem from the Phase 3 memory embedder
 * (src/memory/embed.ts): that one is a cheap deterministic hash stand-in for
 * handful-of-records session/fact recall, while this one embeds an entire
 * repo's source via a real cloud model and persists the vectors to disk.
 */

/** One indexed code chunk, persisted as one JSON line in the index file. */
export interface IndexEntry {
	/** Workspace-relative POSIX path (e.g. "src/engine/loop.ts"). */
	file: string
	/** 1-based inclusive line range of this chunk within the file. */
	startLine: number
	endLine: number
	/** Embedding vector (dimension depends on the model). */
	embedding: number[]
	/**
	 * Content hash of the chunk text (sha256 hex of the raw chunk lines). The
	 * index build compares this against the previous build's entries to skip
	 * re-embedding unchanged chunks — the cost-control mechanism that stops a
	 * re-index of an untouched repo from spending money.
	 */
	hash: string
}

/** The on-disk index: `<workspaceRoot>/.headlesscode/codesearch/index.jsonl`. */
export const INDEX_RELATIVE_PATH = ".headlesscode/codesearch/index.jsonl"

/** Default top-K results returned by codebase_search. */
export const DEFAULT_TOP_K = 10

/** Supported source-file extensions (this repo's language mix + docs/config). */
export const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".c",
	".h",
	".cpp",
	".hpp",
	".cs",
	".rb",
	".java",
	".php",
	".swift",
	".kt",
	".kts",
	".ex",
	".exs",
	".el",
	".html",
	".htm",
	".md",
	".markdown",
	".txt",
	".json",
	".css",
	".ml",
	".mli",
	".lua",
	".scala",
	".toml",
	".zig",
	".elm",
	".ejs",
	".erb",
	".vb",
	".dart",
	".sh",
	".bash",
	".zsh",
	".yml",
	".yaml",
])
