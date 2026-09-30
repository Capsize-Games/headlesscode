import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { OpenShellBenchmarkAgent, OpenShellBenchmarkVerifier } from "../openshell-agent.js"
import type { BenchmarkAgentRequest, BenchmarkTask } from "../types.js"
import type { RsiOpenShellProviderFactory } from "../../openshell.js"

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-openshell-integrated-proof-"))
const originalPath = process.env.PATH
const originalHome = process.env.HOME
const originalHarnessCommit = process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT
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
	process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT = harnessCommit

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
		ceilings: { timeoutMs: 5000, maxCalls: 2, maxOutputTokensPerCall: 32, maxPatchBytes: 65536 },
	}
	const events: string[] = []
	let codingSnapshot = ""
	let verifierSnapshot = ""
	let phase: "agent" | "verifier" = "agent"
	const providerFactory: RsiOpenShellProviderFactory = () => ({
		async spawnExistingWorktreeSession(request, snapshot) {
			if (phase === "agent") {
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
				assert.equal(command.split("/opt/headlesscode/src/cli.ts").length - 1, 1, "coding worker command should execute once")
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

	const request: BenchmarkAgentRequest = {
		taskId: task.id, task: task.task, seed: task.seed, workspace: taskWorkspace, harnessCommit,
		model: { provider: "openshell-ollama", id: "fake-model", sampling: {} }, ceilings: task.ceilings,
	}
	const agent = new OpenShellBenchmarkAgent(harnessRoot, providerFactory)
	const agentResult = await agent.run(request)
	assert.equal(agentResult.validity, "valid")
	assert.ok(agentResult.patch)
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
	await fs.rm(tempRoot, { recursive: true, force: true })
}
