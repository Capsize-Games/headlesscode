/**
 * Edge extraction for the codemap — one mechanical extractor per language:
 *
 *   - TypeScript/JS: reuse `getImportGraph()` from src/codeintel/import-graph.ts
 *     DIRECTLY (built on the TS Language Service, resolves tsconfig `paths`
 *     aliases exactly as the compiler would) — issue #17 explicitly says to
 *     wire it in, not reimplement it — plus `getCallGraph()` from
 *     src/codeintel/call-graph.ts for Phase 2's cross-module call edges
 *     (issue #18: real checker symbol resolution, never text matching).
 *     Modules the TS program doesn't cover (e.g. standalone .mjs scripts
 *     outside tsconfig's include) simply carry no import/call edges.
 *   - Python: shell out to scripts/codemap-python-extract.py (stdlib `ast`
 *     via a small Python subprocess — the project's established pattern for
 *     Python tooling; the script is deterministic, no LLM). Call edges stay
 *     Phase 2 for Python (per-framework pattern lists — FastAPI routes,
 *     Celery tasks — are project-specific by design, see docs/codemap.md).
 *   - C/C++: regex over `#include` directives (mechanical, good enough for
 *     structure; symbol-level resolution is explicitly Phase 2 and likely
 *     stays includes-only — a real call graph needs a compiler frontend).
 *
 * Edges whose target resolves OUTSIDE the workspace (node_modules, builtins,
 * absolute paths) are NOT emitted as graph edges — they are summarized per
 * module in `externalDeps` so the map stays a map of THIS project.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { spawn } from "node:child_process"

import { getCallGraph } from "../codeintel/call-graph.js"
import { getImportGraph } from "../codeintel/import-graph.js"
import { getCodeIntelCache } from "../codeintel/program.js"
import type { CodemapEdge, ModuleEntry } from "./types.js"

/** Absolute path of the Python AST extractor script (env-overridable for tests). */
export function pythonExtractorScript(): string {
	const override = process.env.HEADLESSCODE_CODEMAP_PYTHON_SCRIPT?.trim()
	if (override) {
		return override
	}
	return path.resolve(new URL("../../scripts/codemap-python-extract.py", import.meta.url).pathname)
}

/** C/C++ `#include` directive: `#include <foo.h>` or `#include "foo.h"`. */
const INCLUDE_RE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm

