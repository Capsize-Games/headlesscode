/**
 * Unit tests for src/orchestrator/git-sync.ts (issue #25) — the local-branch
 * ↔ origin reconciliation that keeps local master from silently drifting
 * unpushed (the root cause of repeated merge-conflict cascades at PR-merge
 * time). Real git fixtures (a bare origin + a clone) prove the mutation
 * behavior: push, fast-forward, divergence, and the read-only status path.
 * Plain assert-based, run via `npm test`.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	branchSyncStatus,
	syncBranchWithOrigin,
	syncSummaryLines,
	syncWarningLines,
	TRIVIAL_DRIFT_AHEAD,
} from "../git-sync.js"

function git(repo: string, args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

/** Bare origin + a clone of it with origin/master pushed (initial commit). */
async function makeOriginFixture(): Promise<{ local: string; remote: string }> {
	const remote = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-sync-remote-"))
	execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" })
	const local = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-sync-local-"))
	execFileSync("git", ["init", "-q", "-b", "master", local], { stdio: "ignore" })
	git(local, ["config", "user.email", "test@headlesscode.invalid"])
	git(local, ["config", "user.name", "Sync Test"])
	git(local, ["config", "commit.gpgsign", "false"])
	git(local, ["remote", "add", "origin", remote])
	await fsp.writeFile(path.join(local, "a.txt"), "a\n")
	git(local, ["add", "a.txt"])
	git(local, ["commit", "-qm", "init"])
	git(local, ["push", "-q", "-u", "origin", "master"])
	return { local, remote }
}

/** A second clone used to push origin-side commits (for behind/divergence). */
async function cloneRemote(remote: string): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-sync-other-"))
	execFileSync("git", ["clone", "-q", remote, dir], { stdio: "ignore" })
	git(dir, ["config", "user.email", "test@headlesscode.invalid"])
	git(dir, ["config", "user.name", "Sync Test"])
	git(dir, ["config", "commit.gpgsign", "false"])
	return dir
}

function commitOnMaster(dir: string, marker: string): void {
	fs.appendFileSync(path.join(dir, "a.txt"), `${marker}\n`)
	git(dir, ["add", "a.txt"])
	git(dir, ["commit", "-qm", marker])
}

async function testSyncPushesLocalCommitsToOrigin(): Promise<void> {
	const { local, remote } = await makeOriginFixture()
	try {
		commitOnMaster(local, "local-only-1")
		commitOnMaster(local, "local-only-2")
		const localBefore = git(local, ["rev-parse", "master"])

		const r = syncBranchWithOrigin(local)

		assert.equal(r.skipped, false)
		assert.equal(r.pushed, true, "local-only commits must be pushed")
		assert.equal(r.ahead, 0, "no drift left after the push")
		assert.equal(r.behind, 0)
		assert.equal(git(local, ["rev-parse", "master"]), localBefore, "pushing never rewrites local history")
		assert.equal(git(remote, ["rev-parse", "master"]), localBefore, "origin now has the local commits")
		assert.ok(r.notes.some((n) => n.includes("pushed 2 commit(s)")), `notes describe the push, got: ${r.notes.join("; ")}`)
		assert.equal(r.warnings.length, 0)
	} finally {
		await fsp.rm(local, { recursive: true, force: true })
		await fsp.rm(remote, { recursive: true, force: true })
	}
}

async function testSyncFastForwardsLocalOntoOrigin(): Promise<void> {
	const { local, remote } = await makeOriginFixture()
	try {
		const other = await cloneRemote(remote)
		try {
			commitOnMaster(other, "origin-side-1")
			git(other, ["push", "-q", "origin", "master"])
			const originTip = git(other, ["rev-parse", "master"])
			// Local has NOT fetched yet, so its origin/master ref is stale.
			assert.notEqual(git(local, ["rev-parse", "master"]), originTip)

			const r = syncBranchWithOrigin(local)

			assert.equal(r.fetched, true)
			assert.equal(r.fastForwarded, true, "a strictly-behind local must be fast-forwarded")
			assert.equal(r.ahead, 0)
			assert.equal(r.behind, 0)
			assert.equal(git(local, ["rev-parse", "master"]), originTip, "local master now matches origin")
			assert.equal(r.warnings.length, 0)
		} finally {
			await fsp.rm(other, { recursive: true, force: true })
		}
	} finally {
		await fsp.rm(local, { recursive: true, force: true })
		await fsp.rm(remote, { recursive: true, force: true })
	}
}

