/**
 * Completion monitoring for the orchestrator (Phase 2).
 *
 * Replaces the airunner GUI wake-up (xdotool phone-home / wmctrl) with
 * process/IPC signals written by scripts/run-worker.sh:
 *
 *   <worktree>/.harness.pid    worker PID (written at launch)
 *   <worktree>/.harness.exit   worker exit code (written on harness exit)
 *   <worktree>/.harness.done/  completion marker DIR (mkdir-based, atomic,
 *                              same lock-mutex convention as phone-home.sh)
 *   <worktree>/harness.log     worker stdout+stderr
 *
 * `watchGroups` polls those markers (short configurable interval, default 5s —
 * NO fixed 20s sleep), updates `.orchestrator-state.json` (status
 * done|failed, exit code, summary from the harness.log tail, last_activity),
 * and invokes an optional per-group callback (used to trigger the reviewer)
 * when a group transitions to done. A stall guard flags groups whose spawned
 * timestamp exceeds HEADLESSCODE_STALL_TIMEOUT (default 2h, matching
 * airunner's 2h stall detection) with no completion.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { loadStateSync, saveStateSync, updateGroup, type OrchestratorGroup, type OrchestratorState } from "./state.js"

export const DEFAULT_POLL_INTERVAL_MS = 5_000
export const DEFAULT_STALL_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2h, matching airunner

/** Number of harness.log lines kept as the group summary. */
const SUMMARY_TAIL_LINES = 40

export interface WatchOptions {
	/** Target repo root containing `.worktrees/` (also used to resolve). */
	repoRoot: string
	/** State file path (default: <repoRoot>/.worktrees/.orchestrator-state.json). */
	statePath?: string
	/** Poll interval (default 5s). */
	pollIntervalMs?: number
	/** Stall guard (default: $HEADLESSCODE_STALL_TIMEOUT or 2h). */
	stallTimeoutMs?: number
	/** Optional callback fired when a group transitions to done/failed. */
	onGroupUpdate?: (group: OrchestratorGroup, state: OrchestratorState) => void | Promise<void>
	/** Abort the watch loop (e.g. from a parent orchestrator). */
	signal?: AbortSignal
}

export interface WatchSummary {
	state: OrchestratorState
	/** True when every group reached a terminal state (done/failed/stalled). */
	allTerminal: boolean
}

/** Tail a file's last `maxLines` lines (used for the group summary). */
export function tailLog(logPath: string, maxLines = SUMMARY_TAIL_LINES): string {
	try {
		const raw = fs.readFileSync(logPath, "utf-8")
		const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "")
		return lines.slice(-maxLines).join("\n")
	} catch {
		return ""
	}
}

/** Absolute path of a group's worktree inside the target repo. */
export function groupWorktreePath(repoRoot: string, group: OrchestratorGroup): string {
	const rel = group.worktree ?? `.worktrees/${group.name}`
	return path.resolve(repoRoot, rel)
}

function readExitCode(wtPath: string): number | undefined {
	try {
		const raw = fs.readFileSync(path.join(wtPath, ".harness.exit"), "utf-8").trim()
		const code = Number(raw)
		return Number.isFinite(code) ? code : undefined
	} catch {
		return undefined
	}
}

function hasDoneMarker(wtPath: string): boolean {
	try {
		return fs.statSync(path.join(wtPath, ".harness.done")).isDirectory()
	} catch {
		return false
	}
}

function hasPid(wtPath: string): boolean {
	try {
		const raw = fs.readFileSync(path.join(wtPath, ".harness.pid"), "utf-8").trim()
		return /^\d+$/.test(raw)
	} catch {
		return false
	}
}

/**
 * Inspect one group's worktree and return the next state patch, or undefined
 * when nothing changed. Resolves completion (done/failed) from the
 * `.harness.done` marker + `.harness.exit` code, and stalls via the guard.
 */
export function inspectGroup(
	repoRoot: string,
	group: OrchestratorGroup,
	now: number,
	stallTimeoutMs: number,
): Partial<OrchestratorGroup> | undefined {
	const wtPath = groupWorktreePath(repoRoot, group)
	const startedAt = group.spawned !== undefined ? Date.parse(group.spawned) : NaN
	const isTerminal = group.status === "done" || group.status === "failed"

	if (hasDoneMarker(wtPath)) {
		if (isTerminal) {
			return undefined
		}
		const exitCode = readExitCode(wtPath)
		const status = exitCode === 0 ? "done" : "failed"
		const summary = tailLog(path.join(wtPath, "harness.log"))
		const note =
			exitCode === 0
				? `worker completed cleanly (exit 0)${summary ? " — see harness.log" : ""}`
				: `worker exited ${exitCode ?? "with unknown code"} (see harness.log)`
		return {
			status,
			last_activity: {
				note,
				last_commit: lastCommit(wtPath),
			},
			commits: group.commits ?? [],
			...(exitCode !== undefined ? { exit_code: exitCode } : {}),
			summary: summary.slice(0, 4000),
		}
	}

	// No done marker yet.
	if (isTerminal) {
		return undefined
	}

	// Stall guard: spawned long ago with no completion and no pid → stalled.
	if (!Number.isNaN(startedAt) && now - startedAt > stallTimeoutMs) {
		const isStalled = !hasPid(wtPath)
		return {
			...(isStalled ? { status: "failed", stalled: true } : { stalled: true }),
			last_activity: {
				note: `STALLED: no completion marker after ${Math.round(stallTimeoutMs / 60000)}m (spawned ${group.spawned})`,
			},
		}
	}

	return undefined
}

function lastCommit(wtPath: string): string {
	try {
		const out = execFileSync("git", ["-C", wtPath, "log", "--oneline", "-1"], {
			encoding: "utf-8",
			timeout: 5000,
		})
		return out.trim()
	} catch {
		return ""
	}
}

/**
 * Poll all non-terminal groups until every group is terminal (done/failed),
 * the abort signal fires, or the callback aborts. State changes are persisted
 * to the state file; `onGroupUpdate` is called after each persisted change.
 *
 * Returns the final state + whether all groups reached a terminal status.
 */
export async function watchGroups(options: WatchOptions): Promise<WatchSummary> {
	const repoRoot = path.resolve(options.repoRoot)
	const statePath = options.statePath ?? path.join(repoRoot, ".worktrees", ".orchestrator-state.json")
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
	const stallTimeoutMs =
		options.stallTimeoutMs ?? Number(process.env.HEADLESSCODE_STALL_TIMEOUT ?? DEFAULT_STALL_TIMEOUT_MS)

	let state = loadStateSync(statePath)

	const isTerminal = (g: OrchestratorGroup): boolean => g.status === "done" || g.status === "failed"

	while (true) {
		if (options.signal?.aborted) {
			break
		}
		const now = Date.now()
		let changed = false

		for (const group of state.groups) {
			if (isTerminal(group)) {
				continue
			}
			const patch = inspectGroup(repoRoot, group, now, stallTimeoutMs)
			if (!patch) {
				continue
			}
			state = updateGroup(state, group.name, patch)
			saveStateSync(statePath, state)
			changed = true
			const updated = state.groups.find((g) => g.name === group.name)
			if (updated) {
				await options.onGroupUpdate?.(updated, state)
			}
		}

		const allTerminal = state.groups.length > 0 && state.groups.every(isTerminal)
		if (allTerminal) {
			return { state, allTerminal: true }
		}
		if (!changed) {
			await sleep(pollIntervalMs)
		}
	}

	return { state, allTerminal: state.groups.length > 0 && state.groups.every(isTerminal) }
}
