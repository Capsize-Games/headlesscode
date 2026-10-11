import assert from "node:assert/strict"

import { analyzePilot } from "../../../scripts/monitor-pilot/analyze.js"
import { MONITOR_FEATURE_ORDER } from "../types.js"
import type { FrozenPredictorArtifact, PilotArm, PilotOutcome } from "../types.js"
import { PILOT_FIXTURES } from "../../../scripts/monitor-pilot/fixtures.js"

const predictor: FrozenPredictorArtifact = {
	schemaVersion: 1,
	featureOrder: MONITOR_FEATURE_ORDER,
	coefficients: { identicalCallStreak: 0, sameToolErrorStreak: 0, readOnlyStreak: 0, uniqueCallFraction4: 0, errorFraction4: 0, turnsSinceSuccessfulVirtualWrite: 0, repeatedResultFraction4: 0, iterationBudgetFraction: 0 },
	intercept: 0,
	standardization: { mean: { identicalCallStreak: 0, sameToolErrorStreak: 0, readOnlyStreak: 0, uniqueCallFraction4: 0, errorFraction4: 0, turnsSinceSuccessfulVirtualWrite: 0, repeatedResultFraction4: 0, iterationBudgetFraction: 0 }, scale: { identicalCallStreak: 1, sameToolErrorStreak: 1, readOnlyStreak: 1, uniqueCallFraction4: 1, errorFraction4: 1, turnsSinceSuccessfulVirtualWrite: 1, repeatedResultFraction4: 1, iterationBudgetFraction: 1 } },
	calibration: { intercept: 0, slope: 1 },
	threshold: 0.5,
	l2: 1,
	modelDigest: "synthetic",
	templatesHash: "synthetic",
	artifactHash: "synthetic",
}

function outcome(split: "train" | "calibration" | "test", arm: PilotArm, fixture: number, seed: number): PilotOutcome {
	const runId = split === "test" ? `test-fixture-${fixture}-${seed}-${arm}` : `development-${fixture}-${seed}`
	return {
		experimentId: "synthetic",
		runId,
		attemptId: `${runId}-attempt`,
		epoch: 1,
		fixtureId: `fixture-${fixture}`,
		split,
		arm,
		valid: true,
		success: split === "test" && arm !== "B",
		finalArtifactHash: "",
		oracleHash: "",
		verifierHash: "",
		milestoneCount: 0,
		redundantCalls: 0,
		invalidRetries: 0,
		forbiddenEffectAttempts: 0,
		experimentalInterventionAttempted: false,
		correctionDelivered: false,
		deterministicInterventionCount: 0,
		tokens: 100,
		calls: 1,
		elapsedMs: 10,
		stopReason: "synthetic",
		predictionRecords: arm === "B" ? [{ probability: split === "test" ? 0.1 : 0.99, threshold: 0.5, features: { identicalCallStreak: 0, sameToolErrorStreak: 0, readOnlyStreak: 0, uniqueCallFraction4: 0, errorFraction4: 0, turnsSinceSuccessfulVirtualWrite: 0, repeatedResultFraction4: 0, iterationBudgetFraction: 0 }, featureHash: "", predictorHash: "", latencyNs: 1_000_000 }] : [],
		interventions: [],
		scheduledIntervention: false,
		detectionLabels: [0],
	}
}

const development = Array.from({ length: 32 }, (_, index) => outcome(index < 24 ? "train" : "calibration", "B", index, 101 + (index % 2)))
const heldout = PILOT_FIXTURES.filter((fixture) => fixture.split === "test")
	.flatMap((fixture) => [101, 202].flatMap((seed) => (["B", "M", "R", "G"] as PilotArm[]).map((arm) => ({ ...outcome("test", arm, 0, seed), fixtureId: fixture.id, runId: `heldout-${fixture.id}-${seed}-${arm}` }))))
const analysis = analyzePilot([...development, ...heldout], predictor, 0.5, "synthetic analysis test")

assert.equal(analysis.totalScheduled, 96)
assert.equal(analysis.arms.B.scheduled, 16, "development B runs are not pooled into the held-out causal comparison")
assert.equal(analysis.arms.B.completed, 16)
assert.equal(analysis.arms.M.scheduled, 16)
assert.equal(analysis.arms.B.successRate, 0)
assert.equal(analysis.arms.M.successRate, 1)
assert.equal(analysis.detectionOnB.windows, 16, "detection uses untouched held-out B windows, not training/calibration B rows")
assert.equal(analysis.pairedBootstrap90LowerBoundMMinusB !== null, true, "arm identities pair by held-out fixture/repetition")
assert.equal(analysis.gates.completeSchedule, true)
const partial = analyzePilot([...development, { ...heldout[0], success: true, tokens: 100 }], predictor, 0.5, "partial test")
assert.equal(partial.successAtTokenCheckpoints.B["20000"], 1 / 16, "unscheduled held-out B runs count as unsuccessful at checkpoints")
assert.equal(partial.arms.B.scheduled, 16)
assert.equal(partial.arms.B.completed, 1)
assert.equal(partial.arms.B.successRate, 1 / 16, "aborted and unstarted assigned B slots stay in the intention-to-treat denominator")
assert.equal(partial.arms.M.scheduled, 16)
assert.equal(partial.arms.M.completed, 0)
assert.equal(partial.gates.completeSchedule, false)
assert.equal(partial.harmedPairRate, 1, "an assigned M run missing after a B success remains a harmed ITT pair")
assert.throws(() => analyzePilot([...development, heldout[0], heldout[0]], predictor, 0.5), /duplicates a frozen assignment/)
assert.throws(() => analyzePilot([{ ...heldout[0], fixtureId: "foreign" }], predictor, 0.5), /foreign/)

function detectionExample(scores: number[], labels: (0 | 1)[]) {
	const base = heldout[0]
	return analyzePilot([{ ...base, predictionRecords: scores.map((probability) => ({ ...base.predictionRecords[0], probability })), detectionLabels: labels }], predictor, 0.5).detectionOnB
}
assert.equal(detectionExample([0.9, 0.1], [1, 0]).aucpr, 1, "perfect ranking has unit precision-recall area")
assert.equal(detectionExample([0.9, 0.1], [0, 1]).aucpr, 0.5, "a positive ranked after one negative contributes precision one-half")
assert.equal(detectionExample([0.7, 0.7], [1, 0]).aucpr, 0.5, "tied scores form one threshold group")
assert.equal(detectionExample([0.1], [1]).precision, null, "zero alerts do not establish perfect precision")
assert.equal(detectionExample([0.9], [0]).aucpr, null, "a sample without positive labels cannot estimate AUCPR")
console.log("monitor pilot held-out analysis tests passed")
