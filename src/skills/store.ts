import * as fs from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { projectStoreRoot } from "../project-store.js"
import { assertNoSymlinkAncestors, assertNoSymlinkPath } from "./registry.js"

const ENABLED_FILE = "skills-enabled.json"

function enabledFilePath(): string {
	return path.join(projectStoreRoot(), ENABLED_FILE)
}

export async function readEnabledSkillRoots(): Promise<string[]> {
	let handle: fs.FileHandle | undefined
	const file = enabledFilePath()
	try {
		handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
		const stat = await handle.stat({ bigint: true })
		if (!stat.isFile() || stat.size > 128n * 1024n) throw new Error("must be a regular file no larger than 128 KiB")
		const content = Buffer.alloc(Number(stat.size) + 1)
		const { bytesRead } = await handle.read(content, 0, content.length, 0)
		if (bytesRead !== Number(stat.size)) throw new Error("changed while being read")
		const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, bytesRead)))
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must contain a JSON object")
		const roots = (parsed as { roots?: unknown }).roots
		if (!Array.isArray(roots) || roots.length > 128 || roots.some((root) => typeof root !== "string" || !root.trim() || root.length > 4096)) {
			throw new Error("roots must be an array of at most 128 non-empty paths of at most 4096 characters")
		}
		return [...new Set((roots as string[]).map((root) => path.resolve(root)))].sort()
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		const reason = error instanceof Error ? error.message : String(error)
		throw new Error(`could not read enabled skill roots at ${file}: ${reason}`)
	} finally {
		await handle?.close()
	}
}

export async function enableSkillRoot(root: string): Promise<string[]> {
	await assertNoSymlinkPath(root)
	const resolved = await fs.realpath(path.resolve(root))
	const stat = await fs.lstat(path.resolve(root))
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("enabled skill root must be a real directory, not a symlink")
	const roots = await readEnabledSkillRoots()
	if (!roots.includes(resolved)) roots.push(resolved)
	roots.sort()
	const file = enabledFilePath()
	await assertNoSymlinkAncestors(path.dirname(file))
	await fs.mkdir(path.dirname(file), { recursive: true })
	await assertNoSymlinkPath(path.dirname(file))
	const temp = `${file}.${randomUUID()}.tmp`
	const handle = await fs.open(temp, "wx", 0o600)
	try {
		await handle.writeFile(`${JSON.stringify({ roots }, null, 2)}\n`)
	} finally {
		await handle.close()
	}
	await fs.rename(temp, file)
	return roots
}
