/**
 * Completion monitoring for the orchestrator (Phase 2).
 *
 * Replaces the airunner GUI wake-up (xdotool phone-home / wmctrl) with
 * process/IPC signals written by scripts/run-worker.sh:
 *
 *   <worktree>/.harness.pid              worker PID (written at launch)
 *   <worktree>/.harness.exit             worker exit code (written on harness exit)
 *   <worktree>/.harness.done/            completion marker DIR (mkdir-based, atomic,
 *                                        same lock-mutex convention as phone-home.sh)
 *   <worktree>/.harness.needs-decision   decision escalation marker (JSON:
 *                                        question/suggestions?/askedAt — see
 *                                        src/tools/executor.ts's
 *                                        ask_followup_question handler)
 *   <worktree>/harness.log               worker stdout+stderr
 *
 * `watchGroups` polls those markers (short configurable interval, default 5s —
 * NO fixed 20s sleep), updates `.orchestrator-state.json` (status
 * done|failed|blocked, exit code, summary from the harness.log tail,
 * last_activity), and invokes an optional per-group callback (used to trigger
 * the reviewer) when a group transitions to done. A stall guard flags groups
 * whose spawned timestamp exceeds HEADLESSCODE_STALL_TIMEOUT (default 2h,
 * matching airunner's 2h stall detection) with no completion — a group that is
 * "blocked" (needs-decision marker present) is exempt from the stall guard
 * while the marker exists: waiting on a real question is not stalling. Once
 * the marker disappears (answered via scripts/headlesscode-answer.sh, or the
 * worker's wait timed out and it moved on), the group flows back to "running"
 * on the next poll.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { UsageRecord } from "../engine/usage.js"
import { loadStateSync, saveStateSync, updateGroup, type OrchestratorGroup, type OrchestratorState } from "./state.js"

export const DEFAULT_POLL_INTERVAL_MS = 5_000
export const DEFAULT_STALL_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2h, matching airunner

/** Number of harness.log lines kept as the group summary. */
const SUMMARY_TAIL_LINES = 40

/**
 * The harness loop's exact iteration-cap failure message (the `result.error`
 * from src/engine/loop.ts, printed by src/cli.ts to stderr, which
 * run-worker.sh redirects into harness.log and the watcher captures in the
 * group summary). The ONLY failure reason that may auto-continue a group —
 * a budget stop or a real error must stay terminal.
 */
export const MAX_ITERATIONS_ERROR_RE = /Max iterations \(\d+\) reached without task completion/

/**
 * Run-boundary separator that scripts/run-worker.sh appends to harness.log
 * before launching each session. Since a worktree is reused across
 * continuation/rework respawns and harness.log is now append-only (never
 * truncated, so full log history + accumulated spend/token context survive a
 * restart), tailLog() must scope to content AFTER the last separator —
 * otherwise a short current-run log could still have a stale "Max iterations
 * reached" line from a previous session inside its last-N-lines window and
 * misfire another continuation.
 */
const RUN_SEPARATOR_RE = /^===== headlesscode run start: .* =====$/

/**
 * Whether a worker's log summary indicates it failed specifically because it
 * hit the iteration cap ("the task is bigger than one session") vs. some
 * other reason. Pure + unit-testable so the watcher's continuation decision
 * stays thin (see handleIterationExhaustion in cli.ts).
 */
export function isIterationExhaustion(summary: string | undefined): boolean {
	return typeof summary === "string" && MAX_ITERATIONS_ERROR_RE.test(summary)
}

export interface WatchOptions {
	/** Target repo root containing `.worktrees/` (also used to resolve). */
	repoRoot: string
	/** State file path (default: <repoRoot>/.worktrees/.orchestrator-state.json). */
	statePath?: string
	/** Poll interval (default 5s). */
	pollIntervalMs?: number
	/** Stall guard (default: $HEADLESSCODE_STALL_TIMEOUT or 2h). */
	stallTimeoutMs?: number
	/**
	 * Optional callback fired when a group transitions to done/failed.
	 * Returning `true` tells watchGroups that the callback REWROTE the state
	 * file (e.g. the rework loop reset a group back to "running" and spawned a
	 * new worker on the same worktree): the loop reloads the state from disk
	 * and re-polls, so the group is picked up as "running" → "done" →
	 * re-reviewed exactly like a first attempt.
	 */
	onGroupUpdate?: (group: OrchestratorGroup, state: OrchestratorState) => void | Promise<void | boolean>
	/**
	 * Injectable stderr writer for the proactive status-change signal
	 * (default: process.stderr) — lets tests capture the emitted lines.
	 */
	stderrWriter?: (text: string) => void
	/** Abort the watch loop (e.g. from a parent orchestrator). */
	signal?: AbortSignal
}

