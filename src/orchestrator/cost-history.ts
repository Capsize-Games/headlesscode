/**
 * Cost/token history — the CENTRAL project store's `cost-history.jsonl`
 * (`~/.local/share/headlesscode/projects/<key>/cost-history.jsonl`, see
 * src/project-store.ts). One record per orchestrator group that reaches a
 * terminal status (done/failed/needs-human), keyed by the repo's
 * git-common-dir so every worktree of a repo shares the same history file.
 *
 * Deliberately NOT posted to GitHub issues: a group can carry MULTIPLE
 * issue numbers (see split.ts's same-shape batching), so a per-group total
 * attached as an issue comment would either be duplicated across every
 * issue in the group (misleading — reads as "this issue cost $X" when
 * $X was actually spent across N issues) or arbitrarily attributed to
 * one. A single structured record naming ALL of a group's issues avoids
 * that ambiguity and stays queryable, which per-issue prose comments
 * would not be.
 *
 * `group.usage` (read here) is already the CORRECT combined total across
 * every session that ran on a group's worktree — inspectGroup's usage
 * rollup (readWorktreeUsage) sums every `.headlesscode/usage/*.jsonl` file
 * found, and a worktree gets a new usage file per session, so an original
 * attempt plus any continuation/rework respawns on the SAME worktree are
 * already combined by the time a group reaches its final terminal status.
 *
 * This is deliberately a plain append-only JSONL store, no query engine —
 * matching the project's established idiom (mode-models.json, usage.ts,
 * events.ts). Estimating future task cost FROM this history is implemented
 * in cost-estimate.ts (issue #16): it aggregates these records by issue
 * shape and `orchestrate --dry-run` reports the expected cost/iteration
 * range for a new task; `headlesscode cost-history --by-shape` prints the
 * per-shape aggregates. This module only records and reads raw records.
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { resolveProjectDataDir } from "../project-store.js"
import { usageDir, type UsageRecord } from "../engine/usage.js"
import type { OrchestratorGroup } from "./state.js"

/** One recorded group's combined cost/token/iteration totals. */
export interface CostHistoryRecord {
	recordedAt: string
	repo: string
	groupName: string
	/** Every GitHub issue number this group's work covered (see OrchestratorGroup.issues). */
	issues: number[]
	/**
	 * The per-issue shape (split.ts's issueShape: hot / split / coverage /
	 * test / docs / refactor / generic), one entry per issue in the same
	 * order as `issues` — captured at dispatch time (OrchestratorGroup.shapes)
	 * and copied here so cost-estimate.ts can match a NEW issue to similar
	 * past ones (issue #16). Undefined for records written before this field
	 * existed (or from groups spawned without shapes) — those records can
	 * only be matched by exact issue number, never by shape.
	 */
	shapes?: string[]
	/** Final status at recording time: done | failed | needs-human. */
	status: string
	branch?: string
	costUsd: number
	inputTokens: number
	outputTokens: number
	cachedTokens: number
	iterations: number
	/** How many auto-continuation/rework respawns happened on this group's worktree before it finished. */
	continuationCount: number
	reworkCount: number
	/**
	 * When the group's FIRST worker session was spawned (OrchestratorGroup.spawned,
	 * i.e. round-dispatch time — the earliest point headlesscode itself has
	 * visibility into, not the GitHub issue's own createdAt). Undefined only
	 * for pre-existing groups recorded before this field was added.
	 */
	spawnedAt?: string
	/**
	 * Wall-clock time from spawnedAt to recordedAt (dispatch-to-completion),
	 * covering every continuation/rework/review/QA cycle in between — the
	 * metric that directly measures headlesscode's OWN pipeline efficiency,
	 * separate from cost. A bug that forces an extra rework cycle costs both
	 * money (costUsd) AND wall-clock time (this field); tracking both is what
	 * makes "did fixing bug X actually speed up the next run" answerable.
	 * Undefined when spawnedAt is unavailable.
	 */
	wallClockMs?: number
}

