import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import { appendRun } from "../archive.js"
import type { RsiConfig, RsiRunRecord, WorkerHarnessRuntimeIdentity } from "../types.js"
import { assertEngineeringTransition, assertProofWorkerProfile, configureProofVisibleEvaluations, isFullyConfirmedRun, parseProofDemonstrationArgs, proofConfigFromOptions, PROOF_VISIBLE_EVAL_COMMANDS, runEngineeringArm, runEngineeringArms, runFrozenCampaignArm, validateRuntimeEvaluatorIntegrity, writeEngineeringStopReport } from "../../../scripts/rsi-proof-demonstration.js"
import { frozenProofConfigDigest, type FrozenProofDemonstrationManifest } from "../proof-demonstration-manifest.js"
import { proofCampaignManifestDigest, type ProofCampaignManifest } from "../proof-campaign.js"
import { RSI_MUSE_OPENROUTER_MODEL, RSI_OPENROUTER_MODEL } from "../inference-broker.js"

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

test("proof engineering estimates need no evaluator keys; attested CLI options are parsed as protected paths and pin", () => {
	const estimate = parseProofDemonstrationArgs(["engineering", "--seed", "estimate-seed"])
	assert.equal(estimate.evaluatorSigningKeyPath, undefined, "inference-free estimates do not need dummy trust material")
	const production = parseProofDemonstrationArgs([
		"engineering", "--seed", "prod-seed", "--execute",
		"--evaluator-signing-key", "/operator/private/evaluator.pem",
		"--evaluator-trusted-public-key", "/operator/trust/evaluator.pub.pem",
		"--evaluator-trusted-key-sha256", `sha256:${"a".repeat(64)}`,
	])
	assert.equal(production.evaluatorSigningKeyPath, path.resolve("/operator/private/evaluator.pem"))
	assert.equal(production.evaluatorTrustedPublicKeyPath, path.resolve("/operator/trust/evaluator.pub.pem"))
	assert.equal(production.evaluatorTrustedKeySha256, `sha256:${"a".repeat(64)}`)
	assert.throws(() => parseProofDemonstrationArgs(["execute", "--plan", "/plan.json", "--execute", "--evaluator-trusted-key-sha256", `sha256:${"a".repeat(64)}`]), /requires --evaluator-signing-key/)
})

