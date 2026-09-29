import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { checkpointRun } from "../archive.js"
import { runRsi } from "../controller.js"
import { createMutationSnapshotBundle } from "../openshell.js"
import type { FleetJob, FleetJobPayload, PostgresRsiJobQueue } from "../postgres-queue.js"
import { newCandidate } from "../workspace.js"
import type { CandidateRecord, RsiConfig, RsiRunRecord, TrialResult } from "../types.js"

class FakeFleetQueue {
	artifactBackend = "s3"
	policy = { maxInFlight: 2, leaseMs: 60_000, maxAttempts: 2 }
	artifacts = new Map<string, Buffer>()
	jobs = new Map<string, FleetJob>()
	keys = new Map<string, string>()
	evaluationJobCount = 0
	firstCandidateEvaluationObserved = false
	closeCount = 0
	mutationJobCount = 0
	readonly expectedCandidateEvaluations: number
	readonly failAfterFirstArtifact: boolean
	readonly invalidCandidateTrial: boolean
	readonly adaptiveMixed: boolean
	readonly failRegressionForCandidates: boolean
	readonly staleCurriculumReplayKey: boolean
	readonly failAdversarial: boolean
	staleFastPath?: "baseline" | "mutation" | "evaluation"
	adversarialEvaluationJobCount = 0

	constructor(expectedCandidateEvaluations: number, failAfterFirstArtifact = false, invalidCandidateTrial = false, adaptiveMixed = false, failRegressionForCandidates = false, staleCurriculumReplayKey = false, failAdversarial = false) {
		this.expectedCandidateEvaluations = expectedCandidateEvaluations
		this.failAfterFirstArtifact = failAfterFirstArtifact
		this.invalidCandidateTrial = invalidCandidateTrial
		this.adaptiveMixed = adaptiveMixed
		this.failRegressionForCandidates = failRegressionForCandidates
		this.staleCurriculumReplayKey = staleCurriculumReplayKey
		this.failAdversarial = failAdversarial
	}

	async migrate(): Promise<void> {}
	async activeWorkerCount(): Promise<number> { return 2 }
	async close(): Promise<void> { this.closeCount += 1 }

	async putArtifact(content: Buffer): Promise<{ sha256: string; byteLength: number }> {
		if (this.failAfterFirstArtifact && this.artifacts.size > 0) throw new Error("simulated artifact-store failure")
		const sha256 = createHash("sha256").update(content).digest("hex")
		this.artifacts.set(sha256, Buffer.from(content))
		return { sha256, byteLength: content.byteLength }
	}

	async getArtifact(sha256: string): Promise<Buffer> {
		const value = this.artifacts.get(sha256)
		if (!value) throw new Error("missing fake artifact")
		return Buffer.from(value)
	}

	async getJobByIdempotencyKey(key: string): Promise<FleetJob | undefined> {
		const matchesStalePath = this.staleFastPath === "baseline"
			? key.endsWith(":baseline:evaluation")
			: this.staleFastPath === "mutation"
				? key.endsWith(":mutation")
				: this.staleFastPath === "evaluation" && key.endsWith(":evaluation") && !key.endsWith(":baseline:evaluation")
		if (matchesStalePath) {
			const candidateId = this.staleFastPath === "baseline" ? "baseline" : key.slice(key.indexOf(":") + 1, key.lastIndexOf(":"))
			const jobKind = this.staleFastPath === "mutation" ? "mutation" : "evaluation"
			return {
				jobId: randomUUID(), idempotencyKey: key, runId: key.slice(0, key.indexOf(":")), candidateId,
				jobKind, resourceClass: jobKind === "mutation" ? "LOCAL_GPU" : "CPU", concurrencyKey: "stale-route",
				artifactSha256: "f".repeat(64), payload: { schemaVersion: 1, task: "stale" } as FleetJobPayload,
				status: "completed", attempts: 1, maxAttempts: 2, leaseDurationMs: 60_000, result: {},
				createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			}
		}
		if (this.staleCurriculumReplayKey && key.includes(":curriculum:") && key.includes(":replay:")) {
			const existingId = this.keys.get(key)
			if (existingId) return this.jobs.get(existingId)
			const jobId = randomUUID()
			const stale: FleetJob = {
				jobId, idempotencyKey: key, runId: "wrong-run", candidateId: "completion-discipline-replay-1",
				jobKind: "evaluation", resourceClass: "CPU", artifactSha256: "f".repeat(64),
				payload: {} as FleetJobPayload, status: "completed", attempts: 1, maxAttempts: 2,
				leaseDurationMs: 60_000, result: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			}
			this.keys.set(key, jobId)
			this.jobs.set(jobId, stale)
			return stale
		}
		const id = this.keys.get(key)
		return id ? this.jobs.get(id) : undefined
	}

