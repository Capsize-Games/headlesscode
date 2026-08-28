/**
 * Standalone review / rework / resume subcommands (issue #14) — expose the
 * review and rework steps that normally only fire inside a full
 * `orchestrate` spawn+watch round as independent entry points that pick up
 * EXISTING state instead:
 *
 *   headlesscode orchestrate review --repo <path> --issue <n>|--pr <n>|--group <name>
 *       — run the reviewer against an already-finished group's worktree and
 *         patch state exactly like the watch loop does.
 *   headlesscode orchestrate rework --repo <path> --issue <n>|--group <name>
 *       — re-spawn a worker on the SAME worktree to fix review findings
 *         (from state's pending_review_findings, or the issue's comments),
 *         using the SAME buildReworkTaskFileContent template as the
 *         automatic path.
 *   headlesscode orchestrate resume --repo <path> [--issue <n>|--pr <n>|--group <name>]
 *       — the full recovery pipeline for a stuck/interrupted round, per
 *         group: rebuild state from REAL on-disk markers → review →
 *         rework-if-needed (and continuation on iteration-exhaustion) → QA
 *         (--qa) → cost recording. With no target it resumes every group in
 *         the state file. Re-runnable: after a rework/continuation worker
 *         is spawned the group is left in-flight and the command reports;
 *         re-run it once the worker finishes to continue the chain.
 *
 * Every subcommand reuses the existing runReview / handleReviewVerdict /
 * handleIterationExhaustion / runQaWithRetries logic rather than duplicating
 * it — this is about exposing existing capability as a standalone entry
 * point, not building new review/rework logic.
 */

import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import {
	handleIterationExhaustion,
	handleQaSessionError,
	handleQaVerdict,
	handleReviewSessionError,
	handleReviewVerdict,
} from "./cli.js"
import { recordAllSessionCosts, recordGroupCost } from "./cost-history.js"
import { resolveModelForMode } from "../config/mode-models.js"
import { runQaWithRetries } from "../qa/qa.js"
import { HARNESS_ROOT, parseReviewResult, runReviewWithRetries, type ReviewResult } from "./reviewer.js"
import { loadStateSync, patchGroup, type OrchestratorGroup, type OrchestratorState } from "./state.js"
import { isTerminalStatus } from "./status.js"
import {
	DEFAULT_STALL_TIMEOUT_MS,
	groupWorktreePath,
	inspectGroup,
	isIterationExhaustion,
	readWorktreeUsage,
} from "./watch.js"

// ─── Shared target parsing ───────────────────────────────────────────────────

/** Which group(s) a standalone subcommand targets: by issue, PR, or name. */
export interface ResumeTarget {
	issue?: number
	pr?: number
	group?: string
}

/** One of --issue/--pr/--group is set (never more than one). */
function hasExactlyOneTarget(target: ResumeTarget): boolean {
	const set = (t: ResumeTarget): number =>
		(t.issue !== undefined ? 1 : 0) + (t.pr !== undefined ? 1 : 0) + (t.group !== undefined ? 1 : 0)
	return set(target) === 1
}

/** Extract --issue/--pr/--group from an argv list; the rest is returned untouched. */
function parseTargetArgs(argv: string[]): { rest: string[]; target: ResumeTarget; error?: string } {
	const target: ResumeTarget = {}
	let error: string | undefined
	const rest: string[] = []
	const flagOf = (arg: string): string => {
		const eq = arg.indexOf("=")
		return eq === -1 ? arg : arg.slice(0, eq)
	}
	const inlineValueOf = (arg: string): string | undefined => {
		const eq = arg.indexOf("=")
		return eq === -1 ? undefined : arg.slice(eq + 1)
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const flag = flagOf(arg)
		const inlineValue = inlineValueOf(arg)
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
			case "--issue": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					error = "--issue requires a positive integer"
				} else if (hasExactlyOneTarget(target)) {
					error = "provide exactly one of --issue, --pr, --group"
				} else {
					target.issue = n
				}
				break
			}
			case "--pr": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					error = "--pr requires a positive integer"
				} else if (hasExactlyOneTarget(target)) {
					error = "provide exactly one of --issue, --pr, --group"
				} else {
					target.pr = n
				}
				break
			}
			case "--group": {
				const v = next()
				if (v === undefined || v === "") {
					error = "--group requires a non-empty group name"
				} else if (hasExactlyOneTarget(target)) {
					error = "provide exactly one of --issue, --pr, --group"
				} else {
					target.group = v
				}
				break
			}
			default:
				rest.push(arg)
		}
	}
	return { rest, target, error }
}

// ─── `orchestrate review` ────────────────────────────────────────────────────

const REVIEW_USAGE = `headlesscode orchestrate review — run the review step against an existing group

Usage:
  headlesscode orchestrate review --repo <path> (--issue <n>|--pr <n>|--group <name>) [options]

Resolves the group's worktree (re-checking out its branch if the original was
cleaned up), rebuilds its state from real on-disk markers when stale, then runs
the reviewer exactly as the watch loop does, patching state the same way
(review_verdict / pending_review_findings / reviewed_at). Exit 0 when the
review is clean; 1 when it has findings, errored, or the group is not reviewable.

Options:
  --repo <path>           Target repo root (required)
  --issue <n>             Review the group handling issue <n>
  --pr <n>                Review the group for PR <n> (state pr or branch match)
  --group <name>          Review the group named <name> (e.g. w1)
  --review-mode <slug>    Review session mode (default: deepseek-reviewer)
  --model <id>            Explicit model override for the review session
  --force-review          Re-review even if the group already has a verdict
  --dry-run               Print the plan, change nothing
  --help                  Show this help and exit
`

export interface ReviewCliOptions {
	repo: string
	target: ResumeTarget
	reviewMode: string
	model?: string
	forceReview: boolean
	dryRun: boolean
	help: boolean
}

export function parseReviewArgs(argv: string[]): { options: ReviewCliOptions; error?: string } {
	const options: ReviewCliOptions = {
		repo: "",
		target: {},
		reviewMode: "deepseek-reviewer",
		forceReview: false,
		dryRun: false,
		help: false,
	}
	const { rest, target, error } = parseTargetArgs(argv)
	if (error) {
		return { options, error }
	}
	options.target = target
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]
		const eq = arg.indexOf("=")
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				return inlineValue
			}
			const v = rest[i + 1]
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
			case "--review-mode": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --review-mode" }
				}
				options.reviewMode = v
				break
			}
			case "--model": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --model" }
				}
				options.model = v
				break
			}
			case "--force-review":
				options.forceReview = true
				break
			case "--dry-run":
				options.dryRun = true
				break
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown review argument: ${arg}` }
		}
	}
	return { options }
}

// ─── `orchestrate rework` ────────────────────────────────────────────────────

const REWORK_USAGE = `headlesscode orchestrate rework — re-spawn a worker to fix review/QA findings

Usage:
  headlesscode orchestrate rework --repo <path> (--issue <n>|--pr <n>|--group <name>) [options]

Given an issue/PR/group that already has review findings (or a real QA fail —
issue #52), re-spawns a worker on the SAME worktree (re-checking out the
branch if the original was cleaned up) to fix them, using the SAME
buildReworkTaskFileContent / buildQaReworkTaskFileContent template the
automatic path uses. Review findings come from state's pending_review_findings
when present, else from the issue's GitHub comments; a QA-failed group with no
review findings is reworked from its recorded qa.evidence. Exit 0 when a worker
was spawned; 1 when the rework budget is exhausted (needs human) or there is
nothing to rework.

Options:
  --repo <path>            Target repo root (required)
  --issue <n>              Rework the group handling issue <n>
  --pr <n>                 Rework the group for PR <n> (state pr or branch match)
  --group <name>           Rework the group named <name> (e.g. w1)
  --mode <slug>            Worker mode for the rework spawn (default: code)
  --model <id>             Explicit model override for the rework worker
  --max-rework-cycles <n>  Rework cap (default: 3)
  --max-iterations <n>     Per-session iteration cap for the rework worker
  --memory-dir <path>      Phase 3 memory dir forwarded to the rework worker
  --dry-run                Print the rework task + spawn command, spawn nothing
  --help                   Show this help and exit
