/**
 * Recursive self-improvement progress metrics (issue #145) — v1, scoped
 * to a LOCAL dev-machine dashboard (no external deploy): computes a set
 * of real, backfillable proxies for "is this loop actually getting
 * better at running itself," from data this repo already has on disk
 * plus `git log` and `gh issue list` — no new data collection required.
 *
 * Five metrics, each independently computable (a missing data source
 * degrades that ONE section, never the whole response):
 *
 *  1. Session outcome rate over time (success/error/budget %, hourly
 *     buckets) — from `.headlesscode/usage/*.jsonl` via aggregate.ts's
 *     `buildSummary`. The most direct "is it working" signal the
 *     original issue named.
 *  2. Standing guardrails landed, cumulative — commits whose message
 *     references a real issue number (`(#123)` or `#123`), from
 *     `git log`. A proxy for "the system is learning from its own
 *     failures," even though each fix is still human/Claude-authored.
 *  3. Issue lifecycle (filed vs. closed over time, running open count)
 *     — from `gh issue list --state all`. Requires `gh` + network;
 *     degrades to `undefined` (not an error) when unavailable.
 *  4. Iteration efficiency — mean iterations per SUCCESSFUL session,
 *     hourly — are successful runs getting cheaper/more direct over
 *     time, not just more numerous.
 *  5. Session volume over time — raw dispatch count per hour, the
 *     activity-level context the other four metrics need to be read
 *     against (a success-rate spike on 2 sessions means less than one
 *     on 20).
 *
 * Pure + fs/exec-only (mirrors aggregate.ts's own stated ethos): no
 * `node:http` here, so it's unit-testable without the dashboard server.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { buildSummary, type SessionRow } from "./aggregate.js"

const execFileP = promisify(execFile)

export interface HourlyOutcomeBucket {
	/** ISO-8601 hour bucket start, e.g. "2026-08-21T22:00:00.000Z". */
	hour: string
	success: number
	error: number
	budget: number
	total: number
	successRate: number
}

export interface GuardrailCommit {
	sha: string
	date: string
	subject: string
	issueRefs: number[]
}

export interface IssueLifecycleHour {
	hour: string
	filed: number
	closed: number
}

export interface IssueLifecycle {
	hours: IssueLifecycleHour[]
	currentOpenCount: number
	currentClosedCount: number
	totalTracked: number
}

export interface IterationEfficiencyHour {
	hour: string
	meanIterations: number
	successCount: number
}

export interface SessionVolumeHour {
	hour: string
	count: number
}

export interface SelfImprovementMetrics {
	generatedAt: string
	repo: string
	totalSessions: number
	overallSuccessRate: number
	sessionOutcomesByHour: HourlyOutcomeBucket[]
	standingGuardrails: {
		commits: GuardrailCommit[]
		cumulativeByHour: Array<{ hour: string; cumulative: number }>
		totalCount: number
	}
	issueLifecycle: IssueLifecycle | undefined
	iterationEfficiencyByHour: IterationEfficiencyHour[]
	sessionVolumeByHour: SessionVolumeHour[]
}

/** Floor an ISO timestamp to its containing hour, returned as an ISO string. */
function hourBucket(iso: string): string {
	const d = new Date(iso)
	d.setUTCMinutes(0, 0, 0)
	return d.toISOString()
}

function sortedHours(hours: Iterable<string>): string[] {
	return [...new Set(hours)].sort()
}

export function computeSessionOutcomesByHour(sessions: SessionRow[]): HourlyOutcomeBucket[] {
	const buckets = new Map<string, { success: number; error: number; budget: number }>()
	for (const s of sessions) {
		const hour = hourBucket(s.startedAt)
		const bucket = buckets.get(hour) ?? { success: 0, error: 0, budget: 0 }
		if (s.status === "success") bucket.success++
		else if (s.status === "budget") bucket.budget++
		else bucket.error++
		buckets.set(hour, bucket)
	}
	return sortedHours(buckets.keys()).map((hour) => {
		const b = buckets.get(hour)
		if (!b) {
			throw new Error(`[self-improvement-metrics] internal: no bucket for hour ${hour}`)
		}
		const total = b.success + b.error + b.budget
		return { hour, ...b, total, successRate: total > 0 ? b.success / total : 0 }
	})
}

export function computeIterationEfficiencyByHour(sessions: SessionRow[]): IterationEfficiencyHour[] {
	const buckets = new Map<string, { sum: number; count: number }>()
	for (const s of sessions) {
		if (s.status !== "success") continue
		const hour = hourBucket(s.startedAt)
		const bucket = buckets.get(hour) ?? { sum: 0, count: 0 }
		bucket.sum += s.iterations
		bucket.count++
		buckets.set(hour, bucket)
	}
	return sortedHours(buckets.keys()).map((hour) => {
		const b = buckets.get(hour)
		if (!b) {
			throw new Error(`[self-improvement-metrics] internal: no bucket for hour ${hour}`)
		}
		return { hour, meanIterations: b.count > 0 ? b.sum / b.count : 0, successCount: b.count }
	})
}

export function computeSessionVolumeByHour(sessions: SessionRow[]): SessionVolumeHour[] {
	const buckets = new Map<string, number>()
	for (const s of sessions) {
		const hour = hourBucket(s.startedAt)
		buckets.set(hour, (buckets.get(hour) ?? 0) + 1)
	}
	return sortedHours(buckets.keys()).map((hour) => ({ hour, count: buckets.get(hour) ?? 0 }))
}