test("runtime trust forwarding verifies the pinned public key and rejects a changed pin locally", async () => {
	const root = await fs.mkdtemp(path.join("/var/tmp", "rsi-proof-runtime-trust-"))
	try {
		const keyPair = generateKeyPairSync("ed25519")
		const privatePath = path.join(root, "signing.pem")
		const publicPath = path.join(root, "trusted.pem")
		await fs.writeFile(privatePath, keyPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 })
		await fs.writeFile(publicPath, keyPair.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o600 })
		const pin = `sha256:${createHash("sha256").update(keyPair.publicKey.export({ format: "der", type: "spki" })).digest("hex")}`
		const config = { repoRoot: process.cwd(), archiveDir: path.join(process.cwd(), ".headlesscode", "scratch", "proof-trust-archive"), worktreeDir: path.join(process.cwd(), ".headlesscode", "scratch", "proof-trust-worktrees") } as RsiConfig
		const options = { evaluatorSigningKeyPath: privatePath, evaluatorTrustedPublicKeyPath: publicPath, evaluatorTrustedKeySha256: pin }
		const runtimeConfig = await validateRuntimeEvaluatorIntegrity(config, options)
		assert.equal(runtimeConfig.evaluatorTrustedKeySha256, pin)
		assert.equal(runtimeConfig.evaluatorSigningKeyPath, privatePath)
		await assert.rejects(() => validateRuntimeEvaluatorIntegrity(config, { ...options, evaluatorTrustedKeySha256: `sha256:${"0".repeat(64)}` }), /does not match its independently configured pin/)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("frozen campaign execution forwards key paths at runtime while its manifest contains only the pin", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-proof-trust-forwarding-"))
	try {
		const pin = `sha256:${"a".repeat(64)}`
		const config = { archiveDir: root, seed: "campaign-seed", evaluatorTrustedKeySha256: pin } as RsiConfig
		const runtime: WorkerHarnessRuntimeIdentity = { imageName: "image", imageDigest: `sha256:${"b".repeat(64)}`, harnessCommit: "c".repeat(40), dependencyLockDigest: "d".repeat(64) }
		const manifest = {
			campaignIds: { campaigns: [`rsi-proof-${"d".repeat(20)}`] },
			execution: { configs: [config, config, config, config] }, rootCommit: "e".repeat(40), runtime,
		} as unknown as FrozenProofDemonstrationManifest
		const trustPaths = { evaluatorSigningKeyPath: "/operator/private/signing.pem", evaluatorTrustedPublicKeyPath: "/operator/trust/public.pem", evaluatorTrustedKeySha256: pin }
		let received: RsiConfig | undefined
		await runFrozenCampaignArm(manifest, 0, "fixed-control", "development", async (runtimeConfig) => {
			received = runtimeConfig
			const run = { runId: runtimeConfig.workerHarnessRunId, candidates: [], reports: [] } as unknown as RsiRunRecord
			await appendRun(root, run)
			return run
		}, trustPaths)
		assert.equal(received?.evaluatorSigningKeyPath, trustPaths.evaluatorSigningKeyPath)
		assert.equal(received?.evaluatorTrustedPublicKeyPath, trustPaths.evaluatorTrustedPublicKeyPath)
		assert.equal(received?.evaluatorTrustedKeySha256, pin)
		assert.equal(config.evaluatorSigningKeyPath, undefined)
		assert.equal(config.evaluatorTrustedPublicKeyPath, undefined)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("proof CLI admits explicit Muse selection while keeping legacy DeepSeek as the default", () => {
	assert.equal(parseProofDemonstrationArgs(["estimate"]).openRouterProfile, undefined)
	assert.equal(parseProofDemonstrationArgs(["engineering", "--openrouter-profile", "muse-spark-contributor"]).openRouterProfile, "muse-spark-contributor")
	assert.throws(() => parseProofDemonstrationArgs(["plan", "--openrouter-profile", "unlisted-model"]), /profile is not admitted/)
	assert.throws(() => parseProofDemonstrationArgs(["execute", "--openrouter-profile", "muse-spark-contributor"]), /only valid for estimate, engineering, or plan/)
})

test("proof CLI parses a positive safe max-token limit and passes it into frozen mutation config", () => {
	const options = parseProofDemonstrationArgs(["engineering", "--seed", "token-seed", "--max-tokens", "7000"])
	assert.equal(options.maxTokens, 7000)
	const config = proofConfigFromOptions(options, "a".repeat(40))
	assert.equal(config.maxTokens, 7000)
	assert.equal(config.generations, 3, "the helper config supports all paired-run generations; engineering later freezes two")
	const defaultConfig = proofConfigFromOptions({ ...options, maxTokens: undefined }, "a".repeat(40))
	assert.notEqual(frozenProofConfigDigest([config]), frozenProofConfigDigest([defaultConfig]), "the frozen config digest binds maxTokens")
})

test("proof max-token option rejects invalid values and commands governed by a frozen plan", () => {
	for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992"]) {
		assert.throws(() => parseProofDemonstrationArgs(["engineering", "--seed", "token-seed", "--max-tokens", value]), /must be a positive integer/)
	}
	assert.throws(() => parseProofDemonstrationArgs(["engineering", "--seed", "token-seed", "--max-tokens"]), /requires a value/)
	assert.throws(() => parseProofDemonstrationArgs(["execute", "--plan", "/plan.json", "--max-tokens", "7000"]), /only valid for estimate, engineering, or plan/)
})

test("proof preview selects a nonempty visible test set outside withheld RSI sources", async () => {
	const parsed = parseProofDemonstrationArgs(["engineering", "--seed", "preview-seed"])
	const defaultConfig = (await import("../config.js")).parseRsiArgs(["--repo", process.cwd()]).config!
	assert.deepEqual(defaultConfig.evalCommands, ["npm test -- --filter rsi"])
	const previewConfig = configureProofVisibleEvaluations(defaultConfig)
	assert.equal(previewConfig.regressionCommand, "npm test", "retain the full regression command")
	assert.deepEqual(previewConfig.evalCommands, [...PROOF_VISIBLE_EVAL_COMMANDS])
	const visibleCommand = previewConfig.evalCommands[0]!
	assert.match(visibleCommand, /--filter engine/)
	const selected: string[] = []
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const target = path.join(directory, entry.name)
			if (entry.isDirectory()) await visit(target)
			else if (entry.isFile() && entry.name.endsWith(".test.ts") && path.relative(process.cwd(), target).includes("engine")) selected.push(path.relative(process.cwd(), target))
		}
	}
	await visit(path.join(process.cwd(), "src"))
	assert.ok(selected.length > 0, "the npm test runner's path filter finds visible test files")
	assert.ok(selected.includes("src/engine/__tests__/iteration-boundary.test.ts"), "the engine regression test is available to the evaluator snapshot")
	assert.ok(selected.every((file) => !file.startsWith("src/rsi/")), "selected tests do not require omitted protected RSI files")
	assert.equal(parsed.command, "engineering")
})