async function testSyncDivergenceWarnsAndMutatesNothing(): Promise<void> {
	const { local, remote } = await makeOriginFixture()
	try {
		commitOnMaster(local, "local-side")
		const other = await cloneRemote(remote)
		try {
			commitOnMaster(other, "origin-side")
			git(other, ["push", "-q", "origin", "master"])
			const localTip = git(local, ["rev-parse", "master"])
			const originTip = git(other, ["rev-parse", "master"])

			const r = syncBranchWithOrigin(local)

			assert.equal(r.pushed, false, "a diverged local cannot be pushed (non-fast-forward)")
			assert.equal(r.fastForwarded, false, "a diverged local cannot be fast-forwarded")
			assert.equal(r.ahead, 1)
			assert.equal(r.behind, 1)
			assert.ok(r.warnings.length >= 2, `both failed actions warn, got: ${r.warnings.join("; ")}`)
			assert.equal(git(local, ["rev-parse", "master"]), localTip, "local history untouched")
			assert.equal(git(remote, ["rev-parse", "master"]), originTip, "origin history untouched")
		} finally {
			await fsp.rm(other, { recursive: true, force: true })
		}
	} finally {
		await fsp.rm(local, { recursive: true, force: true })
		await fsp.rm(remote, { recursive: true, force: true })
	}
}

async function testSyncSkipsWhenNoOriginRemote(): Promise<void> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-sync-noorigin-"))
	try {
		execFileSync("git", ["init", "-q", "-b", "master", dir], { stdio: "ignore" })
		git(dir, ["config", "user.email", "test@headlesscode.invalid"])
		git(dir, ["config", "user.name", "Sync Test"])
		await fsp.writeFile(path.join(dir, "a.txt"), "a\n")
		git(dir, ["add", "a.txt"])
		git(dir, ["commit", "-qm", "init"])

		const r = syncBranchWithOrigin(dir)

		assert.equal(r.skipped, true, "no origin remote -> nothing to sync")
		assert.ok(r.skipReason?.includes("origin"), `reason names the missing remote, got: ${r.skipReason}`)
		assert.equal(syncSummaryLines(r).length, 0, "a skipped sync is silent")
		assert.equal(syncWarningLines(r, dir).length, 0)
	} finally {
		await fsp.rm(dir, { recursive: true, force: true })
	}
}

async function testSyncSkipsWhenBranchNeverPushed(): Promise<void> {
	const remote = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-sync-unpushed-remote-"))
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-sync-unpushed-"))
	try {
		execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" })
		execFileSync("git", ["init", "-q", "-b", "master", dir], { stdio: "ignore" })
		git(dir, ["config", "user.email", "test@headlesscode.invalid"])
		git(dir, ["config", "user.name", "Sync Test"])
		git(dir, ["remote", "add", "origin", remote])
		await fsp.writeFile(path.join(dir, "a.txt"), "a\n")
		git(dir, ["add", "a.txt"])
		git(dir, ["commit", "-qm", "init"])

		const r = syncBranchWithOrigin(dir)

		assert.equal(r.skipped, true, "origin/master does not exist -> nothing to sync")
		assert.ok(r.skipReason?.includes("does not exist"), `reason names the missing ref, got: ${r.skipReason}`)
	} finally {
		await fsp.rm(dir, { recursive: true, force: true })
		await fsp.rm(remote, { recursive: true, force: true })
	}
}

async function testSyncSkipsWhenDetachedHead(): Promise<void> {
	const { local, remote } = await makeOriginFixture()
	try {
		execFileSync("git", ["-C", local, "checkout", "-q", "--detach"], { stdio: "ignore" })
		const r = syncBranchWithOrigin(local)
		assert.equal(r.skipped, true, "detached HEAD cannot be synced")
		assert.ok(r.skipReason?.includes("detached"), `reason names detached HEAD, got: ${r.skipReason}`)
	} finally {
		await fsp.rm(local, { recursive: true, force: true })
		await fsp.rm(remote, { recursive: true, force: true })
	}
}

