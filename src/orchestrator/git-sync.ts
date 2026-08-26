/**
 * Local-branch ↔ origin reconciliation for the orchestration workflow
 * (issue #25).
 *
 * The failure mode this exists to prevent: local `master` silently
 * accumulates commits for an entire session without ever being pushed.
 * Parallel worktrees branch off local `master` / `origin/master` while GitHub
 * PR merges only ever move `origin/master`, so the two diverge and every
 * PR-merge cycle pays for it with re-merge conflict cascades (three separate
 * re-merge-and-retest cycles in one session, zero functional benefit).
 *
 * Natural checkpoints call `syncBranchWithOrigin`:
 *   - `orchestrate` before spawning, so a round's branches start from what's
 *     actually on GitHub;
 *   - `orchestrate cleanup --apply` after a round settles.
 *
 * Both are best-effort auxiliary steps matching the repo's non-fatal failure
 * pattern: a failure (auth, divergence, offline) is collected as a warning
 * for the caller to print loudly — it never aborts the round or fails
 * cleanup. Setting `HEADLESSCODE_ORCHESTRATE_NO_SYNC=1` disables the mutation
 * entirely; only a read-only drift report (with a loud warning past
 * `TRIVIAL_DRIFT_AHEAD`) is produced.
 */

import { execFileSync } from "node:child_process"

/** Read-only drift report: how far local <branch> is from origin/<branch>. */
export interface BranchSyncStatus {
	branch: string
	remoteRef: string
	/** Commits on <branch> that origin/<branch> does not have. */
	ahead: number
	/** Commits on origin/<branch> that <branch> does not have. */
	behind: number
}

/** Outcome of one sync attempt; never throws — everything is a note/warning. */
export interface BranchSyncResult {
	branch: string
	remoteRef: string
	ahead: number
	behind: number
	/** Sync was skipped entirely (no origin remote, detached HEAD, never pushed). */
	skipped: boolean
	skipReason?: string
	fetched: boolean
	pushed: boolean
	fastForwarded: boolean
	notes: string[]
	warnings: string[]
}

/** Unpushed drift above this count is "more than a trivial amount" — the
 *  read-only (`HEADLESSCODE_ORCHESTRATE_NO_SYNC`) path warns only past it. */
export const TRIVIAL_DRIFT_AHEAD = 5

/** Setting this env var disables the automatic sync (read-only drift report). */
export const ORCHESTRATE_SYNC_DISABLED_ENV = "HEADLESSCODE_ORCHESTRATE_NO_SYNC"

function git(repo: string, args: string[], timeoutMs: number): string {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: timeoutMs,
	}).trim()
}

/** The repo's checked-out branch ("master"/"main"), or undefined when detached. */
function resolveHeadBranch(repo: string): string | undefined {
	try {
		const branch = git(repo, ["symbolic-ref", "--short", "HEAD"], 5000)
		return branch === "" ? undefined : branch
	} catch {
		return undefined
	}
}

function hasRemoteOrigin(repo: string): boolean {
	try {
		return git(repo, ["remote"], 5000).split("\n").includes("origin")
	} catch {
		return false
	}
}

function remoteRefExists(repo: string, remoteRef: string): boolean {
	try {
		execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", remoteRef], { stdio: "ignore", timeout: 5000 })
		return true
	} catch {
		return false
	}
}

