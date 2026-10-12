import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { TEMPLATE_TEXT } from "../controller.js"
import { extractMonitorFeatures, sha256 } from "../features.js"
import { fitFrozenPredictor, predictFromFeatures } from "../predictor.js"
import { PILOT_FIXTURES, fixtureHash, splitHash, validateFixtureSplits } from "../../../scripts/monitor-pilot/fixtures.js"
import { ExclusiveRunnerLock, JournalCorruptionError, PilotJournal, RunnerLockError } from "../../../scripts/monitor-pilot/journal.js"
import { RestrictedSimulator, runFixture } from "../../../scripts/monitor-pilot/simulator.js"

async function testFixtureSplitAndAuthorityBoundary() {
	validateFixtureSplits()
	assert.equal(new Set(PILOT_FIXTURES.map((fixture) => fixture.family)).size, 4)
	const fixture = PILOT_FIXTURES[0]
	const simulator = new RestrictedSimulator(fixture)
	const before = sha256(simulator.virtualFiles)
	for (const [name, args] of [
		["shell", { command: "echo hacked" }],
		["network_request", { url: "https://example.invalid" }],
		["new_task", { task: "delegate" }],
		["dynamic_import", { module: "node:fs" }],
		["evaluator", { command: "change oracle" }],
		["unknown", {}],
		["read_file", { path: "/etc/passwd" }],
		["read_file", { path: "../outside" }],
	] as const) {
		const result = simulator.execute({ name, args }, `forbidden-${name}`)
		assert.equal(result.result.isError, true)
		assert.equal(result.hostEffects, 0)
	}
	assert.equal(sha256(simulator.virtualFiles), before)
}

async function testPredictorDeterminismAndNegativeControl() {
	const rows = Array.from({ length: 24 }, (_, index) => ({
		trajectoryId: `trajectory-${index}`,
		label: index % 2 as 0 | 1,
		features: {
			identicalCallStreak: index % 4,
			sameToolErrorStreak: index % 3,
			readOnlyStreak: index % 5,
			uniqueCallFraction4: (index % 4) / 4,
			errorFraction4: (index % 3) / 3,
			turnsSinceSuccessfulVirtualWrite: index % 4,
			repeatedResultFraction4: (index % 2) / 2,
			iterationBudgetFraction: index / 24,
		},
	}))
	const artifactA = fitFrozenPredictor(rows, rows, { modelDigest: "pinned-test-digest", templatesHash: sha256(TEMPLATE_TEXT) })
	const artifactB = fitFrozenPredictor(rows, rows, { modelDigest: "pinned-test-digest", templatesHash: sha256(TEMPLATE_TEXT) })
	assert.deepEqual(artifactA, artifactB)
	const fixture = PILOT_FIXTURES.find((value) => value.family === "legitimate-investigation")!
	const outcome = runFixture({
		experimentId: "test",
		runId: "investigation",
		attemptId: "investigation-attempt",
		arm: "B",
		fixture,
		repetitionSeed: 101,
		predictor: artifactA,
	})
	assert.equal(outcome.success, true)
	assert.equal(outcome.forbiddenEffectAttempts, 0)
	const boundary = {
		schemaVersion: 1 as const,
		experimentId: "test",
		runId: "r",
		attemptId: "a",
		epoch: 1,
		sequence: 1,
		iteration: 2,
		maxIterations: 16,
		calls: [],
		results: [],
		recentTurns: [],
		virtualRevisionHashes: {},
		inputTokens: 0,
		outputTokens: 0,
		reasoningAvailable: false,
		truncationFlags: [],
		deterministicGuardrails: { consecutiveMistakes: 0, identicalCallStreak: 0, readOnlyStreak: 0, sameToolErrorStreak: 0, repeatedToolFailureStreak: 0 },
	}
	const features = extractMonitorFeatures(boundary)
	assert.equal(predictFromFeatures(artifactA, features).probability, predictFromFeatures(artifactB, features).probability)
	const unknownModel = predictFromFeatures({ ...artifactA, modelDigest: "" }, features)
	assert.equal(unknownModel.abstentionReason, "unknown-model")
	const scheduledButUnreached = runFixture({
		experimentId: "test",
		runId: "random-unreached",
		attemptId: "random-unreached-attempt",
		arm: "R",
		fixture,
		repetitionSeed: 101,
		predictor: artifactA,
		randomBoundarySequence: 99,
	})
	assert.equal(scheduledButUnreached.scheduledIntervention, true)
	assert.equal(scheduledButUnreached.correctionDelivered, false)
	assert.equal(scheduledButUnreached.interventions.at(-1)?.delivered, false)
}

