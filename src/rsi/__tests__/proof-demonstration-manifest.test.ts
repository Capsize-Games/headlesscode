import assert from "node:assert/strict"
import { test } from "node:test"
import { freezeProofDemonstrationManifest, frozenProofConfigDigest, verifyFrozenProofDemonstrationManifest } from "../proof-demonstration-manifest.js"
import type { ProofDemonstrationPlan } from "../proof-demonstration-plan.js"
import type { RsiConfig, WorkerHarnessRuntimeIdentity } from "../types.js"

const config = { repoRoot: "/work", seed: "eng-seed", protectedPaths: ["src/rsi/"], mutationTask: "fixed objective", evaluatorTrustedKeySha256: `sha256:${"9".repeat(64)}` } as RsiConfig
const plan = { totalRootSpendCeilingUsd: 9, engineeringRootSpendCeilingUsd: 1, campaignRootsSpendCeilingUsd: 8, totalCalls: 10, totalTokens: 100, totalTaskWallMs: 1000 } as ProofDemonstrationPlan
const runtime: WorkerHarnessRuntimeIdentity = { imageName: "headlesscode-openshell-rsi:release", imageDigest: `sha256:${"a".repeat(64)}`, harnessCommit: "b".repeat(40), dependencyLockDigest: "c".repeat(64) }
const limits = { campaignId: "plan-test", maxCalls: 2, maxInputTokensPerCall: 100, maxOutputTokensPerCall: 50, maxTotalTokens: 300, maxDurationMs: 1000, maxRequestBytes: 1000, maxResponseBytes: 1000, maxInputPricePerMillionUsd: 0.2, maxOutputPricePerMillionUsd: 0.3, maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.02, maxCampaignSpendUsd: 1 }
const taskIdentities = ["development", "confirmation"].map((split, index) => ({ id: index === 0 ? "task-one" : "qa-baseline-counts", split, family: "engine", seed: index + 1, startDigest: "d".repeat(64), verifierDigest: "e".repeat(64), knownGoodDigest: "f".repeat(64), knownBadDigest: "1".repeat(64), ceilings: { timeoutMs: 1000, maxCalls: 3, maxOutputTokensPerCall: 100, maxPatchBytes: 1000 } }))

function frozen(operatorCapUsd = 9, priceCeilingsPerMillionUsd = { input: 0.2, output: 0.3 }) {
	return freezeProofDemonstrationManifest({
		createdAt: "2026-09-30T00:00:00.000Z", rootCommit: "2".repeat(40), benchmarkManifestSha256: "3".repeat(64),
		model: { provider: "openshell-openrouter", requestedId: "deepseek/deepseek-v4-flash-0731", sampling: { temperature: 0, think: false, seed: "provider-default" } },
		endpointPrice: { model: "deepseek/deepseek-v4-flash-0731", provider: "deepinfra", endpointTag: "deepinfra/fp8", quantization: "fp8", supportedParameters: ["max_tokens", "temperature", "tools", "tool_choice"], inputPricePerMillionUsd: 0.1, outputPricePerMillionUsd: 0.2, observedAt: "2026-09-30T00:00:00.000Z", responseSha256: "4".repeat(64) },
		priceCeilingsPerMillionUsd: priceCeilingsPerMillionUsd, runtime,
		execution: { configs: [config, config, config, config], configSha256: frozenProofConfigDigest([config, config, config, config]), analysisSourceSha256: "5".repeat(64), inferenceLimits: { mutation: limits, benchmark: limits }, taskIdentities },
		seeds: { engineering: "eng-seed", campaigns: ["campaign-a", "campaign-b", "campaign-c"] },
		campaignIds: { engineering: "eng-id", campaigns: ["a-id", "b-id", "c-id"] }, operatorCapUsd, plan,
		engineeringEvidence: { path: "/work/.headlesscode/rsi-proof/engineering.json", sha256: "6".repeat(64), campaignId: "eng-id", rootCommit: "2".repeat(40), manifestSha256: "7".repeat(64), snapshotSha256: "8".repeat(64) },
		analysis: { bootstrapSeed: "cluster-seed-1", bootstrapReplicates: 1000, confirmationRetentionTaskIds: ["qa-baseline-counts"] },
	})
}

test("frozen demonstration manifest verifies exact config, schedule, endpoint price and separate runtime identity", () => {
	const body = frozen()
	assert.equal(verifyFrozenProofDemonstrationManifest(body).runtime.harnessCommit, runtime.harnessCommit)
	assert.equal(body.rootCommit, "2".repeat(40))
	const changed = structuredClone(body)
	changed.execution.configs[2]!.mutationTask = "changed prompt"
	assert.throws(() => verifyFrozenProofDemonstrationManifest(changed), /manifest digest mismatch/)
})

test("frozen plan rejects a cap below reservations and price ceilings below observed endpoint rates", () => {
	assert.throws(() => frozen(7), /below the three frozen campaign roots reservation/)
	assert.throws(() => frozen(9, { input: 0.01, output: 0.01 }), /price ceilings do not cover/)
})

test("frozen plan pins one evaluator key without publishing operator key paths", () => {
	const valid = frozen()
	assert.equal(valid.execution.configs[0]!.evaluatorTrustedKeySha256, config.evaluatorTrustedKeySha256)
	assert.equal("evaluatorSigningKeyPath" in valid.execution.configs[0]!, false)
	assert.equal("evaluatorTrustedPublicKeyPath" in valid.execution.configs[0]!, false)
	const { schemaVersion: _schemaVersion, digestSha256: _digestSha256, ...body } = valid
	const configs = valid.execution.configs.map((entry) => ({ ...entry, evaluatorSigningKeyPath: "/private/operator/key.pem" })) as unknown as typeof valid.execution.configs
	assert.throws(() => freezeProofDemonstrationManifest({ ...body, execution: { ...valid.execution, configs, configSha256: frozenProofConfigDigest(configs) } }), /must not freeze evaluator key paths/)
})
