/**
 * `headlesscode watch` subcommand — Phase 5 GitHub issue watcher.
 *
 *   npx tsx src/cli.ts watch --owner <o> --repo <local-clone-path> --label <target-label> \
 *       [--gh-repo <name>] [--poll-interval-ms <n>] [--run-once] [--max-per-sweep <n>] \
 *       [--state-file <path>] [--mode <slug>] [--qa] [--deploy] [--memory-dir <path>] \
 *       [--dry-run] [--retry-failed]
 *
 * Thin dispatch to src/watcher/watch.ts — no logic duplicated here. The
 * GitHub repo name defaults to the basename of `--repo` (the local clone),
 * which is the common case; override with `--gh-repo` when the directory
 * name differs.
 *
 * `--dry-run` sweeps + reports what would be spawned (list issues + split
 * plan per issue) WITHOUT spawning or writing state. It still needs a GitHub
 * token for listIssues — a missing token is a clear error.
 *
 * `--run-once` performs one sweep and exits 0 (or 1 if any spawn failed) —
 * the cron/CI-friendly form. Continuous mode (default) logs each sweep and
 * runs until SIGINT/SIGTERM (clean shutdown via AbortSignal; state saved).
 *
 * Pass-through (recorded per batch / forwarded to the spawner): --mode and
 * --memory-dir reach the spawner env (ORCHESTRATOR_MODE /
 * HEADLESSCODE_MEMORY_DIR); --qa and --deploy are stored on the batch's
 * state entry for the follow-up `orchestrate` completion run (see
 * docs/phase5-issue-watcher.md — the watcher itself only spawns; completion
 * watching / review / QA / deploy stays the orchestrator's job).
 */

import { execFileSync } from "node:child_process"
import * as path from "node:path"

import { Logger } from "../engine/logger.js"
import { watchIssues, type SweepResult } from "./watch.js"

const WATCH_USAGE = `headlesscode watch — Phase 5 GitHub issue watcher

Usage:
  headlesscode watch --owner <o> --repo <path> --label <target-label> [options]

Options:
  --owner <o>            GitHub owner (required)
  --repo <path>          Local clone of the target repo (required; worktrees
                         are spawned under <path>/.worktrees/). The GitHub
                         repo name defaults to the directory basename.
  --gh-repo <name>       GitHub repo name override (default: basename of --repo)
  --label <name>         The label that triggers processing, e.g. needs-agent
  --poll-interval-ms <n> Sweep interval in continuous mode (default: 60000)
  --run-once             One sweep then exit 0 (or 1 if any spawn failed);
                         the cron/CI form of the watcher
  --max-per-sweep <n>    Max NEW issues spawned per sweep (default: 5); the
                         rest stay in state as 'pending' and are picked up
                         next sweep (bounds label storms)
  --max-concurrent-sessions <n>  Phase 6 GLOBAL cap on concurrent sessions
                         across processes (default: $HEADLESSCODE_MAX_
                         CONCURRENT_SESSIONS or 3). Interplay: maxPerSweep
                         bounds one sweep's burst; this bounds the total
                         running/spawned fleet — issues beyond it stay
                         'pending' until slots free up
  --state-file <path>    Durable idempotency state (default:
                         <repo>/.worktrees/.watcher-state.json)
  --mode <slug>          Harness mode for workers (default: code; forwarded
                         to the spawner as ORCHESTRATOR_MODE)
  --qa                   Pass-through: record that a QA round should follow
                         each batch (see docs/phase5-issue-watcher.md)
  --deploy               Pass-through: record that a deploy gate should follow
                         each batch (see docs/phase5-issue-watcher.md)
  --memory-dir <path>    Memory dir for workers (forwarded to the spawner as
                         HEADLESSCODE_MEMORY_DIR)
  --dry-run              Sweep + print the spawn plan per new issue, spawn
                         nothing, write no state (still needs a GH token)
  --retry-failed         Retry previously-failed spawns on the next sweep
                         (default: failed entries are NOT auto-retried)
  --help                 Show this help and exit

Environment:
  GH_TOKEN               GitHub token (or GITHUB_TOKEN) — required; never logged
  GITHUB_API_BASE_URL    API base URL override (tests/mocks)
  HEADLESSCODE_SPAWN_SCRIPT  Override the spawner script path (e2e stubbing)
  HEADLESSCODE_MAX_CONCURRENT_SESSIONS  Global concurrency cap (default 3)
`

export interface WatchCliOptions {
	owner: string
	repo: string
	ghRepo?: string
	label: string
	pollIntervalMs: number
	runOnce: boolean
	maxPerSweep: number
	/** Phase 6: global concurrent-session cap (default env or 3). */
	maxConcurrentSessions: number
	stateFile?: string
	mode: string
	qa: boolean
	deploy: boolean
	memoryDir?: string
	dryRun: boolean
	retryFailed: boolean
	help: boolean
}

