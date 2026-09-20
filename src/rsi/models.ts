import { createHash } from "node:crypto"
import { exec as execCallback } from "node:child_process"
import * as fs from "node:fs/promises"
import { promisify } from "node:util"
import type {
	HarnessModelCombination,
	ModelCandidate,
	TrainingConfig,
	TrialResult,
} from "./types.js"

const exec = promisify(execCallback)

export function baseModelCandidate(model: string, now: string, id = "model-base"): ModelCandidate {
	return {
		id,
		parentModel: model,
		trainingMethod: "none",
		trainingConfig: { method: "none" },
		status: "base",
		createdAt: now,
		provenance: { source: "configured-worker-model" },
	}
}

export function modelCombinationId(harnessCandidateId: string, modelCandidateId: string): string {
	return `${harnessCandidateId}::${modelCandidateId}`
}

export function createCombination(
	harnessCandidateId: string,
	modelCandidateId: string,
	now: string,
): HarnessModelCombination {
	return {
		id: modelCombinationId(harnessCandidateId, modelCandidateId),
		harnessCandidateId,
		modelCandidateId,
		status: "planned",
		createdAt: now,
	}
}

export function factorialCombinations(harnessIds: string[], modelIds: string[], now: string): HarnessModelCombination[] {
	return harnessIds.flatMap((harnessId) => modelIds.map((modelId) => createCombination(harnessId, modelId, now)))
}

export interface TrainingBackend {
	prepareDataset(datasetVersion: string, outputDir: string): Promise<void>
	train(config: TrainingConfig, outputDir: string): Promise<TrialResult>
	inspectArtifact(artifactPath: string): Promise<{ hash: string; bytes: number }>
}

export class ExternalTrainingBackend implements TrainingBackend {
	constructor(private readonly timeoutMs = 60 * 60_000) {}

	async prepareDataset(datasetVersion: string, outputDir: string): Promise<void> {
		await fs.mkdir(outputDir, { recursive: true })
		await fs.writeFile(`${outputDir}/dataset-version.txt`, `${datasetVersion}\n`, "utf8")
	}

	async train(config: TrainingConfig, outputDir: string): Promise<TrialResult> {
		const command = config.command
		if (!command) {
			return { ok: false, command: "training-command", exitCode: 2, durationMs: 0, stdout: "", stderr: "no training command configured" }
		}
		const started = Date.now()
		try {
			const result = await exec(command, { cwd: outputDir, timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024 })
			return { ok: true, command, exitCode: 0, durationMs: Date.now() - started, stdout: result.stdout, stderr: result.stderr }
		} catch (error) {
			const failure = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string }
			return {
				ok: false,
				command,
				exitCode: typeof failure.code === "number" ? failure.code : null,
				durationMs: Date.now() - started,
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? String(error),
				timedOut: failure.killed === true,
			}
		}
	}

	async inspectArtifact(artifactPath: string): Promise<{ hash: string; bytes: number }> {
		const bytes = await fs.readFile(artifactPath)
		return { hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength }
	}
}
