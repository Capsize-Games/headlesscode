import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { appendRun, archivePath, checkpointRun, findActiveRun, readArchive } from "../archive.js"
import type { RsiRunRecord } from "../types.js"

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rsi-archive-"))
	try {
		const initial = await readArchive(dir)
		assert.equal(initial.schemaVersion, 2)
		assert.deepEqual(initial.activeRuns, [])
		await fs.writeFile(
			archivePath(dir),
			JSON.stringify({ schemaVersion: 1, updatedAt: "old", runs: [], candidates: [] }),
			"utf8",
		)
		const migrated = await readArchive(dir)
		assert.equal(migrated.schemaVersion, 2)
		assert.deepEqual(migrated.modelCandidates, [])
		const run: RsiRunRecord = {
			runId: "rsi-fixture",
			startedAt: "2026-09-19T20:00:00.000Z",
			finishedAt: "2026-09-19T20:01:00.000Z",
			model: "wxrq-qwen3.5-9b:latest",
			baseRef: "HEAD",
			baseCommit: "abc123",
			generations: 1,
			selected: "none",
			candidates: [],
			reports: [],
		}
		await checkpointRun(dir, run)
		assert.equal((await findActiveRun(dir, "rsi-fixture"))?.runId, "rsi-fixture")
		const archive = await appendRun(dir, run)
		assert.equal(archive.runs.length, 1)
		assert.equal(archive.activeRuns.length, 0)
		assert.equal((await readArchive(dir)).runs[0]?.runId, "rsi-fixture")
		assert.ok((await fs.stat(archivePath(dir))).isFile())
		console.log("All 3 RSI archive tests passed")
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