`

export interface ReworkCliOptions {
	repo: string
	target: ResumeTarget
	mode: string
	model?: string
	maxReworkCycles: number
	maxIterations?: number
	memoryDir?: string
	dryRun: boolean
	help: boolean
}

export function parseReworkArgs(argv: string[]): { options: ReworkCliOptions; error?: string } {
	const options: ReworkCliOptions = {
		repo: "",
		target: {},
		mode: "code",
		maxReworkCycles: 3,
		dryRun: false,
		help: false,
	}
	const { rest, target, error } = parseTargetArgs(argv)
	if (error) {
		return { options, error }
	}
	options.target = target
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]
		const eq = arg.indexOf("=")
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				return inlineValue
			}
			const v = rest[i + 1]
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
			case "--mode": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --mode" }
				}
				options.mode = v
				break
			}
			case "--model": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --model" }
				}
				options.model = v
				break
			}
			case "--max-rework-cycles": {
				const parsed = parseIntFlag(rest, i, "--max-rework-cycles")
				if (parsed.error) {
					return { options, error: parsed.error }
				}
				options.maxReworkCycles = parsed.value!
				i += parsed.consumed
				break
			}
			case "--max-iterations": {
				const parsed = parseIntFlag(rest, i, "--max-iterations")
				if (parsed.error) {
					return { options, error: parsed.error }
				}
				options.maxIterations = parsed.value
				i += parsed.consumed
				break
			}
			case "--memory-dir": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --memory-dir" }
				}
				options.memoryDir = v
				break
			}
			case "--dry-run":
				options.dryRun = true
				break
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown rework argument: ${arg}` }
		}
	}
	return { options }
}

// ─── `orchestrate resume` ────────────────────────────────────────────────────

const RESUME_USAGE = `headlesscode orchestrate resume — recover a stuck/interrupted round from existing state

Usage:
  headlesscode orchestrate resume --repo <path> (--issue <n>|--pr <n>|--group <name>) [options]
  headlesscode orchestrate resume --repo <path> [options]     (resume every group)

Per-group pipeline (issue #14):
  1. rebuild   — re-derive status from REAL on-disk markers (.harness.done /
                 .harness.exit, or their absence); a worktree that was cleaned
                 up is re-checked out from its recorded branch
  2. review    — run the reviewer on a "done" group (skipped when already
                 reviewed unless --force-review)
  3. rework    — findings → re-spawn a worker on the SAME worktree (up to
                 --max-rework-cycles); a finding verdict left over from an
                 interrupted round is reworked from its recorded findings;
                 iteration-exhaustion → continuation
  4. QA        — headless QA session when review passed and --qa is given
  5. cost      — record the group's cost/tokens once it is settled

Re-runnable: after a rework/continuation worker is spawned the group is left
in-flight and resume reports; re-run it once the worker finishes.

Options:
  --repo <path>           Target repo root (required)
  --issue <n>             Resume the group(s) handling issue <n>
  --pr <n>                Resume the group(s) for PR <n> (state pr or branch match)
  --group <name>          Resume the group named <name> (e.g. w1)
  --review-mode <slug>    Review session mode (default: deepseek-reviewer)
  --no-review             Skip the review step (QA/cost only)
  --qa                    Run a headless QA session after a clean review
  --qa-mode <slug>        QA session mode (default: qa-agent)
  --mode <slug>           Worker mode for rework/continuation spawns (default: code)
  --model <id>            Explicit model override for every role
  --max-rework-cycles <n> Rework cap (default: 3)
  --max-continuations <n> Iteration-exhaustion continuation cap (default: 3)
  --max-iterations <n>    Per-session iteration cap for spawned workers
  --memory-dir <path>     Phase 3 memory dir forwarded to spawned workers
  --force-review          Re-review a group even if it already has a verdict
  --dry-run               Print the pipeline plan, change nothing
  --help                  Show this help and exit
`

export interface ResumeCliOptions {
	repo: string
	target: ResumeTarget
	reviewMode: string
	noReview: boolean
	qa: boolean
	qaMode: string
	mode: string
	model?: string
	maxReworkCycles: number
	maxContinuations: number
	maxIterations?: number
	memoryDir?: string
	forceReview: boolean
	dryRun: boolean
	help: boolean
}

