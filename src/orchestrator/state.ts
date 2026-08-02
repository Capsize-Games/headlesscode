/**
 * Orchestrator durable state — read/write `.worktrees/.orchestrator-state.json`.
 *
 * Schema (mirrors the live state file seen in the airunner repo):
 *
 *   {
 *     "batch": string,
 *     "updated": ISO timestamp,
 *     "groups": [
 *       {
 *         "name": string,                    // worktree name, e.g. "w1"
 *         "worktree": string,                // ".worktrees/w1" (repo-relative)
 *         "branch": string,                  // "issues/w1-2026-07-31"
 *         "issues": number[],
 *         "task_file": string,
 *         "status": "spawned"|"running"|"done"|"failed"|"blocked"|"needs-human"|"orphaned"|string,
 *         "spawned": ISO timestamp,
 *         "last_activity": string | object,  // "last_commit"/"note" seen live
 *         "commits": string[],
 *         "actions_taken": string[],
 *         "pending_review_findings": string[]
 *       }
 *     ]
 *   }
 *
 * Validation is deliberately LOOSE (plain fs + JSON, no schema library):
 * the file may have been written by the bash spawner, by a previous
 * orchestrator instance, or be mid-write. We only guarantee the shape the
 * watcher/CLI need: an object with a `groups` array.
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

/** One worktree group in the orchestrator state file. */
export interface OrchestratorGroup {
	name: string
	worktree?: string
	branch?: string
	issues?: number[]
	task_file?: string
	/**
	 * spawned | running | done | failed | blocked | needs-human | orphaned
	 * (loose: any string is tolerated). `needs-human` is a TERMINAL state
	 * set by the rework loop when a group exhausted its review-rework
	 * attempts — the underlying problem was never fixed and a human must
	 * look at it. It is deliberately distinct from `failed` (worker
	 * crash/stall) and from `blocked` (waiting on a decision answer, not a
	 * rework cycle). `orphaned` is a TERMINAL state written by
	 * `orchestrate status`'s read-side reconciliation (status.ts): the
	 * group's worktree is gone from disk and it never reached a terminal
	 * status, so the real outcome cannot be determined from markers alone —
	 * a human must investigate via git history. It is never guessed as
	 * `done`/`failed`; surfacing the ambiguity honestly is the point.
	 */
	status: string
	spawned?: string
	last_status_change?: string
	last_activity?: string | { last_commit?: string; note?: string; [key: string]: unknown }
	commits?: string[]
	actions_taken?: string[]
	pending_review_findings?: string[]
	/** Worker exit code (written by run-worker.sh; recorded by the watcher). */
	exit_code?: number
	/** harness.log tail captured when the group completed. */
	summary?: string
	/** Set by the watcher's stall guard. */
	stalled?: boolean
	/** Review bookkeeping (written by the orchestrator after runReview). */
	review_verdict?: string
	reviewed_at?: string
	/**
	 * Rework loop counter — how many rework cycles this group has already gone
	 * through after a review "finding" verdict. Absent (== 0) when the group
	 * has never been reworked. Incremented by the orchestrator each time it
	 * re-spawns a worker on the SAME worktree to fix review findings.
	 */
	reworkCount?: number
	/**
	 * Iteration-exhaustion continuation counter — how many times this group
	 * has already been re-spawned on the SAME worktree after a worker hit
	 * `--max-iterations` ("the task is bigger than one session", see
	 * plans/issues/02-orchestrate-iteration-plumbing.md). Absent (== 0) when
	 * the group's first attempt never hit the cap. Incremented by the
	 * orchestrator each time it continues a group past the cap; once it
	 * reaches the group's `--max-continuations` budget the group is marked
	 * `needs-human` (same terminal shape as reworkCount's cap).
	 */
	continuationCount?: number
	/**
	 * QA bookkeeping (Phase 4, written by the orchestrator after runQa when
	 * `--qa` is passed): verdict is pass|fail|error; status is "done" for a
	 * pass, "failed" otherwise; evidence is the QA report's evidence section.
	 */
	qa?: {
		status: string
		verdict: string
		evidence: string
		updated: string
	}
	/** PR metadata seen in the live airunner state file. */
	pr?: { number?: number; url?: string; state?: string }
	/**
	 * Decision escalation (workstream 2): set by the watcher (watch.ts) while
	 * `<worktree>/.harness.needs-decision` is present — the worker's
	 * ask_followup_question call is blocked waiting for
	 * `<worktree>/.harness.decision-answer`. Mirrors the marker file's JSON
	 * shape. Cleared (and status flows back to "running") once the marker
	 * disappears, whether because a human/orchestrator answered it via
	 * `scripts/headlesscode-answer.sh` or because the worker's wait timed out
	 * and it fell back to autonomous decision.
	 */
	blocked?: { question: string; suggestions?: string[]; askedAt?: string }
	/**
	 * Cost/token monitoring (workstream 3): rolled up by the watcher
	 * (watch.ts) from the worker's `<worktree>/.headlesscode/usage/*.jsonl`
	 * once the group reaches a terminal state (done/failed). Summed across
	 * all usage records found for the worktree (defensive against a worktree
	 * running more than one session) — see `src/dashboard/aggregate.ts` for
	 * the same shape used dashboard-side.
	 */
	usage?: {
		costUsd: number
		inputTokens: number
		outputTokens: number
		/** Subset of inputTokens served from the provider's prompt cache (0 when unreported). */
		cachedTokens?: number
		iterations: number
	}
}

