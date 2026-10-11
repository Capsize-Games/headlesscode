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
import { museUnsupportedSettingsReason, resolveAgentExecutorSelection, type AgentExecutor, type AgentExecutorSelection } from "../agent-executor.js"
import { splitIssues, type SplitIssue, type WorktreeSpec } from "../orchestrator/split.js"
import { loadStateSync } from "../orchestrator/state.js"
import { writeTaskFiles } from "../orchestrator/cli.js"
import { createGhClient, type GhClient, type GitHubIssue } from "./github.js"
import { GitHubIssueClaimStore, type ClaimSnapshot, type RunnerClaim } from "./claims.js"
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
	executor: AgentExecutor
	museModel?: string
}

export interface SpawnResult {
	ok: boolean
	/** The exact bash command that was (or would be) run. */
	command?: string
	/** True when spawn threw after dispatch may have begun and outcome is uncertain. */
	mayHaveDispatched?: boolean
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
	 * Concurrent-session cap across orchestrator + watcher state files. In
	 * runner-pool mode, durable claims also count jobs held by this machine.
	 * Issues exceeding the cap stay 'pending' and are picked up on a later sweep.
	 */
	maxConcurrentSessions?: number
	/** Stable per-machine identity; enables GitHub-ref claim-based dispatch. */
	runnerId?: string
	runnerAssignee?: string
	/** Lease duration for claim-based runners (default 120 seconds). */
	claimLeaseMs?: number
	/** Injectable claim store for CPU tests. */
	claimStore?: GitHubIssueClaimStore
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
	executionProvider?: "local" | "openshell"
	/** Default worker executor; issue labels can select per-job overrides. */
	executor?: AgentExecutor
	museModel?: string
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
	dryRunPlan?: Array<{ issue: GitHubIssue; specs: WorktreeSpec[]; selection?: AgentExecutorSelection }>
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
	// One in-process limiter per watchIssues run guards the sweep spawn loop;
	// durable state and (in runner-pool mode) claims guard machine capacity.
	const maxConcurrentSessions = config.maxConcurrentSessions ?? maxConcurrentSessionsFromEnv()
	if (config.runnerId && config.runOnce && !config.dryRun) throw new Error("watcher runner pool requires continuous mode; --run-once cannot maintain claim leases")
	if (config.runnerId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.runnerId)) throw new Error("watcher: runnerId must be a stable safe identifier")
	if (config.runnerId && !config.runnerAssignee) throw new Error("watcher runner pool requires runnerAssignee so the GitHub issue shows its current claimant")
	const claimStore = config.claimStore ?? (config.runnerId ? new GitHubIssueClaimStore({
		token,
		owner,
		repo,
		runnerId: config.runnerId,
		runnerAssignee: config.runnerAssignee,
		...(config.ghBaseUrl ? { baseUrl: config.ghBaseUrl } : {}),
		...(config.claimLeaseMs ? { leaseMs: config.claimLeaseMs } : {}),
	}) : undefined)
	if (config.runnerId && claimStore && pollIntervalMs > Math.floor(claimStore.leaseDurationMs / 2)) {
		throw new Error(`watcher runner pool poll interval (${pollIntervalMs}ms) must be at most half the claim lease (${claimStore.leaseDurationMs}ms) so claims can be renewed before expiry`)
	}
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
			...(claimStore ? { claimStore } : {}),
			runnerId: config.runnerId,
			executor: config.executor,
			museModel: config.museModel,
			mode: config.mode ?? "code",
			executionProvider: config.executionProvider ?? "local",
			memoryDir: config.memoryDir,
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
	if (config.signal?.aborted && claimStore && config.runnerId) {
		state = await stopRunnerClaims(state, claimStore, config.runnerId, repoRoot, logger)
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
	claimStore?: GitHubIssueClaimStore
	runnerId?: string
	executor?: AgentExecutor
	museModel?: string
	mode: string
	executionProvider: "local" | "openshell"
	memoryDir?: string
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

	let state = input.state
	let activeRunnerClaims: ClaimSnapshot[] = []
	if (input.claimStore && input.runnerId && !dryRun) {
		try {
			const all = await input.claimStore.listActiveClaims()
			activeRunnerClaims = all.filter((entry) => entry.claim.runnerId === input.runnerId)
			const reconciled = await reconcileRunnerClaims(state, activeRunnerClaims, input.claimStore, repoRoot, logger)
			state = reconciled.state
			activeRunnerClaims = reconciled.claims
		} catch (err) {
			state = await stopLocalClaimsOnUncertainty(state, repoRoot, logger)
			const error = `watcher claim check failed; local workers were stopped where teardown could be confirmed and claims remain quarantined: ${err instanceof Error ? err.message : String(err)}`
			logger.error(error)
			return { issuesFound: 0, newIssues: 0, skipped: 0, spawned: 0, deferred: 0, failures: 0, state, error }
		}
	}

	let issues: GitHubIssue[]
	try {
		issues = await gh.listIssues({ owner, repo, label: targetLabel, state: "open" })
	} catch (err) {
		const error = `watcher sweep failed listing issues for ${owner}/${repo}: ${
			err instanceof Error ? err.message : String(err)
		}`
		logger.error(error)
		return { issuesFound: 0, newIssues: 0, skipped: 0, spawned: 0, deferred: 0, failures: 0, state, error }
	}

	// Deterministic processing order (ascending issue number).
	issues = [...issues].sort((a, b) => a.number - b.number)

	const newIssues = issues.filter((i) => !isProcessedForSweep(state, i.number, retryFailed))
	const skipped = issues.length - newIssues.length

	// maxPerSweep bounds a single sweep's burst; the cap bounds the running
	// sessions seen across local durable state and (in runner-pool mode) claims
	// (orchestrator groups in spawned/running + watcher in-flight 'spawned'
	// entries). Effective new spawns this sweep:
	//     min(maxPerSweep, maxConcurrentSessions - active)
	// Issues beyond it stay 'pending' (same durable deferral as maxPerSweep
	// overflow) and are picked up on a later sweep. Missing orchestrator state
	// file → active = 0 (the cap still applies to this pipeline alone).
	const orchPath = path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
	const orchState = loadStateSync(orchPath)
	const localActive = activeSessionCount(orchState, state)
	// A claim is per issue, but an issue may fan out into several worktrees.
	// Capacity is per worker session, so count every assigned worktree (including
	// quarantined claims retained by reconciliation).
	const active = input.claimStore && input.runnerId
		? countRunnerPoolSessions(orchState, state, activeRunnerClaims)
		: localActive
	const available = Math.max(0, maxConcurrentSessions - active)
	const toSpawn = newIssues.slice(0, Math.min(maxPerSweep, available))
	const deferred = newIssues.slice(toSpawn.length)

	// Accounting for the sweep log: how much of the deferral was maxPerSweep
	// vs the global cap (both ≥ 0).
	const maxPerSweepDeferred = newIssues.length - Math.min(newIssues.length, maxPerSweep)
	const globalCapDeferred = deferred.length - maxPerSweepDeferred

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
		const prior = state.processed[String(issue.number)]
		const retryingFailed = retryFailed && prior?.status === "failed"
		const retryModelLabels = issue.labels.filter((label) => /^muse-model(?::|$)/i.test(label))
		if (retryingFailed && prior?.executor && (retryModelLabels.length > 1 || (retryModelLabels.length === 1 && retryModelLabels[0]!.slice(retryModelLabels[0]!.indexOf(":") + 1) !== (prior.museModel ?? "")))) {
			const message = `watcher: issue #${issue.number} Muse model label changed since its failed spawn; restore the recorded selection before retrying`
			logger.error(message, { issue: issue.number })
			failures++
			continue
		}
		const selectionDefaults = retryingFailed && prior?.executor
			? { executor: prior.executor, museModel: prior.museModel }
			: { executor: input.executor, museModel: input.museModel }
		const resolvedSelection = resolveAgentExecutorSelection(issue.labels, selectionDefaults)
		if (!resolvedSelection.selection) {
			const message = `watcher: issue #${issue.number} has invalid agent selection: ${resolvedSelection.error}`
			logger.error(message, { issue: issue.number })
			failures++
			if (!dryRun) {
				const failedAt = new Date().toISOString()
				state = markProcessed(state, {
					number: issue.number,
					title: issue.title,
					label: targetLabel,
					status: "failed",
					updatedAt: failedAt,
					error: message,
				})
				await saveWatcherState(statePath, state)
			}
			continue
		}
		const selection = resolvedSelection.selection
		if (selection.executor === "muse" && (input.mode !== "code" || input.executionProvider !== "local")) {
			const message = `watcher: issue #${issue.number} selects Muse, which requires local execution and mode code`
			logger.error(message, { issue: issue.number })
			failures++
			if (!dryRun) {
				const failedAt = new Date().toISOString()
				state = markProcessed(state, {
					number: issue.number,
					title: issue.title,
					label: targetLabel,
					status: "failed",
					updatedAt: failedAt,
					error: message,
					executor: selection.executor,
					...(selection.museModel ? { museModel: selection.museModel } : {}),
				})
				await saveWatcherState(statePath, state)
			}
			continue
		}
		if (selection.executor === "muse") {
			const unsupported = museUnsupportedSettingsReason(input.memoryDir)
			if (unsupported) {
				const message = `watcher: issue #${issue.number} selects Muse, but ${unsupported}`
				logger.error(message, { issue: issue.number })
				failures++
				if (!dryRun) {
					const failedAt = new Date().toISOString()
					state = markProcessed(state, {
						number: issue.number,
						title: issue.title,
						label: targetLabel,
						status: "failed",
						updatedAt: failedAt,
						error: message,
						executor: selection.executor,
						...(selection.museModel ? { museModel: selection.museModel } : {}),
					})
					await saveWatcherState(statePath, state)
				}
				continue
			}
		}
		const specs = splitIssues([issue], { occupiedNames })
		for (const spec of specs) {
			occupiedNames.add(spec.name)
		}
		if (dryRun) {
			dryRunPlan!.push({ issue, specs, selection })
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
			let ownedClaim: RunnerClaim | undefined
			if (input.claimStore && input.runnerId) {
				let acquired
				try {
					acquired = await input.claimStore.acquire(issue.number, { worktreeNames: specs.map((spec) => spec.name) })
				} catch (err) {
					state = markProcessed(state, pendingEntry(issue, targetLabel))
					await saveWatcherState(statePath, state)
					failures++
					logger.error(`watcher: claim acquisition failed for issue #${issue.number}; no worker spawned: ${err instanceof Error ? err.message : String(err)}`)
					continue
				}
				if (!acquired.acquired) {
					state = markProcessed(state, pendingEntry(issue, targetLabel))
					logger.info(`watcher: issue #${issue.number} deferred; claim ${acquired.reason} on runner ${acquired.claim.runnerId}`)
					continue
				}
				ownedClaim = acquired.claim
			}

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
				executor: selection.executor,
				...(selection.museModel ? { museModel: selection.museModel } : {}),
				...(ownedClaim ? { claim: claimReference(ownedClaim) } : {}),
			}
			state = markProcessed(state, entry)
			await saveWatcherState(statePath, state)

			if (ownedClaim && input.claimStore) {
				try {
					ownedClaim = await input.claimStore.verifyActive(issue.number, ownedClaim)
				} catch (err) {
					await releaseClaimIfNoWorkers(input.claimStore, ownedClaim, logger, "spawn-failed")
					state = markProcessed(state, { ...entry, status: "failed", claim: undefined, error: `claim verification failed before dispatch: ${err instanceof Error ? err.message : String(err)}` })
					failures++
					await saveWatcherState(statePath, state)
					continue
				}
			}

			const batchInfo = { issue, specs, repoRoot, batch, ...selection }
			let result: SpawnResult
			try {
				result = await spawn(batchInfo)
			} catch (err) {
				result = { ok: false, mayHaveDispatched: true, error: err instanceof Error ? err.message : String(err) }
			}

			if (result.ok) {
				if (ownedClaim && input.claimStore) {
					try {
						ownedClaim = await input.claimStore.markRunning(issue.number, ownedClaim)
					} catch (err) {
						logger.error(`watcher: could not mark issue #${issue.number} claim running; stopping its workers: ${err instanceof Error ? err.message : String(err)}`)
						await stopWorkerGroupsBestEffort(repoRoot, ownedClaim.worktreeNames, logger)
						logger.warn(`watcher: issue #${issue.number} claim remains quarantined after claim-stage failure; worker markers cannot authorize release`)
					}
				}
				state = markProcessed(state, { ...entry, status: "done", updatedAt: new Date().toISOString() })
				if (entry.claim && ownedClaim) state = markProcessed(state, { ...entry, status: "done", claim: claimReference(ownedClaim) })
				if (entry.claim && !ownedClaim) state = markProcessed(state, { ...entry, status: "done", claim: undefined })
				spawned++
				logger.info(`watcher: spawned issue #${issue.number} (${specs.map((s) => s.name).join(", ")})`, {
					batch,
					groups: specs.map((s) => s.taskFile),
				})
			} else {
				const error = result.error ?? `spawn exited ${result.status ?? "unknown"}`
				let claimReferenceStillActive = !!ownedClaim
				if (ownedClaim && input.claimStore) {
					if (!result.command && !result.mayHaveDispatched) {
						await releaseClaimIfNoWorkers(input.claimStore, ownedClaim, logger, "spawn-failed")
						claimReferenceStillActive = false
					} else {
						if (result.command) await stopWorkerGroupsBestEffort(repoRoot, ownedClaim.worktreeNames, logger)
						logger.warn(`watcher: issue #${issue.number} ${result.mayHaveDispatched ? "spawn outcome is uncertain" : "spawn failed after dispatch"}; claim remains quarantined for operator recovery`)
					}
				}
				state = markProcessed(state, { ...entry, status: "failed", error, updatedAt: new Date().toISOString(), ...(claimReferenceStillActive && ownedClaim ? { claim: claimReference(ownedClaim) } : { claim: undefined }) })
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

/** Renew this runner's active claims and release only verified stopped workers. */
async function reconcileRunnerClaims(
	initialState: WatcherState,
	claims: ClaimSnapshot[],
	store: GitHubIssueClaimStore,
	repoRoot: string,
	logger: Logger,
): Promise<{ state: WatcherState; claims: ClaimSnapshot[] }> {
	let state = initialState
	const retained: ClaimSnapshot[] = []
	for (const snapshot of claims) {
		const claim = snapshot.claim
		const inspection = inspectWorkerGroups(repoRoot, claim.worktreeNames)
		if (inspection === "stopped") {
			// PID/PGID/done/sandbox markers are inside a worker-writable worktree.
			// Even a dead PID or a missing marker cannot establish that a detached
			// process on another machine (or an OpenShell guest) is absent. Stop
			// renewing so the lease can expire into the existing operator-recovery
			// path, but keep the claim active and capacity reserved.
			logger.warn(`watcher: issue #${claim.issue} worker markers indicate completion, but claim remains quarantined until an operator independently confirms teardown`)
			retained.push(snapshot)
			continue
		}

		try {
			const renewed = await store.renew(claim.issue, claim)
			const updated = { ...snapshot, claim: renewed }
			retained.push(updated)
			state = updateClaimHandle(state, renewed)
			if (inspection === "running" && renewed.stage === "reserved") {
				try {
					const running = await store.markRunning(claim.issue, renewed)
					retained[retained.length - 1] = { ...updated, claim: running }
					state = updateClaimHandle(state, running)
				} catch (error) {
					logger.warn(`watcher: issue #${claim.issue} claim stage could not be verified; stopping its workers: ${error instanceof Error ? error.message : String(error)}`)
					await stopWorkerGroupsBestEffort(repoRoot, claim.worktreeNames, logger)
					logger.warn(`watcher: issue #${claim.issue} claim remains quarantined after claim-stage failure; worker markers cannot authorize release`)
				}
			}
		} catch (error) {
			logger.error(`watcher: issue #${claim.issue} claim renewal failed; stopping its workers: ${error instanceof Error ? error.message : String(error)}`)
			await stopWorkerGroupsBestEffort(repoRoot, claim.worktreeNames, logger)
			logger.warn(`watcher: issue #${claim.issue} claim remains quarantined after renewal failure; worker markers cannot authorize release`)
			retained.push(snapshot)
		}
	}
	return { state, claims: retained }
}

async function stopLocalClaimsOnUncertainty(state: WatcherState, repoRoot: string, logger: Logger): Promise<WatcherState> {
	for (const entry of Object.values(state.processed)) {
		if (entry.claim) await stopWorkerGroupsBestEffort(repoRoot, entry.claim.worktreeNames, logger)
	}
	return state
}

async function stopRunnerClaims(
	initialState: WatcherState,
	store: GitHubIssueClaimStore,
	runnerId: string,
	repoRoot: string,
	logger: Logger,
): Promise<WatcherState> {
	let state = initialState
	try {
		const claims = await store.listActiveClaims(runnerId)
		for (const { claim } of claims) {
			await stopWorkerGroupsBestEffort(repoRoot, claim.worktreeNames, logger)
			logger.warn(`watcher shutdown: issue #${claim.issue} remains quarantined; an operator must independently confirm worker and guest teardown before recovery`)
		}
	} catch (error) {
		state = await stopLocalClaimsOnUncertainty(state, repoRoot, logger)
		logger.error(`watcher shutdown: claim service unavailable; local workers stopped where possible and refs remain quarantined: ${error instanceof Error ? error.message : String(error)}`)
	}
	return state
}

async function releaseClaimIfNoWorkers(
	store: GitHubIssueClaimStore,
	claim: RunnerClaim,
	logger: Logger,
	reason: "spawn-failed",
): Promise<void> {
	try {
		await store.release(claim.issue, claim, { kind: "never-spawned", observedAt: new Date().toISOString() }, reason)
	} catch (error) {
		logger.warn(`watcher: issue #${claim.issue} claim could not be released and remains quarantined: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function inspectWorkerGroups(repoRoot: string, names: string[]): "running" | "stopped" | "unknown" {
	if (names.length === 0) return "unknown"
	let unknown = false
	for (const name of names) {
		const worktree = path.join(repoRoot, ".worktrees", name)
		if (!fs.existsSync(worktree)) { unknown = true; continue }
		for (const label of ["harness", "qa"] as const) {
			const status = inspectWorkerTree(worktree, label)
			if (status === "running") return "running"
			if (status === "unknown" || (label === "harness" && status === "absent")) unknown = true
		}
	}
	return unknown ? "unknown" : "stopped"
}

function inspectWorkerTree(worktree: string, label: "harness" | "qa"): "running" | "stopped" | "unknown" | "absent" {
	const pgidPath = path.join(worktree, `.${label}.pgid`)
	const pidPath = path.join(worktree, `.${label}.pid`)
	const markerPath = path.join(worktree, `.${label}.done`)
	let hadEvidence = false
	for (const [marker, isGroup] of [[pgidPath, true], [pidPath, false]] as const) {
		if (!fs.existsSync(marker)) continue
		hadEvidence = true
		const raw = fs.readFileSync(marker, "utf8").trim()
		if (!/^\d{1,10}$/.test(raw)) return "unknown"
		const id = Number(raw)
		if (!Number.isSafeInteger(id) || id <= 1) return "unknown"
		try {
			process.kill(isGroup ? -id : id, 0)
			return "running"
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") return "unknown"
		}
	}
	// PID/PGID/done markers provide only a local liveness hint for lease renewal.
	// They are worker-writable and never authorize release of a dispatched claim.
	if (hadEvidence) return "stopped"
	if (fs.existsSync(markerPath)) return "unknown"
	return "absent"
}

async function stopWorkerGroupsBestEffort(repoRoot: string, names: string[], logger: Logger): Promise<void> {
	const stopScript = path.join(HARNESS_ROOT, "scripts", "stop-worker.sh")
	for (const name of names) {
		const worktree = path.join(repoRoot, ".worktrees", name)
		if (!fs.existsSync(worktree)) {
			logger.warn(`watcher: cannot attempt worker stop for missing worktree ${name}`)
			continue
		}
		const result = spawnSync("bash", [stopScript, worktree, "--grace-ms", "5000"], { stdio: "ignore", timeout: 15_000 })
		if (result.status !== 0 || result.error) {
			logger.error(`watcher: could not confirm stop-worker teardown for ${name}`)
		}
	}
}

function claimReference(claim: RunnerClaim): NonNullable<WatcherIssueEntry["claim"]> {
	return { runnerId: claim.runnerId, leaseNonce: claim.leaseNonce, epoch: claim.epoch, worktreeNames: [...claim.worktreeNames] }
}

function sameClaimOwner(left: RunnerClaim, right: RunnerClaim): boolean {
	return left.issue === right.issue && left.phase === "active" && left.runnerId === right.runnerId &&
		left.leaseNonce === right.leaseNonce && left.epoch === right.epoch
}

function updateClaimHandle(state: WatcherState, claim: RunnerClaim): WatcherState {
	const prior = state.processed[String(claim.issue)]
	if (!prior) return state
	return markProcessed(state, { ...prior, claim: claimReference(claim) })
}

/** Count the union of local durable sessions and this runner's claimed worktrees. */
function countRunnerPoolSessions(
	orchState: ReturnType<typeof loadStateSync>,
	watcherState: WatcherState,
	claims: readonly ClaimSnapshot[],
): number {
	const sessions = new Set<string>()
	for (const group of orchState?.groups ?? []) {
		if (group.status === "spawned" || group.status === "running") sessions.add(`worktree:${group.name}`)
	}
	for (const entry of Object.values(watcherState.processed)) {
		if (entry.status !== "spawned") continue
		const names = entry.claim?.worktreeNames ?? entry.groups?.map((group) => group.name) ?? []
		if (names.length === 0) sessions.add(`watcher-issue:${entry.number}`)
		else for (const name of names) sessions.add(`worktree:${name}`)
	}
	for (const snapshot of claims) {
		for (const name of snapshot.claim.worktreeNames) sessions.add(`worktree:${name}`)
	}
	return sessions.size
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
export function defaultSpawn(batch: SpawnBatch, config: Pick<WatcherConfig, "mode" | "memoryDir" | "executionProvider" | "runnerId">): SpawnResult {
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
	const childEnv = { ...process.env }
	if (config.runnerId) {
		// Claim credentials belong to the watcher supervisor. Agent prompts and
		// tools must not inherit the token that can move the shared claim refs.
		delete childEnv.GH_TOKEN
		delete childEnv.GITHUB_TOKEN
	}
	const result = spawnSync("bash", ["-c", command], {
		cwd: batch.repoRoot,
		env: {
			...childEnv,
			TARGET_REPO: batch.repoRoot,
			ORCHESTRATOR_MODE: config.mode ?? "code",
			HEADLESSCODE_EXECUTION_PROVIDER: config.executionProvider ?? process.env.HEADLESSCODE_EXECUTION_PROVIDER ?? "local",
			HEADLESSCODE_AGENT_EXECUTOR: batch.executor,
			HEADLESSCODE_NATIVE_MUSE_MODEL: batch.museModel ?? "",
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
