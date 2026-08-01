/**
 * SHIM — replaces zoo-code/src/services/search/file-search.ts.
 *
 * The original shells out to ripgrep (`executeRipgrep`) to discover files. The
 * vendored `services/roo-config/index.ts` only uses it from
 * `discoverSubfolderRooDirectories()` to find `.roo` directories under the
 * workspace root. This shim implements the same discovery with pure Node fs and
 * returns file paths relative to the workspace, matching ripgrep's output
 * shape (each result has a `path` field).
 */

import * as fs from "fs/promises"
import * as path from "path"

export interface RipgrepResult {
	path: string
}

export async function executeRipgrep(options: {
	args: string[]
	workspacePath: string
}): Promise<RipgrepResult[]> {
	const { workspacePath } = options
	const results: RipgrepResult[] = []

	async function walk(dir: string, relative: string): Promise<void> {
		let entries: import("fs").Dirent[]
		try {
			entries = await fs.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}

		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") {
				continue
			}
			const entryRelative = relative ? path.join(relative, entry.name) : entry.name
			if (entry.isDirectory()) {
				await walk(path.join(dir, entry.name), entryRelative)
			} else if (entryRelative.includes(`${path.sep}.roo${path.sep}`)) {
				results.push({ path: entryRelative })
			}
		}
	}

	await walk(workspacePath, "")
	return results
}