	async getJob(jobId: string): Promise<FleetJob | undefined> {
		const job = this.jobs.get(jobId)
		if (job?.jobKind === "evaluation" && job.candidateId !== "baseline" && !this.firstCandidateEvaluationObserved) {
			assert.equal(this.evaluationJobCount, this.expectedCandidateEvaluations, "all candidate evaluation jobs must be queued before the coordinator waits")
			this.firstCandidateEvaluationObserved = true
		}
		return job
	}

	async enqueue(input: { idempotencyKey: string; runId: string; candidateId: string; jobKind: FleetJob["jobKind"]; resourceClass: FleetJob["resourceClass"]; concurrencyKey?: string; artifactSha256: string; payload: FleetJobPayload }): Promise<FleetJob> {
		const existing = await this.getJobByIdempotencyKey(input.idempotencyKey)
		if (existing) return existing
		const jobId = randomUUID()
		let result: Record<string, unknown>
		if (input.jobKind === "mutation") {
			this.mutationJobCount += 1
			const bundle = this.artifacts.get(input.artifactSha256)
			assert.ok(bundle)
			const temp = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-fake-fleet-mutation-"))
			try {
				const bundlePath = path.join(temp, "snapshot.bundle")
				const repo = path.join(temp, "repo")
				await fs.writeFile(bundlePath, bundle)
				execFileSync("git", ["clone", "--quiet", bundlePath, repo], { cwd: temp })
				execFileSync("git", ["config", "user.name", "Test"], { cwd: repo })
				execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo })
				await fs.writeFile(path.join(repo, "src", "agent.ts"), `// ${input.candidateId}\nexport function candidateBehavior(value) { return value }\n`)
				execFileSync("git", ["add", "--all"], { cwd: repo })
				execFileSync("git", ["commit", "--quiet", "-m", "fake worker candidate"], { cwd: repo })
				const patch = execFileSync("git", ["diff", "--binary", "--no-renames", `${input.payload.snapshotCommit}...HEAD`], { cwd: repo })
				const artifact = await this.putArtifact(patch)
				result = { ok: true, patchSha256: artifact.sha256, patchBytes: artifact.byteLength }
			} finally {
				await fs.rm(temp, { recursive: true, force: true })
			}
		} else {
			const adversarial = input.candidateId.endsWith("-adversarial")
			if (adversarial) {
				this.adversarialEvaluationJobCount += 1
				assert.deepEqual(input.payload.evalCommands, ["node --import tsx __headlesscode_rsi_adversarial__/runner.mjs"])
				const bundle = this.artifacts.get(input.artifactSha256)
				assert.ok(bundle)
			} else this.evaluationJobCount += input.candidateId === "baseline" ? 0 : 1
			const output = await this.putArtifact(Buffer.from(JSON.stringify([{ stdout: "", stderr: "" }])))
			const visibleOkay = adversarial ? !this.failAdversarial : this.adaptiveMixed
				? input.candidateId !== "baseline" && !input.candidateId.includes("c02-")
				: input.candidateId !== "baseline"
			const trial = (ok: boolean, command: string): TrialResult => ({
				ok,
				command,
				exitCode: ok ? 0 : 1,
				durationMs: this.invalidCandidateTrial && input.candidateId !== "baseline" ? Number.NaN : 1,
				stdout: adversarial && ok ? "PASS adversary-case\n" : "",
				stderr: "",
				outputArtifactSha256: output.sha256,
				outputArtifactBytes: output.byteLength,
			})
			result = {
				ok: true,
				evaluation: {
					regression: trial(!this.failRegressionForCandidates || input.candidateId === "baseline", "regression"),
					visible: [trial(visibleOkay, "visible")],
				},
				outputArtifact: { sha256: output.sha256, bytes: output.byteLength },
			}
		}
		const job: FleetJob = {
			jobId,
			idempotencyKey: input.idempotencyKey,
			runId: input.runId,
			candidateId: input.candidateId,
			jobKind: input.jobKind,
			resourceClass: input.resourceClass,
			...(input.concurrencyKey ? { concurrencyKey: input.concurrencyKey } : {}),
			artifactSha256: input.artifactSha256,
			payload: input.payload,
			status: "completed",
			attempts: 1,
			maxAttempts: 2,
			leaseDurationMs: 60_000,
			result,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}
		this.jobs.set(jobId, job)
		this.keys.set(input.idempotencyKey, jobId)
		return job
	}
}

