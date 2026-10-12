import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import fsPromises from "node:fs/promises"
import test from "node:test"
import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { rsiOperationsCliMain } from "../monitor-cli.js"
import { guardRsiMonitorPoolIdleErrors, readRsiOperationsStatus, runRsiMonitor, type RsiMonitorPool, type RsiMonitorOptions } from "../operations-monitor.js"

const tables = [
	"headlesscode_rsi_queue_policy", "headlesscode_rsi_workers", "headlesscode_rsi_jobs",
	"headlesscode_rsi_proof_campaigns", "headlesscode_rsi_proof_campaign_arms", "headlesscode_rsi_proof_campaign_attempts",
	"headlesscode_rsi_inference_campaigns", "headlesscode_rsi_inference_jobs", "headlesscode_rsi_inference_calls",
]
const campaign = {
	campaign_id: "campaign-test", state: "running", sequence: "4", deadline_at: new Date(Date.now() + 60_000),
	deadline_expired: false, max_spend_microusd: "1000000", reserved_spend_microusd: "100", used_spend_microusd: "50",
}

function fixturePool(options: { malformedWorker?: boolean; throwOnQuery?: boolean; queueRows?: Array<Record<string, unknown>>; invalidReceipt?: boolean; finishedPastDeadline?: boolean; idleActiveCampaign?: boolean; armEpoch?: string; armState?: string; armPhase?: string; attemptRows?: Array<Record<string, unknown>>; delayMs?: number } = {}) {
	const statements: Array<{ sql: string; values?: unknown[] }> = []
	let released = 0
	const client = {
		async query(sql: string, values?: unknown[]) {
			statements.push({ sql, values })
			if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
			if (options.throwOnQuery) throw new Error("synthetic database unavailable")
			const rows: Array<Record<string, unknown>> =
				sql.startsWith("SELECT table_name") ? tables.map((table_name) => ({ table_name }))
				: sql.startsWith("SELECT max_in_flight") ? [{ max_in_flight: 2, lease_ms: 5000, max_attempts: 3 }]
				: sql.includes("FROM headlesscode_rsi_workers") && sql.includes("count(*)") ? [{ count: "1" }]
				: sql.includes("FROM headlesscode_rsi_workers") ? [{ worker_id: "worker-a", active: true, resource_classes: options.malformedWorker ? ["ALIEN"] : ["CPU"], registered_at: new Date(), heartbeat_at: new Date(), heartbeat_age_ms: "2", heartbeat_fresh: true }]
				: sql.includes("FROM headlesscode_rsi_jobs") && sql.includes("GROUP BY status") ? options.queueRows ?? (options.idleActiveCampaign ? [] : [{ status: "queued", count: "1", expired_leases: "0", pending_teardown: "0", attempts_total: "0" }])
				: sql.includes("FROM headlesscode_rsi_jobs") ? []
				: sql.includes("FROM headlesscode_rsi_proof_campaigns") ? [{ ...campaign, state: options.finishedPastDeadline ? "finished" : campaign.state, deadline_expired: options.finishedPastDeadline ?? false, deadline_at: options.finishedPastDeadline ? new Date(Date.now() - 60_000) : campaign.deadline_at, reserved_spend_microusd: options.finishedPastDeadline || options.idleActiveCampaign ? "0" : campaign.reserved_spend_microusd, used_spend_microusd: options.finishedPastDeadline ? "100" : options.idleActiveCampaign ? "50" : campaign.used_spend_microusd }]
				: sql.includes("FROM headlesscode_rsi_proof_campaign_arms") ? ["arm-a", "arm-b"].map((arm_id) => ({ arm_id, epoch: options.armEpoch ?? "1", state: options.finishedPastDeadline ? "finished" : options.armState ?? "running", phase: options.armPhase ?? "development", coordinator_id: null, lease_expires_at: new Date(Date.now() + 30_000), lease_fresh: true }))
				: sql.includes("FROM headlesscode_rsi_proof_campaign_attempts") ? options.finishedPastDeadline || options.idleActiveCampaign ? [] : options.attemptRows ?? [{ status: "dispatched", count: "1" }]
				: sql.includes("FROM headlesscode_rsi_inference_campaigns AS campaigns") ? [options.invalidReceipt
					? { campaign_id: "campaign-test:mutation", state: "complete", count: "1", reserved_count: "0", unmeasured_count: "0", invalid_receipts: "1", reserved_microusd: "100" }
					: options.idleActiveCampaign ? { campaign_id: "campaign-test:mutation", state: "complete", count: "0", reserved_count: "0", unmeasured_count: "0", invalid_receipts: "0", reserved_microusd: "0" }
					: options.finishedPastDeadline ? { campaign_id: "campaign-test:mutation", state: "complete", count: "1", reserved_count: "0", unmeasured_count: "0", invalid_receipts: "0", reserved_microusd: "0" }
					: { campaign_id: "campaign-test:mutation", state: "reserved", count: "1", reserved_count: "1", unmeasured_count: "0", invalid_receipts: "0", reserved_microusd: "10" }]
				: sql.includes("FROM headlesscode_rsi_inference_campaigns") ? ["mutation", "benchmark"].map((role) => ({ campaign_id: `campaign-test:${role}`, max_spend_microusd: "500000", reserved_spend_microusd: options.finishedPastDeadline || options.idleActiveCampaign ? "0" : "10", spent_microusd: "20", blocked: false }))
				: []
			return { rows, rowCount: rows.length }
		},
		release() { released++ },
	}
	const pool: RsiMonitorPool = { async connect() { return client }, async end() {} }
	return { pool, statements, get released() { return released } }
}

