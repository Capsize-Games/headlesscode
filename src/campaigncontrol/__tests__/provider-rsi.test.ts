import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { appendProviderRsiHistory, readProviderRsiStatus, type ProviderRsiEntry } from "../provider-rsi.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const entry: ProviderRsiEntry = { updatedAt: "2026-10-29T13:00:00Z", experimentId: "fleet-synthetic-intake-rsi-muse", runId: "rsi-1", planDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), status: "evaluated", baselineCorrect: 3, candidateCorrect: 4, caseCount: 4, eligible: true, modelCalls: 1, settledMicros: 100, ambiguousMicros: 0 }
async function testProjection(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-rsi-")); const file = path.join(root, "history.json")
	try {
		assert.equal((await readProviderRsiStatus(file)).history.length, 0)
		await appendProviderRsiHistory(entry, file)
		await appendProviderRsiHistory(entry, file)
		const view = await readProviderRsiStatus(file)
		assert.equal(view.history.length, 1); assert.equal(view.activation, "not-performed")
		assert.equal(view.history[0]?.candidateCorrect, 4)
		await assert.rejects(appendProviderRsiHistory({ ...entry, eligible: false }, file), /different evidence/)
		await fs.chmod(file, 0o644)
		await assert.rejects(readProviderRsiStatus(file), /private/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}
async function testRejectsInventedResultsAndPrivatePayload(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-rsi-")); const file = path.join(root, "history.json")
	try {
		for (const bad of [{ ...entry, rawLogs: "private" }, { ...entry, candidateCorrect: 3 }, { ...entry, modelCalls: 4 }, { ...entry, settledMicros: 21000 }, { ...entry, settledMicros: 19000, ambiguousMicros: 2000 }]) {
			await assert.rejects(appendProviderRsiHistory(bad as ProviderRsiEntry, file), /validation/)
		}
		await appendProviderRsiHistory({ ...entry, status: "failed", eligible: false, candidateCorrect: null, modelCalls: 0, settledMicros: 0 }, file)
		assert.equal((await readProviderRsiStatus(file)).history[0]?.candidateCorrect, null)
		const symlink = path.join(root, "link.json"); await fs.symlink(file, symlink)
		await assert.rejects(readProviderRsiStatus(symlink), /unavailable/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}
const tests: SuiteTest[] = [["provider RSI metadata is durable and preserves run evidence", testProjection], ["provider RSI rejects private payloads and unsupported result claims", testRejectsInventedResultsAndPrivatePayload]]
runMain("campaign-control-provider-rsi", tests)
