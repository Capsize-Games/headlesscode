/**
 * Unit tests for `headlesscode orchestrate cleanup` (src/orchestrator/cleanup.ts)
 * — the deterministic, human-triggered post-merge worktree cleanup.
 *
 * Real git fixtures (throwaway repos + real worktrees) prove the mutation
 * behavior against actual git: dry-run truly touches nothing, apply removes
 * exactly the right things in the right order, and every safety gate blocks
 * cleanup on its own. The GitHub PR path uses a fake fetch (the same pattern
 * as src/github/__tests__/pr.test.ts). Plain assert-based, run via `npm test`.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { statusMain } from "../cli.js"
import {
	applyCleanup,
	cleanupMain,
	parseCleanupArgs,
	planCleanup,
	removeKnownSafeArtifacts,
	type CleanupDeps,
	type CleanupStatus,
	type GhWiring,
} from "../cleanup.js"
import {
	defaultState,
	loadStateSync,
	saveStateSync,
	updateGroup,
	type OrchestratorGroup,
	type OrchestratorState,
} from "../state.js"

function git(repo: string, args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

async function makeRepoBase(): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-cleanup-"))
	execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" })
	git(dir, ["config", "user.email", "test@headlesscode.invalid"])
	git(dir, ["config", "user.name", "Cleanup Test"])
	git(dir, ["config", "commit.gpgsign", "false"])
	await fsp.writeFile(path.join(dir, "a.txt"), "a\n")
	git(dir, ["add", "a.txt"])
	git(dir, ["commit", "-qm", "init"])
	return dir
}

async function makeWorktree(repo: string, name = "w1", branch = "feat"): Promise<{ wtPath: string; branch: string }> {
	const wtPath = path.join(repo, ".worktrees", name)
	await fsp.mkdir(path.join(repo, ".worktrees"), { recursive: true })
	git(repo, ["worktree", "add", "-q", "-b", branch, wtPath, "main"])
	return { wtPath, branch }
}

async function commitInWorktree(wtPath: string): Promise<void> {
	await fsp.appendFile(path.join(wtPath, "a.txt"), "feat change\n")
	git(wtPath, ["add", "a.txt"])
	git(wtPath, ["commit", "-qm", "feat work"])
}

interface Fixture {
	repo: string
	branch: string
	wtPath: string
	statePath: string
}

function stateWithGroup(f: Fixture, overrides: Partial<OrchestratorGroup> = {}): OrchestratorState {
	let state = defaultState("round-1")
	state = updateGroup(state, "w1", {
		worktree: ".worktrees/w1",
		branch: f.branch,
		issues: [1],
		status: "done",
		spawned: new Date().toISOString(),
		...overrides,
	})
	return state
}

/** Repo with worktree w1 (branch feat) whose work is fast-forward-merged into main. */
async function makeMergedFixture(): Promise<Fixture> {
	const repo = await makeRepoBase()
	const { wtPath, branch } = await makeWorktree(repo)
	await commitInWorktree(wtPath)
	git(repo, ["merge", "-q", "--no-edit", branch])
	const f: Fixture = { repo, branch, wtPath, statePath: path.join(repo, ".worktrees", ".orchestrator-state.json") }
	saveStateSync(f.statePath, stateWithGroup(f, { status: "done" }))
	return f
}

/** Repo with a bare `origin` (origin/main pushed) — for the sync-on-apply test. */
async function makeOriginRepo(): Promise<{ repo: string; remote: string }> {
	const remote = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-cleanup-remote-"))
	execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" })
	const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-cleanup-remote-local-"))
	execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" })
	git(repo, ["config", "user.email", "test@headlesscode.invalid"])
	git(repo, ["config", "user.name", "Cleanup Test"])
	git(repo, ["config", "commit.gpgsign", "false"])
	git(repo, ["remote", "add", "origin", remote])
	await fsp.writeFile(path.join(repo, "a.txt"), "a\n")
	git(repo, ["add", "a.txt"])
	git(repo, ["commit", "-qm", "init"])
	git(repo, ["push", "-q", "-u", "origin", "main"])
	return { repo, remote }
}

