import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority, type RepositoryCampaignDefinition,
	type RepositoryCampaignJob } from "../repository-campaigns.js"
import { CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_FIXED_REVISION, CURL_DEBIAN_INTRODUCED_REVISION,
	CURL_DEBIAN_PUBLIC_BASE_REVISION, CURL_DEBIAN_SNAPSHOT_SHA256, CURL_DEBIAN_SOURCE_HTML_SHA256,
	CURL_DEBIAN_SOURCE_URL, CURL_DEBIAN_SUMMARY, CURL_FIXED_ADVISORY } from "../repository-known-advisory.js"
import { CURL_REPAIR_ADAPTER_ID, CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_EVALUATOR_DIGEST,
	CURL_REPAIR_POLICY_SHA256, CURL_REPAIR_PROFILE_ID, CURL_REPAIR_RECIPE_DIGEST, CURL_REPAIR_REPOSITORY_ID,
	CURL_REPAIR_RESERVATION, CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_TARGET_REPOSITORY,
	buildCurlHistoricalRepairCandidate } from "../repository-curl-repair.js"
import { evaluateCurlHistoricalRepairCandidate } from "../repository-curl-repair-evaluator.js"
import { createCurlHistoricalRepairAdapters } from "../repository-curl-repair-runtime.js"
import { RepositoryCampaignCoordinator } from "../repository-coordinator.js"
import { bindRepositoryWorkerRegistrations, type RepositoryPipelineAdapterFactory, type RepositoryWorkerRegistration } from "../repository-worker-registry.js"
import type { RepositoryCampaignRunLease } from "../repository-run-lease.js"
import type { ActiveCampaignRun } from "../store.js"
import type { CurlRepairRuntimeDependencies } from "../repository-curl-repair-runtime.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const qualified = { sourceAudited: true, workerQualified: true, recipeQualified: true,
	evaluatorQualified: true, modelApproved: true, dataApproved: true, accessApproved: true }
const definition: RepositoryCampaignDefinition = { id: CURL_REPAIR_CAMPAIGN_ID, name: "Historical Curl repair",
	repositoryId: CURL_REPAIR_REPOSITORY_ID, repository: CURL_REPAIR_TARGET_REPOSITORY,
	sourceRevision: CURL_REPAIR_SOURCE_REVISION, policySha256: CURL_REPAIR_POLICY_SHA256,
	workerProfile: CURL_REPAIR_PROFILE_ID, recipeDigest: CURL_REPAIR_RECIPE_DIGEST,
	evaluatorDigest: CURL_REPAIR_EVALUATOR_DIGEST, model: "none",
	dataAccessProfile: "public-source-and-published-advisory-only", qualification: qualified }
const registration: RepositoryWorkerRegistration = { campaignId: definition.id,
	repositoryId: definition.repositoryId!, repository: definition.repository!, sourceRevision: definition.sourceRevision!,
	policySha256: definition.policySha256!, workerProfile: definition.workerProfile!, recipeDigest: definition.recipeDigest!,
	evaluatorDigest: definition.evaluatorDigest!, model: "none", profileId: "no-model",
	pipelineAdapterId: CURL_REPAIR_ADAPTER_ID, executionKind: "live-cve", reservation: { ...CURL_REPAIR_RESERVATION } }

const emptyLifetime = { settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0, settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0 }
function authority(run: ActiveCampaignRun): RepositoryBudgetAuthority {
	return { mode: "fleet-v2", available: true, limitMicros: 20_000, limitTokens: 108_000,
		committedMicros: 0, committedTokens: 0, asOfMs: Date.now(), campaignId: "fleet-security-watch",
		globalEnabled: true, canAdmit: true, controlEpoch: run.epoch, runId: run.id, runExpiresAtMs: run.expiresAt,
		repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!, repository: definition.repository!,
		sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!, model: definition.model!,
		profileId: CURL_REPAIR_PROFILE_ID, repositoryEnabled: true, repositoryEpoch: 1,
		monthly: { month: new Date().toISOString().slice(0, 7), limitMicros: 5_000_000,
			settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 },
		campaignLifetime: { limitMicros: 20_000, limitTokens: 108_000, ...emptyLifetime }, legacyLifetime: emptyLifetime,
		repositoryLifetime: { limitMicros: 2_000, limitTokens: 18_000, ...emptyLifetime } }
}

