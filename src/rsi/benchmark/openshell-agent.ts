import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { parseRsiArgs } from "../config.js"
import { runOpenShellMutation } from "../openshell.js"
import type { CandidateRecord } from "../types.js"
import { runOpenShellBenchmarkVerifier } from "../openshell.js"
import type { BenchmarkAgent, BenchmarkAgentRequest, BenchmarkAgentResult, BenchmarkImageIdentity } from "./types.js"
import type { BenchmarkTask } from "./types.js"
import type { BenchmarkVerifier } from "./runner.js"

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

export async function initializeTaskRepository(root: string): Promise<string> {
	git(root, ["init", "--quiet", "--initial-branch=main"])
	git(root, ["config", "user.name", "HeadlessCode Benchmark"])
	git(root, ["config", "user.email", "benchmark@invalid.example"])
	git(root, ["add", "--all"])
	git(root, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "benchmark starting snapshot"])
	return git(root, ["rev-parse", "HEAD"])
}

export class OpenShellBenchmarkAgent implements BenchmarkAgent {
	readonly provider = "openshell-ollama"
	private readonly harnessRoot: string
	private cachedImageIdentity?: BenchmarkImageIdentity
	constructor(harnessRoot = process.cwd()) { this.harnessRoot = path.resolve(harnessRoot) }

	async imageIdentity(harnessCommit: string): Promise<BenchmarkImageIdentity> {
		const name = "headlesscode-openshell-rsi:local"
		const digest = execFileSync("docker", ["image", "inspect", "--format={{.Id}}", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
		if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`OpenShell benchmark worker image has an invalid Docker image ID: ${digest}`)
		const marker = execFileSync("docker", ["run", "--rm", "--entrypoint", "/bin/cat", name, "/opt/headlesscode/.headlesscode-harness-commit"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
		if (marker !== harnessCommit) throw new Error(`OpenShell worker image harness marker ${marker} does not match requested commit ${harnessCommit}`)
		const identity = { name, digest, harnessCommit: marker }
		if (this.cachedImageIdentity && JSON.stringify(this.cachedImageIdentity) !== JSON.stringify(identity)) throw new Error("OpenShell benchmark worker image changed after its identity was frozen")
		this.cachedImageIdentity = identity
		return identity
	}

	async run(request: BenchmarkAgentRequest): Promise<BenchmarkAgentResult> {
		const checkout = git(this.harnessRoot, ["rev-parse", "HEAD"])
		if (checkout !== request.harnessCommit) throw new Error(`benchmark harness checkout ${checkout} does not match requested commit ${request.harnessCommit}`)
		if (process.env.HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT !== request.harnessCommit) throw new Error("HEADLESSCODE_RSI_BENCHMARK_HARNESS_COMMIT must identify the harness commit baked into the OpenShell image")
		const image = await this.imageIdentity(request.harnessCommit)
		const privateWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), `headlesscode-benchmark-agent-${request.taskId}-`))
		await fs.rmdir(privateWorkspace)
		execFileSync("git", ["clone", "--quiet", "--no-hardlinks", "--shared", request.workspace, privateWorkspace], { stdio: ["ignore", "pipe", "pipe"] })
		const baseCommit = git(privateWorkspace, ["rev-parse", "HEAD"])
		const parsed = parseRsiArgs(["--repo", this.harnessRoot, "--model", request.model.id, "--max-iterations", String(request.ceilings.maxCalls), "--timeout-ms", String(request.ceilings.timeoutMs), "--max-tokens", String(request.ceilings.maxOutputTokensPerCall)])
		if (!parsed.config || parsed.error) throw new Error(parsed.error ?? "could not construct OpenShell benchmark configuration")
		parsed.config.benchmarkHarnessCommit = request.harnessCommit
		const candidate: CandidateRecord = {
			id: request.taskId,
			generation: 0,
			parent: "benchmark-baseline",
			branch: `benchmark-${request.taskId}`,
			worktree: privateWorkspace,
			baseCommit,
			status: "mutating",
			model: request.model.id,
			mutation: request.task,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			commits: [],
			changedFiles: [],
			protectedPathViolations: [],
		}
		const started = Date.now()
		try {
			const outcome = await runOpenShellMutation(candidate, parsed.config, undefined, image.digest)
			const elapsed = Date.now() - started
			if (!outcome.ok) {
				const reason = outcome.error ?? outcome.result?.stderr ?? "OpenShell mutation failed"
				const validity = outcome.patchRejected ? "patch-error" : outcome.result?.timedOut ? "timeout" : "agent-error"
				return { validity, stdout: outcome.result?.stdout ?? "", stderr: reason, calls: outcome.calls ?? null, tokens: outcome.tokens ?? null, wallTimeMs: elapsed, stopReason: validity }
			}
			const patch = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "--no-renames", `${baseCommit}...HEAD`], { cwd: privateWorkspace, encoding: "buffer", maxBuffer: request.ceilings.maxPatchBytes + 1 }) as Buffer
			if (patch.byteLength > request.ceilings.maxPatchBytes) return { validity: "malformed", stdout: outcome.result?.stdout ?? "", stderr: "patch exceeded the task byte ceiling", calls: outcome.calls ?? null, tokens: outcome.tokens ?? null, wallTimeMs: elapsed, stopReason: "patch-limit" }
			return { validity: "valid", patch, stdout: outcome.result?.stdout ?? "", stderr: outcome.result?.stderr ?? "", calls: outcome.calls ?? null, tokens: outcome.tokens ?? null, wallTimeMs: elapsed, stopReason: "agent-complete" }
		} finally { await fs.rm(privateWorkspace, { recursive: true, force: true }) }
	}
}