test("proof worker profile validation rejects environment role overrides before dispatch", () => {
	const muse = { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "muse-spark-contributor" } as const
	const config = { model: RSI_MUSE_OPENROUTER_MODEL, roles: { worker: muse } } as RsiConfig
	assert.doesNotThrow(() => assertProofWorkerProfile(config, { id: "muse-spark-contributor", model: RSI_MUSE_OPENROUTER_MODEL } as never, {}))
	assert.throws(() => assertProofWorkerProfile(config, { id: "muse-spark-contributor", model: RSI_MUSE_OPENROUTER_MODEL } as never, {
		HEADLESSCODE_RSI_ROLE_WORKER_PROVIDER: "openrouter",
		HEADLESSCODE_RSI_ROLE_WORKER_MODEL: RSI_OPENROUTER_MODEL,
		HEADLESSCODE_RSI_ROLE_WORKER_OPENROUTER_PROFILE: "deepseek-deepinfra-fp8",
	}), /must match frozen OpenRouter profile/)
	const legacy = { model: RSI_OPENROUTER_MODEL, roles: { worker: { provider: "openrouter", model: RSI_OPENROUTER_MODEL } } } as RsiConfig
	assert.doesNotThrow(() => assertProofWorkerProfile(legacy, { id: "deepseek-deepinfra-fp8", model: RSI_OPENROUTER_MODEL } as never, {}), "legacy DeepSeek profile remains implicit")
})

test("engineering launcher refuses a matched alternate profile environment before invoking the runner", async () => {
	const scratch = path.join(process.cwd(), ".headlesscode", "scratch")
	const archiveDir = path.join(scratch, "proof-profile-before-dispatch")
	const runtime: WorkerHarnessRuntimeIdentity = { imageName: "image", imageDigest: `sha256:${"b".repeat(64)}`, harnessCommit: "c".repeat(40), dependencyLockDigest: "d".repeat(64) }
	const config = { archiveDir, model: RSI_MUSE_OPENROUTER_MODEL, roles: { worker: { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "muse-spark-contributor" } } } as RsiConfig
	let dispatched = false
	await assert.rejects(() => runEngineeringArm(config, `rsi-proof-${"a".repeat(20)}`, "fixed-control", "e".repeat(40), "seed", runtime, async () => { dispatched = true; throw new Error("must fail before dispatch") }, {
		HEADLESSCODE_RSI_ROLE_WORKER_PROVIDER: "openrouter",
		HEADLESSCODE_RSI_ROLE_WORKER_MODEL: RSI_OPENROUTER_MODEL,
		HEADLESSCODE_RSI_ROLE_WORKER_OPENROUTER_PROFILE: "deepseek-deepinfra-fp8",
	}), /must match frozen OpenRouter profile/)
	assert.equal(dispatched, false)
})

