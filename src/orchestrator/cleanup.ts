/**
 * `headlesscode orchestrate cleanup` — deterministic, human-triggered worktree
 * cleanup after a round's work is merged.
 *
 * Why this is a separate explicit command (never wired into the watcher's
 * terminal-status transition): removing a worktree is the ONE operation in the
 * whole pipeline with no undo, so it stays human-triggered — the same
 * deliberate, separate-step philosophy as `headlesscode index` and the deploy
 * gate.
 *
 * Eligibility — ALL gates below, computed FRESH every run (never cached from
 * a prior round):
 *   1. Worktree exists (a missing worktree is "already done", idempotent).
 *   2. Group status is terminal (done|failed|needs-human|orphaned — see
 *      status.ts's isTerminalStatus). spawned/running/blocked is never touched.
 *   3. Merge verified: `git merge-base --is-ancestor <branch> <base>` (exit 0)
 *      for local merges, or the GitHub PR `.merged` field when the group
 *      records pr.number (squash/rebase merges create a new hash — the local
 *      check alone would wrongly say "not merged"). If both are available and
 *      disagree, fail CLOSED (not merged). See merge-check.ts.
 *   4. Worktree has no uncommitted changes: `git status --porcelain` shows
 *      only the harness's OWN untracked artifacts (run-worker.sh / run-qa.sh /
 *      the spawner / the executor write .harness.*, .qa.*, harness.log,
 *      qa.log, .headlesscode/, ORCHESTRATOR_TASK.md, .env, zoo-code) plus a
 *      small allowlist of known-safe regenerable residue workers routinely
 *      leave behind (a node_modules symlink/dir, __pycache__ dirs,
 *      *.pyc/*.pyo — issue #38). A human's untracked file or ANY tracked
 *      modification blocks cleanup — `git worktree remove` without --force is
 *      the final arbiter, and we never force.
 *   5. No live worker process: <worktree>/.harness.pid and .qa.pid absent or
 *      the PID is not running (reuses watch.ts's isPidAlive liveness check —
 *      a stale pid FILE is not a running worker).
 *
 * Apply, per eligible group in state order (never reordered, so partial runs
 * are resumable and idempotent):
 *   1. Remove the harness's own untracked artifacts and the known-safe
 *      regenerable residue from the worktree. This step exists because `git
 *      worktree remove` (no --force) refuses on ANY untracked file — after a
 *      real round the harness leaves exactly those files, so without this the
 *      no-force removal the safety model requires would be impossible. Only
 *      the allowlisted paths are ever removed; if a human file raced in
 *      between the gate and this step, the no-force `git worktree remove`
 *      below refuses and the human file survives.
 *   2. `git worktree remove <path>` (NO --force). A failure here means gate #4
 *      raced with something: that group's cleanup is aborted and reported,
 *      never forced.
 *   3. `git branch -d <branch>` (lowercase -d — itself refuses to delete a
 *      branch not merged into HEAD/upstream: a second, independent safety net
 *      on top of gate #3). A failure here is reported and recorded in
 *      actions_taken, but is NOT a run failure: the irreversible operation
 *      (worktree removal) already succeeded, and re-running is a no-op.
 *   4. Patch the group's state entry: add `cleaned_at` and append to
 *      `actions_taken`. The group entry itself is NEVER deleted — the round's
 *      history stays queryable (same philosophy as the `orphaned` status).
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import { createAppAuthClient } from "../github/app-auth.js"
import { checkMergedByAncestor, checkMergedByGitHubPr, type MergeCheckResult } from "./merge-check.js"
import { loadStateSync, saveStateSync, updateGroup, type OrchestratorGroup, type OrchestratorState } from "./state.js"
import { isTerminalStatus } from "./status.js"
import { groupWorktreePath, isPidAlive } from "./watch.js"
import {
	branchSyncStatus,
	ORCHESTRATE_SYNC_DISABLED_ENV,
	syncBranchWithOrigin,
	syncSummaryLines,
	syncWarningLines,
	TRIVIAL_DRIFT_AHEAD,
} from "./git-sync.js"

// ─── Harness-owned worktree artifacts ─────────────────────────────────────────
// Paths the harness itself creates inside a worktree (run-worker.sh, run-qa.sh,
// spawn-parallel-worktrees.sh, the executor, headlesscode-answer.sh). These are
// the ONLY untracked entries the dirty gate ignores and the only paths apply
// removes before `git worktree remove` (which refuses on ANY untracked file).
const HARNESS_ARTIFACTS = [
	".harness.pid",
	".harness.pgid", // process-group id written by run-worker.sh's setsid wrapper (issue #38)
	".harness.exit",
	".harness.done",
	".harness.needs-decision",
	".harness.decision-answer",
	".qa.pid",
	".qa.exit",
	".qa.done",
	".qa-task.md",
	"harness.log",
	"qa.log",
	".headlesscode",
	"ORCHESTRATOR_TASK.md",
	".env",
	"zoo-code",
] as const

function isHarnessArtifact(relPath: string): boolean {
	if ((HARNESS_ARTIFACTS as readonly string[]).includes(relPath)) {
		return true
	}
	// A partially-tracked .headlesscode/ shows individual files, not the dir.
	return relPath.startsWith(".headlesscode/")
}

/** Remove exactly the harness-owned artifact paths from a worktree. */
export function removeHarnessArtifacts(wtPath: string): void {
	for (const name of HARNESS_ARTIFACTS) {
		fs.rmSync(path.join(wtPath, name), { recursive: true, force: true })
	}
}

