/**
 * Module inventory for the codemap: git-aware file discovery + a
 * naming-convention-based size/role heuristic (entrypoint, test, config,
 * vendor/generated — NO semantics, per issue #17's scope).
 *
 * Discovery reuses src/codesearch/files.ts's `walkSourceFiles` — the
 * git-aware walker (git ls-files with .gitignore semantics, generated-dir
 * exclusions, a hard file cap) — and narrows its result to the source
 * languages the codemap actually draws a graph over. Reusing it means the
 * inventory and the codebase-search index can never disagree about what is a
 * project file.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { walkSourceFiles } from "../codesearch/files.js"
import type { ModuleEntry, ModuleLanguage, ModuleRole } from "./types.js"

/** Source/config extensions the codemap inventories + draws edges for. */
const CODEMAP_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".c",
	".h",
	".cpp",
	".hpp",
	".cc",
	".hh",
	".cxx",
	".hxx",
	// Config files get inventoried (and role-tagged) even though they carry
	// no import edges — a codemap that omits package.json/tsconfig.json is a
	// map of the code without the knobs that shape it.
	".json",
	".toml",
	".yaml",
	".yml",
])

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"])
const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"])
const PY_EXTENSIONS = new Set([".py"])
const C_EXTENSIONS = new Set([".c", ".h"])
const CPP_EXTENSIONS = new Set([".cpp", ".hpp", ".cc", ".hh", ".cxx", ".hxx"])

/** Map an extension to the coarse language family. */
export function languageForExtension(ext: string): ModuleLanguage {
	const e = ext.toLowerCase()
	if (TS_EXTENSIONS.has(e)) {
		return "typescript"
	}
	if (JS_EXTENSIONS.has(e)) {
		return "javascript"
	}
	if (PY_EXTENSIONS.has(e)) {
		return "python"
	}
	if (CPP_EXTENSIONS.has(e)) {
		return "cpp"
	}
	if (C_EXTENSIONS.has(e)) {
		return "c"
	}
	return "other"
}

/** Test-file naming conventions across the three supported stacks. */
function isTestFile(rel: string, language: ModuleLanguage): boolean {
	const base = path.basename(rel)
	if (language === "python") {
		return /^test_.*\.py$/.test(base) || /_test\.py$/.test(base)
	}
	if (language === "typescript" || language === "javascript") {
		return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)
	}
	if (language === "cpp" || language === "c") {
		return /(^|[_-])test[._-]/.test(base) || /_test\.(c|h|cpp|hpp|cc|hh|cxx|hxx)$/.test(base)
	}
	return false
}

/**
 * Entrypoint naming conventions: main/cli/__main__ files. `__main__.py`
 * (the `python -m` entry) and main.* count anywhere; cli/index count only
 * when shallow (root or one dir deep, e.g. src/cli.ts) — a deep
 * src/codesearch/cli.ts is a subcommand module, not a repo entrypoint.
 * `__init__.py` is deliberately NOT an entrypoint: it is a package marker
 * (a large Python repo alone can have ~190 of them; tagging them all as
 * entrypoints drowns the real ones).
 */
function isEntrypointFile(rel: string): boolean {
	const base = path.basename(rel)
	if (/^main(\.[^.]*)?$/.test(base) || /^__main__\./.test(base) || rel.startsWith("bin/")) {
		return true
	}
	if (/^(cli|index)(\.[^.]*)?$/.test(base)) {
		const depth = rel.split("/").length
		return depth <= 2
	}
	return false
}

/** Config-file naming conventions: well-known manifests + config extensions. */
function isConfigFile(rel: string, language: ModuleLanguage): boolean {
	const base = path.basename(rel).toLowerCase()
	if (language !== "other") {
		return false
	}
	return (
		/\.(json|toml|ya?ml)$/.test(rel) ||
		/\.config\.[a-z0-9]+$/.test(base) ||
		[
			"package.json",
			"tsconfig.json",
			"jsconfig.json",
			"pyproject.toml",
			"setup.cfg",
			"requirements.txt",
			"cargo.toml",
			"go.mod",
			"cmakelists.txt",
			"makefile",
			"dockerfile",
			"compose.yaml",
			"compose.yml",
			".eslintrc",
			".prettierrc",
			".gitlab-ci.yml",
			".github/workflows/",
		].some((name) => rel.toLowerCase().includes(name))
	)
}

/** Vendor/generated directory-name heuristics (path-segment based). */
function isVendorOrGenerated(rel: string): { vendor: boolean; generated: boolean } {
	const segments = rel.split("/")
	let vendor = false
	let generated = false
	for (const segment of segments) {
		if (["vendor", "third_party", "third-party", "node_modules", ".venv", "venv", "site-packages"].includes(segment)) {
			vendor = true
		}
		if (["generated", "gen", "dist", "build", "out", "target"].includes(segment)) {
			generated = true
		}
	}
	// Type declaration files are compiler outputs in spirit (they describe
	// other code); they stay in the graph but are tagged generated.
	if (/\.d\.[cm]?ts$/.test(rel)) {
		generated = true
	}
	return { vendor, generated }
}

/** The naming-convention role for a module (source by default). */
export function classifyRole(rel: string, language: ModuleLanguage): ModuleRole {
	const { vendor, generated } = isVendorOrGenerated(rel)
	if (vendor) {
		return "vendor"
	}
	if (generated) {
		return "generated"
	}
	if (isTestFile(rel, language)) {
		return "test"
	}
	if (isEntrypointFile(rel)) {
		return "entrypoint"
	}
	if (isConfigFile(rel, language)) {
		return "config"
	}
	return "source"
}

/** Read a file's byte size + line count (best-effort; 0s on read failure). */
export function statLines(abs: string): { sizeBytes: number; lineCount: number } {
	try {
		const st = fs.statSync(abs)
		const raw = fs.readFileSync(abs, "utf-8")
		let lines = 0
		for (let i = 0; i < raw.length; i++) {
			if (raw.charCodeAt(i) === 10) {
				lines++
			}
		}
		return { sizeBytes: st.size, lineCount: raw.length === 0 ? 0 : lines + 1 }
	} catch {
		return { sizeBytes: 0, lineCount: 0 }
	}
}

/**
 * Build the module inventory for a workspace: every supported source/config
 * file with its role, language, size, line count and content hash. The hash
 * is the fingerprint key the lock file uses for change detection.
 */
export async function inventoryModules(
	workspaceRoot: string,
	contentHash: (content: string) => string,
): Promise<ModuleEntry[]> {
	const files = await walkSourceFiles(workspaceRoot)
	const modules: ModuleEntry[] = []
	for (const file of files) {
		const ext = path.extname(file.rel).toLowerCase()
		if (!CODEMAP_EXTENSIONS.has(ext)) {
			continue
		}
		const language = languageForExtension(ext)
		const { sizeBytes, lineCount } = statLines(file.abs)
		let content: string
		try {
			content = fs.readFileSync(file.abs, "utf-8")
		} catch {
			continue
		}
		modules.push({
			path: file.rel,
			language,
			role: classifyRole(file.rel, language),
			sizeBytes,
			lineCount,
			hash: contentHash(content),
		})
	}
	modules.sort((a, b) => a.path.localeCompare(b.path))
	return modules
}