test("incomplete engineering stops before the paired arm and writes a separate report with unresolved accounting", async () => {
	const scratch = path.join(process.cwd(), ".headlesscode", "scratch")
	await fs.mkdir(scratch, { recursive: true })
	const work = await fs.mkdtemp(path.join(scratch, "engineering-incomplete-stop-"))
	const output = path.join(process.cwd(), ".headlesscode", "rsi-proof", `engineering-${path.basename(work)}.json`)
	const stopPath = `${output}.stop.json`
	const reportPath = path.join(work, "run.md")
	const campaign = `rsi-proof-${"a".repeat(20)}`
	const rootCommit = "e".repeat(40)
	const runtime: WorkerHarnessRuntimeIdentity = { imageName: "image", imageDigest: `sha256:${"b".repeat(64)}`, harnessCommit: "c".repeat(40), dependencyLockDigest: "d".repeat(64) }
	const config = { archiveDir: work, model: RSI_MUSE_OPENROUTER_MODEL, maxTokens: 2048, roles: { worker: { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "muse-spark-contributor" } } } as RsiConfig
	const scheduleCell = { armId: "fixed-control", generation: 1, candidateId: "g1-candidate-0", taskId: "mutation", seed: "seed-0", attemptKind: "mutation" }
	const failureEvent = { arm_id: "fixed-control", event_type: "candidate-incomplete", payload: { generation: 1, candidateId: "g1-candidate-0", parentId: "g0-candidate-0", parentCommit: "f".repeat(40), outcome: "incomplete", reason: "unreconciled attempt", cells: [{ ...scheduleCell, attemptKey: "attempt-1", status: "uncertain", reservedCalls: 1, reservedTokens: 256, reservedSpendMicrousd: 1000, actualCalls: null, actualTokens: null, actualSpendMicrousd: null }] } }
	const run = {
		runId: "engineering-stop-run", baseCommit: rootCommit, workerHarnessPairId: campaign, workerHarnessMode: "fixed-control", finishedAt: new Date(0).toISOString(), reports: [reportPath], candidates: [],
		proofCampaign: { manifest: { phaseMode: "engineering-only", schedule: [scheduleCell] }, manifestSha256: "1".repeat(64), campaignId: campaign, armId: "fixed-control", epoch: 1, state: "incomplete", incompleteReason: "unresolved attempt", ledgerSnapshot: { campaign: { state: "running", reserved_calls: 1, used_calls: 0 }, attempts: [{ ...failureEvent.payload.cells[0], arm_id: "fixed-control" }], decisions: [], events: [failureEvent] } },
	} as unknown as RsiRunRecord
	try {
		await fs.mkdir(path.dirname(output), { recursive: true })
		await fs.writeFile(output, "previous-qualified-evidence\n", { flag: "wx" })
		let armsStarted: string[] = []
		const stopped = await runEngineeringArms(config, campaign, rootCommit, "seed-0", runtime, async (runtimeConfig) => {
			armsStarted.push(runtimeConfig.workerHarnessMode ?? "missing")
			return run
		})
		assert.equal(stopped.length, 1)
		assert.deepEqual(armsStarted, ["fixed-control"], "an incomplete first arm must not dispatch its paired arm")
		const pathWritten = await writeEngineeringStopReport({ command: "engineering", output, repo: process.cwd(), seeds: ["seed-0"], mutationTask: "", execute: true }, run)
		assert.equal(pathWritten, stopPath)
		const stop = JSON.parse(await fs.readFile(stopPath, "utf8")) as Record<string, unknown>
		assert.equal(stop.outcome, "incomplete")
		assert.equal(stop.qualifiedEvidencePath, output)
		assert.equal((stop.ledgerSnapshot as { campaign: { reserved_calls: number } }).campaign.reserved_calls, 1, "unsettled reservation is retained")
		assert.equal((((stop.candidateFailureEvents as Array<{ payload: { cells: Array<{ status: string; reservedTokens: number }> } }>)[0]!.payload.cells)[0]!.status), "uncertain")
		assert.equal((await fs.readFile(output, "utf8")), "previous-qualified-evidence\n", "incomplete results never overwrite qualified engineering evidence")
		assert.equal(Object.hasOwn(failureEvent.payload, "childCommit"), false, "failure event does not invent a child commit")
	} finally {
		await fs.rm(work, { recursive: true, force: true })
		await fs.rm(output, { force: true })
		await fs.rm(stopPath, { force: true })
	}
})

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
		const config = { archiveDir: root, model: RSI_OPENROUTER_MODEL, roles: { worker: { provider: "openrouter", model: RSI_OPENROUTER_MODEL } }, generations: 2, seed: "engineering-seed" } as RsiConfig
		const finished = {
			runId: `${campaign}-fixed`, startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T00:01:00Z",
			model: RSI_OPENROUTER_MODEL, baseRef: "main", baseCommit: "e".repeat(40), generations: 2, candidates: [], reports: [],
			workerHarnessPairId: campaign, workerHarnessMode: arm, workerHarnessSamplingSeed: "engineering-seed", workerHarnessRuntime: runtime,
			proofCampaign: {
				manifest: { phaseMode: "engineering-only", schedule: [], settings: { effectiveConfig: {} }, model: { provider: "openshell-openrouter", id: RSI_OPENROUTER_MODEL, settings: { roles: { worker: { provider: "openrouter", model: RSI_OPENROUTER_MODEL } } } } }, manifestSha256: "f".repeat(64), campaignId: campaign, armId: arm, epoch: 1,
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
		await assert.rejects(() => runEngineeringArm({ ...config, maxTokens: 7000 }, campaign, arm, finished.baseCommit, "engineering-seed", runtime, async () => {
			runnerCalls++
			throw new Error("a changed output-token limit must fail before replay or dispatch")
		}), /changed frozen output-token limit/)
		assert.equal(runnerCalls, 0, "a finished arm is not replayed under a changed token cap")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("engineering replay rejects persisted run whose nested campaign profile differs from its run identity", async () => {
	const scratch = path.join(process.cwd(), ".headlesscode", "scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratch, "proof-profile-replay-"))
	try {
		const campaign = `rsi-proof-${"a".repeat(20)}`
		const runtime: WorkerHarnessRuntimeIdentity = { imageName: "image", imageDigest: `sha256:${"b".repeat(64)}`, harnessCommit: "c".repeat(40), dependencyLockDigest: "d".repeat(64) }
		const config = { archiveDir: root, model: RSI_MUSE_OPENROUTER_MODEL, roles: { worker: { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "muse-spark-contributor" } }, generations: 2, seed: "engineering-seed" } as RsiConfig
		const mismatched = {
			runId: `${campaign}-fixed`, startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T00:01:00Z",
			model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfileId: "muse-spark-contributor", baseRef: "main", baseCommit: "e".repeat(40), generations: 2, candidates: [], reports: [],
			workerHarnessPairId: campaign, workerHarnessMode: "fixed-control", workerHarnessSamplingSeed: "engineering-seed", workerHarnessRuntime: runtime,
			proofCampaign: { manifest: { phaseMode: "engineering-only", schedule: [], settings: { effectiveConfig: {} }, model: { provider: "openshell-openrouter", id: RSI_OPENROUTER_MODEL } }, manifestSha256: "f".repeat(64), campaignId: campaign, armId: "fixed-control", epoch: 1, state: "finished", ledgerSnapshot: { arms: [{ arm_id: "fixed-control", state: "finished" }] } },
		} as unknown as RsiRunRecord
		await appendRun(root, mismatched)
		let dispatched = false
		await assert.rejects(() => runEngineeringArm(config, campaign, "fixed-control", mismatched.baseCommit, "engineering-seed", runtime, async () => { dispatched = true; throw new Error("should not dispatch") }, {}), /model\/profile differs/)
		assert.equal(dispatched, false)
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
		const config = { archiveDir: root, seed: "campaign-seed", generations: 3, model: RSI_OPENROUTER_MODEL } as RsiConfig
		const schedule = [
			{ armId, generation: 2, candidateId: "candidate-2-0", taskId: "holdout", seed: "17", attemptKind: "confirmation" as const, phase: "confirmation" as const },
			{ armId, generation: 2, candidateId: "root-control", taskId: "holdout", seed: "17", attemptKind: "fixed-control" as const, phase: "confirmation" as const },
		]
		const attempts = [
			{ attemptId: "final-attempt", taskId: "holdout", seed: 17, harnessCommit: "1".repeat(40), validity: "valid", proofQualified: true, resourceAccounting: "supervisor-enforced", artifactRefs: {}, inferenceReceipt: { qualified: true, model: RSI_OPENROUTER_MODEL, returnedModels: [RSI_OPENROUTER_MODEL], endpointProvider: "deepinfra", returnedProviders: ["deepinfra"] } },
			{ attemptId: "root-attempt", taskId: "holdout", seed: 17, harnessCommit: "e".repeat(40), validity: "valid", proofQualified: true, resourceAccounting: "supervisor-enforced", artifactRefs: {}, inferenceReceipt: { qualified: true, model: RSI_OPENROUTER_MODEL, returnedModels: [RSI_OPENROUTER_MODEL], endpointProvider: "deepinfra", returnedProviders: ["deepinfra"] } },
		]
		const manifestData = {
			schemaVersion: 1, phaseMode: "paired-confirmation", campaignId: campaign, rootCommit: "e".repeat(40),
			benchmarkDigests: { manifest: "3".repeat(64), development: "4".repeat(64), confirmation: "5".repeat(64) },
			armAssignment: { fixedControl: "fixed-control", selfHosted: "self-hosted" },
			model: { provider: "openshell-openrouter", id: RSI_OPENROUTER_MODEL, settings: { sampling: { temperature: 0 } } }, seed: "campaign-seed", taskOrder: ["holdout"], schedule,
			budgets: { attempt: { maxCalls: 1, maxTokens: 10, maxSpendUsd: 0.1, maxDurationMs: 1000 }, root: { maxCalls: 10, maxTokens: 100, maxSpendUsd: 1, maxRuntimeMs: 10000 } },
			acceptanceRule: {}, runtime: { imageDigest: runtime.imageDigest, harnessCommit: runtime.harnessCommit, dependencyLockDigest: runtime.dependencyLockDigest }, analysisVersion: "test",
			settings: { effectiveConfig: config },
		} as unknown as ProofCampaignManifest
		const run = {
			runId: `${campaign}-fixed`, startedAt: "2026-09-30T00:00:00Z", finishedAt: "2026-09-30T00:01:00Z",
			model: RSI_OPENROUTER_MODEL, baseRef: "main", baseCommit: "e".repeat(40), generations: 3, candidates: [], reports: [],
			workerHarnessPairId: campaign, workerHarnessMode: armId, workerHarnessSamplingSeed: "campaign-seed", workerHarnessConfigDigest: "f".repeat(64), workerHarnessPlannedGenerations: 3, workerHarnessRuntime: runtime,
			confirmationEvidence: "complete", confirmationAttempts: attempts,
			proofConfirmation: { selectedHarness: { candidateId: "candidate-id", slotId: "candidate-2-0", generation: 2, commit: "1".repeat(40), attemptIds: ["final-attempt"] }, rootHarness: { commit: "e".repeat(40), attemptIds: ["root-attempt"] } },
			proofCampaign: { manifest: manifestData, manifestSha256: proofCampaignManifestDigest(manifestData), campaignId: campaign, armId, epoch: 1, state: "finished", ledgerSnapshot: { campaign: { state: "finished" }, arms: [{ arm_id: armId, phase: "confirmation", state: "finished" }], attempts: schedule.map((cell, index) => ({ broker_job_id: index === 0 ? "final-attempt" : "root-attempt", arm_id: armId, generation: cell.generation, candidate_id: cell.candidateId, task_id: cell.taskId, seed: cell.seed, attempt_kind: cell.attemptKind, status: "completed", result_sha256: digest(attempts[index]), artifact_refs: {} })) } },
		} as unknown as RsiRunRecord
		assert.equal(isFullyConfirmedRun(run, armId), true)
		const museRun = structuredClone(run)
		museRun.openRouterProfileId = "muse-spark-contributor"
		museRun.model = RSI_MUSE_OPENROUTER_MODEL
		museRun.proofCampaign!.manifest.model = { provider: "openshell-openrouter", id: RSI_MUSE_OPENROUTER_MODEL, profileId: "muse-spark-contributor", settings: { sampling: { temperature: 0 } } }
		for (let index = 0; index < museRun.confirmationAttempts!.length; index++) {
			const attempt = museRun.confirmationAttempts![index]!
			attempt.inferenceReceipt!.model = RSI_MUSE_OPENROUTER_MODEL
			attempt.inferenceReceipt!.endpointProvider = "meta"
			attempt.inferenceReceipt!.returnedProviders = ["meta"]
			attempt.inferenceReceipt!.returnedModels = [RSI_MUSE_OPENROUTER_MODEL]
			;(museRun.proofCampaign!.ledgerSnapshot!.attempts as Array<Record<string, unknown>>)[index]!.result_sha256 = digest(attempt)
		}
		assert.equal(isFullyConfirmedRun(museRun, armId), true, "admitted Muse/Meta receipts satisfy the frozen profile-bound confirmation gate")
		const wrongProvider = structuredClone(museRun)
		wrongProvider.confirmationAttempts![0]!.inferenceReceipt!.returnedProviders = ["deepinfra"]
		;(wrongProvider.proofCampaign!.ledgerSnapshot!.attempts as Array<Record<string, unknown>>)[0]!.result_sha256 = digest(wrongProvider.confirmationAttempts![0])
		assert.equal(isFullyConfirmedRun(wrongProvider, armId), false, "Muse profile rejects receipts from a different provider")
		const unknownProfile = structuredClone(museRun)
		unknownProfile.proofCampaign!.manifest.model.profileId = "unadmitted-profile" as never
		assert.equal(isFullyConfirmedRun(unknownProfile, armId), false, "malformed persisted profile identity fails closed without interrupting archive inspection")
		await appendRun(root, run)
		const plan = { campaignIds: { campaigns: [campaign] }, execution: { configs: [config, config, config, config] }, benchmarkManifestSha256: "3".repeat(64), model: { provider: "openshell-openrouter", requestedId: RSI_OPENROUTER_MODEL }, rootCommit: run.baseCommit, runtime } as unknown as FrozenProofDemonstrationManifest
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
