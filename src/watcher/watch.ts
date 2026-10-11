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
 *        d. ordinary issues: markProcessed(status "done" | "failed") + save;
 *           headlesscode-job issues stay "spawned" until a later poll checks
 *           their completion markers and updates GitHub lifecycle state
 *   5. Log the sweep (issues found / new / skipped / spawned / deferred).
 *
 * The state file is the idempotency source of truth: a restart loads it and
 * continues; a crash between (a) and (d) leaves a "spawned" entry which the
 * next restart treats as processed — a double-spawn is impossible.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
	activeSessionCount,
	ConcurrencyLimiter,
	maxConcurrentSessionsFromEnv,
} from "../budget/concurrency.js"
import { Logger } from "../engine/logger.js"
import { museUnsupportedSettingsReason, parseHeadlessCodeJobBody, resolveAgentExecutorSelection, type AgentExecutor, type AgentExecutorSelection } from "../agent-executor.js"
import { splitIssues, type SplitIssue, type WorktreeSpec } from "../orchestrator/split.js"
import { loadStateSync } from "../orchestrator/state.js"
import { writeTaskFiles } from "../orchestrator/cli.js"
import { createGhClient, DEFAULT_GH_BASE_URL, type GhClient, type GitHubIssue, type GitHubPullRequestSummary } from "./github.js"
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
export const HEADLESSCODE_JOB_LABEL = "headlesscode-job"

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
	/** Recorded status: headlesscode-job remains spawned after detached launch. */
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
			ghBaseUrl: config.ghBaseUrl,
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
	ghBaseUrl?: string
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
	const reconciledJobs = await reconcileHeadlessCodeJobs({
		state,
		issues,
		gh,
		owner,
		repo,
		repoRoot,
		ghBaseUrl: input.ghBaseUrl,
		claims: activeRunnerClaims,
		claimStore: input.claimStore,
		dryRun,
		logger,
	})
	state = reconciledJobs.state

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
	let failures = reconciledJobs.failures

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
		const isHeadlessCodeJob = issue.labels.includes(HEADLESSCODE_JOB_LABEL)
		const parsedJob = isHeadlessCodeJob ? parseHeadlessCodeJobBody(issue.body) : undefined
		if (parsedJob && !parsedJob.submission) {
			const message = `watcher: issue #${issue.number} has invalid headlesscode-job intake: ${parsedJob.error}`
			logger.error(message, { issue: issue.number })
			failures++
			if (!dryRun) {
				state = markProcessed(state, {
					number: issue.number,
					title: issue.title,
					label: targetLabel,
					...(isHeadlessCodeJob ? { jobContract: true } : {}),
					status: "failed",
					updatedAt: new Date().toISOString(),
					error: message,
				})
				await saveWatcherState(statePath, state)
				if (isHeadlessCodeJob) await reportJobIntakeFailure(gh, owner, repo, issue.number, message, logger)
			}
			continue
		}
		const dispatchIssue = parsedJob?.submission ? { ...issue, body: parsedJob.submission.task } : issue
		const retryModelLabels = issue.labels.filter((label) => /^muse-model(?::|$)/i.test(label))
		if (retryingFailed && prior?.executor && (retryModelLabels.length > 1 || (retryModelLabels.length === 1 && retryModelLabels[0]!.slice(retryModelLabels[0]!.indexOf(":") + 1) !== (prior.museModel ?? "")))) {
			const message = `watcher: issue #${issue.number} Muse model label changed since its failed spawn; restore the recorded selection before retrying`
			logger.error(message, { issue: issue.number })
			failures++
			if (isHeadlessCodeJob && !dryRun) {
				state = markProcessed(state, { ...prior!, jobContract: true, status: "failed", error: message, updatedAt: new Date().toISOString() })
				await saveWatcherState(statePath, state)
				await reportJobIntakeFailure(gh, owner, repo, issue.number, message, logger)
			}
			continue
		}
		const selectionDefaults = retryingFailed && prior?.executor
			? { executor: prior.executor, museModel: prior.museModel }
			: { executor: input.executor, museModel: input.museModel }
		const resolvedSelection = resolveAgentExecutorSelection(issue.labels, selectionDefaults, parsedJob?.submission?.executor)
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
					...(isHeadlessCodeJob ? { jobContract: true } : {}),
					status: "failed",
					updatedAt: failedAt,
					error: message,
				})
				await saveWatcherState(statePath, state)
				if (isHeadlessCodeJob) await reportJobIntakeFailure(gh, owner, repo, issue.number, message, logger)
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
					...(isHeadlessCodeJob ? { jobContract: true } : {}),
					status: "failed",
					updatedAt: failedAt,
					error: message,
					executor: selection.executor,
					...(selection.museModel ? { museModel: selection.museModel } : {}),
				})
				await saveWatcherState(statePath, state)
				if (isHeadlessCodeJob) await reportJobIntakeFailure(gh, owner, repo, issue.number, message, logger)
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
						...(isHeadlessCodeJob ? { jobContract: true } : {}),
						status: "failed",
						updatedAt: failedAt,
						error: message,
						executor: selection.executor,
						...(selection.museModel ? { museModel: selection.museModel } : {}),
					})
					await saveWatcherState(statePath, state)
					if (isHeadlessCodeJob) await reportJobIntakeFailure(gh, owner, repo, issue.number, message, logger)
				}
				continue
			}
		}
		const specs = splitIssues([dispatchIssue], { occupiedNames })
		for (const spec of specs) {
			occupiedNames.add(spec.name)
		}
		if (dryRun) {
			dryRunPlan!.push({ issue: dispatchIssue, specs, selection })
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
				...(isHeadlessCodeJob ? { jobContract: true } : {}),
				...(parsedJob?.submission ? { submittedBy: parsedJob.submission.submittedBy } : {}),
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

			const batchInfo = { issue: dispatchIssue, specs, repoRoot, batch, ...selection }
			let result: SpawnResult
			try {
				result = await spawn(batchInfo)
			} catch (err) {
				result = { ok: false, mayHaveDispatched: true, error: err instanceof Error ? err.message : String(err) }
			}

			if (result.ok) {
				let claimCurrentForLifecycle = true
				if (ownedClaim && input.claimStore) {
					try {
						ownedClaim = await input.claimStore.markRunning(issue.number, ownedClaim)
					} catch (err) {
						claimCurrentForLifecycle = false
						logger.error(`watcher: could not mark issue #${issue.number} claim running; stopping its workers: ${err instanceof Error ? err.message : String(err)}`)
						await stopWorkerGroupsBestEffort(repoRoot, ownedClaim.worktreeNames, logger)
						logger.warn(`watcher: issue #${issue.number} claim remains quarantined after claim-stage failure; worker markers cannot authorize release`)
					}
				}
				if (entry.jobContract) {
					state = markProcessed(state, {
						...entry,
						status: "spawned",
						updatedAt: new Date().toISOString(),
						...(ownedClaim ? { claim: claimReference(ownedClaim) } : {}),
					})
					try {
						if (!claimCurrentForLifecycle) throw new Error("claim no longer verified after dispatch")
						await setIssueLifecycle(gh, owner, repo, issue.number, "running")
					} catch (error) {
						failures++
						logger.warn(`watcher: issue #${issue.number} launched, but its running label could not be applied; it remains active in local state: ${safeError(error)}`)
					}
				} else {
					state = markProcessed(state, { ...entry, status: "done", updatedAt: new Date().toISOString() })
					if (entry.claim && ownedClaim) state = markProcessed(state, { ...entry, status: "done", claim: claimReference(ownedClaim) })
					if (entry.claim && !ownedClaim) state = markProcessed(state, { ...entry, status: "done", claim: undefined })
				}
				spawned++
				logger.info(`watcher: ${entry.jobContract ? "launched" : "spawned"} issue #${issue.number} (${specs.map((s) => s.name).join(", ")})`, {
					batch,
					groups: specs.map((s) => s.taskFile),
				})
			} else {
				const error = result.error ?? `spawn exited ${result.status ?? "unknown"}`
				const uncertainJobDispatch = !!entry.jobContract && (!!result.command || !!result.mayHaveDispatched)
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
				state = markProcessed(state, {
					...entry,
					status: uncertainJobDispatch ? "spawned" : "failed",
					error,
					updatedAt: new Date().toISOString(),
					...(claimReferenceStillActive && ownedClaim ? { claim: claimReference(ownedClaim) } : { claim: undefined }),
				})
				if (entry.jobContract) {
					try {
						if (uncertainJobDispatch) await setIssueLifecycle(gh, owner, repo, issue.number, "running")
						else await setIssueLifecycle(gh, owner, repo, issue.number, "failed")
					} catch (lifecycleError) {
						logger.warn(`watcher: issue #${issue.number} spawn failure status could not be reflected in GitHub labels: ${safeError(lifecycleError)}`)
					}
				}
				failures++
				// Loud by design: a failed spawn is NOT silently retried (default).
				// Re-run with --retry-failed to force a retry next sweep.
				logger.error(`watcher: spawn FAILED for issue #${issue.number} — ${error}`, { batch })
			}
			await saveWatcherState(statePath, state)
			await input.onBatch?.({ issue, specs, batch, statePath, status: state.processed[String(issue.number)]?.status ?? "failed" })
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

const JOB_LIFECYCLE_LABELS = ["headlesscode:running", "headlesscode:done", "headlesscode:failed"] as const
type JobLifecycle = (typeof JOB_LIFECYCLE_LABELS)[number] extends `headlesscode:${infer S}` ? S : never

interface JobReconcileInput {
	state: WatcherState
	issues: GitHubIssue[]
	gh: GhClient
	owner: string
	repo: string
	repoRoot: string
	ghBaseUrl?: string
	claims: ClaimSnapshot[]
	claimStore?: GitHubIssueClaimStore
	dryRun?: boolean
	logger: Logger
}

/**
 * A successful spawner exit only means detached workers were launched. A
 * headlesscode-job stays in the active "spawned" state until every assigned
 * worktree publishes both of run-worker.sh's terminal markers. This pass is
 * intentionally a later-poll reconciliation; one-shot runs return while the
 * issue is still labelled running.
 */
async function reconcileHeadlessCodeJobs(input: JobReconcileInput): Promise<{ state: WatcherState; failures: number }> {
	let state = input.state
	let failures = 0
	const currentIssues = new Map(input.issues.map((issue) => [issue.number, issue]))
	for (const entry of Object.values(state.processed)) {
		if (!entry.jobContract) continue
		if (entry.status === "failed") {
			if (input.dryRun || !await verifyJobClaim(entry, input.claims, input.claimStore)) continue
			try {
				await setIssueLifecycle(input.gh, input.owner, input.repo, entry.number, "failed")
				const marker = jobFailureMarker(entry)
				const comments = await requireComments(input.gh, input.owner, input.repo, entry.number)
				if (!comments.some((body) => body.includes(marker))) {
					const completion = readJobCompletion(input.repoRoot, entry.groups ?? [])
					const summary = completion.terminal
						? completion.exitCodes.map((code, index) => `${entry.groups?.[index]?.name ?? `worker-${index + 1}`}: exit ${code}`).join("; ")
						: safeError(entry.error ?? "job did not start")
					const logSummary = completion.terminal ? completion.logs.filter(Boolean).join("\n\n").slice(-8000) : ""
					await requireCommentWriter(input.gh)(input.owner, input.repo, entry.number,
						`HeadlessCode job failed (${summary}). The watcher does not close failed job issues; review the worker summary before retrying.\n\n${logSummary ? `Bounded worker log summary:\n\n\`\`\`text\n${logSummary}\n\`\`\`\n\n` : ""}${marker}`)
				}
			} catch (error) {
				failures++
				input.logger.warn(`watcher: issue #${entry.number} failure result could not be reflected in GitHub; it will retry on a later poll: ${safeError(error)}`)
			}
			continue
		}
		if (entry.status !== "spawned") continue
		const completion = readJobCompletion(input.repoRoot, entry.groups ?? [])
		if (!completion.terminal) {
			const issue = currentIssues.get(entry.number)
			const lifecycleOutOfSync = !!issue && (!issue.labels.includes("headlesscode:running") || JOB_LIFECYCLE_LABELS.some((label) => label !== "headlesscode:running" && issue.labels.includes(label)))
			if (issue && lifecycleOutOfSync && !input.dryRun && await verifyJobClaim(entry, input.claims, input.claimStore)) {
				try { await setIssueLifecycle(input.gh, input.owner, input.repo, entry.number, "running") }
				catch (error) { failures++; input.logger.warn(`watcher: issue #${entry.number} is still running, but its lifecycle label could not be refreshed: ${safeError(error)}`) }
			}
			continue
		}
		if (!await verifyJobClaim(entry, input.claims, input.claimStore)) {
			input.logger.warn(`watcher: issue #${entry.number} completion found, but its runner claim could not be verified; leaving lifecycle unchanged`)
			continue
		}
		if (input.dryRun) continue
		const terminal: "done" | "failed" = completion.exitCodes.every((code) => code === 0) ? "done" : "failed"
		const summary = completion.exitCodes.map((code, index) => `${entry.groups?.[index]?.name ?? `worker-${index + 1}`}: exit ${code}`).join("; ")
		try {
			await setIssueLifecycle(input.gh, input.owner, input.repo, entry.number, terminal)
			const commentMarker = terminal === "failed" ? jobFailureMarker({ ...entry, error: summary }) : jobCommentMarker(entry)
			const priorComments = await requireComments(input.gh, input.owner, input.repo, entry.number)
			if (!priorComments.some((body) => body.includes(commentMarker))) {
				const logSummary = completion.logs.filter(Boolean).join("\n\n").slice(-8000)
				if (terminal === "done") {
					const lookup = await findVerifiedJobPullRequests(input, entry)
					const prText = lookup.pullRequests.length > 0
						? lookup.pullRequests.map((pr) => `- [#${pr.number}](${pr.url})`).join("\n")
						: lookup.branchesChecked > 0
							? "No pull request was found for the generated worker branches."
							: "Pull request lookup was unavailable because no generated worker branch could be verified; no PR link is included."
					await requireCommentWriter(input.gh)(input.owner, input.repo, entry.number,
						`HeadlessCode job finished successfully (${summary}).\n\n${logSummary ? `Bounded worker log summary:\n\n\`\`\`text\n${logSummary}\n\`\`\`\n\n` : ""}Pull request lookup:\n${prText}\n\n${commentMarker}`)
				} else {
					await requireCommentWriter(input.gh)(input.owner, input.repo, entry.number,
						`HeadlessCode job failed (${summary}). The watcher does not close failed job issues; review the worker summary before retrying.\n\n${logSummary ? `Bounded worker log summary:\n\n\`\`\`text\n${logSummary}\n\`\`\`\n\n` : ""}${commentMarker}`)
				}
			}
			if (terminal === "done") await requireIssueCloser(input.gh)(input.owner, input.repo, entry.number)
			state = markProcessed(state, { ...entry, status: terminal, updatedAt: new Date().toISOString(), ...(terminal === "failed" ? { error: summary } : { error: undefined }) })
		} catch (error) {
			failures++
			input.logger.warn(`watcher: issue #${entry.number} reached ${terminal}, but GitHub lifecycle update did not finish; it will retry on a later poll: ${safeError(error)}`)
		}
	}
	return { state, failures }
}

async function verifyJobClaim(
	entry: WatcherIssueEntry,
	claims: readonly ClaimSnapshot[],
	store: GitHubIssueClaimStore | undefined,
): Promise<boolean> {
	if (!entry.claim) return true
	if (!store) return false
	const snapshot = claims.find(({ claim }) => claim.issue === entry.number &&
		claim.runnerId === entry.claim!.runnerId && claim.leaseNonce === entry.claim!.leaseNonce &&
		claim.epoch === entry.claim!.epoch && sameStringArray(claim.worktreeNames, entry.claim!.worktreeNames))
	if (!snapshot) return false
	try {
		const current = await store.read(entry.number)
		return !!current && current.claim.phase === "active" &&
			current.claim.runnerId === snapshot.claim.runnerId && current.claim.leaseNonce === snapshot.claim.leaseNonce &&
			current.claim.epoch === snapshot.claim.epoch && sameStringArray(current.claim.worktreeNames, snapshot.claim.worktreeNames)
	} catch {
		return false
	}
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index])
}

async function setIssueLifecycle(gh: GhClient, owner: string, repo: string, number: number, lifecycle: JobLifecycle): Promise<void> {
	const selected = `headlesscode:${lifecycle}`
	if (!gh.removeLabel) throw new Error("GitHub client cannot remove stale job lifecycle labels")
	await gh.addLabel(owner, repo, number, selected)
	for (const label of JOB_LIFECYCLE_LABELS) if (label !== selected) await gh.removeLabel(owner, repo, number, label)
}

function requireComments(gh: GhClient, owner: string, repo: string, number: number): Promise<string[]> {
	if (!gh.listIssueComments) throw new Error("GitHub client cannot check existing job result comments")
	return gh.listIssueComments(owner, repo, number)
}

function requireCommentWriter(gh: GhClient): NonNullable<GhClient["createIssueComment"]> {
	if (!gh.createIssueComment) throw new Error("GitHub client cannot post job result comments")
	return gh.createIssueComment.bind(gh)
}

function requireIssueCloser(gh: GhClient): NonNullable<GhClient["closeIssue"]> {
	if (!gh.closeIssue) throw new Error("GitHub client cannot close completed job issues")
	return gh.closeIssue.bind(gh)
}

async function reportJobIntakeFailure(gh: GhClient, owner: string, repo: string, number: number, message: string, logger: Logger): Promise<void> {
	const marker = jobFailureMarker({ number, error: message })
	try {
		await setIssueLifecycle(gh, owner, repo, number, "failed")
		const comments = await requireComments(gh, owner, repo, number)
		if (!comments.some((body) => body.includes(marker))) {
			await requireCommentWriter(gh)(owner, repo, number, `HeadlessCode could not dispatch this job: ${safeError(message)}\n\n${marker}`)
		}
	} catch (error) {
		logger.warn(`watcher: issue #${number} intake failure could not be reflected in GitHub: ${safeError(error)}`)
	}
}

function jobCommentMarker(entry: WatcherIssueEntry): string {
	const key = createHash("sha256").update(`${entry.number}\0${entry.spawnedAt ?? ""}`).digest("hex").slice(0, 24)
	return `<!-- headlesscode-job-result:${key} -->`
}

function jobFailureMarker(entry: Pick<WatcherIssueEntry, "number"> & Partial<Pick<WatcherIssueEntry, "spawnedAt" | "error">>): string {
	const key = createHash("sha256").update(`${entry.number}\0${entry.spawnedAt ?? ""}\0${entry.error ?? ""}`).digest("hex").slice(0, 24)
	return `<!-- headlesscode-job-failure:${key} -->`
}

interface JobCompletion {
	terminal: boolean
	exitCodes: number[]
	logs: string[]
}

function readJobCompletion(repoRoot: string, groups: readonly WorktreeSpec[]): JobCompletion {
	if (groups.length === 0 || groups.length > 16) return { terminal: false, exitCodes: [], logs: [] }
	const exitCodes: number[] = []
	const logs: string[] = []
	for (const group of groups) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(group.name)) return { terminal: false, exitCodes: [], logs: [] }
		const worktree = path.join(repoRoot, ".worktrees", group.name)
		try {
			const rootStat = fs.lstatSync(path.join(repoRoot, ".worktrees"))
			const worktreeStat = fs.lstatSync(worktree)
			const doneStat = fs.lstatSync(path.join(worktree, ".harness.done"))
			if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || worktreeStat.isSymbolicLink() || !worktreeStat.isDirectory() || doneStat.isSymbolicLink() || !doneStat.isDirectory()) return { terminal: false, exitCodes: [], logs: [] }
		} catch {
			return { terminal: false, exitCodes: [], logs: [] }
		}
		const rawExit = readSmallRegularFile(path.join(worktree, ".harness.exit"), 32)
		if (rawExit === undefined || !/^(?:0|[1-9][0-9]{0,2})\n?$/.test(rawExit)) return { terminal: false, exitCodes: [], logs: [] }
		const exitCode = Number(rawExit.trim())
		if (exitCode > 255) return { terminal: false, exitCodes: [], logs: [] }
		exitCodes.push(exitCode)
		logs.push(readBoundedLogTail(path.join(worktree, "harness.log")))
	}
	return { terminal: true, exitCodes, logs }
}

