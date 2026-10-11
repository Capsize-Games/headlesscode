import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { checkpointRun } from "../archive.js"
import { runRsi } from "../controller.js"
import { createMutationSnapshotIdentity } from "../openshell.js"
import { effectiveWorkerHarnessMode, workerHarnessCliPath } from "../worker-harness.js"
import type { CandidateRecord, RsiConfig, RsiRunRecord, TrialResult, WorkerHarnessRuntimeIdentity } from "../types.js"
import { fakeDevelopmentBenchmarkHook } from "./development-proof-fixture.js"
import { withSyntheticEvaluatorPolicy } from "./synthetic-evaluator-runtime.js"
import { validateCandidateParent } from "../controller.js"
import { candidateId } from "../workspace.js"

function ok(command: string): TrialResult {
	return { ok: true, command, exitCode: 0, durationMs: 1, stdout: "", stderr: "" }
}

async function runControllerFixture(): Promise<void> {
	const scratch = path.resolve(".headlesscode/scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratch, "hc-rsi-worker-harness-controller-"))
	const repo = path.join(root, "repo")
	try {
		await fs.mkdir(repo, { recursive: true })
		execFileSync("git", ["init", "-q"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "rsi@example.invalid"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "RSI Test"], { cwd: repo })
		await fs.mkdir(path.join(repo, "src"), { recursive: true })
		await fs.writeFile(path.join(repo, "src", "agent.ts"), "export const baseline = true\n")
		execFileSync("git", ["add", "."], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo })
		const rootCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		const runtime: WorkerHarnessRuntimeIdentity = {
			imageName: "headlesscode-openshell-rsi:fixture",
			imageDigest: `sha256:${"d".repeat(64)}`,
			harnessCommit: "e".repeat(40),
			dependencyLockDigest: "f".repeat(64),
		}
		const keys = path.join(root, "operator-keys")
		await fs.mkdir(keys, { mode: 0o700 })
		const keyPair = generateKeyPairSync("ed25519")
		const signingKey = path.join(keys, "signing.pem")
		const trustedKey = path.join(keys, "trusted.pem")
		await fs.writeFile(signingKey, keyPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 })
		await fs.writeFile(trustedKey, keyPair.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o600 })
		const trustedPin = `sha256:${createHash("sha256").update(keyPair.publicKey.export({ format: "der", type: "spki" })).digest("hex")}`
		const config: RsiConfig = {
			repoRoot: repo, model: "proof-model", population: 1, generations: 2, maxConcurrent: 1,
			mutationTask: "add a small incremental improvement", regressionCommand: "npm test", evalCommands: ["visible"], hiddenEvalCommands: [],
			archiveDir: path.join(repo, "archive"), worktreeDir: path.join(repo, "worktrees"), baseRef: "HEAD", seed: "worker-harness-controller",
			dryRun: false, keepWorktrees: false, maxIterations: 2, maxTokens: 256, protectedPaths: [".env", "docker/", ".dockerignore"], commandTimeoutMs: 1000,
			workerHarnessMode: "self-hosted",
			workerHarnessRuntime: runtime,
			evaluatorSigningKeyPath: signingKey,
			evaluatorTrustedPublicKeyPath: trustedKey,
			evaluatorTrustedKeySha256: trustedPin,
		}
		await assert.rejects(
			runRsi({ ...config, workerHarnessPairId: `rsi-proof-${"a".repeat(20)}`, workerHarnessRunId: `rsi-proof-${"b".repeat(20)}-self` }, { log: () => undefined }),
			/deterministic worker harness run ID must match its paired campaign and arm/,
			"a deterministic run identity cannot be rebound across campaign IDs",
		)
		await assert.rejects(
			runRsi({ ...config, workerHarnessPairId: `rsi-proof-${"a".repeat(20)}`, workerHarnessRunId: `rsi-proof-${"a".repeat(20)}-fixed` }, { log: () => undefined }),
			/deterministic worker harness run ID must match its paired campaign and arm/,
			"a fixed-control run cannot use the self-hosted deterministic suffix",
		)
		const observed: Array<{ generation: number; mode: string; parentCommit: string; digest: string }> = []
		const run = await runRsi(config, {
			syntheticRuntimeIdentity: true,
			log: () => undefined,
			runCommand: async (command) => ok(command),
			runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook([], {
				proofQualified: true,
				succeeds: (commit) => commit !== rootCommit,
			}),
			runMutation: async (candidate, candidateConfig) => {
				await fs.writeFile(path.join(candidate.worktree, "src", `${candidate.id}.ts`), `export const generation = ${candidate.generation}\n`)
				execFileSync("git", ["add", "."], { cwd: candidate.worktree })
				execFileSync("git", ["commit", "-qm", `candidate ${candidate.id}`], { cwd: candidate.worktree })
				const snapshot = createMutationSnapshotIdentity(candidate.worktree, candidate.baseCommit, candidateConfig)
				assert.equal(candidateConfig.workerHarnessParentCommit, candidate.baseCommit)
				assert.equal(candidateConfig.workerHarnessSnapshotTreeDigest, snapshot.snapshotTreeDigest)
				const mode = effectiveWorkerHarnessMode(candidateConfig.workerHarnessMode!, candidate.generation)
				observed.push({ generation: candidate.generation, mode, parentCommit: candidate.baseCommit, digest: snapshot.snapshotTreeDigest })
				return { ok: true, result: ok("mutation"), workerHarnessExecution: {
					mode, parentCommit: candidate.baseCommit, snapshotCommit: snapshot.snapshotCommit,
					snapshotTreeDigest: snapshot.snapshotTreeDigest, runtime,
					executedCliPath: workerHarnessCliPath(mode),
				} }
			},
		})
		const parent = run.candidates.find((candidate) => candidate.generation === 0)!
		const child = run.candidates.find((candidate) => candidate.generation === 1)!
		assert.equal(run.candidateIdNamespace, run.runId.slice(-8))
		assert.equal(parent.id, candidateId(0, 0, config.seed, run.runId.slice(-8)), "paired proof candidate identity keeps its established run-derived suffix")
		assert.equal(child.id, candidateId(1, 0, config.seed, run.runId.slice(-8)), "paired generation slot identity remains unchanged")
		const integrityManifest = JSON.parse(await fs.readFile(path.join(config.archiveDir, run.evaluatorIntegrity!.manifestPath!), "utf8")) as { payload: { input: { imageIdentity: { identitySource: string; pinnedImageDigest: string | null; workerHarnessRuntime: { imageDigest: string } | null } } } }
		assert.equal(integrityManifest.payload.input.imageIdentity.identitySource, "synthetic-test-hooks")
		assert.equal(integrityManifest.payload.input.imageIdentity.pinnedImageDigest, `sha256:${"0".repeat(64)}`)
		assert.equal(integrityManifest.payload.input.imageIdentity.workerHarnessRuntime?.imageDigest, runtime.imageDigest, "the worker runtime pin remains distinct from the evaluator image")
		assert.equal(parent.status, "accepted")
		assert.equal(parent.workerHarnessExecution?.mode, "fixed-control")
		assert.equal(child.parent, parent.id)
		assert.equal(child.baseCommit, parent.commits[0])
		assert.equal(child.workerHarnessExecution?.mode, "self-hosted")
		assert.equal(child.workerHarnessExecution?.parentCommit, parent.commits[0])
		assert.equal(observed[0]?.mode, "fixed-control")
		assert.equal(observed[1]?.mode, "self-hosted")
		assert.equal(observed[1]?.parentCommit, parent.commits[0])
		assert.ok(observed.every((entry) => /^[a-f0-9]{64}$/.test(entry.digest)))
		await checkpointRun(config.archiveDir, { ...run, workerHarnessConfigDigest: undefined })
		await assert.rejects(
			runRsi({ ...config, resumeRunId: run.runId }, { syntheticRuntimeIdentity: true, log: () => undefined, runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook() }),
			/frozen run manifest/,
			"explicit harness resume must reject a missing frozen config digest",
		)
		await checkpointRun(config.archiveDir, run)
		await assert.rejects(
			runRsi({ ...config, generations: 3, resumeRunId: run.runId }, { syntheticRuntimeIdentity: true, log: () => undefined, runDevelopmentBenchmark: fakeDevelopmentBenchmarkHook() }),
			/planned generation count/,
			"explicit harness resume must reject a changed paired generation count",
		)
		await fs.mkdir(path.join(repo, "docker"), { recursive: true })
		await fs.writeFile(path.join(repo, "docker", "OpenShell-RSI.Dockerfile"), "FROM malicious-parent\n")
		execFileSync("git", ["add", "docker/OpenShell-RSI.Dockerfile"], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "tampered protected ancestor"], { cwd: repo })
		const protectedParentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		await fs.writeFile(path.join(repo, "src", "agent.ts"), "export const safeChildPatch = true\n")
		execFileSync("git", ["add", "src/agent.ts"], { cwd: repo })
		execFileSync("git", ["commit", "-qm", "safe child patch after protected parent"], { cwd: repo })
		const safeChildCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		const acceptedParent = {
			id: "tampered-parent", status: "accepted", commits: [protectedParentCommit],
			developmentProof: { accepted: true, runId: "lineage-run", protocolDigest: "p" },
			fitness: { hardGates: { regression: true, typecheck: true, visible: true } },
		} as unknown as CandidateRecord
		const launderingChild = {
			id: "safe-looking-child", parent: acceptedParent.id, baseCommit: protectedParentCommit,
			parentCommit: protectedParentCommit, commits: [safeChildCommit],
		} as unknown as CandidateRecord
		const lineageRun = { runId: "lineage-run", baseCommit: rootCommit, candidates: [acceptedParent] } as unknown as RsiRunRecord
		assert.throws(
			() => validateCandidateParent(launderingChild, lineageRun, { ...config, protectedPaths: [] }, { protocolDigest: "p" } as NonNullable<RsiRunRecord["developmentProofProtocol"]>),
			/parent .*inherits protected path changes: docker\/OpenShell-RSI\.Dockerfile/,
			"a safe child patch cannot launder a protected change inherited from its accepted parent",
		)
		console.log("Controller selected-parent worker harness assertions passed")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

withSyntheticEvaluatorPolicy(runControllerFixture).catch((error) => {
	console.error(error)
	process.exit(1)
})