/** Extract unique issue numbers referenced in a commit subject, e.g. "fix(x): y (#141)" -> [141]. */
export function extractIssueRefs(subject: string): number[] {
	const matches = subject.match(/#(\d+)/g) ?? []
	return [...new Set(matches.map((m) => Number(m.slice(1))))]
}

/**
 * Standing guardrails: commits whose subject references a real issue
 * number, on the current branch's history. Deliberately subject-only (not
 * full commit body) — the body of a large fix commit often cites OTHER
 * issue numbers as background/evidence (see this repo's own commits from
 * 2026-08-21), which would inflate the count with references that aren't
 * actually "this commit closes/addresses that issue."
 */
export async function computeStandingGuardrails(
	repoRoot: string,
): Promise<{ commits: GuardrailCommit[]; cumulativeByHour: Array<{ hour: string; cumulative: number }>; totalCount: number }> {
	let stdout: string
	try {
		;({ stdout } = await execFileP("git", ["log", "--pretty=format:%H|%aI|%s", "--no-merges"], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 16 }))
	} catch {
		return { commits: [], cumulativeByHour: [], totalCount: 0 }
	}
	const commits: GuardrailCommit[] = []
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue
		const [sha, date, ...rest] = line.split("|")
		const subject = rest.join("|")
		const issueRefs = extractIssueRefs(subject)
		if (issueRefs.length > 0) {
			commits.push({ sha, date, subject, issueRefs })
		}
	}
	// `git log`'s default order is newest-first; reverse to oldest-first
	// BEFORE the stable sort so two commits sharing the same author-date
	// second (the %aI format's granularity) preserve real chronological
	// order instead of staying in git log's newest-first order for that tie.
	commits.reverse()
	commits.sort((a, b) => a.date.localeCompare(b.date))
	const cumulativeByHour: Array<{ hour: string; cumulative: number }> = []
	let running = 0
	const hourTotals = new Map<string, number>()
	for (const c of commits) {
		const hour = hourBucket(c.date)
		hourTotals.set(hour, (hourTotals.get(hour) ?? 0) + 1)
	}
	for (const hour of sortedHours(hourTotals.keys())) {
		running += hourTotals.get(hour) ?? 0
		cumulativeByHour.push({ hour, cumulative: running })
	}
	return { commits, cumulativeByHour, totalCount: commits.length }
}

interface GhIssueRecord {
	number: number
	createdAt: string
	closedAt: string | null
	state: string
}

/**
 * Issue lifecycle via `gh issue list`. Returns undefined (not an error)
 * when `gh` isn't installed/authenticated or the repo has no GitHub
 * remote — this metric is optional, the other four don't depend on it.
 */
export async function computeIssueLifecycle(repoRoot: string): Promise<IssueLifecycle | undefined> {
	let stdout: string
	try {
		;({ stdout } = await execFileP(
			"gh",
			["issue", "list", "--state", "all", "--limit", "500", "--json", "number,createdAt,closedAt,state"],
			{ cwd: repoRoot, maxBuffer: 1024 * 1024 * 16 },
		))
	} catch {
		return undefined
	}
	let records: GhIssueRecord[]
	try {
		records = JSON.parse(stdout) as GhIssueRecord[]
	} catch {
		return undefined
	}
	const filedByHour = new Map<string, number>()
	const closedByHour = new Map<string, number>()
	let currentOpenCount = 0
	let currentClosedCount = 0
	for (const r of records) {
		const filedHour = hourBucket(r.createdAt)
		filedByHour.set(filedHour, (filedByHour.get(filedHour) ?? 0) + 1)
		if (r.state === "OPEN") {
			currentOpenCount++
		} else {
			currentClosedCount++
			if (r.closedAt) {
				const closedHour = hourBucket(r.closedAt)
				closedByHour.set(closedHour, (closedByHour.get(closedHour) ?? 0) + 1)
			}
		}
	}
	const allHours = sortedHours([...filedByHour.keys(), ...closedByHour.keys()])
	const hours = allHours.map((hour) => ({ hour, filed: filedByHour.get(hour) ?? 0, closed: closedByHour.get(hour) ?? 0 }))
	return { hours, currentOpenCount, currentClosedCount, totalTracked: records.length }
}

export async function computeSelfImprovementMetrics(repoRoot: string): Promise<SelfImprovementMetrics> {
	const summary = await buildSummary(repoRoot)
	const sessions = summary.sessions
	const successCount = sessions.filter((s) => s.status === "success").length

	const [standingGuardrails, issueLifecycle] = await Promise.all([
		computeStandingGuardrails(repoRoot),
		computeIssueLifecycle(repoRoot),
	])

	return {
		generatedAt: new Date().toISOString(),
		repo: repoRoot,
		totalSessions: sessions.length,
		overallSuccessRate: sessions.length > 0 ? successCount / sessions.length : 0,
		sessionOutcomesByHour: computeSessionOutcomesByHour(sessions),
		standingGuardrails,
		issueLifecycle,
		iterationEfficiencyByHour: computeIterationEfficiencyByHour(sessions),
		sessionVolumeByHour: computeSessionVolumeByHour(sessions),
	}
}
