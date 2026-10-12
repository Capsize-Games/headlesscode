/**
 * OpenShellSessionProvider — experimental CloudProvider backed by NVIDIA
 * OpenShell. Each session uses a disposable, independent Git clone mounted at
 * /workspace. The host worktree and its process-control files are never mounted.
 * After sandbox deletion, a verified Git bundle imports changes to the assigned
 * host branch.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse, stringify } from "yaml"

import { writeTaskFiles } from "../orchestrator/cli.js"
import { projectStoreRoot, resolveProjectDataDir } from "../project-store.js"
import type { CloudProvider, CloudSessionRequest, CommandResult, SessionHandle } from "./provider.js"
import { CONTAINED_EVIDENCE_RUNTIME_PATH, containedGuestEnvironment, verifyContainedSandboxIdentity } from "../security/profile.js"
import type { ContainedRuntimeProfile } from "../security/profile.js"
import type { EmergencyControl } from "../control/emergency-controller.js"

/** The harness is baked into the sandbox image; never mount the host checkout. */
export const OPENSHELL_HARNESS_ROOT = "/opt/headlesscode"

export const OPENSHELL_WORKSPACE_TARGET = "/workspace"

interface LinuxProcessIdentity {
	pid: number
	processGroupId: number
	sessionId: number
	startTime: string
	effectiveUid: number
}

interface LinuxProcessRecord extends LinuxProcessIdentity { state: string }

const MAX_PROC_ENTRIES = 65_536

function parseLinuxProcessStat(pid: number, stat: string): Omit<LinuxProcessRecord, "effectiveUid"> {
	const close = stat.lastIndexOf(")")
	if (close < 0) throw new Error("could not verify an OpenShell launcher process identity")
	const fields = stat.slice(close + 2).split(/\s+/)
	const processGroupId = Number(fields[2])
	const sessionId = Number(fields[3])
	const startTime = fields[19]
	const state = fields[0]
	if (!Number.isSafeInteger(processGroupId) || processGroupId < 0 || !Number.isSafeInteger(sessionId) || sessionId < 0 || !startTime || !/^\d+$/.test(startTime) || !state || state.length !== 1) {
		throw new Error("could not verify an OpenShell launcher process identity")
	}
	return { pid, processGroupId, sessionId, startTime, state }
}

async function readLinuxProcessRecord(pid: number): Promise<LinuxProcessRecord> {
	try {
		const [stat, effectiveUid] = await Promise.all([fs.promises.readFile(`/proc/${pid}/stat`, "utf8"), readLinuxEffectiveUid(pid)])
		const identity = parseLinuxProcessStat(pid, stat)
		return { ...identity, effectiveUid }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") {
			const missing = new Error("OpenShell process exited before its identity could be verified", { cause: error }) as NodeJS.ErrnoException
			missing.code = "ESRCH"
			throw missing
		}
		throw new Error("could not read an OpenShell process identity from procfs", { cause: error })
	}
}

async function readLinuxEffectiveUid(pid: number): Promise<number> {
	const status = await fs.promises.readFile(`/proc/${pid}/status`, "utf8")
	const uidLine = status.split("\n").find((line) => line.startsWith("Uid:"))
	const effectiveUid = Number(uidLine?.trim().split(/\s+/)[2])
	if (!Number.isSafeInteger(effectiveUid) || effectiveUid < 0) throw new Error("could not verify an OpenShell launcher effective UID")
	return effectiveUid
}

function matchesLinuxProcessIdentity(record: LinuxProcessIdentity, expected: LinuxProcessIdentity): boolean {
	return record.pid === expected.pid && record.processGroupId === expected.processGroupId && record.sessionId === expected.sessionId && record.startTime === expected.startTime && record.effectiveUid === expected.effectiveUid
}

function assertLinuxLauncherIdentity(record: LinuxProcessIdentity, expected: LinuxProcessIdentity): void {
	if (record.pid === expected.pid && !matchesLinuxProcessIdentity(record, expected)) throw new Error("OpenShell launcher PID was reused; teardown stopped")
}

