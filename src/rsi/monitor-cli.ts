import * as os from "node:os"
import * as path from "node:path"
import { createRsiMonitorPool, readRsiOperationsStatus, runRsiMonitorProcess, validateRsiMonitorArguments, type RsiOperationsStatus } from "./operations-monitor.js"

interface MonitorIo { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } }
interface ParsedMonitorArgs {
	queueName: string
	campaignId?: string
	stateDirectory?: string
	queryTimeoutMs: number
	pollMs: number
	stallMs: number
	maxRuntimeMs: number
	help: boolean
}

const DEFAULT_QUEUE = "rsi-default"
const HELP = `Usage:
  headlesscode rsi-status --campaign <id> [--queue <name>] [--query-timeout-ms <ms>]
  headlesscode rsi-monitor --campaign <id> [--state-dir <absolute-path>] [--queue <name>] [--poll-ms <ms>] [--stall-ms <ms>] [--max-runtime-ms <ms>]

Both commands read only queue and campaign operational metadata. They do not
start workers, restart campaigns, resume jobs, or dispatch model calls. Status
health describes operations and accounting; it does not rate experiment results.
`

function parse(argv: string[], monitor: boolean): ParsedMonitorArgs {
	const result: ParsedMonitorArgs = { queueName: process.env.HEADLESSCODE_RSI_QUEUE_NAME?.trim() || DEFAULT_QUEUE, queryTimeoutMs: 5_000, pollMs: 10_000, stallMs: 120_000, maxRuntimeMs: 3_600_000, help: false }
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]
		if (arg === "--help" || arg === "-h") { result.help = true; continue }
		const value = argv[++index]
		if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`)
		switch (arg) {
			case "--queue": result.queueName = value; break
			case "--campaign": result.campaignId = value; break
			case "--state-dir": if (!monitor) throw new Error("--state-dir is only valid for rsi-monitor"); result.stateDirectory = value; break
			case "--query-timeout-ms": result.queryTimeoutMs = Number(value); break
			case "--poll-ms": if (!monitor) throw new Error("--poll-ms is only valid for rsi-monitor"); result.pollMs = Number(value); break
			case "--stall-ms": if (!monitor) throw new Error("--stall-ms is only valid for rsi-monitor"); result.stallMs = Number(value); break
			case "--max-runtime-ms": if (!monitor) throw new Error("--max-runtime-ms is only valid for rsi-monitor"); result.maxRuntimeMs = Number(value); break
			default: throw new Error(`unknown option ${arg}`)
		}
	}
	if (result.help) return result
	if (!result.campaignId) throw new Error("--campaign is required")
	if (monitor && !result.stateDirectory) result.stateDirectory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "headlesscode", "rsi-monitor")
	const campaignId = result.campaignId
	if (!campaignId) throw new Error("--campaign is required")
	validateRsiMonitorArguments({ ...result, campaignId })
	return result
}

function statusExitCode(status: RsiOperationsStatus): number {
	if (status.health === "unknown") return 2
	if (status.health === "healthy") return 0
	return 1
}

export async function rsiOperationsCliMain(argv: string[], mode: "status" | "monitor", io: MonitorIo): Promise<number> {
	let parsed: ParsedMonitorArgs
	try { parsed = parse(argv, mode === "monitor") }
	catch (error) { io.stderr.write(`headlesscode rsi-${mode}: ${error instanceof Error ? error.message : String(error)}\n`); return 2 }
	if (parsed.help) { io.stdout.write(HELP); return 0 }
	const campaignId = parsed.campaignId
	if (!campaignId) { io.stderr.write(`headlesscode rsi-${mode}: --campaign is required\n`); return 2 }
	if (mode === "status") {
		let pool: ReturnType<typeof createRsiMonitorPool> | undefined
		try {
			pool = createRsiMonitorPool(process.env, parsed.queryTimeoutMs)
			const status = await readRsiOperationsStatus(pool, { queueName: parsed.queueName, campaignId, queryTimeoutMs: parsed.queryTimeoutMs })
			io.stdout.write(`${JSON.stringify(status)}\n`)
			return statusExitCode(status)
		} catch { io.stdout.write(`${JSON.stringify({ health: "unknown", condition: "database-or-records-unavailable" })}\n`); return 2 }
		finally { await pool?.end() }
	}
	const controller = new AbortController()
	const onSigint = () => controller.abort()
	const onSigterm = () => controller.abort()
	const stateDirectory = parsed.stateDirectory
	if (!stateDirectory) { io.stderr.write("headlesscode rsi-monitor: state directory is unavailable\n"); return 2 }
	process.once("SIGINT", onSigint)
	process.once("SIGTERM", onSigterm)
	try {
		return await runRsiMonitorProcess({ queueName: parsed.queueName, campaignId, queryTimeoutMs: parsed.queryTimeoutMs, stateDirectory, pollMs: parsed.pollMs, stallMs: parsed.stallMs, maxRuntimeMs: parsed.maxRuntimeMs, signal: controller.signal, stdout: (line) => { io.stdout.write(`${line}\n`) } })
	} catch (error) {
		io.stderr.write(`headlesscode rsi-monitor: ${error instanceof Error ? error.message : String(error)}\n`)
		return 2
	} finally {
		process.removeListener("SIGINT", onSigint)
		process.removeListener("SIGTERM", onSigterm)
	}
}
