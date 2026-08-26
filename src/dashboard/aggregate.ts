/**
 * Cost/token dashboard — pure aggregation logic (workstream 3) + live
 * per-session event feed (live worker monitoring).
 *
 * Scans `.headlesscode/usage/*.jsonl` files (see `src/engine/usage.ts` for
 * the on-disk shape/writer) under a repo root — both the repo's own usage
 * dir (direct, non-orchestrated runs) and every `.worktrees/<name>/` worker
 * worktree (orchestrated runs) — and, when `.worktrees/.orchestrator-state.json`
 * exists, folds in the round-level rollup (per-group usage + any group
 * currently `status: "blocked"`, surfacing the pending question).
 *
 * `readSessionEvents` (the Phase 1 live-monitoring feed) reads a session's
 * `<workspaceRoot>/.headlesscode/events/<sessionId>.jsonl` (see
 * `src/engine/events.ts` for the on-disk shape/writer) from the repo root's
 * own events dir OR any `.worktrees/<name>/` events dir — the same dual
 * search `buildSummary` performs for usage files.
 *
 * Deliberately pure + fs-only: no `node:http` here, so it's unit-testable
 * without spinning up the dashboard server (see `src/dashboard/server.ts`
 * for the HTTP wrapper that calls `buildSummary`).
 *
 * Validation is loose (matches the project's established ethos — plain fs +
 * JSON, no schema library): missing/malformed files are skipped, never
 * thrown from `buildSummary`.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"

import { eventsFilePath, readEventsFile, type EventRecord } from "../engine/events.js"
import { readLiveUsageFile, readUsageFile, type LiveUsageRecord, type UsageRecord } from "../engine/usage.js"
import { loadState, type OrchestratorGroup, type OrchestratorState } from "../orchestrator/state.js"

/** One row in the dashboard's per-session table. */
export interface SessionRow {
	sessionId: string
	mode: string
	model: string
	iterations: number
	inputTokens: number
	outputTokens: number
	/** Subset of inputTokens served from the provider's prompt cache (0 when unreported). */
	cachedTokens: number
	costUsd: number
	startedAt: string
	endedAt: string
	status: string
	workspaceRoot: string
	/** Which worktree/usage dir this record was found under (relative to repo, for display). */
	source: string
}

export interface UsageTotals {
	costUsd: number
	inputTokens: number
	outputTokens: number
	cachedTokens: number
	iterations: number
	sessionCount: number
}

/** A group currently blocked on `ask_followup_question`, surfaced for display. */
export interface BlockedGroup {
	name: string
	question: string
	suggestions?: string[]
	askedAt?: string
}

export interface RoundSummary {
	batch?: string
	updated?: string
	totalUsage?: OrchestratorState["totalUsage"]
	/** Issue #118: usage summed over only the current batch's groups (undefined when none yet). */
	batchUsage?: OrchestratorState["batchUsage"]
	groups: OrchestratorGroup[]
	blocked: BlockedGroup[]
	/** Issue #13 preflight probe result (present once orchestrate ran it). */
	preflight?: OrchestratorState["preflight"]
}

export interface DashboardSummary {
	generatedAt: string
	repo?: string
	sessions: SessionRow[]
	totals: UsageTotals
	round?: RoundSummary
}

function emptyTotals(): UsageTotals {
	return { costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, iterations: 0, sessionCount: 0 }
}

/** List `*.jsonl` files directly inside `dir` (non-recursive); [] when missing/unreadable. */
async function listJsonlFiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		return entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => path.join(dir, e.name))
	} catch {
		return []
	}
}

/** List `*.live.json` snapshot files directly inside `dir` (non-recursive); [] when missing/unreadable. */
async function listLiveJsonFiles(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		return entries.filter((e) => e.isFile() && e.name.endsWith(".live.json")).map((e) => path.join(dir, e.name))
	} catch {
		return []
	}
}

/** Map one usage record (completed or live) to a dashboard session row. */
function toSessionRow(r: UsageRecord | LiveUsageRecord, source: string): SessionRow {
	return {
		sessionId: r.sessionId,
		mode: r.mode,
		model: r.model,
		iterations: r.iterations ?? 0,
		inputTokens: r.inputTokens ?? 0,
		outputTokens: r.outputTokens ?? 0,
		cachedTokens: r.cachedTokens ?? 0,
		costUsd: r.costUsd ?? 0,
		startedAt: r.startedAt,
		// Live snapshots have no endedAt (the session is still running).
		endedAt: "endedAt" in r ? r.endedAt : "",
		status: r.status,
		workspaceRoot: r.workspaceRoot,
		source,
	}
}