async function listLinuxOpenShellGroup(identity: LinuxProcessIdentity, deadline = Number.POSITIVE_INFINITY): Promise<LinuxProcessRecord[]> {
	let entries: string[]
	try { entries = await fs.promises.readdir("/proc") }
	catch (error) { throw new Error("could not inspect procfs to verify OpenShell process teardown", { cause: error }) }
	if (Date.now() >= deadline) throw new Error("OpenShell process teardown exceeded its bounded deadline")
	if (entries.length > MAX_PROC_ENTRIES) throw new Error("procfs process count exceeded the OpenShell teardown inspection bound")
	const records: LinuxProcessRecord[] = []
	for (const entry of entries) {
		if (Date.now() >= deadline) throw new Error("OpenShell process teardown exceeded its bounded deadline")
		if (!/^\d+$/.test(entry)) continue
		const pid = Number(entry)
		if (!Number.isSafeInteger(pid) || pid < 1) continue
		let identityRecord: Omit<LinuxProcessRecord, "effectiveUid">
		try { identityRecord = parseLinuxProcessStat(pid, await fs.promises.readFile(`/proc/${pid}/stat`, "utf8")) }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "ENOENT" || code === "ESRCH") continue
			throw new Error("could not inspect every process while verifying OpenShell teardown", { cause: error })
		}
		if (identityRecord.pid === identity.pid || (identityRecord.processGroupId === identity.processGroupId && identityRecord.sessionId === identity.sessionId)) {
			let record: LinuxProcessRecord
			try { record = { ...identityRecord, effectiveUid: await readLinuxEffectiveUid(pid) } }
			catch (error) {
				const code = (error as NodeJS.ErrnoException).code
				if (code === "ENOENT" || code === "ESRCH") continue
				throw new Error("could not inspect every process while verifying OpenShell teardown", { cause: error })
			}
			if (record.pid === identity.pid) assertLinuxLauncherIdentity(record, identity)
			if (record.processGroupId !== identity.processGroupId || record.sessionId !== identity.sessionId) continue
			if (record.effectiveUid !== identity.effectiveUid) throw new Error("OpenShell process-group member changed effective UID; teardown stopped")
			if (record.state !== "Z" && record.state !== "X") records.push(record)
		}
	}
	if (Date.now() >= deadline) throw new Error("OpenShell process teardown exceeded its bounded deadline")
	return records
}

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
	/** Immutable supervisor-resolved profile required for fail-closed contained sessions. */
	containedProfile?: ContainedRuntimeProfile
	/** Per-session evidence capability; runtime-only and never copied into environment or prompts. */
	evidenceRuntimeConfig?: { sessionId: string; capability: string; pinnedPublicKey: { keyId: string; publicKeyPem: string } }
	run?: (args: string[], timeoutMs?: number) => CommandResult
	/** Async command runner used for long guest commands so host services can keep serving requests. */
	runAsync?: (args: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<CommandResult>
	listSandboxes?: () => string[]
	signal?: AbortSignal
	stopGraceMs?: number
	deleteVerifyTimeoutMs?: number
	emergencyControl?: Pick<EmergencyControl, "identity" | "state" | "stateDirectoryPath" | "signal" | "assertRunning" | "registerCleanup" | "registerResource" | "releaseResource">
}

