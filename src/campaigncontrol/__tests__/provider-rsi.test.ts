import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
	appendProviderRsiHistory,
	readProviderRsiStatus,
	type ProviderRsiEntry,
} from "../provider-rsi.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const entry: ProviderRsiEntry = {
	updatedAt: "2026-10-29T13:00:00Z",
	experimentId: "fleet-synthetic-intake-rsi-muse",
	runId: "rsi-1",
	planDigest: "a".repeat(64),
	evidenceDigest: "b".repeat(64),
	status: "evaluated",
	baselineCorrect: 3,
	candidateCorrect: 4,
	caseCount: 4,
	eligible: true,
	modelCalls: 1,
	settledMicros: 100,
	ambiguousMicros: 0,
}

async function historyFile(): Promise<{
	root: string
	file: string
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-rsi-"))
	return { root, file: path.join(root, "history.json") }
}

async function testProjection(): Promise<void> {
	const { root, file } = await historyFile()
	try {
		assert.equal((await readProviderRsiStatus(file)).history.length, 0)
		await appendProviderRsiHistory(entry, file)
		await appendProviderRsiHistory(entry, file)
		const view = await readProviderRsiStatus(file)
		assert.equal(view.history.length, 1)
		assert.equal(view.activation, "not-performed")
		assert.equal(view.history[0]?.candidateCorrect, 4)
		await assert.rejects(
			appendProviderRsiHistory({ ...entry, eligible: false }, file),
			/different evidence/,
		)
		await fs.chmod(file, 0o644)
		await assert.rejects(readProviderRsiStatus(file), /private/)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

function invalidEntries(): Array<ProviderRsiEntry> {
	return [
		{ ...entry, rawLogs: "private" } as ProviderRsiEntry,
		{ ...entry, candidateCorrect: 3 },
		{ ...entry, modelCalls: 4 },
		{ ...entry, settledMicros: 21000 },
		{ ...entry, settledMicros: 19000, ambiguousMicros: 2000 },
	]
}

async function testRejectsInventedResultsAndPrivatePayload(): Promise<void> {
	const { root, file } = await historyFile()
	try {
		for (const bad of invalidEntries()) {
			await assert.rejects(
				appendProviderRsiHistory(bad, file),
				/validation/,
			)
		}
		await failedRunStaysNull(file)
		await privateSymlinkIsUnavailable(root, file)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function failedRunStaysNull(file: string): Promise<void> {
	await appendProviderRsiHistory(failedEntry(), file)
	assert.equal(
		(await readProviderRsiStatus(file)).history[0]?.candidateCorrect,
		null,
	)
}

async function privateSymlinkIsUnavailable(
	root: string,
	file: string,
): Promise<void> {
	const symlink = path.join(root, "link.json")
	await fs.symlink(file, symlink)
	await assert.rejects(readProviderRsiStatus(symlink), /unavailable/)
}

function failedEntry(): ProviderRsiEntry {
	return {
		...entry,
		status: "failed",
		eligible: false,
		candidateCorrect: null,
		modelCalls: 0,
		settledMicros: 0,
	}
}

const tests: SuiteTest[] = [
	[
		"provider RSI metadata is durable and preserves run evidence",
		testProjection,
	],
	[
		"provider RSI rejects private payloads and unsupported result claims",
		testRejectsInventedResultsAndPrivatePayload,
	],
]
runMain("campaign-control-provider-rsi", tests)
