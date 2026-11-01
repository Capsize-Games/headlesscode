import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { readCampaignRsiStatus } from "../rsi.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const digest = "a".repeat(64)
const entry = { updatedAt: "2026-10-29T08:00:00Z", experimentId: "offline-run-1",
	baselineCommit: "b".repeat(40), candidateCommit: "c".repeat(40), evaluatorDigest: digest,
	baselineSourceDigest: "d".repeat(64), candidateSourceDigest: "e".repeat(64),
	inputDigest: digest, evidenceDigest: digest, eligible: true, baselineCorrect: 1, candidateCorrect: 2 }

async function testAbsentStatusIsExplicitlyNotRun(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-status-"))
	try {
		const status = await readCampaignRsiStatus(path.join(root, "missing.json"))
		assert.equal(status.mode, "offline-synthetic-only")
		assert.equal(status.status, "not-run")
		assert.equal(status.activation, "not-performed")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testOnlyValidatedMetadataIsReturned(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-status-"))
	const file = path.join(root, "status.json")
	try {
		await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, history: [entry], rawEvidence: "must never be accepted" }), { mode: 0o600 })
		await assert.rejects(readCampaignRsiStatus(file), /schema is invalid/)
		await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, history: [entry] }), { mode: 0o600 })
		const status = await readCampaignRsiStatus(file)
		assert.equal(status.status, "evaluated")
		assert.equal(status.history[0]?.evidenceDigest, digest)
		assert.equal("rawEvidence" in status, false)
		await fs.chmod(file, 0o644)
		await assert.rejects(readCampaignRsiStatus(file), /private/)
		await fs.chmod(file, 0o600)
		const link = path.join(root, "link.json")
		await fs.symlink(file, link)
		await assert.rejects(readCampaignRsiStatus(link), /unavailable/)
	} finally { await fs.chmod(file, 0o600).catch(() => undefined); await fs.rm(root, { recursive: true, force: true }) }
}

const tests: SuiteTest[] = [
	["absent RSI proof remains not-run", testAbsentStatusIsExplicitlyNotRun],
	["RSI report exposes validated metadata only", testOnlyValidatedMetadataIsReturned],
]
runMain("campaign-control-rsi", tests)
