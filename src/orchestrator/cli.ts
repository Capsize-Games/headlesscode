/**
 * `headlesscode orchestrate` subcommand — the thin orchestrator entry point.
 *
 *   npx tsx src/cli.ts orchestrate --repo <path> --issue 27 --issue 29 \
 *       [--mode code] [--issues-json <path>] [--dry-run] [--no-review]
 *
 * Flow:
 *   1. Read issues (`gh issue view --json number,title,body` when gh is
 *      available, else `--issues-json <file>`).
 *   2. Split them into worktree groups with splitIssues (the
 *      multi-agent-orchestrator heuristics).
 *   3. Generate task files under <repo>/plans/parallel-tasks/.
 *   4. Spawn via scripts/spawn-parallel-worktrees.sh (the bash script remains
 *      the ACTUAL spawner — the CLI only assembles the spec triples).
 *   5. Watch for completion (.harness.done markers) and run the headless
 *      reviewer on each group that finished cleanly.
 *
 * `--dry-run` prints the split plan + the exact spawn command without
 * spawning anything (no API key needed).
 */

import { execFileSync, spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { activeSessionCountForRepo, maxConcurrentSessionsFromEnv } from "../budget/concurrency.js"
import { issueShape, issueSizeWarnings, splitIssues, type IssueSizeWarning, type SplitIssue, type WorktreeSpec } from "./split.js"
import { readCostHistory } from "./cost-history.js"
import { buildEstimateSection, estimateGroups } from "./cost-estimate.js"
import {
	loadState,
	loadStateSync,
	mutateState,
	patchGroup,
	saveStateSync,
	updateGroup,
	type OrchestratorGroup,
	type OrchestratorState,
} from "./state.js"
import { runReviewWithRetries, type ReviewResult } from "./reviewer.js"
import { runFilingStage, runResearchStage } from "./pipeline.js"
import { analyzeWorktreeSessions } from "./log-analysis.js"
import { runQaWithRetries, type QaResult } from "../qa/qa.js"
import { groupWorktreePath, isIterationExhaustion, isPidAlive, isProviderFailure, watchGroups } from "./watch.js"
import { clearHandoffSummary, readHandoffSummary } from "../engine/handoff.js"
import { autoSplitOversizedIssues, proposeSemanticSplit } from "./auto-split.js"
import { DEFAULT_MODEL, OpenRouterClient } from "../llm/openrouter.js"
import {
	buildStatusSummary,
	formatStatusText,
	isTerminalStatus,
	reconcileGroups,
	verdictLine,
	waitForTerminalState,
	DEFAULT_STATUS_POLL_INTERVAL_MS,
	DEFAULT_STATUS_TIMEOUT_MS,
	type StatusSummary,
} from "./status.js"
import { assessGroupCleanupSync, cleanupMain, resolveBaseBranch, type CleanupStatus } from "./cleanup.js"
import {
	branchSyncStatus,
	ORCHESTRATE_SYNC_DISABLED_ENV,
	syncBranchWithOrigin,
	syncSummaryLines,
	syncWarningLines,
	TRIVIAL_DRIFT_AHEAD,
} from "./git-sync.js"
import { resolveModelForMode } from "../config/mode-models.js"
import { runPreflight, runLocalPreflight, type PreflightResult, type LocalPreflightResult } from "../llm/preflight.js"
import { resolvePerModeEnv } from "../cli.js"

const ORCHESTRATE_USAGE = `headlesscode orchestrate — Phase 2 parallel round

Usage:
  headlesscode orchestrate --repo <path> --issue <n> [--issue <n> ...] [options]
  headlesscode orchestrate --repo <path> --issues-json <file> [options]

Options:
  --repo <path>          Target repo root (required)
  --issue <n>            Issue number to include (repeatable)
  --issues-json <file>   Read issues from a JSON array of {number,title,body}
  --file-issues          With --issues-json: file a REAL GitHub issue for each
                         synthetic entry (gh issue create --repo <origin-owner>/<origin-repo>),
                         swap in the real number returned, and print one
                         confirmation line per created issue. A real, visible
                         write to GitHub — opt-in, never automatic.
                         Requires --issues-json (nothing to file otherwise)
  --mode <slug>          Harness mode for workers (default: code)
  --model <id>           Explicit model override for workers + reviewer + QA
                         (beats .headlesscode/mode-models.json entries). Without
                         it, each role resolves its OWN model from the file:
                         worker mode / --review-mode / --qa-mode
                         (default: $OPENROUTER_MODEL or the client default)
  --batch <name>         Batch id recorded in the state file (default: round-<date>)
  --review-mode <slug>   Mode slug used for review sessions (default: deepseek-reviewer)
  --no-review            Spawn + watch only; do not run the reviewer
  --qa                   Run a headless QA session (--mode qa-agent) on each group
                         after its review passes; record qa {status,verdict,evidence}
  --qa-mode <slug>       Mode slug for QA sessions (default: qa-agent; the target
                         repo's .roomodes + .roo/rules-<slug>/ are spliced automatically)
  --deploy               After all groups done + reviewed + QA passed, run the
                         human-approval deploy gate (scripts/deploy-gate.sh) which
                         refuses to run the repo's deploy-production.sh without
                         explicit human approval (interactive on a TTY, token/file
                         otherwise). Never auto-approves.
  --deploy-args <str>    Deploy args forwarded to the deploy script after the gate
                         approves (space-separated flags; also DEPLOY_ARGS env)
  --poll-interval-ms <n> Watcher poll interval (default: 5000)
  --memory-dir <path>    Phase 3 memory dir for workers (passed as HEADLESSCODE_MEMORY_DIR,
                         which run-worker.sh forwards as --memory-dir to each worker CLI)
  --max-concurrent-sessions <n>  Phase 6 GLOBAL cap on concurrent sessions across
                         processes (default: $HEADLESSCODE_MAX_CONCURRENT_SESSIONS or 3).
                         When the cap is already reached this run ABORTS with a clear
                         message and exit 1 (never queues silently)
  --max-rework-cycles <n>  Max automatic rework attempts per group when the review
                 finds issues (default: 3). Each rework re-runs a worker on the
                 SAME worktree to fix the findings. After the cap, the group is
                 marked "needs-human" and left for manual resolution
  --max-iterations <n>   Per-session loop iteration cap for EVERY worker in this
                 round (default: $HEADLESSCODE_MAX_ITERATIONS or the harness's
                 own default, 50). A worker that hits the cap is auto-continued
                 on the SAME worktree (see --max-continuations) instead of
                 hard-failing the group
  --max-continuations <n>  Max automatic continuations per group after a worker
                 hits the iteration cap (default: 3). Each continuation
                 re-spawns a worker on the SAME worktree with a fresh session.
                 After the cap, the group is marked "needs-human" and left for
                 manual resolution
  --plan-first          Issue #49 experiment: run a SHORT architect-mode
                 planning session per worktree BEFORE the code worker, and
                 append its plan (PLAN.md) into the worker's task file so the
                 code worker executes against it instead of re-discovering
                 context (grep/read cycles) from iteration 1. OPT-IN — never
                 the default without evidence it helps. The plan session runs
                 synchronously inside the spawner, so N plan-first worktrees
                 extend the spawn call by ~N × plan-session time
  --plan-first-mode <slug>  Mode slug for the plan-first session (default:
                 architect; any mode the worker CLI accepts — built-in or
                 .roomodes)
  --plan-first-max-iterations <n>  Iteration cap for the plan-first session
                 (default: 15, or $HEADLESSCODE_PLAN_FIRST_MAX_ITERATIONS) —
                 deliberately short: the plan session must produce a plan,
                 not implement it
  --no-preflight        Skip the pre-spawn preflight probe (issue #13): a cheap
                 1-token completion using the EXACT model + provider pin a real
                 worker uses, run BEFORE anything is spawned, that distinguishes
                 key-invalid / account-balance-exhausted / pinned-provider-down
                 / all-clear. ON by default; skip for CI/non-interactive
                 contexts that don't want the extra round-trip
  --no-issue-size-check Skip the pre-flight issue-size warning (issue #53): a
                 FREE deterministic scan of each issue body that warns loudly
                 when it reads like 3+ independent pieces of work (top-level
                 numbered/bulleted sections), before anything is spawned — the
                 shape that burned iteration caps + budget on real rounds
                 . ON by default; the
                 warning never aborts the round, so this only silences it
  --no-auto-split        Skip auto-split: when an issue is flagged by the size
                         check above, an LLM proposes the smallest number of
                         independently-shippable sub-issues (grouped by
                         deliverable, NOT one per bullet — sequential steps of
                         one fix stay together), files them as real GitHub
                         issues, and closes the oversized parent with a link
                         to each. Fails open (LLM/filing error, or the model
                         deciding the issue is genuinely one coherent piece of
                         work) by dispatching the original issue unchanged.
                         ON by default when a GitHub origin remote is present
                         and issueSizeCheck is on; this flag falls back to
                         warn-only
  --dry-run              Print the split plan, a cost estimate (from recorded
                         cost-history, keyed by issue shape — issue #16), and
                         the spawn commands; spawn nothing
  --help                 Show this help and exit

Environment:
  HEADLESSCODE_OPENROUTER_API_KEY     Required for a real run (workers + reviewer + QA)
  ORCHESTRATOR_MODE      Overrides --mode when set
  HEADLESSCODE_CLI       Overrides the spawner's CLI command
  HEADLESSCODE_MEMORY_DIR  Memory dir inherited by workers (unless --memory-dir overrides)
  DEPLOY_APPROVAL_TOKEN  Deploy gate token (non-interactive approval; must match the
                         token in <repo>/.deploy-approval)
  DEPLOY_APPROVAL_FILE   Path to a one-time approval file created by a human
                         (default: <repo>/.worktrees/.deploy-approved-<batch>)
  DEPLOY_ARGS            Deploy args forwarded to the deploy script (see --deploy-args)
  HEADLESSCODE_MAX_CONCURRENT_SESSIONS  Global concurrency cap (default 3)
  HEADLESSCODE_MAX_COST_USD / HEADLESSCODE_MAX_DURATION_MS
                         Per-session budget env fallbacks forwarded to workers
                         (run-worker.sh / run-qa.sh pass them as CLI flags)
  HEADLESSCODE_MAX_ITERATIONS
                         Per-session iteration cap env fallback forwarded to
                         workers as --max-iterations (run-worker.sh)
`

interface OrchestrateOptions {
	repo: string
	issues: number[]
	issuesJson?: string
	/**
	 * Fix 3: file a REAL GitHub issue for every synthetic --issues-json entry
	 * and substitute the real number before anything else touches `issues`.
	 * Opt-in — a real write to a real GitHub repo. Requires --issues-json.
	 */
	fileIssues: boolean
	mode: string
	model?: string
	batch?: string
	reviewMode: string
	review: boolean
	/** Phase 4: run a headless QA session per group after review passes. */
	qa: boolean
	/** Phase 4: mode slug for QA sessions (default qa-agent). */
	qaMode: string
	/** Phase 4: run the human-approval deploy gate after everything passes. */
	deploy: boolean
	/** Phase 4: deploy args forwarded to the deploy script after approval. */
	deployArgs?: string
	pollIntervalMs: number
	memoryDir?: string
	/** Phase 6: global concurrent-session cap (default env or 3). */
	maxConcurrentSessions: number
	/** Rework loop: max review-rework attempts per group before giving up (default 3). */
	maxReworkCycles: number
	/**
	 * Per-session iteration cap forwarded to every worker (default:
	 * $HEADLESSCODE_MAX_ITERATIONS; undefined = leave the harness's own
	 * default, 50, untouched).
	 */
	maxIterations?: number
	/** Auto-continue: max re-spawns per group after a worker hits the iteration cap (default 3). */
	maxContinuations: number
	/**
	 * Issue #49 experiment: run a short architect-mode planning session per
	 * worktree BEFORE the code worker, and append its plan (PLAN.md) into the
	 * worker's task file so the code worker executes against it instead of
	 * re-discovering context from iteration 1. OPT-IN — never the default.
	 */
	planFirst: boolean
	/** Mode slug for the plan-first session (default: architect). */
	planFirstMode: string
	/** Iteration cap for the plan-first session (default: 15 — deliberately short). */
	planFirstMaxIterations: number
	/**
	 * Issue #13 pre-spawn preflight probe (1-token, exact model + provider
	 * pin). ON by default; --no-preflight skips it for CI/non-interactive.
	 */
	preflight: boolean
	/**
	 * Issue #53 pre-flight issue-size check: a FREE deterministic scan that
	 * warns loudly (never aborts) when an issue body reads like 3+ independent
	 * pieces of work, before anything is spawned. ON by default;
	 * --no-issue-size-check silences it.
	 */
	issueSizeCheck: boolean
	/**
	 * Auto-split (issue #53 follow-up): when the size check flags an issue,
	 * propose a SEMANTIC split (LLM-decided independent deliverables, not a
	 * mechanical one-sub-issue-per-bullet explosion — see auto-split.ts) and
	 * file the result as real GitHub issues, closing the oversized parent.
	 * ON by default when a GitHub 'origin' remote is available; --no-auto-split
	 * falls back to warn-only. Requires issueSizeCheck (nothing to act on
	 * otherwise) and a real (non---issues-json) round (there is no GitHub
	 * issue to close for a synthetic entry).
	 */
	autoSplit: boolean
	dryRun: boolean
	help: boolean
}

/**
	* Resolve the default per-session iteration cap from $HEADLESSCODE_MAX_ITERATIONS.
	* undefined (unset or invalid) means "leave the harness's own default (50)
	* untouched" — the harness default itself is never changed, this only makes the
	* round-level cap overridable.
	*/
function maxIterationsFromEnv(): number | undefined {
	const raw = process.env.HEADLESSCODE_MAX_ITERATIONS
	if (raw === undefined || raw === "") {
		return undefined
	}
	const n = Number(raw)
	return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * Resolve the plan-first session's iteration cap from
 * $HEADLESSCODE_PLAN_FIRST_MAX_ITERATIONS (default: 15 — the plan session is
 * deliberately SHORT: it must produce a plan, not implement it). Invalid
 * values fall back to the default.
 */
function planFirstMaxIterationsFromEnv(): number {
	const raw = process.env.HEADLESSCODE_PLAN_FIRST_MAX_ITERATIONS
	if (raw === undefined || raw === "") {
		return 15
	}
	const n = Number(raw)
	return Number.isInteger(n) && n > 0 ? n : 15
}

export function parseOrchestrateArgs(argv: string[]): { options: OrchestrateOptions; error?: string } {
	const options: OrchestrateOptions = {
		repo: "",
		issues: [],
		mode: process.env.ORCHESTRATOR_MODE ?? "code",
		reviewMode: "deepseek-reviewer",
		review: true,
		qa: false,
		qaMode: "qa-agent",
		deploy: false,
		fileIssues: false,
		pollIntervalMs: 5000,
		maxConcurrentSessions: maxConcurrentSessionsFromEnv(),
		maxReworkCycles: 3,
		maxContinuations: 3,
		maxIterations: maxIterationsFromEnv(),
		planFirst: false,
		planFirstMode: process.env.HEADLESSCODE_PLAN_FIRST_MODE ?? "architect",
		planFirstMaxIterations: planFirstMaxIterationsFromEnv(),
		preflight: true,
		issueSizeCheck: true,
		autoSplit: true,
		dryRun: false,
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
			case "--issue": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--issue requires a positive integer" }
				}
				options.issues.push(n)
				break
			}
			case "--issues-json": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --issues-json" }
				}
				options.issuesJson = v
				break
			}
			case "--file-issues":
				options.fileIssues = true
				break
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
			case "--batch": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --batch" }
				}
				options.batch = v
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
			case "--poll-interval-ms": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--poll-interval-ms requires a positive integer" }
				}
				options.pollIntervalMs = n
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
			case "--max-concurrent-sessions": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--max-concurrent-sessions requires a positive integer" }
				}
				options.maxConcurrentSessions = n
				break
			}
			case "--max-rework-cycles": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--max-rework-cycles requires a positive integer" }
				}
				options.maxReworkCycles = n
				break
			}
			case "--max-iterations": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--max-iterations requires a positive integer" }
				}
				options.maxIterations = n
				break
			}
			case "--max-continuations": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--max-continuations requires a positive integer" }
				}
				options.maxContinuations = n
				break
			}
			case "--plan-first":
				options.planFirst = true
				break
			case "--plan-first-mode": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --plan-first-mode" }
				}
				options.planFirstMode = v
				break
			}
			case "--plan-first-max-iterations": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--plan-first-max-iterations requires a positive integer" }
				}
				options.planFirstMaxIterations = n
				break
			}
			case "--no-review":
				options.review = false
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
			case "--deploy":
				options.deploy = true
				break
			case "--deploy-args": {
				// Deploy args legitimately start with "--" (e.g. --local), so
				// bypass next()'s "--"-rejecting value reader.
				const v = inlineValue ?? argv[i + 1]
				if (v === undefined) {
					return { options, error: "Missing value for --deploy-args" }
				}
				i++
				options.deployArgs = v
				break
			}
			case "--no-preflight":
				options.preflight = false
				break
			case "--no-issue-size-check":
				options.issueSizeCheck = false
				break
			case "--no-auto-split":
				options.autoSplit = false
				break
			case "--dry-run":
				options.dryRun = true
				break
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown orchestrate argument: ${arg}` }
		}
	}

	// Fix 3: --file-issues without --issues-json is a usage error — a real
	// --issue <n>/gh-sourced entry already carries a real number, so there is
	// nothing to file. (Match the existing usage-error exit-2 convention.)
	if (options.fileIssues && !options.issuesJson) {
		return { options, error: "--file-issues requires --issues-json (a real --issue <n> round has nothing to file)" }
	}

	return { options }
}

// ─── Issue loading ───────────────────────────────────────────────────────────

function ghAvailable(): boolean {
	try {
		execFileSync("gh", ["--version"], { stdio: "ignore", timeout: 5000 })
		return true
	} catch {
		return false
	}
}

function fetchIssueWithGh(repo: string, number: number): SplitIssue {
	const out = execFileSync("gh", ["issue", "view", String(number), "--json", "number,title,body"], {
		cwd: repo,
		encoding: "utf-8",
		timeout: 30_000,
	})
	const parsed = JSON.parse(out) as { number?: number; title?: string; body?: string | null }
	return { number: parsed.number ?? number, title: parsed.title ?? `issue ${number}`, body: parsed.body ?? undefined }
}

/**
 * Resolve `<owner>/<repo>` from the target repo's `origin` remote (used by
 * --file-issues' `gh issue create --repo <owner>/<repo>`). Accepts both ssh
 * (`git@host:owner/repo.git`) and https (`https://host/owner/repo.git`) URL
 * forms. Returns undefined when there is no origin or it is unparseable.
 */
