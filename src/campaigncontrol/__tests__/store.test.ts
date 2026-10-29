import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { CampaignControlStore, MAX_MONTHLY_BUDGET_MICROS } from "../store.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

async function fixture(): Promise<{ root: string; store: CampaignControlStore }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-campaign-control-"))
	return { root, store: new CampaignControlStore(path.join(root, "control.json")) }
}

async function testInitialOffAndBudgetCeiling(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const initial = await store.snapshot(new Date("2026-10-28T00:00:00Z"))
		assert.equal(initial.enabled, false)
		assert.equal(initial.budgetLimitMicros, 0)
		assert.equal(initial.canAdmit, false)
		await assert.rejects(store.setBudgetLimit(MAX_MONTHLY_BUDGET_MICROS + 1), /budget must be an integer/)
		const enabled = await store.setEnabled(true)
		assert.equal(enabled.epoch, 1)
		assert.equal(enabled.canAdmit, false, "enabling without assigning a budget remains closed")
		const budgeted = await store.setBudgetLimit(1_250_000)
		assert.equal(budgeted.epoch, 2)
		assert.equal(budgeted.canAdmit, true)
		const unchanged = await store.setBudgetLimit(1_250_000)
		assert.equal(unchanged.epoch, 2, "repeated identical budget command is idempotent")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testExactControlSchemaAndRestartHistory(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const start = new Date("2026-10-28T12:00:00Z")
		await store.setBudgetLimit(5_000_000, start)
		await store.setEnabled(true, start)
		const run = await store.beginRun(start)
		const raw = JSON.parse(await fs.readFile(store.path, "utf8")) as Record<string, unknown>
		assert.deepEqual(Object.keys(raw).sort(), [
			"activeRun", "ambiguousMicros", "budgetLimitMicros", "canAdmit", "campaignId", "enabled", "epoch",
			"month", "nextDueAt", "reservedMicros", "schemaVersion", "settledMicros", "updatedAt",
		].sort(), "the Fleet admission contract has an exact key set")
		assert.deepEqual(raw.activeRun, run)
		const completed = await store.finishRun(run.id, "succeeded", "fixture receipt", new Date(start.getTime() + 10_000))
		assert.equal(completed.status, "succeeded")
		assert.equal((await store.snapshot()).activeRun, null)
		const restarted = new CampaignControlStore(store.path)
		const status = await restarted.status()
		assert.equal(status.control.enabled, true)
		assert.equal(status.runs.length, 1)
		assert.equal(status.runs[0]?.id, run.id)
		assert.equal(status.runs[0]?.detail, "fixture receipt")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testOffFencesNewAdmissionButPreservesPollSchedule(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const t0 = new Date("2026-10-28T12:00:00Z")
		await store.setBudgetLimit(100_000, t0)
		const on = await store.setEnabled(true, t0)
		const due = on.nextDueAt
		const off = await store.setEnabled(false, new Date(t0.getTime() + 1_000))
		assert.equal(off.epoch, on.epoch + 1)
		assert.equal(off.enabled, false)
		assert.equal(off.canAdmit, false)
		assert.equal(off.nextDueAt, due, "turning the campaign off does not erase its schedule")
		const run = await store.beginRun(new Date(t0.getTime() + 2_000))
		assert.equal(run.epoch, off.epoch, "a poll tick can have a fresh epoch while admission stays disabled")
		await store.finishRun(run.id, "succeeded", "active cleanup only", new Date(t0.getTime() + 3_000))
		assert.equal((await store.snapshot()).enabled, false)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testBudgetProjectionIncludesAmbiguousReservations(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date("2026-10-28T14:00:00Z")
		await store.setBudgetLimit(3_000_000, now)
		await store.setEnabled(true, now)
		const projected = await store.updateBudgetProjection({
			month: "2026-10", settledMicros: 1_000_000, reservedMicros: 500_000, ambiguousMicros: 1_000_000,
		}, now)
		assert.equal(projected.canAdmit, true, "an ambiguous hold remains counted against the cap")
		await assert.rejects(store.setBudgetLimit(2_499_999, now), /cannot be lowered below settled, reserved, or ambiguous/)
		const exhausted = await store.setBudgetLimit(2_500_000, now)
		assert.equal(exhausted.canAdmit, false, "no new admission is permitted when commitments equal the cap")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testStaleRunReceiptCannotClearNewerFence(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const started = new Date()
		const first = await store.beginRun(started, 1)
		const second = await store.beginRun(new Date(first.expiresAt))
		await assert.rejects(store.finishRun(first.id, "succeeded"), /fencing token is stale/)
		assert.equal((await store.snapshot()).activeRun?.id, second.id)
		const runs = (await store.status()).runs
		assert.equal(runs.length, 1)
		assert.equal(runs[0]?.status, "interrupted")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testLiveRunLeaseIsNeverReplaced(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const started = new Date()
		const active = await store.beginRun(started, 60_000)
		assert.equal(await store.beginRunIfIdle(new Date(started.getTime() + 1), 60_000), undefined)
		assert.equal((await store.snapshot()).activeRun?.id, active.id)
		await assert.rejects(store.beginRun(new Date(started.getTime() + 2)), /unexpired campaign run lease/)
		assert.equal((await store.status()).runs.length, 0, "a live lease is not falsely recorded as interrupted")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testAdmittedRunRequiresCurrentOnEpochAndSpendRoom(): Promise<void> {
	const { root, store } = await fixture()
	try {
		const now = new Date()
		const off = await store.snapshot(now)
		assert.equal(await store.beginAdmittedRunIfIdle(now, 60_000, off.epoch), undefined)
		await store.setBudgetLimit(100_000, now)
		const on = await store.setEnabled(true, now)
		const run = await store.beginAdmittedRunIfIdle(new Date(now.getTime() + 1), 60_000, on.epoch)
		assert.ok(run)
		assert.equal(run.epoch, on.epoch)
		await store.finishRun(run.id, "succeeded", "test", new Date(now.getTime() + 2))
		const staleEpoch = on.epoch
		await store.setEnabled(false, new Date(now.getTime() + 3))
		assert.equal(await store.beginAdmittedRunIfIdle(new Date(now.getTime() + 4), 60_000, staleEpoch), undefined)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["initial state is off and budget limit is capped", testInitialOffAndBudgetCeiling],
	["control handoff has exact schema and run history survives restart", testExactControlSchemaAndRestartHistory],
	["off fences admission but retains polling schedule", testOffFencesNewAdmissionButPreservesPollSchedule],
	["settled, reserved, and ambiguous costs all constrain the budget", testBudgetProjectionIncludesAmbiguousReservations],
	["stale run receipts cannot clear a newer fence", testStaleRunReceiptCannotClearNewerFence],
	["live campaign run leases cannot be overwritten", testLiveRunLeaseIsNeverReplaced],
	["inference leases require the same enabled epoch and available spend", testAdmittedRunRequiresCurrentOnEpochAndSpendRoom],
]

runMain("campaign-control", tests)