// ─── Known-safe regenerable worktree artifacts ───────────────────────────────
// Untracked residue workers/reviewer/QA sessions routinely leave behind that is
// ALWAYS safe to delete — regenerable by the package manager or interpreter —
// and that target repos' own .gitignore conventions already treat as disposable
// (issue #38). A worker-created `node_modules` SYMLINK in particular does not
// match the dir-only `node_modules/` gitignore pattern, so it shows as
// untracked and previously blocked cleanup every round. Anything NOT matching
// here or in HARNESS_ARTIFACTS still blocks cleanup: genuine uncommitted work
// is never silently discarded.
const KNOWN_SAFE_ARTIFACT_PATTERNS = [
	// node tooling dependencies — symlink or real dir, at any depth
	(p: string): boolean => path.posix.basename(p) === "node_modules",
	// Python bytecode caches — __pycache__ dirs (any depth) and stray .pyc/.pyo
	(p: string): boolean => path.posix.basename(p) === "__pycache__",
	(p: string): boolean => /\.(?:pyc|pyo)$/.test(path.posix.basename(p)),
] as const

function isKnownSafeArtifact(relPath: string): boolean {
	return KNOWN_SAFE_ARTIFACT_PATTERNS.some((match) => match(relPath))
}

// ─── Public result types ──────────────────────────────────────────────────────

/** Per-group cleanup eligibility (also the `cleanup` column in status). */
export type CleanupStatus =
	| { status: "eligible"; via?: string; detail?: string }
	| { status: "blocked"; reason: string; via?: string; detail?: string }
	| { status: "done" }

/** GitHub wiring for the PR-merge check (only when group.pr?.number is set). */
export interface GhWiring {
	owner: string
	repo: string
	getInstallationToken: () => Promise<string>
	baseUrl?: string
	fetchImpl?: typeof fetch
}

/**
 * Injectable seams (tests). Defaults are the real git/fs operations; a test
 * injects only what it needs to prove one gate/step in isolation.
 */
export interface CleanupDeps {
	/** Full merge-check dispatch (GitHub-first when pr.number is set). */
	checkMerged?: (repo: string, group: OrchestratorGroup, baseBranch: string, gh?: GhWiring) => Promise<MergeCheckResult>
	/** Blocking (non-harness) `git status --porcelain` entries; throws on git failure. */
	worktreeStatus?: (wtPath: string) => string[]
	removeHarnessArtifacts?: (wtPath: string) => void
	/** Remove a worktree's untracked known-safe residue (node_modules, __pycache__, *.pyc/*.pyo). */
	removeKnownSafeArtifacts?: (wtPath: string) => void
	/** `git worktree remove <wtPath>` (no --force); throws on failure. */
	removeWorktree?: (repo: string, wtPath: string) => void
	/** `git branch -d <branch>`; throws on failure. */
	deleteBranch?: (repo: string, branch: string) => void
	writeState?: (statePath: string, state: OrchestratorState) => void
	now?: () => string
}

// ─── Small git helpers ────────────────────────────────────────────────────────

