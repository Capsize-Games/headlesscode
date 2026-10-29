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

/** Correct only Git's verified CRLF checkout conversion in a newly created, owned worktree. */
export async function restorePinnedWorktreeEolBytes(input: PinnedGitWorktreeTreeInput): Promise<number> {
	const { root, revision } = await validateRestoreInput(input)
	const entries = readPinnedEntries(root, revision)
	const eolValues = readEolAttributes(root, entries)
	let restored = 0
	for (let index = 0; index < entries.length; index++) {
		if (eolValues[index] === "crlf") restored += await restoreCrLfEntry(root, entries[index]!)
	}
	return restored
}

async function validateRestoreInput(input: PinnedGitWorktreeTreeInput): Promise<{ root: string; revision: string; expectedTreeSha: string }> {
	if (!validPinnedTreeInput(input)) throw new Error("pinned source tree identity is invalid")
	const root = path.resolve(input.worktree)
	await validateOwnedWorktreeRoot(root)
	validateGitWorktreeIdentity(root, input.revision, input.expectedTreeSha)
	return { root, revision: input.revision, expectedTreeSha: input.expectedTreeSha }
}

function validPinnedTreeInput(input: PinnedGitWorktreeTreeInput): boolean {
	return Boolean(input && path.isAbsolute(input.worktree) && /^[a-f0-9]{40}$/.test(input.revision) && TREE_SHA.test(input.expectedTreeSha))
}

async function validateOwnedWorktreeRoot(root: string): Promise<void> {
	const rootStat = await fs.lstat(root)
	const parent = await fs.lstat(path.dirname(root))
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("owned source workspace is invalid")
	if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Error("owned source worktree parent is invalid")
	if (typeof process.getuid === "function" && rootStat.uid !== process.getuid()) throw new Error("owned source workspace has the wrong owner")
	if (typeof process.getuid === "function" && parent.uid !== process.getuid()) throw new Error("owned source worktree parent has the wrong owner")
}

function validateGitWorktreeIdentity(root: string, revision: string, expectedTreeSha: string): void {
	if (path.resolve(runGit(root, ["rev-parse", "--show-toplevel"])) !== root) throw new Error("owned source workspace is not the Git worktree root")
	if (runGit(root, ["rev-parse", `${revision}^{tree}`]) !== expectedTreeSha) throw new Error("pinned source revision tree does not match the approved tree")
}

function readPinnedEntries(root: string, revision: string): Array<{ objectId: string; relativePath: string; mode: number }> {
	const listing = spawnSync("git", ["-C", root, "ls-tree", "-r", "-z", "--full-tree", revision], { encoding: "buffer", timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })
	if (listing.error || listing.status !== 0 || !Buffer.isBuffer(listing.stdout)) throw new Error("pinned source tree listing is unavailable")
	const entries = splitNul(listing.stdout).map(parseTreeEntry)
	if (!entries.length || entries.length > 100_000) throw new Error("pinned source tree entry count is outside the restore bound")
	return entries
}

function parseTreeEntry(row: Buffer): { objectId: string; relativePath: string; mode: number } {
	const separator = row.indexOf(9)
	if (separator < 0) throw new Error("pinned source tree listing is malformed")
	const header = row.subarray(0, separator).toString("ascii").match(/^(100644|100755) blob ([a-f0-9]{40})$/)
	if (!header) throw new Error("pinned source tree contains an unsupported file type")
	const relativePath = new TextDecoder("utf-8", { fatal: true }).decode(row.subarray(separator + 1))
	if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => !part || part === "." || part === "..") || relativePath.includes("\0")) {
		throw new Error("pinned source tree contains an invalid path")
	}
	return { relativePath, objectId: header[2]!, mode: Number.parseInt(header[1]!, 8) }
}

function readEolAttributes(root: string, entries: Array<{ relativePath: string }>): string[] {
	const attrResult = spawnSync("git", ["-C", root, "check-attr", "-z", "--stdin", "eol"], {
		input: Buffer.from(`${entries.map((entry) => entry.relativePath).join("\0")}\0`), encoding: "buffer", timeout: 20_000, maxBuffer: 64 * 1024 * 1024,
	})
	if (attrResult.error || attrResult.status !== 0 || !Buffer.isBuffer(attrResult.stdout)) throw new Error("source checkout attributes could not be verified")
	const attrs = splitNul(attrResult.stdout).map((field) => field.toString("utf8"))
	if (attrs.length !== entries.length * 3) throw new Error("source checkout attributes are malformed")
	return entries.map((entry, index) => {
		if (attrs[index * 3] !== entry.relativePath || attrs[index * 3 + 1] !== "eol") throw new Error("source checkout attributes do not match the pinned file list")
		return attrs[index * 3 + 2]!
	})
}

