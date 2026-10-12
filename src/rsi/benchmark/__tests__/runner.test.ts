import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { FileRsiArtifactStore } from "../../artifact-store.js"
import { freezeBenchmarkProtocol, loadBenchmark, runBenchmark } from "../runner.js"
import type { BenchmarkVerifier } from "../runner.js"
import type { BenchmarkAgent, BenchmarkTask } from "../types.js"
import { OpenShellBenchmarkAgent } from "../openshell-agent.js"

const fixtureRoot = path.resolve("fixtures/rsi-benchmark/smoke")
const loaded = await loadBenchmark(fixtureRoot)
const scratchRoot = path.resolve(".headlesscode/scratch")
await fs.mkdir(scratchRoot, { recursive: true })
const tempRoot = await fs.mkdtemp(path.join(scratchRoot, "rsi-benchmark-runner-test-"))
const outputRoot = path.join(tempRoot, "results")
const harnessCommit = "a".repeat(40)
let agentCalls = 0
let fakeCodingGuestActive = false
let lastCodingGuestWorkspace = ""
let activeSplit: "development" | "confirmation" = "development"
const confirmationTexts = new Set(loaded.manifest.tasks.filter((task) => task.split === "confirmation").map((task) => task.task))
const ownedFakeAgentFixtures = new Set<string>()
const MAX_FIXTURE_REMOVE_ATTEMPTS = 5
const fixtureGitEnv = {
	...process.env,
	GIT_CONFIG_COUNT: "3",
	GIT_CONFIG_KEY_0: "gc.auto",
	GIT_CONFIG_VALUE_0: "0",
	GIT_CONFIG_KEY_1: "maintenance.auto",
	GIT_CONFIG_VALUE_1: "false",
	GIT_CONFIG_KEY_2: "maintenance.autoDetach",
	GIT_CONFIG_VALUE_2: "false",
}
const fixtureGitLocalConfigEnv = { ...fixtureGitEnv, GIT_CONFIG_COUNT: "0" }

async function createOwnedFakeAgentFixture(): Promise<string> {
	const parent = path.join(tempRoot, "fake-agent-fixtures")
	await fs.mkdir(parent, { recursive: true })
	const candidate = await fs.mkdtemp(path.join(parent, "rsi-benchmark-fake-agent-"))
	ownedFakeAgentFixtures.add(candidate)
	return candidate
}

async function removeOwnedFakeAgentFixture(
	candidate: string,
	options: {
		remove?: (target: string) => Promise<void>
		wait?: (milliseconds: number) => Promise<void>
	} = {},
): Promise<void> {
	if (!ownedFakeAgentFixtures.has(candidate)) throw new Error("refusing to remove an unowned fake-agent fixture")
	const remove = options.remove ?? (async (target: string) => fs.rm(target, { recursive: true, force: true }))
	const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
	let lastError: NodeJS.ErrnoException | undefined
	let attempts = 0
	for (let attempt = 1; attempt <= MAX_FIXTURE_REMOVE_ATTEMPTS; attempt += 1) {
		attempts = attempt
		try {
			await remove(candidate)
			ownedFakeAgentFixtures.delete(candidate)
			return
		} catch (error) {
			lastError = error as NodeJS.ErrnoException
			if (lastError.code !== "ENOTEMPTY" || attempt === MAX_FIXTURE_REMOVE_ATTEMPTS) break
			await wait(attempt * 20)
		}
	}
	const failure = new Error(`could not remove owned fake-agent fixture after ${attempts} attempt${attempts === 1 ? "" : "s"}`, { cause: lastError }) as NodeJS.ErrnoException
	failure.code = lastError?.code
	throw failure
}

async function removeRemainingOwnedFakeAgentFixtures(): Promise<void> {
	for (const fixture of ownedFakeAgentFixtures) await removeOwnedFakeAgentFixture(fixture)
}

