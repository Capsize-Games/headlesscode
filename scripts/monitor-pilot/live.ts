import { collectLiveDevelopment, collectLiveHeldout } from "./live-runner.js"
import { pathToFileURL } from "node:url"

function usage(): void {
	console.log("Usage: npx tsx scripts/monitor-pilot/live.ts <collect-development|collect-heldout> [--retry-aborted]")
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const [command, ...flags] = argv
	if (command === "--help" || command === "help" || command === undefined) { usage(); return 0 }
	if (command !== "collect-development" && command !== "collect-heldout") { usage(); return 2 }
	if (flags.some((flag) => flag !== "--retry-aborted")) { usage(); return 2 }
	const controller = new AbortController()
	const stop = () => controller.abort(new Error("operator cancellation"))
	process.once("SIGINT", stop)
	process.once("SIGTERM", stop)
	try {
		if (command === "collect-development") {
			const summary = await collectLiveDevelopment({ signal: controller.signal, retryAborted: flags.includes("--retry-aborted") })
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
		const summary = await collectLiveHeldout({ signal: controller.signal, retryAborted: flags.includes("--retry-aborted") })
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