function snapshot() {
	return { advisoryId: CURL_FIXED_ADVISORY, sourceUrl: CURL_DEBIAN_SOURCE_URL, snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
		summary: CURL_DEBIAN_SUMMARY, affectedRange: CURL_DEBIAN_AFFECTED_RANGE, fixedVersion: null,
		verificationCheckIds: ["curl-92390-fixed-v1"], publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
		sourceHtmlSha256: CURL_DEBIAN_SOURCE_HTML_SHA256, introducedRevision: CURL_DEBIAN_INTRODUCED_REVISION,
		fixedRevision: CURL_DEBIAN_FIXED_REVISION, observedAt: new Date().toISOString() }
}

function runLease(run: ActiveCampaignRun): RepositoryCampaignRunLease {
	return {
		async acquire(): ReturnType<RepositoryCampaignRunLease["acquire"]> { return run },
		async finish(run: ActiveCampaignRun, status: "succeeded" | "failed"): ReturnType<RepositoryCampaignRunLease["finish"]> {
			return { ...run, status, finishedAt: Date.now() }
		},
	}
}

function repairFactory(dependencies: CurlRepairRuntimeDependencies): RepositoryPipelineAdapterFactory {
	return (item, current, context) => {
		if (!context) throw new Error("repair intake fixture requires its campaign store")
		return createCurlHistoricalRepairAdapters(item, current, context, dependencies)
	}
}