async function assertFixtureCleanupContract(): Promise<void> {
	const transient = await createOwnedFakeAgentFixture()
	let attempts = 0
	await removeOwnedFakeAgentFixture(transient, {
		remove: async () => {
			attempts += 1
			if (attempts < 3) throw Object.assign(new Error("simulated concurrent Git metadata write"), { code: "ENOTEMPTY" })
			await fs.rm(transient, { recursive: true, force: true })
		},
		wait: async () => undefined,
	})
	assert.equal(attempts, 3, "owned fixture cleanup retries transient ENOTEMPTY and then succeeds")
	assert.equal(ownedFakeAgentFixtures.has(transient), false, "successful cleanup releases fixture ownership")

	const persistent = await createOwnedFakeAgentFixture()
	attempts = 0
	await assert.rejects(removeOwnedFakeAgentFixture(persistent, {
		remove: async () => {
			attempts += 1
			throw Object.assign(new Error("simulated persistent Git metadata write"), { code: "ENOTEMPTY" })
		},
		wait: async () => undefined,
	}), (error: NodeJS.ErrnoException) => error.code === "ENOTEMPTY")
	assert.equal(attempts, MAX_FIXTURE_REMOVE_ATTEMPTS, "persistent ENOTEMPTY stops at the configured retry bound")
	assert.equal(ownedFakeAgentFixtures.has(persistent), true, "failed cleanup retains ownership for final teardown")
	await removeOwnedFakeAgentFixture(persistent)

	const unexpected = await createOwnedFakeAgentFixture()
	attempts = 0
	await assert.rejects(removeOwnedFakeAgentFixture(unexpected, {
		remove: async () => {
			attempts += 1
			throw Object.assign(new Error("simulated unexpected cleanup failure"), { code: "EACCES" })
		},
		wait: async () => undefined,
	}), (error: NodeJS.ErrnoException) => error.code === "EACCES")
	assert.equal(attempts, 1, "non-ENOTEMPTY cleanup errors are not retried")
	await removeOwnedFakeAgentFixture(unexpected)

	let removedUnowned = false
	await assert.rejects(removeOwnedFakeAgentFixture(path.join(tempRoot, "not-owned"), {
		remove: async () => { removedUnowned = true },
	}), /unowned fake-agent fixture/)
	assert.equal(removedUnowned, false, "unowned paths are never passed to the remover")
}

const agent: BenchmarkAgent = {
	provider: "fake-model",
	async run(request) {
		fakeCodingGuestActive = true
		lastCodingGuestWorkspace = request.workspace
		agentCalls += 1
		const requestTask = loaded.manifest.tasks.find((entry) => entry.id === request.taskId)!
		assert.equal(requestTask.split, activeSplit)
		if (activeSplit === "development") assert.equal(confirmationTexts.has(request.task), false, "confirmation task text must not enter development execution")
		assert.equal(await fs.stat(path.join(request.workspace, "src/solution.js")).then(() => true), true)
		assert.equal(await fs.stat(path.join(request.workspace, "fixtures/rsi-benchmark")).then(() => true).catch(() => false), false, "the coding guest must not receive the benchmark or confirmation fixture tree")
		for (const forbidden of ["verify.mjs", "known-good.json", "known-bad.json", "manifest.json"]) {
			await assert.rejects(fs.access(path.join(request.workspace, forbidden)))
		}
		const task = requestTask
		const oracle = JSON.parse(await fs.readFile(path.join(fixtureRoot, task.knownGoodPath!), "utf8")) as { files: Record<string, string> }
		const candidate = await createOwnedFakeAgentFixture()
		let operationError: unknown
		try {
			execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--shared", "--config", "gc.auto=0", "--config", "maintenance.auto=false", request.workspace, candidate], { stdio: ["ignore", "pipe", "pipe"], env: fixtureGitEnv })
			assert.equal(execFileSync("git", ["config", "--local", "--get", "gc.auto"], { cwd: candidate, encoding: "utf8", env: fixtureGitLocalConfigEnv }).trim(), "0")
			assert.equal(execFileSync("git", ["config", "--local", "--get", "maintenance.auto"], { cwd: candidate, encoding: "utf8", env: fixtureGitLocalConfigEnv }).trim(), "false")
			execFileSync("git", ["config", "gc.auto", "0"], { cwd: candidate, env: fixtureGitEnv })
			execFileSync("git", ["config", "maintenance.auto", "false"], { cwd: candidate, env: fixtureGitEnv })
			execFileSync("git", ["config", "maintenance.autoDetach", "false"], { cwd: candidate, env: fixtureGitEnv })
			execFileSync("git", ["config", "user.name", "RSI Benchmark Test"], { cwd: candidate, env: fixtureGitEnv })
			execFileSync("git", ["config", "user.email", "rsi-benchmark-test@invalid.example"], { cwd: candidate, env: fixtureGitEnv })
			for (const [relative, content] of Object.entries(oracle.files)) {
				const target = path.join(candidate, relative)
				await fs.mkdir(path.dirname(target), { recursive: true })
				await fs.writeFile(target, content)
			}
			execFileSync("git", ["add", "--all"], { cwd: candidate, stdio: "ignore", env: fixtureGitEnv })
			execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fake model patch"], { cwd: candidate, stdio: "ignore", env: fixtureGitEnv })
			const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: candidate, encoding: "utf8", env: fixtureGitEnv }).trim()
			const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", `${base}...HEAD`], { cwd: candidate, encoding: "buffer", env: fixtureGitEnv })
			return { validity: "valid", patch, stdout: "fake model completed", stderr: "", calls: 1, tokens: 22, wallTimeMs: 25, stopReason: "fake-complete" }
		} catch (error) {
			operationError = error
			throw error
		} finally {
			try {
				await removeOwnedFakeAgentFixture(candidate)
			} catch (cleanupError) {
				fakeCodingGuestActive = false
				if (operationError !== undefined) throw new AggregateError([operationError, cleanupError], "fake-agent operation and fixture cleanup both failed")
				throw cleanupError
			}
			fakeCodingGuestActive = false
		}
	},
}

