/**
 * The codemap build pipeline: inventory → fingerprint diff → extract →
 * write. Deterministic end to end, NO LLM anywhere (issue #17's hard
 * requirement).
 *
 * Fingerprint-aware regeneration: the lock (codemap.lock) stores a sha256
 * per module path. When the current inventory exactly matches the lock —
 * same key set, same hash per key — and a codemap.json already exists, the
 * build writes NOTHING and reports "unchanged". Any diff (edited, added,
 * deleted file) triggers a FULL regeneration: extraction is fast and cheap,
 * so per-module incremental regeneration is not worth the complexity for v1
 * (the issue explicitly allows full regen as long as it's fast).
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { inventoryModules } from "./files.js"
import { codemapFingerprint, contentHash, fingerprintMap, lockMatches } from "./fingerprint.js"
import { computeEntrypointFlows } from "./flows.js"
import { renderCodemapHtml } from "./html.js"
import { codemapDir, codemapHtmlPath, codemapJsonPath, codemapLockPath, loadCodemap, loadLock } from "./lock.js"
import { extractEdges } from "./extract.js"
import type { Codemap, CodemapLock, CodemapEdge, ModuleEntry } from "./types.js"

export interface CodemapBuildOptions {
	workspaceRoot: string
	/** Skip the fingerprint check and regenerate unconditionally. */
	force?: boolean
}

export interface CodemapBuildResult {
	/** False when the fingerprint check short-circuited (nothing written). */
	changed: boolean
	project: string
	root: string
	modules: ModuleEntry[]
	edges: CodemapEdge[]
	/** Per-module external (unresolved/out-of-workspace) specifiers. */
	externalDeps: Record<string, string[]>
	/** Entrypoint-rooted reachability (Phase 2, issue #18). */
	flows: Record<string, string[]>
	fingerprint: string
	jsonPath: string
	htmlPath: string
	lockPath: string
}

/** Resolve the human-readable project name (repo dir basename). */
export function projectName(workspaceRoot: string): string {
	return path.basename(path.resolve(workspaceRoot)) || "project"
}

/**
 * Build (or refresh) the codemap for a workspace. When nothing changed since
 * the last build, no files are written and `changed` is false.
 */
export async function buildCodemap(options: CodemapBuildOptions): Promise<CodemapBuildResult> {
	const root = path.resolve(options.workspaceRoot)
	const project = projectName(root)

	const modules = await inventoryModules(root, contentHash)

	if (!options.force) {
		const lock = loadLock(root)
		const existing = loadCodemap(root)
		if (lockMatches(lock, modules) && existing !== undefined) {
			return {
				changed: false,
				project: existing.project || project,
				root,
				modules: existing.modules,
				edges: existing.edges,
				externalDeps: existing.externalDeps,
				// Derived from modules+edges; a map written before flows existed
				// simply has none until the next real regeneration.
				flows: existing.flows ?? {},
				fingerprint: existing.fingerprint,
				jsonPath: codemapJsonPath(root),
				htmlPath: codemapHtmlPath(root),
				lockPath: codemapLockPath(root),
			}
		}
	}

	const { edges, externalDeps } = await extractEdges(root, modules)
	const flows = computeEntrypointFlows(modules, edges)
	const fingerprint = codemapFingerprint({ project, modules, edges, externalDeps })

	const codemap: Codemap = {
		project,
		root,
		generatedAt: new Date().toISOString(),
		fingerprint,
		modules,
		edges,
		externalDeps,
		flows,
	}
	const lock: CodemapLock = {
		project,
		fingerprints: fingerprintMap(modules),
		codemapFingerprint: fingerprint,
	}

	const dir = codemapDir(root)
	await fsp.mkdir(dir, { recursive: true })
	await fsp.writeFile(codemapJsonPath(root), JSON.stringify(codemap, null, 2) + "\n", "utf-8")
	await fsp.writeFile(codemapLockPath(root), JSON.stringify(lock, null, 2) + "\n", "utf-8")
	await fsp.writeFile(codemapHtmlPath(root), renderCodemapHtml(codemap), "utf-8")

	return {
		changed: true,
		project,
		root,
		modules,
		edges,
		externalDeps,
		flows,
		fingerprint,
		jsonPath: codemapJsonPath(root),
		htmlPath: codemapHtmlPath(root),
		lockPath: codemapLockPath(root),
	}
}

/** True when a codemap already exists for the workspace (dashboard 404 helper). */
export function codemapExists(workspaceRoot: string): boolean {
	try {
		return fs.existsSync(codemapJsonPath(workspaceRoot))
	} catch {
		return false
	}
}
