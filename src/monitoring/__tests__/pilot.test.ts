import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
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

async function testJournalIntegrityAndExclusiveLock() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-monitor-journal-"))
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
await testJournalIntegrityAndExclusiveLock()
assert.notEqual(fixtureHash(), splitHash())
console.log("monitoring pilot tests passed")
