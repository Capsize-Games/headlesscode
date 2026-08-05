/**
 * Unit tests for src/orchestrator/cost-history.ts — the central,
 * append-only cost/token history store. Plain assert-based, no network.
 * Redirects the central store to a temp dir via $HEADLESSCODE_DATA_DIR so
 * no test ever touches the real ~/.local/share/headlesscode. Run via
 * `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import { appendCostHistoryRecord, readCostHistory, recordGroupCost, type CostHistoryRecord } from "../cost-history.js"
import type { OrchestratorGroup } from "../state.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tmpRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cost-history-"))
	try {
		execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" })
	} catch {
		execFileSync("git", ["init", "-q", dir], { stdio: "ignore" })
	}
	return dir
}

function baseRecord(overrides: Partial<CostHistoryRecord> = {}): CostHistoryRecord {
	return {
		recordedAt: new Date().toISOString(),
		repo: "/tmp/repo",
		groupName: "w1",
		issues: [27],
		status: "done",
		costUsd: 0.05,
		inputTokens: 1000,
		outputTokens: 100,
		cachedTokens: 500,
		iterations: 30,
		continuationCount: 0,
		reworkCount: 0,
		...overrides,
	}
}

function baseGroup(overrides: Partial<OrchestratorGroup> = {}): OrchestratorGroup {
	return {
		name: "w1",
		status: "done",
		issues: [27, 29],
		branch: "issues/w1-2026-08-05",
		usage: { costUsd: 0.12, inputTokens: 5000, outputTokens: 400, cachedTokens: 2000, iterations: 45 },
		continuationCount: 1,
		reworkCount: 2,
		...overrides,
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testAppendAndReadRoundTrip(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseRecord())
		await appendCostHistoryRecord(repo, baseRecord({ groupName: "w2", issues: [30] }))
		const records = await readCostHistory(repo)
		assert.equal(records.length, 2)
		assert.equal(records[0]?.groupName, "w1")
		assert.equal(records[1]?.groupName, "w2")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReadMissingFileReturnsEmptyArray(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const records = await readCostHistory(repo)
		assert.deepEqual(records, [])
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReadSkipsMalformedLines(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseRecord())
		const { costHistoryFilePath } = await import("../cost-history.js")
		await fs.appendFile(costHistoryFilePath(repo), "not json\n{\"incomplete\":\n", "utf-8")
		await appendCostHistoryRecord(repo, baseRecord({ groupName: "w2" }))
		const records = await readCostHistory(repo)
		assert.equal(records.length, 2, "malformed lines must be skipped, not throw")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRecordGroupCostBuildsCorrectRecord(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const group = baseGroup()
		const record = await recordGroupCost(repo, group)
		assert.ok(record)
		assert.deepEqual(record?.issues, [27, 29], "must carry EVERY issue the group covered, not just one")
		assert.equal(record?.costUsd, 0.12)
		assert.equal(record?.inputTokens, 5000)
		assert.equal(record?.continuationCount, 1)
		assert.equal(record?.reworkCount, 2)
		assert.equal(record?.branch, "issues/w1-2026-08-05")

		const stored = await readCostHistory(repo)
		assert.equal(stored.length, 1)
		assert.equal(stored[0]?.groupName, "w1")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRecordGroupCostSkipsWhenNoUsage(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const group = baseGroup({ usage: undefined })
		const record = await recordGroupCost(repo, group)
		assert.equal(record, undefined, "a group with no usage has nothing meaningful to record")
		const stored = await readCostHistory(repo)
		assert.equal(stored.length, 0, "nothing should be written to disk either")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testRecordGroupCostDefaultsMissingIssuesAndCachedTokens(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const group = baseGroup({
			issues: undefined,
			usage: { costUsd: 0.01, inputTokens: 100, outputTokens: 10, iterations: 5 },
		})
		const record = await recordGroupCost(repo, group)
		assert.deepEqual(record?.issues, [], "missing issues defaults to an empty array, never undefined/throw")
		assert.equal(record?.cachedTokens, 0, "missing cachedTokens defaults to 0")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: [string, () => Promise<void>][] = [
	["append + read round-trip", testAppendAndReadRoundTrip],
	["read missing file -> empty array", testReadMissingFileReturnsEmptyArray],
	["read skips malformed lines", testReadSkipsMalformedLines],
	["recordGroupCost builds a correct record from a terminal group", testRecordGroupCostBuildsCorrectRecord],
	["recordGroupCost returns undefined + writes nothing when group has no usage", testRecordGroupCostSkipsWhenNoUsage],
	["recordGroupCost defaults missing issues/cachedTokens", testRecordGroupCostDefaultsMissingIssuesAndCachedTokens],
]

async function main(): Promise<void> {
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cost-history-store-"))
	process.env.HEADLESSCODE_DATA_DIR = storeTmp
	let failed = 0
	try {
		for (const [name, fn] of tests) {
			try {
				await fn()
				console.log(`  ok   ${name}`)
			} catch (err) {
				failed++
				console.error(`  FAIL ${name}`)
				console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
			}
		}
	} finally {
		delete process.env.HEADLESSCODE_DATA_DIR
		await fs.rm(storeTmp, { recursive: true, force: true })
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} cost-history tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
