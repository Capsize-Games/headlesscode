/**
 * Test-selection heuristic for the `run_tests` tool.
 *
 * Deliberately simple — the goal is "much better than always running the
 * full suite during the iterative edit-check-edit loop", not a perfect
 * solver:
 *
 *   1. Direct match: `src/foo/bar.ts` changed → `src/foo/__tests__/bar.test.ts`
 *      if it exists (this repo's test-file convention). A changed file that
 *      IS itself a test runs itself.
 *   2. Reverse-dependency match: reuse the REAL import graph
 *      (src/codeintel/import-graph.ts — the same resolution the `import_graph`
 *      tool uses, correct on `paths` aliases and extension resolution) to find
 *      which files import the changed file — directly (1 hop) or through one
 *      intermediate module (2 hops, the common "lib → helper → test" case).
 *      Any importer that is a test file is selected.
 *   3. No match → the caller reports "no specific tests matched — consider
 *      running the full suite" rather than silently running nothing.
 *
 * A source file's own direct test wins over reverse-dependency matches for
 * determinism; everything is deduped and sorted for stable output.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { getImportGraph } from "../codeintel/import-graph.js"
import type { CodeIntel } from "../codeintel/program.js"

/** True for `foo.test.ts` / `foo.spec.tsx` style names, or any file inside a `__tests__` dir. */
export function isTestFile(relPath: string): boolean {
	const normalized = relPath.split(path.sep).join("/")
	if (/(^|\/)__tests__(\/|$)/.test(normalized)) {
		return true
	}
	return /[^/]+\.(test|spec)\.(m|c)?[tj]sx?$/i.test(normalized)
}

/**
 * Direct match for a changed source file: `src/foo/bar.ts` →
 * `src/foo/__tests__/bar.test.ts`. Only applies to source extensions the
 * project can test (TS/JS); returns undefined for everything else (scripts,
 * config, docs — those have no per-file test to run directly).
 */
export function directTestMatch(relSource: string): string | undefined {
	const normalized = relSource.split(path.sep).join("/")
	if (!/\.(m|c)?[tj]sx?$/i.test(normalized)) {
		return undefined
	}
	const dir = path.posix.dirname(normalized)
	const base = path.posix.basename(normalized).replace(/\.(m|c)?[tj]sx?$/i, "")
	// Never map a test file onto a sibling test (it already matched itself).
	if (isTestFile(normalized)) {
		return undefined
	}
	return `${dir}/__tests__/${base}.test.ts`
}

/**
 * Reverse-dependency match: every TEST file that (transitively, up to
 * `maxDepth` hops) imports the changed file, per the real import graph.
 * `absTarget` is the changed file's absolute path.
 */
export function reverseDependencyTests(
	intel: CodeIntel,
	workspaceRoot: string,
	absTarget: string,
	maxDepth = 2,
): string[] {
	const graph = getImportGraph(intel)
	const found: string[] = []
	const seenFiles = new Set<string>([absTarget])

	// BFS from the changed file along reverse import edges (`importedBy`).
	let frontier = [absTarget]
	for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
		const next: string[] = []
		for (const file of frontier) {
			for (const importer of graph.importedBy.get(file) ?? []) {
				if (seenFiles.has(importer)) {
					continue
				}
				seenFiles.add(importer)
				const rel = path.relative(workspaceRoot, importer).split(path.sep).join("/")
				if (isTestFile(rel)) {
					found.push(rel)
				}
				next.push(importer)
			}
		}
		frontier = next
	}
	return found
}

export interface TestSelectionResult {
	/** Selected test files, workspace-relative posix paths, sorted + deduped. */
	tests: string[]
	/** Human-readable notes on WHY each file was selected (for the tool result). */
	notes: string[]
}

/**
 * Select the test file(s) to run for a set of changed workspace-relative
 * files. Returns an empty `tests` list (with a note) when nothing matches —
 * the caller must report the fail-safe "no specific tests matched" instead
 * of pretending zero tests ran.
 */
export function selectTestsForChangedFiles(
	intel: CodeIntel,
	workspaceRoot: string,
	changedFiles: string[],
): TestSelectionResult {
	const tests = new Set<string>()
	const notes: string[] = []
	const seenNotes = new Set<string>()

	const note = (text: string): void => {
		if (!seenNotes.has(text)) {
			seenNotes.add(text)
			notes.push(text)
		}
	}

	for (const rel of changedFiles) {
		const normalized = rel.split(path.sep).join("/")
		if (isTestFile(normalized)) {
			tests.add(normalized)
			note(`direct: ${normalized} is itself a test file`)
			continue
		}
		const direct = directTestMatch(normalized)
		if (direct !== undefined && fileExists(path.join(workspaceRoot, direct))) {
			tests.add(direct)
			note(`direct: ${normalized} changed → ${direct}`)
			continue
		}
		const abs = path.resolve(workspaceRoot, normalized)
		const reverse = reverseDependencyTests(intel, workspaceRoot, abs)
		if (reverse.length > 0) {
			for (const t of reverse) {
				tests.add(t)
			}
			note(`reverse-dependency: ${normalized} is imported by ${reverse.join(", ")}`)
			continue
		}
		note(`no test matched ${normalized} (no direct test, no test imports it)`)
	}

	const sorted = [...tests].sort()
	return { tests: sorted, notes }
}

function fileExists(p: string): boolean {
	try {
		return fs.statSync(p).isFile()
	} catch {
		return false
	}
}