const statusOptions = { queueName: "rsi-default", campaignId: "campaign-test", queryTimeoutMs: 1000 }

test("status reads bounded operational metadata in one read-only snapshot without selecting secret-bearing columns", async () => {
	const fixture = fixturePool()
	const result = await readRsiOperationsStatus(fixture.pool, statusOptions)
	assert.equal(result.health, "degraded")
	assert.equal(result.queue.jobCounts.queued, 1)
	assert.equal(result.queue.freshWorkers, 1)
	assert.equal(result.campaign.rootBudgetMicrousd.reserved, 100)
	assert.equal(result.campaign.inferenceUnmeasuredCalls, 0)
	assert.match(fixture.statements[0].sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/)
	assert.equal(fixture.statements.at(-1)?.sql, "COMMIT")
	assert.equal(fixture.released, 1)
	assert.ok(fixture.statements.every(({ sql }) => !/\b(payload|manifest|prompt|capability_sha256|artifact_refs|proof)\b/i.test(sql)), "monitor SQL must not read payload or proof contents")
	assert.ok(fixture.statements.some(({ sql, values }) => sql.includes("heartbeat_at > clock_timestamp()") && values?.[1] === 10_000), "freshness uses twice the persisted lease interval")
	const baseFingerprint = await readRsiOperationsStatus(fixturePool({ idleActiveCampaign: true }).pool, statusOptions)
	const changedEpoch = await readRsiOperationsStatus(fixturePool({ idleActiveCampaign: true, armEpoch: "2" }).pool, statusOptions)
	const changedPhase = await readRsiOperationsStatus(fixturePool({ idleActiveCampaign: true, armPhase: "confirmation" }).pool, statusOptions)
	const changedArmState = await readRsiOperationsStatus(fixturePool({ idleActiveCampaign: true, armState: "planned" }).pool, statusOptions)
	assert.notEqual(baseFingerprint.progressFingerprint, changedEpoch.progressFingerprint, "arm epoch changes count as progress")
	assert.notEqual(baseFingerprint.progressFingerprint, changedPhase.progressFingerprint, "arm phase changes count as progress")
	assert.notEqual(baseFingerprint.progressFingerprint, changedArmState.progressFingerprint, "arm state changes count as progress")
})

