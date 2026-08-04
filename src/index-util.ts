/**
 * Workspace codebase-index detection helpers.
 *
 * The codebase-search index now lives in the CENTRAL per-project data store
 * (see src/project-store.ts): `<dataRoot>/projects/<project-key>/codesearch/
 * index.jsonl`, keyed by the resolved git-common-dir parent so every worktree
 * of a repo shares the SAME index — the property that made the old
 * spawn-script index-seeding step unnecessary. These helpers answer "does a
 * usable index exist here?" in one place, used by:
 *   - HeadlessSession (src/engine/loop.ts) for the read-only-nudge guardrail,
 *   - the spawn-parallel-worktrees scripts (which decide whether a fresh
 *     worktree already has an index — now a central-store lookup, no seeding),
 *   - the spawn-parallel-worktrees smoke test.
 *
 * A "usable" index is one that exists AND is non-empty (an empty file is a
 * crashed/partial build — treat it as absent so the spawner rebuilds it).
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { resolveProjectDataDir } from "./project-store.js"

/** Absolute path of the codebase-search index for a workspace root. */
export function indexFilePathFor(workspaceRoot: string): string {
	return path.join(resolveProjectDataDir(workspaceRoot), "codesearch", "index.jsonl")
}

/**
 * True when the workspace already has a non-empty codebase-search index.
 * Also counts a legacy workspace-relative `.headlesscode/codesearch/index.jsonl`
 * (pre-migration grace — the same rule the spawn scripts rely on so a fresh
 * worktree of an already-indexed repo never rebuilds unnecessarily).
 */
export async function hasCodebaseIndex(workspaceRoot: string): Promise<boolean> {
	for (const file of [
		indexFilePathFor(workspaceRoot),
		path.join(workspaceRoot, ".headlesscode", "codesearch", "index.jsonl"),
	]) {
		try {
			const st = await fsp.stat(file)
			if (st.isFile() && st.size > 0) {
				return true
			}
		} catch {
			// missing — try the next candidate
		}
	}
	return false
}
