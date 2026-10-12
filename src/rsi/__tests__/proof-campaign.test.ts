import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import * as path from "node:path"
import { Pool } from "pg"
import test from "node:test"
import { FileRsiArtifactStore } from "../artifact-store.js"
import { fleetJobMatches, fleetPayloadDigest, PostgresRsiJobQueue, type FleetJobIdentity } from "../postgres-queue.js"
import { PostgresProofCampaign, proofCampaignManifestDigest, type ProofCampaignManifest } from "../proof-campaign.js"
import { openRouterAllocatedEnvironment, openRouterBrokerLimitsFromEnvironment, openRouterProfileForModel, RSI_OPENROUTER_MODEL, type OpenRouterBrokerGrant, type OpenRouterBrokerLimits } from "../inference-broker.js"
import { readArchive, writeArchive } from "../archive.js"
import { createProofCampaignManifest, proofBrokerCampaignId, proofCampaignSpendReservationMicros, reconcileProofCampaignJob, rebuildEvaluatedProofCampaignArchive, rebuildFinishedProofCampaignArchive, RSI_CONFIRMATION_RETENTION_TASK_IDS } from "../controller.js"
import { loadBenchmark, runBenchmark, type BenchmarkVerifier } from "../benchmark/runner.js"
import type { BenchmarkAgent, BenchmarkAttempt, BenchmarkImageIdentity, BenchmarkTask } from "../benchmark/types.js"
import type { CandidateRecord, RsiConfig, RsiRunRecord } from "../types.js"

const databaseUrl = process.env.HEADLESSCODE_RSI_TEST_DATABASE_URL
const attemptKind = "development-proof" as const

