import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"

interface LinuxProcessIdentity {
	pid: number
	processGroupId: number
	sessionId: number
	startTime: string
}

interface LinuxProcessRecord extends LinuxProcessIdentity {
	state: string
}

const MAX_PROC_ENTRIES = 65_536
const MAX_GROUP_TERMINATION_MS = 2_000

function cleanupError(message: string, cause?: unknown): Error {
	const error = new Error(message, cause === undefined ? undefined : { cause })
	error.name = "OwnedProcessTeardownError"
	return error
}

function parseLinuxProcessStat(pid: number, stat: string): LinuxProcessRecord {
	const close = stat.lastIndexOf(")")
	if (close < 0) throw cleanupError("could not verify an owned process identity")
	const fields = stat.slice(close + 2).split(" ")
	// /proc/<pid>/stat fields after comm start with state (field 3). starttime
	// is field 22, at offset 19 in this tail. It prevents signaling a reused PID.
	const processGroupId = Number(fields[2])
	const sessionId = Number(fields[3])
	const startTime = fields[19]
	const state = fields[0]
	if (!Number.isSafeInteger(processGroupId) || processGroupId < 0 || !Number.isSafeInteger(sessionId) || sessionId < 0 || !startTime || !/^\d+$/.test(startTime) || !state || state.length !== 1) {
		throw cleanupError("could not verify an owned process identity")
	}
	return { pid, processGroupId, sessionId, startTime, state }
}

async function readLinuxProcessIdentity(pid: number): Promise<LinuxProcessRecord> {
	try {
		return parseLinuxProcessStat(pid, await fs.readFile(`/proc/${pid}/stat`, "utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") {
			throw cleanupError("owned process exited before its identity could be verified", error)
		}
		if ((error as Error).name === "OwnedProcessTeardownError") throw error
		throw cleanupError("could not read the owned process identity from procfs", error)
	}
}

async function listOwnedProcessGroup(identity: LinuxProcessIdentity): Promise<LinuxProcessRecord[]> {
	let entries: string[]
	try { entries = await fs.readdir("/proc") }
	catch (error) { throw cleanupError("could not inspect procfs to verify owned process teardown", error) }
	if (entries.length > MAX_PROC_ENTRIES) throw cleanupError("procfs process count exceeded the teardown inspection bound")
	const records: LinuxProcessRecord[] = []
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue
		const pid = Number(entry)
		if (!Number.isSafeInteger(pid) || pid < 1) continue
		let stat: string
		try { stat = await fs.readFile(`/proc/${entry}/stat`, "utf8") }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "ENOENT" || code === "ESRCH") continue
			throw cleanupError("could not inspect every process while verifying owned teardown", error)
		}
		const record = parseLinuxProcessStat(pid, stat)
		if (record.processGroupId === identity.processGroupId && record.sessionId === identity.sessionId && record.state !== "Z" && record.state !== "X") {
			records.push(record)
		}
	}
	return records
}

function matchesOwnedProcessIdentity(record: LinuxProcessIdentity, expected: LinuxProcessIdentity): boolean {
	return record.pid === expected.pid && record.processGroupId === expected.processGroupId && record.sessionId === expected.sessionId && record.startTime === expected.startTime
}

async function verifyProcessRecordCurrent(record: LinuxProcessRecord): Promise<boolean> {
	try {
		const current = await readLinuxProcessIdentity(record.pid)
		return matchesOwnedProcessIdentity(current, record)
	} catch (error) {
		if ((error as Error).message.includes("exited before its identity")) return false
		throw error
	}
}

export const ownedChildProcessTestHooks = Object.freeze({
	parseLinuxProcessStat,
	matchesOwnedProcessIdentity,
})

export interface OwnedProcessOptions {
	command: string
	args: string[]
	cwd: string
	env: Record<string, string>
	stdio?: Array<"pipe" | "ignore">
}

