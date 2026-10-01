import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { createHash } from "node:crypto"
import { appendRun } from "../archive.js"
import type { RsiConfig, RsiRunRecord, WorkerHarnessRuntimeIdentity } from "../types.js"
import { assertEngineeringTransition, isFullyConfirmedRun, runEngineeringArm, runFrozenCampaignArm } from "../../../scripts/rsi-proof-demonstration.js"
import type { FrozenProofDemonstrationManifest } from "../proof-demonstration-manifest.js"
import { proofCampaignManifestDigest, type ProofCampaignManifest } from "../proof-campaign.js"

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

test("engineering verifier requires a terminal fixed-control generation-one decision", () => {
	const parentCommit = "1".repeat(40)
	const childCommit = "2".repeat(40)
	const fixedCell = { armId: "fixed-control", phase: "development", generation: 1, candidateId: "g1-candidate-0", taskId: "dev-1", seed: "41", attemptKind: "parent" }
	const fixed = {
		candidates: [],
		proofCampaign: {
			manifest: { schedule: [fixedCell] },
			ledgerSnapshot: {
				attempts: [{ arm_id: "fixed-control", generation: 1, candidate_id: "g1-candidate-0", task_id: "dev-1", seed: "41", attempt_kind: "parent", status: "completed" }],
				decisions: [{ arm_id: "fixed-control", generation: 1, candidate_id: "g1-candidate-0", decision: "rejected" }],
			},
		},
	} as unknown as RsiRunRecord
	const parent = { id: "g0-candidate-0", generation: 0, status: "accepted", developmentProof: { accepted: true }, commits: [parentCommit] }
	const child = { id: "g1-candidate-0", generation: 1, status: "accepted", developmentProof: { accepted: true }, parent: parent.id, baseCommit: parentCommit, parentCommit, workerHarnessExecution: { parentCommit }, commits: [childCommit] }
	const self = {
		candidates: [parent, child],
		proofCampaign: {
			ledgerSnapshot: {
				events: [{ arm_id: "self-hosted", event_type: "generation-selected", payload: { generation: 0, selectedCandidateIds: ["g0-candidate-0"] } }],
				decisions: [{ arm_id: "self-hosted", generation: 1, candidate_id: "g1-candidate-0", decision: "accepted", parent_commit: parentCommit }],
			},
		},
	} as unknown as RsiRunRecord
	assert.doesNotThrow(() => assertEngineeringTransition(fixed, self))
	const missingDecision = structuredClone(fixed)
	missingDecision.proofCampaign!.ledgerSnapshot!.decisions = []
	assert.throws(() => assertEngineeringTransition(missingDecision, self), /fixed-control generation-one cells and candidate decisions/)
})

