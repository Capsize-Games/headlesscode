import assert from "node:assert/strict"
import { candidateProofDecision, compareDevelopmentAttempts, developmentCells, freezeDevelopmentProofProtocol } from "../development-proof.js"
import type { BenchmarkAttempt, BenchmarkManifest, BenchmarkTask } from "../benchmark/types.js"

const startDigest = "a".repeat(64)
const verifierDigest = "b".repeat(64)
const manifestDigest = "c".repeat(64)
const childCommit = "1".repeat(40)
const parentCommit = "2".repeat(40)
const rootCommit = "3".repeat(40)
const model = { provider: "openshell-ollama", id: "test-model", sampling: { temperature: 0, think: false, seed: "fixed" } }

function task(id: string): BenchmarkTask {
	return {
		id, family: id, split: "development", task: `Implement ${id}`, startCommit: rootCommit,
		startDigest, verifierPath: `verifiers/${id}.mjs`, verifierDigest, knownGoodCommit: parentCommit,
		knownGoodDigest: "d".repeat(64), knownBadCommit: rootCommit, knownBadDigest: "e".repeat(64), seed: 7,
		ceilings: { timeoutMs: 10_000, maxCalls: 3, maxOutputTokensPerCall: 64, maxPatchBytes: 20_000 },
	}
}

const tasks = [task("b-general"), task("a-retain")]
const manifest: BenchmarkManifest = { schemaVersion: 1, runnerVersion: "1.0.0", createdFromCommit: rootCommit, tasks }
const protocol = freezeDevelopmentProofProtocol(manifest, manifestDigest, model, {
	minimumNetWins: 1, retentionTaskIds: ["a-retain"], maximumMeanTokenIncreaseRatio: 1.1,
})

function attempts(harnessCommit: string, successes: Record<string, boolean>, tokens = 100, proofQualified = true): BenchmarkAttempt[] {
	return protocol.taskIds.map((taskId) => {
		const definition = tasks.find((entry) => entry.id === taskId)!
		return {
			schemaVersion: 1, manifestDigest, taskId, split: "development", attemptId: `${harnessCommit.slice(0, 4)}-${taskId}`,
			harnessCommit, agentImage: { name: `headlesscode-openshell-rsi:${harnessCommit}`, digest: `sha256:${harnessCommit.slice(0, 1).repeat(64)}`, harnessCommit },
			model, seed: definition.seed, family: definition.family, startDigest: definition.startDigest, ceilings: definition.ceilings,
			verifiedSuccess: successes[taskId] ?? false, proofQualified, resourceAccounting: proofQualified ? "supervisor-enforced" : "guest-reported", validity: "valid",
			calls: 1, tokens, wallTimeMs: 100, stopReason: "done", patchDigest: "f".repeat(64), evaluatorDigest: definition.verifierDigest,
			artifactRefs: { patch: "f".repeat(64), stdout: "a".repeat(64), stderr: "b".repeat(64) },
		}
	})
}

function comparison(child: BenchmarkAttempt[], reference: BenchmarkAttempt[], referenceCommit = parentCommit) {
	return compareDevelopmentAttempts({
		protocol, childCommit, referenceCommit, referenceKind: "immediate-parent",
		child: developmentCells(child), reference: developmentCells(reference),
	})
}

function testProtocolOrderUsesUtf8Bytes(): void {
	const reversed = freezeDevelopmentProofProtocol({ ...manifest, tasks: [...tasks].reverse() }, manifestDigest, model, protocol.rule)
	assert.deepEqual(protocol.taskIds, ["a-retain", "b-general"])
	assert.equal(reversed.protocolDigest, protocol.protocolDigest)
}

function testActualShapedAttemptsCanPassTheFrozenRule(): void {
	const parent = attempts(parentCommit, { "a-retain": true, "b-general": false }, 100)
	const child = attempts(childCommit, { "a-retain": true, "b-general": true }, 105)
	const result = comparison(child, parent)
	assert.equal(result.comparable, true)
	assert.equal(result.eligible, true)
	assert.equal(result.netWins, 1)
	assert.equal(result.meanTokenIncreaseRatio, 1.05)
	assert.equal(candidateProofDecision({ runId: "test-run", protocol, child: developmentCells(child), parent: developmentCells(parent), originalBase: developmentCells(parent), immediateParent: result, originalBaseComparison: { ...result, referenceKind: "original-base", referenceCommit: rootCommit } }).accepted, true)
}

function testRetentionRegressionRejectsOtherwiseQualifiedWin(): void {
	const parent = attempts(parentCommit, { "a-retain": true, "b-general": false })
	const child = attempts(childCommit, { "a-retain": false, "b-general": true })
	const result = comparison(child, parent)
	assert.equal(result.comparable, true)
	assert.equal(result.eligible, false)
	assert.match(result.reason, /retention/)
}

