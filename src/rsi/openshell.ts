import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { DEFAULT_PROTECTED_FILES, findMatchingPattern } from "../permissions/protected-files.js"
import { OpenShellSessionProvider, OPENSHELL_HARNESS_ROOT } from "../cloud/openshell-provider.js"
import type { OpenShellSessionProviderOptions } from "../cloud/openshell-provider.js"
import type { CloudSessionRequest, CommandResult, SessionHandle } from "../cloud/provider.js"
import type { CandidateRecord, CommandRunner, RsiConfig, TrialResult } from "./types.js"
import { ADVERSARIAL_RUNNER_PATH, ADVERSARIAL_TESTS_PATH } from "./adversarial.js"

const POLICY_PATH = fileURLToPath(new URL("../../shared/openshell/headlesscode-policy.yaml", import.meta.url))
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024
const IMAGE_DEPENDENCIES_LINK = "node_modules"
const RSI_OPENSHELL_IMAGE = "headlesscode-openshell-rsi:local"
const RSI_TRAINING_OPENSHELL_IMAGE = "headlesscode-openshell-rsi-training:local"
export const RSI_CPU_MODEL_EVALUATION_MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024 * 1024
const OPENSHELL_INITIAL_CONFIG_SETTLE_MS = 15_000

export interface RsiOpenShellProvider {
	spawnExistingWorktreeSession(request: CloudSessionRequest, worktreePath: string): Promise<SessionHandle>
	waitReady(handle: SessionHandle): Promise<void>
	runHarness(handle: SessionHandle, command: string): Promise<CommandResult>
	teardown(handle: SessionHandle): Promise<void>
}

export type RsiOpenShellProviderFactory = (options: OpenShellSessionProviderOptions) => RsiOpenShellProvider

export interface IsolatedRunOptions {
	config: RsiConfig
	sourceRoot: string
	commit: string
	command: string
	timeoutMs: number
	mode: "mutation" | "evaluation" | "training" | "model-evaluation"
	sessionName?: string
	env?: Record<string, string>
	extraFiles?: Record<string, Buffer>
	image?: string
	providerFactory?: RsiOpenShellProviderFactory
}

function execFileBuffer(command: string, args: string[], options: { cwd?: string; input?: Buffer | string } = {}): Buffer {
	return execFileSync(command, args, {
		cwd: options.cwd,
		input: options.input,
		encoding: "buffer",
		maxBuffer: MAX_BUNDLE_BYTES,
		stdio: ["pipe", "pipe", "pipe"],
	}) as Buffer
}

function pathIsSafe(relativePath: string): boolean {
	return relativePath.length > 0 && !relativePath.includes("\0") && !path.posix.isAbsolute(relativePath) && !relativePath.split("/").some((part) => part === ".." || part === "")
}

function alwaysOmit(relativePath: string): boolean {
	const normalized = relativePath.replaceAll("\\", "/")
	return normalized.startsWith("__headlesscode_rsi_adversarial__/") || findMatchingPattern(normalized, [...DEFAULT_PROTECTED_FILES, ".headlesscode/", ".worktrees/", "node_modules/", "src/rsi/", "scripts/eval-suite/", "fixtures/rsi-benchmark/"]) !== null
}

function shouldInclude(relativePath: string, mode: IsolatedRunOptions["mode"], config: RsiConfig): boolean {
	if (alwaysOmit(relativePath)) return false
	if (mode === "mutation") {
		// These are supervisor-controlled RSI policy/evaluation inputs. Enforce
		// their exclusion even when a caller supplies an incomplete protectedPaths list.
		const segments = relativePath.split("/")
		if (segments.includes("__tests__") || /(?:^|\/)(?:test|spec)\.[^/]+$/.test(relativePath) || /\.(?:test|spec)\.[^/]+$/.test(relativePath)) return false
		if (findMatchingPattern(relativePath, ["src/rsi/", "tests/", "test/", "scripts/", "fixtures/rsi-curriculum/", "fixtures/rsi-benchmark/"]) !== null) return false
		if (findMatchingPattern(relativePath, config.protectedPaths) !== null) return false
	}
	return true
}

interface TreeFile {
	path: string
	mode: "100644" | "100755"
	objectId: string
}

function treeFiles(sourceRoot: string, commit: string, mode: IsolatedRunOptions["mode"], config: RsiConfig): TreeFile[] {
	const raw = execFileBuffer("git", ["ls-tree", "-r", "-z", "--full-tree", commit], { cwd: sourceRoot })
	const files: TreeFile[] = []
	for (const entry of raw.toString("utf8").split("\0")) {
		if (!entry) continue
		const tab = entry.indexOf("\t")
		if (tab < 0) throw new Error("OpenShell snapshot rejected malformed Git tree entry")
		const [fileMode, objectType, objectId] = entry.slice(0, tab).split(" ")
		const relativePath = entry.slice(tab + 1)
		if (!pathIsSafe(relativePath)) throw new Error(`OpenShell snapshot rejected unsafe repository path: ${relativePath}`)
		if (fileMode === "160000") throw new Error(`OpenShell snapshot does not permit submodules: ${relativePath}`)
		if (fileMode === "120000") throw new Error(`OpenShell snapshot does not permit symlink source files: ${relativePath}`)
		if (objectType !== "blob" || (fileMode !== "100644" && fileMode !== "100755")) continue
		if (shouldInclude(relativePath, mode, config)) files.push({ path: relativePath, mode: fileMode, objectId })
	}
	return files
}

