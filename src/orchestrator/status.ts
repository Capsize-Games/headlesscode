/**
 * `headlesscode orchestrate status` — read-side status command for EXTERNAL
 * callers (an interactive orchestrator agent checking on a round from outside
 * the watching process). Reads `.worktrees/.orchestrator-state.json` via
 * loadStateSync (state.ts) — it never re-implements parsing and does NOT
 * touch watch.ts's own live-monitoring loop.
 *
 * Reconciliation: before reporting (and on EVERY poll while waiting), every
 * group whose `status` is non-terminal is checked against real worktree
 * markers (`.harness.done` + `.harness.exit`), and when the ground truth
 * proves a different status the state file is patched back via
 * updateGroup/saveStateSync (state.ts):
 *   - `.harness.done` present  -> "done" (exit 0) / "failed" (non-zero)
 *   - worktree entirely gone   -> "orphaned" (terminal — evidence is gone,
 *                                 a human must investigate via git history)
 *   - worktree present, no marker -> left alone (genuinely still running)
 * This closes the gap where a direct-path round (spawn-parallel-worktrees.sh,
 * no watcher) left group entries stuck on "running" forever.
 *
 * Issue #116: the --wait form NEVER persists its reconciliation while a live
 * watcher owns the state (watchGroups' heartbeat file under
 * `<statePath>.watcher` is fresh AND written by a DIFFERENT process — the
 * wait never writes that file itself, so its own PID can never masquerade as
 * a live watcher; the different-PID check exists so a watcher-less wait
 * keeps its persist-through behavior instead of locking itself out from its
 * second poll onward) — it reconciles in-memory for terminality checks only.
 * Persisting there would pre-empt the watcher, which then short-circuits the
 * group as already-terminal and silently skips log analysis + the automated
 * review pass. The one-shot form (and --wait against a watcher-less round)
 * keeps the persist-through behavior: for a direct-path round with no
 * watcher, `status` is the state file's only writer and must patch stale
 * entries back.
 *
 * Two forms:
 *   - one-shot: print a compact per-group summary (or the reconciled state
 *     with --json) and exit.
 *   - --wait: block inside this ONE process until every group reaches a
 *     terminal status ("done" | "failed" | "needs-human" | "orphaned" —
 *     "blocked" is deliberately NOT terminal: it is a decision-escalation
 *     wait state that keeps this command waiting) or --timeout-ms elapses,
 *     then print the same summary plus a one-line verdict.
 *
 * Polling the state file (not fs.watch) is a deliberate choice: the file is
 * written by watch.ts, which itself polls at DEFAULT_POLL_INTERVAL_MS, so a
 * faster read interval buys nothing; fs.watch on a regular file is
 * unreliable when the writer replaces the file via rename rather than
 * truncating in place (and the file may not exist at wait-start);
 * fs.watchFile is itself just polling with extra steps. A plain poll loop
 * matches the existing watch.ts idiom and is trivially testable.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { CleanupStatus } from "./cleanup.js"
import {
	defaultState,
	loadStateSync,
	saveStateSync,
	updateGroup,
	type OrchestratorGroup,
	type OrchestratorState,
} from "./state.js"
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_STALL_TIMEOUT_MS, groupWorktreePath } from "./watch.js"

/**
 * The statuses that end a round for a group. `blocked` is NOT here on
 * purpose: a group waiting on a decision answer is not finished, and
 * `--wait` must keep waiting rather than exit early (see state.ts's
 * OrchestratorGroup.status doc comment). `orphaned` IS here: the group's
 * worktree is gone, so there is nothing left to wait FOR — the evidence is
 * gone, and reconciliation (reconcileGroups) has already surfaced the case
 * for a human to investigate rather than silently guessing an outcome.
 */
export const TERMINAL_STATUSES = ["done", "failed", "needs-human", "orphaned"] as const

export function isTerminalStatus(status: string): boolean {
	return TERMINAL_STATUSES.includes(status as (typeof TERMINAL_STATUSES)[number])
}

