/**
 * Stopping a dashboard-launched session — the logic behind
 * POST /api/session/:id/stop (see src/dashboard/server.ts).
 *
 * `launchSession` spawns the session CLI with `detached: true`, which
 * makes the child a process-group leader (pid == pgid on POSIX).
 * Signals therefore target the whole GROUP (`kill(-pid)`): killing
 * only the leader would orphan its non-detached children (npx/tsx
 * wrappers, tool subprocesses) — the exact failure
 * scripts/stop-worker.sh exists for (issue #20). On Windows there is
 * no such grouping, so the pid itself is signalled.
 *
 * Stop sequence: SIGTERM the group, poll up to the grace period
 * (default 5s — the real CLI exits promptly on SIGTERM, see
 * src/cli.ts), then SIGKILL if anything is still alive. On a
 * confirmed exit the session is finalized: the pid record is marked
 * stopped (session-pids.ts), the pause marker is cleared, the stale
 * live usage snapshot is removed (a SIGKILLed session never writes
 * its final usage record, so its "running" snapshot would linger),
 * and a `session_stopped` event is appended to the session's feed
 * via the engine's own writer.
 *
 * Idempotency: a session already marked stopped, or whose process
 * is already gone, returns `already-stopped` — a success, never an
 * error. Only a genuinely unknown session (no pid record, no event
 * feed) or one never launched through the dashboard (feed but no
 * pid record) is "not found". No HTTP here: the server maps the
 * result's `status` to a status code.
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { appendEvent } from "../engine/events.js"
import { removeLiveUsage } from "../engine/usage.js"
import { findSessionEventsFile } from "./aggregate.js"
import { findSessionPidRecord, markSessionPidStopped,
	type FoundSessionPid } from "./session-pids.js"

/** Default SIGTERM grace period before escalating to SIGKILL. */
export const DEFAULT_STOP_GRACE_MS = 5000

/** Upper bound for a stop grace period (request or server config). */
export const MAX_STOP_GRACE_MS = 60_000

const POLL_MS = 25

/** Which signal actually ended the session ("none" = already dead). */
export type StopSignalUsed = "SIGTERM" | "SIGKILL" | "none"

/** Outcome of a stop request; the HTTP layer maps it to a code. */
export type StopStatus = "stopped" | "already-stopped" | "unknown" |
	"no-pid-recorded" | "invalid-pid" | "still-alive"

export interface StopSessionResult {
	sessionId: string
	ok: boolean
	stopped: boolean
	status: StopStatus
	graceMs: number
	pid?: number
	signal?: StopSignalUsed
	worktree?: string
	message?: string
}

/** Resolve an optional configured grace period to a usable value. */
export function resolveStopGraceMs(value?: number): number {
	if (value === undefined || !Number.isFinite(value) || value < 0) {
		return DEFAULT_STOP_GRACE_MS
	}
	return Math.min(Math.floor(value), MAX_STOP_GRACE_MS)
}

/** Validate an optional per-request `{ graceMs }` body override. */
export function parseStopGraceOverride(body: unknown):
	{ graceMs?: number; error?: string } {
	if (body === null || body === undefined) return {}
	if (typeof body !== "object" || Array.isArray(body)) {
		return { error: "body must be a JSON object" }
	}
	const graceMs = (body as { graceMs?: unknown }).graceMs
	if (graceMs === undefined) return {}
	if (!Number.isInteger(graceMs) || (graceMs as number) < 0) {
		return { error: "'graceMs' must be a non-negative integer" }
	}
	if ((graceMs as number) > MAX_STOP_GRACE_MS) {
		return { error: `'graceMs' must be at most ${MAX_STOP_GRACE_MS}` }
	}
	return { graceMs: graceMs as number }
}

/** Signal one target; "gone" (no such process) is reported. */
function tryKill(target: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(target, signal)
		return true
	} catch (error) {
		// EPERM: the process exists but is not ours to signal —
		// for a probe that still means alive.
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

/** Whether a detached session pid (or its process group) is alive. */
export function isPidAlive(pid: number): boolean {
	if (process.platform !== "win32" && tryKill(-pid, 0)) return true
	return tryKill(pid, 0)
}

/** Send a signal to the session's group, falling back to the pid. */
function sendSignal(pid: number, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && tryKill(-pid, signal)) return
	tryKill(pid, signal)
}