/** Repo with worktree w1 (branch feat) whose work is NOT merged into main. */
async function makeUnmergedFixture(): Promise<Fixture> {
	const repo = await makeRepoBase()
	const { wtPath, branch } = await makeWorktree(repo)
	await commitInWorktree(wtPath)
	const f: Fixture = { repo, branch, wtPath, statePath: path.join(repo, ".worktrees", ".orchestrator-state.json") }
	saveStateSync(f.statePath, stateWithGroup(f, { status: "done" }))
	return f
}

function capture(): { out: string[]; err: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
	const out: string[] = []
	const err: string[] = []
	return {
		out,
		err,
		io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
	}
}

/** Fake GitHub `GET /pulls/42` fetch for the PR-merge path. */
function fakeFetchPR(handler: (method: string, path: string) => { status: number; body: unknown }): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input))
		const method = (init?.method ?? "GET").toUpperCase()
		const result = handler(method, url.pathname)
		return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } })
	}) as typeof fetch
}

function ghWiring(handler: (method: string, path: string) => { status: number; body: unknown }): GhWiring {
	return {
		owner: "octo",
		repo: "hello",
		getInstallationToken: async () => "ghs_TESTTOKEN1234567890",
		baseUrl: "https://api.github.com",
		fetchImpl: fakeFetchPR(handler),
	}
}

const PR_MERGED = (): { status: number; body: unknown } => ({ status: 200, body: { number: 42, state: "closed", merged: true } })
const PR_OPEN = (): { status: number; body: unknown } => ({ status: 200, body: { number: 42, state: "open", merged: false } })
const PR_404 = (): { status: number; body: unknown } => ({ status: 404, body: { message: "Not Found" } })

// ─── parseCleanupArgs ────────────────────────────────────────────────────────

async function testParseCleanupArgs(): Promise<void> {
	const def = parseCleanupArgs(["--repo", "/tmp/x"])
	assert.equal(def.error, undefined)
	assert.equal(def.options.repo, "/tmp/x")
	assert.equal(def.options.apply, false, "--apply is opt-in")
	assert.equal(def.options.dryRun, false)
	assert.equal(def.options.base, undefined)

	const full = parseCleanupArgs([
		"--repo", "/tmp/x",
		"--base", "main",
		"--apply",
		"--json",
		"--gh-installation-id", "123",
	])
	assert.equal(full.error, undefined)
	assert.equal(full.options.base, "main")
	assert.equal(full.options.apply, true)
	assert.equal(full.options.json, true)
	assert.equal(full.options.ghInstallationId, "123")

	// --flag=value form works too.
	const eq = parseCleanupArgs(["--repo=/tmp/x", "--base=main"])
	assert.equal(eq.error, undefined)
	assert.equal(eq.options.repo, "/tmp/x")
	assert.equal(eq.options.base, "main")

	assert.ok(parseCleanupArgs(["--repo"]).error?.includes("Missing value"), "missing --repo value errors")
	assert.ok(parseCleanupArgs(["--nope"]).error?.includes("Unknown"), "unknown flag errors")
	assert.equal(parseCleanupArgs(["--help"]).options.help, true)

	// Parse permits --apply + --dry-run; cleanupMain rejects the combination.
	const both = parseCleanupArgs(["--repo", "/tmp/x", "--apply", "--dry-run"])
	assert.equal(both.error, undefined)
}

async function testApplyAndDryRunAreMutuallyExclusive(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo, "--apply", "--dry-run"], cap.io)
		assert.equal(code, 2, "both flags -> usage error")
		assert.ok(cap.err.join("").includes("mutually exclusive"))
		assert.ok(fs.existsSync(f.wtPath), "nothing removed on a usage error")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