function readBlobBatch(sourceRoot: string, files: TreeFile[]): Map<string, Buffer> {
	const input = Buffer.from(files.map((file) => file.objectId).join("\n") + "\n")
	const output = execFileBuffer("git", ["cat-file", "--batch"], { cwd: sourceRoot, input })
	const blobs = new Map<string, Buffer>()
	let offset = 0
	let total = 0
	for (const file of files) {
		const headerEnd = output.indexOf(0x0a, offset)
		if (headerEnd < 0) throw new Error("OpenShell snapshot rejected truncated Git blob response")
		const header = output.subarray(offset, headerEnd).toString("ascii").split(" ")
		const size = Number(header[2])
		if (header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) throw new Error(`OpenShell snapshot rejected invalid blob metadata for ${file.path}`)
		total += size
		if (total > MAX_SNAPSHOT_BYTES || offset + (headerEnd - offset + 1) + size >= output.length) {
			if (total > MAX_SNAPSHOT_BYTES) throw new Error("OpenShell snapshot exceeds the 512 MiB experiment limit")
			if (offset + (headerEnd - offset + 1) + size > output.length) throw new Error(`OpenShell snapshot rejected truncated blob ${file.path}`)
		}
		const start = headerEnd + 1
		const end = start + size
		if (output[end] !== 0x0a) throw new Error(`OpenShell snapshot rejected malformed blob terminator for ${file.path}`)
		blobs.set(file.path, output.subarray(start, end))
		offset = end + 1
	}
	return blobs
}

function initializeSnapshot(sourceRoot: string, commit: string, destination: string, mode: IsolatedRunOptions["mode"], config: RsiConfig, includeHarnessDependencies = true): string {
	const files = treeFiles(sourceRoot, commit, mode, config)
	const blobs = readBlobBatch(sourceRoot, files)
	fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
	for (const file of files) {
		const target = path.join(destination, file.path)
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
		fs.writeFileSync(target, blobs.get(file.path)!, { mode: file.mode === "100755" ? 0o755 : 0o644, flag: "wx" })
	}
	if (mode === "evaluation" && includeHarnessDependencies) fs.symlinkSync(`${OPENSHELL_HARNESS_ROOT}/node_modules`, path.join(destination, IMAGE_DEPENDENCIES_LINK))
	execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: destination })
	execFileSync("git", ["config", "user.name", "HeadlessCode RSI Snapshot"], { cwd: destination })
	execFileSync("git", ["config", "user.email", "rsi-snapshot@invalid.example"], { cwd: destination })
	execFileSync("git", ["add", "--all"], { cwd: destination })
	if (mode === "evaluation" && includeHarnessDependencies) execFileSync("git", ["add", "--force", "--", IMAGE_DEPENDENCIES_LINK], { cwd: destination })
	execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", `RSI ${mode} snapshot ${commit}`], { cwd: destination, env: snapshotCommitEnvironment() })
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: destination, encoding: "utf8" }).trim()
}

function snapshotCommitEnvironment(): NodeJS.ProcessEnv {
	const date = "2000-01-01T00:00:00Z"
	return { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
}

/** Make an evaluator snapshot containing only fixed, supervisor-generated model-job inputs. */
export function createModelJobSnapshotBundle(sourceRoot: string, commit: string, config: RsiConfig, inputs: { dataset: Buffer; manifest: Buffer; cells: Buffer; adapterArchive?: Buffer }): { content: Buffer; snapshotCommit: string } {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-rsi-model-snapshot-"))
	const snapshot = path.join(tempRoot, "repo")
	const bundlePath = path.join(tempRoot, "snapshot.bundle")
	try {
		initializeSnapshot(sourceRoot, commit, snapshot, "model-evaluation", config, false)
		const modelInput = path.join(snapshot, ".headlesscode-rsi-model")
		fs.mkdirSync(modelInput, { recursive: true, mode: 0o700 })
		for (const [name, content] of [["dataset.jsonl", inputs.dataset], ["manifest.json", inputs.manifest], ["evaluation-cells.jsonl", inputs.cells]] as const) {
			fs.writeFileSync(path.join(modelInput, name), content, { mode: 0o600, flag: "wx" })
		}
		if (inputs.adapterArchive) fs.writeFileSync(path.join(modelInput, "adapter.tar"), inputs.adapterArchive, { mode: 0o600, flag: "wx" })
		execFileSync("git", ["add", "--all"], { cwd: snapshot })
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--amend", "--quiet", "--no-edit"], { cwd: snapshot, env: snapshotCommitEnvironment() })
		const snapshotCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: snapshot, encoding: "utf8" }).trim()
		if (execFileSync("git", ["rev-list", "--count", "--all"], { cwd: snapshot, encoding: "utf8" }).trim() !== "1") throw new Error("model job snapshot must contain exactly one commit")
		execFileSync("git", ["bundle", "create", bundlePath, "--all"], { cwd: snapshot, stdio: "pipe" })
		execFileSync("git", ["bundle", "verify", bundlePath], { cwd: snapshot, stdio: "pipe" })
		const content = fs.readFileSync(bundlePath)
		if (content.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("model job snapshot exceeds the 512 MiB limit")
		return { content, snapshotCommit }
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true })
	}
}

/** Build a one-commit mutation-only bundle for transfer to a remote worker. */
export function createMutationSnapshotBundle(sourceRoot: string, commit: string, config: RsiConfig): { content: Buffer; snapshotCommit: string } {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-rsi-fleet-snapshot-"))
	const snapshot = path.join(tempRoot, "repo")
	const bundlePath = path.join(tempRoot, "snapshot.bundle")
	try {
		const snapshotCommit = initializeSnapshot(sourceRoot, commit, snapshot, "mutation", config)
		const commitCount = execFileSync("git", ["rev-list", "--count", "--all"], { cwd: snapshot, encoding: "utf8" }).trim()
		if (commitCount !== "1") throw new Error("fleet mutation snapshot must contain exactly one sanitized commit")
		execFileSync("git", ["bundle", "create", bundlePath, "--all"], { cwd: snapshot, stdio: "pipe" })
		execFileSync("git", ["bundle", "verify", bundlePath], { cwd: snapshot, stdio: "pipe" })
		const content = fs.readFileSync(bundlePath)
		if (content.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("fleet mutation bundle exceeds the 512 MiB snapshot limit")
		return { content, snapshotCommit }
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true })
	}
}

