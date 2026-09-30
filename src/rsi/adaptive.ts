import type { AdaptiveSearchDecision, CandidateRecord, RsiConfig } from "./types.js"

/** Decide whether a bounded adaptive run should allocate one follow-up trajectory. */
export function decideAdaptiveContinuation(input: {
	generation: number
	generationCandidates: CandidateRecord[]
	allCandidates: CandidateRecord[]
	config: RsiConfig
	elapsedMs: number
	decidedAt: string
}): AdaptiveSearchDecision {
	const { generation, generationCandidates, allCandidates, config, elapsedMs, decidedAt } = input
	const maxTrajectories = config.maxTrajectories ?? config.population + 1
	const maxIterations = config.maxTotalIterations ?? maxTrajectories * config.maxIterations
	const allocatedTrajectories = allCandidates.length
	const allocatedIterations = allocatedTrajectories * config.maxIterations
	const evidence = generationCandidates.map((candidate) => ({
		candidateId: candidate.id,
		status: candidate.status,
		...(candidate.fitness?.metrics.generalization !== null && candidate.fitness
			? { visiblePassRate: candidate.fitness.metrics.generalization }
			: {}),
	}))
	const distinctResults = new Set(evidence.map((entry) => `${entry.status}:${entry.visiblePassRate ?? "unknown"}`))
	const mixed = evidence.length >= 2 && distinctResults.size > 1
	let reason: AdaptiveSearchDecision["reason"]
	if (allocatedTrajectories >= maxTrajectories) reason = "trajectory-cap"
	else if (allocatedIterations + config.maxIterations > maxIterations) reason = "iteration-cap"
	else if (elapsedMs >= (config.maxRuntimeMs ?? 60 * 60_000)) reason = "runtime-cap"
	else if (generation >= config.generations) reason = "generation-cap"
	else if (evidence.length < 2) reason = "insufficient-results"
	else if (!mixed) reason = "consistent-evidence"
	else reason = "mixed-evidence"
	const remainingTrajectories = Math.max(0, maxTrajectories - allocatedTrajectories)
	const remainingIterations = Math.max(0, maxIterations - allocatedIterations)
	return {
		generation,
		decision: reason === "mixed-evidence" ? "continue" : "stop",
		reason,
		candidateIds: generationCandidates.map((candidate) => candidate.id),
		evidence,
		allocatedTrajectories,
		remainingTrajectories,
		allocatedIterations,
		remainingIterations,
		elapsedMs,
		decidedAt,
	}
}
