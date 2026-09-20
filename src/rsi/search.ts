import type { ComputePolicy } from "./types.js"

export interface DifficultySignals {
	taskLength: number
	priorFailures: number
	uncertainty: number
		repeatedFailure: boolean
}

export interface SearchPlan {
	policy: ComputePolicy
	attempts: number
	criticAfterFailure: boolean
	reason: string
}

export function chooseComputePolicy(signals: DifficultySignals): SearchPlan {
	if (signals.repeatedFailure || signals.priorFailures >= 2) {
		return { policy: "critic-retry", attempts: 2, criticAfterFailure: true, reason: "repeated failure warrants diagnosis before another attempt" }
	}
	if (signals.taskLength >= 1200 || signals.uncertainty >= 0.75) {
		return { policy: "planner-executors", attempts: 3, criticAfterFailure: false, reason: "long or uncertain task needs a plan plus independent implementations" }
	}
	if (signals.taskLength >= 500 || signals.uncertainty >= 0.4) {
		return { policy: "independent", attempts: 2, criticAfterFailure: false, reason: "moderate difficulty merits independent trajectories" }
	}
	return { policy: "single", attempts: 1, criticAfterFailure: false, reason: "easy task does not justify extra inference" }
}

export function boundedSearchBudget(plan: SearchPlan, baseIterations: number): number {
	return Math.max(1, Math.floor(baseIterations * plan.attempts))
}
