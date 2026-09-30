import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { applyFleetMutationPatch, createEvaluationSnapshotBundle, createMutationSnapshotBundle, inspectLocalRsiCheckpoint, networkRules, runOpenShellBenchmarkVerifier, runOpenShellMutation } from "../openshell.js"
import type { RsiOpenShellProviderFactory } from "../openshell.js"
import type { CandidateRecord, RsiConfig } from "../types.js"
import { parseRsiArgs } from "../config.js"
import { transformSync } from "esbuild"

async function run(mode: "source" | "escape" | "symlink" | "preflight" | "worker-failure" | "snapshot-mismatch" | "protected-package" | "self-hosted-missing-cli" | "self-hosted-corrupt-cli" | "dependency-escape"): Promise<void> {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hc-rsi-openshell-"))
	const worktree = path.join(repo, ".worktrees", "rsi", `candidate-${mode}`)
	const originalPath = process.env.PATH
	let guestPath = ""
	let factoryOptions: Parameters<RsiOpenShellProviderFactory>[0] | undefined
	let sessionEnv: Record<string, string> | undefined
	let workerInvocations = 0
	let candidateCliInvocations = 0
	let trustedRuntimeRoot = ""
	try {
		execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo })
		fs.mkdirSync(path.join(repo, "src", "engine"), { recursive: true })
		fs.mkdirSync(path.join(repo, "src", "rsi"), { recursive: true })
		fs.mkdirSync(path.join(repo, "scripts", "eval-suite"), { recursive: true })
		fs.mkdirSync(path.join(repo, "scripts", "rsi-benchmark", "manual-tests"), { recursive: true })
		fs.mkdirSync(path.join(repo, "test"), { recursive: true })
		fs.mkdirSync(path.join(repo, "fixtures", "rsi-benchmark"), { recursive: true })
		fs.mkdirSync(path.join(repo, "__rsi_benchmark_verifier__"), { recursive: true })
		fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true })
		fs.writeFileSync(path.join(repo, "src", "engine", "loop.ts"), "export const value = 1\n")
		fs.writeFileSync(path.join(repo, "src", "cli.ts"), "export const workerCli = true\n")
		fs.writeFileSync(path.join(repo, "node_modules", "private.js"), "export const privateDependency = true\n")
		fs.writeFileSync(path.join(repo, "fixtures", "rsi-benchmark", "confirmation.json"), "{\"answer\":\"sealed\"}\n")
		fs.writeFileSync(path.join(repo, "__rsi_benchmark_verifier__", "verify.mjs"), "throw new Error('sealed verifier')\n")
		fs.writeFileSync(path.join(repo, "package.json"), "{\"name\":\"fixture\"}\n")
		fs.writeFileSync(path.join(repo, "src", "rsi", "evaluator.ts"), "export const hiddenScoring = 'secret'\n")
		fs.writeFileSync(path.join(repo, "scripts", "eval-suite", "hidden.sh"), "secret\n")
		fs.writeFileSync(path.join(repo, "scripts", "rsi-benchmark", "task-spec.mjs"), 'export const confirmationFix = "private-known-good-sha"\n')
		fs.writeFileSync(path.join(repo, "scripts", "rsi-benchmark", "manual-tests", "confirmation.mjs"), 'throw new Error("private confirmation oracle")\n')
		fs.writeFileSync(path.join(repo, "test", "engine.test.ts"), "test secret\n")
		fs.writeFileSync(path.join(repo, ".env"), "TOKEN=secret\n")
		execFileSync("git", ["add", "."], { cwd: repo })
		execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repo })
		const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		fs.mkdirSync(path.dirname(worktree), { recursive: true })
		execFileSync("git", ["worktree", "add", "--quiet", "-b", `rsi/${mode}`, worktree, baseCommit], { cwd: repo })
		const candidate: CandidateRecord = {
			id: `candidate-${mode}`,
			generation: 0,
			parent: "baseline",
			branch: `rsi/${mode}`,
			worktree,
			baseCommit,
			status: "mutating",
			model: "test-model",
			mutation: "test task",
			createdAt: "now",
			updatedAt: "now",
			commits: [],
			changedFiles: [],
			protectedPathViolations: [],
		}
		const harnessRuntime = {
			imageName: "headlesscode-openshell-rsi:fixture",
			imageDigest: `sha256:${"a".repeat(64)}`,
			harnessCommit: "e".repeat(40),
			dependencyLockDigest: "f".repeat(64),
		}
		if (["self-hosted-missing-cli", "self-hosted-corrupt-cli", "dependency-escape"].includes(mode)) {
			const dockerBin = path.join(repo, "bin")
			fs.mkdirSync(dockerBin)
			trustedRuntimeRoot = path.join(repo, "trusted-runtime")
			fs.mkdirSync(path.join(trustedRuntimeRoot, "src"), { recursive: true })
			fs.mkdirSync(path.join(trustedRuntimeRoot, "node_modules"), { recursive: true })
			fs.writeFileSync(path.join(trustedRuntimeRoot, "tsconfig.json"), "{}\n")
			fs.writeFileSync(path.join(trustedRuntimeRoot, "package-lock.json"), "{}\n")
			const dockerStub = path.join(dockerBin, "docker")
			fs.writeFileSync(dockerStub, `#!/bin/sh\ncase "$*" in\n  *"image inspect"*) echo '${harnessRuntime.imageDigest}' ;;\n  *"/opt/headlesscode/.headlesscode-harness-commit"*) echo '${harnessRuntime.harnessCommit}' ;;\n  *"/opt/headlesscode/package-lock.json"*) echo '${harnessRuntime.dependencyLockDigest}  /opt/headlesscode/package-lock.json' ;;\n  *) exit 2 ;;\nesac\n`)
			fs.chmodSync(dockerStub, 0o755)
			process.env.PATH = `${dockerBin}${path.delimiter}${originalPath ?? ""}`
		}
		const config: RsiConfig = {
			repoRoot: repo,
			model: "test-model",
			population: 1,
			generations: 1,
			maxConcurrent: 1,
			mutationTask: "test task",
			regressionCommand: "npm test",
			evalCommands: ["npm test"],
			hiddenEvalCommands: [],
			archiveDir: path.join(repo, ".headlesscode", "archive"),
			worktreeDir: path.join(repo, ".worktrees", "rsi"),
			baseRef: "HEAD",
			seed: "test",
			dryRun: false,
			keepWorktrees: false,
			maxIterations: 2,
			// Deliberately incomplete: supervisor-only paths must still be omitted.
			protectedPaths: [],
			commandTimeoutMs: 10_000,
			...(mode === "preflight" ? { benchmarkHarnessCommit: "f".repeat(40) } : {}),
			...(mode === "snapshot-mismatch" ? { workerHarnessSnapshotTreeDigest: "f".repeat(64) } : {}),
			...(["self-hosted-missing-cli", "self-hosted-corrupt-cli", "dependency-escape"].includes(mode) ? {
				workerHarnessMode: "self-hosted" as const,
				workerHarnessParentCommit: baseCommit,
				workerHarnessRuntime: harnessRuntime,
			} : {}),
		}
		const providerFactory: RsiOpenShellProviderFactory = (options) => {
			factoryOptions = options
			return {
				async spawnExistingWorktreeSession(request, workspace) {
					guestPath = workspace
					sessionEnv = request.env ?? {}
					assert.equal(path.relative(repo, workspace).startsWith(".."), false)
					assert.equal(fs.existsSync(path.join(workspace, "fixtures", "rsi-benchmark", "confirmation.json")), false, "mutation guest cannot read confirmation fixtures")
					assert.equal(fs.existsSync(path.join(workspace, "scripts", "rsi-benchmark", "task-spec.mjs")), false, "mutation guest cannot read confirmation task descriptions or known-good SHAs")
					assert.equal(fs.existsSync(path.join(workspace, "scripts", "rsi-benchmark", "manual-tests", "confirmation.mjs")), false, "mutation guest cannot read confirmation verifier code")
					assert.equal(fs.existsSync(path.join(workspace, "__rsi_benchmark_verifier__", "verify.mjs")), false, "mutation guest cannot read verifier source")
					assert.equal(fs.existsSync(path.join(workspace, "node_modules", "private.js")), false, "candidate dependencies are excluded from the guest snapshot")
					assert.throws(() => fs.readFileSync(path.join(workspace, "__rsi_benchmark_verifier__", "verify.mjs")), /ENOENT/, "an attempted verifier read has no guest-visible file")
					assert.equal(fs.existsSync(path.join(workspace, "src", "rsi", "evaluator.ts")), false)
					assert.equal(fs.existsSync(path.join(workspace, "scripts", "eval-suite", "hidden.sh")), false)
					assert.equal(fs.existsSync(path.join(workspace, "test", "engine.test.ts")), false)
					assert.equal(fs.existsSync(path.join(workspace, ".env")), false)
					assert.equal(fs.existsSync(path.join(workspace, "package.json")), false, "candidate-controlled package metadata must not enter the mutation guest")
					if (mode === "self-hosted-missing-cli") fs.rmSync(path.join(workspace, "src", "cli.ts"))
					if (mode === "self-hosted-corrupt-cli") fs.writeFileSync(path.join(workspace, "src", "cli.ts"), "export const = ;\n")
					if (mode === "self-hosted-corrupt-cli") fs.symlinkSync(path.join(trustedRuntimeRoot, "node_modules"), path.join(workspace, "node_modules"))
					if (mode === "dependency-escape") fs.symlinkSync("/tmp/candidate-owned-node-modules", path.join(workspace, "node_modules"))
					return { id: request.worktreeSpec.name, provider: "mock-openshell", address: workspace }
				},
				async waitReady() {},
				async runHarness(_handle, command) {
					workerInvocations += 1
					assert.match(command, /rev-list --count HEAD/)
					assert.match(command, /\/opt\/headlesscode\/src\/rsi/)
					assert.match(command, /OPENROUTER_API_KEY/)
					assert.match(command, /test -r \/workspace\/src\/cli\.ts/, "guest preflight must reject a missing self-hosted CLI")
					assert.match(command, /readlink \/workspace\/node_modules/)
					assert.match(command, /test \! -e \/workspace\/__rsi_benchmark_verifier__/)
					assert.match(command, /test \! -e \/opt\/headlesscode\/scripts\/rsi-benchmark\/task-spec\.mjs/)
					assert.match(command, /test \! -e \/opt\/headlesscode\/fixtures\/rsi-benchmark/)
					if (["self-hosted-missing-cli", "self-hosted-corrupt-cli", "dependency-escape"].includes(mode)) {
						assert.match(command, /\/workspace\/src\/cli\.ts/)
						assert.match(command, /test "\$\(readlink \/workspace\/node_modules\)" = \/opt\/headlesscode\/node_modules/)
						const separator = command.indexOf(" && exec ")
						assert.ok(separator > 0, "worker command must follow the complete preflight guard")
						const preflight = command.slice(0, separator)
							.replaceAll("/workspace", guestPath)
							.replaceAll("/opt/headlesscode", trustedRuntimeRoot)
						const boundary = spawnSync("/bin/bash", ["-c", preflight], {
							encoding: "utf8",
							env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir() },
						})
						if (mode === "self-hosted-missing-cli" || mode === "dependency-escape") {
							assert.equal(boundary.status, 79, "the actual shell preflight must stop on the missing CLI or escaped dependency link")
							assert.match(boundary.stderr, /RSI_BENCHMARK_PREFLIGHT_FAILURE/)
							return { exitCode: 79, output: boundary.stderr }
						}
						assert.equal(boundary.status, 0, "an existing but corrupted CLI passes only the readability/link preflight")
						assert.throws(() => transformSync(fs.readFileSync(path.join(guestPath, "src", "cli.ts"), "utf8"), { loader: "ts" }), /Expected/)
						candidateCliInvocations += 1
						return { exitCode: 1, output: "SyntaxError in /workspace/src/cli.ts" }
					}
					if (mode === "preflight") {
						assert.match(command, /headlesscode-harness-commit/)
						return { exitCode: 79, output: "RSI_BENCHMARK_PREFLIGHT_FAILURE wrong harness image commit" }
					}
					assert.equal(command.split("/opt/headlesscode/src/cli.ts").length - 1, 1, "the benchmark coding worker command must execute exactly once")
					if (mode === "worker-failure") return { exitCode: 1, output: "model process failed" }
					if (mode === "source") {
						fs.writeFileSync(path.join(guestPath, "src", "engine", "loop.ts"), "export const value = 2\n")
					} else if (mode === "escape") {
						fs.mkdirSync(path.join(guestPath, "scripts", "eval-suite"), { recursive: true })
						fs.writeFileSync(path.join(guestPath, "scripts", "eval-suite", "injected.sh"), "secret\n")
					} else if (mode === "protected-package") {
						fs.writeFileSync(path.join(guestPath, "package.json"), "{\"scripts\":{\"preinstall\":\"touch /tmp/pwned\"}}\n")
					} else {
						fs.symlinkSync("/etc/passwd", path.join(guestPath, "src", "engine", "external"))
					}
					execFileSync("git", ["add", "--all"], { cwd: guestPath })
					execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "guest output"], { cwd: guestPath })
					fs.mkdirSync(path.join(guestPath, ".headlesscode", "rsi-transcripts"), { recursive: true })
					fs.writeFileSync(path.join(guestPath, ".headlesscode", "rsi-transcripts", "mock.jsonl"), `${JSON.stringify({ response: { usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } } })}\n`)
					return { exitCode: 0, output: "bounded fake guest result" }
				},
				async teardown() {},
			}
		}
		if (mode === "preflight") {
			await assert.rejects(runOpenShellMutation(candidate, config, providerFactory), /OpenShell benchmark preflight failed/)
			assert.equal(fs.readFileSync(path.join(worktree, "src", "engine", "loop.ts"), "utf8"), "export const value = 1\n", "wrong harness image must abort before task code runs")
			return
		}
		if (mode === "self-hosted-missing-cli" || mode === "dependency-escape") {
			await assert.rejects(runOpenShellMutation(candidate, config, providerFactory), /OpenShell benchmark preflight failed/)
			assert.equal(workerInvocations, 1, "one boundary-check command should report the failing preflight")
			assert.equal(candidateCliInvocations, 0, "the failing preflight must stop before the candidate CLI is executed")
			assert.equal(fs.readFileSync(path.join(worktree, "src", "cli.ts"), "utf8"), "export const workerCli = true\n")
			return
		}
		if (mode === "self-hosted-corrupt-cli") {
			const result = await runOpenShellMutation(candidate, config, providerFactory)
			assert.equal(result.ok, false, "a corrupted selected-parent CLI is a failed worker result")
			assert.match(result.error ?? "", /mutation worker failed.*SyntaxError/)
			assert.equal(candidateCliInvocations, 1, "the corrupted self-hosted CLI was the attempted worker entrypoint")
			assert.equal(fs.readFileSync(path.join(worktree, "src", "cli.ts"), "utf8"), "export const workerCli = true\n", "failed CLI execution must not import a candidate patch")
			return
		}
		if (mode === "snapshot-mismatch") {
			await assert.rejects(runOpenShellMutation(candidate, config, providerFactory), /snapshot tree digest differs from the frozen fleet job identity/)
			assert.equal(factoryOptions, undefined, "a snapshot identity mismatch must abort before provider creation")
			assert.equal(workerInvocations, 0, "a snapshot identity mismatch must abort before guest execution")
			return
		}
		if (mode === "protected-package") {
			const result = await runOpenShellMutation(candidate, config, providerFactory)
			assert.equal(result.ok, false)
			assert.match(result.error ?? "", /protected paths/)
			assert.equal(fs.readFileSync(path.join(worktree, "package.json"), "utf8"), "{\"name\":\"fixture\"}\n", "candidate package metadata must not be imported")
			return
		}
		if (mode === "worker-failure") {
			const result = await runOpenShellMutation(candidate, config, providerFactory)
			assert.equal(result.ok, false)
			assert.match(result.error ?? "", /OpenShell mutation worker failed/)
			assert.doesNotMatch(result.error ?? "", /preflight failed/)
			assert.equal(workerInvocations, 1)
			return
		}
		const imageRef = mode === "source" ? `sha256:${"a".repeat(64)}` : undefined
		const result = await runOpenShellMutation(candidate, config, providerFactory, imageRef)
		assert.equal(factoryOptions?.includeProjectData, false)
		assert.equal(factoryOptions?.image, imageRef ?? "headlesscode-openshell-rsi:local")
		assert.deepEqual(factoryOptions?.providers, [])
		assert.equal(sessionEnv?.HEADLESSCODE_CODE_MODE_BACKEND, "ollama")
		if (mode === "source") {
			assert.equal(result.ok, true, result.error)
			assert.equal(fs.readFileSync(path.join(worktree, "src", "engine", "loop.ts"), "utf8"), "export const value = 2\n")
		} else if (mode === "escape") {
			assert.equal(result.ok, false)
			assert.match(result.error ?? "", /protected paths/)
			assert.equal(fs.readFileSync(path.join(worktree, "src", "engine", "loop.ts"), "utf8"), "export const value = 1\n")
		} else {
			assert.equal(result.ok, false)
			assert.match(result.error ?? "", /symlinks, submodules, or special files/)
			assert.equal(fs.existsSync(path.join(worktree, "src", "engine", "external")), false)
		}
	} finally {
		if (originalPath === undefined) delete process.env.PATH
		else process.env.PATH = originalPath
		fs.rmSync(repo, { recursive: true, force: true })
	}
}