test("monitor stalls active work between admissions but leaves settled terminal campaigns unstalled", async () => {
	async function sample(pool: RsiMonitorPool) {
		const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rsi-monitor-stall-"))
		await fs.chmod(stateDirectory, 0o700)
		const status = await readRsiOperationsStatus(pool, statusOptions)
		await fs.writeFile(path.join(stateDirectory, "state.json"), `${JSON.stringify({
			schemaVersion: 1, queueName: statusOptions.queueName, campaignId: statusOptions.campaignId,
			lastProgressFingerprint: status.progressFingerprint,
			lastProgressAt: new Date(Date.now() - 5000).toISOString(), history: [],
		})}\n`, { mode: 0o600 })
		const controller = new AbortController()
		let report: Record<string, unknown> | undefined
		const result = await runRsiMonitor({
			...statusOptions, pool, stateDirectory, pollMs: 1000, stallMs: 2000, maxRuntimeMs: 10_000,
			signal: controller.signal,
			stdout(line) { report = JSON.parse(line) as Record<string, unknown>; controller.abort() },
		})
		assert.equal(result, 0)
		assert.ok(report)
		await fs.rm(stateDirectory, { recursive: true, force: true })
		return report as Record<string, unknown>
	}

	const activePool = fixturePool({ idleActiveCampaign: true })
	const active = await sample(activePool.pool)
	assert.equal(active.progressStalled, true, "planned/running campaign arms make an idle admission gap eligible for stall detection")
	const activeCampaign = active.campaign as Record<string, unknown>
	assert.equal(activeCampaign.state, "running")
	assert.equal(active.progressUnderlyingCondition, "campaign-active-no-pending-accounting")
	const terminal = await sample(fixturePool({ finishedPastDeadline: true }).pool)
	assert.equal(terminal.progressStalled, false, "a finished terminal campaign does not stall after it goes idle")
	assert.equal((terminal.campaign as Record<string, unknown>).state, "finished")

	const uncertain = await sample(fixturePool({
		queueRows: [{ status: "leased", count: "1", expired_leases: "1", pending_teardown: "0", attempts_total: "1" }],
		attemptRows: [{ status: "uncertain", count: "1" }],
	}).pool)
	assert.equal(uncertain.progressStalled, true)
	assert.equal(uncertain.progressUnderlyingCondition, "expired-job-leases")
	const uncertainQueue = uncertain.queue as Record<string, unknown>
	const uncertainCampaign = uncertain.campaign as Record<string, unknown>
	assert.equal(uncertainQueue.expiredLeases, 1, "stall reporting preserves the expired-lease count")
	assert.equal(uncertainCampaign.unsettledAttempts, 1, "stall reporting preserves uncertain campaign attempts")
})

test("database outage and malformed operational rows produce unknown, never healthy", async () => {
	const outage = fixturePool({ throwOnQuery: true })
	assert.equal((await readRsiOperationsStatus(outage.pool, statusOptions)).health, "unknown")
	const malformed = fixturePool({ malformedWorker: true })
	assert.equal((await readRsiOperationsStatus(malformed.pool, statusOptions)).health, "unknown")
	const unsafe = fixturePool({ queueRows: [{ status: "queued", count: "9007199254740992", expired_leases: "0", pending_teardown: "0", attempts_total: "0" }] })
	assert.equal((await readRsiOperationsStatus(unsafe.pool, statusOptions)).health, "unknown")
	const unknownJobStatus = fixturePool({ queueRows: [{ status: "mystery", count: "1", expired_leases: "0", pending_teardown: "0", attempts_total: "0" }] })
	assert.equal((await readRsiOperationsStatus(unknownJobStatus.pool, statusOptions)).health, "unknown", "unrecognized persisted job states must fail closed")
	const invalidReceipt = fixturePool({ invalidReceipt: true })
	const receiptStatus = await readRsiOperationsStatus(invalidReceipt.pool, statusOptions)
	assert.equal(receiptStatus.health, "unhealthy")
	assert.equal(receiptStatus.condition, "inference-receipt-invalid")
	assert.equal(receiptStatus.campaign.inferenceInvalidReceipts, 1)
	assert.equal(receiptStatus.campaign.accountingComplete, false)
	const completedAfterDeadline = await readRsiOperationsStatus(fixturePool({ finishedPastDeadline: true }).pool, statusOptions)
	assert.equal(completedAfterDeadline.health, "healthy", "a finished campaign read after its deadline is not an active deadline failure")
	assert.equal(completedAfterDeadline.condition, "campaign-terminal-accounting-settled")
	const slow = fixturePool({ delayMs: 30 })
	assert.equal((await readRsiOperationsStatus(slow.pool, { ...statusOptions, queryTimeoutMs: 250 })).health, "unknown", "total status-read budget is bounded")
})