/**
 * Read every usage record under `<root>/.headlesscode/usage` — both completed
 * `*.jsonl` records and live `*.live.json` snapshots — tagged with `source`.
 */
async function readUsageDir(root: string, source: string): Promise<SessionRow[]> {
	const dir = path.join(root, ".headlesscode", "usage")
	const rows: SessionRow[] = []

	// Completed sessions: one JSONL file per session (append-only format).
	for (const file of await listJsonlFiles(dir)) {
		let records: UsageRecord[]
		try {
			records = await readUsageFile(file)
		} catch {
			continue
		}
		for (const r of records) {
			rows.push(toSessionRow(r, source))
		}
	}

	// Live (in-progress) sessions: one overwritten JSON snapshot per session.
	for (const file of await listLiveJsonFiles(dir)) {
		let live: LiveUsageRecord | null
		try {
			live = await readLiveUsageFile(file)
		} catch {
			continue
		}
		if (live) {
			rows.push(toSessionRow(live, source))
		}
	}
	return rows
}

/** Sum a set of session rows into totals. */
export function sumSessions(rows: SessionRow[]): UsageTotals {
	const totals = emptyTotals()
	for (const row of rows) {
		totals.costUsd += row.costUsd
		totals.inputTokens += row.inputTokens
		totals.outputTokens += row.outputTokens
		totals.cachedTokens += row.cachedTokens
		totals.iterations += row.iterations
		totals.sessionCount += 1
	}
	return totals
}

/**
 * Locate the events feed file for one session id, searching the repo root's
 * own events dir AND every `.worktrees/<name>/` worktree events dir (the same
 * dual search `buildSummary` performs for usage files). Returns the file path
 * + a display `source` label, or undefined when no feed exists anywhere.
 */
export async function findSessionEventsFile(
	repo: string,
	sessionId: string,
): Promise<{ file: string; source: string } | undefined> {
	const repoRoot = path.resolve(repo)

	// 1. Direct (non-orchestrated) sessions run against the repo root itself.
	const rootFile = eventsFilePath(repoRoot, sessionId)
	try {
		await fs.access(rootFile)
		return { file: rootFile, source: "." }
	} catch {
		// Not here — check worktrees.
	}

	// 2. Orchestrated worker sessions, one events dir per worktree.
	const worktreesDir = path.join(repoRoot, ".worktrees")
	let worktreeNames: string[] = []
	try {
		const entries = await fs.readdir(worktreesDir, { withFileTypes: true })
		worktreeNames = entries.filter((e) => e.isDirectory()).map((e) => e.name)
	} catch {
		worktreeNames = []
	}
	for (const name of worktreeNames) {
		const file = eventsFilePath(path.join(worktreesDir, name), sessionId)
		try {
			await fs.access(file)
			return { file, source: `.worktrees/${name}` }
		} catch {
			// Keep looking.
		}
	}
	return undefined
}

/**
 * Read a session's structured event feed, optionally starting from a byte
 * offset (`sinceOffset` — the incremental "give me only what's new since I
 * last asked" polling idea, like `tail -f`). Returns the new events plus the
 * next offset to pass on the following poll.
 *
 * Pure + fs-only, never throws for a missing feed: a session with no events
 * file yet (or already cleaned up) yields `{ events: [], nextOffset: 0 }`.
 * Loose validation is inherited from `readEventsFile` (malformed /
 * partially-written trailing lines are skipped).
 */
