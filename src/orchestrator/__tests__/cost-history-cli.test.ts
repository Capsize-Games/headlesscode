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

import { appendCostHistoryRecord, appendSessionCostRecord, type CostHistoryRecord, type SessionCostRecord } from "../cost-history.js"
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

function baseSessionRecord(overrides: Partial<SessionCostRecord> = {}): SessionCostRecord {
	return {
		recordedAt: "2026-08-05T00:00:00.000Z",
		repo: "/tmp/repo",
		groupName: "w1",
		issues: [27],
		sessionId: "session-1",
		mode: "code",
		status: "success",
		costUsd: 0.01,
		inputTokens: 100,
		outputTokens: 10,
		cachedTokens: 50,
		iterations: 5,
		startedAt: "2026-08-05T00:00:00.000Z",
		endedAt: "2026-08-05T00:05:00.000Z",
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
	assert.deepEqual(result, { repo: "/tmp/x", issues: [27, 29], sessions: false, byShape: false, json: true })
}

async function testParseArgsSessionsFlag(): Promise<void> {
	const result = parseCostHistoryArgs(["--repo", "/tmp/x", "--sessions"])
	assert.deepEqual(result, { repo: "/tmp/x", issues: [], sessions: true, byShape: false, json: false })
}

async function testParseArgsByShapeFlag(): Promise<void> {
	const result = parseCostHistoryArgs(["--repo", "/tmp/x", "--by-shape"])
	assert.deepEqual(result, { repo: "/tmp/x", issues: [], sessions: false, byShape: true, json: false })
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

async function testMainShowsWastedSpendSummary(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseRecord({ costUsd: 0.05 }))
		await appendSessionCostRecord(repo, baseSessionRecord({ sessionId: "s-ok", status: "success", costUsd: 0.03 }))
		await appendSessionCostRecord(repo, baseSessionRecord({ sessionId: "s-killed", status: "killed", costUsd: 0.02 }))
		const out = captureStdout()
		let code: number
		try {
			code = await costHistoryCliMain(["--repo", repo])
		} finally {
			out.restore()
		}
		assert.equal(code, 0)
		assert.match(out.get(), /1 wasted session\(s\).*\$0\.0200/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMainSessionsFlagShowsPerSessionBreakdown(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendSessionCostRecord(repo, baseSessionRecord({ sessionId: "s-ok", status: "success", costUsd: 0.03 }))
		await appendSessionCostRecord(repo, baseSessionRecord({ sessionId: "s-errored", status: "error", costUsd: 0.01 }))
		const out = captureStdout()
		let code: number
		try {
			code = await costHistoryCliMain(["--repo", repo, "--sessions"])
		} finally {
			out.restore()
		}
		assert.equal(code, 0)
		assert.match(out.get(), /s-ok/)
		assert.match(out.get(), /s-errored/)
		assert.match(out.get(), /wasted \(non-success\): \$0\.0100/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMainShowsWallClockDuration(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(
			repo,
			baseRecord({
				groupName: "w1",
				costUsd: 0.05,
				spawnedAt: "2026-08-05T10:00:00.000Z",
				wallClockMs: 75 * 60 * 1000, // 1h 15m
			}),
		)
		const out = captureStdout()
		let code: number
		try {
			code = await costHistoryCliMain(["--repo", repo])
		} finally {
			out.restore()
		}
		assert.equal(code, 0)
		assert.match(out.get(), /1h 15m/)
		assert.match(out.get(), /total wall-clock \(planning-to-completion\): 1h 15m/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMainByShapeShowsPerShapeAggregates(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(
			repo,
			baseRecord({ groupName: "g1", issues: [27], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		)
		await appendCostHistoryRecord(
			repo,
			baseRecord({ groupName: "g2", issues: [28], shapes: ["split"], costUsd: 0.4, iterations: 60 }),
		)
		await appendCostHistoryRecord(
			repo,
			baseRecord({ groupName: "g3", issues: [30], shapes: ["docs"], costUsd: 0.1, iterations: 20 }),
		)
		const out = captureStdout()
		let code: number
		try {
			code = await costHistoryCliMain(["--repo", repo, "--by-shape"])
		} finally {
			out.restore()
		}
		assert.equal(code, 0)
		assert.match(out.get(), /split\s+2\s+\$0\.3000\s+\$0\.3000\s+50\s+0\.0 \/ 0\.0/)
		assert.match(out.get(), /docs\s+1\s+\$0\.1000/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testMainByShapeJsonOutput(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(
			repo,
			baseRecord({ groupName: "g1", issues: [27], shapes: ["split"], costUsd: 0.2, iterations: 40 }),
		)
		const out = captureStdout()
		let code: number
		try {
			code = await costHistoryCliMain(["--repo", repo, "--by-shape", "--json"])
		} finally {
			out.restore()
		}
		assert.equal(code, 0)
		const parsed = JSON.parse(out.get()) as Array<{ shape: string; samples: number; costMedianUsd: number }>
		assert.equal(parsed.length, 1)
		assert.equal(parsed[0]?.shape, "split")
		assert.equal(parsed[0]?.samples, 1)
		assert.equal(parsed[0]?.costMedianUsd, 0.2)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: [string, () => Promise<void>][] = [
	["parseCostHistoryArgs requires --repo", testParseArgsRequiresRepo],
	["parseCostHistoryArgs collects multiple --issue flags", testParseArgsCollectsMultipleIssues],
	["parseCostHistoryArgs --sessions flag", testParseArgsSessionsFlag],
	["parseCostHistoryArgs --by-shape flag", testParseArgsByShapeFlag],
	["parseCostHistoryArgs rejects non-integer --issue", testParseArgsRejectsNonIntegerIssue],
	["main prints a table with a total", testMainPrintsTableWithTotal],
	["main shows wall-clock duration formatted human-readably", testMainShowsWallClockDuration],
	["main filters by --issue", testMainFiltersByIssue],
	["main --json prints raw records", testMainJsonOutput],
	["main prints a clear message on empty history", testMainEmptyHistoryMessage],
	["main shows a wasted-spend summary line when non-success sessions exist", testMainShowsWastedSpendSummary],
	["main --sessions shows the per-session breakdown", testMainSessionsFlagShowsPerSessionBreakdown],
	["main --by-shape prints per-shape aggregates (cost medians + cont/rework rates)", testMainByShapeShowsPerShapeAggregates],
	["main --by-shape --json prints raw shape aggregates", testMainByShapeJsonOutput],
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