function testInvalidAttemptAndUnqualifiedResourceEvidenceAreIncomparable(): void {
	const parent = attempts(parentCommit, { "a-retain": true, "b-general": false })
	const child = attempts(childCommit, { "a-retain": true, "b-general": true })
	child[0] = { ...child[0]!, validity: "timeout" }
	assert.equal(comparison(child, parent).invalid, 1)
	const unqualified = comparison(attempts(childCommit, { "a-retain": true, "b-general": true }, 100, false), parent)
	assert.equal(unqualified.comparable, false)
	assert.equal(unqualified.eligible, false)
	assert.match(unqualified.reason, /not proof-qualified/)
	const forged = attempts(childCommit, { "a-retain": true, "b-general": true }, 100, true)
	forged[0] = { ...forged[0]!, resourceAccounting: "guest-reported" }
	assert.equal(comparison(forged, parent).comparable, false, "proofQualified cannot override guest-reported accounting")
}

function testTokenIncreaseAboveFrozenCapRejects(): void {
	const parent = attempts(parentCommit, { "a-retain": true, "b-general": false }, 100)
	const child = attempts(childCommit, { "a-retain": true, "b-general": true }, 111)
	const result = comparison(child, parent)
	assert.equal(result.comparable, true)
	assert.equal(result.eligible, false)
	assert.equal(result.meanTokenIncreaseRatio, 1.11)
}

function testMissingCellIsInvalid(): void {
	const parent = attempts(parentCommit, { "a-retain": true, "b-general": false })
	const child = attempts(childCommit, { "a-retain": true, "b-general": true }).slice(0, 1)
	const result = comparison(child, parent)
	assert.equal(result.comparable, false)
	assert.equal(result.invalid, 1)
}

function testChildCanBeatRootYetLoseImmediateParent(): void {
	const root = attempts(rootCommit, { "a-retain": false, "b-general": false })
	const parent = attempts(parentCommit, { "a-retain": true, "b-general": true })
	const child = attempts(childCommit, { "a-retain": false, "b-general": true })
	const againstParent = comparison(child, parent)
	const againstRoot = compareDevelopmentAttempts({ protocol, childCommit, referenceCommit: rootCommit, referenceKind: "original-base", child: developmentCells(child), reference: developmentCells(root) })
	assert.equal(againstRoot.eligible, true)
	assert.equal(againstParent.eligible, false)
	assert.equal(againstParent.parentWins, 1)
}

function testIdentityMismatchesAndMixedImageAreInvalid(): void {
	const reference = attempts(parentCommit, { "a-retain": true, "b-general": false })
	const mutations: Array<(attempt: BenchmarkAttempt) => BenchmarkAttempt> = [
		(attempt) => ({ ...attempt, startDigest: "9".repeat(64) }),
		(attempt) => ({ ...attempt, seed: attempt.seed + 1 }),
		(attempt) => ({ ...attempt, ceilings: { ...attempt.ceilings, maxCalls: attempt.ceilings.maxCalls + 1 } }),
		(attempt) => ({ ...attempt, model: { ...attempt.model, id: "different-model" } }),
		(attempt) => ({ ...attempt, evaluatorDigest: "8".repeat(64) }),
		(attempt) => ({ ...attempt, manifestDigest: "7".repeat(64) }),
	]
	for (const mutate of mutations) {
		const child = attempts(childCommit, { "a-retain": true, "b-general": true })
		child[0] = mutate(child[0]!)
		assert.equal(comparison(child, reference).comparable, false)
	}
	const mixedImage = attempts(childCommit, { "a-retain": true, "b-general": true })
	mixedImage[1] = { ...mixedImage[1]!, agentImage: { ...mixedImage[1]!.agentImage!, digest: `sha256:${"9".repeat(64)}` } }
	assert.equal(comparison(mixedImage, reference).comparable, false)
}

function testEmptyTaskSetAndModifiedFrozenRuleAreRejected(): void {
	assert.throws(() => freezeDevelopmentProofProtocol({ ...manifest, tasks: [] }, manifestDigest, model, protocol.rule), /task set is empty/)
	const mutableRule = { minimumNetWins: 1, retentionTaskIds: ["a-retain"], maximumMeanTokenIncreaseRatio: 1.1 }
	const frozen = freezeDevelopmentProofProtocol(manifest, manifestDigest, model, mutableRule)
	mutableRule.minimumNetWins = 99
	mutableRule.retentionTaskIds.push("b-general")
	assert.equal(frozen.rule.minimumNetWins, 1)
	assert.deepEqual(frozen.rule.retentionTaskIds, ["a-retain"])
	const tampered = { ...protocol, rule: { ...protocol.rule, minimumNetWins: 0 } }
	assert.throws(() => compareDevelopmentAttempts({ protocol: tampered, childCommit, referenceCommit: parentCommit, referenceKind: "immediate-parent", child: [], reference: [] }), /protocol digest/)
}

testProtocolOrderUsesUtf8Bytes()
testActualShapedAttemptsCanPassTheFrozenRule()
testRetentionRegressionRejectsOtherwiseQualifiedWin()
testInvalidAttemptAndUnqualifiedResourceEvidenceAreIncomparable()
testTokenIncreaseAboveFrozenCapRejects()
testMissingCellIsInvalid()
testChildCanBeatRootYetLoseImmediateParent()
testIdentityMismatchesAndMixedImageAreInvalid()
testEmptyTaskSetAndModifiedFrozenRuleAreRejected()
console.log("All 9 development proof tests passed")