test("idle pool socket errors are handled and a later bounded status read can reconnect", async () => {
	const emitter = new EventEmitter()
	guardRsiMonitorPoolIdleErrors(emitter as unknown as Parameters<typeof guardRsiMonitorPoolIdleErrors>[0])
	assert.doesNotThrow(() => emitter.emit("error", new Error("synthetic idle socket failure")))
	const recovered = fixturePool()
	let connects = 0
	const pool: RsiMonitorPool = {
		async connect() {
			connects++
			if (connects === 1) throw new Error("synthetic connection outage")
			return await recovered.pool.connect()
		},
		async end() {},
	}
	assert.equal((await readRsiOperationsStatus(pool, statusOptions)).health, "unknown")
	assert.equal((await readRsiOperationsStatus(pool, statusOptions)).health, "degraded")
	assert.equal(connects, 2)
})

test("status CLI reports missing database configuration as structured unknown and exit 2", async () => {
	const previous = process.env.HEADLESSCODE_RSI_DATABASE_URL
	delete process.env.HEADLESSCODE_RSI_DATABASE_URL
	const output: string[] = []
	try {
		const exitCode = await rsiOperationsCliMain(["--campaign", "campaign-test"], "status", { stdout: { write: (text) => output.push(text) }, stderr: { write: (text) => output.push(text) } })
		assert.equal(exitCode, 2)
		assert.deepEqual(output, ['{"health":"unknown","condition":"database-or-records-unavailable"}\n'])
	} finally {
		if (previous === undefined) delete process.env.HEADLESSCODE_RSI_DATABASE_URL
		else process.env.HEADLESSCODE_RSI_DATABASE_URL = previous
	}
})

test("monitor writes an atomic heartbeat and refuses a concurrent process lock", async () => {
	const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rsi-monitor-"))
	await fs.chmod(stateDirectory, 0o700)
	const fixture = fixturePool()
	const controller = new AbortController()
	const options: RsiMonitorOptions = {
		...statusOptions, pool: fixture.pool, stateDirectory, pollMs: 1000, stallMs: 2000, maxRuntimeMs: 10_000,
		signal: controller.signal,
		async stdout(line) {
			const report = JSON.parse(line) as Record<string, unknown>
			assert.equal(report.health, "degraded")
			assert.equal("jobs" in report, false, "stdout is a compact change report, not a workers/jobs dump")
			const competing = await runRsiMonitor({ ...options, signal: undefined }).then(() => "unexpected success", (error: Error) => error.message)
			assert.match(competing, /process already holds the lock/)
			controller.abort()
		},
	}
	const exitCode = await runRsiMonitor(options)
	assert.equal(exitCode, 0)
	const heartbeat = JSON.parse(await fs.readFile(path.join(stateDirectory, "heartbeat.json"), "utf8")) as { health: string; campaignId: string; queueName: string; pid: number; startTicks: string; bootId: string }
	assert.equal(heartbeat.health, "degraded")
	assert.equal(heartbeat.campaignId, "campaign-test")
	assert.equal(heartbeat.queueName, "rsi-default")
	assert.ok(Number.isSafeInteger(heartbeat.pid) && /^\d+$/.test(heartbeat.startTicks) && /^[a-f0-9-]{16,64}$/i.test(heartbeat.bootId))
	assert.equal(await fs.stat(path.join(stateDirectory, "status.json")).then((info) => info.mode & 0o777), 0o600)
	await assert.rejects(runRsiMonitor({ ...options, campaignId: "different-campaign", signal: undefined }), /state is malformed/)
	await fs.rm(stateDirectory, { recursive: true, force: true })
})