export class OwnedChildProcess {
	private readonly child: ChildProcess
	private settled = false
	private timer: NodeJS.Timeout | undefined
	private abortHandler: (() => void) | undefined
	private readonly abortSignal: AbortSignal | undefined
	private readonly timeoutMs: number
	private readonly onExit: () => void
	private readonly onProtocol: (line: string) => void
	private readonly protocolFd?: number
	private pending = ""
	private readonly maxProtocolBytes: number
	private readonly maxStderrBytes: number
	private readonly onFailure: (error: Error) => void
	private stderrBytes = 0
	private failure: Error | undefined
	private cleanupFailure: Error | undefined
	private protocolComplete = false
	private spawnedResolve: (() => void) | undefined
	private spawnedReject: ((error: Error) => void) | undefined
	private readonly spawned: Promise<void>
	private stopPromise: Promise<void> | undefined
	private processIdentity: LinuxProcessIdentity | undefined
	private processIdentityReady: Promise<void> = Promise.resolve()

	constructor(options: OwnedProcessOptions, args: {
		signal?: AbortSignal
		timeoutMs: number
		maxProtocolBytes: number
		maxStderrBytes: number
		protocolFd?: number
		onProtocol: (line: string) => void
		onExit?: () => void
		onFailure?: (error: Error) => void
	}) {
		this.abortSignal = args.signal
		this.timeoutMs = args.timeoutMs
		this.maxProtocolBytes = args.maxProtocolBytes
		this.maxStderrBytes = args.maxStderrBytes
		this.protocolFd = args.protocolFd
		this.onProtocol = args.onProtocol
		this.onExit = args.onExit ?? (() => undefined)
		this.onFailure = args.onFailure ?? (() => undefined)
		this.spawned = new Promise<void>((resolve, reject) => {
			this.spawnedResolve = resolve
			this.spawnedReject = reject
		})
		this.child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
			shell: false,
			detached: process.platform !== "win32",
			windowsHide: true,
		})
		this.child.once("spawn", () => {
			this.spawnedResolve?.()
			this.spawnedResolve = undefined
			this.spawnedReject = undefined
			if (process.platform === "linux" && this.child.pid) {
				const pid = this.child.pid
				this.processIdentityReady = readLinuxProcessIdentity(pid).then((identity) => {
					if (identity.pid !== pid || identity.processGroupId !== pid || identity.sessionId !== pid) {
						throw cleanupError("spawned extension child is not the leader of its owned process group")
					}
					this.processIdentity = identity
				}).catch((error: unknown) => {
					this.cleanupFailure = error instanceof Error ? error : cleanupError("could not capture the owned process identity", error)
				})
			}
		})
		this.child.once("error", (error) => {
			this.fail(error)
			this.spawnedReject?.(error)
			this.spawnedResolve = undefined
			this.spawnedReject = undefined
		})
		this.child.once("close", (code, signal) => {
			this.cleanupListeners()
			if (!this.protocolComplete && !this.failure) this.fail(new Error(`extension child exited before completion (code=${code ?? "null"}, signal=${signal ?? "none"})`))
			void this.stop().then(() => this.notifyExit(), (error: unknown) => {
				this.recordCleanupFailure(error)
				this.notifyFailure(this.cleanupFailure ?? cleanupError("owned extension process teardown failed", error))
				this.notifyExit()
			})
		})
		const protocolStream = this.protocolFd === undefined ? this.child.stdout : this.child.stdio[this.protocolFd]
		protocolStream?.on("data", (chunk: Buffer) => this.acceptProtocolBytes(chunk))
		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrBytes += chunk.byteLength
			if (this.stderrBytes > this.maxStderrBytes) this.fail(new Error("extension child stderr exceeded its bound"))
		})
		this.timer = setTimeout(() => this.fail(new Error("extension call deadline exceeded")), this.timeoutMs)
		this.timer.unref()
		if (this.abortSignal) {
			this.abortHandler = () => this.fail(new Error("extension call was cancelled"))
			if (this.abortSignal.aborted) this.abortHandler()
			else this.abortSignal.addEventListener("abort", this.abortHandler, { once: true })
		}
	}

	get pid(): number | undefined { return this.child.pid }
	get exitCode(): number | null { return this.child.exitCode }
	get error(): Error | undefined { return this.failure }

	async waitForSpawn(): Promise<void> { await this.spawned }

	async sendProtocol(line: string): Promise<void> {
		const bytes = Buffer.from(line)
		if (bytes.byteLength > this.maxProtocolBytes) throw new Error("extension request exceeded protocol bound")
		if (!this.child.stdin || this.child.stdin.destroyed) throw this.failure ?? new Error("extension child stdin is unavailable")
		if (!this.child.stdin.write(bytes)) await new Promise<void>((resolve, reject) => {
			this.child.stdin?.once("drain", resolve)
			this.child.stdin?.once("error", reject)
		})
	}

	endInput(): void { this.child.stdin?.end() }
	markProtocolComplete(): void { this.protocolComplete = true }

	async waitForClose(timeoutMs: number): Promise<boolean> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return true
		return await Promise.race([
			new Promise<boolean>((resolve) => this.child.once("close", () => resolve(true))),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
		])
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise
		if (this.settled) return Promise.resolve()
		this.settled = true
		this.cleanupListeners()
		const pid = this.child.pid
		this.stopPromise = (async () => {
			if (!pid) return
			const signalled = await this.signalTree(pid, "SIGTERM")
			if (!signalled) return
			await new Promise<void>((resolve) => setTimeout(resolve, 100))
			if (process.platform === "linux") {
				const deadline = Date.now() + MAX_GROUP_TERMINATION_MS
				while (Date.now() < deadline) {
					if (!await this.signalTree(pid, "SIGKILL")) break
					await this.waitForExit(50)
				}
				await this.waitForExit(1_000)
				await this.waitForOwnedGroupEmpty(deadline)
			} else {
				await this.signalTree(pid, "SIGKILL")
				await this.waitForExit(1_000)
			}
		})()
		return this.stopPromise
	}

	private acceptProtocolBytes(chunk: Buffer): void {
		if (this.failure || this.settled) return
		if (Buffer.byteLength(this.pending, "utf8") + chunk.byteLength > this.maxProtocolBytes) {
			this.fail(new Error("extension child protocol output exceeded its bound"))
			return
		}
		this.pending += chunk.toString("utf8")
		while (true) {
			const newline = this.pending.indexOf("\n")
			if (newline < 0) break
			const line = this.pending.slice(0, newline)
			this.pending = this.pending.slice(newline + 1)
			if (!line) {
				this.fail(new Error("extension child emitted an empty protocol frame"))
				return
			}
			try { this.onProtocol(line) } catch (error) { this.fail(error instanceof Error ? error : new Error("extension child protocol was invalid")); return }
		}
	}

	private fail(error: Error): void {
		if (this.failure) return
		this.failure = error
		this.cleanupListeners()
		this.notifyFailure(error)
		this.stopInBackground()
	}

	private cleanupListeners(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		if (this.abortSignal && this.abortHandler) this.abortSignal.removeEventListener("abort", this.abortHandler)
		this.abortHandler = undefined
	}

	private async signalTree(pid: number, signal: NodeJS.Signals): Promise<boolean> {
		if (process.platform === "linux") {
			await this.processIdentityReady
			if (this.cleanupFailure) throw cleanupError("owned process-group identity could not be verified; teardown stopped", this.cleanupFailure)
			const identity = this.processIdentity
			if (!identity || identity.pid !== pid || identity.processGroupId !== pid || identity.sessionId !== pid) {
				throw cleanupError("owned process-group identity is unavailable; teardown stopped")
			}
			const members = await listOwnedProcessGroup(identity)
			if (members.length === 0) return false
			// OpenShell can deny negative-PGID kill syscalls while allowing signals
			// to individually verified processes owned by this child. On Linux use
			// the latter strategy directly: it avoids both that denial and a PGID
			// reuse window between procfs inspection and group signaling.
			return await this.signalMembersIndividually(identity, signal, members)
		}
		// Without Linux procfs, retain the existing platform group-signal strategy.
		// It does not provide the per-member identity/empty-group verification above.
		try {
			if (process.platform === "win32") this.child.kill(signal)
			else process.kill(-pid, signal)
			return true
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "ESRCH") return false
			throw cleanupError("could not signal the owned extension process group", error)
		}
	}

	private async signalMembersIndividually(identity: LinuxProcessIdentity, signal: NodeJS.Signals, members: LinuxProcessRecord[]): Promise<boolean> {
		// A negative-PGID signal can be denied inside a contained guest even when
		// signaling processes owned by this child is permitted. Enumerate only
		// members tied to the captured session/group, recheck start times before
		// each PID signal, and later prove that the group is empty. Any uncertainty
		// is a teardown failure; this is not a best-effort PID fallback.
		for (const member of members.sort((left, right) => Number(left.pid === identity.pid) - Number(right.pid === identity.pid))) {
			if (!await verifyProcessRecordCurrent(member)) continue
			try { process.kill(member.pid, signal) }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") continue
				throw cleanupError("could not signal every verified member of the owned process group", error)
			}
		}
		return true
	}

	private async waitForOwnedGroupEmpty(deadline: number): Promise<void> {
		const identity = this.processIdentity
		if (!identity) throw cleanupError("owned process-group identity is unavailable after termination")
		while (Date.now() < deadline) {
			const members = await listOwnedProcessGroup(identity)
			if (members.length === 0) return
			await new Promise<void>((resolve) => setTimeout(resolve, 20))
		}
		const remaining = await listOwnedProcessGroup(identity)
		if (remaining.length > 0) {
			throw cleanupError(`owned process group could not be verified empty after termination (${remaining.length} process(es) remain)`)
		}
	}

	private stopInBackground(): void {
		void this.stop().catch((error: unknown) => {
			this.recordCleanupFailure(error)
			this.notifyFailure(this.cleanupFailure ?? cleanupError("owned extension process teardown failed", error))
		})
	}

	private notifyFailure(error: Error): void {
		try { this.onFailure(error) }
		catch (callbackError) { this.recordCleanupFailure(cleanupError("owned extension process failure callback threw", callbackError)) }
	}

	private notifyExit(): void {
		try { this.onExit() }
		catch (callbackError) { this.recordCleanupFailure(cleanupError("owned extension process exit callback threw", callbackError)) }
	}

	private recordCleanupFailure(error: unknown): void {
		const next = error instanceof Error ? error : cleanupError("owned extension process teardown failed", error)
		if (!this.cleanupFailure) this.cleanupFailure = next
		if (!this.failure) this.failure = this.cleanupFailure
	}

	private async waitForExit(ms: number): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return
		await Promise.race([
			new Promise<void>((resolve) => this.child.once("close", () => resolve())),
			new Promise<void>((resolve) => setTimeout(resolve, ms)),
		])
	}
}