/** Build a one-commit evaluation snapshot without supervisor scoring inputs. */
export function createEvaluationSnapshotBundle(sourceRoot: string, commit: string, config: RsiConfig): { content: Buffer; snapshotCommit: string } {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-rsi-fleet-eval-"))
	const snapshot = path.join(tempRoot, "repo")
	const bundlePath = path.join(tempRoot, "snapshot.bundle")
	try {
		const snapshotCommit = initializeSnapshot(sourceRoot, commit, snapshot, "evaluation", config, false)
		if (execFileSync("git", ["rev-list", "--count", "--all"], { cwd: snapshot, encoding: "utf8" }).trim() !== "1") throw new Error("fleet evaluation snapshot must contain exactly one sanitized commit")
		execFileSync("git", ["bundle", "create", bundlePath, "--all"], { cwd: snapshot, stdio: "pipe" })
		execFileSync("git", ["bundle", "verify", bundlePath], { cwd: snapshot, stdio: "pipe" })
		const content = fs.readFileSync(bundlePath)
		if (content.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("fleet evaluation bundle exceeds the 512 MiB snapshot limit")
		return { content, snapshotCommit }
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true })
	}
}

const ADVERSARIAL_RUNNER_SOURCE = `import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = process.cwd()
const spec = JSON.parse(await readFile(path.join(root, "${ADVERSARIAL_TESTS_PATH}"), "utf8"))
if (!Array.isArray(spec.tests) || spec.tests.length < 1 || spec.tests.length > 8) throw new Error("invalid adversarial test manifest")
for (const test of spec.tests) {
	if (typeof test.modulePath !== "string" || !/^(?:src|lib|app)\\//.test(test.modulePath) || test.modulePath.includes("..") || test.modulePath.includes("\\\\")) throw new Error("unsafe test module path")
	const target = path.resolve(root, test.modulePath)
	if (!target.startsWith(root + path.sep)) throw new Error("test module escaped the candidate snapshot")
	if (typeof test.exportName !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(test.exportName) || !Array.isArray(test.args) || test.args.length > 16) throw new Error("invalid adversarial test invocation")
	const module = await import(pathToFileURL(target).href)
	if (typeof module[test.exportName] !== "function") throw new Error("missing candidate export " + test.exportName)
	const actual = await module[test.exportName](...test.args)
	assert.deepStrictEqual(actual, test.expected, "adversarial test " + test.id + " failed: " + test.reason)
	process.stdout.write("PASS " + test.id + "\\n")
}
`

/** Bundle a candidate commit with a bounded declarative test manifest and fixed runner. */
export function createAdversarialEvaluationSnapshotBundle(sourceRoot: string, commit: string, config: RsiConfig, tests: Buffer): { content: Buffer; snapshotCommit: string } {
	if (tests.byteLength < 2 || tests.byteLength > 64 * 1024) throw new Error("adversarial test artifact must be between 2 bytes and 64 KiB")
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "headlesscode-rsi-adversarial-snapshot-"))
	const snapshot = path.join(tempRoot, "repo")
	const bundlePath = path.join(tempRoot, "snapshot.bundle")
	try {
		initializeSnapshot(sourceRoot, commit, snapshot, "evaluation", config, false)
		const reserved = path.join(snapshot, "__headlesscode_rsi_adversarial__")
		fs.mkdirSync(reserved, { recursive: true, mode: 0o700 })
		fs.writeFileSync(path.join(snapshot, ADVERSARIAL_TESTS_PATH), tests, { mode: 0o600, flag: "wx" })
		fs.writeFileSync(path.join(snapshot, ADVERSARIAL_RUNNER_PATH), ADVERSARIAL_RUNNER_SOURCE, { mode: 0o600, flag: "wx" })
		execFileSync("git", ["add", "--all"], { cwd: snapshot })
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--amend", "--quiet", "--no-edit"], { cwd: snapshot, env: snapshotCommitEnvironment() })
		const snapshotCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: snapshot, encoding: "utf8" }).trim()
		if (execFileSync("git", ["rev-list", "--count", "--all"], { cwd: snapshot, encoding: "utf8" }).trim() !== "1") throw new Error("adversarial evaluation snapshot must contain exactly one commit")
		execFileSync("git", ["bundle", "create", bundlePath, "--all"], { cwd: snapshot, stdio: "pipe" })
		execFileSync("git", ["bundle", "verify", bundlePath], { cwd: snapshot, stdio: "pipe" })
		const content = fs.readFileSync(bundlePath)
		if (content.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("adversarial evaluation bundle exceeds the 512 MiB snapshot limit")
		return { content, snapshotCommit }
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true })
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

