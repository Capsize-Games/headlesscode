/**
 * Phase 5 — watcher durable idempotency state — read/write
 * `.worktrees/.watcher-state.json` (path overridable).
 *
 * Schema:
 *
 *   {
 *     "processed": {
 *       "<issueNumber>": {
 *         "number": 27,
 *         "title": "…",
 *         "label": "needs-agent",            // the target label that triggered it
 *         "batch": "watcher-2026-08-01",
 *         "groups": [ { name, issues, taskFile } ],  // splitIssues output
 *         "spawnedAt": ISO timestamp,        // when the batch was (or will be) spawned
 *         "status": "spawned"|"done"|"failed"|"skipped"|"pending",
 *         "updatedAt": ISO timestamp,
 *         "error": "…"                       // only on failed
 *       }
 *     },
 *     "updated": ISO timestamp,
 *     "lastSweep": ISO timestamp
 *   }
 *
 * Idempotency semantics: an issue is "already processed" iff it has an entry
 * with status != "pending". `pending` means "seen but deferred by the
 * maxPerSweep cap" — it is picked up on a later sweep. `failed` is NOT
 * retried by default (avoids spawn loops); pass retryFailed to re-attempt.
 * If the label is later removed from an issue, the entry persists, so the
 * watcher still treats it as processed (it will not respawn).
 *
 * Write-ahead contract (the watcher relies on this ordering):
 *   1. markProcessed(state, entry with status "spawned") + save → durable
 *      BEFORE the spawn command runs;
 *   2. spawn;
 *   3. markProcessed(state, entry with status "done"|"failed") + save.
 * A crash between spawn and the final save leaves a "spawned" entry, which
 * the next restart treats as processed — a double-spawn is impossible; a
 * crash between the write-ahead save and the spawn leaves a "spawned" entry
 * with no worktrees (safer than the alternative, and surfaced in the state
 * file for manual inspection).
 *
 * Validation is deliberately LOOSE (plain fs + JSON, no schema library),
 * matching src/orchestrator/state.ts style: missing/malformed files yield a
 * fresh default state; entries that don't validate are dropped.
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

import type { WorktreeSpec } from "../orchestrator/split.js"

export type WatcherIssueStatus = "spawned" | "done" | "failed" | "skipped" | "pending"

/** One issue's processing record in the watcher state file. */
export interface WatcherIssueEntry {
	number: number
	title: string
	/** The target label that triggered this entry (recorded for audit). */
	label: string
	/** Batch id (watcher-<date>); the batch maps 1:1 to a spawn invocation. */
	batch?: string
	/** Worktree groups produced by splitIssues([issue]). */
	groups?: WorktreeSpec[]
	spawnedAt?: string
	status: WatcherIssueStatus
	updatedAt: string
	/** Error message when status === "failed". */
	error?: string
	/** Phase 4 pass-through: a QA round should follow this batch. */
	qa?: boolean
	/** Phase 4 pass-through: a deploy gate should follow this batch. */
	deploy?: boolean
}

/** The watcher state file document. */
export interface WatcherState {
	processed: Record<string, WatcherIssueEntry>
	updated?: string
	lastSweep?: string
}

export function defaultWatcherState(): WatcherState {
	return { processed: {}, updated: new Date().toISOString() }
}

/** Loosely validate a parsed state document; drops malformed entries. */
function sanitize(raw: unknown): WatcherState {
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>
		const processed: Record<string, WatcherIssueEntry> = {}
		if (obj.processed !== null && typeof obj.processed === "object" && !Array.isArray(obj.processed)) {
			for (const [key, value] of Object.entries(obj.processed)) {
				if (value === null || typeof value !== "object") {
					continue
				}
				const e = value as Record<string, unknown>
				const number = Number(e.number)
				if (!Number.isInteger(number) || number <= 0) {
					continue
				}
				const entry: WatcherIssueEntry = {
					number,
					title: typeof e.title === "string" ? e.title : "",
					label: typeof e.label === "string" ? e.label : "",
					status: (typeof e.status === "string" ? e.status : "pending") as WatcherIssueStatus,
					updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : new Date().toISOString(),
				}
				if (typeof e.batch === "string") {
					entry.batch = e.batch
				}
				if (Array.isArray(e.groups)) {
					entry.groups = e.groups as WorktreeSpec[]
				}
				if (typeof e.spawnedAt === "string") {
					entry.spawnedAt = e.spawnedAt
				}
				if (typeof e.error === "string") {
					entry.error = e.error
				}
				if (typeof e.qa === "boolean") {
					entry.qa = e.qa
				}
				if (typeof e.deploy === "boolean") {
					entry.deploy = e.deploy
				}
				processed[key] = entry
			}
		}
		const state: WatcherState = { processed }
		if (typeof obj.updated === "string") {
			state.updated = obj.updated
		}
		if (typeof obj.lastSweep === "string") {
			state.lastSweep = obj.lastSweep
		}
		return state
	}
	return defaultWatcherState()
}

