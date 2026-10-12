import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { benchmarkTreeDigest, loadBenchmark, materializeBenchmarkSnapshot } from "../runner.js"
import { loadBoundProofBenchmarkFixtures, loadProofBenchmarkFixtures } from "../proof-fixtures.js"
import { buildSnapshotPackage, MAX_SNAPSHOT_PACKAGE_BLOB_BYTES } from "../snapshot-package.js"
import type { BenchmarkSnapshotPackageDescriptor, BenchmarkTask } from "../types.js"

const scratchRoot = path.resolve(".headlesscode/scratch")
await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
const tempRoot = await fs.mkdtemp(path.join(scratchRoot, "rsi-snapshot-package-test-"))
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
const gitText = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const sourceRepo = path.join(tempRoot, "source")
const emptyRepo = path.join(tempRoot, "empty")
const fixtureRoot = path.join(tempRoot, "fixtures")
const packagePath = path.join(fixtureRoot, "snapshots")
const verifierPath = "verifiers/verify.mjs"

async function commitValue(value: string, message: string): Promise<string> {
	await fs.writeFile(path.join(sourceRepo, "value.txt"), value)
	git(sourceRepo, ["add", "--all"])
	git(sourceRepo, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", message])
	return gitText(sourceRepo, ["rev-parse", "HEAD"])
}

async function snapshotDigest(task: BenchmarkTask, commit: string, name: string): Promise<string> {
	const destination = path.join(tempRoot, name)
	await materializeBenchmarkSnapshot({ ...task, startCommit: commit }, sourceRepo, destination)
	try { return await benchmarkTreeDigest(destination) }
	finally { await fs.rm(destination, { recursive: true, force: true }) }
}

async function writeManifest(tasks: BenchmarkTask[], descriptor?: BenchmarkSnapshotPackageDescriptor, runnerVersion = "1.1.0"): Promise<void> {
	const manifest = { schemaVersion: 1, runnerVersion, createdFromCommit: tasks[0]!.startCommit!, ...(descriptor ? { snapshotPackage: descriptor } : {}), tasks }
	await fs.writeFile(path.join(fixtureRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function descriptorFor(indexPath = path.join(packagePath, "index.json"), relativePath = "snapshots"): Promise<BenchmarkSnapshotPackageDescriptor> {
	return { formatVersion: 1, path: relativePath, digest: sha256(await fs.readFile(indexPath)) }
}

try {
	await fs.mkdir(path.join(sourceRepo, "src"), { recursive: true })
	await fs.mkdir(path.join(sourceRepo, "value"), { recursive: true })
	await fs.writeFile(path.join(sourceRepo, "value", "child.txt"), "nested sibling-order check\n")
	await fs.mkdir(path.join(fixtureRoot, "verifiers"), { recursive: true })
	await fs.writeFile(path.join(sourceRepo, "value.txt"), "one\n")
	git(sourceRepo, ["init", "--quiet", "--initial-branch=main"])
	git(sourceRepo, ["config", "user.name", "Synthetic RSI snapshot test"])
	git(sourceRepo, ["config", "user.email", "synthetic-snapshot-test@invalid.example"])
	const startCommit = await commitValue("one\n", "snapshot start")
	const goodCommit = await commitValue("two\n", "known good")
	const badCommit = await commitValue("zero\n", "known bad")
	await fs.mkdir(emptyRepo, { recursive: true })
	git(emptyRepo, ["init", "--quiet", "--initial-branch=main"])
	await fs.writeFile(path.join(fixtureRoot, verifierPath), "// synthetic verifier\n")
	const scaffold: BenchmarkTask = {
		id: "dev-task-00", family: "family-0", split: "development", task: "synthetic development task",
		startCommit, startDigest: "0".repeat(64), verifierPath, verifierDigest: sha256(await fs.readFile(path.join(fixtureRoot, verifierPath))),
		knownGoodCommit: goodCommit, knownGoodDigest: "0".repeat(64), knownBadCommit: badCommit, knownBadDigest: "0".repeat(64),
		seed: 1, ceilings: { timeoutMs: 10_000, maxCalls: 1, maxOutputTokensPerCall: 32, maxPatchBytes: 4096 },
	}
	scaffold.startDigest = await snapshotDigest(scaffold, startCommit, "start-digest")
	scaffold.knownGoodDigest = await snapshotDigest(scaffold, goodCommit, "good-digest")
	scaffold.knownBadDigest = await snapshotDigest(scaffold, badCommit, "bad-digest")
	const tasks = Array.from({ length: 32 }, (_, index) => ({
		...scaffold,
		id: `${index < 16 ? "dev" : "conf"}-task-${String(index % 16).padStart(2, "0")}`,
		family: `family-${index % 4}`,
		split: index < 16 ? "development" as const : "confirmation" as const,
		task: `synthetic ${index < 16 ? "development" : "confirmation"} task ${index}`,
		seed: index + 1,
	}))
	const built = await buildSnapshotPackage(sourceRepo, tasks, packagePath)
	assert.equal(built.snapshotCount, 3)
	assert.equal(built.path, "snapshots")
	const descriptor = await descriptorFor()
	const originalIndex = await fs.readFile(path.join(packagePath, "index.json"))
	const index = JSON.parse(originalIndex.toString("utf8")) as { snapshots: Array<{ commit: string; treeDigest: string; entries: Array<{ path: string; size: number; blobSha256: string; gitBlobOid: string }> }> }
	const firstBlob = index.snapshots[0]!.entries[0]!.blobSha256
	await writeManifest(tasks, descriptor)
	await fs.symlink("snapshots", path.join(fixtureRoot, "linked-snapshots"), "dir")
	await writeManifest(tasks, { ...descriptor, path: "linked-snapshots" })
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /symlink/)
	await fs.unlink(path.join(fixtureRoot, "linked-snapshots"))
	await writeManifest(tasks, descriptor)

	const symlinkTarget = path.join(tempRoot, "symlink-blob-target")
	const symlinkedBlob = path.join(packagePath, "blobs", firstBlob)
	await fs.copyFile(symlinkedBlob, symlinkTarget)
	await fs.unlink(symlinkedBlob)
	await fs.symlink(symlinkTarget, symlinkedBlob)
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /symlink/)
	await fs.unlink(symlinkedBlob)
	await fs.copyFile(symlinkTarget, symlinkedBlob)
	await fs.writeFile(path.join(packagePath, "unexpected"), "unreferenced")
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /unreferenced files|too many filesystem entries/)
	await fs.unlink(path.join(packagePath, "unexpected"))

	const loaded = await loadBenchmark(fixtureRoot, emptyRepo)
	assert.ok(loaded.snapshotPackage, "new runner loads its explicitly pinned local package")
	assert.equal(loaded.snapshotPackage.digest, descriptor.digest)
	assert.ok(loaded.snapshotPackage.blobContents.size > 0, "package loading retains the exact bytes whose hashes and Git object identities were validated")
	const fixtureBinding = (await loadProofBenchmarkFixtures(fixtureRoot, emptyRepo)).binding
	assert.deepEqual(fixtureBinding.snapshotPackage, { path: "snapshots", digest: descriptor.digest })
	assert.equal((await loadBoundProofBenchmarkFixtures(fixtureBinding, emptyRepo)).snapshotPackage?.digest, descriptor.digest, "external manifest and package index match the frozen supervisor binding")
	const originalManifest = await fs.readFile(path.join(fixtureRoot, "manifest.json"))
	const changedManifest = JSON.parse(originalManifest.toString("utf8")) as { tasks: Array<{ task: string }> }
	changedManifest.tasks[0]!.task += " changed after admission"
	await fs.writeFile(path.join(fixtureRoot, "manifest.json"), `${JSON.stringify(changedManifest, null, 2)}\n`)
	await assert.rejects(loadBoundProofBenchmarkFixtures(fixtureBinding, emptyRepo), /proof benchmark manifest differs from its frozen binding/)
	await fs.writeFile(path.join(fixtureRoot, "manifest.json"), originalManifest)
	const verifierFile = path.join(fixtureRoot, verifierPath)
	const originalVerifier = await fs.readFile(verifierFile)
	await fs.writeFile(verifierFile, Buffer.concat([originalVerifier, Buffer.from("changed after admission")]))
	await assert.rejects(loadBoundProofBenchmarkFixtures(fixtureBinding, emptyRepo), /verifier digest mismatch/)
	await fs.writeFile(verifierFile, originalVerifier)
	const candidateRoot = path.join(tempRoot, "candidate-start")
	await materializeBenchmarkSnapshot(tasks[0]!, emptyRepo, candidateRoot, loaded.snapshotPackage)
	assert.equal(await fs.readFile(path.join(candidateRoot, "value.txt"), "utf8"), "one\n")
	assert.equal(await fs.access(path.join(candidateRoot, "verifiers")).then(() => true).catch(() => false), false, "package extraction contains only the requested source tree")
	assert.equal(await fs.access(path.join(candidateRoot, "snapshots")).then(() => true).catch(() => false), false, "operator package files are not copied into the candidate")
	await fs.rm(candidateRoot, { recursive: true, force: true })
	const mutatedBlob = path.join(packagePath, "blobs", firstBlob)
	const pinnedBlob = await fs.readFile(mutatedBlob)
	await fs.writeFile(mutatedBlob, Buffer.concat([pinnedBlob, Buffer.from("changed after this invocation loaded the package")]))
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /blob digest mismatch/, "a new loading invocation rejects changed package bytes")
	const cachedCandidate = path.join(tempRoot, "candidate-pinned-cache")
	await materializeBenchmarkSnapshot(tasks[0]!, emptyRepo, cachedCandidate, loaded.snapshotPackage)
	assert.equal(await fs.readFile(path.join(cachedCandidate, "value.txt"), "utf8"), "one\n", "materialization uses only the already-verified invocation-local bytes")
	await fs.rm(cachedCandidate, { recursive: true, force: true })
	await fs.writeFile(mutatedBlob, pinnedBlob)

	const blobPath = path.join(packagePath, "blobs", firstBlob)
	const originalBlob = await fs.readFile(blobPath)
	await fs.writeFile(blobPath, Buffer.concat([originalBlob, Buffer.from("corrupt")]))
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /blob digest mismatch/)
	await fs.writeFile(blobPath, originalBlob)

	await fs.writeFile(path.join(packagePath, "index.json"), Buffer.concat([originalIndex, Buffer.from(" ")]))
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /pinned snapshot package digest mismatch/)
	await assert.rejects(loadBoundProofBenchmarkFixtures(fixtureBinding, emptyRepo), /pinned snapshot package digest mismatch/, "execution validation rejects changed index bytes")
	await fs.writeFile(path.join(packagePath, "index.json"), originalIndex)

	const wrongBlobIdentity = JSON.parse(originalIndex.toString("utf8")) as typeof index
	const firstEntry = wrongBlobIdentity.snapshots[0]!.entries[0]!
	firstEntry.gitBlobOid = `${firstEntry.gitBlobOid[0] === "0" ? "1" : "0"}${firstEntry.gitBlobOid.slice(1)}`
	const wrongIdentityRaw = Buffer.from(`${JSON.stringify(wrongBlobIdentity, null, 2)}\n`)
	await fs.writeFile(path.join(packagePath, "index.json"), wrongIdentityRaw)
	await writeManifest(tasks, { ...descriptor, digest: sha256(wrongIdentityRaw) })
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /blob identity mismatch/)
	await fs.writeFile(path.join(packagePath, "index.json"), originalIndex)
	await writeManifest(tasks, descriptor)

	const conflictingPaths = JSON.parse(originalIndex.toString("utf8")) as typeof index
	const conflictingSnapshot = conflictingPaths.snapshots[0]!
	const directoryEntry = conflictingSnapshot.entries.find((entry) => entry.path.includes("/"))!
	const rootFileEntry = conflictingSnapshot.entries.find((entry) => !entry.path.includes("/"))
	assert.ok(rootFileEntry, "synthetic tree includes a root file that conflicts with a directory path")
	rootFileEntry.path = directoryEntry.path.slice(0, directoryEntry.path.indexOf("/"))
	const conflictingRaw = Buffer.from(`${JSON.stringify(conflictingPaths, null, 2)}\n`)
	await fs.writeFile(path.join(packagePath, "index.json"), conflictingRaw)
	await writeManifest(tasks, { ...descriptor, digest: sha256(conflictingRaw) })
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /file-directory path conflict/)
	await fs.writeFile(path.join(packagePath, "index.json"), originalIndex)
	await writeManifest(tasks, descriptor)

	const unsafeIndex = JSON.parse(originalIndex.toString("utf8")) as typeof index
	unsafeIndex.snapshots[0]!.entries[0]!.path = "../escape"
	const unsafeRaw = Buffer.from(`${JSON.stringify(unsafeIndex, null, 2)}\n`)
	await fs.writeFile(path.join(packagePath, "index.json"), unsafeRaw)
	await writeManifest(tasks, { ...descriptor, digest: sha256(unsafeRaw) })
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /invalid entry/)
	await fs.writeFile(path.join(packagePath, "index.json"), originalIndex)
	await writeManifest(tasks, descriptor)

	const oversizedIndex = JSON.parse(originalIndex.toString("utf8")) as typeof index
	oversizedIndex.snapshots[0]!.entries[0]!.size = MAX_SNAPSHOT_PACKAGE_BLOB_BYTES + 1
	const oversizedRaw = Buffer.from(`${JSON.stringify(oversizedIndex, null, 2)}\n`)
	await fs.writeFile(path.join(packagePath, "index.json"), oversizedRaw)
	await writeManifest(tasks, { ...descriptor, digest: sha256(oversizedRaw) })
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /invalid entry/)
	await fs.writeFile(path.join(packagePath, "index.json"), originalIndex)
	await writeManifest(tasks, descriptor)

	const incompleteIndex = JSON.parse(originalIndex.toString("utf8")) as typeof index
	incompleteIndex.snapshots.pop()
	const incompleteRaw = Buffer.from(`${JSON.stringify(incompleteIndex, null, 2)}\n`)
	await fs.writeFile(path.join(packagePath, "index.json"), incompleteRaw)
	await writeManifest(tasks, { ...descriptor, digest: sha256(incompleteRaw) })
	await assert.rejects(loadBenchmark(fixtureRoot, emptyRepo), /commit set/)
	await fs.writeFile(path.join(packagePath, "index.json"), originalIndex)
	await writeManifest(tasks, descriptor)

	const packageMissing = { ...descriptor, path: "missing-snapshot-package" }
	await writeManifest(tasks, packageMissing)
	await assert.rejects(loadBenchmark(fixtureRoot, sourceRepo), /ENOENT/, "a pinned package never falls back to available Git objects")
	await writeManifest(tasks, descriptor)

	const legacyManifestPath = path.join(fixtureRoot, "manifest.json")
	await writeManifest(tasks, undefined, "1.0.0")
	const legacyLoaded = await loadBenchmark(fixtureRoot, sourceRepo)
	assert.equal(legacyLoaded.snapshotPackage, undefined, "legacy manifests keep the explicit Git-object path")
	await fs.writeFile(legacyManifestPath, `${JSON.stringify({ schemaVersion: 1, runnerVersion: "1.0.0", createdFromCommit: startCommit, tasks, snapshotPackage: descriptor }, null, 2)}\n`)
	await assert.rejects(loadBenchmark(fixtureRoot, sourceRepo), /snapshot package bindings require/)
	console.log("Pinned snapshot package fresh-clone, digest, identity, path, size, isolation, and legacy-path checks passed")
} finally {
	await fs.rm(tempRoot, { recursive: true, force: true })
}
