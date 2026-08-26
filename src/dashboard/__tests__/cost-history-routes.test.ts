/**
 * Tests for the dashboard's cost-history route (src/dashboard/server.ts —
 * issue #29): GET /api/cost-history?repo=<path> serves the central store's
 * recorded per-group cost history + per-session breakdown as JSON (from
 * cost-history.jsonl / session-cost-history.jsonl via the existing readers),
 * optionally windowed by ?since=<iso> (recordedAt cutoff) and ?limit=N (most
 * recent N, newest-first ordering). A missing ?repo= is a 400; a repo with no
 * history is an empty 200, never an error.
 *
 * Plain assert-based script (no test framework), run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Server } from "node:http"

import { startDashboardServer } from "../server.js"
import {
	appendCostHistoryRecord,
	appendSessionCostRecord,
	type CostHistoryRecord,
	type SessionCostRecord,
} from "../../orchestrator/cost-history.js"

async function tmpRepo(prefix = "hc-cost-history-route-"): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function startServer(repo?: string): Promise<{ server: Server; port: number }> {
	const server = await startDashboardServer({ port: 0, repo })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	return { server, port }
}

async function get(base: string, urlPath: string): Promise<{ status: number; body: string }> {
	const res = await fetch(base + urlPath)
	const body = await res.text()
	return { status: res.status, body }
}

function baseGroup(overrides: Partial<CostHistoryRecord> = {}): CostHistoryRecord {
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

function baseSession(overrides: Partial<SessionCostRecord> = {}): SessionCostRecord {
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

async function testServesGroupAndSessionRecords(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseGroup({ groupName: "w1", issues: [27], costUsd: 0.05 }))
		await appendCostHistoryRecord(repo, baseGroup({ groupName: "w2", issues: [29], costUsd: 0.03, recordedAt: "2026-08-05T01:00:00.000Z" }))
		await appendSessionCostRecord(repo, baseSession({ sessionId: "s-ok", status: "success", costUsd: 0.03 }))
		await appendSessionCostRecord(repo, baseSession({ sessionId: "s-killed", status: "killed", costUsd: 0.02, recordedAt: "2026-08-05T01:00:00.000Z" }))

		const { server, port } = await startServer()
		try {
			const base = `http://127.0.0.1:${port}`
			const res = await get(base, `/api/cost-history?repo=${encodeURIComponent(repo)}`)
			assert.equal(res.status, 200)
			const data = JSON.parse(res.body) as {
				repo: string
				groups: Array<{ groupName: string; costUsd: number }>
				sessions: Array<{ sessionId: string; status: string }>
			}
			assert.equal(data.repo, path.resolve(repo))
			assert.equal(data.groups.length, 2, "both group records are served")
			assert.equal(data.sessions.length, 2, "both session records are served")
			// Newest-first ordering (like the CLI).
			assert.equal(data.groups[0].groupName, "w2")
			assert.equal(data.groups[1].groupName, "w1")
			assert.equal(data.sessions[0].status, "killed")
		} finally {
			server.close()
		}
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function testSinceWindowsByRecordedAt(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseGroup({ groupName: "old", recordedAt: "2026-08-01T00:00:00.000Z" }))
		await appendCostHistoryRecord(repo, baseGroup({ groupName: "new", recordedAt: "2026-08-05T00:00:00.000Z" }))

		const { server, port } = await startServer()
		try {
			const base = `http://127.0.0.1:${port}`
			const res = await get(base, `/api/cost-history?repo=${encodeURIComponent(repo)}&since=2026-08-02T00:00:00Z`)
			assert.equal(res.status, 200)
			const data = JSON.parse(res.body) as { groups: Array<{ groupName: string }> }
			assert.equal(data.groups.length, 1)
			assert.equal(data.groups[0].groupName, "new")
		} finally {
			server.close()
		}
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

/**
 * Regression: recordedAt is always millisecond-precision ("...000Z") while a
 * hand-typed ?since= (as in the route's own error-message example) is often
 * second-precision ("...Z") for the SAME instant. A raw string comparison
 * treats these as unequal — worse, the millisecond form sorts BEFORE the
 * second form ("." 0x2E < "Z" 0x5A) — so a record at exactly the ?since=
 * boundary was wrongly excluded. Compare parsed instants instead.
 */
