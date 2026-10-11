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

async function testStopBypassesStalledResourceRegistration(): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-test-"))
	let holdWrites = false
	let releaseRegistrationWrite!: () => void
	let registrationWriteStarted!: () => void
	const heldWrite = new Promise<void>((resolve) => { releaseRegistrationWrite = resolve })
	const writeStarted = new Promise<void>((resolve) => { registrationWriteStarted = resolve })
	const control = await EmergencyControl.start({
		identity: "stalled-resource", stateDirectory: root, socketDirectory, graceMs: 40,
		persistState: async (file, record) => {
			if (holdWrites) { registrationWriteStarted(); await heldWrite; return }
			await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
		},
	})
	let cleanupObservedAbort = false
	control.registerCleanup("model-request", async ({ signal }) => { cleanupObservedAbort = signal.aborted }, "worker:model-request")
	try {
		holdWrites = true
		const registration = control.registerResource("worker:model-request").catch((error: unknown) => error)
		await writeStarted
		const stopping = control.command("stop", "operator emergency stop", "operator:test")
		assert.equal(control.signal.aborted, true, "stop aborts at request receipt even while resource persistence is held")
		const started = Date.now()
		const result = await stopping
		assert.ok(Date.now() - started < 500, "stop cleanup and persistence failure remain bounded")
		assert.equal(cleanupObservedAbort, true, "registered model work sees cancellation immediately")
		assert.equal(result.accepted, false)
		assert.equal(result.record.state, "failed-to-stop", "the controller does not claim durable teardown when writes stall")
		assert.equal(result.record.cleanupResults.at(-1)?.name, "control-state-persistence")
		await registration
	} finally {
		releaseRegistrationWrite()
		await control.close()
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testLongUnixSocketPathFailsBeforeListen(): Promise<void> {
	if (process.platform === "win32") return
	const root = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-test-"))
	const tooLongSocketDirectory = path.join(root, "x".repeat(120))
	try {
		await assert.rejects(
			EmergencyControl.start({ identity: "long-socket", stateDirectory: root, socketDirectory: tooLongSocketDirectory }),
			/emergency-control Unix socket path.*shorter HEADLESSCODE_CONTROL_SOCKET_DIR/,
		)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testQueuedResumeCannotUndoLaterStop(): Promise<void> {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".headlesscode", "scratch", "control-test-"))
	const control = await EmergencyControl.start({ identity: "resume-fence", stateDirectory: root, socketDirectory, graceMs: 1_000 })
	let releasePauseCleanup!: () => void
	let pauseCleanupStarted!: () => void
	const cleanupGate = new Promise<void>((resolve) => { releasePauseCleanup = resolve })
	const cleanupStarted = new Promise<void>((resolve) => { pauseCleanupStarted = resolve })
	let calls = 0
	control.registerCleanup("slow-pause", async () => {
		calls += 1
		if (calls === 1) { pauseCleanupStarted(); await cleanupGate }
	})
	try {
		const pause = control.command("pause", "maintenance", "operator:test")
		await cleanupStarted
		const resume = control.command("resume", "resume queued during pause", "operator:test")
		const stop = control.command("stop", "emergency stop supersedes resume", "operator:test")
		assert.equal(control.signal.aborted, true, "stop aborts before waiting for the pause cleanup")
		releasePauseCleanup()
		const [paused, resumed, stopped] = await Promise.all([pause, resume, stop])
		assert.equal(paused.accepted, false, "superseded pause does not publish a stale paused result")
		assert.equal(resumed.accepted, false, "queued resume is fenced by the later stop request")
		assert.equal(stopped.record.state, "stopped")
		assert.equal(stopped.record.epoch, 3)
		assert.equal(control.signal.aborted, true)
	} finally {
		releasePauseCleanup()
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
await testStopBypassesStalledResourceRegistration()
await testLongUnixSocketPathFailsBeforeListen()
await testQueuedResumeCannotUndoLaterStop()
process.stdout.write("All 10 emergency-control tests passed\n")

await socketDirectoryHandle.close()
await fs.rm(actualSocketDirectory, { recursive: true, force: true })
