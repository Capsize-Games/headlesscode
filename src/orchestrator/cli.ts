/**
 * `headlesscode orchestrate` subcommand — the thin orchestrator entry point.
 *
 *   npx tsx src/cli.ts orchestrate --repo <path> --issue 27 --issue 29 \
 *       [--mode code] [--issues-json <path>] [--dry-run] [--no-review]
 *
 * Flow:
 *   1. Read issues (airunner-style `gh issue view --json number,title,body`
 *      when gh is available, else `--issues-json <file>`).
 *   2. Split them into worktree groups with splitIssues (the airunner
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

import { execFileSync, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { activeSessionCountForRepo, maxConcurrentSessionsFromEnv } from "../budget/concurrency.js"
import { splitIssues, type SplitIssue, type WorktreeSpec } from "./split.js"
import { loadState, saveState, updateGroup, type OrchestratorGroup, type OrchestratorState } from "./state.js"
import { runReview, type ReviewResult } from "./reviewer.js"
import { runQa } from "../qa/qa.js"
import { groupWorktreePath, watchGroups } from "./watch.js"
import { resolveModelForMode } from "../config/mode-models.js"

const ORCHESTRATE_USAGE = `headlesscode orchestrate — Phase 2 parallel round

Usage:
  headlesscode orchestrate --repo <path> --issue <n> [--issue <n> ...] [options]
  headlesscode orchestrate --repo <path> --issues-json <file> [options]

Options:
  --repo <path>          Target repo root (required)
  --issue <n>            Issue number to include (repeatable)
  --issues-json <file>   Read issues from a JSON array of {number,title,body}
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
  --dry-run              Print the split plan + spawn commands, spawn nothing
  --help                 Show this help and exit

Environment:
  OPENROUTER_API_KEY     Required for a real run (workers + reviewer + QA)
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
`

interface OrchestrateOptions {
	repo: string
	issues: number[]
	issuesJson?: string
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
	dryRun: boolean
	help: boolean
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
		pollIntervalMs: 5000,
		maxConcurrentSessions: maxConcurrentSessionsFromEnv(),
		maxReworkCycles: 3,
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

export function buildTaskFileContent(spec: WorktreeSpec, issues: SplitIssue[]): string {
	const assigned = spec.issues.map((n) => `#${n}`).join(", ")
	const ghLines = spec.issues.map((n) => `gh issue view ${n}`).join("\n")
	return [
		"Before anything else: read `.roo/rules-code/rules.md` in full (or `.roo/rules/rules.md` if",
		"rules-code is absent) and treat it as binding for this entire session, regardless of whether",
		"it auto-loaded for whatever mode you're running in — don't assume it applied, read it yourself.",
		"",
		"You are working autonomously in an isolated git worktree, on your own branch, with your own",
		"isolated environment. No human is in the loop until you open a PR. Read this entire file before",
		"doing anything.",
		"",
		"## Your assignment",
		"",
		`GitHub issues assigned to this worktree: ${assigned}. Fetch each issue's real body yourself:`,
		"```",
		ghLines,
		"```",
		"Do not rely on a stale copy of any issue body.",
		"",
		"## Hard-won lessons",
		"",
		"- Never delete a public name without grepping the ENTIRE codebase for every importer — including",
		"  string-literal references (dispatch tables, getattr-by-name) and test files that import for",
		"  side effects (pytest fixtures, registration).",
		"- Re-run real checks (tests, boot) after every change and paste the real output in your report —",
		"  output in a report is a claim, not evidence, until reproduced.",
		"- If you find yourself repeating the same check across issues, script it under scripts/.",
		"",
		"## Environment",
		"",
		`Workspace root: this worktree (branch: current branch). All file/command tools are scoped to`,
		"this worktree. Commit per logical unit with the issue number in the message.",
		"",
		"## Workflow",
		"",
		"1. Read each assigned issue body via `gh issue view <n>` and the relevant source files.",
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

export function writeTaskFiles(repo: string, specs: WorktreeSpec[], issues: SplitIssue[]): string[] {
	const dir = path.join(repo, "plans", "parallel-tasks")
	fs.mkdirSync(dir, { recursive: true })
	const written: string[] = []
	for (const spec of specs) {
		const target = path.join(dir, spec.taskFile)
		fs.writeFileSync(target, buildTaskFileContent(spec, issues), "utf-8")
		written.push(target)
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
	group: { name: string; issues?: number[] },
	findings: string[],
	reworkCount: number,
): string {
	const assigned = (group.issues ?? []).map((n) => `#${n}`).join(", ") || "this worktree"
	const ghLines = (group.issues ?? []).map((n) => `gh issue view ${n}`).join("\n")
	const findingsList = findings.length > 0 ? findings.map((f, i) => `${i + 1}. ${f}`).join("\n") : ""
	return [
		"Before anything else: read `.roo/rules-code/rules.md` in full (or `.roo/rules/rules.md` if",
		"rules-code is absent) and treat it as binding for this entire session, regardless of whether",
		"it auto-loaded for whatever mode you're running in — don't assume it applied, read it yourself.",
		"",
		"You are working autonomously in the SAME isolated git worktree as the previous attempt, on",
		"the same branch. The automated adversarial reviewer found problems with that attempt. Read",
		"this entire file before doing anything.",
		"",
		`## Rework cycle ${reworkCount} — address the review findings`,
		"",
		`Assigned issues: ${assigned}. Fetch each issue's real body yourself (do not rely on a stale`,
		"copy of any issue body):",
		"```",
		ghLines || "# (no issue numbers recorded — inspect the worktree for context)",
		"```",
		"",
		"## Review findings to fix (from the automated review)",
		"",
		...findingsList.split("\n"),
		...(findingsList === "" ? ["(no specific findings were recorded — re-read the previous attempt's", "diff and re-verify everything the reviewer might have flagged.)"] : []),
		"",
		"Your job: address EVERY finding above. Do not skip any. Do not claim a finding is fixed",
		"without reproducing the fix for real.",
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
): ReworkDecision {
	const currentRework = typeof group.reworkCount === "number" ? group.reworkCount : 0
	const newReworkCount = currentRework + 1
	const now = new Date().toISOString()

	if (currentRework < maxReworkCycles) {
		const taskFilePath = path.join(repo, "plans", "parallel-tasks", `${group.name}-rework${newReworkCount}.md`)
		const taskContent = buildReworkTaskFileContent(group, result.findings, newReworkCount)
		const worktreePath = groupWorktreePath(repo, group)
		const spawnCommand =
			`bash ${path.join(HARNESS_ROOT_TS, "scripts", "run-worker.sh")} ` +
			`"${worktreePath}" "${taskFilePath}" --mode "${mode}"` +
			(model ? ` --model "${model}"` : "")
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
				qa: undefined,
				stalled: undefined,
				exit_code: undefined,
				summary: undefined,
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
	}
	return { env, workerModel }
}

function printPlan(
	repo: string,
	mode: string,
	specs: WorktreeSpec[],
	issues: SplitIssue[],
	models?: { worker: string; reviewer: string; qa: string },
): void {
	const shapeNotes = new Map<number, string>()
	for (const issue of issues) {
		const hot = /(request|handler|migration|database|session|auth|encryption|crypto|password|token)/i.test(
			`${issue.title}\n${issue.body ?? ""}`,
		)
		const shape = hot
			? "hot-path isolated"
			: /split/i.test(issue.title)
				? "same-shape: split"
				: /coverage/i.test(issue.title)
					? "same-shape: coverage"
					: /test/i.test(issue.title)
						? "same-shape: tests"
						: /docs/i.test(issue.title)
							? "same-shape: docs"
							: /refactor/i.test(issue.title)
								? "same-shape: refactor"
								: "generic"
		shapeNotes.set(issue.number, shape)
	}

	process.stdout.write("── Orchestrate plan (dry run) ─────────────────────────────\n")
	process.stdout.write(`  repo:     ${repo}\n`)
	process.stdout.write(`  mode:     ${mode}\n`)
	if (models) {
		process.stdout.write(`  models:   worker: ${models.worker}\n`)
		process.stdout.write(`            reviewer: ${models.reviewer}\n`)
		process.stdout.write(`            QA: ${models.qa}\n`)
	}
	process.stdout.write(`  issues:   ${issues.map((i) => i.number).join(", ")}\n\n`)
	process.stdout.write("Split plan (heuristics from the airunner multi-agent-orchestrator mode):\n")
	for (const spec of specs) {
		const reasons = spec.issues.map((n) => shapeNotes.get(n) ?? "generic").join(", ")
		process.stdout.write(
			`  ${spec.name.padEnd(4)} issue ${spec.issues.join(", ").padEnd(10)} -> plans/parallel-tasks/${spec.taskFile}  (${reasons})\n`,
		)
	}
	process.stdout.write("\nSpawn commands:\n")
	process.stdout.write(`  ${spawnCommandFor(HARNESS_ROOT_TS, specs)}\n`)
}

/** Resolve this harness repo's root (parent of src/orchestrator). */
const HARNESS_ROOT_TS = fileURLToPath(new URL("../..", import.meta.url))

