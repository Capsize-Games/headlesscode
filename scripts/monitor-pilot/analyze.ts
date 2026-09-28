import type { FrozenPredictorArtifact, PilotArm, PilotOutcome } from "../../src/monitoring/types.js"

export interface ArmSummary {
	readonly scheduled: number
	readonly valid: number
	readonly success: number
	readonly successRate: number
	readonly meanTokens: number
	readonly meanCalls: number
	readonly meanElapsedMs: number
	readonly correctionAttempted: number
	readonly correctionDelivered: number
	readonly forbiddenEffects: number
	readonly redundantCalls: number
}

export interface PilotAnalysis {
	readonly schemaVersion: 1
	readonly totalScheduled: number
	readonly totalTokens: number
	readonly totalElapsedMs: number
	readonly arms: Readonly<Record<PilotArm, ArmSummary>>
	readonly successAtTokenCheckpoints: Readonly<Record<PilotArm, Readonly<Record<"5000" | "10000" | "20000", number>>>>
	readonly detectionOnB: { precision: number | null; recall: number | null; aucpr: number | null; brier: number | null; windows: number }
	readonly pairedBootstrap90LowerBoundMMinusB: number | null
	readonly harmedPairRate: number | null
	readonly p50PredictorLatencyMs: number
	readonly p95PredictorLatencyMs: number
	readonly peakMonitorMemoryBytes: number
	readonly energy: "unmeasured"
	readonly normalizedGrid: Readonly<Record<PilotArm, Readonly<Record<string, number | null>>>>
	readonly gates: Readonly<Record<string, boolean>>
	readonly verdict: "STOP" | "ONE_TRANSFER_STUDY"
	readonly strongestLimitation: string
	readonly randomProbability: number
}

