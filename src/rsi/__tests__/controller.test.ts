import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { checkpointRun, readArchive } from "../archive.js"
import { runRsi } from "../controller.js"
import type { CandidateRecord, RsiConfig, TrialResult } from "../types.js"
import { fakeDevelopmentBenchmarkHook } from "./development-proof-fixture.js"

function ok(command: string, durationMs = 1): TrialResult {
	return { ok: true, command, exitCode: 0, durationMs, stdout: "", stderr: "" }
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
			regressionCommand: "npm test",
			evalCommands: ["visible"],
			hiddenEvalCommands: [],
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
		const proofCalls: Array<{ harnessCommit: string; outputRoot: string }> = []
		const run = await runRsi(config, {
			now: (() => {
				let tick = 0
				return () => `2026-09-20T00:00:${String(tick++).padStart(2, "0")}.000Z`
			})(),
			log: () => undefined,
			runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook(proofCalls),
			runCommand: async (command, cwd) => ok(command, path.basename(cwd).startsWith("rsi-baseline-") ? 100 : 1),
			runMutation: async (candidate) => {
				const file = path.join(candidate.worktree, "src", `${candidate.id}.ts`)
				await fs.writeFile(file, `export const candidate = ${JSON.stringify(candidate.id)}\n`)
				execFileSync("git", ["add", "."], { cwd: candidate.worktree })
				execFileSync("git", ["commit", "-qm", `candidate ${candidate.id}`], { cwd: candidate.worktree })
				return { ok: true, result: ok("mutation") }
			},
		})
		assert.equal(run.candidates.length, 4)
		assert.ok(run.candidates.filter((candidate) => candidate.generation === 1).every((candidate) => candidate.parent === "baseline"), "unqualified parent evidence must keep later candidates on the run base")
		assert.equal(run.combinations?.length, 4)
		assert.equal(run.jobs?.filter((job) => job.status === "completed").length, 4)
		assert.equal(run.selected, undefined, "guest-reported resource counts cannot qualify a candidate")
		assert.equal(run.candidates.every((candidate) => candidate.developmentProof?.accepted === false), true)
		assert.ok(proofCalls.some((entry) => entry.harnessCommit === run.baseCommit), "controller must obtain the original-base benchmark cell")
		assert.ok(run.candidates.every((candidate) => candidate.developmentProof?.immediateParent.referenceCommit === candidate.parentCommit), "each candidate compares against its exact immediate parent")
		const archive = await readArchive(config.archiveDir)
		assert.equal(archive.activeRuns.length, 0)
		assert.equal(archive.runs.length, 1)
		assert.equal(archive.candidates.length, 4)
		assert.equal(archive.runs[0]?.developmentProofProtocol?.protocolDigest, run.developmentProofProtocol?.protocolDigest)
		assert.equal(archive.candidates[0]?.developmentProof?.immediateParent.outcomes.length, run.developmentProofProtocol?.taskIds.length, "archive retains the full paired task outcomes")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
	console.log("All 7 RSI controller assertions passed")
	await testAuthoritativeDevelopmentProofControlsParentSelection()
	await testSealedEvaluatorResumeRejectsDrift()
}

