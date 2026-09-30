import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { FileRsiArtifactStore } from "../artifact-store.js"
import type { BenchmarkAgent, BenchmarkAgentResult, BenchmarkAttempt, BenchmarkImageIdentity, BenchmarkManifest, BenchmarkResourceCeilings, BenchmarkSplit, BenchmarkTask } from "./types.js"

export const RSI_BENCHMARK_RUNNER_VERSION = "1.0.0"
const DEFAULT_FIXTURE_ROOT = path.resolve("fixtures/rsi-benchmark")
const DEFAULT_OUTPUT_ROOT = path.resolve(".headlesscode/rsi-benchmark")

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex")
}

function safeRelative(value: string): boolean {
	return value.length > 0 && !value.includes("\\") && !path.posix.isAbsolute(value) && !value.split("/").some((part) => part === "" || part === "." || part === "..")
}

export async function benchmarkTreeDigest(root: string): Promise<string> {
	const entries: Array<{ path: string; mode: number; content: Buffer }> = []
	const visit = async (directory: string, prefix: string): Promise<void> => {
		for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name
			if (!safeRelative(relative)) throw new Error(`unsafe benchmark fixture path: ${relative}`)
			const absolute = path.join(directory, entry.name)
			const stat = await fs.lstat(absolute)
			if (stat.isSymbolicLink()) throw new Error(`benchmark fixtures may not contain symlinks: ${relative}`)
			if (entry.isDirectory()) await visit(absolute, relative)
			else if (entry.isFile()) entries.push({ path: relative, mode: stat.mode & 0o111 ? 0o755 : 0o644, content: await fs.readFile(absolute) })
			else throw new Error(`benchmark fixtures may not contain special files: ${relative}`)
		}
	}
	await visit(root, "")
	const hash = createHash("sha256")
	for (const entry of entries) {
		hash.update(entry.path).update("\0").update(String(entry.mode)).update("\0").update(entry.content).update("\0")
	}
	return hash.digest("hex")
}

async function resolveFixture(root: string, relative: string): Promise<string> {
	if (!safeRelative(relative)) throw new Error(`unsafe benchmark manifest path: ${relative}`)
	const absolute = path.resolve(root, relative)
	if (!absolute.startsWith(root + path.sep)) throw new Error(`benchmark fixture path escaped root: ${relative}`)
	const stat = await fs.lstat(absolute)
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`benchmark fixture is not a regular file: ${relative}`)
	return absolute
}

async function resolveStartDirectory(root: string, relative: string): Promise<string> {
	if (!safeRelative(relative)) throw new Error(`unsafe benchmark manifest path: ${relative}`)
	const absolute = path.resolve(root, relative)
	if (!absolute.startsWith(root + path.sep)) throw new Error(`benchmark fixture path escaped root: ${relative}`)
	const stat = await fs.lstat(absolute)
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`benchmark start snapshot is not a regular directory: ${relative}`)
	return absolute
}

