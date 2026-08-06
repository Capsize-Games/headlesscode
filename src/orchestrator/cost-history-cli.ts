/**
 * `headlesscode cost-history` subcommand — read-side for cost-history.ts's
 * central `cost-history.jsonl` (per-group combined totals) and
 * `session-cost-history.jsonl` (per-session, with outcome — the wasted-
 * spend breakdown). Recording is automatic and mandatory (see watch.ts's
 * `recordCostIfSettled`/`recordAllSessionCosts`); this is for looking at
 * what's been recorded — filterable by issue number, printed as a
 * human-readable table or raw JSON. `--by-shape` (issue #16) prints
 * per-shape cost/iteration aggregates, including continuation/rework rates.
 * Estimating a NEW task's cost from this history is cost-estimate.ts's job,
 * surfaced by `orchestrate --dry-run`.
 *
 *   headlesscode cost-history --repo <path> [--issue <n>] [--sessions] [--by-shape] [--json]
 */

import { readCostHistory, readSessionCostHistory, type CostHistoryRecord, type SessionCostRecord } from "./cost-history.js"
import { aggregateByShape } from "./cost-estimate.js"

const COST_HISTORY_USAGE = `headlesscode cost-history — read recorded cost/token history for a repo

Usage:
  headlesscode cost-history --repo <path> [options]

Options:
  --repo <path>     Target repo root (required)
  --issue <n>       Only show records covering this issue number (repeatable)
  --sessions        Show the per-session breakdown (with outcome: success/
                     error/budget/killed) instead of per-group totals —
                     this is where wasted spend (non-success outcomes)
                     is visible
  --by-shape        Show per-shape aggregates (samples, median cost, median
                     cost per issue, median iterations, continuation/rework
                     rates) instead of per-group rows — surfaces how much a
                     given issue SHAPE tends to cost and how often it needs
                     rework cycles (issue #16). Shapes are only recorded for
                     groups dispatched after issue #16
  --json            Print the raw records as JSON instead of a table
  --help            Show this help and exit
`

interface CostHistoryCliOptions {
	repo: string
	issues: number[]
	sessions: boolean
	byShape: boolean
	json: boolean
}

export function parseCostHistoryArgs(argv: string[]): CostHistoryCliOptions | { help: true } | { error: string } {
	let repo: string | undefined
	const issues: number[] = []
	let sessions = false
	let byShape = false
	let json = false

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--help" || arg === "-h") {
			return { help: true }
		} else if (arg === "--repo") {
			repo = argv[++i]
		} else if (arg === "--issue") {
			const raw = argv[++i]
			const n = Number(raw)
			if (!raw || !Number.isInteger(n)) {
				return { error: `--issue must be an integer, got: ${raw}` }
			}
			issues.push(n)
		} else if (arg === "--sessions") {
			sessions = true
		} else if (arg === "--by-shape") {
			byShape = true
		} else if (arg === "--json") {
			json = true
		} else {
			return { error: `unknown argument: ${arg}` }
		}
	}

	if (!repo) {
		return { error: "--repo is required" }
	}
	return { repo, issues, sessions, byShape, json }
}

/** Human-readable duration, e.g. "37m", "1h 12m", "2d 3h". Undefined input renders as "?". */
function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
		return "?"
	}
	const totalMinutes = Math.round(ms / 60000)
	const days = Math.floor(totalMinutes / 1440)
	const hours = Math.floor((totalMinutes % 1440) / 60)
	const minutes = totalMinutes % 60
	if (days > 0) {
		return `${days}d ${hours}h`
	}
	if (hours > 0) {
		return `${hours}h ${minutes}m`
	}
	return `${minutes}m`
}

function formatTable(records: CostHistoryRecord[], sessionRecords: SessionCostRecord[]): string {
	if (records.length === 0) {
		return "No cost history recorded for this repo yet."
	}
	const lines: string[] = []
	lines.push(
		`${"GROUP".padEnd(10)}${"ISSUES".padEnd(16)}${"STATUS".padEnd(14)}${"COST".padEnd(10)}${"ITER".padEnd(6)}${"TIME".padEnd(8)}CONT/REWORK · RECORDED`,
	)
	let totalCost = 0
	let totalWallClockMs = 0
	for (const r of records) {
		totalCost += r.costUsd
		totalWallClockMs += r.wallClockMs ?? 0
		lines.push(
			`${r.groupName.padEnd(10)}${r.issues.map((n) => `#${n}`).join(",").padEnd(16)}${r.status.padEnd(14)}` +
				`$${r.costUsd.toFixed(4)}`.padEnd(10) +
				`${String(r.iterations).padEnd(6)}${formatDuration(r.wallClockMs).padEnd(8)}${r.continuationCount}/${r.reworkCount} · ${r.recordedAt}`,
		)
	}
	lines.push("")
	lines.push(
		`${records.length} record(s), total: $${totalCost.toFixed(4)}, total wall-clock (planning-to-completion): ${formatDuration(totalWallClockMs)}`,
	)

	// Wasted-spend summary, from the per-session breakdown: any session
	// whose outcome was NOT "success" (errored, hit budget, or was killed
	// before finishing) is spend that produced no useful outcome on its
	// own — surfaced here so it's never silently invisible inside a
	// group's combined total. Use --sessions to see which sessions.
	const wasted = sessionRecords.filter((r) => r.status !== "success")
	if (wasted.length > 0) {
		const wastedCost = wasted.reduce((sum, r) => sum + r.costUsd, 0)
		lines.push(
			`${wasted.length} wasted session(s) (error/budget/killed): $${wastedCost.toFixed(4)} — see --sessions for detail`,
		)
	}
	return lines.join("\n")
}