export interface WatchSummary {
	state: OrchestratorState
	/** True when every group reached a terminal state (done/failed/needs-human/stalled). */
	allTerminal: boolean
}

/**
 * Tail a file's last `maxLines` lines (used for the group summary), scoped to
 * content after the LAST run-start separator so a respawned worker's summary
 * (and the exhaustion check derived from it) never sees a previous session's
 * output — see RUN_SEPARATOR_RE.
 */
export function tailLog(logPath: string, maxLines = SUMMARY_TAIL_LINES): string {
	try {
		const raw = fs.readFileSync(logPath, "utf-8")
		const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "")
		let lastSeparator = -1
		for (let i = lines.length - 1; i >= 0; i--) {
			if (RUN_SEPARATOR_RE.test(lines[i])) {
				lastSeparator = i
				break
			}
		}
		const currentRun = lastSeparator >= 0 ? lines.slice(lastSeparator + 1) : lines
		return currentRun.slice(-maxLines).join("\n")
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

/**
 * Cost/token monitoring (workstream 3): sum every usage record found under
 * `<worktree>/.headlesscode/usage/*.jsonl` (the worker's session usage — see
 * `src/engine/usage.ts`). Defensive: a worktree is expected to hold exactly
 * one worker session's usage file, but a worktree reused across multiple
 * sessions would have more than one file (or a file with multiple lines) —
 * summing all records found is the correct rollup either way. Returns
 * undefined when no usage data is found (missing dir, no files, or every
 * file unreadable/empty) so callers don't stamp a spurious all-zero usage.
 */
function readWorktreeUsage(wtPath: string): OrchestratorGroup["usage"] | undefined {
	const dir = path.join(wtPath, ".headlesscode", "usage")
	let files: string[]
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
	} catch {
		return undefined
	}

	let costUsd = 0
	let inputTokens = 0
	let outputTokens = 0
	let cachedTokens = 0
	let iterations = 0
	let found = false

	for (const file of files) {
		let raw: string
		try {
			raw = fs.readFileSync(path.join(dir, file), "utf-8")
		} catch {
			continue
		}
		for (const line of raw.split("\n")) {
			const trimmed = line.trim()
			if (!trimmed) {
				continue
			}
			try {
				const record = JSON.parse(trimmed) as Partial<UsageRecord>
				if (typeof record.sessionId !== "string") {
					continue
				}
				costUsd += typeof record.costUsd === "number" ? record.costUsd : 0
				inputTokens += typeof record.inputTokens === "number" ? record.inputTokens : 0
				outputTokens += typeof record.outputTokens === "number" ? record.outputTokens : 0
				cachedTokens += typeof record.cachedTokens === "number" ? record.cachedTokens : 0
				iterations += typeof record.iterations === "number" ? record.iterations : 0
				found = true
			} catch {
				// Loose validation: skip malformed / partially-written lines.
			}
		}
	}

	return found ? { costUsd, inputTokens, outputTokens, cachedTokens, iterations } : undefined
}

/** Sum every group's `usage` into a round-level total (see OrchestratorState.totalUsage). */
export function computeTotalUsage(state: OrchestratorState): OrchestratorState["totalUsage"] {
	let costUsd = 0
	let inputTokens = 0
	let outputTokens = 0
	let cachedTokens = 0
	let iterations = 0
	let found = false
	for (const group of state.groups) {
		if (!group.usage) {
			continue
		}
		found = true
		costUsd += group.usage.costUsd
		inputTokens += group.usage.inputTokens
		outputTokens += group.usage.outputTokens
		cachedTokens += group.usage.cachedTokens ?? 0
		iterations += group.usage.iterations
	}
	return found ? { costUsd, inputTokens, outputTokens, cachedTokens, iterations } : undefined
}

function hasDoneMarker(wtPath: string): boolean {
	try {
		return fs.statSync(path.join(wtPath, ".harness.done")).isDirectory()
	} catch {
		return false
	}
}