function parseManifest(raw: string): BenchmarkManifest {
	const manifest = JSON.parse(raw) as BenchmarkManifest
	if (manifest.schemaVersion !== 1 || manifest.runnerVersion !== RSI_BENCHMARK_RUNNER_VERSION || !Array.isArray(manifest.tasks)) throw new Error("unsupported RSI benchmark manifest")
	const ids = new Set<string>()
	for (const task of manifest.tasks) {
		if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(task.id) || ids.has(task.id)) throw new Error(`invalid or duplicate benchmark task id: ${task.id}`)
		ids.add(task.id)
		if (!task.family.trim() || (task.split !== "development" && task.split !== "confirmation") || !task.task.trim()) throw new Error(`malformed benchmark task ${task.id}`)
		if ((!task.startCommit || !/^[a-f0-9]{40}$/.test(task.startCommit)) && (!task.startPath || !safeRelative(task.startPath)) || ![task.startDigest, task.verifierDigest].every((value) => /^[a-f0-9]{64}$/.test(value))) throw new Error(`invalid digest or snapshot source in task ${task.id}`)
		if (![task.knownGoodDigest, task.knownBadDigest].every((value) => /^[a-f0-9]{64}$/.test(value)) || (!task.knownGoodPath && !task.knownGoodCommit) || (!task.knownBadPath && !task.knownBadCommit)) throw new Error(`invalid solution oracle in task ${task.id}`)
		for (const oracleCommit of [task.knownGoodCommit, task.knownBadCommit]) if (oracleCommit && !/^[a-f0-9]{40}$/.test(oracleCommit)) throw new Error(`invalid solution commit in task ${task.id}`)
		if (task.provenance && (![task.provenance.fixCommit, task.provenance.startCommit].every((value) => /^[a-f0-9]{40}$/.test(value)) || !task.provenance.subject.trim() || (task.provenance.verifierCommit && !/^[a-f0-9]{40}$/.test(task.provenance.verifierCommit)) || !Array.isArray(task.provenance.verifierPaths) || task.provenance.verifierPaths.length < 1)) throw new Error(`invalid provenance in task ${task.id}`)
		if (!Number.isSafeInteger(task.seed) || task.seed < 0 || !validCeilings(task.ceilings)) throw new Error(`invalid seed or resource ceilings in task ${task.id}`)
	}
	for (const split of ["development", "confirmation"] as const) {
		const tasks = manifest.tasks.filter((task) => task.split === split)
		if (tasks.length < 16) throw new Error(`${split} split must contain at least 16 tasks`)
		if (new Set(tasks.map((task) => task.family)).size < 4) throw new Error(`${split} split must cover at least four task families`)
	}
	return manifest
}

function validCeilings(value: BenchmarkResourceCeilings): boolean {
	return value !== null && [value.timeoutMs, value.maxCalls, value.maxOutputTokensPerCall, value.maxPatchBytes].every((n) => Number.isSafeInteger(n) && n > 0)
}

export interface LoadedBenchmark {
	manifest: BenchmarkManifest
	manifestDigest: string
	fixtureRoot: string
	repoRoot: string
	rawManifest: string
}

export async function materializeBenchmarkSnapshot(task: BenchmarkTask, repoRoot: string, destination: string): Promise<void> {
	if (!task.startCommit) throw new Error(`benchmark task ${task.id} has no immutable source commit`)
	await fs.mkdir(destination, { recursive: false, mode: 0o700 })
	const tree = execFileSync("git", ["ls-tree", "-rz", "-r", "--full-tree", task.startCommit], { cwd: repoRoot, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }) as Buffer
	const records = tree.toString("utf8").split("\0")
	if (records.at(-1) !== "" || records.length > 50_001) throw new Error(`benchmark snapshot tree is malformed or too large: ${task.id}`)
	const parsed: Array<{ mode: string; oid: string; relative: string }> = []
	for (const record of records.slice(0, -1)) {
		const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(record)
		const relative = match?.[3] ?? ""
		if (!match || !safeRelative(relative) || relative.split("/").some((part) => part === ".git")) throw new Error(`benchmark snapshot contains an unsafe path, symlink, or submodule: ${task.id}`)
		parsed.push({ mode: match[1]!, oid: match[2]!, relative })
	}
	const batch = execFileSync("git", ["cat-file", "--batch"], { cwd: repoRoot, input: Buffer.from(parsed.map((entry) => entry.oid).join("\n") + "\n"), encoding: "buffer", maxBuffer: 272 * 1024 * 1024 }) as Buffer
	let offset = 0
	let totalBytes = 0
	for (const entry of parsed) {
		const headerEnd = batch.indexOf(0x0a, offset)
		if (headerEnd < 0) throw new Error(`benchmark snapshot blob batch is malformed: ${task.id}`)
		const header = batch.toString("ascii", offset, headerEnd).split(" ")
		const blobSize = Number(header[2])
		if (header[0] !== entry.oid || header[1] !== "blob" || !Number.isSafeInteger(blobSize) || blobSize > 32 * 1024 * 1024 || (totalBytes += blobSize) > 256 * 1024 * 1024) throw new Error(`benchmark snapshot exceeds materialization limits: ${task.id}`)
		const contentStart = headerEnd + 1
		const contentEnd = contentStart + blobSize
		if (contentEnd >= batch.length || batch[contentEnd] !== 0x0a) throw new Error(`benchmark snapshot blob batch is truncated: ${task.id}`)
		const content = batch.subarray(contentStart, contentEnd)
		const target = path.resolve(destination, entry.relative)
		if (!target.startsWith(destination + path.sep)) throw new Error(`benchmark snapshot path escaped workspace: ${entry.relative}`)
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
		await fs.writeFile(target, content, { mode: entry.mode === "100755" ? 0o755 : 0o644, flag: "wx" })
		offset = contentEnd + 1
	}
	if (offset !== batch.length) throw new Error(`benchmark snapshot blob batch has trailing data: ${task.id}`)
}

