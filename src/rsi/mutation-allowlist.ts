import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"

const MAX_ALLOWED_FILE_BYTES = 256 * 1024

/** Verify committed mutation data with Git's raw mode/status records, not a path-only diff. */
export async function assertMutationAllowlist(root: string, baseCommit: string, allowedPaths: readonly string[]): Promise<void> {
	if (!/^[a-f0-9]{40}$/.test(baseCommit) || allowedPaths.length < 1 || allowedPaths.length > 8 ||
		new Set(allowedPaths).size !== allowedPaths.length || allowedPaths.some((entry) => !entry || path.posix.normalize(entry) !== entry || entry.startsWith("/") || entry.split("/").includes(".."))) {
		throw new Error("mutation allowlist identity is invalid")
	}
	const allowed = new Set(allowedPaths)
	const raw = execFileSync("git", ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", `${baseCommit}...HEAD`], { cwd: root, encoding: "buffer", maxBuffer: 1024 * 1024 }).toString("utf8")
	const fields = raw.split("\0")
	if (fields.at(-1) === "") fields.pop()
	if (fields.length % 2 !== 0) throw new Error("mutation diff metadata is malformed")
	const changed: string[] = []
	for (let index = 0; index < fields.length; index += 2) {
		const meta = fields[index]!
		const file = fields[index + 1]!
		const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])$/.exec(meta)
		if (!match || match[1] !== "100644" || match[2] !== "100644" || match[5] !== "M" || !allowed.has(file)) {
			throw new Error("candidate mutation contains a disallowed path or non-regular text-file change")
		}
		changed.push(file)
	}
	const numstatRaw = execFileSync("git", ["diff", "--numstat", "--no-renames", "-z", `${baseCommit}...HEAD`], { cwd: root, encoding: "buffer", maxBuffer: 1024 * 1024 }).toString("utf8")
	const stats = numstatRaw.split("\0").filter(Boolean)
	if (stats.length !== changed.length || stats.some((entry) => {
		const [added, removed, file] = entry.split("\t")
		return added === "-" || removed === "-" || !file || !allowed.has(file)
	})) throw new Error("candidate mutation contains binary or unbound change metadata")
	const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 }).trim()
	if (status) throw new Error("candidate mutation left uncommitted or untracked files")
	for (const file of changed) {
		const target = path.join(root, ...file.split("/"))
		const info = await fs.lstat(target)
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ALLOWED_FILE_BYTES) throw new Error("allowed mutation is not a bounded regular file")
		const content = await fs.readFile(target)
		if (content.includes(0) || !Buffer.from(content.toString("utf8"), "utf8").equals(content)) throw new Error("allowed mutation is not valid UTF-8 text")
	}
}
