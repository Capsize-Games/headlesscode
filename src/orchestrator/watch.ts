/**
 * Completion monitoring for the orchestrator (Phase 2).
 *
 * Replaces the GUI wake-up (xdotool phone-home / wmctrl) with
 * process/IPC signals written by scripts/run-worker.sh:
 *
 *   <worktree>/.harness.pid              worker PID (written at launch)
 *   <worktree>/.harness.pgid             worker process-group id (written by the
 *                                        wrapper under setsid; issue #20 — lets a
 *                                        stop command kill the WHOLE tree)
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
 * matching the original 2h stall detection) with no completion — a group that is
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
import {
	loadStateSync,
	mutateState,
	updateGroup,
	type OrchestratorGroup,
	type OrchestratorState,
} from "./state.js"
import { recordGroupCost, recordAllSessionCosts } from "./cost-history.js"

export const DEFAULT_POLL_INTERVAL_MS = 5_000
export const DEFAULT_STALL_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2h

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

/**
 * The harness loop's main-call failure message (src/engine/loop.ts's
 * `LLM request failed on iteration N: ...`) — this is what used to be a
 * completely SILENT dead end: a provider blip that outlasted the one retry
 * in src/engine/loop.ts's callMainLlm (see isRetryableOpenRouterError in
 * src/llm/openrouter.ts) killed the whole session, the group landed in the
 * generic terminal "failed" state indistinguishable from a real code/logic
 * failure, and nothing ever looked at it again — a human had to happen to
 * open harness.log to learn the task itself was never actually attempted at
 * fault. Observed live 2026-08-08: a hard-pinned model with no fallback
 * provider (allow_fallbacks: false) hit an HTTP 520 mid-session and the
 * group just sat there.
 *
 * Matched by the SAME error-message shapes isRetryableOpenRouterError
 * classifies as transient (provider 5xx/429/no-allowed-providers, or a raw
 * network-error message) — this is deliberately a narrower net than "any
 * failure": a deterministic error (bad tool call, budget stop, real bug)
 * must never auto-continue, only "the model provider itself misbehaved."
 */
export const PROVIDER_FAILURE_RE =
	/LLM request failed on iteration \d+:.*(?:OpenRouter returned HTTP (?:429|5\d\d)|no allowed providers|Network error calling OpenRouter)/is

