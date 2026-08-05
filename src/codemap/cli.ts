/**
 * `headlesscode codemap` subcommand — build/refresh a project's deterministic
 * module/import map (issue #17).
 *
 *   npx tsx src/cli.ts codemap --workspace <path> [--force] [--watch] [--interval-ms <n>]
 *
 * Generates codemap.json / codemap.lock / codemap.html into the CENTRAL
 * per-project data store (~/.local/share/headlesscode/projects/<key>/codemap/ —
 * same resolution as the codesearch index; worktrees of a repo share it).
 * Regeneration is fingerprint-aware: an unchanged repo produces NO writes.
 *
 * `--watch` turns the command into a long-running poll loop (regenerate on
 * change, sleep, repeat) — the watcher mode a systemd timer or cron job can
 * also drive with one-shot invocations instead; see docs/codemap.md.
 */

import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { buildCodemap } from "./build.js"
import { codemapJsonPath } from "./lock.js"

const CODEMAP_USAGE = `headlesscode codemap — build/refresh a project's deterministic codemap

Usage:
  headlesscode codemap --workspace <path> [--force] [--watch] [--interval-ms <n>]

Options:
  --workspace <path>  Workspace root to map (required)
  --force             Regenerate even when the fingerprint lock says nothing changed
  --watch             Watch mode: poll for changes and regenerate, forever
                      (Ctrl-C to stop). One-shot runs are what a cron job /
                      systemd timer should invoke instead.
  --interval-ms <n>   Watch-mode poll interval in ms (default: 60000)
  --help              Show this help and exit

The map is written to the CENTRAL per-project store:
  ~/.local/share/headlesscode/projects/<project-key>/codemap/
    codemap.json   machine-readable module/edge graph (dashboard-served)
    codemap.lock   per-module content fingerprints (change detection)
    codemap.html   self-contained interactive visualizer (open in a browser)

No LLM is involved anywhere in the pipeline — the map is generated
deterministically from the repo's source files.
`

interface CodemapCliOptions {
	workspace?: string
	force: boolean
	watch: boolean
	intervalMs: number
	help: boolean
}

export function parseCodemapArgs(argv: string[]): { options: CodemapCliOptions; error?: string } {
	const options: CodemapCliOptions = { force: false, watch: false, intervalMs: 60_000, help: false }
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
			case "--workspace": {
				const value = next()
				if (value === undefined) {
					return { options, error: "Missing value for --workspace" }
				}
				options.workspace = value
				break
			}
			case "--interval-ms": {
				const value = next()
				const n = value === undefined ? Number.NaN : Number(value)
				if (!Number.isInteger(n) || n <= 0) {
					return { options, error: "--interval-ms requires a positive integer" }
				}
				options.intervalMs = n
				break
			}
			case "--force":
				options.force = true
				break
			case "--watch":
				options.watch = true
				break
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

// `--force` always regenerates (buildCodemap skips the lock check), so only
// two outcomes exist: a real (re)generation, or an unchanged short-circuit.
function report(result: Awaited<ReturnType<typeof buildCodemap>>): void {
	if (result.changed) {
		process.stdout.write(
			`codemap: regenerated ${result.modules.length} modules, ${result.edges.length} edges` +
				` (fp ${result.fingerprint.slice(0, 12)})\n` +
				`  ${result.jsonPath}\n` +
				`  ${result.htmlPath}\n`,
		)
		return
	}
	process.stdout.write(
		`codemap: unchanged — no writes (${result.modules.length} modules, ${result.edges.length} edges cached, ` +
			`fp ${result.fingerprint.slice(0, 12)})\n`,
	)
}

export async function codemapMain(argv: string[]): Promise<number> {
	const { options, error } = parseCodemapArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode codemap: ${error}\n\n${CODEMAP_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(CODEMAP_USAGE)
		return 0
	}
	if (!options.workspace) {
		process.stderr.write(`headlesscode codemap: --workspace <path> is required\n\n${CODEMAP_USAGE}`)
		return 2
	}

	const workspaceRoot = path.resolve(options.workspace)

	const runOnce = async (): Promise<void> => {
		const result = await buildCodemap({ workspaceRoot, force: options.force })
		report(result)
	}

	if (!options.watch) {
		try {
			await runOnce()
			return 0
		} catch (err) {
			process.stderr.write(`headlesscode codemap: ${err instanceof Error ? err.message : String(err)}\n`)
			return 1
		}
	}

	// Watch mode: clean shutdown on SIGINT/SIGTERM (same idiom as watchMain —
	// see src/watcher/cli.ts).
	const controller = new AbortController()
	const onSignal = (): void => controller.abort()
	process.on("SIGINT", onSignal)
	process.on("SIGTERM", onSignal)

	process.stdout.write(`codemap: watching ${workspaceRoot} every ${options.intervalMs}ms (Ctrl-C to stop)\n`)
	try {
		for (;;) {
			if (controller.signal.aborted) {
				break
			}
			try {
				await runOnce()
			} catch (err) {
				process.stderr.write(`headlesscode codemap: ${err instanceof Error ? err.message : String(err)}\n`)
			}
			await Promise.race([
				sleep(options.intervalMs),
				new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true })),
			])
		}
	} finally {
		process.off("SIGINT", onSignal)
		process.off("SIGTERM", onSignal)
	}
	process.stdout.write(`codemap: stopped\n`)
	return 0
}

/** Convenience for tests/scripts: absolute path of the stored codemap.json. */
export { codemapJsonPath }
