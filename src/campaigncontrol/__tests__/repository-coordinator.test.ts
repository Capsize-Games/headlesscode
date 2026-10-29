import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { ActiveCampaignRun } from "../store.js"
import { RepositoryCampaignStore, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { RepositoryCampaignCoordinator } from "../repository-coordinator.js"
import { createRepositoryWorkerPipeline } from "../repository-worker-pipeline.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const digest = (char: string) => char.repeat(64)
const qualification = { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definition: RepositoryCampaignDefinition = { id: "fixture-repo", name: "Offline Fixture", repositoryId: "fixture-repo",
	repository: "Capsize/Fixture", sourceRevision: "a".repeat(40), policySha256: digest("9"), workerProfile: "fixture-profile", recipeDigest: digest("b"),
	evaluatorDigest: digest("c"), model: "fixture-model", dataAccessProfile: "fixture-data", qualification }

function liveAuthority(run: ActiveCampaignRun) {
	const monthly = { month: new Date().toISOString().slice(0, 7), limitMicros: 5_000_000, settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 }
	const campaignLifetime = { limitMicros: 20_000, limitTokens: 108_000, settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0, settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0 }
	const lifetime = { settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0, settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0 }
	const repositoryLifetime = { limitMicros: 20_000, limitTokens: 20_000, ...lifetime }
	return { mode: "fleet-v2" as const, available: true, limitMicros: 20_000, limitTokens: 108_000, committedMicros: 0, committedTokens: 0,
		asOfMs: Date.now(), campaignId: "fleet-security-watch", globalEnabled: true, canAdmit: true, controlEpoch: run.epoch, runId: run.id, runExpiresAtMs: run.expiresAt,
		repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!, repository: definition.repository!, sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!,
		model: definition.model!, profileId: "fixture-profile", repositoryEnabled: true, repositoryEpoch: 1,
		monthly, campaignLifetime, legacyLifetime: lifetime, repositoryLifetime }
}

async function waitForTerminal(store: RepositoryCampaignStore): Promise<any> {
	for (let i = 0; i < 300; i++) {
		const status = await store.status() as any
		const job = status.jobs[0]
		if (job && job.status !== "queued" && job.status !== "running") return job
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("repository worker did not reach a terminal state")
}

async function testCoordinatorRunsRegisteredIntakeWorkerEvaluatorDeliveryLoop(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-camp-") )
	const calls: string[] = []
	try {
		const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => ({ mode: "synthetic-test", available: true,
			limitMicros: 100_000, limitTokens: 100_000, committedMicros: 0, committedTokens: 0 }))
		await store.setCampaignBudget(definition.id, 80_000, 80_000)
		await store.start(definition.id)
		await store.enqueue(definition.id, "CVE-2026-1260")
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
			evaluatorDigest: definition.evaluatorDigest!, model: definition.model!, executionKind: "development-checkpoint",
			reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(advisoryId) { calls.push("intake"); return { advisoryId, sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1260",
				snapshotSha256: digest("d"), summary: "Offline fixture only", affectedRange: "< 1.0", fixedVersion: "1.0", verificationCheckIds: ["fixture-check"] } },
			async prepareWorkspace() { calls.push("prepare"); return { worktree: root, taskSha256: digest("e"),
				async runContained() { calls.push("contained-worker"); return { ok: true, durationMs: 12, outputSha256: digest("f"), actualMicros: 0, actualTokens: 0 } },
				async candidateSha256() { return digest("1") }, async cleanup() { calls.push("cleanup") } } },
			async evaluate() { calls.push("evaluator"); return { passed: true, evidenceSha256: digest("2"), detail: "private bounded fixture result" } },
			async deliverPrivate() { calls.push("delivery"); return { accepted: true, evidenceSha256: digest("3"), boardRef: `http://127.0.0.1:8078/api/cards/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v1:${digest("4")}` } },
		})
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100)
		await coordinator.start()
		try {
			const completed = await waitForTerminal(store)
			assert.equal(completed.status, "succeeded")
			assert.deepEqual(calls, ["intake", "prepare", "contained-worker", "evaluator", "delivery", "cleanup"])
			assert.deepEqual(completed.progress.completedSteps, ["intake", "deduplicate", "investigate", "prepare-candidate", "verify", "deliver"])
			assert.deepEqual(completed.progress.evidenceRefs.map((entry: any) => entry.kind), ["intake", "candidate", "test-receipt", "delivery"])
			assert.equal(completed.progress.boardRef, `http://127.0.0.1:8078/api/cards/1c25cecf-e5e8-4b68-b6fd-5d6ad25426d7#hc-repository-result-v1:${digest("4")}`)
		} finally { await coordinator.stop() }
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testPipelineStopsAtRejectedEvaluatorAndDoesNotDeliver(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-camp-") )
	const calls: string[] = []
	try {
		const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => ({ mode: "synthetic-test", available: true,
			limitMicros: 100_000, limitTokens: 100_000, committedMicros: 0, committedTokens: 0 }))
		await store.setCampaignBudget(definition.id, 80_000, 80_000)
		await store.start(definition.id)
		await store.enqueue(definition.id, "CVE-2026-1260")
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
			evaluatorDigest: definition.evaluatorDigest!, model: definition.model!, executionKind: "development-checkpoint",
			reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(advisoryId) { return { advisoryId, sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1260", snapshotSha256: digest("d"),
				summary: "Offline fixture only", affectedRange: "< 1.0", fixedVersion: "1.0", verificationCheckIds: ["fixture-check"] } },
			async prepareWorkspace() { return { worktree: root, taskSha256: digest("e"), async runContained() { return { ok: true, durationMs: 5, outputSha256: digest("f"), actualMicros: 0, actualTokens: 0 } }, async candidateSha256() { return digest("1") }, async cleanup() { calls.push("cleanup") } } },
			async evaluate() { calls.push("evaluator"); return { passed: false, evidenceSha256: digest("2"), detail: "fixture rejection" } },
			async deliverPrivate() { calls.push("delivery"); return { accepted: true, evidenceSha256: digest("3") } },
		})
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100)
		await coordinator.start()
		try {
			const failed = await waitForTerminal(store)
			assert.equal(failed.status, "failed")
			assert.deepEqual(calls, ["evaluator", "cleanup"])
			assert.equal(failed.progress.blocker, "protected-evaluator-rejected-candidate")
			assert.equal(failed.progress.evidenceRefs.some((entry: any) => entry.kind === "delivery"), false)
		} finally { await coordinator.stop() }
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testLiveRunLeaseLifecycle(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-camp-run-"))
	const run: ActiveCampaignRun = { id: "11111111-1111-4111-8111-111111111111", epoch: 4, startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
	const events: string[] = []
	try {
		const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => liveAuthority(run))
		const lease = { async acquire(timeoutMs: number) { events.push(`acquire:${timeoutMs}`); return run }, async finish(value: ActiveCampaignRun, status: "succeeded" | "failed") {
			assert.equal(value.id, run.id); events.push(`finish:${status}`); return { ...value, status, finishedAt: Date.now() }
		} }
		await store.setCampaignBudget(definition.id, 20_000, 20_000); await store.start(definition.id); await store.enqueue(definition.id, "CVE-2026-1260")
		const worker = createRepositoryWorkerPipeline({ workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!, evaluatorDigest: definition.evaluatorDigest!,
			model: definition.model!, executionKind: "live-cve", reservation: { micros: 10_000, tokens: 10_000 },
			async lookupAdvisory(advisoryId) { events.push("intake"); return { advisoryId, sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1260", snapshotSha256: digest("d"),
				summary: "Fixture", affectedRange: "< 1", fixedVersion: "1", verificationCheckIds: ["registered"] } },
			async prepareWorkspace() { return { worktree: root, taskSha256: digest("e"), async runContained() { events.push("worker"); return { ok: true, durationMs: 1, outputSha256: digest("f"), actualMicros: 1, actualTokens: 1 } }, async candidateSha256() { return digest("1") } } },
			async evaluate() { events.push("evaluate"); return { passed: true, evidenceSha256: digest("2"), detail: "fixture" } },
			async deliverPrivate() { events.push("deliver"); return { accepted: true, evidenceSha256: digest("3") } },
		})
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100, lease)
		await coordinator.start()
		try {
			assert.equal((await waitForTerminal(store)).status, "succeeded")
			for (let i = 0; i < 20 && !events.includes("finish:succeeded"); i++) await new Promise((resolve) => setTimeout(resolve, 10))
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
			async lookupAdvisory(advisoryId) { return { advisoryId, sourceUrl: "https://osv.dev/vulnerability/CVE-2026-1261", snapshotSha256: digest("d"),
				summary: "Fixture", affectedRange: "< 1", fixedVersion: "1", verificationCheckIds: ["registered"] } },
			async prepareWorkspace() { return { worktree: root, taskSha256: digest("e"), async runContained() { return { ok: true, durationMs: 1, outputSha256: digest("f"), actualMicros: 1, actualTokens: 1 } }, async candidateSha256() { return digest("1") } } },
			async evaluate() { return { passed: true, evidenceSha256: digest("2"), detail: "fixture" } },
			async deliverPrivate() { return { accepted: true, evidenceSha256: digest("3") } } })
		const lease = { async acquire() { return busy ? null : run }, async finish(value: ActiveCampaignRun, status: "succeeded" | "failed") { assert.equal(value.id, run.id); assert.equal(status, "succeeded"); return { ...value, status, finishedAt: Date.now() } } }
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100, lease)
		await coordinator.tick()
		assert.equal(((await store.status()) as any).jobs[0].status, "queued")
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
			async lookupAdvisory() { throw new Error("busy lease must not dispatch") }, async prepareWorkspace() { throw new Error("busy lease must not dispatch") },
			async evaluate() { throw new Error("busy lease must not dispatch") }, async deliverPrivate() { throw new Error("busy lease must not dispatch") },
		})
		const intakeRecord = { advisoryId: "CVE-2026-1262", snapshotSha256: digest("d"), sourceUrl: "https://osv.dev/vulnerability/CVE-2026-1262",
			summary: "Fixture published advisory", affectedRange: "< 1.0" }
		const liveWorker = { ...worker, advisoryIntake: { publicBaseRevision: "e".repeat(40), supportedAdvisoryIds: ["CVE-2026-1262"],
			async poll() { polls++; return [intakeRecord] } } }
		const lease = { async acquire() { return null }, async finish(value: ActiveCampaignRun, status: "succeeded" | "failed") { return { ...value, status, finishedAt: Date.now() } } }
		const first = new RepositoryCampaignCoordinator(store, [liveWorker], 100, lease)
		await first.tick()
		let status = await store.status() as any
		assert.equal(status.jobs.length, 1)
		assert.equal(status.intakeRecords.length, 1)
		assert.equal(status.intakeRecords[0].disposition, "eligible")
		await first.tick()
		assert.equal(polls, 1, "unchanged source is quiet until the next bounded polling interval")
		await first.stop()
		const restarted = new RepositoryCampaignCoordinator(store, [liveWorker], 100, lease)
		await restarted.tick()
		status = await store.status() as any
		assert.equal(polls, 2, "process restart resumes polling")
		assert.equal(status.jobs.length, 1, "persisted source/advisory digest prevents duplicate dispatch after restart")
		assert.equal(status.intakeRecords[0].snapshotSha256, intakeRecord.snapshotSha256)
		await restarted.stop()
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["registered repository pipeline runs intake, contained worker, evaluator, and private delivery in order", testCoordinatorRunsRegisteredIntakeWorkerEvaluatorDeliveryLoop],
	["protected evaluator rejection blocks private delivery", testPipelineStopsAtRejectedEvaluatorAndDoesNotDeliver],
	["live worker obtains and releases a bounded global run lease", testLiveRunLeaseLifecycle],
	["existing global run lease leaves queued work untouched", testLiveRunLeaseBusyLeavesJobQueued],
	["published advisory intake queues once, stays quiet when unchanged, and deduplicates after restart", testPublishedIntakeQueuesOnceAcrossPollsAndCoordinatorRestart],
]

await runMain("repository-coordinator", tests)