/**
 * Default `--timeout-ms`: 2h, matching watch.ts's stall guard
 * (DEFAULT_STALL_TIMEOUT_MS). A round whose groups sit non-terminal for
 * longer than that is flagged stalled by the watcher anyway, so waiting past
 * it for terminality is pointless — this is the ceiling and the default.
 */
export const DEFAULT_STATUS_TIMEOUT_MS = DEFAULT_STALL_TIMEOUT_MS

/**
 * Default state-file poll interval for `--wait`: 5s, matching watch.ts's
 * DEFAULT_POLL_INTERVAL_MS — the watcher writes the file at that rate, so a
 * shorter interval cannot observe anything earlier.
 */
export const DEFAULT_STATUS_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS

// ─── Summary shaping ────────────────────────────────────────────────────────

export interface StatusGroupRow {
	name: string
	status: string
	lastActivity: string
	reviewVerdict?: string
	findingsCount: number
	usageCostUsd?: number
	exitCode?: number
	stalled: boolean
	blockedQuestion?: string
	qaVerdict?: string
	/**
	 * Cleanup eligibility for TERMINAL groups (computed by the status CLI via
	 * cleanup.ts's assessGroupCleanupSync — the same gates the cleanup command
	 * uses, minus the network). eligible | blocked (<reason>) | done. Undefined
	 * for non-terminal groups (never touched by cleanup).
	 */
	cleanup?: CleanupStatus
	/**
	 * Auto-continuation/rework activity (undefined/0 = never happened). A
	 * real gap this surfaces: a caller watching a round from the outside had
	 * no visibility into whether auto-continuation after --max-iterations
	 * was actually firing, so they resorted to manually re-invoking
	 * run-worker.sh against the same worktree instead of trusting the
	 * documented auto-continue behavior. Both counts already lived on
	 * OrchestratorGroup (continuationCount/reworkCount) — this just threads
	 * them through to the human/agent-facing status output.
	 */
	continuationCount?: number
	reworkCount?: number
	/**
	 * Issue #49 plan-first outcome (undefined = round was not run with
	 * --plan-first): the architect-mode planning session that ran before this
	 * group's code worker, and whether a plan actually landed in the worker's
	 * task file.
	 */
	planFirst?: OrchestratorGroup["plan_first"]
}

export interface StatusCounts {
	total: number
	done: number
	failed: number
	needsHuman: number
	blocked: number
	running: number
	/** Worktree gone before a terminal status — surfaced for a human (terminal). */
	orphaned: number
	other: number
}

export interface StatusSummary {
	batch?: string
	updated?: string
	groups: StatusGroupRow[]
	counts: StatusCounts
	totalUsage?: OrchestratorState["totalUsage"]
	/** Issue #118: usage summed over only the current batch's groups (undefined when none yet). */
	batchUsage?: OrchestratorState["batchUsage"]
}

function lastActivityText(group: OrchestratorGroup): string {
	const la = group.last_activity
	if (typeof la === "string") {
		return la
	}
	if (la !== null && typeof la === "object") {
		return la.note ?? la.last_commit ?? ""
	}
	return ""
}

/** Shape the loaded state into the compact per-group rows the CLI prints. */
export function buildStatusSummary(state: OrchestratorState): StatusSummary {
	const counts: StatusCounts = {
		total: state.groups.length,
		done: 0,
		failed: 0,
		needsHuman: 0,
		blocked: 0,
		running: 0,
		orphaned: 0,
		other: 0,
	}
	const groups = state.groups.map((g) => {
		switch (g.status) {
			case "done":
				counts.done++
				break
			case "failed":
				counts.failed++
				break
			case "needs-human":
				counts.needsHuman++
				break
			case "blocked":
				counts.blocked++
				break
			case "running":
			case "spawned":
				counts.running++
				break
			case "orphaned":
				counts.orphaned++
				break
			default:
				counts.other++
				break
		}
		return {
			name: g.name,
			status: g.status,
			lastActivity: lastActivityText(g),
			reviewVerdict: g.review_verdict,
			findingsCount: g.pending_review_findings?.length ?? 0,
			usageCostUsd: g.usage?.costUsd,
			exitCode: g.exit_code,
			stalled: g.stalled === true,
			blockedQuestion: g.blocked?.question,
			qaVerdict: g.qa?.verdict,
			continuationCount: g.continuationCount,
			reworkCount: g.reworkCount,
			planFirst: g.plan_first,
		}
	})
	return {
		batch: state.batch,
		updated: state.updated,
		groups,
		counts,
		totalUsage: state.totalUsage,
		batchUsage: state.batchUsage,
	}
}

