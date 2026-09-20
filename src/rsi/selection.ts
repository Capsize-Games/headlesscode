import { randomUUID } from "node:crypto"
import type {
	CandidateRecord,
	MetricVector,
	ParentSelectionPolicy,
	ParentSelectionReason,
	RsiArchive,
	ExperimentJob,
	ExperimentJobKind,
	ExperimentJobStatus,
	ResourceRequirements,
} from "./types.js"

const SPECIALIST_METRICS: Array<keyof MetricVector> = ["correctness", "hidden", "efficiency", "recovery", "reliability"]

function metrics(candidate: CandidateRecord): MetricVector {
	return (
		candidate.fitness?.metrics ?? {
			correctness: candidate.fitness?.components.regression ?? 0,
			reliability: candidate.fitness?.components.recovery ?? 0,
			generalization: candidate.fitness?.components.visible ?? 0,
			hidden: candidate.fitness?.components.hidden ?? 0,
			efficiency: candidate.fitness?.components.efficiency ?? 0,
			latency: 0,
			tokenUse: 0,
			recovery: candidate.fitness?.components.recovery ?? 0,
			fabricationRate: 1,
			complexityPenalty: 0,
		}
	)
}

function eligible(candidates: CandidateRecord[]): CandidateRecord[] {
	return candidates.filter((candidate) => candidate.fitness && candidate.fitness.hardGates.committed !== false && candidate.commits[0])
}

export interface ParentChoice {
	candidateId: string
	baseCommit: string
	reason: ParentSelectionReason
}

export function paretoDominates(left: MetricVector, right: MetricVector): boolean {
	let strictlyBetter = false
	for (const key of Object.keys(left) as Array<keyof MetricVector>) {
		const leftValue = key === "fabricationRate" || key === "complexityPenalty" || key === "latency" || key === "tokenUse" ? -left[key] : left[key]
		const rightValue = key === "fabricationRate" || key === "complexityPenalty" || key === "latency" || key === "tokenUse" ? -right[key] : right[key]
		if (leftValue < rightValue) return false
		if (leftValue > rightValue) strictlyBetter = true
	}
	return strictlyBetter
}

export function paretoFront(candidates: CandidateRecord[]): CandidateRecord[] {
	const pool = eligible(candidates)
	return pool.filter((candidate) => !pool.some((other) => other !== candidate && paretoDominates(metrics(other), metrics(candidate))))
}

function byScore(a: CandidateRecord, b: CandidateRecord): number {
	return (b.fitness?.score ?? 0) - (a.fitness?.score ?? 0)
}

function choice(candidate: CandidateRecord, strategy: ParentSelectionReason["strategy"], reason: string): ParentChoice {
	return {
		candidateId: candidate.id,
		baseCommit: candidate.commits[0] ?? candidate.baseCommit,
		reason: { strategy, reason, metrics: metrics(candidate) },
	}
}

export function selectParentChoices(
	archive: RsiArchive,
	policy: ParentSelectionPolicy,
	count: number,
	): ParentChoice[] {
	const pool = eligible(archive.candidates).sort(byScore)
	if (pool.length === 0 || count <= 0) return []
	if (policy === "all-eligible") {
		return Array.from({ length: count }, (_, index) => choice(pool[index % pool.length], "archive", "eligible archived candidate"))
	}
	if (policy === "pareto-front") {
		const front = paretoFront(pool).sort(byScore)
		return Array.from({ length: count }, (_, index) => choice(front[index % front.length], "pareto", "candidate retained on the multi-objective Pareto front"))
	}

	const selected: ParentChoice[] = []
	const champion = pool[0]
	selected.push(choice(champion, "champion", "highest hard-gated scalar fitness"))
	for (const metric of SPECIALIST_METRICS) {
		if (selected.length >= count) break
		const specialist = [...pool].sort((a, b) => metrics(b)[metric] - metrics(a)[metric])[0]
		if (specialist && !selected.some((entry) => entry.candidateId === specialist.id)) {
			selected.push(choice(specialist, "specialist", `best archived candidate on ${metric}`))
		}
	}
	for (const candidate of pool) {
		if (selected.length >= count) break
		if (!selected.some((entry) => entry.candidateId === candidate.id)) {
			selected.push(choice(candidate, "novelty", "next eligible candidate preserves population diversity"))
		}
	}
	return Array.from({ length: count }, (_, index) => selected[index % selected.length])
}

export function newExperimentJob(
	kind: ExperimentJobKind,
	resource: ResourceRequirements,
	now: string,
	candidateId?: string,
): ExperimentJob {
	return {
		id: `job-${kind}-${randomUUID().slice(0, 8)}`,
		kind,
		status: "queued",
		resource,
		candidateId,
		createdAt: now,
		updatedAt: now,
		attempts: 0,
	}
}

export function transitionJob(job: ExperimentJob, status: ExperimentJobStatus, now: string, error?: string): ExperimentJob {
	if (job.status === "completed" || job.status === "cancelled") return job
	return {
		...job,
		status,
		updatedAt: now,
		attempts: status === "running" ? job.attempts + 1 : job.attempts,
		...(error ? { error } : {}),
	}
}
