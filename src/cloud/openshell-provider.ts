/**
 * OpenShellSessionProvider — experimental CloudProvider backed by NVIDIA
 * OpenShell. Each session uses a disposable, independent Git clone mounted at
 * /workspace. The host worktree and its process-control files are never mounted.
 * After sandbox deletion, a verified Git bundle imports changes to the assigned
 * host branch.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse, stringify } from "yaml"

import { writeTaskFiles } from "../orchestrator/cli.js"
import { projectStoreRoot, resolveProjectDataDir } from "../project-store.js"
import type { CloudProvider, CloudSessionRequest, CommandResult, SessionHandle } from "./provider.js"

/** The harness is baked into the sandbox image; never mount the host checkout. */
export const OPENSHELL_HARNESS_ROOT = "/opt/headlesscode"

export const OPENSHELL_WORKSPACE_TARGET = "/workspace"

interface OpenShellWorkspaceState {
	hostWorkspace: string
	sandboxWorkspace: string
	exportDir: string
	tempRoot: string
	lockPath: string
	memorySnapshot?: string
	memoryHost?: string
	branchRef: string
	baseCommit: string
	importResults: boolean
}

export function writeOpenShellSandboxMarker(workspace: string, name: string): string {
	const marker = path.join(workspace, ".harness.openshell-sandbox")
	try {
		const stat = fs.lstatSync(marker)
		if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(marker, "utf8").trim() !== name) {
			throw new Error(`refusing to overwrite unexpected sandbox marker at ${marker}`)
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
	const fd = fs.openSync(marker, flags, 0o600)
	try {
		fs.fchmodSync(fd, 0o600)
		fs.writeFileSync(fd, `${name}\n`)
	} finally {
		fs.closeSync(fd)
	}
	return marker
}

export interface OpenShellSessionProviderOptions {
	image?: string
	policy?: string
	providers?: string[]
	/** Attach automatically discovered host provider profiles to the sandbox. */
	autoProviders?: boolean
	cpu?: string
	memory?: string
	namePrefix?: string
	readOnlyMounts?: Array<{ source: string; target: string }>
	importResults?: boolean
	scratchRoot?: string
	/** Omit project/shared data snapshots for experiments that must not inherit operator context. */
	includeProjectData?: boolean
	/** Use a guest-safe identity path instead of the supervisor checkout path. */
	projectIdentityRoot?: string
	/** Additional exact OpenShell network rules needed by the workload. */
	networkPolicy?: Record<string, unknown>
	/** Timeout for sandbox commands, including agent mutation. */
	commandTimeoutMs?: number
	/** Number of GPU devices requested for a training-only sandbox. */
	gpu?: number
	run?: (args: string[], timeoutMs?: number) => CommandResult
	/** Async command runner used for long guest commands so host services can keep serving requests. */
	runAsync?: (args: string[], timeoutMs?: number) => Promise<CommandResult>
	listSandboxes?: () => string[]
}

export function runOpenShellCommandAsync(args: string[], timeoutMs?: number, executable = "openshell"): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = execFile(executable, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
			if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("OpenShell CLI executable was not found"))
				return
			}
			const errorCode = (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code
			const code = typeof errorCode === "number" ? errorCode : error ? 1 : 0
			let output = `${stdout ?? ""}${stderr ?? ""}`.trim()
			if (error && !output) {
				const processError = error as NodeJS.ErrnoException & { signal?: unknown; killed?: boolean }
				const signal = processError.signal
				const timedOut = errorCode === "ETIMEDOUT" || (timeoutMs !== undefined && processError.killed === true && typeof signal === "string")
				const details = [
					timedOut ? "timeout=true" : undefined,
					typeof errorCode === "string" ? `code=${errorCode}` : `exitCode=${code}`,
					typeof signal === "string" ? `signal=${signal}` : undefined,
				].filter(Boolean)
				output = `OpenShell CLI returned no output (${details.join(" ")})`
			}
			resolve({ exitCode: code, output })
		})
		// OpenShell's exec relay waits for EOF on stdin before starting a command.
		// The synchronous provider path closes it automatically; close this pipe
		// explicitly so long-running guest commands begin immediately as well.
		child.stdin?.end()
	})
}

export class OpenShellSessionProvider implements CloudProvider {
	readonly name = "openshell"
	private readonly image: string
	private readonly policy?: string
	private readonly providers: string[]
	private readonly autoProviders: boolean
	private readonly cpu: string
	private readonly memory: string
	private readonly namePrefix: string
	private readonly readOnlyMounts: Array<{ source: string; target: string }>
	private readonly run: (args: string[], timeoutMs?: number) => CommandResult
	private readonly runHarnessCommand: (args: string[], timeoutMs?: number) => Promise<CommandResult>
	private readonly listSandboxes: () => string[]
	private readonly importResults: boolean
	private readonly scratchRoot: string
	private readonly includeProjectData: boolean
	private readonly projectIdentityRoot?: string
	private readonly networkPolicy: Record<string, unknown>
	private readonly commandTimeoutMs: number
	private readonly gpu?: number
	private readonly workspaces = new Map<string, OpenShellWorkspaceState>()

