import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runRsi } from "../controller.js"
import type { RsiConfig, TrialResult } from "../types.js"
import { withSyntheticEvaluatorPolicy } from "./synthetic-evaluator-runtime.js"

function result(command: string, ok: boolean): TrialResult {
	return { ok, command, exitCode: ok ? 0 : 1, durationMs: 1, stdout: "", stderr: "" }
}

async function main(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-campaign-scope-"))
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "rsi@example.invalid"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
		await fs.writeFile(path.join(repo, "candidate.py"), "def normalize(value):\n    return value\n")
		execFileSync("git", ["add", "."], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo })
		const config: RsiConfig = {
			repoRoot: repo, model: "fixture-model", population: 1, generations: 1, maxConcurrent: 1,
			mutationTask: "Improve only the fixture intake function", regressionCommand: "python3 -m unittest test_intake",
			evalCommands: ["python3 -m unittest test_intake"], hiddenEvalCommands: [],
			archiveDir: path.join(repo, ".archive"), worktreeDir: path.join(repo, ".worktrees"), baseRef: "HEAD",
			seed: "fixed-campaign-fixture", dryRun: false, keepWorktrees: true, maxIterations: 3,
			protectedPaths: ["test_intake.py", ".archive/", ".worktrees/"], allowedMutationPaths: ["candidate.py"],
			campaignScopedEvaluation: { planDigest: "a".repeat(64), fixtureDigest: "b".repeat(64), evaluatorDigest: "c".repeat(64), runtime: { imageName: "headlesscode-openshell-rsi:test", imageDigest: `sha256:${"d".repeat(64)}`, harnessCommit: "e".repeat(40), dependencyLockDigest: "f".repeat(64) }, objective: "intake-parsing", typecheckCommand: "python3 -c \"compile(open('candidate.py').read(), 'candidate.py', 'exec')\"" },
			maxRuntimeMs: 60_000, commandTimeoutMs: 10_000,
		}
		let benchmarkCalls = 0
		const commands: string[] = []
		const run = await withSyntheticEvaluatorPolicy(() => runRsi(config, {
			syntheticRuntimeIdentity: true,
			log: () => undefined,
			runCommand: async (command, cwd) => { commands.push(command); return result(command, !path.basename(cwd).startsWith("rsi-baseline-")) },
			runMutation: async (candidate) => {
				await fs.writeFile(path.join(candidate.worktree, "candidate.py"), "def normalize(value):\n    return value.strip()\n")
				execFileSync("git", ["add", "candidate.py"], { cwd: candidate.worktree })
				execFileSync("git", ["commit", "-qm", "candidate"], { cwd: candidate.worktree })
				return { ok: true, result: result("mutation", true) }
			},
			runDevelopmentBenchmark: async () => { benchmarkCalls++; throw new Error("generic HCL development proof must not run in campaign scope") },
		}))
		assert.equal(benchmarkCalls, 0)
		assert.ok(commands.every((command) => command !== "npm run typecheck"))
		assert.equal(commands.filter((command) => command === config.campaignScopedEvaluation!.typecheckCommand).length, 2)
		assert.equal(run.campaignScopedEvaluation?.eligibility, "paired-evaluation-only")
		assert.equal(run.developmentProofProtocol, undefined)
		assert.equal(run.candidates[0]?.pairedComparison?.improved, true)
		assert.equal(run.candidates[0]?.developmentProof, undefined)
		assert.equal(run.candidates[0]?.status, "accepted", JSON.stringify({ candidates: run.candidates.map(({ id, status, failure, fitness, pairedComparison }) => ({ id, status, failure, fitness, pairedComparison })) }))
		assert.equal(run.selected, undefined, "campaign-scoped improvement is not an automatic HCL selection")
		assert.deepEqual(run.selectedCandidates, [])
		console.log("Campaign-scoped RSI uses paired visible evaluation without HCL benchmark calls")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

main().catch((error) => { console.error(error); process.exit(1) })
