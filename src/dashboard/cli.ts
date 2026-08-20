/**
 * `headlesscode dashboard` subcommand — a local, auto-refreshing cost/token
 * dashboard (workstream 3) + live per-session event feed + pause/resume
 * control (live worker monitoring).
 *
 *   npx tsx src/cli.ts dashboard [--port 4390] [--repo <path>]
 *
 * Thin dispatch to src/dashboard/server.ts — no logic duplicated here. When
 * `--repo` is omitted the page still starts but shows no sessions/round data
 * (the aggregation gracefully degrades — see src/dashboard/aggregate.ts).
 *
 * NOTE (Phase 3 scope change): the dashboard is no longer purely read-only —
 * the page's pause/resume buttons issue state-changing POSTs to the running
 * worker (see src/dashboard/server.ts's header note). Still local-only +
 * no-auth (binds 127.0.0.1), but that assumption needs revisiting if this is
 * ever exposed beyond localhost.
 */

import { DEFAULT_DASHBOARD_PORT, startDashboardServer } from "./server.js"

const DASHBOARD_USAGE = `headlesscode dashboard — local cost/token dashboard + live worker control

Usage:
  headlesscode dashboard [--port 4390] [--repo <path>]

Options:
  --port <n>     Port to listen on (default: 4390, or $HEADLESSCODE_DASHBOARD_PORT)
  --repo <path>  Repo root to scan for .headlesscode/usage/*.jsonl (own +
                 .worktrees/*) and .worktrees/.orchestrator-state.json.
                 Omit to start the page with no data (still useful to confirm
                 the server runs).
  --help         Show this help and exit

Environment:
  HEADLESSCODE_DASHBOARD_TOKEN  Optional bearer token for the control-plane
                 POST routes (/api/session/start|pause|resume|answer) and
                 the destructive /api/checkpoints/restore. Unset (default) =
                 no auth. Local-only tool; see the notes below.
  HEADLESSCODE_DASHBOARD_SESSION_CLI      Override the CLI invocation
                 POST /api/session/start spawns (default: "npx tsx
                 src/cli.ts", resolved from HEADLESSCODE_DASHBOARD_SESSION_REPO_ROOT).
                 Not a CLI flag deliberately (DashboardServerOptions.cli is a
                 test-only injection point) — this exists for container
                 deployments where the dashboard runs from a live bind-mounted
                 source tree but "npx tsx" has no node_modules there to
                 resolve against (see docker-compose.headlesscode-local.yml).
  HEADLESSCODE_DASHBOARD_SESSION_REPO_ROOT  Override the directory a launched
                 session's CLI runs in (default: process.cwd()). Same
                 container rationale as above — the dashboard's own cwd may
                 be a baked image copy while the live source lives elsewhere.
  HEADLESSCODE_DASHBOARD_WORKTREE_ROOT    Root directory for POST
                 /api/projects/ensure-worktree's disposable per-project
                 worktrees. Unset (default) = that endpoint responds 501.
  HEADLESSCODE_DASHBOARD_WORKTREE_OWNER   chown target (e.g. "1000:1000")
                 for a newly-created worktree and the ref/admin files
                 'git worktree add' writes into the source repo's own
                 .git — read directly by session-launch.ts, not a
                 startDashboardServer option. Only matters when this
                 process runs as root (a container's usual default);
                 unset (default) = skip, leaving those files owned by
                 whoever ran the dashboard.

Notes:
  Binds to 127.0.0.1 only — no auth unless HEADLESSCODE_DASHBOARD_TOKEN is
  set. Never expose this port beyond localhost.
  IMPORTANT (browser control plane): the "start a session" endpoint spawns
  the CLI as a detached child that INHERITS this process's environment — it
  does NOT re-source .env. Export HEADLESSCODE_OPENROUTER_API_KEY (e.g. 'set -a; source
  .env; set +a') before starting the dashboard, or launched sessions will
  fail immediately with an OpenRouter auth error.
`

interface DashboardCliOptions {
	port: number
	repo?: string
	help: boolean
}

export function parseDashboardArgs(argv: string[]): { options: DashboardCliOptions; error?: string } {
	const options: DashboardCliOptions = {
		port: Number(process.env.HEADLESSCODE_DASHBOARD_PORT ?? DEFAULT_DASHBOARD_PORT),
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
			case "--port": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0 || n > 65535) {
					return { options, error: "--port requires an integer between 1 and 65535" }
				}
				options.port = n
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
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown argument: ${arg}` }
		}
	}

	return { options }
}

export async function dashboardMain(argv: string[]): Promise<number> {
	const { options, error } = parseDashboardArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode dashboard: ${error}\n\n${DASHBOARD_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(DASHBOARD_USAGE)
		return 0
	}

	let server: Awaited<ReturnType<typeof startDashboardServer>>
	try {
		server = await startDashboardServer({
			port: options.port,
			repo: options.repo,
			token: process.env.HEADLESSCODE_DASHBOARD_TOKEN || undefined,
			cli: process.env.HEADLESSCODE_DASHBOARD_SESSION_CLI || undefined,
			repoRoot: process.env.HEADLESSCODE_DASHBOARD_SESSION_REPO_ROOT || undefined,
			worktreeRoot: process.env.HEADLESSCODE_DASHBOARD_WORKTREE_ROOT || undefined,
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
			process.stderr.write(
				`headlesscode dashboard: port ${options.port} is already in use. Pick another with --port <n>.\n`,
			)
			return 2
		}
		process.stderr.write(`headlesscode dashboard: failed to start: ${message}\n`)
		return 2
	}

	process.stdout.write(
		`[dashboard] listening on http://127.0.0.1:${options.port}${options.repo ? ` (repo: ${options.repo})` : " (no --repo given; page will show no data)"}\n`,
	)

	// Keep the process alive until interrupted; clean shutdown on SIGINT/SIGTERM.
	return new Promise<number>((resolve) => {
		let shuttingDown = false
		const onSignal = (): void => {
			// Only the first signal shuts down; a second Ctrl-C while the
			// server is mid-close is ignored (the process exits on its own
			// once the listening handle is gone).
			if (shuttingDown) {
				return
			}
			shuttingDown = true
			process.stdout.write("\n[dashboard] shutting down\n")
			process.removeListener("SIGINT", onSignal)
			process.removeListener("SIGTERM", onSignal)
			// Release the port: stop accepting new connections and drop
			// keep-alive sockets so the process can exit. Without close the
			// listening handle keeps the event loop alive and the port bound.
			server.close()
			server.closeAllConnections?.()
			resolve(0)
		}
		process.on("SIGINT", onSignal)
		process.on("SIGTERM", onSignal)
	})
}