await run("source")
await run("escape")
await run("symlink")
await run("preflight")
await run("worker-failure")
await run("snapshot-mismatch")
await run("protected-package")
await run("self-hosted-missing-cli")
await run("self-hosted-corrupt-cli")
await run("dependency-escape")

{
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hc-rsi-benchmark-verifier-"))
	const worktree = path.join(repo, ".worktrees", "task")
	let verifierGuest = ""
	let tornDown = false
	try {
		fs.mkdirSync(path.join(worktree, "src"), { recursive: true })
		fs.writeFileSync(path.join(worktree, "src", "candidate.js"), "export const value = 1\n")
		execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: worktree })
		execFileSync("git", ["config", "user.name", "Test"], { cwd: worktree })
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: worktree })
		execFileSync("git", ["add", "--all"], { cwd: worktree })
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "candidate"], { cwd: worktree })
		const parsed = parseRsiArgs(["--repo", repo, "--regression", "true", "--max-runtime-ms", "5000"])
		assert.ok(parsed.config)
		const candidate: CandidateRecord = { id: "multi-01", generation: 0, parent: "test", branch: "main", worktree, baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(), status: "evaluating", model: "test", mutation: "test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), commits: [], changedFiles: [], protectedPathViolations: [] }
		const factory: RsiOpenShellProviderFactory = () => ({
			async spawnExistingWorktreeSession(_request, snapshot) {
				verifierGuest = snapshot
				assert.equal(fs.existsSync(path.join(snapshot, "fixtures", "rsi-benchmark")), false, "confirmation and corpus fixtures must not enter the verifier task snapshot")
				assert.equal(fs.readFileSync(path.join(snapshot, "__rsi_benchmark_verifier__", "verify.mjs"), "utf8"), "assert.fail('known-bad candidate')\n", "the verifier bytes are supplied only to the isolated verifier guest")
				return { id: "mock-verifier", provider: "mock-openshell", address: snapshot }
			},
			async waitReady() {},
			async runHarness(_handle, command) {
				assert.match(command, /RSI_BENCHMARK_VERIFIER_COMPLETED/)
				assert.match(command, /readlink \/workspace\/node_modules/)
				assert.match(command, /\/usr\/local\/bin\/node/)
				assert.match(command, /HEADLESSCODE_BENCHMARK_TSX=\/opt\/headlesscode\/node_modules\/tsx\/dist\/cli\.mjs/)
				assert.doesNotMatch(command, /ln -s .*\/workspace\/node_modules/)
				assert.equal(fs.readFileSync(path.join(verifierGuest, "src", "candidate.js"), "utf8"), "export const value = 1\n")
				return { exitCode: 1, output: "AssertionError: known-bad candidate\nRSI_BENCHMARK_VERIFIER_COMPLETED:1\n" }
			},
			async teardown() { tornDown = true },
		})
		const result = await runOpenShellBenchmarkVerifier(candidate, parsed.config, Buffer.from("assert.fail('known-bad candidate')\n"), "multi-01", factory)
		assert.equal(result.exitCode, 1, "completed verifier assertion failure is a task rejection, not infrastructure failure")
		assert.equal(tornDown, true)
		assert.equal(fs.existsSync(verifierGuest), false, "verifier guest snapshot is removed after teardown")
		await assert.rejects(runOpenShellBenchmarkVerifier(candidate, parsed.config, Buffer.from("true\n"), "multi-01", () => ({
			async spawnExistingWorktreeSession(_request, snapshot) { verifierGuest = snapshot; return { id: "timeout-marker", provider: "mock-openshell", address: snapshot } },
			async waitReady() {}, async runHarness() { return { exitCode: 125, output: "RSI_BENCHMARK_VERIFIER_INFRA_FAILURE:ETIMEDOUT\nRSI_BENCHMARK_VERIFIER_COMPLETED:125\n" } }, async teardown() { tornDown = true },
		})), /child reported infrastructure failure/)
		await assert.rejects(runOpenShellBenchmarkVerifier(candidate, parsed.config, Buffer.from("true\n"), "multi-01", () => ({
			async spawnExistingWorktreeSession(_request, snapshot) { verifierGuest = snapshot; return { id: "missing-marker", provider: "mock-openshell", address: snapshot } },
			async waitReady() {}, async runHarness() { return { exitCode: 1, output: "sandbox transport failed" } }, async teardown() { tornDown = true },
		})), /did not return its completion marker/)
	} finally { fs.rmSync(repo, { recursive: true, force: true }) }
}

