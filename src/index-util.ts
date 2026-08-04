/**
 * Workspace codebase-index detection helpers.
 *
 * Part of codebase_search activation: the index lives at
 * `<workspaceRoot>/.headlesscode/codesearch/index.jsonl` (see
 * src/codesearch/types.ts) and is gitignored (the repo never ships it — it
 * is ~168MB for this repo, generated on first use). These helpers answer
 * "does a usable index exist here?" in one place, used by:
 *   - spawn-parallel-worktrees.sh (copies the main repo's index into fresh
 *     worktrees so a worker never starts with a guaranteed "not indexed"),
 *   - its GUI sibling spawn-parallel-worktrees-gui.sh,
 *   - the spawn-parallel-worktrees smoke test.
 *
 * A "usable" index is one that exists AND is non-empty (an empty file is a
 * crashed/partial build — treat it as absent so the spawner rebuilds it).
 */

import { existsSync } from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { INDEX_RELATIVE_PATH } from "./codesearch/types.js"

/** Absolute path of the codebase-search index for a workspace root. */
export function indexFilePathFor(workspaceRoot: string): string {
	return path.join(path.resolve(workspaceRoot), INDEX_RELATIVE_PATH)
}

/** True when the workspace already has a non-empty codebase-search index. */
export async function hasCodebaseIndex(workspaceRoot: string): Promise<boolean> {
	const file = indexFilePathFor(workspaceRoot)
	try {
		const st = await fsp.stat(file)
		return st.isFile() && st.size > 0
	} catch {
		return false
	}
}

/**
 * Global-vs-workspace `.headlesscode/` clarity (speed workstream, P1.7): when
 * a workspace has no `.headlesscode/` directory yet, print a one-line note
 * that per-workspace state (codebase-search index, mode-models.json) will be
 * created THERE — distinct from `~/.headlesscode/`, which only holds
 * checkpoints. No-op once the directory exists. Called from `headlesscode
 * index` and `headlesscode orchestrate` at the earliest point the workspace
 * root is known.
 */
export function checkAndNoteHeadlesscodeDir(
	workspaceRoot: string,
	write: (line: string) => void = (line) => process.stdout.write(line),
): void {
	if (existsSync(path.join(path.resolve(workspaceRoot), ".headlesscode"))) {
		return
	}
	write(
		"This workspace has no `.headlesscode/` directory — per-workspace state (index, mode-models.json) will be created here. This is distinct from `~/.headlesscode/` which only holds checkpoints.\n",
	)
}