function originOwnerRepo(repo: string): string | undefined {
	try {
		const url = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
			encoding: "utf-8",
			timeout: 10_000,
		}).trim()
		const match = url.match(/^(?:git@[^:]+:|https?:\/\/[^/]+\/)([^/]+)\/([^/]+?)(?:\.git)?$/)
		return match ? `${match[1]}/${match[2]}` : undefined
	} catch {
		return undefined
	}
}

/**
 * File one real GitHub issue via `gh issue create` — mirrors fetchIssueWithGh's
 * execFileSync idiom (same cwd/timeout). Returns the real issue number (the
 * trailing number of the issue URL gh prints — parsed rather than depending on
 * a --json flag that only exists in newer gh versions) and its URL.
 */
function createGhIssue(repo: string, ownerRepo: string, issue: SplitIssue): { number: number; url: string } {
	const out = execFileSync(
		"gh",
		["issue", "create", "--repo", ownerRepo, "--title", issue.title, "--body", issue.body ?? ""],
		{ cwd: repo, encoding: "utf-8", timeout: 30_000 },
	)
	const url = out.trim().split(/\s+/).pop() ?? out.trim()
	const numberMatch = url.match(/\/issues\/(\d+)\/?$/)
	if (!numberMatch) {
		throw new Error(`gh issue create returned an unrecognized response: ${out.trim()}`)
	}
	return { number: Number(numberMatch[1]), url }
}

/**
 * Close a real GitHub issue with a comment (auto-split's parent-issue
 * closeout) — mirrors createGhIssue's execFileSync idiom. `gh issue close
 * --comment` posts the comment atomically with the close, so there's no
 * window where the issue is closed without the sub-issue links, or vice
 * versa.
 */
function closeGhIssue(repo: string, ownerRepo: string, issueNumber: number, comment: string): void {
	execFileSync("gh", ["issue", "close", String(issueNumber), "--repo", ownerRepo, "--comment", comment], {
		cwd: repo,
		encoding: "utf-8",
		timeout: 30_000,
	})
}

/**
 * Fix 3: file a real GitHub issue for each synthetic issue and substitute the
 * real number, so every downstream step (worktree/branch naming, task files,
 * state persistence, PR-closing comments) uses a number that actually exists
 * on GitHub — no other code needs to know issues were just filed. `shouldFile`
 * gates which entries get filed: orchestrate uses the default (file all —
 * --file-issues requires --issues-json, and every --issues-json entry is
 * synthetic by definition); the predicate exists so tests can cover "entries
 * that already carry a real number pass through untouched" without a real gh
 * call. `createIssue` is injected for the same reason (real: createGhIssue).
 */
export function fileSyntheticIssues(
	issues: SplitIssue[],
	createIssue: (issue: SplitIssue) => { number: number; url: string },
	shouldFile: (issue: SplitIssue) => boolean = () => true,
): { issues: SplitIssue[]; created: Array<{ number: number; title: string; url: string }> } {
	const created: Array<{ number: number; title: string; url: string }> = []
	const next = issues.map((issue) => {
		if (!shouldFile(issue)) {
			return issue
		}
		const real = createIssue(issue)
		created.push({ number: real.number, title: issue.title, url: real.url })
		return { ...issue, number: real.number }
	})
	return { issues: next, created }
}

function loadIssues(options: OrchestrateOptions): SplitIssue[] {
	if (options.issuesJson) {
		const raw = fs.readFileSync(path.resolve(options.issuesJson), "utf-8")
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) {
			throw new Error(`--issues-json must be a JSON array of {number,title,body}`)
		}
		return parsed.map((i) => {
			const issue = i as { number?: unknown; title?: unknown; body?: unknown }
			return {
				number: Number(issue.number),
				title: String(issue.title ?? ""),
				body: typeof issue.body === "string" ? issue.body : undefined,
			}
		})
	}
	if (options.issues.length === 0) {
		throw new Error("provide at least one --issue <n> or an --issues-json file")
	}
	if (!ghAvailable()) {
		throw new Error(
			"gh CLI is not available and no --issues-json was given — install gh or pass --issues-json <file>",
		)
	}
	return [...new Set(options.issues)].sort((a, b) => a - b).map((n) => fetchIssueWithGh(options.repo, n))
}

// ─── Task-file generation ────────────────────────────────────────────────────

/**
 * Rules splicing happens automatically: addCustomInstructions() (vendored,
 * src/vendor/zoo-code/src/core/prompts/sections/custom-instructions.ts) reads
 * the central store's `rules/` + `rules-<mode>/` tiers (and the project's
 * `.roo/` equivalents) into the system prompt before the first turn. Task
 * files must NOT tell the model to go read a rules file itself — on a project
 * with no project-local `.roo/rules-code/` (e.g. a fresh `headlesscode init`
 * setup) that read fails outright and burns a consecutive-mistake budget
 * before real work starts. Shared by all five task-file builders below.
 */
const RULES_SPLICED_NOTE = [
	"Project and mode-specific rules (from the central shared store and this project's own",
	".roo/rules*) are already spliced into your system prompt automatically — you do not",
	"need to read any rules file yourself.",
]

/**
 * One issue's title/body keyed by issue number as a string (JSON object keys
 * are always strings). Persisted on OrchestratorGroup at dispatch time so the
 * rework/QA/continuation task files — generated LATER from state alone, when
 * the original issue objects are no longer in hand — can embed the real
 * title/body instead of telling the worker to `gh issue view <n>` (which
 * fails outright for synthetic --issues-json numbers).
 */
export type IssueBodies = Record<string, { title: string; body?: string }>

/**
 * Render each assigned issue as an inline markdown block
 * ("### Issue #<n>: <title>\n\n<body>") for a task file — the issue title/body
 * is already in hand, so nothing needs fetching at session start. An issue
 * whose body was never recorded gets an explicit note; an issue with NO entry
 * at all falls back to the OLD `gh issue view <n>` instruction for that issue
 * only (state written before bodies were persisted — never silently produce an
 * empty assignment section).
 */
function issueBodyBlocks(
	numbers: number[],
	lookup: (n: number) => { title: string; body?: string } | undefined,
): string[] {
	const blocks: string[] = []
	for (const n of numbers) {
		const entry = lookup(n)
		if (entry === undefined) {
			blocks.push(
				`### Issue #${n}`,
				"",
				`No issue body recorded — fetch it yourself: \`gh issue view ${n}\`.`,
			)
		} else {
			blocks.push(
				`### Issue #${n}: ${entry.title}`,
				"",
				entry.body && entry.body.trim() !== ""
					? entry.body
					: "(no issue body recorded — inspect the codebase and git history for context)",
			)
		}
	}
	return blocks
}

export function buildTaskFileContent(spec: WorktreeSpec, issues: SplitIssue[]): string {
	const assigned = spec.issues.map((n) => `#${n}`).join(", ")
	const issueBlocks = issueBodyBlocks(spec.issues, (n) => issues.find((i) => i.number === n))
	return [
		...RULES_SPLICED_NOTE,
		"",
		"You are working autonomously in an isolated git worktree, on your own branch, with your own",
		"isolated environment. No human is in the loop until you open a PR. Read this entire file before",
		"doing anything.",
		"",
		"## Your assignment",
		"",
		`GitHub issues assigned to this worktree: ${assigned}. The real title/body of each is inline below.`,
		"",
		...(issueBlocks.length > 0 ? issueBlocks : ["(no issue numbers recorded — inspect the worktree for context)"]),
		"",
		"## Environment",
		"",
		`Workspace root: this worktree (branch: current branch). All file/command tools are scoped to`,
		"this worktree. Commit per logical unit with the issue number in the message.",
		"",
		"## Scratch",
		"",
		"Any scratch/temporary files (probe scripts, one-off data dumps, intermediate output) go in",
		"`<workspace>/.headlesscode/scratch/` — NEVER write to `/tmp` or any other path outside this",
		"worktree. `/.headlesscode/` is gitignored, so scratch there needs no ignore rule.",
		"",
		"## Workflow",
		"",
		"1. Read each assigned issue's inline body above and the relevant source files.",
		"2. Implement the change following the project's own conventions and the rules files.",
		"3. Verify for real (run the project's tests / boot check) and capture the output.",
		"4. Commit with the issue number referenced, one logical change per commit.",
		"5. Push the branch and open a PR (ready, not draft).",
		"6. Post the closing comment below on each issue, then close it.",
		"",
		"## Required comment template",
		"",
		"Your issue-closing comment must use this exact structure (every section present; a section can",
		"be 'N/A' with a reason, but a missing section is itself a review finding):",
		"```",
		"## Issue <n> — Closing Report",
		"",
		"### Files changed",
		"<one line per file>",
		"",
		"### Baseline (before)",
		"<real output>",
		"",
		"### Baseline (after)",
		"<real output>",
		"",
		"### Boot check",
		"<real output or exact reason it didn't apply>",
		"",
		"### Residual risk / notes",
		"<anything not 100% certain>",
		"",
		"PR: <link>",
		"```",
		"",
		"## Closing out",
		"",
		"Once every assigned issue is closed with the template above:",
		"1. Finish with attempt_completion and a full summary of what you changed, the real baseline",
		"   numbers, the boot check, and the PR link(s).",
		"2. The harness records your completion automatically (exit code + .harness.done marker) —",
		"   no separate phone-home step is needed.",
		"3. Do not start on any issue not assigned to this worktree.",
		"",
		`Scope: ${assigned} only.`,
	].join("\n")
}

/**
 * Issue #49 plan-first task content: the task file for the SHORT architect-mode
 * planning session that runs INSIDE the fresh worktree before the code worker.
 * The planner must produce a compact implementation plan (written to PLAN.md at
 * the workspace root, overwriting any previous plan) and stop — never
 * implement, never edit source, never ask the human, never switch modes. The
 * spawner appends PLAN.md into ORCHESTRATOR_TASK.md so the code worker that
 * follows executes against it. Reuses the other task files' conventions (rules
 * preamble, scope line).
 */
export function buildPlanFirstTaskFileContent(
	group: { name: string; issues?: number[] },
	/** The in-hand issues (their title/body is embedded inline). Optional for
	 * backward compatibility with callers that only have persisted state. */
	issues?: SplitIssue[],
): string {
	const assigned = (group.issues ?? []).map((n) => `#${n}`).join(", ") || "this worktree"
	const issueBlocks = issueBodyBlocks(group.issues ?? [], (n) => issues?.find((i) => i.number === n))
	return [
		...RULES_SPLICED_NOTE,
		"",
		"You are the PLANNING phase of an autonomous two-phase workflow, running in an isolated git",
		"worktree on your own branch. Your ONLY job is to produce a compact, actionable implementation",
		"plan for the code session that follows. Read this entire file before doing anything.",
		"",
		"## Your assignment (planning only — DO NOT implement)",
		"",
		`Assigned issues: ${assigned}. The real title/body of each is inline below.`,
		"",
		...(issueBlocks.length > 0
			? issueBlocks
			: ["(no issue numbers recorded — read ORCHESTRATOR_TASK.md for the full task)"]),
		"",
		"1. Read `ORCHESTRATOR_TASK.md` at the workspace root — it is the FULL task the code session",
		"   must execute. Read the assigned issues' inline bodies above.",
		"2. Explore the codebase just enough to ground the plan (grep/read the files the issues touch).",
		"3. Write the plan to `PLAN.md` at the workspace root (OVERWRITE any existing PLAN.md) as a",
		"   compact markdown document: goal, concrete steps (files + functions), verification steps",
		"   (tests/boot), and any risks. A code session will execute it — make every step something",
		"   another session can act on without re-doing your exploration.",
		"4. Finish with attempt_completion summarizing where the plan was written.",
		"",
		"## Scratch",
		"",
		"Any scratch/temporary files (probe scripts, one-off data dumps, intermediate output) go in",
		"`<workspace>/.headlesscode/scratch/` — NEVER write to `/tmp` or any other path outside this",
		"worktree. `/.headlesscode/` is gitignored, so scratch there needs no ignore rule.",
		"",
		"## Constraints",
		"",
		"- DO NOT implement anything: no source edits, no commits, no pushes, no PRs.",
		"- DO NOT ask the human questions — you are headless; decide autonomously and write the plan.",
		"- DO NOT use switch_mode — this session ends with attempt_completion, period.",
		"- Keep the plan SHORT (a compact plan beats a tome; the code session re-verifies anything it",
		"  doubts before trusting it).",
		"",
		`Scope: ${assigned} only — planning phase.`,
	].join("\n")
}

export function writeTaskFiles(
	repo: string,
	specs: WorktreeSpec[],
	issues: SplitIssue[],
	opts: { planFirst?: boolean } = {},
): string[] {
	const dir = path.join(repo, "plans", "parallel-tasks")
	fs.mkdirSync(dir, { recursive: true })
	const written: string[] = []
	for (const spec of specs) {
		const target = path.join(dir, spec.taskFile)
		fs.writeFileSync(target, buildTaskFileContent(spec, issues), "utf-8")
		written.push(target)
		if (opts.planFirst) {
			// Issue #49: the plan-first session's task file (the spawner copies
			// it into the worktree as ORCHESTRATOR_PLAN.md and runs it BEFORE
			// the code worker). Named `<name>-plan.md` — the spawner derives it
			// from the worktree name alone, so a standalone spawner invocation
			// can fall back to a generic planner prompt when it is absent.
			const planTarget = path.join(dir, `${spec.name}-plan.md`)
			fs.writeFileSync(planTarget, buildPlanFirstTaskFileContent(spec, issues), "utf-8")
			written.push(planTarget)
		}
	}
	return written
}

/**
 * Rework-loop task content (see plans/rework-loop.md): a NEW task file for a
 * group whose review came back with a "finding" verdict. Reuses the original
 * task file's structure/conventions (rules preamble, closing-report template,
 * scope) but the assignment is the reviewer's `pending_review_findings` list
 * rather than the raw issues. The worker is expected to address EVERY finding,
 * re-verify for real, and re-close/re-comment with fresh evidence per the
 * closing-report template — same contract as the first attempt.
 */
