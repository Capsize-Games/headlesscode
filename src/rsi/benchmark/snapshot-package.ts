import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import type { BenchmarkSnapshotPackageDescriptor, BenchmarkTask } from "./types.js"

export const RSI_SNAPSHOT_PACKAGE_VERSION = 1
export const MAX_SNAPSHOT_PACKAGE_INDEX_BYTES = 16 * 1024 * 1024
export const MAX_SNAPSHOT_PACKAGE_BYTES = 512 * 1024 * 1024
export const MAX_SNAPSHOT_PACKAGE_BLOBS = 100_000
export const MAX_SNAPSHOT_PACKAGE_SNAPSHOTS = 4_096
export const MAX_SNAPSHOT_PACKAGE_ENTRIES = 100_000
export const MAX_SNAPSHOT_PACKAGE_BLOB_BYTES = 32 * 1024 * 1024
export const MAX_SNAPSHOT_PACKAGE_TREE_BYTES = 256 * 1024 * 1024
const MAX_TREE_ENTRIES = 50_000
const MAX_BLOB_BYTES = MAX_SNAPSHOT_PACKAGE_BLOB_BYTES
const MAX_TREE_BYTES = MAX_SNAPSHOT_PACKAGE_TREE_BYTES
const MAX_EXPANDED_PACKAGE_BYTES = 512 * 1024 * 1024

interface SnapshotPackageEntry {
	path: string
	mode: 0o644 | 0o755
	gitBlobOid: string
	blobSha256: string
	size: number
}

interface SnapshotPackageTree {
	commit: string
	gitTreeOid: string
	treeDigest: string
	entries: SnapshotPackageEntry[]
}

interface SnapshotPackageIndex {
	formatVersion: 1
	snapshots: SnapshotPackageTree[]
}

export interface LoadedSnapshotPackage {
	root: string
	path: string
	digest: string
	snapshots: Map<string, SnapshotPackageTree>
}

export interface BuiltSnapshotPackage {
	formatVersion: 1
	path: string
	digest: string
	snapshotCount: number
	blobCount: number
	bytes: number
}

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex")
}

