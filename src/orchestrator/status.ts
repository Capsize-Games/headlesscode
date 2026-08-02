/**
 * `headlesscode orchestrate status` — read-side status command for EXTERNAL
 * callers (an interactive orchestrator agent checking on a round from outside
 * the watching process). Reads `.worktrees/.orchestrator-state.json` via
 * loadStateSync (state.ts) — it never writes the file, never re-implements
 * parsing, and does NOT touch watch.ts's own live-monitoring loop.
 *
 * Two forms:
 *   - one-shot: print a compact per-group summary (or the raw state with
 *     --json) and exit.
 *   - --wait: block inside this ONE process until every group reaches a
 *     terminal status ("done" | "failed" | "needs-human" — "blocked" is
 *     deliberately NOT terminal: it is a decision-escalation wait state that
 *     keeps this command waiting) or --timeout-ms elapses, then print the
 *     same summary plus a one-line verdict.
 *
 * Polling the state file (not fs.watch) is a deliberate choice: the file is
 * written by watch.ts, which itself polls at DEFAULT_POLL_INTERVAL_MS, so a
 * faster read interval buys nothing; fs.watch on a regular file is
 * unreliable when the writer replaces the file via rename rather than
 * truncating in place (and the file may not exist at wait-start);
 * fs.watchFile is itself just polling with extra steps. A plain poll loop
 * matches the existing watch.ts idiom and is trivially testable.
 */

import { setTimeout as sleep } from "node:timers/promises"

import { defaultState, loadStateSync, type OrchestratorGroup, type OrchestratorState } from "./state.js"
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_STALL_TIMEOUT_MS } from "./watch.js"

/**
 * The statuses that end a round for a group. `blocked` is NOT here on
 * purpose: a group waiting on a decision answer is not finished, and
 * `--wait` must keep waiting rather than exit early (see state.ts's
 * OrchestratorGroup.status doc comment).
 */
export const TERMINAL_STATUSES = ["done", "failed", "needs-human"] as const

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
}

export interface StatusCounts {
	total: number
	done: number
	failed: number
	needsHuman: number
	blocked: number
	running: number
	other: number
}

export interface StatusSummary {
	batch?: string
	updated?: string
	groups: StatusGroupRow[]
	counts: StatusCounts
	totalUsage?: OrchestratorState["totalUsage"]
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
		}
	})
	return { batch: state.batch, updated: state.updated, groups, counts, totalUsage: state.totalUsage }
}

/**
 * One-line verdict for the `--wait` form, e.g. "3/3 groups done, 0 failed"
 * or "timed out after 2 of 3 groups done".
 */
export function verdictLine(summary: StatusSummary, timedOut: boolean, allDone: boolean): string {
	const c = summary.counts
	if (c.total === 0) {
		return "nothing to wait for — no groups in state"
	}
	if (timedOut) {
		const tail = c.failed > 0 || c.needsHuman > 0 ? ` (${c.failed} failed, ${c.needsHuman} needs-human)` : ""
		return `timed out after ${c.done} of ${c.total} group${c.total === 1 ? "" : "s"} done${tail}`
	}
	if (allDone) {
		return `${c.total}/${c.total} groups done, 0 failed`
	}
	// All terminal, but not all done → failed and/or needs-human present.
	return `all ${c.total} group${c.total === 1 ? "" : "s"} terminal, but ${c.failed} failed / ${c.needsHuman} needs-human`
}

/** Human-readable status block (one-shot form when timedOut/allDone are omitted). */
export function formatStatusText(
	summary: StatusSummary,
	opts: { repo: string; statePath: string; timedOut?: boolean; allDone?: boolean; elapsedMs?: number },
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

	if (c.total === 0) {
		lines.push("")
		lines.push("No orchestrator groups found in this state file (nothing to report / wait for).")
	} else {
		lines.push("")
		lines.push(`${"GROUP".padEnd(14)}${"STATUS".padEnd(12)}LAST ACTIVITY · REVIEW · QA · USAGE`)
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
			if (g.usageCostUsd !== undefined) {
				bits.push(`$${g.usageCostUsd.toFixed(4)}`)
			}
			if (g.stalled) {
				bits.push("STALLED")
			}
			if (g.blockedQuestion) {
				bits.push(`blocked: ${g.blockedQuestion}`)
			}
			lines.push(`${g.name.padEnd(14)}${g.status.padEnd(12)}${bits.join(" · ")}`)
		}
		lines.push("")
		lines.push(
			`${c.total} group${c.total === 1 ? "" : "s"}: ${c.done} done · ${c.failed} failed · ` +
				`${c.needsHuman} needs-human · ${c.blocked} blocked · ${c.running} running/spawned` +
				(c.other > 0 ? ` · ${c.other} other` : ""),
		)
	}

	if (opts.timedOut !== undefined || opts.allDone !== undefined) {
		lines.push("")
		lines.push(`verdict: ${verdictLine(summary, opts.timedOut ?? false, opts.allDone ?? false)}`)
	}
	return lines.join("\n") + "\n"
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
}

export interface WaitForTerminalResult {
	state: OrchestratorState
	/** Every group reached status "done" (all terminal AND nothing failed). */
	allDone: boolean
	timedOut: boolean
	elapsedMs: number
}

/**
 * Block until every group in the state file is terminal (or the timeout
 * elapses, or the signal aborts). An empty state file (no round yet) returns
 * immediately — there is nothing to wait for, and hanging on a wrong path
 * would be worse than returning a clear "no groups" result.
 *
 * Transient JSON parse errors (the writer's writeFileSync is not atomic, so
 * a read can land mid-save) are treated as "not readable yet": the loop
 * retries on the next poll instead of crashing the wait.
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

	let state = readTolerant()

	while (true) {
		if (opts.signal?.aborted) {
			return { state: state ?? defaultState(), allDone: false, timedOut: false, elapsedMs: Date.now() - start }
		}
		if (state !== null) {
			if (state.groups.length === 0) {
				return { state, allDone: false, timedOut: false, elapsedMs: Date.now() - start }
			}
			if (state.groups.every((g) => isTerminalStatus(g.status))) {
				return {
					state,
					allDone: state.groups.every((g) => g.status === "done"),
					timedOut: false,
					elapsedMs: Date.now() - start,
				}
			}
		}
		if (Date.now() >= deadline) {
			const finalState = readTolerant() ?? state ?? defaultState()
			return { state: finalState, allDone: false, timedOut: true, elapsedMs: Date.now() - start }
		}
		await sleep(pollIntervalMs)
		state = readTolerant()
	}
}