/** Decision-escalation marker contents (see src/tools/executor.ts). */
interface NeedsDecision {
	question: string
	suggestions?: string[]
	askedAt?: string
}

/** Read + loosely validate `.harness.needs-decision`; undefined when absent/malformed. */
function readNeedsDecision(wtPath: string): NeedsDecision | undefined {
	let raw: string
	try {
		raw = fs.readFileSync(path.join(wtPath, ".harness.needs-decision"), "utf-8")
	} catch {
		return undefined
	}
	try {
		const parsed: unknown = JSON.parse(raw)
		if (parsed === null || typeof parsed !== "object" || typeof (parsed as Record<string, unknown>).question !== "string") {
			return undefined
		}
		const obj = parsed as Record<string, unknown>
		return {
			question: obj.question as string,
			...(Array.isArray(obj.suggestions) ? { suggestions: obj.suggestions as string[] } : {}),
			...(typeof obj.askedAt === "string" ? { askedAt: obj.askedAt as string } : {}),
		}
	} catch {
		return undefined
	}
}

/**
 * Whether the worker process recorded in `.harness.pid` is ACTUALLY still
 * running — not just whether the pid file exists. A worker that crashes or
 * is killed without cleaning up its own pid file leaves a stale file behind
 * forever; checking existence alone made a dead worker indistinguishable
 * from a live one, which is what caused the 2026-08-02 incident below (see
 * `inspectGroup`'s stall-guard branch).
 */