// ─── Dry-run never mutates ───────────────────────────────────────────────────

async function testDryRunPrintsPlanAndMutatesNothing(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo, "--dry-run"], cap.io)
		assert.equal(code, 0)
		const text = cap.out.join("")
		assert.ok(text.includes("w1"), "plan names the group")
		assert.ok(text.includes("eligible"), "plan shows the group as eligible")
		assert.ok(cap.err.join("") === "", "no stderr on a clean dry-run")

		// The proof that NOTHING was touched: worktree, branch and state survive.
		assert.ok(fs.existsSync(f.wtPath), "dry-run must not remove the worktree")
		assert.notEqual(git(f.repo, ["branch", "--list", f.branch]), "", "dry-run must not delete the branch")
		const state = loadStateSync(f.statePath)
		assert.equal(state.groups[0].cleaned_at, undefined, "dry-run must not patch the state")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testDefaultIsDryRun(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo], cap.io)
		assert.equal(code, 0, "no --apply/--dry-run flag defaults to a dry run")
		assert.ok(cap.out.join("").includes("Dry run"), "output labels the dry run")
		assert.ok(fs.existsSync(f.wtPath), "default run must not remove anything")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

// ─── Apply: happy path + idempotency ─────────────────────────────────────────

async function testApplyRemovesWorktreeBranchAndPatchesState(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo, "--apply"], cap.io)
		assert.equal(code, 0)
		assert.ok(!fs.existsSync(f.wtPath), "worktree removed")
		assert.equal(git(f.repo, ["branch", "--list", f.branch]), "", "branch deleted")

		const state = loadStateSync(f.statePath)
		const group = state.groups.find((g) => g.name === "w1")
		assert.ok(group, "group entry survives cleanup (history stays queryable)")
		assert.ok(group!.cleaned_at, "cleaned_at recorded on the group")
		const actions = group!.actions_taken ?? []
		assert.ok(actions.some((a) => a.startsWith("worktree removed (merged via local-ancestor)")), "removal recorded in actions_taken")
		assert.ok(actions.includes("branch feat deleted"), "branch deletion recorded in actions_taken")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testApplyTwiceIsIdempotentNoop(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		const first = await cleanupMain(["--repo", f.repo, "--apply"], capture().io)
		assert.equal(first, 0)
		const before = loadStateSync(f.statePath).groups[0].cleaned_at

		const cap = capture()
		const second = await cleanupMain(["--repo", f.repo, "--apply"], cap.io)
		assert.equal(second, 0, "re-running on an already-cleaned group is a clean no-op, not an error")
		assert.ok(cap.out.join("").includes("worktree already removed"), "second run reports the group as already done")
		assert.equal(loadStateSync(f.statePath).groups[0].cleaned_at, before, "state is not rewritten")
		assert.equal(cap.err.join(""), "")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testApplySyncsMainToOrigin(): Promise<void> {
	// Issue #25: cleanup --apply is the "a round just settled" checkpoint —
	// after the worktree/branch removal it must also reconcile local master
	// with origin (push the local merge), so unpushed drift stops accumulating.
	const { repo, remote } = await makeOriginRepo()
	try {
		const { wtPath, branch } = await makeWorktree(repo)
		await commitInWorktree(wtPath)
		git(repo, ["merge", "-q", "--no-edit", branch])
		const f: Fixture = { repo, branch, wtPath, statePath: path.join(repo, ".worktrees", ".orchestrator-state.json") }
		saveStateSync(f.statePath, stateWithGroup(f, { status: "done" }))
		assert.notEqual(git(remote, ["rev-parse", "main"]), git(repo, ["rev-parse", "main"]), "origin is behind local before cleanup")

		const cap = capture()
		const code = await cleanupMain(["--repo", repo, "--apply"], cap.io)
		assert.equal(code, 0)
		assert.ok(!fs.existsSync(wtPath), "worktree removed")
		assert.equal(git(repo, ["branch", "--list", branch]), "", "branch deleted")
		assert.equal(git(remote, ["rev-parse", "main"]), git(repo, ["rev-parse", "main"]), "cleanup --apply pushed local main to origin")
		assert.ok(cap.err.join("").includes("[sync]"), "the sync outcome is reported on stderr, got: " + cap.err.join(""))
	} finally {
		await fsp.rm(repo, { recursive: true, force: true })
		await fsp.rm(remote, { recursive: true, force: true })
	}
}

// ─── Safety gates: each blocks cleanup on its own ────────────────────────────

async function testDirtyGateBlocksCleanup(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		// A human's untracked file (not a harness artifact) makes the worktree dirty.
		await fsp.writeFile(path.join(f.wtPath, "notes.txt"), "human notes\n")

		const dry = capture()
		const dryCode = await cleanupMain(["--repo", f.repo, "--dry-run"], dry.io)
		assert.equal(dryCode, 0)
		assert.ok(dry.out.join("").includes("blocked"), "dirty worktree is reported blocked")
		assert.ok(dry.out.join("").includes("uncommitted changes"), "the reason names the dirty gate")

		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo, "--apply"], cap.io)
		assert.equal(code, 0, "a blocked group is a documented no-op, not a failure")
		assert.ok(fs.existsSync(f.wtPath), "dirty worktree must NOT be removed")
		assert.notEqual(git(f.repo, ["branch", "--list", f.branch]), "", "dirty group's branch must NOT be deleted")
		assert.equal(loadStateSync(f.statePath).groups[0].cleaned_at, undefined, "dirty group's state must NOT be patched")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testHarnessArtifactsDoNotBlockAndAreRemoved(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		// The harness's own untracked residue must NOT count as dirt — a real
		// round always leaves these.
		await fsp.mkdir(path.join(f.wtPath, ".harness.done"), { recursive: true })
		await fsp.writeFile(path.join(f.wtPath, ".harness.pgid"), "12345\n", "utf-8")
		await fsp.writeFile(path.join(f.wtPath, "harness.log"), "worker log\n")
		await fsp.mkdir(path.join(f.wtPath, ".headlesscode", "codesearch"), { recursive: true })
		await fsp.writeFile(path.join(f.wtPath, ".headlesscode", "mode-models.json"), "{}\n")
		await fsp.writeFile(path.join(f.wtPath, "ORCHESTRATOR_TASK.md"), "task\n")

		const dry = capture()
		await cleanupMain(["--repo", f.repo, "--dry-run"], dry.io)
		assert.ok(dry.out.join("").includes("eligible"), "harness artifacts alone do not block cleanup")

		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo, "--apply"], cap.io)
		assert.equal(code, 0)
		assert.ok(!fs.existsSync(f.wtPath), "worktree removed even with harness artifacts present")
		assert.equal(git(f.repo, ["branch", "--list", f.branch]), "", "branch deleted")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testKnownSafeResidueDoesNotBlockAndIsRemoved(): Promise<void> {
	// Build a fixture with a TRACKED python source tree (src/pkg/__init__.py)
	// committed on main BEFORE the worktree is created, so the worktree's
	// checkout contains it and the nested __pycache__ shows up at its real path
	// — the exact shape of the reported friction (a fully-untracked src/ would
	// collapse to `?? src/` and must still block, since it could contain
	// anything human).
	const repo = await makeRepoBase()
	await fsp.mkdir(path.join(repo, "src", "pkg"), { recursive: true })
	await fsp.writeFile(path.join(repo, "src", "pkg", "__init__.py"), "pkg\n")
	git(repo, ["add", "src/pkg/__init__.py"])
	git(repo, ["commit", "-qm", "track a python package"])
	const { wtPath, branch } = await makeWorktree(repo)
	await commitInWorktree(wtPath)
	git(repo, ["merge", "-q", "--no-edit", branch])
	const f: Fixture = { repo, branch, wtPath, statePath: path.join(repo, ".worktrees", ".orchestrator-state.json") }
	saveStateSync(f.statePath, stateWithGroup(f, { status: "done" }))
	try {
		// Worker/QA residue that must NOT count as dirt (issue #38): a
		// node_modules symlink (a symlink does not match the dir-only
		// `node_modules/` gitignore pattern, so git reports it untracked), a
		// nested __pycache__ dir next to tracked sources, and a stray .pyc.
		const symlinkTarget = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-nm-target-"))
		await fsp.writeFile(path.join(symlinkTarget, "dep.js"), "module.exports = 1\n")
		await fsp.symlink(symlinkTarget, path.join(f.wtPath, "node_modules"), "dir")
		await fsp.mkdir(path.join(f.wtPath, "src", "pkg", "__pycache__"), { recursive: true })
		await fsp.writeFile(path.join(f.wtPath, "src", "pkg", "__pycache__", "mod.cpython-312.pyc"), "b0")
		await fsp.writeFile(path.join(f.wtPath, "stray.pyc"), "b0")
		const porcelain = git(f.wtPath, ["status", "--porcelain"]).split("\n")
		assert.ok(porcelain.some((l) => l.startsWith("?? node_modules")), "the node_modules symlink is genuinely untracked (the reported blocker)")
		assert.ok(porcelain.some((l) => l.startsWith("?? src/pkg/__pycache__")), "the nested __pycache__ shows at its real path")

		const dry = capture()
		const dryCode = await cleanupMain(["--repo", f.repo, "--dry-run"], dry.io)
		assert.equal(dryCode, 0)
		assert.match(dry.out.join(""), /w1\s+eligible/, "known-safe residue alone does not block cleanup")
		assert.ok(!dry.out.join("").includes("node_modules"), "node_modules is not listed as a blocker")

		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo, "--apply"], cap.io)
		assert.equal(code, 0)
		assert.ok(!fs.existsSync(f.wtPath), "worktree removed even with known-safe residue present")
		assert.equal(git(f.repo, ["branch", "--list", f.branch]), "", "branch deleted")
		assert.ok(fs.existsSync(symlinkTarget), "the node_modules symlink TARGET survives (only the link is removed)")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testRemoveKnownSafeArtifactsNeverTouchesTrackedFiles(): Promise<void> {
	const repo = await makeRepoBase()
	// A repo that TRACKS a path under a known-safe name (committed on main
	// before the worktree, so the worktree's checkout contains it).
	await fsp.mkdir(path.join(repo, "__pycache__"), { recursive: true })
	await fsp.writeFile(path.join(repo, "__pycache__", "tracked.txt"), "tracked\n")
	git(repo, ["add", "__pycache__/tracked.txt"])
	git(repo, ["commit", "-qm", "track a pycache file"])
	const { wtPath, branch } = await makeWorktree(repo)
	await commitInWorktree(wtPath)
	git(repo, ["merge", "-q", "--no-edit", branch])
	const f: Fixture = { repo, branch, wtPath, statePath: path.join(repo, ".worktrees", ".orchestrator-state.json") }
	saveStateSync(f.statePath, stateWithGroup(f, { status: "done" }))
	try {
		// The removal step must delete ONLY untracked residue, never tracked
		// files — deleting a tracked file would itself dirty the worktree and
		// defeat the no-force `git worktree remove`.
		await fsp.writeFile(path.join(f.wtPath, "__pycache__", "stray.pyc"), "b0")

		removeKnownSafeArtifacts(f.wtPath)
		assert.ok(fs.existsSync(path.join(f.wtPath, "__pycache__", "tracked.txt")), "tracked files under a known-safe name survive")
		assert.ok(!fs.existsSync(path.join(f.wtPath, "__pycache__", "stray.pyc")), "untracked residue is removed")

		// Only the untracked residue was removed, so cleanup --apply proceeds
		// and removes the worktree for real.
		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo, "--apply"], cap.io)
		assert.equal(code, 0)
		assert.ok(!fs.existsSync(f.wtPath), "worktree removed after known-safe residue cleanup")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testLiveProcessGateBlocksCleanup(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		// A LIVE pid (this test process) in .harness.pid => the worker is running.
		await fsp.writeFile(path.join(f.wtPath, ".harness.pid"), String(process.pid), "utf-8")

		const dry = capture()
		await cleanupMain(["--repo", f.repo, "--dry-run"], dry.io)
		assert.ok(dry.out.join("").includes("worker process is still running"), "live process gate reports blocked")

		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo, "--apply"], cap.io)
		assert.equal(code, 0)
		assert.ok(fs.existsSync(f.wtPath), "a worktree with a live worker must NOT be removed")
		assert.equal(loadStateSync(f.statePath).groups[0].cleaned_at, undefined)
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testNonTerminalStatusBlocksCleanup(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		saveStateSync(f.statePath, stateWithGroup(f, { status: "running" }))

		const dry = capture()
		await cleanupMain(["--repo", f.repo, "--dry-run"], dry.io)
		assert.ok(dry.out.join("").includes('status "running" is not terminal'), "non-terminal group is blocked")

		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo, "--apply"], cap.io)
		assert.equal(code, 0)
		assert.ok(fs.existsSync(f.wtPath), "a running group's worktree must NOT be removed")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testNotMergedBlocksCleanup(): Promise<void> {
	const f = await makeUnmergedFixture()
	try {
		const dry = capture()
		await cleanupMain(["--repo", f.repo, "--dry-run"], dry.io)
		assert.ok(dry.out.join("").includes("not merged"), "unmerged branch is blocked")

		const cap = capture()
		const code = await cleanupMain(["--repo", f.repo, "--apply"], cap.io)
		assert.equal(code, 0)
		assert.ok(fs.existsSync(f.wtPath), "unmerged worktree must NOT be removed")
		assert.notEqual(git(f.repo, ["branch", "--list", f.branch]), "", "unmerged branch must NOT be deleted")
		assert.equal(loadStateSync(f.statePath).groups[0].cleaned_at, undefined)
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

// ─── GitHub PR path: disagreement + squash + API errors ──────────────────────

async function testDisagreementFailsClosed(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		// Branch IS merged locally, but the recorded PR is still open: the two
		// checks disagree, so cleanup must FAIL CLOSED (never delete).
		let state = stateWithGroup(f)
		state = updateGroup(state, "w1", { pr: { number: 42 } })
		saveStateSync(f.statePath, state)
		const gh = ghWiring(PR_OPEN)

		const plan = await planCleanup(f.repo, state, { statePath: f.statePath, baseBranch: "main", gh })
		assert.equal(plan.groups[0].status.status, "blocked")
		assert.ok((plan.groups[0].status as { reason: string }).reason.includes("disagreement"), "the discrepancy is surfaced")

		const result = await applyCleanup(f.repo, f.statePath, { baseBranch: "main", gh })
		assert.equal(result.removed.length, 0, "disagreement must not delete anything")
		assert.ok(fs.existsSync(f.wtPath))
		assert.equal(loadStateSync(f.statePath).groups[0].cleaned_at, undefined)
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testGitHubSquashMergeIsEligible(): Promise<void> {
	const f = await makeUnmergedFixture()
	try {
		// The squash-merge workflow the local check cannot see: branch is NOT
		// an ancestor locally, but GitHub says the PR is merged => eligible.
		let state = stateWithGroup(f)
		state = updateGroup(state, "w1", { pr: { number: 42 } })
		saveStateSync(f.statePath, state)
		const gh = ghWiring(PR_MERGED)

		const plan = await planCleanup(f.repo, state, { statePath: f.statePath, baseBranch: "main", gh })
		assert.equal(plan.groups[0].status.status, "eligible")
		assert.equal(plan.groups[0].status.via, "github-pr")

		const result = await applyCleanup(f.repo, f.statePath, { baseBranch: "main", gh })
		assert.equal(result.removed.length, 1, "a GitHub-merged PR is cleanable")
		assert.ok(!fs.existsSync(f.wtPath), "worktree removed")
		// `git branch -d` (lowercase) is the SECOND safety net: the local
		// branch was never merged into LOCAL main (the PR merged on GitHub),
		// so it refuses — the refusal is recorded in actions_taken, never
		// forced, and the branch is left for a human to delete manually.
		assert.notEqual(git(f.repo, ["branch", "--list", f.branch]), "", "branch -d refuses for a GitHub-only merge (safety net, not forced)")
		const group = loadStateSync(f.statePath).groups[0]
		assert.ok(group.cleaned_at, "state patched")
		assert.ok(
			(group.actions_taken ?? []).some((a) => a.includes("branch feat delete FAILED")),
			"the branch-delete refusal is recorded in actions_taken",
		)
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testApiErrorFailsClosedWhenLocalCannotRescue(): Promise<void> {
	const f = await makeUnmergedFixture()
	try {
		// API error + branch NOT merged locally => blocked as unknown (fail closed).
		let state = stateWithGroup(f)
		state = updateGroup(state, "w1", { pr: { number: 42 } })
		saveStateSync(f.statePath, state)
		const gh = ghWiring(PR_404)

		const plan = await planCleanup(f.repo, state, { statePath: f.statePath, baseBranch: "main", gh })
		assert.equal(plan.groups[0].status.status, "blocked")
		assert.ok((plan.groups[0].status as { reason: string }).reason.includes("not merged (unknown)"))

		const result = await applyCleanup(f.repo, f.statePath, { baseBranch: "main", gh })
		assert.equal(result.removed.length, 0)
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testApiErrorFallsBackToLocalAncestorWhenItSaysMerged(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		// API error + branch PROVABLY merged locally: the local ancestor check
		// is the strongest possible evidence, so cleanup is still eligible.
		let state = stateWithGroup(f)
		state = updateGroup(state, "w1", { pr: { number: 42 } })
		saveStateSync(f.statePath, state)
		const gh = ghWiring(PR_404)

		const plan = await planCleanup(f.repo, state, { statePath: f.statePath, baseBranch: "main", gh })
		assert.equal(plan.groups[0].status.status, "eligible")
		assert.equal(plan.groups[0].status.via, "local-ancestor")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

// ─── Partial failure: worktree removal fails ─────────────────────────────────

async function testWorktreeRemoveFailureSkipsBranchAndStatePatch(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		let branchDeletes = 0
		let stateWrites = 0
		const deps: CleanupDeps = {
			removeWorktree: () => {
				throw new Error("simulated worktree remove failure")
			},
			deleteBranch: () => {
				branchDeletes++
			},
			writeState: () => {
				stateWrites++
			},
		}

		const result = await applyCleanup(f.repo, f.statePath, { baseBranch: "main", deps })
		assert.equal(result.removed.length, 0)
		assert.equal(result.failed.length, 1)
		assert.match(result.failed[0].error, /git worktree remove failed/)
		assert.equal(branchDeletes, 0, "branch delete must never run when the worktree removal failed")
		assert.equal(stateWrites, 0, "state patch must never run when the worktree removal failed")
		assert.ok(fs.existsSync(f.wtPath), "the worktree survives a failed removal")
		assert.notEqual(git(f.repo, ["branch", "--list", f.branch]), "")
		assert.equal(loadStateSync(f.statePath).groups[0].cleaned_at, undefined)
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

async function testWorktreePathEscapeIsRefused(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		// A hostile/rotten state file pointing the worktree OUTSIDE .worktrees/
		// must be refused even if every gate passes (gates injected to pass).
		const evil = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-evil-"))
		let state = stateWithGroup(f)
		state = updateGroup(state, "w1", { worktree: path.relative(f.repo, evil) })
		saveStateSync(f.statePath, state)
		const deps: CleanupDeps = {
			checkMerged: async () => ({ merged: true, via: "local-ancestor", detail: "injected" }),
			worktreeStatus: () => [],
		}

		const result = await applyCleanup(f.repo, f.statePath, { baseBranch: "main", deps })
		assert.equal(result.failed.length, 1)
		assert.match(result.failed[0].error, /escapes/)
		assert.ok(fs.existsSync(evil), "the outside directory is never touched")
		await fsp.rm(evil, { recursive: true, force: true })
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

// ─── Cleanup visibility in `orchestrate status` ──────────────────────────────

async function testStatusShowsCleanupColumn(): Promise<void> {
	const f = await makeMergedFixture()
	try {
		const cap = capture()
		const code = await statusMain(["--repo", f.repo], cap.io)
		assert.equal(code, 0)
		const text = cap.out.join("")
		assert.ok(text.includes("CLEANUP"), "status header gains a cleanup column")
		assert.ok(text.includes("eligible"), "the merged terminal group shows cleanup: eligible")

		const jcap = capture()
		const jcode = await statusMain(["--repo", f.repo, "--json"], jcap.io)
		assert.equal(jcode, 0)
		const parsed = JSON.parse(jcap.out.join("")) as { cleanup: Record<string, CleanupStatus> }
		assert.ok(parsed.cleanup, "--json carries the cleanup map")
		assert.equal(parsed.cleanup["w1"].status, "eligible")
	} finally {
		await fsp.rm(f.repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["parseCleanupArgs parses flags and rejects unknown/missing values", testParseCleanupArgs],
	["--apply and --dry-run are mutually exclusive (usage error)", testApplyAndDryRunAreMutuallyExclusive],
	["dry-run prints the plan and mutates NOTHING", testDryRunPrintsPlanAndMutatesNothing],
	["no flag at all defaults to a dry run", testDefaultIsDryRun],
	["apply removes the worktree, deletes the branch, patches state (never the entry)", testApplyRemovesWorktreeBranchAndPatchesState],
	["apply twice is an idempotent no-op on the second run", testApplyTwiceIsIdempotentNoop],
	["apply reconciles local main with origin (pushes the merged round)", testApplySyncsMainToOrigin],
	["dirty worktree (human file) blocks cleanup", testDirtyGateBlocksCleanup],
	["harness's own untracked artifacts do NOT block and are removed", testHarnessArtifactsDoNotBlockAndAreRemoved],
	["known-safe residue (node_modules symlink, __pycache__, *.pyc) does NOT block and is removed", testKnownSafeResidueDoesNotBlockAndIsRemoved],
	["removeKnownSafeArtifacts never touches tracked files under a known-safe name", testRemoveKnownSafeArtifactsNeverTouchesTrackedFiles],
	["live worker process (.harness.pid) blocks cleanup", testLiveProcessGateBlocksCleanup],
	["non-terminal group status blocks cleanup", testNonTerminalStatusBlocksCleanup],
	["unmerged branch blocks cleanup", testNotMergedBlocksCleanup],
	["GitHub-vs-local disagreement fails closed", testDisagreementFailsClosed],
	["GitHub-merged (squash) PR is eligible via github-pr", testGitHubSquashMergeIsEligible],
	["GitHub API error fails closed when the local check cannot rescue", testApiErrorFailsClosedWhenLocalCannotRescue],
	["GitHub API error falls back to local-ancestor when it proves merged", testApiErrorFallsBackToLocalAncestorWhenItSaysMerged],
	["worktree removal failure skips branch delete and state patch for that group", testWorktreeRemoveFailureSkipsBranchAndStatePatch],
	["a worktree path escaping .worktrees/ is refused", testWorktreePathEscapeIsRefused],
	["orchestrate status shows the cleanup column (eligible) for a merged terminal group", testStatusShowsCleanupColumn],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} cleanup tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
