import assert from "node:assert/strict"
import { test } from "node:test"
import { freezeProofDemonstrationManifest, frozenProofConfigDigest, frozenProofDemonstrationDigest, verifyFrozenProofDemonstrationManifest } from "../proof-demonstration-manifest.js"
import type { ProofDemonstrationPlan } from "../proof-demonstration-plan.js"
import type { RsiConfig, WorkerHarnessRuntimeIdentity } from "../types.js"
import { RSI_MUSE_OPENROUTER_MODEL } from "../inference-broker.js"

const benchmarkFixtures = { root: "/work/benchmark-fixtures", manifestSha256: "3".repeat(64), snapshotPackage: { path: "snapshots", digest: "a".repeat(64) } }
const config = { repoRoot: "/work", seed: "eng-seed", protectedPaths: ["src/rsi/"], mutationTask: "fixed objective", evaluatorTrustedKeySha256: `sha256:${"9".repeat(64)}`, proofBenchmarkFixtures: benchmarkFixtures } as RsiConfig
const plan = { totalRootSpendCeilingUsd: 9, engineeringRootSpendCeilingUsd: 1, campaignRootsSpendCeilingUsd: 8, totalCalls: 10, totalTokens: 100, totalTaskWallMs: 1000 } as ProofDemonstrationPlan
const runtime: WorkerHarnessRuntimeIdentity = { imageName: "headlesscode-openshell-rsi:release", imageDigest: `sha256:${"a".repeat(64)}`, harnessCommit: "b".repeat(40), dependencyLockDigest: "c".repeat(64) }
const limits = { campaignId: "plan-test", maxCalls: 2, maxInputTokensPerCall: 100, maxOutputTokensPerCall: 50, maxTotalTokens: 300, maxDurationMs: 1000, maxRequestBytes: 1000, maxResponseBytes: 1000, maxInputPricePerMillionUsd: 0.2, maxOutputPricePerMillionUsd: 0.3, maxCallSpendUsd: 0.01, maxJobSpendUsd: 0.02, maxCampaignSpendUsd: 1 }
const taskIdentities = ["development", "confirmation"].map((split, index) => ({ id: index === 0 ? "task-one" : "qa-baseline-counts", split, family: "engine", seed: index + 1, startDigest: "d".repeat(64), verifierDigest: "e".repeat(64), knownGoodDigest: "f".repeat(64), knownBadDigest: "1".repeat(64), ceilings: { timeoutMs: 1000, maxCalls: 3, maxOutputTokensPerCall: 100, maxPatchBytes: 1000 } }))

