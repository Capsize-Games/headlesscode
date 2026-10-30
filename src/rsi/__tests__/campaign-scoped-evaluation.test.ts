import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runRsi } from "../controller.js"
import type { RsiConfig, RsiHooks, TrialResult } from "../types.js"
import { withSyntheticEvaluatorPolicy } from "./synthetic-evaluator-runtime.js"

function result(command: string, ok: boolean): TrialResult {
	return {
		ok, command, exitCode: ok ? 0 : 1, durationMs: 1, stdout: "", stderr: "",
	}
}

async function main(): Promise<void> {
	const repo = await initRepo()
	try {
		const config = scopedConfig(repo)
		const commands: string[] = []
		const { run, benchmarkCalls } = await executeScopedCampaign(config, commands)
		assertNoBenchmarkSelection(run, commands, config, benchmarkCalls)
		assertScopedOutcome(run, config)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function initRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-campaign-scope-"))
	execFileSync("git", ["init", "-q"], { cwd: repo })
	execFileSync(
		"git",
		["config", "user.email", "rsi@example.invalid"],
		{ cwd: repo },
	)
	execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
	await fs.writeFile(path.join(repo, "candidate.py"), fixtureCandidate())
	execFileSync("git", ["add", "."], { cwd: repo })
	execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo })
	return repo
}

function fixtureCandidate(): string {
	return "def normalize(value):\n    return value\n"
}

function scopedConfig(repo: string): RsiConfig {
	return {
		repoRoot: repo,
		...fixedCampaignFields(),
		population: 1,
		generations: 1,
		maxConcurrent: 1,
		evalCommands: ["python3 -m unittest test_intake"],
		hiddenEvalCommands: [],
		...scopedPaths(repo),
		maxIterations: 3,
		campaignScopedEvaluation: evaluationScope(),
		maxRuntimeMs: 60_000,
		commandTimeoutMs: 10_000,
	}
}

function fixedCampaignFields(): {
	model: string
	mutationTask: string
	regressionCommand: string
	baseRef: string
	seed: string
	dryRun: boolean
	keepWorktrees: boolean
} {
	return {
		model: "fixture-model",
		mutationTask: "Improve only the fixture intake function",
		regressionCommand: "python3 -m unittest test_intake",
		baseRef: "HEAD",
		seed: "fixed-campaign-fixture",
		dryRun: false,
		keepWorktrees: true,
	}
}

function scopedPaths(
	repo: string,
): Pick<
	RsiConfig,
	"archiveDir" | "worktreeDir" | "protectedPaths" | "allowedMutationPaths"
> {
	return {
		archiveDir: path.join(repo, ".archive"),
		worktreeDir: path.join(repo, ".worktrees"),
		protectedPaths: ["test_intake.py", ".archive/", ".worktrees/"],
		allowedMutationPaths: ["candidate.py"],
	}
}

function evaluationScope(): NonNullable<RsiConfig["campaignScopedEvaluation"]> {
	return {
		planDigest: "a".repeat(64),
		fixtureDigest: "b".repeat(64),
		evaluatorDigest: "c".repeat(64),
		runtime: {
			imageName: "headlesscode-openshell-rsi:test",
			imageDigest: `sha256:${"d".repeat(64)}`,
			harnessCommit: "e".repeat(40),
			dependencyLockDigest: "f".repeat(64),
		},
		objective: "intake-parsing",
		typecheckCommand:
			"python3 -c \"compile(open('candidate.py').read(), " +
			"'candidate.py', 'exec')\"",
	}
}

async function executeScopedCampaign(
	config: RsiConfig,
	commands: string[],
): Promise<{
	run: Awaited<ReturnType<typeof runRsi>>
	benchmarkCalls: number
}> {
	const calls = { count: 0 }
	const run = await withSyntheticEvaluatorPolicy(
		() => runRsi(config, scopedHooks(commands, calls)),
	)
	return { run, benchmarkCalls: calls.count }
}

function scopedHooks(commands: string[], calls: { count: number }): RsiHooks {
	return {
		syntheticRuntimeIdentity: true,
		log: () => undefined,
		runCommand: recordingRunCommand(commands),
		runMutation: mutateFixture,
		runDevelopmentBenchmark: failingBenchmark(calls),
	}
}

function failingBenchmark(calls: { count: number }): () => Promise<never> {
	return async () => {
		calls.count++
		throw campaignScopeError()
	}
}

function campaignScopeError(): never {
	throw new Error("generic HCL development proof must not run in campaign scope")
}

function recordingRunCommand(
	commands: string[],
): (command: string, cwd: string) => Promise<TrialResult> {
	return async (command, cwd) => {
		commands.push(command)
		return result(command, !path.basename(cwd).startsWith("rsi-baseline-"))
	}
}

async function mutateFixture(candidate: {
	worktree: string
}): Promise<{ ok: boolean; result: TrialResult }> {
	await fs.writeFile(
		path.join(candidate.worktree, "candidate.py"),
		"def normalize(value):\n    return value.strip()\n",
	)
	execFileSync("git", ["add", "candidate.py"], { cwd: candidate.worktree })
	execFileSync("git", ["commit", "-qm", "candidate"], {
		cwd: candidate.worktree,
	})
	return { ok: true, result: result("mutation", true) }
}

function assertNoBenchmarkSelection(
	run: Awaited<ReturnType<typeof runRsi>>,
	commands: string[],
	config: RsiConfig,
	benchmarkCalls: number,
): void {
	assert.equal(benchmarkCalls, 0)
	assert.ok(commands.every((command) => command !== "npm run typecheck"))
	assert.equal(typecheckRuns(commands, config), 2)
	assert.equal(run.developmentProofProtocol, undefined)
}

function typecheckRuns(commands: string[], config: RsiConfig): number {
	return commands.filter(
		(command) => command === config.campaignScopedEvaluation!.typecheckCommand,
	).length
}

function assertScopedOutcome(
	run: Awaited<ReturnType<typeof runRsi>>,
	config: RsiConfig,
): void {
	assert.equal(
		run.campaignScopedEvaluation?.eligibility,
		"paired-evaluation-only",
	)
	assertCandidateAccepted(run)
	assert.equal(
		run.selected,
		undefined,
		"campaign-scoped improvement is not an automatic HCL selection",
	)
	assert.deepEqual(run.selectedCandidates, [])
	console.log("Campaign-scoped RSI uses paired visible evaluation")
}

function assertCandidateAccepted(
	run: Awaited<ReturnType<typeof runRsi>>,
): void {
	assert.equal(run.candidates[0]?.pairedComparison?.improved, true)
	assert.equal(run.candidates[0]?.developmentProof, undefined)
	assert.equal(
		run.candidates[0]?.status,
		"accepted",
		JSON.stringify(candidateSummary(run)),
	)
}

function candidateSummary(
	run: Awaited<ReturnType<typeof runRsi>>,
): unknown {
	return run.candidates.map(
		({ id, status, failure, fitness, pairedComparison }) => ({
			id,
			status,
			failure,
			fitness,
			pairedComparison,
		}),
	)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
