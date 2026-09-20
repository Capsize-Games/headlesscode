import type { CandidateRecord, Fitness, RsiConfig, RsiRunRecord } from "./types.js"

export function formatCandidate(candidate: CandidateRecord): string {
	const fitness = candidate.fitness
	const parent = candidate.parentSelection ? `, parent=${candidate.parent} (${candidate.parentSelection.strategy})` : ""
	const mutation = candidate.mutationKind ? `, mutation=${candidate.mutationKind}` : ""
	const metrics = fitness ? `, metrics=${JSON.stringify(fitness.metrics)}` : ""
	return `${candidate.id}: ${candidate.status}${parent}${mutation}${fitness ? `, score=${fitness.score}, ${fitness.reason}` : ""}${metrics}`
}

export function formatRunReport(run: RsiRunRecord, config: RsiConfig): string {
	const lines = [
		`# RSI Generation Report: ${run.runId}`,
		"",
		`- Model: ${run.model}`,
		`- Base commit: ${run.baseCommit}`,
		`- Generations: ${run.generations}`,
		`- Started: ${run.startedAt}`,
		`- Finished: ${run.finishedAt ?? "in progress"}`,
		`- Baseline: ${run.baseline ? (run.baseline.ok ? "pass" : "fail") : "not run (dry-run)"}`,
		`- Selected candidate: ${run.selected ?? "none"}`,
		`- Pareto candidates: ${run.selectedCandidates?.join(", ") || "none"}`,
		`- Parent policy: ${run.parentSelectionPolicy ?? config.parentSelectionPolicy ?? "champion-specialist-novelty"}`,
		`- Model candidates: ${run.modelCandidates?.map((model) => `${model.id} (${model.status})`).join(", ") || "none"}`,
		`- Experiment jobs: ${run.jobs?.length ?? 0}`,
		`- Trajectories: ${run.trajectoryRefs?.length ?? 0}`,
		"",
		"## Candidates",
		"",
		...run.candidates.map((candidate) => `- ${formatCandidate(candidate)}${candidate.failure ? `; failure=${candidate.failure}` : ""}`),
		"",
		"## Guardrails",
		"",
		`- Visible evaluations: ${config.evalCommands.join("; ") || "none"}`,
		`- Hidden evaluations: ${config.hiddenEvalCommands.length || 0}`,
		`- Compute policy: ${config.computePolicy ?? "single"}`,
		`- Protected paths: ${config.protectedPaths.join(", ")}`,
		"",
		"The archive is the durable machine-readable record for this run.",
	]
	return `${lines.join("\n")}\n`
}

export function fitnessSummary(fitness: Fitness | undefined): string {
	if (!fitness) return "not evaluated"
	return `${fitness.score} (${fitness.reason})`
}
