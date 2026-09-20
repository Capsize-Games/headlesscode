import assert from "node:assert/strict"
import { computeFitness, hardGatesFor } from "../fitness.js"
import type { EvaluationSummary, TrialResult } from "../types.js"

function trial(ok: boolean): TrialResult {
	return { ok, command: "fixture", exitCode: ok ? 0 : 1, durationMs: 10, stdout: "", stderr: "" }
}

function summary(overrides: Partial<EvaluationSummary> = {}): EvaluationSummary {
	return {
		regression: trial(true),
		visible: [trial(true)],
		hidden: [trial(true)],
		completed: true,
		crashed: false,
		protectedPathViolation: false,
		changedFiles: ["src/engine/loop.ts"],
		...overrides,
	}
}

function testPassingCandidateGetsNonzeroScore(): void {
	const fitness = computeFitness(summary())
	assert.equal(fitness.score, 100)
	assert.equal(fitness.reason, "all hard gates passed")
}

function testHardGateFailureRejectsPartialScore(): void {
	const fitness = computeFitness(summary({ regression: trial(false), visible: [trial(true)] }))
	assert.equal(fitness.score, 0)
	assert.equal(fitness.hardGates.regressionPass, false)
	assert.match(fitness.reason, /regressionPass/)
}

function testProtectedPathIsHardGate(): void {
	const gates = hardGatesFor(summary({ protectedPathViolation: true }))
	assert.equal(gates.noProtectedPathViolation, false)
	assert.equal(computeFitness(summary({ protectedPathViolation: true })).score, 0)
}

const tests = [
	["passing candidate gets full score", testPassingCandidateGetsNonzeroScore],
	["regression failure overrides partial score", testHardGateFailureRejectsPartialScore],
	["protected paths are a hard gate", testProtectedPathIsHardGate],
] as const

for (const [name, test] of tests) {
	test()
	console.log(`  ok   ${name}`)
}
console.log(`All ${tests.length} RSI fitness tests passed`)
