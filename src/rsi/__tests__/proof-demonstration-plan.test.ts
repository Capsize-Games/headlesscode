import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { assertFrozenProofDemonstrationPlanMatches, planProofDemonstration } from "../proof-demonstration-plan.js"
import type { BenchmarkManifest } from "../benchmark/types.js"
import type { RsiConfig } from "../types.js"
import type { ProofRoleLimits } from "../proof-demonstration-plan.js"

const manifest = {
	schemaVersion: 1, runnerVersion: "test", createdFromCommit: "a".repeat(40), tasks: [
		{ id: "dev-a", family: "a", split: "development", task: "dev a", startDigest: "b".repeat(64), verifierPath: "v", verifierDigest: "c".repeat(64), seed: 1, ceilings: { timeoutMs: 100, maxCalls: 2, maxOutputTokensPerCall: 100, maxPatchBytes: 1000 } },
		{ id: "dev-b", family: "b", split: "development", task: "dev b", startDigest: "d".repeat(64), verifierPath: "v", verifierDigest: "e".repeat(64), seed: 2, ceilings: { timeoutMs: 100, maxCalls: 2, maxOutputTokensPerCall: 100, maxPatchBytes: 1000 } },
		{ id: "confirm-a", family: "c", split: "confirmation", task: "confirm a", startDigest: "f".repeat(64), verifierPath: "v", verifierDigest: "1".repeat(64), seed: 3, ceilings: { timeoutMs: 200, maxCalls: 3, maxOutputTokensPerCall: 100, maxPatchBytes: 1000 } },
	],
} as unknown as BenchmarkManifest
const config = {
	population: 2, evalCommands: [], commandTimeoutMs: 100, maxIterations: 4,
} as unknown as RsiConfig
const limits = (campaignId: string): ProofRoleLimits => ({
	campaignId, maxCalls: 4, maxInputTokensPerCall: 1000, maxOutputTokensPerCall: 100,
	maxTotalTokens: 16_000, maxDurationMs: 10_000, maxRequestBytes: 100_000, maxResponseBytes: 100_000,
	maxInputPricePerMillionUsd: 0.1, maxOutputPricePerMillionUsd: 0.2,
	maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.2, maxCampaignSpendUsd: 100,
})
const plan = planProofDemonstration({ config, manifest, mutationLimits: limits("mutation"), benchmarkLimits: limits("benchmark") })
assert.deepEqual({ mutation: plan.engineering.mutationJobs, verification: plan.engineering.verificationJobs, dev: plan.engineering.developmentProofCells, confirmationSchedule: plan.engineering.confirmationScheduleCells }, { mutation: 8, verification: 16, dev: 48, confirmationSchedule: 0 })
assert.deepEqual({ candidateConfirm: plan.campaign.confirmationScheduleCells, notSelected: plan.campaign.confirmationNotSelectedCells, final: plan.campaign.paidConfirmationCells, root: plan.campaign.rootControlCells }, { candidateConfirm: 14, notSelected: 10, final: 2, root: 2 })
assert.equal(plan.engineering.maximumCalls, 128)
assert.equal(plan.campaign.maximumCalls, 204)
assert.equal(plan.totalReservedSpendUsd, plan.engineering.reservedSpendUsd + 3 * plan.campaign.reservedSpendUsd)
assert.equal(plan.totalCalls, plan.engineering.maximumCalls + 3 * plan.campaign.maximumCalls)
assert.throws(() => planProofDemonstration({ config, manifest, mutationLimits: { ...limits("mutation"), maxCallSpendUsd: 0.00001 }, benchmarkLimits: limits("benchmark") }), /per-call spend cap is below/)
assert.doesNotThrow(() => assertFrozenProofDemonstrationPlanMatches(plan, { config, manifest, mutationLimits: limits("mutation"), benchmarkLimits: limits("benchmark") }))
assert.throws(() => assertFrozenProofDemonstrationPlanMatches({ ...plan, campaignRootsSpendCeilingUsd: 0.000001, totalRootSpendCeilingUsd: 0.000001 }, { config, manifest, mutationLimits: limits("mutation"), benchmarkLimits: limits("benchmark") }), /frozen proof budget plan differs/)
assert.throws(() => assertFrozenProofDemonstrationPlanMatches(plan, { config: { ...config, evalCommands: ["npm test"] }, manifest, mutationLimits: limits("mutation"), benchmarkLimits: limits("benchmark") }), /frozen proof budget plan differs/)

const corpus = JSON.parse(await readFile("fixtures/rsi-benchmark/manifest.json", "utf8")) as BenchmarkManifest
const corpusConfig = { ...config, generations: 3, maxIterations: 40, commandTimeoutMs: 900_000, evalCommands: ["npm test"], maxRuntimeMs: 72 * 60 * 60_000 }
const corpusMutationLimits = { ...limits("mutation"), maxCalls: 40, maxInputTokensPerCall: 16_000, maxOutputTokensPerCall: 4096, maxTotalTokens: 160_768, maxInputPricePerMillionUsd: 0.05, maxOutputPricePerMillionUsd: 0.16, maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.04 }
const corpusBenchmarkLimits = { ...corpusMutationLimits, campaignId: "benchmark", maxCalls: 8, maxOutputTokensPerCall: 4096 }
const corpusPlan = planProofDemonstration({ config: corpusConfig, manifest: corpus, mutationLimits: corpusMutationLimits, benchmarkLimits: corpusBenchmarkLimits })
assert.equal(corpusPlan.engineering.developmentProofCells, 384)
assert.equal(corpusPlan.engineering.confirmationDisposition, "not-frozen-until-engineering-passes")
assert.equal(corpusPlan.engineering.paidConfirmationCells, 0)
assert.equal(corpusPlan.engineering.deferredConfirmationReservationCells, 0)
assert.equal(corpusPlan.campaign.developmentProofCells, 576)
assert.equal(corpusPlan.campaign.confirmationScheduleCells, 224)
assert.equal(corpusPlan.campaign.confirmationNotSelectedCells, 160)
assert.equal(corpusPlan.campaign.paidConfirmationCells, 32)
assert.equal(corpusPlan.campaign.rootControlCells, 32)
assert.equal(corpusPlan.campaign.maximumCalls, 19_680)
assert.equal(corpusPlan.totalCalls, 70_880)
assert.equal(corpusPlan.totalReservedSpendUsd, 93.92)
assert.equal(corpusPlan.totalRootSpendCeilingUsd, 93.92, "engineering root cap is reported separately from the three campaign roots")
console.log("RSI proof demonstration schedule and ceiling assertions passed")
