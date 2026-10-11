import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { appendRun, checkpointRun, readArchive } from "../archive.js"
import { runRsi } from "../controller.js"
import { newCandidate, resolveBaseCommit } from "../workspace.js"
import type { RsiConfig, RsiRunRecord, TrialResult } from "../types.js"
import { fakeDevelopmentBenchmarkHook, fixtureDevelopmentProofProtocol } from "./development-proof-fixture.js"

function ok(command: string, durationMs = 1): TrialResult {
	return { ok: true, command, exitCode: 0, durationMs, stdout: "", stderr: "" }
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
			regressionCommand: "npm test",
			evalCommands: ["visible"],
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
		const developmentProofProtocol = await fixtureDevelopmentProofProtocol("qwen")
		const candidate = newCandidate(config, 0, 0, baseCommit, "now")
		const interrupted: RsiRunRecord = {
			runId: "resume-fixture",
			startedAt: "now",
			model: "qwen",
			baseRef: "HEAD",
			baseCommit,
			developmentProofProtocol,
			confirmationEvidence: "unmeasured",
			generations: 1,
			candidates: [candidate],
			reports: [],
		}
		await checkpointRun(config.archiveDir, interrupted)
		const resumed = await runRsi({ ...config, resumeRunId: "resume-fixture" }, {
			log: () => undefined,
			runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook(),
			runCommand: async (command, cwd) => ok(command, path.basename(cwd).startsWith("rsi-baseline-") ? 100 : 1),
			runMutation: async (entry) => {
				await fs.writeFile(path.join(entry.worktree, "resumed.txt"), "resumed\n")
				execFileSync("git", ["add", "resumed.txt"], { cwd: entry.worktree })
				execFileSync("git", ["commit", "-qm", "resume"], { cwd: entry.worktree })
				return { ok: true, result: ok("mutation") }
			},
		})
		assert.equal(resumed.runId, "resume-fixture")
		assert.equal(resumed.candidates[0].status, "rejected")
		assert.equal(resumed.candidates[0].developmentProof?.accepted, false)
		const archive = await readArchive(config.archiveDir)
		assert.equal(archive.activeRuns.length, 0)
		assert.equal(archive.runs[0]?.runId, "resume-fixture")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
	console.log("All 4 RSI resume assertions passed")
	await testRejectedParentCannotLaunchMutation()
}

async function testRejectedParentCannotLaunchMutation(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-invalid-parent-"))
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "rsi@example.invalid"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
		await fs.writeFile(path.join(repo, "README.md"), "fixture\n")
		execFileSync("git", ["add", "README.md"], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo })
		const config = {
			repoRoot: repo, model: "qwen", population: 1, generations: 1, maxConcurrent: 1,
			mutationTask: "resume fixture", regressionCommand: "npm test", evalCommands: ["visible"], hiddenEvalCommands: [],
			archiveDir: path.join(repo, "archive"), worktreeDir: path.join(repo, "worktrees"), baseRef: "HEAD", seed: "lineage",
			dryRun: false, keepWorktrees: false, maxIterations: 1, protectedPaths: [], commandTimeoutMs: 1000,
		} satisfies RsiConfig
		const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		const protocol = await fixtureDevelopmentProofProtocol(config.model)
		await fs.writeFile(path.join(repo, ".env"), "secret=fixture\n")
		execFileSync("git", ["add", "-f", ".env"], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "protected ancestor edit"], { cwd: repo })
		const protectedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		execFileSync("git", ["reset", "--hard", baseCommit], { cwd: repo, stdio: "ignore" })
		const archivedParent = newCandidate(config, 0, 0, baseCommit, "now")
		archivedParent.id = "foreign-protocol-parent"
		archivedParent.status = "accepted"
		archivedParent.commits = [baseCommit]
		archivedParent.developmentProof = { accepted: true, runId: "older-run", protocolDigest: "f".repeat(64) } as NonNullable<typeof archivedParent.developmentProof>
		await appendRun(config.archiveDir, {
			runId: "older-run", startedAt: "now", model: config.model, baseRef: "HEAD", baseCommit, generations: 1,
			candidates: [archivedParent], reports: [],
		})
		let mutationCalls = 0
		for (const [runId, parentKind] of [["missing-parent", "missing"], ["wrong-parent-commit", "mismatch"], ["foreign-protocol-parent", "foreign"], ["foreign-protocol-in-run", "foreign-in-run"], ["protected-ancestor-parent", "protected"]] as const) {
			const candidate = newCandidate(config, 0, 0, parentKind === "protected" ? protectedCommit : baseCommit, "now")
			const candidateId = candidate.id
			if (parentKind === "mismatch") candidate.parentCommit = "f".repeat(40)
			else if (parentKind === "missing") candidate.parent = "missing-accepted-parent"
			else candidate.parent = parentKind === "foreign-in-run" || parentKind === "protected" ? "foreign-protocol-parent-in-run" : "foreign-protocol-parent"
			const inRunParent = parentKind === "foreign-in-run" || parentKind === "protected" ? newCandidate(config, 0, 1, parentKind === "protected" ? protectedCommit : baseCommit, "now") : undefined
			if (inRunParent) {
				inRunParent.id = "foreign-protocol-parent-in-run"
				inRunParent.status = "accepted"
				inRunParent.commits = [parentKind === "protected" ? protectedCommit : baseCommit]
				inRunParent.developmentProof = { accepted: true, runId, protocolDigest: parentKind === "protected" ? protocol.protocolDigest : "e".repeat(64) } as NonNullable<typeof inRunParent.developmentProof>
				if (parentKind === "protected") inRunParent.fitness = { hardGates: { regressionPass: true, typecheckPass: true, visibleEvalPass: true, hiddenEvalPass: null, adversarialPass: true, noProtectedPathViolation: true, completed: true, noCrash: true, committed: true } } as NonNullable<typeof inRunParent.fitness>
			}
			const interrupted: RsiRunRecord = {
				runId, startedAt: "now", model: config.model, baseRef: "HEAD", baseCommit, generations: 1,
				developmentProofProtocol: protocol, confirmationEvidence: "unmeasured", candidates: [...(inRunParent ? [inRunParent] : []), candidate], reports: [],
			}
			await checkpointRun(config.archiveDir, interrupted)
			const caseConfig = { ...config, protectedPaths: parentKind === "protected" ? [".env"] : [], resumeRunId: runId }
			const result = await runRsi(caseConfig, {
				log: () => undefined,
				runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook(),
				runCommand: async (command) => ok(command),
				runMutation: async () => { mutationCalls++; return { ok: true } },
			})
			const rejected = result.candidates.find((entry) => entry.id === candidateId)
			assert.equal(rejected?.status, "rejected")
			assert.match(rejected?.failure ?? "", /parent|commit/)
		}
		assert.equal(mutationCalls, 0, "invalid lineage is rejected before candidate mutation starts")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
	console.log("Rejected or mismatched parents cannot launch mutation work")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