function workerEnvironment(config: RsiConfig, candidate: CandidateRecord): Record<string, string> {
	const worker = config.roles?.worker
	if (worker && worker.provider !== "ollama") throw new Error("RSI OpenShell currently permits only the local Ollama worker; other providers require an explicit reviewed credential policy")
	const host = process.env.HEADLESSCODE_RSI_OLLAMA_HOST?.trim() || "host.openshell.internal"
	if (host !== "host.openshell.internal") throw new Error("RSI OpenShell permits Ollama access only through host.openshell.internal:11434")
	return {
		HEADLESSCODE_CODE_MODE_BACKEND: "ollama",
		HEADLESSCODE_LOCAL_BACKEND_MODES: "code",
		HEADLESSCODE_CODE_MODE_MODEL: worker?.model ?? candidate.model,
		HEADLESSCODE_OLLAMA_URL: `http://${host}:11434`,
		HEADLESSCODE_OLLAMA_THINK: "0",
		HEADLESSCODE_CAPTURE_TRANSCRIPT_DIR: path.join("/workspace", ".headlesscode", "rsi-transcripts"),
		HEADLESSCODE_MAX_ITERATIONS: String(config.maxIterations),
		HEADLESSCODE_MAX_DURATION_MS: String(config.commandTimeoutMs),
	}
}

export function networkRules(mode: IsolatedRunOptions["mode"]): Record<string, unknown> {
	if (mode !== "mutation") return {}
	const host = process.env.HEADLESSCODE_RSI_OLLAMA_HOST?.trim() || "host.openshell.internal"
	if (host !== "host.openshell.internal") throw new Error("RSI OpenShell permits Ollama access only through host.openshell.internal:11434")
	return {
		rsi_local_ollama: {
			name: "rsi-local-ollama-only",
			endpoints: [{ host, port: 11434, protocol: "tcp" }],
			binaries: [{ path: "/usr/local/bin/node" }],
		},
	}
}

export function inspectLocalRsiCheckpoint(configuredBase: string, mode: IsolatedRunOptions["mode"]): { path: string; files: number; bytes: number } {
	const stat = fs.lstatSync(configuredBase)
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("configured RSI base model must be a real directory, not a symlink")
	const source = fs.realpathSync(configuredBase)
	if (!fs.existsSync(path.join(source, "config.json"))) throw new Error("configured RSI base model is not a local Hugging Face checkpoint")
	const pending = [source]
	let files = 0
	let bytes = 0
	while (pending.length) {
		const directory = pending.pop()!
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const target = path.join(directory, entry.name)
			const entryStat = fs.lstatSync(target)
			if (entryStat.isSymbolicLink() || (!entryStat.isDirectory() && !entryStat.isFile())) throw new Error("RSI base checkpoint contains a symlink or special file")
			if (entryStat.isDirectory()) pending.push(target)
			else {
				files += 1
				bytes += entryStat.size
				if (files > 100_000 || bytes > 64 * 1024 * 1024 * 1024) throw new Error("RSI base checkpoint exceeds the 100,000-file or 64 GiB mount bound")
			}
		}
	}
	if (mode === "model-evaluation" && bytes > RSI_CPU_MODEL_EVALUATION_MAX_CHECKPOINT_BYTES) throw new Error("CPU-only paired model evaluation requires a checkpoint no larger than 2 GiB; GPU-backed evaluation is not implemented")
	return { path: source, files, bytes }
}

function providerOptions(config: RsiConfig, mode: IsolatedRunOptions["mode"], timeoutMs: number, imageReference?: string): OpenShellSessionProviderOptions {
	const policy = process.env.HEADLESSCODE_OPENSHELL_POLICY ?? POLICY_PATH
	const configuredImage = process.env.HEADLESSCODE_OPENSHELL_IMAGE?.trim()
	const trainingMode = mode === "training" || mode === "model-evaluation"
	const defaultImage = trainingMode ? RSI_TRAINING_OPENSHELL_IMAGE : RSI_OPENSHELL_IMAGE
	if (configuredImage && configuredImage !== defaultImage) {
		throw new Error(`RSI requires the verified OpenShell image ${defaultImage} for ${mode}; custom images are not verified`)
	}
	let readOnlyMounts: Array<{ source: string; target: string }> = []
	if (trainingMode) {
		const configuredBase = process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH?.trim()
		if (!configuredBase) throw new Error("model training/evaluation requires HEADLESSCODE_RSI_BASE_MODEL_PATH on the worker host")
		const checkpoint = inspectLocalRsiCheckpoint(configuredBase, mode)
		readOnlyMounts = [{ source: checkpoint.path, target: "/workspace/.rsi-base-model" }]
	}
	return {
		image: imageReference ?? defaultImage,
		policy,
		providers: [],
		autoProviders: false,
		importResults: true,
		includeProjectData: false,
		projectIdentityRoot: "/workspace",
		commandTimeoutMs: timeoutMs,
		networkPolicy: networkRules(mode),
		...(trainingMode ? { readOnlyMounts } : {}),
		...(mode === "training" ? { gpu: 1 } : {}),
	}
}

function makeRequest(repoRoot: string, name: string, env: Record<string, string>): CloudSessionRequest {
	return {
		repo: repoRoot,
		issue: { number: 0, title: `RSI isolated ${name}` },
		worktreeSpec: { name, issues: [], taskFile: "RSI_TASK.md" },
		env,
	}
}

function snapshotChanges(snapshot: string, baseCommit: string): Array<{ path: string; mode: string; status: string }> {
	const raw = execFileBuffer("git", ["diff", "--raw", "-z", "--no-renames", `${baseCommit}...HEAD`], { cwd: snapshot })
	const records = raw.toString("utf8").split("\0")
	const changes: Array<{ path: string; mode: string; status: string }> = []
	for (let index = 0; index < records.length - 1; index += 2) {
		const metadata = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(records[index])
		const file = records[index + 1]
		if (!metadata || !file) throw new Error("OpenShell mutation artifact contains malformed Git diff metadata")
		changes.push({ path: file, mode: metadata[2], status: metadata[3] })
	}
	return changes
}

