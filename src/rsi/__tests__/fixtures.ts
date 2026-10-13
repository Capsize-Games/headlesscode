import type { CandidateRecord, Fitness, MetricVector } from "../types.js"

export function metrics(overrides: Partial<MetricVector>): MetricVector {
	return {
		correctness: 0.8,
		reliability: 0.8,
		generalization: 0.8,
		hidden: 0.8,
		efficiency: 0.8,
		latency: 100,
		tokenUse: 100,
		recovery: 0.8,
		fabricationRate: 0.1,
		complexityPenalty: 0.1,
		...overrides,
	}
}

export function fitness(vector: MetricVector, score: number): Fitness {
	return {
		score,
		components: {
			regression: 1, visible: 0.8, hidden: 0.8, efficiency: 0.8, recovery: 0.8,
		},
		metrics: vector,
		complexity: {
			diffLines: 10, changedFiles: 1, newDependencies: 0,
			additionalModelCalls: 0, runtimeOverheadMs: 0,
		},
		hardGates: {
			regressionPass: true, typecheckPass: true, visibleEvalPass: true,
			hiddenEvalPass: true, adversarialPass: true,
			noProtectedPathViolation: true, completed: true, noCrash: true,
			committed: true,
		},
		reason: "all hard gates passed",
	}
}

function acceptedProof(): NonNullable<CandidateRecord["developmentProof"]> {
	return { accepted: true } as NonNullable<CandidateRecord["developmentProof"]>
}

export function candidate(
	id: string, vector: MetricVector, score: number,
): CandidateRecord {
	return {
		id,
		generation: 0, parent: "baseline",
		branch: `rsi/${id}`,
		worktree: `/tmp/${id}`,
		baseCommit: "base",
		status: "accepted",
		model: "qwen",
		mutation: id,
		createdAt: "now", updatedAt: "now",
		commits: [`commit-${id}`],
		changedFiles: ["src/engine/loop.ts"],
		protectedPathViolations: [],
		fitness: fitness(vector, score),
		developmentProof: acceptedProof(),
	}
}
