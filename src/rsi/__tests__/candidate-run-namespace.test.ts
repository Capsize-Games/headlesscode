import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { checkpointRun, readArchive, writeArchive } from "../archive.js"
import { runRsi } from "../controller.js"
import { candidateBranch, candidateId, candidateWorktree, createCandidateWorktree } from "../workspace.js"
import type { RsiConfig } from "../types.js"
import { fakeDevelopmentBenchmarkHook } from "./development-proof-fixture.js"

const scratch = path.resolve(".headlesscode/scratch")
process.env.TMPDIR = scratch
process.env.GIT_CEILING_DIRECTORIES = scratch

async function initializeRepository(root: string): Promise<{ repo: string; baseCommit: string }> {
	const repo = path.join(root, "repo")
	await fs.mkdir(path.join(repo, "src"), { recursive: true })
	execFileSync("git", ["init", "-q"], { cwd: repo })
	execFileSync("git", ["config", "user.email", "rsi-namespace@example.invalid"], { cwd: repo })
	execFileSync("git", ["config", "user.name", "RSI namespace fixture"], { cwd: repo })
	await fs.writeFile(path.join(repo, "src", "baseline.ts"), "export const baseline = true\n")
	execFileSync("git", ["add", "."], { cwd: repo })
	execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo })
	return { repo, baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() }
}

function configFor(repo: string, seed: string): RsiConfig {
	return {
		repoRoot: repo,
		model: "fixture-model",
		population: 1,
		generations: 2,
		maxConcurrent: 1,
		mutationTask: "fixture objective",
		regressionCommand: "true",
		evalCommands: [],
		hiddenEvalCommands: [],
		archiveDir: path.join(repo, "archive"),
		worktreeDir: path.join(repo, "worktrees"),
		baseRef: "HEAD",
		seed,
		dryRun: true,
		keepWorktrees: true,
		maxIterations: 1,
		protectedPaths: [".env"],
		commandTimeoutMs: 1_000,
	}
}