/** MCP stdio framing with a hard aggregate buffer bound and an owned process group. */
export class BoundedStdioTransport implements Transport {
	onclose?: () => void
	onerror?: (error: Error) => void
	onmessage?: (message: JSONRPCMessage) => void
	private child: OwnedChildProcess | undefined
	private readonly outputMaxBytes: number
	private readonly timeoutMs: number
	private readonly signal?: AbortSignal
	private readonly processOptions: OwnedProcessOptions
	private readonly maxStderrBytes: number
	private receivedBytes = 0
	private sentBytes = 0
	private closed = false

	constructor(options: OwnedProcessOptions, config: { maxBufferBytes: number; timeoutMs: number; signal?: AbortSignal; maxStderrBytes?: number }) {
		this.processOptions = options
		this.outputMaxBytes = config.maxBufferBytes
		this.timeoutMs = config.timeoutMs
		this.signal = config.signal
		this.maxStderrBytes = config.maxStderrBytes ?? 64 * 1024
	}

	async start(): Promise<void> {
		if (this.child) throw new Error("bounded MCP transport already started")
		if (this.signal?.aborted) throw new Error("extension call was cancelled")
		this.child = new OwnedChildProcess(this.processOptions, {
			signal: this.signal,
			timeoutMs: this.timeoutMs,
			maxProtocolBytes: this.outputMaxBytes,
			maxStderrBytes: this.maxStderrBytes,
			onFailure: (error) => this.onerror?.(error),
			onProtocol: (line) => {
				this.receivedBytes += Buffer.byteLength(line, "utf8") + 1
				if (this.receivedBytes > this.outputMaxBytes) throw new Error("MCP output exceeded its bound")
				this.onmessage?.(deserializeMessage(line))
			},
			onExit: () => { if (!this.closed) this.onclose?.() },
		})
		await this.child.waitForSpawn()
	}

	async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
		if (!this.child || this.closed) throw new Error("bounded MCP transport is not open")
		const framed = serializeMessage(message)
		this.sentBytes += Buffer.byteLength(framed, "utf8")
		if (this.sentBytes > this.outputMaxBytes) throw new Error("MCP request exceeded its protocol budget")
		await this.child.sendProtocol(framed)
	}

	async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		await this.child?.stop()
		this.onclose?.()
	}
}
