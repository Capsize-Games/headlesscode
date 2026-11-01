import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
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

test(
	"a real evaluation snapshot typechecks with protected code withheld",
	{ timeout: 120_000 },
	async () => {
		const paths = makeBoundaryPaths()
		const saved = saveBoundaryEnv()
		try {
			armBoundaryGit(paths)
			const snapshot = readBoundarySnapshot(paths)
			const clone = materializeBoundaryClone(paths, snapshot)
			await assertBoundaryLayout(clone)
			await assertBoundaryTypecheck(paths, clone)
		} finally {
			restoreBoundaryEnv(saved, paths.root)
		}
	},
)

interface BoundaryPaths {
	repoRoot: string
	scratch: string
	root: string
	gitConfig: string
	gitTrace: string
}

interface BoundaryEnv {
	tmpDir: string | undefined
	gitConfigGlobal: string | undefined
	gitTrace2Event: string | undefined
}

function makeBoundaryPaths(): BoundaryPaths {
	const repoRoot = process.cwd()
	const scratch = path.join(repoRoot, ".headlesscode", "scratch")
	fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })
	const root = fs.mkdtempSync(path.join(scratch, "rsi-cli-boundary-typecheck-"))
	return {
		repoRoot,
		scratch,
		root,
		gitConfig: path.join(root, "forced-git-maintenance.config"),
		gitTrace: path.join(root, "git-trace2.json"),
	}
}

function saveBoundaryEnv(): BoundaryEnv {
	return {
		tmpDir: process.env.TMPDIR,
		gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL,
		gitTrace2Event: process.env.GIT_TRACE2_EVENT,
	}
}

function restoreBoundaryEnv(saved: BoundaryEnv, root: string): void {
	if (saved.tmpDir === undefined) delete process.env.TMPDIR
	else process.env.TMPDIR = saved.tmpDir
	if (saved.gitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
	else process.env.GIT_CONFIG_GLOBAL = saved.gitConfigGlobal
	if (saved.gitTrace2Event === undefined) delete process.env.GIT_TRACE2_EVENT
	else process.env.GIT_TRACE2_EVENT = saved.gitTrace2Event
	fs.rmSync(root, { recursive: true, force: true })
}

function armBoundaryGit(paths: BoundaryPaths): void {
	fs.writeFileSync(
		paths.gitConfig,
		"[gc]\n\tauto = 1\n\tautoDetach = true\n[maintenance]\n\tauto = true\n",
		{ mode: 0o600, flag: "wx" },
	)
	process.env.TMPDIR = paths.scratch
	process.env.GIT_CONFIG_GLOBAL = paths.gitConfig
	process.env.GIT_TRACE2_EVENT = paths.gitTrace
}

function readBoundarySnapshot(
	paths: BoundaryPaths,
): ReturnType<typeof createEvaluationSnapshotBundle> {
	const commit = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: paths.repoRoot, encoding: "utf8",
	}).trim()
	const parsedConfig = parseRsiArgs(["--repo", paths.repoRoot])
	if (!parsedConfig.config || parsedConfig.error) {
		throw new Error(
			parsedConfig.error ?? "could not make evaluation snapshot config",
		)
	}
	const snapshot = createEvaluationSnapshotBundle(
		paths.repoRoot, commit, parsedConfig.config,
	)
	assertBoundaryGitQuiet(paths)
	return snapshot
}

function assertBoundaryGitQuiet(paths: BoundaryPaths): void {
	const gitEvents = fs.readFileSync(paths.gitTrace, "utf8")
	assert.doesNotMatch(
		gitEvents,
		/"argv":\["git","maintenance","run","--auto"/,
		"snapshot Git commit must not detach background maintenance",
	)
	assert.doesNotMatch(
		gitEvents,
		/"argv":\["git","gc","--auto"/,
		"snapshot Git commit must not detach background garbage collection",
	)
}

function materializeBoundaryClone(
	paths: BoundaryPaths,
	snapshot: ReturnType<typeof createEvaluationSnapshotBundle>,
): string {
	const bundlePath = path.join(paths.root, "evaluation.bundle")
	const clone = path.join(paths.root, "candidate")
	fs.writeFileSync(bundlePath, snapshot.content, { mode: 0o600, flag: "wx" })
	execFileSync("git", ["clone", "--quiet", bundlePath, clone], {
		cwd: paths.root, stdio: "pipe",
	})
	return clone
}

async function assertBoundaryLayout(clone: string): Promise<void> {
	assert.equal(
		fs.existsSync(path.join(clone, "src", "rsi")),
		false,
		"the evaluation clone must not contain any RSI source or entrypoint",
	)
	const campaignControl = path.join(clone, "src", "campaigncontrol")
	assert.deepEqual(
		fs.readdirSync(campaignControl).sort(),
		["cli.ts", "repository-curl-evaluator.ts", "repository-known-advisory.ts"],
		"the evaluation clone contains only the non-operational campaign shims",
	)
	assert.equal(
		fs.existsSync(path.join(campaignControl, "repository-campaigns.ts")),
		false,
		"the evaluation clone must not contain the campaign control plane",
	)
	await assertBoundaryShimDisabled(campaignControl)
}

async function assertBoundaryShimDisabled(
	campaignControl: string,
): Promise<void> {
	const shim = await importBoundaryShim(campaignControl)
	assert.equal(
		await shim.campaignMain(["start", "curl-maintenance"]),
		2,
		"campaign actions remain unavailable in the evaluation clone",
	)
}

async function importBoundaryShim(
	campaignControl: string,
): Promise<{ campaignMain(args: string[]): Promise<number> }> {
	return import(pathToFileURL(path.join(campaignControl, "cli.ts")).href)
}

async function assertBoundaryTypecheck(
	paths: BoundaryPaths,
	clone: string,
): Promise<void> {
	assert.equal(
		fs.existsSync(path.join(clone, "src", "rsi-cli-contract.ts")),
		true,
		"the visible CLI contract remains available to candidate typechecking",
	)
	fs.symlinkSync(
		path.join(paths.repoRoot, "node_modules"),
		path.join(clone, "node_modules"),
		"dir",
	)
	const output = runBoundaryTypecheck(paths, clone)
	assert.match(output, /tsc --noEmit/)
}

function runBoundaryTypecheck(paths: BoundaryPaths, clone: string): string {
	const environment = { ...process.env, TMPDIR: paths.scratch }
	return execFileSync("npm", ["run", "typecheck"], {
		cwd: clone,
		env: environment,
		encoding: "utf8",
		timeout: 100_000,
		maxBuffer: 16 * 1024 * 1024,
	})
}
