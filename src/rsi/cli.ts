import { parseRsiArgs } from "./config.js"
import { readArchive } from "./archive.js"
import { PostgresRsiJobQueue, fleetQueuePolicy } from "./postgres-queue.js"
import { runBoundedModelCandidate } from "./model-training.js"
import type { RsiCliEntrypoint } from "../rsi-cli-contract.js"

/** Host-only RSI command router; candidate snapshots intentionally omit this module. */
export const rsiCliMain: RsiCliEntrypoint = async (argv, io) => {
	if (argv[0] === "work-loop") {
		const { workLoopMain } = await import("./work-loop-cli.js")
		return workLoopMain(argv.slice(1), io)
	}
	if (argv[0] === "rsi-worker") {
		const { rsiWorkerMain } = await import("./worker.js")
		return rsiWorkerMain()
	}
	if (argv[0] === "rsi-benchmark") {
		const { benchmarkMain } = await import("./benchmark/cli.js")
		return benchmarkMain(argv.slice(1))
	}
	if (argv[0] === "rsi-train-model") {
		const parsed = parseRsiArgs(argv.slice(1))
		if (parsed.help) {
			io.stdout.write("Usage: headlesscode rsi-train-model --repo <path> --archive-dir <path> --resume <run-id> --model-candidate-id <id>\nThe registered worker must use an OpenShell training image and a local Hugging Face checkpoint.\n")
			return 0
		}
		const config = parsed.config
		const modelCandidateId = config?.modelCandidateId
		if (parsed.error || !config || !config.resumeRunId || !modelCandidateId || config.dryRun) {
			io.stderr.write(`headlesscode rsi-train-model: ${parsed.error ?? "--resume and --model-candidate-id are required; dry-run is unsupported"}\n`)
			return 2
		}
		const archive = await readArchive(config.archiveDir)
		const run = archive.activeRuns.find((entry) => entry.runId === config.resumeRunId) ?? archive.runs.find((entry) => entry.runId === config.resumeRunId)
		if (!run) {
			io.stderr.write(`headlesscode rsi-train-model: RSI run not found in ${config.archiveDir}\n`)
			return 2
		}
		const policy = fleetQueuePolicy(process.env.HEADLESSCODE_RSI_QUEUE_NAME?.trim() || "rsi-default", config.maxConcurrent, process.env)
		const queue = PostgresRsiJobQueue.fromEnvironment(policy, process.env)
		try {
			await queue.migrate()
			const model = await runBoundedModelCandidate(config, run, queue, modelCandidateId)
			io.stdout.write(`[rsi-model] ${model.id}: ${model.status}; eligible=${model.eligibleForSelection === true}\n`)
			return model.eligibleForSelection ? 0 : 1
		} finally {
			await queue.close()
		}
	}
	// Bounded recursive self-improvement: the supervisor owns the evaluator,
	// archive, and selection logic while each candidate runs in its own worktree.
	if (argv[0] === "improve") {
		const { improveMain } = await import("./controller.js")
		return improveMain(argv.slice(1))
	}
	return 2
}