export function parseWatchArgs(argv: string[]): { options: WatchCliOptions; error?: string } {
	const options: WatchCliOptions = {
		owner: "",
		repo: "",
		label: "",
		pollIntervalMs: 60_000,
		runOnce: false,
		maxPerSweep: 5,
		maxConcurrentSessions: 3,
		mode: "code",
		qa: false,
		deploy: false,
		dryRun: false,
		retryFailed: false,
		help: false,
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const eq = arg.indexOf("=")
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				return inlineValue
			}
			const v = argv[i + 1]
			if (v === undefined || v.startsWith("--")) {
				return undefined
			}
			i++
			return v
		}

		switch (flag) {
			case "--owner": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --owner" }
				}
				options.owner = v
				break
			}
			case "--repo": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --repo" }
				}
				options.repo = v
				break
			}
			case "--gh-repo": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --gh-repo" }
				}
				options.ghRepo = v
				break
			}
			case "--label": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --label" }
				}
				options.label = v
				break
			}
			case "--poll-interval-ms": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--poll-interval-ms requires a positive integer" }
				}
				options.pollIntervalMs = n
				break
			}
			case "--max-per-sweep": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--max-per-sweep requires a positive integer" }
				}
				options.maxPerSweep = n
				break
			}
			case "--max-concurrent-sessions": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--max-concurrent-sessions requires a positive integer" }
				}
				options.maxConcurrentSessions = n
				break
			}
			case "--state-file": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --state-file" }
				}
				options.stateFile = v
				break
			}
			case "--mode": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --mode" }
				}
				options.mode = v
				break
			}
			case "--memory-dir": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --memory-dir" }
				}
				options.memoryDir = v
				break
			}
			case "--run-once":
				options.runOnce = true
				break
			case "--qa":
				options.qa = true
				break
			case "--deploy":
				options.deploy = true
				break
			case "--dry-run":
				options.dryRun = true
				break
			case "--retry-failed":
				options.retryFailed = true
				break
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown watch argument: ${arg}` }
		}
	}

	return { options }
}

/** Print the dry-run spawn plan for the sweeps that were simulated. */
function printDryRunPlan(sweeps: SweepResult[]): void {
	process.stdout.write("── Watch plan (dry run) ────────────────────────────────────\n")
	for (const sweep of sweeps) {
		for (const plan of sweep.dryRunPlan ?? []) {
			const { issue, specs } = plan
			process.stdout.write(`  issue #${issue.number}: ${issue.title}\n`)
			for (const spec of specs) {
				process.stdout.write(
					`    -> ${spec.name} issues [${spec.issues.join(", ")}] plans/parallel-tasks/${spec.taskFile}\n`,
				)
			}
		}
		if ((sweep.dryRunPlan ?? []).length === 0) {
			process.stdout.write("  (no new issues to spawn)\n")
		}
	}
}

export async function watchMain(argv: string[]): Promise<number> {
	const { options, error } = parseWatchArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode watch: ${error}\n\n${WATCH_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(WATCH_USAGE)
		return 0
	}
	if (!options.owner || !options.repo || !options.label) {
		process.stderr.write(
			`headlesscode watch: --owner <o>, --repo <path> and --label <name> are required\n\n${WATCH_USAGE}`,
		)
		return 2
	}

	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
	if (!token) {
		process.stderr.write(
			"headlesscode watch: no GitHub token. Set GH_TOKEN (or GITHUB_TOKEN) — the watcher\n" +
				"  needs it for listIssues, even with --dry-run. The token is never logged.\n",
		)
		return 2
	}

	const repoRoot = path.resolve(options.repo)
	// Dry-run never touches the repo, so git validation only applies to real runs.
	if (!options.dryRun) {
		try {
			execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-dir"], { stdio: "ignore", timeout: 5000 })
		} catch {
			process.stderr.write(`headlesscode watch: not a git repo: ${repoRoot}\n`)
			return 2
		}
	}

	const ghRepo = options.ghRepo ?? path.basename(repoRoot)
	const logger = new Logger({ level: "info" })

	// Continuous mode: clean shutdown on SIGINT/SIGTERM (state saved by
	// watchIssues before returning).
	const controller = new AbortController()
	const onSignal = (): void => controller.abort()
	process.on("SIGINT", onSignal)
	process.on("SIGTERM", onSignal)

	let result
	try {
		result = await watchIssues({
			owner: options.owner,
			repo: ghRepo,
			targetLabel: options.label,
			token,
			ghBaseUrl: process.env.GITHUB_API_BASE_URL,
			stateFile: options.stateFile,
			repoRoot,
			pollIntervalMs: options.pollIntervalMs,
			runOnce: options.runOnce,
			maxPerSweep: options.maxPerSweep,
			maxConcurrentSessions: options.maxConcurrentSessions,
			retryFailed: options.retryFailed,
			dryRun: options.dryRun,
			mode: options.mode,
			memoryDir: options.memoryDir,
			qa: options.qa,
			deploy: options.deploy,
			logger,
			signal: controller.signal,
		})
	} finally {
		process.off("SIGINT", onSignal)
		process.off("SIGTERM", onSignal)
	}

	for (const sweep of result.sweeps) {
		if (sweep.error) {
			process.stderr.write(`[watch] ${sweep.error}\n`)
		}
	}
	if (options.dryRun) {
		printDryRunPlan(result.sweeps)
	} else {
		for (const sweep of result.sweeps) {
			process.stdout.write(
				`[watch] sweep: ${sweep.issuesFound} found, ${sweep.newIssues} new, ${sweep.skipped} skipped, ` +
					`${sweep.spawned} spawned, ${sweep.deferred} deferred, ${sweep.failures} failed\n`,
			)
		}
	}

	if (options.dryRun) {
		return 0
	}
	if (result.exitCode !== 0) {
		process.stderr.write(
			`headlesscode watch: ${result.spawned} batch(es) spawned, but one or more sweeps reported errors\n`,
		)
		return 1
	}
	process.stdout.write(`[watch] done: ${result.spawned} batch(es) spawned\n`)
	return 0
}