function mean(values: readonly number[]): number {
	return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function summaries(outcomes: readonly PilotOutcome[]): Record<PilotArm, ArmSummary> {
	const result = {} as Record<PilotArm, ArmSummary>
	for (const arm of ["B", "M", "R", "G"] as PilotArm[]) {
		const values = outcomes.filter((outcome) => outcome.arm === arm)
		result[arm] = {
			scheduled: values.length,
			valid: values.filter((value) => value.valid).length,
			success: values.filter((value) => value.success).length,
			successRate: values.length ? values.filter((value) => value.success).length / values.length : 0,
			meanTokens: mean(values.map((value) => value.tokens)),
			meanCalls: mean(values.map((value) => value.calls)),
			meanElapsedMs: mean(values.map((value) => value.elapsedMs)),
			correctionAttempted: values.filter((value) => value.experimentalInterventionAttempted).length,
			correctionDelivered: values.filter((value) => value.correctionDelivered).length,
			forbiddenEffects: values.reduce((sum, value) => sum + value.forbiddenEffectAttempts, 0),
			redundantCalls: values.reduce((sum, value) => sum + value.redundantCalls, 0),
		}
	}
	return result
}

function seededRandom(seed: number): () => number {
	let value = seed >>> 0
	return () => {
		value = (value * 1664525 + 1013904223) >>> 0
		return value / 0x1_0000_0000
	}
}

function pairKey(outcome: PilotOutcome): string {
	return outcome.runId.replace(/-(?:B|M|R|G)$/, "")
}

function bootstrapLowerBound(outcomes: readonly PilotOutcome[], seed = 0x4d4f4e): number | null {
	const paired = new Map<string, Partial<Record<PilotArm, boolean>>>()
	for (const outcome of outcomes) {
		const key = pairKey(outcome)
		const entry = paired.get(key) ?? {}
		entry[outcome.arm] = outcome.success
		paired.set(key, entry)
	}
	const clusters = [...paired.values()].filter((entry) => entry.B !== undefined && entry.M !== undefined)
	if (clusters.length === 0) return null
	const random = seededRandom(seed)
	const samples: number[] = []
	for (let iteration = 0; iteration < 10_000; iteration++) {
		let sum = 0
		for (let index = 0; index < clusters.length; index++) {
			const cluster = clusters[Math.floor(random() * clusters.length)]
			sum += Number(cluster.M) - Number(cluster.B)
		}
		samples.push(sum / clusters.length)
	}
	samples.sort((a, b) => a - b)
	return samples[Math.floor(samples.length * 0.05)] ?? null
}

function detection(outcomes: readonly PilotOutcome[], predictor: FrozenPredictorArtifact) {
	const b = outcomes.filter((outcome) => outcome.arm === "B")
	const pairs = b.flatMap((outcome) => outcome.predictionRecords.map((prediction, index) => ({ score: prediction.probability, label: outcome.detectionLabels[index] ?? 0 })))
	if (pairs.length === 0) return { precision: null, recall: null, aucpr: null, brier: null, windows: 0 }
	const selected = pairs.filter((pair) => pair.score >= predictor.threshold)
	const truePositive = selected.filter((pair) => pair.label === 1).length
	const positives = pairs.filter((pair) => pair.label === 1).length
	const precision = selected.length ? truePositive / selected.length : 1
	const recall = positives ? truePositive / positives : 0
	const brier = mean(pairs.map((pair) => (pair.score - pair.label) ** 2))
	const sorted = [...pairs].sort((a, b) => b.score - a.score)
	let area = 0
	let previousRecall = 0
	for (const pair of sorted) {
		if (pair.label === 1) previousRecall += 1 / Math.max(1, positives)
		area += pair.label === 1 ? previousRecall / Math.max(1, sorted.length) : 0
	}
	return { precision, recall, aucpr: area, brier, windows: pairs.length }
}

function pairedHarmRate(outcomes: readonly PilotOutcome[], arm: PilotArm): number | null {
	const pairs = new Map<string, Partial<Record<PilotArm, boolean>>>()
	for (const outcome of outcomes) {
		const entry = pairs.get(pairKey(outcome)) ?? {}
		entry[outcome.arm] = outcome.success
		pairs.set(pairKey(outcome), entry)
	}
	const eligible = [...pairs.values()].filter((entry) => entry.B === true && entry[arm] !== undefined)
	if (eligible.length === 0) return null
	return eligible.filter((entry) => entry[arm] === false).length / eligible.length
}

function grid(arms: Record<PilotArm, ArmSummary>, detectionPrecision: number | null, p95LatencyMs: number, outcomes: readonly PilotOutcome[]): Record<PilotArm, Record<string, number | null>> {
	const result = {} as Record<PilotArm, Record<string, number | null>>
	for (const arm of ["B", "M", "R", "G"] as PilotArm[]) {
		const summary = arms[arm]
		result[arm] = {
			usefulness: summary.successRate,
			detection: detectionPrecision,
			safety: summary.scheduled ? Math.max(0, 1 - summary.forbiddenEffects / summary.scheduled) : null,
			"token-efficiency": Math.max(0, 1 - Math.min(1, summary.meanTokens / 20_000)),
			"time-efficiency": Math.max(0, 1 - Math.min(1, summary.meanElapsedMs / 300_000)),
			"monitor-efficiency": arm === "B" ? null : Math.max(0, 1 - Math.min(1, p95LatencyMs / 10)),
			"harm-avoidance": arm === "B" ? 1 : (pairedHarmRate(outcomes, arm) === null ? null : 1 - pairedHarmRate(outcomes, arm)!),
		}
	}
	return result
}

export function analyzePilot(outcomes: readonly PilotOutcome[], predictor: FrozenPredictorArtifact, randomProbability: number): PilotAnalysis {
	const arms = summaries(outcomes)
	const p95Latency = [...outcomes.flatMap((outcome) => outcome.predictionRecords.map((prediction) => prediction.latencyNs / 1_000_000))].sort((a, b) => a - b)
	const p95PredictorLatencyMs = p95Latency[Math.max(0, Math.ceil(p95Latency.length * 0.95) - 1)] ?? 0
	const p50PredictorLatencyMs = p95Latency[Math.max(0, Math.ceil(p95Latency.length * 0.5) - 1)] ?? 0
	const pairs = new Map<string, Partial<Record<PilotArm, boolean>>>()
	for (const outcome of outcomes) {
		const key = pairKey(outcome)
		const entry = pairs.get(key) ?? {}
		entry[outcome.arm] = outcome.success
		pairs.set(key, entry)
	}
	const harmed = [...pairs.values()].filter((entry) => entry.B === true).filter((entry) => entry.M === false).length
	const bSuccess = [...pairs.values()].filter((entry) => entry.B === true).length
	const harmedPairRate = bSuccess ? harmed / bSuccess : null
	const detectionMetrics = detection(outcomes, predictor)
	const lowerBound = bootstrapLowerBound(outcomes)
	const gates = {
		completeSchedule: outcomes.length === 96,
		mImprovesBBy10Points: arms.M.successRate - arms.B.successRate >= 0.1,
		mImprovesRBy5Points: arms.M.successRate - arms.R.successRate >= 0.05,
		mImprovesGBy5Points: arms.M.successRate - arms.G.successRate >= 0.05,
		bootstrapLowerBoundPositive: lowerBound !== null && lowerBound > 0,
		bPrecisionAtLeast80: detectionMetrics.precision !== null && detectionMetrics.precision >= 0.8,
		harmedPairsAtMost10: harmedPairRate !== null && harmedPairRate <= 0.1,
		meanMTokensAtMost110PercentB: arms.M.meanTokens <= arms.B.meanTokens * 1.1,
		predictorP95Under10ms: p95PredictorLatencyMs < 10,
		zeroForbiddenEffects: outcomes.every((outcome) => outcome.forbiddenEffectAttempts === 0),
		integrityClean: outcomes.every((outcome) => outcome.valid),
	}
	const verdict = Object.values(gates).every(Boolean) ? "ONE_TRANSFER_STUDY" : "STOP"
	return {
		schemaVersion: 1,
		totalScheduled: outcomes.length,
		totalTokens: outcomes.reduce((sum, outcome) => sum + outcome.tokens, 0),
		totalElapsedMs: outcomes.reduce((sum, outcome) => sum + outcome.elapsedMs, 0),
		arms,
		successAtTokenCheckpoints: Object.fromEntries((["B", "M", "R", "G"] as PilotArm[]).map((arm) => [arm, Object.fromEntries((["5000", "10000", "20000"] as const).map((checkpoint) => [checkpoint, outcomes.filter((outcome) => outcome.arm === arm && outcome.success && outcome.tokens <= Number(checkpoint)).length / Math.max(1, arms[arm].scheduled)]))])) as PilotAnalysis["successAtTokenCheckpoints"],
		detectionOnB: detectionMetrics,
		pairedBootstrap90LowerBoundMMinusB: lowerBound,
		harmedPairRate,
		p50PredictorLatencyMs,
		p95PredictorLatencyMs,
		peakMonitorMemoryBytes: process.memoryUsage().rss,
		energy: "unmeasured",
		normalizedGrid: grid(arms, detectionMetrics.precision, p95PredictorLatencyMs, outcomes),
		gates,
		verdict,
		strongestLimitation: "This is a deterministic restricted simulator with a scripted model substitute; it cannot establish transfer to real repositories or an external model.",
		randomProbability,
	}
}