async function testSinceBoundaryMillisecondPrecisionIncludesEqualInstant(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(
			repo,
			baseGroup({ groupName: "at-boundary", recordedAt: "2026-08-02T00:00:00.000Z" }),
		)

		const { server, port } = await startServer()
		try {
			const base = `http://127.0.0.1:${port}`
			// Same instant as the record's recordedAt, but second-precision.
			const res = await get(base, `/api/cost-history?repo=${encodeURIComponent(repo)}&since=2026-08-02T00:00:00Z`)
			assert.equal(res.status, 200)
			const data = JSON.parse(res.body) as { groups: Array<{ groupName: string }> }
			assert.equal(data.groups.length, 1, "a record exactly at the ?since= instant must be included (>=)")
			assert.equal(data.groups[0].groupName, "at-boundary")
		} finally {
			server.close()
		}
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function testLimitKeepsMostRecent(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await appendCostHistoryRecord(repo, baseGroup({ groupName: "w1", recordedAt: "2026-08-01T00:00:00.000Z" }))
		await appendCostHistoryRecord(repo, baseGroup({ groupName: "w2", recordedAt: "2026-08-02T00:00:00.000Z" }))
		await appendCostHistoryRecord(repo, baseGroup({ groupName: "w3", recordedAt: "2026-08-03T00:00:00.000Z" }))

		const { server, port } = await startServer()
		try {
			const base = `http://127.0.0.1:${port}`
			const res = await get(base, `/api/cost-history?repo=${encodeURIComponent(repo)}&limit=2`)
			assert.equal(res.status, 200)
			const data = JSON.parse(res.body) as { groups: Array<{ groupName: string }> }
			assert.equal(data.groups.length, 2)
			assert.deepEqual(data.groups.map((g) => g.groupName), ["w3", "w2"])
		} finally {
			server.close()
		}
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function testMissingRepoIs400(): Promise<void> {
	const { server, port } = await startServer()
	try {
		const res = await get(`http://127.0.0.1:${port}`, "/api/cost-history")
		assert.equal(res.status, 400)
		const body = JSON.parse(res.body) as { error: string }
		assert.match(body.error, /missing repo/)
	} finally {
		server.close()
	}
}

async function testInvalidSinceAndLimitAre400(): Promise<void> {
	const { server, port } = await startServer()
	try {
		const base = `http://127.0.0.1:${port}`
		const badSince = await get(base, "/api/cost-history?repo=/tmp/x&since=not-a-date")
		assert.equal(badSince.status, 400)
		assert.match(JSON.parse(badSince.body).error, /invalid since/)
		const badLimit = await get(base, "/api/cost-history?repo=/tmp/x&limit=0")
		assert.equal(badLimit.status, 400)
		assert.match(JSON.parse(badLimit.body).error, /invalid limit/)
		const floatLimit = await get(base, "/api/cost-history?repo=/tmp/x&limit=2.5")
		assert.equal(floatLimit.status, 400)
	} finally {
		server.close()
	}
}

async function testNoHistoryIsEmpty200(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer()
		try {
			const res = await get(`http://127.0.0.1:${port}`, `/api/cost-history?repo=${encodeURIComponent(repo)}`)
			assert.equal(res.status, 200)
			const data = JSON.parse(res.body) as { groups: unknown[]; sessions: unknown[] }
			assert.deepEqual(data.groups, [])
			assert.deepEqual(data.sessions, [])
		} finally {
			server.close()
		}
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
	}
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		["GET /api/cost-history?repo= serves group + session records (newest first)", testServesGroupAndSessionRecords],
		["?since=<iso> windows by recordedAt", testSinceWindowsByRecordedAt],
		[
			"?since= boundary: millisecond-precision recordedAt vs second-precision since includes the equal instant",
			testSinceBoundaryMillisecondPrecisionIncludesEqualInstant,
		],
		["?limit=N keeps the most recent N", testLimitKeepsMostRecent],
		["missing ?repo= is a 400", testMissingRepoIs400],
		["invalid ?since= / ?limit= are 400s", testInvalidSinceAndLimitAre400],
		["a repo with no history is an empty 200", testNoHistoryIsEmpty200],
	]

	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} cost-history dashboard-route tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
