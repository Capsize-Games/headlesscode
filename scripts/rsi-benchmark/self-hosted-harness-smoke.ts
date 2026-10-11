import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { FileOpenRouterInferenceLedger, RSI_OPENROUTER_ENDPOINT_PROVIDER, RSI_OPENROUTER_ENDPOINT_TAG, RSI_OPENROUTER_MODEL, startOpenRouterBroker, type OpenRouterBrokerLimits } from "../../src/rsi/inference-broker.js"
import { createMutationSnapshotBundle, runOpenShellMutation } from "../../src/rsi/openshell.js"
import { workerHarnessSentinelDiff } from "../../src/rsi/worker-harness-sentinel.js"
import type { CandidateRecord, RsiConfig, WorkerHarnessMode, WorkerHarnessRuntimeIdentity } from "../../src/rsi/types.js"

const repoRoot = path.resolve(process.argv[2] ?? process.cwd())
const harnessCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
const imageName = process.env.HEADLESSCODE_RSI_WORKER_IMAGE?.trim() || `headlesscode-openshell-rsi:${harnessCommit}`
const imageDigest = execFileSync("docker", ["image", "inspect", "--format={{.Id}}", imageName], { encoding: "utf8" }).trim()
const marker = execFileSync("docker", ["run", "--rm", "--entrypoint", "/bin/cat", imageDigest, "/opt/headlesscode/.headlesscode-harness-commit"], { encoding: "utf8" }).trim()
const dependencyLockDigest = execFileSync("docker", ["run", "--rm", "--entrypoint", "/bin/sha256sum", imageDigest, "/opt/headlesscode/package-lock.json"], { encoding: "utf8" }).trim().split(/\s+/, 1)[0]
assert.equal(marker, harnessCommit, "the image marker must identify this exact harness commit")
const runtime: WorkerHarnessRuntimeIdentity = { imageName, imageDigest, harnessCommit, dependencyLockDigest }
const bindHost = process.env.HEADLESSCODE_RSI_BROKER_BIND_HOST?.trim()
if (!bindHost) throw new Error("Set HEADLESSCODE_RSI_BROKER_BIND_HOST to an address in the OpenShell gateway network namespace")

const root = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-self-hosted-harness-"))
const ledger = new FileOpenRouterInferenceLedger(path.join(root, "broker-ledger.json"))
const promptMarker = "RSI_SELF_HOSTED_SENTINEL_18"
const task = "Create src/harness-result.txt. Follow the harness-specific instruction in the system prompt."
const sampling = { temperature: 0, seed: "generation-two-sentinel-18" }
const budget = { maxCalls: 3, maxOutputTokensPerCall: 256, timeoutMs: 180_000, maxPatchBytes: 256 * 1024 }
const baseLimits: Omit<OpenRouterBrokerLimits, "campaignId"> = {
	maxCalls: 3,
	maxInputTokensPerCall: 150_000,
	maxOutputTokensPerCall: 256,
	maxTotalTokens: 450_768,
	maxDurationMs: 180_000,
	maxRequestBytes: 1024 * 1024,
	maxResponseBytes: 512 * 1024,
	maxInputPricePerMillionUsd: 1,
	maxOutputPricePerMillionUsd: 1,
	maxCallSpendUsd: 0.20,
	maxJobSpendUsd: 0.60,
	maxCampaignSpendUsd: 3.00,
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
	return { id, type: "function", function: { name, arguments: JSON.stringify(args) } }
}

function mockUpstream(stage: "seed" | "bridge" | "sentinel", observed: { sentinelPrompts: boolean[] }) {
	let calls = 0
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input)
		if (url.endsWith(`/models/${RSI_OPENROUTER_MODEL}/endpoints`)) {
			return new Response(JSON.stringify({ data: { endpoints: [{ provider_name: "DeepInfra", tag: RSI_OPENROUTER_ENDPOINT_TAG, quantization: "fp8", status: 0, supported_parameters: ["tools", "tool_choice", "temperature", "seed", "max_tokens"], supports_tool_choice: { auto: true, required: true, function: true }, pricing: { prompt: "0.000001", completion: "0.000001" } }] } }), { status: 200, headers: { "content-type": "application/json" } })
		}
		assert.equal(url, "https://openrouter.ai/api/v1/chat/completions")
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mock-only-not-a-provider-key")
		const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: unknown }> }
		const systemText = (body.messages ?? []).filter((message) => message.role === "system").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n")
		const sawSentinel = systemText.includes(promptMarker)
		const callNumber = ++calls
		assert.ok(callNumber <= 3, "each bounded mock task admits at most three model calls")
		if (callNumber === 1) observed.sentinelPrompts.push(sawSentinel)
		let call: ReturnType<typeof toolCall>
		if (callNumber === 1 && stage === "seed") {

			call = toolCall("sentinel-edit", "apply_diff", { path: "src/engine/prompt.ts", diff: workerHarnessSentinelDiff(promptMarker) })
		} else if (callNumber === 1 && stage === "bridge") {
			call = toolCall("bridge-result", "write_to_file", { path: "src/harness-gen1.txt", content: "paired-parent\n" })
		} else if (callNumber === 1) {
			call = toolCall("write-result", "write_to_file", { path: "src/harness-result.txt", content: sawSentinel ? "self-hosted-generation-two\n" : "fixed-control-generation-two\n" })
		} else if (callNumber === 2) {
			call = toolCall("commit-result", "execute_command", { command: "git add -- src && git -c user.name='RSI smoke' -c user.email='rsi-smoke@example.invalid' -c core.hooksPath=/dev/null commit -m 'mock harness sentinel result'" })
		} else {
			call = toolCall("finish-result", "attempt_completion", { result: "Committed the bounded fake-model task result." })
		}
		const message = { role: "assistant", tool_calls: [call] }
		return new Response(JSON.stringify({
			id: `mock-self-hosted-${stage}-${calls}`,
			model: RSI_OPENROUTER_MODEL,
			openrouter_metadata: { endpoints: { available: [{ provider: RSI_OPENROUTER_ENDPOINT_PROVIDER, selected: true }] } },
			choices: [{ message, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 10_000, completion_tokens: 200, cost: 0.0102 },
		}), { status: 200, headers: { "content-type": "application/json" } })
	}
}

