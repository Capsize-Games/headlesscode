import { verifyEvidenceFiles } from "./index.js"

/** Small parent-wirable CLI entry point; it never starts a collector implicitly. */
export async function runEvidenceCli(argv: string[]): Promise<number> {
	const [command, ...args] = argv
	if (command !== "verify" || args.length !== 3) {
		console.error("Usage: headlesscode evidence verify <bundle.json> <pinned-key.json> <pinned-head.json>")
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

export const evidenceMain = runEvidenceCli
