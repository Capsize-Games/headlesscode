/**
 * `headlesscode trend` subcommand — a local, auto-refreshing, multi-repo
 * cost-efficiency trend page. Thin dispatch to src/dashboard/trend.ts, same
 * shape as dashboard/cli.ts.
 *
 *   npx tsx src/cli.ts trend --repo <a> [--repo <b> ...] [--port 4460]
 */

import { startTrendServer } from "./trend.js"

const TREND_USAGE = `headlesscode trend — local, live-updating, multi-repo cost-efficiency trend

Usage:
  headlesscode trend --repo <path> [--repo <path> ...] [--port 4460]

Options:
  --repo <path>  Repo to include (repeatable). At least one required. Reads
                 that repo's central-store cost-history.jsonl /
                 session-cost-history.jsonl LIVE on every page load — no
                 separate build/index step, nothing to keep in sync.
  --port <n>     Port to listen on (default: 4460, or $HEADLESSCODE_TREND_PORT)
  --help         Show this help and exit

Binds to 127.0.0.1 only, read-only, no auth — matches the dashboard's
local-only contract.
`

interface TrendCliOptions {
	repos: string[]
	port: number
	help: boolean
}

export function parseTrendArgs(argv: string[]): { options: TrendCliOptions; error?: string } {
	const options: TrendCliOptions = {
		repos: [],
		port: Number(process.env.HEADLESSCODE_TREND_PORT ?? 4460),
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
			case "--repo": {
				const v = next()
				if (v === undefined) {
					return { options, error: "Missing value for --repo" }
				}
				options.repos.push(v)
				break
			}
			case "--port": {
				const v = next()
				const n = v === undefined ? Number.NaN : Number(v)
				if (!Number.isInteger(n) || n <= 0 || n > 65535) {
					return { options, error: "--port requires an integer between 1 and 65535" }
				}
				options.port = n
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

export async function trendMain(argv: string[]): Promise<number> {
	const { options, error } = parseTrendArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode trend: ${error}\n\n${TREND_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(TREND_USAGE)
		return 0
	}
	if (options.repos.length === 0) {
		process.stderr.write(`headlesscode trend: at least one --repo is required\n\n${TREND_USAGE}`)
		return 2
	}

	let server: Awaited<ReturnType<typeof startTrendServer>>
	try {
		server = await startTrendServer({ port: options.port, repos: options.repos })
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
			process.stderr.write(`headlesscode trend: port ${options.port} is already in use. Pick another with --port <n>.\n`)
			return 2
		}
		process.stderr.write(`headlesscode trend: failed to start: ${message}\n`)
		return 2
	}

	process.stdout.write(`[trend] listening on http://127.0.0.1:${options.port} (repos: ${options.repos.join(", ")})\n`)

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
			process.stdout.write("\n[trend] shutting down\n")
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
