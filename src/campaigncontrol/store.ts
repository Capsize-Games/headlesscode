import * as fs from "node:fs/promises"
import * as constants from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

export const CAMPAIGN_ID = "fleet-security-watch"
export const MAX_MONTHLY_BUDGET_MICROS = 5_000_000
export const DEFAULT_INTERVAL_SECONDS = 60
const MAX_HISTORY = 200
const MAX_DETAIL = 240

export interface ActiveCampaignRun {
	id: string
	epoch: number
	startedAt: number
	expiresAt: number
}

export interface CampaignRun extends ActiveCampaignRun {
	finishedAt?: number
	status: "succeeded" | "failed" | "interrupted"
	detail?: string
}

/** Exact state contract read by Fleet; run history is kept in a sidecar. */
export interface CampaignControlState {
	schemaVersion: 1
	campaignId: typeof CAMPAIGN_ID
	enabled: boolean
	epoch: number
	budgetLimitMicros: number
	month: string
	settledMicros: number
	reservedMicros: number
	ambiguousMicros: number
	canAdmit: boolean
	nextDueAt: number | null
	updatedAt: number
	activeRun: ActiveCampaignRun | null
}

export interface CampaignBudgetProjection {
	month: string
	settledMicros: number
	reservedMicros: number
	ambiguousMicros: number
}

function validState(value: unknown): value is CampaignControlState {
	if (!value || typeof value !== "object") return false
	const s = value as Partial<CampaignControlState>
	const keys = Object.keys(value as object).sort().join(",")
	const expected = ["activeRun", "ambiguousMicros", "budgetLimitMicros", "canAdmit", "campaignId", "enabled", "epoch", "month", "nextDueAt", "reservedMicros", "schemaVersion", "settledMicros", "updatedAt"].sort().join(",")
	if (keys !== expected) return false
	const active = s.activeRun
	return s.schemaVersion === 1 && s.campaignId === CAMPAIGN_ID &&
		typeof s.enabled === "boolean" && Number.isSafeInteger(s.epoch) && (s.epoch ?? -1) >= 0 &&
		Number.isSafeInteger(s.budgetLimitMicros) && (s.budgetLimitMicros ?? -1) >= 0 &&
		(s.budgetLimitMicros ?? MAX_MONTHLY_BUDGET_MICROS + 1) <= MAX_MONTHLY_BUDGET_MICROS &&
		typeof s.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s.month) &&
		Number.isSafeInteger(s.settledMicros) && (s.settledMicros ?? -1) >= 0 &&
		Number.isSafeInteger(s.reservedMicros) && (s.reservedMicros ?? -1) >= 0 &&
		Number.isSafeInteger(s.ambiguousMicros) && (s.ambiguousMicros ?? -1) >= 0 &&
		typeof s.canAdmit === "boolean" &&
		(s.nextDueAt === null || Number.isSafeInteger(s.nextDueAt)) &&
		Number.isSafeInteger(s.updatedAt) &&
		(active === null || (!!active && typeof active === "object" &&
			Object.keys(active).sort().join(",") === "epoch,expiresAt,id,startedAt" &&
			typeof active.id === "string" && Number.isSafeInteger(active.epoch) &&
			Number.isSafeInteger(active.startedAt) && Number.isSafeInteger(active.expiresAt) && active.expiresAt >= active.startedAt))
}

function initialState(now: Date): CampaignControlState {
	return {
		schemaVersion: 1, campaignId: CAMPAIGN_ID, enabled: false, epoch: 0, budgetLimitMicros: 0,
		month: now.toISOString().slice(0, 7), settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0,
		canAdmit: false, nextDueAt: null, updatedAt: now.getTime(), activeRun: null,
	}
}

function safeDetail(detail: string): string {
	return detail.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_DETAIL)
}

/** Durable owner-controlled campaign settings and bounded run history. */
export class CampaignControlStore {
	readonly path: string
	private readonly lockPath: string
	private readonly historyPath: string

	constructor(filePath: string) {
		this.path = path.resolve(filePath)
		this.lockPath = `${this.path}.lock`
		this.historyPath = `${this.path}.history.json`
	}

	async read(now = new Date()): Promise<CampaignControlState> {
		await this.ensurePrivateParent()
		try {
			const info = await fs.lstat(this.path)
			if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("campaign control file is not a bounded regular file")
			const handle = await fs.open(this.path, constants.constants.O_RDONLY | (constants.constants.O_NOFOLLOW ?? 0))
			let text: string
			try { text = await handle.readFile("utf8") } finally { await handle.close() }
			const parsed: unknown = JSON.parse(text)
			if (!validState(parsed)) throw new Error("campaign control state failed exact-schema validation")
			if (parsed.month !== now.toISOString().slice(0, 7)) {
				return this.update((state) => {
					state.month = now.toISOString().slice(0, 7)
					state.settledMicros = state.reservedMicros = state.ambiguousMicros = 0
					this.refreshCanAdmit(state)
					return state
				}, now)
			}
			return parsed
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return this.update((state) => state, now)
		}
	}