test("monitor lock files project only process identity and scope fields", async () => {
	const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rsi-monitor-lock-projection-"))
	await fs.chmod(stateDirectory, 0o700)
	const fixture = fixturePool()
	const sentinel = "postgres://monitor-lock-secret:sentinel-password@127.0.0.1/private?token=sentinel-token"
	Object.assign(fixture.pool, { connectionString: sentinel, privatePoolOption: "must-not-serialize" })
	const injectedOptions = Object.assign({
		...statusOptions, pool: fixture.pool, stateDirectory, pollMs: 1000, stallMs: 2000, maxRuntimeMs: 10_000,
	}, { connectionString: sentinel, additionalRuntimeOption: "must-not-serialize" }) as RsiMonitorOptions
	const originalOpen = fsPromises.open
	const captured: Record<string, string> = {}
	const patchedOpen: typeof fsPromises.open = async (...args) => {
		const handle = await originalOpen(...args)
		const filename = String(args[0])
		if (!filename.endsWith("/monitor.lock") && !filename.endsWith("/monitor.lock.bootstrap")) return handle
		return new Proxy(handle, {
			get(target, property) {
				if (property === "writeFile") return async (...writeArgs: Parameters<typeof handle.writeFile>) => {
					await Reflect.apply(handle.writeFile.bind(handle), handle, writeArgs)
					captured[path.basename(filename)] = await fs.readFile(filename, "utf8")
					return undefined
				}
				const value = Reflect.get(target, property, target)
				return typeof value === "function" ? value.bind(target) : value
			},
		})
	}
	const controller = new AbortController()
	try {
		fsPromises.open = patchedOpen
		syncBuiltinESMExports()
		const exitCode = await runRsiMonitor({ ...injectedOptions, signal: controller.signal, stdout: () => controller.abort() })
		assert.equal(exitCode, 0)
		const persistent = JSON.parse(captured["monitor.lock"] ?? "null") as Record<string, unknown> | null
		const bootstrap = JSON.parse(captured["monitor.lock.bootstrap"] ?? "null") as Record<string, unknown> | null
		assert.ok(persistent, "read the persistent lock bytes after the file write")
		assert.ok(bootstrap, "capture the bootstrap lock bytes during its write")
		const allowedPersistent = ["schemaVersion", "pid", "startTicks", "bootId", "queueName", "campaignId", "startedAt"]
		const allowedBootstrap = ["schemaVersion", "pid", "startTicks", "bootId", "queueName", "campaignId", "nonce"]
		assert.deepEqual(Object.keys(persistent).sort(), allowedPersistent.sort())
		assert.deepEqual(Object.keys(bootstrap).sort(), allowedBootstrap.sort())
		assert.equal(persistent.queueName, statusOptions.queueName)
		assert.equal(persistent.campaignId, statusOptions.campaignId)
		assert.equal(bootstrap.queueName, statusOptions.queueName)
		assert.equal(bootstrap.campaignId, statusOptions.campaignId)
		assert.ok(!captured["monitor.lock"].includes(sentinel))
		assert.ok(!captured["monitor.lock.bootstrap"].includes(sentinel))
		assert.ok(!captured["monitor.lock"].includes("must-not-serialize"))
		assert.ok(!captured["monitor.lock.bootstrap"].includes("must-not-serialize"))
	} finally {
		fsPromises.open = originalOpen
		syncBuiltinESMExports()
		await fs.rm(stateDirectory, { recursive: true, force: true })
	}
})

