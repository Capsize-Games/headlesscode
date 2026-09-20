import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { checkpointRun, readArchive } from "../archive.js"
import { runRsi } from "../controller.js"
import { newCandidate, resolveBaseCommit } from "../workspace.js"
import type { RsiConfig, RsiRunRecord, TrialResult } from "../types.js"

function ok(command: string): TrialResult {
	return { ok: true, command, exitCode: 0, durationMs: 1, stdout: "", stderr: "" }
}

async function main(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-resume-"))
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "rsi@example.invalid"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
		await fs.writeFile(path.join(repo, "README.md"), "fixture\n")
		execFileSync("git", ["add", "."], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo })
		const config = {
			repoRoot: repo,
			model: "qwen",
			population: 1,
			generations: 1,
			maxConcurrent: 1,
			mutationTask: "resume fixture",
			evalCommands: [],
			hiddenEvalCommands: [],
			archiveDir: path.join(repo, "archive"),
			worktreeDir: path.join(repo, "worktrees"),
			baseRef: "HEAD",
			seed: "resume",
			dryRun: false,
			keepWorktrees: false,
			maxIterations: 1,
			protectedPaths: [],
			commandTimeoutMs: 1000,
		} satisfies RsiConfig
		const baseCommit = await resolveBaseCommit(config)
		const candidate = newCandidate(config, 0, 0, baseCommit, "now")
		const interrupted: RsiRunRecord = {
			runId: "resume-fixture",
			startedAt: "now",
			model: "qwen",
			baseRef: "HEAD",
			baseCommit,
			generations: 1,
			candidates: [candidate],
			reports: [],
		}
		await checkpointRun(config.archiveDir, interrupted)
		const resumed = await runRsi({ ...config, resumeRunId: "resume-fixture" }, {
			log: () => undefined,
			runCommand: async (command) => ok(command),
			runMutation: async (entry) => {
				await fs.writeFile(path.join(entry.worktree, "resumed.txt"), "resumed\n")
				execFileSync("git", ["add", "resumed.txt"], { cwd: entry.worktree })
				execFileSync("git", ["commit", "-qm", "resume"], { cwd: entry.worktree })
				return { ok: true, result: ok("mutation") }
			},
		})
		assert.equal(resumed.runId, "resume-fixture")
		assert.equal(resumed.candidates[0].status, "accepted")
		const archive = await readArchive(config.archiveDir)
		assert.equal(archive.activeRuns.length, 0)
		assert.equal(archive.runs[0]?.runId, "resume-fixture")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
	console.log("All 4 RSI resume assertions passed")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
