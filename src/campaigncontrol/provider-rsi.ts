import * as fs from "node:fs/promises"
import { constants } from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { CAMPAIGN_CONTROL_ROOT } from "./paths.js"

export interface ProviderRsiEntry {
	updatedAt: string
	experimentId: string
	runId: string
	planDigest: string
	evidenceDigest: string
	status: "evaluated" | "failed" | "interrupted"
	baselineCorrect: number | null
	candidateCorrect: number | null
	caseCount: 4
	eligible: boolean
	modelCalls: number
	settledMicros: number
	ambiguousMicros: number
}
export interface ProviderRsiStatus {
	mode: "provider-synthetic-only"
	model: "meta/muse-spark-1.3-contributor"
	activation: "not-performed"
	maxSpendMicros: 20000
	history: ProviderRsiEntry[]
}
const DEFAULT_FILE = path.join(CAMPAIGN_CONTROL_ROOT, "rsi", "provider-status.json")
const SHA = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const KEYS = "ambiguousMicros,baselineCorrect,candidateCorrect,caseCount,eligible,evidenceDigest,experimentId,modelCalls,planDigest,runId,settledMicros,status,updatedAt"

function validate(value: unknown): ProviderRsiEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider RSI entry is invalid")
	const e = value as Record<string, unknown>
	if (Object.keys(e).sort().join(",") !== KEYS || typeof e.updatedAt !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(e.updatedAt) || !Number.isFinite(Date.parse(e.updatedAt)) ||
		![e.experimentId, e.runId].every(v => typeof v === "string" && ID.test(v)) ||
		![e.planDigest, e.evidenceDigest].every(v => typeof v === "string" && SHA.test(v)) ||
		!["evaluated", "failed", "interrupted"].includes(e.status as string) || e.caseCount !== 4 ||
		![e.baselineCorrect, e.candidateCorrect].every(v => v === null || (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 4)) ||
		typeof e.eligible !== "boolean" || (e.eligible && (e.status !== "evaluated" || e.baselineCorrect === null || e.candidateCorrect !== 4 || (e.baselineCorrect as number) >= 4)) ||
		!Number.isSafeInteger(e.modelCalls) || (e.modelCalls as number) < 0 || (e.modelCalls as number) > 3 ||
		![e.settledMicros, e.ambiguousMicros].every(v => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 20000) ||
		(e.settledMicros as number) + (e.ambiguousMicros as number) > 20000) throw new Error("Provider RSI entry failed validation")
	return { ...e } as unknown as ProviderRsiEntry
}

/** Dashboard metadata only: no source, logs, credential paths or provider payloads. */
export async function readProviderRsiStatus(file = DEFAULT_FILE): Promise<ProviderRsiStatus> {
	const empty: ProviderRsiStatus = { mode: "provider-synthetic-only", model: "meta/muse-spark-1.3-contributor", activation: "not-performed", maxSpendMicros: 20000, history: [] }
	let handle: fs.FileHandle
	try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW) }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty; throw new Error("Provider RSI history is unavailable") }
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768 || (stat.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Provider RSI history must be private and bounded")
		const data = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>
		if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).sort().join(",") !== "history,schemaVersion" || data.schemaVersion !== 1 || !Array.isArray(data.history) || data.history.length > 20) throw new Error("Provider RSI history schema is invalid")
		const history = data.history.map(validate)
		if (new Set(history.map(e => e.runId)).size !== history.length) throw new Error("Provider RSI run identities are duplicated")
		return { ...empty, history }
	} finally { await handle.close() }
}

/** Trusted controller projection; a run's existing evidence cannot be overwritten. */
export async function appendProviderRsiHistory(entry: ProviderRsiEntry, file = DEFAULT_FILE): Promise<void> {
	const next = validate(entry)
	const current = await readProviderRsiStatus(file)
	const previous = current.history.find(e => e.runId === next.runId)
	if (previous) {
		if (Object.keys(previous).some(key => previous[key as keyof ProviderRsiEntry] !== next[key as keyof ProviderRsiEntry])) throw new Error("Provider RSI run already has different evidence")
		return
	}
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
	const temp = `${file}.tmp.${randomUUID()}`
	try {
		await fs.writeFile(temp, JSON.stringify({ schemaVersion: 1, history: [...current.history, next].slice(-20) }) + "\n", { flag: "wx", mode: 0o600 })
		const handle = await fs.open(temp, "r+")
		try { await handle.sync() } finally { await handle.close() }
		await fs.rename(temp, file)
	} finally { await fs.rm(temp, { force: true }) }
}