export function buildReworkTaskFileContent(
	group: { name: string; issues?: number[]; issueBodies?: IssueBodies },
	findings: string[],
	reworkCount: number,
	/** Persisted issue title/body captured at dispatch time (see
	 * OrchestratorGroup.issueBodies). Absent for state written before the
	 * bodies feature — falls back to the old `gh issue view <n>` instruction. */
	issueBodies?: IssueBodies,
): string {
	const assigned = (group.issues ?? []).map((n) => `#${n}`).join(", ") || "this worktree"
	const issueBlocks = issueBodyBlocks(group.issues ?? [], (n) => group.issueBodies?.[String(n)] ?? issueBodies?.[String(n)])
	const findingsList = findings.length > 0 ? findings.map((f, i) => `${i + 1}. ${f}`).join("\n") : ""
	return [
		...RULES_SPLICED_NOTE,
		"",
		"You are working autonomously in the SAME isolated git worktree as the previous attempt, on",
		"the same branch. The automated adversarial reviewer found problems with that attempt. Read",
		"this entire file before doing anything.",
		"",
		`## Rework cycle ${reworkCount} — address the review findings`,
		"",
		`Assigned issues: ${assigned}. The real title/body of each is inline below.`,
		"",
		...(issueBlocks.length > 0
			? issueBlocks
			: ["(no issue numbers recorded — inspect the worktree for context)"]),
		"",
		"## Review findings to fix (from the automated review)",
		"",
		...findingsList.split("\n"),
		...(findingsList === "" ? ["(no specific findings were recorded — re-read the previous attempt's", "diff and re-verify everything the reviewer might have flagged.)"] : []),
		"",
		"Your job: address EVERY finding above. Do not skip any. Do not claim a finding is fixed",
		"without reproducing the fix for real.",
		"",
		"## Scratch",
		"",
		"Any scratch/temporary files (probe scripts, one-off data dumps, intermediate output) go in",
		"`<workspace>/.headlesscode/scratch/` — NEVER write to `/tmp` or any other path outside this",
		"worktree. `/.headlesscode/` is gitignored, so scratch there needs no ignore rule.",
		"",
		"## Workflow",
		"",
		"1. Read each finding above and the relevant source files.",
		"2. Fix every finding, following the project's own conventions and the rules files.",
		"3. Re-verify for real (run the project's tests / boot check) and capture the output —",
		"   output in a report is a claim, not evidence, until reproduced.",
		"4. Commit with the issue number referenced, one logical change per commit.",
		"5. Push the branch and update the PR (or open a new one if needed).",
		"6. Post an UPDATED closing comment below on each issue using the required template, then",
		"   re-close it (or leave it open with the updated report if it must stay open).",
		"",
		"## Required comment template",
		"",
		"Your issue-closing comment must use this exact structure (every section present; a section can",
		"be 'N/A' with a reason, but a missing section is itself a review finding):",
		"```",
		`## Issue <n> — Closing Report (rework cycle ${reworkCount})`,
		"",
		"### Files changed",
		"<one line per file>",
		"",
		"### Baseline (before)",
		"<real output>",
		"",
		"### Baseline (after)",
		"<real output>",
		"",
		"### Boot check",
		"<real output or exact reason it didn't apply>",
		"",
		"### Residual risk / notes",
		"<anything not 100% certain>",
		"",
		"PR: <link>",
		"```",
		"",
		"## Closing out",
		"",
		"Once every finding is addressed and every assigned issue is re-closed with fresh evidence:",
		"1. Finish with attempt_completion and a full summary of what you changed, the real baseline",
		"   numbers, the boot check, and the PR link(s).",
		"2. The harness records your completion automatically (exit code + .harness.done marker) —",
		"   no separate phone-home step is needed.",
		"3. Do not start on any issue not assigned to this worktree.",
		"",
		`Scope: ${assigned} only — rework cycle ${reworkCount}.`,
	].join("\n")
}

/**
	* QA-fail rework task content (issue #52): a NEW task file for a group whose
	* QA session came back with a real "fail" verdict (review had passed). Same
	* structure/conventions as buildReworkTaskFileContent, but the assignment is
	* the QA evidence — what the QA session actually found and verified — rather
	* than the reviewer's findings list. The worker is expected to address every
	* piece of evidence, re-verify for real, and re-close with fresh evidence per
	* the closing-report template — same contract as the first attempt.
	*/
export function buildQaReworkTaskFileContent(
	group: { name: string; issues?: number[]; issueBodies?: IssueBodies },
	evidence: string,
	reworkCount: number,
	reportPath?: string,
	/** Persisted issue title/body captured at dispatch time (see
	 * OrchestratorGroup.issueBodies). Absent for state written before the
	 * bodies feature — falls back to the old `gh issue view <n>` instruction. */
	issueBodies?: IssueBodies,
): string {
	const assigned = (group.issues ?? []).map((n) => `#${n}`).join(", ") || "this worktree"
	const issueBlocks = issueBodyBlocks(group.issues ?? [], (n) => group.issueBodies?.[String(n)] ?? issueBodies?.[String(n)])
	// Issue #34-style: point at the QA session's COMPLETE final report so the
	// full reasoning is one file-read away (evidence is only a 4000-char slice).
	const reportLines = reportPath
		? [
				"",
				`The full QA session report is at: \`${reportPath}\` — read it for the complete`,
				"reasoning behind every finding before you start.",
		  ]
		: []
	return [
		...RULES_SPLICED_NOTE,
		"",
		"You are working autonomously in the SAME isolated git worktree as the previous attempt, on",
		"the same branch. Review passed, but the automated QA session found real problems with the",
		"attempt — treat them as NEW WORK. Read this entire file before doing anything.",
		"",
		`## Rework cycle ${reworkCount} — address the QA findings`,
		"",
		`Assigned issues: ${assigned}. The real title/body of each is inline below.`,
		"",
		...(issueBlocks.length > 0
			? issueBlocks
			: ["(no issue numbers recorded — inspect the worktree for context)"]),
		"",
		"## QA findings to fix (from the automated QA)",
		"",
		...(evidence === ""
			? [
					"(the QA report recorded no extractable evidence — re-run the QA checklist against the",
					"worktree yourself and fix whatever fails.)",
			  ]
			: [evidence]),
		...reportLines,
		"",
		"Your job: address EVERY finding above. Do not skip any. Do not claim a finding is fixed",
		"without reproducing the fix for real.",
		"",
		"## Scratch",
		"",
		"Any scratch/temporary files (probe scripts, one-off data dumps, intermediate output) go in",
		"`<workspace>/.headlesscode/scratch/` — NEVER write to `/tmp` or any other path outside this",
		"worktree. `/.headlesscode/` is gitignored, so scratch there needs no ignore rule.",
		"",
		"## Workflow",
		"",
		"1. Read each finding above and the relevant source files.",
		"2. Fix every finding, following the project's own conventions and the rules files.",
		"3. Re-verify for real (run the project's tests / boot check) and capture the output —",
		"   output in a report is a claim, not evidence, until reproduced.",
		"4. Commit with the issue number referenced, one logical change per commit.",
		"5. Push the branch and update the PR (or open a new one if needed).",
		"6. Post an UPDATED closing comment below on each issue using the required template, then",
		"   re-close it (or leave it open with the updated report if it must stay open).",
		"",
		"## Required comment template",
		"",
		"Your issue-closing comment must use this exact structure (every section present; a section can",
		"be 'N/A' with a reason, but a missing section is itself a review finding):",
		"```",
		`## Issue <n> — Closing Report (rework cycle ${reworkCount})`,
		"",
		"### Files changed",
		"<one line per file>",
		"",
		"### Baseline (before)",
		"<real output>",
		"",
		"### Baseline (after)",
		"<real output>",
		"",
		"### Boot check",
		"<real output or exact reason it didn't apply>",
		"",
		"### Residual risk / notes",
		"<anything not 100% certain>",
		"",
		"PR: <link>",
		"```",
		"",
		"## Closing out",
		"",
		"Once every finding is addressed and every assigned issue is re-closed with fresh evidence:",
		"1. Finish with attempt_completion and a full summary of what you changed, the real baseline",
		"   numbers, the boot check, and the PR link(s).",
		"2. The harness records your completion automatically (exit code + .harness.done marker) —",
		"   no separate phone-home step is needed.",
		"3. Do not start on any issue not assigned to this worktree.",
		"",
		`Scope: ${assigned} only — rework cycle ${reworkCount}.`,
	].join("\n")
}

/**
	* Continuation task content (plans/issues/02-orchestrate-iteration-plumbing.md,
	* Part 2): a NEW task file for a group whose worker exited because it hit the
	* iteration cap. The worktree is untouched and resumable — the partial edits
	* are on disk — so the next session picks up where the last left off. Reuses
	* the original task file's conventions (rules preamble, closing-report
	* template, scope) but the assignment is "keep going" rather than the raw
	* issues.
	*/
export function buildContinuationTaskFileContent(
	group: { name: string; issues?: number[]; issueBodies?: IssueBodies },
	continuationCount: number,
	/** Persisted issue title/body captured at dispatch time (see
	 * OrchestratorGroup.issueBodies). Absent for state written before the
	 * bodies feature — falls back to the old `gh issue view <n>` instruction. */
	issueBodies?: IssueBodies,
	/** The previous session's own condensed summary of its history (see
	 * src/engine/handoff.ts) — file reads, command outputs, decisions made —
	 * so this cycle doesn't have to re-derive them from scratch. Absent when
	 * the previous session's handoff write failed/didn't run (older state,
	 * or a very short session); the git-status-inspection instruction below
	 * is the fallback either way, not a redundant step. */
	handoffSummary?: string,
): string {
	const assigned = (group.issues ?? []).map((n) => `#${n}`).join(", ") || "this worktree"
	const issueBlocks = issueBodyBlocks(group.issues ?? [], (n) => group.issueBodies?.[String(n)] ?? issueBodies?.[String(n)])
	return [
		...RULES_SPLICED_NOTE,
		"",
		"You are working autonomously in the SAME isolated git worktree as the previous session(s), on",
		"the same branch. The previous session was cut short — either it hit the harness's iteration cap, or",
		"it hit a transient LLM-provider failure (a hard-pinned model with no fallback provider had a bad",
		"moment; not a fault in your task or the code). Neither is a review verdict — its partial work is",
		"still on disk: uncommitted edits, commits, notes — pick up exactly where it left off. Read this",
		"entire file before doing anything.",
		"",
		`## Continuation cycle ${continuationCount} — complete the task`,
		"",
		`Assigned issues: ${assigned}. The real title/body of each is inline below.`,
		"",
		...(issueBlocks.length > 0
			? issueBlocks
			: ["(no issue numbers recorded — inspect the worktree for context)"]),
		"",
		"## What the previous session already learned — do not re-derive this",
		"",
		...(handoffSummary
			? [
					"The previous session summarized its own history before it ran out of iterations. Trust it and",
					"build on it — re-reading files or re-running commands it already covered wastes iterations you",
					"need for finishing the actual task. It CAN be wrong (compression loses detail, and the session's",
					"own notes may be incomplete) — if something below conflicts with what you observe on disk, what",
					"you observe wins, but don't re-verify things it reports with confidence just to be safe.",
					"",
					"```",
					handoffSummary.trim(),
					"```",
				]
			: [
					"(No handoff summary available for this cycle — the previous session's write either failed or",
					"never ran. Fall back to inspecting the worktree yourself, below.)",
				]),
		"",
		"## What the previous session did",
		"",
		"- Inspect the worktree's git status, recent commits, and uncommitted changes to see exactly",
		"  how far the previous session got — this is a real-state CHECK, not your primary source of",
		"  context; the summary above should already tell you most of this.",
		"- Do NOT restart from scratch: continue the existing work toward the issues above.",
		"- If the previous session left a partial fix, finish it and verify it for real.",
		"",
		"## Scratch",
		"",
		"Any scratch/temporary files (probe scripts, one-off data dumps, intermediate output) go in",
		"`<workspace>/.headlesscode/scratch/` — NEVER write to `/tmp` or any other path outside this",
		"worktree. `/.headlesscode/` is gitignored, so scratch there needs no ignore rule.",
		"",
		"## Workflow",
		"",
		"1. Read each assigned issue's inline body above and the relevant source files.",
		"2. Continue the implementation following the project's own conventions and the rules files.",
		"3. Verify for real (run the project's tests / boot check) and capture the output —",
		"   output in a report is a claim, not evidence, until reproduced.",
		"4. Commit with the issue number referenced, one logical change per commit.",
		"5. Push the branch and open a PR (ready, not draft).",
		"6. Post the closing comment below on each issue using the required template, then close it.",
		"",
		"## Required comment template",
		"",
		"Your issue-closing comment must use this exact structure (every section present; a section can",
		"be 'N/A' with a reason, but a missing section is itself a review finding):",
		"```",
		`## Issue <n> — Closing Report (continuation cycle ${continuationCount})`,
		"",
		"### Files changed",
		"<one line per file>",
		"",
		"### Baseline (before)",
		"<real output>",
		"",
		"### Baseline (after)",
		"<real output>",
		"",
		"### Boot check",
		"<real output or exact reason it didn't apply>",
		"",
		"### Residual risk / notes",
		"<anything not 100% certain>",
		"",
		"PR: <link>",
		"```",
		"",
		"## Closing out",
		"",
		"Once every assigned issue is closed with the template above:",
		"1. Finish with attempt_completion and a full summary of what you changed, the real baseline",
		"   numbers, the boot check, and the PR link(s).",
		"2. The harness records your completion automatically (exit code + .harness.done marker) —",
		"   no separate phone-home step is needed.",
		"3. Do not start on any issue not assigned to this worktree.",
		"",
		`Scope: ${assigned} only — continuation cycle ${continuationCount}.`,
	].join("\n")
}

// ─── Rework-loop decision ────────────────────────────────────────────────────

/**
 * The outcome of deciding what to do with a group whose review came back with
 * a "finding" verdict (see plans/rework-loop.md). Either the group gets a NEW
 * rework attempt on the SAME worktree (shouldSpawn), or it has exhausted its
 * `--max-rework-cycles` budget and is marked for human attention.
 */
export interface ReworkDecision {
	/** State patch to apply to the group (rework reset, or needs-human). */
	patch: Partial<Omit<OrchestratorGroup, "name">>
	/** Whether a rework worker should be spawned on the same worktree. */
	shouldSpawn: boolean
	/** The group's reworkCount after this decision. */
	newReworkCount: number
	/** Absolute path of the rework task file (only when shouldSpawn). */
	taskFilePath?: string
	/** Content of the rework task file (only when shouldSpawn). */
	taskContent?: string
	/** Exact `bash -c` command that launches the rework worker (only when shouldSpawn). */
	spawnCommand?: string
}

/**
 * Decide what to do after a review "finding" verdict, and build the pieces the
 * caller needs (state patch, task file, spawn command). Extracted from the
 * watchGroups callback so every branch is unit-testable without a live round.
 *
 * - Below the cap: the group is reset to "running" on the SAME worktree with a
 *   fresh `spawned` timestamp (so the watcher's stall guard measures the rework
 *   worker, not the original one), review/QA records are cleared, reworkCount is
 *   incremented, and a rework task file + worker launch command are produced.
 * - At the cap: no spawn; the group is marked `needs-human` (a TERMINAL state,
 *   deliberately distinct from `failed`) with the findings left recorded so a
 *   human can see exactly what the reviewer flagged.
 */
export function handleReviewVerdict(
	group: OrchestratorGroup,
	result: ReviewResult,
	repo: string,
	maxReworkCycles: number,
	mode: string,
	model?: string,
	/** Per-session iteration cap forwarded to the rework worker (default: harness's own). */
	maxIterations?: number,
): ReworkDecision {
	const currentRework = typeof group.reworkCount === "number" ? group.reworkCount : 0
	const newReworkCount = currentRework + 1
	const now = new Date().toISOString()

	if (currentRework < maxReworkCycles) {
		const taskFilePath = path.join(repo, "plans", "parallel-tasks", `${group.name}-rework${newReworkCount}.md`)
		const taskContent = buildReworkTaskFileContent(group, result.findings, newReworkCount, group.issueBodies)
		const worktreePath = groupWorktreePath(repo, group)
		const spawnCommand =
			`bash ${path.join(HARNESS_ROOT_TS, "scripts", "run-worker.sh")} ` +
			`"${worktreePath}" "${taskFilePath}" --mode "${mode}"` +
			(model ? ` --model "${model}"` : "") +
			(maxIterations !== undefined ? ` --max-iterations "${maxIterations}"` : "")
		return {
			shouldSpawn: true,
			newReworkCount,
			taskFilePath,
			taskContent,
			spawnCommand,
			patch: {
				status: "running",
				reworkCount: newReworkCount,
				// Fresh spawned timestamp: the stall guard must measure the
				// rework worker, not the (possibly hours-old) original attempt.
				spawned: now,
				// A fresh cycle needs a fresh review — clear the old verdict,
				// findings, QA, and the previous attempt's completion artifacts.
				review_verdict: undefined,
				pending_review_findings: undefined,
				reviewed_at: undefined,
				review_report: undefined,
				qa: undefined,
				stalled: undefined,
				exit_code: undefined,
				summary: undefined,
				// Must also clear cost_recorded: the rework worker adds MORE real
				// cost on this worktree, and recordCostIfSettled's one-shot gate
				// would otherwise silently skip re-recording the combined total
				// once this cycle re-settles — a real bug caught while manually
				// recovering a stuck round (see cost-history.ts).
				cost_recorded: undefined,
				last_activity: {
					note: `rework cycle ${newReworkCount}: re-spawned worker on the same worktree to fix review findings`,
				},
			},
		}
	}

	// Cap reached: no new attempt. Terminal "needs-human" outcome — the
	// findings stay recorded so a human can see exactly what failed.
	return {
		shouldSpawn: false,
		newReworkCount: currentRework,
		patch: {
			status: "needs-human",
			reworkCount: currentRework,
			last_activity: {
				note: `exhausted ${currentRework} rework attempt(s); review still has ${result.findings.length} finding(s) — needs human`,
			},
		},
	}
}

