import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { OpenShellBenchmarkAgent, OpenShellBenchmarkVerifier } from "../openshell-agent.js"
import { startOpenRouterBroker, RSI_OPENROUTER_MODEL } from "../../inference-broker.js"
import type { BenchmarkAgentRequest, BenchmarkTask } from "../types.js"
import type { RsiOpenShellProviderFactory } from "../../openshell.js"

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-openshell-integrated-proof-"))
const originalPath = process.env.PATH
const originalHome = process.env.HOME
const originalHarnessCommit = process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT
const brokerEnvNames = [
	"HEADLESSCODE_OPENROUTER_API_KEY", "HEADLESSCODE_RSI_BROKER_BIND_HOST",
	"HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_TOKENS_PER_CALL",
	"HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD",
	"HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD", "HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD",
	"HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD", "HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD",
] as const
const originalBrokerEnv = Object.fromEntries(brokerEnvNames.map((name) => [name, process.env[name]]))
try {
	const emptyHome = path.join(tempRoot, "empty-home")
	await fs.mkdir(emptyHome)
	process.env.HOME = emptyHome
	const fakeBin = path.join(tempRoot, "bin")
	await fs.mkdir(fakeBin)
	const fakeDocker = path.join(fakeBin, "docker")
	await fs.writeFile(fakeDocker, "#!/bin/sh\nif [ \"$1\" = image ]; then printf '%s\\n' \"$RSI_TEST_IMAGE_DIGEST\"; elif [ \"$1\" = run ]; then printf '%s\\n' \"$RSI_TEST_HARNESS_COMMIT\"; else exit 2; fi\n", { mode: 0o755 })
	process.env.PATH = `${fakeBin}:${originalPath ?? "/usr/bin:/bin"}`
	process.env.RSI_TEST_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`
	process.env.HEADLESSCODE_OPENROUTER_API_KEY = "host-test-key-never-forwarded-to-guest"
	process.env.HEADLESSCODE_RSI_BROKER_BIND_HOST = "127.0.0.1"
	process.env.HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_TOKENS_PER_CALL = "512"
	process.env.HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD = "1"
	process.env.HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD = "1"
	process.env.HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD = "0.01"
	process.env.HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD = "0.04"
	process.env.HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD = "0.10"
	process.env.HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD = "0.04"
	process.env.HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD = "0.04"

	const harnessRoot = path.join(tempRoot, "harness")
	await fs.mkdir(path.join(harnessRoot, "src"), { recursive: true })
	await fs.mkdir(path.join(harnessRoot, ".worktrees"), { recursive: true })
	await fs.writeFile(path.join(harnessRoot, "src", "placeholder.js"), "export const harness = true\n")
	const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" })
	const initRepo = (cwd: string) => {
		git(cwd, ["init", "--quiet", "--initial-branch=main"])
		git(cwd, ["config", "user.name", "RSI Test"])
		git(cwd, ["config", "user.email", "rsi-test@invalid.example"])
		git(cwd, ["add", "--all"])
		git(cwd, ["commit", "--quiet", "-m", "test snapshot"])
	}
	initRepo(harnessRoot)
	const harnessCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: harnessRoot, encoding: "utf8" }).trim()
	process.env.RSI_TEST_HARNESS_COMMIT = harnessCommit
	delete process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT

	const taskWorkspace = path.join(tempRoot, "task")
	await fs.mkdir(path.join(taskWorkspace, "src"), { recursive: true })
	await fs.mkdir(path.join(taskWorkspace, "fixtures", "rsi-benchmark"), { recursive: true })
	await fs.mkdir(path.join(taskWorkspace, "fixtures", "rsi-curriculum"), { recursive: true })
	await fs.writeFile(path.join(taskWorkspace, "src", "app.js"), "export const answer = 1\n")
	await fs.writeFile(path.join(taskWorkspace, "fixtures", "rsi-benchmark", "confirmation.json"), "confirmation secret\n")
	await fs.writeFile(path.join(taskWorkspace, "fixtures", "rsi-curriculum", "verifier.json"), "verifier secret\n")
	initRepo(taskWorkspace)
	const taskBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: taskWorkspace, encoding: "utf8" }).trim()

	const fixtureRoot = path.join(tempRoot, "supervisor-fixtures")
	await fs.mkdir(path.join(fixtureRoot, "verifiers"), { recursive: true })
	const verifierBytes = Buffer.from("independent verifier bytes\n")
	await fs.writeFile(path.join(fixtureRoot, "verifiers", "task.mjs"), verifierBytes)
	const task: BenchmarkTask = {
		id: "integration-task", family: "runner", split: "development", task: "Change app answer to 2",
		startCommit: taskBase, startDigest: "a".repeat(64), verifierPath: "verifiers/task.mjs",
		verifierDigest: createHash("sha256").update(verifierBytes).digest("hex"), knownGoodCommit: taskBase,
		knownGoodDigest: "b".repeat(64), knownBadCommit: taskBase, knownBadDigest: "c".repeat(64), seed: 1,
		ceilings: { timeoutMs: 60_000, maxCalls: 2, maxOutputTokensPerCall: 32, maxPatchBytes: 65536 },
	}
	const events: string[] = []
	let codingSnapshot = ""
	let verifierSnapshot = ""
	let phase: "agent" | "verifier" = "agent"
	let guestEnvironment: Record<string, string> = {}
	let guestWorkerCommand = ""
	let brokerBaseUrl = ""
	let upstreamCalls = 0
	let guestNetworkPolicy: Record<string, unknown> = {}
	const providerFactory: RsiOpenShellProviderFactory = (options) => {
		guestNetworkPolicy = options.networkPolicy ?? {}
		return ({
		async spawnExistingWorktreeSession(request, snapshot) {
			if (phase === "agent") {
				guestEnvironment = request.env ?? {}
				codingSnapshot = snapshot
				events.push("agent-spawn")
				assert.equal(await fs.stat(path.join(snapshot, "src", "app.js")).then(() => true), true)
				assert.equal(await fs.stat(path.join(snapshot, "fixtures", "rsi-benchmark")).then(() => true).catch(() => false), false, "coding guest must not see benchmark confirmation fixtures")
				assert.equal(await fs.stat(path.join(snapshot, "fixtures", "rsi-curriculum")).then(() => true).catch(() => false), false, "coding guest must not see verifier inputs")
				assert.equal(await fs.stat(path.join(snapshot, "__rsi_benchmark_verifier__")).then(() => true).catch(() => false), false, "coding guest must not see verifier bytes")
			} else {
				verifierSnapshot = snapshot
				events.push("verifier-spawn")
				assert.equal(events.at(-2), "agent-teardown", "verifier guest must launch only after the coding guest was torn down")
				assert.equal(await fs.readFile(path.join(snapshot, "__rsi_benchmark_verifier__", "verify.mjs"), "utf8"), verifierBytes.toString())
				assert.equal(await fs.stat(path.join(snapshot, "fixtures", "rsi-benchmark")).then(() => true).catch(() => false), false, "verifier guest input must not contain the confirmation corpus")
			}
			return { id: request.worktreeSpec.name, provider: "mock-openshell", address: snapshot }
		},
		async waitReady() {},
		async runHarness(_handle, command) {
			if (phase === "agent") {
				events.push("agent-command")
				guestWorkerCommand = command
				const workerCommand = command.split(" && exec ")[1] ?? ""
				assert.equal(command.split(" && exec ").length - 1, 1, "coding worker command should execute once after preflight")
				assert.equal(workerCommand.split("/opt/headlesscode/src/cli.ts").length - 1, 1, "fixed-control must execute the pinned release CLI exactly once")
				assert.equal(workerCommand.includes("/workspace/src/cli.ts"), false, "fixed-control must not execute the candidate CLI")
				assert.equal(guestEnvironment.HEADLESSCODE_RSI_INFERENCE_CAPABILITY, lastCapability)
				assert.equal(guestEnvironment.HEADLESSCODE_OPENROUTER_API_KEY, undefined, "raw provider credential must stay on the supervisor")
				assert.equal(guestEnvironment.OPENROUTER_API_KEY, undefined)
				assert.match(guestEnvironment.OPENROUTER_BASE_URL ?? "", /^http:\/\/host\.openshell\.internal:\d+$/)
				const brokerRule = guestNetworkPolicy.rsi_openrouter_broker as { endpoints?: Array<{ host?: string; port?: number; protocol?: string }> } | undefined
				assert.deepEqual(brokerRule?.endpoints, [{ host: "host.openshell.internal", port: Number(new URL(brokerBaseUrl).port), protocol: "tcp" }])
				assert.equal(JSON.stringify(guestNetworkPolicy).includes("example.com"), false, "guest network policy must not grant arbitrary external access")
				const brokerCall = await fetch(`${brokerBaseUrl}/api/v1/chat/completions`, {
					method: "POST", headers: { authorization: `Bearer ${guestEnvironment.HEADLESSCODE_RSI_INFERENCE_CAPABILITY}`, "content-type": "application/json", "x-rsi-call-id": "openshell-mock-call-001" },
					body: JSON.stringify({ model: RSI_OPENROUTER_MODEL, messages: [{ role: "user", content: "Return a small change." }], max_completion_tokens: 8 }),
				})
				assert.equal(brokerCall.status, 200)
				const rejectedRoute = await fetch(`${brokerBaseUrl}/v1/admin`, { headers: { authorization: `Bearer ${guestEnvironment.HEADLESSCODE_RSI_INFERENCE_CAPABILITY}` } })
				assert.equal(rejectedRoute.status, 404, "broker capability cannot be used as an arbitrary proxy")
				upstreamCalls += 1
				await fs.writeFile(path.join(codingSnapshot, "src", "app.js"), "export const answer = 2\n")
				git(codingSnapshot, ["config", "user.name", "RSI Test"])
				git(codingSnapshot, ["config", "user.email", "rsi-test@invalid.example"])
				git(codingSnapshot, ["add", "--all"])
				git(codingSnapshot, ["commit", "--quiet", "-m", "fake coding result"])
				return { exitCode: 0, output: "fake coding guest completed" }
			}
			events.push("verifier-command")
			assert.match(command, /RSI_BENCHMARK_VERIFIER_COMPLETED/)
			return { exitCode: 0, output: "verifier passed\nRSI_BENCHMARK_VERIFIER_COMPLETED:0\n" }
		},
		async teardown() { events.push(phase === "agent" ? "agent-teardown" : "verifier-teardown") },
		})
	}

	const request: BenchmarkAgentRequest = {
		taskId: task.id, attemptId: `attempt-${task.id}`, campaignId: "campaign-test", brokerLedgerPath: path.join(tempRoot, "inference-ledger.json"), task: 'Change app answer to 2.\nPreserve the literal text "answer" and edit only src/app.js.', seed: task.seed, workspace: taskWorkspace, harnessCommit,
		model: { provider: "openshell-openrouter", id: RSI_OPENROUTER_MODEL, sampling: {} }, ceilings: task.ceilings,
	}
	let lastCapability = ""
	const brokerFactory = async (options: Parameters<typeof startOpenRouterBroker>[0]) => {
		const broker = await startOpenRouterBroker({ ...options, upstreamFetch: async (input, init) => {
			const url = String(input)
			if (url.endsWith(`/models/${RSI_OPENROUTER_MODEL}/endpoints`)) return new Response(JSON.stringify({ data: { endpoints: [{ provider_name: "DeepInfra", tag: "deepinfra/fp8", quantization: "fp8", status: 0, supported_parameters: ["max_tokens", "temperature", "tools", "tool_choice"], supports_tool_choice: { "auto": true, "required": true }, pricing: { prompt: "0.00000006", completion: "0.00000018" } }] } }), { status: 200, headers: { "content-type": "application/json" } })
			assert.equal(url, "https://openrouter.ai/api/v1/chat/completions")
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer host-test-key-never-forwarded-to-guest")
			return new Response(JSON.stringify({ id: "mock-provider-response", model: RSI_OPENROUTER_MODEL, openrouter_metadata: { endpoints: { available: [{ provider: "deepinfra", selected: true }] } }, choices: [{ message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.00000144 } }), { status: 200, headers: { "content-type": "application/json" } })
		} })
		brokerBaseUrl = broker.localBaseUrl
		lastCapability = broker.capability
		return broker
	}
	const agent = new OpenShellBenchmarkAgent(harnessRoot, providerFactory, "headlesscode-openshell-rsi:local", harnessCommit, undefined, "openshell-openrouter", brokerFactory)
	const agentResult = await agent.run(request)
	assert.equal(agentResult.validity, "valid")
	assert.ok(guestWorkerCommand.includes(`Objective: ${request.task}`), "mocked guest dispatch must receive the exact multiline benchmark objective")
	assert.equal(guestWorkerCommand.includes("Improve the headlesscode agent loop while preserving all existing behavior and tests."), false, "benchmark dispatch must not retain the generic RSI objective")
	assert.ok(agentResult.patch)
	assert.equal(upstreamCalls, 1, "the guest path must complete one brokered provider request")
	assert.equal(agentResult.inferenceReceipt?.qualified, true)
	assert.equal(agentResult.inferenceReceipt?.calls, 1)
	assert.equal(agentResult.inferenceReceipt?.totalTokens, 16)
	const archivedOutput = [agentResult.stdout, agentResult.stderr, agentResult.patch?.toString("utf8") ?? ""].join("\n")
	assert.equal(archivedOutput.includes("host-test-key-never-forwarded-to-guest"), false, "provider credential must not appear in guest output or imported patch")
	assert.equal(archivedOutput.includes("Return a small change."), false, "prompt contents must not appear in guest output or imported patch")
	assert.equal(events.includes("agent-teardown"), true)
	await fs.rm(codingSnapshot, { recursive: true, force: true })
	// Apply only the result returned by the coding adapter to the task repository.
	execFileSync("git", ["apply", "--binary"], { cwd: taskWorkspace, input: agentResult.patch })
	git(taskWorkspace, ["add", "--all"])
	git(taskWorkspace, ["commit", "--quiet", "-m", "import candidate result"])
	phase = "verifier"
	const verifier = new OpenShellBenchmarkVerifier(harnessRoot, providerFactory)
	const verdict = await verifier.run(task, fixtureRoot, taskWorkspace)
	assert.equal(verdict.success, true)
	assert.deepEqual(events.filter((event) => event.endsWith("spawn") || event.endsWith("teardown")), ["agent-spawn", "agent-teardown", "verifier-spawn", "verifier-teardown"])
	assert.equal(await fs.stat(verifierSnapshot).then(() => true).catch(() => false), false, "verifier guest snapshot should be removed after teardown")
	console.log("Integrated OpenShell benchmark adapters preserve guest separation and teardown order")
} finally {
	if (originalPath === undefined) delete process.env.PATH
	else process.env.PATH = originalPath
	if (originalHome === undefined) delete process.env.HOME
	else process.env.HOME = originalHome
	if (originalHarnessCommit === undefined) delete process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT
	else process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT = originalHarnessCommit
	delete process.env.RSI_TEST_IMAGE_DIGEST
	delete process.env.RSI_TEST_HARNESS_COMMIT
	for (const name of brokerEnvNames) {
		const value = originalBrokerEnv[name]
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
	await fs.rm(tempRoot, { recursive: true, force: true })
}
