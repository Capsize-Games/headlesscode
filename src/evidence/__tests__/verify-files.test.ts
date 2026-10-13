/**
 * Unit tests for the evidence verify-file move (src/evidence/verify.ts,
 * issue #128).
 *
 * verifyEvidenceFiles moves out of src/evidence/index.ts into the verify.ts
 * leaf so src/evidence/cli.ts can import it without an import cycle back
 * into the index (index.ts re-exported the CLI entry point). The index keeps
 * re-exporting verifyEvidenceFiles for backward compatibility, and the root
 * CLI imports the evidence entry point straight from evidence/cli.ts.
 *
 * Plain assert-based script (no test framework), run via `npm test` →
 * `tsx src/evidence/__tests__/verify-files.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { FileEvidenceCollector, UnixEvidenceJournal } from "../collector.js"
import { verifyEvidenceFiles } from "../verify.js"
import { verifyEvidenceFiles as indexVerifyEvidenceFiles } from "../index.js"

interface SignedBundlePaths {
	bundlePath: string
	keyPath: string
	headPath: string
	recordCount: number
}

async function appendFixtureRecords(
	client: UnixEvidenceJournal,
	sessionId: string,
): Promise<void> {
	const base = { sessionId, actor: "test", origin: "fixture" }
	const intent = {
		requestId: "r1", kind: "tool_intent", payload: { tool: "read_file" },
	}
	await client.append({ ...base, ...intent })
	const result = {
		requestId: "r2", kind: "tool_result", payload: { ok: true },
	}
	await client.append({ ...base, ...result })
}

async function exportBundleFiles(
	collector: FileEvidenceCollector,
	sessionId: string,
	dir: string,
): Promise<SignedBundlePaths> {
	const bundle = await collector.exportBundle(sessionId)
	const bundlePath = path.join(dir, "bundle.json")
	const keyPath = path.join(dir, "key.json")
	const headPath = path.join(dir, "head.json")
	await fs.writeFile(bundlePath, JSON.stringify(bundle), "utf8")
	const pubKey = JSON.stringify(collector.publicKey)
	await fs.writeFile(keyPath, pubKey, "utf8")
	await fs.writeFile(headPath, JSON.stringify(bundle.head), "utf8")
	return { bundlePath, keyPath, headPath, recordCount: bundle.records.length }
}

async function buildSignedBundle(dir: string): Promise<SignedBundlePaths> {
	const storageDir = path.join(dir, "collector")
	const socketPath = path.join(dir, "s")
	const collector = await FileEvidenceCollector.start({ storageDir, socketPath })
	try {
		const sessionId = "verify-files-test"
		const capability = await collector.authorizeSession(sessionId)
		const client = new UnixEvidenceJournal({
			socketPath,
			sessionId,
			capability,
			pinnedPublicKey: collector.publicKey,
		})
		await appendFixtureRecords(client, sessionId)
		return await exportBundleFiles(collector, sessionId, dir)
	} finally {
		await collector.close()
	}
}

async function testVerifyFilesAcceptsSignedBundle(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-evidence-verify-"))
	const built = await buildSignedBundle(dir)
	const { bundlePath, keyPath, headPath, recordCount } = built
	const result = await verifyEvidenceFiles(bundlePath, keyPath, headPath)
	assert.equal(result.valid, true, result.errors.join("\n"))
	assert.equal(result.checkedRecords, recordCount)
}

async function testVerifyFilesRejectsTamperedBundle(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-evidence-verify-"))
	const { bundlePath, keyPath, headPath } = await buildSignedBundle(dir)
	const text = await fs.readFile(bundlePath, "utf8")
	const raw = JSON.parse(text) as { records: Array<{ payload: unknown }> }
	raw.records[0] = { ...raw.records[0]!, payload: { tampered: true } }
	await fs.writeFile(bundlePath, JSON.stringify(raw), "utf8")
	const result = await verifyEvidenceFiles(bundlePath, keyPath, headPath)
	assert.equal(result.valid, false, "a tampered record must fail verification")
}

async function testIndexReexportsTheLeaf(): Promise<void> {
	assert.equal(indexVerifyEvidenceFiles, verifyEvidenceFiles)
}

async function runOne(name: string, fn: () => Promise<void>): Promise<boolean> {
	try {
		await fn()
		console.log(`  ok   ${name}`)
		return true
	} catch (error) {
		console.error(`  FAIL ${name}`)
		if (error instanceof Error) console.error(error.stack ?? error)
		else console.error(String(error))
		return false
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["accepts a signed bundle", testVerifyFilesAcceptsSignedBundle],
		["rejects a tampered bundle", testVerifyFilesRejectsTamperedBundle],
		["index re-exports the leaf", testIndexReexportsTheLeaf],
	]
	let failed = 0
	for (const [name, fn] of tests) {
		if (!(await runOne(name, fn))) failed++
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} verify-files tests passed`)
}

main().catch((error) => {
	console.error("Test runner crashed:", error)
	process.exit(1)
})
