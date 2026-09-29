import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { appendRun, checkpointRun } from "./archive.js"
import { createModelJobSnapshotBundle } from "./openshell.js"
import { fleetJobMatches, requiredFleetJobLeaseMs, type FleetJob, type FleetJobIdentity, type FleetJobPayload, type PostgresRsiJobQueue } from "./postgres-queue.js"
import { buildVerifiedTrainingDataset } from "./training-data.js"
import type { CandidateRecord, ModelCandidate, RsiConfig, RsiRunRecord } from "./types.js"

const SEED = 1337
const CELL_IDS = ["generalization:negative number", "generalization:positive numeric string", "generalization:zero string"]

function digest(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex")
}

function modelCandidateId(value: string): string {
	if (!/^[A-Za-z0-9._-]{1,80}$/.test(value)) throw new Error("model candidate id must contain only letters, numbers, dot, underscore, or dash")
	return value
}

function modelJobPayload(config: RsiConfig, candidate: CandidateRecord, snapshot: { content: Buffer; snapshotCommit: string }, artifactSha256: string, task: NonNullable<FleetJobPayload["modelTask"]>): FleetJobPayload {
	return {
		schemaVersion: 1,
		snapshotSha256: artifactSha256,
		snapshotBytes: snapshot.content.byteLength,
		snapshotCommit: snapshot.snapshotCommit,
		task: "Run the fixed offline RSI model training/evaluation program.",
		model: candidate.model,
		maxIterations: 1,
		timeoutMs: config.commandTimeoutMs,
		protectedPaths: config.protectedPaths,
		candidate: { id: candidate.id, generation: 0, parent: "base", modelCandidateId: task.modelCandidateId, computePolicy: "single" },
		regressionCommand: "true",
		evalCommands: [],
		modelTask: task,
	}
}

async function waitForModelJob(queue: PostgresRsiJobQueue, jobId: string, timeoutMs: number): Promise<FleetJob> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const job = await queue.getJob(jobId)
		if (!job) throw new Error(`model job ${jobId} disappeared`)
		if (["completed", "failed", "cancelled"].includes(job.status)) return job
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	// Keep a live lease and capacity reserved until the OpenShell worker confirms
	// teardown or the lease expires. The coordinator does not clear it on timeout.
	throw new Error(`model job ${jobId} exceeded coordinator wait timeout`)
}

function assertModelJob(job: FleetJob, expected: FleetJobIdentity): void {
	if (!fleetJobMatches(job, expected)) {
		throw new Error("existing model job idempotency key refers to a different payload or artifact")
	}
}

function readJsonArtifact(queue: PostgresRsiJobQueue, sha256: string, bytes: number): Promise<Record<string, unknown>> {
	return queue.getArtifact(sha256).then((content) => {
		if (content.byteLength !== bytes) throw new Error("model result artifact length differs from its recorded metadata")
		return JSON.parse(content.toString("utf8")) as Record<string, unknown>
	})
}

function completedModelResult(job: FleetJob): Record<string, unknown> {
	if (job.status !== "completed" || !job.result || typeof job.result !== "object") throw new Error(job.error ?? `model job ended ${job.status}`)
	const result = job.result as { modelResult?: unknown }
	if (!result.modelResult || typeof result.modelResult !== "object") throw new Error("completed model job has no bounded result record")
	return result.modelResult as Record<string, unknown>
}

function validatePairedResult(result: Record<string, unknown>, modelKind: "base" | "adapter", dataset: ReturnType<typeof buildVerifiedTrainingDataset>, baseModelId: string): { exactMatchRate: number; outputSha256: string; resultSha256: string; baseModelSha256: string; adapterSha256?: string } {
	if (result.status !== "completed" || result.modelKind !== modelKind || result.seed !== SEED || result.cellSetSha256 !== digest(Buffer.from([...dataset.evaluationCellIds].sort().join("\n")))) {
		throw new Error(`${modelKind} evaluation did not complete the fixed seed and cell set`)
	}
	if (result.baseModelId !== baseModelId) throw new Error(`${modelKind} evaluation used a different configured base model identity`)
	if (!Array.isArray(result.cellSet) || JSON.stringify([...result.cellSet].sort()) !== JSON.stringify([...dataset.evaluationCellIds].sort())) throw new Error(`${modelKind} evaluation cell set is incomplete or changed`)
	if (!Array.isArray(result.results) || result.results.length !== dataset.evaluationCellIds.length) throw new Error(`${modelKind} evaluation omitted one or more paired cells`)
	const ids = result.results.map((item) => item && typeof item === "object" ? (item as { cellId?: unknown }).cellId : undefined)
	if (JSON.stringify([...ids].sort()) !== JSON.stringify([...dataset.evaluationCellIds].sort())) throw new Error(`${modelKind} evaluation result IDs differ from the registered harness cells`)
	const metric = result.exactMatchRate
	if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0 || metric > 1) throw new Error(`${modelKind} evaluation metric is invalid`)
	const outputs = result.results.map((item) => (item as { outputSha256?: unknown }).outputSha256)
	if (outputs.some((value) => typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))) throw new Error(`${modelKind} evaluation output digest is invalid`)
	const baseModelSha256 = String(result.baseModelSha256 ?? "")
	if (!/^[0-9a-f]{64}$/.test(baseModelSha256)) throw new Error(`${modelKind} evaluation omitted base model provenance`)
	const adapterSha256 = modelKind === "adapter" ? String(result.adapterSha256 ?? "") : undefined
	if (modelKind === "adapter" && !/^[0-9a-f]{64}$/.test(adapterSha256!)) throw new Error("adapter evaluation omitted adapter digest provenance")
	return { exactMatchRate: metric, outputSha256: digest(JSON.stringify(outputs)), resultSha256: String(result.resultSha256 ?? ""), baseModelSha256, ...(adapterSha256 ? { adapterSha256 } : {}) }
}

