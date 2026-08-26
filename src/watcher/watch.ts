/**
 * Phase 5 — GitHub issue watcher: poll a label, fan out into batches, spawn
 * worktrees through the EXISTING bash spawner, and track idempotency in a
 * durable state file.
 *
 * Sweep flow (per tick):
 *   1. listIssues({ owner, repo, label: targetLabel, state: open }).
 *   2. Partition: new (no entry / status pending / failed-with-retry) vs
 *      already processed (everything else — skipped this sweep).
 *   3. Apply the maxPerSweep cap: the first `maxPerSweep` new issues are
 *      spawned; the rest are recorded as status "pending" so the NEXT sweep
 *      picks them up (a label storm never spawns more than N worktrees per
 *      sweep).
 *   4. For each spawned issue (write-ahead ordering):
 *        a. markProcessed(status "spawned") + save  ← durable BEFORE spawn
 *        b. splitIssues([issue]) -> specs
 *        c. writeTaskFiles(...) + spawn via
 *           scripts/spawn-parallel-worktrees.sh (bash -c — the bash script
 *           remains the ACTUAL spawner; no worktree creation in TS)
 *        d. markProcessed(status "done" | "failed") + save
 *   5. Log the sweep (issues found / new / skipped / spawned / deferred).
 *
 * The state file is the idempotency source of truth: a restart loads it and
 * continues; a crash between (a) and (d) leaves a "spawned" entry which the
 * next restart treats as processed — a double-spawn is impossible.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
	activeSessionCount,
	ConcurrencyLimiter,
	maxConcurrentSessionsFromEnv,
} from "../budget/concurrency.js"
import { Logger } from "../engine/logger.js"
import { splitIssues, type SplitIssue, type WorktreeSpec } from "../orchestrator/split.js"
import { loadStateSync } from "../orchestrator/state.js"
import { writeTaskFiles } from "../orchestrator/cli.js"
import { createGhClient, type GhClient, type GitHubIssue } from "./github.js"
import {
	isProcessed,
	loadWatcherState,
	markProcessed,
	saveWatcherState,
	type WatcherIssueEntry,
	type WatcherIssueStatus,
	type WatcherState,
} from "./state.js"

/** The harness repo root (parent of src/watcher) — same pattern as the CLI. */
const HARNESS_ROOT = fileURLToPath(new URL("../..", import.meta.url))

export const DEFAULT_POLL_INTERVAL_MS = 60_000
export const DEFAULT_MAX_PER_SWEEP = 5

export interface SpawnBatch {
	issue: GitHubIssue
	/** Worktree groups from splitIssues([issue]). */
	specs: WorktreeSpec[]
	/** Local target repo root where worktrees are created. */
	repoRoot: string
	/** Batch id (watcher-<date>). */
	batch: string
}

export interface SpawnResult {
	ok: boolean
	/** The exact bash command that was (or would be) run. */
	command?: string
	/** spawnSync exit status (null = spawn failed to launch). */
	status?: number | null
	error?: string
}

export interface WatcherBatchInfo {
	issue: GitHubIssue
	specs: WorktreeSpec[]
	batch: string
	statePath: string
	/** Final recorded status after the batch processed: done | failed. */
	status: WatcherIssueStatus
}

