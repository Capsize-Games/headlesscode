import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { readArchive } from "../archive.js"
import { runRsi } from "../controller.js"
import type { RsiConfig, TrialResult } from "../types.js"

function ok(command: string): TrialResult {
	return { ok: true, command, exitCode: 0, durationMs: 1, stdout: "", stderr: "" }
}

async function main(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-controller-"))
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "rsi@example.invalid"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
		await fs.mkdir(path.join(repo, "src"), { recursive: true })
		await fs.writeFile(path.join(repo, "src", "agent.ts"), "export const baseline = true\n")
		execFileSync("git", ["add", "."], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo })
		const config = {
			repoRoot: repo,
			model: "wxrq-qwen3.5-9b:latest",
			population: 2,
			generations: 2,
			maxConcurrent: 1,
			mutationTask: "fixture evolution",
			evalCommands: ["visible"],
			hiddenEvalCommands: ["hidden"],
			archiveDir: path.join(repo, ".rsi-archive"),
			worktreeDir: path.join(repo, ".rsi-worktrees"),
			trajectoryDir: path.join(repo, ".rsi-trajectories"),
			curriculumDir: path.join(repo, ".rsi-curriculum"),
			baseRef: "HEAD",
			seed: "controller-test",
			dryRun: false,
			keepWorktrees: false,
			maxIterations: 2,
			protectedPaths: [".env", ".rsi-archive/", ".rsi-worktrees/"],
			commandTimeoutMs: 1000,
		} satisfies RsiConfig
		const run = await runRsi(config, {
			now: (() => {
				let tick = 0
				return () => `2026-09-20T00:00:${String(tick++).padStart(2, "0")}.000Z`
			})(),
			log: () => undefined,
			runCommand: async (command) => ok(command),
			runMutation: async (candidate) => {
				const file = path.join(candidate.worktree, "src", `${candidate.id}.ts`)
				await fs.writeFile(file, `export const candidate = ${JSON.stringify(candidate.id)}\n`)
				execFileSync("git", ["add", "."], { cwd: candidate.worktree })
				execFileSync("git", ["commit", "-qm", `candidate ${candidate.id}`], { cwd: candidate.worktree })
				return { ok: true, result: ok("mutation") }
			},
		})
		assert.equal(run.candidates.length, 4)
		assert.ok(run.candidates.filter((candidate) => candidate.generation === 1).every((candidate) => candidate.parent !== "baseline"))
		assert.equal(run.combinations?.length, 4)
		assert.equal(run.jobs?.filter((job) => job.status === "completed").length, 4)
		assert.ok(run.selected)
		const archive = await readArchive(config.archiveDir)
		assert.equal(archive.activeRuns.length, 0)
		assert.equal(archive.runs.length, 1)
		assert.equal(archive.candidates.length, 4)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
	console.log("All 7 RSI controller assertions passed")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
