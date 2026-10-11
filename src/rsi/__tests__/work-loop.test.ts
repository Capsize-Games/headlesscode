import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { runWorkLoop, workObservationsFromEvents, type WorkLoopConfig, type WorkLoopDriver } from "../work-loop.js"

const base = "a".repeat(40)
const repaired = "b".repeat(40)
const taskCommit = "c".repeat(40)
const observation = { key: "broken-tool", kind: "error" as const, summary: "tool has a reproduced error", evidenceRef: "host:reproducer-1" }
async function fixture(run: (config: WorkLoopConfig, driver: WorkLoopDriver) => Promise<void>) {
	const root = await mkdtemp(path.join(os.tmpdir(), "hc-work-loop-"))
	const config: WorkLoopConfig = { tasks: [{ id: "one", prompt: "fix project" }], harness: { commit: base, runtimeId: "sha256:old-runtime" }, ledgerPath: path.join(root, "ledger.jsonl"), maxTasks: 3, maxTaskAttempts: 2, maxRepairs: 2, maxRepairAttempts: 2, maxRuntimeMs: 10_000, maxSpendUsd: 1 }
	const driver: WorkLoopDriver = {
		runTask: async () => ({ candidate: { commit: taskCommit, workspace: root }, observations: [], costUsd: .01 }),
		verifyTask: async (_task, candidate) => ({ passed: true, commit: candidate.commit, evidenceRef: "host:task-tests" }),
		confirmObservation: async () => true,
		repairHarness: async () => ({ candidate: { commit: repaired, workspace: root }, observations: [], costUsd: .02 }),
		verifyHarness: async (_observation, candidate) => ({ passed: true, commit: candidate.commit, evidenceRef: "host:regression-and-reproducer" }),
		activateHarness: async (candidate) => ({ commit: candidate.commit, runtimeId: "sha256:new-runtime" }),
		acceptTask: async () => {},
	}
	try { await run(config, driver) } finally { await rm(root, { recursive: true, force: true }) }
}

test("failed task repairs harness, verifies it, then retries with the new immutable runtime", async () => fixture(async (config, driver) => {
	const calls: string[] = []
	driver.runTask = async (_task, attempt, context) => {
		calls.push(`task-${attempt}-${context.harness.commit}`)
		assert.ok(context.remainingSpendUsd <= 1 && !context.signal.aborted)
		return attempt === 1 ? { observations: [observation], costUsd: .01 } : { candidate: { commit: taskCommit, workspace: path.dirname(config.ledgerPath) }, observations: [], costUsd: .01 }
	}
	driver.verifyHarness = async (_observation, candidate) => { calls.push("verify-harness"); return { passed: true, commit: candidate.commit, evidenceRef: "host:checks" } }
	driver.activateHarness = async (candidate) => { calls.push("activate-harness"); return { commit: candidate.commit, runtimeId: "sha256:new-runtime" } }
	driver.acceptTask = async () => { calls.push("accept-task") }
	const result = await runWorkLoop(config, driver)
	assert.equal(result.reason, "queue-complete")
	assert.deepEqual(calls, [`task-1-${base}`, "verify-harness", "activate-harness", `task-2-${repaired}`, "accept-task"])
	assert.equal(result.acceptedRepairs, 1)
	assert.equal(result.settledCostUsd, .04)
	const records = (await readFile(config.ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
	let previousHash = ""
	for (const [index, record] of records.entries()) {
		const { hash, ...payload } = record
		assert.equal(record.sequence, index + 1)
		assert.equal(record.previousHash, previousHash)
		assert.equal(hash, createHash("sha256").update(JSON.stringify(payload)).digest("hex"))
		previousHash = hash
	}
	assert.equal(records.at(-1).type, "loop-stop")
}))

test("wrong-commit and failed verification cannot activate a repair or accept a task", async () => fixture(async (config, driver) => {
	driver.runTask = async () => ({ candidate: { commit: taskCommit, workspace: path.dirname(config.ledgerPath) }, observations: [observation], costUsd: 0 })
	driver.verifyTask = async () => ({ passed: true, commit: base, evidenceRef: "host:wrong-identity" })
	driver.verifyHarness = async () => ({ passed: true, commit: base, evidenceRef: "host:wrong-identity" })
	driver.activateHarness = async () => { assert.fail("unverified repair activated") }
	driver.acceptTask = async () => { assert.fail("unverified task accepted") }
	const result = await runWorkLoop(config, driver)
	assert.equal(result.reason, "task-failed")
	assert.equal(result.repairAttempts, 2)
	assert.equal(result.acceptedRepairs, 0)
	assert.equal(result.harness.commit, base)
}))

test("repeated evidence is repaired once across task retries; unconfirmed findings never trigger repairs", async () => fixture(async (config, driver) => {
	driver.runTask = async () => ({ observations: [observation, { ...observation }, { ...observation, key: "unconfirmed" }], costUsd: 0 })
	driver.confirmObservation = async (item) => item.key !== "unconfirmed"
	let repairs = 0
	driver.repairHarness = async () => { repairs++; return { observations: [], costUsd: 0 } }
	const result = await runWorkLoop(config, driver)
	assert.equal(result.reason, "task-failed")
	assert.equal(repairs, 2, "one finding receives its two bounded repair attempts")
}))

test("unknown billing stops before verification or further inference", async () => fixture(async (config, driver) => {
	driver.runTask = async () => ({ observations: [observation], costUsd: null })
	driver.confirmObservation = async () => { assert.fail("continued after unknown charges") }
	const result = await runWorkLoop(config, driver)
	assert.equal(result.reason, "uncertain-billing")
	assert.equal(result.taskAttempts, 1)
	assert.equal(result.repairAttempts, 0)
}))

test("global spending and repair caps apply across both kinds of model work", async () => fixture(async (config, driver) => {
	config.maxSpendUsd = .025
	driver.runTask = async () => ({ observations: [observation], costUsd: .01 })
	driver.repairHarness = async (_observation, _attempt, context) => {
		assert.equal(context.remainingSpendUsd, .015000000000000001)
		return { observations: [], costUsd: .02 }
	}
	assert.equal((await runWorkLoop(config, driver)).reason, "spend-limit")
}))

test("repair cap stops before a new repair worker starts", async () => fixture(async (config, driver) => {
	config.maxRepairs = 1
	driver.runTask = async () => ({ observations: [observation], costUsd: 0 })
	driver.repairHarness = async () => ({ observations: [], costUsd: 0 })
	const result = await runWorkLoop(config, driver)
	assert.equal(result.reason, "repair-limit")
	assert.equal(result.repairAttempts, 1)
}))

test("pre-existing cancellation launches no worker", async () => fixture(async (config, driver) => {
	const abort = new AbortController(); abort.abort()
	driver.runTask = async () => { assert.fail("cancelled worker launched") }
	const result = await runWorkLoop(config, driver, abort.signal)
	assert.equal(result.reason, "cancelled")
	assert.equal(result.taskAttempts, 0)
}))

test("deadline aborts the active driver and prevents a retry", async () => fixture(async (config, driver) => {
	config.maxRuntimeMs = 20
	driver.runTask = async (_task, _attempt, context) => {
		await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }))
		return { observations: [], costUsd: 0 }
	}
	const result = await runWorkLoop(config, driver)
	assert.equal(result.reason, "runtime-limit")
	assert.equal(result.taskAttempts, 1)
}))