function readSmallRegularFile(filePath: string, maxBytes: number): string | undefined {
	let fd: number | undefined
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
		const stat = fs.fstatSync(fd)
		if (!stat.isFile() || stat.size > maxBytes) return undefined
		const buffer = Buffer.alloc(maxBytes + 1)
		const length = fs.readSync(fd, buffer, 0, buffer.length, 0)
		if (length > maxBytes) return undefined
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))
	} catch {
		return undefined
	} finally {
		if (fd !== undefined) fs.closeSync(fd)
	}
}

function readBoundedLogTail(filePath: string): string {
	const maxBytes = 16 * 1024
	let fd: number | undefined
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
		const stat = fs.fstatSync(fd)
		if (!stat.isFile()) return ""
		const size = Math.min(stat.size, maxBytes)
		const buffer = Buffer.alloc(size)
		fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size))
		const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer)
		return sanitizeJobSummary(text.split(/\r?\n/).slice(-20).join("\n"))
	} catch {
		return ""
	} finally {
		if (fd !== undefined) fs.closeSync(fd)
	}
}

function sanitizeJobSummary(value: string): string {
	return value
		.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.replace(/```/g, "'''" )
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-or-v1-[A-Za-z0-9_-]{16,})\b/g, "[redacted credential]")
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, "[redacted secret field]")
		.replace(/https?:\/\/\S+/gi, "[URL redacted]")
		.replace(/@/g, "@\u200b")
		.slice(-4000)
}

async function findVerifiedJobPullRequests(input: JobReconcileInput, entry: WatcherIssueEntry): Promise<{ pullRequests: GitHubPullRequestSummary[]; branchesChecked: number }> {
	if (!input.gh.listPullRequestsForHead) return { pullRequests: [], branchesChecked: 0 }
	const state = loadStateSync(path.join(input.repoRoot, ".worktrees", ".orchestrator-state.json"))
	const verified: GitHubPullRequestSummary[] = []
	let branchesChecked = 0
	for (const group of entry.groups ?? []) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(group.name)) continue
		const generated = state?.groups?.find((candidate) => candidate.name === group.name)
		const branch = generated?.branch
		if (typeof branch !== "string" || !new RegExp(`^issues/${escapeRegExp(group.name)}-\\d{4}-\\d{2}-\\d{2}(?:-\\d+)?$`).test(branch)) continue
		branchesChecked++
		const pullRequests = await input.gh.listPullRequestsForHead(input.owner, input.repo, branch)
		for (const pr of pullRequests) {
			if (pr.branch !== branch || pr.baseRepository.toLowerCase() !== `${input.owner}/${input.repo}`.toLowerCase() || pr.headRepository.toLowerCase() !== `${input.owner}/${input.repo}`.toLowerCase()) continue
			if (!isVerifiedPullRequestUrl(pr.url, pr.number, input.owner, input.repo, input.ghBaseUrl)) continue
			verified.push(pr)
		}
	}
	return { pullRequests: [...new Map(verified.map((pr) => [pr.number, pr])).values()].sort((a, b) => a.number - b.number), branchesChecked }
}

function isVerifiedPullRequestUrl(value: string, expectedNumber: number, owner: string, repo: string, apiBaseUrl?: string): boolean {
	try {
		const url = new URL(value)
		if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return false
		const match = new RegExp(`^/${escapeRegExp(owner)}/${escapeRegExp(repo)}/pull/([1-9][0-9]*)$`, "i").exec(url.pathname)
		if (!match || Number(match[1]) !== expectedNumber) return false
		const apiBase = apiBaseUrl ?? process.env.GITHUB_API_BASE_URL ?? DEFAULT_GH_BASE_URL
		const apiHost = new URL(apiBase).hostname
		const expectedHost = apiHost === "api.github.com" ? "github.com" : apiHost
		return url.hostname === expectedHost
	} catch {
		return false
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function safeError(error: unknown): string {
	return sanitizeJobSummary(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300)
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
	const result = spawnSync("bash", ["-c", command], {
		cwd: batch.repoRoot,
		env: buildWorkerSpawnEnvironment(batch, config),
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

const GITHUB_AUTH_ENV = [
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GITHUB_APP_ID",
	"GITHUB_APP_PRIVATE_KEY",
	"GITHUB_APP_PRIVATE_KEY_PATH",
	"GITHUB_APP_INSTALLATION_ID",
] as const

/** Construct the exact inherited environment passed to the worker spawner. */
export function buildWorkerSpawnEnvironment(
	batch: SpawnBatch,
	config: Pick<WatcherConfig, "mode" | "memoryDir" | "executionProvider" | "runnerId">,
	baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = { ...baseEnv }
	if (config.runnerId) {
		// The pool's GitHub credentials belong to the watcher. The worker must
		// not inherit either token environment variables or App signing material
		// that could mint an equivalent installation token.
		for (const name of GITHUB_AUTH_ENV) delete childEnv[name]
	}
	return {
		...childEnv,
		TARGET_REPO: batch.repoRoot,
		ORCHESTRATOR_MODE: config.mode ?? "code",
		HEADLESSCODE_EXECUTION_PROVIDER: config.executionProvider ?? baseEnv.HEADLESSCODE_EXECUTION_PROVIDER ?? "local",
		HEADLESSCODE_AGENT_EXECUTOR: batch.executor,
		HEADLESSCODE_NATIVE_MUSE_MODEL: batch.museModel ?? "",
		HEADLESSCODE_PROJECT: path.basename(batch.repoRoot),
		...(config.memoryDir ? { HEADLESSCODE_MEMORY_DIR: path.resolve(config.memoryDir) } : {}),
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
