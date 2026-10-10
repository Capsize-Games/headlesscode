import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { createServer, request as httpRequest, type Server } from "node:http"
import { setTimeout as delay } from "node:timers/promises"

export type EmergencyState = "running" | "pause-requested" | "paused" | "stop-requested" | "stopped" | "failed-to-stop"
export type EmergencyAction = "status" | "pause" | "resume" | "stop"

export interface EmergencyControlRecord {
	identity: string
	epoch: number
	state: EmergencyState
	operatorId?: string
	reason?: string
	requestedAt?: string
	acknowledgedAt?: string
	cleanupResults: Array<{ name: string; ok: boolean; detail: string; at: string }>
	resources: string[]
	evidenceSequence: number
	evidenceStatus: "none" | "pending" | "recorded" | "failed"
	updatedAt: string
}

export interface EmergencyControlOptions {
	identity: string
	stateDirectory?: string
	socketDirectory?: string
	operatorId?: string
	graceMs?: number
	recordControlEvent?: (record: EmergencyControlRecord) => Promise<void>
	/** Injectable durable-state writer for fault tests and supervised storage adapters. */
	persistState?: (file: string, record: EmergencyControlRecord) => Promise<void>
}

export interface EmergencyControlResource { id: string; kind: string }

export interface EmergencyControlResult {
	accepted: boolean
	record: EmergencyControlRecord
}

type Cleanup = (context: { signal: AbortSignal; epoch: number; graceMs: number }) => Promise<void>
type CleanupRegistration = { run: Cleanup; resource?: string }

const DEFAULT_STATE_DIRECTORY = path.join(os.homedir(), ".local", "share", "headlesscode", "control")
const IDENTITY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

function controlPaths(identity: string, stateDirectory: string, socketDirectory = stateDirectory): { state: string; socket: string } {
	if (!IDENTITY_PATTERN.test(identity)) throw new Error("control identity must contain only letters, digits, dot, underscore, or hyphen")
	const root = path.resolve(stateDirectory)
	const socketId = createHash("sha256").update(identity).digest("hex").slice(0, 20)
	const socket = path.join(path.resolve(socketDirectory), `${socketId}.sock`)
	if (process.platform !== "win32" && Buffer.byteLength(socket) >= 108) {
		throw new Error(`emergency-control Unix socket path is ${Buffer.byteLength(socket)} bytes; use a shorter HEADLESSCODE_CONTROL_SOCKET_DIR (maximum 107 bytes)`)
	}
	return { state: path.join(root, `${identity}.json`), socket }
}

function initialRecord(identity: string): EmergencyControlRecord {
	return { identity, epoch: 1, state: "running", cleanupResults: [], resources: [], evidenceSequence: 0, evidenceStatus: "none", updatedAt: new Date().toISOString() }
}

function validRecord(value: unknown, identity: string): value is EmergencyControlRecord {
	if (!value || typeof value !== "object") return false
	const record = value as Partial<EmergencyControlRecord>
	return record.identity === identity && Number.isSafeInteger(record.epoch) && Number(record.epoch) > 0
		&& ["running", "pause-requested", "paused", "stop-requested", "stopped", "failed-to-stop"].includes(String(record.state))
		&& Array.isArray(record.cleanupResults) && Array.isArray(record.resources)
}

async function readRecord(file: string, identity: string): Promise<EmergencyControlRecord> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"))
		if (!validRecord(parsed, identity)) throw new Error("emergency-control state file is malformed")
		return parsed
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialRecord(identity)
		throw error
	}
}