test("monitor rejects a pre-existing lock and malformed history instead of taking ownership", async () => {
	const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rsi-monitor-lock-"))
	await fs.chmod(stateDirectory, 0o700)
	await fs.writeFile(path.join(stateDirectory, "monitor.lock"), "owned-by-another-process\n", { mode: 0o600 })
	await assert.rejects(runRsiMonitor({ ...statusOptions, pool: fixturePool().pool, stateDirectory, pollMs: 1000, stallMs: 2000, maxRuntimeMs: 10_000 }), /lock is malformed/)
	await fs.rm(path.join(stateDirectory, "monitor.lock"))
	await fs.writeFile(path.join(stateDirectory, "state.json"), "{}\n", { mode: 0o600 })
	await assert.rejects(runRsiMonitor({ ...statusOptions, pool: fixturePool().pool, stateDirectory, pollMs: 1000, stallMs: 2000, maxRuntimeMs: 10_000 }), /state is malformed/)
	assert.equal(await fs.stat(path.join(stateDirectory, "monitor.lock")).then(() => true).catch(() => false), false, "startup failure releases the lock")
	await fs.rm(stateDirectory, { recursive: true, force: true })
})

test("monitor reclaims only a lock whose recorded process is absent on this boot", async () => {
	const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rsi-monitor-stale-"))
	await fs.chmod(stateDirectory, 0o700)
	const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
	await fs.writeFile(path.join(stateDirectory, "monitor.lock"), `${JSON.stringify({ schemaVersion: 1, pid: 2_000_000_000, startTicks: "1", bootId, queueName: statusOptions.queueName, campaignId: statusOptions.campaignId, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 })
	const controller = new AbortController()
	const result = await runRsiMonitor({ ...statusOptions, pool: fixturePool().pool, stateDirectory, pollMs: 1000, stallMs: 2000, maxRuntimeMs: 10_000, signal: controller.signal, stdout: () => controller.abort() })
	assert.equal(result, 0)
	assert.equal(await fs.stat(path.join(stateDirectory, "monitor.lock")).then(() => true).catch(() => false), false)
	await fs.rm(stateDirectory, { recursive: true, force: true })
})

test("concurrent monitor starts serialize stale-lock recovery without removing the live winner", async () => {
	const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rsi-monitor-burst-"))
	await fs.chmod(stateDirectory, 0o700)
	const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
	await fs.writeFile(path.join(stateDirectory, "monitor.lock"), `${JSON.stringify({ schemaVersion: 1, pid: 2_000_000_000, startTicks: "1", bootId, queueName: statusOptions.queueName, campaignId: statusOptions.campaignId, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 })
	let signalEntered: () => void = () => {}
	let releaseWinner: () => void = () => {}
	const entered = new Promise<void>((resolve) => { signalEntered = resolve })
	const held = new Promise<void>((resolve) => { releaseWinner = resolve })
	let outputs = 0
	const makeOptions = (signal: AbortSignal, abort: () => void): RsiMonitorOptions => ({
		...statusOptions, pool: fixturePool().pool, stateDirectory, pollMs: 1000, stallMs: 2000, maxRuntimeMs: 10_000, signal,
		async stdout() { outputs++; signalEntered(); await held; abort() },
	})
	const firstAbort = new AbortController()
	const secondAbort = new AbortController()
	const first = runRsiMonitor(makeOptions(firstAbort.signal, () => firstAbort.abort())).then((code) => ({ code }), (error: Error) => ({ error: error.message }))
	const second = runRsiMonitor(makeOptions(secondAbort.signal, () => secondAbort.abort())).then((code) => ({ code }), (error: Error) => ({ error: error.message }))
	await entered
	const loser = await Promise.race([first, second])
	assert.ok("error" in loser, "exactly one starter must fail while the other owns the state directory")
	const liveLock = await fs.readFile(path.join(stateDirectory, "monitor.lock"), "utf8")
	const thirdAbort = new AbortController()
	await assert.rejects(runRsiMonitor(makeOptions(thirdAbort.signal, () => thirdAbort.abort())), /already holds the lock/)
	assert.equal(await fs.readFile(path.join(stateDirectory, "monitor.lock"), "utf8"), liveLock, "a rejected starter must not replace or remove the live owner's lock")
	assert.equal(outputs, 1)
	releaseWinner()
	const results = await Promise.all([first, second])
	assert.equal(results.filter((result) => "code" in result && result.code === 0).length, 1)
	assert.equal(await fs.stat(path.join(stateDirectory, "monitor.lock")).then(() => true).catch(() => false), false)
	await fs.rm(stateDirectory, { recursive: true, force: true })
})

test("separate monitor processes recover a SIGKILLed owner and admit one burst starter", async () => {
	const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-rsi-monitor-process-burst-"))
	await fs.chmod(stateDirectory, 0o700)
	const childScript = path.join(process.cwd(), "src", "rsi", "__tests__", "monitor-lock-child.ts")
	const children: ChildProcess[] = []
	const launch = () => {
		const child = spawn(process.execPath, ["--import", "tsx", childScript, stateDirectory], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] })
		children.push(child)
		return child
	}
	const waitForExit = async (child: ChildProcess, timeoutMs = 5_000) => {
		if (child.exitCode !== null) return child.exitCode
		return await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("monitor child did not exit before the bound")), timeoutMs)
			child.once("exit", (code) => { clearTimeout(timer); resolve(code ?? -1) })
			child.once("error", (error) => { clearTimeout(timer); reject(error) })
		})
	}
	const waitForHeartbeat = async (expectedPids?: Array<number | undefined>) => {
		for (let attempt = 0; attempt < 150; attempt++) {
			try {
				const heartbeat = JSON.parse(await fs.readFile(path.join(stateDirectory, "heartbeat.json"), "utf8")) as { pid: number; queueName: string; campaignId: string }
				if (!expectedPids || expectedPids.includes(heartbeat.pid)) return heartbeat
			}
			catch { await new Promise((resolve) => setTimeout(resolve, 20)) }
			await new Promise((resolve) => setTimeout(resolve, 20))
		}
		throw new Error("monitor child did not publish its heartbeat before the bound")
	}
	try {
		const original = launch()
		const originalHeartbeat = await waitForHeartbeat()
		assert.equal(originalHeartbeat.pid, original.pid)
		assert.equal(originalHeartbeat.queueName, "rsi-default")
		assert.equal(originalHeartbeat.campaignId, "campaign-test")
		original.kill("SIGKILL")
		await waitForExit(original)
		assert.equal(original.signalCode, "SIGKILL")

		const contenders = [launch(), launch()]
		const contenderHeartbeat = await waitForHeartbeat(contenders.map((child) => child.pid))
		await new Promise((resolve) => setTimeout(resolve, 150))
		const active = contenders.filter((child) => child.exitCode === null)
		assert.equal(active.length, 1, "a simultaneous post-crash burst must have exactly one live monitor")
		assert.equal(contenderHeartbeat.pid, active[0]?.pid)
		const lock = JSON.parse(await fs.readFile(path.join(stateDirectory, "monitor.lock"), "utf8")) as { pid: number; queueName: string; campaignId: string; startTicks: string; bootId: string }
		assert.equal(lock.pid, active[0]?.pid)
		assert.equal(lock.queueName, "rsi-default")
		assert.equal(lock.campaignId, "campaign-test")
		assert.ok(/^\d+$/.test(lock.startTicks) && /^[a-f0-9-]{16,64}$/i.test(lock.bootId))
		const loser = contenders.find((child) => child.exitCode !== null)
		assert.ok(loser, "losing starter exits after observing the live winner")
		assert.notEqual(await waitForExit(loser), 0)
		active[0]?.kill("SIGKILL")
		await waitForExit(active[0] as ChildProcess)
		assert.equal(active[0]?.signalCode, "SIGKILL")
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill("SIGKILL")
		await Promise.all(children.map((child) => waitForExit(child).catch(() => -1)))
		await fs.rm(stateDirectory, { recursive: true, force: true })
	}
})
