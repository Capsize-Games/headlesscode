/**
 * Cost/token monitoring (workstream 3) — per-session usage persistence.
 *
 * Storage layout, one JSONL file per session, append-only, mirroring the
 * existing project idiom (`src/memory/local.ts`'s `appendJsonl`/`readJsonl`
 * — plain `node:fs`, no schema library, loose validation on read):
 *
 *   <workspaceRoot>/.headlesscode/usage/<sessionId>.jsonl
 *
 * A worker process normally writes exactly ONE line here (its single
 * completed session), but the format is append-only JSONL rather than a
 * single JSON object so that concurrent/rerun scenarios (e.g. a worktree
 * reused across multiple sessions) never corrupt a partial write — same
 * write-contention rationale as the memory store's per-project files.
 *
 * This module is intentionally the ONLY place that knows the on-disk usage
 * layout, so `src/dashboard/aggregate.ts` (read side) and
 * `src/engine/loop.ts` (write side) stay in sync.
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"

/** One completed session's usage, as persisted to `.headlesscode/usage/<sessionId>.jsonl`. */
export interface UsageRecord {
	sessionId: string
	mode: string
	model: string
	iterations: number
	inputTokens: number
	outputTokens: number
	/**
	 * Subset of inputTokens served from the provider's prompt cache (see
	 * LlmResponse.usage.cachedTokens). Optional: absent on records written
	 * before this field existed, or when the provider never reports it.
	 */
	cachedTokens?: number
	costUsd: number
	startedAt: string
	endedAt: string
	status: "success" | "error" | "budget"
	workspaceRoot: string
}

/**
 * A live (in-progress) usage snapshot, overwritten in place at
 * `.headlesscode/usage/<sessionId>.live.json` after every iteration while a
 * session runs, so the dashboard can show accumulating cost/tokens before the
 * session finishes. Same shape as `UsageRecord` minus `endedAt`, with
 * `status: "running"`.
 */
export interface LiveUsageRecord {
	sessionId: string
	mode: string
	model: string
	iterations: number
	inputTokens: number
	outputTokens: number
	cachedTokens?: number
	costUsd: number
	startedAt: string
	status: "running"
	workspaceRoot: string
}

/** The usage dir for a workspace: `<workspaceRoot>/.headlesscode/usage`. */
export function usageDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".headlesscode", "usage")
}

/** The usage file path for one session. */
export function usageFilePath(workspaceRoot: string, sessionId: string): string {
	return path.join(usageDir(workspaceRoot), `${sessionId}.jsonl`)
}

/** The live (in-progress) usage snapshot path for one session. */
export function liveUsageFilePath(workspaceRoot: string, sessionId: string): string {
	return path.join(usageDir(workspaceRoot), `${sessionId}.live.json`)
}

/**
 * Append one usage record for a completed session. Creates the usage dir if
 * needed. Callers (see `HeadlessSession.recordUsage`) are expected to wrap
 * this in try/catch and treat failures as non-fatal — this function itself
 * does not swallow errors, so it fails loudly for direct callers/tests.
 */
export async function recordSessionUsage(workspaceRoot: string, record: UsageRecord): Promise<void> {
	const file = usageFilePath(workspaceRoot, record.sessionId)
	await fsp.mkdir(path.dirname(file), { recursive: true })
	await fsp.appendFile(file, JSON.stringify(record) + "\n", "utf-8")
}

/**
 * Overwrite a session's live (in-progress) usage snapshot. Never appended —
 * this is a point-in-time snapshot, not a log (unlike `recordSessionUsage`).
 * Creates the usage dir if needed. Callers (see `HeadlessSession`) are
 * expected to wrap this in try/catch and treat failures as non-fatal.
 */
export async function writeLiveUsage(workspaceRoot: string, record: LiveUsageRecord): Promise<void> {
	const file = liveUsageFilePath(workspaceRoot, record.sessionId)
	await fsp.mkdir(path.dirname(file), { recursive: true })
	await fsp.writeFile(file, JSON.stringify(record, null, 2) + "\n", "utf-8")
}

/**
 * Delete a session's live snapshot. Called on every completion path once the
 * final `.jsonl` record is written — that record is the authoritative source,
 * so a stale live snapshot must not linger. Never throws for a missing file
 * (`force: true`). Callers are expected to wrap this in try/catch (non-fatal).
 */
export async function removeLiveUsage(workspaceRoot: string, sessionId: string): Promise<void> {
	await fsp.rm(liveUsageFilePath(workspaceRoot, sessionId), { force: true })
}

/**
 * Read + loosely validate one usage JSONL file. Malformed/partially-written
 * lines are skipped; a missing file yields an empty array (never throws for
 * ENOENT — matches the memory store's `readJsonl` idiom).
 *
 * Deduped by `sessionId` (issue #81): a session id can be reused across a
 * restart/retry of the same worker, which appends another line to the same
 * file (the file itself is named `<sessionId>.jsonl`, so every line here
 * already shares one id) — without dedup, dashboard `sumSessions` would sum
 * every one of those rows and double/triple-count cost and tokens. The last
 * record for a given sessionId wins (most recent write reflects the final
 * outcome of that session id).
 */
export async function readUsageFile(file: string): Promise<UsageRecord[]> {
	let raw: string
	try {
		raw = await fsp.readFile(file, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw error
	}
	const bySessionId = new Map<string, UsageRecord>()
	const order: string[] = []
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		try {
			const parsed = JSON.parse(trimmed) as Partial<UsageRecord>
			if (typeof parsed.sessionId === "string" && typeof parsed.status === "string") {
				if (!bySessionId.has(parsed.sessionId)) {
					order.push(parsed.sessionId)
				}
				bySessionId.set(parsed.sessionId, parsed as UsageRecord)
			}
		} catch {
			// Loose validation: skip malformed / partially-written lines.
		}
	}
	return order.map((id) => bySessionId.get(id) as UsageRecord)
}

/**
	* Read + loosely validate one live usage snapshot (`*.live.json` — a single
	* JSON object, overwritten in place, NOT JSONL). Missing or malformed files
	* yield `null` (never throws for ENOENT / bad JSON — same ethos as
	* `readUsageFile`).
	*/
export async function readLiveUsageFile(file: string): Promise<LiveUsageRecord | null> {
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
		const parsed = JSON.parse(raw) as Partial<LiveUsageRecord>
		if (typeof parsed.sessionId === "string" && parsed.status === "running") {
			return parsed as LiveUsageRecord
		}
		return null
	} catch {
		// Loose validation: a partially-written snapshot is not a session.
		return null
	}
}
