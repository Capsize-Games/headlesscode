import { collectLiveDevelopment, collectLiveHeldout, DEFAULT_MAX_OUTPUT_TOKENS, MAX_CONFIGURED_OUTPUT_TOKENS } from "./live-runner.js"
import { pathToFileURL } from "node:url"

function usage(): void {
	console.log(`Usage: npx tsx scripts/monitor-pilot/live.ts <collect-development|collect-heldout> [--retry-aborted] [--max-output-tokens <1-${MAX_CONFIGURED_OUTPUT_TOKENS}>] [--output-dir <private-directory>]`)
	console.log(`Default output cap: ${DEFAULT_MAX_OUTPUT_TOKENS} tokens per request.`)
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const [command, ...flags] = argv
	if (command === "--help" || command === "help" || command === undefined) { usage(); return 0 }
	if (command !== "collect-development" && command !== "collect-heldout") { usage(); return 2 }
	let retryAborted = false
	let outputDir: string | undefined
	let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS
	let outputCapProvided = false
	for (let index = 0; index < flags.length; index++) {
		const flag = flags[index]
		const value = flags[index + 1]
		if (flag === "--retry-aborted" && !retryAborted) { retryAborted = true; continue }
		if (flag === "--output-dir" && outputDir === undefined && value && !value.startsWith("--")) { outputDir = value; index++; continue }
		if (flag === "--max-output-tokens" && !outputCapProvided && value && !value.startsWith("--")) {
			if (!/^\d+$/.test(value)) { usage(); return 2 }
			maxOutputTokens = Number(value)
			if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_CONFIGURED_OUTPUT_TOKENS) { usage(); return 2 }
			outputCapProvided = true
			index++
			continue
		}
		usage()
		return 2
	}
	const controller = new AbortController()
	const stop = () => controller.abort(new Error("operator cancellation"))
	process.once("SIGINT", stop)
	process.once("SIGTERM", stop)
	try {
		if (command === "collect-development") {
			const summary = await collectLiveDevelopment({ signal: controller.signal, retryAborted, outputDir, maxOutputTokens })
			console.log(JSON.stringify({
				experimentId: summary.experimentId,
				scheduledRuns: summary.scheduledRuns,
				completedRuns: summary.completedRuns,
				attempts: summary.attempts,
				abortedAttempts: summary.abortedAttempts,
				unstartedSlots: summary.unstartedSlots,
				invalidCompletedRuns: summary.invalidCompletedRuns,
				billing: summary.billing,
				predictorStatus: summary.predictorStatus,
				...(summary.stopReason ? { stopReason: summary.stopReason } : {}),
				...(summary.predictor ? { predictorHash: summary.predictor.artifactHash, threshold: summary.predictor.threshold } : {}),
				manifestHash: summary.manifestHash,
				journalPath: summary.journalPath,
			}, null, 2))
			return summary.predictorStatus === "QUALIFIED" ? 0 : 3
		}
		const summary = await collectLiveHeldout({ signal: controller.signal, retryAborted, outputDir, maxOutputTokens })
		console.log(JSON.stringify(summary, null, 2))
		return summary.status === "COMPLETE" ? 0 : 4
	} catch (error) {
		const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? ` (HTTP ${error.status})` : ""
		const safeMessage = error instanceof Error && (error.message.startsWith("Set HEADLESSCODE_") || error.message.startsWith("Live pilot requires "))
			? error.message
			: `${error instanceof Error ? error.name : "UnknownError"}${status}; inspect the private journal for the recorded stop reason.`
		console.error(`Live monitor pilot stopped: ${safeMessage}`)
		return 1
	} finally {
		process.removeListener("SIGINT", stop)
		process.removeListener("SIGTERM", stop)
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main().then((code) => { process.exitCode = code })
}