export interface WatcherConfig {
	/** GitHub owner (e.g. "my-org"). */
	owner: string
	/** GitHub repo name (e.g. "my-repo"). */
	repo: string
	/** The label that triggers processing (e.g. "needs-agent"). */
	targetLabel: string
	/** GitHub token (GH_TOKEN / GITHUB_TOKEN). Never logged or persisted. */
	token: string
	/** Sweep interval (default 60000ms). */
	pollIntervalMs?: number
	/** GitHub API base URL (default: $GITHUB_API_BASE_URL or api.github.com). */
	ghBaseUrl?: string
	/** Durable state file (default: <repoRoot>/.worktrees/.watcher-state.json). */
	stateFile?: string
	/** Local target repo root where worktrees are spawned (default: cwd). */
	repoRoot?: string
	/** Called after each batch is processed (spawn done/failed). */
	onBatch?: (info: WatcherBatchInfo) => void | Promise<void>
	/** true = one sweep then return; false = continuous loop. */
	runOnce?: boolean
	/** Abort the loop (continuous mode clean shutdown). */
	signal?: AbortSignal
	/** Per-sweep cap on newly spawned issues (default 5). */
	maxPerSweep?: number
	/**
	 * Phase 6 GLOBAL cap on concurrent sessions across processes (default
	 * $HEADLESSCODE_MAX_CONCURRENT_SESSIONS or 3). Interplay with maxPerSweep:
	 * maxPerSweep bounds a single sweep's burst; this bounds the TOTAL number
	 * of running/spawned sessions seen across the orchestrator + watcher state
	 * files — a label storm can never push the fleet past the cap. Issues
	 * exceeding the cap stay 'pending' in watcher state (deferred exactly like
	 * maxPerSweep overflow) and are picked up on a later sweep.
	 */
	maxConcurrentSessions?: number
	/** Retry previously-failed issues on the next sweep (default: no). */
	retryFailed?: boolean
	/** Sweep + report without spawning or writing state. */
	dryRun?: boolean
	/** Injected GitHub client for tests (default: createGhClient(token)). */
	gh?: GhClient
	/** Injected spawn function for tests (default: the real bash spawner). */
	spawn?: (batch: SpawnBatch) => SpawnResult | Promise<SpawnResult>
	/** Harness mode for workers (forwarded to the spawner as ORCHESTRATOR_MODE). */
	mode?: string
	/** Memory dir for workers (forwarded to the spawner as HEADLESSCODE_MEMORY_DIR). */
	memoryDir?: string
	/** Phase 4 pass-through: recorded on the batch entry (see docs). */
	qa?: boolean
	/** Phase 4 pass-through: recorded on the batch entry (see docs). */
	deploy?: boolean
	logger?: Logger
}

export interface SweepResult {
	issuesFound: number
	newIssues: number
	skipped: number
	spawned: number
	deferred: number
	failures: number
	state: WatcherState
	/** Dry-run only: what WOULD be spawned per new issue. */
	dryRunPlan?: Array<{ issue: GitHubIssue; specs: WorktreeSpec[] }>
	error?: string
}

export interface WatchResult {
	/** One entry per completed sweep. */
	sweeps: SweepResult[]
	/** Total batches spawned across all sweeps. */
	spawned: number
	/** 0 = ok; 1 = one or more spawns failed. */
	exitCode: number
}

/**
 * Run the watcher. Continuous mode loops until the abort signal fires;
 * `runOnce` performs a single sweep and returns. State is loaded from disk at
 * startup (restart-safe) and saved after every sweep.
 */
export async function watchIssues(config: WatcherConfig): Promise<WatchResult> {
	const owner = config.owner
	const repo = config.repo
	const targetLabel = config.targetLabel
	const token = config.token
	if (!token) {
		throw new Error("watcher: no GitHub token (set GH_TOKEN or GITHUB_TOKEN)")
	}
	if (!owner || !repo || !targetLabel) {
		throw new Error("watcher: owner, repo and targetLabel are required")
	}

	const repoRoot = path.resolve(config.repoRoot ?? process.cwd())
	const statePath = path.resolve(config.stateFile ?? path.join(repoRoot, ".worktrees", ".watcher-state.json"))
	const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
	const maxPerSweep = config.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP
	// Phase 6: the global concurrency cap (flag wins; else env; else 3). One
	// in-process limiter per watchIssues run guards the sweep spawn loop; the
	// durable-state view (activeSessionCount) guards the cross-process window.
	const maxConcurrentSessions = config.maxConcurrentSessions ?? maxConcurrentSessionsFromEnv()
	const limiter = new ConcurrencyLimiter(maxConcurrentSessions)
	const gh = config.gh ?? createGhClient({ token, baseUrl: config.ghBaseUrl })
	const logger = config.logger ?? new Logger({ level: "info" })
	const spawn = config.spawn ?? ((batch: SpawnBatch): SpawnResult => defaultSpawn(batch, config))
	const qa = config.qa ?? false
	const deploy = config.deploy ?? false

	let state = await loadWatcherState(statePath)
	const sweeps: SweepResult[] = []
	let spawnedTotal = 0
	let exitCode = 0

	for (;;) {
		if (config.signal?.aborted) {
			break
		}

		const sweep = await sweepOnce({
			gh,
			owner,
			repo,
			targetLabel,
			state,
			statePath,
			repoRoot,
			maxPerSweep,
			maxConcurrentSessions,
			limiter,
			retryFailed: config.retryFailed,
			dryRun: config.dryRun,
			spawn,
			onBatch: config.onBatch,
			logger,
			qa,
			deploy,
		})
		state = sweep.state
		sweeps.push(sweep)
		spawnedTotal += sweep.spawned
		// A list failure OR any failed spawn makes the run "error out"
		// (runOnce exits 1; continuous mode logs and keeps going).
		if (sweep.error || sweep.failures > 0) {
			exitCode = 1
		}

		if (config.runOnce) {
			break
		}
		await sleepOrAbort(pollIntervalMs, config.signal)
	}

	// Final save so lastSweep is durable even after a clean abort.
	// Dry-run writes nothing at all.
	if (!config.dryRun) {
		await saveWatcherState(statePath, state)
	}
	return { sweeps, spawned: spawnedTotal, exitCode }
}