test("incomplete candidate event records the exact frozen cells without evaluating or settling the candidate", async () => {
	const candidateCells: ProofCampaignManifest["schedule"] = [
		{ armId: "fixed", generation: 1, candidateId: "candidate-a", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
		{ armId: "fixed", generation: 1, candidateId: "candidate-a:child", taskId: "task-a", seed: "seed-0", attemptKind: "development-proof" },
	]
	const frozen = manifest("incomplete-event-test", [
		{ armId: "fixed", generation: 0, candidateId: "parent-a", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
		...candidateCells,
	])
	const lease = { campaignId: frozen.campaignId, armId: "fixed", runId: "run-fixed", epoch: 3, coordinatorId: "controller", token: "token", manifestSha256: "d".repeat(64), deadlineAt: new Date(Date.now() + 60_000).toISOString(), phase: "development" } as const
	const leaseTokenHash = createHash("sha256").update(lease.token).digest("hex")
	const durableEvents: Array<{ payload: unknown }> = []
	const queries: Array<{ sql: string; parameters?: unknown[] }> = []
	let sequence = 0
	const client = {
		query: async (sql: string, parameters?: unknown[]) => {
			queries.push({ sql, parameters })
			if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
			if (sql.includes("SELECT campaign.*,arm.epoch")) return { rows: [{ state: "running", arm_epoch: 3, arm_phase: "development", run_id: "run-fixed", lease_token_sha256: leaseTokenHash, manifest_sha256: lease.manifestSha256, arm_lease_valid: true, deadline_valid: true }], rowCount: 1 }
			if (sql.startsWith("SELECT manifest FROM headlesscode_rsi_proof_campaigns")) return { rows: [{ manifest: frozen }], rowCount: 1 }
			if (sql.includes("SELECT 1 FROM headlesscode_rsi_proof_campaign_decisions AS parent")) return { rows: [{ one: 1 }], rowCount: 1 }
			if (sql.includes("FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1 AND arm_id=$2 AND generation=$3")) {
				const taskId = parameters?.[4]
				const row = taskId === "mutation"
					? { attempt_key: "mutation-uncertain", status: "uncertain", reserved_calls: 1, reserved_tokens: 700, reserved_spend_microusd: 550_000, actual_calls: null, actual_tokens: null, actual_spend_microusd: null, error: "dispatch result not reconciled" }
					: { attempt_key: "child-skipped", status: "skipped-after-hard-gate", reserved_calls: 0, reserved_tokens: 0, reserved_spend_microusd: 0, actual_calls: 0, actual_tokens: 0, actual_spend_microusd: 0, error: null }
				return { rows: [row], rowCount: 1 }
			}
			if (sql.includes("SELECT payload FROM headlesscode_rsi_proof_campaign_events WHERE campaign_id=$1 AND arm_id=$2 AND event_type='candidate-incomplete'")) return { rows: durableEvents, rowCount: durableEvents.length }
			if (sql.startsWith("UPDATE headlesscode_rsi_proof_campaigns SET sequence=sequence+1")) return { rows: [{ sequence: ++sequence }], rowCount: 1 }
			if (sql.startsWith("INSERT INTO headlesscode_rsi_proof_campaign_events")) {
				durableEvents.push({ payload: JSON.parse(String(parameters?.[5])) })
				return { rows: [], rowCount: 1 }
			}
			throw new Error(`unexpected SQL in synthetic campaign pool: ${sql}`)
		},
		release: () => undefined,
	}
	const pool = { connect: async () => client } as unknown as Pool
	const campaign = new PostgresProofCampaign(pool)
	const failure = { generation: 1, candidateId: "candidate-a", parentId: "parent-a", parentCommit: "b".repeat(40), reason: "candidate mutation ended with unreconciled accounting" }
	await campaign.recordIncompleteCandidate(lease, failure)
	await campaign.recordIncompleteCandidate(lease, failure)
	assert.equal(durableEvents.length, 1, "same incomplete checkpoint is idempotent")
	const payload = durableEvents[0]!.payload as { outcome: string; childCommit?: string; parentId: string; parentCommit: string; cells: Array<Record<string, unknown>> }
	assert.equal(payload.outcome, "incomplete")
	assert.equal(payload.parentId, "parent-a")
	assert.equal(payload.parentCommit, "b".repeat(40))
	assert.equal(Object.hasOwn(payload, "childCommit"), false, "failure bookkeeping never invents a child commit")
	assert.deepEqual(payload.cells.map((cell) => [cell.taskId, cell.status]), [["mutation", "uncertain"], ["task-a", "skipped-after-hard-gate"]])
	assert.equal(payload.cells[0]?.reservedTokens, 700)
	assert.equal(payload.cells[0]?.actualTokens, null, "unknown actual use stays unknown")
	assert.equal(queries.some(({ sql }) => /SET state='evaluated'/.test(sql) || sql.includes("INSERT INTO headlesscode_rsi_proof_campaign_decisions")), false, "incomplete event never transitions the arm or creates an evaluated decision")
})

function manifest(campaignId: string, schedule: ProofCampaignManifest["schedule"]): ProofCampaignManifest {
	return {
		schemaVersion: 1, campaignId, rootCommit: "a".repeat(40), benchmarkDigests: { manifest: "d".repeat(64), development: "b".repeat(64), confirmation: "c".repeat(64) },
		armAssignment: { fixedControl: "fixed", selfHosted: "self" }, model: { provider: "mock", id: "test/model", settings: { temperature: 0 } },
		seed: "seed-0", taskOrder: [...new Set(schedule.map((cell) => cell.taskId))], schedule,
		budgets: { attempt: { maxCalls: 1, maxTokens: 100, maxSpendUsd: 0.1, maxDurationMs: 10_000 }, root: { maxCalls: 10, maxTokens: 1000, maxSpendUsd: 1, maxRuntimeMs: 60_000 } },
		acceptanceRule: { requiredPasses: 1 }, runtime: { imageDigest: `sha256:${"d".repeat(64)}`, harnessCommit: "e".repeat(40), dependencyLockDigest: "f".repeat(64) }, analysisVersion: "test-v1", settings: {},
	}
}

async function withCampaign(action: (campaign: PostgresProofCampaign, pool: Pool, root: string, queue: PostgresRsiJobQueue) => Promise<void>): Promise<void> {
	assert.ok(databaseUrl, "HEADLESSCODE_RSI_TEST_DATABASE_URL is required for PostgreSQL campaign integration")
	const schema = `rsi_proof_${randomUUID().replaceAll("-", "")}`
	const admin = new Pool({ connectionString: databaseUrl })
	await admin.query(`CREATE SCHEMA ${schema}`)
	const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
	const root = await mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/rsi-proof-campaign-`)
	try {
		const queue = new PostgresRsiJobQueue(pool, { queueName: `proof-${randomUUID().slice(0, 8)}`, maxInFlight: 1, leaseMs: 1_000, maxAttempts: 1 }, new FileRsiArtifactStore(root))
		await queue.migrate()
		await action(new PostgresProofCampaign(pool, 10_000), pool, root, queue)
	} finally {
		await pool.end()
		await admin.query(`DROP SCHEMA ${schema} CASCADE`)
		await admin.end()
		await rm(root, { recursive: true, force: true })
	}
}

async function admit(campaign: PostgresProofCampaign, lease: Awaited<ReturnType<PostgresProofCampaign["acquire"]>>, cell: ProofCampaignManifest["schedule"][number], attemptKey: string) {
	await campaign.admit(lease, {
		attemptKey, kind: cell.attemptKind, identity: { generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind },
		requestSha256: "1".repeat(64), calls: 1, tokens: 100, spendUsd: 0.1,
	})
}

test("proof campaign retains uncertain dispatched spend and enforces one key per logical cell", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool) => {
		const schedule = [{ armId: "fixed", generation: 0, candidateId: "candidate-a", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" as const }]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		await admit(campaign, lease, schedule[0]!, "attempt-a")
		await assert.rejects(() => admit(campaign, lease, schedule[0]!, "attempt-b"), /different attempt key/)
		await campaign.markDispatched(lease, "attempt-a", randomUUID())
		await campaign.settle(lease, "attempt-a", { status: "failed", error: "worker lost after dispatch" })
		const snapshot = await campaign.snapshot(frozen.campaignId)
		const attempt = (snapshot.attempts as Array<Record<string, unknown>>)[0]!
		assert.equal(attempt.status, "uncertain")
		assert.equal(Number((snapshot.campaign as Record<string, unknown>).reserved_calls), 1)
		assert.equal(Number((snapshot.campaign as Record<string, unknown>).used_calls), 0)
		assert.equal((await pool.query("SELECT count(*)::int AS count FROM headlesscode_rsi_proof_campaign_attempts WHERE campaign_id=$1", [frozen.campaignId])).rows[0]?.count, 1)
	})
})

test("pre-profile DeepSeek campaign manifests retain their frozen digest and default receipt identity", () => {
	const legacy = manifest("legacy-deepseek", [{ armId: "fixed", generation: 0, candidateId: "root-control", taskId: "task-0", seed: "seed-0", attemptKind: "fixed-control" }])
	legacy.model = { provider: "openshell-openrouter", id: RSI_OPENROUTER_MODEL, settings: { temperature: 0 } }
	assert.equal(Object.hasOwn(legacy.model, "profileId"), false)
	assert.equal(proofCampaignManifestDigest(legacy), "4e172b0dcbd889f951ed6454a4e8cf737c688e7ce782e95a7dae09e75395a941")
	const historicalReceipt = {
		provider: "openrouter", endpointProvider: "deepinfra", jobId: "legacy-job", campaignId: "legacy-deepseek", model: RSI_OPENROUTER_MODEL,
		returnedModels: [RSI_OPENROUTER_MODEL], returnedProviders: ["deepinfra"], qualified: true,
	}
	assert.equal(Object.hasOwn(historicalReceipt, "profileId"), false)
	assert.equal(openRouterProfileForModel(historicalReceipt.model).id, "deepseek-deepinfra-fp8", "a pre-profile receipt resolves to the frozen DeepSeek default")
})

test("proof campaign reservations use integer microUSD for role and root funding", () => {
	const allocation = {
		mutationJobs: 8, mutationMaxJobSpendUsd: 0.66, mutationAllocationUsd: 5.28,
		benchmarkJobs: 384, benchmarkMaxJobSpendUsd: 0.035, benchmarkAllocationUsd: 13.44,
		totalAllocationUsd: 20, benchmarkShortfallMessage: "benchmark reservation shortfall",
	}
	assert.deepEqual(proofCampaignSpendReservationMicros(allocation), { mutation: 5_280_000, benchmark: 13_440_000, total: 18_720_000 }, "exact $13.44 funding for 384 $0.035 reservations fits within the $20 root allocation")
	assert.equal(proofCampaignSpendReservationMicros({ ...allocation, totalAllocationUsd: 18.72 }).total, 18_720_000, "exact root funding is sufficient")
	assert.throws(() => proofCampaignSpendReservationMicros({ ...allocation, mutationAllocationUsd: 5.279999 }), /mutation broker campaign allocation is below/, "one microUSD below mutation reservations is rejected")
	assert.throws(() => proofCampaignSpendReservationMicros({ ...allocation, benchmarkAllocationUsd: 13.439999 }), /benchmark reservation shortfall/, "one microUSD below the benchmark reservations is rejected")
	assert.throws(() => proofCampaignSpendReservationMicros({ ...allocation, benchmarkMaxJobSpendUsd: 0.0350001 }), /benchmark reservation shortfall/, "fractional microUSD job reservations round upward")
	assert.throws(() => proofCampaignSpendReservationMicros({ ...allocation, totalAllocationUsd: 18.719999 }), /total allocation is below/, "one microUSD below the combined root reservations is rejected")
})

test("engineering-only proof pair finishes after development and freezes no confirmation cells", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const campaignId = `engineering-${randomUUID()}`
		const schedule: ProofCampaignManifest["schedule"] = ["fixed", "self"].map((armId) => ({ armId, generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation", phase: "development" }))
		const frozen = manifest(campaignId, schedule)
		frozen.phaseMode = "engineering-only"
		frozen.benchmarkDigests.confirmation = createHash("sha256").update("[]").digest("hex")
		frozen.settings = { phaseMode: "engineering-only", confirmationTaskIdentities: [] }
		for (const armId of ["fixed", "self"]) {
			const lease = await campaign.acquire(frozen, armId, `run-${armId}`, `coordinator-${armId}`)
			const cell = schedule.find((entry) => entry.armId === armId)!
			const attemptKey = `engineering-${armId}`
			await admit(campaign, lease, cell, attemptKey)
			await campaign.markDispatched(lease, attemptKey)
			await campaign.settle(lease, attemptKey, { status: "completed", resultSha256: "9".repeat(64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.001 })
			await campaign.recordDecision(lease, { generation: 0, candidateId: cell.candidateId, parentId: "baseline", status: "accepted", childCommit: "b".repeat(40), parentCommit: frozen.rootCommit, proof: { developmentAccepted: true }, attemptKeys: [attemptKey] })
			await campaign.selectGeneration(lease, 0, [cell.candidateId])
			await campaign.finishDevelopmentArm(lease)
		}
		const snapshot = await campaign.snapshot(campaignId)
		assert.equal((snapshot.campaign as Record<string, unknown>).state, "finished")
		assert.ok((snapshot.arms as Array<Record<string, unknown>>).every((arm) => arm.state === "finished" && arm.phase === "development"))
		assert.equal((snapshot.attempts as Array<Record<string, unknown>>).some((attempt) => attempt.attempt_kind === "confirmation"), false)
		assert.equal((snapshot.events as Array<Record<string, unknown>>).filter((event) => event.event_type === "engineering-development-finished").length, 2)
		await assert.rejects(() => campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-reopen"), /finished/)
	})
})

test("proof campaign enforces frozen per-attempt call, token, and spend ceilings", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule = [{ armId: "fixed", generation: 0, candidateId: "candidate-a", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" as const }]
	const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		frozen.budgets.attempt = { maxCalls: 1, maxTokens: 10, maxSpendUsd: 0.01, maxDurationMs: 1_000 }
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const cell = schedule[0]!
		const attempt = (calls: number, tokens: number, spendUsd: number) => campaign.admit(lease, {
			attemptKey: `attempt-${calls}-${tokens}-${spendUsd}`, kind: cell.attemptKind,
			identity: { generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind },
			requestSha256: "1".repeat(64), calls, tokens, spendUsd,
		})
		await assert.rejects(() => attempt(2, 1, 0.001), /per-attempt ceiling/)
		await assert.rejects(() => attempt(1, 11, 0.001), /per-attempt ceiling/)
		await assert.rejects(() => attempt(1, 10, 0.010001), /per-attempt ceiling/)
		assert.equal((await campaign.snapshot(frozen.campaignId) as { attempts: unknown[] }).attempts.length, 0, "rejected over-limit reservations do not create attempt rows")
	})
})

test("controller freezes paired broker allocations as separate campaigns under one root spend ledger", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, _pool, _root, queue) => {
		const campaignId = `paired-controller-${randomUUID()}`
		const oldEnv = { ...process.env }
		try {
			for (const key of Object.keys(process.env)) if (key.startsWith("HEADLESSCODE_RSI_OPENROUTER_")) delete process.env[key]
			Object.assign(process.env, {
				HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD: "0.32",
				HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD: "0.04",
				HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD: "0.28",
				HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD: "0.0001",
				HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD: "0.0001",
				HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD: "0.01",
				HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD: "0.01",
			})
			const task = {
				id: "proof-task", family: "controller-integration", split: "development" as const, task: "change a real repository behavior",
				startDigest: "a".repeat(64), verifierPath: "verify.mjs", verifierDigest: "b".repeat(64),
				knownGoodPath: "good.patch", knownGoodCommit: "c".repeat(40), knownGoodDigest: "c".repeat(64),
				knownBadPath: "bad.patch", knownBadCommit: "d".repeat(40), knownBadDigest: "d".repeat(64),
				seed: 17, ceilings: { timeoutMs: 5_000, maxCalls: 2, maxOutputTokensPerCall: 128, maxPatchBytes: 16_384 },
			}
			const confirmationTasks = RSI_CONFIRMATION_RETENTION_TASK_IDS.map((id, index) => ({ ...task, id, family: `confirmation-integration-${index}`, split: "confirmation" as const, seed: 23 + index }))
			const developmentManifest = { schemaVersion: 1 as const, runnerVersion: "test", createdFromCommit: "e".repeat(40), tasks: [task, ...confirmationTasks] }
			const protocol = {
				schemaVersion: 1 as const, manifestDigest: "1".repeat(64), taskSetDigest: "2".repeat(64), taskIds: [task.id],
				taskIdentities: [{ id: task.id, family: task.family, seed: task.seed, startDigest: task.startDigest, verifierDigest: task.verifierDigest, ceilings: task.ceilings }],
				model: { provider: "openshell-openrouter", id: RSI_OPENROUTER_MODEL, sampling: { temperature: 0 } },
				rule: { minimumNetWins: 1, retentionTaskIds: [], maximumMeanTokenIncreaseRatio: 1.1 }, protocolDigest: "3".repeat(64),
			}
			const config: RsiConfig = {
				repoRoot: "/repo", model: RSI_OPENROUTER_MODEL, population: 1, generations: 2, maxConcurrent: 1,
				mutationTask: "implement the requested behavior", regressionCommand: "npm test", evalCommands: [], hiddenEvalCommands: [],
				archiveDir: "/archive", worktreeDir: "/worktrees", baseRef: "HEAD", seed: "paired-seed", dryRun: false,
				keepWorktrees: false, maxIterations: 2, maxTokens: 128, protectedPaths: ["src/rsi/"], commandTimeoutMs: 5_000,
			}
			const frozen = createProofCampaignManifest({
				config, campaignId, baseCommit: "f".repeat(40), model: RSI_OPENROUTER_MODEL, provider: "openshell-openrouter",
				runtime: { imageName: "rsi:test", imageDigest: `sha256:${"9".repeat(64)}`, harnessCommit: "8".repeat(40), dependencyLockDigest: "7".repeat(64) },
				developmentManifest, developmentManifestDigest: "4".repeat(64), plannedGenerations: 2, proofProtocol: protocol,
			})
			assert.deepEqual(frozen.armAssignment, { fixedControl: "fixed-control", selfHosted: "self-hosted" })
			assert.equal(frozen.benchmarkDigests.manifest, "4".repeat(64), "the full loaded manifest digest, including runner/version metadata, is frozen")
			assert.deepEqual(frozen.settings.inferenceCampaignIds, { mutation: `${campaignId}:mutation`, benchmark: `${campaignId}:benchmark` })
			assert.deepEqual(frozen.settings.inferenceAllocationsUsd, { mutation: 0.04, benchmark: 0.28 })
			assert.equal(frozen.schedule.filter((cell) => cell.armId === "fixed-control").length, 24)
			assert.equal(frozen.schedule.filter((cell) => cell.armId === "self-hosted").length, 24)
			assert.equal(frozen.schedule.filter((cell) => cell.armId === "fixed-control" && cell.phase === "confirmation").length, 12, "all generation candidate slots and root-control confirmation cells are frozen")
			assert.equal(frozen.budgets.root.maxCalls, 64, "root calls sum mutation calls, all three development proof roles, and selected-final/root confirmation grants for both arms")
			assert.equal(frozen.budgets.root.maxTokens, 1_032_192, "root tokens sum effective task-specific grants rather than the base per-call defaults")
			assert.equal(frozen.budgets.root.maxSpendUsd, 0.32, "root spend is the sum of every frozen provider-job reservation")
			assert.equal(frozen.settings.taskWallBoundMs, 200_000, "the runtime plan sums mutation, required evaluation, development proof, and selected-final/root confirmation deadlines")
			const engineering = createProofCampaignManifest({
				config: { ...config, workerHarnessEngineeringOnly: true }, campaignId: `${campaignId}-engineering`, baseCommit: "f".repeat(40), model: RSI_OPENROUTER_MODEL, provider: "openshell-openrouter",
				runtime: { imageName: "rsi:test", imageDigest: `sha256:${"9".repeat(64)}`, harnessCommit: "8".repeat(40), dependencyLockDigest: "7".repeat(64) },
				developmentManifest, developmentManifestDigest: "4".repeat(64), plannedGenerations: 2, proofProtocol: protocol,
			})
			assert.equal(engineering.phaseMode, "engineering-only")
			assert.ok(engineering.schedule.every((cell) => cell.phase === "development"), "engineering-only authority freezes no confirmation cells")
			assert.deepEqual(engineering.settings.confirmationTaskIdentities, [], "engineering manifest carries no holdout task identities")
			assert.equal(engineering.benchmarkDigests.confirmation, createHash("sha256").update("[]").digest("hex"), "engineering manifest records an empty confirmation schedule, not holdout task identities")
			assert.notEqual(proofCampaignManifestDigest(engineering), proofCampaignManifestDigest(frozen), "phase mode and schedule are bound into the campaign identity")
			assert.throws(() => createProofCampaignManifest({ config: { ...config, maxRuntimeMs: 139_999 }, campaignId: `${campaignId}-short`, baseCommit: "f".repeat(40), model: RSI_OPENROUTER_MODEL, provider: "openshell-openrouter", runtime: { imageName: "rsi:test", imageDigest: `sha256:${"9".repeat(64)}`, harnessCommit: "8".repeat(40), dependencyLockDigest: "7".repeat(64) }, developmentManifest, developmentManifestDigest: "4".repeat(64), plannedGenerations: 2, proofProtocol: protocol }), /below the summed frozen task-time ceiling/)
			process.env.HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD = "0.19"
			process.env.HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD = "0.04"
			process.env.HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD = "0.15"
			assert.throws(() => createProofCampaignManifest({ config, campaignId: `${campaignId}-underfunded`, baseCommit: "f".repeat(40), model: RSI_OPENROUTER_MODEL, provider: "openshell-openrouter", runtime: { imageName: "rsi:test", imageDigest: `sha256:${"9".repeat(64)}`, harnessCommit: "8".repeat(40), dependencyLockDigest: "7".repeat(64) }, developmentManifest, developmentManifestDigest: "4".repeat(64), plannedGenerations: 2, proofProtocol: protocol }), /below development plus selected-final\/root confirmation job reservations/)
			process.env.HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD = "0.32"
			process.env.HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD = "0.04"
			process.env.HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD = "0.28"
			const fixed = await campaign.acquire(frozen, "fixed-control", "run-fixed", "coordinator-fixed")
			const selfHosted = await campaign.acquire(frozen, "self-hosted", "run-self", "coordinator-self")
			assert.equal(fixed.manifestSha256, selfHosted.manifestSha256)
			await assert.rejects(() => campaign.acquire({ ...frozen, benchmarkDigests: { ...frozen.benchmarkDigests, manifest: "5".repeat(64) } }, "fixed-control", "run-fixed", "coordinator-tampered"), /manifest or root budget changed/)
			const mutationCell = frozen.schedule.find((cell) => cell.armId === fixed.armId && cell.attemptKind === "mutation")!
			const benchmarkCell = frozen.schedule.find((cell) => cell.armId === fixed.armId && cell.attemptKind === "development-proof")!
			await campaign.admit(fixed, { attemptKey: "role-mutation-attempt", kind: "mutation", identity: { generation: mutationCell.generation, candidateId: mutationCell.candidateId, taskId: mutationCell.taskId, seed: mutationCell.seed, attemptKind: mutationCell.attemptKind }, requestSha256: "a".repeat(64), calls: 1, tokens: 10, spendUsd: 0.01 })
			await campaign.admit(fixed, { attemptKey: "role-benchmark-attempt", kind: "development-proof", identity: { generation: benchmarkCell.generation, candidateId: benchmarkCell.candidateId, taskId: benchmarkCell.taskId, seed: benchmarkCell.seed, attemptKind: benchmarkCell.attemptKind }, sourceCandidateId: "g0-candidate-0", requestSha256: "b".repeat(64), calls: 1, tokens: 10, spendUsd: 0.01 })
			const proofSnapshot = await campaign.snapshot(campaignId)
			assert.equal(Number((proofSnapshot.campaign as Record<string, unknown>).reserved_spend_microusd), 20_000, "both allocations reserve against the same root spend ledger")
			const limits = ["mutation", "benchmark"].map((role) => openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(process.env, role as "mutation" | "benchmark"), proofBrokerCampaignId(campaignId, role as "mutation" | "benchmark"), { maxCalls: 1, maxDurationMs: 5_000 }))
			assert.deepEqual(limits.map((limit) => limit.maxCampaignSpendUsd), [0.04, 0.28])
			await queue.registerWorker({ workerId: "paired-broker-worker", gatewayId: "proof-gateway", hostname: "proof-host", maxActive: 1, resourceClasses: ["REMOTE_API"] })
			for (const [index, role] of (["mutation", "benchmark"] as const).entries()) {
				const artifact = await queue.putArtifact(Buffer.from(`paired ${role} broker request`))
				const brokerPayload = { schemaVersion: 1 as const, snapshotSha256: artifact.sha256, snapshotBytes: artifact.byteLength, snapshotCommit: "a".repeat(40), task: `mock ${role} request`, model: RSI_OPENROUTER_MODEL, provider: "openrouter" as const, inferenceLimits: limits[index], maxIterations: 1, timeoutMs: 5_000, protectedPaths: [], candidate: { id: `candidate-${role}` } }
				const job = await queue.enqueue({ idempotencyKey: `${campaignId}:${role}:broker-job`, runId: fixed.runId, candidateId: `candidate-${role}`, jobKind: "mutation", resourceClass: "REMOTE_API", artifactSha256: artifact.sha256, payload: brokerPayload })
				const leased = await queue.claim("paired-broker-worker")
				assert.ok(leased)
				assert.equal(leased.job.jobId, job.jobId)
				const grant: OpenRouterBrokerGrant = { jobId: job.jobId, leaseToken: leased.token, capability: `paired-capability-${role}`, model: RSI_OPENROUTER_MODEL, limits: limits[index]! }
				await queue.register(grant)
				assert.equal(await queue.fail(leased, "test grant registered"), true)
			}
			const brokerCampaigns = (await _pool.query("SELECT campaign_id,max_spend_microusd FROM headlesscode_rsi_inference_campaigns WHERE campaign_id=ANY($1::text[]) ORDER BY campaign_id", [[proofBrokerCampaignId(campaignId, "benchmark"), proofBrokerCampaignId(campaignId, "mutation")]])).rows
			assert.equal(brokerCampaigns.length, 2)
			assert.deepEqual(brokerCampaigns.map((row) => [row.campaign_id, Number(row.max_spend_microusd)]), [[`${campaignId}:benchmark`, 280_000], [`${campaignId}:mutation`, 40_000]])
			const snapshot = await campaign.snapshot(campaignId)
			assert.deepEqual((snapshot.arms as Array<Record<string, unknown>>).map((arm) => [arm.arm_id, arm.run_id]).sort(), [
				["fixed-control", "run-fixed"], ["self-hosted", "run-self"],
			])
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
			Object.assign(process.env, oldEnv)
		}
	})
})

test("development completion preserves frozen confirmation cells for fenced post-development admission", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "candidate-a", taskId: "mutation", seed: "seed-0", attemptKind: "mutation", phase: "development" },
			{ armId: "self", generation: 0, candidateId: "candidate-self", taskId: "mutation", seed: "seed-0", attemptKind: "mutation", phase: "development" },
			{ armId: "fixed", generation: 0, candidateId: "candidate-a", taskId: "hidden", seed: "seed-1", attemptKind: "confirmation", phase: "confirmation" },
			{ armId: "fixed", generation: 0, candidateId: "candidate-b", taskId: "hidden", seed: "seed-1", attemptKind: "confirmation", phase: "confirmation" },
			{ armId: "fixed", generation: 0, candidateId: "root-control", taskId: "hidden", seed: "seed-1", attemptKind: "fixed-control", phase: "confirmation" },
		]
		const frozen = manifest("campaign-" + randomUUID(), schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-dev")
		await assert.rejects(() => admit(campaign, lease, schedule[2]!, "early-confirmation"), /cannot be admitted during the development phase/)
		const dev = schedule[0]!
		await admit(campaign, lease, dev, "development-mutation")
		await campaign.markDispatched(lease, "development-mutation")
		await campaign.settle(lease, "development-mutation", { status: "completed", resultSha256: "1".repeat(64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
		await campaign.recordDecision(lease, { generation: 0, candidateId: "candidate-a", parentId: "baseline", status: "accepted", childCommit: "2".repeat(40), parentCommit: frozen.rootCommit, proof: { developmentPassed: true }, attemptKeys: ["development-mutation"] })
		await campaign.selectGeneration(lease, 0, ["candidate-a"])
		await campaign.finishDevelopmentArm(lease)
		await campaign.finishDevelopmentArm(lease)
		await assert.rejects(() => campaign.finishArm(lease, ["candidate-a"]), /stale coordinator/)
		await assert.rejects(() => campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-early-confirmation"), /until both arms finish development/)
		const selfLease = await campaign.acquire(frozen, "self", "run-self", "coordinator-self-dev")
		const selfCell = schedule[1]!
		await admit(campaign, selfLease, selfCell, "self-development-mutation")
		await campaign.markDispatched(selfLease, "self-development-mutation")
		await campaign.settle(selfLease, "self-development-mutation", { status: "completed", resultSha256: "6".repeat(64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
		await campaign.recordDecision(selfLease, { generation: 0, candidateId: "candidate-self", parentId: "baseline", status: "accepted", childCommit: "7".repeat(40), parentCommit: frozen.rootCommit, proof: { developmentPassed: true }, attemptKeys: ["self-development-mutation"] })
		await campaign.selectGeneration(selfLease, 0, ["candidate-self"])
		await campaign.finishDevelopmentArm(selfLease)
		const confirmationLease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-confirmation")
		assert.equal(confirmationLease.epoch, lease.epoch + 1)
		assert.equal(confirmationLease.phase, "confirmation")
		await assert.rejects(() => campaign.finishArm(confirmationLease, ["candidate-a"]), /missing, incomplete, or uncertain frozen task cell/)
		await campaign.selectFinalHarness(confirmationLease, { generation: 0, candidateId: "candidate-a", commit: "2".repeat(40) })
		await campaign.markNotSelected(confirmationLease, { attemptKey: "not-selected-b", generation: 0, candidateId: "candidate-b", taskId: "hidden", seed: "seed-1", reason: "slot was not selected by the development decision" })
		await assert.rejects(() => campaign.markNotSelected(confirmationLease, { attemptKey: "not-selected-a", generation: 0, candidateId: "candidate-a", taskId: "hidden", seed: "seed-1", reason: "selected slots cannot be skipped" }), /selected or undecided/)
		for (const cell of [schedule[2]!, schedule[4]!]) {
			const key = "confirmation-" + cell.candidateId
			await campaign.admit(confirmationLease, { attemptKey: key, kind: cell.attemptKind, identity: { generation: 0, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind }, requestSha256: "3".repeat(64), calls: 1, tokens: 10, spendUsd: 0.01 })
			await campaign.markDispatched(confirmationLease, key)
			await campaign.settle(confirmationLease, key, { status: "completed", resultSha256: cell.candidateId === "root-control" ? "5".repeat(64) : "4".repeat(64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
		}
		await campaign.finishArm(confirmationLease, ["candidate-a"])
		const snapshot = await campaign.snapshot(frozen.campaignId)
		assert.equal((snapshot.arms as Array<Record<string, unknown>>)[0]?.state, "finished")
		assert.ok((snapshot.attempts as Array<Record<string, unknown>>).some((attempt) => attempt.status === "not-selected" && attempt.candidate_id === "candidate-b"))
	})
})

test("development-phase finalization is replay-safe and prevents later development admissions", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "fixed-candidate", taskId: "mutation", seed: "seed-0", attemptKind: "mutation", phase: "development" },
			{ armId: "self", generation: 0, candidateId: "self-candidate", taskId: "mutation", seed: "seed-0", attemptKind: "mutation", phase: "development" },
			{ armId: "fixed", generation: 0, candidateId: "fixed-candidate", taskId: "hidden", seed: "seed-1", attemptKind: "confirmation", phase: "confirmation" },
			{ armId: "self", generation: 0, candidateId: "self-candidate", taskId: "hidden", seed: "seed-1", attemptKind: "confirmation", phase: "confirmation" },
		]
		const frozen = manifest(`phase-replay-${randomUUID()}`, schedule)
		const fixed = await campaign.acquire(frozen, "fixed", "run-fixed", "dev-fixed")
		await admit(campaign, fixed, schedule[0]!, "fixed-dev")
		await campaign.markDispatched(fixed, "fixed-dev")
		await campaign.settle(fixed, "fixed-dev", { status: "completed", resultSha256: "8".repeat(64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
		await campaign.recordDecision(fixed, { generation: 0, candidateId: "fixed-candidate", parentId: "baseline", status: "accepted", childCommit: "9".repeat(40), parentCommit: frozen.rootCommit, proof: { ok: true }, attemptKeys: ["fixed-dev"] })
		await campaign.selectGeneration(fixed, 0, ["fixed-candidate"])
		await campaign.finishDevelopmentArm(fixed)
		await campaign.finishDevelopmentArm(fixed) // DB committed, archive checkpoint may not have happened.
		await assert.rejects(() => campaign.acquire(frozen, "fixed", "run-fixed", "confirmation-too-early"), /until both arms finish development/)
		const self = await campaign.acquire(frozen, "self", "run-self", "dev-self")
		await admit(campaign, self, schedule[1]!, "self-dev")
		await campaign.markDispatched(self, "self-dev")
		await campaign.settle(self, "self-dev", { status: "completed", resultSha256: "a".repeat(64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
		await campaign.recordDecision(self, { generation: 0, candidateId: "self-candidate", parentId: "baseline", status: "accepted", childCommit: "c".repeat(40), parentCommit: frozen.rootCommit, proof: { ok: true }, attemptKeys: ["self-dev"] })
		await campaign.selectGeneration(self, 0, ["self-candidate"])
		await campaign.finishDevelopmentArm(self)
		const recoveredFixed = await campaign.acquire(frozen, "fixed", "run-fixed", "confirmation-fixed")
		assert.equal(recoveredFixed.phase, "confirmation")
		await assert.rejects(() => admit(campaign, recoveredFixed, schedule[0]!, "late-development"), /cannot be admitted during the confirmation phase/)
		await assert.rejects(() => campaign.skipAfterHardGate(recoveredFixed, { attemptKey: "late-skip", identity: { generation: 0, candidateId: "fixed-candidate", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" }, requestSha256: "1".repeat(64), reason: "late skip" }), /hard-gate skips cannot be added after the development phase closes/)
		await assert.rejects(() => campaign.recordDecision(recoveredFixed, { generation: 0, candidateId: "fixed-candidate", parentId: "baseline", status: "accepted", childCommit: "9".repeat(40), parentCommit: frozen.rootCommit, proof: { ok: true }, attemptKeys: ["fixed-dev"] }), /candidate decisions are closed after the development phase/)
		await assert.rejects(() => campaign.selectGeneration(recoveredFixed, 0, ["fixed-candidate"]), /generation selections are closed after the development phase/)
		await campaign.finishDevelopmentArm(recoveredFixed) // Read-only replay is safe under the new fenced lease.
	})
})

test("proof campaign generation selection waits for every frozen task and candidate decision", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule = [
			{ armId: "fixed", generation: 0, candidateId: "candidate-a", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" as const },
			{ armId: "fixed", generation: 0, candidateId: "candidate-b", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" as const },
		]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const attemptKeys = new Map<string, string>()
		for (const cell of schedule) {
			const key = `attempt-${cell.candidateId}`
			attemptKeys.set(cell.candidateId, key)
			await admit(campaign, lease, cell, key)
			await campaign.settle(lease, key, { status: "completed", resultSha256: "2".repeat(64), actualCalls: 1, actualTokens: 20, actualSpendUsd: 0.01 })
		}
		await campaign.recordDecision(lease, { generation: 0, candidateId: "candidate-a", parentId: "baseline", status: "accepted", childCommit: "3".repeat(40), parentCommit: "a".repeat(40), proof: { passes: 1 }, attemptKeys: [attemptKeys.get("candidate-a")!] })
		await assert.rejects(() => campaign.selectGeneration(lease, 0, ["candidate-a"]), /every scheduled candidate needs a durable decision/)
		await campaign.recordDecision(lease, { generation: 0, candidateId: "candidate-b", parentId: "baseline", status: "rejected", childCommit: "4".repeat(40), parentCommit: "a".repeat(40), proof: { passes: 0 }, attemptKeys: [attemptKeys.get("candidate-b")!] })
		await campaign.selectGeneration(lease, 0, ["candidate-a"])
		await campaign.selectGeneration(lease, 0, ["candidate-a"])
		await assert.rejects(() => campaign.selectGeneration(lease, 0, []), /conflicts with an earlier durable selection/)
	})
})

test("hard-gate-dependent cells are durable zero-spend skips for rejected candidates only", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "candidate-a", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
			{ armId: "fixed", generation: 0, candidateId: "candidate-a", taskId: "typecheck", seed: "seed-0", attemptKind: "verification" },
			{ armId: "fixed", generation: 0, candidateId: "candidate-a:child", taskId: "task-a", seed: "seed-0", attemptKind: "development-proof" },
		]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		for (const cell of schedule.slice(0, 2)) {
			const key = `attempt-${cell.taskId}`
			await admit(campaign, lease, cell, key)
			await campaign.settle(lease, key, { status: "completed", resultSha256: "2".repeat(64), actualCalls: 0, actualTokens: 0, actualSpendUsd: 0 })
		}
		const skipped = schedule[2]!
		await campaign.skipAfterHardGate(lease, {
			attemptKey: "skip-development-task-a",
			identity: { generation: skipped.generation, candidateId: skipped.candidateId, taskId: skipped.taskId, seed: skipped.seed, attemptKind: skipped.attemptKind },
			requestSha256: "3".repeat(64), reason: "typecheck hard gate failed; no benchmark dispatch occurred",
		})
		await campaign.recordDecision(lease, { generation: 0, candidateId: "candidate-a", parentId: "baseline", status: "rejected", childCommit: "4".repeat(40), parentCommit: "a".repeat(40), proof: { hardGate: "typecheck-failed", skippedCells: 1 }, attemptKeys: ["attempt-mutation", "attempt-typecheck", "skip-development-task-a"] })
		const snapshot = await campaign.snapshot(frozen.campaignId)
		const skippedAttempt = (snapshot.attempts as Array<Record<string, unknown>>).find((attempt) => attempt.attempt_key === "skip-development-task-a")!
		assert.equal(skippedAttempt.status, "skipped-after-hard-gate")
		assert.equal(Number(skippedAttempt.reserved_calls), 0)
		assert.equal(Number(skippedAttempt.reserved_tokens), 0)
		assert.equal(Number(skippedAttempt.reserved_spend_microusd), 0)
		assert.equal(Number((snapshot.campaign as Record<string, unknown>).reserved_calls), 0)
		assert.equal(Number((snapshot.campaign as Record<string, unknown>).used_calls), 0)
		await assert.rejects(() => campaign.recordDecision(lease, { generation: 0, candidateId: "candidate-a", parentId: "baseline", status: "accepted", childCommit: "6".repeat(40), parentCommit: "a".repeat(40), proof: { passes: 1 }, attemptKeys: ["attempt-mutation", "attempt-typecheck", "skip-development-task-a"] }), /incomplete, uncertain, or missing/)
		await campaign.selectGeneration(lease, 0, [])
	})
})

test("generation n+1 decisions must reference the exact selected parent from generation n", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-1", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
			{ armId: "fixed", generation: 1, candidateId: "g1-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
		]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		for (const [index, cell] of schedule.entries()) {
			const key = `attempt-${index}`
			await admit(campaign, lease, cell, key)
			await campaign.settle(lease, key, { status: "completed", resultSha256: `${index + 1}`.repeat(64).slice(0, 64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
		}
		await campaign.recordDecision(lease, { generation: 0, candidateId: "g0-candidate-0", parentId: "baseline", status: "accepted", childCommit: "3".repeat(40), parentCommit: frozen.rootCommit, proof: { passed: true }, attemptKeys: ["attempt-0"] })
		await campaign.recordDecision(lease, { generation: 0, candidateId: "g0-candidate-1", parentId: "baseline", status: "rejected", childCommit: "4".repeat(40), parentCommit: frozen.rootCommit, proof: { passed: false }, attemptKeys: ["attempt-1"] })
		await campaign.selectGeneration(lease, 0, ["g0-candidate-0"])
		await assert.rejects(() => campaign.recordDecision(lease, { generation: 1, candidateId: "g1-candidate-0", parentId: "baseline", status: "accepted", childCommit: "5".repeat(40), parentCommit: frozen.rootCommit, proof: { passed: true }, attemptKeys: ["attempt-2"] }), /empty immediately preceding generation/)
		await assert.rejects(() => campaign.recordDecision(lease, { generation: 1, candidateId: "g1-candidate-0", parentId: "g0-candidate-1", status: "accepted", childCommit: "5".repeat(40), parentCommit: "4".repeat(40), proof: { passed: true }, attemptKeys: ["attempt-2"] }), /previously accepted campaign lineage commit/)
		await campaign.recordDecision(lease, { generation: 1, candidateId: "g1-candidate-0", parentId: "g0-candidate-0", status: "accepted", childCommit: "5".repeat(40), parentCommit: "3".repeat(40), proof: { passed: true }, attemptKeys: ["attempt-2"] })
	})
})

test("empty generation may restart from root with explicit non-recursive lineage", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
			{ armId: "fixed", generation: 1, candidateId: "g1-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
		]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		for (const [index, cell] of schedule.entries()) {
			const key = `root-restart-${index}`
			await admit(campaign, lease, cell, key)
			await campaign.settle(lease, key, { status: "completed", resultSha256: `${index + 1}`.repeat(64).slice(0, 64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
		}
		await campaign.recordDecision(lease, { generation: 0, candidateId: "g0-candidate-0", parentId: "baseline", status: "rejected", childCommit: "3".repeat(40), parentCommit: frozen.rootCommit, proof: { passed: false }, attemptKeys: ["root-restart-0"] })
		await campaign.selectGeneration(lease, 0, [])
		await campaign.recordDecision(lease, { generation: 1, candidateId: "g1-candidate-0", parentId: "baseline", status: "accepted", childCommit: "4".repeat(40), parentCommit: frozen.rootCommit, proof: { passed: true, lineage: "root-restart" }, attemptKeys: ["root-restart-1"] })
		const snapshot = await campaign.snapshot(frozen.campaignId)
		const gen1 = (snapshot.decisions as Array<Record<string, unknown>>).find((decision) => decision.candidate_id === "g1-candidate-0")
		assert.equal(gen1?.lineage_kind, "root-restart", "analysis can distinguish a new root branch from a recursive parent transition")
	})
})

test("candidate can branch from an older selected ancestor after an empty intervening generation", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
			{ armId: "fixed", generation: 1, candidateId: "g1-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
			{ armId: "fixed", generation: 2, candidateId: "g2-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
		]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		for (const [index, cell] of schedule.entries()) {
			const key = `ancestor-attempt-${index}`
			await admit(campaign, lease, cell, key)
			await campaign.settle(lease, key, { status: "completed", resultSha256: `${index + 1}`.repeat(64).slice(0, 64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
		}
		await campaign.recordDecision(lease, { generation: 0, candidateId: "g0-candidate-0", parentId: "baseline", status: "accepted", childCommit: "5".repeat(40), parentCommit: frozen.rootCommit, proof: { passed: true }, attemptKeys: ["ancestor-attempt-0"] })
		await campaign.selectGeneration(lease, 0, ["g0-candidate-0"])
		await campaign.recordDecision(lease, { generation: 1, candidateId: "g1-candidate-0", parentId: "g0-candidate-0", status: "rejected", childCommit: "6".repeat(40), parentCommit: "5".repeat(40), proof: { passed: false }, attemptKeys: ["ancestor-attempt-1"] })
		await campaign.selectGeneration(lease, 1, [])
		await campaign.recordDecision(lease, { generation: 2, candidateId: "g2-candidate-0", parentId: "g0-candidate-0", status: "accepted", childCommit: "7".repeat(40), parentCommit: "5".repeat(40), proof: { passed: true }, attemptKeys: ["ancestor-attempt-2"] })
		const decisions = (await campaign.snapshot(frozen.campaignId)).decisions as Array<Record<string, unknown>>
		const generationTwo = decisions.find((entry) => entry.candidate_id === "g2-candidate-0")!
		assert.equal(generationTwo.lineage_kind, "selected-ancestor")
		assert.equal(Number(generationTwo.parent_generation), 0)
	})
})

test("benchmark artifact written before database settlement is reconciled after arm recovery", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool) => {
		const cell = { armId: "fixed", generation: 0, candidateId: "g0-candidate-0:child", taskId: "task-a", seed: "seed-0", attemptKind }
		const frozen = manifest(`campaign-${randomUUID()}`, [cell])
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const attemptKey = "written-file-before-settle"
		const identity = { generation: 0, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind }
		const requestSha256 = "1".repeat(64)
		const reservation = { calls: 1, tokens: 100, spendUsd: 0.1 }
		await campaign.admit(lease, { attemptKey, kind: attemptKind, identity, requestSha256, ...reservation })
		await campaign.markDispatched(lease, attemptKey)
		await pool.query("UPDATE headlesscode_rsi_proof_campaign_arms SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE campaign_id=$1 AND arm_id=$2", [frozen.campaignId, lease.armId])
		const recovered = await campaign.acquire(frozen, lease.armId, lease.runId, "coordinator-2")
		assert.equal((await campaign.admit(recovered, { attemptKey, kind: attemptKind, identity, requestSha256, ...reservation })).status, "dispatched")
		const settlement = { status: "completed" as const, resultSha256: "9".repeat(64), artifactRefs: { stdout: { sha256: "a".repeat(64) }, stderr: { sha256: "b".repeat(64) } }, actualCalls: 1, actualTokens: 25, actualSpendUsd: 0.01 }
		await campaign.settle(recovered, attemptKey, settlement)
		const attempt = ((await campaign.snapshot(frozen.campaignId)).attempts as Array<Record<string, unknown>>)[0]!
		assert.equal(attempt.status, "completed")
		assert.equal(Number(attempt.epoch), recovered.epoch)
	})
})

test("completed benchmark settlement can be replayed after epoch recovery but changed artifacts fail", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool) => {
		const cell = { armId: "fixed", generation: 0, candidateId: "g0-candidate-0:child", taskId: "task-a", seed: "seed-0", attemptKind }
		const frozen = manifest(`campaign-${randomUUID()}`, [cell])
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const attemptKey = "completed-before-archive"
		const identity = { generation: 0, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind }
		const requestSha256 = "1".repeat(64)
		const reservation = { calls: 1, tokens: 100, spendUsd: 0.1 }
		await campaign.admit(lease, { attemptKey, kind: attemptKind, identity, requestSha256, ...reservation })
		await campaign.markDispatched(lease, attemptKey)
		const settlement = { status: "completed" as const, resultSha256: "9".repeat(64), artifactRefs: { stdout: { sha256: "a".repeat(64) }, stderr: { sha256: "b".repeat(64) } }, actualCalls: 1, actualTokens: 25, actualSpendUsd: 0.01 }
		await campaign.settle(lease, attemptKey, settlement)
		await pool.query("UPDATE headlesscode_rsi_proof_campaign_arms SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE campaign_id=$1 AND arm_id=$2", [frozen.campaignId, lease.armId])
		const recovered = await campaign.acquire(frozen, lease.armId, lease.runId, "coordinator-2")
		assert.equal((await campaign.admit(recovered, { attemptKey, kind: attemptKind, identity, requestSha256, ...reservation })).status, "completed")
		await campaign.settle(recovered, attemptKey, settlement)
		await assert.rejects(() => campaign.settle(recovered, attemptKey, { ...settlement, artifactRefs: { stdout: { sha256: "c".repeat(64) }, stderr: { sha256: "b".repeat(64) } } }), /conflicting duplicate/)
	})
})

test("runner replays a saved benchmark file through settlement after a crash and never calls the agent twice", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool, root) => {
		const loaded = await loadBenchmark(path.resolve("fixtures/rsi-benchmark/smoke"))
		const task = loaded.manifest.tasks.find((entry) => entry.id === "multi-01")!
		const cell = { armId: "fixed", generation: 0, candidateId: "g0-candidate-0:child", taskId: task.id, seed: String(task.seed), attemptKind }
		const frozen = manifest(`campaign-${randomUUID()}`, [cell])
		frozen.model = { provider: "openshell-openrouter", id: RSI_OPENROUTER_MODEL, settings: {} }
		frozen.budgets.attempt = { maxCalls: task.ceilings.maxCalls, maxTokens: 100, maxSpendUsd: 0.1, maxDurationMs: task.ceilings.timeoutMs }
		frozen.budgets.root = { maxCalls: 100, maxTokens: 10_000, maxSpendUsd: 1, maxRuntimeMs: 60_000 }
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		let activeLease = lease
		const outputRoot = path.join(root, "benchmark-replay")
		let agentRuns = 0
		let simulateCrash = true
		const harnessCommit = "e".repeat(40)
		const modelId = RSI_OPENROUTER_MODEL
		const sampling: Record<string, number | string | boolean> = { temperature: 0, think: false, seed: "provider-default" }
		const agent: BenchmarkAgent = {
			provider: "openshell-openrouter",
			async run(request) {
				agentRuns++
				const oracle = JSON.parse(await fs.readFile(path.join(loaded.fixtureRoot, task.knownGoodPath!), "utf8")) as { files: Record<string, string> }
				const candidate = path.join(root, "fake-benchmark-agent")
				await fs.rm(candidate, { recursive: true, force: true })
				execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--shared", request.workspace, candidate], { stdio: ["ignore", "pipe", "pipe"] })
				try {
					execFileSync("git", ["config", "user.name", "RSI Proof Test"], { cwd: candidate })
					execFileSync("git", ["config", "user.email", "rsi-proof-test@invalid.example"], { cwd: candidate })
					for (const [relative, content] of Object.entries(oracle.files)) {
						const target = path.join(candidate, relative)
						await fs.mkdir(path.dirname(target), { recursive: true })
						await fs.writeFile(target, content)
					}
					execFileSync("git", ["add", "--all"], { cwd: candidate, stdio: "ignore" })
					execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fake benchmark patch"], { cwd: candidate, stdio: "ignore" })
					const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: candidate, encoding: "utf8" }).trim()
					const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", `${base}...HEAD`], { cwd: candidate, encoding: "buffer" })
				return {
					validity: "valid", patch, stdout: "bounded mock response", stderr: "", calls: 1, tokens: 22, wallTimeMs: 10, stopReason: "mock-complete",
				inferenceReceipt: { provider: "openrouter", endpointProvider: "deepinfra", profileId: "deepseek-deepinfra-fp8", jobId: request.attemptId, campaignId: frozen.campaignId, model: request.model.id, returnedModels: [request.model.id], returnedProviders: ["deepinfra"], calls: 1, promptTokens: 10, completionTokens: 12, totalTokens: 22, costUsd: 0.001, accounting: "supervisor-enforced", qualified: true, callReceipts: [], denials: [] },
			}
				} finally { await fs.rm(candidate, { recursive: true, force: true }) }
			},
			async verifyReceipt() { return true },
		}
		const verifier: BenchmarkVerifier = {
			async run(verifyTask, fixtureRoot, workspace) {
				const oracle = JSON.parse(await fs.readFile(path.join(fixtureRoot, verifyTask.knownGoodPath!), "utf8")) as { files: Record<string, string> }
				for (const [relative, content] of Object.entries(oracle.files)) if (await fs.readFile(path.join(workspace, relative), "utf8") !== content) return { success: false, output: `mismatch: ${relative}` }
				return { success: true, output: "mock verifier passed" }
			},
		}
		const options = {
			loaded, agent, verifier, harnessCommit, modelId, sampling, split: "development" as const, outputRoot,
			taskIds: [task.id], inferenceCampaignId: frozen.campaignId, attemptNamespace: "g0-candidate-0:child",
			attemptLifecycle: {
				beforeAttempt: async ({ task: current, attemptId, campaignId, harnessCommit: commit, agentImage, model, sampling: sample }: { task: BenchmarkTask; attemptId: string; campaignId: string; harnessCommit: string; agentImage: BenchmarkImageIdentity | null; model: string; sampling: Record<string, number | string | boolean> }) => {
					const request = { taskId: current.id, attemptId, campaignId, harnessCommit: commit, agentImage, model, sampling: sample, seed: current.seed, startDigest: current.startDigest, verifierDigest: current.verifierDigest, ceilings: current.ceilings }
					const requestSha256 = createHash("sha256").update(JSON.stringify(request)).digest("hex")
					const attemptKey = `development:${cell.candidateId}:${attemptId}`
					const admitted = await campaign.admit(activeLease, { attemptKey, brokerJobId: attemptId, kind: attemptKind, identity: { generation: 0, candidateId: cell.candidateId, taskId: current.id, seed: String(current.seed), attemptKind }, requestSha256, calls: current.ceilings.maxCalls, tokens: 100, spendUsd: 0.1 })
					if (admitted.status !== "admitted") throw new Error("proof attempt must be freshly admitted before the fake agent runs")
					await campaign.markDispatched(activeLease, attemptKey)
					return requestSha256
				},
				settledAttempt: async ({ attempt }: { task: BenchmarkTask; attempt: import("../benchmark/types.js").BenchmarkAttempt }) => {
					if (simulateCrash) { simulateCrash = false; throw new Error("simulated coordinator crash after attempt file write") }
					const attemptKey = `development:${cell.candidateId}:${attempt.attemptId}`
					const admitted = await campaign.admit(activeLease, { attemptKey, brokerJobId: attempt.attemptId, kind: attemptKind, identity: { generation: 0, candidateId: cell.candidateId, taskId: task.id, seed: String(task.seed), attemptKind }, requestSha256: attempt.proofRequestSha256!, calls: task.ceilings.maxCalls, tokens: 100, spendUsd: 0.1 })
					if (admitted.status === "admitted" || admitted.status === "dispatched") await campaign.markDispatched(activeLease, attemptKey)
					else if (admitted.status !== "completed") throw new Error(`unexpected resumed campaign status: ${admitted.status}`)
					const receipt = attempt.inferenceReceipt!
					await campaign.settle(activeLease, attemptKey, { status: "completed", resultSha256: createHash("sha256").update(JSON.stringify(attempt)).digest("hex"), artifactRefs: Object.fromEntries(Object.entries(attempt.artifactRefs).map(([key, value]) => [key, { sha256: value }])), actualCalls: receipt.calls, actualTokens: receipt.totalTokens!, actualSpendUsd: receipt.costUsd! })
				},
			},
		}
		await assert.rejects(() => runBenchmark(options), /simulated coordinator crash/)
		assert.equal(agentRuns, 1)
		await pool.query("UPDATE headlesscode_rsi_proof_campaign_arms SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE campaign_id=$1 AND arm_id=$2", [frozen.campaignId, lease.armId])
		activeLease = await campaign.acquire(frozen, lease.armId, lease.runId, "coordinator-2")
		const replay = await runBenchmark(options)
		assert.equal(replay.length, 1)
		assert.equal(replay[0]?.proofQualified, true)
		assert.equal(agentRuns, 1, "saved benchmark bytes are independently rechecked and settled without a second provider call")
		const saved = (await campaign.snapshot(frozen.campaignId)).attempts as Array<Record<string, unknown>>
		assert.equal(saved[0]?.status, "completed")
		assert.equal(Number(saved[0]?.epoch), activeLease.epoch)
	})
})

test("runner refuses to redispatch a dispatched benchmark cell when its local attempt file is missing", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, _pool, root) => {
		const loaded = await loadBenchmark(path.resolve("fixtures/rsi-benchmark/smoke"))
		const task = loaded.manifest.tasks.find((entry) => entry.id === "multi-01")!
		const cell = { armId: "fixed", generation: 0, candidateId: "g0-candidate-0:child", taskId: task.id, seed: String(task.seed), attemptKind }
		const frozen = manifest(`campaign-${randomUUID()}`, [cell])
		frozen.budgets.attempt.maxCalls = task.ceilings.maxCalls
		frozen.budgets.root.maxCalls = 100
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const harnessCommit = "e".repeat(40)
		const modelId = RSI_OPENROUTER_MODEL
		const sampling: Record<string, number | string | boolean> = { temperature: 0, think: false, seed: "provider-default" }
		let agentRuns = 0
		const agent: BenchmarkAgent = { provider: "fake-model", async run() { agentRuns++; throw new Error("must not run") } }
		const verifier: BenchmarkVerifier = { async run() { throw new Error("must not verify without an agent result") } }
		const outputRoot = path.join(root, "missing-dispatched-attempt")
		const options = {
			loaded, agent, verifier, harnessCommit, modelId, sampling, split: "development" as const, outputRoot,
			taskIds: [task.id], inferenceCampaignId: frozen.campaignId, attemptNamespace: cell.candidateId,
			attemptLifecycle: {
				beforeAttempt: async ({ task: current, attemptId, campaignId, harnessCommit: commit, agentImage, model, sampling: sample }: { task: BenchmarkTask; attemptId: string; campaignId: string; harnessCommit: string; agentImage: BenchmarkImageIdentity | null; model: string; sampling: Record<string, number | string | boolean> }) => {
					const request = { taskId: current.id, attemptId, campaignId, harnessCommit: commit, agentImage, model, sampling: sample, seed: current.seed, startDigest: current.startDigest, verifierDigest: current.verifierDigest, ceilings: current.ceilings }
					const attemptKey = `development:${cell.candidateId}:${attemptId}`
					const admission = await campaign.admit(lease, { attemptKey, brokerJobId: attemptId, kind: attemptKind, identity: { generation: 0, candidateId: cell.candidateId, taskId: current.id, seed: String(current.seed), attemptKind }, requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"), calls: current.ceilings.maxCalls, tokens: 100, spendUsd: 0.1 })
					if (admission.status === "admitted") {
						await campaign.markDispatched(lease, attemptKey)
						throw new Error("simulated crash after durable dispatch, before local attempt write")
					}
					throw new Error(`dispatched attempt has no verified local artifact (${admission.status}); refusing to dispatch it again`)
				},
				settledAttempt: async () => { throw new Error("no saved attempt exists") },
			},
		}
		await assert.rejects(() => runBenchmark(options), /simulated crash after durable dispatch/)
		await assert.rejects(() => runBenchmark(options), /refusing to dispatch it again/)
		assert.equal(agentRuns, 0, "a dispatched but unreconciled cell must never invoke the provider again")
		const attempts = (await campaign.snapshot(frozen.campaignId)).attempts as Array<Record<string, unknown>>
		assert.equal(attempts[0]?.status, "dispatched")
	})
})

test("proof campaign terminal arms cannot be reacquired after coordinator completion", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule = [{ armId: "fixed", generation: 0, candidateId: "candidate-a", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" as const }]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		await admit(campaign, lease, schedule[0]!, "attempt-a")
		await campaign.settle(lease, "attempt-a", { status: "completed", resultSha256: "2".repeat(64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
		await campaign.recordDecision(lease, { generation: 0, candidateId: "candidate-a", parentId: "baseline", status: "rejected", childCommit: "3".repeat(40), parentCommit: frozen.rootCommit, proof: { passed: false }, attemptKeys: ["attempt-a"] })
		await campaign.selectGeneration(lease, 0, [])
		await campaign.finishArm(lease, [])
		await assert.rejects(() => campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-2"), /terminal and cannot be reacquired/)
		const recovered = await campaign.snapshot(frozen.campaignId)
		assert.equal((recovered.arms as Array<Record<string, unknown>>)[0]?.state, "finished", "a finished ledger remains available to rebuild a lost JSON archive view")
	})
})

test("finished ledger rebuilds the final report from a reloaded active-run checkpoint", async () => {
	const archiveDir = await mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/rsi-proof-archive-rebuild-`)
	try {
		const candidate: CandidateRecord = {
			id: "candidate-one", generation: 0, parent: "baseline", branch: "rsi/candidate-one", worktree: "/tmp/candidate-one",
			baseCommit: "a".repeat(40), status: "accepted", model: "test/model", mutation: "test mutation",
			createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z", commits: ["b".repeat(40)], changedFiles: ["src/example.ts"], protectedPathViolations: [],
		}
		const run: RsiRunRecord = {
			runId: "finished-run", startedAt: "2026-01-01T00:00:00.000Z", model: "test/model", baseRef: "main", baseCommit: "a".repeat(40),
			generations: 1, candidates: [candidate], reports: [], confirmationEvidence: "complete",
			proofConfirmation: {
				selectedHarness: { candidateId: candidate.id, slotId: "g0-candidate-0", generation: 0, commit: "b".repeat(40), attemptIds: ["confirm-selected"] },
				rootHarness: { commit: "a".repeat(40), attemptIds: ["confirm-root"] },
			},
		}
		const config = { archiveDir, regressionCommand: "npm test", evalCommands: [], hiddenEvalCommands: [], protectedPaths: [] } as unknown as RsiConfig
		const confirmationSchedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "confirm", seed: "seed-0", attemptKind: "confirmation", phase: "confirmation" },
			{ armId: "fixed", generation: 0, candidateId: "root-control", taskId: "confirm", seed: "seed-0", attemptKind: "fixed-control", phase: "confirmation" },
		]
		const frozen = manifest("finished-campaign", confirmationSchedule)
		frozen.model = { provider: "openshell-openrouter", id: RSI_OPENROUTER_MODEL, settings: {} }
		const makeAttempt = (attemptId: string, candidateId: string, kind: "confirmation" | "fixed-control", commit: string): BenchmarkAttempt => ({
			schemaVersion: 1, manifestDigest: "d".repeat(64), taskId: "confirm", split: "confirmation", attemptId, harnessCommit: commit,
			agentImage: null, model: { provider: "openshell-openrouter", id: RSI_OPENROUTER_MODEL, sampling: {} }, seed: 1, family: "confirmation",
			startDigest: "e".repeat(64), ceilings: { timeoutMs: 1000, maxCalls: 1, maxOutputTokensPerCall: 10, maxPatchBytes: 1000 },
			verifiedSuccess: true, proofQualified: true, resourceAccounting: "supervisor-enforced", proofRequestSha256: "f".repeat(64),
			inferenceReceipt: { provider: "openrouter", endpointProvider: "deepinfra", jobId: attemptId, campaignId: "finished-campaign:benchmark", model: RSI_OPENROUTER_MODEL, returnedModels: [RSI_OPENROUTER_MODEL], returnedProviders: ["deepinfra"], calls: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.0001, accounting: "supervisor-enforced", qualified: true, callReceipts: [], denials: [] },
			validity: "valid", calls: 1, tokens: 2, wallTimeMs: 10, stopReason: "completed", patchDigest: null,
			evaluatorDigest: "a".repeat(64), artifactRefs: { stdout: createHash("sha256").update(attemptId + " stdout").digest("hex"), stderr: createHash("sha256").update(attemptId + " stderr").digest("hex") },
		})
		const selectedAttempt = makeAttempt("confirm-selected", "g0-candidate-0", "confirmation", "b".repeat(40))
		const rootAttempt = makeAttempt("confirm-root", "root-control", "fixed-control", "a".repeat(40))
		const confirmationAttempts = [selectedAttempt, rootAttempt]
		for (const [attempt, candidateId, kind] of [[selectedAttempt, "g0-candidate-0", "confirmation"], [rootAttempt, "root-control", "fixed-control"]] as const) {
			for (const [name, digest] of Object.entries(attempt.artifactRefs)) {
				const bytes = Buffer.from(attempt.attemptId + (name === "stdout" ? " stdout" : " stderr"))
				const artifact = path.join(archiveDir, "confirmation", frozen.campaignId, "fixed", candidateId, kind, "harness", attempt.harnessCommit, "artifacts", "sha256", digest.slice(0, 2), digest)
				await fs.mkdir(path.dirname(artifact), { recursive: true })
				await fs.writeFile(artifact, bytes)
			}
		}
		run.confirmationAttempts = confirmationAttempts
		const snapshot = {
			campaign: { manifest_sha256: proofCampaignManifestDigest(frozen) },
			arms: [{ arm_id: "fixed", run_id: run.runId, state: "finished", epoch: 3 }],
			events: [
				{ sequence: 4, arm_id: "fixed", event_type: "generation-selected", payload: { generation: 0, selectedCandidateIds: ["g0-candidate-0"] } },
				{ sequence: 5, arm_id: "fixed", event_type: "final-harness-selected", payload: { generation: 0, candidateId: "g0-candidate-0", commit: "b".repeat(40) } },
			],
			attempts: confirmationAttempts.map((attempt, index) => ({
				arm_id: "fixed", generation: 0, candidate_id: index === 0 ? "g0-candidate-0" : "root-control", task_id: "confirm", seed: "seed-0",
				attempt_kind: index === 0 ? "confirmation" : "fixed-control", status: "completed", broker_job_id: attempt.attemptId,
				result_sha256: createHash("sha256").update(JSON.stringify(attempt)).digest("hex"), artifact_refs: Object.fromEntries(Object.entries(attempt.artifactRefs).map(([name, digest]) => [name, { sha256: digest }])),
			})),
		}
		await writeArchive(archiveDir, { schemaVersion: 2, updatedAt: run.startedAt, runs: [], activeRuns: [run], candidates: [candidate], modelCandidates: [], combinations: [], jobs: [], trajectoryRefs: [], curriculumTasks: [] })
		const checkpoint = await readArchive(archiveDir)
		const resumedRun = checkpoint.activeRuns[0]
		assert.ok(resumedRun, "the process restart reloads the last durable active-run checkpoint")
		await assert.rejects(() => import("node:fs/promises").then(({ readFile }) => readFile(path.join(archiveDir, `${run.runId}.md`), "utf8")), /ENOENT/)
		const rebuilt = await rebuildFinishedProofCampaignArchive({ run: resumedRun, config, snapshot, manifest: frozen, armId: "fixed", now: () => "2026-01-01T00:00:02.000Z" })
		assert.equal(rebuilt.selectedCandidates?.[0], candidate.id)
		assert.equal(rebuilt.proofCampaign?.state, "finished")
		const archive = await readArchive(archiveDir)
		assert.equal(archive.runs.length, 1)
		assert.equal(archive.runs[0]?.runId, run.runId)
		assert.equal(archive.runs[0]?.proofCampaign?.state, "finished")
	} finally {
		await rm(archiveDir, { recursive: true, force: true })
	}
})

