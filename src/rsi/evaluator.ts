import { exec as execCallback } from "node:child_process"
import { promisify } from "node:util"
import type { CommandRunner, EvaluationSummary, RsiConfig, TrialResult } from "./types.js"
import { changedFiles, candidateCommits, gitOutput } from "./workspace.js"
import { protectedPathViolations } from "./sandbox.js"

const exec = promisify(execCallback)

export const runCommand: CommandRunner = async (command, cwd, timeoutMs, env) => {
	const started = Date.now()
	try {
		const result = await exec(command, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
		return { ok: true, command, exitCode: 0, durationMs: Date.now() - started, stdout: result.stdout, stderr: result.stderr }
	} catch (error) {
		const failure = error as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string }
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

export async function evaluateCandidate(
	config: RsiConfig,
	candidateRoot: string,
	baseCommit: string,
	runner: CommandRunner = runCommand,
): Promise<EvaluationSummary> {
	const files = await changedFiles(candidateRoot, baseCommit)
	const commits = await candidateCommits(candidateRoot, baseCommit)
	const complexity = await complexityMetrics(candidateRoot, baseCommit, files)
	const violations = protectedPathViolations(files, config.protectedPaths)
	// Refuse to execute a candidate that touched evaluator/scoring inputs. This
	// check happens before any candidate-controlled test command runs.
	if (violations.length > 0) {
		const blocked: TrialResult = {
			ok: false,
			command: "protected-path-check",
			exitCode: 1,
			durationMs: 0,
			stdout: "",
			stderr: `protected paths changed: ${violations.join(", ")}`,
		}
		return {
			regression: blocked,
			visible: [],
			hidden: [],
			completed: false,
			crashed: false,
			protectedPathViolation: true,
			changedFiles: files,
			committed: commits.length > 0,
			complexity,
			failureClassification: "protected-path-violation",
		}
	}
	const regression = await runner("npm test", candidateRoot, config.commandTimeoutMs)
	const visible: TrialResult[] = []
	for (const command of config.evalCommands) {
		visible.push(await runner(command, candidateRoot, config.commandTimeoutMs))
	}
	const hidden: TrialResult[] = []
	for (const command of config.hiddenEvalCommands) {
		// Hidden commands belong to the supervisor checkout. They receive the
		// candidate path explicitly so a candidate cannot replace the evaluator
		// script or package metadata in the process that scores it.
		hidden.push(
			await runner(command, config.repoRoot, config.commandTimeoutMs, {
				...process.env,
				HEADLESSCODE_RSI_CANDIDATE_ROOT: candidateRoot,
			}),
		)
	}
	return {
		regression,
		visible,
		hidden,
		completed: regression.ok && visible.every((trial) => trial.ok) && hidden.every((trial) => trial.ok),
		crashed: [regression, ...visible, ...hidden].some((trial) => trial.exitCode === null && !trial.timedOut),
		protectedPathViolation: false,
		changedFiles: files,
		committed: commits.length > 0,
		complexity,
		failureClassification: [regression, ...visible, ...hidden].some((trial) => !trial.ok) ? "evaluation-failure" : undefined,
	}
}

async function complexityMetrics(candidateRoot: string, baseCommit: string, files: string[]): Promise<NonNullable<EvaluationSummary["complexity"]>> {
	try {
		const numstat = await gitOutput(candidateRoot, ["diff", "--numstat", `${baseCommit}...HEAD`])
		const diffLines = numstat.split("\n").reduce((total, line) => {
			const [added, deleted] = line.split(/\s+/)
			const a = Number(added)
			const d = Number(deleted)
			return total + (Number.isFinite(a) ? a : 0) + (Number.isFinite(d) ? d : 0)
		}, 0)
		return { diffLines, changedFiles: files.length, newDependencies: 0, additionalModelCalls: 0, runtimeOverheadMs: 0 }
	} catch {
		return { diffLines: 0, changedFiles: files.length, newDependencies: 0, additionalModelCalls: 0, runtimeOverheadMs: 0 }
	}
}