function isPidAlive(wtPath: string): boolean {
	let raw: string
	try {
		raw = fs.readFileSync(path.join(wtPath, ".harness.pid"), "utf-8").trim()
	} catch {
		return false
	}
	if (!/^\d+$/.test(raw)) {
		return false
	}
	try {
		process.kill(Number(raw), 0)
		return true
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
	// `needs-human` is terminal: a group that exhausted its rework attempts is
	// never re-polled for completion markers (no worker is running on it).
	const isTerminal = group.status === "done" || group.status === "failed" || group.status === "needs-human"

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
		const usage = readWorktreeUsage(wtPath)
		return {
			status,
			last_activity: {
				note,
				last_commit: lastCommit(wtPath),
			},
			commits: group.commits ?? [],
			...(exitCode !== undefined ? { exit_code: exitCode } : {}),
			summary: summary.slice(0, 4000),
			...(usage ? { usage } : {}),
		}
	}

	// No done marker yet.
	if (isTerminal) {
		return undefined
	}

	// Decision escalation: the worker's ask_followup_question call is blocked
	// waiting for a human/orchestrator answer. Not stalling — exempt from the
	// stall guard below while the marker is present.
	const decision = readNeedsDecision(wtPath)
	if (decision) {
		const alreadyBlocked =
			group.status === "blocked" &&
			group.blocked?.question === decision.question &&
			group.blocked?.askedAt === decision.askedAt
		if (alreadyBlocked) {
			return undefined
		}
		return {
			status: "blocked",
			blocked: decision,
			last_activity: {
				note: `blocked: awaiting decision — ${decision.question}`,
			},
		}
	}

	// Marker gone: a previously blocked group resumed (answered or timed out
	// and fell back to autonomous decision) — flow back to "running".
	if (group.status === "blocked") {
		return { status: "running", blocked: undefined }
	}

	// Stall guard: spawned long ago with no completion marker.
	//
	// 2026-08-02 incident: this branch used to return a freshly-constructed
	// patch on EVERY poll once a group passed stallTimeoutMs, even when
	// nothing had actually changed since the previous poll (same "still
	// stalled" note, forever). watchGroups' loop only sleeps when nothing
	// changed, and treated "inspectGroup returned a patch" as "something
	// changed" -- so once any group entered this state, the outer loop
	// never slept again: a zero-delay busy loop that ran for 11+ hours at
	// ~76% CPU, continuously rewriting .orchestrator-state.json, on a
	// worktree whose worker had actually already died (a stale
	// `.harness.pid` file made `hasPid` return true forever, so the branch
	// never resolved to a terminal state either -- see `isPidAlive` above,
	// which replaces a file-existence check with an actual liveness check).
	//
	// Fixed by two changes: (1) resolve to "failed" the moment the process
	// is confirmed dead, instead of reporting "still stalled" forever with
	// no live process behind it; (2) for a genuinely still-alive-but-slow
	// worker, report the stall ONCE (the first time `group.stalled` flips
	// true) rather than on every subsequent poll -- an unresolved stall
	// that hasn't changed state is not new information.
	if (!Number.isNaN(startedAt) && now - startedAt > stallTimeoutMs) {
		if (!isPidAlive(wtPath)) {
			return {
				status: "failed",
				stalled: true,
				last_activity: {
					note:
						`STALLED: no completion marker after ${Math.round(stallTimeoutMs / 60000)}m ` +
						`and the worker process is no longer running (spawned ${group.spawned})`,
				},
			}
		}
		if (group.stalled === true) {
			// Already reported; still alive, still no completion -- not new.
			return undefined
		}
		return {
			stalled: true,
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
 * Print a concise, human-facing status-change line to the watch loop's
 * stderr writer (proactive monitoring — see plans/live-monitoring-gaps.md,
 * gap 2). Only ever called on a genuine status transition by watchGroups,
 * so a group that stays blocked/running never spams the same lines. The
 * review verdict per group is intentionally omitted: the orchestrator CLI
 * already prints it (`[orchestrate] <group> review verdict: …`) after
 * running the reviewer.
 */
function printStatusTransition(
	write: (text: string) => void,
	group: OrchestratorGroup,
	patch: Partial<Omit<OrchestratorGroup, "name">>,
	newStatus: string,
): void {
	const worktree = group.worktree ?? `.worktrees/${group.name}`
	switch (newStatus) {
		case "blocked": {
			const question = patch.blocked?.question ?? ""
			write(`[orchestrate] BLOCKED: group "${group.name}" needs a decision — "${question}"\n`)
			write(`[orchestrate]   answer with: scripts/headlesscode-answer.sh ${worktree} "<answer>"\n`)
			break
		}
		case "done":
			write(`[orchestrate] DONE: group "${group.name}" finished (exit ${patch.exit_code ?? 0})\n`)
			break
		case "failed":
			write(
				`[orchestrate] FAILED: group "${group.name}" failed` +
					(patch.stalled ? " (stalled)" : ` (exit ${patch.exit_code ?? "?"})`) +
					"\n",
			)
			break
		case "needs-human":
			write(
				`[orchestrate] NEEDS-HUMAN: group "${group.name}" exhausted ` +
					`${group.reworkCount ?? 0} rework attempt(s) and still has review findings — a human must look at this\n`,
			)
			break
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

	const writeStderr = options.stderrWriter ?? ((text: string) => process.stderr.write(text))

	// Previously-seen status per group, seeded from the loaded state: the
	// loop only prints a status-change line on a genuine transition, so a
	// group that stays blocked/running across polls never re-spams it.
	const lastSeenStatus = new Map<string, string>()
	for (const g of state.groups) {
		lastSeenStatus.set(g.name, g.status)
	}

	const isTerminal = (g: OrchestratorGroup): boolean =>
		g.status === "done" || g.status === "failed" || g.status === "needs-human"

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
			// Proactive status-change signal (gap 2): print a clear stderr line
			// on the transition into blocked / done / failed / needs-human —
			// only when the status genuinely changed, never on every poll while
			// a group stays in the same state.
			if (typeof patch.status === "string") {
				const prevStatus = lastSeenStatus.get(group.name) ?? group.status
				if (patch.status !== prevStatus) {
					printStatusTransition(writeStderr, group, patch, patch.status)
				}
				lastSeenStatus.set(group.name, patch.status)
			}
			state = updateGroup(state, group.name, patch)
			// Cost/token monitoring: recompute the round-level total whenever a
			// group's usage may have changed (i.e. every state update — cheap,
			// and keeps totalUsage never stale).
			state = { ...state, totalUsage: computeTotalUsage(state) }
			saveStateSync(statePath, state)
			changed = true
			const updated = state.groups.find((g) => g.name === group.name)
			if (updated) {
				const reload = await options.onGroupUpdate?.(updated, state)
				if (reload === true) {
					// The callback rewrote the state file (rework loop: group
					// reset to "running", or marked "needs-human"). The loop's
					// in-memory state is stale — reload from disk (the
					// authoritative source) and restart this poll pass so the
					// group is re-inspected under its new status. lastSeenStatus
					// is resynced so transition lines stay accurate.
					state = loadStateSync(statePath)
					for (const g of state.groups) {
						lastSeenStatus.set(g.name, g.status)
					}
					break
				}
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
