import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { FileRsiArtifactStore } from "../../artifact-store.js"
import { freezeBenchmarkProtocol, loadBenchmark, runBenchmark } from "../runner.js"
import type { BenchmarkVerifier } from "../runner.js"
import type { BenchmarkAgent, BenchmarkTask } from "../types.js"
import { OpenShellBenchmarkAgent } from "../openshell-agent.js"

const fixtureRoot = path.resolve("fixtures/rsi-benchmark/smoke")
const loaded = await loadBenchmark(fixtureRoot)
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-benchmark-runner-test-"))
const outputRoot = path.join(tempRoot, "results")
const harnessCommit = "a".repeat(40)
let agentCalls = 0
let fakeCodingGuestActive = false
let lastCodingGuestWorkspace = ""
let activeSplit: "development" | "confirmation" = "development"
const confirmationTexts = new Set(loaded.manifest.tasks.filter((task) => task.split === "confirmation").map((task) => task.task))

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
		const candidate = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-benchmark-fake-agent-"))
		await fs.rm(candidate, { recursive: true, force: true })
		execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--shared", request.workspace, candidate], { stdio: ["ignore", "pipe", "pipe"] })
		try {
			for (const [relative, content] of Object.entries(oracle.files)) {
				const target = path.join(candidate, relative)
				await fs.mkdir(path.dirname(target), { recursive: true })
				await fs.writeFile(target, content)
			}
			execFileSync("git", ["add", "--all"], { cwd: candidate, stdio: "ignore" })
			execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fake model patch"], { cwd: candidate, stdio: "ignore" })
			const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: candidate, encoding: "utf8" }).trim()
			const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", `${base}...HEAD`], { cwd: candidate, encoding: "buffer" })
			return { validity: "valid", patch, stdout: "fake model completed", stderr: "", calls: 1, tokens: 22, wallTimeMs: 25, stopReason: "fake-complete" }
		} finally {
			await fs.rm(candidate, { recursive: true, force: true })
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

	const identityRoot = path.join(tempRoot, "image-identity")
	const savedImageIdentity = process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT
	const actualHarnessCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
	process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT = "b".repeat(40)
	try {
		await assert.rejects(runBenchmark({
			loaded, agent: new OpenShellBenchmarkAgent(), verifier, harnessCommit: actualHarnessCommit, agentImageIdentity: { name: "headlesscode-openshell-rsi:local", digest: `sha256:${"c".repeat(64)}`, harnessCommit: actualHarnessCommit }, modelId: "fake-image-identity", split: "development", outputRoot: identityRoot, taskIds: ["multi-01"],
		}), /must identify the harness commit baked into the OpenShell image/)
		assert.deepEqual(await fs.readdir(path.join(identityRoot, "attempts")).catch(() => []), [], "wrong image identity must abort without a scored attempt")
	} finally {
		if (savedImageIdentity === undefined) delete process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT
		else process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT = savedImageIdentity
	}
	console.log("All 18 RSI benchmark runner integration assertions passed")
} finally {
	await fs.rm(tempRoot, { recursive: true, force: true })
}
