/**
 * Unit tests for src/orchestrator/status.ts's continuation/rework visibility
 * (buildStatusSummary + formatStatusText). Plain assert-based, no network.
 * Run via `npm test`.
 *
 * Added alongside the naming-collision liveness fix and log-analysis tool —
 * a caller watching a round from the outside had no way to see whether
 * auto-continuation after --max-iterations was actually firing, so they
 * fell back to manually re-invoking run-worker.sh instead of trusting the
 * documented auto-continue behavior. The counts already lived on
 * OrchestratorGroup; this just threads them into the status output.
 */

import assert from "node:assert/strict"

import { buildStatusSummary, formatStatusText } from "../status.js"
import type { OrchestratorGroup, OrchestratorState } from "../state.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function baseGroup(overrides: Partial<OrchestratorGroup> = {}): OrchestratorGroup {
	return { name: "w1", status: "done", ...overrides }
}

function stateOf(groups: OrchestratorGroup[]): OrchestratorState {
	return { batch: "test-batch", groups }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testSummaryCarriesContinuationAndReworkCounts(): Promise<void> {
	const state = stateOf([baseGroup({ continuationCount: 2, reworkCount: 1 })])
	const summary = buildStatusSummary(state)
	assert.equal(summary.groups[0]?.continuationCount, 2)
	assert.equal(summary.groups[0]?.reworkCount, 1)
}

async function testSummaryLeavesCountsUndefinedWhenNeverTriggered(): Promise<void> {
	const state = stateOf([baseGroup()])
	const summary = buildStatusSummary(state)
	assert.equal(summary.groups[0]?.continuationCount, undefined)
	assert.equal(summary.groups[0]?.reworkCount, undefined)
}

async function testFormattedTextShowsContinuationAndRework(): Promise<void> {
	const state = stateOf([baseGroup({ continuationCount: 3, reworkCount: 2 })])
	const summary = buildStatusSummary(state)
	const text = formatStatusText(summary, { repo: "/tmp/repo", statePath: "/tmp/state.json" })
	assert.match(text, /continued:3/)
	assert.match(text, /rework:2/)
}

async function testFormattedTextOmitsZeroCounts(): Promise<void> {
	const state = stateOf([baseGroup({ continuationCount: 0, reworkCount: 0 })])
	const summary = buildStatusSummary(state)
	const text = formatStatusText(summary, { repo: "/tmp/repo", statePath: "/tmp/state.json" })
	assert.ok(!text.includes("continued:"), `zero continuation count should not render, got: ${text}`)
	assert.ok(!text.includes("rework:"), `zero rework count should not render, got: ${text}`)
}

// ─── plan-first visibility (issue #49) ───────────────────────────────────────

async function testSummaryCarriesPlanFirst(): Promise<void> {
	const state = stateOf([baseGroup({ plan_first: { mode: "architect", status: "ok", report: "PLAN.md" } })])
	const summary = buildStatusSummary(state)
	assert.deepEqual(summary.groups[0]?.planFirst, { mode: "architect", status: "ok", report: "PLAN.md" })
}

async function testSummaryLeavesPlanFirstUndefinedWhenNotRun(): Promise<void> {
	const state = stateOf([baseGroup()])
	const summary = buildStatusSummary(state)
	assert.equal(summary.groups[0]?.planFirst, undefined)
}

async function testFormattedTextShowsPlanFirstOk(): Promise<void> {
	const state = stateOf([baseGroup({ plan_first: { mode: "architect", status: "ok", report: "PLAN.md" } })])
	const summary = buildStatusSummary(state)
	const text = formatStatusText(summary, { repo: "/tmp/repo", statePath: "/tmp/state.json" })
	assert.match(text, /plan-first:ok \(plan in task file\)/)
}

async function testFormattedTextShowsPlanFirstFailed(): Promise<void> {
	const state = stateOf([baseGroup({ plan_first: { mode: "architect", status: "failed" } })])
	const summary = buildStatusSummary(state)
	const text = formatStatusText(summary, { repo: "/tmp/repo", statePath: "/tmp/state.json" })
	assert.match(text, /plan-first:failed/)
	assert.ok(!text.includes("(plan in task file)"), "failed plan must not claim a plan is in the task file")
}

async function testFormattedTextOmitsPlanFirstWhenNotRun(): Promise<void> {
	const state = stateOf([baseGroup()])
	const summary = buildStatusSummary(state)
	const text = formatStatusText(summary, { repo: "/tmp/repo", statePath: "/tmp/state.json" })
	assert.ok(!text.includes("plan-first:"), `plan-first should not render for a plain round, got: ${text}`)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: [string, () => Promise<void>][] = [
	["buildStatusSummary carries continuation/rework counts", testSummaryCarriesContinuationAndReworkCounts],
	["buildStatusSummary leaves counts undefined when never triggered", testSummaryLeavesCountsUndefinedWhenNeverTriggered],
	["formatStatusText shows continued:/rework: when > 0", testFormattedTextShowsContinuationAndRework],
	["formatStatusText omits continued:/rework: when 0", testFormattedTextOmitsZeroCounts],
	["buildStatusSummary carries plan_first when the round used --plan-first", testSummaryCarriesPlanFirst],
	["buildStatusSummary leaves plan_first undefined for a plain round", testSummaryLeavesPlanFirstUndefinedWhenNotRun],
	["formatStatusText shows plan-first:ok (plan in task file)", testFormattedTextShowsPlanFirstOk],
	["formatStatusText shows plan-first:failed without claiming a plan", testFormattedTextShowsPlanFirstFailed],
	["formatStatusText omits plan-first for a plain round", testFormattedTextOmitsPlanFirstWhenNotRun],
]

async function main(): Promise<void> {
	let failed = 0
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
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} status tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