/** Config file basename inside the central project data dir. */
export const COST_HISTORY_FILE = "cost-history.jsonl"

/** Absolute path of the central cost-history.jsonl for a workspace root. */
export function costHistoryFilePath(workspaceRoot: string): string {
	return path.join(resolveProjectDataDir(workspaceRoot), COST_HISTORY_FILE)
}

/** Append one record (non-fatal on write failure is the CALLER's responsibility — this throws). */
export async function appendCostHistoryRecord(workspaceRoot: string, record: CostHistoryRecord): Promise<void> {
	const file = costHistoryFilePath(workspaceRoot)
	await fsp.mkdir(path.dirname(file), { recursive: true })
	await fsp.appendFile(file, JSON.stringify(record) + "\n", "utf-8")
}

/**
 * Read + loosely validate the cost-history file. Malformed lines are
 * skipped; a missing file yields an empty array (never throws for ENOENT)
 * — same idiom as `readEventsFile`/`readUsageFile`.
 */
export async function readCostHistory(workspaceRoot: string): Promise<CostHistoryRecord[]> {
	let raw: string
	try {
		raw = await fsp.readFile(costHistoryFilePath(workspaceRoot), "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw error
	}
	const records: CostHistoryRecord[] = []
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		try {
			const parsed = JSON.parse(trimmed) as Partial<CostHistoryRecord>
			if (
				typeof parsed.recordedAt === "string" &&
				typeof parsed.groupName === "string" &&
				typeof parsed.costUsd === "number" &&
				Array.isArray(parsed.issues)
			) {
				records.push(parsed as CostHistoryRecord)
			}
		} catch {
			// Loose validation: skip malformed / partially-written lines.
		}
	}
	return records
}

/**
 * Build a CostHistoryRecord from a terminal group and append it to the
 * repo's central history. Returns `undefined` (records nothing) when the
 * group has no `usage` — nothing meaningful to record (e.g. a group that
 * failed before any session ever wrote a usage file).
 */
export async function recordGroupCost(repoRoot: string, group: OrchestratorGroup): Promise<CostHistoryRecord | undefined> {
	if (!group.usage) {
		return undefined
	}
	const recordedAt = new Date().toISOString()
	// group.spawned is NOT the original dispatch time — handleReviewVerdict/
	// handleIterationExhaustion's reset patches explicitly overwrite it with
	// "now" on every rework/continuation respawn (so the stall guard measures
	// the CURRENT attempt, not a possibly-hours-old original one). Using it
	// here would under-report wallClockMs to just the final cycle, hiding
	// exactly the wasted time a bug-triggered extra cycle adds — the thing
	// this metric exists to make visible. The true start is the EARLIEST
	// startedAt across every session that ever ran on this worktree (usage
	// files are never deleted across respawns), so derive it from there,
	// falling back to group.spawned only if no usage data exists at all.
	const worktreePath = path.resolve(repoRoot, group.worktree ?? `.worktrees/${group.name}`)
	const spawnedAt = (await earliestSessionStart(worktreePath)) ?? group.spawned
	const record: CostHistoryRecord = {
		recordedAt,
		repo: path.resolve(repoRoot),
		groupName: group.name,
		issues: group.issues ?? [],
		shapes: group.shapes,
		status: group.status,
		branch: group.branch,
		costUsd: group.usage.costUsd,
		inputTokens: group.usage.inputTokens,
		outputTokens: group.usage.outputTokens,
		cachedTokens: group.usage.cachedTokens ?? 0,
		iterations: group.usage.iterations,
		continuationCount: group.continuationCount ?? 0,
		reworkCount: group.reworkCount ?? 0,
		spawnedAt,
		wallClockMs: spawnedAt ? Date.parse(recordedAt) - Date.parse(spawnedAt) : undefined,
	}
	await appendCostHistoryRecord(repoRoot, record)
	return record
}