export function parseResumeArgs(argv: string[]): { options: ResumeCliOptions; error?: string } {
	const options: ResumeCliOptions = {
		repo: "",
		target: {},
		reviewMode: "deepseek-reviewer",
		noReview: false,
		qa: false,
		qaMode: "qa-agent",
		mode: "code",
		maxReworkCycles: 3,
		maxContinuations: 3,
		dryRun: false,
		forceReview: false,
		help: false,
	}
	const { rest, target, error } = parseTargetArgs(argv)
	if (error) {
		return { options, error }
	}
	options.target = target
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]
		const eq = arg.indexOf("=")
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				return inlineValue
			}
			const v = rest[i + 1]
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
			case "--review-mode": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --review-mode" }
				}
				options.reviewMode = v
				break
			}
			case "--no-review":
				options.noReview = true
				break
			case "--qa":
				options.qa = true
				break
			case "--qa-mode": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --qa-mode" }
				}
				options.qaMode = v
				break
			}
			case "--mode": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --mode" }
				}
				options.mode = v
				break
			}
			case "--model": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --model" }
				}
				options.model = v
				break
			}
			case "--max-rework-cycles": {
				const parsed = parseIntFlag(rest, i, "--max-rework-cycles")
				if (parsed.error) {
					return { options, error: parsed.error }
				}
				options.maxReworkCycles = parsed.value!
				i += parsed.consumed
				break
			}
			case "--max-continuations": {
				const parsed = parseIntFlag(rest, i, "--max-continuations")
				if (parsed.error) {
					return { options, error: parsed.error }
				}
				options.maxContinuations = parsed.value!
				i += parsed.consumed
				break
			}
			case "--max-iterations": {
				const parsed = parseIntFlag(rest, i, "--max-iterations")
				if (parsed.error) {
					return { options, error: parsed.error }
				}
				options.maxIterations = parsed.value
				i += parsed.consumed
				break
			}
			case "--memory-dir": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --memory-dir" }
				}
				options.memoryDir = v
				break
			}
			case "--force-review":
				options.forceReview = true
				break
			case "--dry-run":
				options.dryRun = true
				break
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown resume argument: ${arg}` }
		}
	}
	return { options }
}

// ─── Group resolution ────────────────────────────────────────────────────────

export interface ResolveTargetHooks {
	/** PR-head-branch resolver (default: gh pr view --json headRefName). */
	prHeadBranch?: (repo: string, pr: number) => string | undefined
}

/**
 * Resolve which state groups a target selects. By issue number (group.issues),
 * by group name, or by PR — first a direct group.pr?.number match, then a
 * branch match against the PR's head branch (gh). Empty when nothing matches.
 */
export function resolveTargetGroups(
	state: OrchestratorState,
	target: ResumeTarget,
	opts: { repo: string; hooks?: ResolveTargetHooks } = { repo: "" },
): OrchestratorGroup[] {
	if (target.group !== undefined) {
		return state.groups.filter((g) => g.name === target.group)
	}
	if (target.issue !== undefined) {
		const issue = target.issue
		return state.groups.filter((g) => (g.issues ?? []).includes(issue))
	}
	if (target.pr !== undefined) {
		const pr = target.pr
		const byPr = state.groups.filter((g) => g.pr?.number === pr)
		if (byPr.length > 0) {
			return byPr
		}
		const headBranch = (opts.hooks?.prHeadBranch ?? prHeadBranch)(opts.repo, pr)
		if (headBranch) {
			return state.groups.filter((g) => g.branch === headBranch)
		}
		return []
	}
	return []
}

/** The head branch of a GitHub PR (gh), or undefined when gh is unavailable. */
export function prHeadBranch(repo: string, pr: number): string | undefined {
	try {
		const out = execFileSync(
			"gh",
			["pr", "view", String(pr), "--json", "headRefName", "--jq", ".headRefName"],
			{ cwd: repo, encoding: "utf-8", timeout: 30_000 },
		).trim()
		return out === "" ? undefined : out
	} catch {
		return undefined
	}
}

// ─── Rebuild from real on-disk markers ───────────────────────────────────────

/**
 * Issue #14 (issue comment requirement): the FIRST step of any resume/review/
 * rework run — rebuild a group's state from the REAL on-disk markers
 * (.harness.done / .harness.exit / .harness.needs-decision, or their absence)
 * when the local orchestrator state is stale relative to what actually
 * happened. A stuck/interrupted round ALWAYS means local state and disk reality
 * have diverged, so this is the PRIMARY (not edge) case.
 *
 * The pattern is exactly the one the issue calls out:
 *   inspectGroup(repo, {...group, status: "running"}, Date.now(), stallTimeout)
 * — the forced "running" status is deliberate: it bypasses inspectGroup's
 * terminal short-circuit so ANY entry (regardless of what the state file
 * claims) is re-derived purely from markers.
 *
 * Pure: returns the patch (or undefined when markers change nothing); the
 * caller persists via patchGroup. A worktree that is entirely gone — with
 * nothing left to inspect — is surfaced as "orphaned" (never guessed as
 * done/failed), mirroring status.ts's reconcileGroups.
 */
export function rebuildPatchFromMarkers(
	repo: string,
	group: OrchestratorGroup,
	now = Date.now(),
	stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
): Partial<Omit<OrchestratorGroup, "name">> | undefined {
	const wtPath = groupWorktreePath(repo, group)
	if (!fs.existsSync(wtPath)) {
		return {
			status: "orphaned",
			last_activity: {
				note: "orphaned: worktree removed before a terminal status — investigate via git history",
			},
		}
	}
	return inspectGroup(repo, { ...group, status: "running" }, now, stallTimeoutMs)
}

// ─── Worktree re-checkout ────────────────────────────────────────────────────

/**
 * Re-checkout a group's branch into a fresh worktree when the original was
 * cleaned up (issue #14: "or re-checkout the branch into a fresh worktree if
 * the original was cleaned up"). Prefers recreating the local branch from
 * origin/<branch> (the branch's committed, pushed state) and falls back to
 * the local branch. `git worktree add -B` refuses when the branch is checked
 * out in ANOTHER worktree, so this can never clobber a live worktree — a
 * failure means the branch is busy elsewhere and the caller reports it.
 */
export function recheckoutWorktree(repo: string, group: OrchestratorGroup): { ok: boolean; error?: string } {
	const wtPath = groupWorktreePath(repo, group)
	const branch = group.branch
	if (!branch) {
		return { ok: false, error: `group ${group.name} has no recorded branch to re-checkout` }
	}
	try {
		fs.mkdirSync(path.dirname(wtPath), { recursive: true })
		try {
			execFileSync("git", ["-C", repo, "fetch", "origin", branch], { stdio: "ignore", timeout: 60_000 })
		} catch {
			// origin may be unreachable or the branch local-only — try local below.
		}
		try {
			execFileSync("git", ["-C", repo, "worktree", "add", "-B", branch, wtPath, `origin/${branch}`], {
				stdio: "ignore",
				timeout: 60_000,
			})
		} catch {
			execFileSync("git", ["-C", repo, "worktree", "add", "-B", branch, wtPath, branch], {
				stdio: "ignore",
				timeout: 60_000,
			})
		}
		return { ok: true }
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}
}

// ─── Findings from issue comments (rework fallback) ──────────────────────────

/**
 * Extract review findings from GitHub issue-comment bodies using the SAME
 * parser the orchestrator uses for a live review session (parseReviewResult
 * knows the reviewer's report format). Pure + unit-testable; gh is only
 * needed by fetchFindingsFromIssueComments.
 */
export function findingsFromCommentBodies(bodies: string[]): string[] {
	const findings: string[] = []
	for (const body of bodies) {
		if (typeof body !== "string" || body.trim() === "") {
			continue
		}
		const parsed = parseReviewResult(body)
		if (parsed.verdict === "finding") {
			findings.push(...parsed.findings)
		}
	}
	return [...new Set(findings)]
}

/**
 * Fallback findings source for `orchestrate rework` when the group no longer
 * has pending_review_findings in state (issue #14: "read from the issue
 * comments, or from pending_review_findings in state if still present").
 * Returns [] when gh is unavailable or no comment parses as a finding report
 * — callers fall back to the rework template's no-findings text.
 */
export function fetchFindingsFromIssueComments(repo: string, issue: number): string[] {
	let raw: string
	try {
		raw = execFileSync(
			"gh",
			["issue", "view", String(issue), "--json", "comments", "--jq", "[.comments[] | .body]"],
			{ cwd: repo, encoding: "utf-8", timeout: 30_000 },
		)
	} catch {
		return []
	}
	try {
		const bodies: unknown = JSON.parse(raw)
		if (!Array.isArray(bodies)) {
			return []
		}
		return findingsFromCommentBodies(bodies.filter((b): b is string => typeof b === "string"))
	} catch {
		return []
	}
}

// ─── Pipeline steps ──────────────────────────────────────────────────────────

/** Reload a group fresh from disk; falls back to the given snapshot. */
function reloadedGroup(statePath: string, name: string, fallback: OrchestratorGroup): OrchestratorGroup {
	try {
		return loadStateSync(statePath).groups.find((g) => g.name === name) ?? fallback
	} catch {
		return fallback
	}
}

// Bookkeeping artifacts the harness itself writes into a worktree — never
// real work, must not count as "the group changed something".
const HARNESS_ARTIFACT_RE =
	/^(\.harness\.|harness\.log$|qa\.log$|review\.log$|\.env$|ORCHESTRATOR_TASK\.md$|\.headlesscode\/)/

/**
 * Deterministic, un-hallucinate-able gate: does this worktree actually
 * contain any real change at all? Run directly by the orchestrator's own
 * git commands — never asked of an LLM — before either runReviewStep or
 * runQaStep ever trusts a "clean"/"pass" verdict.
 *
 * Verified live 2026-08-28 (joeos issue #26): a review session fabricated
 * an ENTIRE false completion — invented commit counts, invented diff
 * stats ("8691 insertions... across 47 files"), invented passing test
 * output, even a fabricated GitHub PR link — and declared VERDICT: CLEAN
 * via the structured, supposedly-authoritative verdict line, for a
 * worktree that in reality had ZERO commits and ZERO changes. No amount
 * of parser hardening closes this: the fabrication was coherent,
 * well-formatted prose: the model's own summary is not a source of
 * truth about what really happened. This checks the actual filesystem/
 * git state instead, which the model cannot talk its way around.
 *
 * Checks BOTH: (1) committed changes vs the tracked upstream (mirrors
 * exactly what worker/review/QA sessions are themselves told to check
 * via `git diff origin/master...HEAD`), and (2) uncommitted working-tree
 * changes — a worker's write_to_file calls land in the real working tree
 * with nothing forcing it to also commit them, so a committed-only check
 * could false-negative on real, uncommitted work. Ignores the harness's
 * own bookkeeping files (harness.log, .env, etc.) via HARNESS_ARTIFACT_RE
 * — those exist in every worktree regardless of whether real work
 * happened and must never count as "changed something".
 */
function hasRealWorktreeChanges(wtPath: string): boolean {
	let upstream = "origin/master"
	try {
		const tracked = execFileSync(
			"git",
			["-C", wtPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
			{ encoding: "utf-8", timeout: 5000 },
		).trim()
		if (tracked) {
			upstream = tracked
		}
	} catch {
		// No tracked upstream configured — fall back to origin/master.
	}
	try {
		const diffStat = execFileSync("git", ["-C", wtPath, "diff", `${upstream}...HEAD`, "--stat"], {
			encoding: "utf-8",
			timeout: 10_000,
		}).trim()
		if (diffStat.length > 0) {
			return true
		}
	} catch {
		// A failed diff isn't proof of "no changes" — fall through to the
		// working-tree check below rather than assume real work happened.
	}
	try {
		const status = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], {
			encoding: "utf-8",
			timeout: 10_000,
		})
		for (const line of status.split("\n")) {
			const filePath = line.slice(3).trim()
			if (filePath && !HARNESS_ARTIFACT_RE.test(filePath)) {
				return true
			}
		}
	} catch {
		// Can't determine either way — err toward NOT trusting an
		// unverifiable "clean" (return false, same as "no changes found").
	}
	return false
}

export interface ReviewStepOptions {
	repo: string
	statePath: string
	group: OrchestratorGroup
	reviewMode: string
	reviewerModel?: string
	forceReview: boolean
	dryRun: boolean
	write: (text: string) => void
}

export interface ReviewStepResult {
	group: OrchestratorGroup
	/** The review outcome (undefined when the step was skipped). */
	result?: ReviewResult
	skipped: boolean
	message: string
}

/**
 * Review a done group exactly as the watch loop's onGroupUpdate does:
 * runReviewWithRetries → session-error → handleReviewSessionError
 * (needs-human, NEVER a rework spawn); real verdict → review_verdict /
 * pending_review_findings / reviewed_at / last_activity patched. Skips groups
 * that already have a verdict unless forceReview.
 */
export async function runReviewStep(opts: ReviewStepOptions): Promise<ReviewStepResult> {
	const { repo, statePath, group, reviewMode, reviewerModel, forceReview, dryRun, write } = opts
	if (group.status !== "done") {
		return { group, skipped: true, message: `${group.name} is ${group.status} — review only runs on a "done" group` }
	}
	if (group.review_verdict !== undefined && !forceReview) {
		return {
			group,
			skipped: true,
			message: `${group.name} was already reviewed (verdict ${group.review_verdict}); use --force-review to re-review`,
		}
	}
	if (forceReview && !dryRun) {
		// A forced re-review starts from a clean slate — drop the old verdict.
		await patchGroup(statePath, group.name, {
			review_verdict: undefined,
			pending_review_findings: undefined,
			reviewed_at: undefined,
		})
	}
	const wtPath = groupWorktreePath(repo, group)
	write(`reviewing ${group.name} (branch ${group.branch ?? "?"})...\n`)
	if (dryRun) {
		write(`  dry-run: would run a headless review session (mode ${reviewMode}, model ${reviewerModel ?? "(default)"}) against ${wtPath}\n`)
		return { group, skipped: false, message: "dry-run: review not run" }
	}
	// See hasRealWorktreeChanges's doc comment: a "clean" verdict is
	// structurally impossible with zero real changes, checked directly
	// against git — never asked of (or trusted from) the review LLM
	// itself. Skips the review session entirely rather than spend a call
	// that has nothing real to verify.
	if (!hasRealWorktreeChanges(wtPath)) {
		const stateAfter = await patchGroup(statePath, group.name, {
			review_verdict: "finding",
			pending_review_findings: [
				"No real changes found in the worktree (empty diff vs the tracked upstream, no uncommitted changes outside harness bookkeeping files) — there is nothing for a review to verify. Automatic fail: a \"clean\" verdict is structurally impossible with zero changes.",
			],
			reviewed_at: new Date().toISOString(),
			last_activity: { note: "review skipped: worktree has no real changes (automatic fail)" },
		})
		const updated = stateAfter.groups.find((g) => g.name === group.name) ?? group
		write(
			`AUTOMATIC FAIL: ${group.name}'s worktree has no real changes — skipping the review session (a "clean" verdict is structurally impossible with an empty diff)\n`,
		)
		return { group: updated, skipped: false, message: "no real changes → automatic fail (review session never ran)" }
	}
	const result = await runReviewWithRetries({
		workspaceRoot: wtPath,
		mode: reviewMode,
		model: reviewerModel,
		issues: group.issues,
	})
	if (result.verdict === "error") {
		const stateAfter = await patchGroup(statePath, group.name, handleReviewSessionError(result))
		const updated = stateAfter.groups.find((g) => g.name === group.name) ?? group
		write(`NEEDS-HUMAN: ${group.name}'s review session failed repeatedly — ${result.summary}\n`)
		return { group: updated, result, skipped: false, message: "review session error → needs-human" }
	}
	const stateAfter = await patchGroup(statePath, group.name, {
		review_verdict: result.verdict,
		pending_review_findings: result.findings,
		reviewed_at: new Date().toISOString(),
		last_activity: { note: `reviewed: verdict=${result.verdict} (${result.findings.length} finding(s))` },
	})
	const updated = stateAfter.groups.find((g) => g.name === group.name) ?? group
	write(`review verdict: ${result.verdict} (${result.findings.length} finding(s))\n`)
	return { group: updated, result, skipped: false, message: `reviewed: ${result.verdict}` }
}

