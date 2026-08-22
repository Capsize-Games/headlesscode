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
	/**
	 * Backend that produced this entry's embedding
	 * (`openrouter` | `ollama` | `airunner`). Added by the build for every
	 * entry; absent on pre-existing entries from before the Ollama backend
	 * existed, which the build treats as `openrouter` (the only backend that
	 * existed then). The query handler refuses to search with a mismatched
	 * backend — local and cloud embedding models produce different vector
	 * dimensions, so mixing them would silently yield garbage similarity
	 * scores.
	 */
	backend?: "openrouter" | "ollama" | "airunner"
}

/**
 * The on-disk index, relative to the CENTRAL project data dir
 * (`<dataRoot>/projects/<project-key>/codesearch/index.jsonl` — see
 * src/project-store.ts). No longer workspace-relative: the index lives in the
 * central store so every worktree of a repo shares it.
 */
export const INDEX_RELATIVE_PATH = "codesearch/index.jsonl"

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
