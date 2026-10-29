import * as fs from "node:fs/promises"
import { constants } from "node:fs"
import * as path from "node:path"
import { CAMPAIGN_CONTROL_ROOT } from "./paths.js"

export interface CampaignRsiHistoryEntry {
	updatedAt: string
	experimentId: string
	baselineCommit: string
	candidateCommit: string
	baselineSourceDigest: string
	candidateSourceDigest: string
	evaluatorDigest: string
	inputDigest: string
	evidenceDigest: string
	eligible: boolean
	baselineCorrect: number
	candidateCorrect: number
}

export interface CampaignRsiStatus {
	mode: "offline-synthetic-only"
	status: "not-run" | "evaluated"
	activation: "not-performed"
	limits: { modelCalls: 0; spendUsd: 0; comparisons: 1; maxDurationSeconds: 30; maxFixtures: 500 }
	history: CampaignRsiHistoryEntry[]
}

const DEFAULT_RSI_STATUS = path.join(CAMPAIGN_CONTROL_ROOT, "rsi", "status.json")
const LIMITS: CampaignRsiStatus["limits"] = { modelCalls: 0, spendUsd: 0, comparisons: 1, maxDurationSeconds: 30, maxFixtures: 500 }
const EMPTY: CampaignRsiStatus = { mode: "offline-synthetic-only", status: "not-run", activation: "not-performed", limits: LIMITS, history: [] }
const SHA = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/

/** Read only bounded, owner-private metadata. Raw evidence and source paths never enter the API. */
export async function readCampaignRsiStatus(file = DEFAULT_RSI_STATUS): Promise<CampaignRsiStatus> {
	let handle: Awaited<ReturnType<typeof fs.open>>
	try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY
		throw new Error("RSI status is unavailable")
	}
	let value: unknown
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 ||
			(stat.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())) {
			throw new Error("RSI status file must be bounded, private, regular, and owner-held")
		}
		value = JSON.parse(await handle.readFile("utf8"))
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error("RSI status file is malformed")
		throw error
	} finally { await handle.close() }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RSI status schema is invalid")
	const row = value as Record<string, unknown>
	if (Object.keys(row).sort().join(",") !== "history,schemaVersion" || row.schemaVersion !== 1 ||
		!Array.isArray(row.history) || row.history.length > 20) throw new Error("RSI status schema is invalid")
	const history: CampaignRsiHistoryEntry[] = row.history.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("RSI history entry is invalid")
		const e = entry as Record<string, unknown>
		if (Object.keys(e).sort().join(",") !== "baselineCommit,baselineCorrect,baselineSourceDigest,candidateCommit,candidateCorrect,candidateSourceDigest,eligible,evaluatorDigest,evidenceDigest,experimentId,inputDigest,updatedAt" ||
			typeof e.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(e.updatedAt) ||
			typeof e.experimentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(e.experimentId) ||
			typeof e.baselineCommit !== "string" || !COMMIT.test(e.baselineCommit) ||
			typeof e.candidateCommit !== "string" || !COMMIT.test(e.candidateCommit) ||
			![e.baselineSourceDigest, e.candidateSourceDigest, e.evaluatorDigest, e.inputDigest, e.evidenceDigest].every((digest) => typeof digest === "string" && SHA.test(digest as string)) ||
			typeof e.eligible !== "boolean" ||
			![e.baselineCorrect, e.candidateCorrect].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) {
			throw new Error("RSI history entry failed schema validation")
		}
		return { updatedAt: e.updatedAt as string, experimentId: e.experimentId as string,
			baselineCommit: e.baselineCommit as string, candidateCommit: e.candidateCommit as string,
			baselineSourceDigest: e.baselineSourceDigest as string, candidateSourceDigest: e.candidateSourceDigest as string,
			evaluatorDigest: e.evaluatorDigest as string, inputDigest: e.inputDigest as string,
			evidenceDigest: e.evidenceDigest as string, eligible: e.eligible as boolean,
			baselineCorrect: e.baselineCorrect as number, candidateCorrect: e.candidateCorrect as number }
	})
	return { mode: "offline-synthetic-only", status: history.length ? "evaluated" : "not-run",
		activation: "not-performed", limits: LIMITS, history }
}