const verifier: BenchmarkVerifier = {
	async run(task: BenchmarkTask, root: string, workspace: string) {
		assert.equal(fakeCodingGuestActive, false, "supervisor verifier must run after the coding guest adapter has returned and torn down")
		assert.equal(await fs.stat(path.join(lastCodingGuestWorkspace, "verify.mjs")).then(() => true).catch(() => false), false, "verifier bytes must not be included in coding guest inputs")
		assert.equal(await fs.stat(path.join(lastCodingGuestWorkspace, "fixtures/rsi-benchmark")).then(() => true).catch(() => false), false, "confirmation corpus must not be included in coding guest inputs")
		const expected = JSON.parse(await fs.readFile(path.join(root, task.knownGoodPath!), "utf8")) as { files: Record<string, string> }
		for (const [relative, content] of Object.entries(expected.files)) {
			if (await fs.readFile(path.join(workspace, relative), "utf8") !== content) return { success: false, output: `mismatch at ${relative}` }
		}
		return { success: true, output: "fake independent verifier passed" }
	},
}

try {
	await assertFixtureCleanupContract()
	assert.equal(loaded.manifest.tasks.length, 32)
	assert.equal(loaded.manifest.tasks.filter((task) => task.split === "development").length, 16)
	assert.equal(loaded.manifest.tasks.filter((task) => task.split === "confirmation").length, 16)
	assert.equal(new Set(loaded.manifest.tasks.map((task) => task.family)).size, 4)
	const development = await runBenchmark({ loaded, agent, verifier, harnessCommit, modelId: "fake-model-v1", split: "development", outputRoot })
	assert.equal(development.length, 16)
	assert.equal(development.filter((attempt) => attempt.verifiedSuccess).length, 16, JSON.stringify(development.slice(0, 2)))
	assert.equal(agentCalls, 16)
	const report = JSON.parse(await fs.readFile(path.join(outputRoot, "development-report.json"), "utf8")) as { denominator: number; successes: number; totals: { tokens: number } }
	assert.equal(report.denominator, 16)
	assert.equal(report.successes, 16)
	assert.equal(report.totals.tokens, 352)
	const replayed = await runBenchmark({ loaded, agent, verifier, harnessCommit, modelId: "fake-model-v1", split: "development", outputRoot })
	assert.deepEqual(replayed.map((attempt) => attempt.attemptId), development.map((attempt) => attempt.attemptId))
	assert.equal(agentCalls, 16, "recorded task cells are replayed idempotently without rerunning the model")
	const missingCompletedArtifactRoot = path.join(tempRoot, "missing-completed-artifact")
	const callsBeforeMissingArtifact = agentCalls
	await assert.rejects(runBenchmark({
		loaded, agent, verifier, harnessCommit, modelId: "completed-cell-missing-artifact", split: "development", outputRoot: missingCompletedArtifactRoot,
		taskIds: ["multi-01"],
		attemptLifecycle: {
			beforeAttempt: async () => { throw new Error("completed benchmark proof cell has no verified local attempt artifact; refusing to dispatch it again") },
			settledAttempt: async () => undefined,
		},
	}), /refusing to dispatch it again/)
	assert.equal(agentCalls, callsBeforeMissingArtifact, "a durable completed cell without its local artifact must fail closed before calling the model")
	const tamperedAttemptPath = path.join(outputRoot, "attempts", `${development[0]!.attemptId}.json`)
	const pristineAttempt = await fs.readFile(tamperedAttemptPath, "utf8")
	const tamperedAttempt = JSON.parse(pristineAttempt) as Record<string, unknown>
	tamperedAttempt.harnessCommit = "b".repeat(40)
	await fs.writeFile(tamperedAttemptPath, JSON.stringify(tamperedAttempt))
	await assert.rejects(runBenchmark({ loaded, agent, verifier, harnessCommit, modelId: "fake-model-v1", split: "development", outputRoot }), /metadata mismatch: harnessCommit/)
	await fs.writeFile(tamperedAttemptPath, pristineAttempt)
	await assert.rejects(runBenchmark({ loaded, agent, verifier, harnessCommit, modelId: "fake-model-v1", split: "confirmation", confirmProtocol: true, outputRoot }))
	const frozenDigest = await freezeBenchmarkProtocol({ loaded, harnessCommit, modelId: "fake-model-v1", outputRoot, provider: agent.provider })
	assert.match(frozenDigest, /^[a-f0-9]{64}$/)
	activeSplit = "confirmation"
	const confirmation = await runBenchmark({ loaded, agent, verifier, harnessCommit, modelId: "fake-model-v1", split: "confirmation", confirmProtocol: true, outputRoot })
	assert.equal(confirmation.length, 16)
	assert.equal(confirmation.every((attempt) => attempt.split === "confirmation" && attempt.verifiedSuccess), true)
	const artifactRoot = path.join(outputRoot, "artifacts")
	const store = new FileRsiArtifactStore(artifactRoot)
	const patchDigest = development[0]!.artifactRefs.patch!
	const objectKey = `sha256/${patchDigest.slice(0, 2)}/${patchDigest}`
	await fs.rm(path.join(artifactRoot, objectKey))
	await assert.rejects(runBenchmark({ loaded, agent, verifier, harnessCommit, modelId: "fake-model-v1", split: "development", outputRoot }), /ENOENT/)
	assert.match(await fs.readFile(path.join(outputRoot, "invalid-replays.jsonl"), "utf8"), /attemptId/)

	const replayRoot = path.join(tempRoot, "patch-error-replay")
	const replayFile = path.join(tempRoot, "malformed-result.json")
	await fs.writeFile(replayFile, JSON.stringify({ validity: "valid", patchBase64: Buffer.from("not a git patch\n").toString("base64"), stdout: "", stderr: "", calls: 1, tokens: 1, wallTimeMs: 1, stopReason: "replayed" }))
	const rejected = await runBenchmark({ loaded, agent, verifier, harnessCommit, modelId: "fake-patch-error", split: "development", outputRoot: replayRoot, taskIds: ["multi-01"], replayFile })
	assert.equal(rejected[0]?.validity, "patch-error")
	const resumed = await runBenchmark({ loaded, agent, verifier, harnessCommit, modelId: "fake-patch-error", split: "development", outputRoot: replayRoot, taskIds: ["multi-01"] })
	assert.equal(resumed[0]?.validity, "patch-error", "a recorded patch rejection should replay without rerunning the agent")

	const unaccountedRoot = path.join(tempRoot, "unaccounted-resources")
	activeSplit = "development"
	const unaccountedAgent: BenchmarkAgent = {
		provider: "fake-model",
		async run(request) { const result = await agent.run(request); return { ...result, tokens: null } },
	}
	const unaccounted = await runBenchmark({ loaded, agent: unaccountedAgent, verifier, harnessCommit, modelId: "fake-unaccounted", split: "development", outputRoot: unaccountedRoot, taskIds: ["multi-01"] })
	assert.equal(unaccounted[0]?.validity, "valid")
	assert.equal(unaccounted[0]?.verifiedSuccess, true, "correctness verification is independent of guest-reported resource accounting")
	assert.equal(unaccounted[0]?.resourceAccounting, "incomplete")
	assert.equal(unaccounted[0]?.proofQualified, false, "unavailable aggregate enforcement cannot qualify resource bounds")
	const guestReportedRoot = path.join(tempRoot, "guest-reported-resources")
	const guestReportedAgent: BenchmarkAgent = {
		provider: "fake-model",
		async run(request) { const result = await agent.run(request); return { ...result, calls: request.ceilings.maxCalls + 1 } },
	}
	const guestReported = await runBenchmark({ loaded, agent: guestReportedAgent, verifier, harnessCommit, modelId: "fake-reported-over-limit", split: "development", outputRoot: guestReportedRoot, taskIds: ["multi-01"] })
	assert.equal(guestReported[0]?.validity, "valid", "untrusted guest transcript counts are never used as enforcement")
	assert.equal(guestReported[0]?.resourceAccounting, "guest-reported")
	assert.equal(guestReported[0]?.calls, guestReported[0]!.ceilings.maxCalls + 1)

	const verifierInfraRoot = path.join(tempRoot, "verifier-infrastructure")
	activeSplit = "development"
	await assert.rejects(runBenchmark({
		loaded, agent, harnessCommit, modelId: "fake-verifier-infra", split: "development", outputRoot: verifierInfraRoot, taskIds: ["multi-01"],
		verifier: { async run() { throw new Error("verifier sandbox launch failed") } },
	}), /verifier sandbox launch failed/)
	assert.deepEqual(await fs.readdir(path.join(verifierInfraRoot, "attempts")).catch(() => []), [], "verifier infrastructure failure must not create a scored attempt")

	const malformedResourceRoot = path.join(tempRoot, "malformed-error-resources")
	const malformedResourceAgent: BenchmarkAgent = {
		provider: "fake-model",
		async run() { return { validity: "agent-error", stdout: "worker failed", stderr: "worker failed", calls: -1, tokens: null, wallTimeMs: 1, stopReason: "worker-error" } },
	}
	await assert.rejects(runBenchmark({ loaded, agent: malformedResourceAgent, verifier, harnessCommit, modelId: "fake-malformed-error-resources", split: "development", outputRoot: malformedResourceRoot, taskIds: ["multi-01"] }), /invalid or over-limit resource observations/)
	assert.deepEqual(await fs.readdir(path.join(malformedResourceRoot, "attempts")).catch(() => []), [], "invalid counters on a failed agent result must not become a scored attempt")

	const forgedReceiptRoot = path.join(tempRoot, "forged-inference-receipt")
	const forgedReceiptAgent: BenchmarkAgent = {
		provider: "openshell-openrouter",
		async run(request) {
			return {
				validity: "agent-error", stdout: "", stderr: "", calls: 1, tokens: 10, wallTimeMs: 1, stopReason: "fake",
				inferenceReceipt: {
					provider: "openrouter", endpointProvider: "deepinfra", profileId: "deepseek-deepinfra-fp8", jobId: request.attemptId, campaignId: request.campaignId, model: "deepseek/deepseek-v4-flash-0731",
					returnedModels: ["deepseek/deepseek-v4-flash-0731"], returnedProviders: ["deepinfra"], calls: 1, promptTokens: 5, completionTokens: 5, totalTokens: 10,
					costUsd: 0.001, accounting: "supervisor-enforced", qualified: true, callReceipts: [], denials: [],
				},
			}
		},
	}
	await assert.rejects(runBenchmark({ loaded, agent: forgedReceiptAgent, verifier, harnessCommit, modelId: "deepseek/deepseek-v4-flash-0731", split: "development", outputRoot: forgedReceiptRoot, taskIds: ["multi-01"] }), /not present in the trusted supervisor ledger/)
	assert.deepEqual(await fs.readdir(path.join(forgedReceiptRoot, "attempts")).catch(() => []), [], "a forged first-run receipt cannot mint a proof-qualified attempt")

	const identityRoot = path.join(tempRoot, "image-identity")
	const actualHarnessCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
	let imageIdentityReads = 0
	const identityAgent = new OpenShellBenchmarkAgent(process.cwd(), undefined, "headlesscode-openshell-rsi:test-stub", undefined, async (name) => {
		imageIdentityReads += 1
		return { name, digest: `sha256:${"c".repeat(64)}`, harnessCommit: "b".repeat(40) }
	})
	await assert.rejects(runBenchmark({
		loaded, agent: identityAgent, verifier, harnessCommit: actualHarnessCommit, agentImageIdentity: { name: "headlesscode-openshell-rsi:test-stub", digest: `sha256:${"c".repeat(64)}`, harnessCommit: actualHarnessCommit }, modelId: "fake-image-identity", split: "development", outputRoot: identityRoot, taskIds: ["multi-01"],
	}), /does not match requested commit/)
	assert.equal(imageIdentityReads, 1, "mismatched identity must come from the deterministic resolver without Docker")
	assert.deepEqual(await fs.readdir(path.join(identityRoot, "attempts")).catch(() => []), [], "wrong image identity must abort without a scored attempt")
	console.log("All RSI benchmark runner integration assertions passed")
} finally {
	try {
		await removeRemainingOwnedFakeAgentFixtures()
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true })
	}
}
