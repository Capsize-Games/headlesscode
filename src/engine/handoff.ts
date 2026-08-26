/**
 * Cross-restart handoff summary — `<workspaceRoot>/.headlesscode/handoff-summary.md`.
 *
 * Mirrors the on-disk-layout modules idiom (src/engine/reports.ts for final
 * reports, src/engine/usage.ts for usage): one module owns one layout.
 *
 * Why this exists: when a session hits the iteration cap, the orchestrator
 * spawns a continuation worker on the SAME worktree, but as a BRAND NEW
 * conversation — the previous session's entire message history (every
 * `read_file`/`execute_command` result, every bit of reasoning about where
 * things live) is gone. Only the continuation task file and whatever is on
 * disk (git diff, commits) survive. In practice the continuation task file
 * only says "go inspect the worktree yourself", so the new session re-derives
 * everything the old one already learned at real cost — this was measured on
 * a live job: a continuation session re-read the exact same files (in full)
 * that the session before it had already read in full.
 *
 * The fix: right before a session gives up on the iteration cap, it
 * summarizes its own history (via condense.ts's condenseOldestTurns — the
 * same LLM-compression machinery the mid-session condensation path already
 * uses) and writes the result here. The orchestrator's continuation-task-file
 * builder reads it and inlines it as "what the previous session already
 * learned", so the new session starts from a compact summary instead of a
 * blank slate.
 *
 * A single FIXED filename (not per-session): the orchestrator only ever needs
 * "the latest handoff for this worktree", and each continuation attempt
 * refreshes it. `clearHandoffSummary` removes it once consumed, so a stale
 * summary from a finished task never leaks into an unrelated later one.
 *
 * Like every other auxiliary write path in this codebase, writing is
 * deliberately non-fatal: callers wrap it in try/catch and log a warning — a
 * failed handoff write must never abort or corrupt the session that produced
 * it.
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

/** The handoff summary file for a workspace: `<workspaceRoot>/.headlesscode/handoff-summary.md`. */
export function handoffSummaryPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".headlesscode", "handoff-summary.md")
}

/** Persist a session's handoff summary, overwriting any previous one for this worktree. */
export async function writeHandoffSummary(workspaceRoot: string, summaryText: string): Promise<string> {
	const file = handoffSummaryPath(workspaceRoot)
	await fsp.mkdir(path.dirname(file), { recursive: true })
	await fsp.writeFile(file, summaryText, "utf-8")
	return file
}

/** Synchronous read for the orchestrator's task-file builder (no existing async plumbing there). Returns undefined if absent/unreadable. */
export function readHandoffSummary(workspaceRoot: string): string | undefined {
	const file = handoffSummaryPath(workspaceRoot)
	try {
		return fs.readFileSync(file, "utf-8")
	} catch {
		return undefined
	}
}

/** Remove a consumed handoff summary so it never leaks into a later, unrelated continuation. Non-fatal. */
export function clearHandoffSummary(workspaceRoot: string): void {
	try {
		fs.unlinkSync(handoffSummaryPath(workspaceRoot))
	} catch {
		// Absent or unremovable — nothing to clean up, nothing to report.
	}
}
