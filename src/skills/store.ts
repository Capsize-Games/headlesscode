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
	try {
		handle = await fs.open(enabledFilePath(), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
		const stat = await handle.stat({ bigint: true })
		if (!stat.isFile() || stat.size > 128n * 1024n) return []
		const content = Buffer.alloc(Number(stat.size) + 1)
		const { bytesRead } = await handle.read(content, 0, content.length, 0)
		if (bytesRead !== Number(stat.size)) return []
		const parsed: unknown = JSON.parse(content.subarray(0, bytesRead).toString("utf-8"))
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
		const roots = (parsed as { roots?: unknown }).roots
		if (!Array.isArray(roots)) return []
		return [...new Set(roots.filter((root): root is string => typeof root === "string").map((root) => path.resolve(root)))].sort()
	} catch {
		return []
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
