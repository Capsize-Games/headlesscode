import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { ActiveCampaignRun } from "../store.js"
import { RepositoryCampaignStore,
	type ClaimedRepositoryJob, type RepositoryBudgetAuthority, type RepositoryCampaignDefinition, type RepositoryCampaignJob,
	type RepositoryAdvisoryIntakeRecord } from "../repository-campaigns.js"
import type { RepositoryWorkerPipelineAdapters,
	RepositoryPreparedWorkspace } from "../repository-worker-pipeline.js"
import type { RepositoryCampaignRunLease } from "../repository-run-lease.js"
import type { PublishedAdvisoryRecord } from "../repository-advisory-intake.js"
import { RepositoryCampaignCoordinator } from "../repository-coordinator.js"
import { createRepositoryWorkerPipeline } from "../repository-worker-pipeline.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const digest = (char: string) => char.repeat(64)
const qualification = { sourceAudited: true, workerQualified: true,
	recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definition: RepositoryCampaignDefinition = { id: "fixture-repo",
	name: "Offline Fixture", repositoryId: "fixture-repo",
	repository: "Capsize/Fixture", sourceRevision: "a".repeat(40),
		policySha256: digest("9"), workerProfile: "fixture-profile",
			recipeDigest: digest("b"),
	evaluatorDigest: digest("c"), model: "fixture-model",
		dataAccessProfile: "fixture-data", qualification }

type CoordinatorStatusSnapshot = {
	jobs: RepositoryCampaignJob[]
	intakeRecords: RepositoryAdvisoryIntakeRecord[]
}
function readStatus(value: Record<string, unknown>): CoordinatorStatusSnapshot { return value as unknown as CoordinatorStatusSnapshot }
const emptyLifetime = { settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0,
	settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0 }
const monthlyBudget = { month: new Date().toISOString().slice(0, 7), limitMicros: 5_000_000,
	settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 }
const campaignLifetimeBudget = { limitMicros: 20_000, limitTokens: 108_000,
	...emptyLifetime }
function liveAuthority(run: ActiveCampaignRun): RepositoryBudgetAuthority {
	return { mode: "fleet-v2" as const, available: true, limitMicros: 20_000,
		limitTokens: 108_000, committedMicros: 0, committedTokens: 0,
		asOfMs: Date.now(), campaignId: "fleet-security-watch", globalEnabled: true,
		canAdmit: true, controlEpoch: run.epoch, runId: run.id, runExpiresAtMs: run.expiresAt,
		repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!,
		repository: definition.repository!, sourceRevision: definition.sourceRevision!,
		policySha256: definition.policySha256!, model: definition.model!,
		profileId: "fixture-profile", repositoryEnabled: true, repositoryEpoch: 1,
		monthly: monthlyBudget, campaignLifetime: campaignLifetimeBudget,
		legacyLifetime: emptyLifetime,
		repositoryLifetime: { limitMicros: 20_000, limitTokens: 20_000, ...emptyLifetime } }
}
async function waitForTerminal(store: RepositoryCampaignStore): Promise<RepositoryCampaignJob> {
	for (let i = 0; i < 300; i++) {
		const job = readStatus(await store.status()).jobs[0]
		if (job && job.status !== "queued" && job.status !== "running") return job
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("repository worker did not reach a terminal state")
}
async function testCoordinatorRunsRegisteredIntakeWorkerEvaluatorDeliveryLoop(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-camp-") )
	const calls: string[] = []
	try {
		const store = new RepositoryCampaignStore(path.join(root, "state.json"),
			[definition], () => ({ mode: "synthetic-test", available: true,
			limitMicros: 100_000, limitTokens: 100_000, committedMicros: 0,
				committedTokens: 0 }))
		await store.setCampaignBudget(definition.id, 80_000, 80_000)
		await store.start(definition.id)
		await store.enqueue(definition.id, "CVE-2026-1260")
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
			evaluatorDigest: definition.evaluatorDigest!, model: definition.model!,
				executionKind: "development-checkpoint",
			reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(advisoryId): ReturnType<RepositoryWorkerPipelineAdapters["lookupAdvisory"]> { calls.push("intake"); return { advisoryId, sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1260",
				snapshotSha256: digest("d"), summary: "Offline fixture only",
					affectedRange: "< 1.0", fixedVersion: "1.0",
						verificationCheckIds: ["fixture-check"] } },
			async prepareWorkspace(): ReturnType<RepositoryWorkerPipelineAdapters["prepareWorkspace"]> { calls.push("prepare"); return { worktree: root,
				taskSha256: digest("e"),
				async runContained(): ReturnType<RepositoryPreparedWorkspace["runContained"]> { calls.push("contained-worker"); return { ok: true,
					durationMs: 12, outputSha256: digest("f"), actualMicros: 0,
						actualTokens: 0 } },
				async candidateSha256(): ReturnType<RepositoryPreparedWorkspace["candidateSha256"]> { return digest("1") },
					async cleanup(): Promise<void> { calls.push("cleanup") } } },
			async evaluate(): ReturnType<RepositoryWorkerPipelineAdapters["evaluate"]> { calls.push("evaluator"); return { passed: true,
				evidenceSha256: digest("2"), detail: "private bounded fixture result" } },
			async deliverPrivate(): ReturnType<RepositoryWorkerPipelineAdapters["deliverPrivate"]> { calls.push("delivery"); return { accepted: true,
				evidenceSha256: digest("3"),
					boardRef: `http://127.0.0.1:8078/api/cards/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v1:${digest("4")}` } },
		})
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100)
		await coordinator.start()
		try {
			const completed = await waitForTerminal(store)
			assert.equal(completed.status, "succeeded"); assert.ok(completed.progress)
			assert.deepEqual(calls, ["intake", "prepare", "contained-worker", "evaluator", "delivery", "cleanup"])
			assert.deepEqual(completed.progress.completedSteps, ["intake", "deduplicate", "investigate", "prepare-candidate", "verify", "deliver"])
			assert.deepEqual(completed.progress.evidenceRefs.map((entry) => entry.kind), ["intake", "candidate", "test-receipt", "delivery"])
			assert.equal(completed.progress.boardRef, `http://127.0.0.1:8078/api/cards/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v1:${digest("4")}`)
		} finally { await coordinator.stop() }
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testPipelineStopsAtRejectedEvaluatorAndDoesNotDeliver(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-camp-") )
	const calls: string[] = []
	try {
		const store = new RepositoryCampaignStore(path.join(root, "state.json"),
			[definition], () => ({ mode: "synthetic-test", available: true,
			limitMicros: 100_000, limitTokens: 100_000, committedMicros: 0,
				committedTokens: 0 }))
		await store.setCampaignBudget(definition.id, 80_000, 80_000)
		await store.start(definition.id)
		await store.enqueue(definition.id, "CVE-2026-1260")
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
			evaluatorDigest: definition.evaluatorDigest!, model: definition.model!,
				executionKind: "development-checkpoint",
			reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(advisoryId): ReturnType<RepositoryWorkerPipelineAdapters["lookupAdvisory"]> { return { advisoryId,
				sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1260",
					snapshotSha256: digest("d"),
				summary: "Offline fixture only", affectedRange: "< 1.0",
					fixedVersion: "1.0", verificationCheckIds: ["fixture-check"] } },
			async prepareWorkspace(): ReturnType<RepositoryWorkerPipelineAdapters["prepareWorkspace"]> { return { worktree: root,
				taskSha256: digest("e"), async runContained(): ReturnType<RepositoryPreparedWorkspace["runContained"]> { return { ok: true,
					durationMs: 5, outputSha256: digest("f"), actualMicros: 0,
						actualTokens: 0 } }, async candidateSha256(): ReturnType<RepositoryPreparedWorkspace["candidateSha256"]> { return digest("1") },
							async cleanup(): Promise<void> { calls.push("cleanup") } } },
			async evaluate(): ReturnType<RepositoryWorkerPipelineAdapters["evaluate"]> { calls.push("evaluator"); return { passed: false,
				evidenceSha256: digest("2"), detail: "fixture rejection" } },
			async deliverPrivate(): ReturnType<RepositoryWorkerPipelineAdapters["deliverPrivate"]> { calls.push("delivery"); return { accepted: true,
				evidenceSha256: digest("3") } },
		})
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100)
		await coordinator.start()
		try {
			const failed = await waitForTerminal(store)
			assert.equal(failed.status, "failed"); assert.ok(failed.progress)
			assert.deepEqual(calls, ["evaluator", "cleanup"])
			assert.equal(failed.progress.blocker,
				"protected-evaluator-rejected-candidate")
			assert.equal(failed.progress.evidenceRefs.some((entry) => entry.kind === "delivery"), false)
		} finally { await coordinator.stop() }
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testStopDuringPreparationSkipsContainedLaunchAndCleansWorkspace(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-camp-stop-before-worker-"))
	let enteredPreparation!: () => void
	const preparationEntered = new Promise<void>((resolve) => { enteredPreparation = resolve })
	let releasePreparation!: () => void
	const preparationRelease = new Promise<void>((resolve) => { releasePreparation = resolve })
	let runContainedCalls = 0
	let cleanupCalls = 0
	let evaluationCalls = 0
	let deliveryCalls = 0
	const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => ({
		mode: "synthetic-test", available: true, limitMicros: 100_000,
		limitTokens: 100_000, committedMicros: 0, committedTokens: 0,
	}))
	try {
		await store.setCampaignBudget(definition.id, 80_000, 80_000)
		await store.start(definition.id)
		await store.enqueue(definition.id, "CVE-2026-1260")
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
			evaluatorDigest: definition.evaluatorDigest!, model: definition.model!, executionKind: "development-checkpoint",
			reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(advisoryId) { return { advisoryId, sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1260",
				snapshotSha256: digest("d"), summary: "Offline fixture only", affectedRange: "< 1.0", fixedVersion: "1.0", verificationCheckIds: ["fixture-check"] } },
			async prepareWorkspace() {
				enteredPreparation()
				await preparationRelease
				return { worktree: root, taskSha256: digest("e"),
					async runContained() { runContainedCalls += 1; return { ok: true, durationMs: 1, outputSha256: digest("f"), actualMicros: 0, actualTokens: 0 } },
					async candidateSha256() { return digest("1") }, async cleanup() { cleanupCalls += 1 } }
			},
			async evaluate() { evaluationCalls += 1; return { passed: true, evidenceSha256: digest("2"), detail: "unexpected" } },
			async deliverPrivate() { deliveryCalls += 1; return { accepted: true, evidenceSha256: digest("3") } },
		})
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100)
		await coordinator.start()
		try {
			await preparationEntered
			await store.stop(definition.id)
			coordinator.stopCampaign(definition.id)
			releasePreparation()
			const stopped = await waitForTerminal(store)
			assert.equal(stopped.status, "ambiguous", "a pre-dispatch stop keeps its reserved hold until exact no-call reconciliation")
			assert.equal(runContainedCalls, 0, "Stop prevents contained launch before the model-call path")
			assert.equal(cleanupCalls, 1, "prepared worktree and supervisor resources are cleaned")
			assert.equal(evaluationCalls, 0)
			assert.equal(deliveryCalls, 0)
		} finally { releasePreparation(); await coordinator.stop() }
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testStopAfterRequestStartPreservesSettlementAndDoesNotReplay(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-camp-stop-after-send-"))
	let enteredRequest!: () => void
	const requestEntered = new Promise<void>((resolve) => { enteredRequest = resolve })
	let releaseRequest!: () => void
	const requestRelease = new Promise<void>((resolve) => { releaseRequest = resolve })
	let observedAbort!: () => void
	const abortObserved = new Promise<void>((resolve) => { observedAbort = resolve })
	let sends = 0
	let cleanupCalls = 0
	let evaluationCalls = 0
	let deliveryCalls = 0
	let claim: ClaimedRepositoryJob | undefined
	const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => ({
		mode: "synthetic-test", available: true, limitMicros: 100_000,
		limitTokens: 100_000, committedMicros: 0, committedTokens: 0,
	}))
	try {
		await store.setCampaignBudget(definition.id, 80_000, 80_000)
		await store.start(definition.id)
		await store.enqueue(definition.id, "CVE-2026-1260")
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
			evaluatorDigest: definition.evaluatorDigest!, model: definition.model!, executionKind: "development-checkpoint",
			reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(advisoryId) { return { advisoryId, sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1260",
				snapshotSha256: digest("d"), summary: "Offline fixture only", affectedRange: "< 1.0", fixedVersion: "1.0", verificationCheckIds: ["fixture-check"] } },
			async prepareWorkspace(input) {
				claim = input.claim
				return { worktree: root, taskSha256: digest("e"),
					async runContained(signal) {
						signal.addEventListener("abort", observedAbort, { once: true })
						const started = await store.withClaimRequestStart(claim!, async () => {
							sends += 1
							enteredRequest()
							await requestRelease
							return "settled-fixture-response"
						})
						assert.equal(started, "settled-fixture-response")
						return { ok: false, durationMs: 20, outputSha256: digest("f"), actualMicros: 7_000, actualTokens: 9_000,
							failureDiagnostic: "Contained worker cancelled after request start; exact fixture receipt settled" }
					},
					async candidateSha256() { return digest("1") }, async cleanup() { cleanupCalls += 1 }
				}
			},
			async evaluate() { evaluationCalls += 1; return { passed: true, evidenceSha256: digest("2"), detail: "unexpected" } },
			async deliverPrivate() { deliveryCalls += 1; return { accepted: true, evidenceSha256: digest("3") } },
		})
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100)
		await coordinator.start()
		try {
			await requestEntered
			await store.stop(definition.id)
			coordinator.stopCampaign(definition.id)
			await abortObserved
			await assert.rejects(store.withClaimRequestStart(claim!, async () => { sends += 1; return "forbidden" }), /stale or stopped/)
			assert.equal(sends, 1, "the stop fence rejects every later call")
			releaseRequest()
			const settled = await waitForTerminal(store)
			assert.equal(settled.status, "failed")
			assert.equal(settled.settledMicros, 7_000)
			assert.equal(settled.settledTokens, 9_000)
			assert.equal(cleanupCalls, 1)
			assert.equal(evaluationCalls, 0, "Stop prevents verification and delivery after the already-sent call settles")
			assert.equal(deliveryCalls, 0)
		} finally { releaseRequest(); await coordinator.stop() }
		const restarted = new RepositoryCampaignStore(store.path, [definition], () => ({
			mode: "synthetic-test", available: true, limitMicros: 100_000,
			limitTokens: 100_000, committedMicros: 0, committedTokens: 0,
		}))
		assert.equal(readStatus(await restarted.status()).jobs.length, 1)
		assert.equal(sends, 1, "restart does not replay the settled stopped job")
	} finally { releaseRequest(); await fs.rm(root, { recursive: true, force: true }) }
}

