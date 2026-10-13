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

async function buildSignedBundle(dir: string): Promise<{ bundlePath: string; keyPath: string; headPath: string; recordCount: number }> {
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
		await client.append({ sessionId, requestId: "r1", kind: "tool_intent", actor: "test", origin: "fixture", payload: { tool: "read_file" } })
		await client.append({ sessionId, requestId: "r2", kind: "tool_result", actor: "test", origin: "fixture", payload: { ok: true } })
		const bundle = await collector.exportBundle(sessionId)
		const bundlePath = path.join(dir, "bundle.json")
		const keyPath = path.join(dir, "key.json")
		const headPath = path.join(dir, "head.json")
		await fs.writeFile(bundlePath, JSON.stringify(bundle), "utf8")
		await fs.writeFile(keyPath, JSON.stringify(collector.publicKey), "utf8")
		await fs.writeFile(headPath, JSON.stringify(bundle.head), "utf8")
		return { bundlePath, keyPath, headPath, recordCount: bundle.records.length }
	} finally {
		await collector.close()
	}
}

async function testVerifyFilesAcceptsSignedBundle(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-evidence-verify-"))
	const { bundlePath, keyPath, headPath, recordCount } = await buildSignedBundle(dir)
	const result = await verifyEvidenceFiles(bundlePath, keyPath, headPath)
	assert.equal(result.valid, true, result.errors.join("\n"))
	assert.equal(result.checkedRecords, recordCount)
}

async function testVerifyFilesRejectsTamperedBundle(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-evidence-verify-"))
	const { bundlePath, keyPath, headPath } = await buildSignedBundle(dir)
	const raw = JSON.parse(await fs.readFile(bundlePath, "utf8")) as { records: Array<{ payload: unknown }> }
	raw.records[0] = { ...raw.records[0]!, payload: { tampered: true } }
	await fs.writeFile(bundlePath, JSON.stringify(raw), "utf8")
	const result = await verifyEvidenceFiles(bundlePath, keyPath, headPath)
	assert.equal(result.valid, false, "a tampered record must fail verification")
}

async function testIndexReexportsTheLeaf(): Promise<void> {
	assert.equal(indexVerifyEvidenceFiles, verifyEvidenceFiles)
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["verify files accepts a signed bundle", testVerifyFilesAcceptsSignedBundle],
		["verify files rejects a tampered bundle", testVerifyFilesRejectsTamperedBundle],
		["index re-exports the leaf", testIndexReexportsTheLeaf],
	]

	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (error) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}
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
