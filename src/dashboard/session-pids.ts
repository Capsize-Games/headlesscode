/**
 * Pid registry for dashboard-launched sessions — the storage the stop
 * endpoint (see src/dashboard/session-stop.ts) looks a detached
 * session's process up in.
 *
 * `launchSession` (src/dashboard/session-launch.ts) spawns the session
 * CLI `detached: true` + `unref()`, so the child outlives the dashboard
 * process itself. An in-memory map would lose the pid the moment the
 * dashboard restarts, so the record is persisted next to the other
 * per-session stores, in the same plain-fs + JSON idiom:
 *
 *   <workspaceRoot>/.headlesscode/pids/<sessionId>.json
 *
 * One overwritten JSON snapshot per session (like the live usage
 * snapshot in src/engine/usage.ts, not an append-only log): launch
 * writes `status: "running"`, a successful stop rewrites it with
 * `status: "stopped"`. The record is KEPT after a stop so a second
 * stop can answer "already stopped" instead of "unknown session" —
 * that is what makes stop idempotent.
 *
 * Only sessions launched through the dashboard have a record. A CLI
 * or orchestrator-launched session has an event feed but no pid here,
 * and the stop endpoint reports that case distinctly.
 *
 * This module is pure fs — no HTTP, no process signalling — so it is
 * unit-testable without the dashboard server.
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"

/** One dashboard-launched session's pid record. */
export interface SessionPidRecord {
	sessionId: string
	pid: number
	workspaceRoot: string
	mode: string
	launchedAt: string
	status: "running" | "stopped"
	stoppedAt?: string
	stopSignal?: string
}

/** A pid record found under a repo, with where it was found. */
export interface FoundSessionPid {
	record: SessionPidRecord
	/** The workspace root the record lives under. */
	workspaceRoot: string
	/** Display label relative to the searched repo ("." or a worktree). */
	source: string
}

/** The pids dir for a workspace: `<workspaceRoot>/.headlesscode/pids`. */
export function pidsDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".headlesscode", "pids")
}

/** The pid record file path for one session. */
export function sessionPidFilePath(
	workspaceRoot: string,
	sessionId: string,
): string {
	return path.join(pidsDir(workspaceRoot), `${sessionId}.json`)
}

/**
 * A session id safe to use as a file basename. Session ids arrive
 * from the URL path, so anything with a separator or dot segment is
 * refused before it can turn a registry read into a traversal.
 */
export function isSafeSessionId(sessionId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)
}

/** Write (overwrite) one pid record. Creates the pids dir if needed. */
async function writePidRecord(record: SessionPidRecord): Promise<void> {
	const file = sessionPidFilePath(
		record.workspaceRoot, record.sessionId)
	await fsp.mkdir(path.dirname(file), { recursive: true })
	await fsp.writeFile(file, JSON.stringify(record, null, 2) + "\n")
}

/** Record a freshly launched session's pid as running. */
export async function recordSessionPid(input: {
	sessionId: string
	pid: number
	workspaceRoot: string
	mode: string
}): Promise<SessionPidRecord> {
	const record: SessionPidRecord = {
		...input,
		launchedAt: new Date().toISOString(),
		status: "running",
	}
	await writePidRecord(record)
	return record
}

/**
 * Read + loosely validate one pid record file. Missing or malformed
 * files yield `null` (never throws for ENOENT / bad JSON — same ethos
 * as `readLiveUsageFile` in src/engine/usage.ts).
 */
export async function readSessionPidFile(
	file: string,
): Promise<SessionPidRecord | null> {
	let raw: string
	try {
		raw = await fsp.readFile(file, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null
		}
		throw error
	}
	try {
		const parsed = JSON.parse(raw) as Partial<SessionPidRecord>
		return isPidRecord(parsed) ? parsed : null
	} catch {
		return null
	}
}

/** Loose shape check for a parsed pid record. */
function isPidRecord(
	parsed: Partial<SessionPidRecord>,
): parsed is SessionPidRecord {
	return (
		typeof parsed.sessionId === "string" &&
		isSafeSessionId(parsed.sessionId) &&
		Number.isInteger(parsed.pid) &&
		(parsed.pid ?? 0) > 0 &&
		typeof parsed.workspaceRoot === "string" &&
		(parsed.status === "running" || parsed.status === "stopped")
	)
}

/** Read one session's pid record from a workspace, or `null`. */
export async function readSessionPidRecord(
	workspaceRoot: string,
	sessionId: string,
): Promise<SessionPidRecord | null> {
	if (!isSafeSessionId(sessionId)) {
		return null
	}
	const file = sessionPidFilePath(workspaceRoot, sessionId)
	return readSessionPidFile(file)
}

/**
 * Rewrite a session's record as stopped. Returns the updated record,
 * or `null` when no record exists (nothing to mark).
 */
export async function markSessionPidStopped(
	workspaceRoot: string,
	sessionId: string,
	stopSignal: string,
): Promise<SessionPidRecord | null> {
	const record = await readSessionPidRecord(workspaceRoot, sessionId)
	if (!record) {
		return null
	}
	record.status = "stopped"
	record.stoppedAt = new Date().toISOString()
	record.stopSignal = stopSignal
	record.workspaceRoot = workspaceRoot
	await writePidRecord(record)
	return record
}

/** Candidate roots under a repo: itself, then every worker worktree. */
async function candidateRoots(
	repoRoot: string,
): Promise<Array<{ root: string; source: string }>> {
	const roots = [{ root: repoRoot, source: "." }]
	const worktreesDir = path.join(repoRoot, ".worktrees")
	try {
		const entries = await fsp.readdir(worktreesDir, {
			withFileTypes: true,
		})
		for (const entry of entries.filter((e) => e.isDirectory())) {
			roots.push({
				root: path.join(worktreesDir, entry.name),
				source: `.worktrees/${entry.name}`,
			})
		}
	} catch {
		// No worktrees dir — the repo root is the only candidate.
	}
	return roots
}

/**
 * Locate a session's pid record under a repo, searching the repo
 * root AND every `.worktrees/<name>/` worktree (the same dual search
 * `findSessionEventsFile` performs for event feeds). The returned
 * workspace root is derived from where the record lives on disk,
 * not from the record's own claim, so callers can trust it for
 * sibling-file cleanup (pause marker, live usage snapshot).
 */
export async function findSessionPidRecord(
	repo: string,
	sessionId: string,
): Promise<FoundSessionPid | undefined> {
	const repoRoot = path.resolve(repo)
	for (const candidate of await candidateRoots(repoRoot)) {
		const record = await readSessionPidRecord(
			candidate.root, sessionId)
		if (record) {
			return {
				record,
				workspaceRoot: candidate.root,
				source: candidate.source,
			}
		}
	}
	return undefined
}
