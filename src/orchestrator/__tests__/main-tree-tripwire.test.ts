import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { removeHarnessArtifacts } from "../cleanup.js"
import { buildStatusSummary, formatStatusText } from "../status.js"
import { reconcileGroups } from "../status.js"
import { runMain } from "../../test-runner.js"
import {
	DEFAULT_STALL_TIMEOUT_MS,
	inspectGroup,
	readMainTreeDirty,
} from "../watch.js"

const SCRIPT = fileURLToPath(
	new URL("../../../scripts/check-main-tree-clean.sh", import.meta.url),
)

function git(repo: string, args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim()
}

async function initRepo(repo: string): Promise<void> {
	execFileSync("git", ["init", "-q", "-b", "main", repo], {
		stdio: "ignore",
	})
	git(repo, ["config", "user.email", "test@headlesscode.invalid"])
	git(repo, ["config", "user.name", "Tripwire Test"])
	git(repo, ["config", "commit.gpgsign", "false"])
	await fsp.writeFile(path.join(repo, "README.md"), "# fixture\n")
	git(repo, ["add", "README.md"])
	git(repo, ["commit", "-qm", "init"])
}

interface Fixture {
	repo: string
	wt: string
}

async function makeFixture(): Promise<Fixture> {
	const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-tripwire-"))
	await initRepo(repo)
	const wt = path.join(repo, ".worktrees", "w1")
	git(repo, ["worktree", "add", "-q", "-b", "feat", wt, "main"])
	return { repo, wt }
}

async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
	const fx = await makeFixture()
	try {
		await fn(fx)
	} finally {
		git(fx.repo, ["worktree", "remove", "--force", fx.wt])
		git(fx.repo, ["worktree", "prune"])
		await fsp.rm(fx.repo, { recursive: true, force: true })
	}
}

function tripwire(role: string, mode: string, wt: string): string {
	const ran = spawnSync("bash", [SCRIPT, role, mode, wt], {
		encoding: "utf-8",
	})
	assert.equal(ran.status, 0, "tripwire always exits 0")
	return `${ran.stdout}${ran.stderr}`
}

function dirtyMarker(fx: Fixture, role: string): string {
	const stem = role === "qa" ? ".qa" : ".harness"
	return path.join(fx.wt, `${stem}.main-tree-dirty`)
}

async function cleanRunLeavesNoMarker(fx: Fixture): Promise<void> {
	tripwire("worker", "snapshot", fx.wt)
	tripwire("worker", "check", fx.wt)
	assert.equal(fs.existsSync(dirtyMarker(fx, "worker")), false)
}

async function escapedWriteIsReported(fx: Fixture): Promise<void> {
	tripwire("worker", "snapshot", fx.wt)
	await fsp.writeFile(path.join(fx.repo, "escaped.txt"), "x\n")
	await fsp.appendFile(path.join(fx.repo, "README.md"), "dirt\n")
	const out = tripwire("worker", "check", fx.wt)
	const marker = dirtyMarker(fx, "worker")
	assert.equal(fs.existsSync(marker), true)
	const body = await fsp.readFile(marker, "utf-8")
	assert.ok(body.includes("escaped.txt"))
	assert.ok(body.includes("README.md"))
	assert.ok(out.includes("MAIN-TREE-DIRTY"))
}

async function orchestratorDirsExcluded(fx: Fixture): Promise<void> {
	tripwire("worker", "snapshot", fx.wt)
	const churn = path.join(fx.repo, "plans", "parallel-tasks")
	await fsp.mkdir(churn, { recursive: true })
	await fsp.writeFile(path.join(churn, "churn.md"), "x\n")
	const sib = path.join(fx.repo, ".worktrees", "other")
	await fsp.mkdir(sib, { recursive: true })
	await fsp.writeFile(path.join(sib, "x.txt"), "x\n")
	tripwire("worker", "check", fx.wt)
	assert.equal(fs.existsSync(dirtyMarker(fx, "worker")), false)
}

async function missingBaselineReportsAll(fx: Fixture): Promise<void> {
	await fsp.writeFile(path.join(fx.repo, "stale.txt"), "x\n")
	const out = tripwire("worker", "check", fx.wt)
	assert.ok(out.includes("no baseline"))
	const body = await fsp.readFile(dirtyMarker(fx, "worker"), "utf-8")
	assert.ok(body.includes("stale.txt"))
}

async function mainCheckoutRefusesLoudly(fx: Fixture): Promise<void> {
	const out = tripwire("worker", "snapshot", fx.repo)
	assert.ok(out.includes("directly on"))
	const before = path.join(fx.repo, ".harness.main-tree-before")
	assert.equal(fs.existsSync(before), false)
}

