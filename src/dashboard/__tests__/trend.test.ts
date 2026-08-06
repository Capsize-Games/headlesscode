/**
 * Unit tests for src/dashboard/trend.ts's computeTrendData — the pure
 * function behind `headlesscode trend`. Plain assert-based script (no
 * framework, no network), run via `npm test`.
 */

import assert from "node:assert/strict"

import { computeTrendData } from "../trend.js"
import type { CostHistoryRecord, SessionCostRecord } from "../../orchestrator/cost-history.js"

function group(overrides: Partial<CostHistoryRecord> = {}): CostHistoryRecord {
	return {
		recordedAt: "2026-08-05T00:00:00.000Z",
		repo: "/tmp/repo",
		groupName: "w1",
		issues: [1],
		status: "done",
		costUsd: 0.1,
		inputTokens: 1000,
		outputTokens: 100,
		cachedTokens: 500,
		iterations: 100,
		continuationCount: 0,
		reworkCount: 0,
		...overrides,
	}
}

function session(overrides: Partial<SessionCostRecord> = {}): SessionCostRecord {
	return {
		recordedAt: "2026-08-05T00:00:00.000Z",
		repo: "/tmp/repo",
		groupName: "w1",
		issues: [1],
		sessionId: "s1",
		mode: "code",
		status: "success",
		costUsd: 0.05,
		inputTokens: 500,
		outputTokens: 50,
		cachedTokens: 200,
		iterations: 50,
		startedAt: "2026-08-05T00:00:00.000Z",
		endedAt: "2026-08-05T00:05:00.000Z",
		...overrides,
	}
}

function testComputesRatePerRepoChronologically(): void {
	const data = computeTrendData([
		{
			name: "repoA",
			groups: [
				group({ groupName: "w2", recordedAt: "2026-08-05T02:00:00.000Z", costUsd: 0.2, iterations: 200 }),
				group({ groupName: "w1", recordedAt: "2026-08-05T01:00:00.000Z", costUsd: 0.1, iterations: 100 }),
			],
			sessions: [],
		},
	])
	assert.equal(data.repos.length, 1)
	const points = data.repos[0].points
	assert.equal(points.length, 2)
	// Sorted chronologically, not insertion order.
	assert.equal(points[0].groupName, "w1")
	assert.equal(points[1].groupName, "w2")
	// $0.1 / 100 iter * 1000 = $1.00 per 1k-iter.
	assert.equal(points[0].rate, 1)
	assert.equal(points[1].rate, 1)
}

function testFlagsWastedPointsFromMatchingSession(): void {
	const data = computeTrendData([
		{
			name: "repoA",
			groups: [group({ groupName: "w1", recordedAt: "2026-08-05T01:00:00.000Z" })],
			sessions: [
				session({ groupName: "w1", recordedAt: "2026-08-05T01:00:00.000Z", status: "error", mode: "qa-agent" }),
				// A DIFFERENT recordedAt (different settle event) must not match.
				session({ groupName: "w1", recordedAt: "2026-08-05T09:00:00.000Z", status: "error", mode: "code" }),
			],
		},
	])
	const point = data.repos[0].points[0]
	assert.equal(point.wasted, true)
	assert.match(point.wastedNote ?? "", /qa-agent error/)
	assert.doesNotMatch(point.wastedNote ?? "", /09:00/)
}

function testWastedClusteringInsightNotesZeroSince(): void {
	const data = computeTrendData([
		{
			name: "repoA",
			groups: [
				group({ groupName: "w1", recordedAt: "2026-08-05T01:00:00.000Z" }),
				group({ groupName: "w2", recordedAt: "2026-08-05T02:00:00.000Z" }),
			],
			sessions: [session({ groupName: "w1", recordedAt: "2026-08-05T01:00:00.000Z", status: "error" })],
		},
	])
	const insight = data.insights.find((i) => i.includes("wasted session"))
	assert.ok(insight, "expected a wasted-session insight")
	assert.match(insight!, /zero wasted sessions in the 1 round/)
}

function testNoWastedSessionsInsight(): void {
	const data = computeTrendData([{ name: "repoA", groups: [group()], sessions: [] }])
	assert.ok(data.insights.some((i) => i.startsWith("No wasted sessions")))
}

function testReworkRateInsight(): void {
	const data = computeTrendData([
		{
			name: "repoA",
			groups: [group({ groupName: "w1", reworkCount: 1 }), group({ groupName: "w2", reworkCount: 0 })],
			sessions: [],
		},
	])
	const insight = data.insights.find((i) => i.includes("needed at least one rework"))
	assert.ok(insight)
	assert.match(insight!, /^1\/2 round/)
}

function testRepoComparisonInsight(): void {
	const data = computeTrendData([
		{ name: "cheap", groups: [group({ costUsd: 0.01, iterations: 100 })], sessions: [] },
		{ name: "expensive", groups: [group({ costUsd: 1, iterations: 100 })], sessions: [] },
	])
	const insight = data.insights.find((i) => i.startsWith("expensive averages"))
	assert.ok(insight, "expected a repo-comparison insight naming the higher-cost repo first")
}

function testEmptyReposProduceNoCrash(): void {
	const data = computeTrendData([{ name: "empty", groups: [], sessions: [] }])
	assert.equal(data.repos[0].points.length, 0)
	assert.equal(data.repos[0].avgRate, 0)
	assert.ok(Array.isArray(data.insights))
}

const tests: Array<[string, () => void]> = [
	["computes rate per repo, sorted chronologically", testComputesRatePerRepoChronologically],
	["flags a wasted point only from a session at the SAME settle event", testFlagsWastedPointsFromMatchingSession],
	["wasted-clustering insight notes zero-since when applicable", testWastedClusteringInsightNotesZeroSince],
	["no-wasted-sessions insight when there are none", testNoWastedSessionsInsight],
	["rework-rate insight", testReworkRateInsight],
	["repo-comparison insight names the higher-cost repo", testRepoComparisonInsight],
	["empty repo produces no crash, sane defaults", testEmptyReposProduceNoCrash],
]

let failed = 0
for (const [name, fn] of tests) {
	try {
		fn()
		console.log(`  ok   ${name}`)
	} catch (err) {
		failed++
		console.error(`  FAIL ${name}`)
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
	}
}
if (failed > 0) {
	console.error(`\n${failed} test(s) failed`)
	process.exit(1)
}
console.log(`\nAll ${tests.length} trend tests passed`)
