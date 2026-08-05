/**
 * `headlesscode cost-history` subcommand — read-side for cost-history.ts's
 * central `cost-history.jsonl`. Recording is automatic and mandatory (see
 * watch.ts's `recordCostIfTerminal`); this is just for looking at what's
 * been recorded — filterable by issue number, printed as a human-readable
 * table or raw JSON. Building actual cost ESTIMATES from this history is
 * explicit future work, not this command.
 *
 *   headlesscode cost-history --repo <path> [--issue <n>] [--json]
 */

import { readCostHistory, type CostHistoryRecord } from "./cost-history.js"

const COST_HISTORY_USAGE = `headlesscode cost-history — read recorded cost/token history for a repo

Usage:
  headlesscode cost-history --repo <path> [options]

Options:
  --repo <path>     Target repo root (required)
  --issue <n>       Only show records covering this issue number (repeatable)
  --json            Print the raw records as JSON instead of a table
  --help            Show this help and exit
`

interface CostHistoryCliOptions {
	repo: string
	issues: number[]
	json: boolean
}

export function parseCostHistoryArgs(argv: string[]): CostHistoryCliOptions | { help: true } | { error: string } {
	let repo: string | undefined
	const issues: number[] = []
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
		} else if (arg === "--json") {
			json = true
		} else {
			return { error: `unknown argument: ${arg}` }
		}
	}

	if (!repo) {
		return { error: "--repo is required" }
	}
	return { repo, issues, json }
}

function formatTable(records: CostHistoryRecord[]): string {
	if (records.length === 0) {
		return "No cost history recorded for this repo yet."
	}
	const lines: string[] = []
	lines.push(
		`${"GROUP".padEnd(10)}${"ISSUES".padEnd(16)}${"STATUS".padEnd(14)}${"COST".padEnd(10)}${"ITER".padEnd(6)}CONT/REWORK · RECORDED`,
	)
	let totalCost = 0
	for (const r of records) {
		totalCost += r.costUsd
		lines.push(
			`${r.groupName.padEnd(10)}${r.issues.map((n) => `#${n}`).join(",").padEnd(16)}${r.status.padEnd(14)}` +
				`$${r.costUsd.toFixed(4)}`.padEnd(10) +
				`${String(r.iterations).padEnd(6)}${r.continuationCount}/${r.reworkCount} · ${r.recordedAt}`,
		)
	}
	lines.push("")
	lines.push(`${records.length} record(s), total: $${totalCost.toFixed(4)}`)
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
	if (parsed.issues.length > 0) {
		const wanted = new Set(parsed.issues)
		records = records.filter((r) => r.issues.some((n) => wanted.has(n)))
	}

	if (parsed.json) {
		process.stdout.write(JSON.stringify(records, null, 2) + "\n")
	} else {
		process.stdout.write(formatTable(records) + "\n")
	}
	return 0
}
