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
 * events.ts). Estimating future task cost FROM this history is explicit
 * future work, not implemented here — this module only records and reads
 * raw records; `headlesscode cost-history` (cost-history-cli.ts) is the
 * read-side for now.
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { resolveProjectDataDir } from "../project-store.js"
import type { OrchestratorGroup } from "./state.js"

/** One recorded group's combined cost/token/iteration totals. */
export interface CostHistoryRecord {
	recordedAt: string
	repo: string
	groupName: string
	/** Every GitHub issue number this group's work covered (see OrchestratorGroup.issues). */
	issues: number[]
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
	const record: CostHistoryRecord = {
		recordedAt: new Date().toISOString(),
		repo: path.resolve(repoRoot),
		groupName: group.name,
		issues: group.issues ?? [],
		status: group.status,
		branch: group.branch,
		costUsd: group.usage.costUsd,
		inputTokens: group.usage.inputTokens,
		outputTokens: group.usage.outputTokens,
		cachedTokens: group.usage.cachedTokens ?? 0,
		iterations: group.usage.iterations,
		continuationCount: group.continuationCount ?? 0,
		reworkCount: group.reworkCount ?? 0,
	}
	await appendCostHistoryRecord(repoRoot, record)
	return record
}