/**
 * One-line verdict for the `--wait` form, e.g. "3/3 groups done, 0 failed"
 * or "timed out after 2 of 3 groups done". Orphaned groups are called out
 * explicitly (they are terminal but NOT done — a human must investigate).
 */
export function verdictLine(summary: StatusSummary, timedOut: boolean, allDone: boolean): string {
	const c = summary.counts
	if (c.total === 0) {
		return "nothing to wait for — no groups in state"
	}
	if (timedOut) {
		const tail: string[] = []
		if (c.failed > 0 || c.needsHuman > 0) {
			tail.push(`${c.failed} failed, ${c.needsHuman} needs-human`)
		}
		if (c.orphaned > 0) {
			tail.push(`${c.orphaned} orphaned`)
		}
		return `timed out after ${c.done} of ${c.total} group${c.total === 1 ? "" : "s"} done${tail.length > 0 ? ` (${tail.join("; ")})` : ""}`
	}
	if (allDone) {
		return `${c.total}/${c.total} groups done, 0 failed`
	}
	// All terminal, but not all done → failed and/or needs-human and/or orphaned present.
	const tail: string[] = []
	if (c.failed > 0) {
		tail.push(`${c.failed} failed`)
	}
	if (c.needsHuman > 0) {
		tail.push(`${c.needsHuman} needs-human`)
	}
	if (c.orphaned > 0) {
		tail.push(`${c.orphaned} orphaned`)
	}
	return `all ${c.total} group${c.total === 1 ? "" : "s"} terminal, but ${tail.length > 0 ? tail.join(" / ") : "something unresolved"}`
}

