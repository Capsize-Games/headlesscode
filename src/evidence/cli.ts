import { verifyEvidenceFiles } from "./verify.js"
import { startContainedEvidenceService } from "../security/contained-evidence-service.js"

/** Small parent-wirable CLI entry point; it never starts a collector implicitly. */
export async function runEvidenceCli(argv: string[]): Promise<number> {
	const [command, ...args] = argv
	if (command === "serve-contained") return serveContainedEvidence(args)
	if (command !== "verify" || args.length !== 3) {
		console.error("Usage: headlesscode evidence verify <bundle.json> <pinned-key.json> <pinned-head.json>\n       headlesscode evidence serve-contained --storage-dir <dir> --socket <path> --config-dir <dir> --session <id> [--session <id> ...]")
		return 2
	}
	try {
		const result = await verifyEvidenceFiles(args[0], args[1], args[2])
		for (const item of result.readableHistory) {
			console.log(`${String(item.sequence).padStart(6, "0")} ${item.occurredAt} [${item.source}] ${item.actor}: ${item.kind}${item.actionId ? ` (${item.actionId})` : ""}`)
			console.log(JSON.stringify(item.payload, null, 2))
		}
		console.log(result.valid ? `Evidence valid (${result.checkedRecords} records)` : `Evidence invalid (${result.checkedRecords} records)`)
		for (const error of result.errors) console.error(`- ${error}`)
		return result.valid ? 0 : 1
	} catch (error) {
		console.error(`Evidence verification failed: ${error instanceof Error ? error.message : String(error)}`)
		return 1
	}
}

async function serveContainedEvidence(args: string[]): Promise<number> {
	const options: { storageDir?: string; socketPath?: string; configDirectory?: string; sessionIds: string[] } = { sessionIds: [] }
	for (let index = 0; index < args.length; index++) {
		const flag = args[index]
		const value = args[++index]
		if (!value || value.startsWith("--")) {
			console.error(`evidence serve-contained: missing value for ${flag}`)
			return 2
		}
		if (flag === "--storage-dir") options.storageDir = value
		else if (flag === "--socket") options.socketPath = value
		else if (flag === "--config-dir") options.configDirectory = value
		else if (flag === "--session") options.sessionIds.push(value)
		else {
			console.error(`evidence serve-contained: unknown option ${flag}`)
			return 2
		}
	}
	if (!options.storageDir || !options.socketPath || !options.configDirectory || !options.sessionIds.length) {
		console.error("Usage: headlesscode evidence serve-contained --storage-dir <dir> --socket <path> --config-dir <dir> --session <id> [--session <id> ...]")
		return 2
	}
	let service
	try {
		service = await startContainedEvidenceService({ storageDir: options.storageDir, socketPath: options.socketPath, configDirectory: options.configDirectory, sessionIds: options.sessionIds, repoRoot: process.cwd() })
	} catch (error) {
		console.error(`evidence serve-contained: ${error instanceof Error ? error.message : String(error)}`)
		return 2
	}
	console.log(`Evidence collector ready for ${service.sessions.length} session(s); runtime configs are protected under ${service.configDirectory}`)
	let resolveStop!: () => void
	const stopped = new Promise<void>((resolve) => { resolveStop = resolve })
	const onSignal = (): void => resolveStop()
	process.once("SIGINT", onSignal)
	process.once("SIGTERM", onSignal)
	try {
		await stopped
		await service.close()
		return 0
	} catch (error) {
		console.error(`evidence serve-contained shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
		return 1
	} finally {
		process.removeListener("SIGINT", onSignal)
		process.removeListener("SIGTERM", onSignal)
	}
}

export const evidenceMain = runEvidenceCli