function applyCandidatePatch(snapshot: string, snapshotBase: string, candidate: CandidateRecord, config: RsiConfig): string[] {
	const changes = snapshotChanges(snapshot, snapshotBase)
	const files = changes.map((change) => change.path)
	if (files.some((file) => !pathIsSafe(file))) throw new Error("OpenShell mutation artifact contains an unsafe path")
	const invalidModes = changes.filter((change) => change.status !== "D" && change.mode !== "100644" && change.mode !== "100755")
	if (invalidModes.length > 0) throw new Error(`OpenShell mutation artifact contains symlinks, submodules, or special files: ${invalidModes.map((change) => change.path).join(", ")}`)
	const forbiddenMetadata = new Set([".gitattributes", ".gitmodules", ".gitignore"])
	const violations = files.filter((file) => findMatchingPattern(file, config.protectedPaths) !== null || alwaysOmit(file) || file === "node_modules" || forbiddenMetadata.has(file))
	if (violations.length > 0) throw new Error(`OpenShell mutation artifact changed protected paths: ${violations.join(", ")}`)
	const commits = execFileSync("git", ["rev-list", "--count", `${snapshotBase}..HEAD`], { cwd: snapshot, encoding: "utf8" }).trim()
	if (Number(commits) === 0 || files.length === 0) throw new Error("OpenShell mutation produced no committed source changes")
	const patch = execFileBuffer("git", ["diff", "--binary", "--no-ext-diff", "--no-renames", `${snapshotBase}...HEAD`], { cwd: snapshot })
	const tempPatch = path.join(path.dirname(candidate.worktree), `.rsi-${candidate.id}-${randomUUID()}.patch`)
	try {
		fs.writeFileSync(tempPatch, patch, { mode: 0o600, flag: "wx" })
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "apply", "--check", "--index", tempPatch], { cwd: candidate.worktree, stdio: "pipe" })
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "apply", "--index", tempPatch], { cwd: candidate.worktree, stdio: "pipe" })
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", `RSI candidate ${candidate.id}`], { cwd: candidate.worktree, stdio: "pipe" })
	} finally {
		fs.rmSync(tempPatch, { force: true })
	}
	return files
}

/** Validate and import an untrusted worker patch into the supervisor candidate worktree. */
export function applyFleetMutationPatch(patch: Buffer, candidate: CandidateRecord, config: RsiConfig): string[] {
	if (patch.byteLength === 0 || patch.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("fleet worker returned an empty or oversized patch")
	const tempPatch = path.join(path.dirname(candidate.worktree), `.rsi-fleet-${candidate.id}-${randomUUID()}.patch`)
	try {
		fs.writeFileSync(tempPatch, patch, { mode: 0o600, flag: "wx" })
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "apply", "--check", "--index", tempPatch], { cwd: candidate.worktree, stdio: "pipe" })
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "apply", "--index", tempPatch], { cwd: candidate.worktree, stdio: "pipe" })
		// The patch is applied with --index, before the supervisor creates its
		// commit. Compare the staged index directly; a base...HEAD diff is empty
		// at this point and would reject every valid worker patch.
		const changes = stagedSnapshotChanges(candidate.worktree)
		const files = changes.map((change) => change.path)
		if (files.length === 0 || files.some((file) => !pathIsSafe(file))) throw new Error("fleet worker patch produced no files or an unsafe path")
		const invalidModes = changes.filter((change) => change.status !== "D" && change.mode !== "100644" && change.mode !== "100755")
		if (invalidModes.length > 0) throw new Error(`fleet worker patch contains symlinks or special files: ${invalidModes.map((change) => change.path).join(", ")}`)
		const forbiddenMetadata = new Set([".gitattributes", ".gitmodules", ".gitignore"])
		const violations = files.filter((file) => findMatchingPattern(file, config.protectedPaths) !== null || alwaysOmit(file) || file === "node_modules" || forbiddenMetadata.has(file))
		if (violations.length > 0) throw new Error(`fleet worker patch changed protected paths: ${violations.join(", ")}`)
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", `RSI candidate ${candidate.id}`], { cwd: candidate.worktree, stdio: "pipe" })
		return files
	} catch (error) {
		execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: candidate.worktree, stdio: "ignore" })
		throw error
	} finally {
		fs.rmSync(tempPatch, { force: true })
	}
}

function stagedSnapshotChanges(snapshot: string): Array<{ path: string; mode: string; status: string }> {
	const raw = execFileBuffer("git", ["diff", "--cached", "--raw", "-z", "--no-renames", "HEAD"], { cwd: snapshot })
	const records = raw.toString("utf8").split("\0")
	const changes: Array<{ path: string; mode: string; status: string }> = []
	for (let index = 0; index < records.length - 1; index += 2) {
		const metadata = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(records[index])
		const file = records[index + 1]
		if (!metadata || !file) throw new Error("fleet worker patch produced malformed staged Git diff metadata")
		changes.push({ path: file, mode: metadata[2], status: metadata[3] })
	}
	return changes
}

