/**
 * `headlesscode dashboard` subcommand — a local, read-only, auto-refreshing
 * cost/token dashboard (workstream 3).
 *
 *   npx tsx src/cli.ts dashboard [--port 4390] [--repo <path>]
 *
 * Thin dispatch to src/dashboard/server.ts — no logic duplicated here. When
 * `--repo` is omitted the page still starts but shows no sessions/round data
 * (the aggregation gracefully degrades — see src/dashboard/aggregate.ts).
 */

import { DEFAULT_DASHBOARD_PORT, startDashboardServer } from "./server.js"

const DASHBOARD_USAGE = `headlesscode dashboard — local read-only cost/token dashboard

Usage:
  headlesscode dashboard [--port 4390] [--repo <path>]

Options:
  --port <n>     Port to listen on (default: 4390, or $HEADLESSCODE_DASHBOARD_PORT)
  --repo <path>  Repo root to scan for .headlesscode/usage/*.jsonl (own +
                 .worktrees/*) and .worktrees/.orchestrator-state.json.
                 Omit to start the page with no data (still useful to confirm
                 the server runs).
  --help         Show this help and exit

Notes:
  Binds to 127.0.0.1 only — no auth, local-only tool. Never expose this
  port beyond localhost.
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

	try {
		await startDashboardServer({ port: options.port, repo: options.repo })
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
		const onSignal = (): void => {
			process.stdout.write("\n[dashboard] shutting down\n")
			resolve(0)
		}
		process.on("SIGINT", onSignal)
		process.on("SIGTERM", onSignal)
	})
}