test("cancellation after verification prevents publication", async () => fixture(async (config, driver) => {
	const abort = new AbortController()
	driver.verifyTask = async (_task, candidate) => { abort.abort(); return { passed: true, commit: candidate.commit, evidenceRef: "host:checks" } }
	driver.acceptTask = async () => { assert.fail("published after cancellation") }
	assert.equal((await runWorkLoop(config, driver, abort.signal)).reason, "cancelled")
}))

test("runtime activation must match the independently verified harness commit", async () => fixture(async (config, driver) => {
	driver.runTask = async () => ({ observations: [observation], costUsd: 0 })
	driver.activateHarness = async () => ({ commit: base, runtimeId: "sha256:wrong" })
	const result = await runWorkLoop(config, driver)
	assert.equal(result.reason, "driver-error")
	assert.equal(result.harness.commit, base)
	assert.match(result.error!, /does not match/)
}))

test("invalid limits and duplicate tasks fail before executing any driver", async () => fixture(async (config, driver) => {
	config.maxRuntimeMs = Infinity
	await assert.rejects(runWorkLoop(config, driver), /maxRuntimeMs/)
	config.maxRuntimeMs = 1000
	config.tasks.push({ ...config.tasks[0]! })
	await assert.rejects(runWorkLoop(config, driver), /unique/)
}))

test("existing ledgers are preserved rather than reset for another scheduler", async () => fixture(async (config, driver) => {
	await writeFile(config.ledgerPath, "previous evidence\n")
	await assert.rejects(runWorkLoop(config, driver), { code: "EEXIST" })
	assert.equal(await readFile(config.ledgerPath, "utf8"), "previous evidence\n")
}))

test("event findings deduplicate errors, pair calls by session, and require independent confirmation", () => {
	const events = [
		{ ts: "2026-10-11T00:00:00Z", sessionId: "one", type: "tool_call", tool: "read_file", callId: "same" },
		{ ts: "2026-10-11T00:00:30Z", sessionId: "two", type: "tool_call", tool: "read_file", callId: "same" },
		{ ts: "2026-10-11T00:01:10Z", sessionId: "one", type: "tool_result", tool: "read_file", callId: "same", isError: false },
		{ ts: "2026-10-11T00:01:11Z", sessionId: "two", type: "tool_result", tool: "read_file", callId: "same", isError: false },
		{ ts: "2026-10-11T00:01:12Z", sessionId: "one", type: "tool_result", tool: "not_real", isError: true, result: "unknown tool: not_real" },
		{ ts: "2026-10-11T00:01:13Z", sessionId: "one", type: "tool_result", tool: "not_real", isError: true, result: "unknown tool: not_real" },
	]
	const findings = workObservationsFromEvents(events, "host:event-artifact")
	assert.deepEqual(findings.map((item) => item.kind), ["bottleneck", "missing-tool"])
	assert.match(findings[0]!.summary, /70000ms/)
})
