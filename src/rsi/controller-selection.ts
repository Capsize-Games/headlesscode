/**
 * Per-generation candidate selection for the RSI controller (issue
 * #126). Pure: ranks the accepted candidates, takes the pareto front
 * and the top-ranked winner, and digests the decision. The caller
 * seals the result into the run's evaluator integrity record.
 */
import { evaluatorGenerationDecisionDigest } from "./evaluation-integrity.js"
import { compareFitness } from "./fitness.js"
import { paretoFront } from "./selection.js"
import type { AdversarialReviewRecord, CandidateRecord } from "./types.js"

export interface GenerationSelectionInput {
	candidates: CandidateRecord[]
	generation: number
	adversarialReviews: AdversarialReviewRecord[]
}

export interface GenerationSelection {
	generation: number
	selectedCandidateIds: string[]
	selectedCandidateId?: string
	decisionsSha256: string
}

export interface GenerationSelectionResult {
	selectedCandidates: string[]
	selected: string | undefined
	front: CandidateRecord[]
	selection: GenerationSelection
}

function rankAccepted(
	accepted: CandidateRecord[],
): CandidateRecord[] {
	return [...accepted].sort((a, b) => compareFitness(b.fitness, a.fitness))
}

function selectionRecord(
	input: GenerationSelectionInput,
	ids: string[],
	selected: string | undefined,
): GenerationSelection {
	return {
		generation: input.generation,
		selectedCandidateIds: ids,
		...(selected === undefined ? {} : { selectedCandidateId: selected }),
		decisionsSha256: evaluatorGenerationDecisionDigest(
			input.candidates,
			input.adversarialReviews,
			selected,
		),
	}
}

export function selectGenerationCandidates(
	input: GenerationSelectionInput,
): GenerationSelectionResult {
	const isAccepted = (entry: CandidateRecord): boolean =>
		entry.status === "accepted"
	const accepted = input.candidates.filter(isAccepted)
	const front = paretoFront(accepted)
	const selected = rankAccepted(accepted)[0]?.id
	const ids = front.map((entry) => entry.id)
	return {
		selectedCandidates: ids,
		selected,
		front,
		selection: selectionRecord(input, ids, selected),
	}
}
