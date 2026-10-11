import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { analyzeProofDemonstration, verifyProofDemonstrationArtifactBytes } from "../proof-demonstration.js"
import { freezeProofDemonstrationManifest, frozenProofConfigDigest } from "../proof-demonstration-manifest.js"
import { proofCampaignManifestDigest, type ProofCampaignManifest } from "../proof-campaign.js"
import { RSI_MUSE_OPENROUTER_MODEL, RSI_OPENROUTER_MODEL } from "../inference-broker.js"
import type { BenchmarkAttempt } from "../benchmark/types.js"
import type { FrozenProofDemonstrationManifest } from "../proof-demonstration-manifest.js"
import type { CandidateRecord, RsiConfig, RsiRunRecord, WorkerHarnessRuntimeIdentity } from "../types.js"
import { formatAnalysisReport } from "../../../scripts/rsi-proof-demonstration.js"

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")

function frozenPlan(): FrozenProofDemonstrationManifest {
	const configs = ["engineering", "campaign-a", "campaign-b", "campaign-c"].map((seed) => ({ repoRoot: "/work", seed, mutationTask: "fixed task", protectedPaths: ["src/rsi"], evaluatorTrustedKeySha256: `sha256:${"9".repeat(64)}` } as RsiConfig)) as unknown as [RsiConfig, RsiConfig, RsiConfig, RsiConfig]
	const runtime: WorkerHarnessRuntimeIdentity = { imageName: "headlesscode-openshell-rsi:fixed", imageDigest: `sha256:${"a".repeat(64)}`, harnessCommit: "b".repeat(40), dependencyLockDigest: "c".repeat(64) }
	const tasks = ["dev-task", "confirm-task"].map((id, index) => ({ id, split: index ? "confirmation" : "development", family: "engine", seed: index + 1, startDigest: "d".repeat(64), verifierDigest: "e".repeat(64), knownGoodDigest: "f".repeat(64), knownBadDigest: "1".repeat(64), ceilings: { timeoutMs: 1000, maxCalls: 1, maxOutputTokensPerCall: 100, maxPatchBytes: 1000 } }))
	const limits = { campaignId: "test", maxCalls: 1, maxInputTokensPerCall: 100, maxOutputTokensPerCall: 100, maxTotalTokens: 200, maxDurationMs: 1000, maxRequestBytes: 1000, maxResponseBytes: 1000, maxInputPricePerMillionUsd: 1, maxOutputPricePerMillionUsd: 1, maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.02, maxCampaignSpendUsd: 1 }
	const plan = { totalRootSpendCeilingUsd: 1, engineeringRootSpendCeilingUsd: 0.25, campaignRootsSpendCeilingUsd: 0.75, totalCalls: 1, totalTokens: 1, totalTaskWallMs: 1000 } as never
	const args = {
		createdAt: new Date(0).toISOString(), rootCommit: "2".repeat(40), benchmarkManifestSha256: "3".repeat(64),
		model: { provider: "openshell-openrouter" as const, requestedId: RSI_OPENROUTER_MODEL, sampling: { temperature: 0 as const, think: false as const, seed: "provider-default" as const } },
		endpointPrice: { model: RSI_OPENROUTER_MODEL, provider: "deepinfra" as const, endpointTag: "deepinfra/fp8" as const, quantization: "fp8" as const, supportedParameters: ["max_tokens", "temperature", "tools", "tool_choice"], inputPricePerMillionUsd: 0.06, outputPricePerMillionUsd: 0.18, observedAt: new Date(0).toISOString(), responseSha256: "4".repeat(64) },
		priceCeilingsPerMillionUsd: { input: 1, output: 1 }, runtime,
		execution: { configs, configSha256: frozenProofConfigDigest(configs), analysisSourceSha256: "5".repeat(64), inferenceLimits: { mutation: limits, benchmark: limits }, taskIdentities: tasks },
		seeds: { engineering: "engineering", campaigns: ["campaign-a", "campaign-b", "campaign-c"] as [string, string, string] },
		campaignIds: { engineering: "eng-id", campaigns: ["campaign-a-id", "campaign-b-id", "campaign-c-id"] as [string, string, string] }, operatorCapUsd: 2, plan,
		engineeringEvidence: { path: "/work/.headlesscode/rsi-proof/engineering.json", sha256: "9".repeat(64), campaignId: "eng-id", rootCommit: "2".repeat(40), manifestSha256: "a".repeat(64), snapshotSha256: "b".repeat(64) },
		analysis: { bootstrapSeed: "fixed-bootstrap", bootstrapReplicates: 100, confirmationRetentionTaskIds: ["confirm-task"] },
	}
	return freezeProofDemonstrationManifest(args)
}