export type ReworkOutcome = "spawned" | "cap" | "not-applicable" | "already-running" | "dry-run"

export interface ReworkStepOptions {
	repo: string
	statePath: string
	group: OrchestratorGroup
	mode: string
	model?: string
	maxReworkCycles: number
	maxIterations?: number
	memoryDir?: string
	/** Findings to fix (default: group.pending_review_findings ?? []). */
	findings?: string[]
	dryRun: boolean
	write: (text: string) => void
}

export interface ReworkStepResult {
	outcome: ReworkOutcome
	group: OrchestratorGroup
	message: string
}

/**
 * Rework step: given a group with review findings, build the rework task via
 * the SAME buildReworkTaskFileContent template the automatic path uses (through
 * handleReviewVerdict), write it, and re-spawn a worker on the SAME worktree
 * via the same handleReviewVerdict decision (which also resets the group to
 * "running" and clears review/QA/cost artifacts for a fresh cycle). At the
 * rework cap the group is marked needs-human — identical to the watch loop.
 *
 * Issue #52: a group that FAILED QA (real verdict, not session error) has
 * actionable evidence even with no review findings — the same rework goes
 * through handleQaVerdict (feeding `qa.evidence` into the task file instead
 * of review findings), so `orchestrate rework` against a QA-failed group is
 * no longer a no-op. Review findings win if both are present (the reviewer
 * is the more specific source).
 */
export async function runReworkStep(opts: ReworkStepOptions): Promise<ReworkStepResult> {
	const { repo, statePath, group, mode, model, maxReworkCycles, maxIterations, memoryDir, dryRun, write } = opts
	if (group.status === "running" || group.status === "spawned" || group.status === "blocked") {
		return {
			outcome: "already-running",
			group,
			message: `${group.name} is ${group.status} — a worker is in flight; nothing to rework`,
		}
	}
	const findings = opts.findings ?? group.pending_review_findings ?? []
	const qaFail = group.qa?.verdict === "fail" && findings.length === 0
	const result: ReviewResult = {
		verdict: "finding",
		findings,
		summary: "standalone rework trigger (orchestrate rework/resume)",
	}
	const decision = qaFail
		? handleQaVerdict(
				group,
				{
					verdict: "fail",
					evidence: group.qa?.evidence ?? "",
					summary: "standalone QA-fail rework trigger (orchestrate rework/resume)",
				},
				repo,
				maxReworkCycles,
				mode,
				model,
				maxIterations,
			)
		: handleReviewVerdict(group, result, repo, maxReworkCycles, mode, model, maxIterations)
	if (!decision.shouldSpawn) {
		// Cap reached: terminal needs-human (findings stay recorded).
		if (dryRun) {
			write(`  dry-run: would mark ${group.name} needs-human (rework cap ${maxReworkCycles} reached)\n`)
		} else {
			await patchGroup(statePath, group.name, decision.patch)
		}
		return {
			outcome: "cap",
			group: dryRun ? group : reloadedGroup(statePath, group.name, group),
			message: `${group.name} exhausted its rework budget (cap ${maxReworkCycles}) — needs human`,
		}
	}
	if (!decision.taskFilePath || !decision.taskContent || !decision.spawnCommand) {
		return { outcome: "not-applicable", group, message: "no rework decision produced" }
	}
	write(`rework cycle ${decision.newReworkCount}: re-spawning worker on the same worktree...\n`)
	if (dryRun) {
		write(`  dry-run: would write ${path.relative(repo, decision.taskFilePath)} and run:\n    ${decision.spawnCommand}\n`)
		return { outcome: "dry-run", group, message: "dry-run: rework task + spawn command ready" }
	}
	fs.mkdirSync(path.dirname(decision.taskFilePath), { recursive: true })
	fs.writeFileSync(decision.taskFilePath, decision.taskContent, "utf-8")
	write(`wrote ${path.relative(repo, decision.taskFilePath)}\n`)
	const spawnResult = spawnSync("bash", ["-c", decision.spawnCommand], {
		cwd: repo,
		env: {
			...process.env,
			HEADLESSCODE_ROOT: HARNESS_ROOT,
			...(memoryDir ? { HEADLESSCODE_MEMORY_DIR: path.resolve(memoryDir) } : {}),
		},
		stdio: "inherit",
	})
	if (spawnResult.status !== 0) {
		// The rework worker could not be launched — surface as needing a human
		// instead of leaving a dangling "running" group (same as the watch loop).
		await patchGroup(statePath, group.name, {
			status: "needs-human",
			reworkCount: decision.newReworkCount,
			last_activity: { note: `rework spawn failed after ${decision.newReworkCount} attempt(s); needs human` },
		})
		return {
			outcome: "cap",
			group: reloadedGroup(statePath, group.name, group),
			message: `rework worker spawn failed (exit ${spawnResult.status}) — marked needs-human`,
		}
	}
	const stateAfter = await patchGroup(statePath, group.name, decision.patch)
	const updated = stateAfter.groups.find((g) => g.name === group.name) ?? group
	return {
		outcome: "spawned",
		group: updated,
		message: `rework cycle ${decision.newReworkCount}: worker spawned on the same worktree`,
	}
}