async function writeRecord(file: string, record: EmergencyControlRecord): Promise<void> {
	const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
	const handle = await fs.open(temporary, "wx", 0o600)
	try {
		await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`)
		await handle.sync()
	} finally { await handle.close() }
	try {
		await fs.rename(temporary, file)
		const directory = await fs.open(path.dirname(file), "r")
		try { await directory.sync() } finally { await directory.close() }
	} catch (error) { await fs.rm(temporary, { force: true }); throw error }
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function resourceId(resource?: string | EmergencyControlResource): string | undefined {
	if (resource === undefined || typeof resource === "string") return resource
	if (!resource.id.trim() || !resource.kind.trim()) throw new Error("resource kind and id are required")
	return `${resource.kind}:${resource.id}`
}

/** Supervisor-owned, durable emergency controls for one session or job. */
export class EmergencyControl {
	readonly identity: string
	private readonly stateFile: string
	private readonly socketFile: string
	private readonly lockFile: string
	private readonly lockToken: string
	private readonly stateDirectory: string
	private readonly socketDirectory: string
	private readonly graceMs: number
	private readonly operatorId: string
	private readonly recordControlEvent?: EmergencyControlOptions["recordControlEvent"]
	private readonly persistState: NonNullable<EmergencyControlOptions["persistState"]>
	private mutationTail: Promise<void> = Promise.resolve()
	private persistTail: Promise<void> = Promise.resolve()
	private emergencySequence = 0
	private controller = new AbortController()
	private server?: Server
	private record!: EmergencyControlRecord
	private closed = false
	private readonly cleanups = new Map<string, CleanupRegistration>()
	private constructor(options: EmergencyControlOptions, stateDirectory: string, socketDirectory: string, stateFile: string, socketFile: string, lockToken: string) {
		this.identity = options.identity
		this.stateDirectory = stateDirectory
		this.socketDirectory = socketDirectory
		this.stateFile = stateFile
		this.socketFile = socketFile
		this.lockFile = `${socketFile}.lock`
		this.lockToken = lockToken
		this.graceMs = options.graceMs ?? 5_000
		this.operatorId = options.operatorId ?? `uid:${typeof process.getuid === "function" ? process.getuid() : "unknown"}`
		this.recordControlEvent = options.recordControlEvent
		this.persistState = options.persistState ?? writeRecord
	}

	static async start(options: EmergencyControlOptions): Promise<EmergencyControl> {
		const stateDirectory = path.resolve(options.stateDirectory ?? DEFAULT_STATE_DIRECTORY)
		const socketDirectory = path.resolve(options.socketDirectory ?? stateDirectory)
		const paths = controlPaths(options.identity, stateDirectory, socketDirectory)
		await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 })
		await fs.chmod(stateDirectory, 0o700)
		await fs.mkdir(socketDirectory, { recursive: true, mode: 0o700 })
		await fs.chmod(socketDirectory, 0o700)
		const lockToken = randomUUID()
		const lockFile = `${paths.socket}.lock`
		let acquired = false
		for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
			try {
				const lock = await fs.open(lockFile, "wx", 0o600)
				try { await lock.writeFile(JSON.stringify({ pid: process.pid, token: lockToken })); await lock.sync() } finally { await lock.close() }
				acquired = true
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
				const prior = JSON.parse(await fs.readFile(lockFile, "utf8")) as { pid?: unknown; token?: unknown }
				if (!Number.isSafeInteger(prior.pid) || typeof prior.token !== "string") throw new Error(`emergency-control instance lock is malformed for ${options.identity}`)
				let alive = true
				try { process.kill(prior.pid as number, 0) } catch (probeError) { alive = (probeError as NodeJS.ErrnoException).code !== "ESRCH" }
				if (alive) throw new Error(`emergency control is already active for ${options.identity}`)
				const latest = JSON.parse(await fs.readFile(lockFile, "utf8")) as { token?: unknown }
				if (latest.token === prior.token) await fs.rm(lockFile, { force: true })
			}
		}
		if (!acquired) throw new Error(`could not acquire emergency-control instance lock for ${options.identity}`)
		const control = new EmergencyControl(options, stateDirectory, socketDirectory, paths.state, paths.socket, lockToken)
		try {
		control.record = await readRecord(paths.state, options.identity)
		if (control.record.state === "stop-requested" || control.record.state === "failed-to-stop" || control.record.state === "stopped" || control.record.resources.length > 0) {
			control.controller.abort(new Error("emergency stop recovery required"))
			if (control.record.resources.length > 0) {
				control.record.state = "failed-to-stop"
				control.record.cleanupResults.push({ name: "restart-recovery", ok: false, detail: "resources from a prior process require supervisor cleanup", at: new Date().toISOString() })
			}
		} else if (control.record.state === "pause-requested") {
			control.controller.abort(new Error("security pause recovery required"))
			control.record.state = "paused"
		} else if (control.record.state === "paused") {
			control.controller.abort(new Error("security pause remains active"))
		}
		control.record.updatedAt = new Date().toISOString()
		await control.persistRecord()
		await control.listen()
		return control
		} catch (error) {
			await control.releaseLock().catch(() => undefined)
			throw error
		}
	}

	get snapshot(): EmergencyControlRecord { return structuredClone(this.record) }
	get stateDirectoryPath(): string { return this.stateDirectory }
	get signal(): AbortSignal { return this.controller.signal }
	get state(): EmergencyState { return this.record.state }
	get hasCleanupHandlers(): boolean { return this.cleanups.size > 0 }

	private persistRecord(): Promise<void> {
		const snapshot = structuredClone(this.record)
		const write = this.persistTail.then(() => this.persistState(this.stateFile, snapshot))
		this.persistTail = write.then(() => undefined, () => undefined)
		return write
	}

	private async persistBounded(pending: Promise<unknown>, graceMs = 1_000): Promise<void> {
		let timer: NodeJS.Timeout | undefined
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`control-state persistence exceeded ${graceMs}ms`)), graceMs)
			timer.unref()
		})
		try { await Promise.race([pending, timeout]) } finally { if (timer) clearTimeout(timer) }
	}

	private async persistOutcome(initialWrite: Promise<void>, outcomes: EmergencyControlRecord["cleanupResults"]): Promise<boolean> {
		const finalWrite = this.persistRecord()
		try {
			const settled = Promise.allSettled([initialWrite, finalWrite])
			await this.persistBounded(settled, this.graceMs)
			const results = await settled
			const failure = results.find((entry): entry is PromiseRejectedResult => entry.status === "rejected")
			if (failure) throw failure.reason
			return true
		} catch (error) {
			const at = new Date().toISOString()
			this.record.state = "failed-to-stop"
			this.record.cleanupResults = [...outcomes, { name: "control-state-persistence", ok: false, detail: message(error).slice(0, 4000), at }]
			this.record.acknowledgedAt = at
			this.record.updatedAt = at
			void this.persistRecord().catch(() => undefined)
			return false
		}
	}

	async waitUntilRunning(signal?: AbortSignal): Promise<boolean> {
		while (this.record.state === "paused" || this.record.state === "pause-requested") {
			if (signal?.aborted) return false
			await delay(100, undefined, { signal }).catch(() => undefined)
		}
		return this.record.state === "running"
	}

	async waitForStopped(): Promise<void> {
		while (this.record.state !== "stopped") await delay(250)
	}

	assertRunning(): void {
		if (this.record.state !== "running" || this.signal.aborted) throw this.signal.reason ?? new Error(`session is ${this.record.state}`)
	}

	registerCleanup(name: string, cleanup: Cleanup, resource?: string | EmergencyControlResource): () => void {
		if (this.record.state !== "running" && this.record.state !== "failed-to-stop") throw this.signal.reason ?? new Error(`session is ${this.record.state}`)
		if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error("cleanup name is invalid")
		if (this.cleanups.has(name)) throw new Error(`cleanup already registered: ${name}`)
		this.cleanups.set(name, { run: cleanup, resource: resourceId(resource) })
		return () => { this.cleanups.delete(name) }
	}

	async registerResource(resource: string | EmergencyControlResource): Promise<void> {
		const id = resourceId(resource)!
		this.assertRunning()
		if (this.record.resources.includes(id)) return
		this.record.resources.push(id)
		this.record.updatedAt = new Date().toISOString()
		try { await this.persistBounded(this.persistRecord(), this.graceMs) }
		catch (error) {
			if (this.record.state === "running") {
				const at = new Date().toISOString()
				this.record.state = "failed-to-stop"
				this.record.cleanupResults.push({ name: "resource-state-persistence", ok: false, detail: message(error).slice(0, 4000), at })
				this.record.updatedAt = at
				this.controller.abort(new Error("emergency-control resource state could not be persisted"))
				void this.persistRecord().catch(() => undefined)
			}
			throw error
		}
	}

	async releaseResource(resource: string | EmergencyControlResource): Promise<void> {
		const id = resourceId(resource)!
		if (this.record.resources.includes(id)) {
			this.record.resources = this.record.resources.filter((entry) => entry !== id)
			this.record.updatedAt = new Date().toISOString()
			try { await this.persistBounded(this.persistRecord(), this.graceMs) }
			catch (error) {
				if (!this.record.resources.includes(id)) this.record.resources.push(id)
				if (this.record.state === "running") {
					const at = new Date().toISOString()
					this.record.state = "failed-to-stop"
					this.record.cleanupResults.push({ name: "resource-state-persistence", ok: false, detail: message(error).slice(0, 4000), at })
					this.record.updatedAt = at
					this.controller.abort(new Error("emergency-control resource state could not be persisted"))
					void this.persistRecord().catch(() => undefined)
				}
				throw error
			}
		}
	}

	async command(action: EmergencyAction, reason = "", operatorId = this.operatorId): Promise<EmergencyControlResult> {
		if (action === "status") return { accepted: true, record: this.snapshot }
		if (!operatorId.trim()) throw new Error("operator identity is required")
		if ((action === "pause" || action === "stop") && !reason.trim()) throw new Error("a reason is required for pause and stop")
		if (action === "pause") {
			if (this.record.state === "paused") return { accepted: true, record: this.snapshot }
			if (this.record.state !== "running") return { accepted: false, record: this.snapshot }
			const request = this.requestPause(reason, operatorId)
			return this.enqueueMutation(() => this.finishPause(request.sequence, request.initialWrite))
		}
		if (action === "stop") {
			if (this.record.state === "stopped") return { accepted: true, record: this.snapshot }
			const request = this.requestStop(reason, operatorId)
			return this.enqueueMutation(() => this.finishStop(request.sequence, request.initialWrite))
		}
		const sequence = this.emergencySequence
		const operation = this.mutationTail.then(() => this.resume(reason, operatorId, sequence))
		this.mutationTail = operation.then(() => undefined, () => undefined)
		return operation
	}

	private enqueueMutation(operation: () => Promise<EmergencyControlResult>): Promise<EmergencyControlResult> {
		const pending = this.mutationTail.then(operation)
		this.mutationTail = pending.then(() => undefined, () => undefined)
		return pending
	}

	private requestPause(reason: string, operatorId: string): { sequence: number; initialWrite: Promise<void> } {
		const sequence = ++this.emergencySequence
		this.record.state = "pause-requested"
		this.record.epoch += 1
		this.record.operatorId = operatorId
		this.record.reason = reason.slice(0, 4000)
		this.record.requestedAt = new Date().toISOString()
		this.record.updatedAt = this.record.requestedAt
		this.controller.abort(new Error(`security pause: ${this.record.reason}`))
		const initialWrite = this.persistRecord()
		void initialWrite.catch(() => undefined)
		this.emitEvidence()
		return { sequence, initialWrite }
	}

	private async finishPause(sequence: number, initialWrite: Promise<void>): Promise<EmergencyControlResult> {
		const outcomes = await this.runCleanups()
		if (sequence !== this.emergencySequence) return { accepted: false, record: this.snapshot }
		this.record.state = outcomes.every((entry) => entry.ok) ? "paused" : "failed-to-stop"
		this.record.acknowledgedAt = new Date().toISOString()
		this.record.cleanupResults = outcomes
		this.record.updatedAt = this.record.acknowledgedAt
		const persisted = await this.persistOutcome(initialWrite, outcomes)
		this.emitEvidence()
		return { accepted: outcomes.every((entry) => entry.ok) && persisted, record: this.snapshot }
	}

	private requestStop(reason: string, operatorId: string): { sequence: number; initialWrite: Promise<void> } {
		const retryingFailedStop = this.record.state === "failed-to-stop"
		const alreadyRequested = this.record.state === "stop-requested"
		const sequence = ++this.emergencySequence
		if (!retryingFailedStop && !alreadyRequested) this.record.epoch += 1
		this.record.state = "stop-requested"
		if (!alreadyRequested) {
			this.record.operatorId = operatorId
			this.record.reason = reason.slice(0, 4000)
			this.record.requestedAt = new Date().toISOString()
		}
		this.record.updatedAt = new Date().toISOString()
		this.controller.abort(new Error(`emergency stop: ${this.record.reason ?? reason}`))
		const initialWrite = this.persistRecord()
		void initialWrite.catch(() => undefined)
		this.emitEvidence()
		return { sequence, initialWrite }
	}

	private async finishStop(sequence: number, initialWrite: Promise<void>): Promise<EmergencyControlResult> {
		if (sequence !== this.emergencySequence) return { accepted: false, record: this.snapshot }
		return await this.completeStop(sequence, initialWrite)
	}

	private async completeStop(sequence: number, initialWrite: Promise<void>): Promise<EmergencyControlResult> {
		const outcomes = await this.runCleanups()
		if (sequence !== this.emergencySequence) return { accepted: false, record: this.snapshot }
		this.record.cleanupResults = outcomes
		this.record.state = outcomes.every((entry) => entry.ok) ? "stopped" : "failed-to-stop"
		this.record.acknowledgedAt = new Date().toISOString()
		this.record.updatedAt = this.record.acknowledgedAt
		const persisted = await this.persistOutcome(initialWrite, outcomes)
		this.emitEvidence()
		return { accepted: outcomes.every((entry) => entry.ok) && persisted, record: this.snapshot }
	}

	private async resume(reason: string, operatorId: string, sequence: number): Promise<EmergencyControlResult> {
		if (sequence !== this.emergencySequence) return { accepted: false, record: this.snapshot }
		if (this.record.state === "running") return { accepted: true, record: this.snapshot }
		if (this.record.state !== "paused") return { accepted: false, record: this.snapshot }
		this.record.epoch += 1
		this.record.state = "running"
		this.record.operatorId = operatorId
		this.record.reason = reason.slice(0, 4000)
		this.record.requestedAt = new Date().toISOString()
		this.record.acknowledgedAt = this.record.requestedAt
		this.record.updatedAt = this.record.requestedAt
		this.controller = new AbortController()
		try { await this.persistBounded(this.persistRecord(), this.graceMs) }
		catch (error) {
			if (sequence === this.emergencySequence && this.record.state === "running") {
				const at = new Date().toISOString()
				this.record.state = "failed-to-stop"
				this.record.cleanupResults.push({ name: "control-state-persistence", ok: false, detail: message(error).slice(0, 4000), at })
				this.record.updatedAt = at
				this.controller.abort(new Error("emergency-control resume state could not be persisted"))
				void this.persistRecord().catch(() => undefined)
			}
			return { accepted: false, record: this.snapshot }
		}
		if (sequence !== this.emergencySequence || this.record.state !== "running") return { accepted: false, record: this.snapshot }
		this.emitEvidence()
		return { accepted: true, record: this.snapshot }
	}

	private async runCleanups(): Promise<EmergencyControlRecord["cleanupResults"]> {
		const results: EmergencyControlRecord["cleanupResults"] = []
		for (const [name, cleanup] of this.cleanups) {
			const at = new Date().toISOString()
			try {
				let timer: NodeJS.Timeout | undefined
				const timeout = new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`cleanup exceeded ${this.graceMs}ms grace period`)), this.graceMs)
					timer.unref()
				})
				try { await Promise.race([cleanup.run({ signal: this.signal, epoch: this.record.epoch, graceMs: this.graceMs }), timeout]) }
				finally { if (timer) clearTimeout(timer) }
				if (cleanup.resource) this.record.resources = this.record.resources.filter((resource) => resource !== cleanup.resource)
				results.push({ name, ok: true, detail: "cleanup verified", at })
			} catch (error) {
				results.push({ name, ok: false, detail: message(error).slice(0, 4000), at })
			}
		}
		for (const resource of this.record.resources) results.push({ name: `unverified:${resource}`, ok: false, detail: "resource has no successful teardown verification", at: new Date().toISOString() })
		return results
	}

	private emitEvidence(): void {
		if (!this.recordControlEvent) return
		this.record.evidenceSequence += 1
		this.record.evidenceStatus = "pending"
		this.record.updatedAt = new Date().toISOString()
		void this.persistRecord().catch(() => undefined)
		const event = this.snapshot
		const sequence = this.record.evidenceSequence
		let timer: NodeJS.Timeout | undefined
		const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 1_000); timer.unref() })
		void Promise.race([Promise.resolve().then(() => this.recordControlEvent!(event)).then(() => "recorded" as const, () => "failed" as const), timeout]).then(async (status) => {
			if (timer) clearTimeout(timer)
			if (this.closed || this.record.evidenceSequence !== sequence) return
			this.record.evidenceStatus = status === "recorded" ? "recorded" : "failed"
			this.record.updatedAt = new Date().toISOString()
			await this.persistRecord().catch(() => undefined)
		})
	}

	private async listen(): Promise<void> {
		try {
			const stat = await fs.lstat(this.socketFile)
			if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error(`refusing unexpected emergency-control endpoint ${this.socketFile}`)
			try {
				await requestEmergencyControl({ identity: this.identity, stateDirectory: this.stateDirectory, socketDirectory: this.socketDirectory, action: "status" })
				throw new Error(`emergency control is already active for ${this.identity}`)
			} catch (error) {
				if (error instanceof Error && error.message.includes("already active")) throw error
				if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED" && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				await fs.rm(this.socketFile, { force: true })
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		this.server = createServer((request, response) => {
			if (request.method !== "POST" || request.url !== "/control") {
				response.writeHead(404).end()
				return
			}
			const chunks: Buffer[] = []
			let size = 0
			request.on("data", (chunk: Buffer) => {
				size += chunk.length
				if (size <= 8192) chunks.push(chunk)
				else request.destroy()
			})
			request.on("end", () => {
				void (async () => {
					try {
						const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { action?: EmergencyAction; reason?: string }
						if (!["status", "pause", "resume", "stop"].includes(String(input.action))) throw new Error("unsupported control action")
						const operatorId = `uid:${typeof process.getuid === "function" ? process.getuid() : "unknown"}`
						const result = await this.command(input.action!, input.reason ?? "", operatorId)
						response.writeHead(result.accepted ? 200 : 409, { "content-type": "application/json" }).end(JSON.stringify(result))
					} catch (error) {
						response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: message(error) }))
					}
				})()
			})
		})
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject)
			this.server!.listen(this.socketFile, () => resolve())
		})
		await fs.chmod(this.socketFile, 0o600)
	}

	async close(): Promise<void> {
		this.closed = true
		await this.persistBounded(this.mutationTail, this.graceMs + 1_000).catch(() => undefined)
		await this.persistBounded(this.persistTail, 1_000).catch(() => undefined)
		if (this.server) await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()))
		await fs.rm(this.socketFile, { force: true })
		await this.releaseLock()
	}

	private async releaseLock(): Promise<void> {
		try {
			const lock = JSON.parse(await fs.readFile(this.lockFile, "utf8")) as { token?: string }
			if (lock.token === this.lockToken) await fs.rm(this.lockFile, { force: true })
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
	}
}

export async function requestEmergencyControl(options: EmergencyControlOptions & { action: EmergencyAction; reason?: string }): Promise<EmergencyControlResult> {
	const stateDirectory = path.resolve(options.stateDirectory ?? DEFAULT_STATE_DIRECTORY)
	const { socket } = controlPaths(options.identity, stateDirectory, path.resolve(options.socketDirectory ?? stateDirectory))
	const operatorId = options.operatorId ?? `uid:${typeof process.getuid === "function" ? process.getuid() : "unknown"}`
	return await new Promise((resolve, reject) => {
		const request = httpRequest({ socketPath: socket, path: "/control", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
			const chunks: Buffer[] = []
			response.on("data", (chunk: Buffer) => chunks.push(chunk))
			response.on("end", () => {
				try {
					const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as EmergencyControlResult | { error: string }
					if ("error" in payload) reject(new Error(payload.error))
					else if (response.statusCode !== 200) reject(Object.assign(new Error(`emergency control rejected (${response.statusCode})`), { result: payload }))
					else resolve(payload)
				} catch (error) { reject(error) }
			})
		})
		request.on("error", reject)
		request.end(JSON.stringify({ action: options.action, reason: options.reason }))
	})
}
