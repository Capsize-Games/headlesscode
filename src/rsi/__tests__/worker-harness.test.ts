import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHeadlessExecutor } from "../../tools/executor.js"
import type { RsiConfig } from "../types.js"
import { effectiveWorkerHarnessMode, validWorkerHarnessRuntimeIdentity, workerHarnessCliPath, workerHarnessConfigDigest } from "../worker-harness.js"
import { workerHarnessSentinelDiff } from "../worker-harness-sentinel.js"

const config: RsiConfig = {
	repoRoot: "/repo",
	model: "pinned-model",
	population: 2,
	generations: 2,
	maxConcurrent: 1,
	mutationTask: "same registered task",
	regressionCommand: "npm test",
	evalCommands: ["npm run typecheck"],
	hiddenEvalCommands: [],
	archiveDir: "/archive",
	worktreeDir: "/worktrees",
	baseRef: "main",
	seed: "paired-seed",
	dryRun: false,
	keepWorktrees: true,
	maxIterations: 4,
	maxTokens: 256,
	protectedPaths: ["src/rsi/", "tests/"],
	commandTimeoutMs: 60_000,
}

const identity = {
	baseCommit: "a".repeat(40),
	model: "pinned-model",
	provider: "openshell-openrouter",
	proofProtocolDigest: "b".repeat(64),
}

function testGenerationZeroIsPinnedAndLaterSelfHostedModeUsesSelectedSource(): void {
	assert.equal(effectiveWorkerHarnessMode("fixed-control", 0), "fixed-control")
	assert.equal(effectiveWorkerHarnessMode("fixed-control", 2), "fixed-control")
	assert.equal(effectiveWorkerHarnessMode("self-hosted", 0), "fixed-control")
	assert.equal(effectiveWorkerHarnessMode("self-hosted", 2), "self-hosted")
	assert.equal(workerHarnessCliPath("fixed-control"), "/opt/headlesscode/src/cli.ts")
	assert.equal(workerHarnessCliPath("self-hosted"), "/workspace/src/cli.ts")
}

function testPairedArmDigestIgnoresOnlyTheHarnessArm(): void {
	const fixed = workerHarnessConfigDigest({ ...config, workerHarnessMode: "fixed-control", workerHarnessPairId: "pair-a" }, identity)
	const selfHosted = workerHarnessConfigDigest({ ...config, workerHarnessMode: "self-hosted", workerHarnessPairId: "pair-a" }, identity)
	assert.equal(fixed, selfHosted)
	const differingSettings: Array<Partial<RsiConfig>> = [
		{ mutationTask: "different task" },
		{ seed: "different seed" },
		{ generations: 3 },
		{ maxTokens: 512 },
		{ commandTimeoutMs: 60_001 },
		{ parentSelectionPolicy: "all-eligible" },
		{ eliteCount: 3 },
		{ specialistCount: 2 },
		{ noveltyRate: 0.25 },
		{ maxTrajectories: 4 },
		{ maxTotalIterations: 13 },
		{ maxRuntimeMs: 90_000 },
		{ roles: { worker: { provider: "openrouter", model: "pinned-model" }, critic: { provider: "ollama", model: "critic-v2" } } },
		{ modelCandidateId: "different-model-candidate" },
		{ modelCandidates: [{ id: "model-alt", parentModel: "pinned-model", trainingMethod: "none", trainingConfig: { method: "none" }, status: "base", createdAt: "now" }] },
	]
	for (const settings of differingSettings) {
		assert.notEqual(workerHarnessConfigDigest({ ...config, ...settings }, identity), fixed, `paired config digest must bind ${Object.keys(settings).join(",")}`)
	}
	const defaulted = workerHarnessConfigDigest(config, identity)
	const explicitDefaults = workerHarnessConfigDigest({
		...config,
		roles: { worker: { provider: "openrouter", model: identity.model } },
		parentSelectionPolicy: "champion-specialist-novelty",
		maxTrajectories: config.population + 1,
		maxTotalIterations: (config.population + 1) * config.maxIterations,
		maxRuntimeMs: 60 * 60_000,
		modelCandidateId: "model-base",
		modelCandidates: [],
	}, identity)
	assert.equal(defaulted, explicitDefaults, "omitted and explicitly supplied effective defaults must have the same paired digest")
	const sameRolesDifferentInsertionOrder = workerHarnessConfigDigest({
		...config,
		roles: { critic: { provider: "ollama", model: "critic" }, worker: { provider: "openrouter", model: identity.model } },
	}, identity)
	const canonicalRoleOrder = workerHarnessConfigDigest({
		...config,
		roles: { worker: { provider: "openrouter", model: identity.model }, critic: { provider: "ollama", model: "critic" } },
	}, identity)
	assert.equal(sameRolesDifferentInsertionOrder, canonicalRoleOrder, "role map insertion order must not change the frozen digest")
	assert.notEqual(workerHarnessConfigDigest(config, { ...identity, model: "different-model" }), fixed)
	assert.notEqual(workerHarnessConfigDigest(config, { ...identity, proofProtocolDigest: "c".repeat(64) }), fixed)
}

function testRuntimeIdentityRequiresPinnedImageCommitAndLock(): void {
	assert.equal(validWorkerHarnessRuntimeIdentity({
		imageName: "headlesscode-openshell-rsi:release",
		imageDigest: `sha256:${"d".repeat(64)}`,
		harnessCommit: "e".repeat(40),
		dependencyLockDigest: "f".repeat(64),
	}), true)
	assert.equal(validWorkerHarnessRuntimeIdentity({
		imageName: "headlesscode-openshell-rsi:release",
		imageDigest: "mutable-tag",
		harnessCommit: "e".repeat(40),
		dependencyLockDigest: "f".repeat(64),
	}), false)
}

async function testSentinelDiffEditsOnlyTheCodeModePromptReturn(): Promise<void> {
	const source = await fs.readFile(path.resolve("src/engine/prompt.ts"), "utf8")
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-harness-sentinel-test-"))
	try {
		await fs.writeFile(path.join(workspace, "prompt.ts"), source)
		const executor = createHeadlessExecutor(workspace)
		const marker = "RSI_SELF_HOSTED_SENTINEL_TEST"
		const result = await executor.execute("apply_diff", { path: "prompt.ts", diff: workerHarnessSentinelDiff(marker) })
		assert.equal(result.isError, false, `sentinel diff should apply: ${result.content}`)
		const changed = await fs.readFile(path.join(workspace, "prompt.ts"), "utf8")
		assert.equal(changed.split(marker).length - 1, 1, "the marker should appear once in the intended prompt function")
		assert.equal(changed.split("return { prompt: fullPromptWithSentinel, modeConfig, customModes }").length - 1, 1)
	assert.equal(changed.split("return { prompt: fullPrompt, modeConfig, customModes }").length - 1, 1, "the separate lean-prompt implementation should remain unchanged")
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
	}
}

testGenerationZeroIsPinnedAndLaterSelfHostedModeUsesSelectedSource()
testPairedArmDigestIgnoresOnlyTheHarnessArm()
testRuntimeIdentityRequiresPinnedImageCommitAndLock()
await testSentinelDiffEditsOnlyTheCodeModePromptReturn()
console.log("All 4 RSI worker harness tests passed")