/**
	* QA-side twin of handleReviewVerdict (issue #52): a REAL QA "fail" verdict
	* (as opposed to a QA-SESSION "error" — see handleQaSessionError) is
	* actionable new work, exactly like a review "finding". Below the
	* `--max-rework-cycles` cap the group is reset to "running" on the SAME
	* worktree with a fresh `spawned` timestamp, review/QA/cost artifacts are
	* cleared, reworkCount is incremented, and a QA rework task file (fed from
	* `qa.evidence` rather than review findings) + worker launch command are
	* produced. At the cap: no spawn; the group is marked `needs-human` with the
	* QA verdict/evidence left recorded so a human can see exactly what failed.
	*/
export function handleQaVerdict(
	group: OrchestratorGroup,
	result: QaResult,
	repo: string,
	maxReworkCycles: number,
	mode: string,
	model?: string,
	/** Per-session iteration cap forwarded to the rework worker (default: harness's own). */
	maxIterations?: number,
): ReworkDecision {
	const currentRework = typeof group.reworkCount === "number" ? group.reworkCount : 0
	const newReworkCount = currentRework + 1
	const now = new Date().toISOString()

	if (currentRework < maxReworkCycles) {
		const taskFilePath = path.join(repo, "plans", "parallel-tasks", `${group.name}-qa-rework${newReworkCount}.md`)
		const taskContent = buildQaReworkTaskFileContent(
			group,
			result.evidence,
			newReworkCount,
			result.reportPath,
			group.issueBodies,
		)
		const worktreePath = groupWorktreePath(repo, group)
		const spawnCommand =
			`bash ${path.join(HARNESS_ROOT_TS, "scripts", "run-worker.sh")} ` +
			`"${worktreePath}" "${taskFilePath}" --mode "${mode}"` +
			(model ? ` --model "${model}"` : "") +
			(maxIterations !== undefined ? ` --max-iterations "${maxIterations}"` : "")
		return {
			shouldSpawn: true,
			newReworkCount,
			taskFilePath,
			taskContent,
			spawnCommand,
			patch: {
				status: "running",
				reworkCount: newReworkCount,
				// Fresh spawned timestamp: the stall guard must measure the
				// rework worker, not the (possibly hours-old) original attempt.
				spawned: now,
				// The rework worker changes code, so review AND QA must both
				// re-run — same fresh-cycle reset as handleReviewVerdict.
				review_verdict: undefined,
				pending_review_findings: undefined,
				reviewed_at: undefined,
				review_report: undefined,
				qa: undefined,
				stalled: undefined,
				exit_code: undefined,
				summary: undefined,
				// The rework worker adds MORE real cost on this worktree; the
				// one-shot recordCostIfSettled gate must re-record once this
				// cycle re-settles (same reasoning as handleReviewVerdict).
				cost_recorded: undefined,
				last_activity: {
					note: `rework cycle ${newReworkCount}: re-spawned worker on the same worktree to fix QA findings`,
				},
			},
		}
	}

	// Cap reached: no new attempt. Terminal "needs-human" outcome — the QA
	// verdict/evidence stay recorded so a human can see exactly what failed.
	return {
		shouldSpawn: false,
		newReworkCount: currentRework,
		patch: {
			status: "needs-human",
			reworkCount: currentRework,
			qa: {
				status: "failed",
				verdict: result.verdict,
				evidence: result.evidence.slice(0, 4000),
				report: result.reportPath,
				updated: now,
			},
			last_activity: {
				note: `exhausted ${currentRework} rework attempt(s); QA still failing — needs human`,
			},
		},
	}
}

/**
	* A review-SESSION failure (crash/budget/mistake-limit — see
 * runReviewWithRetries) survived every retry: verdict "error", distinct from
 * a real code "finding". This must NEVER feed into handleReviewVerdict's
 * rework-a-worker path — there is nothing actionable in a placeholder error
 * message, and spawning a worker to "fix" it wastes a full session for
 * nothing (caught live 2026-08-05 on issue #17's own round: a review
 * session's own bounded-failure triggered a pointless worker rework cycle).
 * Always terminal needs-human — a human should look at why review sessions
 * keep failing against this worktree, not have a worker respawned blindly.
 */
export function handleReviewSessionError(result: ReviewResult): Partial<OrchestratorGroup> {
	return {
		status: "needs-human",
		review_verdict: result.verdict,
		pending_review_findings: result.findings,
		reviewed_at: new Date().toISOString(),
		last_activity: { note: `review session kept failing: ${result.summary}` },
	}
}

/**
 * QA-side twin of handleReviewSessionError: a QA-SESSION failure (verdict
 * "error" — see runQaWithRetries) survived every retry. Must escalate to
 * needs-human directly, never recorded as an ordinary "failed" QA (which
 * would settle the round with cost recorded and nothing left to retry,
 * while QA never actually validated anything). Caught live 2026-08-05 on
 * issue #18's own round.
 */
export function handleQaSessionError(result: QaResult): Partial<OrchestratorGroup> {
	return {
		status: "needs-human",
		qa: {
			status: "failed",
			verdict: result.verdict,
			evidence: result.evidence.slice(0, 4000),
			updated: new Date().toISOString(),
		},
		last_activity: { note: `QA session kept failing: ${result.summary}` },
	}
}

// ─── Iteration-exhaustion continuation decision ──────────────────────────────

/**
	* The outcome of deciding what to do with a group whose worker failed with
	* exit != 0 (plans/issues/02-orchestrate-iteration-plumbing.md, Part 2).
	* Either the group gets a NEW continuation session on the SAME worktree
	* (shouldSpawn), or it has exhausted its `--max-continuations` budget and is
	* marked for human attention, or the failure is not the iteration-cap reason
	* at all and the group stays `failed`.
	*/
export interface ContinuationDecision {
	/** State patch to apply to the group (running reset, needs-human, or empty for a real failure). */
	patch: Partial<Omit<OrchestratorGroup, "name">>
	/** Whether a continuation worker should be spawned on the same worktree. */
	shouldSpawn: boolean
	/** The group's continuationCount after this decision. */
	newContinuationCount: number
	/** Absolute path of the continuation task file (only when shouldSpawn). */
	taskFilePath?: string
	/** Content of the continuation task file (only when shouldSpawn). */
	taskContent?: string
	/** Exact `bash -c` command that launches the continuation worker (only when shouldSpawn). */
	spawnCommand?: string
}

/**
	* Decide what to do after a worker failed with exit != 0, and build the pieces
	* the caller needs (state patch, task file, spawn command). Extracted from the
	* watchGroups callback so every branch is unit-testable without a live round.
	*
	* - The failure is NEITHER the iteration-cap reason NOR a transient
	*   LLM-provider failure (budget stop, tool-error storm, a real code/task
	*   bug — or a clean exit with either string merely in the log tail): no
	*   continuation; the patch is empty and the watcher's "failed" stands.
	*   Provider failures earned the same auto-continue treatment as the
	*   iteration cap after a live incident (2026-08-08): a hard-pinned model
	*   with no fallback provider hit an HTTP 520 mid-session, the session
	*   died outright (this predates src/engine/loop.ts's callMainLlm retry —
	*   even with that retry, a longer outage still exhausts it), and the
	*   group sat in the generic terminal "failed" state — indistinguishable
	*   from a real bug — until a human happened to read harness.log. Bounded
	*   the same way as the iteration cap (maxContinuations), so a genuinely
	*   dead provider still surfaces to a human eventually, it just gets a
	*   few free retries first instead of zero.
	* - Below the cap: the group is reset to "running" on the SAME worktree with a
	*   fresh `spawned` timestamp (so the stall guard measures the continuation
	*   worker, not the attempt that hit the cap), continuationCount is
	*   incremented, completion artifacts are cleared, and a continuation task
	*   file + worker launch command are produced.
	* - At the cap: no spawn; the group is marked `needs-human` (a TERMINAL state,
	*   deliberately distinct from `failed`).
	*/
export function handleIterationExhaustion(
	group: OrchestratorGroup,
	repo: string,
	maxContinuations: number,
	mode: string,
	model?: string,
	maxIterations?: number,
): ContinuationDecision {
	const current = typeof group.continuationCount === "number" ? group.continuationCount : 0
	if (group.exit_code === 0 || !(isIterationExhaustion(group.summary) || isProviderFailure(group.summary))) {
		// Real failure — budget stops and every other exit reason stay
		// terminal. No patch: the watcher's "failed" stands.
		return { shouldSpawn: false, newContinuationCount: current, patch: {} }
	}
	const newContinuationCount = current + 1
	const now = new Date().toISOString()

	if (current < maxContinuations) {
		const taskFilePath = path.join(repo, "plans", "parallel-tasks", `${group.name}-continue${newContinuationCount}.md`)
		const worktreePath = groupWorktreePath(repo, group)
		// The session that just hit the cap wrote its own condensed history
		// here (src/engine/handoff.ts) right before exiting — inline it into
		// the continuation task file so the new conversation doesn't have to
		// re-derive everything from scratch, then clear it: it's about to be
		// baked into the task file text, and a stale copy must never leak
		// into a LATER, unrelated continuation on this same worktree.
		const handoffSummary = readHandoffSummary(worktreePath)
		clearHandoffSummary(worktreePath)
		const taskContent = buildContinuationTaskFileContent(group, newContinuationCount, group.issueBodies, handoffSummary)
		const spawnCommand =
			`bash ${path.join(HARNESS_ROOT_TS, "scripts", "run-worker.sh")} ` +
			`"${worktreePath}" "${taskFilePath}" --mode "${mode}"` +
			(model ? ` --model "${model}"` : "") +
			(maxIterations !== undefined ? ` --max-iterations "${maxIterations}"` : "")
		return {
			shouldSpawn: true,
			newContinuationCount,
			taskFilePath,
			taskContent,
			spawnCommand,
			patch: {
				status: "running",
				continuationCount: newContinuationCount,
				// Fresh spawned timestamp: the stall guard must measure the
				// continuation worker, not the (possibly hours-old) attempt
				// that hit the cap.
				spawned: now,
				// A fresh session starts clean: drop the previous attempt's
				// completion artifacts, review/QA records and stall flag.
				review_verdict: undefined,
				pending_review_findings: undefined,
				reviewed_at: undefined,
				review_report: undefined,
				qa: undefined,
				stalled: undefined,
				exit_code: undefined,
				summary: undefined,
				// Must also clear cost_recorded — see the identical note in
				// handleReviewVerdict's patch above.
				cost_recorded: undefined,
				last_activity: {
					note: `continuation ${newContinuationCount}: previous session hit the iteration cap; re-spawned worker on the same worktree`,
				},
			},
		}
	}

	// Cap reached: no new attempt. Terminal "needs-human" outcome.
	return {
		shouldSpawn: false,
		newContinuationCount: current,
		patch: {
			status: "needs-human",
			continuationCount: current,
			last_activity: {
				note: `exhausted ${current} continuation attempt(s) — still hitting the iteration cap; needs human`,
			},
		},
	}
}

// ─── Spawn command assembly ──────────────────────────────────────────────────

function spawnCommandFor(harnessRoot: string, specs: WorktreeSpec[]): string {
	const triples = specs.map((spec) => `${spec.name}:${specs.indexOf(spec)}:plans/parallel-tasks/${spec.taskFile}`)
	return `bash ${path.join(harnessRoot, "scripts", "spawn-parallel-worktrees.sh")} ${triples.join(" ")}`
}

export interface BuildSpawnEnvOptions {
	repo: string
	/** Harness mode for the workers (e.g. "code"). */
	mode: string
	/** An explicit --model flag value, if the caller passed one — always wins (resolveModelForMode rule 1). */
	explicitModel?: string
	memoryDir?: string
	/** Per-session iteration cap forwarded as HEADLESSCODE_MAX_ITERATIONS (run-worker.sh → --max-iterations). */
	maxIterations?: number
	/** Issue #49: run a plan-first session per worktree before the code worker (forwarded as PLAN_FIRST=1). */
	planFirst?: boolean
	/** Mode slug for the plan-first session (default: architect). */
	planFirstMode?: string
	/** Iteration cap for the plan-first session (default: 15). */
	planFirstMaxIterations?: number
	/** Env to read OPENROUTER_MODEL from (default: process.env). */
	env?: NodeJS.ProcessEnv
}

/**
 * Resolve the worker's model and build the env for the initial spawnSync
 * (step 2 of orchestrateMain). Exported for tests: this is the fix for
 * "mode-models.json ignored on a worker's FIRST spawn" — the resolved model
 * is threaded into the spawn env as OPENROUTER_MODEL (which the spawner
 * script and run-worker.sh inherit), instead of only applying on rework
 * re-spawns. The returned workerModel is the SAME const the rework loop
 * reuses later.
 */
export function buildSpawnEnv(options: BuildSpawnEnvOptions): { env: NodeJS.ProcessEnv; workerModel: string | undefined } {
	const workerModel = resolveModelForMode({
		workspaceRoot: options.repo,
		mode: options.mode,
		explicitModel: options.explicitModel,
		env: options.env ?? process.env,
	})
	const env: NodeJS.ProcessEnv = {
		...(options.env ?? process.env),
		TARGET_REPO: options.repo,
		ORCHESTRATOR_MODE: options.mode,
		// The resolved worker model must reach the spawner (and the workers it
		// launches) — same pattern as HEADLESSCODE_PROJECT below.
		...(workerModel ? { OPENROUTER_MODEL: workerModel } : {}),
		// Phase 3: workers scope memory to the REPO (not the worktree) and
		// share one memory dir. HEADLESSCODE_PROJECT flows to the worker CLI
		// which passes it as the session `project`; the env var is inherited
		// when --memory-dir is not given.
		HEADLESSCODE_PROJECT: path.basename(options.repo),
		...(options.memoryDir ? { HEADLESSCODE_MEMORY_DIR: path.resolve(options.memoryDir) } : {}),
		// Iteration cap: an explicit --max-iterations beats the inherited env
		// var; undefined leaves whatever the caller's env already had in place
		// (or the harness's own default, 50, if neither is set).
		...(options.maxIterations !== undefined ? { HEADLESSCODE_MAX_ITERATIONS: String(options.maxIterations) } : {}),
		// Operator knobs (spawner guardrail + local exploration) forwarded from
		// the AMBIENT env, not options.env — the caller's env is usually
		// process.env so the spread above already carries them, but a filtered
		// env must not silently drop an operator decision. ALLOW_UNINDEXED /
		// HEADLESSCODE_AUTO_INDEX gate the spawner's no-index guardrail;
		// HEADLESSCODE_LOCAL_EXPLORE* enable the pre-cloud local-explore phase.
		...(process.env.ALLOW_UNINDEXED ? { ALLOW_UNINDEXED: process.env.ALLOW_UNINDEXED } : {}),
		...(process.env.HEADLESSCODE_AUTO_INDEX ? { HEADLESSCODE_AUTO_INDEX: process.env.HEADLESSCODE_AUTO_INDEX } : {}),
		...(process.env.HEADLESSCODE_LOCAL_EXPLORE ? { HEADLESSCODE_LOCAL_EXPLORE: process.env.HEADLESSCODE_LOCAL_EXPLORE } : {}),
		...(process.env.HEADLESSCODE_LOCAL_EXPLORE_MODEL
			? { HEADLESSCODE_LOCAL_EXPLORE_MODEL: process.env.HEADLESSCODE_LOCAL_EXPLORE_MODEL }
			: {}),
		...(process.env.HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS
			? { HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS: process.env.HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS }
			: {}),
		...(process.env.HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS
			? { HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS: process.env.HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS }
			: {}),
		// Issue #49 plan-first experiment: forwarded to the spawner, which runs
		// a short architect-mode planning session in each worktree BEFORE
		// launching the code worker and appends the plan (PLAN.md) to the
		// worker's task file. Only set when --plan-first is on — never the
		// default. PLAN_FIRST_MODE/MAX_ITERATIONS are only meaningful when
		// PLAN_FIRST is set, so they travel together.
		...(options.planFirst ? { PLAN_FIRST: "1" } : {}),
		...(options.planFirst ? { PLAN_FIRST_MODE: options.planFirstMode ?? "architect" } : {}),
		...(options.planFirst ? { PLAN_FIRST_MAX_ITERATIONS: String(options.planFirstMaxIterations ?? 15) } : {}),
	}
	return { env, workerModel }
}

/**
 * Issue #53 pre-flight issue-size check: one loud stderr line per issue whose
 * body reads like 3+ independent pieces of work. Warning-only by design — a
 * crude heuristic can false-positive, so it never aborts the round; the
 * operator is told BEFORE anything spawns so they can split the issue first.
 */
function printIssueSizeWarnings(warnings: IssueSizeWarning[]): void {
	for (const w of warnings) {
		process.stderr.write(
			`headlesscode orchestrate: WARNING: issue #${w.number} ("${w.title}") reads like ${w.sections} independent pieces of work ` +
				`(${w.sections} top-level numbered/bulleted sections in its body). Dispatching it to ONE worker risks iteration-cap / budget ` +
				`burn + rework cycles (issue #53). Consider splitting it into ${w.sections} sub-issues and re-running before spawning. ` +
				`--no-issue-size-check silences this warning.\n`,
		)
	}
}

