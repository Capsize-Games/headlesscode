import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { evaluateCandidate } from "../evaluator.js"
import type { RsiConfig, TrialResult } from "../types.js"

async function main(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-eval-"))
	try {
		await fs.writeFile(path.join(repo, "README.md"), "fixture\n")
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "rsi@example.invalid"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
		execFileSync("git", ["add", "README.md"], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo })
		const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		const calls: Array<{ command: string; cwd: string; env?: NodeJS.ProcessEnv }> = []
		const runner = async (command: string, cwd: string, _timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<TrialResult> => {
			calls.push({ command, cwd, env })
			return { ok: true, command, exitCode: 0, durationMs: 1, stdout: "", stderr: "" }
		}
		const config = {
			repoRoot: repo,
			model: "qwen",
			population: 1,
			generations: 1,
			maxConcurrent: 1,
		mutationTask: "fixture",
		regressionCommand: "npm test",
			evalCommands: ["visible-check"],
			hiddenEvalCommands: [],
			archiveDir: path.join(repo, "archive"),
			worktreeDir: path.join(repo, "worktrees"),
			baseRef: "HEAD",
			seed: "test",
			dryRun: false,
			keepWorktrees: false,
			maxIterations: 1,
			protectedPaths: [],
			commandTimeoutMs: 1000,
		} satisfies RsiConfig
		const summary = await evaluateCandidate(config, repo, base, runner)
		assert.equal(summary.hidden.length, 0)
		assert.equal(calls[0].command, "npm test")
		assert.equal(calls[1].command, "npm run typecheck")
		assert.equal(calls[2].command, "visible-check")
		assert.equal(calls[0].cwd, repo)
		assert.equal(calls[1].cwd, repo)
		assert.equal(calls[2].cwd, repo)
		assert.equal(summary.typecheck?.ok, true)
		await assert.rejects(evaluateCandidate({ ...config, hiddenEvalCommands: ["./scripts/eval-suite/hidden.sh"] }, repo, base, runner), /hidden evaluations require a supervisor-only evaluator service/)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
	console.log("All 3 RSI evaluator assertions passed")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
