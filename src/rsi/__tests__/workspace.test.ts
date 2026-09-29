import assert from "node:assert/strict"
import * as path from "node:path"
import { candidateBranch, candidateId, candidateWorktree, changedFiles, newCandidate } from "../workspace.js"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import type { RsiConfig } from "../types.js"

const config: RsiConfig = {
	repoRoot: "/tmp/repo",
	model: "wxrq-qwen3.5-9b:latest",
	population: 2,
	generations: 1,
	maxConcurrent: 1,
		mutationTask: "fixture",
		regressionCommand: "npm test",
	evalCommands: [],
	hiddenEvalCommands: [],
	archiveDir: "/tmp/repo/.headlesscode/rsi",
	worktreeDir: "/tmp/repo/.worktrees/rsi",
	baseRef: "HEAD",
	seed: "night run",
	dryRun: false,
	keepWorktrees: false,
	maxIterations: 40,
	protectedPaths: [],
	commandTimeoutMs: 1000,
}

function testStableNames(): void {
	const id = candidateId(0, 1, config.seed)
	assert.equal(id, "g0-c02-night-run")
	assert.equal(candidateBranch(id), "rsi/g0-c02-night-run")
	assert.equal(candidateWorktree(config, id), path.join(config.worktreeDir, id))
}

function testLineageMetadata(): void {
	const candidate = newCandidate(config, 2, 0, "abc123", "2026-09-19T20:00:00.000Z")
	assert.equal(candidate.parent, "champion")
	assert.equal(candidate.baseCommit, "abc123")
	assert.equal(candidate.status, "planned")
}

async function testPorcelainStatusPreservesFilenameAndSpaces(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-paths-"))
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "rsi@example.invalid"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
		await fs.mkdir(path.join(repo, "scripts"), { recursive: true })
		await fs.writeFile(path.join(repo, "scripts", "check.cjs"), "base\n")
		execFileSync("git", ["add", "."], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "base"], { cwd: repo })
		const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		await fs.writeFile(path.join(repo, "scripts", "check.cjs"), "changed\n")
		await fs.writeFile(path.join(repo, "untracked file.txt"), "new\n")
		assert.deepEqual(await changedFiles(repo, base), ["scripts/check.cjs", "untracked file.txt"])
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

testStableNames()
testLineageMetadata()
await testPorcelainStatusPreservesFilenameAndSpaces()
console.log("All 3 RSI workspace tests passed")
