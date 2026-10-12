import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { buildProofPlanPreview, parseProofDemonstrationArgs, proofConfigFromOptions } from "../../../scripts/rsi-proof-demonstration.js"
import { runRsi } from "../controller.js"
import { benchmarkTreeDigest, materializeBenchmarkSnapshot } from "../benchmark/runner.js"
import { buildSnapshotPackage } from "../benchmark/snapshot-package.js"
import type { BenchmarkTask } from "../benchmark/types.js"

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
const gitText = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

test("proof preview binds an external package root and rejects missing fixtures before metadata fetch", async () => {
	const scratch = path.join(process.cwd(), ".headlesscode", "scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratch, "proof-fixture-preview-"))
	const repo = path.join(root, "source-root")
	const packageSource = path.join(root, "package-source")
	const fixtures = path.join(root, "external-fixtures")
	const packagePath = path.join(fixtures, "snapshots")
	const manifestPath = path.join(fixtures, "manifest.json")
	const verifierPath = "verifiers/synthetic.mjs"
	try {
		await fs.mkdir(repo, { recursive: true })
		await fs.mkdir(packageSource, { recursive: true })
		await fs.mkdir(path.join(fixtures, "verifiers"), { recursive: true })
		git(repo, ["init", "--quiet", "--initial-branch=main"])
		git(repo, ["config", "user.name", "Synthetic preview source"])
		git(repo, ["config", "user.email", "synthetic-preview@invalid.example"])
		for (const source of [
			"src/rsi/development-proof.ts", "src/rsi/proof-campaign.ts", "src/rsi/proof-confirmation.ts",
			"src/rsi/proof-demonstration.ts", "src/rsi/proof-demonstration-plan.ts", "src/rsi/proof-demonstration-manifest.ts",
			"src/rsi/controller.ts", "scripts/rsi-proof-demonstration.ts",
		]) {
			const file = path.join(repo, source)
			await fs.mkdir(path.dirname(file), { recursive: true })
			await fs.writeFile(file, "// synthetic preview digest input\n")
		}
		await fs.writeFile(path.join(repo, "synthetic-source.txt"), "source snapshot only\n")
		git(repo, ["add", "--all"])
		git(repo, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "synthetic preview source"])
		const rootCommit = gitText(repo, ["rev-parse", "HEAD"])

		await fs.mkdir(path.join(packageSource, "src"), { recursive: true })
		await fs.writeFile(path.join(packageSource, "src", "synthetic.txt"), "snapshot one\n")
		git(packageSource, ["init", "--quiet", "--initial-branch=main"])
		git(packageSource, ["config", "user.name", "Synthetic preview package"])
		git(packageSource, ["config", "user.email", "synthetic-package@invalid.example"])
		git(packageSource, ["add", "--all"])
		git(packageSource, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "snapshot start"])
		const startCommit = gitText(packageSource, ["rev-parse", "HEAD"])
		await fs.writeFile(path.join(packageSource, "src", "synthetic.txt"), "snapshot good\n")
		git(packageSource, ["add", "--all"])
		git(packageSource, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "snapshot good"])
		const goodCommit = gitText(packageSource, ["rev-parse", "HEAD"])
		await fs.writeFile(path.join(packageSource, "src", "synthetic.txt"), "snapshot bad\n")
		git(packageSource, ["add", "--all"])
		git(packageSource, ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "snapshot bad"])
		const badCommit = gitText(packageSource, ["rev-parse", "HEAD"])

		const digestAt = async (commit: string, label: string): Promise<string> => {
			const destination = path.join(root, label)
			await materializeBenchmarkSnapshot({ ...scaffold, startCommit: commit }, packageSource, destination)
			try { return await benchmarkTreeDigest(destination) }
			finally { await fs.rm(destination, { recursive: true, force: true }) }
		}
		const verifier = path.join(fixtures, verifierPath)
		await fs.mkdir(path.dirname(verifier), { recursive: true })
		await fs.writeFile(verifier, "// synthetic verifier\n")
		const scaffold: BenchmarkTask = {
			id: "dev-task-00", family: "synthetic-family-0", split: "development", task: "synthetic isolated task",
			startCommit, startDigest: "0".repeat(64), verifierPath, verifierDigest: sha256(await fs.readFile(verifier)),
			knownGoodCommit: goodCommit, knownGoodDigest: "0".repeat(64), knownBadCommit: badCommit, knownBadDigest: "0".repeat(64),
			seed: 1, ceilings: { timeoutMs: 10_000, maxCalls: 1, maxOutputTokensPerCall: 32, maxPatchBytes: 4096 },
		}
		scaffold.startDigest = await digestAt(startCommit, "start-tree")
		scaffold.knownGoodDigest = await digestAt(goodCommit, "good-tree")
		scaffold.knownBadDigest = await digestAt(badCommit, "bad-tree")
		const tasks: BenchmarkTask[] = Array.from({ length: 32 }, (_, index) => ({
			...scaffold,
			id: `${index < 16 ? "dev" : "conf"}-task-${String(index % 16).padStart(2, "0")}`,
			family: `synthetic-family-${index % 4}`,
			split: index < 16 ? "development" : "confirmation",
			task: `synthetic task ${index}`,
			seed: index + 1,
		}))
		const builtPackage = await buildSnapshotPackage(packageSource, tasks, packagePath)
		const descriptor = { formatVersion: builtPackage.formatVersion, path: builtPackage.path, digest: builtPackage.digest }
		const indexDigest = sha256(await fs.readFile(path.join(packagePath, "index.json")))
		assert.equal(descriptor.digest, indexDigest)
		const manifest = { schemaVersion: 1, runnerVersion: "1.1.0", createdFromCommit: startCommit, snapshotPackage: descriptor, tasks }
		await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

		const env: NodeJS.ProcessEnv = {
			HEADLESSCODE_RSI_RUNTIME_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
			HEADLESSCODE_RSI_RUNTIME_HARNESS_COMMIT: rootCommit,
			HEADLESSCODE_RSI_DEPENDENCY_LOCK_DIGEST: "b".repeat(64),
			HEADLESSCODE_RSI_OPENROUTER_MAX_CAMPAIGN_SPEND_USD: "20",
			HEADLESSCODE_RSI_OPENROUTER_MUTATION_BUDGET_USD: "5",
			HEADLESSCODE_RSI_OPENROUTER_BENCHMARK_BUDGET_USD: "15",
			HEADLESSCODE_RSI_OPENROUTER_MAX_CALL_SPEND_USD: "0.1",
			HEADLESSCODE_RSI_OPENROUTER_MAX_JOB_SPEND_USD: "1",
			HEADLESSCODE_RSI_OPENROUTER_MAX_INPUT_PRICE_PER_MILLION_USD: "1",
			HEADLESSCODE_RSI_OPENROUTER_MAX_OUTPUT_PRICE_PER_MILLION_USD: "1",
		}
		const options = parseProofDemonstrationArgs(["estimate", "--repo", repo, "--seed", "synthetic-eng", "--campaign-seed", "synthetic-a", "--campaign-seed", "synthetic-b", "--campaign-seed", "synthetic-c", "--benchmark-fixtures-root", fixtures])
		let metadataRequests = 0
		const fetcher = (async (input: string | URL, init?: RequestInit) => {
			metadataRequests++
			assert.equal(init?.method, "GET")
			assert.match(String(input), /\/models\/deepseek\/deepseek-v4-flash-0731\/endpoints$/)
			return new Response(JSON.stringify({ data: { endpoints: [{
				provider_name: "DeepInfra", tag: "deepinfra/fp8", quantization: "fp8", status: 0,
				pricing: { prompt: "0.00000006", completion: "0.00000018" },
				supported_parameters: ["tools", "tool_choice", "temperature", "seed", "max_tokens"],
				supports_tool_choice: { auto: true, required: true, function: true },
			}] } }), { status: 200 })
		}) as typeof fetch

		const preview = await buildProofPlanPreview(options, env, fetcher)
		assert.equal(metadataRequests, 1, "valid synthetic preview performs only the mocked pricing metadata GET")
		assert.deepEqual(preview.benchmarkFixtures, { root: await fs.realpath(fixtures), manifestSha256: sha256(await fs.readFile(manifestPath)), snapshotPackage: { path: "snapshots", digest: indexDigest } })
		assert.deepEqual(preview.execution.configs.map((config) => config.proofBenchmarkFixtures), Array(4).fill(preview.benchmarkFixtures))
		assert.equal(preview.benchmarkManifestSha256, preview.benchmarkFixtures.manifestSha256)
		assert.equal(gitText(repo, ["status", "--porcelain=v1", "--untracked-files=all"]), "", "preview leaves the synthetic source root clean")

		const indexPath = path.join(packagePath, "index.json")
		const originalIndex = await fs.readFile(indexPath)
		await fs.writeFile(indexPath, Buffer.concat([originalIndex, Buffer.from(" ")]))
		metadataRequests = 0
		await assert.rejects(buildProofPlanPreview(options, env, fetcher), /pinned snapshot package digest mismatch/)
		assert.equal(metadataRequests, 0, "changed package bytes fail before metadata pricing fetch")
		const controllerConfig = {
			...proofConfigFromOptions({ repo, seeds: ["synthetic-eng"], mutationTask: "synthetic objective" }, rootCommit, preview.benchmarkFixtures),
			archiveDir: path.join(root, "controller-archive"), worktreeDir: path.join(root, "controller-worktrees"), dryRun: true,
		}
		const effects = { mutation: 0, command: 0, benchmark: 0 }
		await assert.rejects(runRsi(controllerConfig, {
			runMutation: async () => { effects.mutation++; throw new Error("mutation hook must not run") },
			runCommand: async () => { effects.command++; throw new Error("command hook must not run") },
			runDevelopmentBenchmark: async () => { effects.benchmark++; throw new Error("benchmark hook must not run") },
		}), /pinned snapshot package digest mismatch/)
		assert.deepEqual(effects, { mutation: 0, command: 0, benchmark: 0 }, "controller rejects the frozen fixture mismatch before evaluator, mutation, or benchmark hooks")
		await fs.writeFile(indexPath, originalIndex)

		const missingManifestRoot = path.join(root, "missing-manifest")
		await fs.mkdir(missingManifestRoot)
		metadataRequests = 0
		const missingManifestOptions = parseProofDemonstrationArgs(["estimate", "--repo", repo, "--seed", "synthetic-eng", "--campaign-seed", "synthetic-a", "--campaign-seed", "synthetic-b", "--campaign-seed", "synthetic-c", "--benchmark-fixtures-root", missingManifestRoot])
		await assert.rejects(buildProofPlanPreview(missingManifestOptions, env, fetcher), /ENOENT/)
		assert.equal(metadataRequests, 0, "missing fixture manifest fails before pricing metadata, campaign, or inference effects")

		const missingPackageRoot = path.join(root, "missing-package")
		await fs.cp(fixtures, missingPackageRoot, { recursive: true })
		const missingPackageManifest = { ...manifest, snapshotPackage: { ...descriptor, path: "missing-snapshots" } }
		await fs.writeFile(path.join(missingPackageRoot, "manifest.json"), `${JSON.stringify(missingPackageManifest, null, 2)}\n`)
		metadataRequests = 0
		const missingPackageOptions = parseProofDemonstrationArgs(["estimate", "--repo", repo, "--seed", "synthetic-eng", "--campaign-seed", "synthetic-a", "--campaign-seed", "synthetic-b", "--campaign-seed", "synthetic-c", "--benchmark-fixtures-root", missingPackageRoot])
		await assert.rejects(buildProofPlanPreview(missingPackageOptions, env, fetcher), /ENOENT/)
		assert.equal(metadataRequests, 0, "missing package fails before pricing metadata, campaign, or inference effects")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
