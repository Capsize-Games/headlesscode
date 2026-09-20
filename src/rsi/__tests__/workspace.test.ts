import assert from "node:assert/strict"
import * as path from "node:path"
import { candidateBranch, candidateId, candidateWorktree, newCandidate } from "../workspace.js"
import type { RsiConfig } from "../types.js"

const config: RsiConfig = {
	repoRoot: "/tmp/repo",
	model: "wxrq-qwen3.5-9b:latest",
	population: 2,
	generations: 1,
	maxConcurrent: 1,
	mutationTask: "fixture",
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

testStableNames()
testLineageMetadata()
console.log("All 2 RSI workspace tests passed")
