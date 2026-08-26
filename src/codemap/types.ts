/**
 * Shared types for the deterministic per-project codemap subsystem
 * (src/codemap/ — module inventory, import/include/call graph,
 * entrypoint-rooted flows, self-contained HTML visualizer,
 * fingerprint-aware watcher, dashboard endpoints).
 *
 * Everything here is produced by a SCRIPT, never an LLM: the whole point
 * (issue #17/#18) is a worker that needs to know "what is this repo, what
 * imports what, what calls what, where do the entrypoints lead" can read
 * codemap.json instead of re-deriving structure via grep every session —
 * and trust it because it was generated mechanically.
 */

/** Naming-convention heuristic for a module's role (no semantics needed). */
export type ModuleRole = "source" | "test" | "entrypoint" | "config" | "vendor" | "generated"

/** Coarse language family, used by the extractor + visualizer. */
export type ModuleLanguage = "typescript" | "javascript" | "python" | "cpp" | "c" | "other"

/** One module (file) in the map. */
export interface ModuleEntry {
	/** Workspace-relative POSIX path (e.g. "src/engine/loop.ts"). */
	path: string
	language: ModuleLanguage
	role: ModuleRole
	/** File size in bytes (for a size/role heuristic). */
	sizeBytes: number
	/** Line count (for the same heuristic + the visualizer's detail panel). */
	lineCount: number
	/** sha256 hex of the file content — the fingerprint key for the lock. */
	hash: string
}

/**
 * One directed edge between two workspace modules. Only edges whose target
 * resolves INSIDE the workspace appear here; edges that resolve outside
 * (node_modules, builtins, absolute paths, failures) are summarized per
 * module in ModuleEntry.externalDeps so the map never explodes with
 * dependency nodes.
 */
export interface CodemapEdge {
	/** Workspace-relative POSIX path of the source module. */
	from: string
	/** Workspace-relative POSIX path of the target module. */
	to: string
	/**
	 * "import" for TS/JS/Python import statements, "include" for C/C++,
	 * "call" for TS/JS cross-module function/method/constructor calls
	 * (Phase 2 — resolved via the TS checker, not text matching).
	 */
	kind: "import" | "include" | "call"
	/**
	 * Raw specifier as written in source (e.g. "./b.js", "a.b.c", "foo.h").
	 * For call edges: the sorted, comma-joined callee names that make up the
	 * edge (one edge per from/to pair, so the module graph stays clean).
	 */
	specifier: string
	/** True for TS `import type` / `export type` edges (thinner in the view). */
	isTypeOnly?: boolean
}

/** The full codemap document (`codemap.json`). */
export interface Codemap {
	/** Human-readable project name (repo basename, or the workspace basename). */
	project: string
	/** Resolved absolute workspace root the map was generated from. */
	root: string
	/** ISO timestamp of generation. */
	generatedAt: string
	/**
	 * Deterministic content hash of the map: sha256 over the sorted module
	 * paths + hashes and the sorted edges. Stable across regenerations of an
	 * unchanged repo, so consumers can cheaply compare "did anything change".
	 */
	fingerprint: string
	modules: ModuleEntry[]
	edges: CodemapEdge[]
	/**
	 * Per-module deduplicated list of import specifiers that did NOT resolve
	 * to a workspace-internal module (node_modules, builtins, failures). Null
	 * (not empty) on a module with no such imports.
	 */
	externalDeps: Record<string, string[]>
	/**
	 * Entrypoint-rooted end-to-end flows (Phase 2, issue #18): for each
	 * module whose role is "entrypoint", the sorted list of every module
	 * reachable from it along directed import+call edges. Derived, not
	 * fingerprinted — a pure function of modules + edges. Deliberately NOT
	 * ranked by "importance" (see src/codemap/flows.ts for why).
	 */
	flows: Record<string, string[]>
}

/** Per-module content fingerprints — the change-detection lock. */
export interface CodemapLock {
	project: string
	/** Workspace-relative POSIX path -> sha256 hex of the file content. */
	fingerprints: Record<string, string>
	/** The fingerprint of the codemap.json this lock was written alongside. */
	codemapFingerprint: string
}
