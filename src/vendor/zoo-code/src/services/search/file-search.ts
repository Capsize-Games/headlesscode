/**
 * SHIM — replaces zoo-code/src/services/search/file-search.ts.
 *
 * The original shells out to ripgrep (`executeRipgrep`) to discover files by
 * glob pattern. Two vendored call sites use it:
 *   - `services/roo-config/index.ts#discoverSubfolderRooDirectories()`: finds
 *     any file under a nested ".roo" directory, excluding node_modules and
 *     ".git" (double-star glob, "-g" flags — see that file for the literal args).
 *   - `services/checkpoints/ShadowCheckpointService.ts#getNestedGitRepository()`:
 *     finds ".git" + "HEAD" pairs anywhere under the workspace (nested-repo
 *     detection — see that file for the literal args).
 *
 * This shim implements the same `{ args, workspacePath } -> results` shape
 * with pure Node `fs`, supporting the small glob subset both callers use
 * (double-star, single-star, and "!"-prefixed excludes via repeated "-g"
 * flags). Each result has `{ path, type }` (relative to `workspacePath`,
 * forward-slash separated), matching the real ripgrep-backed
 * implementation's `FileResult` shape closely enough for both callers (the
 * checkpoints caller destructures `type`).
 *
 * To keep this bounded on real repos, directories named ".git" are not
 * recursed into wholesale (that would walk the entire object store) —
 * instead only their "HEAD" file is checked directly, and "node_modules"
 * directories are never recursed into. Both are reasonable defaults for the
 * two callers above, which either exclude these directories explicitly or
 * (in the checkpoints case) only ever care about a top-level "HEAD" file.
 */

import * as fs from "fs/promises"
import * as path from "path"

export interface RipgrepResult {
	path: string
	type: "file" | "folder"
}

function globToRegex(glob: string): RegExp {
	let re = ""
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*"
				i++
				if (glob[i + 1] === "/") {
					i++
				}
			} else {
				re += "[^/]*"
			}
		} else if ("+.^${}()|[]\\".includes(c)) {
			re += "\\" + c
		} else {
			re += c
		}
	}
	return new RegExp(`^${re}$`)
}

function parsePatterns(args: string[]): { include: RegExp[]; exclude: RegExp[] } {
	const include: RegExp[] = []
	const exclude: RegExp[] = []

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-g" && args[i + 1] !== undefined) {
			const pattern = args[i + 1]
			if (pattern.startsWith("!")) {
				exclude.push(globToRegex(pattern.slice(1)))
			} else {
				include.push(globToRegex(pattern))
			}
			i++
		}
	}

	return { include, exclude }
}

export async function executeRipgrep({
	args,
	workspacePath,
}: {
	args: string[]
	workspacePath: string
}): Promise<RipgrepResult[]> {
	const { include, exclude } = parsePatterns(args)
	const results: RipgrepResult[] = []

	const isExcluded = (relPath: string, isDir: boolean) => {
		const candidates = isDir ? [relPath, `${relPath}/`] : [relPath]
		return exclude.some((re) => candidates.some((c) => re.test(c)))
	}

	const matchesInclude = (relPath: string) => include.length === 0 || include.some((re) => re.test(relPath))

	async function walk(dir: string, relative: string): Promise<void> {
		let entries: import("fs").Dirent[]

		try {
			entries = await fs.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}

		for (const entry of entries) {
			const entryRelative = relative ? `${relative}/${entry.name}` : entry.name

			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || isExcluded(entryRelative, true)) {
					continue
				}

				if (entry.name === ".git") {
					// Don't walk the object store; only surface HEAD, mirroring what
					// the checkpoints caller's `**/.git/HEAD` pattern is looking for.
					const headRelative = `${entryRelative}/HEAD`
					const headAbsolute = path.join(dir, entry.name, "HEAD")

					try {
						const stat = await fs.stat(headAbsolute)

						if (stat.isFile() && matchesInclude(headRelative) && !isExcluded(headRelative, false)) {
							results.push({ path: headRelative, type: "file" })
						}
					} catch {
						// No HEAD file — not a real git dir, nothing to report.
					}

					continue
				}

				await walk(path.join(dir, entry.name), entryRelative)
			} else if (entry.isFile()) {
				if (matchesInclude(entryRelative) && !isExcluded(entryRelative, false)) {
					results.push({ path: entryRelative, type: "file" })
				}
			}
		}
	}

	await walk(workspacePath, "")
	return results
}