/**
 * The earliest `startedAt` across every session (completed `.jsonl` or
 * orphaned `.live.json`) ever recorded in a worktree's usage dir — the
 * true "work on this group began at" timestamp, immune to group.spawned
 * being reset on every rework/continuation respawn. Returns undefined
 * when the usage dir doesn't exist or contains no valid records.
 */
async function earliestSessionStart(worktreePath: string): Promise<string | undefined> {
	const dir = usageDir(worktreePath)
	let entries: string[]
	try {
		entries = await fsp.readdir(dir)
	} catch {
		return undefined
	}
	let earliest: string | undefined
	for (const file of entries) {
		if (!file.endsWith(".jsonl") && !file.endsWith(".live.json")) {
			continue
		}
		try {
			const raw = await fsp.readFile(path.join(dir, file), "utf-8")
			const firstLine = raw.trim().split("\n")[0]
			const parsed = JSON.parse(firstLine) as { startedAt?: string }
			if (typeof parsed.startedAt === "string" && (!earliest || parsed.startedAt < earliest)) {
				earliest = parsed.startedAt
			}
		} catch {
			continue
		}
	}
	return earliest
}

/**
 * One individual session's cost, with its own outcome — the per-session
 * companion to CostHistoryRecord's per-GROUP combined total. Exists
 * specifically so wasted spend (a session that errored, hit budget, or was
 * killed before finishing) is visible and queryable on its own, not just
 * silently folded into a group's final combined total. A real incident
 * that motivated this: a worker respawned by a false-positive review bug
 * ran to completion finding nothing to fix (real cost, zero useful
 * outcome) — before this, that cost was invisible; the group-level total
 * doesn't distinguish it from productive work.
 */
export interface SessionCostRecord {
	recordedAt: string
	repo: string
	groupName: string
	issues: number[]
	sessionId: string
	/** The session's mode (code | deepseek-reviewer | qa-agent | ...) — the closest thing to a "role" label available. */
	mode: string
	/**
	 * success | error | budget — from the session's own final usage record
	 * (engine/usage.ts's UsageRecord.status) when it completed normally, or
	 * "killed" when only an orphaned `.live.json` snapshot was found (the
	 * session's own recordUsage()/removeLiveSnapshot() cleanup never ran —
	 * see usage.ts: that pair runs on EVERY normal completion path, success,
	 * error, or budget, so a leftover live snapshot means the process was
	 * killed or crashed before reaching it).
	 */
	status: "success" | "error" | "budget" | "killed"
	costUsd: number
	inputTokens: number
	outputTokens: number
	cachedTokens: number
	iterations: number
	startedAt: string
	endedAt?: string
}

/** Config file basename inside the central project data dir. */
export const SESSION_COST_HISTORY_FILE = "session-cost-history.jsonl"

/** Absolute path of the central session-cost-history.jsonl for a workspace root. */
export function sessionCostHistoryFilePath(workspaceRoot: string): string {
	return path.join(resolveProjectDataDir(workspaceRoot), SESSION_COST_HISTORY_FILE)
}

/** Append one per-session record (non-fatal on write failure is the CALLER's responsibility — this throws). */
export async function appendSessionCostRecord(workspaceRoot: string, record: SessionCostRecord): Promise<void> {
	const file = sessionCostHistoryFilePath(workspaceRoot)
	await fsp.mkdir(path.dirname(file), { recursive: true })
	await fsp.appendFile(file, JSON.stringify(record) + "\n", "utf-8")
}

/**
 * Read + loosely validate the session-cost-history file. Malformed lines
 * are skipped; a missing file yields an empty array (never throws for
 * ENOENT) — same idiom as the group-level history.
 */