async function testLiveRunLeaseLifecycle(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-camp-run-"))
	const run: ActiveCampaignRun = { id: "11111111-1111-4111-8111-111111111111",
		epoch: 4, startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
	const events: string[] = []
	try {
		const store = new RepositoryCampaignStore(path.join(root, "state.json"),
			[definition], () => liveAuthority(run))
		const lease = { async acquire(timeoutMs: number): ReturnType<RepositoryCampaignRunLease["acquire"]> { events.push(`acquire:${timeoutMs}`); return run }, async finish(value: ActiveCampaignRun, status: "succeeded" | "failed"): ReturnType<RepositoryCampaignRunLease["finish"]> {
			assert.equal(value.id, run.id); events.push(`finish:${status}`); return { ...value, status, finishedAt: Date.now() }
		} }
		await store.setCampaignBudget(definition.id, 20_000, 20_000); await store.start(definition.id); await store.enqueue(definition.id, "CVE-2026-1260")
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!, evaluatorDigest: definition.evaluatorDigest!,
			model: definition.model!, executionKind: "live-cve", reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(advisoryId): ReturnType<RepositoryWorkerPipelineAdapters["lookupAdvisory"]> { events.push("intake"); return { advisoryId, sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1260", snapshotSha256: digest("d"),
				summary: "Fixture", affectedRange: "< 1", fixedVersion: "1", verificationCheckIds: ["registered"] } },
			async prepareWorkspace(): ReturnType<RepositoryWorkerPipelineAdapters["prepareWorkspace"]> { return { worktree: root, taskSha256: digest("e"), async runContained(): ReturnType<RepositoryPreparedWorkspace["runContained"]> { events.push("worker"); return { ok: true, durationMs: 1, outputSha256: digest("f"), actualMicros: 1, actualTokens: 1 } }, async candidateSha256(): ReturnType<RepositoryPreparedWorkspace["candidateSha256"]> { return digest("1") } } },
			async evaluate(): ReturnType<RepositoryWorkerPipelineAdapters["evaluate"]> { events.push("evaluate"); return { passed: true, evidenceSha256: digest("2"), detail: "fixture" } },
			async deliverPrivate(): ReturnType<RepositoryWorkerPipelineAdapters["deliverPrivate"]> { events.push("deliver"); return { accepted: true, evidenceSha256: digest("3") } },
		})
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100, lease)
		await coordinator.start()
		try {
			assert.equal((await waitForTerminal(store)).status, "succeeded")
			for (let i = 0; i < 20 && !events.includes("finish:succeeded"); i++) await new Promise<void>((resolve) => setTimeout(resolve, 10))
			assert.deepEqual(events, [`acquire:${20 * 60_000}`, "intake", "worker", "evaluate", "deliver", "finish:succeeded"])
		} finally { await coordinator.stop() }
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testLiveRunLeaseBusyLeavesJobQueued(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-camp-busy-"))
	const run: ActiveCampaignRun = { id: "22222222-2222-4222-8222-222222222222", epoch: 4, startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
	let busy = true
	try {
		const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => liveAuthority(run))
		await store.setCampaignBudget(definition.id, 20_000, 20_000); await store.start(definition.id); await store.enqueue(definition.id, "CVE-2026-1261")
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!, evaluatorDigest: definition.evaluatorDigest!,
			model: definition.model!, executionKind: "live-cve", reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(advisoryId): ReturnType<RepositoryWorkerPipelineAdapters["lookupAdvisory"]> { return { advisoryId, sourceUrl: "https://osv.dev/vulnerability/CVE-2026-1261", snapshotSha256: digest("d"),
				summary: "Fixture", affectedRange: "< 1", fixedVersion: "1", verificationCheckIds: ["registered"] } },
			async prepareWorkspace(): ReturnType<RepositoryWorkerPipelineAdapters["prepareWorkspace"]> { return { worktree: root, taskSha256: digest("e"), async runContained(): ReturnType<RepositoryPreparedWorkspace["runContained"]> { return { ok: true, durationMs: 1, outputSha256: digest("f"), actualMicros: 1, actualTokens: 1 } }, async candidateSha256(): ReturnType<RepositoryPreparedWorkspace["candidateSha256"]> { return digest("1") } } },
			async evaluate(): ReturnType<RepositoryWorkerPipelineAdapters["evaluate"]> { return { passed: true, evidenceSha256: digest("2"), detail: "fixture" } },
			async deliverPrivate(): ReturnType<RepositoryWorkerPipelineAdapters["deliverPrivate"]> { return { accepted: true, evidenceSha256: digest("3") } } })
		const lease = { async acquire(): ReturnType<RepositoryCampaignRunLease["acquire"]> { return busy ? null : run }, async finish(value: ActiveCampaignRun, status: "succeeded" | "failed"): ReturnType<RepositoryCampaignRunLease["finish"]> { assert.equal(value.id, run.id); assert.equal(status, "succeeded"); return { ...value, status, finishedAt: Date.now() } } }
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100, lease)
		await coordinator.tick()
		assert.equal(((await store.status()) as unknown as CoordinatorStatusSnapshot).jobs[0].status, "queued")
		busy = false
		await coordinator.tick()
		assert.equal((await waitForTerminal(store)).status, "succeeded", "a later poll retries lease acquisition without replaying a prior claim")
		await coordinator.stop()
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testPublishedIntakeQueuesOnceAcrossPollsAndCoordinatorRestart(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-camp-intake-"))
	const run: ActiveCampaignRun = { id: "33333333-3333-4333-8333-333333333333", epoch: 4, startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
	let polls = 0
	try {
		const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => liveAuthority(run))
		await store.setCampaignBudget(definition.id, 20_000, 20_000)
		await store.start(definition.id)
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
			evaluatorDigest: definition.evaluatorDigest!, model: definition.model!, executionKind: "live-cve", reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(): Promise<never> { throw new Error("busy lease must not dispatch") }, async prepareWorkspace(): Promise<never> { throw new Error("busy lease must not dispatch") },
			async evaluate(): Promise<never> { throw new Error("busy lease must not dispatch") }, async deliverPrivate(): Promise<never> { throw new Error("busy lease must not dispatch") },
		})
		const intakeRecord = { advisoryId: "CVE-2026-1262", snapshotSha256: digest("d"), sourceUrl: "https://osv.dev/vulnerability/CVE-2026-1262",
			summary: "Fixture published advisory", affectedRange: "< 1.0" }
		const liveWorker = { ...worker, advisoryIntake: { source: "osv-commit-query" as const, publicBaseRevision: "e".repeat(40), supportedAdvisoryIds: ["CVE-2026-1262"],
			async poll(): Promise<PublishedAdvisoryRecord[]> { polls++; return [intakeRecord] } } }
		const lease = { async acquire(): Promise<null> { return null }, async finish(value: ActiveCampaignRun, status: "succeeded" | "failed"): ReturnType<RepositoryCampaignRunLease["finish"]> { return { ...value, status, finishedAt: Date.now() } } }
		const first = new RepositoryCampaignCoordinator(store, [liveWorker], 100, lease)
		await first.tick()
		let status = await store.status() as unknown as CoordinatorStatusSnapshot
		assert.equal(status.jobs.length, 1)
		assert.equal(status.intakeRecords.length, 1)
		assert.equal(status.intakeRecords[0].disposition, "eligible")
		await first.tick()
		assert.equal(polls, 1, "unchanged source is quiet until the next bounded polling interval")
		await first.stop()
		const restarted = new RepositoryCampaignCoordinator(store, [liveWorker], 100, lease)
		await restarted.tick()
		status = await store.status() as unknown as CoordinatorStatusSnapshot
		assert.equal(polls, 2, "process restart resumes polling")
		assert.equal(status.jobs.length, 1, "persisted source/advisory digest prevents duplicate dispatch after restart")
		assert.equal(status.intakeRecords[0].snapshotSha256, intakeRecord.snapshotSha256)
		await restarted.stop()
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testChangedPrivateSourceBlocksOrdinaryOsvIntake(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-source-pin-osv-"))
	const run: ActiveCampaignRun = { id: "44444444-4444-4444-8444-444444444444", epoch: 5, startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
	let polls = 0
	try {
		const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => liveAuthority(run))
		await store.setCampaignBudget(definition.id, 20_000, 20_000)
		await store.start(definition.id)
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
			evaluatorDigest: definition.evaluatorDigest!, model: definition.model!, executionKind: "live-cve", reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(): Promise<never> { throw new Error("changed source must not dispatch") }, async prepareWorkspace(): Promise<never> { throw new Error("changed source must not dispatch") },
			async evaluate(): Promise<never> { throw new Error("changed source must not dispatch") }, async deliverPrivate(): Promise<never> { throw new Error("changed source must not dispatch") },
		})
		const liveWorker = { ...worker, advisoryIntake: { source: "osv-commit-query" as const, publicBaseRevision: "e".repeat(40), supportedAdvisoryIds: ["CVE-2026-1262"],
			async verifySource(): Promise<void> { throw new Error("private Curl source pin changed") },
			async poll(): Promise<PublishedAdvisoryRecord[]> { polls++; return [] } } }
		const lease = { async acquire(): Promise<null> { return null }, async finish(value: ActiveCampaignRun, status: "succeeded" | "failed"): ReturnType<RepositoryCampaignRunLease["finish"]> { return { ...value, status, finishedAt: Date.now() } } }
		const coordinator = new RepositoryCampaignCoordinator(store, [liveWorker], 100, lease)
		await coordinator.tick()
		const status = await store.status() as unknown as CoordinatorStatusSnapshot
		assert.equal(polls, 0, "private source identity is checked before querying or claiming ordinary OSV intake")
		assert.equal(status.jobs.length, 0)
		assert.equal(status.intakeRecords.length, 0)
		assert.equal(coordinator.intakeStatus(definition.id).state, "unavailable")
		await coordinator.stop()
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["registered repository pipeline runs intake, contained worker, evaluator, and private delivery in order", testCoordinatorRunsRegisteredIntakeWorkerEvaluatorDeliveryLoop],
	["protected evaluator rejection blocks private delivery", testPipelineStopsAtRejectedEvaluatorAndDoesNotDeliver],
	["Stop during preparation prevents contained launch and cleans the prepared workspace", testStopDuringPreparationSkipsContainedLaunchAndCleansWorkspace],
	["Stop after request start blocks later calls, preserves measured settlement, and does not replay", testStopAfterRequestStartPreservesSettlementAndDoesNotReplay],
	["live worker obtains and releases a bounded global run lease", testLiveRunLeaseLifecycle],
	["existing global run lease leaves queued work untouched", testLiveRunLeaseBusyLeavesJobQueued],
	["published advisory intake queues once, stays quiet when unchanged, and deduplicates after restart", testPublishedIntakeQueuesOnceAcrossPollsAndCoordinatorRestart],
	["a changed private source pin blocks ordinary OSV intake before polling", testChangedPrivateSourceBlocksOrdinaryOsvIntake],
]

await runMain("repository-coordinator", tests)