export interface QaStepOptions {
	repo: string
	statePath: string
	group: OrchestratorGroup
	qaMode: string
	qaModel?: string
	dryRun: boolean
	write: (text: string) => void
}

export interface QaStepResult {
	group: OrchestratorGroup
	skipped: boolean
	message: string
}

/**
 * QA step — the Phase 4 twin of runReviewStep, mirroring the watch loop's QA
 * block: runQaWithRetries → session-error → handleQaSessionError
 * (needs-human); real verdict → qa {status, verdict, evidence, updated}.
 */
export async function runQaStep(opts: QaStepOptions): Promise<QaStepResult> {
	const { repo, statePath, group, qaMode, qaModel, dryRun, write } = opts
	if (group.status !== "done" || group.qa !== undefined) {
		return {
			group,
			skipped: true,
			message: `${group.name} QA skipped (status ${group.status}, qa ${group.qa?.verdict ?? "unset"})`,
		}
	}
	const wtPath = groupWorktreePath(repo, group)
	write(`QA ${group.name} (branch ${group.branch ?? "?"})...\n`)
	if (dryRun) {
		write(`  dry-run: would run a headless QA session (mode ${qaMode}, model ${qaModel ?? "(default)"}) against ${wtPath}\n`)
		return { group, skipped: false, message: "dry-run: QA not run" }
	}
	// See hasRealWorktreeChanges's doc comment: same automatic-fail gate as
	// runReviewStep, checked directly against git before the QA LLM session
	// ever runs — a "pass" verdict is structurally impossible with zero
	// real changes.
	if (!hasRealWorktreeChanges(wtPath)) {
		const stateAfter = await patchGroup(statePath, group.name, {
			qa: {
				status: "failed",
				verdict: "fail",
				evidence:
					"No real changes found in the worktree (empty diff vs the tracked upstream, no uncommitted changes outside harness bookkeeping files) — there is nothing for QA to verify. Automatic fail: a \"pass\" verdict is structurally impossible with zero changes.",
				updated: new Date().toISOString(),
			},
			last_activity: { note: "QA skipped: worktree has no real changes (automatic fail)" },
		})
		const updated = stateAfter.groups.find((g) => g.name === group.name) ?? group
		write(
			`AUTOMATIC FAIL: ${group.name}'s worktree has no real changes — skipping the QA session (a "pass" verdict is structurally impossible with an empty diff)\n`,
		)
		return { group: updated, skipped: false, message: "no real changes → automatic fail (QA session never ran)" }
	}
	const qaResult = await runQaWithRetries({ workspaceRoot: wtPath, mode: qaMode, model: qaModel })
	if (qaResult.verdict === "error") {
		const stateAfter = await patchGroup(statePath, group.name, handleQaSessionError(qaResult))
		const updated = stateAfter.groups.find((g) => g.name === group.name) ?? group
		write(`NEEDS-HUMAN: ${group.name}'s QA session failed repeatedly — ${qaResult.summary}\n`)
		return { group: updated, skipped: false, message: "QA session error → needs-human" }
	}
	const qaStatus = qaResult.verdict === "pass" ? "done" : "failed"
	const stateAfter = await patchGroup(statePath, group.name, {
		qa: {
			status: qaStatus,
			verdict: qaResult.verdict,
			evidence: qaResult.evidence.slice(0, 4000),
			updated: new Date().toISOString(),
		},
		last_activity: { note: `QA: verdict=${qaResult.verdict}` },
	})
	const updated = stateAfter.groups.find((g) => g.name === group.name) ?? group
	write(`QA verdict: ${qaResult.verdict} (status ${qaStatus})\n`)
	return { group: updated, skipped: false, message: `QA: ${qaResult.verdict}` }
}

export interface RecordCostOptions {
	repo: string
	statePath: string
	group: OrchestratorGroup
	reviewEnabled: boolean
	qaEnabled: boolean
	write: (text: string) => void
}

/** Mirror of watchGroups' isSettled for a single group. */
function isSettledForRecording(group: OrchestratorGroup, reviewEnabled: boolean, qaEnabled: boolean): boolean {
	if (group.status !== "done") {
		return isTerminalStatus(group.status)
	}
	const reviewSettled = !reviewEnabled || group.review_verdict !== undefined
	const qaSettled = !qaEnabled || group.qa !== undefined
	return reviewSettled && qaSettled
}

/**
 * Mirror of watchGroups' recordCostIfSettled for a SINGLE group: fire the
 * one-shot cost/token recording exactly once per group, the first time it's
 * observed settled, recomputing usage FRESH from the worktree (so review/QA
 * sessions' cost is included). Non-fatal on failure — warn, never abort.
 */
export async function recordSettledCost(opts: RecordCostOptions): Promise<void> {
	const { repo, statePath, group, reviewEnabled, qaEnabled, write } = opts
	if (group.cost_recorded !== undefined || !isSettledForRecording(group, reviewEnabled, qaEnabled)) {
		return
	}
	const wtPath = groupWorktreePath(repo, group)
	const freshUsage = readWorktreeUsage(wtPath)
	try {
		await recordGroupCost(repo, { ...group, usage: freshUsage })
	} catch (err) {
		write(`cost recording for ${group.name} failed: ${err instanceof Error ? err.message : String(err)}\n`)
	}
	try {
		await recordAllSessionCosts(repo, group)
	} catch (err) {
		write(`per-session cost recording for ${group.name} failed: ${err instanceof Error ? err.message : String(err)}\n`)
	}
	await patchGroup(statePath, group.name, { cost_recorded: new Date().toISOString() })
}

// ─── Per-group resume pipeline ───────────────────────────────────────────────

export type ResumeOutcome = "settled" | "in-flight" | "needs-human" | "failed" | "orphaned" | "error"

export interface ResumeGroupOptions {
	repo: string
	statePath: string
	group: OrchestratorGroup
	reviewMode: string
	qaMode: string
	reviewEnabled: boolean
	qaEnabled: boolean
	mode: string
	/** Resolved worker model for rework/continuation spawns. */
	workerModel?: string
	/** Resolved reviewer model. */
	reviewerModel?: string
	/** Resolved QA model. */
	qaModel?: string
	maxReworkCycles: number
	maxContinuations: number
	maxIterations?: number
	memoryDir?: string
	forceReview: boolean
	dryRun: boolean
	write: (text: string) => void
}

export interface ResumeGroupResult {
	outcome: ResumeOutcome
	group: OrchestratorGroup
	message: string
}

/**
 * Terminal needs-human outcome with the group's cost recorded (parity with
 * watchGroups). Dry-run never persists — the cost step is reported, not run.
 */
async function needsHumanOutcome(
	opts: ResumeGroupOptions,
	group: OrchestratorGroup,
	message: string,
): Promise<ResumeGroupResult> {
	if (!opts.dryRun) {
		await recordSettledCost({
			repo: opts.repo,
			statePath: opts.statePath,
			group,
			reviewEnabled: opts.reviewEnabled,
			qaEnabled: opts.qaEnabled,
			write: opts.write,
		})
	}
	return { outcome: "needs-human", group, message }
}

/**
 * One full pipeline pass for a single group (issue #14 comment requirement):
 * rebuild → review → rework-if-needed / continuation → QA → cost recording.
 *
 * The rebuild step is the FIRST thing that happens — a stuck/interrupted
 * round always means the state file and disk reality have diverged, so the
 * group's status is re-derived from real markers before any decision is made
 * (rebuildPatchFromMarkers, the issue's first-class path — not something
 * rebuilt ad hoc each time). A worktree that was cleaned up is re-checked out
 * from its recorded branch first (a missing worktree has no markers to
 * rebuild from).
 *
 * A finding verdict left over from an interrupted round (the review ran, the
 * rework spawn never did — issue #14's exact recovery scenario) is reworked
 * from its recorded findings without burning a fresh review session.
 *
 * After a rework/continuation worker is spawned the group is left in-flight
 * (status running) and this returns "in-flight": the operator re-runs resume
 * once the worker finishes to continue the chain.
 */
