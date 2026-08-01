/**
 * SHIM — minimal replacement for zoo-code/src/utils/fs.ts.
 *
 * The original exports a large set of fs helpers (mostly for the GUI layer).
 * The vendored CustomModesManager only needs `fileExistsAtPath`.
 */

import * as fs from "fs/promises"

export async function fileExistsAtPath(filePath: string): Promise<boolean> {
	try {
		const stats = await fs.stat(filePath)
		return stats.isFile()
	} catch {
		return false
	}
}