export class OpenShellBenchmarkVerifier implements BenchmarkVerifier {
	private readonly harnessRoot: string
	private cachedImageIdentity?: BenchmarkImageIdentity
	constructor(harnessRoot = process.cwd()) { this.harnessRoot = path.resolve(harnessRoot) }

	async imageIdentity(harnessCommit: string): Promise<BenchmarkImageIdentity> {
		const name = "headlesscode-openshell-rsi:local"
		const digest = execFileSync("docker", ["image", "inspect", "--format={{.Id}}", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
		if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`OpenShell verifier image has an invalid Docker image ID: ${digest}`)
		const marker = execFileSync("docker", ["run", "--rm", "--entrypoint", "/bin/cat", name, "/opt/headlesscode/.headlesscode-harness-commit"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
		if (marker !== harnessCommit) throw new Error(`OpenShell verifier image harness marker ${marker} does not match checkout commit ${harnessCommit}`)
		const identity = { name, digest, harnessCommit: marker }
		if (this.cachedImageIdentity && JSON.stringify(this.cachedImageIdentity) !== JSON.stringify(identity)) throw new Error("OpenShell verifier image changed during oracle qualification")
		this.cachedImageIdentity = identity
		return identity
	}

	async run(task: BenchmarkTask, fixtureRoot: string, workspace: string): Promise<{ success: boolean; output: string }> {
		const harnessCommit = git(this.harnessRoot, ["rev-parse", "HEAD"])
		const image = await this.imageIdentity(harnessCommit)
		const verifierPath = path.resolve(fixtureRoot, task.verifierPath)
		if (!verifierPath.startsWith(path.resolve(fixtureRoot) + path.sep)) throw new Error(`verifier escaped fixture root for ${task.id}`)
		const verifier = await fs.readFile(verifierPath)
		if (createHash("sha256").update(verifier).digest("hex") !== task.verifierDigest) throw new Error(`verifier digest changed after manifest load: ${task.id}`)
		const baseCommit = git(workspace, ["rev-parse", "HEAD"])
		const parsed = parseRsiArgs(["--repo", this.harnessRoot, "--regression", "true", "--max-runtime-ms", String(task.ceilings.timeoutMs)])
		if (!parsed.config || parsed.error) throw new Error(parsed.error ?? "could not construct benchmark verifier configuration")
		parsed.config.commandTimeoutMs = task.ceilings.timeoutMs
		const candidate: CandidateRecord = {
			id: `verify-${task.id}`, generation: 0, parent: "benchmark-candidate", branch: `benchmark-${task.id}`,
			worktree: workspace, baseCommit, status: "evaluating", model: "supervisor-verifier", mutation: task.task,
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), commits: [], changedFiles: [], protectedPathViolations: [],
		}
		const result = await runOpenShellBenchmarkVerifier(candidate, parsed.config, verifier, task.id, undefined, image.digest)
		return { success: result.ok, output: `${result.stdout}${result.stderr}`.slice(0, 16_384) }
	}
}
