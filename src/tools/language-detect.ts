/**
 * Cheap workspace-language detection used to CONDITIONALLY register tools that
 * only work for specific languages (Part D of the central-store round):
 *
 * - The code-intelligence tools (outline, go_to_definition, find_references,
 *   import_graph, rename_symbol — src/codeintel/) are registered per language
 *   (issue #59): the executor asks this detector which languages the
 *   workspace has, then wires a backend for each language that has one
 *   available (TypeScript/JavaScript via ts.Program, Python via the bundled
 *   pyright language server).
 * - `run_tests`'s direct-match discovery + `tsx` invocation are TS-specific
 *   and remain gated on TS/JS workspaces only.
 *
 * On a real target project like a C++ or Rust repo with no wired language
 * server, the code-intelligence tools are dead weight — advertised on every
 * request, costing prompt tokens, silently useless if tried — so they are
 * simply not registered there (the same "match the tool list to what actually
 * works" discipline `codebase_search` already models with its broad extension
 * list).
 *
 * The detector is deliberately crude — marker files at the root plus a
 * BOUNDED extension-frequency walk (see MAX_SCAN_FILES) — accurate enough to
 * gate on, and cheap enough to run synchronously at every executor creation.
 * It is NOT a language taxonomy: it only needs to answer "which languages are
 * present (so the per-language code-intel backends make sense)?".
 */

import * as fs from "node:fs"
import * as path from "node:path"

/** Workspace languages the detector can recognize. */
export type WorkspaceLanguage = "typescript" | "python" | "cpp" | "rust" | "go" | "java"

/**
 * Directory names never scanned (same spirit as src/codesearch/files.ts's
 * FALLBACK_EXCLUDES — generated artifacts and VCS dirs). Anything not listed
 * is fair game: the detector is extension-frequency-based and cheap.
 */
const SKIP_DIR_NAMES = new Set([
	".git",
	".headlesscode",
	".worktrees",
	".roo",
	".idea",
	".vscode",
	".next",
	".nuxt",
	".terraform",
	".terragrunt-cache",
	".pytest_cache",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"target",
	"__pycache__",
	"venv",
	".venv",
	"env",
	"vendor",
	"Pods",
	"bin",
	"obj",
])

/** Root marker files that imply a language even with zero source files yet. */
const MARKER_FILES: ReadonlyArray<{ name: string; language: WorkspaceLanguage }> = [
	{ name: "package.json", language: "typescript" },
	{ name: "tsconfig.json", language: "typescript" },
	{ name: "jsconfig.json", language: "typescript" },
	{ name: "pyproject.toml", language: "python" },
	{ name: "setup.py", language: "python" },
	{ name: "setup.cfg", language: "python" },
	{ name: "requirements.txt", language: "python" },
	{ name: "Pipfile", language: "python" },
	{ name: "CMakeLists.txt", language: "cpp" },
	{ name: "Cargo.toml", language: "rust" },
	{ name: "go.mod", language: "go" },
	{ name: "pom.xml", language: "java" },
	{ name: "build.gradle", language: "java" },
	{ name: "build.gradle.kts", language: "java" },
	{ name: "settings.gradle", language: "java" },
]

/** Extension → language. `.h`/`.c` alone do NOT imply C++ (plain C is common). */
const EXTENSION_LANGUAGES: ReadonlyArray<{ exts: readonly string[]; language: WorkspaceLanguage }> = [
	{ exts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], language: "typescript" },
	{ exts: [".py"], language: "python" },
	{ exts: [".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx"], language: "cpp" },
	{ exts: [".rs"], language: "rust" },
	{ exts: [".go"], language: "go" },
	{ exts: [".java"], language: "java" },
]

/** Cap on files examined during the extension walk (cheap + deterministic). */
export const MAX_SCAN_FILES = 4_000

/** Cap on directories descended during the walk (prevents pathological trees). */
export const MAX_SCAN_DIRS = 2_000

/** Number of same-extension hits required to count a language (1 is enough to gate on). */
const EXTENSION_COUNT_THRESHOLD = 1

/**
 * Detect the languages present in a workspace. Root marker files are checked
 * first (cheap + authoritative for tooling-heavy repos); then a bounded
 * recursive walk counts source extensions. Never throws — a missing/unreadable
 * workspace returns the empty set.
 */
export function detectWorkspaceLanguages(workspaceRoot: string): Set<WorkspaceLanguage> {
	const root = path.resolve(workspaceRoot)
	const detected = new Set<WorkspaceLanguage>()

	// 1. Root marker files.
	let rootEntries: fs.Dirent[]
	try {
		rootEntries = fs.readdirSync(root, { withFileTypes: true })
	} catch {
		return detected
	}
	for (const ent of rootEntries) {
		if (!ent.isFile() && !ent.isSymbolicLink()) {
			continue
		}
		for (const { name, language } of MARKER_FILES) {
			if (ent.name === name) {
				detected.add(language)
			}
		}
	}

	// 2. Bounded extension-frequency walk. Once every language we care about is
	// found, stop early.
	const wanted = new Set<WorkspaceLanguage>(["typescript", "python", "cpp", "rust", "go", "java"])
	const counts = new Map<WorkspaceLanguage, number>()
	let scanned = 0
	let dirs = 0

	const walk = (dir: string): void => {
		if (dirs >= MAX_SCAN_DIRS || scanned >= MAX_SCAN_FILES) {
			return
		}
		dirs++
		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const ent of entries) {
			if (scanned >= MAX_SCAN_FILES) {
				return
			}
			if (ent.isDirectory()) {
				if (!SKIP_DIR_NAMES.has(ent.name) && !ent.name.startsWith(".")) {
					walk(path.join(dir, ent.name))
				}
				continue
			}
			if (!ent.isFile()) {
				continue
			}
			scanned++
			const ext = path.extname(ent.name).toLowerCase()
			for (const { exts, language } of EXTENSION_LANGUAGES) {
				if (exts.includes(ext)) {
					counts.set(language, (counts.get(language) ?? 0) + 1)
					break
				}
			}
		}
	}
	walk(root)

	for (const lang of wanted) {
		if ((counts.get(lang) ?? 0) >= EXTENSION_COUNT_THRESHOLD) {
			detected.add(lang)
		}
	}
	return detected
}

/** Convenience: is this workspace TS/JS (the codeintel/run_tests gate)? */
export function isTypeScriptWorkspace(workspaceRoot: string): boolean {
	return detectWorkspaceLanguages(workspaceRoot).has("typescript")
}