function printPlan(
	repo: string,
	mode: string,
	specs: WorktreeSpec[],
	issues: SplitIssue[],
	models?: { worker: string; reviewer: string; qa: string },
	maxIterations?: number,
	estimateSection?: string[],
	/** Issue #49: plan-first session info to surface on the dry-run plan. */
	planFirst?: { mode: string; maxIterations: number },
): void {
	// Shape labels come from split.ts's issueShape (the SAME taxonomy the
	// split and the cost estimate use) — a single source of truth instead of
	// a third inline copy of the keyword scans.
	const shapeNotes = new Map<number, string>()
	for (const issue of issues) {
		const shape = issueShape(issue)
		const label =
			shape === "hot" ? "hot-path isolated" : shape === "generic" ? "generic" : `same-shape: ${shape}`
		shapeNotes.set(issue.number, label)
	}

	process.stdout.write("── Orchestrate plan (dry run) ─────────────────────────────\n")
	process.stdout.write(`  repo:     ${repo}\n`)
	process.stdout.write(`  mode:     ${mode}\n`)
	if (planFirst) {
		process.stdout.write(
			`  plan-first: mode ${planFirst.mode}, max ${planFirst.maxIterations} iterations per worktree ` +
				`(issue #49 — plan session runs BEFORE each code worker)\n`,
		)
	}
	process.stdout.write(
		maxIterations !== undefined
			? `  max iterations: ${maxIterations} (workers get --max-iterations ${maxIterations})\n`
			: "  max iterations: <harness default 250>\n",
	)
	if (models) {
		process.stdout.write(`  models:   worker: ${models.worker}\n`)
		process.stdout.write(`            reviewer: ${models.reviewer}\n`)
		process.stdout.write(`            QA: ${models.qa}\n`)
	}
	process.stdout.write(`  issues:   ${issues.map((i) => i.number).join(", ")}\n\n`)
	process.stdout.write("Split plan (heuristics from the multi-agent-orchestrator mode):\n")
	for (const spec of specs) {
		const reasons = spec.issues.map((n) => shapeNotes.get(n) ?? "generic").join(", ")
		process.stdout.write(
			`  ${spec.name.padEnd(4)} issue ${spec.issues.join(", ").padEnd(10)} -> plans/parallel-tasks/${spec.taskFile}  (${reasons})\n`,
		)
	}
	// Issue #16: expected cost/iteration range for this round, estimated
	// from recorded cost history (best-effort — a read failure yields no
	// section, never a failed dry-run).
	if (estimateSection && estimateSection.length > 0) {
		process.stdout.write("\nCost estimate (from recorded cost-history — issue #16):\n")
		for (const line of estimateSection) {
			process.stdout.write(`  ${line}\n`)
		}
	}
	process.stdout.write("\nSpawn commands:\n")
	process.stdout.write(`  ${spawnCommandFor(HARNESS_ROOT_TS, specs)}\n`)
}

/** Resolve this harness repo's root (parent of src/orchestrator). */
const HARNESS_ROOT_TS = fileURLToPath(new URL("../..", import.meta.url))

// ─── `orchestrate status` — read-side status / wait for EXTERNAL callers ────

const STATUS_USAGE = `headlesscode orchestrate status — per-group status of a round, optionally waiting for it

Usage:
  headlesscode orchestrate status --repo <path> [--json]
  headlesscode orchestrate status --repo <path> --wait [--timeout-ms <n>] [--on-group-terminal <cmd>] [--json]

Options:
  --repo <path>          Target repo root whose .worktrees/.orchestrator-state.json
                         is read (required). Before reporting, stale non-terminal
                         entries are reconciled against real worktree markers
                         (.harness.done/.harness.exit) and the state file is
                         patched back when ground truth proves a different status
                         ("done"/"failed", or "orphaned" when the worktree is gone).
  --wait                 Block inside this ONE call until every group reaches a
                         terminal status (done|failed|needs-human|orphaned;
                         "blocked" is NOT terminal — it keeps waiting) or
                         --timeout-ms elapses, then print the same summary plus a
                         one-line verdict. Reconciliation runs on every poll.
  --timeout-ms <n>       Max --wait duration, ms (default: 7200000 = 2h, matching
                         the watcher's stall guard — a round left non-terminal
                         longer than that is flagged stalled anyway).
  --poll-interval-ms <n> State-file poll interval for --wait, ms (default: 5000,
                         matching the watcher's own write cadence).
  --on-group-terminal <cmd>
                         With --wait: run <cmd> (spawned directly — no shell
                         parsing — with the group name and its terminal status as
                         two positional args) each time a group transitions to
                         done|failed|needs-human|orphaned mid-wait. Fires once per
                         group per transition; never fires for groups already
                         terminal when the wait started. A failing hook logs a
                         warning to stderr but never aborts the wait.
  --json                 Machine-readable output. One-shot: the reconciled
                         OrchestratorState plus a top-level "reconciled" array of
                         group names patched (only when something was patched).
                         With --wait: the final state plus top-level
                         allDone/timedOut/verdict/reconciled fields.
  --help, -h             Show this help and exit.

Exit codes:
  0  one-shot: no group is failed/needs-human/orphaned right now;
     --wait: every group is done (clean finish)
  1  one-shot: at least one group is failed, needs-human, or orphaned;
     --wait: any group failed/needs-human/orphaned, or the wait timed out
  2  usage error (bad or missing arguments)
`

export interface StatusOptions {
	repo: string
	json: boolean
	wait: boolean
	timeoutMs: number
	pollIntervalMs: number
	/** Command spawned (with the group name + terminal status as args) per terminal transition while --wait is active. */
	onGroupTerminal?: string
	help: boolean
}

export function parseStatusArgs(argv: string[]): { options: StatusOptions; error?: string } {
	const options: StatusOptions = {
		repo: "",
		json: false,
		wait: false,
		timeoutMs: DEFAULT_STATUS_TIMEOUT_MS,
		pollIntervalMs: DEFAULT_STATUS_POLL_INTERVAL_MS,
		onGroupTerminal: undefined,
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
			case "--json":
				options.json = true
				break
			case "--wait":
				options.wait = true
				break
			case "--timeout-ms": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--timeout-ms requires a positive integer" }
				}
				options.timeoutMs = n
				break
			}
			case "--poll-interval-ms": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--poll-interval-ms requires a positive integer" }
				}
				options.pollIntervalMs = n
				break
			}
			case "--on-group-terminal": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --on-group-terminal" }
				}
				options.onGroupTerminal = v
				break
			}
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown orchestrate status argument: ${arg}` }
		}
	}
	return { options }
}

export interface StatusIo {
	stdout?: (text: string) => void
	stderr?: (text: string) => void
}

function waitExitCode(allDone: boolean, summary: StatusSummary): number {
	// Nothing in the state file is not a failure — exit 0 so a caller that
	// ran --wait against a wrong/empty path sees a clear, non-alarming result.
	if (summary.counts.total === 0) {
		return 0
	}
	if (allDone) {
		return 0
	}
	// Reached here only when allDone is false: either the wait timed out with
	// groups still non-terminal, or every group is terminal but at least one
	// failed/needs-human. Both are non-clean outcomes → 1.
	return 1
}

/**
	* Run the `--on-group-terminal <cmd>` hook for a group that just reached a
	* terminal status: spawn <cmd> directly (NO shell parsing of <cmd> — it is
	* the executable path/name) with the group name and status as the two
	* positional args, and await completion so transitions fire sequentially.
	* A broken hook (spawn failure or non-zero exit) logs a warning to stderr
	* but never aborts the wait — a failed notification must not take down a
	* status watch that is otherwise healthy.
	*/
async function runGroupTerminalHook(cmd: string, group: OrchestratorGroup, writeErr: (text: string) => void): Promise<void> {
	try {
		const child = spawn(cmd, [group.name, group.status], { stdio: "inherit" })
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject)
			child.once("exit", (code, signal) => {
				if (code !== 0) {
					reject(new Error(signal ? `killed by ${signal}` : `exit ${code}`))
				} else {
					resolve()
				}
			})
		})
	} catch (err) {
		writeErr(
			`headlesscode orchestrate status: --on-group-terminal hook failed for group "${group.name}" ` +
				`(${group.status}): ${err instanceof Error ? err.message : String(err)}\n`,
		)
	}
}

/**
	* Attach the cleanup-eligibility column to every TERMINAL group's status row
	* (read-only, no side effects — the same gates the cleanup command uses,
	* minus the GitHub PR network check). Returns the per-group map for --json.
	* Never throws: on any failure the group is reported blocked with a reason,
	* matching cleanup's fail-closed model.
	*/
function attachCleanupStatus(repo: string, state: OrchestratorState, summary: StatusSummary): Record<string, CleanupStatus> {
	let baseBranch: string | undefined
	try {
		baseBranch = resolveBaseBranch(repo)
	} catch {
		baseBranch = undefined
	}
	const byGroup: Record<string, CleanupStatus> = {}
	for (const row of summary.groups) {
		if (!isTerminalStatus(row.status)) {
			continue // non-terminal groups are never touched by cleanup
		}
		const group = state.groups.find((g) => g.name === row.name)
		if (!group) {
			continue
		}
		const cleanup: CleanupStatus =
			baseBranch === undefined
				? { status: "blocked", reason: "cannot resolve base branch (detached HEAD?) — pass --base to cleanup" }
				: assessGroupCleanupSync(repo, group, baseBranch)
		row.cleanup = cleanup
		byGroup[row.name] = cleanup
	}
	return byGroup
}

/**
	* `headlesscode orchestrate status` entry point. One call, one result: the
	* calling agent never re-invokes a tool per poll, unlike the bash loop this
	* replaces. Both forms reconcile stale state against real worktree markers
	* before reporting (see status.ts's reconcileGroups) — the state file is
	* patched back when ground truth proves a different status, so a stale
	* "running" entry is never reported as-is.
	*/
export async function statusMain(argv: string[], io: StatusIo = {}): Promise<number> {
	const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text))
	const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text))

	const { options, error } = parseStatusArgs(argv)
	if (error) {
		writeErr(`headlesscode orchestrate status: ${error}\n\n${STATUS_USAGE}`)
		return 2
	}
	if (options.help) {
		writeOut(STATUS_USAGE)
		return 0
	}
	if (!options.repo) {
		writeErr(`headlesscode orchestrate status: --repo <path> is required\n\n${STATUS_USAGE}`)
		return 2
	}

	const repo = path.resolve(options.repo)
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")

	if (options.wait) {
		// --on-group-terminal: spawn the hook command per genuine terminal
		// transition (sequentially — terminal transitions are rare and
		// blocking the poll loop for the hook is fine).
		const hookCmd = options.onGroupTerminal
		const result = await waitForTerminalState(statePath, {
			timeoutMs: options.timeoutMs,
			pollIntervalMs: options.pollIntervalMs,
			// Reconcile on EVERY poll (a group can finish mid-wait). The
			// hook reports the patch; waitForTerminalState persists it ONLY
			// when no live watcher owns the state file (issue #116: a
			// concurrent `status --wait` persisting its read-side reconcile
			// pre-empted the watcher, which then short-circuited the group
			// and silently skipped log analysis + the automated review —
			// see waitForTerminalState's live-watcher heartbeat check).
			reconcile: (state) => reconcileGroups(state, repo),
			onGroupTerminal: hookCmd ? (group) => runGroupTerminalHook(hookCmd, group, writeErr) : undefined,
		})
		const summary = buildStatusSummary(result.state)
		const verdict = verdictLine(summary, result.timedOut, result.allDone)
		const cleanupByGroup = attachCleanupStatus(repo, result.state, summary)
		if (options.json) {
			const out: Record<string, unknown> = {
				...result.state,
				allDone: result.allDone,
				timedOut: result.timedOut,
				verdict,
			}
			if (result.reconciled.length > 0) {
				out.reconciled = result.reconciled
			}
			if (Object.keys(cleanupByGroup).length > 0) {
				out.cleanup = cleanupByGroup
			}
			writeOut(JSON.stringify(out, null, 2) + "\n")
		} else {
			writeOut(
				formatStatusText(summary, {
					repo,
					statePath,
					timedOut: result.timedOut,
					allDone: result.allDone,
					elapsedMs: result.elapsedMs,
					reconciled: result.reconciled,
				}),
			)
		}
		return waitExitCode(result.allDone, summary)
	}

	// One-shot: read the current state, reconcile it against real markers
	// (persisting any patch), print, exit on current health.
	let state: OrchestratorState
	try {
		state = loadStateSync(statePath)
	} catch (err) {
		writeErr(
			`headlesscode orchestrate status: cannot read state file ${statePath}: ${err instanceof Error ? err.message : String(err)}\n`,
		)
		return 1
	}
	const reconciliation = reconcileGroups(state, repo)
	if (reconciliation.reconciled.length > 0) {
		saveStateSync(statePath, reconciliation.state)
		state = reconciliation.state
	}
	const summary = buildStatusSummary(state)
	const cleanupByGroup = attachCleanupStatus(repo, state, summary)
	if (options.json) {
		const out: Record<string, unknown> = { ...state }
		if (reconciliation.reconciled.length > 0) {
			out.reconciled = reconciliation.reconciled
		}
		if (Object.keys(cleanupByGroup).length > 0) {
			out.cleanup = cleanupByGroup
		}
		writeOut(JSON.stringify(out, null, 2) + "\n")
	} else {
		writeOut(formatStatusText(summary, { repo, statePath, reconciled: reconciliation.reconciled }))
	}
	return summary.counts.failed > 0 || summary.counts.needsHuman > 0 || summary.counts.orphaned > 0 ? 1 : 0
}

// ─── `orchestrate stop` — stop a group's WHOLE worker tree (issue #20) ──────

const STOP_USAGE = `headlesscode orchestrate stop — stop one or more groups' worker process trees

Usage:
  headlesscode orchestrate stop --repo <path> --group <name> [--group <name> ...] [options]

Stops a worker COMPLETELY: scripts/stop-worker.sh targets the worker's process
GROUP — run-worker.sh launches each worker under setsid and the wrapper
records its process-group id in <worktree>/.harness.pgid — so the wrapper
bash, npx, node/tsx and every non-detached grandchild are all killed.
Killing the wrapper PID alone used to leave the real work running undetected,
reparented to init, until the session finished on its own (issue #20).

Each stopped group is patched to "needs-human" (a TERMINAL state — a human
must decide what to do with the stopped worktree next, e.g. resume it under
new logic). Groups that are already terminal are left untouched.

Options:
  --repo <path>          Target repo root whose .worktrees/.orchestrator-state.json
                         is read (required).
  --group <name>         Worktree group name to stop (repeatable; at least one).
  --grace-ms <n>         SIGTERM grace period before SIGKILL escalation, ms
                         (default: 5000; forwarded to scripts/stop-worker.sh).
  --json                 Machine-readable output: per-group results + final state.
  --help, -h             Show this help and exit.

Exit codes:
  0  every requested group was stopped (or was already terminal)
  1  a requested group could not be stopped / is not in the state file
  2  usage error (bad or missing arguments)
`

export interface StopOptions {
	repo: string
	groups: string[]
	graceMs: number
	json: boolean
	help: boolean
}

export function parseStopArgs(argv: string[]): { options: StopOptions; error?: string } {
	const options: StopOptions = { repo: "", groups: [], graceMs: 5000, json: false, help: false }
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
			case "--group": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --group" }
				}
				options.groups.push(v)
				break
			}
			case "--grace-ms": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n < 0) {
					return { options, error: "--grace-ms requires a non-negative integer" }
				}
				options.graceMs = n
				break
			}
			case "--json":
				options.json = true
				break
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown orchestrate stop argument: ${arg}` }
		}
	}
	return { options }
}

export interface StopIo {
	stdout?: (text: string) => void
	stderr?: (text: string) => void
	/** Injectable stop-script runner (tests); default: spawnSync scripts/stop-worker.sh. */
	runStopWorker?: (wtPath: string, graceMs: number) => { exitCode: number; output: string }
}

/**
 * `headlesscode orchestrate stop` entry point. Stops each requested group's
 * worker process tree via scripts/stop-worker.sh (issue #20) and patches the
 * stopped groups to `needs-human` so they never sit "running" forever with no
 * process behind them.
 */