async function runSnapshot(options: IsolatedRunOptions & { preserveSnapshot?: boolean }): Promise<{ result: TrialResult; snapshot: string; snapshotBase: string }> {
	if (options.config.hiddenEvalCommands.length > 0) {
		throw new Error("RSI hidden evaluations are disabled until an evaluator service can keep test inputs outside candidate execution")
	}
	if (options.mode === "evaluation" && /(?:scripts\/eval-suite|\.headlesscode)/i.test(options.command)) {
		throw new Error("RSI evaluation command refers to supervisor-only evaluation material")
	}
	const name = options.sessionName ?? `rsi-${options.mode}-${randomUUID().slice(0, 12)}`
	const snapshot = path.join(options.config.repoRoot, ".worktrees", name)
	fs.mkdirSync(path.dirname(snapshot), { recursive: true })
	const snapshotBase = initializeSnapshot(options.sourceRoot, options.commit, snapshot, options.mode, options.config)
	if (options.extraFiles && Object.keys(options.extraFiles).length > 0) {
		for (const [relativePath, content] of Object.entries(options.extraFiles)) {
			if (!pathIsSafe(relativePath)) throw new Error(`OpenShell evaluation input has an unsafe path: ${relativePath}`)
			const target = path.join(snapshot, relativePath)
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
			fs.writeFileSync(target, content, { mode: 0o600, flag: "wx" })
		}
		execFileSync("git", ["add", "--all"], { cwd: snapshot })
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--amend", "--quiet", "--no-edit"], { cwd: snapshot, env: snapshotCommitEnvironment() })
	}
	const factory = options.providerFactory ?? ((providerConfig) => new OpenShellSessionProvider(providerConfig))
	const provider = factory(providerOptions(options.config, options.mode, options.timeoutMs, options.image))
	const request = makeRequest(options.config.repoRoot, name, options.env ?? {})
	let handle: SessionHandle | undefined
	const started = Date.now()
	try {
		const startedHandle = await provider.spawnExistingWorktreeSession(request, snapshot)
		handle = startedHandle
		await provider.waitReady(startedHandle)
		if (options.mode === "mutation") {
			// OpenShell 0.1.2 polls provider environment revisions about every
			// 10 seconds. Its first empty-environment sync advances the policy
			// generation and closes older in-flight tunnels, even with no attached
			// providers. Let that initial sync settle before local inference starts.
			const remaining = OPENSHELL_INITIAL_CONFIG_SETTLE_MS - (Date.now() - started)
			if (remaining > 0) await delay(remaining)
		}
		const command = `cd /workspace && ${options.command}`
		const result = await provider.runHarness(startedHandle, command)
		return {
			result: {
				ok: result.exitCode === 0,
				command: options.command,
				exitCode: result.exitCode,
				durationMs: Date.now() - started,
				stdout: result.output,
				stderr: "",
			},
			snapshot,
			snapshotBase,
		}
	} finally {
		try {
			if (handle) await provider.teardown(handle)
		} finally {
			if (!options.preserveSnapshot && options.mode !== "mutation" && !fs.existsSync(path.join(snapshot, ".harness.openshell-sandbox"))) {
				fs.rmSync(snapshot, { recursive: true, force: true })
			}
		}
	}
}

/** Run the fixed QLoRA or matched-model evaluator command inside OpenShell. */
export async function runOpenShellModelJob(candidate: CandidateRecord, config: RsiConfig, task: NonNullable<import("./postgres-queue.js").FleetJobPayload["modelTask"]>, providerFactory?: RsiOpenShellProviderFactory): Promise<{ result: Record<string, unknown>; adapterArchive?: Buffer }> {
	if (task.seed !== 1337 || task.baseModelPath !== "/workspace/.rsi-base-model" || !/^[A-Za-z0-9._:@/-]{1,180}$/.test(task.baseModelId)) throw new Error("model job does not match the fixed dataset seed, base-model mount, or model identity")
	const training = task.kind === "qlora-train"
	if (training && (task.maxSteps !== 8 || task.adapterPath || task.modelKind)) throw new Error("training job differs from the bounded QLoRA policy")
	if (!training && (!task.modelKind || !task.cellIds.length || (task.modelKind === "adapter" && !task.adapterPath) || (task.modelKind === "base" && task.adapterPath))) throw new Error("model evaluation job is missing or mismatches its fixed cell/model identity")
	const output = "/workspace/.headlesscode-rsi-model-output"
	const command = training
		? `python3 /opt/headlesscode-rsi-training/train_qlora.py --base-model /workspace/.rsi-base-model --base-model-id '${task.baseModelId}' --dataset /workspace/.headlesscode-rsi-model/dataset.jsonl --manifest /workspace/.headlesscode-rsi-model/manifest.json --output /workspace/.headlesscode-rsi-model-output`
		: `python3 /opt/headlesscode-rsi-training/evaluate_adapter.py --base-model /workspace/.rsi-base-model --base-model-id '${task.baseModelId}' --cells /workspace/.headlesscode-rsi-model/evaluation-cells.jsonl --output ${output}/evaluation-result.json${task.modelKind === "adapter" ? " --adapter-archive /workspace/.headlesscode-rsi-model/adapter.tar" : ""}`
	const isolated = await runSnapshot({
		config,
		sourceRoot: candidate.worktree,
		commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidate.worktree, encoding: "utf8" }).trim(),
		command,
		timeoutMs: config.commandTimeoutMs,
		mode: training ? "training" : "model-evaluation",
		sessionName: `rsi-model-${candidate.id}-${randomUUID().slice(0, 8)}`,
		providerFactory,
		preserveSnapshot: true,
	})
	try {
		const resultName = training ? "training-result.json" : "evaluation-result.json"
		const resultPath = path.join(isolated.snapshot, ".headlesscode-rsi-model-output", resultName)
		if (!fs.existsSync(resultPath)) throw new Error(`OpenShell model job omitted ${resultName}; exit=${isolated.result.exitCode}`)
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>
		if (result.schemaVersion !== 1 || !["completed", "failed", "partial"].includes(String(result.status))) throw new Error("OpenShell model job returned an invalid result record")
		if (training && result.status === "completed") {
			const archive = execFileBuffer("git", ["archive", "--format=tar", "HEAD", ".headlesscode-rsi-model-output/adapter"], { cwd: isolated.snapshot })
			if (archive.byteLength < 1) throw new Error("completed QLoRA job produced no adapter archive")
			return { result, adapterArchive: archive }
		}
		return { result }
	} finally {
		if (!fs.existsSync(path.join(isolated.snapshot, ".harness.openshell-sandbox"))) fs.rmSync(isolated.snapshot, { recursive: true, force: true })
	}
}

