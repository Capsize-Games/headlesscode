/**
 * Content hashing + lock comparison for the codemap's change detection.
 *
 * The lock file (codemap.lock) records a sha256 per module path. A rebuild
 * recomputes the current hashes and compares them with the stored ones: an
 * identical key-set AND identical hash per key means "nothing changed" and
 * the build writes nothing. Any diff — a changed file, a new file, a deleted
 * file — means a (full) regeneration. Full regen is deliberate for v1: the
 * extraction is fast and cheap, so incremental per-module regeneration would
 * add complexity with no measurable win (issue #17 explicitly allows it).
 */

import * as crypto from "node:crypto"

import type { Codemap, CodemapLock } from "./types.js"

/** sha256 hex of a string (the same digest the codesearch index uses). */
export function contentHash(content: string): string {
	return crypto.createHash("sha256").update(content, "utf-8").digest("hex")
}

/** Current fingerprint map for the given modules (path -> content hash). */
export function fingerprintMap(modules: ReadonlyArray<{ path: string; hash: string }>): Record<string, string> {
	const out: Record<string, string> = {}
	for (const m of modules) {
		out[m.path] = m.hash
	}
	return out
}

/** True when the current modules exactly match the stored lock (no writes needed). */
export function lockMatches(lock: CodemapLock | undefined, modules: ReadonlyArray<{ path: string; hash: string }>): boolean {
	if (lock === undefined) {
		return false
	}
	const current = fingerprintMap(modules)
	const stored = lock.fingerprints
	const currentKeys = Object.keys(current)
	if (currentKeys.length !== Object.keys(stored).length) {
		return false
	}
	for (const key of currentKeys) {
		if (stored[key] !== current[key]) {
			return false
		}
	}
	return true
}

/**
 * Deterministic content fingerprint for the whole codemap: sha256 over the
 * sorted module paths+hashes and the sorted edges. Stable across
 * regenerations of an unchanged repo.
 */
export function codemapFingerprint(codemap: Pick<Codemap, "project" | "modules" | "edges" | "externalDeps">): string {
	const h = crypto.createHash("sha256")
	const moduleLines = codemap.modules.map((m) => `${m.path}\t${m.hash}`).join("\n")
	h.update(`modules:\n${moduleLines}\n`)
	const edgeLines = codemap.edges
		.map((e) => `${e.from}\t${e.to}\t${e.kind}\t${e.specifier}`)
		.sort()
		.join("\n")
	h.update(`edges:\n${edgeLines}\n`)
	return h.digest("hex")
}