function musePlan(): FrozenProofDemonstrationManifest {
	const base = frozenPlan()
	const { schemaVersion: _schemaVersion, digestSha256: _digestSha256, ...body } = base
	const configs = base.execution.configs.map((config) => ({ ...config, model: RSI_MUSE_OPENROUTER_MODEL, roles: { worker: { provider: "openrouter" as const, model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "muse-spark-contributor" as const } } })) as unknown as typeof base.execution.configs
	return freezeProofDemonstrationManifest({
		...body,
		model: { ...base.model, requestedId: RSI_MUSE_OPENROUTER_MODEL, profileId: "muse-spark-contributor" },
		endpointPrice: { ...base.endpointPrice, model: RSI_MUSE_OPENROUTER_MODEL, provider: "meta", endpointTag: "meta", quantization: "unknown" },
		execution: { ...base.execution, configs, configSha256: frozenProofConfigDigest(configs) },
	})
}

test("analysis is inconclusive for missing campaign records and duplicate arm runs", () => {
	const plan = frozenPlan()
	const empty = analyzeProofDemonstration([], { frozenPlan: plan })
	assert.equal(empty.verdict, "inconclusive")
	assert.ok(empty.denominators.missingCells.some((cell) => cell.includes("missing-arm")))
	assert.match(formatAnalysisReport(empty, plan.digestSha256), /Missing cells:/)
	const armManifest = {
		campaignId: plan.campaignIds.campaigns[0], rootCommit: plan.rootCommit,
		benchmarkDigests: { manifest: plan.benchmarkManifestSha256, development: "6".repeat(64), confirmation: "7".repeat(64) },
		model: { provider: plan.model.provider, id: plan.model.requestedId, settings: plan.model.sampling }, seed: plan.seeds.campaigns[0], taskOrder: ["confirm-task"],
		schedule: [{ armId: "self-hosted", generation: 0, candidateId: "root-control", taskId: "confirm-task", seed: "2", attemptKind: "fixed-control", phase: "confirmation" }],
		budgets: {}, acceptanceRule: {}, runtime: plan.runtime, analysisVersion: "test", settings: {},
	}
	const duplicateArm = (runId: string) => ({ runId, startedAt: new Date(0).toISOString(), model: plan.model.requestedId, baseRef: "main", baseCommit: plan.rootCommit, generations: 1, candidates: [], reports: [], workerHarnessPairId: plan.campaignIds.campaigns[0], workerHarnessMode: "self-hosted", proofCampaign: { manifest: armManifest, manifestSha256: "8".repeat(64), campaignId: armManifest.campaignId, armId: "self-hosted", epoch: 1, state: "finished" } }) as unknown as RsiRunRecord
	const duplicate = analyzeProofDemonstration([duplicateArm("dup-1"), duplicateArm("dup-2")], { frozenPlan: plan })
	assert.equal(duplicate.verdict, "inconclusive")
	assert.ok(duplicate.denominators.missingCells.includes(plan.campaignIds.campaigns[0] + ":duplicate-arm-runs"))
})