export async function readSessionCostHistory(workspaceRoot: string): Promise<SessionCostRecord[]> {
	let raw: string
	try {
		raw = await fsp.readFile(sessionCostHistoryFilePath(workspaceRoot), "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw error
	}
	const records: SessionCostRecord[] = []
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		try {
			const parsed = JSON.parse(trimmed) as Partial<SessionCostRecord>
			if (typeof parsed.recordedAt === "string" && typeof parsed.sessionId === "string" && typeof parsed.costUsd === "number") {
				records.push(parsed as SessionCostRecord)
			}
		} catch {
			// Loose validation: skip malformed / partially-written lines.
		}
	}
	return records
}

/**
 * Scan a worktree's `.headlesscode/usage/` dir for every session that has
 * EVER run there (completed `.jsonl` records AND orphaned `.live.json`
 * snapshots left behind by a killed/crashed session), and append a
 * SessionCostRecord for each one not already recorded — idempotent via
 * checking sessionIds already present in the history file, same pattern
 * as `cost_recorded` gates re-recording at the group level. Returns every
 * record appended THIS call (empty array if everything was already
 * recorded, or the usage dir doesn't exist).
 */
export async function recordAllSessionCosts(repoRoot: string, group: OrchestratorGroup): Promise<SessionCostRecord[]> {
	const worktreePath = path.resolve(repoRoot, group.worktree ?? `.worktrees/${group.name}`)
	const dir = usageDir(worktreePath)
	let entries: string[]
	try {
		entries = await fsp.readdir(dir)
	} catch {
		return []
	}

	const existing = await readSessionCostHistory(repoRoot)
	const alreadyRecorded = new Set(existing.map((r) => r.sessionId))

	const completedIds = new Set(entries.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length)))
	const newRecords: SessionCostRecord[] = []

	for (const file of entries) {
		if (file.endsWith(".jsonl")) {
			const sessionId = file.slice(0, -".jsonl".length)
			if (alreadyRecorded.has(sessionId)) {
				continue
			}
			let usage: UsageRecord
			try {
				const raw = await fsp.readFile(path.join(dir, file), "utf-8")
				usage = JSON.parse(raw.trim().split("\n")[0]) as UsageRecord
			} catch {
				continue
			}
			const record: SessionCostRecord = {
				recordedAt: new Date().toISOString(),
				repo: path.resolve(repoRoot),
				groupName: group.name,
				issues: group.issues ?? [],
				sessionId,
				mode: usage.mode,
				status: usage.status,
				costUsd: usage.costUsd,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedTokens: usage.cachedTokens ?? 0,
				iterations: usage.iterations,
				startedAt: usage.startedAt,
				endedAt: usage.endedAt,
			}
			await appendSessionCostRecord(repoRoot, record)
			newRecords.push(record)
		} else if (file.endsWith(".live.json")) {
			const sessionId = file.slice(0, -".live.json".length)
			// A completed .jsonl for the same session means recordUsage() DID
			// run (success/error/budget) — the live snapshot is just stale
			// leftover from before that, not a sign of a killed session.
			if (alreadyRecorded.has(sessionId) || completedIds.has(sessionId)) {
				continue
			}
			let live: { mode: string; costUsd: number; inputTokens: number; outputTokens: number; cachedTokens?: number; iterations: number; startedAt: string }
			try {
				const raw = await fsp.readFile(path.join(dir, file), "utf-8")
				live = JSON.parse(raw)
			} catch {
				continue
			}
			const record: SessionCostRecord = {
				recordedAt: new Date().toISOString(),
				repo: path.resolve(repoRoot),
				groupName: group.name,
				issues: group.issues ?? [],
				sessionId,
				mode: live.mode,
				status: "killed",
				costUsd: live.costUsd,
				inputTokens: live.inputTokens,
				outputTokens: live.outputTokens,
				cachedTokens: live.cachedTokens ?? 0,
				iterations: live.iterations,
				startedAt: live.startedAt,
			}
			await appendSessionCostRecord(repoRoot, record)
			newRecords.push(record)
		}
	}
	return newRecords
}
