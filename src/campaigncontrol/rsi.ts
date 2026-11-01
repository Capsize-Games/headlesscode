import * as fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
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
	limits: {
		modelCalls: 0
		spendUsd: 0
		comparisons: 1
		maxDurationSeconds: 30
		maxFixtures: 500
	}
	history: CampaignRsiHistoryEntry[]
}

const DEFAULT_RSI_STATUS = path.join(
	CAMPAIGN_CONTROL_ROOT,
	"rsi",
	"status.json",
)
const LIMITS: CampaignRsiStatus["limits"] = {
	modelCalls: 0, spendUsd: 0, comparisons: 1, maxDurationSeconds: 30,
	maxFixtures: 500,
}
const EMPTY: CampaignRsiStatus = {
	mode: "offline-synthetic-only",
	status: "not-run",
	activation: "not-performed",
	limits: LIMITS,
	history: [],
}
const SHA = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const TIMESTAMP_PATTERN = new RegExp(
	"^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?Z$",
)
const EXPERIMENT_PATTERN = new RegExp("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
const ENTRY_KEY_LIST = [
	"baselineCommit",
	"baselineCorrect",
	"baselineSourceDigest",
	"candidateCommit",
	"candidateCorrect",
	"candidateSourceDigest",
	"eligible",
	"evaluatorDigest",
	"evidenceDigest",
	"experimentId",
	"inputDigest",
	"updatedAt",
].join(",")

/** Read only bounded, owner-private metadata. Raw evidence and source
	paths never enter the API. */
export async function readCampaignRsiStatus(
	file = DEFAULT_RSI_STATUS,
): Promise<CampaignRsiStatus> {
	const handle = await openStatusHandle(file)
	if (!handle) return EMPTY
	try {
		const history = statusHistory(await readStatusValue(handle))
		return {
			mode: "offline-synthetic-only",
			status: history.length ? "evaluated" : "not-run",
			activation: "not-performed",
			limits: LIMITS,
			history,
		}
	} finally {
		await handle.close()
	}
}

async function openStatusHandle(
	file: string,
): Promise<Awaited<ReturnType<typeof fs.open>> | null> {
	try {
		return await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw new Error("RSI status is unavailable")
	}
}

async function readStatusValue(
	handle: Awaited<ReturnType<typeof fs.open>>,
): Promise<unknown> {
	const stat = await handle.stat()
	assertStatusFile(stat)
	try {
		return JSON.parse(await handle.readFile("utf8"))
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("RSI status file is malformed")
		}
		throw error
	}
}

function assertStatusFile(stat: Stats): void {
	if (
		!stat.isFile() ||
		stat.nlink !== 1 ||
		stat.size > 32 * 1024 ||
		(stat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())
	) {
		throw new Error(
			"RSI status file must be bounded, private, regular, and owner-held",
		)
	}
}

function statusHistory(value: unknown): CampaignRsiHistoryEntry[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("RSI status schema is invalid")
	}
	const row = value as Record<string, unknown>
	if (
		Object.keys(row).sort().join(",") !== "history,schemaVersion" ||
		row.schemaVersion !== 1 ||
		!Array.isArray(row.history) ||
		row.history.length > 20
	) {
		throw new Error("RSI status schema is invalid")
	}
	return row.history.map(toHistoryEntry)
}

function toHistoryEntry(entry: unknown): CampaignRsiHistoryEntry {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		throw new Error("RSI history entry is invalid")
	}
	const record = entry as Record<string, unknown>
	assertEntryShape(record)
	assertEntryFields(record)
	return entryRecord(record)
}

function assertEntryShape(record: Record<string, unknown>): void {
	if (Object.keys(record).sort().join(",") !== ENTRY_KEY_LIST) {
		throw new Error("RSI history entry is invalid")
	}
}

function assertEntryFields(record: Record<string, unknown>): void {
	if (
		!validTimestamp(record.updatedAt) ||
		!validExperiment(record.experimentId) ||
		!validCommit(record.baselineCommit) ||
		!validCommit(record.candidateCommit) ||
		!validDigests(record) ||
		typeof record.eligible !== "boolean" ||
		!validCounts(record)
	) {
		throw new Error("RSI history entry failed schema validation")
	}
}

function validTimestamp(value: unknown): boolean {
	return typeof value === "string" && TIMESTAMP_PATTERN.test(value)
}

function validExperiment(value: unknown): boolean {
	return typeof value === "string" && EXPERIMENT_PATTERN.test(value)
}

function validCommit(value: unknown): boolean {
	return typeof value === "string" && COMMIT.test(value)
}

function validDigests(record: Record<string, unknown>): boolean {
	return [
		record.baselineSourceDigest,
		record.candidateSourceDigest,
		record.evaluatorDigest,
		record.inputDigest,
		record.evidenceDigest,
	].every((digest) => typeof digest === "string" && SHA.test(digest as string))
}

function validCounts(record: Record<string, unknown>): boolean {
	return [record.baselineCorrect, record.candidateCorrect].every(
		(n) => Number.isSafeInteger(n) && (n as number) >= 0,
	)
}

function entryRecord(e: Record<string, unknown>): CampaignRsiHistoryEntry {
	return {
		updatedAt: e.updatedAt as string,
		experimentId: e.experimentId as string,
		baselineCommit: e.baselineCommit as string,
		candidateCommit: e.candidateCommit as string,
		baselineSourceDigest: e.baselineSourceDigest as string,
		candidateSourceDigest: e.candidateSourceDigest as string,
		evaluatorDigest: e.evaluatorDigest as string,
		inputDigest: e.inputDigest as string,
		evidenceDigest: e.evidenceDigest as string,
		eligible: e.eligible as boolean,
		baselineCorrect: e.baselineCorrect as number,
		candidateCorrect: e.candidateCorrect as number,
	}
}
