/**
 * SHIM — minimal replacement for zoo-code/src/utils/fs.ts.
 *
 * The original exports a large set of fs helpers (mostly for the GUI layer).
 * The vendored core only needs `fileExistsAtPath`, whose real implementation
 * (`zoo-code/src/utils/fs.ts`) is existence-only, regardless of file vs
 * directory:
 *
 *   export async function fileExistsAtPath(filePath: string): Promise<boolean> {
 *     try {
 *       await fs.access(filePath)
 *       return true
 *     } catch {
 *       return false
 *     }
 *   }
 *
 * This must match that exactly. An earlier version of this shim narrowed it
 * to `stats.isFile()`, which broke every caller that checks a DIRECTORY's
 * existence — `CustomModesManager`'s `.roo/rules-<slug>/` folder check, and
 * (found while vendoring checkpoints) `ShadowCheckpointService#initShadowGit`'s
 * check for whether the shadow `.git` dir already exists. With the `isFile`
 * version, both always returned false for existing directories, so
 * `initShadowGit` always took the "create new repo" branch — silently
 * re-initializing (and appending a redundant empty commit to) an
 * already-initialized shadow repo on every session, corrupting the checkpoint
 * history's meaning of "baseline".
 */

import * as fs from "fs/promises"

export async function fileExistsAtPath(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}
