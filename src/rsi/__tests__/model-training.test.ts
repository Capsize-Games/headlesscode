import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { parseRsiArgs } from "../config.js"
import { runBoundedModelCandidate } from "../model-training.js"
import type { FleetJob, FleetJobPayload, PostgresRsiJobQueue } from "../postgres-queue.js"
import type { RsiRunRecord } from "../types.js"

class FakeModelQueue {
	artifactBackend = "s3"
	policy = { leaseMs: 20 * 60_000 }
	artifacts = new Map<string, Buffer>()
	jobs = new Map<string, FleetJob>()
	queued: FleetJob[] = []
	activeWorkerChecks = 0
	adapter = Buffer.from("bounded-test-adapter-archive")
	constructor(private readonly mode: "success" | "partial" | "failed" | "incomplete-pair" | "digest-mismatch" = "success", private readonly resources = ["TRAINING_GPU", "CPU"]) {}
	async activeWorkerCount(resource?: string) { this.activeWorkerChecks += 1; return resource ? Number(this.resources.includes(resource)) : 1 }
	async putArtifact(content: Buffer) {
		const sha256 = createHash("sha256").update(content).digest("hex")
		this.artifacts.set(sha256, Buffer.from(content))
		return { sha256, byteLength: content.byteLength }
	}
	async getArtifact(sha256: string) { const value = this.artifacts.get(sha256); if (!value) throw new Error("missing artifact"); return Buffer.from(value) }
	async getJobByIdempotencyKey(key: string) { return [...this.jobs.values()].find((job) => job.idempotencyKey === key) }
	async getJob(id: string) { return this.jobs.get(id) }
	async enqueue(input: { idempotencyKey: string; runId: string; candidateId: string; jobKind: FleetJob["jobKind"]; resourceClass: FleetJob["resourceClass"]; concurrencyKey?: string; artifactSha256: string; payload: FleetJobPayload }) {
		this.queued.push(input as unknown as FleetJob)
		let result: Record<string, unknown>
		if (input.jobKind === "training") {
			const modelTask = input.payload.modelTask!
			const complete = this.mode === "success" || this.mode === "incomplete-pair" || this.mode === "digest-mismatch"
			const fullTraining = Buffer.from(JSON.stringify({ schemaVersion: 1, status: this.mode === "failed" ? "failed" : complete ? "completed" : "partial", seed: 1337, maxSteps: 8, stepsCompleted: complete ? 8 : 3, baseModelId: modelTask.baseModelId, baseModelSha256: "a".repeat(64), adapterSha256: "c".repeat(64), datasetSha256: this.mode === "digest-mismatch" ? "f".repeat(64) : modelTask.datasetSha256, manifestSha256: modelTask.manifestSha256 }))
			const output = await this.putArtifact(fullTraining)
			const adapter = this.mode === "partial" || this.mode === "failed" || this.mode === "digest-mismatch" ? undefined : await this.putArtifact(this.adapter)
			result = { ok: true, modelResult: { ...JSON.parse(fullTraining.toString()), outputArtifactSha256: output.sha256, outputArtifactBytes: output.byteLength, ...(adapter ? { adapterArtifactSha256: adapter.sha256, adapterArtifactBytes: adapter.byteLength } : {}) } }
		} else {
			const modelTask = input.payload.modelTask!
			const evaluation = Buffer.from(JSON.stringify({
				schemaVersion: 1, status: "completed", modelKind: modelTask.modelKind, baseModelId: modelTask.baseModelId,
				seed: 1337, cellSet: this.mode === "incomplete-pair" && modelTask.modelKind === "adapter" ? modelTask.cellIds.slice(0, -1) : modelTask.cellIds, cellSetSha256: modelTask.cellSetSha256,
				cellsSha256: "b".repeat(64), baseModelSha256: "a".repeat(64), adapterSha256: modelTask.modelKind === "adapter" ? "c".repeat(64) : null,
				exactMatchRate: modelTask.modelKind === "adapter" ? 1 : 0.5,
				results: modelTask.cellIds.map((cellId, index) => ({ cellId, exactMatch: index !== 0, outputSha256: String(index + 1).padStart(64, "0"), preview: "bounded" })),
			}))
			const output = await this.putArtifact(evaluation)
			result = { ok: true, modelResult: { ...JSON.parse(evaluation.toString()), outputArtifactSha256: output.sha256, outputArtifactBytes: output.byteLength } }
		}
		const job = {
			jobId: `job-${this.queued.length}`, idempotencyKey: input.idempotencyKey, runId: input.runId,
			candidateId: input.candidateId, jobKind: input.jobKind, resourceClass: input.resourceClass,
			concurrencyKey: input.concurrencyKey, artifactSha256: input.artifactSha256, payload: input.payload,
			status: "completed", attempts: 1, maxAttempts: 1, leaseDurationMs: 120_000, result,
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		} as FleetJob
		this.jobs.set(job.jobId, job)
		return job
	}
}