async function setup(): Promise<{ root: string; config: RsiConfig }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-controller-fleet-"))
	execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root })
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root })
	execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root })
	await fs.mkdir(path.join(root, "src"), { recursive: true })
	await fs.writeFile(path.join(root, "src", "agent.ts"), "export const baseline = true\n")
	await fs.cp(path.join(process.cwd(), "fixtures", "rsi-curriculum"), path.join(root, "fixtures", "rsi-curriculum"), { recursive: true })
	execFileSync("git", ["add", "."], { cwd: root })
	execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root })
	const config = {
		repoRoot: root,
		model: "local-test-model",
		population: 2,
		generations: 1,
		maxConcurrent: 2,
		mutationTask: "make a focused test change",
		regressionCommand: "regression",
		evalCommands: ["visible"],
		hiddenEvalCommands: [],
		archiveDir: path.join(root, ".headlesscode", "archive"),
		worktreeDir: path.join(root, ".worktrees", "rsi"),
		baseRef: "HEAD",
		seed: "fleet-controller-test",
		dryRun: false,
		keepWorktrees: false,
		maxIterations: 2,
		protectedPaths: [".headlesscode/", ".worktrees/"],
		commandTimeoutMs: 1000,
	} satisfies RsiConfig
	return { root, config }
}