export async function stopMain(argv: string[], io: StopIo = {}): Promise<number> {
	const writeOut = io.stdout ?? ((text: string) => process.stdout.write(text))
	const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text))

	const { options, error } = parseStopArgs(argv)
	if (error) {
		writeErr(`headlesscode orchestrate stop: ${error}\n\n${STOP_USAGE}`)
		return 2
	}
	if (options.help) {
		writeOut(STOP_USAGE)
		return 0
	}
	if (!options.repo) {
		writeErr(`headlesscode orchestrate stop: --repo <path> is required\n\n${STOP_USAGE}`)
		return 2
	}
	if (options.groups.length === 0) {
		writeErr(`headlesscode orchestrate stop: at least one --group <name> is required\n\n${STOP_USAGE}`)
		return 2
	}

	const repo = path.resolve(options.repo)
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	const runStopWorker =
		io.runStopWorker ??
		((wtPath: string, graceMs: number): { exitCode: number; output: string } => {
			const res = spawnSync(
				"bash",
				[path.join(HARNESS_ROOT_TS, "scripts", "stop-worker.sh"), wtPath, "--grace-ms", String(graceMs)],
				{ encoding: "utf-8" },
			)
			const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim()
			return { exitCode: res.status ?? 1, output }
		})

	if (!fs.existsSync(statePath)) {
		writeErr(`headlesscode orchestrate stop: no orchestrator state file at ${statePath} — nothing to stop (wrong --repo?)\n`)
		return 1
	}

	let state: OrchestratorState
	try {
		state = loadStateSync(statePath)
	} catch (err) {
		writeErr(
			`headlesscode orchestrate stop: cannot read state file ${statePath}: ${err instanceof Error ? err.message : String(err)}\n`,
		)
		return 1
	}

	// Validate EVERY requested group exists BEFORE stopping anything — an
	// operator typo must not stop half the requested set.
	const unknown = options.groups.filter((name) => !state.groups.some((g) => g.name === name))
	if (unknown.length > 0) {
		writeErr(
			`headlesscode orchestrate stop: group(s) not in state file ${statePath}: ${unknown.join(", ")}\n`,
		)
		return 1
	}

	const results: Array<{ name: string; status: string; stopped: boolean; output?: string }> = []
	let failed = 0
	let current = state
	for (const name of options.groups) {
		const group = current.groups.find((g) => g.name === name)
		if (!group) {
			continue
		}
		// With --json, stdout stays pure JSON — human progress + the stop
		// script's own output go to stderr (conventional diagnostics channel).
		const writeDiag = options.json ? writeErr : writeOut
		if (isTerminalStatus(group.status)) {
			// Already done/failed/needs-human/orphaned: no live worker to stop,
			// and patching it would clobber the real outcome.
			writeDiag(`[stop] ${name}: already ${group.status} — nothing to stop\n`)
			results.push({ name, status: group.status, stopped: false })
			continue
		}
		const wtPath = groupWorktreePath(repo, group)
		const res = runStopWorker(wtPath, options.graceMs)
		if (res.exitCode !== 0) {
			writeDiag(res.output ? `${res.output}\n` : "")
			writeErr(
				`[stop] ${name}: scripts/stop-worker.sh failed (exit ${res.exitCode}) — group left as-is (${group.status})\n`,
			)
			failed++
			results.push({ name, status: group.status, stopped: false, ...(res.output ? { output: res.output } : {}) })
			continue
		}
		current = updateGroup(current, name, {
			status: "needs-human",
			stopped_at: new Date().toISOString(),
			stalled: undefined,
			blocked: undefined,
			last_activity: {
				note: "stopped by operator: worker process tree killed (scripts/stop-worker.sh); a human must decide next steps",
			},
		})
		results.push({ name, status: "needs-human", stopped: true })
		writeDiag(res.output ? `${res.output}\n` : "")
		writeDiag(`[stop] ${name}: worker tree stopped; group marked needs-human\n`)
	}
	saveStateSync(statePath, current)

	if (options.json) {
		const out: Record<string, unknown> = {
			results,
			stopped: results.filter((r) => r.stopped).map((r) => r.name),
			groups: current.groups,
		}
		writeOut(JSON.stringify(out, null, 2) + "\n")
	}
	return failed > 0 ? 1 : 0
}

// ─── `pipeline` subcommand (issue #148) ───────────────────────────────────────

const PIPELINE_USAGE = `headlesscode pipeline — run the stage-isolated research→filing pipeline

Usage:
	 headlesscode pipeline --workspace <path> [--research-task <text>] [--skip-filing]
	                       [--model <id>] [--max-iterations <n>]

Runs the stage-isolated pipeline from issue #148: a fresh \`researcher\`-mode
session produces ONE well-cited research doc on disk (the artifact gate is
bound by default), then a fresh \`issue-filer\`-mode session turns that doc's
CONTENT (read off disk — never the prior session's conversation) into real
GitHub issue(s). Each stage is a genuinely separate \`HeadlessSession\` with
its own context, mode, and executor.

Options:
	 --workspace <path>   Workspace root the stages run against (required; must be
	                      a git repo — the filer needs \`gh\` against its origin)
	 --research-task <t>  Task text for the research stage (default: a built-in
	                      prompt naming the artifact pattern + required sections)
	 --skip-filing        Stop after the research stage; do NOT run the filing stage
	 --model <id>         Model override for both stages (default: env / client)
	 --max-iterations <n> Per-stage iteration cap (default: 60)
	 --help               Show this help and exit

Exit codes:
	 0  all run stages succeeded
	 1  a run stage failed (research session error / no artifact / filing parse error)
	 2  usage error (missing --workspace, unknown flag)
`

interface PipelineCliOptions {
	workspace?: string
	researchTask?: string
	skipFiling: boolean
	model?: string
	maxIterations?: number
	help: boolean
}