export async function runOpenShellMutation(candidate: CandidateRecord, config: RsiConfig, providerFactory?: RsiOpenShellProviderFactory, image?: string): Promise<{ ok: boolean; result?: TrialResult; error?: string; patchRejected?: boolean; calls?: number | null; tokens?: number | null }> {
	try {
		const workerCommand = [
			"/opt/headlesscode/node_modules/.bin/tsx",
			"/opt/headlesscode/src/cli.ts",
			"--mode",
			"code",
			"--max-iterations",
			String(config.maxIterations),
			...(config.maxTokens ? ["--max-tokens", String(config.maxTokens)] : []),
			"--no-checkpoints",
			"--task",
			mutationTask(candidate, config),
		].map(shellQuote).join(" ")
		const boundaryChecks = [
			"ln -s /opt/headlesscode/node_modules /workspace/node_modules",
			'test "$(git -C /workspace rev-list --count HEAD)" = 1',
			"test ! -e /workspace/src/rsi",
			"test ! -e /workspace/scripts",
			"test ! -e /workspace/tests",
			"test ! -e /workspace/test",
			"test ! -e /workspace/.env",
			"test ! -e /workspace/.headlesscode",
			"test ! -e /opt/headlesscode/src/rsi",
			"test ! -e /opt/headlesscode/scripts/eval-suite",
			...(config.benchmarkHarnessCommit ? ["test -f /opt/headlesscode/.headlesscode-harness-commit", `test "$(cat /opt/headlesscode/.headlesscode-harness-commit)" = ${shellQuote(config.benchmarkHarnessCommit)}`] : []),
			config.benchmarkHarnessCommit
				? "test -z \"$(find /opt/headlesscode/src -type f \\( -path '*/__tests__/*' -o -name '*.test.*' -o -name '*.spec.*' \\) -print -quit)\""
				: "test -z \"$(find /workspace /opt/headlesscode/src -type f \\( -path '*/__tests__/*' -o -name '*.test.*' -o -name '*.spec.*' \\) -print -quit)\"",
			'test -z "${HEADLESSCODE_OPENROUTER_API_KEY:-}${OPENROUTER_API_KEY:-}${OPENAI_API_KEY:-}${ANTHROPIC_API_KEY:-}"',
			`exec ${workerCommand}`,
		]
		const boundaryGuard = `${boundaryChecks.map((check) => `(${check}) || { echo RSI_BENCHMARK_PREFLIGHT_FAILURE >&2; exit 79; }`).join(" && ")} && exec ${workerCommand}`
		const env = workerEnvironment(config, candidate)
		const isolation = await runSnapshot({
			config,
			sourceRoot: candidate.worktree,
			commit: candidate.baseCommit,
			command: boundaryGuard,
			timeoutMs: config.commandTimeoutMs,
			mode: "mutation",
			sessionName: `rsi-mutation-${candidate.id}-${randomUUID().slice(0, 6)}`,
			env,
			image,
			providerFactory,
		})
		if (!isolation.result.ok) {
			const detail = isolation.result.stderr || isolation.result.stdout
			if (isolation.result.exitCode === 79 && detail.includes("RSI_BENCHMARK_PREFLIGHT_FAILURE")) throw new Error(`OpenShell benchmark preflight failed: ${detail.slice(0, 3000)}`)
			return { ok: false, result: isolation.result, error: `OpenShell mutation worker failed (exit ${isolation.result.exitCode ?? "unknown"})${detail ? `: ${detail.slice(0, 3000)}` : ""}` }
		}
		const usage = readMutationTranscriptUsage(isolation.snapshot)
		let changedFiles: string[]
		try {
			changedFiles = applyCandidatePatch(isolation.snapshot, isolation.snapshotBase, candidate, config)
		} catch (error) {
			// A worker can finish successfully while producing a patch that violates
			// the import contract. Keep that as a rejected task result; failures
			// before artifact validation (including OpenShell setup) still propagate.
			return {
				ok: false,
				result: isolation.result,
				error: error instanceof Error ? error.message : String(error),
				patchRejected: true,
				...usage,
			}
		}
		if (isolation.result.ok && changedFiles.length === 0) return { ok: false, result: isolation.result, error: "OpenShell worker returned success without a candidate change", ...usage }
		return { ok: true, result: isolation.result, ...usage }
	} finally {
		const snapshotPrefix = `rsi-mutation-${candidate.id}`
		try {
			for (const name of fs.readdirSync(path.join(config.repoRoot, ".worktrees"))) {
				if (name.startsWith(snapshotPrefix)) {
					const snapshot = path.join(config.repoRoot, ".worktrees", name)
					if (!fs.existsSync(path.join(snapshot, ".harness.openshell-sandbox"))) fs.rmSync(snapshot, { recursive: true, force: true })
				}
			}
		} catch {
			// Keep a failed cleanup visible for operator recovery.
		}
	}
}