export async function resumeGroup(opts: ResumeGroupOptions): Promise<ResumeGroupResult> {
	const { repo, statePath, reviewEnabled, qaEnabled, dryRun, write } = opts
	let group = opts.group
	const wtPath = groupWorktreePath(repo, group)

	// Cost recording is part of the pipeline but never runs in dry-run —
	// nothing in this function may persist when dryRun is set.
	const recordCost = async (g: OrchestratorGroup): Promise<void> => {
		if (dryRun) {
			return
		}
		await recordSettledCost({ repo, statePath, group: g, reviewEnabled, qaEnabled, write })
	}

	// 1. Worktree missing → re-checkout the branch (issue #14: "or re-checkout
	//    the branch into a fresh worktree if the original was cleaned up").
	//    This must precede the marker rebuild: a missing worktree has NO
	//    markers to rebuild from, and a fresh re-checkout deliberately has no
	//    .harness.done either (it would trip the stall guard) — the branch's
	//    committed state IS the ground truth, so the group is marked done.
	let recheckedOut = false
	if (!fs.existsSync(wtPath)) {
		if (group.branch) {
			if (dryRun) {
				write(
					`[resume] ${group.name}: worktree missing — dry-run: would re-checkout branch ${group.branch} into ${wtPath}\n`,
				)
				recheckedOut = true
				if (group.status !== "done") {
					group = { ...group, status: "done" }
				}
			} else {
				write(`[resume] ${group.name}: worktree missing — re-checking out branch ${group.branch}...\n`)
				const result = recheckoutWorktree(repo, group)
				if (!result.ok) {
					const patch = {
						status: "orphaned",
						last_activity: { note: `orphaned: worktree gone and branch re-checkout failed — ${result.error}` },
					}
					await patchGroup(statePath, group.name, patch)
					write(`[resume] ${group.name}: cannot re-checkout worktree (${result.error}) — orphaned\n`)
					return { outcome: "orphaned", group, message: `cannot re-checkout ${group.name}'s branch: ${result.error}` }
				}
				write(`[resume] ${group.name}: re-checked out ${wtPath}\n`)
				recheckedOut = true
			}
			if (group.status !== "done") {
				const patch: Partial<Omit<OrchestratorGroup, "name">> = {
					status: "done",
					last_activity: { note: `worktree re-created for resume (branch ${group.branch}) — marked done for review` },
				}
				if (!dryRun) {
					const stateAfter = await patchGroup(statePath, group.name, patch)
					group = stateAfter.groups.find((g) => g.name === group.name) ?? group
				} else {
					group = { ...group, ...patch }
				}
			}
		} else {
			return { outcome: "orphaned", group, message: `${group.name} has no worktree and no recorded branch` }
		}
	}

	// 2. Rebuild: re-derive the group's state from REAL on-disk markers (issue
	//    #14 comment — the first-class path, never rebuilt ad hoc). Skipped for
	//    a group just re-checked out above (its markers legitimately don't
	//    exist yet).
	if (!recheckedOut) {
		const rebuildPatch = rebuildPatchFromMarkers(repo, group)
		if (rebuildPatch) {
			write(`[resume] ${group.name}: state said "${group.status}" — rebuilding from disk markers...\n`)
			if (!dryRun) {
				const stateAfter = await patchGroup(statePath, group.name, rebuildPatch)
				group = stateAfter.groups.find((g) => g.name === group.name) ?? group
			} else {
				group = { ...group, ...rebuildPatch }
			}
			const note =
				typeof rebuildPatch.last_activity === "object" &&
				rebuildPatch.last_activity !== null &&
				"note" in rebuildPatch.last_activity
					? (rebuildPatch.last_activity.note as string)
					: `rebuild: ${rebuildPatch.status ?? "no change"}`
			write(`[resume] ${group.name}: ${note}\n`)
		}
	}

	// 3. In-flight: a live worker owns the group — nothing for us to do.
	if (group.status === "running" || group.status === "spawned" || group.status === "blocked") {
		return {
			outcome: "in-flight",
			group,
			message: `${group.name} is ${group.status} — worker in flight; re-run resume when it finishes`,
		}
	}

	// 4. Failed: continuation on iteration-exhaustion (same automatic path as
	//    the watch loop — handleIterationExhaustion).
	if (group.status === "failed") {
		if (isIterationExhaustion(group.summary)) {
			const decision = handleIterationExhaustion(
				group,
				repo,
				opts.maxContinuations,
				opts.mode,
				opts.workerModel,
				opts.maxIterations,
			)
			if (decision.shouldSpawn && decision.taskFilePath && decision.taskContent && decision.spawnCommand) {
				write(`[resume] ${group.name}: worker hit the iteration cap — continuation ${decision.newContinuationCount}...\n`)
				if (dryRun) {
					write(`  dry-run: would write ${path.relative(repo, decision.taskFilePath)} and run:\n    ${decision.spawnCommand}\n`)
					return { outcome: "in-flight", group, message: `dry-run: continuation ${decision.newContinuationCount} ready for ${group.name}` }
				}
				fs.mkdirSync(path.dirname(decision.taskFilePath), { recursive: true })
				fs.writeFileSync(decision.taskFilePath, decision.taskContent, "utf-8")
				const spawnResult = spawnSync("bash", ["-c", decision.spawnCommand], {
					cwd: repo,
					env: {
						...process.env,
						HEADLESSCODE_ROOT: HARNESS_ROOT,
						...(opts.memoryDir ? { HEADLESSCODE_MEMORY_DIR: path.resolve(opts.memoryDir) } : {}),
					},
					stdio: "inherit",
				})
				if (spawnResult.status !== 0) {
					await patchGroup(statePath, group.name, {
						status: "needs-human",
						continuationCount: decision.newContinuationCount,
						last_activity: { note: `continuation spawn failed after ${decision.newContinuationCount} attempt(s); needs human` },
					})
					return needsHumanOutcome(
						opts,
						reloadedGroup(statePath, group.name, group),
						`continuation spawn failed (exit ${spawnResult.status}) — marked needs-human`,
					)
				}
				const stateAfter = await patchGroup(statePath, group.name, decision.patch)
				const updated = stateAfter.groups.find((g) => g.name === group.name) ?? group
				return { outcome: "in-flight", group: updated, message: `continuation ${decision.newContinuationCount} spawned on ${group.name}` }
			}
			if (decision.patch.status === "needs-human") {
				if (!dryRun) {
					await patchGroup(statePath, group.name, decision.patch)
				}
				return needsHumanOutcome(
					opts,
					dryRun ? group : reloadedGroup(statePath, group.name, group),
					`${group.name} exhausted its continuation budget (cap ${opts.maxContinuations}) — needs human`,
				)
			}
		}
		await recordCost(group)
		return { outcome: "failed", group, message: `${group.name} failed (exit ${group.exit_code ?? "?"}) and is not continuable` }
	}

	// 5. Done: review → rework-if-needed → QA → cost.
	if (group.status === "done") {
		let current = group
		// Issue #52: a real QA "fail" (verdict "fail", distinct from a
		// session "error") is actionable NEW WORK, exactly like a review
		// finding — re-spawn a worker on the same worktree to fix the QA
		// evidence, up to the rework cap. Cost is NOT recorded here: the
		// rework reset clears the one-shot gate and the cycle's real total
		// is recorded when it settles.
		const reworkQaFail = async (g: OrchestratorGroup): Promise<ResumeGroupResult> => {
			const rework = await runReworkStep({
				repo,
				statePath,
				group: g,
				mode: opts.mode,
				model: opts.workerModel,
				maxReworkCycles: opts.maxReworkCycles,
				maxIterations: opts.maxIterations,
				memoryDir: opts.memoryDir,
				dryRun,
				write,
			})
			if (rework.outcome === "spawned" || rework.outcome === "dry-run") {
				return { outcome: "in-flight", group: rework.group, message: rework.message }
			}
			return needsHumanOutcome(opts, rework.group, rework.message)
		}
		// An ALREADY-recorded QA fail (status done + qa.verdict fail): the
		// rework never spawned — interrupted round, or state written by the
		// pre-#52 code that silently settled as done. Recover from the
		// recorded qa.evidence without burning a fresh QA session (same
		// shape as the review-finding recovery below). forceReview opts the
		// operator into a fresh review instead.
		if (qaEnabled && current.qa?.verdict === "fail" && !opts.forceReview) {
			return reworkQaFail(current)
		}
		if (reviewEnabled) {
			// A leftover review-session-error verdict (status done is an
			// inconsistent-state edge case — handleReviewSessionError normally
			// sets needs-human) must never be reported as settled.
			if (current.review_verdict === "error" && !opts.forceReview) {
				return needsHumanOutcome(
					opts,
					current,
					`${current.name} has a review-session-error verdict — a human should investigate`,
				)
			}
			if (current.review_verdict === "finding" && !opts.forceReview) {
				// Interrupted between a finding review and its rework spawn
				// (issue #14's exact recovery scenario): rework the RECORDED
				// findings without burning a fresh review session.
				const rework = await runReworkStep({
					repo,
					statePath,
					group: current,
					mode: opts.mode,
					model: opts.workerModel,
					maxReworkCycles: opts.maxReworkCycles,
					maxIterations: opts.maxIterations,
					memoryDir: opts.memoryDir,
					findings: current.pending_review_findings ?? [],
					dryRun,
					write,
				})
				if (rework.outcome === "spawned" || rework.outcome === "dry-run") {
					return { outcome: "in-flight", group: rework.group, message: rework.message }
				}
				return needsHumanOutcome(opts, rework.group, rework.message)
			}
			const review = await runReviewStep({
				repo,
				statePath,
				group: current,
				reviewMode: opts.reviewMode,
				reviewerModel: opts.reviewerModel,
				forceReview: opts.forceReview,
				dryRun,
				write,
			})
			current = review.group
			if (review.result?.verdict === "error") {
				return needsHumanOutcome(opts, current, review.message)
			}
			if (review.result?.verdict === "finding") {
				const rework = await runReworkStep({
					repo,
					statePath,
					group: current,
					mode: opts.mode,
					model: opts.workerModel,
					maxReworkCycles: opts.maxReworkCycles,
					maxIterations: opts.maxIterations,
					memoryDir: opts.memoryDir,
					findings: review.result.findings,
					dryRun,
					write,
				})
				if (rework.outcome === "spawned" || rework.outcome === "dry-run") {
					return { outcome: "in-flight", group: rework.group, message: rework.message }
				}
				return needsHumanOutcome(opts, rework.group, rework.message)
			}
		}
		if (qaEnabled && current.qa === undefined && (!reviewEnabled || current.review_verdict === "clean")) {
			const qaStep = await runQaStep({
				repo,
				statePath,
				group: current,
				qaMode: opts.qaMode,
				qaModel: opts.qaModel,
				dryRun,
				write,
			})
			current = qaStep.group
			if (current.qa?.verdict === "error") {
				return needsHumanOutcome(opts, current, qaStep.message)
			}
			if (current.qa?.verdict === "fail") {
				// A just-returned QA fail is reworked, not settled as a
				// "failed" group with the top-level status still "done"
				// (issue #52's silent-settle bug in the resume path).
				return reworkQaFail(current)
			}
		}
		await recordCost(current)
		return {
			outcome: "settled",
			group: current,
			message: `${current.name} is settled (review ${current.review_verdict ?? "n/a"})`,
		}
	}

	// 6. needs-human / orphaned / any other terminal state.
	if (group.status === "needs-human") {
		await recordCost(group)
		return { outcome: "needs-human", group, message: `${group.name} needs a human (see state for pending_review_findings)` }
	}
	return { outcome: "orphaned", group, message: `${group.name} is in an unresumable state (${group.status})` }
}