async function testOrdinaryRunsWithLongSharedSeedPrefixGetDistinctBranches(): Promise<void> {
	const root = await fs.mkdtemp(path.join(scratch, "rsi-run-namespace-"))
	try {
		const { repo, baseCommit } = await initializeRepository(root)
		const config = configFor(repo, "self-rsi-retry-20261011-shared-prefix-that-is-longer-than-candidate-id-budget")
		const hooks = { now: () => "2026-10-11T12:00:00.000Z", log: () => undefined, runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook() }
		const runFirst = await runRsi(config, hooks)
		const runSecond = await runRsi(config, hooks)
		assert.notEqual(runFirst.runId, runSecond.runId)
		assert.equal(runFirst.candidateIdNamespace, runFirst.runId.slice(-8))
		assert.equal(runSecond.candidateIdNamespace, runSecond.runId.slice(-8))
		assert.notEqual(runFirst.candidateIdNamespace, runSecond.candidateIdNamespace, "a prior run namespace cannot leak into a later run")
		const first = runFirst.candidates.find((candidate) => candidate.generation === 0)!
		const second = runSecond.candidates.find((candidate) => candidate.generation === 0)!
		assert.equal(first.id, candidateId(0, 0, `${config.seed}-${runFirst.runId.slice(-8)}`, runFirst.candidateIdNamespace))
		assert.equal(first.baseCommit, baseCommit)
		assert.equal(second.baseCommit, baseCommit)
		assert.notEqual(first.branch, second.branch, "durable run identities must disambiguate identical truncated seed prefixes")
		assert.notEqual(first.worktree, second.worktree)

		await createCandidateWorktree(config, first)
		const firstRef = execFileSync("git", ["rev-parse", first.branch], { cwd: repo, encoding: "utf8" }).trim()
		await createCandidateWorktree(config, second)
		assert.equal(execFileSync("git", ["rev-parse", first.branch], { cwd: repo, encoding: "utf8" }).trim(), firstRef, "creating a later run must retain the earlier candidate branch")
		assert.equal(execFileSync("git", ["rev-parse", second.branch], { cwd: repo, encoding: "utf8" }).trim(), baseCommit)

		const active = { ...runFirst, finishedAt: undefined, candidates: runFirst.candidates.filter((candidate) => candidate.generation === 0) }
		await checkpointRun(config.archiveDir, active)
		const archive = await readArchive(config.archiveDir)
		archive.candidates = archive.candidates.filter((candidate) => candidate.generation === 0)
		await writeArchive(config.archiveDir, archive)
		archive.activeRuns[0]!.candidateIdNamespace = "tampered"
		await writeArchive(config.archiveDir, archive)
		await assert.rejects(
			runRsi({ ...config, resumeRunId: runFirst.runId }, hooks),
			/candidate branch namespace differs from the durable run identity/,
			"a resumed namespace must not be rebound independently of the run ID",
		)
		archive.activeRuns[0]!.candidateIdNamespace = runFirst.runId.slice(-8)
		await writeArchive(config.archiveDir, archive)
		const resumed = await runRsi({ ...config, resumeRunId: runFirst.runId }, { ...hooks, now: () => "2026-10-11T12:01:00.000Z" })
		assert.equal(resumed.runId, runFirst.runId)
		assert.equal(resumed.candidateIdNamespace, runFirst.candidateIdNamespace, "the physical namespace is durable across resume")
		assert.equal(resumed.candidates.find((candidate) => candidate.generation === 0)?.id, first.id, "resume must retain persisted candidate identities")
		const resumedGenerationOne = resumed.candidates.find((candidate) => candidate.generation === 1)!
		assert.ok(resumedGenerationOne, "resume should be able to plan the next generation")
		assert.equal(resumedGenerationOne.id, candidateId(1, 0, `${config.seed}-${runFirst.runId.slice(-8)}`, runFirst.candidateIdNamespace))
		assert.notEqual(resumedGenerationOne.branch, first.branch)
		assert.equal(execFileSync("git", ["rev-parse", first.branch], { cwd: repo, encoding: "utf8" }).trim(), firstRef, "resume must not delete or replace a prior branch")

		const legacyGenerated = await runRsi(config, hooks)
		const legacyCandidates = legacyGenerated.candidates.map((candidate) => {
			const id = candidateId(candidate.generation, 0, `${config.seed}-${legacyGenerated.runId.slice(-8)}`)
			return { ...candidate, id, branch: candidateBranch(id), worktree: candidateWorktree(config, id) }
		})
		const legacyFirst = { ...legacyGenerated, candidateIdNamespace: undefined, finishedAt: undefined, candidates: legacyCandidates.filter((candidate) => candidate.generation === 0) }
		await checkpointRun(config.archiveDir, legacyFirst)
		const legacyArchive = await readArchive(config.archiveDir)
		const legacyGenerationOneId = candidateId(1, 0, `${config.seed}-${legacyGenerated.runId.slice(-8)}`)
		legacyArchive.candidates = legacyArchive.candidates.filter((candidate) => candidate.id !== legacyGenerationOneId)
		await writeArchive(config.archiveDir, legacyArchive)
		const legacyResumed = await runRsi({ ...config, resumeRunId: legacyGenerated.runId }, hooks)
		assert.equal(legacyResumed.candidateIdNamespace, undefined, "legacy ordinary runs keep their prior no-namespace candidate identity scheme")
		assert.equal(legacyResumed.candidates.find((candidate) => candidate.generation === 0)?.id, legacyCandidates.find((candidate) => candidate.generation === 0)?.id)
		assert.equal(legacyResumed.candidates.find((candidate) => candidate.generation === 1)?.id, legacyGenerationOneId)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
await testOrdinaryRunsWithLongSharedSeedPrefixGetDistinctBranches()
console.log("RSI durable run candidate namespace tests passed")
