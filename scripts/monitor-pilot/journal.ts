import * as fs from "node:fs/promises"
import { createHash } from "node:crypto"
import * as path from "node:path"

import { stableJson } from "../../src/monitoring/features.js"

export interface JournalRecord {
	readonly schemaVersion: 1
	readonly sequence: number
	readonly type: string
	readonly experimentId: string
	readonly runId?: string
	readonly attemptId?: string
	readonly epoch?: number
	readonly payload: Readonly<Record<string, unknown>>
	readonly previousHash: string
	readonly recordHash: string
}

export class JournalCorruptionError extends Error {}
export class RunnerLockError extends Error {}

// Hash only the JSON shape that survives a journal write/read round trip.
function persistedJsonValue(value: unknown, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new JournalCorruptionError("journal payload contains a non-finite number")
		return value
	}
	if (typeof value === "undefined") return null
	if (typeof value !== "object") throw new JournalCorruptionError("journal payload contains an unsupported JSON value")
	if (ancestors.has(value)) throw new JournalCorruptionError("journal payload contains a circular reference")
	ancestors.add(value)
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
				throw new JournalCorruptionError("journal payload contains an unsupported JSON value")
			}
			const keys = Object.keys(value)
			if (keys.some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
				throw new JournalCorruptionError("journal payload contains an unsupported JSON value")
			}
			const items: unknown[] = []
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
				if (!descriptor) {
					items.push(null)
					continue
				}
				if (!("value" in descriptor)) throw new JournalCorruptionError("journal payload contains an accessor")
				items.push(persistedJsonValue(descriptor.value, ancestors))
			}
			return items
		}
		const prototype = Object.getPrototypeOf(value)
		if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) {
			throw new JournalCorruptionError("journal payload contains an unsupported JSON value")
		}
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
		for (const key of Object.keys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor || !("value" in descriptor)) throw new JournalCorruptionError("journal payload contains an accessor")
			if (descriptor.value === undefined) continue
			Object.defineProperty(result, key, {
				value: persistedJsonValue(descriptor.value, ancestors),
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
		return result
	} finally {
		ancestors.delete(value)
	}
}

export class ExclusiveRunnerLock {
	private handle: fs.FileHandle | undefined
	constructor(readonly lockPath: string) {}

	async acquire(): Promise<void> {
		await fs.mkdir(path.dirname(this.lockPath), { recursive: true })
		try {
			this.handle = await fs.open(this.lockPath, "wx")
			await this.handle.writeFile(`${process.pid}\n`)
			await this.handle.sync()
		} catch (error) {
			if (this.handle) await this.handle.close().catch(() => undefined)
			this.handle = undefined
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RunnerLockError(`runner lock is already held: ${this.lockPath}`)
			throw error
		}
	}

	async release(): Promise<void> {
		await this.handle?.close().catch(() => undefined)
		this.handle = undefined
		await fs.rm(this.lockPath, { force: true })
	}
}

export class PilotJournal {
	private lastSequence = 0
	private lastHash = "GENESIS"
	private records: JournalRecord[] = []
	private readonly latestEpochByRun = new Map<string, number>()
	private appendOutcomeUncertain = false

	constructor(readonly filePath: string) {}

	async open(): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true })
		let raw = ""
		try {
			raw = await fs.readFile(this.filePath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		for (const [index, line] of raw.split("\n").filter(Boolean).entries()) {
			let record: JournalRecord
			try {
				record = JSON.parse(line) as JournalRecord
			} catch {
				throw new JournalCorruptionError(`malformed journal record at line ${index + 1}`)
			}
			this.validateRecord(record, index + 1)
			this.records.push(record)
			this.lastSequence = record.sequence
			this.lastHash = record.recordHash
			this.noteEpoch(record)
		}
	}

	async append(type: string, experimentId: string, payload: Record<string, unknown>, ids: Partial<Pick<JournalRecord, "runId" | "attemptId" | "epoch">> = {}): Promise<JournalRecord> {
		if (this.appendOutcomeUncertain) {
			throw new JournalCorruptionError("journal append outcome is uncertain; reopen the journal before appending")
		}
		if (ids.runId !== undefined && ids.epoch !== undefined) {
			const latestEpoch = this.latestEpochByRun.get(ids.runId)
			if (latestEpoch !== undefined && ids.epoch < latestEpoch) throw new JournalCorruptionError(`stale attempt epoch for run ${ids.runId}`)
		}
		const sequence = this.lastSequence + 1
		const withoutHash = persistedJsonValue({
			schemaVersion: 1 as const,
			sequence,
			type,
			experimentId,
			...ids,
			payload,
			previousHash: this.lastHash,
		}) as Omit<JournalRecord, "recordHash">
		const record: JournalRecord = { ...withoutHash, recordHash: createHash("sha256").update(stableJson(withoutHash)).digest("hex") }
		const handle = await fs.open(this.filePath, "a")
		try {
			await handle.writeFile(`${JSON.stringify(record)}\n`)
			await handle.sync()
		} catch (error) {
			this.appendOutcomeUncertain = true
			await handle.close().catch(() => undefined)
			throw error
		}
		try {
			await handle.close()
		} catch (error) {
			this.appendOutcomeUncertain = true
			throw error
		}
		this.records.push(record)
		this.lastSequence = sequence
		this.lastHash = record.recordHash
		this.noteEpoch(record)
		return record
	}

	/** Mark every unfinished attempt as aborted after an interrupted process. */
	async abortActiveAttempts(experimentId: string, reason = "interrupted"): Promise<readonly JournalRecord[]> {
		const aborted: JournalRecord[] = []
		for (const active of this.activeAttempts()) {
			aborted.push(await this.append("attempt_aborted", experimentId, {
				reason,
				interruptedAttemptId: active.attemptId,
				lastRecordType: active.type,
			}, { runId: active.runId, attemptId: active.attemptId, epoch: active.epoch }))
		}
		return aborted
	}

	list(): readonly JournalRecord[] {
		return this.records.slice()
	}

	activeAttempts(): readonly JournalRecord[] {
		const states = new Map<string, JournalRecord>()
		for (const record of this.records) {
			if (record.attemptId) states.set(record.attemptId, record)
		}
		return [...states.values()].filter((record) => record.type === "attempt_started" || record.type === "attempt_running")
	}

	private validateRecord(record: JournalRecord, line: number): void {
		if (record.schemaVersion !== 1 || record.sequence !== this.lastSequence + 1 || record.previousHash !== this.lastHash) {
			throw new JournalCorruptionError(`journal sequence/hash corruption at line ${line}`)
		}
		const { recordHash, ...withoutHash } = record
		const expected = createHash("sha256").update(stableJson(withoutHash)).digest("hex")
		if (recordHash !== expected) throw new JournalCorruptionError(`journal record hash mismatch at line ${line}`)
	}

	private noteEpoch(record: JournalRecord): void {
		if (record.runId !== undefined && record.epoch !== undefined) {
			this.latestEpochByRun.set(record.runId, Math.max(this.latestEpochByRun.get(record.runId) ?? record.epoch, record.epoch))
		}
	}
}
