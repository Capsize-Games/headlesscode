import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { OpenShellBenchmarkAgent, OpenShellBenchmarkVerifier } from "./benchmark/openshell-agent.js"
import { resolveRsiEvaluatorPolicySha256 } from "./openshell.js"
import { freezeBenchmarkProtocol, loadBenchmark, runBenchmark } from "./benchmark/runner.js"
import type { BenchmarkAttempt, BenchmarkImageIdentity, BenchmarkSplit } from "./benchmark/types.js"
import type { RunBenchmarkOptions } from "./benchmark/runner.js"

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const builtImages = new Set<string>()

function git(repoRoot: string, args: string[]): string {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

export function benchmarkImageTag(commit: string): string {
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("benchmark image requires a full commit SHA")
	return `headlesscode-openshell-rsi:${commit}`
}

function buildCommitImage(repoRoot: string, commit: string): BenchmarkImageIdentity {
	const tag = benchmarkImageTag(commit)
	const key = `${path.resolve(repoRoot)}:${commit}`
	if (!builtImages.has(key)) {
		if (path.resolve(repoRoot) !== moduleRoot) throw new Error("RSI development benchmark image builds require the HeadlessCode repository as the candidate source")
		const cli = path.join(moduleRoot, "node_modules", "tsx", "dist", "cli.mjs")
		const script = path.join(moduleRoot, "scripts", "rsi-benchmark", "build-image.mjs")
		execFileSync(process.execPath, [cli, script, commit, "--commit-context"], { cwd: repoRoot, stdio: "inherit", maxBuffer: 32 * 1024 * 1024 })
		builtImages.add(key)
	}
	const digest = execFileSync("docker", ["image", "inspect", "--format={{.Id}}", tag], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
	if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`benchmark image has an invalid Docker image ID: ${tag}`)
	const marker = execFileSync("docker", ["run", "--rm", "--entrypoint", "/bin/cat", tag, "/opt/headlesscode/.headlesscode-harness-commit"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
	if (marker !== commit) throw new Error(`benchmark image ${tag} has harness marker ${marker}, expected ${commit}`)
	return { name: tag, digest, harnessCommit: marker }
}

async function withCommitWorktree<T>(repoRoot: string, commit: string, action: (worktree: string) => Promise<T>): Promise<T> {
	const worktree = await fs.mkdtemp(path.join(os.tmpdir(), `headlesscode-rsi-harness-${commit.slice(0, 8)}-`))
	await fs.rm(worktree, { recursive: true, force: true })
	execFileSync("git", ["worktree", "add", "--detach", worktree, commit], { cwd: repoRoot, stdio: "pipe" })
	try {
		if (git(worktree, ["rev-parse", "HEAD"]) !== commit || git(worktree, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("benchmark harness worktree is not a clean exact commit")
		return await action(worktree)
	} finally {
		try { execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot, stdio: "pipe" }) }
		finally { await fs.rm(worktree, { recursive: true, force: true }) }
	}
}

export async function runDevelopmentBenchmarkForCommit(args: {
	repoRoot: string
	fixturesRoot: string
	outputRoot: string
	harnessCommit: string
	model: string
	provider?: "openshell-ollama" | "openshell-openrouter"
	campaignId?: string
	inferenceLedgerPath?: string
	attemptNamespace?: string
	evaluatorPolicySha256?: string
	split?: BenchmarkSplit
	attemptLifecycle?: RunBenchmarkOptions["attemptLifecycle"]
}): Promise<BenchmarkAttempt[]> {
	const repoRoot = path.resolve(args.repoRoot)
	const loaded = await loadBenchmark(args.fixturesRoot, repoRoot)
	const agentImage = buildCommitImage(repoRoot, args.harnessCommit)
	const verifierCommit = git(repoRoot, ["rev-parse", "HEAD"])
	const verifierImage = buildCommitImage(repoRoot, verifierCommit)
	return await withCommitWorktree(repoRoot, args.harnessCommit, async (harnessRoot) => {
		const agent = new OpenShellBenchmarkAgent(harnessRoot, undefined, agentImage.name, args.harnessCommit, undefined, args.provider ?? "openshell-ollama")
		const evaluatorPolicySha256 = args.evaluatorPolicySha256 ?? await resolveRsiEvaluatorPolicySha256()
		const verifier = new OpenShellBenchmarkVerifier(repoRoot, undefined, verifierImage.name, evaluatorPolicySha256)
		const split = args.split ?? "development"
		const outputRoot = path.join(args.outputRoot, "harness", args.harnessCommit)
		if (split === "confirmation") {
			try { await fs.access(path.join(outputRoot, "frozen-protocol.json")) }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				await freezeBenchmarkProtocol({ loaded, harnessCommit: args.harnessCommit, agentImageIdentity: agentImage, modelId: args.model, outputRoot, sampling: { temperature: 0, think: false, seed: "provider-default" }, provider: agent.provider })
			}
		}
		return await runBenchmark({
			loaded,
			agent,
			verifier,
			harnessCommit: args.harnessCommit,
			agentImageIdentity: agentImage,
			modelId: args.model,
			sampling: { temperature: 0, think: false, seed: "provider-default" },
			split,
			...(split === "confirmation" ? { confirmProtocol: true } : {}),
			outputRoot,
			...(args.campaignId ? { inferenceCampaignId: args.campaignId } : {}),
			inferenceLedgerPath: args.inferenceLedgerPath ?? path.join(args.outputRoot, "openrouter-inference-ledger.json"),
			...(args.attemptNamespace ? { attemptNamespace: args.attemptNamespace } : {}),
			...(args.attemptLifecycle ? { attemptLifecycle: args.attemptLifecycle } : {}),
		})
	})
}