{
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hc-rsi-eval-bundle-"))
	const unpack = fs.mkdtempSync(path.join(os.tmpdir(), "hc-rsi-eval-unpack-"))
	try {
		execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo })
		for (const [relative, body] of [["src/app.ts", "source\n"], ["test/app.test.ts", "visible test\n"], ["scripts/eval-suite/hidden.js", "hidden suite\n"], ["src/rsi/fitness.ts", "hidden scorer\n"], [".headlesscode/archive.json", "operator archive\n"], [".headlesscode/rsi-proof/plan.json", "sealed confirmation metadata\n"], ["fixtures/rsi-curriculum/generalization.json", "{}\n"], ["fixtures/rsi-benchmark/confirmation.json", "private proof task\n"]]) {
			const target = path.join(repo, relative)
			fs.mkdirSync(path.dirname(target), { recursive: true })
			fs.writeFileSync(target, body)
		}
		execFileSync("git", ["add", "--all"], { cwd: repo })
		execFileSync("git", ["commit", "--quiet", "-m", "snapshot source"], { cwd: repo })
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		const bundle = createEvaluationSnapshotBundle(repo, head, { protectedPaths: [], repoRoot: repo } as unknown as RsiConfig)
		const replayBundle = createEvaluationSnapshotBundle(repo, head, { protectedPaths: [], repoRoot: repo } as unknown as RsiConfig)
		assert.equal(replayBundle.snapshotCommit, bundle.snapshotCommit, "the same clean base/config must produce a stable snapshot commit on resume")
		assert.deepEqual(replayBundle.content, bundle.content, "the same clean base/config must produce the same content-addressed bundle")
		const bundlePath = path.join(unpack, "snapshot.bundle")
		const clonePath = path.join(unpack, "repo")
		fs.writeFileSync(bundlePath, bundle.content)
		execFileSync("git", ["clone", "--quiet", bundlePath, clonePath], { cwd: unpack })
		assert.equal(fs.existsSync(path.join(clonePath, "test/app.test.ts")), true, "visible tests remain available for evaluation jobs")
		assert.equal(fs.existsSync(path.join(clonePath, "scripts/eval-suite/hidden.js")), false)
		assert.equal(fs.existsSync(path.join(clonePath, "src/rsi/fitness.ts")), false)
		assert.equal(fs.existsSync(path.join(clonePath, ".headlesscode/archive.json")), false)
		assert.equal(fs.existsSync(path.join(clonePath, "fixtures/rsi-curriculum/generalization.json")), true, "registered curriculum fixtures remain available to evaluation guests")
		assert.equal(fs.existsSync(path.join(clonePath, "fixtures/rsi-benchmark/confirmation.json")), false, "benchmark task and verifier data stays outside evaluation guests")
		assert.equal(fs.existsSync(path.join(clonePath, ".headlesscode/rsi-proof/plan.json")), false, "frozen operator plan and confirmation metadata stay outside evaluation guests")
		assert.equal(fs.lstatSync(path.join(clonePath, "test/app.test.ts")).isSymbolicLink(), false, "bundle transfer excludes harness-only dependency symlinks")
		const mutation = createMutationSnapshotBundle(repo, head, { protectedPaths: [], repoRoot: repo } as unknown as RsiConfig)
		const mutationBundle = path.join(unpack, "mutation.bundle")
		const mutationClone = path.join(unpack, "mutation-repo")
		fs.writeFileSync(mutationBundle, mutation.content)
		execFileSync("git", ["clone", "--quiet", mutationBundle, mutationClone], { cwd: unpack })
		assert.equal(fs.existsSync(path.join(mutationClone, "fixtures/rsi-curriculum/generalization.json")), false, "mutation guests never receive evaluator-owned fixture assets")
		assert.equal(fs.existsSync(path.join(mutationClone, "fixtures/rsi-benchmark/confirmation.json")), false, "mutation guests never receive benchmark task and verifier data")
		assert.equal(fs.existsSync(path.join(mutationClone, ".headlesscode/rsi-proof/plan.json")), false, "mutation guests never receive the frozen proof plan")
	} finally {
		fs.rmSync(repo, { recursive: true, force: true })
		fs.rmSync(unpack, { recursive: true, force: true })
	}
}
	const runtimeDockerfile = fs.readFileSync(path.join(process.cwd(), "docker", "OpenShell.Dockerfile"), "utf8")
	const rsiDockerfile = fs.readFileSync(path.join(process.cwd(), "docker", "OpenShell-RSI.Dockerfile"), "utf8")
	const dockerIgnore = fs.readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8")
	assert.match(dockerIgnore, /^scripts\/$/m, "benchmark corpus source is excluded from Docker build context")
	assert.match(runtimeDockerfile, /COPY scripts\/spawn-parallel-worktrees\.sh scripts\/run-worker\.sh scripts\/headlesscode-answer\.sh \.\/scripts\//, "runtime image copies only the named operational scripts")
	assert.doesNotMatch(runtimeDockerfile, /COPY (?:\.\/)?scripts\s/, "runtime image does not copy the scripts tree")
	assert.match(runtimeDockerfile, /test ! -e \/opt\/headlesscode\/scripts\/rsi-benchmark\/task-spec\.mjs/, "runtime image build fails if task descriptions and known-good SHAs enter the image")
	assert.match(rsiDockerfile, /test ! -e \/opt\/headlesscode\/fixtures\/rsi-benchmark/, "RSI image build fails if confirmation fixtures enter the image")
	assert.match(rsiDockerfile, /test ! -e \/opt\/headlesscode\/\.git/, "RSI guest image cannot expose harness history containing known fixes")
	console.log("RSI OpenShell isolation assertions passed")

{
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hc-rsi-fleet-patch-"))
	try {
		execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo })
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repo })
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo })
		fs.writeFileSync(path.join(repo, "app.js"), "module.exports = 1\n")
		fs.writeFileSync(path.join(repo, "protected.txt"), "unchanged\n")
		execFileSync("git", ["add", "--all"], { cwd: repo })
		execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repo })
		const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
		const createWorktree = (name: string): string => {
			const directory = path.join(repo, ".worktrees", name)
			fs.mkdirSync(path.dirname(directory), { recursive: true })
			execFileSync("git", ["worktree", "add", "--quiet", "-b", name, directory, baseCommit], { cwd: repo })
			return directory
		}
		const makeCandidate = (name: string, worktree: string): CandidateRecord => ({
			id: name,
			generation: 0,
			parent: "baseline",
			branch: name,
			worktree,
			baseCommit,
			status: "mutating",
			model: "test-model",
			mutation: "test patch import",
			createdAt: "now",
			updatedAt: "now",
			commits: [],
			changedFiles: [],
			protectedPathViolations: [],
		})
		const config = { protectedPaths: ["protected.txt"] } as RsiConfig

		const validSource = createWorktree("valid-source")
		const validTarget = createWorktree("valid-target")
		fs.writeFileSync(path.join(validSource, "app.js"), "module.exports = 2\n")
		fs.writeFileSync(path.join(validSource, "asset.bin"), Buffer.from([0, 1, 2, 255, 0]))
		execFileSync("git", ["add", "--all"], { cwd: validSource })
		execFileSync("git", ["commit", "--quiet", "-m", "valid source patch"], { cwd: validSource })
		const validPatch = execFileSync("git", ["diff", "--binary", "--no-renames", `${baseCommit}...HEAD`], { cwd: validSource })
		const changed = applyFleetMutationPatch(validPatch, makeCandidate("valid-target", validTarget), config)
		assert.deepEqual(changed.sort(), ["app.js", "asset.bin"])
		assert.deepEqual(fs.readFileSync(path.join(validTarget, "asset.bin")), Buffer.from([0, 1, 2, 255, 0]))
		assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: validTarget, encoding: "utf8" }), "")

		const protectedSource = createWorktree("protected-source")
		const protectedTarget = createWorktree("protected-target")
		fs.writeFileSync(path.join(protectedSource, "protected.txt"), "tampered\n")
		execFileSync("git", ["add", "--all"], { cwd: protectedSource })
		execFileSync("git", ["commit", "--quiet", "-m", "protected source patch"], { cwd: protectedSource })
		const protectedPatch = execFileSync("git", ["diff", "--binary", "--no-renames", `${baseCommit}...HEAD`], { cwd: protectedSource })
		assert.throws(() => applyFleetMutationPatch(protectedPatch, makeCandidate("protected-target", protectedTarget), config), /protected paths/)
		assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: protectedTarget, encoding: "utf8" }), "")
		assert.equal(fs.readFileSync(path.join(protectedTarget, "protected.txt"), "utf8"), "unchanged\n")

		const modeSource = createWorktree("mode-source")
		const modeTarget = createWorktree("mode-target")
		fs.rmSync(path.join(modeSource, "app.js"))
		fs.symlinkSync("protected.txt", path.join(modeSource, "app.js"))
		execFileSync("git", ["add", "--all"], { cwd: modeSource })
		execFileSync("git", ["commit", "--quiet", "-m", "mode source patch"], { cwd: modeSource })
		const modePatch = execFileSync("git", ["diff", "--binary", "--no-renames", `${baseCommit}...HEAD`], { cwd: modeSource })
		assert.throws(() => applyFleetMutationPatch(modePatch, makeCandidate("mode-target", modeTarget), config), /symlinks or special files/)
		assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: modeTarget, encoding: "utf8" }), "")
		assert.equal(fs.lstatSync(path.join(modeTarget, "app.js")).isSymbolicLink(), false)
	} finally {
		fs.rmSync(repo, { recursive: true, force: true })
	}
}
const checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hc-rsi-model-checkpoint-"))
try {
	const checkpoint = path.join(checkpointRoot, "checkpoint")
	fs.mkdirSync(checkpoint)
	fs.writeFileSync(path.join(checkpoint, "config.json"), '{"model_type":"fixture"}\n')
	fs.writeFileSync(path.join(checkpoint, "weights.bin"), "small")
	assert.equal(inspectLocalRsiCheckpoint(checkpoint, "training").files, 2)
	fs.truncateSync(path.join(checkpoint, "weights.bin"), 2 * 1024 * 1024 * 1024 + 1)
	assert.throws(() => inspectLocalRsiCheckpoint(checkpoint, "model-evaluation"), /larger than 2 GiB/)
	fs.truncateSync(path.join(checkpoint, "weights.bin"), 5)
	const outside = path.join(checkpointRoot, "outside")
	fs.writeFileSync(outside, "external")
	fs.symlinkSync(outside, path.join(checkpoint, "linked-weights"))
	assert.throws(() => inspectLocalRsiCheckpoint(checkpoint, "training"), /symlink or special file/)
} finally {
	fs.rmSync(checkpointRoot, { recursive: true, force: true })
}
assert.deepEqual(networkRules("evaluation"), {}, "visible evaluation receives no network allowance")
assert.deepEqual(networkRules("training"), {}, "offline training receives no network allowance")
assert.deepEqual(networkRules("model-evaluation"), {}, "offline model evaluation receives no network allowance")
assert.deepEqual(Object.keys(networkRules("mutation")), ["rsi_local_ollama"], "only the mutation worker receives the local Ollama allowance")
console.log("RSI fleet mutation and model checkpoint assertions passed")
