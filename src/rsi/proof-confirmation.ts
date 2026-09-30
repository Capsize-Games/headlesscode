import { createHash } from "node:crypto"
import * as path from "node:path"
import type { RsiConfig, RsiRunRecord } from "./types.js"
import type { BenchmarkAttempt, BenchmarkManifest } from "./benchmark/types.js"
import { openRouterAllocatedEnvironment, openRouterBrokerLimitsFromEnvironment } from "./inference-broker.js"
import { runDevelopmentBenchmarkForCommit } from "./development-benchmark.js"
import type { PostgresProofCampaign, ProofCampaignArmLease, ProofCampaignManifest } from "./proof-campaign.js"

function candidateSlot(generation: number, index: number): string { return "g" + generation + "-candidate-" + index }

/** Execute only the preselected final harness and root-control confirmation cells under the PG campaign lease. */
export async function runProofConfirmation(args: {
	run: RsiRunRecord
	config: RsiConfig
	manifest: ProofCampaignManifest
	benchmark: BenchmarkManifest
	fixturesRoot: string
	store: PostgresProofCampaign
	lease: ProofCampaignArmLease
	assertLease: () => Promise<void>
	model: string
	provider: "openshell-openrouter"
}): Promise<{ attempts: BenchmarkAttempt[]; selectedCandidateId: string; selectedGeneration: number; selectedCommit: string; selectedHarnessCandidate: string; selectedAttempts: BenchmarkAttempt[]; rootAttempts: BenchmarkAttempt[] }> {
	if (args.lease.phase !== "confirmation") throw new Error("confirmation requires a confirmation-phase campaign lease")
	const tasks = args.benchmark.tasks.filter((task) => task.split === "confirmation")
	if (!tasks.length) throw new Error("frozen benchmark manifest has no confirmation tasks")
	const candidate = args.run.selected ? args.run.candidates.find((entry) => entry.id === args.run.selected && entry.status === "accepted" && entry.developmentProof?.accepted === true) : undefined
	const candidatesAtGeneration = candidate ? args.run.candidates.filter((entry) => entry.generation === candidate.generation) : []
	const candidateIndex = candidate ? candidatesAtGeneration.indexOf(candidate) : -1
	const selectedCandidateId = candidate && candidateIndex >= 0 ? candidateSlot(candidate.generation, candidateIndex) : "root-control"
	const selectedGeneration = candidate?.generation ?? Math.max(...args.manifest.schedule.filter((cell) => cell.armId === args.lease.armId && cell.phase === "confirmation").map((cell) => cell.generation))
	const selectedCommit = candidate?.commits[0] ?? args.run.baseCommit
	await args.store.selectFinalHarness(args.lease, { generation: selectedGeneration, candidateId: selectedCandidateId, commit: selectedCommit })
	for (const cell of args.manifest.schedule.filter((entry) => entry.armId === args.lease.armId && entry.phase === "confirmation" && entry.attemptKind === "confirmation")) {
		if (cell.candidateId === selectedCandidateId && cell.generation === selectedGeneration) continue
		await args.store.markNotSelected(args.lease, {
			attemptKey: "not-selected:" + args.lease.armId + ":" + cell.candidateId + ":" + cell.taskId,
			generation: cell.generation, candidateId: cell.candidateId, taskId: cell.taskId, seed: cell.seed,
			reason: "candidate is not the final selected harness for this campaign arm",
		})
	}
	const attempts: BenchmarkAttempt[] = []
	const campaignId = args.lease.campaignId + ":benchmark"
	const ledgerPath = path.join(args.config.archiveDir, "development-proof", args.lease.campaignId, "benchmark-openrouter-inference-ledger.json")
	const runHarness = async (candidateId: string, generation: number, commit: string, kind: "confirmation" | "fixed-control", sourceCandidateId: string): Promise<BenchmarkAttempt[]> => {
		await args.assertLease()
		const outputRoot = path.join(args.config.archiveDir, "confirmation", args.lease.campaignId, args.lease.armId, candidateId, kind)
		const result = await runDevelopmentBenchmarkForCommit({
			repoRoot: args.config.repoRoot, fixturesRoot: args.fixturesRoot, outputRoot, harnessCommit: commit, model: args.model,
			provider: args.provider, campaignId, inferenceLedgerPath: ledgerPath,
			attemptNamespace: args.lease.armId + ":confirmation:" + candidateId, split: "confirmation",
			attemptLifecycle: {
				beforeAttempt: async ({ task, attemptId, campaignId: requestCampaign, agentImage, model, sampling }) => {
					await args.assertLease()
					const remaining = Math.max(1, Date.parse(args.lease.deadlineAt) - Date.now())
					const limits = openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(process.env, "benchmark"), campaignId, { maxCalls: task.ceilings.maxCalls, maxOutputTokensPerCall: task.ceilings.maxOutputTokensPerCall, maxDurationMs: Math.max(1, Math.min(task.ceilings.timeoutMs, remaining)) })
					const request = { phase: "confirmation", taskId: task.id, attemptId, campaignId: requestCampaign, candidateId, kind, sourceCandidateId, harnessCommit: commit, agentImage, model, sampling, seed: task.seed, startDigest: task.startDigest, verifierDigest: task.verifierDigest, ceilings: task.ceilings }
					const requestSha256 = createHash("sha256").update(JSON.stringify(request)).digest("hex")
					const attemptKey = "confirmation:" + args.lease.armId + ":" + candidateId + ":" + attemptId
					const admitted = await args.store.admit(args.lease, { attemptKey, brokerJobId: attemptId, kind, identity: { generation, candidateId, taskId: task.id, seed: String(task.seed), attemptKind: kind }, sourceCandidateId, requestSha256, calls: limits.maxCalls, tokens: limits.maxTotalTokens, spendUsd: limits.maxJobSpendUsd })
					if (admitted.status !== "admitted") throw new Error("confirmation cell is already dispatched or settled without a verified artifact; refusing duplicate provider call")
					await args.store.markDispatched(args.lease, attemptKey)
					return requestSha256
				},
				settledAttempt: async ({ attempt }) => {
					if (!attempt.proofRequestSha256) throw new Error("confirmation attempt is missing its campaign request digest")
					const limits = openRouterBrokerLimitsFromEnvironment(openRouterAllocatedEnvironment(process.env, "benchmark"), campaignId, { maxCalls: attempt.ceilings.maxCalls, maxOutputTokensPerCall: attempt.ceilings.maxOutputTokensPerCall, maxDurationMs: Math.max(1, Math.min(attempt.ceilings.timeoutMs, Date.parse(args.lease.deadlineAt) - Date.now())) })
					const attemptKey = "confirmation:" + args.lease.armId + ":" + candidateId + ":" + attempt.attemptId
					const admitted = await args.store.admit(args.lease, { attemptKey, brokerJobId: attempt.attemptId, kind, identity: { generation, candidateId, taskId: attempt.taskId, seed: String(attempt.seed), attemptKind: kind }, sourceCandidateId, requestSha256: attempt.proofRequestSha256, calls: limits.maxCalls, tokens: limits.maxTotalTokens, spendUsd: limits.maxJobSpendUsd })
					if (admitted.status === "admitted" || admitted.status === "dispatched") await args.store.markDispatched(args.lease, attemptKey)
					else if (admitted.status !== "completed") throw new Error("confirmation attempt cannot be reconciled under the current campaign epoch")
					const receipt = attempt.inferenceReceipt
					if (!receipt?.qualified) await args.store.settle(args.lease, attemptKey, { status: "uncertain", error: "confirmation broker receipt is missing or unqualified" })
					else await args.store.settle(args.lease, attemptKey, {
						status: "completed", resultSha256: createHash("sha256").update(JSON.stringify(attempt)).digest("hex"),
						artifactRefs: Object.fromEntries(Object.entries(attempt.artifactRefs).map(([key, value]) => [key, { sha256: value }])),
						actualCalls: receipt.calls, actualTokens: receipt.totalTokens ?? 0, actualSpendUsd: receipt.costUsd ?? 0,
					})
				},
			},
		})
		attempts.push(...result)
		return result
	}
	const selectedAttempts = candidate ? await runHarness(selectedCandidateId, selectedGeneration, selectedCommit, "confirmation", candidate.id) : []
	const rootGeneration = Math.max(...args.manifest.schedule.filter((cell) => cell.armId === args.lease.armId && cell.phase === "confirmation").map((cell) => cell.generation))
	const rootAttempts = await runHarness("root-control", rootGeneration, args.run.baseCommit, "fixed-control", "root-control")
	return { attempts, selectedCandidateId, selectedGeneration, selectedCommit, selectedHarnessCandidate: candidate?.id ?? "baseline", selectedAttempts: candidate ? selectedAttempts : rootAttempts, rootAttempts }
}