function formatSessionTable(records: SessionCostRecord[]): string {
	if (records.length === 0) {
		return "No session cost history recorded for this repo yet."
	}
	const lines: string[] = []
	lines.push(
		`${"GROUP".padEnd(10)}${"MODE".padEnd(18)}${"STATUS".padEnd(10)}${"COST".padEnd(10)}${"ITER".padEnd(6)}SESSION · RECORDED`,
	)
	let totalCost = 0
	let wastedCost = 0
	for (const r of records) {
		totalCost += r.costUsd
		if (r.status !== "success") {
			wastedCost += r.costUsd
		}
		lines.push(
			`${r.groupName.padEnd(10)}${r.mode.padEnd(18)}${r.status.padEnd(10)}` +
				`$${r.costUsd.toFixed(4)}`.padEnd(10) +
				`${String(r.iterations).padEnd(6)}${r.sessionId} · ${r.recordedAt}`,
		)
	}
	lines.push("")
	lines.push(`${records.length} session(s), total: $${totalCost.toFixed(4)}, wasted (non-success): $${wastedCost.toFixed(4)}`)
	return lines.join("\n")
}

function formatShapeTable(stats: ReturnType<typeof aggregateByShape>, recordCount: number): string {
	if (recordCount === 0) {
		return "No cost history recorded for this repo yet."
	}
	if (stats.length === 0) {
		return (
			`${recordCount} record(s) on file, but none carry shapes — shapes are recorded for groups dispatched from now on (issue #16); ` +
			`use --json to see the raw records.`
		)
	}
	const lines: string[] = []
	lines.push(
		`${"SHAPE".padEnd(10)}${"N".padEnd(4)}${"COST MED".padEnd(12)}${"COST/ISSUE MED".padEnd(16)}${"ITER MED".padEnd(10)}CONT/REWORK`,
	)
	for (const s of stats) {
		lines.push(
			`${s.shape.padEnd(10)}${String(s.samples).padEnd(4)}` +
				`${`$${s.costMedianUsd.toFixed(4)}`.padEnd(12)}` +
				`${`$${s.costPerIssueMedianUsd.toFixed(4)}`.padEnd(16)}` +
				`${String(s.iterationsMedian).padEnd(10)}${s.continuationRate.toFixed(1)} / ${s.reworkRate.toFixed(1)}`,
		)
	}
	lines.push("")
	lines.push(
		`Median group cost by shape (per-issue normalized where a group spans multiple issues); continuation/rework = mean cycles per group.`,
	)
	return lines.join("\n")
}

export async function costHistoryCliMain(argv: string[]): Promise<number> {
	const parsed = parseCostHistoryArgs(argv)
	if ("help" in parsed) {
		process.stdout.write(COST_HISTORY_USAGE)
		return 0
	}
	if ("error" in parsed) {
		process.stderr.write(`cost-history: ${parsed.error}\n\n${COST_HISTORY_USAGE}`)
		return 2
	}

	let records = await readCostHistory(parsed.repo)
	let sessionRecords = await readSessionCostHistory(parsed.repo)
	if (parsed.issues.length > 0) {
		const wanted = new Set(parsed.issues)
		records = records.filter((r) => r.issues.some((n) => wanted.has(n)))
		sessionRecords = sessionRecords.filter((r) => r.issues.some((n) => wanted.has(n)))
	}

	if (parsed.byShape) {
		const stats = aggregateByShape(records)
		if (parsed.json) {
			process.stdout.write(JSON.stringify(stats, null, 2) + "\n")
		} else {
			process.stdout.write(formatShapeTable(stats, records.length) + "\n")
		}
		return 0
	}

	if (parsed.sessions) {
		if (parsed.json) {
			process.stdout.write(JSON.stringify(sessionRecords, null, 2) + "\n")
		} else {
			process.stdout.write(formatSessionTable(sessionRecords) + "\n")
		}
		return 0
	}

	if (parsed.json) {
		process.stdout.write(JSON.stringify(records, null, 2) + "\n")
	} else {
		process.stdout.write(formatTable(records, sessionRecords) + "\n")
	}
	return 0
}