function qualifyingRuns(plan: FrozenProofDemonstrationManifest): RsiRunRecord[] {
	const runs: RsiRunRecord[] = []
	const task = plan.execution.taskIdentities.find((entry) => entry.split === "confirmation")!
	for (let index = 0; index < 3; index++) {
		const campaignId = plan.campaignIds.campaigns[index]!
		const seed = plan.seeds.campaigns[index]!
		const gen0Commit = (10 + index).toString(16).repeat(40).slice(0, 40)
		const gen1Commit = (20 + index).toString(16).repeat(40).slice(0, 40)
		const gen0Id = `gen0-${index}`
		const gen1Id = `gen1-${index}`
		const manifestFor = (armId: "self-hosted" | "fixed-control") => {
			const schedule = (["self-hosted", "fixed-control"] as const).flatMap((scheduledArm) => [
				{ armId: scheduledArm, generation: 2, candidateId: "g2-candidate-0", taskId: task.id, seed: String(task.seed), attemptKind: "confirmation", phase: "confirmation" },
				{ armId: scheduledArm, generation: 2, candidateId: "root-control", taskId: task.id, seed: String(task.seed), attemptKind: "fixed-control", phase: "confirmation" },
			])
			const raw = {
				schemaVersion: 1, campaignId, rootCommit: plan.rootCommit,
				benchmarkDigests: { manifest: plan.benchmarkManifestSha256, development: "6".repeat(64), confirmation: "7".repeat(64) },
				armAssignment: { fixedControl: "fixed-control", selfHosted: "self-hosted" },
			model: { provider: plan.model.provider, id: plan.model.requestedId, ...(plan.model.profileId ? { profileId: plan.model.profileId } : {}), settings: { sampling: plan.model.sampling } }, seed,
				taskOrder: [task.id], schedule, budgets: { attempt: { maxCalls: 1, maxTokens: 200, maxSpendUsd: 0.02, maxDurationMs: 1000 }, root: { maxCalls: 100, maxTokens: 10000, maxSpendUsd: 1, maxRuntimeMs: 10_000_000 } },
				acceptanceRule: { confirmationRetentionTaskIds: [task.id] }, runtime: { imageDigest: plan.runtime.imageDigest, harnessCommit: plan.runtime.harnessCommit, dependencyLockDigest: plan.runtime.dependencyLockDigest }, analysisVersion: "task-cluster-bootstrap-90-v1",
				phaseMode: "paired-confirmation", settings: { effectiveConfig: plan.execution.configs[index + 1], confirmationTaskIdentities: [{ id: task.id, seed: task.seed, startDigest: task.startDigest, verifierDigest: task.verifierDigest, ceilings: task.ceilings }], candidateCounts: [1, 1, 1], inferenceCeilings: { maxInputTokensPerCall: 100, maxTotalTokens: 200, maxJobSpendUsd: 0.02 } },
			}
			return raw as unknown as ProofCampaignManifest
		}
		for (const armId of ["self-hosted", "fixed-control"] as const) {
			const armManifest = manifestFor(armId)
			const selectedId = armId === "self-hosted" ? gen1Id : "fixed-final"
			const selectedCommit = armId === "self-hosted" ? gen1Commit : "3".repeat(40)
			const finalAttemptId = `${campaignId}-${armId}-final`
			const rootAttemptId = `${campaignId}-${armId}-root`
			const makeAttempt = (attemptId: string, candidateId: string, kind: string, commit: string, success: boolean) => ({
				attemptId, taskId: task.id, split: "confirmation", harnessCommit: commit, model: { provider: plan.model.provider, id: plan.model.requestedId, ...(plan.model.profileId ? { profileId: plan.model.profileId } : {}), sampling: plan.model.sampling }, seed: task.seed,
				startDigest: task.startDigest, evaluatorDigest: task.verifierDigest, ceilings: task.ceilings, validity: "valid", proofQualified: true, resourceAccounting: "supervisor-enforced", verifiedSuccess: success,
				calls: 1, tokens: 20, wallTimeMs: 10, patchDigest: "8".repeat(64), artifactRefs: {}, stopReason: "completed",
				inferenceReceipt: { qualified: true, model: plan.model.requestedId, returnedModels: [plan.model.requestedId], endpointProvider: plan.endpointPrice.provider, returnedProviders: [plan.endpointPrice.provider], calls: 1, totalTokens: 20, costUsd: 0.001 },
			})
			const finalAttempt = makeAttempt(finalAttemptId, armId === "self-hosted" ? "g2-candidate-0" : "g2-candidate-0", "confirmation", selectedCommit, armId === "self-hosted") as unknown as BenchmarkAttempt
			const rootAttempt = makeAttempt(rootAttemptId, "root-control", "fixed-control", plan.rootCommit, false) as unknown as BenchmarkAttempt
			const attemptRows = [
				{ broker_job_id: finalAttemptId, arm_id: armId, generation: 2, candidate_id: "g2-candidate-0", task_id: task.id, seed: String(task.seed), attempt_kind: "confirmation", status: "completed", result_sha256: sha256(JSON.stringify(finalAttempt)), artifact_refs: {} },
				{ broker_job_id: rootAttemptId, arm_id: armId, generation: 2, candidate_id: "root-control", task_id: task.id, seed: String(task.seed), attempt_kind: "fixed-control", status: "completed", result_sha256: sha256(JSON.stringify(rootAttempt)), artifact_refs: {} },
			]
			const slot0 = "g0-candidate-0"
			const slot1 = "g1-candidate-0"
			const selectedSlot = "g2-candidate-0"
			const events = [0, 1, 2].map((generation) => ({ arm_id: armId, event_type: "generation-selected", payload: { generation, selectedCandidateIds: [generation === 0 ? slot0 : generation === 1 ? slot1 : selectedSlot] } }))
			const decisions = [
				{ arm_id: armId, generation: 0, candidate_id: slot0, decision: "accepted", child_commit: gen0Commit, parent_commit: plan.rootCommit, parent_id: "baseline" },
				{ arm_id: armId, generation: 1, candidate_id: slot1, decision: "accepted", child_commit: gen1Commit, parent_commit: gen0Commit, parent_id: slot0 },
				{ arm_id: armId, generation: 2, candidate_id: selectedSlot, decision: "accepted", child_commit: selectedCommit, parent_commit: gen1Commit, parent_id: slot1 },
			]
			const candidate0 = { id: gen0Id, generation: 0, status: "accepted", parent: "baseline", parentCommit: plan.rootCommit, baseCommit: plan.rootCommit, commits: [gen0Commit], developmentProof: { accepted: true, immediateParent: { comparable: true, eligible: true } } } as unknown as CandidateRecord
			const candidate1 = { id: gen1Id, generation: 1, status: "accepted", parent: gen0Id, parentCommit: gen0Commit, baseCommit: gen0Commit, commits: [gen1Commit], workerHarnessExecution: { parentCommit: gen0Commit }, developmentProof: { accepted: true, immediateParent: { comparable: true, eligible: true } } } as unknown as CandidateRecord
			const candidate2 = { id: selectedId, generation: 2, status: "accepted", parent: gen1Id, parentCommit: gen1Commit, baseCommit: gen1Commit, commits: [selectedCommit], workerHarnessExecution: { parentCommit: gen1Commit }, developmentProof: { accepted: true, immediateParent: { comparable: true, eligible: true } } } as unknown as CandidateRecord
			const confirmationAttemptList = [finalAttempt, rootAttempt]
			const run = {
				runId: `${campaignId}-${armId}`, startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T00:01:00Z", model: plan.model.requestedId, baseRef: "main", baseCommit: plan.rootCommit, generations: 3, selected: selectedId,
				workerHarnessMode: armId, workerHarnessPairId: campaignId, workerHarnessSamplingSeed: seed, workerHarnessRuntime: plan.runtime, workerHarnessConfigDigest: "9".repeat(64), confirmationEvidence: "complete",
				candidates: [candidate0, candidate1, candidate2], reports: [], confirmationAttempts: confirmationAttemptList,
				proofConfirmation: { selectedHarness: { candidateId: selectedId, slotId: selectedSlot, generation: 2, commit: selectedCommit, attemptIds: [finalAttemptId] }, rootHarness: { commit: plan.rootCommit, attemptIds: [rootAttemptId] } },
				proofCampaign: { campaignId, armId, manifest: armManifest, manifestSha256: proofCampaignManifestDigest(armManifest), epoch: 1, state: "finished", ledgerSnapshot: {
					campaign: { state: "finished", manifest_sha256: proofCampaignManifestDigest(armManifest), used_calls: 4, used_tokens: 80, used_spend_microusd: 4_000, reserved_calls: 0, reserved_tokens: 0, reserved_spend_microusd: 0, deadline_at: "2026-09-30T01:00:00Z" },
					arms: [{ arm_id: armId, state: "finished" }, { arm_id: armId === "self-hosted" ? "fixed-control" : "self-hosted", state: "finished" }], attempts: attemptRows, events, decisions,
				} },
			} as unknown as RsiRunRecord
			runs.push(run)
		}
	}
	return runs
}