	constructor(options: OpenShellSessionProviderOptions = {}) {
		this.image = options.image ?? process.env.HEADLESSCODE_OPENSHELL_IMAGE ?? "headlesscode-openshell:local"
		this.policy = options.policy ?? process.env.HEADLESSCODE_OPENSHELL_POLICY
		this.providers = options.providers ?? (process.env.HEADLESSCODE_OPENSHELL_PROVIDERS ?? "headlesscode-openrouter").split(",").map((name) => name.trim()).filter(Boolean)
		this.autoProviders = options.autoProviders ?? true
		this.cpu = options.cpu ?? process.env.HEADLESSCODE_OPENSHELL_CPU ?? "2"
		this.memory = options.memory ?? process.env.HEADLESSCODE_OPENSHELL_MEMORY ?? "4Gi"
		this.namePrefix = options.namePrefix ?? process.env.HEADLESSCODE_OPENSHELL_NAME_PREFIX ?? "hcls"
		this.readOnlyMounts = options.readOnlyMounts ?? []
		this.importResults = options.importResults ?? true
		this.scratchRoot = path.resolve(options.scratchRoot ?? process.env.HEADLESSCODE_OPENSHELL_SCRATCH_ROOT ?? path.join(os.homedir(), ".local", "share", "headlesscode", "openshell-sessions"))
		this.includeProjectData = options.includeProjectData ?? true
		this.projectIdentityRoot = options.projectIdentityRoot
		this.networkPolicy = options.networkPolicy ?? {}
		this.commandTimeoutMs = options.commandTimeoutMs ?? 15 * 60_000
		if (options.gpu !== undefined && (!Number.isInteger(options.gpu) || options.gpu < 1 || options.gpu > 8)) throw new Error("OpenShell GPU count must be an integer from 1 to 8")
		this.gpu = options.gpu
		const injectedRun = options.run
		this.run = injectedRun ?? ((args, timeoutMs) => {
			const result = spawnSync("openshell", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs })
			return { exitCode: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() }
		})
		this.runHarnessCommand = options.runAsync ?? (injectedRun
			? async (args, timeoutMs) => injectedRun(args, timeoutMs)
			: runOpenShellCommandAsync)
		this.listSandboxes = options.listSandboxes ?? (() => {
			const result = this.run(["sandbox", "list", "--output", "json"])
			if (result.exitCode !== 0) throw new Error(`OpenShell sandbox list failed: ${result.output}`)
			try {
				const parsed = JSON.parse(result.output) as unknown
				const value = Array.isArray(parsed)
					? parsed
					: typeof parsed === "object" && parsed !== null && "sandboxes" in parsed && Array.isArray((parsed as { sandboxes: unknown }).sandboxes)
						? (parsed as { sandboxes: unknown[] }).sandboxes
						: undefined
				if (!value || value.some((item) => typeof item !== "object" || item === null || !("name" in item) || typeof (item as { name: unknown }).name !== "string")) {
					throw new Error("expected a sandbox array with string names")
				}
				return value.map((item) => (item as { name: string }).name)
			} catch (error) {
				throw new Error(`OpenShell sandbox list returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
			}
		})
	}

	private sandboxName(handle: SessionHandle): string { return handle.containerId ?? this.sandboxNameForWorktree(handle.id) }

	/** Stable OpenShell name shared by worker launch and stop/recovery paths. */
	sandboxNameForWorktree(worktreeName: string, repoPath = ""): string {
		const prefix = this.namePrefix.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "hcls"
		const prefixPart = prefix.slice(0, 3).replace(/-+$/g, "") || "h"
		const identity = `${path.resolve(repoPath || process.cwd())}\0${worktreeName}`
		const hash = createHash("sha256").update(identity).digest("hex").slice(0, 19 - prefixPart.length - 1)
		const name = `${prefixPart}-${hash}`
		if (name.length > 19 || !/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(name)) {
			throw new Error(`OpenShell sandbox name is not a DNS label: ${name}`)
		}
		return name
	}

	async spawnWorktreeSession(request: CloudSessionRequest): Promise<SessionHandle> {
		const repo = path.resolve(request.repo)
		if (!/^[A-Za-z0-9._-]+$/.test(request.worktreeSpec.name)) {
			throw new Error(`Invalid OpenShell worktree name: ${request.worktreeSpec.name}`)
		}
		const workspace = path.join(repo, ".worktrees", request.worktreeSpec.name)
		const name = this.sandboxNameForWorktree(request.worktreeSpec.name, repo)
		try {
			if (!fs.statSync(path.join(repo, ".git")).isDirectory()) throw new Error("not a repository root")
		} catch {
			throw new Error(`OpenShell provider requires a Git repository root with a .git directory: ${repo}`)
		}
		writeTaskFiles(repo, [request.worktreeSpec], [request.issue])
		const branch = `headlesscode/${request.worktreeSpec.name}-${Date.now()}`
		const wt = spawnSync("git", ["worktree", "add", "-b", branch, workspace, "HEAD"], { cwd: repo, encoding: "utf8" })
		if (wt.status !== 0) throw new Error(`OpenShell worktree creation failed: ${wt.stderr || wt.stdout}`)
		const taskFile = path.join(repo, "plans", "parallel-tasks", request.worktreeSpec.taskFile)
		try {
			fs.copyFileSync(taskFile, path.join(workspace, "ORCHESTRATOR_TASK.md"))
		} catch (error) {
			spawnSync("git", ["worktree", "remove", "--force", workspace], { cwd: repo, encoding: "utf8" })
			spawnSync("git", ["branch", "-D", branch], { cwd: repo, encoding: "utf8" })
			throw error
		}
		return this.spawnExistingWorktreeSession(request, workspace)
	}

	/** Start a sandbox around a worktree already created by the normal spawner. */
	async spawnExistingWorktreeSession(request: CloudSessionRequest, worktreePath: string): Promise<SessionHandle> {
		const repo = path.resolve(request.repo)
		const workspace = path.resolve(worktreePath)
		const expected = path.join(repo, ".worktrees", request.worktreeSpec.name)
		if (workspace !== expected) throw new Error(`OpenShell worker path must be ${expected}`)
		if (!fs.statSync(workspace).isDirectory()) throw new Error(`OpenShell worker worktree does not exist: ${workspace}`)
		const name = this.sandboxNameForWorktree(request.worktreeSpec.name, repo)
		const isolated = this.prepareIsolatedWorkspace(workspace, name)
		try {
			return await this.createSandbox(request, repo, workspace, isolated, name)
		} catch (error) {
			if (!fs.existsSync(path.join(workspace, ".harness.openshell-sandbox"))) {
				this.workspaces.delete(name)
				fs.rmSync(isolated.tempRoot, { recursive: true, force: true })
				fs.rmSync(isolated.lockPath, { recursive: true, force: true })
			}
			throw error
		}
	}

	private prepareIsolatedWorkspace(hostWorkspace: string, sandboxName: string): OpenShellWorkspaceState {
		const tempRoot = path.join(this.scratchRoot, `headlesscode-openshell-session-${sandboxName}`)
		const lockPath = `${tempRoot}.lock`
		const sandboxWorkspace = path.join(tempRoot, "workspace")
		const exportDir = path.join(tempRoot, "result")
		let ownsLock = false
		let ownsTempRoot = false
		try {
			fs.mkdirSync(this.scratchRoot, { recursive: true, mode: 0o700 })
			const rootStat = fs.lstatSync(this.scratchRoot)
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`refusing unexpected OpenShell scratch root ${this.scratchRoot}`)
			fs.mkdirSync(lockPath, { mode: 0o700 })
			ownsLock = true
			if (this.listSandboxes().includes(sandboxName)) throw new Error(`OpenShell sandbox ${sandboxName} is already active`)
			try {
				const existing = fs.lstatSync(tempRoot)
				if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`refusing unexpected OpenShell scratch path ${tempRoot}`)
				fs.rmSync(tempRoot, { recursive: true, force: true })
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
			fs.mkdirSync(tempRoot, { mode: 0o700 })
			ownsTempRoot = true
			fs.mkdirSync(exportDir, { mode: 0o700 })
			const branchRef = execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: hostWorkspace, encoding: "utf8" }).trim()
			if (!branchRef.startsWith("refs/heads/")) throw new Error(`OpenShell requires a local worktree branch, got ${branchRef}`)
			const branchName = branchRef.slice("refs/heads/".length)
			const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: hostWorkspace, encoding: "utf8" }).trim()
			const cloned = spawnSync("git", ["clone", "--no-local", "--single-branch", "--branch", branchName, hostWorkspace, sandboxWorkspace], { encoding: "utf8", timeout: 120_000 })
			if (cloned.status !== 0) throw new Error(`OpenShell isolated Git clone failed: ${cloned.stderr || cloned.stdout}`)
			const ident = execFileSync("git", ["var", "GIT_AUTHOR_IDENT"], { cwd: hostWorkspace, encoding: "utf8" }).trim()
			const match = /^(.*) <([^<>]+)> \d+ [+-]\d{4}$/.exec(ident)
			if (match) {
				execFileSync("git", ["-C", sandboxWorkspace, "config", "user.name", match[1]])
				execFileSync("git", ["-C", sandboxWorkspace, "config", "user.email", match[2]])
			}
			fs.appendFileSync(path.join(sandboxWorkspace, ".git", "info", "exclude"), "\n/ORCHESTRATOR_TASK.md\n/ORCHESTRATOR_PLAN.md\n/.qa-task.md\n/.env\n/.env.*\n/.headlesscode/\n/.headlesscode-session/\n/.harness.*\n/harness.log\n/qa.log\n/review.log\n")
			// Stage only known orchestration inputs that wrappers can reference by
			// path. The disposable clone does not include arbitrary host files.
			for (const inputName of ["ORCHESTRATOR_TASK.md", "ORCHESTRATOR_PLAN.md", ".qa-task.md"]) {
				const inputPath = path.join(hostWorkspace, inputName)
				try {
					const inputStat = fs.lstatSync(inputPath)
					if (!inputStat.isFile() || inputStat.isSymbolicLink()) throw new Error(`OpenShell task input is not a regular file: ${inputPath}`)
					fs.copyFileSync(inputPath, path.join(sandboxWorkspace, inputName))
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				}
			}
			// The orchestrator creates this file from port overrides only for
			// OpenShell worktrees. Copy just those known-safe settings.
			const envSource = path.join(hostWorkspace, ".env")
			try {
				if (fs.lstatSync(envSource).isFile()) {
					const safeEnv = fs.readFileSync(envSource, "utf8").split(/\r?\n/).filter((line) => /^(COMPOSE_PROJECT_NAME|POSTGRES_PORT|AIRUNNER_HTTP_PORT|VITE_PORT)=/.test(line))
					fs.writeFileSync(path.join(sandboxWorkspace, ".env"), `${safeEnv.join("\n")}\n`, { mode: 0o600 })
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
			return { hostWorkspace, sandboxWorkspace, exportDir, tempRoot, lockPath, branchRef, baseCommit, importResults: this.importResults }
		} catch (error) {
			if (ownsTempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
			if (ownsLock) fs.rmSync(lockPath, { recursive: true, force: true })
			throw error
		}
	}

	private async createSandbox(
		request: CloudSessionRequest,
		repo: string,
		hostWorkspace: string,
		isolated: OpenShellWorkspaceState,
		name: string,
	): Promise<SessionHandle> {
		const { sandboxWorkspace } = isolated
		if (!this.policy || !fs.existsSync(this.policy)) throw new Error("OpenShell requires a base policy file")
		const args = ["sandbox", "create", "--detach", this.autoProviders ? "--auto-providers" : "--no-auto-providers", "--cpu", this.cpu, "--memory", this.memory, "--name", name, "--from", this.image]
		if (this.gpu !== undefined) args.push("--gpu", String(this.gpu))
		if (this.policy) args.push("--policy", path.resolve(this.policy))
		for (const provider of this.providers) args.push("--provider", provider)
		// Only the disposable clone is writable inside the sandbox. Host Git
		// metadata and process-control files live in the separate orchestration
		// worktree, which is never mounted into the container.
		const mounts: Array<{ type: string; source: string; target: string; read_only: boolean }> = [
			{ type: "bind", source: sandboxWorkspace, target: OPENSHELL_WORKSPACE_TARGET, read_only: false },
			{ type: "bind", source: isolated.exportDir, target: "/result", read_only: false },
		]
		const dataSnapshotRoot = path.join(isolated.tempRoot, "data")
		const policy = this.policy ? parse(fs.readFileSync(this.policy, "utf8")) as Record<string, any> : undefined
		const filesystemPolicy = policy?.filesystem_policy
		if (!filesystemPolicy || !Array.isArray(filesystemPolicy.read_only) || !Array.isArray(filesystemPolicy.read_write)) {
			throw new Error("policy must define filesystem_policy.read_only and read_write arrays")
		}
		filesystemPolicy.read_write.push(OPENSHELL_WORKSPACE_TARGET)
		filesystemPolicy.read_write.push("/result")
		policy.network_policies = { ...(policy.network_policies ?? {}), ...this.networkPolicy }
		filesystemPolicy.read_only.push(OPENSHELL_HARNESS_ROOT)
		let projectDataMounted = false
		if (this.includeProjectData) {
			const projectData = resolveProjectDataDir(repo)
			if (fs.existsSync(projectData)) {
				const projectDataTarget = "/opt/headlesscode-data/projects/" + path.basename(projectData)
				const projectDataSnapshot = path.join(dataSnapshotRoot, "projects", path.basename(projectData))
				fs.mkdirSync(path.dirname(projectDataSnapshot), { recursive: true })
				fs.cpSync(projectData, projectDataSnapshot, { recursive: true, dereference: true })
				mounts.push({ type: "bind", source: projectDataSnapshot, target: projectDataTarget, read_only: true })
				filesystemPolicy.read_only.push(projectDataTarget)
				projectDataMounted = true
			}
			const sharedData = path.join(projectStoreRoot(), "shared")
			if (fs.existsSync(sharedData)) {
				const sharedDataSnapshot = path.join(dataSnapshotRoot, "shared")
				fs.cpSync(sharedData, sharedDataSnapshot, { recursive: true, dereference: true })
				mounts.push({ type: "bind", source: sharedDataSnapshot, target: "/opt/headlesscode-data/shared", read_only: true })
				filesystemPolicy.read_only.push("/opt/headlesscode-data/shared")
			}
		}
		const checkpointsSnapshot = path.join(dataSnapshotRoot, "checkpoints")
		fs.mkdirSync(checkpointsSnapshot, { recursive: true })
		mounts.push({ type: "bind", source: checkpointsSnapshot, target: "/opt/headlesscode-data/checkpoints", read_only: false })
		if (projectDataMounted) filesystemPolicy.read_only.push("/opt/headlesscode-data")
		else filesystemPolicy.read_write.push("/opt/headlesscode-data")
		filesystemPolicy.read_write.push("/opt/headlesscode-data/checkpoints")
		const memoryDir = request.env?.HEADLESSCODE_MEMORY_DIR
		if (memoryDir) {
			const requestedMemoryPath = path.resolve(memoryDir)
			assertNoSymlinkAncestors(requestedMemoryPath)
			const memoryHost = fs.realpathSync(requestedMemoryPath)
			const commonGitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim()
			for (const protectedPath of [hostWorkspace, commonGitDir, isolated.tempRoot, this.scratchRoot]) {
				if (pathsOverlap(memoryHost, path.resolve(protectedPath))) throw new Error(`OpenShell memory path overlaps protected session data: ${memoryHost}`)
			}
			const memorySnapshot = path.join(isolated.tempRoot, "memory")
			fs.mkdirSync(memorySnapshot, { recursive: true })
			copyMemorySnapshot(memoryHost, memorySnapshot)
			isolated.memoryHost = memoryHost
			isolated.memorySnapshot = memorySnapshot
			mounts.push({ type: "bind", source: memorySnapshot, target: "/opt/headlesscode-memory", read_only: false })
			filesystemPolicy.read_write.push("/opt/headlesscode-memory")
		}
		const mountTargets = validateReadOnlyMountTargets(this.readOnlyMounts)
		for (const [index, mount] of this.readOnlyMounts.entries()) {
			const sourceSnapshot = path.join(isolated.tempRoot, "read-only-mounts", String(index))
			fs.mkdirSync(path.dirname(sourceSnapshot), { recursive: true, mode: 0o700 })
			fs.cpSync(path.resolve(mount.source), sourceSnapshot, { recursive: true, dereference: true })
			mounts.push({ type: "bind", source: sourceSnapshot, target: mountTargets[index]!, read_only: true })
			filesystemPolicy.read_only.push(mountTargets[index]!)
		}
		const generatedPolicy = path.join(os.tmpdir(), `headlesscode-openshell-policy-${process.pid}-${Date.now()}.yaml`)
		fs.writeFileSync(generatedPolicy, stringify(policy), { mode: 0o600 })
		args[args.indexOf("--policy") + 1] = generatedPolicy
		args.push("--driver-config-json", JSON.stringify({ docker: { mounts } }))
		for (const [key, value] of Object.entries(request.env ?? {})) {
			if (key === "HEADLESSCODE_MEMORY_DIR" && isolated.memorySnapshot) args.push("--env", "HEADLESSCODE_MEMORY_DIR=/opt/headlesscode-memory")
			else if (key !== "TARGET_REPO") args.push("--env", `${key}=${value}`)
		}
		args.push("--env", `TARGET_REPO=${OPENSHELL_WORKSPACE_TARGET}`, "--env", `HEADLESSCODE_ROOT=${OPENSHELL_HARNESS_ROOT}`, "--env", "HEADLESSCODE_DATA_DIR=/opt/headlesscode-data", "--env", `HEADLESSCODE_PROJECT_IDENTITY_ROOT=${this.projectIdentityRoot ?? repo}`, "--env", "GIT_CONFIG_NOSYSTEM=1", "--env", "GIT_CONFIG_GLOBAL=/dev/null")
		args.push("--", "sleep", "infinity")
		this.workspaces.set(name, isolated)
		writeOpenShellSandboxMarker(hostWorkspace, name)
		let result: CommandResult
		try {
			result = this.run(args, this.commandTimeoutMs)
		} finally {
			fs.rmSync(generatedPolicy, { force: true })
		}
		if (result.exitCode !== 0) {
			// A non-zero create often means the sandbox was accepted but failed
			// during provisioning. Clean up this request's deterministic name; if
			// deletion is not confirmed, keep the host marker and scratch tree for
			// the stop-worker recovery path.
			try {
				this.run(["sandbox", "delete", name])
				const deadline = Date.now() + 30_000
				while (this.listSandboxes().includes(name)) {
					if (Date.now() >= deadline) break
					await sleep(250)
				}
				if (!this.listSandboxes().includes(name)) {
					this.workspaces.delete(name)
					fs.rmSync(isolated.tempRoot, { recursive: true, force: true })
					fs.rmSync(isolated.lockPath, { recursive: true, force: true })
					fs.rmSync(path.join(hostWorkspace, ".harness.openshell-sandbox"), { force: true })
				}
			} catch {
				// Preserve the marker and scratch data so operators can recover it.
			}
			throw new Error(`OpenShell sandbox create failed (exit ${result.exitCode}): ${result.output}`)
		}
		return { id: request.worktreeSpec.name, provider: this.name, address: hostWorkspace, containerId: name }
	}

	async waitReady(handle: SessionHandle): Promise<void> {
		const result = this.run(["sandbox", "exec", "--name", this.sandboxName(handle), "--no-login-shell", "--", "true"])
		if (result.exitCode !== 0) throw new Error(`OpenShell sandbox not ready: ${result.output}`)
	}

	async runHarness(handle: SessionHandle, cmd: string): Promise<CommandResult> {
		const name = this.sandboxName(handle)
		const state = this.workspaces.get(name)
		if (!state) throw new Error(`OpenShell isolated workspace state is unavailable for ${name}`)
		let mappedCommand = cmd.split(state.hostWorkspace).join(OPENSHELL_WORKSPACE_TARGET)
		if (state.memoryHost) mappedCommand = mappedCommand.split(state.memoryHost).join("/opt/headlesscode-memory")
		return this.runHarnessCommand(["sandbox", "exec", "--name", name, "--workdir", OPENSHELL_WORKSPACE_TARGET, "--no-login-shell", "--", "/bin/bash", "-c", mappedCommand], this.commandTimeoutMs)
	}

	async collectResults(handle: SessionHandle): Promise<Record<string, unknown>> {
		const root = handle.address
		if (!root) throw new Error(`OpenShellSessionProvider: no workspace path on ${handle.id}`)
		return {
			exitCode: readInt(path.join(root, ".harness.exit")),
			done: fs.existsSync(path.join(root, ".harness.done")),
			summary: tail(path.join(root, "harness.log"), 40),
			worktree: root,
		}
	}

	async teardown(handle: SessionHandle): Promise<void> {
		const name = this.sandboxName(handle)
		if (!handle.address) throw new Error(`OpenShellSessionProvider: no host workspace path on ${handle.id}`)
		const state = this.workspaces.get(name)
		let exportResult: CommandResult | undefined
		let exportError: Error | undefined
		try {
		if (state?.importResults) {
			const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
			const branchRef = quote(state.branchRef)
			const script = [
				"if [ -L /workspace/node_modules ]; then [ \"$(readlink /workspace/node_modules)\" = /opt/headlesscode/node_modules ] || { echo RSI_UNEXPECTED_DEPENDENCY_LINK >&2; exit 79; }; rm -- /workspace/node_modules; elif [ -e /workspace/node_modules ]; then echo RSI_UNEXPECTED_DEPENDENCY_PATH >&2; exit 79; fi",
				"for p in .headlesscode-session .headlesscode .harness.done ORCHESTRATOR_TASK.md ORCHESTRATOR_PLAN.md .qa-task.md harness.log qa.log review.log; do if [ -z \"$(git ls-files -- \"$p\" \"$p/**\")\" ]; then rm -rf -- \"/workspace/$p\"; fi; done",
				"for f in /workspace/.harness.* /workspace/.qa.* /workspace/.review.*; do [ -e \"$f\" ] || continue; rel=\"${f#/workspace/}\"; [ -z \"$(git ls-files -- \"$rel\")\" ] && rm -f -- \"$f\"; done",
				"git ls-files -z -- .env '.env.*' | while IFS= read -r -d '' rel; do git show \"HEAD:$rel\" > \"/workspace/$rel\"; done",
				"for f in /workspace/.env /workspace/.env.*; do [ -e \"$f\" ] || continue; rel=\"${f#/workspace/}\"; git ls-files --error-unmatch -- \"$rel\" >/dev/null 2>&1 || rm -f -- \"$f\"; done",
				"git rm -r --cached --ignore-unmatch -- .rsi-base-model && git add -A -- . ':!.rsi-base-model'",
				"if ! git diff --cached --quiet HEAD; then git -c core.hooksPath=/dev/null commit -m 'HeadlessCode sandbox result'; fi",
				`git bundle create /result/result.bundle ${branchRef}`,
			].join(" && ")
			exportResult = this.run(["sandbox", "exec", "--name", name, "--workdir", OPENSHELL_WORKSPACE_TARGET, "--no-login-shell", "--", "/bin/bash", "-c", script], 120_000)
			if (exportResult.exitCode !== 0) exportError = new Error(`OpenShell Git export failed for ${name}: ${exportResult.output}`)
		}
		} catch (error) { exportError = error instanceof Error ? error : new Error(String(error)) }
		let deleteError: Error | undefined
		try {
			const result = this.run(["sandbox", "delete", name], 30_000)
			if (result.exitCode !== 0 && !/not found|does not exist/i.test(result.output)) deleteError = new Error(`OpenShell sandbox delete failed for ${name}: ${result.output}`)
		} catch (error) { deleteError = error instanceof Error ? error : new Error(String(error)) }
		const deadline = Date.now() + 30_000
		try {
			while (this.listSandboxes().includes(name)) {
				if (Date.now() >= deadline) throw deleteError ?? new Error(`OpenShell sandbox ${name} remains after delete`)
				await sleep(250)
			}
		} catch (error) {
			// Keep the scratch tree and lock if teardown cannot confirm that the
			// gateway released its bind mounts. stop-worker can retry deletion.
			throw error
		}
		try {
			if (deleteError) throw deleteError
			if (state?.importResults) {
				if (exportError) throw exportError
				if (!exportResult || exportResult.exitCode !== 0) throw new Error(`OpenShell Git export failed for ${name}`)
				this.importIsolatedGitResults(state)
			}
			if (state?.memorySnapshot && state.memoryHost) importMemorySnapshot(state.memorySnapshot, state.memoryHost)
		} finally {
			this.workspaces.delete(name)
			if (state) fs.rmSync(state.tempRoot, { recursive: true, force: true })
			if (state) fs.rmSync(state.lockPath, { recursive: true, force: true })
			fs.rmSync(path.join(handle.address, ".harness.openshell-sandbox"), { force: true })
		}
	}

	private importIsolatedGitResults(state: OpenShellWorkspaceState): void {
		const bundlePath = path.join(state.exportDir, "result.bundle")
		const bundleStat = fs.lstatSync(bundlePath)
		if (!bundleStat.isFile() || bundleStat.isSymbolicLink() || bundleStat.size > 2 * 1024 * 1024 * 1024) {
			throw new Error(`OpenShell Git export is not a regular bundle within the 2 GiB limit: ${bundlePath}`)
		}
		const hostHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: state.hostWorkspace, encoding: "utf8" }).trim()
		if (hostHead !== state.baseCommit) throw new Error("OpenShell result import refused because the host worktree moved during the session")
		const hostBranch = execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: state.hostWorkspace, encoding: "utf8" }).trim()
		if (hostBranch !== state.branchRef) throw new Error("OpenShell result import refused because the host worktree switched branches during the session")
		const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: state.hostWorkspace, encoding: "utf8" }).trim()
		if (status) throw new Error("OpenShell result import refused because the host worktree has tracked changes")
		const heads = execFileSync("git", ["bundle", "list-heads", bundlePath], { cwd: state.hostWorkspace, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean)
		if (heads.length !== 1 || !heads[0].endsWith(` ${state.branchRef}`)) throw new Error("OpenShell Git bundle did not contain exactly the expected branch")
		execFileSync("git", ["bundle", "verify", bundlePath], { cwd: state.hostWorkspace, stdio: "pipe", timeout: 30_000 })
		const importRef = `refs/headlesscode/openshell-import/${createHash("sha256").update(bundlePath).digest("hex").slice(0, 24)}`
		const env = { ...process.env }
		for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_INDEX_FILE"]) delete env[key]
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "fetch", "--no-write-fetch-head", "--force", bundlePath, `${state.branchRef}:${importRef}`], { cwd: state.hostWorkspace, env, stdio: "pipe", timeout: 120_000 })
		try {
		execFileSync("git", ["merge-base", "--is-ancestor", state.baseCommit, importRef], { cwd: state.hostWorkspace, env, stdio: "pipe" })
			validateImportedTree(state.hostWorkspace, state.baseCommit, importRef, env)
			execFileSync("git", ["update-ref", state.branchRef, importRef, state.baseCommit], { cwd: state.hostWorkspace, env, stdio: "pipe" })
			const filterConfigResult = spawnSync("git", ["config", "--get-regexp", "^filter\\..*\\.(smudge|process|required)$"], { cwd: state.hostWorkspace, env, encoding: "utf8" })
			if (filterConfigResult.status !== 0 && filterConfigResult.status !== 1) throw new Error(`Could not inspect host Git filters: ${filterConfigResult.stderr}`)
			const filterNames = [...new Set((filterConfigResult.stdout ?? "").split(/\r?\n/).map((line) => /^filter\.(.+)\.(?:smudge|process|required)\s/.exec(line)?.[1]).filter((value): value is string => !!value))]
			const safeCheckoutArgs = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...filterNames.flatMap((name) => ["-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`]), "reset", "--hard", state.branchRef]
			execFileSync("git", safeCheckoutArgs, { cwd: state.hostWorkspace, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "pipe", timeout: 120_000 })
		} finally {
			execFileSync("git", ["update-ref", "-d", importRef], { cwd: state.hostWorkspace, env, stdio: "pipe" })
		}
	}

}