/** The branch the round's work was merged into: --base or the repo's HEAD branch. */
export function resolveBaseBranch(repo: string, explicit?: string): string {
	if (explicit !== undefined && explicit !== "") {
		return explicit
	}
	try {
		const branch = execFileSync("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim()
		if (branch !== "") {
			return branch
		}
	} catch {
		// fall through to the error below
	}
	throw new Error("cannot resolve the repo's current branch (detached HEAD?) — pass --base <branch>")
}

/** A group's branch: state's `branch` field, else the worktree's checked-out branch. */
export function resolveGroupBranch(repo: string, group: OrchestratorGroup): string | undefined {
	if (group.branch) {
		return group.branch
	}
	try {
		return execFileSync("git", ["-C", groupWorktreePath(repo, group), "symbolic-ref", "--short", "HEAD"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim()
	} catch {
		return undefined
	}
}

interface PorcelainEntry {
	code: string
	path: string
	raw: string
}

/** Parse `git status --porcelain` output into {code, path, raw} entries. */
function parsePorcelain(out: string): PorcelainEntry[] {
	const entries: PorcelainEntry[] = []
	for (const line of out.split("\n")) {
		if (line === "") {
			continue
		}
		const code = line.slice(0, 2)
		let file = line.slice(3).trim()
		if (file.includes(" -> ")) {
			file = file.split(" -> ").pop()!.trim()
		}
		entries.push({ code, path: file.replace(/\/+$/, ""), raw: line.trim() })
	}
	return entries
}

/** `git status --porcelain` for a worktree; throws on git failure. */
function gitStatusPorcelain(wtPath: string): string {
	try {
		return execFileSync("git", ["-C", wtPath, "status", "--porcelain"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		})
	} catch (err) {
		throw new Error(`cannot read worktree git status: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/**
 * `git status --porcelain` entries that are NOT the harness's own untracked
 * artifacts or known-safe regenerable residue (i.e. real uncommitted changes —
 * tracked modifications or a human's untracked files). Empty = the worktree is
 * safe to remove.
 */
export function worktreeUncommitted(wtPath: string): string[] {
	const blocking: string[] = []
	for (const entry of parsePorcelain(gitStatusPorcelain(wtPath))) {
		if (entry.code === "??" && (isHarnessArtifact(entry.path) || isKnownSafeArtifact(entry.path))) {
			continue
		}
		blocking.push(entry.raw)
	}
	return blocking
}

/**
 * Remove a worktree's UNTRACKED known-safe residue (node_modules symlink/dir,
 * __pycache__ dirs, stray .pyc/.pyo) before `git worktree remove`, which
 * refuses on ANY untracked file. Git-status-driven: only paths git reports as
 * untracked are ever removed, so a repo that TRACKS one of these names is
 * never touched; removing a node_modules symlink unlinks the symlink itself,
 * never its target. Anything not matching the allowlist is left alone (and
 * would have blocked cleanup at the dirty gate anyway).
 */
export function removeKnownSafeArtifacts(wtPath: string): void {
	let out: string
	try {
		out = gitStatusPorcelain(wtPath)
	} catch {
		return // the dirty gate already surfaced a status error — removal must not mask it
	}
	for (const entry of parsePorcelain(out)) {
		if (entry.code !== "??" || !isKnownSafeArtifact(entry.path)) {
			continue
		}
		fs.rmSync(path.join(wtPath, entry.path), { recursive: true, force: true })
	}
}

// ─── Merge-check dispatch ─────────────────────────────────────────────────────

/**
 * Dispatch by which workflow produced the group: GitHub PR first when
 * group.pr?.number is set AND gh wiring exists, else local-ancestor.
 *
 * Disagreement rule (fail closed): when BOTH checks are available, a GitHub
 * "not merged" alongside a local "is ancestor" is a real contradiction — the
 * recorded PR was never merged even though the branch's commits are in
 * history — and is treated as NOT merged with the discrepancy surfaced. The
 * reverse (GitHub merged / local not-ancestor) is the EXPECTED squash/rebase
 * shape (a new hash), not a contradiction: GitHub's `.merged` is
 * authoritative for PR merges.
 */
export async function checkGroupMerged(
	repo: string,
	group: OrchestratorGroup,
	baseBranch: string,
	gh?: GhWiring,
): Promise<MergeCheckResult> {
	const branch = resolveGroupBranch(repo, group)
	if (group.pr?.number && gh) {
		const ghResult = await checkMergedByGitHubPr({
			owner: gh.owner,
			repo: gh.repo,
			prNumber: group.pr.number,
			getInstallationToken: gh.getInstallationToken,
			...(gh.baseUrl ? { baseUrl: gh.baseUrl } : {}),
			...(gh.fetchImpl ? { fetchImpl: gh.fetchImpl } : {}),
		})
		let local: MergeCheckResult | undefined
		if (branch) {
			try {
				local = checkMergedByAncestor(repo, branch, baseBranch)
			} catch {
				local = undefined // branch gone / unreadable — rely on GitHub alone
			}
		}
		if (ghResult.merged) {
			return {
				merged: true,
				via: "github-pr",
				detail:
					ghResult.detail +
					(local && !local.merged
						? ` (local ancestor check disagrees — expected for squash/rebase merges)`
						: ""),
			}
		}
		if (ghResult.via === "unknown") {
			// The GitHub check is UNAVAILABLE (API/network error), not
			// disagreeing. Fall back to the local ancestor check: if the
			// branch's commits are provably in history, deletion is safe no
			// matter what the PR state is. Otherwise the unknown blocks.
			if (local && local.merged) {
				return local
			}
			return ghResult
		}
		// GitHub definitively says NOT merged.
		if (local && local.merged) {
			return {
				merged: false,
				via: "unknown",
				detail: `disagreement: GitHub PR #${group.pr.number} is NOT merged but branch ${branch} IS an ancestor of ${baseBranch} — failing closed`,
			}
		}
		return { merged: false, via: ghResult.via, detail: ghResult.detail }
	}
	// No PR number (or no GitHub wiring): local-ancestor is the source of truth.
	if (!branch) {
		throw new Error(`cannot determine branch for group ${group.name}`)
	}
	return checkMergedByAncestor(repo, branch, baseBranch)
}

// ─── Gates ────────────────────────────────────────────────────────────────────

/** Gates 4–5 (dirty + live process) applied after the merge gate passed. */
function gateAfterMerge(wtPath: string, merged: MergeCheckResult, worktreeStatus: (wtPath: string) => string[]): CleanupStatus {
	let changes: string[]
	try {
		changes = worktreeStatus(wtPath)
	} catch (err) {
		return { status: "blocked", reason: `cannot check worktree status: ${err instanceof Error ? err.message : String(err)}`, via: merged.via }
	}
	if (changes.length > 0) {
		const shown = changes.slice(0, 3).join("; ")
		return {
			status: "blocked",
			reason:
				`merged (${merged.via}) but worktree has uncommitted changes: ` +
				`${shown}${changes.length > 3 ? ` (+${changes.length - 3} more)` : ""}`,
			via: merged.via,
		}
	}
	if (isPidAlive(wtPath) || isPidAlive(wtPath, ".qa.pid")) {
		return {
			status: "blocked",
			reason: `merged (${merged.via}) but worker process is still running`,
			via: merged.via,
		}
	}
	return { status: "eligible", via: merged.via, detail: merged.detail }
}

function sharedGates(wtPath: string, group: OrchestratorGroup): CleanupStatus | undefined {
	if (!fs.existsSync(wtPath)) {
		return { status: "done" }
	}
	if (!isTerminalStatus(group.status)) {
		return { status: "blocked", reason: `status "${group.status}" is not terminal` }
	}
	return undefined
}

/**
 * Full eligibility assessment (cleanup command path — may use the GitHub PR
 * check when wired). Non-throwing: any failure becomes a blocked result.
 */
export async function assessGroupCleanup(
	repo: string,
	group: OrchestratorGroup,
	opts: { baseBranch: string; gh?: GhWiring; deps?: CleanupDeps },
): Promise<CleanupStatus> {
	const deps = opts.deps ?? {}
	const checkMerged = deps.checkMerged ?? checkGroupMerged
	const worktreeStatus = deps.worktreeStatus ?? worktreeUncommitted
	const wtPath = groupWorktreePath(repo, group)

	const shared = sharedGates(wtPath, group)
	if (shared) {
		return shared
	}

	let merged: MergeCheckResult
	try {
		merged = await checkMerged(repo, group, opts.baseBranch, opts.gh)
	} catch (err) {
		return { status: "blocked", reason: `cannot verify merge: ${err instanceof Error ? err.message : String(err)}`, via: "unknown" }
	}
	if (!merged.merged) {
		return { status: "blocked", reason: `not merged (${merged.via}): ${merged.detail}`, via: merged.via, detail: merged.detail }
	}
	return gateAfterMerge(wtPath, merged, worktreeStatus)
}

/**
 * Read-only eligibility for the `orchestrate status` cleanup column: the SAME
 * gates as assessGroupCleanup minus the network (local-ancestor merge check
 * only), synchronous and never throwing. A group with a pr.number that cannot
 * be verified locally reports blocked with a pointer to the cleanup command.
 */
export function assessGroupCleanupSync(repo: string, group: OrchestratorGroup, baseBranch: string): CleanupStatus {
	const wtPath = groupWorktreePath(repo, group)

	const shared = sharedGates(wtPath, group)
	if (shared) {
		return shared
	}

	let merged: MergeCheckResult
	try {
		const branch = resolveGroupBranch(repo, group)
		if (!branch) {
			return { status: "blocked", reason: "cannot determine branch" }
		}
		merged = checkMergedByAncestor(repo, branch, baseBranch)
	} catch (err) {
		return {
			status: "blocked",
			reason:
				group.pr?.number
					? `PR #${group.pr.number} merge not verifiable locally — run "orchestrate cleanup --dry-run" for the GitHub check`
					: `cannot verify merge: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
	if (!merged.merged) {
		return {
			status: "blocked",
			reason:
				group.pr?.number
					? `not merged locally (PR #${group.pr.number} may be squash-merged) — run "orchestrate cleanup --dry-run" for the GitHub check`
					: `not merged (${merged.via}): ${merged.detail}`,
			via: merged.via,
		}
	}
	return gateAfterMerge(wtPath, merged, worktreeUncommitted)
}

// ─── Planning + applying ──────────────────────────────────────────────────────

export interface CleanupPlanEntry {
	name: string
	status: CleanupStatus
	/**
	 * The branch resolved for this group (state `branch` field, else the
	 * worktree's checked-out branch). Carried from the plan so apply can
	 * delete it AFTER the worktree is gone (when the state never recorded a
	 * branch, the worktree was the only way to learn it).
	 */
	branch?: string
}

export interface CleanupPlan {
	repo: string
	statePath: string
	baseBranch: string
	/** State-file order — never reordered, so partial runs are resumable. */
	groups: CleanupPlanEntry[]
}

export interface CleanupRunResult {
	plan: CleanupPlan
	/** Groups whose worktree was removed this run. */
	removed: string[]
	/** Groups whose worktree removal failed (no branch delete / state patch). */
	failed: Array<{ name: string; error: string }>
	/** Groups whose state entry was patched with cleaned_at. */
	statePatched: string[]
}

/** Compute the full plan for a state. Pure (git reads only), never mutates. */
export async function planCleanup(
	repo: string,
	state: OrchestratorState,
	opts: { statePath: string; baseBranch: string; gh?: GhWiring; deps?: CleanupDeps },
): Promise<CleanupPlan> {
	const groups: CleanupPlanEntry[] = []
	for (const group of state.groups) {
		const status = await assessGroupCleanup(repo, group, opts)
		const branch = status.status === "eligible" ? resolveGroupBranch(repo, group) : undefined
		groups.push({ name: group.name, status, branch })
	}
	return { repo, statePath: opts.statePath, baseBranch: opts.baseBranch, groups }
}

/** Ensure a group's worktree path stays inside <repo>/.worktrees/ — cleanup
 * deletes, so a hostile/rotten state file must never point it outside. */
function worktreePathInRepo(repo: string, wtPath: string): boolean {
	const parent = path.join(repo, ".worktrees") + path.sep
	return wtPath.startsWith(parent)
}

/**
 * Execute cleanup for every eligible group (in state order): remove harness
 * artifacts and known-safe residue → `git worktree remove` (no --force) →
 * `git branch -d` → patch the state entry. A worktree-removal failure aborts
 * ONLY that group (no branch delete, no state patch) and continues with the
 * next.
 */
export async function applyCleanup(
	repo: string,
	statePath: string,
	opts: { baseBranch: string; gh?: GhWiring; deps?: CleanupDeps },
): Promise<CleanupRunResult> {
	const deps = {
		removeHarnessArtifacts,
		removeKnownSafeArtifacts,
		removeWorktree: (r: string, wtPath: string): void => {
			execFileSync("git", ["-C", r, "worktree", "remove", wtPath], { stdio: "ignore", timeout: 30_000 })
		},
		deleteBranch: (r: string, branch: string): void => {
			execFileSync("git", ["-C", r, "branch", "-d", branch], { stdio: "ignore", timeout: 10_000 })
		},
		writeState: saveStateSync,
		now: () => new Date().toISOString(),
		...opts.deps,
	} as Required<
		Pick<CleanupDeps, "removeHarnessArtifacts" | "removeKnownSafeArtifacts" | "removeWorktree" | "deleteBranch" | "writeState" | "now">
	>
	const state = loadStateSync(statePath)
	const plan = await planCleanup(repo, state, { ...opts, statePath })

	const removed: string[] = []
	const failed: Array<{ name: string; error: string }> = []
	const statePatched: string[] = []

	for (const entry of plan.groups) {
		if (entry.status.status !== "eligible") {
			continue
		}
		const group = state.groups.find((g) => g.name === entry.name)
		if (!group) {
			continue
		}
		const wtPath = groupWorktreePath(repo, group)
		if (!worktreePathInRepo(repo, wtPath)) {
			failed.push({ name: entry.name, error: `worktree path escapes <repo>/.worktrees/: ${wtPath} — refusing` })
			continue
		}

		// Step 1: drop the harness's own untracked artifacts and the known-safe
		// regenerable residue so the no-force `git worktree remove` below can
		// succeed (it refuses on ANY untracked file; the dirty gate already
		// proved everything untracked is allowlisted).
		try {
			deps.removeHarnessArtifacts(wtPath)
			deps.removeKnownSafeArtifacts(wtPath)
		} catch (err) {
			failed.push({
				name: entry.name,
				error: `removing worktree artifacts failed: ${err instanceof Error ? err.message : String(err)}`,
			})
			continue
		}
		// Step 2: remove the worktree, NO --force. If this fails the worktree
		// got dirty/raced after the gate — abort THIS group, never force.
		try {
			deps.removeWorktree(repo, wtPath)
		} catch (err) {
			failed.push({ name: entry.name, error: `git worktree remove failed: ${err instanceof Error ? err.message : String(err)}` })
			continue
		}
		removed.push(entry.name)

		// Step 3: delete the branch with lowercase -d (refuses unless merged
		// into HEAD/upstream — a second, independent safety net). A failure
		// here is recorded, not fatal: the irreversible removal succeeded.
		const branch = entry.branch ?? resolveGroupBranch(repo, group)
		const actions: string[] = [...(group.actions_taken ?? [])]
		actions.push(`worktree removed (merged via ${entry.status.via ?? "unknown"})`)
		let branchNote = ""
		if (branch) {
			try {
				deps.deleteBranch(repo, branch)
				actions.push(`branch ${branch} deleted`)
				branchNote = `; branch ${branch} deleted`
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				actions.push(`branch ${branch} delete FAILED (delete manually): ${msg}`)
				branchNote = `; branch ${branch} delete FAILED — see actions_taken`
			}
		}

		// Step 4: patch the state entry (reload fresh — the watcher or a
		// concurrent status call may have rewritten the file mid-run). The
		// entry itself is never deleted.
		try {
			const fresh = loadStateSync(statePath)
			const patched = updateGroup(fresh, entry.name, {
				cleaned_at: deps.now(),
				actions_taken: actions,
				last_activity: {
					note: `cleaned: worktree removed (merged via ${entry.status.via ?? "unknown"})${branchNote}`,
				},
			})
			deps.writeState(statePath, patched)
			statePatched.push(entry.name)
		} catch (err) {
			failed.push({
				name: entry.name,
				error: `state patch failed: ${err instanceof Error ? err.message : String(err)}`,
			})
		}
	}

	return { plan, removed, failed, statePatched }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const CLEANUP_USAGE = `headlesscode orchestrate cleanup — remove merged worktrees after a round

Usage:
  headlesscode orchestrate cleanup --repo <path> [--base <branch>] [--dry-run|--apply] [--json]
  headlesscode orchestrate cleanup --repo <path> [--gh-installation-id <id>] [--dry-run|--apply]

Options:
  --repo <path>          Target repo root whose .worktrees/.orchestrator-state.json
                         is read (required) and whose worktrees live under
                         <repo>/.worktrees/<name>.
  --base <branch>        Branch the round's work was merged INTO (default: the
                         repo's current branch, via HEAD).
  --dry-run              Print which groups are cleanup-eligible / blocked and
                         why, touching NOTHING. The DEFAULT when neither
                         --dry-run nor --apply is given.
  --apply                Actually perform the cleanup. For each eligible group,
                         in state order: remove the worktree (git worktree
                         remove, NO --force), delete the branch (git branch -d —
                         a second safety net), and record cleaned_at +
                         actions_taken in the state file.
  --json                 Machine-readable output (plan + results as JSON).
  --gh-installation-id <id>
                         GitHub App installation id for the PR-merge check when
                         a group records pr.number (squash/rebase merges cannot
                         be detected locally). Owner/repo are derived from the
                         repo's 'origin' remote. Requires GITHUB_APP_ID +
                         GITHUB_APP_PRIVATE_KEY[_PATH] (docs/github-app-setup.md).
                         Without it, groups with a pr.number fall back to the
                         local ancestor check.
  --help, -h             Show this help and exit.

Safety model (all gates recomputed fresh, never cached):
  - merge verified: git merge-base --is-ancestor <branch> <base> (exit 0), or
    GitHub PR .merged when pr.number is recorded; disagreement fails closed
  - worktree clean: git status --porcelain shows only the harness's own
    untracked artifacts (.harness.*, .qa.*, harness.log, qa.log,
    .headlesscode/, ORCHESTRATOR_TASK.md, .env, zoo-code) plus known-safe
    regenerable residue (node_modules symlink/dir, __pycache__, *.pyc/*.pyo)
  - no live worker: .harness.pid and .qa.pid absent or the PID is not running
  - terminal status: done | failed | needs-human | orphaned

Anything failing a gate is a documented no-op (reported, never forced).
Exit codes:
  0  dry-run: plan printed; --apply: every eligible group cleaned (blocked
     groups are not errors)
  1  --apply: at least one worktree removal or state write failed
  2  usage error
`

export interface CleanupCliOptions {
	repo: string
	base?: string
	dryRun: boolean
	apply: boolean
	json: boolean
	ghInstallationId?: string
	help: boolean
}

export function parseCleanupArgs(argv: string[]): { options: CleanupCliOptions; error?: string } {
	const options: CleanupCliOptions = {
		repo: "",
		base: undefined,
		dryRun: false,
		apply: false,
		json: false,
		ghInstallationId: undefined,
		help: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const eq = arg.indexOf("=")
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				return inlineValue
			}
			const v = argv[i + 1]
			if (v === undefined || v.startsWith("--")) {
				return undefined
			}
			i++
			return v
		}
		switch (flag) {
			case "--repo": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --repo" }
				}
				options.repo = v
				break
			}
			case "--base": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --base" }
				}
				options.base = v
				break
			}
			case "--dry-run":
				options.dryRun = true
				break
			case "--apply":
				options.apply = true
				break
			case "--json":
				options.json = true
				break
			case "--gh-installation-id": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --gh-installation-id" }
				}
				options.ghInstallationId = v
				break
			}
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown orchestrate cleanup argument: ${arg}` }
		}
	}
	return { options }
}

export interface CleanupIo {
	stdout?: (text: string) => void
	stderr?: (text: string) => void
}

function repoOwnerRepoFromRemote(repo: string): { owner: string; repo: string } | undefined {
	try {
		const url = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim()
		const match = url.match(/(?:github\.com[/:])([^/]+)\/([^/]+?)(?:\.git)?$/)
		if (match) {
			return { owner: match[1], repo: match[2] }
		}
	} catch {
		// no origin remote — the GitHub check simply isn't available
	}
	return undefined
}

/** Build GitHub wiring from --gh-installation-id + env creds; undefined when
 * the remote isn't a GitHub URL or the App credentials are missing. */
function buildGhWiring(repo: string, installationId: string): GhWiring | undefined {
	const parsed = repoOwnerRepoFromRemote(repo)
	if (!parsed) {
		return undefined
	}
	const appId = process.env.GITHUB_APP_ID
	const inlineKey = process.env.GITHUB_APP_PRIVATE_KEY
	const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH
	if (!appId || (!inlineKey && !keyPath)) {
		return undefined
	}
	try {
		const privateKey = inlineKey ?? fs.readFileSync(path.resolve(keyPath!), "utf-8")
		const client = createAppAuthClient({
			appId,
			privateKey,
			...(process.env.GITHUB_API_BASE_URL ? { baseUrl: process.env.GITHUB_API_BASE_URL } : {}),
		})
		return {
			owner: parsed.owner,
			repo: parsed.repo,
			getInstallationToken: () => client.getInstallationToken(installationId),
			...(process.env.GITHUB_API_BASE_URL ? { baseUrl: process.env.GITHUB_API_BASE_URL } : {}),
		}
	} catch {
		return undefined
	}
}

function shortStatus(status: CleanupStatus): string {
	return status.status
}

export function formatCleanupText(
	plan: CleanupPlan,
	opts: { mode: "dry-run" | "apply"; result?: CleanupRunResult },
): string {
	const lines: string[] = []
	lines.push(`── Orchestrator cleanup (${opts.mode}) ──`)
	lines.push(`repo:        ${plan.repo}`)
	lines.push(`state file:  ${plan.statePath}`)
	lines.push(`base branch: ${plan.baseBranch}`)
	lines.push("")
	if (plan.groups.length === 0) {
		lines.push("No orchestrator groups found in this state file (nothing to clean).")
	} else {
		lines.push(`${"GROUP".padEnd(14)}${"CLEANUP".padEnd(10)}DETAIL`)
		for (const entry of plan.groups) {
			const s = entry.status
			let detail = ""
			if (s.status === "eligible") {
				detail = `merged via ${s.via ?? "unknown"}` + (s.detail ? ` (${s.detail})` : "")
			} else if (s.status === "blocked") {
				detail = s.reason
			} else {
				detail = "worktree already removed"
			}
			lines.push(`${entry.name.padEnd(14)}${shortStatus(s).padEnd(10)}${detail}`)
		}
		lines.push("")
		const counts = { eligible: 0, blocked: 0, done: 0 }
		for (const entry of plan.groups) {
			counts[entry.status.status === "blocked" ? "blocked" : entry.status.status === "done" ? "done" : "eligible"]++
		}
		lines.push(
			`${counts.eligible} eligible · ${counts.blocked} blocked · ${counts.done} already-done ` +
				`(of ${plan.groups.length} group${plan.groups.length === 1 ? "" : "s"})`,
		)
	}
	if (opts.mode === "apply" && opts.result) {
		if (opts.result.removed.length > 0) {
			lines.push(`removed:      ${opts.result.removed.join(", ")}`)
		}
		if (opts.result.statePatched.length > 0) {
			lines.push(`state patched: ${opts.result.statePatched.join(", ")}`)
		}
		for (const f of opts.result.failed) {
			lines.push(`FAILED:       ${f.name} — ${f.error}`)
		}
	} else {
		lines.push("")
		lines.push('Dry run — nothing was removed. Re-run with --apply to perform deletions.')
	}
	return lines.join("\n") + "\n"
}

export function cleanupJson(plan: CleanupPlan, opts: { mode: "dry-run" | "apply"; result?: CleanupRunResult }): string {
	const groups = plan.groups.map((entry) => {
		const s = entry.status
		return {
			name: entry.name,
			status: s.status,
			...(s.status !== "done" && s.via ? { via: s.via } : {}),
			...(s.status === "blocked" && s.reason ? { reason: s.reason } : {}),
			...(s.status === "eligible" && s.detail ? { detail: s.detail } : {}),
		}
	})
	const out: Record<string, unknown> = {
		mode: opts.mode,
		repo: plan.repo,
		statePath: plan.statePath,
		baseBranch: plan.baseBranch,
		groups,
	}
	if (opts.result) {
		out.removed = opts.result.removed
		out.statePatched = opts.result.statePatched
		out.failed = opts.result.failed
	}
	return JSON.stringify(out, null, 2) + "\n"
}

export async function cleanupMain(argv: string[], io: CleanupIo = {}): Promise<number> {
	const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text))
	const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text))

	const { options, error } = parseCleanupArgs(argv)
	if (error) {
		writeErr(`headlesscode orchestrate cleanup: ${error}\n\n${CLEANUP_USAGE}`)
		return 2
	}
	if (options.help) {
		writeOut(CLEANUP_USAGE)
		return 0
	}
	if (!options.repo) {
		writeErr(`headlesscode orchestrate cleanup: --repo <path> is required\n\n${CLEANUP_USAGE}`)
		return 2
	}
	if (options.apply && options.dryRun) {
		writeErr(`headlesscode orchestrate cleanup: --apply and --dry-run are mutually exclusive\n\n${CLEANUP_USAGE}`)
		return 2
	}

	const repo = path.resolve(options.repo)
	try {
		execFileSync("git", ["-C", repo, "rev-parse", "--git-dir"], { stdio: "ignore", timeout: 5000 })
	} catch {
		writeErr(`headlesscode orchestrate cleanup: not a git repo: ${repo}\n`)
		return 2
	}

	let baseBranch: string
	try {
		baseBranch = resolveBaseBranch(repo, options.base)
	} catch (err) {
		writeErr(`headlesscode orchestrate cleanup: ${err instanceof Error ? err.message : String(err)}\n`)
		return 2
	}

	const gh = options.ghInstallationId ? buildGhWiring(repo, options.ghInstallationId) : undefined
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	let state: OrchestratorState
	try {
		state = loadStateSync(statePath)
	} catch (err) {
		writeErr(`headlesscode orchestrate cleanup: cannot read state file ${statePath}: ${err instanceof Error ? err.message : String(err)}\n`)
		return 1
	}

	const mode = options.apply ? "apply" : "dry-run"
	if (mode === "apply") {
		const result = await applyCleanup(repo, statePath, { baseBranch, gh })
		if (options.json) {
			writeOut(cleanupJson(result.plan, { mode, result }))
		} else {
			writeOut(formatCleanupText(result.plan, { mode, result }))
		}
		// Issue #25: cleanup --apply is the "a round just settled" checkpoint —
		// reconcile local master with origin (fetch, push, fast-forward) so
		// unpushed merge commits stop accumulating. Best-effort: failures are
		// loud warnings, never a cleanup failure. Sync lines go to stderr so
		// --json stdout stays machine-readable (see git-sync.ts).
		if (process.env[ORCHESTRATE_SYNC_DISABLED_ENV]) {
			const drift = branchSyncStatus(repo, baseBranch)
			if (drift && drift.ahead > TRIVIAL_DRIFT_AHEAD) {
				writeErr(
					`headlesscode orchestrate cleanup: WARNING: local ${drift.branch} is ${drift.ahead} commit(s) ahead of ${drift.remoteRef} ` +
						`(${ORCHESTRATE_SYNC_DISABLED_ENV} set — not pushing). Push it now: git -C ${repo} push origin ${drift.branch}\n`,
				)
			}
		} else {
			const sync = syncBranchWithOrigin(repo, baseBranch)
			for (const line of syncSummaryLines(sync)) {
				writeErr(`[sync] ${line}\n`)
			}
			for (const line of syncWarningLines(sync, repo)) {
				writeErr(`headlesscode orchestrate cleanup: ${line}\n`)
			}
		}
		return result.failed.length > 0 ? 1 : 0
	}

	const plan = await planCleanup(repo, state, { statePath, baseBranch, gh })
	if (options.json) {
		writeOut(cleanupJson(plan, { mode }))
	} else {
		writeOut(formatCleanupText(plan, { mode }))
	}
	return 0
}