test("a complete synthetic paired record can demonstrate, while provider, config, cells, and lineage tampering fail closed", () => {
	const plan = frozenPlan()
	const records = qualifyingRuns(plan)
	const report = analyzeProofDemonstration(records, { frozenPlan: plan })
	assert.equal(report.verdict, "demonstrated")
	assert.ok(report.pooled.cluster90PercentInterval?.[0]! > 0)
	const wrongProvider = structuredClone(records)
	wrongProvider[0]!.confirmationAttempts![0]!.inferenceReceipt!.returnedProviders = ["other"]
	assert.notEqual(analyzeProofDemonstration(wrongProvider, { frozenPlan: plan }).verdict, "demonstrated")
	const wrongConfig = structuredClone(records)
	;(wrongConfig[0]!.proofCampaign!.manifest.settings.effectiveConfig as Record<string, unknown>).mutationTask = "different task"
	wrongConfig[0]!.proofCampaign!.manifestSha256 = proofCampaignManifestDigest(wrongConfig[0]!.proofCampaign!.manifest)
	wrongConfig[1]!.proofCampaign!.manifest = structuredClone(wrongConfig[0]!.proofCampaign!.manifest)
	wrongConfig[1]!.proofCampaign!.manifestSha256 = wrongConfig[0]!.proofCampaign!.manifestSha256
	assert.notEqual(analyzeProofDemonstration(wrongConfig, { frozenPlan: plan }).verdict, "demonstrated")
	const missingCell = structuredClone(records)
	missingCell[0]!.proofCampaign!.ledgerSnapshot!.attempts = (missingCell[0]!.proofCampaign!.ledgerSnapshot!.attempts as unknown[]).slice(1)
	assert.notEqual(analyzeProofDemonstration(missingCell, { frozenPlan: plan }).verdict, "demonstrated")
	const wrongLineage = structuredClone(records)
	for (const run of wrongLineage.filter((entry) => entry.workerHarnessMode === "self-hosted")) run.candidates.find((candidate) => candidate.generation === 1)!.parentCommit = "f".repeat(40)
	assert.notEqual(analyzeProofDemonstration(wrongLineage, { frozenPlan: plan }).verdict, "demonstrated")
})