/** Whether a worker's log summary indicates a transient LLM-provider failure (see PROVIDER_FAILURE_RE) rather than a real task/code failure. */
export function isProviderFailure(summary: string | undefined): boolean {
	return typeof summary === "string" && PROVIDER_FAILURE_RE.test(summary)
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
	/**
	 * Whether this round runs the automated review step (default true,
	 * matching orchestrate's own `--no-review` default). Cost-history
	 * recording (recordCostIfTerminal) needs this: a "done" group's review
	 * (and, if review is clean, QA) hasn't necessarily run yet the FIRST
	 * moment the worker's own `.harness.done` marker appears — recording
	 * right then would miss those sessions' cost. When review is enabled,
	 * recording waits for `group.review_verdict` to be set.
	 */
	reviewEnabled?: boolean
	/**
	 * Whether this round runs QA (default false, matching orchestrate's own
	 * `--qa` opt-in default). When enabled, cost-history recording for a
	 * "done" group additionally waits for `group.qa` to be set.
	 */
	qaEnabled?: boolean
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
export function readWorktreeUsage(wtPath: string): OrchestratorGroup["usage"] | undefined {
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

/** The rollup shape shared by totalUsage/batchUsage (see OrchestratorState). */
export interface UsageRollup {
	costUsd: number
	inputTokens: number
	outputTokens: number
	cachedTokens?: number
	iterations: number
}

/** Sum every group's `usage` into a round-level total (see OrchestratorState.totalUsage). */
export function computeTotalUsage(state: OrchestratorState): UsageRollup | undefined {
	return sumGroupUsage(state.groups)
}

/**
 * Issue #118: per-batch usage aggregate — the sum of every group's `usage`
 * that BELONGS to the current batch, matching `state.batch` by prefix against
 * the group's `spawned` ISO timestamp (e.g. `batch: "round-2026-08-17"` ->
 * `spawned: "2026-08-17T…"`). `totalUsage` is cumulative across ALL groups
 * ever recorded in the state file (prior rounds' groups are retained for
 * history/cleanup bookkeeping), so it can diverge arbitrarily from what the
 * CURRENT round actually cost; this scopes the sum back to the round at hand.
 * Returns undefined when no current-batch group has a usage record yet.
 */
export function computeBatchUsage(state: OrchestratorState): UsageRollup | undefined {
	const batch = state.batch
	if (!batch) {
		return undefined
	}
	const prefix = batch.replace(/^round-/, "")
	return sumGroupUsage(
		state.groups.filter((group) => {
			if (!group.spawned) {
				return false
			}
			const spawned = group.spawned
			const spawnedDate = spawned.slice(0, 10)
			// Full-date batch ("2026-08-17") must match the spawned DATE
			// exactly; a timestamp-prefixed batch ("2026-08-17T…") must run
			// through the 'T' separator (>= 11 chars) so a truncated prefix
			// like "2026-08-1" can never over-match a whole day.
			return spawnedDate === prefix || (prefix.length >= 11 && spawned.startsWith(prefix))
		}),
	)
}

function sumGroupUsage(groups: OrchestratorGroup[]): UsageRollup | undefined {
	let costUsd = 0
	let inputTokens = 0
	let outputTokens = 0
	let cachedTokens = 0
	let iterations = 0
	let found = false
	for (const group of groups) {
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

/** Read + validate a numeric pid/pgid marker file; undefined when absent/invalid. */
function readPidFile(wtPath: string, name: string): number | undefined {
	let raw: string
	try {
		raw = fs.readFileSync(path.join(wtPath, name), "utf-8").trim()
	} catch {
		return undefined
	}
	if (!/^\d+$/.test(raw)) {
		return undefined
	}
	return Number(raw)
}

/** `process.kill(pid, 0)` liveness probe (a negative pid targets a process group). */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/**
 * Whether the process recorded in a pid file (default `.harness.pid`) is
 * ACTUALLY still running — not just whether the file exists. A worker that
 * crashes or is killed without cleaning up its own pid file leaves a stale
 * file behind forever; checking existence alone made a dead worker
 * indistinguishable from a live one, which is what caused the 2026-08-02
 * incident below (see `inspectGroup`'s stall-guard branch).
 *
 * The pid-file name is a parameter so the same liveness check can be reused
 * for the QA session marker (`.qa.pid`) by orchestrate cleanup — one
 * mechanism, never reinvented.
 *
 * Issue #20: for the worker's OWN pid file specifically, liveness is checked
 * at the process GROUP level when available (`.harness.pgid`, written by
 * run-worker.sh's setsid launch): killing only the wrapper bash — the
 * `.harness.pid` process — leaves the real child running reparented to
 * init, and a wrapper-only check would report the worker dead while it
 * keeps burning the session. Workers launched before the setsid change (and
 * any non-default pidFile, e.g. the QA session's `.qa.pid`, which has no
 * group concept) fall back to the single-pid check.
 */
export function isPidAlive(wtPath: string, pidFile = ".harness.pid"): boolean {
	if (pidFile === ".harness.pid") {
		const pgid = readPidFile(wtPath, ".harness.pgid")
		if (pgid !== undefined) {
			return processAlive(-pgid)
		}
	}
	const pid = readPidFile(wtPath, pidFile)
	return pid !== undefined && processAlive(pid)
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
			// `.slice(-4000)`, NOT `.slice(0, 4000)`: this is a TAIL (already the
			// last SUMMARY_TAIL_LINES lines of the run) being capped to a char
			// budget. Keeping the FIRST 4000 chars of a tail throws away the most
			// recent content — exactly the lines that report the actual terminal
			// outcome (a worker's final error, e.g. "Max iterations (N) reached
			// without task completion"). This was a real, confirmed production
			// bug: it silently broke isIterationExhaustion's detection (the
			// summary never contained the error string it matches against), so
			// auto-continuation never fired for genuinely iteration-exhausted
			// groups, AND it broke human/agent-facing status reporting (the
			// "summary" shown was always a stale mid-run snapshot, never the
			// real ending) — both from the same one-line bug.
			summary: summary.slice(-4000),
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

	// Watcher heartbeat (issue #116): stamp <statePath>.watcher with our PID
	// at the same cadence as the poll loop. A concurrent read-side `status
	// --wait` (status.ts) checks this file's freshness to decide whether a
	// live watch loop owns the state — when it does, the status call must NOT
	// persist its read-side reconciliation (that would pre-empt this loop,
	// which then short-circuits the group as already-terminal and silently
	// skips log analysis + the automated review). Best-effort: a heartbeat
	// write failure must never crash the watcher.
	const heartbeatPath = `${statePath}.watcher`
	const heartbeat = (): void => {
		try {
			fs.writeFileSync(heartbeatPath, String(process.pid))
		} catch {
			// Best-effort — see above.
		}
	}
	heartbeat()

	// Previously-seen status per group, seeded from the loaded state: the
	// loop only prints a status-change line on a genuine transition, so a
	// group that stays blocked/running across polls never re-spams it.
	const lastSeenStatus = new Map<string, string>()
	for (const g of state.groups) {
		lastSeenStatus.set(g.name, g.status)
	}

	const isTerminal = (g: OrchestratorGroup): boolean =>
		g.status === "done" || g.status === "failed" || g.status === "needs-human"

	const reviewEnabled = options.reviewEnabled ?? true
	const qaEnabled = options.qaEnabled ?? false

	/**
	 * Whether a group has NO more automated work pending, i.e. it's safe to
	 * record its cost as final. For "failed"/"needs-human" this is just
	 * `isTerminal` — cli.ts's review/QA sections both gate on
	 * `group.status === "done"`, so a failed or needs-human group never gets
	 * reviewed/QA'd at all. For "done" specifically, review (if enabled) and
	 * QA (if enabled) may still be IN PROGRESS the first moment the worker's
	 * own `.harness.done` marker appears — recording right then would miss
	 * those sessions' real cost entirely (they're separate HeadlessSession
	 * runs against the same worktree, each writing their own
	 * `.headlesscode/usage/*.jsonl`, but nothing re-triggers a usage rollup
	 * for a "done" group unless a rework respawn happens). So for "done",
	 * wait for `review_verdict`/`qa` to actually be populated first.
	 */
	const isSettled = (g: OrchestratorGroup): boolean => {
		if (g.status !== "done") {
			return isTerminal(g)
		}
		const reviewSettled = !reviewEnabled || g.review_verdict !== undefined
		const qaSettled = !qaEnabled || g.qa !== undefined
		return reviewSettled && qaSettled
	}

	// Mandatory cost/token history recording (cost-history.ts): fires exactly
	// once per group, the FIRST time it's observed SETTLED (see isSettled),
	// regardless of which of orchestrate's many branches got it there (a
	// clean "done" + review + QA, a real failure, a rework-cap exhaustion, a
	// continuation-cap exhaustion all reach this the same way). A single
	// insertion point here — rather than one call per terminal-outcome
	// branch in cli.ts's onGroupUpdate — means no future branch can
	// silently skip recording by forgetting to call it. Called from two
	// spots below: for a group ALREADY settled at the top of a poll pass
	// (e.g. reloaded from disk after onGroupUpdate marked it needs-human),
	// and immediately after a group's settledness may have changed WITHIN
	// the current pass (needed because `allTerminal` can return before the
	// loop ever revisits that group at the top of a fresh pass).
	const recordCostIfSettled = async (g: OrchestratorGroup): Promise<void> => {
		if (!isSettled(g) || g.cost_recorded !== undefined) {
			return
		}
		// Recompute usage FRESH from the worktree rather than trusting
		// `g.usage` (which may predate the review/QA sessions that just ran
		// against the same worktree, each writing their own usage file) —
		// this is what actually makes review/QA cost visible in the record.
		const freshUsage = readWorktreeUsage(groupWorktreePath(repoRoot, g))
		try {
			await recordGroupCost(repoRoot, { ...g, usage: freshUsage })
		} catch (err) {
			writeStderr(
				`[orchestrate] cost recording for ${g.name} failed: ${err instanceof Error ? err.message : String(err)}\n`,
			)
		}
		// Per-session breakdown (with outcome: success/error/budget/killed) —
		// makes wasted spend (a session that errored, hit budget, or was
		// killed before finishing, e.g. a rework respawned by a bug) visible
		// on its own, not just silently folded into the group's combined
		// total above.
		try {
			await recordAllSessionCosts(repoRoot, g)
		} catch (err) {
			writeStderr(
				`[orchestrate] per-session cost recording for ${g.name} failed: ${err instanceof Error ? err.message : String(err)}\n`,
			)
		}
		// Mark recorded regardless of whether recordGroupCost found usage to
		// write (undefined return = nothing to record, e.g. failed before any
		// session wrote a usage file) — either way, don't retry forever.
		//
		// Issue #79: go through mutateState (cross-process lock, same as
		// patchGroup) rather than a manual loadStateSync/updateGroup/
		// saveStateSync sequence — reloading fresh right before the save
		// narrows the race but does not close it; a concurrent onGroupUpdate
		// callback can write directly to the state file via patchGroup between
		// this function's loadStateSync and its saveStateSync (e.g. cli.ts's
		// clean-verdict path after a rework reset), which would otherwise
		// clobber the callback's own write — a real regression this exact fix
		// caught (cli.test.ts's rework/continuation-reset re-poll tests).
		state = await mutateState(statePath, (fresh) => updateGroup(fresh, g.name, { cost_recorded: new Date().toISOString() }))
	}

	// onGroupUpdate calls in flight (keyed by group name), fired without
	// blocking this loop's iteration over the OTHER groups — see issue #24:
	// awaiting each group's review/QA inline in this loop meant one group's
	// multi-minute review fully monopolized the watcher, leaving every other
	// group's completion undetected (and its own review/QA unstarted) for as
	// long as the in-flight one took. `allTerminal` below must not fire until
	// this set drains, or the round would report done while review/QA for a
	// group is still silently running in the background.
	const inFlightCallbacks = new Map<string, Promise<void>>()

	while (true) {
		if (options.signal?.aborted) {
			// Issue #135: a group's onGroupUpdate callback can itself be what
			// triggers the abort (e.g. a caller stopping the loop the moment it
			// observes the first update) — at that point the callback's own
			// async tail (state re-fetch + recordCostIfSettled's saveState) is
			// still in flight in inFlightCallbacks. Returning immediately let
			// that write race the caller's own post-return cleanup (a test's
			// `finally { rm(tmpDir) }`, or a real process exit) and occasionally
			// lose: an ENOENT on saveState's rename once the target directory
			// was already gone. Drain every in-flight callback before handing
			// control back, so no write from this loop can ever outlive it.
			await Promise.all(inFlightCallbacks.values())
			break
		}
		// Refresh the watcher heartbeat FIRST so a concurrently-running
		// `status --wait` (status.ts) sees this loop as alive before it
		// considers persisting its own read-side reconciliation.
		heartbeat()
		// Reload fresh from disk every pass rather than trusting the loop's
		// in-memory `state`: a concurrently in-flight onGroupUpdate call (see
		// inFlightCallbacks above) writes review/QA patches and rework/
		// continuation resets directly to the state file via patchGroup, with
		// no synchronous signal back to this loop. Anything this pass reads
		// must come from disk to see those writes.
		state = loadStateSync(statePath)
		// Resync transition tracking against whatever the fresh state shows:
		// a background callback may have reset a group's status (e.g.
		// "done" -> "running" for a rework/continuation respawn) since the
		// last pass, and that must still print a transition line even though
		// no `inspectGroup` patch drove it this pass.
		for (const group of state.groups) {
			const prevStatus = lastSeenStatus.get(group.name) ?? group.status
			if (group.status !== prevStatus) {
				printStatusTransition(writeStderr, group, { status: group.status }, group.status)
				lastSeenStatus.set(group.name, group.status)
			}
		}
		const now = Date.now()
		let changed = false

		for (const group of state.groups) {
			// A group whose onGroupUpdate is still in flight must not be
			// re-inspected: a rework/continuation reset writes the "running"
			// status BEFORE it finishes clearing and re-creating the
			// .harness.done/.harness.exit markers (each fs op is a separate
			// await), so a poll landing in that window would see "running" +
			// stale leftover markers and spuriously re-fire the callback for
			// the SAME group a second time before the first invocation ever
			// finished resetting them.
			if (inFlightCallbacks.has(group.name)) {
				continue
			}
			if (isTerminal(group)) {
				await recordCostIfSettled(group)
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
			// Issue #79: route this write through mutateState's cross-process
			// lock (the same infra patchGroup uses) rather than applying `patch`
			// to this pass's start-of-loop `state` snapshot and saving that
			// directly. Without this, a concurrent in-flight onGroupUpdate
			// callback (see inFlightCallbacks below) writing via patchGroup can
			// have its just-written review/QA verdict silently clobbered by this
			// loop's stale snapshot the next time it saves — the exact
			// lost-update bug patchGroup exists to prevent, just reached from
			// this loop instead of from a callback.
			state = await mutateState(statePath, (fresh) => {
				let next = updateGroup(fresh, group.name, patch)
				// Cost/token monitoring: recompute the round-level totals whenever
				// a group's usage may have changed (i.e. every state update —
				// cheap, and keeps totalUsage/batchUsage never stale). totalUsage
				// is cumulative across every group ever recorded; batchUsage is
				// scoped to the current batch (issue #118).
				next = {
					...next,
					totalUsage: computeTotalUsage(next),
					batchUsage: computeBatchUsage(next),
				}
				return next
			})
			changed = true
			const updated = state.groups.find((g) => g.name === group.name)
			// Fire the callback WITHOUT blocking this loop's iteration over the
			// other groups (issue #24) — `updated` just transitioned into a
			// terminal status this pass, so the top-of-loop `isTerminal` check
			// above guards against re-firing it for the same group while this
			// call is still in flight (its status stays "done"/"failed"/
			// "needs-human" in the state file the whole time this callback
			// runs, even mid-review, since review/QA outcomes are separate
			// fields). Guard with inFlightCallbacks too, defensively, in case
			// a future status shape changes that invariant.
			if (updated && !inFlightCallbacks.has(group.name)) {
				const callback = (async () => {
					try {
						await options.onGroupUpdate?.(updated, state)
					} catch (err) {
						writeStderr(
							`[orchestrate] onGroupUpdate for ${group.name} failed: ${err instanceof Error ? err.message : String(err)}\n`,
						)
					}
					// The callback (if any) persisted its patches directly to the
					// state file via patchGroup — re-fetch fresh rather than
					// trusting this closure's `state`, which may now be stale
					// relative to disk (this group's own writes, or another
					// group's concurrent writes). Record cost now rather than
					// waiting for a future pass, since `allTerminal` only drains
					// via inFlightCallbacks.size, not by revisiting this group.
					const freshAfterCallback = loadStateSync(statePath).groups.find((g) => g.name === group.name)
					if (freshAfterCallback) {
						await recordCostIfSettled(freshAfterCallback)
					}
				})()
				inFlightCallbacks.set(group.name, callback)
				void callback.finally(() => {
					inFlightCallbacks.delete(group.name)
				})
			}
		}

		const allTerminal =
			state.groups.length > 0 && state.groups.every(isTerminal) && inFlightCallbacks.size === 0
		if (allTerminal) {
			// Reload once more: an in-flight callback observed as drained just
			// above may have written its final patch to disk after this pass's
			// `state` was last touched.
			return { state: loadStateSync(statePath), allTerminal: true }
		}
		if (!changed) {
			await sleep(pollIntervalMs)
		}
	}

	return { state, allTerminal: state.groups.length > 0 && state.groups.every(isTerminal) }
}