async function runArm(mode: WorkerHarnessMode, generation: number, parentCommit: string, stage: "seed" | "bridge" | "sentinel", armIndex: number, observed: { sentinelPrompts: boolean[] }, worktrees: string[]): Promise<{ candidate: CandidateRecord; parentCommit: string }> {
	const id = `${mode}-g${generation}-${armIndex}`
	const task = stage === "seed"
		? "Add the specified harness sentinel to the code-mode system prompt and commit."
		: stage === "bridge"
			? "Create src/harness-gen1.txt with the paired-parent marker and commit."
			: "Create src/harness-result.txt. Follow the harness-specific instruction in the system prompt."
	const worktree = path.join(root, id)
	execFileSync("git", ["worktree", "add", "--quiet", "--detach", worktree, parentCommit], { cwd: repoRoot })
	worktrees.push(worktree)
	execFileSync("git", ["-C", worktree, "config", "user.name", "RSI smoke"], { cwd: repoRoot })
	execFileSync("git", ["-C", worktree, "config", "user.email", "rsi-smoke@example.invalid"], { cwd: repoRoot })
	const candidate: CandidateRecord = {
		id, generation, parent: parentCommit, parentCommit, branch: `rsi-smoke-${id}`, worktree, baseCommit: parentCommit,
		status: "mutating", model: RSI_OPENROUTER_MODEL, modelProvider: "openrouter", mutation: task,
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), commits: [], changedFiles: [], protectedPathViolations: [],
	}
	const config: RsiConfig = {
		repoRoot, model: RSI_OPENROUTER_MODEL, population: 1, generations: 3, maxConcurrent: 1,
		mutationTask: task, regressionCommand: "true", evalCommands: [], hiddenEvalCommands: [],
		archiveDir: path.join(root, ".archive"), worktreeDir: path.join(root, ".candidate-worktrees"), baseRef: harnessCommit,
		seed: sampling.seed, dryRun: false, keepWorktrees: true, maxIterations: 3, maxTokens: 256,
		protectedPaths: [], commandTimeoutMs: budget.timeoutMs, roles: { worker: { provider: "openrouter", model: RSI_OPENROUTER_MODEL } },
		workerHarnessMode: mode, workerHarnessPairId: "rsi-harness-sentinel-18", workerHarnessRuntime: runtime,
		workerHarnessParentCommit: parentCommit,
	}
	const snapshot = createMutationSnapshotBundle(worktree, parentCommit, config)
	config.workerHarnessSnapshotTreeDigest = snapshot.snapshotTreeDigest
	const jobId = `mock-${mode}-${generation}-${armIndex}`
	const broker = await startOpenRouterBroker({
		jobId,
		leaseToken: `mock-lease-${mode}-${generation}-${armIndex}`,
		model: RSI_OPENROUTER_MODEL,
		limits: { ...baseLimits, campaignId: "rsi-self-hosted-harness-18" },
		apiKey: "mock-only-not-a-provider-key",
		bindHost,
		ledger,
		upstreamFetch: mockUpstream(stage, observed),
	})
	try {
		const result = await runOpenShellMutation(candidate, config, undefined, undefined, { guestBaseUrl: broker.guestBaseUrl, capability: broker.capability, port: broker.port })
		assert.equal(result.ok, true, result.error)
		assert.ok(result.workerHarnessExecution)
		assert.equal(result.workerHarnessExecution.mode, generation === 0 ? "fixed-control" : mode)
		assert.equal(result.workerHarnessExecution.executedCliPath, generation === 0 || mode === "fixed-control" ? "/opt/headlesscode/src/cli.ts" : "/workspace/src/cli.ts")
		assert.equal(result.workerHarnessExecution.parentCommit, parentCommit)
		const receipt = await broker.receipt()
		assert.equal(receipt.qualified, true)
		assert.equal(receipt.calls, 3)
		return { candidate, parentCommit: git(worktree, ["rev-parse", "HEAD"]) }
	} finally {
		await broker.close()
	}
}