async function qaRoleUsesQaMarkers(fx: Fixture): Promise<void> {
	tripwire("qa", "snapshot", fx.wt)
	await fsp.writeFile(path.join(fx.repo, "qa-escaped.txt"), "x\n")
	tripwire("qa", "check", fx.wt)
	assert.equal(fs.existsSync(dirtyMarker(fx, "qa")), true)
	assert.equal(fs.existsSync(dirtyMarker(fx, "worker")), false)
}

async function scriptAndReaderAgree(fx: Fixture): Promise<void> {
	tripwire("worker", "snapshot", fx.wt)
	await fsp.writeFile(path.join(fx.repo, "escape.txt"), "x\n")
	tripwire("worker", "check", fx.wt)
	assert.deepEqual(readMainTreeDirty(fx.wt), ["?? escape.txt"])
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hc-tripwire-read-"))
	try {
		await fn(dir)
	} finally {
		await fsp.rm(dir, { recursive: true, force: true })
	}
}

async function readerReadsMarkerLines(dir: string): Promise<void> {
	assert.equal(readMainTreeDirty(dir), undefined)
	const wt = path.join(dir, "w1")
	await fsp.mkdir(wt)
	const marker = path.join(wt, ".harness.main-tree-dirty")
	await fsp.writeFile(marker, "?? a.txt\n M b.txt\n\n")
	assert.deepEqual(readMainTreeDirty(wt), ["?? a.txt", " M b.txt"])
}

async function inspectPersistsDirty(dir: string): Promise<void> {
	const wt = path.join(dir, ".worktrees", "w1")
	await fsp.mkdir(wt, { recursive: true })
	await fsp.mkdir(path.join(wt, ".harness.done"))
	await fsp.writeFile(path.join(wt, ".harness.exit"), "0")
	const marker = path.join(wt, ".harness.main-tree-dirty")
	await fsp.writeFile(marker, "?? escaped.txt\n")
	const group = { name: "w1", status: "running" }
	const patch = inspectGroup(dir, group, Date.now(), DEFAULT_STALL_TIMEOUT_MS)
	assert.deepEqual(patch?.main_tree_dirty, ["?? escaped.txt"])
	const la = patch?.last_activity as { note: string }
	assert.match(la.note, /MAIN-TREE-DIRTY/)
}

async function reconcilePersistsDirty(dir: string): Promise<void> {
	const wt = path.join(dir, ".worktrees", "w1")
	await fsp.mkdir(wt, { recursive: true })
	await fsp.mkdir(path.join(wt, ".harness.done"))
	await fsp.writeFile(path.join(wt, ".harness.exit"), "0")
	const marker = path.join(wt, ".harness.main-tree-dirty")
	await fsp.writeFile(marker, " M escaped.txt\n")
	const groups = [{ name: "w1", status: "running" }]
	const { state: out } = reconcileGroups({ batch: "t", groups }, dir)
	assert.deepEqual(out.groups[0]?.main_tree_dirty, [" M escaped.txt"])
}

async function summarySurfacesDirtyBit(dir: string): Promise<void> {
	const groups = [{ name: "w1", status: "done", main_tree_dirty: ["?? e.txt"] }]
	const summary = buildStatusSummary({ batch: "t", groups })
	assert.deepEqual(summary.groups[0]?.mainTreeDirty, ["?? e.txt"])
	const text = formatStatusText(summary, { repo: dir, statePath: "s" })
	assert.match(text, /MAIN-TREE-DIRTY/)
}

async function cleanupRemovesMarkers(dir: string): Promise<void> {
	const names = [
		".harness.main-tree-before",
		".harness.main-tree-dirty",
		".qa.main-tree-before",
		".qa.main-tree-dirty",
	]
	for (const name of names) await fsp.writeFile(path.join(dir, name), "x")
	removeHarnessArtifacts(dir)
	for (const name of names) {
		assert.equal(fs.existsSync(path.join(dir, name)), false)
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["clean run leaves no marker", () => withFixture(cleanRunLeavesNoMarker)],
	["escaped write is reported", () => withFixture(escapedWriteIsReported)],
	["orchestrator dirs excluded", () => withFixture(orchestratorDirsExcluded)],
	["missing baseline reports all", () => withFixture(missingBaselineReportsAll)],
	["main checkout refuses loudly", () => withFixture(mainCheckoutRefusesLoudly)],
	["qa role uses qa markers", () => withFixture(qaRoleUsesQaMarkers)],
	["script and reader agree", () => withFixture(scriptAndReaderAgree)],
	["reader reads marker lines", () => withTmpDir(readerReadsMarkerLines)],
	["inspect persists dirty", () => withTmpDir(inspectPersistsDirty)],
	["reconcile persists dirty", () => withTmpDir(reconcilePersistsDirty)],
	["summary surfaces dirty bit", () => withTmpDir(summarySurfacesDirtyBit)],
	["cleanup removes markers", () => withTmpDir(cleanupRemovesMarkers)],
]

runMain("main-tree-tripwire", tests)