function fixtureRepo(): { root: string; run: RsiRunRecord; config: NonNullable<ReturnType<typeof parseRsiArgs>["config"]>; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsi-model-pair-"))
	const previousBasePath = process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH
	const checkpointPath = path.join(root, "checkpoint")
	fs.mkdirSync(checkpointPath)
	fs.writeFileSync(path.join(checkpointPath, "config.json"), "{}")
	process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH = checkpointPath
	execFileSync("git", ["init", "-q", "-b", "main", root])
	execFileSync("git", ["-C", root, "config", "user.name", "Model test"])
	execFileSync("git", ["-C", root, "config", "user.email", "model-test@example.invalid"])
	fs.cpSync(path.join(process.cwd(), "fixtures", "rsi-curriculum"), path.join(root, "fixtures", "rsi-curriculum"), { recursive: true })
	execFileSync("git", ["-C", root, "add", "fixtures"])
	execFileSync("git", ["-C", root, "commit", "-qm", "verified fixtures"])
	const baseCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
	const config = parseRsiArgs(["--repo", root, "--archive-dir", path.join(root, ".archive"), "--base-ref", baseCommit]).config!
	const run: RsiRunRecord = { runId: "run-model-test", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), model: "worker-model", baseRef: baseCommit, baseCommit, generations: 1, candidates: [], reports: [] }
	return {
		root, run, config,
		cleanup: () => {
			if (previousBasePath === undefined) delete process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH
			else process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH = previousBasePath
			fs.rmSync(root, { recursive: true, force: true })
		},
	}
}

test("bounded model pipeline admits one training job and both paired OpenShell model cells before waiting", async () => {
	const { run, config, cleanup } = fixtureRepo()
	const queue = new FakeModelQueue()
	try {
		const candidate = await runBoundedModelCandidate(config, run, queue as unknown as PostgresRsiJobQueue, "candidate-qlora", "Qwen/local-7b@sha256:checkpoint")
		assert.equal(candidate.status, "accepted")
		assert.equal(candidate.eligibleForSelection, true)
		assert.equal(candidate.trainingResult?.stepsCompleted, 8)
		assert.equal(candidate.pairedEvaluation?.completedCellCount, candidate.pairedEvaluation?.expectedCellCount)
		assert.equal(candidate.pairedEvaluation?.seed, 1337)
		assert.equal(queue.queued.length, 3)
		assert.deepEqual(queue.queued.map((job) => job.jobKind), ["training", "model-evaluation", "model-evaluation"])
		assert.deepEqual(queue.queued.slice(1).map((job) => job.payload.modelTask?.cellIds), [queue.queued[1]!.payload.modelTask!.cellIds, queue.queued[1]!.payload.modelTask!.cellIds])
		assert.notEqual(queue.queued[1]?.artifactSha256, queue.queued[2]?.artifactSha256, "the adapter evaluation receives a different sealed snapshot")
		assert.equal(queue.queued[0]?.resourceClass, "TRAINING_GPU")
		assert.equal(queue.queued.slice(1).every((job) => job.resourceClass === "CPU"), true)
		assert.equal(run.modelCandidates?.[0]?.trainingResult?.datasetSha256, run.modelCandidates?.[0]?.provenance?.datasetSha256)
	} finally {
		cleanup()
	}
})