/** The orchestrator state file document. */
export interface OrchestratorState {
	batch?: string
	updated?: string
	groups: OrchestratorGroup[]
	/**
	 * Cost/token monitoring (workstream 3): round-level total, the sum of
	 * every group's `usage` field. Recomputed by the watcher each time a
	 * group's usage is rolled in, so "this round cost $X" is answerable
	 * without summing client-side.
	 */
	totalUsage?: {
		costUsd: number
		inputTokens: number
		outputTokens: number
		/** Subset of inputTokens served from the provider's prompt cache (0 when unreported). */
		cachedTokens?: number
		iterations: number
	}
	[key: string]: unknown
}

export function defaultState(batch = "unnamed"): OrchestratorState {
	return { batch, updated: new Date().toISOString(), groups: [] }
}

/** Loosely validate a parsed state document; returns groups as an array. */
function sanitize(raw: unknown): OrchestratorState {
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>
		const groups = Array.isArray(obj.groups)
			? (obj.groups as OrchestratorGroup[]).filter((g) => g !== null && typeof g === "object")
			: []
		return { ...obj, groups } as OrchestratorState
	}
	return defaultState()
}

/**
 * Read + parse the state file. Missing or malformed files yield a fresh
 * default state (never throws for missing files). Invalid JSON throws.
 */
export async function loadState(statePath: string): Promise<OrchestratorState> {
	let raw: string
	try {
		raw = await fsp.readFile(statePath, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return defaultState()
		}
		throw error
	}
	const parsed: unknown = JSON.parse(raw)
	return sanitize(parsed)
}

/** Synchronous variant (handy for scripts); same semantics as loadState. */
export function loadStateSync(statePath: string): OrchestratorState {
	let raw: string
	try {
		raw = fs.readFileSync(statePath, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return defaultState()
		}
		throw error
	}
	return sanitize(JSON.parse(raw))
}

/** Write the state file (pretty-printed + trailing newline), creating dirs. */
export async function saveState(statePath: string, state: OrchestratorState): Promise<void> {
	const cleaned = sanitize(state)
	cleaned.updated = new Date().toISOString()
	await fsp.mkdir(path.dirname(statePath), { recursive: true })
	await fsp.writeFile(statePath, JSON.stringify(cleaned, null, 2) + "\n", "utf-8")
}

/** Synchronous variant of saveState. */
export function saveStateSync(statePath: string, state: OrchestratorState): void {
	const cleaned = sanitize(state)
	cleaned.updated = new Date().toISOString()
	fs.mkdirSync(path.dirname(statePath), { recursive: true })
	fs.writeFileSync(statePath, JSON.stringify(cleaned, null, 2) + "\n", "utf-8")
}

/**
 * Return a NEW state object with the named group patched (upsert by name).
 * `patch` fields are shallow-merged over the existing group; a group that
 * does not exist yet is created from `{ name, ...patch }`. The input state
 * is not mutated.
 */
export function updateGroup(
	state: OrchestratorState,
	name: string,
	patch: Partial<Omit<OrchestratorGroup, "name">>,
): OrchestratorState {
	const groups = state.groups.map((g) => ({ ...g }))
	const index = groups.findIndex((g) => g.name === name)
	if (index >= 0) {
		groups[index] = { ...groups[index], ...patch, name }
	} else {
		groups.push({ ...patch, name, status: patch.status ?? "spawned" })
	}
	return { ...state, groups, updated: new Date().toISOString() }
}
