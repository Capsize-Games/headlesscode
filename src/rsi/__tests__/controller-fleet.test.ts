import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Pool } from "pg"
import test, { after, before } from "node:test"
import { checkpointRun } from "../archive.js"
import { runRsi as runRsiImplementation } from "../controller.js"
import { createMutationSnapshotBundle } from "../openshell.js"
import { FileRsiArtifactStore } from "../artifact-store.js"
import { PostgresProofCampaign } from "../proof-campaign.js"
import { PostgresRsiJobQueue, type FleetJob, type FleetJobPayload } from "../postgres-queue.js"
import { newCandidate } from "../workspace.js"
import type { CandidateRecord, RsiConfig, RsiRunRecord, RsiHooks, TrialResult } from "../types.js"
import { fakeDevelopmentBenchmarkHook } from "./development-proof-fixture.js"
import { fixtureDevelopmentProofProtocol } from "./development-proof-fixture.js"

const originalPolicyPath = process.env.HEADLESSCODE_OPENSHELL_POLICY
let syntheticPolicyDirectory: string | undefined
before(async () => {
	const scratch = path.resolve(".headlesscode/scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	syntheticPolicyDirectory = await fs.mkdtemp(path.join(scratch, "synthetic-fleet-policy-"))
	const policyPath = path.join(syntheticPolicyDirectory, "policy.yaml")
	await fs.writeFile(policyPath, "sandbox:\n  network: disabled\n", { mode: 0o600 })
	await fs.chmod(policyPath, 0o600)
	process.env.HEADLESSCODE_OPENSHELL_POLICY = policyPath
})
after(async () => {
	if (originalPolicyPath === undefined) delete process.env.HEADLESSCODE_OPENSHELL_POLICY
	else process.env.HEADLESSCODE_OPENSHELL_POLICY = originalPolicyPath
	if (syntheticPolicyDirectory) await fs.rm(syntheticPolicyDirectory, { recursive: true, force: true })
})

function runRsi(config: RsiConfig, hooks: RsiHooks = {}, queue?: PostgresRsiJobQueue): Promise<RsiRunRecord> {
	return runRsiImplementation(config, { syntheticRuntimeIdentity: true, runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook(), ...hooks }, queue)
}

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
	proofCampaign?: PostgresProofCampaign
	proofCampaignProxy?: PostgresProofCampaign
	proofLease?: Awaited<ReturnType<PostgresProofCampaign["acquire"]>>
	failMutationUncertain = false
	mutationFailureSettled = false

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
	setProofCampaign(campaign: PostgresProofCampaign): void {
		this.proofCampaign = campaign
		this.proofCampaignProxy = new Proxy(campaign, {
			get: (target, property) => {
				if (property === "acquire") return async (...args: Parameters<PostgresProofCampaign["acquire"]>) => {
					const lease = await target.acquire(...args)
					this.proofLease = lease
					return lease
				}
				const value = Reflect.get(target, property, target) as unknown
				return typeof value === "function" ? value.bind(target) : value
			},
		})
	}
	proofCampaignCoordinator(): PostgresProofCampaign {
		if (!this.proofCampaignProxy) throw new Error("test proof campaign coordinator was not configured")
		return this.proofCampaignProxy
	}

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
		if (job?.jobKind === "mutation" && job.status === "failed" && this.failMutationUncertain && !this.mutationFailureSettled) {
			if (!this.proofCampaign || !this.proofLease) throw new Error("uncertain mutation test has no real campaign lease")
			await this.proofCampaign.settle(this.proofLease, job.idempotencyKey, { status: "failed", error: job.error ?? "synthetic unresolved mutation accounting" })
			this.mutationFailureSettled = true
		}
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
			assert.equal(input.payload.evaluatorRuntime, undefined, "mutation jobs do not receive evaluator-only runtime identity")
			this.mutationJobCount += 1
			if (this.failMutationUncertain) result = { ok: false, error: "synthetic worker lost mutation accounting after dispatch" }
			else {
				const bundle = this.artifacts.get(input.artifactSha256)
				assert.ok(bundle)
				const scratch = path.resolve(".headlesscode/scratch")
				await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
				const temp = await fs.mkdtemp(path.join(scratch, "rsi-fake-fleet-mutation-"))
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
			}
		} else {
			assert.equal(input.payload.evaluatorRuntime?.imageDigest, `sha256:${"0".repeat(64)}`, "synthetic evaluation hooks carry an explicit non-production image identity")
			assert.match(input.payload.evaluatorRuntime?.policySha256 ?? "", /^[a-f0-9]{64}$/, "evaluation payload freezes the effective policy bytes")
			const adversarial = input.candidateId.endsWith("-adversarial")
			if (adversarial) {
				this.adversarialEvaluationJobCount += 1
				assert.deepEqual(input.payload.evalCommands, ["node --import tsx __headlesscode_rsi_adversarial__/runner.mjs"])
				assert.match(input.payload.adversarialEvaluation?.testsSha256 ?? "", /^[a-f0-9]{64}$/, "queued adversarial payload pins the supervisor-authored test bytes")
				assert.match(input.payload.adversarialEvaluation?.runnerSha256 ?? "", /^[a-f0-9]{64}$/, "queued adversarial payload pins the fixed supervisor runner")
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
					typecheck: trial(true, "npm run typecheck"),
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
			status: input.jobKind === "mutation" && this.failMutationUncertain ? "failed" : "completed",
			attempts: 1,
			maxAttempts: 2,
			leaseDurationMs: 60_000,
			result,
			...(input.jobKind === "mutation" && this.failMutationUncertain ? { error: "synthetic worker lost mutation accounting after dispatch" } : {}),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}
		this.jobs.set(jobId, job)
		this.keys.set(input.idempotencyKey, jobId)
		return job
	}
}

