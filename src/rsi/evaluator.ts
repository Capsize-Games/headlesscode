import type { CommandRunner, EvaluationSummary, RsiConfig, TrialResult } from "./types.js"
import { changedFiles, candidateCommits, gitOutput } from "./workspace.js"
import { protectedPathViolations } from "./sandbox.js"
import { createOpenShellCommandRunner } from "./openshell.js"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { verifyHiddenFunctions } from "./hidden-verifier.js"
import type { HiddenFunctionSuite, HiddenNonceStore, IsolatedHiddenCaseRunner } from "./hidden-verifier.js"

export interface HiddenEvaluationOptions {
	suite: HiddenFunctionSuite
	runner: IsolatedHiddenCaseRunner
	nonceStore: HiddenNonceStore
	publicKey: string | Buffer
	evaluatorImageDigest: string
	sessionId: string
	jobId: string
}

export async function evaluateCandidate(
	config: RsiConfig,
	candidateRoot: string,
	baseCommit: string,
	runner?: CommandRunner,
	hiddenEvaluation?: HiddenEvaluationOptions,
): Promise<EvaluationSummary> {
	if (config.hiddenEvalCommands.length > 0) throw new Error("RSI hidden evaluations require a supervisor-only evaluator service with bounded exported-function cases; candidate guest shell commands are refused")
	const isolatedRunner = runner ?? createOpenShellCommandRunner(config)
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
	const regression = await isolatedRunner(config.regressionCommand, candidateRoot, config.commandTimeoutMs)
	const typecheck = await isolatedRunner("npm run typecheck", candidateRoot, config.commandTimeoutMs)
	const visible: TrialResult[] = []
	for (const command of config.evalCommands) {
		visible.push(await isolatedRunner(command, candidateRoot, config.commandTimeoutMs))
	}
	const hidden: TrialResult[] = []
	if (hiddenEvaluation) {
		const candidateCommit = await gitOutput(candidateRoot, ["rev-parse", "HEAD"])
		const sourceTree = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], { cwd: candidateRoot, maxBuffer: 32 * 1024 * 1024 })
		const result = await verifyHiddenFunctions(hiddenEvaluation.suite, {
			candidateSourceDigest: createHash("sha256").update(sourceTree).digest("hex"),
			evaluatorImageDigest: hiddenEvaluation.evaluatorImageDigest,
			candidateCommit,
			sessionId: hiddenEvaluation.sessionId,
			jobId: hiddenEvaluation.jobId,
		}, hiddenEvaluation)
		hidden.push({
			ok: result.status === "passed",
			command: "supervisor-hidden-function-cases",
			exitCode: result.status === "passed" ? 0 : 1,
			durationMs: 0,
			stdout: `${result.caseResults.filter((item) => item.passed).length}/${result.caseResults.length} hidden function cases passed; protocol=${result.protocolDigest}`,
			stderr: result.reason ?? "",
		})
	}
	return {
		regression,
		visible,
		hidden,
		completed: regression.ok && typecheck.ok && visible.every((trial) => trial.ok) && hidden.every((trial) => trial.ok),
		crashed: [regression, typecheck, ...visible, ...hidden].some((trial) => trial.exitCode === null && !trial.timedOut),
		protectedPathViolation: false,
		changedFiles: files,
		committed: commits.length > 0,
		complexity,
		typecheck,
		failureClassification: [regression, typecheck, ...visible, ...hidden].some((trial) => !trial.ok) ? "evaluation-failure" : undefined,
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