// ─── Main ────────────────────────────────────────────────────────────────────

export async function orchestrateMain(argv: string[]): Promise<number> {
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

	const specs = splitIssues(issues)
	if (options.dryRun) {
		// Per-mode model assignment: resolve each role's model exactly like a
		// real round so the dry-run preview shows the effective model per role
		// (mode-models.json / _default / OPENROUTER_MODEL; explicit --model
		// always wins). undefined -> the OpenRouter client's built-in default.
		const previewModel = (mode: string): string =>
			resolveModelForMode({ workspaceRoot: repo, mode, explicitModel: options.model, env: process.env }) ??
			"deepseek/deepseek-chat (client default)"
		printPlan(repo, options.mode, specs, issues, {
			worker: previewModel(options.mode),
			reviewer: previewModel(options.reviewMode),
			qa: previewModel(options.qaMode),
		})
		return 0
	}

	if (!process.env.OPENROUTER_API_KEY) {
		process.stderr.write(
			"headlesscode orchestrate: OPENROUTER_API_KEY is not set (workers + reviewer need it).\n" +
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

	// 1b. Task files.
	const written = writeTaskFiles(repo, specs, issues)
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
	let state: OrchestratorState = { batch, groups: [] }
	try {
		state = await loadState(statePath)
	} catch {
		state = { batch, groups: [] }
	}
	state.batch = batch
	await saveState(statePath, state)

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
		onGroupUpdate: async (group, currentState) => {
			if (!options.review) {
				return
			}
			if (group.status !== "done" || group.review_verdict !== undefined) {
				return
			}
			process.stdout.write(`[orchestrate] reviewing ${group.name} (branch ${group.branch ?? "?"})...\n`)
			try {
				const result = await runReview({
					workspaceRoot: groupWorktreePath(repo, group),
					mode: options.reviewMode,
					model: reviewerModel,
				})
				const patch = {
					review_verdict: result.verdict,
					pending_review_findings: result.findings,
					reviewed_at: new Date().toISOString(),
					last_activity: {
						note: `reviewed: verdict=${result.verdict} (${result.findings.length} finding(s))`,
					},
				}
				// Merge into the watcher's current state (not the outer snapshot,
				// which may predate the group's transition to done) so the status
				// written by watchGroups is never clobbered back to an older value.
				state = updateGroup(currentState, group.name, patch)
				await saveState(statePath, state)
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
							state = updateGroup(state, group.name, {
								status: "needs-human",
								reworkCount: decision.newReworkCount,
								last_activity: {
									note: `rework spawn failed after ${decision.newReworkCount} attempt(s); needs human`,
								},
							})
							await saveState(statePath, state)
						} else {
							// Spawn succeeded: reset the group so the watcher
							// re-polls it as "running" → "done" → re-reviewed.
							state = updateGroup(state, group.name, decision.patch)
							await saveState(statePath, state)
						}
						return true
					}
					// Cap reached: terminal "needs-human" outcome. Findings stay
					// recorded so a human can see exactly what the reviewer flagged.
					state = updateGroup(state, group.name, decision.patch)
					await saveState(statePath, state)
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
			// verdict lives in the state we just persisted, so read it fresh.
			const updatedGroup = state.groups.find((g) => g.name === group.name)
			const reviewPassed = !options.review || updatedGroup?.review_verdict === "clean"
			if (!reviewPassed) {
				return
			}
			process.stdout.write(`[orchestrate] QA ${group.name} (branch ${group.branch ?? "?"})...\n`)
			try {
				const qaResult = await runQa({
					workspaceRoot: groupWorktreePath(repo, group),
					mode: options.qaMode,
					model: qaModel,
				})
				const qaStatus = qaResult.verdict === "pass" ? "done" : "failed"
				// Merge onto `state` (which already carries the review patch) —
				// NOT `currentState`, which would clobber review_verdict on save.
				state = updateGroup(state, group.name, {
					qa: {
						status: qaStatus,
						verdict: qaResult.verdict,
						evidence: qaResult.evidence.slice(0, 4000),
						updated: new Date().toISOString(),
					},
					last_activity: {
						note: `QA: verdict=${qaResult.verdict}`,
					},
				})
				await saveState(statePath, state)
				process.stdout.write(
					`[orchestrate] ${group.name} QA verdict: ${qaResult.verdict} (status ${qaStatus})\n`,
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
			`headlesscode orchestrate: ${needsHuman.length} group(s) exhausted their rework attempts and ` +
				`need a human: ${needsHuman.map((g) => g.name).join(", ")}. ` +
				`See their review_verdict/pending_review_findings in ${statePath}.\n`,
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
	// Rework-exhausted groups: a distinct, final "needs a human" outcome —
	// the deploy must never proceed while one exists, and the reason must
	// say why (not a generic failure, not an in-flight review).
	const anyNeedsHuman = state.groups.some((g) => g.status === "needs-human")
	if (anyNeedsHuman) {
		return { ready: false, reason: "one or more groups need human attention (rework attempts exhausted)" }
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