async function testSealedEvaluatorResumeRejectsDrift(): Promise<void> {
	const scratch = path.resolve(".headlesscode/scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratch, "hc-rsi-sealed-resume-"))
	try {
		const repo = path.join(root, "repo")
		const archiveDir = path.join(repo, ".rsi-archive")
		const worktreeDir = path.join(repo, ".rsi-worktrees")
		const keys = path.join(root, "operator-keys")
		await fs.mkdir(path.join(repo, "src"), { recursive: true })
		await fs.mkdir(keys, { mode: 0o700 })
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "rsi@example.invalid"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
		await fs.writeFile(path.join(repo, "src", "agent.ts"), "export const baseline = true\n")
		execFileSync("git", ["add", "."], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo })
		const keyPair = generateKeyPairSync("ed25519")
		const signingKey = path.join(keys, "signing.pem")
		const trustedKey = path.join(keys, "trusted.pem")
		const trustedPem = keyPair.publicKey.export({ format: "pem", type: "spki" })
		await fs.writeFile(signingKey, keyPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 })
		await fs.writeFile(trustedKey, trustedPem, { mode: 0o600 })
		const trustedPin = `sha256:${createHash("sha256").update(keyPair.publicKey.export({ format: "der", type: "spki" })).digest("hex")}`
		const config = {
			repoRoot: repo, model: "fixture-model", population: 1, generations: 1, maxConcurrent: 1,
			mutationTask: "fixture mutation", regressionCommand: "npm test", evalCommands: ["visible"], hiddenEvalCommands: [],
			archiveDir, worktreeDir, baseRef: "HEAD", seed: "sealed-resume-test", dryRun: false, keepWorktrees: false,
			maxIterations: 1, protectedPaths: [".env", ".rsi-archive/", ".rsi-worktrees/"], commandTimeoutMs: 1_000,
			evaluatorSigningKeyPath: signingKey, evaluatorTrustedPublicKeyPath: trustedKey, evaluatorTrustedKeySha256: trustedPin,
		} satisfies RsiConfig
		const hooks = {
			syntheticRuntimeIdentity: true as const,
			log: () => undefined,
			runCommand: async (command: string) => ok(command),
			runMutation: async (candidate: CandidateRecord) => {
				await fs.writeFile(path.join(candidate.worktree, "src", "candidate.ts"), "export const changed = true\n")
				execFileSync("git", ["add", "."], { cwd: candidate.worktree })
				execFileSync("git", ["commit", "-qm", "candidate"], { cwd: candidate.worktree })
				return { ok: true, result: ok("mutation") }
			},
			runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook(),
		}
		const run = await runRsi(config, hooks)
		assert.equal(run.evaluatorIntegrity?.status, "sealed")
		assert.ok(run.evaluatorIntegrity?.manifestPath)
		const archivePath = path.join(archiveDir, "archive.json")
		const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as { runs: typeof run[]; activeRuns: typeof run[] }
		archive.runs = []
		archive.activeRuns = [structuredClone(run)]
		await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`)
		await assert.rejects(() => runRsi({ ...config, evaluatorSigningKeyPath: undefined, evaluatorTrustedPublicKeyPath: undefined, evaluatorTrustedKeySha256: undefined, resumeRunId: run.runId }, hooks), /sealed RSI run cannot resume without its independently pinned evaluator integrity trust/)

		const downgraded = structuredClone(run)
		downgraded.evaluatorIntegrity = { status: "unsealed", outputs: [], generations: [] }
		archive.activeRuns = [downgraded]
		await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`)
		await assert.rejects(() => runRsi({ ...config, evaluatorSigningKeyPath: undefined, evaluatorTrustedPublicKeyPath: undefined, evaluatorTrustedKeySha256: undefined, resumeRunId: run.runId }, hooks), /seal artifacts exist but archive metadata is missing or downgraded/)

		const active = structuredClone(run)
		active.candidates[0]!.fitness!.score += 1
		archive.activeRuns = [active]
		await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`)
		await assert.rejects(() => runRsi({ ...config, resumeRunId: run.runId }, hooks), /archived evaluator state changed since its last signed checkpoint/)
		console.log("Sealed RSI resume rejects missing independent trust and changed archived evaluation state")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testAuthoritativeDevelopmentProofControlsParentSelection(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-authoritative-proof-"))
	try {
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "rsi@example.invalid"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
		await fs.mkdir(path.join(repo, "src"), { recursive: true })
		await fs.writeFile(path.join(repo, "src", "agent.ts"), "export const baseline = true\n")
		execFileSync("git", ["add", "."], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo })
		const rootCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		const config = {
			repoRoot: repo, model: "proof-model", population: 1, generations: 2, maxConcurrent: 1,
			mutationTask: "write an incremental change", regressionCommand: "npm test", evalCommands: ["visible"], hiddenEvalCommands: [],
			archiveDir: path.join(repo, "archive"), worktreeDir: path.join(repo, "worktrees"), baseRef: "HEAD", seed: "proof-controller",
			dryRun: false, keepWorktrees: false, maxIterations: 2, protectedPaths: [".env", "docker/", ".dockerignore"], commandTimeoutMs: 1000,
		} satisfies RsiConfig
		const manifest = JSON.parse(await fs.readFile(path.resolve("fixtures/rsi-benchmark/manifest.json"), "utf8")) as { tasks: Array<{ id: string }> }
		const retention = new Set(["tool-symlink-escape", "malformed-child-completion", "ollama-request-timeout", "watch-abort-callbacks"])
		const retentionWin = manifest.tasks.find((task) => retention.has(task.id))!.id
		const [firstNonRetention, secondNonRetention] = manifest.tasks.filter((task) => !retention.has(task.id)).map((task) => task.id)
		let acceptedCommit: string | undefined
		const run = await runRsi(config, {
			log: () => undefined,
			runCommand: async (command) => ok(command),
			runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook([], {
				proofQualified: true,
				succeeds: (harnessCommit, taskId) => {
					if (harnessCommit === rootCommit) return false
					if (!acceptedCommit) acceptedCommit = harnessCommit
				return harnessCommit === acceptedCommit ? taskId === retentionWin || taskId === firstNonRetention : taskId === secondNonRetention
				},
			}),
			runMutation: async (candidate) => {
				await fs.writeFile(path.join(candidate.worktree, "src", `${candidate.id}.ts`), "export const incremental = true\n")
				execFileSync("git", ["add", "."], { cwd: candidate.worktree })
				execFileSync("git", ["commit", "-qm", `candidate ${candidate.id}`], { cwd: candidate.worktree })
				return { ok: true, result: ok("mutation") }
			},
		})
		const first = run.candidates.find((candidate) => candidate.generation === 0)!
		const second = run.candidates.find((candidate) => candidate.generation === 1)!
		assert.equal(first.status, "accepted", "authoritative qualified benchmark evidence can accept a net development win")
		assert.equal(first.pairedComparison?.improved, false, "the legacy original-base command comparison is diagnostic, not an acceptance veto")
		assert.equal(second.parent, first.id)
		assert.equal(second.baseCommit, first.commits[0])
		assert.equal(second.developmentProof?.immediateParent.referenceCommit, first.commits[0])
		assert.equal(second.status, "rejected", "a child that beats root but loses the retention task to its parent must be rejected")
		assert.equal(second.developmentProof?.originalBase.eligible, true, "the root comparison remains a separate diagnostic anchor")
		assert.equal(second.developmentProof?.immediateParent.eligible, false)
		const acceptedSnapshot = structuredClone(first)
		const tamperCases = [
			(proof: NonNullable<typeof first.developmentProof>) => { proof.immediateParent.childCommit = rootCommit },
			(proof: NonNullable<typeof first.developmentProof>) => { proof.immediateParent.referenceCommit = first.commits[0]! },
			(proof: NonNullable<typeof first.developmentProof>) => { proof.originalBase.childCommit = rootCommit },
			(proof: NonNullable<typeof first.developmentProof>) => { proof.originalBase.referenceCommit = first.commits[0]! },
		]
		for (const tamper of tamperCases) {
			Object.assign(first, structuredClone(acceptedSnapshot))
			tamper(first.developmentProof!)
			const interrupted = { ...run, generations: 3 }
			await checkpointRun(config.archiveDir, interrupted)
			const replayCalls: Array<{ harnessCommit: string; outputRoot: string }> = []
			const replayed = await runRsi({ ...config, generations: 3, dryRun: true, resumeRunId: run.runId }, {
				log: () => undefined,
				runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook(replayCalls, { proofQualified: true }),
			})
			assert.equal(replayed.candidates.find((candidate) => candidate.id === first.id)?.status, "rejected")
			assert.equal(replayCalls.length, 0, "tampered comparison references must fail before artifact replay")
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
	console.log("Authoritative development proof controls selection against the exact immediate parent")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