/** Human-readable status block (one-shot form when timedOut/allDone are omitted). */
export function formatStatusText(
	summary: StatusSummary,
	opts: {
		repo: string
		statePath: string
		timedOut?: boolean
		allDone?: boolean
		elapsedMs?: number
		/** Group names this call reconciled from stale markers (shown when non-empty). */
		reconciled?: string[]
	},
): string {
	const c = summary.counts
	const lines: string[] = []
	lines.push(
		`── Orchestrator status${opts.elapsedMs !== undefined ? ` (waited ${Math.round(opts.elapsedMs)}ms)` : ""} ──`,
	)
	lines.push(`repo:       ${opts.repo}`)
	lines.push(`state file: ${opts.statePath}`)
	lines.push(`batch:      ${summary.batch ?? "(none)"}`)
	lines.push(`updated:    ${summary.updated ?? "(never)"}`)
	if (summary.totalUsage) {
		const u = summary.totalUsage
		lines.push(
			`total usage: $${u.costUsd.toFixed(4)} · ${u.inputTokens} in / ${u.outputTokens} out tokens` +
				(u.iterations > 0 ? ` · ${u.iterations} iterations` : ""),
		)
	}
	if (summary.batchUsage) {
		const u = summary.batchUsage
		lines.push(
			`batch usage: $${u.costUsd.toFixed(4)} · ${u.inputTokens} in / ${u.outputTokens} out tokens` +
				(u.iterations > 0 ? ` · ${u.iterations} iterations` : "") +
				" (this round only)",
		)
	}

	if (c.total === 0) {
		lines.push("")
		lines.push("No orchestrator groups found in this state file (nothing to report / wait for).")
	} else {
		lines.push("")
		lines.push(`${"GROUP".padEnd(14)}${"STATUS".padEnd(12)}${"CLEANUP".padEnd(12)}LAST ACTIVITY · REVIEW · QA · USAGE`)
		for (const g of summary.groups) {
			const bits: string[] = []
			if (g.lastActivity) {
				bits.push(g.lastActivity)
			}
			if (g.reviewVerdict) {
				bits.push(`review:${g.reviewVerdict}${g.findingsCount > 0 ? `(${g.findingsCount})` : ""}`)
			}
			if (g.qaVerdict) {
				bits.push(`qa:${g.qaVerdict}`)
			}
			if (g.continuationCount !== undefined && g.continuationCount > 0) {
				bits.push(`continued:${g.continuationCount}`)
			}
			if (g.reworkCount !== undefined && g.reworkCount > 0) {
				bits.push(`rework:${g.reworkCount}`)
			}
			if (g.planFirst !== undefined) {
				bits.push(`plan-first:${g.planFirst.status}${g.planFirst.status === "ok" ? " (plan in task file)" : ""}`)
			}
			if (g.usageCostUsd !== undefined) {
				bits.push(`$${g.usageCostUsd.toFixed(4)}`)
			}
			if (g.stalled) {
				bits.push("STALLED")
			}
			if (g.blockedQuestion) {
				bits.push(`blocked: ${g.blockedQuestion}`)
			}
			if (g.cleanup?.status === "blocked") {
				bits.push(`cleanup: ${g.cleanup.reason}`)
			}
			const cleanupCell =
				g.cleanup === undefined ? "-" : g.cleanup.status === "eligible" ? "eligible" : g.cleanup.status === "done" ? "done" : "blocked"
			lines.push(`${g.name.padEnd(14)}${g.status.padEnd(12)}${cleanupCell.padEnd(12)}${bits.join(" · ")}`)
		}
		lines.push("")
		lines.push(
			`${c.total} group${c.total === 1 ? "" : "s"}: ${c.done} done · ${c.failed} failed · ` +
				`${c.needsHuman} needs-human · ${c.blocked} blocked · ${c.running} running/spawned` +
				(c.orphaned > 0 ? ` · ${c.orphaned} orphaned` : "") +
				(c.other > 0 ? ` · ${c.other} other` : ""),
		)
	}

	if (opts.reconciled !== undefined && opts.reconciled.length > 0) {
		lines.push("")
		lines.push(`reconciled: ${opts.reconciled.join(", ")} (stale status patched from worktree markers)`)
	}

	if (opts.timedOut !== undefined || opts.allDone !== undefined) {
		lines.push("")
		lines.push(`verdict: ${verdictLine(summary, opts.timedOut ?? false, opts.allDone ?? false)}`)
	}
	return lines.join("\n") + "\n"
}

// ─── Read-side reconciliation ────────────────────────────────────────────────

export interface ReconcileHooks {
	/** Worktree existence check (default: fs.existsSync). */
	worktreeExists?: (worktreePath: string) => boolean
	/** `.harness.done` marker check (default: directory at <wt>/.harness.done). */
	hasDoneMarker?: (worktreePath: string) => boolean
	/** `.harness.exit` reader (default: parse <wt>/.harness.exit, undefined when absent/invalid). */
	readExitCode?: (worktreePath: string) => number | undefined
}

export interface ReconcileResult {
	/** The reconciled state (unchanged when nothing was patched). */
	state: OrchestratorState
	/** Group names whose status/exit_code were patched by this pass. */
	reconciled: string[]
}

/**
 * Reconcile a state's non-terminal groups against REAL worktree markers.
 * This is the fix for the 2026-08-02 `--wait` hang: a worker that genuinely
 * finished (`.harness.done` present, process dead) but whose state entry
 * still said "running", and groups from long-merged rounds whose worktrees
 * were removed while the state still said "running". Only positive evidence
 * triggers a patch — a worktree that still exists without a `.harness.done`
 * marker is left alone (genuinely still running, not ours to second-guess).
 *
 * Pure: returns a new state + the names patched; does NOT persist. Callers
 * persist via saveStateSync when `reconciled` is non-empty.
 */
