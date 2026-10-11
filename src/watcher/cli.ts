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
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { Logger } from "../engine/logger.js"
import { isMuseModelIdentifier, museUnsupportedSettingsReason, type AgentExecutor } from "../agent-executor.js"
import { watchIssues, type SweepResult } from "./watch.js"
import { openshellPreflight } from "../cloud/openshell-preflight.js"
import { resolveContainedRuntimeProfile, resolveSecurityProfile, serializeResolvedContainedProfile, type SecurityProfileName } from "../security/profile.js"
import { validateContainedSupervisorRoots } from "../security/supervisor.js"

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
  --poll-interval-ms <n> Sweep interval in continuous mode (default: 60000);
                         runner-pool mode requires at most half the claim lease
  --run-once             One sweep then exit 0 (or 1 if any spawn failed);
                         the cron/CI form of the watcher
  --max-per-sweep <n>    Max NEW issues spawned per sweep (default: 5); the
                         rest stay in state as 'pending' and are picked up
                         next sweep (bounds label storms)
  --max-concurrent-sessions <n>  Concurrent-session cap (default: $HEADLESSCODE_MAX_
                         CONCURRENT_SESSIONS or 3); in runner-pool mode this
                         is the per-machine cap. Interplay: maxPerSweep
                         bounds one sweep's burst; this bounds running/spawned
                         sessions on this machine — issues beyond it stay
                         'pending' until slots free up
  --runner-id <id>       Enable claim-based multi-machine dispatch. Use a
                         stable unique id per machine; requires continuous
                         mode and GitHub Contents read/write + Issues read/write.
  --runner-assignee <login>  GitHub account shown as assignee while a claim
                         is active (required with --runner-id)
  --state-file <path>    Durable idempotency state (default:
                         <repo>/.worktrees/.watcher-state.json)
  --mode <slug>          Harness mode for workers (default: code; forwarded
                         to the spawner as ORCHESTRATOR_MODE)
  --executor <builtin|muse>  Default worker implementation; issue labels may
                         select per-job with executor:builtin or executor:muse
  --muse-model <id>      Native Muse Meta model id (requires --executor muse)
  --execution-provider <local|openshell> Worker runtime (default: local)
  --security-profile <local|contained>  Trust boundary (default local: runs with host authority;
                                       contained: OpenShell only, fails closed)
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
  HEADLESSCODE_MAX_CONCURRENT_SESSIONS  Session cap (default 3; per-machine in pool mode)
  HEADLESSCODE_RUNNER_ID / HEADLESSCODE_RUNNER_ASSIGNEE
                         Enable claim-based multi-machine runner mode
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
	runnerId?: string
	runnerAssignee?: string
	stateFile?: string
	mode: string
	executionProvider: "local" | "openshell"
	executor?: AgentExecutor
	museModel?: string
	securityProfile?: SecurityProfileName
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
		...(process.env.HEADLESSCODE_RUNNER_ID ? { runnerId: process.env.HEADLESSCODE_RUNNER_ID } : {}),
		...(process.env.HEADLESSCODE_RUNNER_ASSIGNEE ? { runnerAssignee: process.env.HEADLESSCODE_RUNNER_ASSIGNEE } : {}),
		mode: "code",
		executionProvider: process.env.HEADLESSCODE_EXECUTION_PROVIDER === "openshell" ? "openshell" : "local",
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
			case "--runner-assignee": {
				const v = next()
				if (v === undefined || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(v)) return { options, error: "--runner-assignee requires a GitHub login" }
				options.runnerAssignee = v
				break
			}
			case "--runner-id": {
				const v = next()
				if (v === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)) return { options, error: "--runner-id requires a safe stable machine identifier" }
				options.runnerId = v
				break
			}
			case "--security-profile": {
				const v = next()
				try { options.securityProfile = resolveSecurityProfile(v) }
				catch (error) { return { options, error: error instanceof Error ? error.message : String(error) } }
				break
			}
			case "--execution-provider": {
				const v = next()
				if (v !== "local" && v !== "openshell") return { options, error: "--execution-provider must be local or openshell" }
				options.executionProvider = v
				break
			}
			case "--executor": {
				const v = next()
				if (v !== "builtin" && v !== "muse") return { options, error: "--executor must be builtin or muse" }
				options.executor = v
				break
			}
			case "--muse-model": {
				const v = next()
				if (v === undefined || !isMuseModelIdentifier(v)) return { options, error: "--muse-model requires a valid native Muse model identifier" }
				options.museModel = v
				break
			}
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

	if (!options.securityProfile) {
		try { options.securityProfile = resolveSecurityProfile(process.env.HEADLESSCODE_SECURITY_PROFILE) }
		catch (error) { return { options, error: error instanceof Error ? error.message : String(error) } }
	}
	if (options.runnerId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.runnerId)) return { options, error: "HEADLESSCODE_RUNNER_ID must be a safe stable machine identifier" }
	if (!!options.runnerId !== !!options.runnerAssignee) return { options, error: "--runner-id and --runner-assignee must be set together" }
	if (options.runnerId && options.runOnce && !options.dryRun) return { options, error: "claim-based runner pool requires continuous mode; --run-once cannot maintain leases" }
	if (options.securityProfile === "contained") {
		if (options.executionProvider === "local" && argv.some((arg) => arg === "--execution-provider" || arg.startsWith("--execution-provider="))) return { options, error: "contained security profile cannot use the local execution provider" }
		options.executionProvider = "openshell"
	}
	if (options.museModel && options.executor !== "muse") {
		return { options, error: "--muse-model requires --executor muse" }
	}
	if (options.executor === "muse" && (options.executionProvider !== "local" || options.mode !== "code")) {
		return { options, error: "Muse executor requires local execution and --mode code" }
	}
	if (options.executor === "muse" && options.securityProfile === "contained") {
		return { options, error: "Muse executor cannot run under the contained OpenShell security profile" }
	}
	if (options.executor === "muse") {
		const unsupported = museUnsupportedSettingsReason(options.memoryDir)
		if (unsupported) return { options, error: unsupported }
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
			if (plan.selection) {
				process.stdout.write(`    executor: ${plan.selection.executor}${plan.selection.museModel ? ` (native Muse model ${plan.selection.museModel})` : ""}\n`)
			}
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
	if (!options.dryRun && options.securityProfile === "contained") {
		try {
			const resolved = resolveContainedRuntimeProfile({ repoRoot, purpose: "worker" })
			validateContainedSupervisorRoots(resolved, repoRoot)
			process.env.HEADLESSCODE_SECURITY_PROFILE = "contained"
			process.env.HEADLESSCODE_OPENSHELL_POLICY = resolved.policySnapshotPath
			process.env.HEADLESSCODE_OPENSHELL_IMAGE = resolved.image
			process.env.HEADLESSCODE_OPENSHELL_CPU = resolved.cpu
			process.env.HEADLESSCODE_OPENSHELL_MEMORY = resolved.memory
			process.env.HEADLESSCODE_OPENSHELL_PROVIDERS = resolved.providers.join(",")
			process.env.HEADLESSCODE_CONTAINED_PROFILE_SHA256 = resolved.profileSha256
			process.env.HEADLESSCODE_CONTAINED_POLICY_SHA256 = resolved.policySha256
			process.env.HEADLESSCODE_CONTAINED_RUNTIME_PROFILE_JSON = serializeResolvedContainedProfile(resolved)
		} catch (error) {
			process.stderr.write(`headlesscode watch: contained security preflight failed: ${error instanceof Error ? error.message : String(error)}\n`)
			return 2
		}
	} else if (!options.dryRun && options.executionProvider === "openshell") {
		const issue = openshellPreflight()
		if (issue) {
			process.stderr.write(`headlesscode watch: OpenShell preflight failed: ${issue}\n`)
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
	let lockPath: string | undefined
	try {
		if (options.runnerId) {
			const stateHome = path.resolve(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"))
			lockPath = await acquireRunnerPoolLock(stateHome, options.runnerId)
		}
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
			runnerId: options.runnerId,
			runnerAssignee: options.runnerAssignee,
			retryFailed: options.retryFailed,
			dryRun: options.dryRun,
			mode: options.mode,
			executionProvider: options.executionProvider,
			executor: options.executor,
			museModel: options.museModel,
			memoryDir: options.memoryDir,
			qa: options.qa,
			deploy: options.deploy,
			logger,
			signal: controller.signal,
		})
	} catch (error) {
		process.stderr.write(`headlesscode watch: ${error instanceof Error ? error.message : String(error)}\n`)
		return 2
	} finally {
		process.off("SIGINT", onSignal)
		process.off("SIGTERM", onSignal)
		if (lockPath) await fs.rm(lockPath, { force: true })
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

/**
 * Enforce one pool watcher per local state home. Capacity is machine-scoped,
 * so locking only by runnerId would let two IDs on one host each consume the
 * full cap independently.
 */
export async function acquireRunnerPoolLock(stateHome: string, runnerId: string): Promise<string> {
	const lockDir = path.join(path.resolve(stateHome), "headlesscode")
	await fs.mkdir(lockDir, { recursive: true, mode: 0o700 })
	const lockPath = path.join(lockDir, "runner-pool.lock")
	let lock: Awaited<ReturnType<typeof fs.open>> | undefined
	try {
		lock = await fs.open(lockPath, "wx", 0o600)
		await lock.writeFile(`${JSON.stringify({ pid: process.pid, runnerId, startedAt: new Date().toISOString() })}\n`)
		await lock.close()
		return lockPath
	} catch (error) {
		await lock?.close().catch(() => undefined)
		if (lock && (error as NodeJS.ErrnoException).code !== "EEXIST") await fs.rm(lockPath, { force: true }).catch(() => undefined)
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`a runner-pool watcher already has a lock at ${lockPath}; verify its process before removing a stale lock`)
		}
		throw error
	}
}
