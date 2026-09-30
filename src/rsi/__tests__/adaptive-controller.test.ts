import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { runRsi as runRsiImplementation } from "../controller.js"
import type { RsiConfig, RsiHooks, RsiRunRecord, TrialResult } from "../types.js"
import { fakeDevelopmentBenchmarkHook } from "./development-proof-fixture.js"

function runRsi(config: RsiConfig, hooks: RsiHooks = {}): Promise<RsiRunRecord> {
	return runRsiImplementation(config, { runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook(), ...hooks })
}

function trial(command: string, ok: boolean): TrialResult {
	return { command, ok, exitCode: ok ? 0 : 1, durationMs: 1, stdout: "", stderr: "" }
}

test("hook-level controller evaluates an independent cohort then allocates an evidence-driven follow-up", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-adaptive-"))
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "rsi@example.invalid"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
		await fs.mkdir(path.join(repo, "src"), { recursive: true })
		await fs.writeFile(path.join(repo, "src", "agent.ts"), "export const baseline = true\n")
		execFileSync("git", ["add", "."], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo })
		const config = {
			repoRoot: repo, model: "local", population: 2, generations: 1, maxConcurrent: 2,
			mutationTask: "adaptive fixture", regressionCommand: "regression", evalCommands: ["visible"],
			hiddenEvalCommands: [], archiveDir: path.join(repo, ".rsi-archive"), worktreeDir: path.join(repo, ".rsi-worktrees"),
			trajectoryDir: path.join(repo, ".rsi-trajectories"), curriculumDir: path.join(repo, ".rsi-curriculum"),
			baseRef: "HEAD", seed: "adaptive-test", dryRun: false, keepWorktrees: false, maxIterations: 2,
			maxTrajectories: 3, maxTotalIterations: 6, maxRuntimeMs: 1_000_000_000,
			computePolicy: "adaptive-independent", protectedPaths: [], commandTimeoutMs: 1000,
		} satisfies RsiConfig
		const run = await runRsi(config, {
			log: () => undefined,
			runCommand: async (command, cwd) => {
				if (command === "regression") return trial(command, true)
				if (cwd.includes("rsi-baseline-")) return trial(command, false)
				return trial(command, path.basename(cwd).includes("c01-") || path.basename(cwd).includes("c03-"))
			},
			runMutation: async (candidate) => {
				await fs.writeFile(path.join(candidate.worktree, "src", `${candidate.id}.ts`), `export const id = ${JSON.stringify(candidate.id)}\n`)
				execFileSync("git", ["add", "."], { cwd: candidate.worktree })
				execFileSync("git", ["commit", "-qm", `candidate ${candidate.id}`], { cwd: candidate.worktree })
				return { ok: true, result: trial("mutation", true) }
			},
		})
		assert.equal(run.generations, 2, "one configured adaptive generation is one follow-up after the initial cohort")
		assert.equal(run.candidates.length, 3)
		assert.equal(run.candidates.filter((candidate) => candidate.generation === 0).length, 2)
		assert.equal(run.candidates.filter((candidate) => candidate.generation === 1).length, 1)
		assert.equal(run.adaptiveSearch?.[0]?.decision, "continue")
		assert.equal(run.adaptiveSearch?.[0]?.reason, "mixed-evidence")
		assert.equal(run.adaptiveSearch?.[0]?.allocatedTrajectories, 2)
		assert.equal(run.adaptiveSearch?.[1]?.allocatedTrajectories, 3)
		assert.equal(run.reports.length, 1)
		const report = await fs.readFile(run.reports[0]!, "utf8")
		assert.match(report, /Adaptive allocation decisions/)
		assert.match(report, /mixed-evidence/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
})