/** True when `rel` (workspace-relative posix) stays inside the workspace. */
function isInsideWorkspace(rel: string): boolean {
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** abs path -> workspace-relative posix path (undefined when outside). */
function toWorkspaceRel(root: string, abs: string): string | undefined {
	const rel = path.relative(root, abs).split(path.sep).join("/")
	return isInsideWorkspace(rel) ? rel : undefined
}

/** Collect TS/JS import edges from the shared codeintel import graph. */
function extractTypeScriptEdges(root: string, modules: ModuleEntry[]): { edges: CodemapEdge[]; externalDeps: Record<string, string[]> } {
	const moduleSet = new Set(modules.map((m) => m.path))
	const edges: CodemapEdge[] = []
	const externalDeps: Record<string, string[]> = {}

	// Skip program loading entirely on non-TS projects (a Python-only repo
	// must not pay for an empty TS program).
	if (!modules.some((m) => m.language === "typescript" || m.language === "javascript")) {
		return { edges, externalDeps }
	}

	let intel
	try {
		intel = getCodeIntelCache(root).get()
	} catch {
		// A broken/absent tsconfig must not kill the whole codemap: the module
		// inventory + other languages still work.
		return { edges, externalDeps }
	}
	const graph = getImportGraph(intel)
	const callGraph = getCallGraph(intel)

	for (const module of modules) {
		if (module.language !== "typescript" && module.language !== "javascript") {
			continue
		}
		const abs = path.join(root, module.path)
		const importEdges = graph.imports.get(abs)
		if (importEdges === undefined || importEdges.length === 0) {
			continue
		}
		const externals = new Set<string>()
		for (const edge of importEdges) {
			if (edge.resolved === undefined) {
				externals.add(edge.specifier)
				continue
			}
			const rel = toWorkspaceRel(root, edge.resolved)
			if (rel === undefined || !moduleSet.has(rel)) {
				externals.add(edge.specifier)
				continue
			}
			edges.push({
				from: module.path,
				to: rel,
				kind: "import",
				specifier: edge.specifier,
				isTypeOnly: edge.isTypeOnly === true,
			})
		}
		if (externals.size > 0) {
			externalDeps[module.path] = [...externals].sort()
		}
	}

	// Phase 2 call edges (issue #18): cross-module function/method/constructor
	// calls, resolved by the TS checker to the callee's defining file. One
	// edge per from/to pair — callee names are joined into `specifier` so the
	// module graph stays clean (no parallel lines in the visualizer).
	const CALL_NAMES_CAP = 8
	for (const module of modules) {
		if (module.language !== "typescript" && module.language !== "javascript") {
			continue
		}
		const abs = path.join(root, module.path)
		const calls = callGraph.get(abs)
		if (calls === undefined || calls.length === 0) {
			continue
		}
		const byTarget = new Map<string, string[]>()
		for (const call of calls) {
			if (call.resolvedFile === undefined) {
				continue
			}
			const rel = toWorkspaceRel(root, call.resolvedFile)
			if (rel === undefined || rel === module.path || !moduleSet.has(rel)) {
				continue
			}
			const names = byTarget.get(rel) ?? []
			if (!names.includes(call.callee)) {
				names.push(call.callee)
			}
			byTarget.set(rel, names)
		}
		for (const [target, names] of byTarget) {
			names.sort()
			const shown = names.length > CALL_NAMES_CAP ? [...names.slice(0, CALL_NAMES_CAP), `… (${names.length} callees)`] : names
			edges.push({ from: module.path, to: target, kind: "call", specifier: shown.join(", ") })
		}
	}
	return { edges, externalDeps }
}

/** Run the Python AST extractor and emit import edges. */
async function extractPythonEdges(root: string, modules: ModuleEntry[]): Promise<{ edges: CodemapEdge[]; externalDeps: Record<string, string[]> }> {
	const pyModules = modules.filter((m) => m.language === "python")
	const edges: CodemapEdge[] = []
	const externalDeps: Record<string, string[]> = {}
	if (pyModules.length === 0) {
		return { edges, externalDeps }
	}
	const moduleSet = new Set(modules.map((m) => m.path))

	// Run the extractor with the payload on stdin (spawn — execFile has no
	// `input` option, and the file list can be thousands of entries).
	const stdout = await runPythonExtractor(root, pyModules.map((m) => m.path))
	if (stdout === undefined) {
		// python3 missing or the script failed — non-fatal: log and continue
		// with the rest of the map (matches the project's non-fatal pattern
		// for auxiliary subsystems). The inventory still lists the modules.
		return { edges, externalDeps }
	}

	let parsed: { files?: Record<string, Array<{ specifier: string; kind: string; resolved: string | null }>> }
	try {
		parsed = JSON.parse(stdout)
	} catch {
		console.warn("[codemap] python extractor returned malformed output — skipped")
		return { edges, externalDeps }
	}
	for (const [file, imports] of Object.entries(parsed.files ?? {})) {
		const externals = new Set<string>()
		for (const imp of imports) {
			if (imp.resolved === null) {
				externals.add(imp.specifier)
				continue
			}
			if (!moduleSet.has(imp.resolved)) {
				externals.add(imp.specifier)
				continue
			}
			edges.push({ from: file, to: imp.resolved, kind: "import", specifier: imp.specifier })
		}
		if (externals.size > 0) {
			externalDeps[file] = [...externals].sort()
		}
	}
	return { edges, externalDeps }
}

/** Regex-based C/C++ `#include` edges (best-effort path resolution). */
function extractCppEdges(root: string, modules: ModuleEntry[]): { edges: CodemapEdge[]; externalDeps: Record<string, string[]> } {
	const cppModules = modules.filter((m) => m.language === "cpp" || m.language === "c")
	const edges: CodemapEdge[] = []
	const externalDeps: Record<string, string[]> = {}
	if (cppModules.length === 0) {
		return { edges, externalDeps }
	}
	const moduleSet = new Set(modules.map((m) => m.path))

	const resolveInclude = (absFile: string, specifier: string, angle: boolean): string | undefined => {
		const candidates: string[] = []
		if (angle) {
			// `<foo/bar.h>`: try workspace-root-relative first, then the
			// including file's directory (some projects quote-import adjacent).
			candidates.push(path.join(root, specifier.split("/").join(path.sep)))
			candidates.push(path.join(path.dirname(absFile), specifier.split("/").join(path.sep)))
		} else {
			// `"foo/bar.h"`: file-dir-relative first, then root-relative.
			candidates.push(path.join(path.dirname(absFile), specifier.split("/").join(path.sep)))
			candidates.push(path.join(root, specifier.split("/").join(path.sep)))
		}
		for (const candidate of candidates) {
			try {
				if (fs.statSync(candidate).isFile()) {
					return toWorkspaceRel(root, path.resolve(candidate))
				}
			} catch {
				// keep trying
			}
		}
		return undefined
	}

	for (const module of cppModules) {
		const abs = path.join(root, module.path)
		let source: string
		try {
			source = fs.readFileSync(abs, "utf-8")
		} catch {
			continue
		}
		const seen = new Set<string>()
		const externals = new Set<string>()
		INCLUDE_RE.lastIndex = 0
		let match: RegExpExecArray | null
		while ((match = INCLUDE_RE.exec(source)) !== null) {
			const specifier = match[1]!
			const angle = source[match.index + match[0].indexOf("<")] === "<"
			const rel = resolveInclude(abs, specifier, angle)
			const key = rel ?? `unresolved:${specifier}`
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
			if (rel === undefined || !moduleSet.has(rel)) {
				externals.add(specifier)
				continue
			}
			edges.push({ from: module.path, to: rel, kind: "include", specifier })
		}
		if (externals.size > 0) {
			externalDeps[module.path] = [...externals].sort()
		}
	}
	return { edges, externalDeps }
}

/**
 * Run scripts/codemap-python-extract.py with the file list on stdin and
 * return its stdout. undefined when python3 is missing or the script fails
 * (callers treat that as "no python edges", never as a crash).
 */
function runPythonExtractor(root: string, files: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn("python3", [pythonExtractorScript()], { cwd: root })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf-8")
			if (stdout.length > 64 * 1024 * 1024) {
				child.kill()
				resolve(undefined)
			}
		})
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf-8")
		})
		child.on("error", (err) => {
			resolve(undefined)
			void err
		})
		child.on("close", (code) => {
			if (code === 0) {
				resolve(stdout)
			} else {
				console.warn(`[codemap] python extractor exited ${code}: ${stderr.trim().slice(0, 400)}`)
				resolve(undefined)
			}
		})
		child.stdin.on("error", () => {
			// stdin closed early (child died) — nothing to do
		})
		child.stdin.end(JSON.stringify({ root, files }))
	})
}

/**
 * Extract every import/include edge for the workspace's modules. Edges are
 * deduplicated and sorted for determinism.
 */
export async function extractEdges(
	root: string,
	modules: ModuleEntry[],
): Promise<{ edges: CodemapEdge[]; externalDeps: Record<string, string[]> }> {
	const ts = extractTypeScriptEdges(root, modules)
	const py = await extractPythonEdges(root, modules)
	const cpp = extractCppEdges(root, modules)

	const edges = [...ts.edges, ...py.edges, ...cpp.edges]
	const byKey = new Map<string, CodemapEdge>()
	for (const edge of edges) {
		const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.specifier}`
		if (!byKey.has(key)) {
			byKey.set(key, edge)
		}
	}
	const deduped = [...byKey.values()].sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)))

	const externalDeps: Record<string, string[]> = {}
	for (const dep of [ts.externalDeps, py.externalDeps, cpp.externalDeps]) {
		for (const [file, specs] of Object.entries(dep)) {
			const merged = new Set(externalDeps[file] ?? [])
			for (const s of specs) {
				merged.add(s)
			}
			externalDeps[file] = [...merged].sort()
		}
	}
	return { edges: deduped, externalDeps }
}