async function waitForTerminal(store: RepositoryCampaignStore): Promise<RepositoryCampaignJob> {
	for (let i = 0; i < 500; i++) {
		const status = await store.status() as { jobs: RepositoryCampaignJob[] }
		const job = status.jobs[0]
		if (job && job.status !== "queued" && job.status !== "running") return job
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("automatic Curl repair intake did not settle")
}

async function registeredRepairIntakeQueuesAndSettlesOnceAcrossRestart(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repair-intake-"))
	let polls = 0
	let sourceChecks = 0
	let evaluatorCalls = 0
	let deliveryCalls = 0
	try {
		const candidate = await buildCurlHistoricalRepairCandidate()
		const advisory = snapshot()
		const run: ActiveCampaignRun = { id: "44444444-4444-4444-8444-444444444444", epoch: 1,
			startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
		const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => authority(run))
		await store.setCampaignBudget(definition.id, 2_000, 18_000)
		await store.start(definition.id)
		const factories = new Map([[CURL_REPAIR_ADAPTER_ID, repairFactory({
				buildCandidate: async () => candidate,
				loadAdvisory: async () => { polls += 1; return advisory },
				verifySource: async () => { sourceChecks += 1 },
				evaluateCandidate: async (input) => {
					evaluatorCalls += 1
					return await evaluateCurlHistoricalRepairCandidate({ ...input, evaluateFixedProof: async () => ({ schemaVersion: 1,
						accepted: true, disposition: "already-fixed", evidenceSha256: "a".repeat(64), reasonCode: "fixed-proof-verified" }) })
				},
				deliverRepair: async ({ claim, candidate: delivered }) => {
					assert.equal(claim.job.purpose, "repair")
					assert.equal(delivered.patchSha256, candidate.patchSha256)
					deliveryCalls += 1
					return { accepted: true, disposition: "already-fixed", evidenceSha256: "d".repeat(64), privateRef: null,
						reasonCode: "candidate-already-in-private-base" }
				},
			})]])
		const [worker] = bindRepositoryWorkerRegistrations([definition], [registration], factories, { store })
		assert.ok(worker?.advisoryIntake)
		assert.equal(worker.advisoryIntake.source, "debian-tracker-repair-snapshot")
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100, runLease(run))
		await coordinator.tick()
		const job = await waitForTerminal(store)
		assert.equal(job.purpose, "repair")
		assert.equal(job.status, "succeeded")
		assert.equal(job.settledMicros, 0)
		assert.equal(job.settledTokens, 0)
		const firstStatus = await store.status() as { jobs: RepositoryCampaignJob[]; intakeRecords: Array<{ source?: string; jobId: string | null }> }
		assert.equal(firstStatus.jobs.length, 1)
		assert.equal(firstStatus.intakeRecords[0]?.source, "debian-tracker-repair-snapshot")
		assert.equal(firstStatus.intakeRecords[0]?.jobId, job.id)
		assert.equal(coordinator.intakeStatus(definition.id).source, "debian-tracker-repair-snapshot")
		assert.equal(coordinator.intakeStatus(definition.id).coverage, "pinned-snapshot")
		await coordinator.stop()

		const restarted = new RepositoryCampaignCoordinator(store, [worker], 100, runLease(run))
		await restarted.tick()
		const secondStatus = await store.status() as { jobs: RepositoryCampaignJob[]; intakeRecords: Array<{ jobId: string | null }> }
		assert.equal(polls, 3, "the fixed loader runs for intake, the worker lookup, and restart intake")
		assert.equal(sourceChecks, 4, "source pin is checked before intake and before claim")
		assert.equal(secondStatus.jobs.length, 1, "unchanged Debian snapshot and restart preserve one durable repair job")
		assert.equal(secondStatus.intakeRecords[0]?.jobId, job.id)
		assert.equal(evaluatorCalls, 1, "the historical evaluator does not replay after restart")
		assert.equal(deliveryCalls, 1, "private already-fixed delivery does not replay after restart")
		await restarted.stop()
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function changedPrivateSourcePinBlocksNewClaims(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repair-source-change-"))
	try {
		const run: ActiveCampaignRun = { id: "55555555-5555-4555-8555-555555555555", epoch: 1,
			startedAt: Date.now(), expiresAt: Date.now() + 20 * 60_000 }
		const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => authority(run))
		await store.setCampaignBudget(definition.id, 2_000, 18_000)
		await store.start(definition.id)
		await store.enqueueKnownRepair({ campaignId: definition.id, advisoryId: CURL_FIXED_ADVISORY,
			publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION, snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
			sourceUrl: CURL_DEBIAN_SOURCE_URL, sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
			affectedRange: CURL_DEBIAN_AFFECTED_RANGE })
		let pollCalls = 0
		const worker = bindRepositoryWorkerRegistrations([definition], [registration], new Map([[CURL_REPAIR_ADAPTER_ID,
			repairFactory({
					loadAdvisory: async () => { pollCalls += 1; return snapshot() },
					verifySource: async () => { throw new Error("private Curl source no longer matches the audited pin") },
				})]]), { store })[0]!
		const coordinator = new RepositoryCampaignCoordinator(store, [worker], 100, runLease(run))
		await coordinator.tick()
		const status = await store.status() as { jobs: RepositoryCampaignJob[] }
		assert.equal(status.jobs[0]?.status, "queued", "source pin failure leaves queued work unclaimed")
		assert.equal(pollCalls, 0, "changed private source blocks admission before the Debian snapshot is polled")
		assert.equal(coordinator.readiness(definition).state, "blocked-prerequisite")
		assert.deepEqual(coordinator.readiness(definition).reasons, ["private-source-pin-changed-or-unavailable"])
		assert.equal(coordinator.intakeStatus(definition.id).source, "debian-tracker-repair-snapshot")
		assert.equal(coordinator.intakeStatus(definition.id).state, "unavailable")
		await coordinator.stop()
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function ambiguousRepairObservationNeverCreatesAReplay(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-repair-ambiguous-"))
	try {
		const store = new RepositoryCampaignStore(path.join(root, "state.json"), [definition], () => ({
			mode: "synthetic-test", available: true, limitMicros: 20_000, limitTokens: 108_000,
			committedMicros: 0, committedTokens: 0,
		}))
		await store.setCampaignBudget(definition.id, 2_000, 18_000)
		await store.start(definition.id)
		const input = { campaignId: definition.id, advisoryId: CURL_FIXED_ADVISORY,
			publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION, snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
			sourceUrl: CURL_DEBIAN_SOURCE_URL, sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
			affectedRange: CURL_DEBIAN_AFFECTED_RANGE }
		const observed = await store.observeKnownRepairAdvisory(input)
		assert.equal(observed.queued, true)
		const claim = await store.claimNext(definition.id, CURL_REPAIR_RESERVATION)
		assert.ok(claim)
		assert.equal(await store.recoverInterrupted(), 1)
		const repeated = await store.observeKnownRepairAdvisory(input)
		assert.equal(repeated.changed, false)
		assert.equal(repeated.queued, false)
		assert.equal(repeated.job.status, "ambiguous")
		const reopened = new RepositoryCampaignStore(store.path, [definition], () => ({
			mode: "synthetic-test", available: true, limitMicros: 20_000, limitTokens: 108_000,
			committedMicros: 0, committedTokens: 0,
		}))
		const afterRestart = await reopened.observeKnownRepairAdvisory(input)
		const status = await reopened.status() as { jobs: RepositoryCampaignJob[] }
		assert.equal(afterRestart.job.id, observed.job.id)
		assert.equal(status.jobs.length, 1)
		assert.equal(status.jobs[0]?.status, "ambiguous")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

const tests: readonly SuiteTest[] = [
	["registered Debian snapshot automatically queues and settles the historical already-fixed repair once across restart", registeredRepairIntakeQueuesAndSettlesOnceAcrossRestart],
	["changed private Curl source pin reports a prerequisite failure and blocks new claims", changedPrivateSourcePinBlocksNewClaims],
	["ambiguous repair intake remains durably held and is never automatically replayed", ambiguousRepairObservationNeverCreatesAReplay],
]

await runMain("repository-curl-repair-intake", tests)
