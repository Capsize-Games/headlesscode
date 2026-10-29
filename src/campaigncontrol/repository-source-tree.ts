import { createHash } from "node:crypto"
import { constants } from "node:fs"
import type { BigIntStats } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

const TREE_SHA = /^[a-f0-9]{40}$/
const MAX_TREE_BYTES = 512 * 1024 * 1024

export interface PinnedGitWorktreeTreeInput {
	worktree: string
	revision: string
	expectedTreeSha: string
}

interface TreeEntry { mode: number; objectId: string; relativePath: string }

/** Verify actual working-tree bytes and modes against one pinned Git tree; the index and worktree status are not trusted. */
export async function verifyPinnedGitWorktreeTree(input: PinnedGitWorktreeTreeInput): Promise<{ treeSha: string; fileCount: number; totalBytes: number }> {
	if (!input || !path.isAbsolute(input.worktree) || !/^[a-f0-9]{40}$/.test(input.revision) || !TREE_SHA.test(input.expectedTreeSha)) {
		throw new Error("pinned source tree identity is invalid")
	}
	const root = path.resolve(input.worktree)
	const rootStat = await fs.lstat(root)
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("pinned source workspace is not a real directory")
	const topResult = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
	if (topResult.error || topResult.status !== 0 || path.resolve(topResult.stdout.trim()) !== root) throw new Error("pinned source workspace is not the Git worktree root")
	const treeResult = spawnSync("git", ["-C", root, "rev-parse", `${input.revision}^{tree}`], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
	if (treeResult.error || treeResult.status !== 0) throw new Error("pinned source tree is unavailable")
	const treeSha = treeResult.stdout.trim()
	if (!TREE_SHA.test(treeSha) || treeSha !== input.expectedTreeSha) throw new Error("pinned source revision tree does not match the approved tree")
	const listing = spawnSync("git", ["-C", root, "ls-tree", "-r", "-z", "--full-tree", input.revision], { encoding: "buffer", timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })
	if (listing.error || listing.status !== 0 || !Buffer.isBuffer(listing.stdout)) throw new Error("pinned source tree listing is unavailable")
	const expected = new Map<string, TreeEntry>()
	for (const row of splitNul(listing.stdout)) {
		const separator = row.indexOf(9)
		if (separator < 0) throw new Error("pinned source tree listing is malformed")
		const header = row.subarray(0, separator).toString("ascii").match(/^(100644|100755) blob ([a-f0-9]{40})$/)
		if (!header) throw new Error("pinned source tree contains an unsupported file type")
		const relativePath = new TextDecoder("utf-8", { fatal: true }).decode(row.subarray(separator + 1))
		if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => !part || part === "." || part === "..") || relativePath.includes("\0")) {
			throw new Error("pinned source tree contains an invalid path")
		}
		if (expected.has(relativePath)) throw new Error("pinned source tree contains duplicate paths")
		expected.set(relativePath, { mode: Number.parseInt(header[1]!, 8), objectId: header[2]!, relativePath })
	}
	if (expected.size === 0) throw new Error("pinned source tree is empty")

	let totalBytes = 0
	const actual = new Set<string>()
	const walk = async (absolute: string, relative = ""): Promise<void> => {
		const names = await fs.readdir(absolute)
		for (const name of names) {
			if (!relative && name === ".git") {
				const metadata = await fs.lstat(path.join(absolute, name))
				if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) throw new Error("pinned source Git metadata is invalid")
				continue
			}
			const childRelative = relative ? `${relative}/${name}` : name
			const childPath = path.join(absolute, name)
			const st = await fs.lstat(childPath, { bigint: true })
			if (st.isSymbolicLink()) throw new Error("pinned source workspace contains a symbolic link")
			if (st.isDirectory()) {
				const hasTrackedDescendant = [...expected.keys()].some((item) => item.startsWith(`${childRelative}/`))
				if (!hasTrackedDescendant) throw new Error("pinned source workspace contains an unexpected directory")
				await walk(childPath, childRelative)
				continue
			}
			if (!st.isFile()) throw new Error("pinned source workspace contains an unsupported filesystem entry")
			const entry = expected.get(childRelative)
			if (!entry) throw new Error("pinned source workspace contains an unexpected file")
			const mode = Number(st.mode & 0o111n) === 0 ? 0o100644 : 0o100755
			if (mode !== entry.mode) throw new Error("pinned source workspace file mode differs from the approved tree")
			if (st.size > BigInt(MAX_TREE_BYTES) || totalBytes + Number(st.size) > MAX_TREE_BYTES) throw new Error("pinned source workspace exceeds the verification size limit")
			const digest = await hashGitBlob(childPath, st)
			if (digest !== entry.objectId) throw new Error("pinned source workspace bytes differ from the approved tree")
			totalBytes += Number(st.size)
			actual.add(childRelative)
		}
	}
	await walk(root)
	if (actual.size !== expected.size) throw new Error("pinned source workspace is missing tracked files")
	return { treeSha, fileCount: actual.size, totalBytes }
}

async function hashGitBlob(filePath: string, before: BigIntStats): Promise<string> {
	const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		const current = await file.stat({ bigint: true })
		if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size ||
			current.mode !== before.mode || current.mtimeNs !== before.mtimeNs) throw new Error("pinned source workspace changed during verification")
		const hash = createHash("sha1")
		hash.update(`blob ${current.size}\0`)
		const buffer = Buffer.allocUnsafe(64 * 1024)
		let bytes = 0n
		for (;;) {
			const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
			if (bytesRead === 0) break
			bytes += BigInt(bytesRead)
			hash.update(buffer.subarray(0, bytesRead))
		}
		const after = await file.stat({ bigint: true })
		if (bytes !== current.size || after.dev !== current.dev || after.ino !== current.ino || after.size !== current.size ||
			after.mode !== current.mode || after.mtimeNs !== current.mtimeNs) throw new Error("pinned source workspace changed during verification")
		return hash.digest("hex")
	} finally { await file.close() }
}

function splitNul(buffer: Buffer): Buffer[] {
	if (buffer.length === 0) return []
	if (buffer[buffer.length - 1] !== 0) throw new Error("pinned source tree listing is truncated")
	return buffer.subarray(0, -1).toString("binary").split("\0").map((row) => Buffer.from(row, "binary"))
}
