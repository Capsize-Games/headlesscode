import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import test from "node:test"
import { main } from "../../cli.js"
import { createEvaluationSnapshotBundle } from "../openshell.js"
import { parseRsiArgs } from "../config.js"
import type { RsiCliEntrypoint, RsiCliIO } from "../../rsi-cli-contract.js"
import { rsiCliMain } from "../cli.js"

const protectedEntrypoint: RsiCliEntrypoint = rsiCliMain

test("visible CLI dispatches RSI help and rejects invalid model-training mode through protected entrypoint", async () => {
	let stdout = ""
	let stderr = ""
	const io: RsiCliIO = {
		stdout: { write: (text) => { stdout += text } },
		stderr: { write: (text) => { stderr += text } },
	}
	assert.equal(await main(["rsi-train-model", "--help"], io), 0)
	assert.match(stdout, /^Usage: headlesscode rsi-train-model/)
	assert.match(stdout, /OpenShell training image/)
	assert.equal(stderr, "")

	stdout = ""
	stderr = ""
	const scratch = path.join(process.cwd(), ".headlesscode", "scratch")
	fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
	assert.equal(await main([
		"rsi-train-model", "--repo", process.cwd(), "--archive-dir", scratch,
		"--resume", "synthetic-run", "--model-candidate-id", "synthetic-model", "--dry-run",
	], io), 2)
	assert.match(stderr, /dry-run is unsupported/)
	assert.equal(stdout, "")
	assert.equal(protectedEntrypoint, rsiCliMain)
})

test("a real evaluation snapshot typechecks with all protected RSI implementations withheld", { timeout: 120_000 }, () => {
	const repoRoot = process.cwd()
	const scratch = path.join(repoRoot, ".headlesscode", "scratch")
	fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
	const root = fs.mkdtempSync(path.join(scratch, "rsi-cli-boundary-typecheck-"))
	const previousTmpDir = process.env.TMPDIR
	const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
	const previousGitTrace2Event = process.env.GIT_TRACE2_EVENT
	const gitConfig = path.join(root, "forced-git-maintenance.config")
	const gitTrace = path.join(root, "git-trace2.json")
	try {
		fs.writeFileSync(gitConfig, "[gc]\n\tauto = 1\n\tautoDetach = true\n[maintenance]\n\tauto = true\n", { mode: 0o600, flag: "wx" })
		process.env.TMPDIR = scratch
		process.env.GIT_CONFIG_GLOBAL = gitConfig
		process.env.GIT_TRACE2_EVENT = gitTrace
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
		const parsedConfig = parseRsiArgs(["--repo", repoRoot])
		if (!parsedConfig.config || parsedConfig.error) throw new Error(parsedConfig.error ?? "could not make evaluation snapshot config")
		const snapshot = createEvaluationSnapshotBundle(repoRoot, commit, parsedConfig.config)
		const gitEvents = fs.readFileSync(gitTrace, "utf8")
		assert.doesNotMatch(gitEvents, /"argv":\["git","maintenance","run","--auto"/, "snapshot Git commit must not detach background maintenance")
		assert.doesNotMatch(gitEvents, /"argv":\["git","gc","--auto"/, "snapshot Git commit must not detach background garbage collection")
		const bundlePath = path.join(root, "evaluation.bundle")
		const clone = path.join(root, "candidate")
		fs.writeFileSync(bundlePath, snapshot.content, { mode: 0o600, flag: "wx" })
		execFileSync("git", ["clone", "--quiet", bundlePath, clone], { cwd: root, stdio: "pipe" })
		assert.equal(fs.existsSync(path.join(clone, "src", "rsi")), false, "the evaluation clone must not contain any RSI source or entrypoint")
		assert.equal(fs.existsSync(path.join(clone, "src", "rsi-cli-contract.ts")), true, "the visible CLI contract remains available to candidate typechecking")
		fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(clone, "node_modules"), "dir")
		const environment = { ...process.env, TMPDIR: scratch }
		const output = execFileSync("npm", ["run", "typecheck"], { cwd: clone, env: environment, encoding: "utf8", timeout: 100_000, maxBuffer: 16 * 1024 * 1024 })
		assert.match(output, /tsc --noEmit/)
	} finally {
		if (previousTmpDir === undefined) delete process.env.TMPDIR
		else process.env.TMPDIR = previousTmpDir
		if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
		else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal
		if (previousGitTrace2Event === undefined) delete process.env.GIT_TRACE2_EVENT
		else process.env.GIT_TRACE2_EVENT = previousGitTrace2Event
		fs.rmSync(root, { recursive: true, force: true })
	}
})