	async snapshot(now = new Date()): Promise<CampaignControlState> { return this.read(now) }

	async status(now = new Date()): Promise<{ control: CampaignControlState; runs: CampaignRun[] }> {
		return { control: await this.read(now), runs: await this.readRuns() }
	}

	async setEnabled(enabled: boolean, now = new Date()): Promise<CampaignControlState> {
		if (typeof enabled !== "boolean") throw new Error("enabled must be boolean")
		return this.update((state) => {
			if (state.enabled !== enabled) {
				state.enabled = enabled
				state.epoch += 1
				this.refreshCanAdmit(state)
				if (enabled) state.nextDueAt = now.getTime()
			}
			return state
		}, now)
	}

	async setBudgetLimit(micros: number, now = new Date()): Promise<CampaignControlState> {
		if (!Number.isSafeInteger(micros) || micros < 0 || micros > MAX_MONTHLY_BUDGET_MICROS) {
			throw new Error(`budget must be an integer from 0 to ${MAX_MONTHLY_BUDGET_MICROS} micros`)
		}
		return this.update((state) => {
			if (micros < state.settledMicros + state.reservedMicros + state.ambiguousMicros) {
				throw new Error("budget cannot be lowered below settled, reserved, or ambiguous monthly spend")
			}
			if (state.budgetLimitMicros !== micros) {
				state.budgetLimitMicros = micros
				state.epoch += 1
				this.refreshCanAdmit(state)
			}
			return state
		}, now)
	}

