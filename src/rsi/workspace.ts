import { execFile as execFileCallback } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"
import { modelCombinationId } from "./models.js"
import type { CandidateRecord, RsiConfig } from "./types.js"
import type { ParentChoice } from "./selection.js"

const execFile = promisify(execFileCallback)

export function candidateId(generation: number, index: number, seed: string): string {
	const cleanSeed = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run"
	return `g${generation}-c${String(index + 1).padStart(2, "0")}-${cleanSeed.slice(0, 20)}`
}

export function candidateBranch(id: string): string {
	return `rsi/${id}`
}

export function candidateWorktree(config: RsiConfig, id: string): string {
	return path.join(config.worktreeDir, id)
}

export async function gitOutput(repoRoot: string, args: string[]): Promise<string> {
	const result = await execFile("git", args, { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 })
	return result.stdout.trim()
}

export async function resolveBaseCommit(config: RsiConfig): Promise<string> {
	return gitOutput(config.repoRoot, ["rev-parse", `${config.baseRef}^{commit}`])
}

export function newCandidate(
	config: RsiConfig,
	generation: number,
	index: number,
	baseCommit: string,
	now: string,
	parentChoice?: ParentChoice,
): CandidateRecord {
	const id = candidateId(generation, index, config.seed)
	const modelCandidateId = config.modelCandidateId ?? "model-base"
	return {
		id,
		generation,
		parent: parentChoice?.candidateId ?? (generation === 0 ? "baseline" : "champion"),
		branch: candidateBranch(id),
		worktree: candidateWorktree(config, id),
		baseCommit,
		status: "planned",
		model: config.model,
		mutation: config.mutationTask,
		createdAt: now,
		updatedAt: now,
		commits: [],
		changedFiles: [],
		protectedPathViolations: [],
		mutationKind: config.mutationKind ?? "corrective",
		hypothesis: config.hypothesis,
		parentSelection: parentChoice?.reason ?? (generation === 0 ? { strategy: "baseline", reason: "initial base ref" } : undefined),
		parentCommit: parentChoice?.baseCommit ?? baseCommit,
		modelCandidateId,
		combinationId: modelCombinationId(id, modelCandidateId),
	}
}

export async function createCandidateWorktree(config: RsiConfig, candidate: CandidateRecord): Promise<void> {
	await fs.mkdir(config.worktreeDir, { recursive: true })
	await execFile("git", ["worktree", "add", "-b", candidate.branch, candidate.worktree, candidate.baseCommit], {
		cwd: config.repoRoot,
		maxBuffer: 4 * 1024 * 1024,
	})
}

export async function removeCandidateWorktree(config: RsiConfig, candidate: CandidateRecord): Promise<void> {
	await execFile("git", ["worktree", "remove", "--force", candidate.worktree], {
		cwd: config.repoRoot,
		maxBuffer: 4 * 1024 * 1024,
	})
}

export async function changedFiles(repoRoot: string, baseCommit: string): Promise<string[]> {
	const output = await gitOutput(repoRoot, ["diff", "--name-only", `${baseCommit}...HEAD`])
	const status = await gitOutput(repoRoot, ["status", "--short"])
	const files = new Set(output.split("\n").map((file) => file.trim()).filter(Boolean))
	for (const line of status.split("\n")) {
		const file = line.slice(3).trim()
		if (file) files.add(file)
	}
	return [...files].sort()
}

export async function candidateCommits(repoRoot: string, baseCommit: string): Promise<string[]> {
	const output = await gitOutput(repoRoot, ["log", "--format=%H", `${baseCommit}..HEAD`])
	return output.split("\n").map((commit) => commit.trim()).filter(Boolean)
}