function frozen(profileId?: "muse-spark-contributor", operatorCapUsd = 9, priceCeilingsPerMillionUsd = { input: 0.2, output: 0.3 }, endpointProvider = profileId ? "meta" : "deepinfra") {
	const requestedId = profileId ? RSI_MUSE_OPENROUTER_MODEL : "deepseek/deepseek-v4-flash-0731"
	return freezeProofDemonstrationManifest({
		createdAt: "2026-09-30T00:00:00.000Z", rootCommit: "2".repeat(40), benchmarkFixtures, benchmarkManifestSha256: "3".repeat(64),
		model: { provider: "openshell-openrouter", requestedId, ...(profileId ? { profileId } : {}), sampling: { temperature: 0, think: false, seed: "provider-default" } },
		endpointPrice: { model: requestedId, provider: endpointProvider, endpointTag: profileId ? "meta" : "deepinfra/fp8", quantization: profileId ? "unknown" : "fp8", supportedParameters: ["max_tokens", "temperature", "tools", "tool_choice"], inputPricePerMillionUsd: 0.1, outputPricePerMillionUsd: 0.2, observedAt: "2026-09-30T00:00:00.000Z", responseSha256: "4".repeat(64) },
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
	assert.deepEqual(body.execution.configs.map((entry) => entry.proofBenchmarkFixtures), [body.benchmarkFixtures, body.benchmarkFixtures, body.benchmarkFixtures, body.benchmarkFixtures], "preview fixture identity flows unchanged into every execution config")
	assert.equal(Object.hasOwn(body.model, "profileId"), false, "legacy DeepSeek manifest serialization keeps its historical model shape")
	const changed = structuredClone(body)
	changed.execution.configs[2]!.mutationTask = "changed prompt"
	assert.throws(() => verifyFrozenProofDemonstrationManifest(changed), /manifest digest mismatch/)
})

test("frozen proof manifest rejects fixture root, manifest, package, or cross-config binding changes", () => {
	const valid = frozen()
	const changedRoot = structuredClone(valid)
	changedRoot.benchmarkFixtures!.root = "/work/other-fixtures"
	assert.throws(() => verifyFrozenProofDemonstrationManifest(changedRoot), /manifest digest mismatch/)
	const changedManifest = structuredClone(valid)
	changedManifest.benchmarkFixtures!.manifestSha256 = "b".repeat(64)
	assert.throws(() => verifyFrozenProofDemonstrationManifest(changedManifest), /manifest digest mismatch/)
	const { schemaVersion: _schemaVersion, digestSha256: _digestSha256, ...body } = valid
	const mismatchedConfigs = valid.execution.configs.map((entry, index) => index === 3 ? { ...entry, proofBenchmarkFixtures: { ...valid.benchmarkFixtures!, snapshotPackage: { path: "snapshots", digest: "c".repeat(64) } } } : entry) as unknown as typeof valid.execution.configs
	assert.throws(() => freezeProofDemonstrationManifest({ ...body, execution: { ...valid.execution, configs: mismatchedConfigs, configSha256: frozenProofConfigDigest(mismatchedConfigs) } }), /do not share the frozen benchmark fixture binding/)
	assert.throws(() => freezeProofDemonstrationManifest({ ...body, benchmarkFixtures: { ...valid.benchmarkFixtures!, snapshotPackage: { path: "snapshots", digest: "c".repeat(64) } } }), /snapshot package|manifest binding|do not share/)
})

test("older frozen manifests without an external fixture binding retain default-root compatibility", () => {
	const valid = frozen()
	const configs = valid.execution.configs.map(({ proofBenchmarkFixtures: _binding, ...entry }) => entry) as unknown as typeof valid.execution.configs
	const { schemaVersion: _schemaVersion, digestSha256: _digestSha256, benchmarkFixtures: _binding, ...body } = valid
	const compatible = freezeProofDemonstrationManifest({ ...body, execution: { ...valid.execution, configs, configSha256: frozenProofConfigDigest(configs) } })
	assert.equal(compatible.benchmarkFixtures, undefined)
	assert.doesNotThrow(() => verifyFrozenProofDemonstrationManifest(compatible))
})

test("frozen plan rejects a cap below reservations and price ceilings below observed endpoint rates", () => {
	assert.throws(() => frozen(undefined, 7), /below the three frozen campaign roots reservation/)
	assert.throws(() => frozen(undefined, 9, { input: 0.01, output: 0.01 }), /price ceilings do not cover/)
})

test("Muse Contributor proof plans bind the admitted Meta profile and endpoint without changing DeepSeek defaults", () => {
	const muse = frozen("muse-spark-contributor")
	const verified = verifyFrozenProofDemonstrationManifest(muse)
	assert.equal(verified.model.requestedId, RSI_MUSE_OPENROUTER_MODEL)
	assert.equal(verified.model.profileId, "muse-spark-contributor")
	assert.equal(verified.endpointPrice.provider, "meta")
	assert.equal(verified.endpointPrice.endpointTag, "meta")
	assert.throws(() => frozen("muse-spark-contributor", 9, { input: 0.2, output: 0.3 }, "deepinfra"), /endpoint price identity/)
	assert.throws(() => {
		const value = structuredClone(muse)
		delete value.model.profileId
		const { digestSha256: _digest, ...body } = value
		return verifyFrozenProofDemonstrationManifest({ ...body, digestSha256: frozenProofDemonstrationDigest(body) })
	}, /profile identity must be explicit/)
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