test("fleet controller queues baseline and all candidate evaluations before waiting", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2)
	try {
		const run = await runRsi(config, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		assert.equal(run.candidates.filter((candidate) => candidate.status === "accepted").length, 2)
		assert.equal(queue.evaluationJobCount, 2)
		assert.equal(queue.firstCandidateEvaluationObserved, true)
		assert.equal(queue.closeCount, 1)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("fleet baseline resume rejects a stale idempotency row before waiting", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(1)
	queue.staleFastPath = "baseline"
	try {
		await assert.rejects(runRsi(config, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue), /baseline evaluation idempotency key has mismatched execution identity or payload/)
		assert.equal(queue.evaluationJobCount, 0)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("fleet mutation resume rejects a stale snapshot/task row before dispatch", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(1)
	queue.staleFastPath = "mutation"
	try {
		await assert.rejects(runRsi(config, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue), /mutation job has mismatched execution identity, snapshot, or task payload/)
		assert.equal(queue.mutationJobCount, 0, "a mismatched existing row must not be executed or replaced")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("fleet evaluation resume rejects stale eval configuration and routing", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(1)
	queue.staleFastPath = "evaluation"
	try {
		const run = await runRsi(config, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		assert.equal(run.candidates[0]?.status, "failed")
		assert.match(run.candidates[0]?.failure ?? "", /evaluation job has mismatched execution identity, snapshot, or evaluation configuration/)
		assert.equal(queue.evaluationJobCount, 0, "the stale row is rejected before worker dispatch")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

function adversarialResponse(findings: Array<{ severity: "major" | "minor"; message: string; testId?: string }> = []): string {
	return JSON.stringify({
		summary: "Check the changed behavior at a boundary value.",
		findings,
		tests: [{ id: "adversary-case", modulePath: "src/agent.ts", exportName: "candidateBehavior", args: [1], expected: 1, reason: "The exported behavior should preserve its input." }],
	})
}

test("fleet adversarial replay failure rejects candidate and closes the adversarial hard gate", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2, false, false, false, false, false, true)
	try {
		const run = await runRsi({
			...config,
			roles: { worker: { provider: "ollama", model: "worker-model" }, adversary: { provider: "openrouter", model: "review-model" } },
		}, { log: () => undefined, runAdversary: async () => adversarialResponse() }, queue as unknown as PostgresRsiJobQueue)
		assert.ok(run.candidates.every((candidate) => candidate.status === "rejected"))
		assert.ok(run.candidates.every((candidate) => candidate.fitness?.score === 0 && candidate.fitness.hardGates.adversarialPass === false))
		assert.equal(run.adversarialReviews?.length, 2)
		assert.ok(run.adversarialReviews?.every((review) => review.status === "failed" && review.testResults.length === 1 && !review.testResults[0]?.passed))
		assert.equal(queue.adversarialEvaluationJobCount, 2)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("fleet adversarial major finding records a bounded penalty when its OpenShell test passes", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2)
	try {
		const run = await runRsi({
			...config,
			roles: { worker: { provider: "ollama", model: "worker-model" }, adversary: { provider: "openrouter", model: "review-model" } },
		}, { log: () => undefined, runAdversary: async () => adversarialResponse([{ severity: "major", message: "A boundary case may be mishandled.", testId: "adversary-case" }]) }, queue as unknown as PostgresRsiJobQueue)
		assert.ok(run.candidates.every((candidate) => candidate.status === "accepted"))
		assert.ok(run.candidates.every((candidate) => candidate.fitness?.hardGates.adversarialPass === true && candidate.fitness.adversarialPenalty === 5 && candidate.fitness.score === 95))
		assert.equal(run.adversarialReviews?.length, 2)
		assert.ok(run.adversarialReviews?.every((review) => review.status === "passed" && review.findings[0]?.severity === "major" && review.penaltyPoints === 5 && review.testResults[0]?.passed))
		assert.ok(run.adversarialReviews?.every((review) => review.provider === "openrouter" && review.model === "review-model" && review.promptArtifactSha256 && review.resultArtifactSha256 && review.testArtifactSha256 && review.snapshotArtifactSha256 && review.jobId))
		assert.equal(queue.adversarialEvaluationJobCount, 2)
		const report = await fs.readFile(run.reports[0]!, "utf8")
		assert.match(report, /Adversarial review/)
		assert.match(report, /provider=openrouter; model=review-model/)
		assert.match(report, /promptVersion=rsi-adversary-tests-v1/)
		assert.match(report, /findings=major:A boundary case may be mishandled\./)
		assert.match(report, /penalty=5/)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("adversarial role with same model name on a different provider is not cross-model supervision", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2)
	let reviewerCalled = false
	try {
		const run = await runRsi({
			...config,
			roles: { worker: { provider: "ollama", model: "shared-model-name" }, adversary: { provider: "openrouter", model: "shared-model-name" } },
		}, { log: () => undefined, runAdversary: async () => { reviewerCalled = true; return adversarialResponse() } }, queue as unknown as PostgresRsiJobQueue)
		assert.equal(reviewerCalled, false)
		assert.ok(run.candidates.every((candidate) => candidate.status === "rejected" && candidate.fitness?.hardGates.adversarialPass === false))
		assert.ok(run.adversarialReviews?.every((review) => review.status === "error" && /different model/.test(review.error ?? "")))
		assert.equal(queue.adversarialEvaluationJobCount, 0)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("malformed adversary response preserves provider result provenance separately from parse error", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2)
	const rawResponse = "{not-json"
	try {
		const run = await runRsi({
			...config,
			roles: { worker: { provider: "ollama", model: "worker-model" }, adversary: { provider: "openrouter", model: "review-model" } },
		}, { log: () => undefined, runAdversary: async () => rawResponse }, queue as unknown as PostgresRsiJobQueue)
		assert.ok(run.adversarialReviews?.every((review) => review.status === "error" && review.resultArtifactSha256 && review.resultSha256 && review.errorArtifactSha256 && review.errorSha256))
		for (const review of run.adversarialReviews ?? []) {
			assert.equal((await queue.getArtifact(review.resultArtifactSha256!)).toString("utf8"), rawResponse)
			assert.match((await queue.getArtifact(review.errorArtifactSha256!)).toString("utf8"), /strict JSON/)
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("fleet controller validates curriculum fixtures only through repeatable OpenShell evaluation jobs", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2, false, false, false, true)
	try {
		const run = await runRsi(config, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		const task = run.curriculumTasks?.[0]
		assert.ok(task)
		assert.equal(task.validated, true)
		assert.equal(task.validation?.reproducible, true)
		assert.equal(task.validation?.baseCommit, run.baseCommit)
		assert.equal(task.validation?.replays.length, 2)
		assert.ok(task.validation?.replays.every((replay) => replay.ok && replay.exitCode === 0 && replay.outputSha256 === task.validation?.replays[0]?.outputSha256))
		assert.equal(task.promotedAt, undefined, "fixture validation never auto-promotes a task")
		for (const attempt of [1, 2]) {
			const key = `${run.runId}:curriculum:${task.id}:replay:${attempt}`
			const jobId = queue.keys.get(key)
			const job = jobId ? queue.jobs.get(jobId) : undefined
			assert.ok(job, `repeat ${attempt} must use a durable idempotent fleet job`)
			assert.equal(job?.jobKind, "evaluation")
			assert.equal(job?.payload.regressionCommand, "true")
			assert.deepEqual(job?.payload.evalCommands, [task.groundTruthCommand])
		}
		const report = await fs.readFile(run.reports[0]!, "utf8")
		assert.match(report, /fixture-replay validated; not promoted/)
		assert.match(report, /does not certify that task wording measures the named capability/)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("fleet curriculum replay refuses a stale idempotency key without executing it", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2, false, false, false, true, true)
	try {
		const run = await runRsi(config, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		const task = run.curriculumTasks?.[0]
		assert.ok(task)
		assert.equal(task.validated, false)
		assert.match(task.validation?.reason ?? "", /stale or mismatched fleet job payload/)
		assert.equal(task.validation?.replays.length, 1)
		assert.match(task.validation?.replays[0]?.failure ?? "", /stale or mismatched fleet job payload/)
		assert.equal(queue.evaluationJobCount, 2, "the stale key must not dispatch another evaluation job")
		assert.equal(queue.jobs.size, 1 + 2 + 2 + 1, "only baseline/candidate evaluations, mutations, and the injected stale row exist")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("adaptive fleet run evaluates a population then admits one follow-up under its trajectory cap", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2, false, false, true)
	try {
		const run = await runRsi({
			...config,
			computePolicy: "adaptive-independent",
			maxTrajectories: 3,
			maxTotalIterations: config.maxIterations * 3,
		}, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		assert.equal(run.generations, 2, "generations=1 permits one adaptive follow-up stage")
		assert.equal(run.candidates.length, 3, JSON.stringify({ decisions: run.adaptiveSearch, candidates: run.candidates.map(({ id, status, pairedComparison }) => ({ id, status, pairedComparison })) }))
		assert.equal(run.candidates.filter((candidate) => candidate.generation === 0).length, 2)
		assert.equal(run.candidates.filter((candidate) => candidate.generation === 1).length, 1)
		assert.equal(run.adaptiveSearch?.[0]?.decision, "continue")
		assert.equal(run.adaptiveSearch?.[1]?.reason, "trajectory-cap")
		assert.equal(queue.mutationJobCount, 3)
		assert.equal(queue.evaluationJobCount, 3)
		assert.equal(queue.policy.maxInFlight, config.maxConcurrent, "the adaptive jobs share the queue's configured global cap")
		const jobs = [...queue.jobs.values()].filter((job) => job.runId === run.runId)
		assert.equal(jobs.length, 7, "baseline evaluation plus three mutations and three visible evaluations")
		assert.ok(jobs.every((job) => job.status === "completed"))
		for (const candidate of run.candidates) {
			assert.ok(queue.keys.has(`${run.runId}:${candidate.id}:mutation`), `mutation job for ${candidate.id} is idempotently keyed`)
			assert.ok(queue.keys.has(`${run.runId}:${candidate.id}:evaluation`), `evaluation job for ${candidate.id} is idempotently keyed`)
		}
		assert.ok(queue.keys.has(`${run.runId}:baseline:evaluation`))
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("adaptive fleet run does not admit follow-ups after runtime or total-iteration budgets are exhausted", async (t) => {
	for (const [name, budgets, reason] of [
		["runtime", { maxRuntimeMs: 1 }, "runtime-cap"],
		["iterations", { maxTotalIterations: 4 }, "iteration-cap"],
	] as const) {
		await t.test(name, async () => {
			const { root, config } = await setup()
			const queue = new FakeFleetQueue(2, false, false, true)
			try {
				const run = await runRsi({
					...config,
					computePolicy: "adaptive-independent",
					maxTrajectories: 3,
					maxTotalIterations: config.maxIterations * 3,
					...budgets,
				}, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
				assert.equal(run.candidates.length, 2)
				assert.equal(run.adaptiveSearch?.[0]?.decision, "stop")
				assert.equal(run.adaptiveSearch?.[0]?.reason, reason)
				assert.equal(queue.mutationJobCount, 2)
			} finally {
				await fs.rm(root, { recursive: true, force: true })
			}
		})
	}
})

test("fleet controller removes newly created worktrees when snapshot admission fails", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2, true)
	try {
		await assert.rejects(runRsi(config, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue), /simulated artifact-store failure/)
		const lines = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" }).split("\n").filter((line) => line.startsWith("worktree "))
		assert.equal(lines.length, 1, "only the source checkout should remain registered")
		assert.equal(queue.closeCount, 1)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("fleet resume reattaches to the persisted mutation idempotency key without failing an active candidate", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(1)
	const runId = "resume-fleet-run"
	const runConfig: RsiConfig = { ...config, seed: `${config.seed}-${runId.slice(-8)}` }
	try {
		const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
		const candidate = newCandidate(runConfig, 0, 0, baseCommit, new Date().toISOString())
		candidate.status = "mutating"
		execFileSync("git", ["worktree", "add", "--quiet", "-b", candidate.branch, candidate.worktree, candidate.baseCommit], { cwd: root })
		const snapshot = createMutationSnapshotBundle(candidate.worktree, candidate.baseCommit, runConfig)
		const artifact = await queue.putArtifact(snapshot.content)
		const payload: FleetJobPayload = {
			schemaVersion: 1,
			snapshotSha256: artifact.sha256,
			snapshotBytes: artifact.byteLength,
			snapshotCommit: snapshot.snapshotCommit,
			task: config.mutationTask,
			model: config.model,
			maxIterations: config.maxIterations,
			timeoutMs: config.commandTimeoutMs,
			protectedPaths: config.protectedPaths,
			candidate: { id: candidate.id, generation: 0, parent: candidate.parent, mutationKind: candidate.mutationKind, hypothesis: candidate.hypothesis, modelCandidateId: candidate.modelCandidateId, computePolicy: runConfig.computePolicy },
			regressionCommand: config.regressionCommand,
			evalCommands: config.evalCommands,
		}
		const mutation = await queue.enqueue({
			idempotencyKey: `${runId}:${candidate.id}:mutation`,
			runId,
			candidateId: candidate.id,
			jobKind: "mutation",
			resourceClass: "LOCAL_GPU",
			concurrencyKey: `ollama:${candidate.model}`,
			artifactSha256: artifact.sha256,
			payload,
		})
		const pass: TrialResult = { ok: true, command: "regression", exitCode: 0, durationMs: 1, stdout: "", stderr: "" }
		const fail: TrialResult = { ok: false, command: "visible", exitCode: 1, durationMs: 1, stdout: "", stderr: "" }
		const startedAt = new Date().toISOString()
		const run: RsiRunRecord = {
			runId,
			startedAt,
			model: config.model,
			baseRef: "HEAD",
			baseCommit,
			generations: 1,
			selectedCandidates: [],
			modelCandidates: [],
			combinations: [],
			jobs: [{ id: "mutation-experiment", kind: "mutation", status: "running", resource: { class: "LOCAL_GPU", units: 1 }, candidateId: candidate.id, createdAt: startedAt, updatedAt: startedAt, attempts: 1 }],
			trajectoryRefs: [],
			curriculumTasks: [],
			candidates: [candidate],
			reports: [],
			baselineEvaluation: { regression: pass, visible: [fail], hidden: [], completed: false, crashed: false, protectedPathViolation: false, changedFiles: [], committed: false },
			baseline: pass,
		}
		await checkpointRun(config.archiveDir, run)
		const resumed = await runRsi({ ...config, resumeRunId: runId }, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		assert.equal(resumed.runId, runId)
		assert.equal(resumed.candidates[0]?.status, "accepted")
		assert.equal(queue.mutationJobCount, 1, "resume should reuse the already-completed mutation job")
		assert.equal(resumed.jobs?.find((job) => job.id === "mutation-experiment")?.status, "completed")
		assert.equal(queue.closeCount, 1)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("fleet resume recognizes an applied patch before the status checkpoint and cleans its worktree", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(1)
	const runId = "resume-applied-fleet-run"
	const runConfig: RsiConfig = { ...config, seed: `${config.seed}-${runId.slice(-8)}` }
	try {
		const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
		const candidate = newCandidate(runConfig, 0, 0, baseCommit, new Date().toISOString())
		candidate.status = "mutating"
		execFileSync("git", ["worktree", "add", "--quiet", "-b", candidate.branch, candidate.worktree, candidate.baseCommit], { cwd: root })
		await fs.writeFile(path.join(candidate.worktree, "src", "agent.ts"), "export const appliedPatch = true\n")
		execFileSync("git", ["add", "src/agent.ts"], { cwd: candidate.worktree })
		execFileSync("git", ["commit", "--quiet", "-m", "applied candidate patch"], { cwd: candidate.worktree })
		const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-renames", `${baseCommit}...HEAD`], { cwd: candidate.worktree, encoding: "buffer" })
		const patchArtifact = await queue.putArtifact(patch)
		const snapshot = createMutationSnapshotBundle(candidate.worktree, baseCommit, runConfig)
		const snapshotArtifact = await queue.putArtifact(snapshot.content)
		const payload: FleetJobPayload = {
			schemaVersion: 1,
			snapshotSha256: snapshotArtifact.sha256,
			snapshotBytes: snapshotArtifact.byteLength,
			snapshotCommit: snapshot.snapshotCommit,
			task: config.mutationTask,
			model: config.model,
			maxIterations: config.maxIterations,
			timeoutMs: config.commandTimeoutMs,
			protectedPaths: config.protectedPaths,
			candidate: { id: candidate.id, generation: 0, parent: candidate.parent, mutationKind: candidate.mutationKind, hypothesis: candidate.hypothesis, modelCandidateId: candidate.modelCandidateId, computePolicy: runConfig.computePolicy },
			regressionCommand: config.regressionCommand,
			evalCommands: config.evalCommands,
		}
		const mutation = await queue.enqueue({
			idempotencyKey: `${runId}:${candidate.id}:mutation`, runId, candidateId: candidate.id,
			jobKind: "mutation", resourceClass: "LOCAL_GPU", concurrencyKey: `ollama:${candidate.model}`,
			artifactSha256: snapshotArtifact.sha256, payload,
		})
		mutation.result = { ok: true, patchSha256: patchArtifact.sha256, patchBytes: patchArtifact.byteLength }
		const pass: TrialResult = { ok: true, command: "regression", exitCode: 0, durationMs: 1, stdout: "", stderr: "" }
		const fail: TrialResult = { ok: false, command: "visible", exitCode: 1, durationMs: 1, stdout: "", stderr: "" }
		const startedAt = new Date().toISOString()
		const run: RsiRunRecord = {
			runId, startedAt, model: config.model, baseRef: "HEAD", baseCommit, generations: 1,
			selectedCandidates: [], modelCandidates: [], combinations: [],
			jobs: [{ id: "mutation-experiment", kind: "mutation", status: "running", resource: { class: "LOCAL_GPU", units: 1 }, candidateId: candidate.id, createdAt: startedAt, updatedAt: startedAt, attempts: 1 }],
			trajectoryRefs: [], curriculumTasks: [], candidates: [candidate], reports: [],
			baselineEvaluation: { regression: pass, visible: [fail], hidden: [], completed: false, crashed: false, protectedPathViolation: false, changedFiles: [], committed: false },
			baseline: pass,
		}
		await checkpointRun(config.archiveDir, run)
		const resumed = await runRsi({ ...config, resumeRunId: runId }, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		assert.equal(resumed.candidates[0]?.status, "accepted")
		assert.equal(queue.mutationJobCount, 1, "resume must validate and reuse the completed mutation job")
		assert.equal(resumed.jobs?.find((job) => job.id === "mutation-experiment")?.status, "completed")
		await assert.rejects(fs.access(candidate.worktree), /ENOENT/, "resumed worktrees must be removed when keepWorktrees is false")
		assert.equal(queue.closeCount, 1)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("fleet controller rejects malformed trial status before assigning fitness", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2, false, true)
	try {
		const run = await runRsi(config, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		assert.ok(run.candidates.every((candidate) => candidate.status === "failed"))
		assert.ok(run.candidates.every((candidate) => candidate.fitness === undefined))
		assert.ok(run.candidates.every((candidate) => candidate.failure?.includes("bounded result fields")))
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