export function parsePipelineArgs(argv: string[]): { options: PipelineCliOptions; error?: string } {
	const options: PipelineCliOptions = { skipFiling: false, help: false }
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
			case "--workspace":
			case "--research-task":
			case "--model":
			case "--max-iterations": {
				const value = next()
				if (value === undefined) {
					return { options, error: `Missing value for ${flag}` }
				}
				if (flag === "--workspace") {
					options.workspace = value
				} else if (flag === "--research-task") {
					options.researchTask = value
				} else if (flag === "--model") {
					options.model = value
				} else {
					const n = Number(value)
					if (!Number.isInteger(n) || n <= 0) {
						return { options, error: "--max-iterations requires a positive integer" }
					}
					options.maxIterations = n
				}
				break
			}
			case "--skip-filing":
				options.skipFiling = true
				break
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown argument: ${arg}` }
		}
	}
	return { options }
}

/**
	* `headlesscode pipeline` — run the stage-isolated research→filing pipeline
	* (issue #148) against one workspace. Research produces the artifact; filing
	* (unless --skip-filing) turns it into real GitHub issues.
	*/
export async function pipelineMain(argv: string[]): Promise<number> {
	const { options, error } = parsePipelineArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode pipeline: ${error}\n\n${PIPELINE_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(PIPELINE_USAGE)
		return 0
	}
	if (!options.workspace) {
		process.stderr.write(`headlesscode pipeline: --workspace <path> is required\n\n${PIPELINE_USAGE}`)
		return 2
	}

	const workspaceRoot = path.resolve(options.workspace)
	process.stdout.write(`headlesscode pipeline: running research stage (mode researcher, artifact gate ON)...\n`)
	const research = await runResearchStage({
		workspaceRoot,
		taskText: options.researchTask,
		model: options.model,
		maxIterations: options.maxIterations,
	})
	if (research.status !== "ok" || !research.artifactPath) {
		process.stderr.write(
			`headlesscode pipeline: research stage failed — ${research.summary}\n`,
		)
		return 1
	}
	process.stdout.write(`headlesscode pipeline: research artifact at ${research.artifactPath}\n`)
	if (options.skipFiling) {
		return 0
	}

	process.stdout.write(`headlesscode pipeline: running filing stage (mode issue-filer)...\n`)
	const filing = await runFilingStage({
		workspaceRoot,
		researchArtifactPath: research.artifactPath,
		model: options.model,
		maxIterations: options.maxIterations,
	})
	if (filing.status !== "ok") {
		process.stderr.write(
			`headlesscode pipeline: filing stage failed — ${filing.summary}\n`,
		)
		return 1
	}
	process.stdout.write(
		`headlesscode pipeline: filed issue(s): ${filing.issueNumbers.join(", ")}\n`,
	)
	return 0
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function orchestrateMain(argv: string[]): Promise<number> {
	// Subcommand dispatch: `headlesscode orchestrate status ...` is the
	// read-side status/wait command, `... stop ...` stops a group's whole
	// worker tree (issue #20), `... cleanup ...` is the human-triggered
	// post-merge worktree cleanup, `... review/rework/resume ...` (issue #14)
	// are the standalone recovery subcommands; everything else is the
	// spawn+watch round.
	if (argv[0] === "status") {
		return statusMain(argv.slice(1))
	}
	if (argv[0] === "stop") {
		return stopMain(argv.slice(1))
	}
	if (argv[0] === "cleanup") {
		return cleanupMain(argv.slice(1))
	}
	if (argv[0] === "pipeline") {
		return pipelineMain(argv.slice(1))
	}
	// Issue #14 standalone recovery subcommands. Imported lazily (not
	// statically) because resume.ts imports this module's rework-decision
	// helpers — a static import here would create a module cycle.
	if (argv[0] === "review" || argv[0] === "rework" || argv[0] === "resume") {
		const { reviewMain, reworkMain, resumeMain } = await import("./resume.js")
		switch (argv[0]) {
			case "review":
				return reviewMain(argv.slice(1))
			case "rework":
				return reworkMain(argv.slice(1))
			default:
				return resumeMain(argv.slice(1))
		}
	}
	const { options, error } = parseOrchestrateArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode orchestrate: ${error}\n\n${ORCHESTRATE_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(ORCHESTRATE_USAGE)
		return 0
	}
	if (!options.repo) {
		process.stderr.write(`headlesscode orchestrate: --repo <path> is required\n\n${ORCHESTRATE_USAGE}`)
		return 2
	}

	const repo = path.resolve(options.repo)
	try {
		execFileSync("git", ["-C", repo, "rev-parse", "--git-dir"], { stdio: "ignore", timeout: 5000 })
	} catch {
		process.stderr.write(`headlesscode orchestrate: not a git repo: ${repo}\n`)
		return 2
	}

	let issues: SplitIssue[]
	try {
		issues = loadIssues(options)
	} catch (err) {
		process.stderr.write(`headlesscode orchestrate: ${err instanceof Error ? err.message : String(err)}\n`)
		return 2
	}

	// Fix 3: --file-issues (only valid with --issues-json) files a REAL GitHub
	// issue for every synthetic --issues-json entry and substitutes the real
	// number, so worktree/branch naming, task files, and PR-closing comments
	// all use a number that actually exists on GitHub. Runs before anything
	// else touches `issues`. A real, visible-to-GitHub side effect — never
	// silent: one confirmation line per created issue.
	if (options.fileIssues) {
		const ownerRepo = originOwnerRepo(repo)
		if (!ownerRepo) {
			process.stderr.write(
				`headlesscode orchestrate: --file-issues needs a parseable GitHub 'origin' remote on ${repo} ` +
					`(got none) to know where to file the issues\n`,
			)
			return 2
		}
		try {
			const { issues: filed, created } = fileSyntheticIssues(issues, (issue) => createGhIssue(repo, ownerRepo, issue))
			for (const c of created) {
				process.stdout.write(`[orchestrate] filed issue #${c.number}: ${c.title} -> ${c.url}\n`)
			}
			issues = filed
		} catch (err) {
			process.stderr.write(
				`headlesscode orchestrate: --file-issues failed: ${err instanceof Error ? err.message : String(err)}\n`,
			)
			return 2
		}
	}

	// Issue #53 pre-flight issue-size check + auto-split: a FREE deterministic
	// scan (split.ts's topLevelSectionCount) flags issues whose body reads
	// like 3+ independent pieces of work. Runs BEFORE splitIssues() below —
	// unlike the original warn-only version, this can REPLACE a flagged issue
	// with real sub-issues, and splitIssues must see the replacement, not the
	// oversized original. Auto-split needs a real (non-synthetic) issue to
	// close and a GitHub remote to file into; --issues-json entries and
	// remote-less repos fall back to warn-only (auto-split has nothing to
	// close/file against). --dry-run ALSO falls back to warn-only: filing
	// real issues and closing the parent are exactly the kind of visible,
	// hard-to-reverse side effects a dry run promises never to do.
	if (options.issueSizeCheck) {
		const warnings = issueSizeWarnings(issues)
		const ownerRepo = options.autoSplit && !options.issuesJson && !options.dryRun ? originOwnerRepo(repo) : undefined
		if (warnings.length > 0 && ownerRepo) {
			const model = options.model ?? DEFAULT_MODEL
			const llmClient = new OpenRouterClient({ apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY })
			const { issues: split, outcomes } = await autoSplitOversizedIssues(issues, warnings, {
				proposeSplit: (issue) => proposeSemanticSplit(issue, llmClient, model),
				createIssue: (issue) => createGhIssue(repo, ownerRepo, issue),
				closeParent: (n, comment) => closeGhIssue(repo, ownerRepo, n, comment),
			})
			issues = split
			for (const o of outcomes) {
				if (o.outcome === "split") {
					process.stdout.write(
						`[orchestrate] auto-split #${o.number} ("${o.title}") into ${o.created?.length} sub-issue(s): ` +
							(o.created ?? []).map((c) => `#${c.number} (${c.url})`).join(", ") +
							` — parent closed\n`,
					)
				} else if (o.outcome === "kept-as-is") {
					process.stdout.write(
						`[orchestrate] #${o.number} ("${o.title}") flagged by the size heuristic, but the model determined ` +
							`it's one coherent piece of work — dispatching as-is\n`,
					)
				} else {
					process.stderr.write(
						`headlesscode orchestrate: WARNING: auto-split failed for #${o.number} ("${o.title}"): ${o.reason} — ` +
							`dispatching the original issue as-is. --no-auto-split silences future attempts.\n`,
					)
				}
			}
		} else if (warnings.length > 0) {
			printIssueSizeWarnings(warnings)
		}
	}

	// Naming collision avoidance: a still-running round in the same repo
	// already occupies some `.worktrees/wN` dirs. Scan them and let
	// splitIssues name this round's groups around the gap instead of always
	// starting at w1 and colliding — see split.ts's occupiedNames param. Two
	// concurrent `orchestrate` invocations against the same repo can now
	// share it instead of the second one hard-failing on a "stale" worktree
	// that was actually just in-flight, not stale.
	let occupiedNames: Set<string> = new Set()
	try {
		occupiedNames = new Set(
			fs
				.readdirSync(path.join(repo, ".worktrees"), { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name),
		)
	} catch {
		// No .worktrees dir yet — nothing occupied.
	}
	const specs = splitIssues(issues, { occupiedNames })

	// Pre-spawn collision check: defense in depth only now that naming skips
	// occupied slots above — this should not fire in the normal case. It
	// still catches races (a worktree appearing between the scan above and
	// spawn) and fails loudly before spawning anything or writing task
	// files/state, so a skipped-at-spawn group can never be silently dropped.
	//
	// Liveness-aware (a real production incident, not hypothetical): a
	// generic "stale worktree" message previously read as an invitation to
	// manually `rm -rf`/`git worktree remove` the path — which, when the
	// worktree actually belonged to a still-running worker, destroyed live
	// session state mid-run and wasted real API spend, repeatedly, across
	// one dispatch session. Distinguish "still running" from "leftover" via
	// the SAME `.harness.pid` liveness check the watcher's own stall guard
	// uses (isPidAlive), and steer toward `orchestrate cleanup --apply`
	// specifically — NOT raw `git worktree remove`, which refuses on any
	// untracked file and can leave a stray `.headlesscode/` behind that
	// re-trips this exact check on the next attempt; `cleanup --apply`
	// removes harness artifacts (including `.headlesscode/`) and known-safe
	// residue BEFORE calling `git worktree remove`, precisely to avoid that
	// residue (see cleanup.ts's removeHarnessArtifacts/removeKnownSafeArtifacts).
	const staleWorktrees = specs
		.map((spec) => path.join(repo, ".worktrees", spec.name))
		.filter((wtPath) => fs.existsSync(wtPath))
	if (staleWorktrees.length > 0) {
		const details = staleWorktrees
			.map((wtPath) => {
				const rel = path.relative(repo, wtPath)
				return isPidAlive(wtPath) ? `${rel} (round IN PROGRESS — live pid)` : `${rel} (no live pid — likely leftover)`
			})
			.join(", ")
		process.stderr.write(
			`headlesscode orchestrate: worktree collision found: ${details}. ` +
				`If any are marked "round IN PROGRESS", do NOT delete them — that destroys a live session's state and spend. ` +
				`Retry once it finishes, or investigate with "headlesscode orchestrate status --repo ${repo}". ` +
				`For genuinely leftover worktrees, use "headlesscode orchestrate cleanup --repo ${repo} --apply" ` +
				`(only removes worktrees whose branch is verified merged, and clears .headlesscode/ before ` +
				`"git worktree remove" so it can't leave residue behind) — avoid raw "git worktree remove"/"rm -rf", ` +
				`which can leave a stray .headlesscode/ dir that re-trips this same check next time.\n`,
		)
		return 1
	}

	if (options.dryRun) {
		// Per-mode model assignment: resolve each role's model exactly like a
		// real round so the dry-run preview shows the effective model per role
		// (mode-models.json / _default / OPENROUTER_MODEL; explicit --model
		// always wins). undefined -> the OpenRouter client's built-in default.
		const previewModel = (mode: string): string =>
			resolveModelForMode({ workspaceRoot: repo, mode, explicitModel: options.model, env: process.env }) ??
			"deepseek/deepseek-v4-flash-0731 (client default)"
		// Issue #16: estimate the round's expected cost/iterations from
		// recorded cost history, keyed by issue shape. Advisory only — a
		// history read failure must never fail the dry-run, just omit the
		// section.
		let historyRecords: Awaited<ReturnType<typeof readCostHistory>> = []
		try {
			historyRecords = await readCostHistory(repo)
		} catch {
			historyRecords = []
		}
		const estimateSection = buildEstimateSection(estimateGroups(historyRecords, specs, issues), historyRecords.length)
		printPlan(repo, options.mode, specs, issues, {
			worker: previewModel(options.mode),
			reviewer: previewModel(options.reviewMode),
			qa: previewModel(options.qaMode),
		}, options.maxIterations, estimateSection,
			options.planFirst
				? { mode: options.planFirstMode, maxIterations: options.planFirstMaxIterations }
				: undefined,
		)
		return 0
	}

	if (!process.env.HEADLESSCODE_OPENROUTER_API_KEY) {
		process.stderr.write(
			"headlesscode orchestrate: HEADLESSCODE_OPENROUTER_API_KEY is not set (workers + reviewer need it).\n" +
				"  Use --dry-run to preview the plan without an API key.\n",
		)
		return 2
	}

	// 1a. Phase 6 GLOBAL concurrency cap (spec 6.3): abort BEFORE any work
	// (task files, spawn) when the fleet is already at/over the cap.
	// Cross-process view: orchestrator groups in spawned/running + watcher
	// in-flight 'spawned' entries. Fail-fast by design — orchestrate never
	// queues silently (the watcher's durable 'pending' state is the queueing
	// mechanism; see docs/phase6-cloud.md).
	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	const activeNow = activeSessionCountForRepo(repo)
	if (activeNow >= options.maxConcurrentSessions) {
		process.stderr.write(
			`headlesscode orchestrate: concurrency cap reached — ${activeNow} active session(s) ` +
				`(cap ${options.maxConcurrentSessions}, set via --max-concurrent-sessions or ` +
				`HEADLESSCODE_MAX_CONCURRENT_SESSIONS). This round was NOT spawned. ` +
				`Wait for running sessions to finish or raise the cap.\n`,
		)
		return 1
	}

	// 1a-sync. Issue #25: local master silently drifts unpushed from origin,
	// and every PR-merge cycle pays for it with re-merge conflict cascades.
	// At this "a new round is about to start" checkpoint, reconcile the two
	// (fetch origin, push local-only commits, fast-forward local onto origin)
	// so this round's branches start from what's actually on GitHub. Best-
	// effort auxiliary step: a failure is a loud warning, never an abort.
	// HEADLESSCODE_ORCHESTRATE_NO_SYNC=1 disables the mutation and only warns
	// on non-trivial drift (see git-sync.ts).
	if (process.env[ORCHESTRATE_SYNC_DISABLED_ENV]) {
		const drift = branchSyncStatus(repo)
		if (drift && drift.ahead > TRIVIAL_DRIFT_AHEAD) {
			process.stderr.write(
				`headlesscode orchestrate: WARNING: local ${drift.branch} is ${drift.ahead} commit(s) ahead of ${drift.remoteRef} ` +
					`(${ORCHESTRATE_SYNC_DISABLED_ENV} set — not pushing). Push it now to avoid merge-conflict cascades at ` +
					`PR-merge time (issue #25): git -C ${repo} push origin ${drift.branch}\n`,
			)
		}
	} else {
		const sync = syncBranchWithOrigin(repo)
		for (const line of syncSummaryLines(sync)) {
			process.stdout.write(`[sync] ${line}\n`)
		}
		for (const line of syncWarningLines(sync, repo)) {
			process.stderr.write(`headlesscode orchestrate: ${line}\n`)
		}
	}

	// 1a-pre. Issue #13 pre-spawn preflight probe: a cheap 1-token completion
	// using the EXACT model + provider pin a real worker will use, so a dead
	// key / exhausted account balance / down pinned provider fails NOW instead
	// of 30-80 iterations (10-15 min + real spend) into the round. Runs before
	// task files or spawn; --no-preflight skips it for CI/non-interactive
	// contexts that don't want the extra round-trip. The probe's model is
	// resolved exactly like the worker's first spawn (same resolveModelForMode
	// precedence as 1c below), so what we probe is what the worker will call.
	let preflightProbe: PreflightResult | LocalPreflightResult | undefined
	if (options.preflight) {
		// 2026-08-27: probe whichever backend the WORKER's mode will actually
		// use (see cli.ts's useLocalCodeBackend / reviewer.ts's runReview /
		// qa.ts's runQa — same gate, repeated here since orchestrate never
		// otherwise imports cli.ts). Before this, a round configured entirely
		// for the local daemon still probed OpenRouter/DeepSeek unconditionally
		// and aborted on a cloud key that round would never touch.
		const useLocalBackendForWorker =
			process.env.HEADLESSCODE_CODE_MODE_BACKEND === "ollama" &&
			(process.env.HEADLESSCODE_LOCAL_BACKEND_MODES ?? "code")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
				.includes(options.mode)
		try {
			if (useLocalBackendForWorker) {
				preflightProbe = await runLocalPreflight({
					model: options.model ?? resolvePerModeEnv("HEADLESSCODE_CODE_MODE_MODEL", options.mode),
					baseUrl: resolvePerModeEnv("HEADLESSCODE_OLLAMA_URL", options.mode),
				})
			} else {
				const workerModelForProbe = resolveModelForMode({
					workspaceRoot: repo,
					mode: options.mode,
					explicitModel: options.model,
					env: process.env,
				})
				const maxCostRaw = process.env.HEADLESSCODE_MAX_COST_USD
				const maxCostUsd = maxCostRaw !== undefined && maxCostRaw !== "" ? Number(maxCostRaw) : undefined
				preflightProbe = await runPreflight({
					model: workerModelForProbe,
					workerSessions: specs.length,
					maxCostUsd: maxCostUsd !== undefined && Number.isFinite(maxCostUsd) && maxCostUsd > 0 ? maxCostUsd : undefined,
				})
			}
		} catch (err) {
			// Neither probe throws by contract, but if either ever does the
			// round must not proceed on an unchecked gate.
			process.stderr.write(
				`headlesscode orchestrate: preflight probe crashed unexpectedly: ${err instanceof Error ? err.message : String(err)}\n`,
			)
			return 1
		}
		process.stdout.write(`[preflight] ${preflightProbe.line}\n`)
		if (preflightProbe.status !== "ok") {
			process.stderr.write(
				`headlesscode orchestrate: preflight FAILED (${preflightProbe.status}) — aborting before any workers spawn. ` +
					`Fix the problem above, or use --no-preflight to skip this check.\n`,
			)
			return 1
		}
	}

	// 1b. Task files.
	const written = writeTaskFiles(repo, specs, issues, { planFirst: options.planFirst })
	process.stdout.write(`Wrote ${written.length} task file(s) under ${path.join(repo, "plans", "parallel-tasks")}\n`)

	// 1c. Per-mode model assignment for the WORKER'S FIRST SPAWN. This must
	// resolve BEFORE step 2's spawnSync: the spawner script (and through it
	// run-worker.sh) inherits OPENROUTER_MODEL from the environment, so a
	// mode-models.json entry for the worker's mode would otherwise be silently
	// ignored on the first attempt (it only kicked in on rework re-spawns).
	// resolveModelForMode's own precedence holds here: an explicit --model
	// flag beats the config file, which beats OPENROUTER_MODEL.
	const { env: spawnEnv, workerModel } = buildSpawnEnv({
		repo,
		mode: options.mode,
		explicitModel: options.model,
		memoryDir: options.memoryDir,
		maxIterations: options.maxIterations,
		planFirst: options.planFirst,
		planFirstMode: options.planFirstMode,
		planFirstMaxIterations: options.planFirstMaxIterations,
		env: process.env,
	})

	// 2. Spawn (the bash script is the actual spawner; cwd = target repo so
	//    `git rev-parse --show-toplevel` resolves there).
	const spawnCmd = `bash ${path.join(HARNESS_ROOT_TS, "scripts", "spawn-parallel-worktrees.sh")} ${specs
		.map((spec) => `${spec.name}:${specs.indexOf(spec)}:plans/parallel-tasks/${spec.taskFile}`)
		.join(" ")}`
	process.stdout.write(`Spawn: ${spawnCmd}\n`)
	// `bash -c <spawnCmd>` (NOT spawnSync("bash", [spawnCmd], { shell: true }),
	// which would run `bash bash <script> …` and die with "cannot execute
	// binary file").
	const spawnResult = spawnSync("bash", ["-c", spawnCmd], {
		cwd: repo,
		env: spawnEnv,
		stdio: "inherit",
	})
	if (spawnResult.status !== 0) {
		process.stderr.write(`headlesscode orchestrate: spawn script failed (exit ${spawnResult.status})\n`)
		return 1
	}

	// 3. Record batch + groups in the state file (the spawner already wrote
	//    group entries; add the batch id).
	const batch = options.batch ?? `round-${new Date().toISOString().slice(0, 10)}`
	try {
		// Issue #80: the whole load-merge-save below runs inside mutateState's
		// cross-process lock. Without it, two concurrent `orchestrate` invocations
		// against the same repo (explicitly supported — see the concurrency
		// budget check above) can both loadState the same on-disk snapshot, then
		// whichever saveState runs last silently discards the other's round's
		// groups. patchGroup already guards single-group patches this way; this
        // is the same guarantee for this multi-group initial-write transaction.
		await mutateState(statePath, async (fresh) => {
			let state = fresh
			state.batch = batch
			// Issue #16: stamp every group with its per-issue shape (split.ts's
			// issueShape) at dispatch time — the only moment the issue titles/bodies
			// are in hand. cost-history recording happens LATER (when the group
			// reaches a terminal status, possibly in a separate orchestrate
			// invocation) and only has issue numbers; the shape is what lets
			// cost-estimate.ts match a NEW task to similar past ones, so it must be
			// captured here and persisted in the state file (OrchestratorGroup.shapes).
			// The titles/bodies themselves are captured at the same moment into
			// OrchestratorGroup.issueBodies: the rework/QA/continuation task files are
			// generated LATER from state alone (a separate orchestrate invocation) and
			// need them to embed each issue's real title/body inline instead of a
			// runtime `gh issue view` (which fails for synthetic --issues-json
			// numbers).
			const shapeByNumber = new Map<number, string>()
			const issueBodiesByNumber = new Map<number, { title: string; body?: string }>()
			for (const issue of issues) {
				shapeByNumber.set(issue.number, issueShape(issue))
				issueBodiesByNumber.set(issue.number, { title: issue.title, body: issue.body })
			}
			const groupNamesOnDisk = new Set(state.groups.map((g) => g.name))
			for (const spec of specs) {
				if (!groupNamesOnDisk.has(spec.name)) {
					continue
				}
				const shapes = spec.issues.map((n) => shapeByNumber.get(n) ?? "generic")
				const issueBodies: IssueBodies = {}
				for (const n of spec.issues) {
					const entry = issueBodiesByNumber.get(n)
					if (entry) {
						issueBodies[String(n)] = entry
					}
				}
				state = updateGroup(state, spec.name, { shapes, issueBodies })
			}
			// Issue #13: persist the preflight probe so the dashboard can surface the
			// preflight line on the round view (see aggregate.ts RoundSummary.preflight).
			if (preflightProbe) {
				// LocalPreflightResult has no cost fields at all (local inference
				// is genuinely free) — default to 0/undefined rather than widen
				// PreflightRecord's required probeCostUsd to optional for a case
				// that's always a real number either way.
				state.preflight = {
					status: preflightProbe.status,
					model: preflightProbe.model,
					baseUrl: preflightProbe.baseUrl,
					line: preflightProbe.line,
					latencyMs: preflightProbe.latencyMs,
					probeCostUsd: "probeCostUsd" in preflightProbe ? preflightProbe.probeCostUsd : 0,
					roundCostEstimateUsd: "roundCostEstimateUsd" in preflightProbe ? preflightProbe.roundCostEstimateUsd : undefined,
				}
			}
			return state
		})
	} catch (err) {
		if (!(err instanceof SyntaxError)) {
			// Not a corrupt-JSON case (e.g. the cross-process lock timed out) —
			// nothing to back up, just report and abort loudly.
			process.stderr.write(
				`headlesscode orchestrate: failed to record round state in ${statePath}: ` +
					`${err instanceof Error ? err.message : String(err)}\n`,
			)
			return 1
		}
		// Issue #77: loadState (inside mutateState) only throws SyntaxError for a
		// genuinely corrupt/truncated state file (ENOENT is already handled
		// inside loadState and returns a fresh default). Silently replacing it
		// here would destroy every group's status/review verdict with no
		// warning. Back the corrupt file up so it isn't lost, then refuse to
		// start rather than clobber it.
		const backupPath = `${statePath}.corrupt-${Date.now()}`
		try {
			await fs.promises.rename(statePath, backupPath)
		} catch {
			/* best-effort backup; fall through to the loud abort either way */
		}
		process.stderr.write(
			`headlesscode orchestrate: state file ${statePath} is corrupt and could not be parsed ` +
				`(${err.message}). Backed up to ${backupPath}. ` +
				`Refusing to start with an empty state — restore or repair the backup, then retry.\n`,
		)
		return 1
	}

	// 4. Watch + review. Per-mode model assignment: each role resolves its OWN
	// model — workers use the group's mode (resolved in 1c, above — the SAME
	// const reused here for the rework loop), the reviewer uses reviewMode, QA
	// uses qaMode. An explicit --model flag beats every mode's config entry
	// (resolveModelForMode precedence rule 1), so a blanket override still
	// works exactly as before.
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

	process.stdout.write("Watching for worker completion (.harness.done markers)...\n")
	await watchGroups({
		repoRoot: repo,
		statePath,
		pollIntervalMs: options.pollIntervalMs,
		reviewEnabled: options.review,
		qaEnabled: options.qa,
		onGroupUpdate: async (group) => {
			// Auto-continue on iteration-exhaustion (issue #2 Part 2): a worker
			// that failed ONLY because it hit --max-iterations gets a fresh
			// session on the SAME worktree (the partial state is on disk), up
			// to --max-continuations, then the group is marked needs-human.
			// Runs regardless of --no-review (this is about worker failure, not
			// review routing) and never triggers for budget stops or real
			// errors — handleIterationExhaustion's empty patch keeps "failed".
			if (group.status === "failed") {
				const decision = handleIterationExhaustion(
					group,
					repo,
					options.maxContinuations,
					options.mode,
					workerModel,
					options.maxIterations,
				)
				if (decision.shouldSpawn && decision.taskFilePath && decision.taskContent && decision.spawnCommand) {
					fs.mkdirSync(path.dirname(decision.taskFilePath), { recursive: true })
					fs.writeFileSync(decision.taskFilePath, decision.taskContent, "utf-8")
					process.stdout.write(
						`[orchestrate] ${group.name} continuation ${decision.newContinuationCount}: ` +
							`previous worker hit the iteration cap; wrote ${path.relative(repo, decision.taskFilePath)}; ` +
							`re-spawning worker on the same worktree...\n`,
					)
					const spawnResult = spawnSync("bash", ["-c", decision.spawnCommand], {
						cwd: repo,
						env: {
							...process.env,
							HEADLESSCODE_ROOT: HARNESS_ROOT_TS,
							...(options.memoryDir ? { HEADLESSCODE_MEMORY_DIR: path.resolve(options.memoryDir) } : {}),
						},
						stdio: "inherit",
					})
					if (spawnResult.status !== 0) {
						// The continuation worker could not be launched — the
						// group cannot continue itself, so surface it as needing
						// a human instead of leaving a dangling "running" group.
						process.stderr.write(
							`[orchestrate] continuation spawn for ${group.name} failed (exit ${spawnResult.status}); ` +
								`marking group needs-human\n`,
						)
						// patchGroup reloads the state file fresh immediately
						// before merging (under a write lock) rather than basing
						// the merge on `currentState` — a stale snapshot that may
						// predate other groups' concurrent writes now that
						// review/QA for multiple groups can run in parallel
						// (issue #24).
						await patchGroup(statePath, group.name, {
							status: "needs-human",
							continuationCount: decision.newContinuationCount,
							last_activity: {
								note: `continuation spawn failed after ${decision.newContinuationCount} attempt(s); needs human`,
							},
						})
					} else {
						// Spawn succeeded: reset the group so the watcher re-polls
						// it as "running" → "done/failed" → re-continued exactly
						// like a first attempt.
						await patchGroup(statePath, group.name, decision.patch)
					}
					return true
				}
				if (decision.patch.status === "needs-human") {
					// Continuation cap reached: terminal "needs-human" outcome.
					await patchGroup(statePath, group.name, decision.patch)
					process.stderr.write(
						`[orchestrate] NEEDS-HUMAN: ${group.name} exhausted ${decision.newContinuationCount} continuation ` +
							`attempt(s) and still hits the iteration cap — a human must look at this worktree.\n`,
					)
					return true
				}
				// Real failure (not iteration exhaustion): stays failed.
				return
			}

			// Deterministic post-hoc log analysis: runs once per group as soon
			// as it reaches "done", unconditionally (no --review/--qa gate, no
			// LLM cost) — the same tool-call/error/stall/repeated-command
			// findings a human would otherwise get by hand-reading harness.log
			// + events.jsonl. Never blocks review/QA below; a failure here is
			// logged and swallowed.
			if (group.status === "done" && group.log_analysis === undefined) {
				try {
					const analysis = await analyzeWorktreeSessions(groupWorktreePath(repo, group))
					const patch = {
						log_analysis: analysis
							? {
									findings: analysis.findings,
									toolCallCounts: analysis.toolCallCounts,
									toolErrorCounts: analysis.toolErrorCounts,
									analyzedAt: new Date().toISOString(),
								}
							: (false as const),
					}
					await patchGroup(statePath, group.name, patch)
					if (analysis && analysis.findings.length > 0) {
						process.stdout.write(
							`[orchestrate] ${group.name} log analysis: ${analysis.findings.length} finding(s):\n` +
								analysis.findings.map((f) => `    - ${f}\n`).join(""),
						)
					}
				} catch (err) {
					process.stderr.write(
						`[orchestrate] log analysis of ${group.name} failed: ${err instanceof Error ? err.message : String(err)}\n`,
					)
				}
			}

			if (!options.review) {
				return
			}
			if (group.status !== "done" || group.review_verdict !== undefined) {
				return
			}
			process.stdout.write(`[orchestrate] reviewing ${group.name} (branch ${group.branch ?? "?"})...\n`)
			try {
				const result = await runReviewWithRetries({
					workspaceRoot: groupWorktreePath(repo, group),
					mode: options.reviewMode,
					model: reviewerModel,
				})
				// A review-SESSION failure must not feed into the rework-a-worker
				// path below — see handleReviewSessionError's doc comment.
				if (result.verdict === "error") {
					await patchGroup(statePath, group.name, handleReviewSessionError(result))
					process.stderr.write(
						`[orchestrate] NEEDS-HUMAN: ${group.name}'s review session failed repeatedly — ` +
							`${result.summary}\n`,
					)
					return true
				}
				const patch = {
					review_verdict: result.verdict,
					pending_review_findings: result.findings,
					reviewed_at: new Date().toISOString(),
					// Issue #34: point at the review session's complete final
					// report so the full reasoning behind the verdict is one
					// file-read away, not a re-run away.
					review_report: result.reportPath,
					last_activity: {
						note: `reviewed: verdict=${result.verdict} (${result.findings.length} finding(s))`,
					},
				}
				await patchGroup(statePath, group.name, patch)
				process.stdout.write(
					`[orchestrate] ${group.name} review verdict: ${result.verdict} (${result.findings.length} finding(s))\n`,
				)

				// Rework loop (plans/rework-loop.md): a "finding" verdict is
				// treated as NEW WORK — re-spawn a worker on the SAME worktree to
				// fix the findings, up to --max-rework-cycles attempts. Returning
				// true tells watchGroups to reload state from disk so it re-polls
				// the group as "running" → "done" → re-reviewed (the watcher's
				// in-memory state is otherwise stale — see watchGroups).
				if (result.verdict === "finding") {
					const decision = handleReviewVerdict(
						group,
						result,
						repo,
						options.maxReworkCycles,
						options.mode,
						workerModel,
						options.maxIterations,
					)
					if (decision.shouldSpawn && decision.taskFilePath && decision.taskContent && decision.spawnCommand) {
						fs.mkdirSync(path.dirname(decision.taskFilePath), { recursive: true })
						fs.writeFileSync(decision.taskFilePath, decision.taskContent, "utf-8")
						process.stdout.write(
							`[orchestrate] ${group.name} rework cycle ${decision.newReworkCount}: ` +
								`wrote ${path.relative(repo, decision.taskFilePath)}; re-spawning worker on the same worktree...\n`,
						)
						const spawnResult = spawnSync("bash", ["-c", decision.spawnCommand], {
							cwd: repo,
							env: {
								...process.env,
								HEADLESSCODE_ROOT: HARNESS_ROOT_TS,
								...(options.memoryDir ? { HEADLESSCODE_MEMORY_DIR: path.resolve(options.memoryDir) } : {}),
							},
							stdio: "inherit",
						})
						if (spawnResult.status !== 0) {
							// The rework worker could not be launched — the group
							// cannot fix itself, so surface it as needing a human
							// instead of leaving a dangling "running" group.
							process.stderr.write(
								`[orchestrate] rework worker spawn for ${group.name} failed (exit ${spawnResult.status}); ` +
									`marking group needs-human\n`,
							)
							await patchGroup(statePath, group.name, {
								status: "needs-human",
								reworkCount: decision.newReworkCount,
								last_activity: {
									note: `rework spawn failed after ${decision.newReworkCount} attempt(s); needs human`,
								},
							})
						} else {
							// Spawn succeeded: reset the group so the watcher
							// re-polls it as "running" → "done" → re-reviewed.
							await patchGroup(statePath, group.name, decision.patch)
						}
						return true
					}
					// Cap reached: terminal "needs-human" outcome. Findings stay
					// recorded so a human can see exactly what the reviewer flagged.
					await patchGroup(statePath, group.name, decision.patch)
					process.stderr.write(
						`[orchestrate] NEEDS-HUMAN: ${group.name} exhausted ${decision.newReworkCount} rework ` +
							`attempt(s) and the review still has findings — a human must look at this worktree.\n`,
					)
					return true
				}
			} catch (err) {
				process.stderr.write(
					`[orchestrate] review of ${group.name} failed: ${err instanceof Error ? err.message : String(err)}\n`,
				)
			}
			// Phase 4: after a group's workers complete AND review passes, run a
			// headless QA session against that worktree. QA only runs when review
			// was clean (or review was disabled); the result is recorded in the
			// group's `qa` field. QA uses read+command tools only — it can boot
			// the app and run tests but cannot modify source files.
			if (!options.qa) {
				return
			}
			if (group.status !== "done" || group.qa !== undefined) {
				return
			}
			// The callback's `group` is the pre-review snapshot; the review
			// verdict lives in the state file we just persisted via patchGroup,
			// so read it fresh from disk rather than any in-memory copy —
			// review/QA for other groups can be writing concurrently now
			// (issue #24), so a captured snapshot here could be stale.
			const updatedGroup = loadStateSync(statePath).groups.find((g) => g.name === group.name)
			const reviewPassed = !options.review || updatedGroup?.review_verdict === "clean"
			if (!reviewPassed) {
				return
			}
			process.stdout.write(`[orchestrate] QA ${group.name} (branch ${group.branch ?? "?"})...\n`)
			try {
				const qaResult = await runQaWithRetries({
					workspaceRoot: groupWorktreePath(repo, group),
					mode: options.qaMode,
					model: qaModel,
				})
				// A QA-SESSION failure (crash/budget/mistake-limit/no result —
				// see runQaWithRetries) survived every retry: verdict "error",
				// distinct from a real "fail". Must escalate to needs-human, NOT
				// silently record a "failed"-looking QA with empty evidence and
				// leave the group's top-level status "done" — that would settle
				// the round (cost recorded, nothing left to retry) while QA never
				// actually validated anything. Caught live 2026-08-05 on issue
				// #18's own round: the QA-side twin of #33's review bug.
				if (qaResult.verdict === "error") {
					await patchGroup(statePath, group.name, handleQaSessionError(qaResult))
					process.stderr.write(
						`[orchestrate] NEEDS-HUMAN: ${group.name}'s QA session failed repeatedly — ` +
							`${qaResult.summary}\n`,
					)
					return
				}
				// A real QA FAIL verdict is NEW WORK, not a settled "done"
				// (issue #52, caught live 2026-08-05): the group passed review
				// but QA caught real problems. Auto-spawn a rework cycle on the
				// SAME worktree exactly like a review finding, feeding the QA
				// evidence into the task file instead of review findings, up to
				// --max-rework-cycles. At the cap the group goes terminal
				// needs-human — it must never silently settle as "done" with
				// only the nested qa.status showing "failed".
				if (qaResult.verdict === "fail") {
					const decision = handleQaVerdict(
						group,
						qaResult,
						repo,
						options.maxReworkCycles,
						options.mode,
						workerModel,
						options.maxIterations,
					)
					if (decision.shouldSpawn && decision.taskFilePath && decision.taskContent && decision.spawnCommand) {
						fs.mkdirSync(path.dirname(decision.taskFilePath), { recursive: true })
						fs.writeFileSync(decision.taskFilePath, decision.taskContent, "utf-8")
						process.stdout.write(
							`[orchestrate] ${group.name} QA-fail rework cycle ${decision.newReworkCount}: ` +
								`wrote ${path.relative(repo, decision.taskFilePath)}; re-spawning worker on the same worktree...\n`,
						)
						const spawnResult = spawnSync("bash", ["-c", decision.spawnCommand], {
							cwd: repo,
							env: {
								...process.env,
								HEADLESSCODE_ROOT: HARNESS_ROOT_TS,
								...(options.memoryDir ? { HEADLESSCODE_MEMORY_DIR: path.resolve(options.memoryDir) } : {}),
							},
							stdio: "inherit",
						})
						if (spawnResult.status !== 0) {
							// The QA-fail rework worker could not be launched —
							// the group cannot fix itself, so surface it as
							// needing a human instead of leaving a dangling
							// "running" group (same as the review-finding path).
							process.stderr.write(
								`[orchestrate] QA-fail rework worker spawn for ${group.name} failed (exit ${spawnResult.status}); ` +
									`marking group needs-human\n`,
							)
							await patchGroup(statePath, group.name, {
								status: "needs-human",
								reworkCount: decision.newReworkCount,
								qa: {
									status: "failed",
									verdict: qaResult.verdict,
									evidence: qaResult.evidence.slice(0, 4000),
									report: qaResult.reportPath,
									updated: new Date().toISOString(),
								},
								last_activity: {
									note: `QA-fail rework spawn failed after ${decision.newReworkCount} attempt(s); needs human`,
								},
							})
						} else {
							// Spawn succeeded: reset the group so the watcher
							// re-polls it as "running" → "done" → re-reviewed
							// → re-QA'd.
							await patchGroup(statePath, group.name, decision.patch)
						}
						return true
					}
					// Cap reached: terminal "needs-human" outcome. The QA
					// verdict/evidence stay recorded so a human can see
					// exactly what failed.
					await patchGroup(statePath, group.name, decision.patch)
					process.stderr.write(
						`[orchestrate] NEEDS-HUMAN: ${group.name} exhausted ${decision.newReworkCount} rework ` +
							`attempt(s) and QA still fails — a human must look at this worktree.\n`,
					)
					return true
				}
				await patchGroup(statePath, group.name, {
					qa: {
						status: "done",
						verdict: "pass",
						evidence: qaResult.evidence.slice(0, 4000),
						// Issue #34: the state file keeps the lightweight parsed
						// fields for quick scanning; point at the QA session's
						// COMPLETE final report so the full reasoning behind the
						// verdict is one file-read away, not a re-run away.
						report: qaResult.reportPath,
						updated: new Date().toISOString(),
					},
					last_activity: {
						note: "QA: verdict=pass",
					},
				})
				process.stdout.write(
					`[orchestrate] ${group.name} QA verdict: pass (status done)\n`,
				)
			} catch (err) {
				process.stderr.write(
					`[orchestrate] QA of ${group.name} failed: ${err instanceof Error ? err.message : String(err)}\n`,
				)
			}
		},
	})

	// Reload the state from disk: onGroupUpdate persisted the review/QA
	// patches through the state FILE (the watcher's in-memory copy only tracks
	// worker completion), so the authoritative post-round state is on disk.
	const finalState = await loadState(statePath)

	const terminal = finalState.groups.filter(
		(g) => g.status === "done" || g.status === "failed" || g.status === "needs-human",
	)
	process.stdout.write(
		`\nRound complete: ${terminal.length}/${finalState.groups.length} groups terminal. State: ${statePath}\n`,
	)
	const failed = finalState.groups.filter((g) => g.status === "failed")
	if (failed.length > 0) {
		process.stderr.write(
			`headlesscode orchestrate: ${failed.length} group(s) failed: ${failed.map((g) => g.name).join(", ")}\n`,
		)
		return 1
	}
	// Rework-exhausted groups are a DISTINCT, final "needs a human" outcome —
	// not a mid-review group and not a generic failure. Exit 1 like a failure
	// (the round did not fully succeed) but the message names the cause.
	const needsHuman = finalState.groups.filter((g) => g.status === "needs-human")
	if (needsHuman.length > 0) {
		process.stderr.write(
			`headlesscode orchestrate: ${needsHuman.length} group(s) need a human (rework/continuation ` +
				`attempts exhausted): ${needsHuman.map((g) => g.name).join(", ")}. ` +
				`See ${statePath} for their review_verdict/pending_review_findings and continuationCount.\n`,
		)
		return 1
	}

	// Phase 4: human-approval deploy gate (--deploy). Runs ONLY when every
	// group is done, no group failed, every review is clean (when review is
	// enabled) and every QA verdict is pass (when --qa was passed). The gate
	// itself is a hard stop: scripts/deploy-gate.sh never invokes the repo's
	// deploy-production.sh without explicit human approval.
	if (options.deploy) {
		const gate = deployGateReady(finalState, options)
		if (!gate.ready) {
			process.stderr.write(
				`headlesscode orchestrate: deploy gate SKIPPED — ${gate.reason}. No deploy was attempted.\n`,
			)
			return 1
		}
		const batch = options.batch ?? `round-${new Date().toISOString().slice(0, 10)}`
		const gateCmd = [
			`bash ${path.join(HARNESS_ROOT_TS, "scripts", "deploy-gate.sh")}`,
			`"${repo}"`,
			`--batch "${batch}"`,
			options.deployArgs ? `--deploy-args "${options.deployArgs}"` : "",
		]
			.filter(Boolean)
			.join(" ")
		process.stdout.write(`[orchestrate] running deploy gate...\n`)
		// Same `bash -c` pattern as the spawn call above (no double-bash).
		const gateResult = spawnSync("bash", ["-c", gateCmd], {
			cwd: repo,
			env: { ...process.env },
			stdio: "inherit",
		})
		if (gateResult.status === 3) {
			process.stderr.write(
				"headlesscode orchestrate: deploy DENIED by the human-approval gate. deploy-production.sh was NOT run.\n",
			)
			return 1
		}
		if (gateResult.status !== 0) {
			process.stderr.write(
				`headlesscode orchestrate: deploy gate failed (exit ${gateResult.status}). No deploy was attempted.\n`,
			)
			return 1
		}
		process.stdout.write("[orchestrate] deploy approved by the gate and executed.\n")
	}
	return 0
}

