/**
 * Phase 6 — global concurrency guardrail (spec 6.3): a hard cap on how many
 * harness sessions may run at once, enforced BEFORE anything is spawned.
 *
 * Two layers, both in this module:
 *
 *  1. `ConcurrencyLimiter` — an in-process counting semaphore. We deliberately
 *     chose FAIL-FAST over queueing for headless spawners: a queued spawner
 *     has nowhere to hold "waiting" work unless it is the watcher (which
 *     already has a durable pending mechanism), and a silently queued
 *     orchestrate run is worse than a loud abort. The watcher's "defer with
 *     durable pending state" is the queue — implemented in the watcher, not
 *     the limiter.
 *
 *  2. `activeSessionCount(...)` — a CROSS-PROCESS view of how many sessions
 *     are currently running, derived from the durable state files:
 *       - `.orchestrator-state.json` groups with status `spawned` | `running`;
 *       - `.watcher-state.json` entries with status `spawned` (in-flight
 *         write-ahead spawns).
 *     Each process (orchestrate, watcher, a cron watcher, a manual run) reads
 *     these files before spawning, so the cap holds even when several
 *     processes run concurrently against the same repo — the in-process
 *     limiter covers the window INSIDE one process (e.g. a sweep spawning
 *     several batches back-to-back), the state files cover the window ACROSS
 *     processes.
 */

import * as path from "node:path"

import { loadStateSync, type OrchestratorState } from "../orchestrator/state.js"
import { loadWatcherStateSync, type WatcherState } from "../watcher/state.js"

/** Default global cap: HEADLESSCODE_MAX_CONCURRENT_SESSIONS or 3. */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 3

/**
 * In-process counting semaphore with fail-fast acquisition. The cap counts
 * SESSIONS (one worktree group = one harness session), not worktrees.
 */
export class ConcurrencyLimiter {
	readonly maxSessions: number
	private active = 0

	constructor(maxSessions: number) {
		if (!Number.isInteger(maxSessions) || maxSessions <= 0) {
			throw new Error(`ConcurrencyLimiter: maxSessions must be a positive integer (got ${maxSessions})`)
		}
		this.maxSessions = maxSessions
	}

	/**
	 * Try to reserve a slot. Fail-fast: returns { ok: false, reason } instead
	 * of queueing — a caller that cannot spawn right now must either defer
	 * (watcher → durable pending) or abort loudly (orchestrate), never wait
	 * silently. (Decision documented in docs/phase6-cloud.md.)
	 */
	acquire(): { ok: boolean; reason?: string } {
		if (this.active >= this.maxSessions) {
			return {
				ok: false,
				reason: `concurrency cap reached: ${this.maxSessions} active session(s) (HEADLESSCODE_MAX_CONCURRENT_SESSIONS)`,
			}
		}
		this.active++
		return { ok: true }
	}

	/** Release a slot previously reserved with acquire(). Never goes below 0. */
	release(): void {
		this.active = Math.max(0, this.active - 1)
	}

	/** Current number of reserved (active) slots in this process. */
	current(): number {
		return this.active
	}
}

/** Parsed env cap: HEADLESSCODE_MAX_CONCURRENT_SESSIONS (default 3). */
export function maxConcurrentSessionsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.HEADLESSCODE_MAX_CONCURRENT_SESSIONS
	if (raw === undefined || raw === "") {
		return DEFAULT_MAX_CONCURRENT_SESSIONS
	}
	const n = Number(raw)
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENT_SESSIONS
}

/**
 * Cross-process active-session count: orchestrator groups in `spawned`/
 * `running` + watcher entries in `spawned` (write-ahead, spawn in flight).
 * Pass either state as null/undefined when that pipeline isn't in use.
 */
export function activeSessionCount(
	orchState?: OrchestratorState | null,
	watcherState?: WatcherState | null,
): number {
	let count = 0
	if (orchState) {
		for (const group of orchState.groups) {
			if (group.status === "spawned" || group.status === "running") {
				count++
			}
		}
	}
	if (watcherState) {
		for (const entry of Object.values(watcherState.processed)) {
			if (entry.status === "spawned") {
				count++
			}
		}
	}
	return count
}

/**
 * Convenience: load BOTH durable state files for a repo root and return the
 * combined active count. Missing files are tolerated (fresh default state).
 * Paths follow the repo conventions: `<repoRoot>/.worktrees/`.
 */
export function activeSessionCountForRepo(repoRoot: string): number {
	const worktrees = path.join(path.resolve(repoRoot), ".worktrees")
	const orchState = loadStateSync(path.join(worktrees, ".orchestrator-state.json"))
	const watcherState = loadWatcherStateSync(path.join(worktrees, ".watcher-state.json"))
	return activeSessionCount(orchState, watcherState)
}