test("partial QLoRA execution is recorded and cannot become eligible", async () => {
	const { run, config, cleanup } = fixtureRepo()
	const queue = new FakeModelQueue("partial")
	try {
		const candidate = await runBoundedModelCandidate(config, run, queue as unknown as PostgresRsiJobQueue, "candidate-partial", "Qwen/local-7b@sha256:checkpoint")
		assert.equal(candidate.status, "partial")
		assert.equal(candidate.trainingResult?.stepsCompleted, 3)
		assert.equal(candidate.eligibleForSelection, false)
		assert.equal(queue.queued.length, 1, "partial training never admits paired evaluation")
	} finally {
		cleanup()
	}
})

test("model training refuses admission when no worker advertises TRAINING_GPU", async () => {
	const { run, config, cleanup } = fixtureRepo()
	const queue = new FakeModelQueue("success", ["CPU"])
	try {
		await assert.rejects(runBoundedModelCandidate(config, run, queue as unknown as PostgresRsiJobQueue, "no-gpu", "Qwen/local-7b@sha256:checkpoint"), /no fresh OpenShell worker advertises TRAINING_GPU/)
		assert.equal(queue.queued.length, 0)
	} finally {
		cleanup()
	}
})

test("GGUF base model is rejected before worker admission or job enqueue", async () => {
	const { root, run, config, cleanup } = fixtureRepo()
	const queue = new FakeModelQueue()
	const previous = process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH
	process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH = path.join(root, "Qwen3.5-9B-Q8_0.gguf")
	try {
		await assert.rejects(
			runBoundedModelCandidate(config, run, queue as unknown as PostgresRsiJobQueue, "gguf-candidate", "Qwen3.5-9B-Q8_0.gguf"),
			/GGUF base models are not supported.*No model job was enqueued/,
		)
		assert.equal(queue.activeWorkerChecks, 0)
		assert.equal(queue.queued.length, 0)
	} finally {
		if (previous === undefined) delete process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH
		else process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH = previous
		cleanup()
	}
})

test("GGUF model identity is rejected when the path variable is unset", async () => {
	const { run, config, cleanup } = fixtureRepo()
	const queue = new FakeModelQueue()
	try {
		delete process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH
		await assert.rejects(
			runBoundedModelCandidate(config, run, queue as unknown as PostgresRsiJobQueue, "gguf-identity", "/models/Qwen3.5-9B-Q8_0.gguf"),
			/GGUF base models are not supported.*No model job was enqueued/,
		)
		assert.equal(queue.activeWorkerChecks, 0)
		assert.equal(queue.queued.length, 0)
	} finally {
		cleanup()
	}
})

test("missing coordinator base-model path fails before worker admission or enqueue", async () => {
	const { run, config, cleanup } = fixtureRepo()
	const queue = new FakeModelQueue()
	try {
		delete process.env.HEADLESSCODE_RSI_BASE_MODEL_PATH
		await assert.rejects(
			runBoundedModelCandidate(config, run, queue as unknown as PostgresRsiJobQueue, "missing-model-path", "Qwen/local-7b@sha256:checkpoint"),
			/HEADLESSCODE_RSI_BASE_MODEL_PATH is required on the coordinator and model workers; no model job was enqueued/,
		)
		assert.equal(queue.activeWorkerChecks, 0)
		assert.equal(queue.queued.length, 0)
	} finally {
		cleanup()
	}
})

test("failed training and incomplete paired evaluation remain ineligible", async () => {
	for (const [mode, expected] of [["failed", "failed"], ["incomplete-pair", "partial"], ["digest-mismatch", "failed"]] as const) {
		const { run, config, cleanup } = fixtureRepo()
		const queue = new FakeModelQueue(mode)
		try {
			const candidate = await runBoundedModelCandidate(config, run, queue as unknown as PostgresRsiJobQueue, `candidate-${mode}`, "Qwen/local-7b@sha256:checkpoint")
			assert.equal(candidate.status, expected, `mode=${mode}`)
			assert.equal(candidate.eligibleForSelection, false)
			assert.notEqual(candidate.status, "accepted")
			if (mode === "incomplete-pair") assert.equal(queue.queued.length, 3)
			if (mode !== "incomplete-pair") assert.equal(queue.queued.length, 1)
		} finally {
			cleanup()
		}
	}
})