function readMutationTranscriptUsage(snapshot: string): { calls: number | null; tokens: number | null } {
	const directory = path.join(snapshot, ".headlesscode", "rsi-transcripts")
	if (!fs.existsSync(directory)) return { calls: null, tokens: null }
	const files = fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl"))
	if (files.length < 1 || files.length > 16) return { calls: null, tokens: null }
	let calls = 0
	let tokens = 0
	let bytes = 0
	for (const name of files) {
		const file = path.join(directory, name)
		const stat = fs.lstatSync(file)
		if (!stat.isFile() || stat.isSymbolicLink()) return { calls: null, tokens: null }
		bytes += stat.size
		if (bytes > 32 * 1024 * 1024) return { calls: null, tokens: null }
		for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
			if (line.length > 2 * 1024 * 1024) return { calls: null, tokens: null }
			let record: { response?: { usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number } } }
			try { record = JSON.parse(line) as typeof record } catch { return { calls: null, tokens: null } }
			const usage = record.response?.usage
			if (!usage || !Number.isSafeInteger(usage.promptTokens) || !Number.isSafeInteger(usage.completionTokens)) return { calls: null, tokens: null }
			calls += 1
			tokens += usage.totalTokens ?? (usage.promptTokens! + usage.completionTokens!)
		}
	}
	if (calls < 1 || !Number.isSafeInteger(tokens)) return { calls: null, tokens: null }
	return { calls, tokens }
}

function mutationTask(candidate: CandidateRecord, config: RsiConfig): string {
	const hypothesis = candidate.hypothesis
	return [
		"You are a bounded RSI worker inside an OpenShell sandbox.",
		`Improve the isolated candidate snapshot for generation ${candidate.generation}.`,
		`Mutation class: ${candidate.mutationKind ?? "corrective"}. Compute policy: ${config.computePolicy ?? "single"}.`,
		`Objective: ${config.mutationTask}`,
		hypothesis ? `Hypothesis: ${hypothesis.statement}\nExpected effect: ${hypothesis.expectedEffect}\nPotential downside: ${hypothesis.potentialDownside}${hypothesis.evidence ? `\nEvidence: ${hypothesis.evidence}` : ""}` : "",
		"The workspace contains only candidate source files. Supervisor evaluation scripts, scoring state, project history, and operator data are not mounted.",
		"Make a focused source change and commit it. Do not run tests; the supervisor will evaluate the sealed artifact in a separate OpenShell session.",
	].filter(Boolean).join("\n\n")
}

export function createOpenShellCommandRunner(config: RsiConfig): CommandRunner {
	return async (command, cwd, timeoutMs, env) => {
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim()
		const safeEnv: Record<string, string> = {}
		if (env?.HEADLESSCODE_RSI_CANDIDATE_ROOT) safeEnv.HEADLESSCODE_RSI_CANDIDATE_ROOT = "/workspace"
		try {
			const isolated = await runSnapshot({ config, sourceRoot: cwd, commit, command, timeoutMs, mode: "evaluation", env: safeEnv })
			return isolated.result
		} catch (error) {
			return { ok: false, command, exitCode: null, durationMs: 0, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
		}
	}
}

/** Execute only visible candidate checks inside a fresh OpenShell guest. */
export async function runOpenShellEvaluation(candidate: CandidateRecord, config: RsiConfig): Promise<{ regression: TrialResult; visible: TrialResult[] }> {
	if (config.hiddenEvalCommands.length > 0) throw new Error("hidden RSI evaluation is supervisor-only and cannot be submitted as a worker job")
	const commands = [config.regressionCommand, ...config.evalCommands]
	const results: TrialResult[] = []
	for (const command of commands) {
		const isolated = await runSnapshot({ config, sourceRoot: candidate.worktree, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidate.worktree, encoding: "utf8" }).trim(), command, timeoutMs: config.commandTimeoutMs, mode: "evaluation" })
		results.push(isolated.result)
	}
	return { regression: results[0], visible: results.slice(1) }
}

/** Run one supervisor-supplied benchmark verifier after the coding guest has been torn down. */
export async function runOpenShellBenchmarkVerifier(candidate: CandidateRecord, config: RsiConfig, verifier: Buffer, taskId: string, providerFactory?: RsiOpenShellProviderFactory, image?: string): Promise<TrialResult> {
	if (verifier.byteLength < 1 || verifier.byteLength > 1024 * 1024) throw new Error("benchmark verifier must be between 1 byte and 1 MiB")
	if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(taskId)) throw new Error("benchmark verifier task id is malformed")
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidate.worktree, encoding: "utf8" }).trim()
	const isolated = await runSnapshot({
		config,
		sourceRoot: candidate.worktree,
		commit,
		command: `ln -s /opt/headlesscode/node_modules /workspace/node_modules && command -v node >/dev/null && test -f /workspace/__rsi_benchmark_verifier__/verify.mjs && { node /workspace/__rsi_benchmark_verifier__/verify.mjs /workspace ${taskId}; verifier_status=$?; printf '\\nRSI_BENCHMARK_VERIFIER_COMPLETED:%s\\n' "$verifier_status"; exit "$verifier_status"; }`,
		timeoutMs: config.commandTimeoutMs,
		mode: "evaluation",
		sessionName: `rsi-benchmark-verifier-${candidate.id}-${randomUUID().slice(0, 8)}`,
		extraFiles: { "__rsi_benchmark_verifier__/verify.mjs": verifier },
		image,
		providerFactory,
	})
	const marker = /(?:^|\n)RSI_BENCHMARK_VERIFIER_COMPLETED:(\d+)(?:\n|$)/.exec(isolated.result.stdout + isolated.result.stderr)
	if (!marker) throw new Error(`OpenShell benchmark verifier did not return its completion marker (exit ${isolated.result.exitCode ?? "unknown"}): ${(isolated.result.stderr || isolated.result.stdout).slice(0, 3000)}`)
	if (Number(marker[1]) !== isolated.result.exitCode) throw new Error("OpenShell benchmark verifier completion marker disagrees with the sandbox exit code")
	return isolated.result
}

export function openShellMutationRunner(): typeof runOpenShellMutation {
	return runOpenShellMutation
}
