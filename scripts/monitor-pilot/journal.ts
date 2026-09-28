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
		if (ids.runId !== undefined && ids.epoch !== undefined) {
			const latestEpoch = this.latestEpochByRun.get(ids.runId)
			if (latestEpoch !== undefined && ids.epoch < latestEpoch) throw new JournalCorruptionError(`stale attempt epoch for run ${ids.runId}`)
		}
		const sequence = this.lastSequence + 1
		const withoutHash = {
			schemaVersion: 1 as const,
			sequence,
			type,
			experimentId,
			...ids,
			payload,
			previousHash: this.lastHash,
		}
		const record: JournalRecord = { ...withoutHash, recordHash: createHash("sha256").update(stableJson(withoutHash)).digest("hex") }
		const handle = await fs.open(this.filePath, "a")
		try {
			await handle.writeFile(`${JSON.stringify(record)}\n`)
			await handle.sync()
		} finally {
			await handle.close()
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