function validateImportedTree(cwd: string, base: string, ref: string, env: NodeJS.ProcessEnv): void {
	const paths = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", base, ref], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split("\0").filter(Boolean)
	const protectedPath = (entry: string): boolean => {
		const root = entry.split("/", 1)[0]
		return root === "ORCHESTRATOR_TASK.md"
			|| root === "harness.log"
			|| root === "qa.log"
			|| root === "review.log"
			|| root === ".headlesscode"
			|| root === ".headlesscode-session"
			|| root === ".env"
			|| root.startsWith(".env.")
			|| root.startsWith(".harness.")
			|| root.startsWith(".qa.")
			|| root.startsWith(".review.")
	}
	const violation = paths.find(protectedPath)
	if (violation) throw new Error(`OpenShell result import refused protected orchestration or secret path: ${violation}`)
}

function readInt(file: string): number | undefined {
	try { const value = Number(fs.readFileSync(file, "utf8").trim()); return Number.isFinite(value) ? value : undefined } catch { return undefined }
}

function tail(file: string, count: number): string {
	try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-count).join("\n") } catch { return "" }
}

function copyMemorySnapshot(source: string, target: string): void {
	assertNoSymlinkAncestors(source)
	for (const category of ["facts", "sessions"]) {
		const sourceDir = path.join(source, category)
		if (!fs.existsSync(sourceDir)) continue
		const stat = fs.lstatSync(sourceDir)
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`OpenShell memory snapshot refused unexpected path ${sourceDir}`)
		fs.mkdirSync(path.join(target, category), { recursive: true })
		for (const name of fs.readdirSync(sourceDir)) {
			if (!/^[A-Za-z0-9._-]+\.jsonl$/.test(name)) continue
			const file = path.join(sourceDir, name)
			const fileStat = fs.lstatSync(file)
			if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 16 * 1024 * 1024) throw new Error(`OpenShell memory snapshot refused unexpected file ${file}`)
			fs.copyFileSync(file, path.join(target, category, name))
		}
	}
}