export async function loadBenchmark(fixtureRoot = DEFAULT_FIXTURE_ROOT, repoRoot = process.cwd()): Promise<LoadedBenchmark> {
	const root = path.resolve(fixtureRoot)
	const repository = path.resolve(repoRoot)
	const manifestPath = path.join(root, "manifest.json")
	const rawManifest = await fs.readFile(manifestPath, "utf8")
	const manifest = parseManifest(rawManifest)
	for (const task of manifest.tasks) {
		const verifier = await resolveFixture(root, task.verifierPath)
		const knownGood = task.knownGoodPath ? await resolveFixture(root, task.knownGoodPath) : undefined
		const knownBad = task.knownBadPath ? await resolveFixture(root, task.knownBadPath) : undefined
		const snapshot = await fs.mkdtemp(path.join(os.tmpdir(), `headlesscode-benchmark-snapshot-${task.id}-`))
		try {
			if (task.startCommit) {
				await fs.rmdir(snapshot)
				await materializeBenchmarkSnapshot(task, repository, snapshot)
			} else {
				const start = await resolveStartDirectory(root, task.startPath!)
				await fs.cp(start, snapshot, { recursive: true, force: false, dereference: false })
			}
			if (await benchmarkTreeDigest(snapshot) !== task.startDigest) throw new Error(`benchmark start snapshot digest mismatch for ${task.id}`)
		} finally { await fs.rm(snapshot, { recursive: true, force: true }) }
		if (sha256(await fs.readFile(verifier)) !== task.verifierDigest) throw new Error(`benchmark verifier digest mismatch for ${task.id}`)
		for (const [commit, filePath, expected, name] of [[task.knownGoodCommit, knownGood, task.knownGoodDigest, "known-good"], [task.knownBadCommit, knownBad, task.knownBadDigest, "known-bad"]] as const) {
			if (commit) {
				const oracle = await fs.mkdtemp(path.join(os.tmpdir(), `headlesscode-benchmark-${name}-${task.id}-`))
				try { await fs.rmdir(oracle); await materializeBenchmarkSnapshot({ ...task, startCommit: commit }, repository, oracle); if (await benchmarkTreeDigest(oracle) !== expected) throw new Error(`benchmark ${name} tree digest mismatch for ${task.id}`) }
				finally { await fs.rm(oracle, { recursive: true, force: true }) }
			} else if (!filePath || sha256(await fs.readFile(filePath)) !== expected) throw new Error(`benchmark ${name} oracle digest mismatch for ${task.id}`)
		}
	}
	return { manifest, manifestDigest: sha256(rawManifest), fixtureRoot: root, repoRoot: repository, rawManifest }
}

export interface BenchmarkVerifier {
	run(task: BenchmarkTask, fixtureRoot: string, workspace: string): Promise<{ success: boolean; output: string }>
}

async function copyStartSnapshot(task: BenchmarkTask, loaded: LoadedBenchmark, workspace: string): Promise<void> {
	if (task.startCommit) {
		await fs.rmdir(workspace)
		await materializeBenchmarkSnapshot(task, loaded.repoRoot, workspace)
	}
	else {
		const start = await resolveStartDirectory(loaded.fixtureRoot, task.startPath!)
		await fs.cp(start, workspace, { recursive: true, force: false, dereference: false })
	}
	const stat = await fs.lstat(workspace)
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("benchmark workspace is not a regular directory")
}