// ─── CLI mains ───────────────────────────────────────────────────────────────

export interface ResumeIo {
	stdout?: (text: string) => void
	stderr?: (text: string) => void
}

function isGitRepo(repo: string): boolean {
	try {
		execFileSync("git", ["-C", repo, "rev-parse", "--git-dir"], { stdio: "ignore", timeout: 5000 })
		return true
	} catch {
		return false
	}
}

function describeTarget(target: ResumeTarget): string {
	if (target.issue !== undefined) {
		return `issue #${target.issue}`
	}
	if (target.pr !== undefined) {
		return `PR #${target.pr}`
	}
	if (target.group !== undefined) {
		return `group "${target.group}"`
	}
	return "(none)"
}

/** Resolve the target group(s) from state; fails loudly when none match. */
function resolveGroupsOrFail(
	repo: string,
	statePath: string,
	target: ResumeTarget,
	defaultToAll: boolean,
	writeErr: (t: string) => void,
): { groups?: OrchestratorGroup[]; error?: string } {
	let state: OrchestratorState
	try {
		state = loadStateSync(statePath)
	} catch (err) {
		writeErr(
			`headlesscode orchestrate: cannot read state file ${statePath}: ${err instanceof Error ? err.message : String(err)}\n`,
		)
		return { error: "cannot read state" }
	}
	const noTarget = target.issue === undefined && target.pr === undefined && target.group === undefined
	const groups = noTarget ? (defaultToAll ? state.groups : []) : resolveTargetGroups(state, target, { repo })
	if (groups.length === 0) {
		return {
			error: noTarget
				? `no groups to resume in ${statePath}`
				: `no group in ${statePath} matches --issue/--pr/--group ${describeTarget(target)}`,
		}
	}
	return { groups }
}

/** Ensure a group's worktree exists, re-checking-out its branch when cleaned up. */
function ensureWorktreeForGroup(
	repo: string,
	group: OrchestratorGroup,
	writeOut: (t: string) => void,
	dryRun = false,
): { ok: boolean; error?: string } {
	const wtPath = groupWorktreePath(repo, group)
	if (fs.existsSync(wtPath)) {
		return { ok: true }
	}
	if (!group.branch) {
		return { ok: false, error: `${group.name} has no worktree and no recorded branch` }
	}
	if (dryRun) {
		writeOut(`[orchestrate] dry-run: would re-checkout branch ${group.branch} into ${wtPath}\n`)
		return { ok: true }
	}
	const result = recheckoutWorktree(repo, group)
	if (!result.ok) {
		return { ok: false, error: `cannot re-checkout ${group.name}'s branch: ${result.error}` }
	}
	writeOut(`[orchestrate] re-checked out branch ${group.branch} into ${wtPath}\n`)
	return { ok: true }
}

export async function reviewMain(argv: string[], io: ResumeIo = {}): Promise<number> {
	const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text))
	const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text))

	const { options, error } = parseReviewArgs(argv)
	if (error) {
		writeErr(`headlesscode orchestrate review: ${error}\n\n${REVIEW_USAGE}`)
		return 2
	}
	if (options.help) {
		writeOut(REVIEW_USAGE)
		return 0
	}
	if (!options.repo) {
		writeErr(`headlesscode orchestrate review: --repo <path> is required\n\n${REVIEW_USAGE}`)
		return 2
	}
	if (!hasExactlyOneTarget(options.target)) {
		writeErr(`headlesscode orchestrate review: provide exactly one of --issue <n>, --pr <n>, --group <name>\n\n${REVIEW_USAGE}`)
		return 2
	}
	const repo = path.resolve(options.repo)
	if (!isGitRepo(repo)) {
		writeErr(`headlesscode orchestrate review: not a git repo: ${repo}\n`)
		return 2
	}
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	const resolved = resolveGroupsOrFail(repo, statePath, options.target, false, writeErr)
	if (resolved.error || !resolved.groups) {
		writeErr(`headlesscode orchestrate review: ${resolved.error}\n`)
		return 1
	}
	if (resolved.groups.length > 1) {
		writeErr(
			`headlesscode orchestrate review: target matches ${resolved.groups.length} groups ` +
				`(${resolved.groups.map((g) => g.name).join(", ")}) — narrow it down\n`,
		)
		return 1
	}
	let current = resolved.groups[0]!

	// Worktree first: a cleaned-up group's branch is re-checked out (the
	// branch's committed state is the review target; a fresh re-checkout has
	// no markers to rebuild from, so it is treated as done below).
	const worktreeExisted = fs.existsSync(groupWorktreePath(repo, current))
	if (!worktreeExisted) {
		const ensured = ensureWorktreeForGroup(repo, current, writeOut, options.dryRun)
		if (!ensured.ok) {
			writeErr(`headlesscode orchestrate review: ${ensured.error}\n`)
			return 1
		}
		if (current.status !== "done") {
			const patch = {
				status: "done",
				last_activity: { note: `worktree re-created for standalone review (branch ${current.branch}) — marked done` },
			}
			if (options.dryRun) {
				current = { ...current, ...patch }
			} else {
				const stateAfter = await patchGroup(statePath, current.name, patch)
				current = stateAfter.groups.find((g) => g.name === current.name) ?? current
			}
		}
	} else {
		// Rebuild stale state from real markers before reviewing.
		const rebuildPatch = rebuildPatchFromMarkers(repo, current)
		if (rebuildPatch && rebuildPatch.status !== undefined) {
			if (options.dryRun) {
				current = { ...current, ...rebuildPatch }
				writeOut(`[review] ${current.name}: (dry-run) would rebuild state from markers → ${rebuildPatch.status}\n`)
			} else {
				const stateAfter = await patchGroup(statePath, current.name, rebuildPatch)
				current = stateAfter.groups.find((g) => g.name === current.name) ?? current
				writeOut(`[review] ${current.name}: rebuilt state from markers → ${current.status}\n`)
			}
		}
	}
	if (current.status !== "done") {
		writeErr(
			`headlesscode orchestrate review: ${current.name} is ${current.status} — review only runs on a "done" group. ` +
				`Use "orchestrate resume" to drive the group through the full pipeline.\n`,
		)
		return 1
	}
	const reviewerModel = resolveModelForMode({
		workspaceRoot: repo,
		mode: options.reviewMode,
		explicitModel: options.model,
		env: process.env,
	})
	const review = await runReviewStep({
		repo,
		statePath,
		group: current,
		reviewMode: options.reviewMode,
		reviewerModel,
		forceReview: options.forceReview,
		dryRun: options.dryRun,
		write: writeOut,
	})
	if (review.result?.verdict === "error") {
		writeErr(`headlesscode orchestrate review: ${review.message}\n`)
		return 1
	}
	// A finding verdict — whether just produced or already recorded from an
	// interrupted round — means the group is NOT clean; exit 1 either way.
	if (review.result?.verdict === "finding" || review.group.review_verdict === "finding") {
		const findingsCount =
			review.result?.findings.length ?? review.group.pending_review_findings?.length ?? 0
		writeErr(
			`headlesscode orchestrate review: ${findingsCount} finding(s) — ` +
				`run "headlesscode orchestrate rework" (or resume) to fix them, or fix manually\n`,
		)
		return 1
	}
	// A settled group's review cost is now final — record it (review sessions
	// write their own usage files that a fresh rollup picks up). Dry-run
	// never persists.
	if (!options.dryRun) {
		await recordSettledCost({ repo, statePath, group: review.group, reviewEnabled: true, qaEnabled: false, write: writeOut })
	}
	writeOut(`[review] ${review.group.name}: ${review.message}\n`)
	return 0
}

