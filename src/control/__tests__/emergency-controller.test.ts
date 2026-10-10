import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { EmergencyControl, requestEmergencyControl } from "../emergency-controller.js"

const actualSocketDirectory = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-sockets-"))
const socketDirectoryHandle = await fs.open(actualSocketDirectory, "r")
const socketDirectory = process.platform === "linux" && Buffer.byteLength(path.join(actualSocketDirectory, `${"x".repeat(20)}.sock`)) >= 108
	? `/proc/self/fd/${socketDirectoryHandle.fd}`
	: actualSocketDirectory

async function testPauseRequiresExplicitResumeAndAdvancesEpoch(): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-test-"))
	const control = await EmergencyControl.start({ identity: "pause-case", stateDirectory: root, socketDirectory })
	let cleanupCalls = 0
	const unregister = control.registerCleanup("worker", async () => { cleanupCalls += 1 })
	try {
		const paused = await requestEmergencyControl({ identity: "pause-case", stateDirectory: root, socketDirectory, action: "pause", reason: "operator pause" })
		assert.equal(paused.record.state, "paused")
		assert.equal(paused.record.epoch, 2)
		assert.equal(control.signal.aborted, true)
		assert.equal(cleanupCalls, 1)
		await new Promise((resolve) => setTimeout(resolve, 30))
		assert.equal(control.state, "paused", "security pause persists without an automatic resume")
		const resumed = await requestEmergencyControl({ identity: "pause-case", stateDirectory: root, socketDirectory, action: "resume" })
		assert.equal(resumed.record.state, "running")
		assert.equal(resumed.record.epoch, 3)
		assert.equal(control.signal.aborted, false, "resume creates a fresh abort signal")
		unregister()
	} finally {
		await control.close()
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testStopIsIdempotentAndFailedTeardownRetainsResource(): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-test-"))
	let control = await EmergencyControl.start({ identity: "stop-case", stateDirectory: root, socketDirectory })
	await control.registerResource("sandbox:fixture")
	let attempts = 0
	control.registerCleanup("delete-sandbox", async () => { attempts += 1; if (attempts === 1) throw new Error("sandbox still listed") }, "sandbox:fixture")
	try {
		const first = await control.command("stop", "test shutdown", "operator:test")
		const second = await control.command("stop", "duplicate", "operator:test")
		assert.equal(first.accepted, false)
		assert.equal(first.record.state, "failed-to-stop")
		assert.equal(first.record.resources[0], "sandbox:fixture")
		assert.equal(first.record.cleanupResults[0]?.detail, "sandbox still listed")
		assert.equal(second.record.epoch, first.record.epoch, "duplicate stop does not advance the fencing epoch")
		assert.equal(second.record.state, "stopped", "a later explicit stop retries failed cleanup")
		assert.equal(second.record.resources.length, 0)
		assert.equal(JSON.parse(await fs.readFile(path.join(root, "stop-case.json"), "utf8")).state, "stopped")
		await control.close()
		control = await EmergencyControl.start({ identity: "stop-case", stateDirectory: root, socketDirectory })
		assert.equal(control.state, "stopped")
		assert.equal(control.signal.aborted, true, "restart cannot turn a stopped controller back into active work")
	} finally {
		await control.close()
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testHungCleanupIsBoundedAndRestartOfStoppedControlIsAborted(): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-test-"))
	let control = await EmergencyControl.start({ identity: "hung-case", stateDirectory: root, socketDirectory, graceMs: 25 })
	control.registerCleanup("hung", async () => await new Promise<void>(() => undefined))
	const started = Date.now()
	const stopped = await control.command("stop", "hung cleanup", "operator:test")
	assert.ok(Date.now() - started < 500, "a stuck cleanup cannot hold the external control request indefinitely")
	assert.equal(stopped.record.state, "failed-to-stop")
	await control.close()
	control = await EmergencyControl.start({ identity: "hung-case", stateDirectory: root, socketDirectory })
	try {
		assert.equal(control.state, "failed-to-stop")
		assert.equal(control.signal.aborted, true)
	} finally {
		await control.close()
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testStalledEvidenceDoesNotDelayStopAndSecondControllerCannotUnlinkSocket(): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-test-"))
	const control = await EmergencyControl.start({ identity: "evidence-case", stateDirectory: root, socketDirectory, recordControlEvent: async () => await new Promise<void>(() => undefined) })
	try {
		await assert.rejects(EmergencyControl.start({ identity: "evidence-case", stateDirectory: root, socketDirectory }), /already active|EADDRINUSE/)
		let cleaned = false
		control.registerCleanup("fixture", async () => { cleaned = true })
		const started = Date.now()
		const stopped = await requestEmergencyControl({ identity: "evidence-case", stateDirectory: root, socketDirectory, action: "stop", reason: "recorder stalled", operatorId: "forged:caller" })
		assert.ok(Date.now() - started < 500, "stalled evidence cannot delay emergency cleanup")
		assert.equal(cleaned, true)
		assert.equal(stopped.record.evidenceStatus, "pending", "the durable controller state marks unacknowledged evidence as incomplete")
		assert.equal(stopped.record.operatorId, `uid:${typeof process.getuid === "function" ? process.getuid() : "unknown"}`, "the endpoint records its OS operator identity")
	} finally {
		await control.close()
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testRestartKeepsPausedStateAndClosedSocketRecovers(): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-test-"))
	let control = await EmergencyControl.start({ identity: "restart-case", stateDirectory: root, socketDirectory })
	await control.command("pause", "maintenance", "operator:test")
	await control.close()
	control = await EmergencyControl.start({ identity: "restart-case", stateDirectory: root, socketDirectory })
	try {
		assert.equal(control.state, "paused")
		assert.equal(control.signal.aborted, true)
		const resumed = await requestEmergencyControl({ identity: "restart-case", stateDirectory: root, socketDirectory, action: "resume" })
		assert.equal(resumed.record.state, "running")
	} finally {
		await control.close()
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testRestartWithPersistedResourcesRequiresRecovery(): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-test-"))
	let control = await EmergencyControl.start({ identity: "resource-recovery", stateDirectory: root, socketDirectory })
	await control.registerResource({ id: "worker-1", kind: "sandbox" })
	await control.close()
	control = await EmergencyControl.start({ identity: "resource-recovery", stateDirectory: root, socketDirectory })
	try {
		assert.equal(control.state, "failed-to-stop")
		assert.equal(control.signal.aborted, true)
		assert.deepEqual(control.snapshot.resources, ["sandbox:worker-1"])
		let removed = false
		control.registerCleanup("recover-sandbox", async () => { removed = true }, { id: "worker-1", kind: "sandbox" })
		const recovered = await control.command("stop", "restart recovery")
		assert.equal(removed, true)
		assert.equal(recovered.record.state, "stopped")
		assert.deepEqual(recovered.record.resources, [])
	} finally {
		await control.close()
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testPersistenceFailureDoesNotPreventEmergencyAbortOrCleanup(): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-test-"))
	let failWrites = false
	const control = await EmergencyControl.start({
		identity: "write-failure", stateDirectory: root, socketDirectory,
		persistState: async (file, record) => {
			if (failWrites) throw new Error("control state disk is unavailable")
			await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
		},
	})
	let cleaned = false
	control.registerCleanup("abort-fixture", async () => { cleaned = true })
	failWrites = true
	try {
		const result = await control.command("stop", "disk failure during emergency stop")
		assert.equal(control.signal.aborted, true, "abort is signaled before a state-write failure can delay cleanup")
		assert.equal(cleaned, true)
		assert.equal(result.accepted, false, "the controller does not claim a durable stop when state persistence failed")
		assert.equal(result.record.state, "failed-to-stop")
		assert.equal(result.record.cleanupResults.at(-1)?.name, "control-state-persistence")
		assert.match(result.record.cleanupResults.at(-1)?.detail ?? "", /state disk is unavailable/)
	} finally {
		await control.close()
		await fs.rm(root, { recursive: true, force: true })
	}
}

await testPauseRequiresExplicitResumeAndAdvancesEpoch()
await testStopIsIdempotentAndFailedTeardownRetainsResource()
await testRestartKeepsPausedStateAndClosedSocketRecovers()
await testHungCleanupIsBoundedAndRestartOfStoppedControlIsAborted()
await testStalledEvidenceDoesNotDelayStopAndSecondControllerCannotUnlinkSocket()
await testRestartWithPersistedResourcesRequiresRecovery()
await testPersistenceFailureDoesNotPreventEmergencyAbortOrCleanup()
process.stdout.write("All 7 emergency-control tests passed\n")

await socketDirectoryHandle.close()
await fs.rm(actualSocketDirectory, { recursive: true, force: true })