class PatchImportError extends Error {}

async function applyPatch(workspace: string, patch: Buffer, maxBytes: number): Promise<void> {
	if (!patch.length || patch.length > maxBytes) throw new PatchImportError("agent patch is empty or exceeds the task limit")
	const root = await fs.realpath(workspace)
	const temporary = path.join(os.tmpdir(), `rsi-bench-${randomUUID()}.patch`)
	try {
		await fs.writeFile(temporary, patch, { mode: 0o600, flag: "wx" })
		const check = await runGit(["apply", "--check", "--index", temporary], root)
		if (check.code !== 0) throw new PatchImportError(`agent patch is malformed or contains a path escape: ${check.stderr.slice(0, 1000)}`)
		const applied = await runGit(["apply", "--index", temporary], root)
		if (applied.code !== 0) throw new PatchImportError(`agent patch could not be applied: ${applied.stderr.slice(0, 1000)}`)
		const raw = await runGit(["diff", "--cached", "--raw", "-z", "--no-renames", "HEAD"], root)
		const records = raw.stdout.split("\0")
		if (records.at(-1) !== "") throw new PatchImportError("agent patch produced malformed Git metadata")
		for (let index = 0; index < records.length - 1; index += 2) {
			const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(records[index] ?? "")
			const relative = records[index + 1] ?? ""
			if (!match || !safeRelative(relative) || relative.split("/").some((part) => part === ".git") || relative.startsWith("__rsi_benchmark_verifier__/")) throw new PatchImportError("agent patch contains malformed or reserved path metadata")
			if (match[3] !== "D" && match[2] !== "100644" && match[2] !== "100755") throw new PatchImportError(`agent patch added a symlink or special file: ${relative}`)
			const target = path.resolve(root, relative)
			if (!target.startsWith(root + path.sep)) throw new PatchImportError(`agent patch path escaped its task workspace: ${relative}`)
			try { if ((await fs.lstat(target)).isSymbolicLink()) throw new PatchImportError(`agent patch created a symlink: ${relative}`) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
		}
		const commit = await runGit(["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "benchmark agent result"], root)
		if (commit.code !== 0) throw new PatchImportError(`agent patch could not be committed: ${commit.stderr.slice(0, 1000)}`)
	} catch (error) {
		await runGit(["reset", "--hard", "HEAD"], root)
		throw error
	} finally { await fs.rm(temporary, { force: true }) }
}

async function runGit(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir() } })
		let stdout = ""; let stderr = ""
		child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk })
		child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { stderr += chunk })
		child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr }))
	})
}

export interface RunBenchmarkOptions {
	loaded: LoadedBenchmark
	agent: BenchmarkAgent
	verifier: BenchmarkVerifier
	harnessCommit: string
	modelId: string
	sampling?: Record<string, number | string | boolean>
	split?: BenchmarkSplit
	outputRoot?: string
	confirmProtocol?: boolean
	taskIds?: string[]
	agentImageIdentity?: BenchmarkImageIdentity | null
}

async function artifactByDigest(store: FileRsiArtifactStore, root: string, digest: string): Promise<Buffer> {
	if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("attempt contains an invalid artifact digest")
	const objectKey = `sha256/${digest.slice(0, 2)}/${digest}`
	const file = path.join(root, objectKey)
	const stat = await fs.lstat(file)
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`attempt artifact is missing or not a regular file: ${digest}`)
	return store.get({ sha256: digest, byteLength: stat.size, objectKey, backend: "file", storageId: `file:${path.resolve(root)}` })
}

async function applyAndVerify(task: BenchmarkTask, loaded: LoadedBenchmark, workspace: string, patch: Buffer, verifier: BenchmarkVerifier): Promise<{ success: boolean; output: string }> {
	await applyPatch(workspace, patch, task.ceilings.maxPatchBytes)
	return verifier.run(task, loaded.fixtureRoot, workspace)
}

