/**
 * `headlesscode analyze-worktree` subcommand — ad-hoc, standalone entry
 * point for src/orchestrator/log-analysis.ts. The orchestrator already
 * runs this automatically once each group reaches "done" (see cli.ts's
 * onGroupUpdate); this subcommand exists for pointing it at ANY worktree
 * by hand — a stalled group mid-round, a worktree from a round that
 * predates this feature, or just re-reading a report without waiting for
 * the next orchestrate poll.
 *
 *   headlesscode analyze-worktree --worktree <path> [--json]
 *                                 [--stall-minutes <n>] [--repeat-threshold <n>]
 */

import { analyzeWorktreeSessions, formatAnalysisReport } from "./log-analysis.js"

const ANALYZE_USAGE = `headlesscode analyze-worktree — deterministic session log analysis

Usage:
  headlesscode analyze-worktree --worktree <path> [options]

Options:
  --worktree <path>        Worktree root to analyze (required) — the dir
                            containing .headlesscode/events/*.jsonl
  --json                   Print the raw SessionLogAnalysis as JSON instead
                            of the human-readable report
  --stall-minutes <n>      Gap between events considered a stall (default 15)
  --repeat-threshold <n>   Min verbatim repeats to flag a command (default 3)
  --help                   Show this help and exit
`

interface AnalyzeCliOptions {
	worktree: string
	json: boolean
	stallMinutes?: number
	repeatThreshold?: number
}

export function parseAnalyzeArgs(argv: string[]): AnalyzeCliOptions | { help: true } | { error: string } {
	let worktree: string | undefined
	let json = false
	let stallMinutes: number | undefined
	let repeatThreshold: number | undefined

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--help" || arg === "-h") {
			return { help: true }
		} else if (arg === "--worktree") {
			worktree = argv[++i]
		} else if (arg === "--json") {
			json = true
		} else if (arg === "--stall-minutes") {
			const raw = argv[++i]
			const n = Number(raw)
			if (!raw || Number.isNaN(n) || n <= 0) {
				return { error: `--stall-minutes must be a positive number, got: ${raw}` }
			}
			stallMinutes = n
		} else if (arg === "--repeat-threshold") {
			const raw = argv[++i]
			const n = Number(raw)
			if (!raw || Number.isNaN(n) || n <= 0) {
				return { error: `--repeat-threshold must be a positive number, got: ${raw}` }
			}
			repeatThreshold = n
		} else {
			return { error: `unknown argument: ${arg}` }
		}
	}

	if (!worktree) {
		return { error: "--worktree is required" }
	}
	return { worktree, json, stallMinutes, repeatThreshold }
}

export async function analyzeCliMain(argv: string[]): Promise<number> {
	const parsed = parseAnalyzeArgs(argv)
	if ("help" in parsed) {
		process.stdout.write(ANALYZE_USAGE)
		return 0
	}
	if ("error" in parsed) {
		process.stderr.write(`analyze-worktree: ${parsed.error}\n\n${ANALYZE_USAGE}`)
		return 2
	}

	const analysis = await analyzeWorktreeSessions(parsed.worktree, {
		stallThresholdMs: parsed.stallMinutes !== undefined ? parsed.stallMinutes * 60 * 1000 : undefined,
		repeatThreshold: parsed.repeatThreshold,
	})

	if (!analysis) {
		process.stderr.write(`analyze-worktree: no .headlesscode/events feed found under ${parsed.worktree}\n`)
		return 1
	}

	if (parsed.json) {
		process.stdout.write(JSON.stringify(analysis, null, 2) + "\n")
	} else {
		process.stdout.write(formatAnalysisReport(analysis) + "\n")
	}
	return 0
}