async function scratchDirectory(prefix: string): Promise<string> {
	const scratch = path.resolve(".headlesscode/scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	return fs.mkdtemp(path.join(scratch, prefix))
}

async function withPatchedFileHandleMethod<T>(
	filePath: string,
	method: "writeFile" | "sync",
	replacement: (original: Function) => Function,
	work: () => Promise<T>,
): Promise<T> {
	const probe = await fs.open(filePath, "a")
	const prototype = Object.getPrototypeOf(probe) as object
	await probe.close()
	const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
	assert.ok(descriptor && typeof descriptor.value === "function", `FileHandle.${method} is patchable for the failure test`)
	Object.defineProperty(prototype, method, { ...descriptor, value: replacement(descriptor.value) })
	try {
		return await work()
	} finally {
		Object.defineProperty(prototype, method, descriptor)
	}
}

async function testJournalPersistedRepresentationAndFailureAtomicity() {
	const root = await scratchDirectory("hc-monitor-journal-json-")
	try {
		const journalPath = path.join(root, "journal.jsonl")
		const journal = new PilotJournal(journalPath)
		await journal.open()
		const response = {
			role: "assistant",
			content: null,
			refusal: undefined,
			tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}", optional: undefined } }],
		}
		const sparse: unknown[] = []
		sparse.length = 3
		sparse[1] = { optional: undefined, retained: true }
		await journal.append("llm_response_received", "experiment", {
			assistantMessage: response,
			optional: undefined,
			nested: { optional: undefined, retained: true },
			array: [undefined, sparse, { optional: undefined, retained: true }, null],
		})
		const persisted = JSON.parse(await fs.readFile(journalPath, "utf8")) as { payload: Record<string, unknown> }
		assert.deepEqual(persisted.payload, {
			assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }] },
			nested: { retained: true },
			array: [null, [null, { retained: true }, null], { retained: true }, null],
		})
		const reopened = new PilotJournal(journalPath)
		await reopened.open()
		assert.deepEqual(reopened.list(), [persisted])

		const corrupted = { ...persisted, payload: { ...persisted.payload, nested: { retained: false } } }
		await fs.writeFile(journalPath, `${JSON.stringify(corrupted)}\n`)
		await assert.rejects(() => new PilotJournal(journalPath).open(), JournalCorruptionError)

		const unsupportedPath = path.join(root, "unsupported.jsonl")
		const unsupported = new PilotJournal(unsupportedPath)
		await unsupported.open()
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		let accessorInvoked = false
		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => { accessorInvoked = true; return "unsupported" } })
		for (const value of [1n, () => undefined, Symbol("unsupported"), Number.POSITIVE_INFINITY, new Date(), cyclic, accessor]) {
			await assert.rejects(() => unsupported.append("invalid", "experiment", { value }), JournalCorruptionError)
		}
		assert.equal(accessorInvoked, false, "unsupported accessors are rejected without evaluating them")
		assert.equal(unsupported.list().length, 0)
		await assert.rejects(() => fs.stat(unsupportedPath), { code: "ENOENT" })
		const firstValid = await unsupported.append("valid", "experiment", { ok: true })
		assert.equal(firstValid.sequence, 1, "unsupported values do not advance journal sequence")

		const failureDirectory = path.join(root, "write-failure")
		await fs.mkdir(failureDirectory)
		const failurePath = path.join(failureDirectory, "journal.jsonl")
		const failedWrite = new PilotJournal(failurePath)
		await failedWrite.open()
		await fs.rm(failureDirectory, { recursive: true })
		await assert.rejects(() => failedWrite.append("unwritten", "experiment", { ok: true }))
		assert.equal(failedWrite.list().length, 0)
		await fs.mkdir(failureDirectory)
		const afterFailure = await failedWrite.append("written", "experiment", { ok: true })
		assert.equal(afterFailure.sequence, 1, "failed writes do not advance journal sequence")
		const verified = new PilotJournal(failurePath)
		await verified.open()
		assert.equal(verified.list().length, 1)

		const partialPath = path.join(root, "partial-write.jsonl")
		const partialJournal = new PilotJournal(partialPath)
		await partialJournal.open()
		await withPatchedFileHandleMethod(partialPath, "writeFile", (original) => async function(this: fs.FileHandle, data: string | Uint8Array) {
			const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8")
			await original.call(this, text.slice(0, Math.max(1, Math.floor(text.length / 2))))
			throw new Error("simulated failure after a partial append")
		}, async () => {
			await assert.rejects(() => partialJournal.append("uncertain", "experiment", { ok: true }), /partial append/)
		})
		assert.equal(partialJournal.list().length, 0, "a partial write does not advance in-memory journal state")
		const partialBytes = await fs.readFile(partialPath, "utf8")
		assert.ok(partialBytes.length > 0 && !partialBytes.endsWith("\n"), "the injected failure leaves a torn record on disk")
		await assert.rejects(() => partialJournal.append("duplicate", "experiment", { ok: true }), /outcome is uncertain/)
		assert.equal(await fs.readFile(partialPath, "utf8"), partialBytes, "a poisoned instance cannot append a duplicate sequence")
		await assert.rejects(() => new PilotJournal(partialPath).open(), JournalCorruptionError, "reopen verifies and rejects the torn persisted record")

		const syncPath = path.join(root, "sync-failure.jsonl")
		const syncJournal = new PilotJournal(syncPath)
		await syncJournal.open()
		await withPatchedFileHandleMethod(syncPath, "sync", () => async function() {
			throw new Error("simulated sync failure after write")
		}, async () => {
			await assert.rejects(() => syncJournal.append("written-not-synced", "experiment", { ok: true }), /sync failure/)
		})
		assert.equal(syncJournal.list().length, 0, "sync failure does not advance in-memory journal state")
		await assert.rejects(() => syncJournal.append("duplicate", "experiment", { ok: true }), /outcome is uncertain/)
		const syncReopened = new PilotJournal(syncPath)
		await syncReopened.open()
		assert.equal(syncReopened.list().length, 1, "a fresh instance verifies the complete record before resuming")
		const nextAfterReopen = await syncReopened.append("after-reopen", "experiment", { ok: true })
		assert.equal(nextAfterReopen.sequence, 2, "reopen resumes after the verified durable record")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testJournalIntegrityAndExclusiveLock() {
	const root = await scratchDirectory("hc-monitor-journal-")
	try {
		const journalPath = path.join(root, "journal.jsonl")
		const journal = new PilotJournal(journalPath)
		await journal.open()
		await journal.append("attempt_started", "experiment", { ok: true }, { runId: "run", attemptId: "attempt", epoch: 1 })
		await journal.append("outcome", "experiment", { success: true }, { runId: "run", attemptId: "attempt", epoch: 1 })
		await journal.append("attempt_started", "experiment", { retry: true }, { runId: "retryable", attemptId: "attempt-2", epoch: 2 })
		await assert.rejects(
			() => journal.append("outcome", "experiment", { stale: true }, { runId: "retryable", attemptId: "attempt-1", epoch: 1 }),
			JournalCorruptionError,
		)
		const reopened = new PilotJournal(journalPath)
		await reopened.open()
		assert.equal(reopened.list().length, 3)
		assert.equal(reopened.activeAttempts().length, 1)
		const aborted = await reopened.abortActiveAttempts("experiment")
		assert.equal(aborted.length, 1)
		assert.equal(reopened.activeAttempts().length, 0)
		await fs.appendFile(journalPath, "{\"torn\":true}\n")
		await assert.rejects(() => new PilotJournal(journalPath).open(), JournalCorruptionError)

		const lockPath = path.join(root, "runner.lock")
		const first = new ExclusiveRunnerLock(lockPath)
		const second = new ExclusiveRunnerLock(lockPath)
		await first.acquire()
		await assert.rejects(() => second.acquire(), RunnerLockError)
		await first.release()
		await second.acquire()
		await second.release()
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

await testFixtureSplitAndAuthorityBoundary()
await testPredictorDeterminismAndNegativeControl()
await testJournalPersistedRepresentationAndFailureAtomicity()
await testJournalIntegrityAndExclusiveLock()
assert.notEqual(fixtureHash(), splitHash())
console.log("monitoring pilot tests passed")
