import { createHash } from "node:crypto"
import {
	canonicalJson,
	evaluatorIntegrityDigest,
} from "./evaluation-integrity.js"
import type { PostgresRsiJobQueue } from "./postgres-queue.js"
import type {
	AdversarialReviewRecord,
	EvaluationSummary,
	RsiRunRecord,
	TrialResult,
} from "./types.js"

export type IntegrityOutput = NonNullable<RsiRunRecord["evaluatorIntegrity"]>["outputs"][number]

export function trialOutputRecords(candidateId: string, taskId: string, trial: TrialResult): IntegrityOutput[] {
	return [{
		candidateId,
		taskId,
		outputSha256: evaluatorIntegrityDigest({ command: trial.command, exitCode: trial.exitCode, stdout: trial.stdout, stderr: trial.stderr, timedOut: trial.timedOut ?? false }),
		...(trial.outputArtifactSha256 ? { artifactSha256: trial.outputArtifactSha256, artifactBytes: trial.outputArtifactBytes } : {}),
	}]
}

export function evaluationOutputRecords(candidateId: string, evaluation: EvaluationSummary): IntegrityOutput[] {
	const trials: Array<{ taskId: string; trial: TrialResult }> = [
		{ taskId: "regression", trial: evaluation.regression },
		...(evaluation.typecheck ? [{ taskId: "typecheck", trial: evaluation.typecheck }] : []),
		...evaluation.visible.map((trial, index) => ({ taskId: `visible-${index}`, trial })),
		...evaluation.hidden.map((trial, index) => ({ taskId: `hidden-${index}`, trial })),
	]
	return trials.flatMap(({ taskId, trial }) => trialOutputRecords(candidateId, taskId, trial))
}

export function adversarialOutputRecords(review: AdversarialReviewRecord): IntegrityOutput[] {
	const refs: Array<[string, string | undefined]> = [
		["prompt", review.promptArtifactSha256], ["result", review.resultArtifactSha256],
		["error", review.errorArtifactSha256], ["tests", review.testArtifactSha256],
		["snapshot", review.snapshotArtifactSha256],
		...review.testResults.map((test, index): [string, string | undefined] => [`test-output-${index}`, test.outputArtifactSha256]),
	]
	return refs.filter((entry): entry is [string, string] => !!entry[1]).map(([taskId, artifactSha256]) => ({
		candidateId: review.candidateId,
		taskId: `adversarial-${taskId}`,
		outputSha256: artifactSha256,
		artifactSha256,
	}))
}

export function verifyArchivedIntegrityOutputs(run: RsiRunRecord, signedOutputs: IntegrityOutput[]): void {
	const expected: IntegrityOutput[] = []
	if (run.baselineEvaluation) expected.push(...evaluationOutputRecords("baseline", run.baselineEvaluation))
	for (const candidate of run.candidates) {
		if (candidate.result) expected.push(...trialOutputRecords(candidate.id, "regression", candidate.result))
	}
	for (const review of run.adversarialReviews ?? []) expected.push(...adversarialOutputRecords(review))
	const signed = new Map(signedOutputs.map((entry) => [`${entry.candidateId}\0${entry.taskId}`, entry]))
	for (const output of expected) {
		const recorded = signed.get(`${output.candidateId}\0${output.taskId}`)
		if (!recorded || canonicalJson(recorded) !== canonicalJson(output)) throw new Error(`archived evaluator output differs from signed identity: ${output.candidateId}/${output.taskId}`)
	}
	for (const output of signedOutputs) {
		if (output.candidateId === "baseline" && !run.baselineEvaluation) throw new Error("signed baseline evaluator outputs are missing from the RSI archive")
		if (output.candidateId !== "baseline" && output.taskId === "regression" && !run.candidates.some((candidate) => candidate.id === output.candidateId && candidate.result)) {
			throw new Error(`signed regression output is missing from the RSI archive: ${output.candidateId}`)
		}
	}
}

export function mergeIntegrityOutputs(record: NonNullable<RsiRunRecord["evaluatorIntegrity"]>, outputs: IntegrityOutput[]): void {
	const byTask = new Map(record.outputs.map((entry) => [`${entry.candidateId}\0${entry.taskId}`, entry]))
	for (const output of outputs) {
		const key = `${output.candidateId}\0${output.taskId}`
		const existing = byTask.get(key)
		if (existing && canonicalJson(existing) !== canonicalJson(output)) throw new Error(`evaluator output identity changed for ${output.candidateId}/${output.taskId}`)
		byTask.set(key, output)
	}
	record.outputs = [...byTask.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId) || left.taskId.localeCompare(right.taskId))
}

export function evaluatorArchiveStateDigest(run: RsiRunRecord): string {
	const state = JSON.parse(JSON.stringify({
		baselineEvaluation: run.baselineEvaluation ?? null,
		baselineFitness: run.baselineFitness ?? null,
		candidates: run.candidates,
		adversarialReviews: run.adversarialReviews ?? [],
		selected: run.selected ?? null,
		selectedCandidates: run.selectedCandidates ?? [],
	})) as Record<string, unknown>
	return evaluatorIntegrityDigest(state)
}

export async function verifyIntegrityArtifacts(queue: PostgresRsiJobQueue | undefined, outputs: IntegrityOutput[]): Promise<void> {
	const references = outputs.filter((entry) => entry.artifactSha256)
	if (references.length > 0 && !queue) throw new Error("evaluator integrity artifact verification requires the configured RSI artifact store")
	for (const reference of references) {
		const bytes = await queue!.getArtifact(reference.artifactSha256!)
		if (createHash("sha256").update(bytes).digest("hex") !== reference.artifactSha256 || reference.artifactBytes !== undefined && bytes.byteLength !== reference.artifactBytes) {
			throw new Error(`evaluator output artifact differs from its signed identity: ${reference.candidateId}/${reference.taskId}`)
		}
	}
}