/**
	* Phase 4: decide whether the deploy gate may run after a round. Fail-closed:
	* returns { ready: false, reason } unless every group is done, none failed,
	* every review is clean (when review is enabled) and every QA verdict is pass
	* (when --qa was passed). A group that never got a QA record (e.g. review
	* found issues) blocks the deploy.
	*/
function deployGateReady(
	state: OrchestratorState,
	options: OrchestrateOptions,
): { ready: boolean; reason?: string } {
	if (state.groups.length === 0) {
		return { ready: false, reason: "no groups in state" }
	}
	const anyFailed = state.groups.some((g) => g.status === "failed")
	if (anyFailed) {
		return { ready: false, reason: "one or more groups failed" }
	}
	// Rework/continuation-exhausted groups: a distinct, final "needs a human"
	// outcome — the deploy must never proceed while one exists, and the reason
	// must say why (not a generic failure, not an in-flight review).
	const anyNeedsHuman = state.groups.some((g) => g.status === "needs-human")
	if (anyNeedsHuman) {
		return { ready: false, reason: "one or more groups need human attention (rework/continuation attempts exhausted)" }
	}
	const anyNotDone = state.groups.some((g) => g.status !== "done")
	if (anyNotDone) {
		return { ready: false, reason: "not all groups reached status done" }
	}
	if (options.review) {
		const anyUnreviewed = state.groups.some((g) => g.review_verdict !== "clean")
		if (anyUnreviewed) {
			return { ready: false, reason: "not all groups reviewed clean" }
		}
	}
	if (options.qa) {
		const anyQaUnpassed = state.groups.some((g) => g.qa?.verdict !== "pass")
		if (anyQaUnpassed) {
			return { ready: false, reason: "not all groups passed QA" }
		}
	}
	return { ready: true }
}