function hasExactlyKeys(value: object, keys: string[]): boolean {
	const actual = Object.keys(value).sort()
	const expected = [...keys].sort()
	return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function gitBlobOid(bytes: Buffer, oidLength: number): string {
	const algorithm = oidLength === 64 ? "sha256" : "sha1"
	return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

function safePackageRelative(value: string): boolean {
	return value.length > 0 && Buffer.byteLength(value) <= 4096 && Buffer.from(value).toString("utf8") === value && !/[\u0000-\u001f\u007f]/.test(value) && !value.includes("\\")
		&& !path.posix.isAbsolute(value) && !value.split("/").some((part) => Buffer.byteLength(part) > 255 || part === "" || part === "." || part === ".." || part === ".git")
}

function treeDigest(entries: Array<{ path: string; mode: 0o644 | 0o755; content: Buffer }>): string {
	const hash = createHash("sha256")
	const compareTreeOrder = (left: string, right: string): number => {
		const leftParts = left.split("/")
		const rightParts = right.split("/")
		for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
			const partOrder = Buffer.compare(Buffer.from(leftParts[index]!), Buffer.from(rightParts[index]!))
			if (partOrder !== 0) return partOrder
		}
		return leftParts.length - rightParts.length
	}
	for (const entry of entries.sort((a, b) => compareTreeOrder(a.path, b.path))) {
		hash.update(entry.path).update("\0").update(String(entry.mode)).update("\0").update(entry.content).update("\0")
	}
	return hash.digest("hex")
}

function expectedCommitDigests(tasks: BenchmarkTask[]): Map<string, string> {
	const expected = new Map<string, string>()
	for (const task of tasks) {
		for (const [commit, digest] of [[task.startCommit, task.startDigest], [task.knownGoodCommit, task.knownGoodDigest], [task.knownBadCommit, task.knownBadDigest]] as const) {
			if (!commit) continue
			if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid snapshot reference in task ${task.id}`)
			const prior = expected.get(commit)
			if (prior !== undefined && prior !== digest) throw new Error(`snapshot reference has conflicting digests: ${commit}`)
			expected.set(commit, digest)
		}
	}
	return expected
}

async function readRegularFile(root: string, relative: string, maximumBytes: number): Promise<Buffer> {
	if (!safePackageRelative(relative)) throw new Error(`unsafe snapshot package path: ${relative}`)
	const absolute = path.resolve(root, relative)
	if (!absolute.startsWith(root + path.sep)) throw new Error(`snapshot package path escaped its root: ${relative}`)
	let current = root
	for (const segment of relative.split("/")) {
		current = path.join(current, segment)
		const stat = await fs.lstat(current)
		if (stat.isSymbolicLink()) throw new Error(`snapshot package contains a symlink: ${relative}`)
		if (current !== absolute && !stat.isDirectory()) throw new Error(`snapshot package parent is not a directory: ${relative}`)
	}
	const noFollow = fsConstants.O_NOFOLLOW ?? 0
	const handle = await fs.open(absolute, fsConstants.O_RDONLY | noFollow)
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || stat.size > maximumBytes) throw new Error(`snapshot package file exceeds its limit or is not regular: ${relative}`)
		const chunks: Buffer[] = []
		let total = 0
		while (total <= maximumBytes) {
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total))
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
			if (bytesRead === 0) break
			total += bytesRead
			if (total > maximumBytes) throw new Error(`snapshot package file exceeds its limit: ${relative}`)
			chunks.push(chunk.subarray(0, bytesRead))
		}
		return Buffer.concat(chunks, total)
	} finally { await handle.close() }
}

async function assertPackageFileSet(root: string, packagePath: string, expectedFiles: Set<string>): Promise<void> {
	const packageRoot = path.resolve(root, packagePath)
	const found = new Set<string>()
	let visitedEntries = 0
	const visit = async (directory: string, prefix: string): Promise<void> => {
		const entries = await fs.opendir(directory)
		for await (const entry of entries) {
			if (++visitedEntries > expectedFiles.size + 1) throw new Error("snapshot package contains too many filesystem entries")
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name
			if (!safePackageRelative(relative)) throw new Error(`snapshot package contains an unsafe path: ${relative}`)
			const absolute = path.join(directory, entry.name)
			const stat = await fs.lstat(absolute)
			if (stat.isSymbolicLink()) throw new Error(`snapshot package contains a symlink: ${relative}`)
			if (entry.isDirectory()) {
				if (relative !== "blobs") throw new Error(`snapshot package contains an unexpected directory: ${relative}`)
				await visit(absolute, relative)
			}
			else if (entry.isFile()) {
				if (!expectedFiles.has(relative)) throw new Error("snapshot package contains missing or unreferenced files")
				found.add(relative)
			}
			else throw new Error(`snapshot package contains a special file: ${relative}`)
		}
	}
	const stat = await fs.lstat(packageRoot)
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("snapshot package path is not a regular directory")
	await visit(packageRoot, "")
	if (found.size !== expectedFiles.size || [...found].some((file) => !expectedFiles.has(file))) throw new Error("snapshot package contains missing or unreferenced files")
}

function parseIndex(raw: Buffer): SnapshotPackageIndex {
	let value: unknown
	try { value = JSON.parse(raw.toString("utf8")) } catch { throw new Error("snapshot package index is malformed") }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("snapshot package index is malformed")
	const index = value as SnapshotPackageIndex
	if (index.formatVersion !== RSI_SNAPSHOT_PACKAGE_VERSION || !Array.isArray(index.snapshots)) throw new Error("unsupported snapshot package format")
	if (!hasExactlyKeys(index, ["formatVersion", "snapshots"])) throw new Error("snapshot package index has unexpected fields")
	if (!raw.equals(Buffer.from(`${JSON.stringify(index, null, 2)}\n`))) throw new Error("snapshot package index is not canonical")
	return index
}

export async function loadSnapshotPackage(root: string, descriptor: BenchmarkSnapshotPackageDescriptor, tasks: BenchmarkTask[]): Promise<LoadedSnapshotPackage> {
	if (!descriptor || !hasExactlyKeys(descriptor, ["formatVersion", "path", "digest"]) || descriptor.formatVersion !== RSI_SNAPSHOT_PACKAGE_VERSION || !safePackageRelative(descriptor.path) || !/^[a-f0-9]{64}$/.test(descriptor.digest)) throw new Error("invalid pinned snapshot package descriptor")
	const fixtureRoot = path.resolve(root)
	const fixtureStat = await fs.lstat(fixtureRoot)
	if (!fixtureStat.isDirectory() || fixtureStat.isSymbolicLink()) throw new Error("snapshot package fixture root must be a regular directory")
	const indexPath = `${descriptor.path}/index.json`
	const rawIndex = await readRegularFile(fixtureRoot, indexPath, MAX_SNAPSHOT_PACKAGE_INDEX_BYTES)
	if (sha256(rawIndex) !== descriptor.digest) throw new Error("pinned snapshot package digest mismatch")
	const index = parseIndex(rawIndex)
	const expected = expectedCommitDigests(tasks)
	if (index.snapshots.length !== expected.size || index.snapshots.length > MAX_SNAPSHOT_PACKAGE_SNAPSHOTS) throw new Error("snapshot package commit set does not match benchmark manifest")
	const snapshots = new Map<string, SnapshotPackageTree>()
	const expectedFiles = new Set(["index.json"])
	let totalBytes = 0
	let totalEntries = 0
	let priorCommit = ""
	const blobSizes = new Map<string, number>()
	const blobGitOids = new Map<string, Set<string>>()
	for (const snapshot of index.snapshots) {
		if (!snapshot || !/^[a-f0-9]{40}$/.test(snapshot.commit) || snapshot.commit <= priorCommit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.gitTreeOid) || !/^[a-f0-9]{64}$/.test(snapshot.treeDigest) || !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_TREE_ENTRIES) throw new Error("snapshot package contains malformed or unordered snapshot metadata")
		if (!hasExactlyKeys(snapshot, ["commit", "gitTreeOid", "treeDigest", "entries"])) throw new Error("snapshot package snapshot has unexpected fields")
		priorCommit = snapshot.commit
		if (snapshots.has(snapshot.commit) || expected.get(snapshot.commit) !== snapshot.treeDigest) throw new Error("snapshot package contains an unexpected commit or tree digest")
		snapshots.set(snapshot.commit, snapshot)
		let snapshotBytes = 0
		let priorPath: Buffer | undefined
		const seenPaths = new Set<string>()
		for (const entry of snapshot.entries) {
			if (!entry || !safePackageRelative(entry.path) || Buffer.from(entry.path).toString("utf8") !== entry.path || entry.path.split("/").some((segment) => segment === ".git") || (entry.mode !== 0o644 && entry.mode !== 0o755) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.gitBlobOid) || !/^[a-f0-9]{64}$/.test(entry.blobSha256) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_BLOB_BYTES) throw new Error(`snapshot package contains an invalid entry: ${snapshot.commit}`)
			if (!hasExactlyKeys(entry, ["path", "mode", "gitBlobOid", "blobSha256", "size"])) throw new Error("snapshot package entry has unexpected fields")
			const pathBytes = Buffer.from(entry.path)
			if (priorPath && Buffer.compare(priorPath, pathBytes) >= 0) throw new Error(`snapshot package paths are duplicate or unordered: ${snapshot.commit}`)
			priorPath = pathBytes
			if (seenPaths.has(entry.path)) throw new Error(`snapshot package contains a duplicate path: ${snapshot.commit}`)
			for (let slash = entry.path.indexOf("/"); slash >= 0; slash = entry.path.indexOf("/", slash + 1)) {
				if (seenPaths.has(entry.path.slice(0, slash))) throw new Error(`snapshot package contains a file-directory path conflict: ${snapshot.commit}`)
			}
			seenPaths.add(entry.path)
			snapshotBytes += entry.size
			if (snapshotBytes > MAX_TREE_BYTES) throw new Error(`snapshot package snapshot exceeds materialization limits: ${snapshot.commit}`)
			const priorSize = blobSizes.get(entry.blobSha256)
			if (priorSize !== undefined && priorSize !== entry.size) throw new Error("snapshot package has conflicting blob sizes")
			blobSizes.set(entry.blobSha256, entry.size)
			const gitOids = blobGitOids.get(entry.blobSha256) ?? new Set<string>()
			gitOids.add(entry.gitBlobOid)
			blobGitOids.set(entry.blobSha256, gitOids)
			expectedFiles.add(`blobs/${entry.blobSha256}`)
			totalEntries++
		}
		totalBytes += snapshotBytes
	}
	if ([...expected.keys()].some((commit) => !snapshots.has(commit)) || blobSizes.size > MAX_SNAPSHOT_PACKAGE_BLOBS || totalEntries > MAX_SNAPSHOT_PACKAGE_ENTRIES) throw new Error("snapshot package is missing required commit snapshots or exceeds entry limits")
	const uniqueBytes = [...blobSizes.values()].reduce((sum, size) => sum + size, 0)
	if (uniqueBytes > MAX_SNAPSHOT_PACKAGE_BYTES || totalBytes > MAX_EXPANDED_PACKAGE_BYTES) throw new Error("snapshot package exceeds aggregate resource limits")
	await assertPackageFileSet(fixtureRoot, descriptor.path, expectedFiles)
	for (const [digest, size] of blobSizes) {
		const content = await readRegularFile(fixtureRoot, `${descriptor.path}/blobs/${digest}`, MAX_BLOB_BYTES)
		if (content.length !== size || sha256(content) !== digest) throw new Error(`snapshot package blob digest mismatch: ${digest}`)
		if ([...(blobGitOids.get(digest) ?? [])].some((oid) => gitBlobOid(content, oid.length) !== oid)) throw new Error(`snapshot package blob identity mismatch: ${digest}`)
	}
	return { root: fixtureRoot, path: descriptor.path, digest: descriptor.digest, snapshots }
}

export async function materializePackagedSnapshot(snapshotPackage: LoadedSnapshotPackage, commit: string, destination: string): Promise<void> {
	const snapshot = snapshotPackage.snapshots.get(commit)
	if (!snapshot) throw new Error(`pinned snapshot package is missing commit ${commit}`)
	await fs.mkdir(destination, { recursive: false, mode: 0o700 })
	let totalBytes = 0
	const digestEntries: Array<{ path: string; mode: 0o644 | 0o755; content: Buffer }> = []
	for (const entry of snapshot.entries) {
		if ((totalBytes += entry.size) > MAX_TREE_BYTES) throw new Error(`snapshot package snapshot exceeds materialization limits: ${commit}`)
		const content = await readRegularFile(snapshotPackage.root, `${snapshotPackage.path}/blobs/${entry.blobSha256}`, MAX_BLOB_BYTES)
		if (content.length !== entry.size || sha256(content) !== entry.blobSha256 || gitBlobOid(content, entry.gitBlobOid.length) !== entry.gitBlobOid) throw new Error(`snapshot package blob identity mismatch: ${commit}`)
		const target = path.resolve(destination, entry.path)
		if (!target.startsWith(destination + path.sep)) throw new Error(`snapshot package path escaped workspace: ${entry.path}`)
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
		await fs.writeFile(target, content, { mode: entry.mode, flag: "wx" })
		digestEntries.push({ path: entry.path, mode: entry.mode, content })
	}
	if (treeDigest(digestEntries) !== snapshot.treeDigest) throw new Error(`snapshot package tree digest mismatch: ${commit}`)
}

export async function buildSnapshotPackage(repoRoot: string, tasks: BenchmarkTask[], outputPath: string): Promise<BuiltSnapshotPackage> {
	const repository = path.resolve(repoRoot)
	const output = path.resolve(outputPath)
	const expected = expectedCommitDigests(tasks)
	if (expected.size === 0) throw new Error("benchmark manifest contains no commit-backed snapshots")
	const treeRows = new Map<string, Array<{ mode: 0o644 | 0o755; gitBlobOid: string; path: string }>>()
	const gitBlobIds = new Set<string>()
	for (const commit of [...expected.keys()].sort()) {
		const rawTree = execFileSync("git", ["ls-tree", "-rz", "-r", "--full-tree", commit], { cwd: repository, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }) as Buffer
		if (rawTree.length > 0 && rawTree[rawTree.length - 1] !== 0) throw new Error(`source snapshot tree is malformed: ${commit}`)
		const entries: Array<{ mode: 0o644 | 0o755; gitBlobOid: string; path: string }> = []
		let offset = 0
		while (offset < rawTree.length - 1) {
			const end = rawTree.indexOf(0, offset)
			if (end < 0 || entries.length >= MAX_TREE_ENTRIES) throw new Error(`source snapshot tree is malformed or too large: ${commit}`)
			const record = rawTree.subarray(offset, end)
			const tab = record.indexOf(0x09)
			const metadata = tab >= 0 ? record.toString("ascii", 0, tab) : ""
			const relativeBytes = tab >= 0 ? record.subarray(tab + 1) : Buffer.alloc(0)
			const relative = relativeBytes.toString("utf8")
			const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(metadata)
			if (!match || !Buffer.from(relative).equals(relativeBytes) || !safePackageRelative(relative)) throw new Error(`source snapshot contains an unsafe path, symlink, or submodule: ${commit}`)
			const mode = match[1] === "100755" ? 0o755 : 0o644
			entries.push({ mode, gitBlobOid: match[2]!, path: relative })
			gitBlobIds.add(match[2]!)
			offset = end + 1
		}
		if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error(`source snapshot contains duplicate paths: ${commit}`)
		treeRows.set(commit, entries)
	}
	if (gitBlobIds.size > MAX_SNAPSHOT_PACKAGE_BLOBS) throw new Error("source snapshots exceed package blob count limit")
	const batch = execFileSync("git", ["cat-file", "--batch"], { cwd: repository, input: Buffer.from([...gitBlobIds].join("\n") + "\n"), encoding: "buffer", maxBuffer: MAX_SNAPSHOT_PACKAGE_BYTES + 16 * 1024 * 1024 }) as Buffer
	const contentByGitOid = new Map<string, Buffer>()
	const digestByGitOid = new Map<string, string>()
	const sourceSizes = new Map<string, number>()
	let offset = 0
	let uniqueBytes = 0
	for (const oid of gitBlobIds) {
		const headerEnd = batch.indexOf(0x0a, offset)
		if (headerEnd < 0) throw new Error("source snapshot blob batch is malformed")
		const [reportedOid, type, rawSize] = batch.toString("ascii", offset, headerEnd).split(" ")
		const size = Number(rawSize)
		if (reportedOid !== oid || type !== "blob" || !Number.isSafeInteger(size) || size > MAX_BLOB_BYTES) throw new Error(`source snapshot blob exceeds package limits: ${oid}`)
		if ((uniqueBytes += size) > MAX_SNAPSHOT_PACKAGE_BYTES) throw new Error("source snapshots exceed package byte limit")
		const start = headerEnd + 1
		const end = start + size
		if (end >= batch.length || batch[end] !== 0x0a) throw new Error("source snapshot blob batch is truncated")
		const content = Buffer.from(batch.subarray(start, end))
		if (gitBlobOid(content, oid.length) !== oid) throw new Error(`source Git blob identity mismatch: ${oid}`)
		const digest = sha256(content)
		contentByGitOid.set(oid, content)
		digestByGitOid.set(oid, digest)
		sourceSizes.set(oid, size)
		offset = end + 1
	}
	if (offset !== batch.length) throw new Error("source snapshot blob batch contains trailing data")
	const snapshots: SnapshotPackageTree[] = []
	const packageBlobs = new Map<string, Buffer>()
	for (const [commit, entries] of treeRows) {
		let total = 0
		const packagedEntries = entries.map((entry) => {
			const content = contentByGitOid.get(entry.gitBlobOid)!
			if ((total += content.length) > MAX_TREE_BYTES) throw new Error(`source snapshot exceeds materialization limits: ${commit}`)
			const digest = digestByGitOid.get(entry.gitBlobOid)!
			packageBlobs.set(digest, content)
			return { path: entry.path, mode: entry.mode, gitBlobOid: entry.gitBlobOid, blobSha256: digest, size: sourceSizes.get(entry.gitBlobOid)! }
		})
		const digestEntries = entries.map((entry) => ({ path: entry.path, mode: entry.mode, content: contentByGitOid.get(entry.gitBlobOid)! }))
		const computedTreeDigest = treeDigest(digestEntries)
		if (expected.get(commit) !== computedTreeDigest) throw new Error(`source snapshot does not match benchmark tree digest: ${commit}`)
		const gitTreeOid = execFileSync("git", ["rev-parse", `${commit}^{tree}`], { cwd: repository, encoding: "utf8" }).trim()
		snapshots.push({ commit, gitTreeOid, treeDigest: computedTreeDigest, entries: packagedEntries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))) })
	}
	const index: SnapshotPackageIndex = { formatVersion: RSI_SNAPSHOT_PACKAGE_VERSION, snapshots }
	const rawIndex = Buffer.from(`${JSON.stringify(index, null, 2)}\n`)
	if (rawIndex.length > MAX_SNAPSHOT_PACKAGE_INDEX_BYTES) throw new Error("snapshot package index exceeds its size limit")
	await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
	await fs.mkdir(output, { recursive: false, mode: 0o700 })
	try {
		await fs.mkdir(path.join(output, "blobs"), { mode: 0o700 })
		for (const [digest, content] of packageBlobs) await fs.writeFile(path.join(output, "blobs", digest), content, { mode: 0o600, flag: "wx" })
		await fs.writeFile(path.join(output, "index.json"), rawIndex, { mode: 0o600, flag: "wx" })
	} catch (error) {
		await fs.rm(output, { recursive: true, force: true })
		throw error
	}
	return { formatVersion: RSI_SNAPSHOT_PACKAGE_VERSION, path: path.basename(output), digest: sha256(rawIndex), snapshotCount: snapshots.length, blobCount: packageBlobs.size, bytes: [...packageBlobs.values()].reduce((sum, content) => sum + content.length, 0) }
}
