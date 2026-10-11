import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { adversarialEvaluationArtifactIdentity, adversarialEvaluationRunner, resolveRsiEvaluatorPolicySha256, runOpenShellEvaluation } from "../openshell.js"
import type { RsiOpenShellProviderFactory } from "../openshell.js"
import { ADVERSARIAL_COMMAND, ADVERSARIAL_RUNNER_PATH, ADVERSARIAL_TESTS_PATH } from "../adversarial.js"
import { parseRsiArgs } from "../config.js"
import type { CandidateRecord } from "../types.js"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-rsi-adversarial-guest-"))
const repo = path.join(root, "repo")
const worktree = path.join(repo, ".worktrees", "candidate")
const policyPath = path.join(root, "operator-policy.yaml")
const originalPolicy = process.env.HEADLESSCODE_OPENSHELL_POLICY
const policyBytes = Buffer.from("sandbox:\n  network: disabled\n")
const tests = Buffer.from(JSON.stringify({ schemaVersion: 1, tests: [{ id: "upper-clamp", modulePath: "src/math.mjs", exportName: "clamp", args: [20, 0, 10], expected: 10, reason: "the upper bound must be applied" }] }))
const runner = adversarialEvaluationRunner()
const identity = adversarialEvaluationArtifactIdentity(tests)
assert.equal(identity.runnerSha256, createHash("sha256").update(runner).digest("hex"))
let activeGuest = ""
let actualRuns = 0
let guestCount = 0

try {
	fs.mkdirSync(path.join(worktree, "src"), { recursive: true })
	fs.mkdirSync(path.join(worktree, "__headlesscode_rsi_adversarial__"), { recursive: true })
	fs.writeFileSync(policyPath, policyBytes, { mode: 0o400 })
	process.env.HEADLESSCODE_OPENSHELL_POLICY = policyPath
	fs.writeFileSync(path.join(worktree, "src", "math.mjs"), "export const clamp = (value, min, max) => Math.min(Math.max(value, min), max)\n")
	fs.writeFileSync(path.join(worktree, ADVERSARIAL_TESTS_PATH), "candidate-authored tests must be excluded\n")
	fs.writeFileSync(path.join(worktree, ADVERSARIAL_RUNNER_PATH), "candidate-authored runner must be excluded\n")
	execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: worktree })
	execFileSync("git", ["config", "user.name", "Test"], { cwd: worktree })
	execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: worktree })
	execFileSync("git", ["add", "--all"], { cwd: worktree })
	execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "candidate"], { cwd: worktree })
	const parsed = parseRsiArgs(["--repo", repo, "--regression", "true", "--eval", ADVERSARIAL_COMMAND])
	assert.ok(parsed.config)
	const candidate: CandidateRecord = { id: "adversarial-guest", generation: 0, parent: "test", branch: "main", worktree, baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(), status: "evaluating", model: "test", mutation: "test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), commits: [], changedFiles: [], protectedPathViolations: [] }
	const factory: RsiOpenShellProviderFactory = () => ({
		async spawnExistingWorktreeSession(_request, snapshot) {
			activeGuest = snapshot
			guestCount += 1
			if (guestCount % 3 === 0) {
				assert.deepEqual(fs.readFileSync(path.join(snapshot, ADVERSARIAL_TESTS_PATH)), tests)
				assert.deepEqual(fs.readFileSync(path.join(snapshot, ADVERSARIAL_RUNNER_PATH)), runner)
				fs.unlinkSync(path.join(snapshot, "node_modules"))
				fs.symlinkSync(path.resolve("node_modules"), path.join(snapshot, "node_modules"))
			} else {
				assert.equal(fs.existsSync(path.join(snapshot, ADVERSARIAL_TESTS_PATH)), false, "adversarial artifacts are absent from unrelated evaluation guests")
			}
			return { id: `adversarial-${actualRuns}`, provider: "mock-openshell", address: snapshot }
		},
		async waitReady() {},
		async runHarness(_handle, command) {
			if (!command.endsWith(ADVERSARIAL_COMMAND)) return { exitCode: 0, output: "ok" }
			actualRuns += 1
			const run = spawnSync("node", ["--import", "tsx", ADVERSARIAL_RUNNER_PATH], { cwd: activeGuest, encoding: "utf8", timeout: 20_000 })
			return { exitCode: run.status ?? 1, output: run.stdout + run.stderr }
		},
		async teardown() {},
	})
	const runtime = { imageDigest: `sha256:${"c".repeat(64)}`, policySha256: await resolveRsiEvaluatorPolicySha256() }
	const passing = await runOpenShellEvaluation(candidate, parsed.config, undefined, undefined, runtime, factory, { tests, runner })
	assert.equal(passing.visible[0]?.ok, true, "the real runner passes in the staged guest snapshot")
	assert.match(passing.visible[0]?.stdout ?? "", /PASS upper-clamp/)
	fs.writeFileSync(path.join(worktree, "src", "math.mjs"), "export const clamp = (value, min, max) => Math.min(Math.max(value, min), min)\n")
	execFileSync("git", ["add", "src/math.mjs"], { cwd: worktree })
	execFileSync("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "seed upper clamp defect"], { cwd: worktree })
	const failing = await runOpenShellEvaluation(candidate, parsed.config, undefined, undefined, runtime, factory, { tests, runner })
	assert.equal(failing.visible[0]?.ok, false, "the seeded upper-clamp defect fails through the staged guest runner")
	assert.equal(actualRuns, 2)
	console.log("Adversarial evaluator guest staging assertions passed")
	} finally {
	if (originalPolicy === undefined) delete process.env.HEADLESSCODE_OPENSHELL_POLICY
	else process.env.HEADLESSCODE_OPENSHELL_POLICY = originalPolicy
	fs.rmSync(root, { recursive: true, force: true })
}