export function reconcileGroups(state: OrchestratorState, repo: string, hooks: ReconcileHooks = {}): ReconcileResult {
	const worktreeExists = hooks.worktreeExists ?? ((p: string): boolean => fs.existsSync(p))
	const hasDoneMarker = hooks.hasDoneMarker ?? ((p: string): boolean => {
		try {
			return fs.statSync(path.join(p, ".harness.done")).isDirectory()
		} catch {
			return false
		}
	})
	const readExitCode = hooks.readExitCode ?? ((p: string): number | undefined => {
		try {
			const raw = fs.readFileSync(path.join(p, ".harness.exit"), "utf-8").trim()
			const code = Number(raw)
			return Number.isFinite(code) ? code : undefined
		} catch {
			return undefined
		}
	})

	let current = state
	const reconciled: string[] = []
	for (const group of state.groups) {
		if (isTerminalStatus(group.status)) {
			continue
		}
		const wtPath = groupWorktreePath(repo, group)
		if (hasDoneMarker(wtPath)) {
			// Ground truth exists: the worker finished. Mirror watch.ts's
			// mapping (exit 0 → done, anything else/unknown → failed).
			const exitCode = readExitCode(wtPath)
			const status = exitCode === 0 ? "done" : "failed"
			current = updateGroup(current, group.name, {
				status,
				...(exitCode !== undefined ? { exit_code: exitCode } : {}),
				last_activity: {
					note:
						exitCode === 0
							? "reconciled from .harness markers: worker completed cleanly (exit 0)"
							: `reconciled from .harness markers: worker exited ${exitCode ?? "with unknown code"}`,
				},
			})
			reconciled.push(group.name)
		} else if (!worktreeExists(wtPath)) {
			// Worktree entirely gone, never reached a terminal status: the
			// outcome is genuinely unknowable from markers — surface it as
			// "orphaned" for a human instead of silently guessing done.
			current = updateGroup(current, group.name, {
				status: "orphaned",
				last_activity: {
					note: "orphaned: worktree removed before a terminal status — investigate via git history",
				},
			})
			reconciled.push(group.name)
		}
		// else: worktree still present, no .harness.done → still in progress;
		// absence of evidence is not evidence of absence — leave as-is.
	}
	return { state: current, reconciled }
}

// ─── Blocking wait ───────────────────────────────────────────────────────────

export interface WaitForTerminalOptions {
	/** Max wall-clock wait (default DEFAULT_STATUS_TIMEOUT_MS = 2h). */
	timeoutMs?: number
	/** State-file poll interval (default DEFAULT_STATUS_POLL_INTERVAL_MS = 5s). */
	pollIntervalMs?: number
	/** Abort the wait early (returns the current state, not timed out). */
	signal?: AbortSignal
	/** Injectable state reader (default: loadStateSync on statePath). */
	readState?: () => OrchestratorState
	/**
	 * Read-side reconciliation applied to EVERY polled state (not just the
	 * first — a group can finish mid-wait) BEFORE the terminality check.
	 * Return the (possibly patched) state plus the names reconciled; the
	 * loop accumulates the union across polls into the result's
	 * `reconciled` list.
	 */
	reconcile?: (state: OrchestratorState) => ReconcileResult
	/**
	 * Called immediately when a group transitions to a terminal status
	 * (done/failed/needs-human/orphaned) during the wait — fires once per
	 * group per transition. Does NOT fire for non-terminal transitions
	 * (blocked, running, spawned). Never called for groups that were already
	 * terminal before the wait started (including groups whose initial
	 * "running" entry was stale state the FIRST reconciliation fixed to
	 * terminal — those were always terminal, just stale in the file).
	 * May return a promise; the wait loop awaits it so transitions are
	 * processed sequentially (e.g. a --on-group-terminal hook command).
	 */
	onGroupTerminal?: (group: OrchestratorGroup) => void | Promise<void>
}