export async function reworkMain(argv: string[], io: ResumeIo = {}): Promise<number> {
	const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text))
	const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text))

	const { options, error } = parseReworkArgs(argv)
	if (error) {
		writeErr(`headlesscode orchestrate rework: ${error}\n\n${REWORK_USAGE}`)
		return 2
	}
	if (options.help) {
		writeOut(REWORK_USAGE)
		return 0
	}
	if (!options.repo) {
		writeErr(`headlesscode orchestrate rework: --repo <path> is required\n\n${REWORK_USAGE}`)
		return 2
	}
	if (!hasExactlyOneTarget(options.target)) {
		writeErr(`headlesscode orchestrate rework: provide exactly one of --issue <n>, --pr <n>, --group <name>\n\n${REWORK_USAGE}`)
		return 2
	}
	const repo = path.resolve(options.repo)
	if (!isGitRepo(repo)) {
		writeErr(`headlesscode orchestrate rework: not a git repo: ${repo}\n`)
		return 2
	}
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	const resolved = resolveGroupsOrFail(repo, statePath, options.target, false, writeErr)
	if (resolved.error || !resolved.groups) {
		writeErr(`headlesscode orchestrate rework: ${resolved.error}\n`)
		return 1
	}
	if (resolved.groups.length > 1) {
		writeErr(
			`headlesscode orchestrate rework: target matches ${resolved.groups.length} groups ` +
				`(${resolved.groups.map((g) => g.name).join(", ")}) — narrow it down\n`,
		)
		return 1
	}
	const group = resolved.groups[0]!

	const ensured = ensureWorktreeForGroup(repo, group, writeOut, options.dryRun)
	if (!ensured.ok) {
		writeErr(`headlesscode orchestrate rework: ${ensured.error}\n`)
		return 1
	}

	// Findings: state's pending_review_findings first, then the issue's
	// comments (issue #14). Empty findings fall back to the rework template's
	// no-findings text (the worker re-audits the previous diff itself).
	let findings = group.pending_review_findings ?? []
	let findingsSource = "state (pending_review_findings)"
	if (findings.length === 0 && options.target.issue !== undefined) {
		findings = fetchFindingsFromIssueComments(repo, options.target.issue)
		findingsSource = findings.length > 0 ? "issue comments" : "issue comments (none found)"
	}
	if (findings.length === 0) {
		writeOut(
			`[rework] no recorded findings (${findingsSource}) — using the rework template's ` +
				`no-findings fallback; the worker will re-audit the previous diff\n`,
		)
	}
	const workerModel = resolveModelForMode({
		workspaceRoot: repo,
		mode: options.mode,
		explicitModel: options.model,
		env: process.env,
	})
	const step = await runReworkStep({
		repo,
		statePath,
		group,
		mode: options.mode,
		model: workerModel,
		maxReworkCycles: options.maxReworkCycles,
		maxIterations: options.maxIterations,
		memoryDir: options.memoryDir,
		findings,
		dryRun: options.dryRun,
		write: writeOut,
	})
	if (step.outcome === "cap") {
		writeErr(`headlesscode orchestrate rework: ${step.message}\n`)
		return 1
	}
	writeOut(`[rework] ${step.message}\n`)
	return 0
}

export async function resumeMain(argv: string[], io: ResumeIo = {}): Promise<number> {
	const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text))
	const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text))

	const { options, error } = parseResumeArgs(argv)
	if (error) {
		writeErr(`headlesscode orchestrate resume: ${error}\n\n${RESUME_USAGE}`)
		return 2
	}
	if (options.help) {
		writeOut(RESUME_USAGE)
		return 0
	}
	if (!options.repo) {
		writeErr(`headlesscode orchestrate resume: --repo <path> is required\n\n${RESUME_USAGE}`)
		return 2
	}
	const repo = path.resolve(options.repo)
	if (!isGitRepo(repo)) {
		writeErr(`headlesscode orchestrate resume: not a git repo: ${repo}\n`)
		return 2
	}
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	const resolved = resolveGroupsOrFail(repo, statePath, options.target, true, writeErr)
	if (resolved.error || !resolved.groups) {
		writeErr(`headlesscode orchestrate resume: ${resolved.error}\n`)
		return 1
	}

	const reviewerModel = resolveModelForMode({
		workspaceRoot: repo,
		mode: options.reviewMode,
		explicitModel: options.model,
		env: process.env,
	})
	const qaModel = resolveModelForMode({
		workspaceRoot: repo,
		mode: options.qaMode,
		explicitModel: options.model,
		env: process.env,
	})
	const workerModel = resolveModelForMode({
		workspaceRoot: repo,
		mode: options.mode,
		explicitModel: options.model,
		env: process.env,
	})

	let bad = 0
	for (const group of resolved.groups) {
		const result = await resumeGroup({
			repo,
			statePath,
			group,
			reviewMode: options.reviewMode,
			qaMode: options.qaMode,
			reviewEnabled: !options.noReview,
			qaEnabled: options.qa,
			mode: options.mode,
			workerModel,
			reviewerModel,
			qaModel,
			maxReworkCycles: options.maxReworkCycles,
			maxContinuations: options.maxContinuations,
			maxIterations: options.maxIterations,
			memoryDir: options.memoryDir,
			forceReview: options.forceReview,
			dryRun: options.dryRun,
			write: writeOut,
		})
		writeOut(`[resume] ${result.message}\n`)
		if (
			result.outcome === "needs-human" ||
			result.outcome === "failed" ||
			result.outcome === "orphaned" ||
			result.outcome === "error"
		) {
			bad++
		}
	}
	if (bad > 0) {
		writeErr(
			`headlesscode orchestrate resume: ${bad} group(s) need a human or failed — see ${statePath} ` +
				`for review_verdict/pending_review_findings\n`,
		)
		return 1
	}
	return 0
}

/** Read a positive integer flag value via the argv cursor (shared by the parsers). */
function parseIntFlag(argv: string[], i: number, flag: string): { value: number | undefined; error?: string; consumed: number } {
	const eq = argv[i].indexOf("=")
	const inlineValue = eq === -1 ? undefined : argv[i].slice(eq + 1)
	const v = inlineValue ?? argv[i + 1]
	if (v === undefined || (inlineValue === undefined && v.startsWith("--"))) {
		return { value: undefined, error: `Missing value for ${flag}`, consumed: 0 }
	}
	const n = Number(v)
	const consumed = inlineValue === undefined ? 1 : 0
	if (!Number.isInteger(n) || n <= 0) {
		return { value: undefined, error: `${flag} requires a positive integer`, consumed }
	}
	return { value: n, consumed }
}