function importMemorySnapshot(snapshot: string, destination: string): void {
	assertNoSymlinkAncestors(destination)
	for (const category of ["facts", "sessions"]) {
		const sourceDir = path.join(snapshot, category)
		if (!fs.existsSync(sourceDir)) continue
		const directoryStat = fs.lstatSync(sourceDir)
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`OpenShell memory import refused unexpected path ${sourceDir}`)
		for (const name of fs.readdirSync(sourceDir)) {
			if (!/^[A-Za-z0-9._-]+\.jsonl$/.test(name)) continue
			const source = path.join(sourceDir, name)
			const stat = fs.lstatSync(source)
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error(`OpenShell memory import refused unexpected file ${source}`)
			const target = path.join(destination, category, name)
			assertNoSymlinkAncestors(path.dirname(target))
			if (fs.existsSync(target)) {
				const targetStat = fs.lstatSync(target)
				if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error(`OpenShell memory import refused unexpected destination ${target}`)
			}
			const existing = new Set(fs.existsSync(target) ? fs.readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean) : [])
			const additions = fs.readFileSync(source, "utf8").split(/\r?\n/).filter((line) => {
				if (!line) return false
				try { const value = JSON.parse(line); return !!value && typeof value === "object" && !Array.isArray(value) && !existing.has(line) } catch { return false }
			})
			if (additions.length) {
				fs.mkdirSync(path.dirname(target), { recursive: true })
				fs.appendFileSync(target, `${additions.join("\n")}\n`, { mode: 0o600 })
			}
		}
	}
}