export async function readSessionEvents(
	repo: string,
	sessionId: string,
	sinceOffset = 0,
): Promise<{ events: EventRecord[]; nextOffset: number }> {
	const found = await findSessionEventsFile(repo, sessionId)
	if (!found) {
		return { events: [], nextOffset: 0 }
	}
	const events = await readEventsFile(found.file)
	// Byte-offset semantics (tail -f): a line is considered consumed only
	// when its END (start + encoded length, newline included) lies at or
	// before the offset — a partially-appended line (the caller's offset
	// lands mid-line) is returned whole. Lines after the consumed prefix are
	// returned; nextOffset is the byte offset just past the last returned
	// line, so the next poll passes it back as sinceOffset.
	let fileSize = 0
	try {
		fileSize = (await fs.stat(found.file)).size
	} catch {
		fileSize = 0
	}
	// The offset never exceeds the current file size, so a shrunk/recreated
	// file degrades to "read from the start".
	const safeOffset = Math.min(Math.max(0, sinceOffset), fileSize)
	const encoded = events.map((e) => JSON.stringify(e) + "\n")
	let startIndex = 0
	let bytesSeen = 0
	for (let i = 0; i < encoded.length; i++) {
		const lineBytes = Buffer.byteLength(encoded[i])
		if (safeOffset < bytesSeen + lineBytes) {
			// This line is not fully consumed — it (and everything after) is new.
			startIndex = i
			break
		}
		bytesSeen += lineBytes
		startIndex = i + 1
	}
	const newEvents = events.slice(startIndex)
	const newBytes = encoded.slice(startIndex).reduce((acc, line) => acc + Buffer.byteLength(line), 0)
	return { events: newEvents, nextOffset: safeOffset + newBytes }
}

/**
 * Build the dashboard's summary for one repo (or none — sessions/totals are
 * simply empty). Never throws: every fs read is defensive (missing dir,
 * malformed JSON, missing state file all degrade gracefully).
 */
export async function buildSummary(repo?: string): Promise<DashboardSummary> {
	if (!repo) {
		return { generatedAt: new Date().toISOString(), sessions: [], totals: emptyTotals() }
	}

	const repoRoot = path.resolve(repo)
	const sessions: SessionRow[] = []

	// 1. Direct (non-orchestrated) sessions run against the repo root itself.
	sessions.push(...(await readUsageDir(repoRoot, ".")))

	// 2. Orchestrated worker sessions, one usage dir per worktree.
	const worktreesDir = path.join(repoRoot, ".worktrees")
	let worktreeNames: string[] = []
	try {
		const entries = await fs.readdir(worktreesDir, { withFileTypes: true })
		worktreeNames = entries.filter((e) => e.isDirectory()).map((e) => e.name)
	} catch {
		worktreeNames = []
	}
	for (const name of worktreeNames) {
		sessions.push(...(await readUsageDir(path.join(worktreesDir, name), `.worktrees/${name}`)))
	}

	// 3. Round-level rollup from .orchestrator-state.json, when present.
	let round: RoundSummary | undefined
	const statePath = path.join(worktreesDir, ".orchestrator-state.json")
	try {
		await fs.stat(statePath)
		const state = await loadState(statePath)
		const blocked: BlockedGroup[] = state.groups
			.filter((g) => g.status === "blocked" && g.blocked?.question)
			.map((g) => ({
				name: g.name,
				question: g.blocked?.question ?? "",
				suggestions: g.blocked?.suggestions,
				askedAt: g.blocked?.askedAt,
			}))
		round = {
			batch: state.batch,
			updated: state.updated,
			totalUsage: state.totalUsage,
			batchUsage: state.batchUsage,
			groups: state.groups,
			blocked,
			preflight: state.preflight,
		}
	} catch {
		round = undefined
	}

	// Gap 1: merge live snapshots with completed records. If both a
	// `.live.json` and a completed `.jsonl` record exist for the same session
	// id (a narrow race at the exact moment of completion), the completed
	// record wins — never double-count or show duplicates. Duplicate completed
	// records (same id, multiple jsonl lines) keep their prior behavior.
	const deduped: SessionRow[] = []
	const bySessionId = new Map<string, number>()
	for (const row of sessions) {
		const idx = bySessionId.get(row.sessionId)
		if (idx === undefined) {
			bySessionId.set(row.sessionId, deduped.length)
			deduped.push(row)
		} else if (deduped[idx].status === "running" && row.status !== "running") {
			// A completed .jsonl record takes precedence over a stale live snapshot.
			deduped[idx] = row
		}
	}

	// Deterministic ordering: most recently started session first.
	deduped.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))

	return {
		generatedAt: new Date().toISOString(),
		repo: repoRoot,
		sessions: deduped,
		totals: sumSessions(deduped),
		round,
	}
}