/**
 * Read + parse the watcher state file. Missing or malformed files yield a
 * fresh default state (never throws for missing files). Issue #78: a parse
 * error (e.g. a crash truncated the file mid-write, back when writes were
 * non-atomic) is NOT fatal here either — unlike the orchestrator's state
 * file, watcher state is a resumable idempotency cache, not the source of
 * truth for in-flight work, so falling back to a fresh default lets the
 * watcher keep running (worst case: a few issues get re-evaluated) instead
 * of hard-failing on every subsequent poll.
 */
export async function loadWatcherState(statePath: string): Promise<WatcherState> {
	let raw: string
	try {
		raw = await fsp.readFile(statePath, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return defaultWatcherState()
		}
		throw error
	}
	try {
		return sanitize(JSON.parse(raw))
	} catch {
		return defaultWatcherState()
	}
}

/** Synchronous variant; same semantics as loadWatcherState. */
export function loadWatcherStateSync(statePath: string): WatcherState {
	let raw: string
	try {
		raw = fs.readFileSync(statePath, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return defaultWatcherState()
		}
		throw error
	}
	try {
		return sanitize(JSON.parse(raw))
	} catch {
		return defaultWatcherState()
	}
}

/**
 * Unique sibling temp path for an atomic state write (mirrors
 * src/orchestrator/state.ts's stateTmpPath). The pid + counter suffix keeps
 * concurrent saves from ever sharing a temp file, which would race their
 * renames.
 */
let watcherStateWriteCounter = 0
function watcherStateTmpPath(statePath: string): string {
	return `${statePath}.tmp-${process.pid}-${++watcherStateWriteCounter}`
}

/**
 * Write the state file (pretty-printed + trailing newline), creating dirs.
 * Issue #78: atomic temp+rename write, matching the orchestrator's
 * saveState (src/orchestrator/state.ts) — a crash mid-write can no longer
 * truncate .watcher-state.json (rename is atomic on the same filesystem).
 */
export async function saveWatcherState(statePath: string, state: WatcherState): Promise<void> {
	const cleaned = sanitize(state)
	cleaned.updated = new Date().toISOString()
	await fsp.mkdir(path.dirname(statePath), { recursive: true })
	const tmpPath = watcherStateTmpPath(statePath)
	await fsp.writeFile(tmpPath, JSON.stringify(cleaned, null, 2) + "\n", "utf-8")
	await fsp.rename(tmpPath, statePath)
}

/** Synchronous variant of saveWatcherState. */
export function saveWatcherStateSync(statePath: string, state: WatcherState): void {
	const cleaned = sanitize(state)
	cleaned.updated = new Date().toISOString()
	fs.mkdirSync(path.dirname(statePath), { recursive: true })
	const tmpPath = watcherStateTmpPath(statePath)
	fs.writeFileSync(tmpPath, JSON.stringify(cleaned, null, 2) + "\n", "utf-8")
	fs.renameSync(tmpPath, statePath)
}

/**
 * Return a NEW state with the given entry upserted (immutable; the input
 * state is not mutated). Stamps a fresh `updatedAt` on the entry.
 */
export function markProcessed(state: WatcherState, entry: WatcherIssueEntry): WatcherState {
	const processed = { ...state.processed }
	processed[String(entry.number)] = { ...entry, updatedAt: new Date().toISOString() }
	return { ...state, processed, updated: new Date().toISOString() }
}

/**
 * Is this issue considered already processed for the current sweep?
 * - no entry        -> false (new issue, spawn)
 * - status pending  -> false (deferred by the cap; pick up this sweep)
 * - status failed   -> false ONLY when retryFailed is set (--retry-failed)
 * - everything else -> true (spawned/done/skipped — do not respawn,
 *                      regardless of whether the label is still attached)
 */
export function isProcessed(state: WatcherState, number: number, options?: { retryFailed?: boolean }): boolean {
	const entry = state.processed[String(number)]
	if (!entry) {
		return false
	}
	if (entry.status === "pending") {
		return false
	}
	if (entry.status === "failed" && options?.retryFailed) {
		return false
	}
	return true
}