export interface WaitForTerminalResult {
	state: OrchestratorState
	/** Every group reached status "done" (all terminal AND nothing failed). */
	allDone: boolean
	timedOut: boolean
	elapsedMs: number
	/** Group names reconciled (patched to done/failed/orphaned) across all polls. */
	reconciled: string[]
}

/**
 * Block until every group in the state file is terminal (or the timeout
 * elapses, or the signal aborts). An empty state file (no round yet) returns
 * immediately — there is nothing to wait for, and hanging on a wrong path
 * would be worse than returning a clear "no groups" result.
 *
 * Transient JSON parse errors are treated as "not readable yet": the loop
 * retries on the next poll instead of crashing the wait. This tolerance is
 * NOT because the writer is non-atomic — saveStateSync (state.ts) writes to
 * a pid+counter-suffixed temp sibling and renames it over the target, so a
 * concurrent reader never observes a partially-written file. It's defensive
 * anyway: a reader could still race a rename on filesystems/platforms where
 * rename isn't atomic, or hit a transient ENOENT between the old file being
 * gone and the new one appearing, so treating a parse failure as "retry, not
 * crash" costs nothing and remains correct.
 */
export async function waitForTerminalState(
	statePath: string,
	opts: WaitForTerminalOptions = {},
): Promise<WaitForTerminalResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS
	const readState = opts.readState ?? ((): OrchestratorState => loadStateSync(statePath))
	const start = Date.now()
	const deadline = start + timeoutMs

	const readTolerant = (): OrchestratorState | null => {
		try {
			return readState()
		} catch {
			return null
		}
	}

	const reconciled: string[] = []
	const reconciledSeen = new Set<string>()

	// Apply read-side reconciliation to a freshly-read state and record any
	// patched group names (deduped across polls). Returns the ReconcileResult
	// (state + names patched) so callers can decide whether to persist.
	const applyReconcile = (s: OrchestratorState): ReconcileResult => {
		if (!opts.reconcile) {
			return { state: s, reconciled: [] }
		}
		const result = opts.reconcile(s)
		for (const name of result.reconciled) {
			if (!reconciledSeen.has(name)) {
				reconciledSeen.add(name)
				reconciled.push(name)
			}
		}
		return result
	}

	// The 2026-08-18 bug (issue #116): a `status --wait` running CONCURRENTLY
	// with a live orchestrate round used to persist its read-side
	// reconciliation straight back to the shared state file. The watcher's
	// next poll then loaded the group as already-terminal and short-circuited
	// on it — log analysis and the automated review pass never fired (groups
	// w13/w14 settled as "done" with review_verdict/log_analysis absent).
	// The watcher is the only process that owns review/QA/continuation
	// workflows; a read-side `status` must never pre-empt it.
	//
	// Watcher heartbeat: the live watching process (watchGroups, watch.ts)
	// stamps its own PID under <statePath>.watcher (a plain file write, no
	// lock — the point is not exclusivity but honesty: if the watcher wrote
	// the file RECENTLY, it is alive and owns the state). The wait NEVER
	// writes this file itself — a wait's own PID must never masquerade as a
	// live watcher (rework cycle 2 finding: be11a6d reintroduced the exact
	// #116 pre-emption bug by stamping the wait's PID every poll, clobbering
	// the real watcher's fresh heartbeat and unlocking the persist). A round
	// with no watcher at all (direct-path spawn-parallel-worktrees.sh rounds,
	// which `status` exists to reconcile for) leaves no heartbeat file, so
	// the wait keeps its persist-through behavior in that case.
	//
	// Staleness is measured against the WATCHER's heartbeat cadence
	// (DEFAULT_POLL_INTERVAL_MS — the watcher stamps the file once per poll),
	// NOT this wait's own poll interval: a --wait polled faster than the
	// watcher (e.g. --poll-interval-ms 1000 against a 5s watcher) must not
	// declare the watcher dead between the watcher's refreshes, or it would
	// unlock the exact #116 persist again (rework cycle 2 finding: the
	// rework-2 mid-wait test with a 25ms poll exposed this — 3×25ms expired
	// before the live watcher's 5s heartbeat had refreshed).
	const WATCHER_STALENESS_MS = 3 * DEFAULT_POLL_INTERVAL_MS

	const liveWatcher = (): boolean => {
		try {
			const stat = fs.statSync(`${statePath}.watcher`)
			if (Date.now() - stat.mtimeMs >= WATCHER_STALENESS_MS) {
				return false
			}
			// The heartbeat file must carry a DIFFERENT process's PID to
			// count: a wait must never mistake its own earlier write for a
			// live watcher (the reviewer's finding on the first #116 fix).
			const pid = Number(fs.readFileSync(`${statePath}.watcher`, "utf-8"))
			return Number.isFinite(pid) && pid !== process.pid
		} catch {
			return false
		}
	}

	// A single reconcile pass: apply the hook, and ONLY persist when no
	// live watcher owns the state file (see liveWatcher above). Never
	// persisted while a watch loop is running — that is exactly the race
	// #116 fixes (the watcher's next poll would short-circuit the group as
	// already-terminal and silently skip log analysis + the automated
	// review).
	const reconcilePass = (s: OrchestratorState): OrchestratorState => {
		const result = applyReconcile(s)
		if (result.reconciled.length > 0 && !liveWatcher()) {
			try {
				saveStateSync(statePath, result.state)
			} catch {
				// A read-side reconcile must never crash the wait; the next
				// poll re-attempts.
			}
		}
		return result.state
	}

	let state = readTolerant()
	if (state !== null) {
		state = reconcilePass(state)
	}

	// Previously-seen status per group, seeded from the FIRST reconciled
	// state (same pattern as watchGroups). The onGroupTerminal callback only
	// fires on a genuine transition INTO a terminal status — never for a
	// group that was already terminal when the wait started, including
	// groups whose initial "running" entry was stale state the first
	// reconciliation fixed to terminal (they were always terminal, just
	// stale in the file). Comparison happens AFTER reconciliation on every
	// poll, so a reconciliation-driven status change is only seen as a
	// transition when the PREVIOUS poll had already observed the
	// (reconciled) non-terminal truth — i.e. a real, live finish detected
	// via worktree markers appearing mid-wait.
	const lastSeenStatus = new Map<string, string>()
	if (state !== null) {
		for (const g of state.groups) {
			lastSeenStatus.set(g.name, g.status)
		}
	}

	const notifyTerminal = async (groups: OrchestratorGroup[]): Promise<void> => {
		for (const g of groups) {
			const prev = lastSeenStatus.get(g.name) ?? g.status
			if (opts.onGroupTerminal && isTerminalStatus(g.status) && !isTerminalStatus(prev)) {
				await opts.onGroupTerminal(g)
			}
			lastSeenStatus.set(g.name, g.status)
		}
	}

	while (true) {
		if (opts.signal?.aborted) {
			return {
				state: state ?? defaultState(),
				allDone: false,
				timedOut: false,
				elapsedMs: Date.now() - start,
				reconciled,
			}
		}
		if (state !== null) {
			if (state.groups.length === 0) {
				return { state, allDone: false, timedOut: false, elapsedMs: Date.now() - start, reconciled }
			}
			if (state.groups.every((g) => isTerminalStatus(g.status))) {
				return {
					state,
					allDone: state.groups.every((g) => g.status === "done"),
					timedOut: false,
					elapsedMs: Date.now() - start,
					reconciled,
				}
			}
		}
		if (Date.now() >= deadline) {
			let finalState = readTolerant() ?? state ?? defaultState()
			finalState = reconcilePass(finalState)
			// The final read can observe a transition that landed right at the
			// deadline — report it before returning the timed-out result.
			await notifyTerminal(finalState.groups)
			return { state: finalState, allDone: false, timedOut: true, elapsedMs: Date.now() - start, reconciled }
		}
		await sleep(pollIntervalMs)
		state = readTolerant()
		if (state !== null) {
			state = reconcilePass(state)
			await notifyTerminal(state.groups)
		}
	}
}