test("development finish crash rebuilds only the evaluated active checkpoint without starting the next arm", async () => {
	const archiveDir = await mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/rsi-proof-development-rebuild-`)
	try {
		const campaignId = "evaluated-campaign"
		const candidate: CandidateRecord = {
			id: "candidate-one", generation: 0, parent: "baseline", branch: "rsi/candidate-one", worktree: "/tmp/candidate-one",
			baseCommit: "a".repeat(40), status: "accepted", model: "test/model", mutation: "test mutation",
			createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z", commits: ["b".repeat(40)], changedFiles: ["src/example.ts"], protectedPathViolations: [],
		}
		const run: RsiRunRecord = {
			runId: "evaluated-run", startedAt: "2026-01-01T00:00:00.000Z", model: "test/model", baseRef: "main", baseCommit: "a".repeat(40),
			generations: 1, candidates: [candidate], reports: [], workerHarnessPairId: campaignId, workerHarnessMode: "fixed-control",
		}
		const config = { archiveDir, regressionCommand: "npm test", evalCommands: [], hiddenEvalCommands: [], protectedPaths: [] } as unknown as RsiConfig
		const frozen = manifest(campaignId, [
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation", phase: "development" },
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "hidden", seed: "seed-1", attemptKind: "confirmation", phase: "confirmation" },
		])
		const snapshot = {
			campaign: { manifest_sha256: proofCampaignManifestDigest(frozen) },
			arms: [{ arm_id: "fixed", run_id: run.runId, state: "evaluated", phase: "confirmation", epoch: 4, lease_expires_at: null }],
			events: [{ sequence: 7, arm_id: "fixed", event_type: "development-phase-finished", payload: { remainingPhase: "confirmation" } }],
		}
		await writeArchive(archiveDir, { schemaVersion: 2, updatedAt: run.startedAt, runs: [], activeRuns: [run], candidates: [candidate], modelCandidates: [], combinations: [], jobs: [], trajectoryRefs: [], curriculumTasks: [] })
		const checkpoint = (await readArchive(archiveDir)).activeRuns[0]
		assert.ok(checkpoint)
		const recovered = await rebuildEvaluatedProofCampaignArchive({ run: checkpoint, config, snapshot, manifest: frozen, armId: "fixed", now: () => "2026-01-01T00:00:02.000Z" })
		assert.equal(recovered.proofCampaign?.state, "evaluated")
		assert.equal(recovered.finishedAt, "2026-01-01T00:00:02.000Z", "development-phase recovery must rebuild the terminal arm archive view")
		const after = await readArchive(archiveDir)
		assert.equal(after.runs.length, 1, "evaluated recovery reproduces the terminal archive write after the DB commit")
		assert.equal(after.runs[0]?.proofCampaign?.state, "evaluated")
		assert.equal(after.activeRuns.length, 0)
	} finally {
		await rm(archiveDir, { recursive: true, force: true })
	}
})

test("proof campaign cannot finish while a frozen generation has no selection", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
			{ armId: "fixed", generation: 1, candidateId: "g1-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
		]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		await admit(campaign, lease, schedule[0]!, "attempt-generation-zero")
		await campaign.settle(lease, "attempt-generation-zero", { status: "completed", resultSha256: "2".repeat(64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
		await campaign.recordDecision(lease, { generation: 0, candidateId: "g0-candidate-0", parentId: "baseline", status: "rejected", childCommit: "3".repeat(40), parentCommit: frozen.rootCommit, proof: { passed: false }, attemptKeys: ["attempt-generation-zero"] })
		await campaign.selectGeneration(lease, 0, [])
		await assert.rejects(() => campaign.finishArm(lease, []), /generation 1 has no canonical selection/)
	})
})

test("proof campaign fences concurrent and recovered coordinators and rejects a corrupt manifest view", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool) => {
		const schedule = [{ armId: "fixed", generation: 0, candidateId: "candidate-a", taskId: "task-a", seed: "seed-0", attemptKind }]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const first = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const concurrent = await Promise.allSettled([campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-2"), campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-3")])
		assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 0, "the live arm lease excludes concurrent coordinators")
		await pool.query("UPDATE headlesscode_rsi_proof_campaign_arms SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE campaign_id=$1 AND arm_id='fixed'", [frozen.campaignId])
		const recovered = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-recovered")
		assert.equal(recovered.epoch, first.epoch + 1)
		await assert.rejects(() => admit(campaign, first, schedule[0]!, "stale-attempt"), /stale coordinator epoch/)
		await admit(campaign, recovered, schedule[0]!, "current-attempt")
		await pool.query("UPDATE headlesscode_rsi_proof_campaigns SET manifest=jsonb_set(manifest,'{settings}', '{\"tampered\":true}'::jsonb) WHERE campaign_id=$1", [frozen.campaignId])
		await assert.rejects(() => campaign.snapshot(frozen.campaignId), /manifest bytes do not match/)
	})
})

test("proof campaign root deadline rejects admission and renewal", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool) => {
		const schedule = [{ armId: "fixed", generation: 0, candidateId: "candidate-a", taskId: "task-a", seed: "seed-0", attemptKind }]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		await pool.query("UPDATE headlesscode_rsi_proof_campaigns SET deadline_at=clock_timestamp()-interval '1 second' WHERE campaign_id=$1", [frozen.campaignId])
		assert.equal(await campaign.renew(lease), false)
		await assert.rejects(() => admit(campaign, lease, schedule[0]!, "expired-attempt"), /stale coordinator epoch, phase, lease, manifest, or root deadline/)
	})
})

test("paired fake-provider campaign recovers one arm without duplicate admission or changing terminal lineage", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "pair-seed", attemptKind: "mutation" },
			{ armId: "self", generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "pair-seed", attemptKind: "mutation" },
		]
		const frozen = { ...manifest(`campaign-${randomUUID()}`, schedule), armAssignment: { fixedControl: "fixed", selfHosted: "self" }, settings: { provider: "fake", sameSeedBothArms: true } }
		const fixed = await campaign.acquire(frozen, "fixed", "run-fixed", "fixed-coordinator")
		const self = await campaign.acquire(frozen, "self", "run-self", "self-coordinator")
		for (const [lease, cell, commit] of [[fixed, schedule[0]!, "3".repeat(40)], [self, schedule[1]!, "4".repeat(40)]] as const) {
			const key = `${lease.armId}-mutation`
			await admit(campaign, lease, cell, key)
			await campaign.markDispatched(lease, key, randomUUID())
			await campaign.settle(lease, key, { status: "completed", resultSha256: commit.padEnd(64, "0").slice(0, 64), actualCalls: 1, actualTokens: 10, actualSpendUsd: 0.01 })
			await campaign.recordDecision(lease, { generation: 0, candidateId: cell.candidateId, parentId: "baseline", status: "accepted", childCommit: commit, parentCommit: frozen.rootCommit, proof: { fakeProvider: true, terminalCommit: commit }, attemptKeys: [key] })
			await campaign.selectGeneration(lease, 0, [cell.candidateId])
			if (lease.armId === "fixed") await campaign.finishArm(lease, [cell.candidateId])
		}
		await pool.query("UPDATE headlesscode_rsi_proof_campaign_arms SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE campaign_id=$1 AND arm_id='self'", [frozen.campaignId])
		const recoveredSelf = await campaign.acquire(frozen, "self", "run-self", "self-recovery")
		const duplicate = await campaign.admit(recoveredSelf, {
			attemptKey: "self-mutation", kind: "mutation", identity: { generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "pair-seed", attemptKind: "mutation" },
			requestSha256: "1".repeat(64), calls: 1, tokens: 100, spendUsd: 0.1,
		})
		assert.equal(duplicate.duplicate, true)
		assert.equal(duplicate.status, "completed")
		await campaign.finishArm(recoveredSelf, ["g0-candidate-0"])
		const snapshot = await campaign.snapshot(frozen.campaignId)
		assert.equal((snapshot.attempts as Array<Record<string, unknown>>).length, 2)
		assert.equal(Number((snapshot.campaign as Record<string, unknown>).used_calls), 2)
		assert.deepEqual((snapshot.decisions as Array<Record<string, unknown>>).map((decision) => decision.child_commit).sort(), ["3".repeat(40), "4".repeat(40)])
		assert.ok((snapshot.decisions as Array<Record<string, unknown>>).every((decision) => decision.proof && decision.proof_sha256))
	})
})

test("a no-dispatch failed slot is rejected with predeclared skips without blocking an accepted peer", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "typecheck", seed: "seed-0", attemptKind: "verification" },
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0:child", taskId: "task-a", seed: "seed-0", attemptKind: "development-proof" },
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-1", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
		]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const skippedKeys: string[] = []
		for (const cell of schedule.slice(0, 3)) {
			const attemptKey = `skip:${cell.candidateId}:${cell.taskId}`
			await campaign.skipAfterHardGate(lease, {
				attemptKey,
				identity: { generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind },
				requestSha256: "7".repeat(64), reason: "candidate rejected by a pre-mutation lineage gate; no dispatch occurred",
			})
			skippedKeys.push(attemptKey)
		}
		const acceptedCell = schedule[3]!
		await admit(campaign, lease, acceptedCell, "accepted-mutation")
		await campaign.settle(lease, "accepted-mutation", { status: "completed", resultSha256: "8".repeat(64), actualCalls: 1, actualTokens: 12, actualSpendUsd: 0.01 })
		await campaign.recordDecision(lease, { generation: 0, candidateId: "g0-candidate-0", parentId: "baseline", status: "rejected", childCommit: "3".repeat(40), parentCommit: frozen.rootCommit, proof: { gate: "lineage", skipped: skippedKeys }, attemptKeys: skippedKeys })
		await campaign.recordDecision(lease, { generation: 0, candidateId: "g0-candidate-1", parentId: "baseline", status: "accepted", childCommit: "4".repeat(40), parentCommit: frozen.rootCommit, proof: { gate: "passed" }, attemptKeys: ["accepted-mutation"] })
		await campaign.selectGeneration(lease, 0, ["g0-candidate-1"])
		const snapshot = await campaign.snapshot(frozen.campaignId)
		assert.equal((snapshot.attempts as Array<Record<string, unknown>>).filter((attempt) => attempt.status === "skipped-after-hard-gate").length, 3)
		assert.equal((snapshot.attempts as Array<Record<string, unknown>>).filter((attempt) => attempt.status === "completed").length, 1)
	})
})

test("proof-bound enqueue rejects a cross-run or cross-candidate campaign cell", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool, root) => {
		const queue = new PostgresRsiJobQueue(pool, { queueName: `proof-queue-${randomUUID().slice(0, 8)}`, maxInFlight: 1, leaseMs: 10_000, maxAttempts: 1 }, new FileRsiArtifactStore(root))
		await queue.migrate()
		const schedule: ProofCampaignManifest["schedule"] = [{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" }]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		await campaign.admit(lease, {
			attemptKey: "mutation-attempt", kind: "mutation", identity: { generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
			sourceCandidateId: "candidate-real", requestSha256: "1".repeat(64), calls: 1, tokens: 100, spendUsd: 0.1,
		})
		await campaign.markDispatched(lease, "mutation-attempt")
		const artifact = await queue.putArtifact(Buffer.from("sanitized snapshot"))
		const payload = {
			schemaVersion: 1 as const, snapshotSha256: artifact.sha256, snapshotBytes: artifact.byteLength, snapshotCommit: "a".repeat(40), task: "task", model: "mock/model", provider: "openrouter" as const,
			maxIterations: 1, timeoutMs: 1000, protectedPaths: [], candidate: {},
			proofCampaign: { campaignId: frozen.campaignId, armId: "fixed", epoch: lease.epoch, manifestSha256: lease.manifestSha256, cells: [{ attemptKey: "mutation-attempt", slotId: "g0-candidate-0", attemptKind: "mutation" as const }] },
		}
		const input = { idempotencyKey: "run-fixed:candidate-real:mutation", runId: "run-fixed", candidateId: "candidate-real", jobKind: "mutation" as const, resourceClass: "REMOTE_API" as const, artifactSha256: artifact.sha256, payload }
		await assert.rejects(() => queue.enqueue({ ...input, runId: "run-other" }), /exact current dispatched cells/)
		await assert.rejects(() => queue.enqueue({ ...input, candidateId: "candidate-other" }), /exact current dispatched cells/)
		const accepted = await queue.enqueue(input)
		assert.equal(accepted.status, "queued")
	})
})

test("FileArtifactStore PostgreSQL proof-bound evaluation imports verified bytes and fences stale result replay", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool, _root, queue) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "regression", seed: "seed-0", attemptKind: "verification" },
		]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const cell = schedule[0]!
		const attemptKey = "evaluation-regression"
		const snapshot = await queue.putArtifact(Buffer.from("sanitized evaluation snapshot"))
		const payload = {
			schemaVersion: 1 as const, snapshotSha256: snapshot.sha256, snapshotBytes: snapshot.byteLength, snapshotCommit: "a".repeat(40),
			task: "run regression and typecheck", model: "test/model", maxIterations: 1, timeoutMs: 10_000,
			protectedPaths: ["src/rsi/"], candidate: { id: "actual-candidate-id", generation: 0, parent: "baseline" }, evalCommands: ["npm test"],
			proofCampaign: { campaignId: frozen.campaignId, armId: lease.armId, epoch: lease.epoch, manifestSha256: proofCampaignManifestDigest(frozen), cells: [{ attemptKey, slotId: cell.candidateId, attemptKind: "verification" as const }] },
		}
		await campaign.admit(lease, {
			attemptKey, kind: "verification",
			identity: { generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind },
			sourceCandidateId: "actual-candidate-id", requestSha256: fleetPayloadDigest(payload), calls: 0, tokens: 0, spendUsd: 0,
		})
		await campaign.markDispatched(lease, attemptKey)
		const job = await queue.enqueue({ idempotencyKey: "run-fixed:actual-candidate:evaluation", runId: lease.runId, candidateId: "actual-candidate-id", jobKind: "evaluation", resourceClass: "CPU", artifactSha256: snapshot.sha256, payload })
		await queue.registerWorker({ workerId: "proof-eval-worker", gatewayId: "proof-gateway", hostname: "proof-host", maxActive: 1, resourceClasses: ["CPU"] })
		const jobLease = await queue.claim("proof-eval-worker")
		assert.ok(jobLease)
		assert.equal(jobLease.job.jobId, job.jobId)
		const output = await queue.putArtifact(Buffer.from("independent regression/typecheck output"))
		const result = { outputArtifact: { sha256: output.sha256, bytes: output.byteLength }, passed: true }
		assert.equal((await queue.complete(jobLease, result)).accepted, true)
		const campaignView = await campaign.snapshot(frozen.campaignId)
		const imported = (campaignView.attempts as Array<Record<string, unknown>>).find((attempt) => attempt.attempt_key === attemptKey)!
		assert.equal(imported.status, "completed")
		assert.equal((imported.artifact_refs as Record<string, unknown>).evaluation, undefined)
		assert.equal((imported.artifact_refs as Record<string, { sha256: string }>)["evaluation-output"]?.sha256, output.sha256)
		await pool.query("UPDATE headlesscode_rsi_proof_campaign_arms SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE campaign_id=$1 AND arm_id=$2", [frozen.campaignId, lease.armId])
		const recovered = await campaign.acquire(frozen, lease.armId, lease.runId, "coordinator-2")
		assert.equal(recovered.epoch, lease.epoch + 1)
		const replayPayload = { ...payload, proofCampaign: { ...payload.proofCampaign, epoch: recovered.epoch } }
		const replayIdentity: FleetJobIdentity = { idempotencyKey: "run-fixed:actual-candidate:evaluation", runId: lease.runId, candidateId: "actual-candidate-id", jobKind: "evaluation", resourceClass: "CPU", artifactSha256: snapshot.sha256, payload: replayPayload }
		assert.equal(fleetJobMatches((await queue.getJob(job.jobId))!, replayIdentity), true, "completed imported jobs remain replayable under a recovered arm epoch without changing their archived payload")
		const completedJob = (await queue.getJob(job.jobId))!
		const replayAdmission = await campaign.admit(recovered, {
			attemptKey, kind: "verification", identity: { generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind },
			sourceCandidateId: "actual-candidate-id", requestSha256: fleetPayloadDigest(completedJob.payload), calls: 0, tokens: 0, spendUsd: 0,
		})
		assert.equal(replayAdmission.status, "completed", "completed imported proof cells are reused rather than admitted again")
		await assert.rejects(() => queue.complete(jobLease, result), /stale proof campaign epoch/)
	})
})

test("queued proof job is atomically rebound after arm recovery before any worker can claim it", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool, _root, queue) => {
		const schedule: ProofCampaignManifest["schedule"] = [{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "typecheck", seed: "seed-0", attemptKind: "verification" }]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const cell = schedule[0]!
		const attemptKey = "queued-typecheck"
		const snapshot = await queue.putArtifact(Buffer.from("frozen evaluation snapshot"))
		const payload = {
			schemaVersion: 1 as const, snapshotSha256: snapshot.sha256, snapshotBytes: snapshot.byteLength, snapshotCommit: "a".repeat(40),
			task: "run typecheck", model: "test/model", maxIterations: 1, timeoutMs: 10_000, protectedPaths: [],
			candidate: { id: "candidate-real", generation: 0, parent: "baseline" }, evalCommands: ["npm run typecheck"],
			proofCampaign: { campaignId: frozen.campaignId, armId: lease.armId, epoch: lease.epoch, manifestSha256: lease.manifestSha256, cells: [{ attemptKey, slotId: cell.candidateId, attemptKind: "verification" as const }] },
		}
		const identity: FleetJobIdentity = { idempotencyKey: "run-fixed:candidate-real:typecheck", runId: lease.runId, candidateId: "candidate-real", jobKind: "evaluation", resourceClass: "CPU", artifactSha256: snapshot.sha256, payload }
		await campaign.admit(lease, {
			attemptKey, kind: "verification", identity: { generation: 0, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind },
			sourceCandidateId: "candidate-real", requestSha256: fleetPayloadDigest(payload), calls: 0, tokens: 0, spendUsd: 0,
		})
		await campaign.markDispatched(lease, attemptKey)
		const queued = await queue.enqueue(identity)
		assert.equal(queued.status, "queued")
		await pool.query("UPDATE headlesscode_rsi_proof_campaign_arms SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE campaign_id=$1 AND arm_id=$2", [frozen.campaignId, lease.armId])
		const recovered = await campaign.acquire(frozen, lease.armId, lease.runId, "coordinator-2")
		const recoveredIdentity: FleetJobIdentity = { ...identity, payload: { ...payload, proofCampaign: { ...payload.proofCampaign, epoch: recovered.epoch } } }
		const rebound = await reconcileProofCampaignJob(queue, queued, recoveredIdentity, recovered)
		assert.ok(rebound)
		assert.equal(rebound.status, "queued")
		assert.equal(rebound.payload.proofCampaign?.epoch, recovered.epoch)
		assert.equal(fleetJobMatches(rebound, recoveredIdentity), true)
		assert.equal((await campaign.admit(recovered, {
			attemptKey, kind: "verification", identity: { generation: 0, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind },
			sourceCandidateId: "candidate-real", requestSha256: fleetPayloadDigest(recoveredIdentity.payload), calls: 0, tokens: 0, spendUsd: 0, jobId: queued.jobId,
		})).status, "dispatched", "controller resumes using the request digest transactionally rebound with the queued payload")
		const attempt = (await campaign.snapshot(frozen.campaignId)).attempts as Array<Record<string, unknown>>
		assert.equal(Number(attempt[0]?.epoch), recovered.epoch)
		await queue.registerWorker({ workerId: "recovered-eval-worker", gatewayId: "proof-gateway", hostname: "proof-host", maxActive: 1, resourceClasses: ["CPU"] })
		const jobLease = await queue.claim("recovered-eval-worker")
		assert.ok(jobLease)
		assert.equal(jobLease.job.jobId, queued.jobId)
		const output = await queue.putArtifact(Buffer.from("verified after recovered dispatch"))
		assert.equal((await queue.complete(jobLease, { outputArtifact: { sha256: output.sha256, bytes: output.byteLength }, passed: true })).accepted, true)
	})
})

test("a requeued proof job that was previously claimed cannot be rebound after recovery", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, pool, _root, queue) => {
		const schedule: ProofCampaignManifest["schedule"] = [{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "typecheck", seed: "seed-0", attemptKind: "verification" }]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const cell = schedule[0]!
		const attemptKey = "claimed-then-requeued-typecheck"
		const snapshot = await queue.putArtifact(Buffer.from("frozen evaluation snapshot"))
		const payload = {
			schemaVersion: 1 as const, snapshotSha256: snapshot.sha256, snapshotBytes: snapshot.byteLength, snapshotCommit: "a".repeat(40),
			task: "run typecheck", model: "test/model", maxIterations: 1, timeoutMs: 10_000, protectedPaths: [],
			candidate: { id: "candidate-real", generation: 0, parent: "baseline" }, evalCommands: ["npm run typecheck"],
			proofCampaign: { campaignId: frozen.campaignId, armId: lease.armId, epoch: lease.epoch, manifestSha256: lease.manifestSha256, cells: [{ attemptKey, slotId: cell.candidateId, attemptKind: "verification" as const }] },
		}
		const identity: FleetJobIdentity = { idempotencyKey: "run-fixed:candidate-real:typecheck:claimed", runId: lease.runId, candidateId: "candidate-real", jobKind: "evaluation", resourceClass: "CPU", artifactSha256: snapshot.sha256, payload }
		await campaign.admit(lease, { attemptKey, kind: "verification", identity: { generation: 0, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind }, sourceCandidateId: "candidate-real", requestSha256: fleetPayloadDigest(payload), calls: 0, tokens: 0, spendUsd: 0 })
		await campaign.markDispatched(lease, attemptKey)
		const queued = await queue.enqueue(identity)
		await pool.query("UPDATE headlesscode_rsi_jobs SET max_attempts=2 WHERE job_id=$1", [queued.jobId])
		await queue.registerWorker({ workerId: "interrupted-eval-worker", gatewayId: "proof-gateway", hostname: "proof-host", maxActive: 1, resourceClasses: ["CPU"] })
		const claimed = await queue.claim("interrupted-eval-worker")
		assert.ok(claimed)
		assert.equal(await queue.fail(claimed, "worker interrupted after claim"), true)
		const requeued = await queue.getJob(queued.jobId)
		assert.equal(requeued?.status, "queued")
		assert.equal(requeued?.attempts, 1)
		await pool.query("UPDATE headlesscode_rsi_proof_campaign_arms SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE campaign_id=$1 AND arm_id=$2", [frozen.campaignId, lease.armId])
		const recovered = await campaign.acquire(frozen, lease.armId, lease.runId, "coordinator-2")
		const recoveredIdentity: FleetJobIdentity = { ...identity, payload: { ...payload, proofCampaign: { ...payload.proofCampaign, epoch: recovered.epoch } } }
		await assert.rejects(() => reconcileProofCampaignJob(queue, requeued, recoveredIdentity, recovered), /never-claimed queued proof job/)
		const attempts = (await campaign.snapshot(frozen.campaignId)).attempts as Array<Record<string, unknown>>
		assert.equal(attempts[0]?.status, "dispatched", "the previously claimed cell remains uncertain and charged")
	})
})

test("FileArtifactStore PostgreSQL proof-bound mutation imports only matching durable broker receipt", { skip: !databaseUrl }, async () => {
	await withCampaign(async (campaign, _pool, _root, queue) => {
		const schedule: ProofCampaignManifest["schedule"] = [
			{ armId: "fixed", generation: 0, candidateId: "g0-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" },
		]
		const frozen = manifest(`campaign-${randomUUID()}`, schedule)
		frozen.settings = { inferenceCampaignIds: { mutation: `${frozen.campaignId}:mutation` } }
		const callMicrousd = [2116, 90, 371, 932, 137, 865, 117, 192, 229, 210, 623, 133, 146, 186, 1497, 2939, 390, 122]
		const totalMicrousd = callMicrousd.reduce((sum, amount) => sum + amount, 0)
		assert.equal(totalMicrousd, 11_295)
		const promptTokens = callMicrousd.map(() => 30_000)
		const completionTokens = callMicrousd.map((_, index) => index === 0 ? 630 : 632)
		const totalTokens = promptTokens.reduce((sum, amount, index) => sum + amount + completionTokens[index]!, 0)
		assert.equal(totalTokens, 551_374)
		frozen.budgets.attempt = { ...frozen.budgets.attempt, maxCalls: callMicrousd.length, maxTokens: totalTokens, maxSpendUsd: 0.36 }
		frozen.budgets.root = { ...frozen.budgets.root, maxCalls: callMicrousd.length, maxTokens: totalTokens, maxSpendUsd: 1 }
		const lease = await campaign.acquire(frozen, "fixed", "run-fixed", "coordinator-1")
		const cell = schedule[0]!
		const attemptKey = "mutation-cell"
		const actualCandidateId = "actual-candidate-id"
		const limits: OpenRouterBrokerLimits = {
			campaignId: `${frozen.campaignId}:mutation`, maxCalls: callMicrousd.length, maxInputTokensPerCall: 150_000, maxOutputTokensPerCall: 7_000,
			maxTotalTokens: totalTokens, maxDurationMs: 60_000, maxRequestBytes: 16_384, maxResponseBytes: 16_384,
			maxInputPricePerMillionUsd: 0.1, maxOutputPricePerMillionUsd: 0.2, maxCallSpendUsd: 0.02, maxJobSpendUsd: 0.36, maxCampaignSpendUsd: 0.36,
		}
		await campaign.admit(lease, {
			attemptKey, kind: "mutation",
			identity: { generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed, attemptKind: cell.attemptKind },
			sourceCandidateId: actualCandidateId, requestSha256: "1".repeat(64), calls: limits.maxCalls, tokens: limits.maxTotalTokens, spendUsd: limits.maxJobSpendUsd,
		})
		await campaign.markDispatched(lease, attemptKey)
		const snapshot = await queue.putArtifact(Buffer.from("sanitized mutation snapshot"))
		const payload = {
			schemaVersion: 1 as const, snapshotSha256: snapshot.sha256, snapshotBytes: snapshot.byteLength, snapshotCommit: "a".repeat(40),
			task: "make one bounded source change", model: RSI_OPENROUTER_MODEL, provider: "openrouter" as const, inferenceLimits: limits,
			maxIterations: 1, timeoutMs: 10_000, protectedPaths: ["src/rsi/"], candidate: { id: actualCandidateId, generation: 0, parent: "baseline" },
			proofCampaign: { campaignId: frozen.campaignId, armId: lease.armId, epoch: lease.epoch, manifestSha256: proofCampaignManifestDigest(frozen), cells: [{ attemptKey, slotId: cell.candidateId, attemptKind: "mutation" as const }] },
		}
		const job = await queue.enqueue({ idempotencyKey: "run-fixed:actual-candidate:mutation", runId: lease.runId, candidateId: actualCandidateId, jobKind: "mutation", resourceClass: "REMOTE_API", concurrencyKey: "openrouter:test-model", artifactSha256: snapshot.sha256, payload })
		await queue.registerWorker({ workerId: "proof-mutation-worker", gatewayId: "proof-gateway", hostname: "proof-host", maxActive: 1, resourceClasses: ["REMOTE_API"] })
		const jobLease = await queue.claim("proof-mutation-worker")
		assert.ok(jobLease)
		assert.equal(jobLease.job.jobId, job.jobId)
		const grant: OpenRouterBrokerGrant = { jobId: job.jobId, leaseToken: jobLease.token, capability: randomUUID(), model: RSI_OPENROUTER_MODEL, limits }
		await queue.register(grant)
		for (const [index, microusd] of callMicrousd.entries()) {
			const callId = `mock-call-${String(index + 1).padStart(6, "0")}`
			const tokens = promptTokens[index]! + completionTokens[index]!
			await queue.reserve(grant, { callId, requestSha256: String(index + 2).repeat(64).slice(0, 64), reservedUsd: 0.02, reservedTokens: tokens, startedAt: new Date().toISOString() })
			await queue.settle(grant, { callId, state: "complete", qualified: true, returnedModel: RSI_OPENROUTER_MODEL, returnedProvider: "deepinfra", promptTokens: promptTokens[index]!, completionTokens: completionTokens[index]!, costUsd: microusd / 1_000_000, responseSha256: String(index + 3).repeat(64).slice(0, 64), completedAt: new Date().toISOString() })
		}
		const receipt = await queue.receipt(grant)
		assert.equal(receipt.qualified, true)
		assert.equal(receipt.accounting, "supervisor-enforced")
		assert.equal(receipt.provider, "openrouter")
		assert.equal(receipt.jobId, job.jobId)
		assert.equal(receipt.campaignId, limits.campaignId)
		assert.equal(receipt.model, RSI_OPENROUTER_MODEL)
		assert.equal(receipt.endpointProvider, "deepinfra")
		assert.equal(receipt.calls, callMicrousd.length)
		assert.equal(receipt.promptTokens, 540_000)
		assert.equal(receipt.completionTokens, 11_374)
		assert.equal(receipt.totalTokens, totalTokens)
		assert.equal(receipt.costUsd, totalMicrousd / 1_000_000)
		assert.equal(receipt.callReceipts.length, callMicrousd.length)
		assert.deepEqual(receipt.returnedProviders, ["deepinfra"])
		const patch = await queue.putArtifact(Buffer.from("verified candidate patch bytes"))
		const result = { patchSha256: patch.sha256, patchBytes: patch.byteLength, inferenceReceipt: receipt }
		const incompleteReceipts: Array<[string, Record<string, unknown>]> = [
			["missing receipt", {}],
			["wrong provider", { ...receipt, provider: "other" }],
			["wrong job", { ...receipt, jobId: "other-job" }],
			["wrong campaign", { ...receipt, campaignId: "other-campaign" }],
			["wrong model", { ...receipt, model: "other/model" }],
			["unqualified receipt", { ...receipt, qualified: false }],
			["wrong call count", { ...receipt, calls: receipt.calls - 1 }],
			["wrong token count", { ...receipt, totalTokens: receipt.totalTokens! - 1 }],
		]
		for (const [label, invalidReceipt] of incompleteReceipts) {
			await assert.rejects(
				() => queue.complete(jobLease, { ...result, inferenceReceipt: invalidReceipt }),
				/proof campaign result receipt does not match durable broker call accounting/,
				`${label} must remain rejected`,
			)
		}
		for (const delta of [-1, 1]) {
			await assert.rejects(
				() => queue.complete(jobLease, { ...result, inferenceReceipt: { ...receipt, costUsd: (totalMicrousd + delta) / 1_000_000 } }),
				/proof campaign result receipt does not match durable broker call accounting/,
				`a receipt differing by ${delta} microUSD must be rejected`,
			)
		}
		assert.equal((await queue.complete(jobLease, result)).accepted, true)
		const view = await campaign.snapshot(frozen.campaignId)
		const imported = (view.attempts as Array<Record<string, unknown>>).find((attempt) => attempt.attempt_key === attemptKey)!
		assert.equal(imported.status, "completed")
		assert.equal(Number(imported.actual_calls), callMicrousd.length)
		assert.equal(Number(imported.actual_tokens), totalTokens)
		assert.equal(Number(imported.actual_spend_microusd), totalMicrousd)
		assert.equal((imported.artifact_refs as Record<string, { sha256: string }>).patch?.sha256, patch.sha256)
		const conflictingReplay = await queue.complete(jobLease, { ...result, inferenceReceipt: { ...receipt, totalTokens: 31 } })
		assert.equal(conflictingReplay.accepted, false, "a duplicate import with a receipt that differs from durable call accounting is not accepted")
	})
})