/** Poll until the pid is gone or the timeout passes. True when gone. */
async function waitForExit(pid: number, timeoutMs: number):
	Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (isPidAlive(pid)) {
		const remaining = deadline - Date.now()
		if (remaining <= 0) return false
		await sleep(Math.min(POLL_MS, remaining))
	}
	return true
}

/** SIGTERM, grace, then SIGKILL. Reports which signal finished it. */
async function terminatePid(pid: number, graceMs: number):
	Promise<{ stopped: boolean; signal: StopSignalUsed }> {
	if (!isPidAlive(pid)) return { stopped: true, signal: "none" }
	sendSignal(pid, "SIGTERM")
	if (await waitForExit(pid, graceMs)) {
		return { stopped: true, signal: "SIGTERM" }
	}
	sendSignal(pid, "SIGKILL")
	const stopped = await waitForExit(pid, Math.max(graceMs, 1000))
	return { stopped, signal: "SIGKILL" }
}

/** Await a cleanup step, swallowing its failure (non-fatal ethos). */
async function bestEffort(task: Promise<unknown>): Promise<void> {
	try {
		await task
	} catch {
		// Cleanup after a confirmed kill must not fail the stop.
	}
}

/** Post-kill bookkeeping: record, pause marker, snapshot, event. */
async function finalizeStopped(found: FoundSessionPid,
	signal: StopSignalUsed): Promise<void> {
	const root = found.workspaceRoot
	const sessionId = found.record.sessionId
	await bestEffort(markSessionPidStopped(root, sessionId, signal))
	const pauseMarker = path.join(root, ".harness.pause-requested")
	await bestEffort(fsp.rm(pauseMarker, { force: true }))
	await bestEffort(removeLiveUsage(root, sessionId))
	const event = { ts: new Date().toISOString(), sessionId,
		type: "session_stopped", pid: found.record.pid, signal,
		source: "dashboard" }
	await bestEffort(appendEvent(root, sessionId, event))
}

/** Result for a session with no pid record anywhere under the repo. */
async function missingResult(repo: string, sessionId: string,
	graceMs: number): Promise<StopSessionResult> {
	const base = { sessionId, graceMs, ok: false, stopped: false }
	const feed = await findSessionEventsFile(repo, sessionId)
	if (!feed) {
		return { ...base, status: "unknown",
			message: `no session ${sessionId} found under ${repo}` }
	}
	return { ...base, status: "no-pid-recorded", worktree: feed.source,
		message: `no pid recorded for session ${sessionId} — it was ` +
			"not launched through the dashboard, so it cannot be " +
			"stopped from here" }
}

/** Refuse to signal init, an invalid pid, or the dashboard itself. */
function isStoppablePid(pid: number): boolean {
	return Number.isInteger(pid) && pid > 1 && pid !== process.pid
}

/** Stop a session whose record says it is (or was) running. */
async function stopRunningSession(found: FoundSessionPid,
	base: Omit<StopSessionResult, "ok" | "stopped" | "status">):
	Promise<StopSessionResult> {
	const outcome = await terminatePid(found.record.pid, base.graceMs)
	if (!outcome.stopped) {
		return { ...base, ok: false, stopped: false,
			status: "still-alive", signal: outcome.signal,
			message: `session pid ${found.record.pid} is still ` +
				"alive after SIGKILL — investigate manually" }
	}
	await finalizeStopped(found, outcome.signal)
	return { ...base, ok: true, stopped: true, signal: outcome.signal,
		status: outcome.signal === "none" ? "already-stopped" :
			"stopped" }
}

/**
 * Stop one dashboard-launched session under `repo`. Never throws
 * for a missing/dead session — every such case is a result status
 * the caller maps to a clear non-500 response.
 */
export async function stopSession(repo: string, sessionId: string,
	graceMs?: number): Promise<StopSessionResult> {
	const grace = resolveStopGraceMs(graceMs)
	const found = await findSessionPidRecord(repo, sessionId)
	if (!found) return missingResult(repo, sessionId, grace)
	const base = { sessionId, graceMs: grace, pid: found.record.pid,
		worktree: found.source }
	if (found.record.status === "stopped") {
		return { ...base, ok: true, stopped: true,
			status: "already-stopped" }
	}
	if (!isStoppablePid(found.record.pid)) {
		return { ...base, ok: false, stopped: false,
			status: "invalid-pid",
			message: `refusing to signal pid ${found.record.pid}` }
	}
	return stopRunningSession(found, base)
}
