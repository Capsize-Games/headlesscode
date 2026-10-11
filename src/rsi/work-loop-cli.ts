import { readFile, realpath } from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { runWorkLoop, type WorkLoopConfig, type WorkLoopDriver } from "./work-loop.js"
import type { RsiCliIO } from "../rsi-cli-contract.js"

const HELP = `headlesscode work-loop --config <json> --driver <module>

Run a bounded project queue with independently verified harness repairs.
The config contains tasks, a pinned harness, an absolute ledgerPath, and limits.
The driver is trusted host code exporting createWorkLoopDriver(config).
Keep both files outside worker-accessible repositories and sandbox mounts.
Drivers must enforce inference limits, settle billing, independently evaluate
patches, and activate immutable harness runtimes between worker sessions.
SIGINT/SIGTERM cancel the active phase through its AbortSignal.
`

export async function workLoopMain(argv: string[], io: RsiCliIO = { stdout: process.stdout, stderr: process.stderr }): Promise<number> {
	if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) { io.stdout.write(HELP); return 0 }
	let configPath: string | undefined
	let driverPath: string | undefined
	for (let index = 0; index < argv.length; index += 2) {
		const value = argv[index + 1]
		if (!value || value.startsWith("--") || !["--config", "--driver"].includes(argv[index]!)) { io.stderr.write(HELP); return 2 }
		if (argv[index] === "--config") { if (configPath) return 2; configPath = path.resolve(value) }
		else { if (driverPath) return 2; driverPath = path.resolve(value) }
	}
	if (!configPath || !driverPath) { io.stderr.write(HELP); return 2 }
	const abort = new AbortController()
	const stop = () => abort.abort(new Error("operator stopped work loop"))
	process.once("SIGINT", stop)
	process.once("SIGTERM", stop)
	try {
		const config = JSON.parse(await readFile(configPath, "utf8")) as WorkLoopConfig
		const module = await import(pathToFileURL(await realpath(driverPath)).href) as { createWorkLoopDriver?: (config: WorkLoopConfig) => WorkLoopDriver | Promise<WorkLoopDriver> }
		if (typeof module.createWorkLoopDriver !== "function") throw new Error("driver must export createWorkLoopDriver(config)")
		const driver = await module.createWorkLoopDriver(config)
		const summary = await runWorkLoop(config, driver, abort.signal)
		io.stdout.write(JSON.stringify(summary) + "\n")
		return summary.reason === "queue-complete" ? 0 : summary.reason === "cancelled" ? 130 : 1
	} catch (error) {
		io.stderr.write(`headlesscode work-loop: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	} finally {
		process.removeListener("SIGINT", stop)
		process.removeListener("SIGTERM", stop)
	}
}