export function runOpenShellCommandAsync(args: string[], timeoutMs?: number, executable = "openshell", signal?: AbortSignal, graceMs = 1_000): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(signal.reason ?? new Error("OpenShell command aborted")); return }
		const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" })
		let stdout = ""
		let stderr = ""
		let timer: NodeJS.Timeout | undefined
		let finalizationTimer: NodeJS.Timeout | undefined
		let aborted = false
		let timedOut = false
		let finished = false
		let processIdentity: LinuxProcessIdentity | undefined
		let processIdentityFailure: unknown
		let markProcessIdentityReady!: () => void
		const processIdentityReady = new Promise<void>((resolveReady) => { markProcessIdentityReady = resolveReady })
		let terminationPromise: Promise<void> | undefined
		let terminationFailure: unknown
		const boundedGraceMs = Math.min(5_000, Math.max(1, graceMs))
		// Procfs enumeration is sequential and can involve thousands of entries on
		// a busy host; leave it a bounded verification window after the TERM grace.
		const terminationBoundMs = boundedGraceMs + 5_000
		const append = (current: string, chunk: Buffer) => `${current}${chunk.toString("utf8")}`.slice(-64 * 1024 * 1024)
		child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk) })
		child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk) })
		const cleanup = () => {
			if (timer) clearTimeout(timer)
			if (finalizationTimer) clearTimeout(finalizationTimer)
			signal?.removeEventListener("abort", onAbort)
			child.stdout.destroy()
			child.stderr.destroy()
		}
		const settleFailure = (error: unknown) => {
			if (finished) return
			finished = true
			cleanup()
			reject(error)
		}
		const settleResult = (code: number | null, childSignal: NodeJS.Signals | null) => {
			if (finished) return
			finished = true
			cleanup()
			const details = [timedOut ? `timeout=true (after ${timeoutMs}ms)` : undefined, code !== 0 ? `exitCode=${code ?? 1}` : undefined, childSignal ? `signal=${childSignal}` : undefined].filter(Boolean).join(" ")
			resolve({ exitCode: code ?? 1, output: [stdout, stderr, details].filter(Boolean).join("\n").trim() })
		}
		const signalIndividuallyAfterGroupEperm = async (name: NodeJS.Signals, deadline: number) => {
			if (process.platform !== "linux" || !child.pid) throw new Error("OpenShell process-group signal was denied and verified Linux fallback is unavailable")
			await processIdentityReady
			if (processIdentityFailure) throw new Error("OpenShell launcher process-group identity could not be verified; teardown stopped", { cause: processIdentityFailure })
			const identity = processIdentity
			if (!identity || identity.pid !== child.pid || identity.processGroupId !== child.pid || identity.sessionId !== child.pid) throw new Error("OpenShell launcher process-group identity is unavailable; teardown stopped")
			const members = await listLinuxOpenShellGroup(identity, deadline)
			for (const member of members.sort((left, right) => Number(left.pid === identity.pid) - Number(right.pid === identity.pid))) {
				if (Date.now() >= deadline) throw new Error("OpenShell process teardown exceeded its bounded deadline")
				let current: LinuxProcessRecord
				try { current = await readLinuxProcessRecord(member.pid) }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ESRCH") continue
					throw error
				}
				assertLinuxLauncherIdentity(current, identity)
				if (!matchesLinuxProcessIdentity(current, member)) throw new Error("OpenShell process PID was reused before teardown; teardown stopped")
				if (current.state === "Z" || current.state === "X") continue
				if (Date.now() >= deadline) throw new Error("OpenShell process teardown exceeded its bounded deadline")
				try { process.kill(current.pid, name) }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("could not signal a verified OpenShell process-group member", { cause: error })
				}
			}
		}
		const send = async (name: NodeJS.Signals, deadline: number) => {
			if (!child.pid) return
			if (process.platform === "linux") {
				await processIdentityReady
				if (processIdentityFailure) throw new Error("OpenShell launcher process-group identity could not be verified; teardown stopped", { cause: processIdentityFailure })
				if (!processIdentity) throw new Error("OpenShell launcher process-group identity is unavailable; teardown stopped")
				if (Date.now() >= deadline) throw new Error("OpenShell process teardown exceeded its bounded deadline")
				// Verify that the captured group/session still has an owned live member
				// immediately before the primary group signal, rejecting a reused PGID.
				if ((await listLinuxOpenShellGroup(processIdentity, deadline)).length === 0) return
			}
			if (Date.now() >= deadline) throw new Error("OpenShell process teardown exceeded its bounded deadline")
			try { process.kill(process.platform === "win32" ? child.pid : -child.pid, name) }
			catch (error) {
				const code = (error as NodeJS.ErrnoException).code
				if (code === "ESRCH") return
				if (code !== "EPERM" || process.platform !== "linux") throw error
				await signalIndividuallyAfterGroupEperm(name, deadline)
			}
		}
		const wait = async (ms: number, deadline: number) => {
			const remaining = deadline - Date.now()
			if (remaining > 0) await new Promise<void>((done) => setTimeout(done, Math.min(ms, remaining)))
		}
		const groupIsTerminal = async (deadline: number): Promise<boolean> => {
			if (!child.pid) return true
			if (process.platform === "win32") return child.exitCode !== null || child.signalCode !== null
			if (process.platform === "linux") {
				await processIdentityReady
				if (processIdentityFailure) throw new Error("OpenShell launcher process-group identity could not be verified; teardown stopped", { cause: processIdentityFailure })
				if (!processIdentity) throw new Error("OpenShell launcher process-group identity is unavailable; teardown stopped")
				if (Date.now() >= deadline) throw new Error("OpenShell process teardown exceeded its bounded deadline")
				return (await listLinuxOpenShellGroup(processIdentity, deadline)).length === 0
			}
			try { process.kill(-child.pid, 0); return false }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error }
		}
		const signalOwnedLauncher = async (name: NodeJS.Signals, deadline: number) => {
			if (!child.pid) return
			if (process.platform === "linux") {
				await processIdentityReady
				if (processIdentityFailure) throw new Error("OpenShell launcher process-group identity could not be verified; teardown stopped", { cause: processIdentityFailure })
				const identity = processIdentity
				if (!identity || identity.pid !== child.pid) throw new Error("OpenShell launcher identity is unavailable; teardown stopped")
				const current = await readLinuxProcessRecord(identity.pid)
				assertLinuxLauncherIdentity(current, identity)
				if (!matchesLinuxProcessIdentity(current, identity)) throw new Error("OpenShell launcher PID was reused before teardown; teardown stopped")
				if (current.state === "Z" || current.state === "X") return
				if (Date.now() >= deadline) throw new Error("OpenShell process teardown exceeded its bounded deadline")
				try { process.kill(current.pid, name) }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
				return
			}
			if (Date.now() >= deadline) throw new Error("OpenShell process teardown exceeded its bounded deadline")
			try { child.kill(name) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
		}
		const terminateOwnedProcesses = async (deadline: number): Promise<void> => {
			let firstFailure: unknown
			const attempt = async (name: NodeJS.Signals) => {
				try { await send(name, deadline) }
				catch (error) {
					if (firstFailure === undefined) firstFailure = error
					try { await signalOwnedLauncher(name, deadline) } catch { /* the failure remains recorded and verification continues */ }
				}
			}
			await attempt("SIGTERM")
			const graceDeadline = Math.min(deadline, Date.now() + boundedGraceMs)
			while (Date.now() < graceDeadline) {
				try { if (await groupIsTerminal(deadline)) break }
				catch (error) { if (firstFailure === undefined) firstFailure = error }
				await wait(25, graceDeadline)
			}
			await attempt("SIGKILL")
			while (Date.now() < deadline) {
				try {
					if (await groupIsTerminal(deadline)) {
						if (firstFailure !== undefined) throw firstFailure
						return
					}
				} catch (error) { if (firstFailure === undefined) firstFailure = error }
				await wait(20, deadline)
			}
			if (firstFailure !== undefined) throw firstFailure
			throw new Error("OpenShell launcher process group remains after bounded SIGKILL teardown")
		}
		const startTermination = () => {
			if (!child.pid || terminationPromise || finished) return
			const deadline = Date.now() + terminationBoundMs
			terminationPromise = terminateOwnedProcesses(deadline)
			void terminationPromise.then(
				() => { if (aborted) settleFailure(signal?.reason ?? new Error("OpenShell command aborted")); else settleResult(child.exitCode, child.signalCode) },
				(error: unknown) => { terminationFailure = error; settleFailure(error) },
			)
			finalizationTimer = setTimeout(() => {
				settleFailure(terminationFailure ?? new Error("OpenShell process teardown did not finalize before its bounded deadline"))
			}, terminationBoundMs + 250)
		}
		const onAbort = () => { aborted = true; startTermination() }
		if (timeoutMs !== undefined) timer = setTimeout(() => { timedOut = true; startTermination() }, timeoutMs)
		signal?.addEventListener("abort", onAbort, { once: true })
		child.once("spawn", () => {
			if (process.platform === "linux" && child.pid) {
				const pid = child.pid
				void readLinuxProcessRecord(pid).then((record) => {
					if (record.pid !== pid || record.processGroupId !== pid || record.sessionId !== pid) throw new Error("OpenShell launcher is not the leader of its detached process group")
					processIdentity = record
			}).catch((error: unknown) => { processIdentityFailure = error }).finally(markProcessIdentityReady)
			} else {
				markProcessIdentityReady()
			}
			if (aborted || timedOut) startTermination()
		})
		child.once("error", (error) => {
			markProcessIdentityReady()
			settleFailure((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error("OpenShell CLI executable was not found") : error)
		})
		child.once("close", (code, childSignal) => {
			if (aborted || timedOut) {
				if (!terminationPromise) startTermination()
				void terminationPromise?.then(() => {
					if (aborted) settleFailure(signal?.reason ?? new Error("OpenShell command aborted"))
					else settleResult(code, childSignal)
				}, settleFailure)
				return
			}
			settleResult(code, childSignal)
		})
		child.stdin.end()
	})
}
export class OpenShellSessionProvider implements CloudProvider {
	readonly name = "openshell"
	readonly emergencyManaged = true
	private readonly image: string
	private readonly policy?: string
	private readonly providers: string[]
	private readonly autoProviders: boolean
	private readonly cpu: string
	private readonly memory: string
	private readonly namePrefix: string
	private readonly readOnlyMounts: Array<{ source: string; target: string }>
	private readonly run: (args: string[], timeoutMs?: number) => CommandResult
	private readonly runHarnessCommand: (args: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<CommandResult>
	private readonly listSandboxes: () => string[]
	private readonly importResults: boolean
	private readonly scratchRoot: string
	private readonly includeProjectData: boolean
	private readonly projectIdentityRoot?: string
	private readonly networkPolicy: Record<string, unknown>
	private readonly commandTimeoutMs: number
	private readonly externalSignal?: AbortSignal
	private readonly stopGraceMs: number
	private readonly deleteVerifyTimeoutMs: number
	private readonly emergencyControl?: OpenShellSessionProviderOptions["emergencyControl"]
	private readonly gpu?: number
	private readonly containedProfile?: ContainedRuntimeProfile
	private readonly evidenceRuntimeConfig?: OpenShellSessionProviderOptions["evidenceRuntimeConfig"]
	private readonly workspaces = new Map<string, OpenShellWorkspaceState>()
	private readonly controlCleanups = new Map<string, () => void>()
	private readonly creating = new Map<string, Promise<void>>()

	constructor(options: OpenShellSessionProviderOptions = {}) {
		this.image = options.image ?? process.env.HEADLESSCODE_OPENSHELL_IMAGE ?? "headlesscode-openshell:local"
		this.policy = options.policy ?? process.env.HEADLESSCODE_OPENSHELL_POLICY
		this.providers = options.providers ?? (process.env.HEADLESSCODE_OPENSHELL_PROVIDERS ?? "headlesscode-openrouter").split(",").map((name) => name.trim()).filter(Boolean)
		this.autoProviders = options.autoProviders ?? !options.containedProfile
		this.cpu = options.cpu ?? process.env.HEADLESSCODE_OPENSHELL_CPU ?? "2"
		this.memory = options.memory ?? process.env.HEADLESSCODE_OPENSHELL_MEMORY ?? "4Gi"
		this.namePrefix = options.namePrefix ?? process.env.HEADLESSCODE_OPENSHELL_NAME_PREFIX ?? "hcls"
		this.readOnlyMounts = options.readOnlyMounts ?? []
		this.importResults = options.importResults ?? true
		this.scratchRoot = path.resolve(options.scratchRoot ?? process.env.HEADLESSCODE_OPENSHELL_SCRATCH_ROOT ?? path.join(os.homedir(), ".local", "share", "headlesscode", "openshell-sessions"))
		this.includeProjectData = options.includeProjectData ?? !options.containedProfile
		this.projectIdentityRoot = options.projectIdentityRoot
		this.networkPolicy = options.networkPolicy ?? {}
		this.commandTimeoutMs = options.commandTimeoutMs ?? 15 * 60_000
		this.externalSignal = options.signal
		this.stopGraceMs = options.stopGraceMs ?? 2_000
		this.deleteVerifyTimeoutMs = options.deleteVerifyTimeoutMs ?? 30_000
		this.emergencyControl = options.emergencyControl
		if (options.gpu !== undefined && (!Number.isInteger(options.gpu) || options.gpu < 1 || options.gpu > 8)) throw new Error("OpenShell GPU count must be an integer from 1 to 8")
		this.gpu = options.gpu
		this.containedProfile = options.containedProfile
		this.evidenceRuntimeConfig = options.evidenceRuntimeConfig
		if (this.containedProfile) {
			if (this.gpu !== undefined) throw new Error("contained profile does not permit GPU allocation")
			if (!this.emergencyControl || this.emergencyControl.identity !== this.containedProfile.expectedEmergencyControllerIdentity) throw new Error("contained profile requires the pinned, active supervisor emergency controller")
			this.emergencyControl.assertRunning()
			if (!this.evidenceRuntimeConfig) throw new Error("contained profile requires a supervisor-authorized evidence session capability")
			if (!this.evidenceRuntimeConfig.sessionId || !/^[A-Za-z0-9_-]{43}$/.test(this.evidenceRuntimeConfig.capability) || Buffer.from(this.evidenceRuntimeConfig.capability, "base64url").length !== 32) {
				throw new Error("contained profile requires a correctly scoped 32-byte evidence capability")
			}
			if (this.image !== this.containedProfile.image || this.policy !== this.containedProfile.policySnapshotPath || this.cpu !== this.containedProfile.cpu || this.memory !== this.containedProfile.memory || this.providers.join("\0") !== this.containedProfile.providers.join("\0")) {
				throw new Error("OpenShell request settings differ from the resolved contained profile")
			}
			if (options.autoProviders === true || options.includeProjectData === true || this.readOnlyMounts.length || Object.keys(this.networkPolicy).length) {
				throw new Error("contained sessions cannot attach ambient providers, project snapshots, arbitrary mounts, or network overrides")
			}
		}
		const injectedRun = options.run
		this.run = injectedRun ?? ((args, timeoutMs) => {
			const result = spawnSync("openshell", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs })
			return { exitCode: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() }
		})
		this.runHarnessCommand = options.runAsync ?? (injectedRun
			? async (args, timeoutMs) => injectedRun(args, timeoutMs)
			: (args, timeoutMs, signal) => runOpenShellCommandAsync(args, timeoutMs, "openshell", signal, this.stopGraceMs))
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

	private get signal(): AbortSignal | undefined { return this.externalSignal ?? this.emergencyControl?.signal }

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
		this.emergencyControl?.assertRunning()
		const { sandboxWorkspace } = isolated
		if (this.containedProfile && this.emergencyControl) {
			const controlPath = path.resolve(this.emergencyControl.stateDirectoryPath)
			assertNoSymlinkAncestors(controlPath)
			for (const root of [repo, hostWorkspace, isolated.tempRoot, this.scratchRoot]) {
				if (pathsOverlap(controlPath, path.resolve(root))) throw new Error("supervisor control state must remain outside all worker and OpenShell scratch roots")
			}
		}
		if (!this.policy || !fs.existsSync(this.policy)) throw new Error("OpenShell requires a base policy file")
		const reviewedPolicyBytes = fs.readFileSync(this.policy)
		if (this.containedProfile && createHash("sha256").update(reviewedPolicyBytes).digest("hex") !== this.containedProfile.policySha256) {
			throw new Error("contained policy snapshot changed before sandbox creation")
		}
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
		const policy = parse(reviewedPolicyBytes.toString("utf8")) as Record<string, any>
		const filesystemPolicy = policy?.filesystem_policy
		if (!filesystemPolicy || !Array.isArray(filesystemPolicy.read_only) || !Array.isArray(filesystemPolicy.read_write)) {
			throw new Error("policy must define filesystem_policy.read_only and read_write arrays")
		}
		filesystemPolicy.read_write.push(OPENSHELL_WORKSPACE_TARGET)
		filesystemPolicy.read_write.push("/result")
		if (this.containedProfile) {
			const profile = this.containedProfile
			if (profile.purpose !== "worker") throw new Error("worker launcher cannot run an evaluation profile")
			if (!this.evidenceRuntimeConfig || this.evidenceRuntimeConfig.pinnedPublicKey.keyId !== profile.evidencePublicKeyFingerprint) throw new Error("evidence session key does not match the pinned contained profile")
			if (this.evidenceRuntimeConfig.pinnedPublicKey.publicKeyPem.trim() !== fs.readFileSync(profile.evidencePublicKeyPath, "utf8").trim()) throw new Error("evidence runtime public key differs from the pinned collector key file")
			if (!this.evidenceRuntimeConfig.sessionId || !this.evidenceRuntimeConfig.capability) throw new Error("evidence runtime configuration is missing its scoped session capability")
			filesystemPolicy.read_write.push(profile.evidenceGuestPath)
			filesystemPolicy.read_only.push(profile.evidenceGuestPublicKeyPath)
			const evidenceRuntimePath = path.join(isolated.tempRoot, "evidence-runtime.json")
			fs.writeFileSync(evidenceRuntimePath, JSON.stringify({
				sessionId: this.evidenceRuntimeConfig.sessionId,
				socketPath: profile.evidenceGuestPath,
				capability: this.evidenceRuntimeConfig.capability,
				pinnedPublicKey: this.evidenceRuntimeConfig.pinnedPublicKey,
				evidenceRequired: true,
			}), { flag: "wx", mode: 0o400 })
			fs.chmodSync(evidenceRuntimePath, 0o400)
			mounts.push({ type: "bind", source: profile.evidenceSocketPath, target: profile.evidenceGuestPath, read_only: false })
			mounts.push({ type: "bind", source: profile.evidencePublicKeyPath, target: profile.evidenceGuestPublicKeyPath, read_only: true })
			mounts.push({ type: "bind", source: evidenceRuntimePath, target: CONTAINED_EVIDENCE_RUNTIME_PATH, read_only: true })
		}
		policy.network_policies = { ...(policy.network_policies ?? {}), ...this.networkPolicy }
		filesystemPolicy.read_only.push(OPENSHELL_HARNESS_ROOT)
		let projectDataMounted = false
		if (this.includeProjectData && !this.containedProfile) {
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
		else if (!this.containedProfile) filesystemPolicy.read_write.push("/opt/headlesscode-data")
		filesystemPolicy.read_write.push("/opt/headlesscode-data/checkpoints")
		const memoryDir = this.containedProfile ? undefined : request.env?.HEADLESSCODE_MEMORY_DIR
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
		const generatedPolicy = path.join(isolated.tempRoot, "policy.generated.yaml")
		fs.writeFileSync(generatedPolicy, stringify(policy), { flag: "wx", mode: 0o600 })
		args[args.indexOf("--policy") + 1] = generatedPolicy
		args.push("--driver-config-json", JSON.stringify({ docker: { mounts } }))
		const guestEnvironment = this.containedProfile
			? containedGuestEnvironment(this.containedProfile, {}, request.env ?? {}, {
				GIT_AUTHOR_NAME: request.env?.GIT_AUTHOR_NAME ?? "",
				GIT_AUTHOR_EMAIL: request.env?.GIT_AUTHOR_EMAIL ?? "",
				GIT_COMMITTER_NAME: request.env?.GIT_COMMITTER_NAME ?? "",
				GIT_COMMITTER_EMAIL: request.env?.GIT_COMMITTER_EMAIL ?? "",
			})
			: request.env ?? {}
		for (const [key, value] of Object.entries(guestEnvironment)) {
			if (key === "HEADLESSCODE_MEMORY_DIR" && isolated.memorySnapshot) args.push("--env", "HEADLESSCODE_MEMORY_DIR=/opt/headlesscode-memory")
			else if (key !== "TARGET_REPO") args.push("--env", `${key}=${value}`)
		}
		args.push("--env", `TARGET_REPO=${OPENSHELL_WORKSPACE_TARGET}`, "--env", `HEADLESSCODE_ROOT=${OPENSHELL_HARNESS_ROOT}`, "--env", "HEADLESSCODE_DATA_DIR=/opt/headlesscode-data", "--env", `HEADLESSCODE_PROJECT_IDENTITY_ROOT=${this.containedProfile ? OPENSHELL_WORKSPACE_TARGET : this.projectIdentityRoot ?? repo}`, "--env", "GIT_CONFIG_NOSYSTEM=1", "--env", "GIT_CONFIG_GLOBAL=/dev/null")
		args.push("--", "sleep", "infinity")
		this.workspaces.set(name, isolated)
		writeOpenShellSandboxMarker(hostWorkspace, name)
		const resource = `openshell:${name}`
		let resolveCreation!: () => void
		const creationSettled = new Promise<void>((resolve) => { resolveCreation = resolve })
		this.creating.set(name, creationSettled)
		if (this.emergencyControl) {
			try {
				this.controlCleanups.set(name, this.emergencyControl.registerCleanup(`openshell-provider-${name}`, async () => {
					await creationSettled
					await this.stopSandbox(name)
					this.forgetSandboxState(name)
				}, resource))
				await this.emergencyControl.registerResource(resource)
				this.emergencyControl.assertRunning()
			} catch (error) { resolveCreation(); throw error }
		}
		let result: CommandResult
		try {
			result = await this.runHarnessCommand(args, this.commandTimeoutMs, this.signal)
		} catch (error) {
			if (this.signal?.aborted) await this.stopSandbox(name, false)
			throw error
		} finally {
			fs.rmSync(generatedPolicy, { force: true })
			resolveCreation()
		}
		if (this.signal?.aborted) {
			await this.stopSandbox(name, false)
			throw this.signal.reason ?? new Error("OpenShell sandbox creation aborted")
		}
		if (result.exitCode !== 0) {
			// A non-zero create often means the sandbox was accepted but failed
			// during provisioning. Clean up this request's deterministic name; if
			// deletion is not confirmed, keep the host marker and scratch tree for
			// the stop-worker recovery path.
			try {
				await this.stopSandbox(name, false)
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
		if (this.containedProfile) {
			try {
				verifyContainedSandboxIdentity({ probe: (probeArgs, timeoutMs) => {
					const checked = this.run(probeArgs, timeoutMs)
					return { status: checked.exitCode, stdout: checked.output }
				}, name, profile: this.containedProfile })
			} catch (error) {
				throw new Error(`contained OpenShell sandbox failed identity/effective-policy verification: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		this.creating.delete(name)
		return { id: request.worktreeSpec.name, provider: this.name, address: hostWorkspace, containerId: name }
	}

	async waitReady(handle: SessionHandle): Promise<void> {
		this.emergencyControl?.assertRunning()
		const result = await this.runHarnessCommand(["sandbox", "exec", "--name", this.sandboxName(handle), "--no-login-shell", "--", "true"], this.commandTimeoutMs, this.signal)
		if (result.exitCode !== 0) throw new Error(`OpenShell sandbox not ready: ${result.output}`)
	}

	async runHarness(handle: SessionHandle, cmd: string): Promise<CommandResult> {
		this.emergencyControl?.assertRunning()
		const name = this.sandboxName(handle)
		const state = this.workspaces.get(name)
		if (!state) throw new Error(`OpenShell isolated workspace state is unavailable for ${name}`)
		let mappedCommand = cmd.split(state.hostWorkspace).join(OPENSHELL_WORKSPACE_TARGET)
		if (state.memoryHost) mappedCommand = mappedCommand.split(state.memoryHost).join("/opt/headlesscode-memory")
		return this.runHarnessCommand(["sandbox", "exec", "--name", name, "--workdir", OPENSHELL_WORKSPACE_TARGET, "--no-login-shell", "--", "/bin/bash", "-c", mappedCommand], this.commandTimeoutMs, this.signal)
	}

	async stopSession(handle: SessionHandle): Promise<void> {
		const name = this.sandboxName(handle)
		await this.stopSandbox(name)
		this.forgetSandboxState(name)
		const resource = `openshell:${name}`
		this.controlCleanups.get(name)?.()
		this.controlCleanups.delete(name)
		await this.emergencyControl?.releaseResource(resource)
	}

	private forgetSandboxState(name: string): void {
		const state = this.workspaces.get(name)
		this.workspaces.delete(name)
		if (!state) return
		fs.rmSync(state.tempRoot, { recursive: true, force: true })
		fs.rmSync(state.lockPath, { recursive: true, force: true })
		fs.rmSync(path.join(state.hostWorkspace, ".harness.openshell-sandbox"), { force: true })
	}

	async stopSandbox(name: string, waitForCreation = true): Promise<void> {
		if (!/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(name)) throw new Error("refusing to delete an invalid OpenShell sandbox name")
		if (waitForCreation) await this.creating.get(name)
		let deleteError: Error | undefined
		try {
			const result = await this.runHarnessCommand(["sandbox", "delete", name], 30_000)
			if (result.exitCode !== 0 && !/not found|does not exist/i.test(result.output)) deleteError = new Error(`OpenShell sandbox delete failed for ${name}: ${result.output}`)
		} catch (error) { deleteError = error instanceof Error ? error : new Error(String(error)) }
		const deadline = Date.now() + this.deleteVerifyTimeoutMs
		try {
			while (this.listSandboxes().includes(name)) {
				if (Date.now() >= deadline) throw deleteError ?? new Error(`OpenShell sandbox ${name} remains after delete`)
				await sleep(250)
			}
		} catch (error) { throw error }
		this.controlCleanups.get(name)?.()
		this.controlCleanups.delete(name)
		this.creating.delete(name)
		await this.emergencyControl?.releaseResource(`openshell:${name}`)
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
		if (state?.importResults && !this.signal?.aborted) {
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
			exportResult = await this.runHarnessCommand(["sandbox", "exec", "--name", name, "--workdir", OPENSHELL_WORKSPACE_TARGET, "--no-login-shell", "--", "/bin/bash", "-c", script], 120_000, this.signal)
			if (exportResult.exitCode !== 0) exportError = new Error(`OpenShell Git export failed for ${name}: ${exportResult.output}`)
		}
		} catch (error) { exportError = error instanceof Error ? error : new Error(String(error)) }
		try { await this.stopSandbox(name) } catch (error) {
			// Keep the scratch tree and lock if teardown cannot confirm that the
			// gateway released its bind mounts. stop-worker can retry deletion.
			throw error
		}
		try {
			if (this.signal?.aborted) return
			if (state?.importResults) {
				if (exportError) throw exportError
				if (!exportResult || exportResult.exitCode !== 0) throw new Error(`OpenShell Git export failed for ${name}`)
				this.importIsolatedGitResults(state)
			}
			if (state?.memorySnapshot && state.memoryHost) importMemorySnapshot(state.memorySnapshot, state.memoryHost)
		} finally {
			this.controlCleanups.get(name)?.()
			this.controlCleanups.delete(name)
			await this.emergencyControl?.releaseResource(`openshell:${name}`)
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