async function testBranchSyncStatusIsReadOnly(): Promise<void> {
	const { local, remote } = await makeOriginFixture()
	try {
		commitOnMaster(local, "unpushed-1")
		const originRefBefore = git(local, ["rev-parse", "origin/master"])

		const s = branchSyncStatus(local)

		assert.ok(s, "a repo with origin/master is comparable")
		assert.equal(s!.ahead, 1, "read-only status sees the unpushed commit")
		assert.equal(s!.behind, 0)
		assert.equal(git(local, ["rev-parse", "origin/master"]), originRefBefore, "status never fetches or mutates")
		assert.notEqual(git(local, ["rev-parse", "master"]), git(remote, ["rev-parse", "master"]), "origin still lacks the local commit")
	} finally {
		await fsp.rm(local, { recursive: true, force: true })
		await fsp.rm(remote, { recursive: true, force: true })
	}
}

async function testBranchSyncStatusUndefinedWithoutComparableRef(): Promise<void> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "headlesscode-sync-status-"))
	try {
		execFileSync("git", ["init", "-q", "-b", "master", dir], { stdio: "ignore" })
		git(dir, ["config", "user.email", "test@headlesscode.invalid"])
		git(dir, ["config", "user.name", "Sync Test"])
		await fsp.writeFile(path.join(dir, "a.txt"), "a\n")
		git(dir, ["add", "a.txt"])
		git(dir, ["commit", "-qm", "init"])
		assert.equal(branchSyncStatus(dir), undefined, "no origin remote -> not comparable")
	} finally {
		await fsp.rm(dir, { recursive: true, force: true })
	}
}

async function testSyncReportLines(): Promise<void> {
	const { local, remote } = await makeOriginFixture()
	try {
		commitOnMaster(local, "local-side")
		const other = await cloneRemote(remote)
		try {
			commitOnMaster(other, "origin-side")
			git(other, ["push", "-q", "origin", "master"])

			const r = syncBranchWithOrigin(local)

			assert.ok(syncSummaryLines(r).some((l) => l.includes("NOT fully synced")), "summary names the residual drift")
			const warnings = syncWarningLines(r, local)
			assert.ok(warnings.some((w) => w.includes("WARNING:")), "warnings are loud")
			assert.ok(warnings.some((w) => w.includes("git -C " + local)), "warnings carry the manual reconcile command")
		} finally {
			await fsp.rm(other, { recursive: true, force: true })
		}
	} finally {
		await fsp.rm(local, { recursive: true, force: true })
		await fsp.rm(remote, { recursive: true, force: true })
	}
}

async function testTrivialDriftThresholdIsExported(): Promise<void> {
	assert.equal(typeof TRIVIAL_DRIFT_AHEAD, "number")
	assert.ok(TRIVIAL_DRIFT_AHEAD > 0, "threshold is a positive count")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["sync pushes local-only commits to origin", testSyncPushesLocalCommitsToOrigin],
	["sync fast-forwards a strictly-behind local onto origin", testSyncFastForwardsLocalOntoOrigin],
	["sync divergence warns and mutates nothing", testSyncDivergenceWarnsAndMutatesNothing],
	["sync skips silently with no origin remote", testSyncSkipsWhenNoOriginRemote],
	["sync skips when the branch was never pushed", testSyncSkipsWhenBranchNeverPushed],
	["sync skips on detached HEAD", testSyncSkipsWhenDetachedHead],
	["branchSyncStatus is read-only", testBranchSyncStatusIsReadOnly],
	["branchSyncStatus is undefined without a comparable ref", testBranchSyncStatusUndefinedWithoutComparableRef],
	["sync summary/warning lines are loud and actionable", testSyncReportLines],
	["TRIVIAL_DRIFT_AHEAD threshold is exported", testTrivialDriftThresholdIsExported],
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
	console.log(`\nAll ${tests.length} git-sync tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
