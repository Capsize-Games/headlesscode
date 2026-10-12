import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { benchmarkTreeDigest, materializeBenchmarkSnapshot, runBenchmark } from "../runner.js"
import type { BenchmarkVerifier, LoadedBenchmark } from "../runner.js"
import type { BenchmarkAgent, BenchmarkAgentRequest, BenchmarkTask } from "../types.js"

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-commit-workspace-"))
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
const gitText = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

try {
	const repoRoot = path.join(tempRoot, "source-repo")
	const fixtureRoot = path.join(tempRoot, "fixtures")
	const outputRoot = path.join(tempRoot, "results")
	await fs.mkdir(path.join(repoRoot, "src"), { recursive: true })
	await fs.mkdir(path.join(fixtureRoot, "verifiers"), { recursive: true })
	await fs.writeFile(path.join(repoRoot, "src", "solution.js"), "export const answer = 1\n")
	git(repoRoot, ["init", "--quiet", "--initial-branch=main"])
	git(repoRoot, ["config", "user.name", "Synthetic RSI test"])
	git(repoRoot, ["config", "user.email", "synthetic-rsi-test@invalid.example"])
	git(repoRoot, ["add", "--all"])
	git(repoRoot, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "synthetic start snapshot"])
	const startCommit = gitText(repoRoot, ["rev-parse", "HEAD"])
	const verifierPath = path.join(fixtureRoot, "verifiers", "task.mjs")
	await fs.writeFile(verifierPath, "// synthetic verifier marker\n")
	const verifierDigest = sha256(await fs.readFile(verifierPath, "utf8"))
	const task: BenchmarkTask = {
		id: "commit-task", family: "workspace", split: "development", task: "Set answer to two",
		startCommit, startDigest: "0".repeat(64), verifierPath: "verifiers/task.mjs", verifierDigest,
		knownGoodDigest: "a".repeat(64), knownBadDigest: "b".repeat(64), seed: 7,
		ceilings: { timeoutMs: 30_000, maxCalls: 1, maxOutputTokensPerCall: 32, maxPatchBytes: 4096 },
	}
	// Hash the immutable source tree, not the live .git object database. Git's
	// automatic housekeeping may remove loose object directories at any time.
	const startSnapshot = path.join(tempRoot, "start-snapshot")
	await materializeBenchmarkSnapshot(task, repoRoot, startSnapshot)
	task.startDigest = await benchmarkTreeDigest(startSnapshot)
	await assert.rejects(fs.access(path.join(startSnapshot, ".git")), { code: "ENOENT" })
	git(repoRoot, ["-c", "gc.autoDetach=false", "gc", "--quiet"])
	const repackedSnapshot = path.join(tempRoot, "repacked-snapshot")
	await materializeBenchmarkSnapshot(task, repoRoot, repackedSnapshot)
	assert.equal(await benchmarkTreeDigest(repackedSnapshot), task.startDigest, "Git object repacking does not change the frozen source digest")
	const manifest = { schemaVersion: 1 as const, runnerVersion: "1.0.0", createdFromCommit: startCommit, tasks: [task] }
	const rawManifest = `${JSON.stringify(manifest)}\n`
	const loaded: LoadedBenchmark = { manifest, manifestDigest: sha256(rawManifest), fixtureRoot, repoRoot, rawManifest }
	let agentCalls = 0
	let verifierCalls = 0
	const verifierWorkspaces: string[] = []
	const agent: BenchmarkAgent = {
		provider: "synthetic-commit-test",
		async run(request: BenchmarkAgentRequest) {
			agentCalls += 1
			assert.equal(await fs.readFile(path.join(request.workspace, "src", "solution.js"), "utf8"), "export const answer = 1\n", "agent receives the exact commit-backed start tree")
			const candidate = path.join(tempRoot, `candidate-${agentCalls}`)
			git(process.cwd(), ["clone", "--quiet", "--no-hardlinks", "--shared", request.workspace, candidate])
			try {
				git(candidate, ["config", "user.name", "Synthetic benchmark agent"])
				git(candidate, ["config", "user.email", "synthetic-agent@invalid.example"])
				await fs.writeFile(path.join(candidate, "src", "solution.js"), "export const answer = 2\n")
				git(candidate, ["add", "--all"])
				git(candidate, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "synthetic agent patch"])
				const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "HEAD~1...HEAD"], { cwd: candidate, encoding: "buffer" })
				return { validity: "valid", patch, stdout: "synthetic agent result", stderr: "", calls: 1, tokens: 4, wallTimeMs: 10, stopReason: "synthetic-complete" }
			} finally {
				await fs.rm(candidate, { recursive: true, force: true })
			}
		},
	}
	const verifier: BenchmarkVerifier = {
		async run(_task, _root, workspace) {
			verifierCalls += 1
			verifierWorkspaces.push(workspace)
			return (await fs.readFile(path.join(workspace, "src", "solution.js"), "utf8")) === "export const answer = 2\n"
				? { success: true, output: "independent verifier accepted answer" }
				: { success: false, output: "answer mismatch" }
		},
	}
	const options = { loaded, agent, verifier, harnessCommit: startCommit, modelId: "synthetic-model", split: "development" as const, outputRoot, taskIds: [task.id] }
	const first = await runBenchmark(options)
	assert.equal(first.length, 1)
	assert.equal(first[0]?.verifiedSuccess, true)
	assert.equal(agentCalls, 1, "first attempt reaches the agent")
	assert.equal(verifierCalls, 1, "first attempt reaches the independent verifier")
	await assert.rejects(fs.access(verifierWorkspaces[0]!), { code: "ENOENT" }, "attempt workspace is cleaned after verification")

	const replayed = await runBenchmark(options)
	assert.deepEqual(replayed.map((attempt) => attempt.attemptId), first.map((attempt) => attempt.attemptId))
	assert.equal(agentCalls, 1, "durable replay does not call the agent again")
	assert.equal(verifierCalls, 2, "durable replay re-materializes the commit and reruns independent verification")
	await assert.rejects(fs.access(verifierWorkspaces[1]!), { code: "ENOENT" }, "replay workspace is cleaned after verification")
	console.log("Commit-backed RSI workspace first-attempt, verifier, replay, and cleanup checks passed")
} finally {
	await fs.rm(tempRoot, { recursive: true, force: true })
}