function pathsOverlap(left: string, right: string): boolean {
	return isSameOrInside(left, right) || isSameOrInside(right, left)
}

/** Validate nested read-only bind targets before taking filesystem snapshots. */
export function validateReadOnlyMountTargets(readOnlyMounts: Array<{ source: string; target: string }>): string[] {
	const targets = readOnlyMounts.map(({ target }) => {
		if (typeof target !== "string" || target.includes("\0") || target.includes("\\") || /[\r\n]/.test(target)) {
			throw new Error(`OpenShell read-only mount target is unsafe: ${String(target)}`)
		}
		const normalized = path.posix.normalize(target)
		if (target === "/" || !target.startsWith(`${OPENSHELL_WORKSPACE_TARGET}/`) || normalized !== target || target.slice(1).split("/").some((part) => part === ".." || part === "." || part === "")) {
			throw new Error(`OpenShell read-only mount target must be a normalized non-root path beneath ${OPENSHELL_WORKSPACE_TARGET}: ${target}`)
		}
		return normalized
	})
	for (let left = 0; left < targets.length; left += 1) {
		for (let right = left + 1; right < targets.length; right += 1) {
			const a = targets[left]!
			const b = targets[right]!
			if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
				throw new Error(`OpenShell read-only mount targets overlap: ${a} and ${b}`)
			}
		}
	}
	return targets
}

function isSameOrInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child))
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function assertNoSymlinkAncestors(target: string): void {
	const absolute = path.resolve(target)
	let current = path.parse(absolute).root
	for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component)
		try {
			const stat = fs.lstatSync(current)
			if (stat.isSymbolicLink()) throw new Error(`OpenShell path refused symbolic link ${current}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break
			throw error
		}
	}
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