function countAheadBehind(repo: string, remoteRef: string, branch: string): { ahead: number; behind: number } {
	const count = (args: string[]): number => {
		try {
			return Number(git(repo, args, 10_000)) || 0
		} catch {
			return 0
		}
	}
	return {
		ahead: count(["rev-list", "--count", `${remoteRef}..${branch}`]),
		behind: count(["rev-list", "--count", `${branch}..${remoteRef}`]),
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/**
 * Read-only drift report against the CURRENT (possibly stale) origin ref —
 * no fetch, no mutation. `undefined` when there is nothing to compare
 * against (detached HEAD, no origin remote, branch never pushed).
 */
export function branchSyncStatus(repo: string, branch?: string): BranchSyncStatus | undefined {
	const head = resolveHeadBranch(repo)
	const target = branch ?? head
	if (!target || !hasRemoteOrigin(repo)) {
		return undefined
	}
	const remoteRef = `origin/${target}`
	if (!remoteRefExists(repo, remoteRef)) {
		return undefined
	}
	const { ahead, behind } = countAheadBehind(repo, remoteRef, target)
	return { branch: target, remoteRef, ahead, behind }
}

/**
 * Fetch origin, push local-only commits, then fast-forward local onto origin
 * (only when local is strictly behind and it is the checked-out branch). A
 * divergence (local ahead AND behind) cannot be auto-reconciled — it is
 * reported as a loud warning. Never throws.
 */
export function syncBranchWithOrigin(repo: string, branch?: string): BranchSyncResult {
	const head = resolveHeadBranch(repo)
	const target = branch ?? head
	if (!target) {
		return {
			branch: "", remoteRef: "", ahead: 0, behind: 0,
			skipped: true, skipReason: "detached HEAD — cannot determine the branch to sync",
			fetched: false, pushed: false, fastForwarded: false, notes: [], warnings: [],
		}
	}
	const remoteRef = `origin/${target}`
	if (!hasRemoteOrigin(repo)) {
		return {
			branch: target, remoteRef, ahead: 0, behind: 0,
			skipped: true, skipReason: `no git remote named 'origin' — nothing to sync`,
			fetched: false, pushed: false, fastForwarded: false, notes: [], warnings: [],
		}
	}
	if (!remoteRefExists(repo, remoteRef)) {
		return {
			branch: target, remoteRef, ahead: 0, behind: 0,
			skipped: true, skipReason: `${remoteRef} does not exist — this branch was never pushed`,
			fetched: false, pushed: false, fastForwarded: false, notes: [], warnings: [],
		}
	}

	const notes: string[] = []
	const warnings: string[] = []

	let fetched = false
	try {
		git(repo, ["fetch", "origin", target], 60_000)
		fetched = true
	} catch (err) {
		return {
			branch: target, remoteRef, ahead: 0, behind: 0, skipped: false,
			fetched: false, pushed: false, fastForwarded: false, notes: [],
			warnings: [`git fetch origin ${target} failed: ${errMessage(err)} — cannot sync local ${target} with ${remoteRef}`],
		}
	}

	let { ahead, behind } = countAheadBehind(repo, remoteRef, target)
	let pushed = false
	let fastForwarded = false

	if (ahead > 0) {
		try {
			git(repo, ["push", "origin", target], 60_000)
			pushed = true
			notes.push(`pushed ${ahead} commit(s) to ${remoteRef}`)
			ahead = 0
		} catch (err) {
			warnings.push(`could not push ${ahead} commit(s) to ${remoteRef}: ${errMessage(err)}`)
		}
	}

	if (behind > 0) {
		if (target !== head) {
			notes.push(`local ${target} is ${behind} commit(s) behind ${remoteRef} — not fast-forwarding (only the checked-out branch is auto-merged)`)
		} else {
			try {
				git(repo, ["merge", "--ff-only", remoteRef], 30_000)
				fastForwarded = true
				notes.push(`fast-forwarded ${target} onto ${remoteRef} (${behind} commit(s))`)
				behind = 0
			} catch (err) {
				warnings.push(`could not fast-forward ${target} onto ${remoteRef}: ${errMessage(err)}`)
			}
		}
	}

	return { branch: target, remoteRef, ahead, behind, skipped: false, fetched, pushed, fastForwarded, notes, warnings }
}

/** Informational lines describing what the sync did (empty for a silent no-op). */
export function syncSummaryLines(result: BranchSyncResult): string[] {
	if (result.skipped) {
		return []
	}
	if (result.pushed || result.fastForwarded) {
		const bits: string[] = []
		if (result.pushed) {
			bits.push("pushed local commits")
		}
		if (result.fastForwarded) {
			bits.push("fast-forwarded onto origin")
		}
		return [`${result.branch} synced with ${result.remoteRef} (${bits.join(", ")})`]
	}
	if (result.ahead > 0 || result.behind > 0) {
		return [`${result.branch} NOT fully synced with ${result.remoteRef} (${result.ahead} ahead, ${result.behind} behind)`]
	}
	if (result.warnings.length === 0) {
		return [`${result.branch} is in sync with ${result.remoteRef}`]
	}
	return []
}

/** Loud, actionable warning lines for drift the sync could not fix. */
export function syncWarningLines(result: BranchSyncResult, repo: string): string[] {
	if (result.skipped) {
		return []
	}
	const lines = [...result.warnings]
	if (result.ahead > 0 || result.behind > 0) {
		lines.push(
			`WARNING: local ${result.branch} is ${result.ahead} commit(s) ahead and ${result.behind} behind ${result.remoteRef} ` +
				`after the sync attempt — unpushed drift like this causes merge-conflict cascades at PR-merge time (issue #25). ` +
				`Reconcile manually: git -C ${repo} fetch origin && git -C ${repo} merge --ff-only origin/${result.branch} && git -C ${repo} push origin ${result.branch}`,
		)
	}
	return lines
}