async function setup(): Promise<{ root: string; config: RsiConfig }> {
	const scratch = path.resolve(".headlesscode/scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratch, "rsi-controller-fleet-"))
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

async function syntheticEvaluatorTrust(config: RsiConfig): Promise<{ config: RsiConfig; cleanup: () => Promise<void> }> {
	const scratch = path.resolve(".headlesscode/scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratch, "hc-rsi-fleet-test-trust-"))
	const pair = generateKeyPairSync("ed25519")
	const signingKeyPath = path.join(root, "signing.pem")
	const trustedPublicKeyPath = path.join(root, "trusted-public.pem")
	await fs.writeFile(signingKeyPath, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 })
	await fs.writeFile(trustedPublicKeyPath, pair.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o600 })
	const trustedKeySha256 = `sha256:${createHash("sha256").update(pair.publicKey.export({ format: "der", type: "spki" })).digest("hex")}`
	return {
		config: { ...config, evaluatorSigningKeyPath: signingKeyPath, evaluatorTrustedPublicKeyPath: trustedPublicKeyPath, evaluatorTrustedKeySha256: trustedKeySha256 },
		cleanup: () => fs.rm(root, { recursive: true, force: true }),
	}
}

test("fleet controller queues baseline and all candidate evaluations before waiting", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(2)
	try {
		const run = await runRsi(config, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		assert.equal(run.candidates.filter((candidate) => candidate.status === "accepted").length, 0, "guest-reported token counts cannot make fleet candidates proof-qualified")
		assert.equal(queue.evaluationJobCount, 2)
		assert.equal(queue.firstCandidateEvaluationObserved, true)
		assert.equal(queue.closeCount, 1)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

const proofDatabaseUrl = process.env.HEADLESSCODE_RSI_TEST_DATABASE_URL

test("controller checkpoints an unresolved mutation in a real PostgreSQL campaign ledger without selection or reservation release", { skip: !proofDatabaseUrl }, async () => {
	const scratch = path.resolve(".headlesscode/scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const schema = `rsi_controller_${randomUUID().replaceAll("-", "")}`
	const root = await fs.mkdtemp(path.join(scratch, "rsi-controller-incomplete-pg-"))
	const admin = new Pool({ connectionString: proofDatabaseUrl })
	let pool: Pool | undefined
	let queueMigrator: PostgresRsiJobQueue | undefined
	const budgetNames = [
		"HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD",
		"HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD",
		"HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD", "HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD",
	]
	const saved = Object.fromEntries(budgetNames.map((name) => [name, process.env[name]]))
	try {
		Object.assign(process.env, {
			HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD: "0.001",
			HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD: "0.001",
			HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD: "0.05",
			HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD: "0.05",
			HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD: "20",
			HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD: "5",
			HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD: "15",
		})
		await admin.query(`CREATE SCHEMA ${schema}`)
		pool = new Pool({ connectionString: proofDatabaseUrl, options: `-c search_path=${schema}` })
		const artifactRoot = path.join(root, "artifacts")
		queueMigrator = new PostgresRsiJobQueue(pool, { queueName: `proof-${randomUUID().slice(0, 8)}`, maxInFlight: 1, leaseMs: 60_000, maxAttempts: 1 }, new FileRsiArtifactStore(artifactRoot))
		await queueMigrator.migrate()
		const campaignStore = queueMigrator.proofCampaignCoordinator()
		const fakeQueue = new FakeFleetQueue(0)
		fakeQueue.setProofCampaign(campaignStore)
		fakeQueue.failMutationUncertain = true
		const { config: baseConfig, root: repoRoot } = await setup()
		const trusted = await syntheticEvaluatorTrust(baseConfig)
		try {
			const model = "deepseek/deepseek-v4-flash-0731"
			const campaign = `rsi-proof-${randomUUID().replaceAll("-", "").slice(0, 20)}`
			const runtime = { imageName: "synthetic-test-image", imageDigest: `sha256:${"0".repeat(64)}`, harnessCommit: "1".repeat(40), dependencyLockDigest: "2".repeat(64) }
			const config: RsiConfig = {
				...trusted.config, model, roles: { worker: { provider: "openrouter", model } }, population: 1, generations: 2, maxIterations: 1, maxTokens: 256, maxRuntimeMs: 48 * 60 * 60_000,
				workerHarnessPairId: campaign, workerHarnessRunId: `${campaign}-fixed`, workerHarnessMode: "fixed-control", workerHarnessPhase: "development", workerHarnessEngineeringOnly: true, workerHarnessRuntime: runtime,
			}
			const run = await runRsiImplementation(config, { syntheticRuntimeIdentity: true, log: () => undefined }, fakeQueue as unknown as PostgresRsiJobQueue)
			assert.equal(fakeQueue.mutationJobCount, 1)
			assert.equal(fakeQueue.mutationFailureSettled, true)
			assert.equal(run.candidates[0]?.status, "failed")
			assert.equal(run.proofCampaign?.state, "incomplete")
			assert.ok(run.finishedAt, "incomplete run is terminally reported")
			const snapshot = await campaignStore.snapshot(campaign)
			const persistedCampaign = snapshot.campaign as Record<string, unknown>
			const arm = (snapshot.arms as Array<Record<string, unknown>>).find((entry) => entry.arm_id === "fixed-control")
			const attempts = snapshot.attempts as Array<Record<string, unknown>>
			const mutation = attempts.find((attempt) => attempt.attempt_kind === "mutation")
			assert.equal(persistedCampaign.state, "running", "campaign state remains nonterminal")
			assert.equal(arm?.state, "running", "arm is not marked evaluated or finished")
			assert.equal(mutation?.status, "uncertain", "dispatched failure remains unresolved")
			assert.ok(Number(mutation?.reserved_tokens) > 0)
			assert.equal(mutation?.actual_tokens, null)
			assert.ok(Number(persistedCampaign.reserved_calls) > 0, "unsettled reservation is retained")
			assert.equal(Number(persistedCampaign.used_calls), 0)
			const events = snapshot.events as Array<Record<string, unknown>>
			assert.equal(events.filter((event) => event.event_type === "candidate-incomplete").length, 1)
			assert.equal(events.some((event) => event.event_type === "generation-selected" || event.event_type === "engineering-development-finished"), false, "selection and finish gates remain closed")
			assert.equal((snapshot.decisions as Array<Record<string, unknown>>).length, 0, "unsettled mutation is never recorded as evaluated")
			const incompleteEvent = events.find((event) => event.event_type === "candidate-incomplete")!
			const eventPayload = incompleteEvent.payload as { cells: Array<Record<string, unknown>> }
			const frozenCells = run.proofCampaign!.manifest.schedule.filter((cell) => cell.armId === "fixed-control" && cell.generation === 0)
			assert.deepEqual(eventPayload.cells.map((cell) => [cell.armId, cell.generation, cell.candidateId, cell.taskId, cell.seed, cell.attemptKind]), frozenCells.map((cell) => [cell.armId, cell.generation, cell.candidateId, cell.taskId, cell.seed, cell.attemptKind]), "checkpoint includes the exact full frozen slot schedule")
			assert.ok(run.reports.some((report) => report.endsWith(".md")))
		} finally {
			await trusted.cleanup()
			await fs.rm(repoRoot, { recursive: true, force: true })
		}
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
		await pool?.end()
		await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
		await admin.end()
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("OpenRouter mutation resource is recorded as REMOTE_API for first dispatch and resume", async () => {
	const { root, config } = await setup()
	const queue = new FakeFleetQueue(1)
	const saved = Object.fromEntries([
		"HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD",
		"HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD",
		"HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD", "HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD",
	].map((name) => [name, process.env[name]]))
	try {
		Object.assign(process.env, {
			HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD: "1",
			HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD: "1",
			HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD: "0.01",
			HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD: "0.04",
			HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD: "0.10",
			HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD: "0.04",
			HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD: "0.04",
		})
		const model = "deepseek/deepseek-v4-flash-0731"
		const run = await runRsi({ ...config, population: 1, roles: { worker: { provider: "openrouter", model } } }, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		const submitted = [...queue.jobs.values()].find((job) => job.jobKind === "mutation")
		assert.equal(submitted?.resourceClass, "REMOTE_API")
		assert.equal(submitted?.concurrencyKey, `openrouter:${model}`)
		assert.equal(run.jobs?.find((job) => job.kind === "mutation")?.resource.class, "REMOTE_API")
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
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
	const trusted = await syntheticEvaluatorTrust(config)
	const queue = new FakeFleetQueue(2, false, false, false, false, false, true)
	try {
		const run = await runRsi({
			...trusted.config,
			roles: { worker: { provider: "ollama", model: "worker-model" }, adversary: { provider: "openrouter", model: "review-model" } },
		}, { log: () => undefined, runAdversary: async () => adversarialResponse() }, queue as unknown as PostgresRsiJobQueue)
		assert.ok(run.candidates.every((candidate) => candidate.status === "rejected"), JSON.stringify(run.candidates.map(({ id, status, failure }) => ({ id, status, failure }))))
		assert.ok(run.candidates.every((candidate) => candidate.fitness?.score === 0 && candidate.fitness.hardGates.adversarialPass === false))
		assert.equal(run.adversarialReviews?.length, 2)
		assert.ok(run.adversarialReviews?.every((review) => review.status === "failed" && review.testResults.length === 1 && !review.testResults[0]?.passed))
		assert.equal(queue.adversarialEvaluationJobCount, 2)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
		await trusted.cleanup()
	}
})

test("fleet adversarial major finding records a bounded penalty when its OpenShell test passes", async () => {
	const { root, config } = await setup()
	const trusted = await syntheticEvaluatorTrust(config)
	const queue = new FakeFleetQueue(2)
	try {
		const run = await runRsi({
			...trusted.config,
			roles: { worker: { provider: "ollama", model: "worker-model" }, adversary: { provider: "openrouter", model: "review-model" } },
		}, { log: () => undefined, runAdversary: async () => adversarialResponse([{ severity: "major", message: "A boundary case may be mishandled.", testId: "adversary-case" }]) }, queue as unknown as PostgresRsiJobQueue)
		assert.ok(run.candidates.every((candidate) => candidate.status === "rejected"), JSON.stringify(run.candidates.map(({ id, status, failure }) => ({ id, status, failure }))))
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
		await trusted.cleanup()
	}
})

test("adversarial role with same model name on a different provider is not cross-model supervision", async () => {
	const { root, config } = await setup()
	const trusted = await syntheticEvaluatorTrust(config)
	const queue = new FakeFleetQueue(2)
	let reviewerCalled = false
	try {
		const run = await runRsi({
			...trusted.config,
			roles: { worker: { provider: "ollama", model: "shared-model-name" }, adversary: { provider: "openrouter", model: "shared-model-name" } },
		}, { log: () => undefined, runAdversary: async () => { reviewerCalled = true; return adversarialResponse() } }, queue as unknown as PostgresRsiJobQueue)
		assert.equal(reviewerCalled, false)
		assert.ok(run.candidates.every((candidate) => candidate.status === "rejected" && candidate.fitness?.hardGates.adversarialPass === false), JSON.stringify(run.candidates.map(({ id, status, failure, fitness }) => ({ id, status, failure, gates: fitness?.hardGates }))))
		assert.ok(run.adversarialReviews?.every((review) => review.status === "error" && /different model/.test(review.error ?? "")))
		assert.equal(queue.adversarialEvaluationJobCount, 0)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
		await trusted.cleanup()
	}
})

test("malformed adversary response preserves provider result provenance separately from parse error", async () => {
	const { root, config } = await setup()
	const trusted = await syntheticEvaluatorTrust(config)
	const queue = new FakeFleetQueue(2)
	const rawResponse = "{not-json"
	try {
		const run = await runRsi({
			...trusted.config,
			roles: { worker: { provider: "ollama", model: "worker-model" }, adversary: { provider: "openrouter", model: "review-model" } },
		}, { log: () => undefined, runAdversary: async () => rawResponse }, queue as unknown as PostgresRsiJobQueue)
		assert.ok(run.adversarialReviews?.every((review) => review.status === "error" && review.resultArtifactSha256 && review.resultSha256 && review.errorArtifactSha256 && review.errorSha256))
		for (const review of run.adversarialReviews ?? []) {
			assert.equal((await queue.getArtifact(review.resultArtifactSha256!)).toString("utf8"), rawResponse)
			assert.match((await queue.getArtifact(review.errorArtifactSha256!)).toString("utf8"), /strict JSON/)
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true })
		await trusted.cleanup()
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
		const developmentProofProtocol = await fixtureDevelopmentProofProtocol(config.model)
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
			provider: "ollama",
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
			developmentProofProtocol,
			confirmationEvidence: "unmeasured",
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
		assert.equal(resumed.candidates[0]?.status, "rejected", JSON.stringify({ failure: resumed.candidates[0]?.failure, status: resumed.candidates[0]?.status }))
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
		const developmentProofProtocol = await fixtureDevelopmentProofProtocol(config.model)
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
			provider: "ollama",
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
			developmentProofProtocol,
			confirmationEvidence: "unmeasured",
			jobs: [{ id: "mutation-experiment", kind: "mutation", status: "running", resource: { class: "LOCAL_GPU", units: 1 }, candidateId: candidate.id, createdAt: startedAt, updatedAt: startedAt, attempts: 1 }],
			trajectoryRefs: [], curriculumTasks: [], candidates: [candidate], reports: [],
			baselineEvaluation: { regression: pass, visible: [fail], hidden: [], completed: false, crashed: false, protectedPathViolation: false, changedFiles: [], committed: false },
			baseline: pass,
		}
		await checkpointRun(config.archiveDir, run)
		const resumed = await runRsi({ ...config, resumeRunId: runId }, { log: () => undefined }, queue as unknown as PostgresRsiJobQueue)
		assert.equal(resumed.candidates[0]?.status, "rejected", JSON.stringify({ failure: resumed.candidates[0]?.failure, status: resumed.candidates[0]?.status }))
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