test("analysis accepts exact admitted Muse profile/provider receipts and rejects DeepInfra receipts", () => {
	const plan = musePlan()
	const records = qualifyingRuns(plan)
	const report = analyzeProofDemonstration(records, { frozenPlan: plan })
	assert.equal(report.verdict, "demonstrated", `${report.verdictReasons.join("; ")} missing=${report.denominators.missingCells.join(",")} excluded=${report.denominators.excludedAttempts.join(",")}`)
	const wrongRoute = structuredClone(records)
	wrongRoute[0]!.confirmationAttempts![0]!.inferenceReceipt!.returnedProviders = ["deepinfra"]
	assert.notEqual(analyzeProofDemonstration(wrongRoute, { frozenPlan: plan }).verdict, "demonstrated")
	const unadmittedAlias = structuredClone(records)
	unadmittedAlias[0]!.confirmationAttempts![0]!.inferenceReceipt!.returnedModels = ["meta/unadmitted-alias"]
	assert.notEqual(analyzeProofDemonstration(unadmittedAlias, { frozenPlan: plan }).verdict, "demonstrated")
})

test("confirmation analysis artifact verifier checks referenced bytes and rejects changed files", async () => {
	const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "proof-demonstration-artifacts-"))
	try {
		const campaignId = "campaign-artifact-check"
		const armId = "self-hosted"
		const attemptId = "attempt-confirmation-1"
		const commit = "a".repeat(40)
		const stdout = Buffer.from("verified output\n")
		const stderr = Buffer.from("\u0000binary\u00ff\n", "latin1")
		const refs = { stdout: sha256(stdout), stderr: sha256(stderr) }
		const attempt = { attemptId, harnessCommit: commit, artifactRefs: refs } as BenchmarkAttempt
		const row = {
			broker_job_id: attemptId, arm_id: armId, status: "completed", result_sha256: sha256(JSON.stringify(attempt)),
			candidate_id: "g0-candidate-0", attempt_kind: "confirmation",
			artifact_refs: { stdout: { sha256: refs.stdout }, stderr: { sha256: refs.stderr } },
		}
		const outputRoot = path.join(archiveDir, "confirmation", campaignId, armId, "g0-candidate-0", "confirmation", "harness", commit, "artifacts", "sha256")
		for (const [name, bytes] of [["stdout", stdout], ["stderr", stderr]] as const) {
			const digest = refs[name]
			const file = path.join(outputRoot, digest.slice(0, 2), digest)
			await fs.mkdir(path.dirname(file), { recursive: true })
			await fs.writeFile(file, bytes)
		}
		const run = {
			runId: "run-artifact-check", startedAt: new Date(0).toISOString(), model: "test/model", baseRef: "main", baseCommit: "b".repeat(40), generations: 1, candidates: [], reports: [],
			proofCampaign: { campaignId, armId, manifest: {}, manifestSha256: "c".repeat(64), epoch: 1, state: "finished", ledgerSnapshot: { attempts: [row] } },
			proofConfirmation: { selectedHarness: { attemptIds: [attemptId] }, rootHarness: { attemptIds: [] } },
			confirmationAttempts: [attempt],
		} as unknown as RsiRunRecord
		await verifyProofDemonstrationArtifactBytes([run], archiveDir)
		await fs.writeFile(path.join(outputRoot, refs.stdout.slice(0, 2), refs.stdout), "changed\n")
		await assert.rejects(() => verifyProofDemonstrationArtifactBytes([run], archiveDir), /missing or changed/)
	} finally {
		await fs.rm(archiveDir, { recursive: true, force: true })
	}
})
