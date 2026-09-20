import { exec as execCallback } from "node:child_process"
import * as path from "node:path"
import { promisify } from "node:util"
import type { MutationRunner, RsiConfig, TrialResult, CandidateRecord } from "./types.js"
import { DEFAULT_RSI_MODEL } from "./config.js"

const exec = promisify(execCallback)

export function mutationPrompt(candidate: CandidateRecord, config: RsiConfig): string {
	const hypothesis = candidate.hypothesis
	return [
		"You are the bounded RSI worker for headlesscode.",
		`Improve this candidate checkout for generation ${candidate.generation}.`,
		`Mutation class: ${candidate.mutationKind ?? "corrective"}. Compute policy: ${config.computePolicy ?? "single"}.`,
		`Objective: ${config.mutationTask}`,
		hypothesis
			? `Hypothesis: ${hypothesis.statement}\nExpected effect: ${hypothesis.expectedEffect}\nPotential downside: ${hypothesis.potentialDownside}${hypothesis.evidence ? `\nEvidence: ${hypothesis.evidence}` : ""}`
			: "",
		"You may change agent implementation, but you must not modify tests, evaluator/scoring/archive code, hidden evaluation commands, git metadata, or protected paths.",
		"Inspect the existing repository first. Make a small, test-backed change. Run the relevant existing tests. Commit the candidate change before completing.",
	].join("\n\n")
}

export const runMutation: MutationRunner = async (candidate, config) => {
	const started = Date.now()
	const workerRole = config.roles?.worker
	const workerModel = workerRole?.model ?? config.model
	const workerProvider = workerRole?.provider ?? "ollama"
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HEADLESSCODE_OPENROUTER_API_KEY: process.env.HEADLESSCODE_OPENROUTER_API_KEY ?? "rsi-local-placeholder",
		HEADLESSCODE_CODE_MODE_BACKEND: workerProvider === "ollama" ? "ollama" : "openrouter",
		HEADLESSCODE_LOCAL_BACKEND_MODES: "code",
		HEADLESSCODE_CODE_MODE_MODEL: workerModel || DEFAULT_RSI_MODEL,
		HEADLESSCODE_OLLAMA_THINK: "0",
		HEADLESSCODE_CAPTURE_TRANSCRIPT_DIR: path.join(candidate.worktree, ".headlesscode", "rsi-transcripts"),
	}
	const command = [
		"npx tsx src/cli.ts",
		"--mode code",
		`--max-iterations ${config.maxIterations}`,
		"--no-checkpoints",
		`--task ${JSON.stringify(mutationPrompt(candidate, config))}`,
	].join(" ")
	try {
		const result = await exec(command, {
			cwd: candidate.worktree,
			env,
			timeout: config.commandTimeoutMs,
			maxBuffer: 16 * 1024 * 1024,
		})
		const trial: TrialResult = {
			ok: true,
			command,
			exitCode: 0,
			durationMs: Date.now() - started,
			stdout: result.stdout,
			stderr: result.stderr,
		}
		return { ok: true, result: trial }
	} catch (error) {
		const failure = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string }
		return {
			ok: false,
			result: {
				ok: false,
				command,
				exitCode: typeof failure.code === "number" ? failure.code : null,
				durationMs: Date.now() - started,
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? String(error),
				timedOut: failure.killed === true,
			},
			error: error instanceof Error ? error.message : String(error),
		}
	}
}