function cellId(loaded: LoadedBenchmark, task: BenchmarkTask, options: RunBenchmarkOptions, sampling: Record<string, number | string | boolean>, agentImage: BenchmarkImageIdentity | null): string {
	return sha256(JSON.stringify([loaded.manifestDigest, task.id, options.harnessCommit, agentImage, options.agent.provider, options.modelId, sampling, task.seed]))
}

export async function freezeBenchmarkProtocol(options: Omit<RunBenchmarkOptions, "agent" | "verifier" | "split" | "confirmProtocol" | "taskIds"> & { provider: string }): Promise<string> {
	const sampling = options.sampling ?? { temperature: 0, think: false, seed: "provider-default" }
	const agentImage = options.agentImageIdentity ?? null
	if (agentImage && agentImage.harnessCommit !== options.harnessCommit) throw new Error("benchmark image identity does not match the requested harness commit")
	const record = { schemaVersion: 2, manifestDigest: options.loaded.manifestDigest, harnessCommit: options.harnessCommit, agentImage, provider: options.provider, modelId: options.modelId, sampling, runnerVersion: options.loaded.manifest.runnerVersion }
	const protocolDigest = sha256(JSON.stringify(record))
	const root = path.resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT)
	await fs.mkdir(root, { recursive: true, mode: 0o700 })
	const target = path.join(root, "frozen-protocol.json")
	try { await fs.access(target); throw new Error("benchmark protocol is already frozen; use a new output directory to freeze a new protocol") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
	await fs.writeFile(target, `${JSON.stringify({ ...record, protocolDigest }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
	return protocolDigest
}

async function readFrozenProtocol(options: RunBenchmarkOptions, agentImage: BenchmarkImageIdentity | null): Promise<void> {
	const file = path.join(path.resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT), "frozen-protocol.json")
	const frozen = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
	const expected = { schemaVersion: 2, manifestDigest: options.loaded.manifestDigest, harnessCommit: options.harnessCommit, agentImage, provider: options.agent.provider, modelId: options.modelId, sampling: options.sampling ?? { temperature: 0, think: false, seed: "provider-default" }, runnerVersion: options.loaded.manifest.runnerVersion }
	if (JSON.stringify(Object.fromEntries(Object.keys(expected).map((key) => [key, frozen[key]]))) !== JSON.stringify(expected)) throw new Error("confirmation run does not match the frozen benchmark protocol")
	const digest = sha256(JSON.stringify(expected))
	if (frozen.protocolDigest !== digest) throw new Error("frozen benchmark protocol digest mismatch")
}

async function loadReplayResult(filename: string): Promise<BenchmarkAgentResult> {
	const value = JSON.parse(await fs.readFile(filename, "utf8")) as BenchmarkAgentResult & { patchBase64?: string }
	if (!value || !["valid", "malformed", "missing", "timeout", "agent-error", "patch-error", "verifier-error"].includes(value.validity) || typeof value.stdout !== "string" || typeof value.stderr !== "string" || typeof value.stopReason !== "string") throw new Error("replay result is malformed")
	return { ...value, patch: value.patchBase64 ? Buffer.from(value.patchBase64, "base64") : undefined }
}

function validateExistingAttempt(existing: BenchmarkAttempt, task: BenchmarkTask, options: RunBenchmarkOptions, split: BenchmarkSplit, attemptId: string, sampling: Record<string, number | string | boolean>, agentImage: BenchmarkImageIdentity | null): void {
	const expected = {
		schemaVersion: 1,
		manifestDigest: options.loaded.manifestDigest,
		taskId: task.id,
		split,
		attemptId,
		harnessCommit: options.harnessCommit,
		agentImage,
		model: { provider: options.agent.provider, id: options.modelId, sampling },
		seed: task.seed,
		family: task.family,
		startDigest: task.startDigest,
		ceilings: task.ceilings,
		evaluatorDigest: task.verifierDigest,
	}
	for (const [key, value] of Object.entries(expected)) {
		if (JSON.stringify((existing as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)) throw new Error(`existing benchmark attempt metadata mismatch: ${key}`)
	}
	if (!Number.isSafeInteger(existing.wallTimeMs) || existing.wallTimeMs < 0 || existing.wallTimeMs > task.ceilings.timeoutMs) throw new Error("existing benchmark attempt has invalid wall-time accounting")
	if (![existing.calls, existing.tokens].every((count) => count === null || (Number.isSafeInteger(count) && count >= 0))) throw new Error("existing benchmark attempt has invalid resource counters")
	if (existing.resourceAccounting !== (existing.calls !== null && existing.tokens !== null ? "guest-reported" : "incomplete")) throw new Error("existing benchmark attempt resource-accounting status is inconsistent")
	if (existing.proofQualified !== false) throw new Error("existing benchmark attempt cannot claim aggregate-token proof qualification")
	if (!existing.artifactRefs || typeof existing.artifactRefs !== "object" || !/^[a-f0-9]{64}$/.test(existing.artifactRefs.stdout) || !/^[a-f0-9]{64}$/.test(existing.artifactRefs.stderr)) throw new Error("existing benchmark attempt has invalid artifact references")
	if ((existing.artifactRefs.patch ?? null) !== existing.patchDigest || (existing.patchDigest !== null && !/^[a-f0-9]{64}$/.test(existing.patchDigest))) throw new Error("existing benchmark attempt patch digest is inconsistent")
	if (existing.verifiedSuccess && (existing.validity !== "valid" || !existing.patchDigest)) throw new Error("existing benchmark attempt claims success without a valid patch")
	if (existing.validity !== "valid" && existing.verifiedSuccess) throw new Error("non-valid benchmark attempt cannot be marked successful")
}

export async function runBenchmark(options: RunBenchmarkOptions & { replayFile?: string }): Promise<BenchmarkAttempt[]> {
	const split = options.split ?? "development"
	if (split === "confirmation" && !options.confirmProtocol) throw new Error("confirmation split requires the explicit confirmation command")
	const agentImage = options.agentImageIdentity ?? await options.agent.imageIdentity?.(options.harnessCommit) ?? null
	if (agentImage && agentImage.harnessCommit !== options.harnessCommit) throw new Error("benchmark image identity does not match the requested harness commit")
	if (split === "confirmation") await readFrozenProtocol(options, agentImage)
	const tasks = options.loaded.manifest.tasks.filter((task) => task.split === split && (!options.taskIds || options.taskIds.includes(task.id)))
	if (tasks.length === 0) throw new Error(`benchmark ${split} split is empty; empty evaluations are not success`)
	const outputRoot = path.resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT)
	const artifacts = new FileRsiArtifactStore(path.join(outputRoot, "artifacts"), 256 * 1024 * 1024)
	const sampling = options.sampling ?? { temperature: 0, think: false, seed: "provider-default" }
	const attempts: BenchmarkAttempt[] = []
	for (const task of tasks) {
			const attemptId = cellId(options.loaded, task, options, sampling, agentImage)
			const attemptPath = path.join(outputRoot, "attempts", `${attemptId}.json`)
			await fs.mkdir(path.dirname(attemptPath), { recursive: true, mode: 0o700 })
			const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `headlesscode-rsi-bench-${task.id}-`))
			try {
			let existing: BenchmarkAttempt | undefined
			try {
				existing = JSON.parse(await fs.readFile(attemptPath, "utf8")) as BenchmarkAttempt
				validateExistingAttempt(existing, task, options, split, attemptId, sampling, agentImage)
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await fs.rm(workspace, { recursive: true, force: true }); throw error } }
			let result: BenchmarkAgentResult
			let verifiedSuccess = false
			let failure: string | undefined
			let patchDigest: string | null = null
			let patchArtifact: string | undefined
			let evaluatorOutput = ""
			try {
				await fs.rm(workspace, { recursive: true, force: true })
				await copyStartSnapshot(task, options.loaded, workspace)
				const { initializeTaskRepository } = await import("./openshell-agent.js")
				await initializeTaskRepository(workspace)
				if (existing) {
					const [stdout, stderr] = await Promise.all([
						artifactByDigest(artifacts, path.join(outputRoot, "artifacts"), existing.artifactRefs.stdout),
						artifactByDigest(artifacts, path.join(outputRoot, "artifacts"), existing.artifactRefs.stderr),
					])
					if (stdout.byteLength > 256 * 1024 * 1024 || stderr.byteLength > 256 * 1024 * 1024) throw new Error("recorded output artifact is oversized")
					if (existing.artifactRefs.patch) {
						if (existing.patchDigest !== existing.artifactRefs.patch) throw new Error("recorded benchmark patch digest reference mismatch")
						const patch = await artifactByDigest(artifacts, path.join(outputRoot, "artifacts"), existing.artifactRefs.patch)
						if (sha256(patch) !== existing.patchDigest) throw new Error("recorded benchmark patch digest mismatch")
						if (existing.validity === "patch-error") {
							let rejected = false
							try { await applyPatch(workspace, patch, task.ceilings.maxPatchBytes) } catch (error) { if (!(error instanceof PatchImportError)) throw error; rejected = true }
						if (!rejected || existing.verifiedSuccess) throw new Error("recorded patch-error no longer matches its patch importer result")
					} else if (existing.validity === "valid") {
						const checked = await applyAndVerify(task, options.loaded, workspace, patch, options.verifier)
						if (checked.success !== existing.verifiedSuccess) throw new Error("recorded benchmark attempt no longer matches its independent verifier result")
					} else throw new Error("recorded benchmark attempt has a patch artifact for an unsupported result class")
					} else if (existing.patchDigest !== null || existing.verifiedSuccess) throw new Error("recorded successful benchmark attempt is missing its patch")
					attempts.push(existing)
					await fs.rm(workspace, { recursive: true, force: true })
					continue
				}
			} catch (error) {
				if (existing) {
					await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 })
					await fs.appendFile(path.join(outputRoot, "invalid-replays.jsonl"), `${JSON.stringify({ attemptId, taskId: task.id, error: error instanceof Error ? error.message : String(error) })}\n`, { mode: 0o600 })
					await fs.rm(workspace, { recursive: true, force: true })
					throw error
				}
				throw error
			}
			result = options.replayFile ? await loadReplayResult(options.replayFile) : await options.agent.run({
				taskId: task.id, task: task.task, seed: task.seed, workspace, harnessCommit: options.harnessCommit,
				model: { provider: options.agent.provider, id: options.modelId, sampling }, ceilings: task.ceilings,
			})
			if (result.validity === "valid" && result.patch) {
				if (!Number.isSafeInteger(result.wallTimeMs) || result.wallTimeMs < 0 || ![result.calls, result.tokens].every((count) => count === null || (Number.isSafeInteger(count) && count >= 0))) throw new Error("agent result contained invalid resource observations")
			}
			if (result.validity === "valid" && result.patch) {
				patchDigest = sha256(result.patch)
				if (result.patch.byteLength > task.ceilings.maxPatchBytes) throw new Error("agent patch exceeded the task patch limit")
				try { await applyPatch(workspace, result.patch, task.ceilings.maxPatchBytes) }
				catch (error) {
					if (!(error instanceof PatchImportError)) throw error
					result = { ...result, validity: "patch-error" }; failure = error.message
				}
				if (result.validity === "valid") {
					const verified = await options.verifier.run(task, options.loaded.fixtureRoot, workspace)
					verifiedSuccess = verified.success
					evaluatorOutput = verified.output
					if (!verified.success) failure = "independent verifier rejected the imported result"
				}
			} else if (!failure) failure = result.validity !== "valid" ? `agent completion validity: ${result.validity}` : "agent returned no patch"
			if (options.replayFile) await fs.rm(workspace, { recursive: true, force: true })
			const [stdoutArtifact, stderrArtifact, patchRef] = await Promise.all([
				artifacts.put(Buffer.from(result.stdout)), artifacts.put(Buffer.from(`${result.stderr}${evaluatorOutput ? `\n[verifier]\n${evaluatorOutput}` : ""}`)),
				result.patch ? artifacts.put(result.patch) : Promise.resolve(undefined),
			])
			if (patchRef) patchArtifact = patchRef.sha256
			const attempt: BenchmarkAttempt = {
				schemaVersion: 1, manifestDigest: options.loaded.manifestDigest, taskId: task.id, split, attemptId,
				harnessCommit: options.harnessCommit, agentImage, model: { provider: options.agent.provider, id: options.modelId, sampling }, seed: task.seed,
				family: task.family, startDigest: task.startDigest, ceilings: task.ceilings,
				verifiedSuccess, proofQualified: false, resourceAccounting: result.calls !== null && result.tokens !== null ? "guest-reported" : "incomplete",
				validity: result.validity, calls: result.calls, tokens: result.tokens, wallTimeMs: result.wallTimeMs,
				stopReason: result.stopReason, patchDigest, evaluatorDigest: task.verifierDigest,
				artifactRefs: { ...(patchArtifact ? { patch: patchArtifact } : {}), stdout: stdoutArtifact.sha256, stderr: stderrArtifact.sha256 },
				...(failure ? { failure } : {}),
			}
			await fs.writeFile(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`, { mode: 0o600, flag: "wx" })
			attempts.push(attempt)
			} finally { await fs.rm(workspace, { recursive: true, force: true }) }
	}
	const report = {
		schemaVersion: 1, runnerVersion: options.loaded.manifest.runnerVersion, manifestDigest: options.loaded.manifestDigest,
		split, harnessCommit: options.harnessCommit, agentImage, model: { provider: options.agent.provider, id: options.modelId, sampling },
		denominator: attempts.length, successes: attempts.filter((attempt) => attempt.verifiedSuccess).length,
		proofQualified: attempts.filter((attempt) => attempt.proofQualified).length,
		aggregateTokenEnforcement: "unavailable; guest-reported totals are observational only",
		failures: attempts.filter((attempt) => !attempt.verifiedSuccess).map((attempt) => ({ taskId: attempt.taskId, validity: attempt.validity, reason: attempt.failure ?? attempt.stopReason })),
		totals: { calls: attempts.reduce((sum, attempt) => sum + (attempt.calls ?? 0), 0), tokens: attempts.reduce((sum, attempt) => sum + (attempt.tokens ?? 0), 0), wallTimeMs: attempts.reduce((sum, attempt) => sum + attempt.wallTimeMs, 0) },
		attempts,
	}
	await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 })
	const manifestCopy = path.join(outputRoot, "experiment-manifest.json")
	try {
		const saved = await fs.readFile(manifestCopy, "utf8")
		if (saved !== options.loaded.rawManifest) throw new Error("results directory already contains a different benchmark manifest")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		await fs.writeFile(manifestCopy, options.loaded.rawManifest, { mode: 0o600, flag: "wx" })
	}
	await fs.writeFile(path.join(outputRoot, `${split}-report.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
	return attempts
}

export function printBenchmarkSummary(attempts: BenchmarkAttempt[]): string {
	const successes = attempts.filter((attempt) => attempt.verifiedSuccess).length
	const proofQualified = attempts.filter((attempt) => attempt.proofQualified).length
	const calls = attempts.reduce((sum, attempt) => sum + (attempt.calls ?? 0), 0)
	const tokens = attempts.reduce((sum, attempt) => sum + (attempt.tokens ?? 0), 0)
	const wallMs = attempts.reduce((sum, attempt) => sum + attempt.wallTimeMs, 0)
	const failures = attempts.filter((attempt) => !attempt.verifiedSuccess).map((attempt) => `${attempt.taskId}: ${attempt.validity}${attempt.failure ? ` (${attempt.failure})` : ""}`).join("\n")
	return `RSI benchmark: ${successes}/${attempts.length} verified\nProof-qualified: ${proofQualified}/${attempts.length}; local Ollama resource ceilings are not broker-enforced\nGuest-reported calls: ${calls}; guest-reported tokens: ${tokens}; measured wall time: ${wallMs} ms${failures ? `\nFailures:\n${failures}` : ""}`
}