interface SweepInput {
	gh: GhClient
	owner: string
	repo: string
	targetLabel: string
	state: WatcherState
	statePath: string
	repoRoot: string
	maxPerSweep: number
	/** Phase 6: global concurrent-session cap (see WatcherConfig). */
	maxConcurrentSessions: number
	/** Phase 6: in-process limiter guarding the sweep spawn loop. */
	limiter: ConcurrencyLimiter
	retryFailed?: boolean
	dryRun?: boolean
	spawn: (batch: SpawnBatch) => SpawnResult | Promise<SpawnResult>
	onBatch?: (info: WatcherBatchInfo) => void | Promise<void>
	logger: Logger
	/** Recorded on each batch entry (pass-through for the follow-up round). */
	qa: boolean
	/** Recorded on each batch entry (pass-through for the follow-up round). */
	deploy: boolean
}

/** One full sweep: list → partition → cap (per-sweep + global) → spawn → log. */
async function sweepOnce(input: SweepInput): Promise<SweepResult> {
	const {
		gh,
		owner,
		repo,
		targetLabel,
		statePath,
		repoRoot,
		maxPerSweep,
		maxConcurrentSessions,
		limiter,
		retryFailed,
		dryRun,
		spawn,
		logger,
	} = input

	let issues: GitHubIssue[]
	try {
		issues = await gh.listIssues({ owner, repo, label: targetLabel, state: "open" })
	} catch (err) {
		const error = `watcher sweep failed listing issues for ${owner}/${repo}: ${
			err instanceof Error ? err.message : String(err)
		}`
		logger.error(error)
		return { issuesFound: 0, newIssues: 0, skipped: 0, spawned: 0, deferred: 0, failures: 0, state: input.state, error }
	}

	// Deterministic processing order (ascending issue number).
	issues = [...issues].sort((a, b) => a.number - b.number)

	const newIssues = issues.filter((i) => !isProcessedForSweep(input.state, i.number, retryFailed))
	const skipped = issues.length - newIssues.length

	// ── Phase 6 GLOBAL cap (spec 6.3) ──────────────────────────────────────
	// maxPerSweep bounds a single sweep's burst; the global cap bounds the
	// TOTAL running/spawned sessions seen across the durable state files
	// (orchestrator groups in spawned/running + watcher in-flight 'spawned'
	// entries). Effective new spawns this sweep:
	//     min(maxPerSweep, maxConcurrentSessions - active)
	// Issues beyond it stay 'pending' (same durable deferral as maxPerSweep
	// overflow) and are picked up on a later sweep. Missing orchestrator state
	// file → active = 0 (the cap still applies to this pipeline alone).
	const orchPath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
	const orchState = loadStateSync(orchPath)
	const active = activeSessionCount(orchState, input.state)
	const available = Math.max(0, maxConcurrentSessions - active)
	const toSpawn = newIssues.slice(0, Math.min(maxPerSweep, available))
	const deferred = newIssues.slice(toSpawn.length)

	// Accounting for the sweep log: how much of the deferral was maxPerSweep
	// vs the global cap (both ≥ 0).
	const maxPerSweepDeferred = newIssues.length - Math.min(newIssues.length, maxPerSweep)
	const globalCapDeferred = deferred.length - maxPerSweepDeferred

	let state = input.state
	const dryRunPlan: SweepResult["dryRunPlan"] = dryRun ? [] : undefined
	let spawned = 0
	let failures = 0

	// Naming collision avoidance (mirrors orchestrator/cli.ts's orchestrate
	// path): seed from whatever `.worktrees/wN` dirs already exist — a
	// still-running `orchestrate` round, or an earlier sweep this same
	// process — then reserve each issue's assigned names as we go, so two
	// issues spawned in the SAME sweep never both land on w1 either.
	let occupiedNames: Set<string>
	try {
		occupiedNames = new Set(
			fs
				.readdirSync(path.join(repoRoot, ".worktrees"), { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name),
		)
	} catch {
		occupiedNames = new Set()
	}

	// Record deferred issues as "pending" so the next sweep picks them up
	// (persisted by the per-issue saves below, or the final save). Dry-run
	// writes nothing.
	if (!dryRun) {
		for (const issue of deferred) {
			state = markProcessed(state, pendingEntry(issue, targetLabel))
		}
	}

	for (const issue of toSpawn) {
		const specs = splitIssues([issue], { occupiedNames })
		for (const spec of specs) {
			occupiedNames.add(spec.name)
		}
		if (dryRun) {
			dryRunPlan!.push({ issue, specs })
			continue
		}

		// In-process fail-fast guard (ConcurrencyLimiter). The durable-state
		// view above already pre-capped toSpawn, so this only fires if the
		// fleet picture changed mid-sweep (another process spawned); the issue
		// is deferred to 'pending' rather than over-spawning.
		const acq = limiter.acquire()
		if (!acq.ok) {
			state = markProcessed(state, pendingEntry(issue, targetLabel))
			logger.warn(`watcher: issue #${issue.number} deferred by the global concurrency cap — ${acq.reason}`, {})
			continue
		}

		try {
			// ── Write-ahead: durable "spawned" entry BEFORE the spawn ──
			const batch = batchId()
			const spawnedAt = new Date().toISOString()
			const entry: WatcherIssueEntry = {
				number: issue.number,
				title: issue.title,
				label: targetLabel,
				batch,
				groups: specs,
				spawnedAt,
				status: "spawned",
				updatedAt: spawnedAt,
				...(input.qa ? { qa: true } : {}),
				...(input.deploy ? { deploy: true } : {}),
			}
			state = markProcessed(state, entry)
			await saveWatcherState(statePath, state)

			const batchInfo = { issue, specs, repoRoot, batch }
			let result: SpawnResult
			try {
				result = await spawn(batchInfo)
			} catch (err) {
				result = { ok: false, error: err instanceof Error ? err.message : String(err) }
			}

			if (result.ok) {
				state = markProcessed(state, { ...entry, status: "done", updatedAt: new Date().toISOString() })
				spawned++
				logger.info(`watcher: spawned issue #${issue.number} (${specs.map((s) => s.name).join(", ")})`, {
					batch,
					groups: specs.map((s) => s.taskFile),
				})
			} else {
				const error = result.error ?? `spawn exited ${result.status ?? "unknown"}`
				state = markProcessed(state, { ...entry, status: "failed", error, updatedAt: new Date().toISOString() })
				failures++
				// Loud by design: a failed spawn is NOT silently retried (default).
				// Re-run with --retry-failed to force a retry next sweep.
				logger.error(`watcher: spawn FAILED for issue #${issue.number} — ${error}`, { batch })
			}
			await saveWatcherState(statePath, state)
			await input.onBatch?.({ issue, specs, batch, statePath, status: result.ok ? "done" : "failed" })
		} finally {
			limiter.release()
		}
	}

	state.lastSweep = new Date().toISOString()
	if (!dryRun) {
		await saveWatcherState(statePath, state)
	}

	logger.info(`watcher sweep: ${issues.length} issue(s) with label "${targetLabel}"`, {
		found: issues.length,
		new: newIssues.length,
		skipped,
		spawned,
		deferred: dryRun ? newIssues.length - toSpawn.length : deferred.length,
		global_cap_deferred: globalCapDeferred,
		max_per_sweep_deferred: maxPerSweepDeferred,
		active_sessions: active,
		failures,
	})

	return {
		issuesFound: issues.length,
		newIssues: newIssues.length,
		skipped,
		spawned,
		deferred: dryRun ? newIssues.length - toSpawn.length : deferred.length,
		failures,
		state,
		...(dryRunPlan ? { dryRunPlan } : {}),
	}
}

/** isProcessed plus the retry-failed override (see state.ts). */
function isProcessedForSweep(state: WatcherState, number: number, retryFailed?: boolean): boolean {
	return isProcessed(state, number, { retryFailed })
}

function pendingEntry(issue: GitHubIssue, label: string): WatcherIssueEntry {
	return {
		number: issue.number,
		title: issue.title,
		label,
		status: "pending",
		updatedAt: new Date().toISOString(),
	}
}

function batchId(): string {
	return `watcher-${new Date().toISOString().slice(0, 10)}`
}

/**
 * The REAL spawn path: generate task files (reusing the orchestrator's
 * builder) and run the existing bash spawner via `bash -c` — the same
 * invocation pattern as src/orchestrator/cli.ts (spawnSync("bash", ["-c", …])
 * with cwd = the target repo so `git rev-parse --show-toplevel` resolves).
 * No worktree creation happens in TS; the bash script remains the spawner.
 */
export function defaultSpawn(batch: SpawnBatch, config: Pick<WatcherConfig, "mode" | "memoryDir">): SpawnResult {
	const issues: SplitIssue[] = [
		{ number: batch.issue.number, title: batch.issue.title, body: batch.issue.body },
	]

	// 1. Task files under <repoRoot>/plans/parallel-tasks/ (the convention
	//    the spawner copies them into each worktree).
	try {
		writeTaskFiles(batch.repoRoot, batch.specs, issues)
	} catch (err) {
		return { ok: false, error: `task file generation failed: ${err instanceof Error ? err.message : String(err)}` }
	}

	// 2. Spawn via the existing bash script (env override allows the e2e to
	//    stub it; default is the real spawner).
	const spawnScript =
		process.env.HEADLESSCODE_SPAWN_SCRIPT ?? path.join(HARNESS_ROOT, "scripts", "spawn-parallel-worktrees.sh")
	const triples = batch.specs
		.map((spec) => `${spec.name}:${batch.specs.indexOf(spec)}:plans/parallel-tasks/${spec.taskFile}`)
		.join(" ")
	const command = `bash ${spawnScript} ${triples}`

	// `bash -c <command>` (NOT spawnSync("bash", [command], { shell: true }),
	// which would run `bash bash <script> …` and die — same gotcha the
	// orchestrator CLI documents).
	const result = spawnSync("bash", ["-c", command], {
		cwd: batch.repoRoot,
		env: {
			...process.env,
			TARGET_REPO: batch.repoRoot,
			ORCHESTRATOR_MODE: config.mode ?? "code",
			HEADLESSCODE_PROJECT: path.basename(batch.repoRoot),
			...(config.memoryDir ? { HEADLESSCODE_MEMORY_DIR: path.resolve(config.memoryDir) } : {}),
		},
		stdio: "inherit",
	})

	if (result.status === 0) {
		return { ok: true, command, status: 0 }
	}
	return {
		ok: false,
		command,
		status: result.status ?? null,
		error:
			result.error !== undefined
				? `spawn script failed to launch: ${result.error.message}`
				: `spawn script exited ${result.status}`,
	}
}

/** Sleep for `ms` but resolve immediately when the signal aborts. */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve()
			return
		}
		// Issue #85: on the normal (timer-fires-first) path, `{once:true}` only
		// stops the listener from firing TWICE — it does not detach it. Every
		// poll of a long-running watch loop reuses the same `config.signal`, so
		// without an explicit removeEventListener here each poll's listener
		// stayed attached for the rest of the process's life — a slow leak over
		// a long continuous watch.
		const onAbort = () => {
			clearTimeout(timer)
			resolve()
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

// Re-exported for callers that want the state helpers without importing
// state.js directly (e.g. tests asserting isProcessed semantics).
export { isProcessed } from "./state.js"
export type { WatcherIssueEntry, WatcherState } from "./state.js"