const observed = { sentinelPrompts: [] as boolean[] }
const worktrees: string[] = []
try {
	const seedFixed = await runArm("fixed-control", 0, harnessCommit, "seed", 0, observed, worktrees)
	const seedSelf = await runArm("self-hosted", 0, harnessCommit, "seed", 1, observed, worktrees)
	assert.equal(git(seedFixed.candidate.worktree, ["show", seedFixed.parentCommit + ":src/engine/prompt.ts"]).includes(promptMarker), true)
	assert.equal(git(seedSelf.candidate.worktree, ["show", seedSelf.parentCommit + ":src/engine/prompt.ts"]).includes(promptMarker), true)

	const bridgeFixed = await runArm("fixed-control", 1, seedFixed.parentCommit, "bridge", 2, observed, worktrees)
	const bridgeSelf = await runArm("self-hosted", 1, seedSelf.parentCommit, "bridge", 3, observed, worktrees)
	assert.equal(git(bridgeFixed.candidate.worktree, ["show", bridgeFixed.parentCommit + ":src/harness-gen1.txt"]), "paired-parent")
	assert.equal(git(bridgeSelf.candidate.worktree, ["show", bridgeSelf.parentCommit + ":src/harness-gen1.txt"]), "paired-parent")
	assert.equal(bridgeFixed.candidate.mutation, bridgeSelf.candidate.mutation)
	assert.notEqual(bridgeFixed.candidate.id, bridgeSelf.candidate.id)
	const fixedGenerationTwo = await runArm("fixed-control", 2, bridgeFixed.parentCommit, "sentinel", 4, observed, worktrees)
	const selfGenerationTwo = await runArm("self-hosted", 2, bridgeSelf.parentCommit, "sentinel", 5, observed, worktrees)
	assert.deepEqual(observed.sentinelPrompts, [false, false, false, true, false, true], "the self-hosted source sentinel must reach gen2; fixed-control stays on /opt")
	assert.equal(await fs.readFile(path.join(fixedGenerationTwo.candidate.worktree, "src", "harness-result.txt"), "utf8"), "fixed-control-generation-two\n")
	assert.equal(await fs.readFile(path.join(selfGenerationTwo.candidate.worktree, "src", "harness-result.txt"), "utf8"), "self-hosted-generation-two\n")
	assert.equal(fixedGenerationTwo.candidate.model, selfGenerationTwo.candidate.model)
	assert.equal(fixedGenerationTwo.candidate.mutation, selfGenerationTwo.candidate.mutation)
	assert.equal(fixedGenerationTwo.candidate.generation, selfGenerationTwo.candidate.generation)
	assert.notEqual(fixedGenerationTwo.candidate.id, selfGenerationTwo.candidate.id)
	const fixedPatch = git(fixedGenerationTwo.candidate.worktree, ["diff", "--binary", fixedGenerationTwo.candidate.baseCommit + "...HEAD"])
	const selfPatch = git(selfGenerationTwo.candidate.worktree, ["diff", "--binary", selfGenerationTwo.candidate.baseCommit + "...HEAD"])
	assert.equal(git(fixedGenerationTwo.candidate.worktree, ["diff", "--name-only", fixedGenerationTwo.candidate.baseCommit + "...HEAD"]), "src/harness-result.txt")
	assert.equal(git(selfGenerationTwo.candidate.worktree, ["diff", "--name-only", selfGenerationTwo.candidate.baseCommit + "...HEAD"]), "src/harness-result.txt")
	assert.notEqual(fixedPatch, selfPatch, "the committed generation-two task patches must differ")
	assert.ok(fixedPatch.includes("fixed-control-generation-two"))
	assert.ok(selfPatch.includes("self-hosted-generation-two"))
	process.stdout.write(JSON.stringify({ status: "passed", harnessCommit, runtime, pairId: "rsi-harness-sentinel-18", model: RSI_OPENROUTER_MODEL, sampling, budget, candidateCount: 1, pairedTaskIds: ["seed", "bridge", "sentinel"], generationZeroModes: ["fixed-control", "fixed-control"], generationTwoCliPaths: ["/opt/headlesscode/src/cli.ts", "/workspace/src/cli.ts"], generationTwoPromptSentinel: observed.sentinelPrompts.slice(-2), generationTwoOutputs: ["fixed-control-generation-two", "self-hosted-generation-two"], generationTwoPatchDigests: [fixedPatch, selfPatch].map((patch) => createHash("sha256").update(patch).digest("hex")), calls: 18, attempts: 6, provider: "mock-openrouter-upstream", productionCredentialUsed: false }) + "\n")
} finally {
	for (const worktree of worktrees.reverse()) {
		await fs.rm(worktree, { recursive: true, force: true }).catch(() => undefined)
		execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "ignore" })
	}
	await fs.rm(root, { recursive: true, force: true })
}