	async updateBudgetProjection(projection: CampaignBudgetProjection, now = new Date()): Promise<CampaignControlState> {
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(projection.month) ||
			![projection.settledMicros, projection.reservedMicros, projection.ambiguousMicros].every((value) => Number.isSafeInteger(value) && value >= 0)) {
			throw new Error("budget report failed schema validation")
		}
		if (projection.month !== now.toISOString().slice(0, 7)) throw new Error("budget report month is stale")
		return this.update((state) => {
			state.month = projection.month
			state.settledMicros = projection.settledMicros
			state.reservedMicros = projection.reservedMicros
			state.ambiguousMicros = projection.ambiguousMicros
			return state
		}, now)
	}

	async beginRun(now = new Date(), timeoutMs = 5 * 60_000): Promise<ActiveCampaignRun> {
		const run = await this.beginRunIfIdle(now, timeoutMs)
		if (!run) throw new Error("an unexpired campaign run lease is already active")
		return run
	}

	/** Atomically claim the short tick fence without replacing a live campaign-run lease. */
	async beginRunIfIdle(now = new Date(), timeoutMs = 5 * 60_000): Promise<ActiveCampaignRun | undefined> {
		return this.claimRunIfIdle(now, timeoutMs)
	}

	/** Atomically claim a finite inference run only while its observed ON epoch still admits spend. */
	async beginAdmittedRunIfIdle(now: Date, timeoutMs: number, expectedEpoch: number): Promise<ActiveCampaignRun | undefined> {
		if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) throw new Error("campaign epoch is invalid")
		return this.claimRunIfIdle(now, timeoutMs, expectedEpoch)
	}

	private async claimRunIfIdle(now: Date, timeoutMs: number, admittedEpoch?: number): Promise<ActiveCampaignRun | undefined> {
		const result = await this.update((state) => {
			const previous = state.activeRun
			if (previous && previous.expiresAt > now.getTime()) return { activeRun: undefined, previous: undefined }
			if (admittedEpoch !== undefined && (state.epoch !== admittedEpoch || !state.enabled ||
				state.budgetLimitMicros <= state.settledMicros + state.reservedMicros + state.ambiguousMicros)) {
				return { activeRun: undefined, previous: undefined }
			}
			const activeRun = { id: randomUUID(), epoch: state.epoch, startedAt: now.getTime(), expiresAt: now.getTime() + timeoutMs }
			state.activeRun = activeRun
			state.nextDueAt = now.getTime() + DEFAULT_INTERVAL_SECONDS * 1000
			return { activeRun, previous }
		}, now)
		if (!result.activeRun) return undefined
		if (result.previous) await this.appendRun({ ...result.previous, finishedAt: now.getTime(), status: "interrupted", detail: "previous tick ended without a completion receipt" })
		return result.activeRun
	}

	async finishRun(runId: string, status: CampaignRun["status"] & ("succeeded" | "failed"), detail = "", now = new Date()): Promise<CampaignRun> {
		const run = await this.update((state) => {
			if (!state.activeRun || state.activeRun.id !== runId) throw new Error("campaign run fencing token is stale")
			const completed: CampaignRun = { ...state.activeRun, finishedAt: now.getTime(), status, detail: safeDetail(detail) }
			state.activeRun = null
			state.nextDueAt = now.getTime() + DEFAULT_INTERVAL_SECONDS * 1000
			return completed
		}, now)
		await this.appendRun(run)
		return run
	}

	private async update<T>(mutate: (state: CampaignControlState) => T, now: Date): Promise<T> {
		const release = await this.acquireStateLock()
		try {
			let state: CampaignControlState
			try {
				const parsed: unknown = JSON.parse(await fs.readFile(this.path, "utf8"))
				if (!validState(parsed)) throw new Error("campaign control state failed exact-schema validation")
				state = parsed
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				state = initialState(now)
			}
			if (state.month !== now.toISOString().slice(0, 7)) {
				state.month = now.toISOString().slice(0, 7)
				state.settledMicros = state.reservedMicros = state.ambiguousMicros = 0
			}
			const result = mutate(state)
			this.refreshCanAdmit(state)
			state.updatedAt = now.getTime()
			await this.atomicWrite(state)
			return result
		} finally { await release() }
	}

	private async ensurePrivateParent(): Promise<void> {
		const parent = path.dirname(this.path)
		await fs.mkdir(parent, { recursive: true, mode: 0o700 })
		const stat = await fs.lstat(parent)
		if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
			throw new Error("campaign control parent must be an owned real directory")
		}
		if ((stat.mode & 0o077) !== 0) await fs.chmod(parent, 0o700)
	}

	private refreshCanAdmit(state: CampaignControlState): void {
		state.canAdmit = state.enabled && state.budgetLimitMicros > state.settledMicros + state.reservedMicros + state.ambiguousMicros
	}

	private async acquireStateLock(): Promise<() => Promise<void>> {
		await this.ensurePrivateParent()
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				const handle = await fs.open(this.lockPath, "wx", 0o600)
				await handle.writeFile(`${process.pid}\n`)
				return async () => { await handle.close(); await fs.rm(this.lockPath, { force: true }) }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
				const owner = Number((await fs.readFile(this.lockPath, "utf8").catch(() => "")).trim())
				let alive = Number.isSafeInteger(owner) && owner > 0
				if (alive) {
					try { process.kill(owner, 0) } catch (probe) { alive = (probe as NodeJS.ErrnoException).code === "EPERM" }
				}
				if (!alive) {
					const stale = `${this.lockPath}.stale.${randomUUID()}`
					await fs.rename(this.lockPath, stale).catch(() => undefined)
					await fs.rm(stale, { force: true }).catch(() => undefined)
					continue
				}
				await new Promise((resolve) => setTimeout(resolve, 10 + attempt))
			}
		}
		throw new Error("campaign state is busy")
	}

	private async atomicWrite(state: CampaignControlState): Promise<void> {
		const temp = `${this.path}.tmp.${process.pid}.${randomUUID()}`
		const handle = await fs.open(temp, "wx", 0o600)
		try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8"); await handle.sync() }
		finally { await handle.close() }
		await fs.rename(temp, this.path)
		const dir = await fs.open(path.dirname(this.path), "r")
		try { await dir.sync() } finally { await dir.close() }
	}

	private async readRuns(): Promise<CampaignRun[]> {
		try {
			const stat = await fs.lstat(this.historyPath)
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 ||
				(typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("campaign history must be a bounded owner file")
			const handle = await fs.open(this.historyPath, constants.constants.O_RDONLY | (constants.constants.O_NOFOLLOW ?? 0))
			let text: string
			try { text = await handle.readFile("utf8") } finally { await handle.close() }
			const parsed: unknown = JSON.parse(text)
			if (!Array.isArray(parsed) || parsed.length > MAX_HISTORY || parsed.some((item) => {
				if (!item || typeof item !== "object") return true
				const run = item as Partial<CampaignRun>
				return typeof run.id !== "string" || !Number.isSafeInteger(run.epoch) ||
					!Number.isSafeInteger(run.startedAt) || !Number.isSafeInteger(run.expiresAt) ||
					(run.finishedAt !== undefined && !Number.isSafeInteger(run.finishedAt)) ||
					!["succeeded", "failed", "interrupted"].includes(run.status ?? "") ||
					(run.detail !== undefined && typeof run.detail !== "string")
			})) {
				throw new Error("campaign history failed schema validation")
			}
			return parsed as CampaignRun[]
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
			throw error
		}
	}

	private async appendRun(run: CampaignRun): Promise<void> {
		const release = await this.acquireStateLock()
		try {
			const runs = await this.readRuns()
			if (runs.some((item) => item.id === run.id && item.status === run.status)) return
			runs.push(run)
			const temp = `${this.historyPath}.tmp.${process.pid}.${randomUUID()}`
			const handle = await fs.open(temp, "wx", 0o600)
			try { await handle.writeFile(`${JSON.stringify(runs.slice(-MAX_HISTORY), null, 2)}\n`, "utf8"); await handle.sync() }
			finally { await handle.close() }
			await fs.rename(temp, this.historyPath)
			const dir = await fs.open(path.dirname(this.historyPath), "r")
			try { await dir.sync() } finally { await dir.close() }
		} finally { await release() }
	}
}