/** Enqueue bounded OpenShell QLoRA training and paired base/adapter model evaluation. */
export async function runBoundedModelCandidate(config: RsiConfig, run: RsiRunRecord, queue: PostgresRsiJobQueue, id: string, baseModelId = process.env.HEADLESSCODE_RSI_BASE_MODEL_ID?.trim() ?? ""): Promise<ModelCandidate> {
	if (config.dryRun) throw new Error("model training does not support dry-run mode")
	if (queue.artifactBackend !== "s3") throw new Error("model training requires the shared S3-compatible RSI artifact store")
	const configuredBasePath = process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH?.trim() ?? ""
	if (/\.gguf$/i.test(configuredBasePath) || /\.gguf$/i.test(baseModelId)) {
		throw new Error("GGUF base models are not supported by the current QLoRA runner: Transformers GGUF loading cannot be combined with bitsandbytes training, and the paired evaluator requires a Hugging Face checkpoint. No model job was enqueued.")
	}
	if (!configuredBasePath) throw new Error("HEADLESSCODE_RSI_BASE_MODEL_PATH is required on the coordinator and model workers; no model job was enqueued")
	if (await queue.activeWorkerCount("TRAINING_GPU") < 1) throw new Error("no fresh OpenShell worker advertises TRAINING_GPU; model training was not enqueued")
	if (await queue.activeWorkerCount("CPU") < 1) throw new Error("no fresh OpenShell worker advertises CPU; paired model evaluation was not enqueued")
	const candidateId = modelCandidateId(id)
	if (!/^[A-Za-z0-9._:@/-]{1,180}$/.test(baseModelId)) throw new Error("HEADLESSCODE_RSI_BASE_MODEL_ID must identify the operator-provided local Hugging Face checkpoint")
	const existing = run.modelCandidates?.find((entry) => entry.id === candidateId)
	if (existing?.eligibleForSelection) throw new Error(`model candidate ${candidateId} is already eligible and cannot be retrained in place`)
	const model: ModelCandidate = existing ?? {
		id: candidateId,
		parentModel: baseModelId,
		trainingMethod: "qlora",
		datasetVersion: undefined,
		trainingConfig: { method: "qlora", seed: SEED, parameters: { maxSteps: 8, rank: 8, alpha: 16, dropout: 0.05, quantization: "nf4-double" } },
		status: "prepared",
		createdAt: new Date().toISOString(),
		eligibleForSelection: false,
		provenance: {},
	}
	run.modelCandidates ??= []
	if (!existing) run.modelCandidates.push(model)
	const candidate: CandidateRecord = {
		id: `model-${candidateId}`,
		generation: 0,
		parent: "base",
		branch: `rsi-model-${candidateId}`,
		worktree: config.repoRoot,
		baseCommit: run.baseCommit,
		status: "evaluating",
		model: config.model,
		mutation: "Run bounded QLoRA model candidate",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		commits: [],
		changedFiles: [],
		protectedPathViolations: [],
		modelCandidateId: candidateId,
	}
	try {
		const dataset = buildVerifiedTrainingDataset(config.repoRoot)
		model.datasetVersion = dataset.version
		model.provenance = { datasetSha256: dataset.datasetSha256, manifestSha256: dataset.manifestSha256, evaluationCellsSha256: dataset.evaluationCellsSha256, seed: String(SEED), maxSteps: "8", image: "headlesscode-openshell-rsi-training:local", baseModelId }
		await checkpointRun(config.archiveDir, run)
		const trainingSnapshot = createModelJobSnapshotBundle(config.repoRoot, run.baseCommit, config, { dataset: dataset.dataset, manifest: dataset.manifest, cells: dataset.evaluationCells })
		const trainingArtifact = await queue.putArtifact(trainingSnapshot.content)
		const trainingTask: NonNullable<FleetJobPayload["modelTask"]> = {
			kind: "qlora-train", datasetVersion: dataset.version, datasetSha256: dataset.datasetSha256,
			manifestSha256: dataset.manifestSha256, baseModelId, baseModelPath: "/workspace/.rsi-base-model", seed: SEED,
			maxSteps: 8, modelCandidateId: candidateId,
			cellSetSha256: digest(Buffer.from([...dataset.evaluationCellIds].sort().join("\n"))), cellIds: [...dataset.evaluationCellIds].sort(),
		}
		const trainingExpected = {
			idempotencyKey: `${run.runId}:${candidateId}:qlora-train`, runId: run.runId, candidateId: `model-${candidateId}`,
			jobKind: "training" as const, resourceClass: "TRAINING_GPU" as const, concurrencyKey: `training:${config.model}`,
			artifactSha256: trainingArtifact.sha256,
			payload: modelJobPayload(config, candidate, trainingSnapshot, trainingArtifact.sha256, trainingTask),
		}
		let trainingJob = await queue.getJobByIdempotencyKey(trainingExpected.idempotencyKey)
		if (!trainingJob) trainingJob = await queue.enqueue(trainingExpected)
		assertModelJob(trainingJob, trainingExpected)
		const trainingCompleted = await waitForModelJob(queue, trainingJob.jobId, requiredFleetJobLeaseMs("training", config.commandTimeoutMs) + 60_000)
		const trainResult = completedModelResult(trainingCompleted)
		const status = trainResult.status
		if (status !== "completed") {
			model.status = status === "partial" ? "partial" : "failed"
			model.trainingResult = { status: model.status, datasetVersion: dataset.version, datasetSha256: dataset.datasetSha256, baseModelSha256: String(trainResult.baseModelSha256 ?? ""), stepsCompleted: Number(trainResult.stepsCompleted ?? 0), maxSteps: 8, error: String(trainResult.error ?? "training did not complete") }
			model.eligibleForSelection = false
			model.provenance.trainingJobId = trainingJob.jobId
			await checkpointRun(config.archiveDir, run)
			if (run.finishedAt) await appendRun(config.archiveDir, run)
			return model
		}
		const resultArtifactSha = String(trainResult.outputArtifactSha256 ?? "")
		const resultArtifactBytes = Number(trainResult.outputArtifactBytes)
		if (!/^[0-9a-f]{64}$/.test(resultArtifactSha) || !Number.isSafeInteger(resultArtifactBytes) || resultArtifactBytes < 1) throw new Error("training result artifact reference is invalid")
		const fullTrainingResult = await readJsonArtifact(queue, resultArtifactSha, resultArtifactBytes)
		const baseModelSha256 = String(fullTrainingResult.baseModelSha256 ?? "")
		if (fullTrainingResult.status !== "completed" || fullTrainingResult.datasetSha256 !== dataset.datasetSha256 || fullTrainingResult.manifestSha256 !== dataset.manifestSha256 || fullTrainingResult.baseModelId !== baseModelId || fullTrainingResult.stepsCompleted !== 8 || !/^[0-9a-f]{64}$/.test(baseModelSha256)) throw new Error("training artifact does not prove complete execution against the verified dataset and base model")
		const adapterSha = String(trainResult.adapterArtifactSha256 ?? "")
		const adapterBytes = Number(trainResult.adapterArtifactBytes)
		if (!/^[0-9a-f]{64}$/.test(adapterSha) || !Number.isSafeInteger(adapterBytes) || adapterBytes < 1) throw new Error("trained adapter artifact reference is invalid")
		const adapterArchive = await queue.getArtifact(adapterSha)
		if (adapterArchive.byteLength !== adapterBytes || digest(adapterArchive) !== adapterSha) throw new Error("trained adapter artifact failed content digest verification")
		model.status = "trained"
		model.artifactHash = adapterSha
		model.artifactPath = `sha256:${adapterSha}`
		model.trainingResult = { status: "completed", datasetVersion: dataset.version, datasetSha256: dataset.datasetSha256, baseModelSha256, artifactSha256: adapterSha, artifactBytes: adapterBytes, stepsCompleted: 8, maxSteps: 8 }
		model.provenance.trainingJobId = trainingJob.jobId
		await checkpointRun(config.archiveDir, run)

		const pair = [] as Array<{ kind: "base" | "adapter"; job: FleetJob; result: Record<string, unknown> }>
		for (const kind of ["base", "adapter"] as const) {
			const snapshot = createModelJobSnapshotBundle(config.repoRoot, run.baseCommit, config, { dataset: dataset.dataset, manifest: dataset.manifest, cells: dataset.evaluationCells, ...(kind === "adapter" ? { adapterArchive } : {}) })
			const artifact = await queue.putArtifact(snapshot.content)
			const modelTask: NonNullable<FleetJobPayload["modelTask"]> = {
				kind: "model-evaluation", datasetVersion: dataset.version, datasetSha256: dataset.datasetSha256,
				manifestSha256: dataset.manifestSha256, baseModelId, baseModelPath: "/workspace/.rsi-base-model", seed: SEED,
				modelCandidateId: candidateId, adapterPath: kind === "adapter" ? "/workspace/.headlesscode-rsi-model/adapter.tar" : undefined,
				modelKind: kind, cellSetSha256: trainingTask.cellSetSha256, cellIds: trainingTask.cellIds,
			}
			const expected = {
				idempotencyKey: `${run.runId}:${candidateId}:paired-${kind}`, runId: run.runId, candidateId: `model-${candidateId}`,
				jobKind: "model-evaluation" as const, resourceClass: "CPU" as const, concurrencyKey: `model-eval:${candidateId}:${kind}`,
				artifactSha256: artifact.sha256, payload: modelJobPayload(config, candidate, snapshot, artifact.sha256, modelTask),
			}
			let job = await queue.getJobByIdempotencyKey(expected.idempotencyKey)
			if (!job) job = await queue.enqueue(expected)
			assertModelJob(job, expected)
			pair.push({ kind, job, result: {} })
		}
		// Both cells are admitted before waiting, allowing independent CPU workers to run them concurrently.
		for (const entry of pair) {
			const completed = await waitForModelJob(queue, entry.job.jobId, requiredFleetJobLeaseMs("model-evaluation", config.commandTimeoutMs) + 60_000)
			const bounded = completedModelResult(completed)
			const resultSha = String(bounded.outputArtifactSha256 ?? "")
			const resultBytes = Number(bounded.outputArtifactBytes)
			if (!/^[0-9a-f]{64}$/.test(resultSha) || !Number.isSafeInteger(resultBytes) || resultBytes < 1) throw new Error(`${entry.kind} paired result has no verified artifact reference`)
			const full = await readJsonArtifact(queue, resultSha, resultBytes)
			entry.result = { ...full, resultSha256: resultSha }
		}
		const baseEval = validatePairedResult(pair[0]!.result, "base", dataset, baseModelId)
		const adapterEval = validatePairedResult(pair[1]!.result, "adapter", dataset, baseModelId)
		if (baseEval.baseModelSha256 !== baseModelSha256 || adapterEval.baseModelSha256 !== baseModelSha256) throw new Error("paired evaluations did not use the exact checkpoint used for training")
		if (adapterEval.adapterSha256 !== fullTrainingResult.adapterSha256) throw new Error("paired adapter evaluation digest differs from the trained adapter artifact")
		model.pairedEvaluation = {
			cellSetSha256: trainingTask.cellSetSha256,
			baseResultSha256: baseEval.resultSha256 || baseEval.outputSha256,
			adapterResultSha256: adapterEval.resultSha256 || adapterEval.outputSha256,
			baseMetric: baseEval.exactMatchRate,
			adapterMetric: adapterEval.exactMatchRate,
			completedCellCount: dataset.evaluationCellIds.length,
			expectedCellCount: dataset.evaluationCellIds.length,
			seed: SEED,
		}
		model.provenance.baseEvaluationJobId = pair[0]!.job.jobId
		model.provenance.adapterEvaluationJobId = pair[1]!.job.jobId
		model.provenance.baseOutputSha256 = baseEval.outputSha256
		model.provenance.adapterOutputSha256 = adapterEval.outputSha256
		model.provenance.adapterTreeSha256 = adapterEval.adapterSha256!
		model.status = adapterEval.exactMatchRate > baseEval.exactMatchRate ? "accepted" : "rejected"
		model.eligibleForSelection = model.status === "accepted"
		await checkpointRun(config.archiveDir, run)
		if (run.finishedAt) await appendRun(config.archiveDir, run)
		return model
	} catch (error) {
		model.status = model.status === "trained" ? "partial" : "failed"
		model.eligibleForSelection = false
		model.provenance = { ...(model.provenance ?? {}), failure: error instanceof Error ? error.message : String(error) }
		model.trainingResult ??= { status: model.status, datasetVersion: model.datasetVersion ?? "unavailable", datasetSha256: model.provenance.datasetSha256 ?? "", baseModelSha256: "", stepsCompleted: 0, maxSteps: 8, error: model.provenance.failure }
		await checkpointRun(config.archiveDir, run)
		if (run.finishedAt) await appendRun(config.archiveDir, run)
		return model
	}
}

export function currentModelBaseCommit(repoRoot: string, baseRef: string): string {
	return execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: repoRoot, encoding: "utf8" }).trim()
}
