import assert from "node:assert/strict"

import { runMain } from "../../test-runner.js"
import {
	selectGenerationCandidates,
	type GenerationSelectionInput,
} from "../controller-selection.js"
import { candidate, metrics } from "./fixtures.js"

async function selectsFrontAndTopRanked(): Promise<void> {
	const a = candidate("a", metrics({ correctness: 1, efficiency: 0.4 }), 80)
	const b = candidate("b",
		metrics({ correctness: 0.8, efficiency: 1, hidden: 1 }), 82)
	const dominated = candidate("dominated",
		metrics({ correctness: 0.7, efficiency: 0.3, hidden: 0.7 }), 70)
	const result = selectGenerationCandidates({
		candidates: [a, b, dominated],
		generation: 4,
		adversarialReviews: [],
	})
	assert.deepEqual(result.selectedCandidates.sort(), ["a", "b"])
	const frontIds = result.front.map((entry) => entry.id).sort()
	assert.deepEqual(frontIds, ["a", "b"])
	assert.equal(result.selected, "b")
	assert.equal(result.selection.generation, 4)
	assert.deepEqual(result.selection.selectedCandidateIds.sort(), ["a", "b"])
	assert.equal(result.selection.selectedCandidateId, "b")
}

async function emptyAcceptedSelectsNothing(): Promise<void> {
	const evaluating = candidate("a", metrics({}), 9)
	evaluating.status = "evaluating"
	const result = selectGenerationCandidates({
		candidates: [evaluating], generation: 0, adversarialReviews: [],
	})
	assert.deepEqual(result.selectedCandidates, [])
	assert.equal(result.selected, undefined)
	assert.equal(result.selection.selectedCandidateId, undefined)
}

async function digestIsStableAndSensitive(): Promise<void> {
	const input = (score: number): GenerationSelectionInput => ({
		candidates: [candidate("a", metrics({}), score)],
		generation: 0,
		adversarialReviews: [],
	})
	const one = input(1)
	const two = input(2)
	const first = selectGenerationCandidates(one)
	const again = selectGenerationCandidates(one)
	const changed = selectGenerationCandidates(two)
	assert.equal(typeof first.selection.decisionsSha256, "string")
	assert.equal(first.selection.decisionsSha256, again.selection.decisionsSha256)
	const updated = changed.selection.decisionsSha256
	assert.notEqual(first.selection.decisionsSha256, updated)
}

const tests: Array<[string, () => Promise<void>]> = [
	["selects front and top ranked", selectsFrontAndTopRanked],
	["empty accepted selects nothing", emptyAcceptedSelectsNothing],
	["digest is stable and sensitive", digestIsStableAndSensitive],
]

runMain("controller-selection", tests)
