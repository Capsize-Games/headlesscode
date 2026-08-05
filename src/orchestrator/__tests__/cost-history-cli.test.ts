/**
 * Unit tests for src/orchestrator/cost-history-cli.ts — the `headlesscode
 * cost-history` read-side subcommand. Plain assert-based, no network. Run
 * via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"

import { appendCostHistoryRecord, type CostHistoryRecord } from "../cost-history.js"
import { costHistoryCliMain, parseCostHistoryArgs } from "../cost-history-cli.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tmpRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cost-history-cli-"))
	try {
		execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" })
	} catch {
		execFileSync("git", ["init", "-q", dir], { stdio: "ignore" })
	}
	return dir
}

function baseRecord(overrides: Partial<CostHistoryRecord> = {}): CostHistoryRecord {
	return {
		recordedAt: "2026-08-05T00:00:00.000Z",
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

function captureStdout(): { get: () => string; restore: () => void } {
	let buf = ""
	const orig = process.stdout.write.bind(process.stdout)
	process.stdout.write = ((chunk: string) => {
		buf += chunk
		return true
	}) as typeof process.stdout.write
	return { get: () => buf, restore: () => (process.stdout.write = orig) }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testParseArgsRequiresRepo(): Promise<void> {
	const result = parseCostHistoryArgs([])
	assert.ok("error" in result)
	assert.match((result as { error: string }).error, /--repo is required/)
}

async function testParseArgsCollectsMultipleIssues(): Promise<void> {
	const result = parseCostHistoryArgs(["--repo", "/tmp/x", "--issue", "27", "--issue", "29", "--json"])
	assert.deepEqual(result, { repo: "/tmp/x", issues: [27, 29], json: true })
}

async function testParseArgsRejectsNonIntegerIssue(): Promise<void> {
	const result = parseCostHistoryArgs(["--repo", "/tmp/x", "--issue", "abc"])
	assert.ok("error" in result)
	assert.match((result as { error: string }).error, /--issue must be an integer/)
}

async function testMainPrintsTableWithTotal(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseRecord({ groupName: "w1", costUsd: 0.05 }))
		await appendCostHistoryRecord(repo, baseRecord({ groupName: "w2", issues: [30], costUsd: 0.03 }))
		const out = captureStdout()
		let code: number
		try {
			code = await costHistoryCliMain(["--repo", repo])
		} finally {
			out.restore()
		}
		assert.equal(code, 0)
		assert.match(out.get(), /w1/)
		assert.match(out.get(), /w2/)
		assert.match(out.get(), /2 record\(s\), total: \$0\.0800/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMainFiltersByIssue(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseRecord({ groupName: "w1", issues: [27] }))
		await appendCostHistoryRecord(repo, baseRecord({ groupName: "w2", issues: [30] }))
		const out = captureStdout()
		let code: number
		try {
			code = await costHistoryCliMain(["--repo", repo, "--issue", "30"])
		} finally {
			out.restore()
		}
		assert.equal(code, 0)
		assert.ok(!out.get().includes("w1"), "must not include a group that doesn't cover the filtered issue")
		assert.match(out.get(), /w2/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMainJsonOutput(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseRecord())
		const out = captureStdout()
		let code: number
		try {
			code = await costHistoryCliMain(["--repo", repo, "--json"])
		} finally {
			out.restore()
		}
		assert.equal(code, 0)
		const parsed = JSON.parse(out.get())
		assert.equal(parsed.length, 1)
		assert.equal(parsed[0].groupName, "w1")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMainEmptyHistoryMessage(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const out = captureStdout()
		let code: number
		try {
			code = await costHistoryCliMain(["--repo", repo])
		} finally {
			out.restore()
		}
		assert.equal(code, 0)
		assert.match(out.get(), /No cost history recorded/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: [string, () => Promise<void>][] = [
	["parseCostHistoryArgs requires --repo", testParseArgsRequiresRepo],
	["parseCostHistoryArgs collects multiple --issue flags", testParseArgsCollectsMultipleIssues],
	["parseCostHistoryArgs rejects non-integer --issue", testParseArgsRejectsNonIntegerIssue],
	["main prints a table with a total", testMainPrintsTableWithTotal],
	["main filters by --issue", testMainFiltersByIssue],
	["main --json prints raw records", testMainJsonOutput],
	["main prints a clear message on empty history", testMainEmptyHistoryMessage],
]

async function main(): Promise<void> {
	const storeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-cost-history-cli-store-"))
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
	console.log(`\nAll ${tests.length} cost-history-cli tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