test("engineering replay reuses a finished fixed arm after a crash before self-hosted starts", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-engineering-replay-"))
	try {
		const campaign = `rsi-proof-${"a".repeat(20)}`
		const arm = "fixed-control" as const
		const runtime: WorkerHarnessRuntimeIdentity = { imageName: "image", imageDigest: `sha256:${"b".repeat(64)}`, harnessCommit: "c".repeat(40), dependencyLockDigest: "d".repeat(64) }
		const config = { archiveDir: root, model: "model", generations: 2, seed: "engineering-seed" } as RsiConfig
		const finished = {
			runId: `${campaign}-fixed`, startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T00:01:00Z",
			model: "model", baseRef: "main", baseCommit: "e".repeat(40), generations: 2, candidates: [], reports: [],
			workerHarnessPairId: campaign, workerHarnessMode: arm, workerHarnessSamplingSeed: "engineering-seed", workerHarnessRuntime: runtime,
			proofCampaign: {
				manifest: { phaseMode: "engineering-only", schedule: [] }, manifestSha256: "f".repeat(64), campaignId: campaign, armId: arm, epoch: 1,
				ledgerSnapshot: { arms: [{ arm_id: arm, state: "finished" }] }, state: "finished",
			},
		} as unknown as RsiRunRecord
		await appendRun(root, finished)
		let runnerCalls = 0
		const resumed = await runEngineeringArm(config, campaign, arm, finished.baseCommit, "engineering-seed", runtime, async () => {
			runnerCalls++
			throw new Error("a completed arm must be read-only on recovery")
		})
		assert.equal(resumed.runId, finished.runId)
		assert.equal(runnerCalls, 0)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("campaign executor reuses a finished first arm without dispatching it again", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-campaign-replay-"))
	try {
		const campaign = `rsi-proof-${"a".repeat(20)}`
		const armId = "fixed-control" as const
		const runtime: WorkerHarnessRuntimeIdentity = { imageName: "image", imageDigest: `sha256:${"b".repeat(64)}`, harnessCommit: "c".repeat(40), dependencyLockDigest: "d".repeat(64) }
		const config = { archiveDir: root, seed: "campaign-seed", generations: 3, model: "model" } as RsiConfig
		const schedule = [
			{ armId, generation: 2, candidateId: "candidate-2-0", taskId: "holdout", seed: "17", attemptKind: "confirmation" as const, phase: "confirmation" as const },
			{ armId, generation: 2, candidateId: "root-control", taskId: "holdout", seed: "17", attemptKind: "fixed-control" as const, phase: "confirmation" as const },
		]
		const attempts = [
			{ attemptId: "final-attempt", taskId: "holdout", seed: 17, harnessCommit: "1".repeat(40), validity: "valid", proofQualified: true, resourceAccounting: "supervisor-enforced", artifactRefs: {}, inferenceReceipt: { qualified: true, endpointProvider: "deepinfra", returnedProviders: ["deepinfra"] } },
			{ attemptId: "root-attempt", taskId: "holdout", seed: 17, harnessCommit: "e".repeat(40), validity: "valid", proofQualified: true, resourceAccounting: "supervisor-enforced", artifactRefs: {}, inferenceReceipt: { qualified: true, endpointProvider: "deepinfra", returnedProviders: ["deepinfra"] } },
		]
		const manifestData = {
			schemaVersion: 1, phaseMode: "paired-confirmation", campaignId: campaign, rootCommit: "e".repeat(40),
			benchmarkDigests: { manifest: "3".repeat(64), development: "4".repeat(64), confirmation: "5".repeat(64) },
			armAssignment: { fixedControl: "fixed-control", selfHosted: "self-hosted" },
			model: { provider: "openshell-openrouter", id: "model", settings: { sampling: { temperature: 0 } } }, seed: "campaign-seed", taskOrder: ["holdout"], schedule,
			budgets: { attempt: { maxCalls: 1, maxTokens: 10, maxSpendUsd: 0.1, maxDurationMs: 1000 }, root: { maxCalls: 10, maxTokens: 100, maxSpendUsd: 1, maxRuntimeMs: 10000 } },
			acceptanceRule: {}, runtime: { imageDigest: runtime.imageDigest, harnessCommit: runtime.harnessCommit, dependencyLockDigest: runtime.dependencyLockDigest }, analysisVersion: "test",
			settings: { effectiveConfig: config },
		} as unknown as ProofCampaignManifest
		const run = {
			runId: `${campaign}-fixed`, startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T00:01:00Z",
			model: "model", baseRef: "main", baseCommit: "e".repeat(40), generations: 3, candidates: [], reports: [],
			workerHarnessPairId: campaign, workerHarnessMode: armId, workerHarnessSamplingSeed: "campaign-seed", workerHarnessConfigDigest: "f".repeat(64), workerHarnessPlannedGenerations: 3, workerHarnessRuntime: runtime,
			confirmationEvidence: "complete", confirmationAttempts: attempts,
			proofConfirmation: { selectedHarness: { candidateId: "candidate-id", slotId: "candidate-2-0", generation: 2, commit: "1".repeat(40), attemptIds: ["final-attempt"] }, rootHarness: { commit: "e".repeat(40), attemptIds: ["root-attempt"] } },
			proofCampaign: { manifest: manifestData, manifestSha256: proofCampaignManifestDigest(manifestData), campaignId: campaign, armId, epoch: 1, state: "finished", ledgerSnapshot: { campaign: { state: "finished" }, arms: [{ arm_id: armId, phase: "confirmation", state: "finished" }], attempts: schedule.map((cell, index) => ({ broker_job_id: index === 0 ? "final-attempt" : "root-attempt", arm_id: armId, generation: cell.generation, candidate_id: cell.candidateId, task_id: cell.taskId, seed: cell.seed, attempt_kind: cell.attemptKind, status: "completed", result_sha256: digest(attempts[index]), artifact_refs: {} })) } },
		} as unknown as RsiRunRecord
		assert.equal(isFullyConfirmedRun(run, armId), true)
		await appendRun(root, run)
		const plan = { campaignIds: { campaigns: [campaign] }, execution: { configs: [config, config, config, config] }, benchmarkManifestSha256: "3".repeat(64), model: { provider: "openshell-openrouter", requestedId: "model" }, rootCommit: run.baseCommit, runtime } as unknown as FrozenProofDemonstrationManifest
		let calls = 0
		const reused = await runFrozenCampaignArm(plan, 0, armId, "confirmation", async () => { calls++; throw new Error("finished arm must not replay inference") })
		assert.equal(reused.runId, run.runId)
		assert.equal(calls, 0)
		const forgedReceipt = structuredClone(run)
		forgedReceipt.confirmationAttempts![0]!.inferenceReceipt!.returnedProviders = []
		assert.equal(isFullyConfirmedRun(forgedReceipt, armId), false, "an empty provider list is not authoritative provider evidence")
		const damaged = structuredClone(run)
		;(damaged.proofCampaign!.ledgerSnapshot!.attempts as Array<Record<string, unknown>>)[0]!.result_sha256 = "f".repeat(64)
		assert.equal(isFullyConfirmedRun(damaged, armId), false, "a changed durable result digest prevents terminal replay")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