async function restoreCrLfEntry(root: string, entry: { objectId: string; relativePath: string; mode: number }): Promise<number> {
	const absolutePath = path.join(root, entry.relativePath)
	const before = await requireOwnedRegularPath(root, entry.relativePath, entry.mode)
	if (before.size > MAX_TREE_BYTES) throw new Error("owned source file exceeds the restore size bound")
	const expectedBytes = readPinnedBlob(root, entry.objectId)
	const actualBytes = await readOwnedFile(absolutePath, before)
	if (actualBytes.equals(expectedBytes)) return 0
	assertExactCrlfConversion(actualBytes, expectedBytes)
	await writeOwnedFile(absolutePath, entry, await requireOwnedRegularPath(root, entry.relativePath, entry.mode), expectedBytes)
	return 1
}

function assertExactCrlfConversion(actualBytes: Buffer, expectedBytes: Buffer): void {
	if (!actualBytes.equals(toCrlf(expectedBytes))) throw new Error("source checkout differs for a reason other than the pinned CRLF attribute")
}

function readPinnedBlob(root: string, objectId: string): Buffer {
	const result = spawnSync("git", ["-C", root, "cat-file", "blob", objectId], { encoding: "buffer", timeout: 10_000, maxBuffer: MAX_TREE_BYTES })
	if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error("pinned source blob is unavailable")
	if (result.stdout.length > MAX_TREE_BYTES) throw new Error("pinned source blob exceeds the restore size bound")
	return result.stdout
}

async function readOwnedFile(filePath: string, before: import("node:fs").Stats): Promise<Buffer> {
	const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		if (!sameOwnedFile(before, await file.stat())) throw new Error("owned source file changed during CRLF inspection")
		return await file.readFile()
	} finally { await file.close() }
}

async function writeOwnedFile(filePath: string, entry: { mode: number }, before: import("node:fs").Stats, bytes: Buffer): Promise<void> {
	const file = await fs.open(filePath, constants.O_WRONLY | constants.O_NOFOLLOW)
	try {
		if (!sameOwnedFile(before, await file.stat())) throw new Error("owned source file changed before CRLF restoration")
		await file.truncate(0)
		await file.writeFile(bytes)
		await file.chmod(entry.mode & 0o777)
	} finally { await file.close() }
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 })
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") throw new Error("pinned source Git metadata is unavailable")
	return result.stdout.trim()
}

async function requireOwnedRegularPath(root: string, relativePath: string, mode: number): Promise<import("node:fs").Stats> {
	const parts = relativePath.split("/")
	await validateOwnedParents(root, parts)
	const target = path.join(root, relativePath)
	const stat = await fs.lstat(target)
	validateOwnedFileStat(stat, mode)
	return stat
}

async function validateOwnedParents(root: string, parts: string[]): Promise<void> {
	let current = root
	for (const part of parts.slice(0, -1)) {
		current = path.join(current, part)
		const stat = await fs.lstat(current)
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("owned source path contains a non-directory parent")
	}
}

function validateOwnedFileStat(stat: import("node:fs").Stats, mode: number): void {
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("owned source target is not a regular file")
	const actualMode = (stat.mode & 0o111) === 0 ? 0o100644 : 0o100755
	if (actualMode !== mode) throw new Error("owned source target mode differs from the pinned tree")
	if (stat.nlink !== 1) throw new Error("owned source target has an unexpected hard link")
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("owned source target has the wrong owner")
}

function sameOwnedFile(before: import("node:fs").Stats, after: import("node:fs").Stats): boolean {
	return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
		before.mode === after.mode && before.nlink === after.nlink && before.uid === after.uid
}

function toCrlf(bytes: Buffer): Buffer {
	const out: number[] = []
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 10 && (i === 0 || bytes[i - 1] !== 13)) out.push(13)
		out.push(bytes[i]!)
	}
	return Buffer.from(out)
}

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
