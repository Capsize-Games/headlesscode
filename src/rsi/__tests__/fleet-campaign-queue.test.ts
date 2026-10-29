import assert from "node:assert/strict"
import test from "node:test"
import { fleetPayload } from "../controller-fleet.js"
import { rsiMutationGuestEnvironment } from "../openshell.js"
import { taskConfig } from "../worker.js"
import { RSI_MUSE_OPENROUTER_MODEL } from "../inference-broker.js"
import type { RsiConfig } from "../types.js"

test("campaign evaluation identity survives controller payload, queue worker config, and guest environment", () => {
	const scope = {
		planDigest: "a".repeat(64), fixtureDigest: "b".repeat(64), evaluatorDigest: "c".repeat(64),
		runtime: { imageName: "headlesscode-openshell-rsi:test", imageDigest: `sha256:${"d".repeat(64)}`, harnessCommit: "e".repeat(40), dependencyLockDigest: "f".repeat(64) },
		objective: "intake-parsing" as const,
		typecheckCommand: "python3 -c \"compile(open('candidate.py').read(), 'candidate.py', 'exec')\"",
	}
	const config = {
		model: RSI_MUSE_OPENROUTER_MODEL, mutationTask: "synthetic intake fixtures", maxIterations: 3,
		commandTimeoutMs: 120_000, protectedPaths: ["test_intake.py"], allowedMutationPaths: ["candidate.py"],
		regressionCommand: "python3 -m unittest test_intake", evalCommands: ["python3 -m unittest test_intake.CampaignCases.test_parse"],
		campaignScopedEvaluation: scope,
		roles: { worker: { provider: "openrouter", model: RSI_MUSE_OPENROUTER_MODEL, openRouterProfile: "muse-spark-contributor" } },
	} as unknown as RsiConfig
	const candidate = { id: "fixture-candidate", generation: 0, parent: "baseline", mutationKind: "corrective", hypothesis: "parser fixes fixture labels", model: RSI_MUSE_OPENROUTER_MODEL } as never
	const payload = fleetPayload(config, candidate, { content: Buffer.from("snapshot"), snapshotCommit: "d".repeat(40) })
	assert.deepEqual(payload.campaignScopedEvaluation, scope)
	const queue = { policy: { maxInFlight: 1 } } as never
	const workerConfig = taskConfig(payload, "/tmp/fixture", queue)
	assert.deepEqual(workerConfig.campaignScopedEvaluation, scope)
	const broker = { guestBaseUrl: "http://host.openshell.internal:1234", port: 1234, capability: "fixture", maxPromptBytes: 31_872 }
	const guestEnv = rsiMutationGuestEnvironment(workerConfig, candidate, broker)
	assert.equal(guestEnv.HEADLESSCODE_RSI_CAMPAIGN_MUTATION, "1")
	assert.equal(guestEnv.HEADLESSCODE_MAX_ITERATIONS, "3")
	assert.equal(rsiMutationGuestEnvironment(taskConfig({ ...payload, campaignScopedEvaluation: undefined }, "/tmp/fixture", queue), candidate, broker).HEADLESSCODE_RSI_CAMPAIGN_MUTATION, undefined)
})

test("worker rejects a forged campaign evaluation command before mutation setup", () => {
	const payload = {
		schemaVersion: 1, snapshotSha256: "", snapshotBytes: 1, snapshotCommit: "d".repeat(40), task: "test", model: "muse-spark",
		maxIterations: 3, timeoutMs: 1000, protectedPaths: [], candidate: { id: "candidate", computePolicy: "single" },
		campaignScopedEvaluation: { planDigest: "a".repeat(64), fixtureDigest: "b".repeat(64), evaluatorDigest: "c".repeat(64), runtime: { imageName: "headlesscode-openshell-rsi:test", imageDigest: `sha256:${"d".repeat(64)}`, harnessCommit: "e".repeat(40), dependencyLockDigest: "f".repeat(64) }, objective: "intake-parsing", typecheckCommand: "npm run typecheck" },
	} as never
	assert.throws(() => taskConfig(payload, "/tmp/fixture", { policy: { maxInFlight: 1 } } as never), /campaign evaluation identity is malformed/)
})
