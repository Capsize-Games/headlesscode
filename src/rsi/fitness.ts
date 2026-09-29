import type { EvaluationSummary, Fitness, HardGates, PairedComparison } from "./types.js"

function rate(passed: number, total: number): number {
	return total === 0 ? 1 : passed / total
}

export function hardGatesFor(summary: EvaluationSummary): HardGates {
	const hasTaskEvaluation = summary.visible.length > 0 || summary.hidden.length > 0
	return {
		regressionPass: summary.regression.ok,
		visibleEvalPass: hasTaskEvaluation && summary.visible.every((trial) => trial.ok),
		hiddenEvalPass: summary.hidden.every((trial) => trial.ok),
		adversarialPass: summary.adversarialPass !== false,
		noProtectedPathViolation: !summary.protectedPathViolation,
		completed: summary.completed,
		noCrash: !summary.crashed,
		committed: summary.committed !== false,
	}
}

export function computeFitness(summary: EvaluationSummary): Fitness {
	const hardGates = hardGatesFor(summary)
	const visibleRate = rate(summary.visible.filter((trial) => trial.ok).length, summary.visible.length)
	const hiddenRate = rate(summary.hidden.filter((trial) => trial.ok).length, summary.hidden.length)
	const regression = hardGates.regressionPass ? 1 : 0
	const efficiency = Math.max(0, 1 - Math.min(1, summary.visible.reduce((sum, trial) => sum + trial.durationMs, 0) / 600_000))
	const recovery = summary.visible.length === 0 ? 0 : visibleRate
	const complexity = summary.complexity ?? {
		diffLines: 0,
		changedFiles: summary.changedFiles.length,
		newDependencies: 0,
		additionalModelCalls: 0,
		runtimeOverheadMs: 0,
	}
	const latency = [summary.regression, ...summary.visible, ...summary.hidden].reduce((sum, trial) => sum + trial.durationMs, 0)
	const complexityPenalty = Math.min(1, complexity.diffLines / 20_000 + complexity.newDependencies / 10 + complexity.additionalModelCalls / 20)
	const metrics = {
		correctness: regression,
		reliability: hardGates.noCrash ? 1 : 0,
		generalization: visibleRate,
		hidden: hiddenRate,
		efficiency,
		latency: latency,
		tokenUse: 0,
		recovery,
		fabricationRate: summary.completed ? 0 : 1,
		complexityPenalty,
	}
	const components = { regression, visible: visibleRate, hidden: hiddenRate, efficiency, recovery }
	const unpenalizedScore = Math.round(
		(regression * 45 + visibleRate * 25 + hiddenRate * 20 + efficiency * 5 + recovery * 5 - complexityPenalty * 5) * 100,
	) / 100
	const adversarialPenalty = Math.min(10, Math.max(0, summary.adversarialPenalty ?? 0))
	const score = Math.max(0, Math.round((unpenalizedScore - adversarialPenalty) * 100) / 100)
	const failedGate = Object.entries(hardGates).find(([, passed]) => !passed)?.[0]
	return {
		score: failedGate ? 0 : score,
		components,
		metrics,
		complexity,
		hardGates,
		reason: failedGate ? `hard gate failed: ${failedGate}` : adversarialPenalty > 0 ? `all hard gates passed; adversarial findings penalty ${adversarialPenalty}` : "all hard gates passed",
		...(adversarialPenalty > 0 ? { adversarialPenalty } : {}),
	}
}

export function compareFitness(left: Fitness | undefined, right: Fitness | undefined): number {
	return (left?.score ?? 0) - (right?.score ?? 0)
}

export function comparePairedEvaluation(baseline: EvaluationSummary, candidate: EvaluationSummary): PairedComparison {
	const baselineTrials = [baseline.regression, ...baseline.visible, ...baseline.hidden]
	const candidateTrials = [candidate.regression, ...candidate.visible, ...candidate.hidden]
	const baselinePasses = baselineTrials.filter((trial) => trial.ok).length
	const candidatePasses = candidateTrials.filter((trial) => trial.ok).length
	const baselineDurationMs = baselineTrials.reduce((total, trial) => total + trial.durationMs, 0)
	const candidateDurationMs = candidateTrials.reduce((total, trial) => total + trial.durationMs, 0)
	const durationRatio = baselineDurationMs === 0 ? Number.POSITIVE_INFINITY : candidateDurationMs / baselineDurationMs
	const comparable = baselineTrials.length === candidateTrials.length && baselineTrials.every((trial, index) => trial.command === candidateTrials[index]?.command)
	const correctnessImproved = comparable && candidatePasses > baselinePasses
	const efficiencyImproved = comparable && candidatePasses === baselinePasses && candidatePasses === candidateTrials.length && durationRatio <= 0.9
	const improved = correctnessImproved || efficiencyImproved
	return {
		baselinePasses,
		candidatePasses,
		trialCount: Math.min(baselineTrials.length, candidateTrials.length),
		baselineDurationMs,
		candidateDurationMs,
		durationRatio,
		improved,
		reason: !comparable
			? "baseline and candidate did not run the same evaluation commands"
			: correctnessImproved
				? "candidate passed more paired evaluation trials"
				: efficiencyImproved
					? "candidate passed every paired trial and reduced total evaluation duration by at least 10%"
					: "candidate did not meet the paired improvement threshold",
	}
}
