import * as path from "node:path"
import { DEFAULT_PROTECTED_FILES } from "../permissions/protected-files.js"
import type { ComputePolicy, MutationHypothesis, MutationKind, ParentSelectionPolicy, RsiConfig } from "./types.js"

export const DEFAULT_RSI_MODEL = "wxrq-qwen3.5-9b:latest"
export const DEFAULT_VISIBLE_EVALS = ["npm test -- --filter rsi"]
export const DEFAULT_PROTECTED_PATHS = [
	...DEFAULT_PROTECTED_FILES,
	"src/rsi/",
	"scripts/",
	"**/*.test.ts",
	"package.json",
	"package-lock.json",
	".gitignore",
	"scripts/eval-suite/",
	".headlesscode/",
	".worktrees/",
]

export interface ParsedRsiArgs {
	config?: RsiConfig
	help?: boolean
	error?: string
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`)
	}
	return parsed
}

function splitCommands(value: string): string[] {
	return value
		.split(";;")
		.map((command) => command.trim())
		.filter(Boolean)
}

export function rsiHelp(): string {
	return `headlesscode improve — bounded recursive self-improvement

Usage:
  headlesscode improve --repo <path> [options]

Options:
  --model <id>                 worker model (default: ${DEFAULT_RSI_MODEL})
  --population <n>             candidates per generation (default: 2)
  --generations <n>            bounded generations (default: 1)
  --parent-policy <name>      champion-specialist-novelty | pareto-front | all-eligible
  --mutation-kind <name>      corrective | architectural | search-policy | curriculum | model-adaptation
  --hypothesis <text>         recorded reason for the mutation
  --expected-effect <text>    measurable benefit to test
  --potential-downside <text> recorded cost or regression risk
  --compute-policy <name>     single | independent | planner-executors | critic-retry
  --eval <command>             visible command; repeat or separate with ;; 
  --hidden-eval <command>      supervisor-only hidden command
  --mutation-task <text>       improvement objective
  --archive-dir <path>         durable archive directory
  --worktree-dir <path>        candidate worktree directory
  --trajectory-dir <path>      structured trajectory output directory
  --curriculum-dir <path>      generated curriculum proposal directory
  --resume <run-id>            resume a checkpointed active run
  --model-candidate-id <id>    model identity used for combination tracking
  --base-ref <ref>             git ref to branch from (default: HEAD)
  --dry-run                    print the planned loop without changing files
  --keep-worktrees              retain candidate worktrees after evaluation
  --help                       show this help

The evaluator and scoring code are protected from candidates. The first run
uses the local Qwen worker unless --model overrides it.
`
}

export function parseRsiArgs(argv: string[], cwd = process.cwd()): ParsedRsiArgs {
	let repoRoot = cwd
	let model = DEFAULT_RSI_MODEL
	let population = 2
	let generations = 1
	let maxConcurrent = 1
	let mutationTask = "Improve the headlesscode agent loop while preserving all existing behavior and tests."
	let parentSelectionPolicy: ParentSelectionPolicy = "champion-specialist-novelty"
	let mutationKind: MutationKind = "corrective"
	let hypothesis: MutationHypothesis = {
		statement: mutationTask,
		expectedEffect: "higher verified task success without regressions",
		potentialDownside: "additional complexity or inference cost",
	}
	let computePolicy: ComputePolicy = "single"
	let evalCommands = [...DEFAULT_VISIBLE_EVALS]
	let hiddenEvalCommands: string[] = []
	let archiveDir: string | undefined
	let worktreeDir: string | undefined
	let baseRef = "HEAD"
	let seed = "headlesscode-rsi"
	let dryRun = false
	let keepWorktrees = false
	let maxIterations = 40
	let commandTimeoutMs = 15 * 60_000
	let trajectoryDir: string | undefined
	let curriculumDir: string | undefined
	let resumeRunId: string | undefined
	let modelCandidateId: string | undefined

	const take = (index: number, name: string): [string, number] => {
		const value = argv[index + 1]
		if (!value || value.startsWith("--")) {
			throw new Error(`${name} requires a value`)
		}
		return [value, index + 1]
	}

	try {
		for (let index = 0; index < argv.length; index++) {
			const arg = argv[index]
			switch (arg) {
				case "--help":
				case "-h":
					return { help: true }
				case "--repo": {
					const [value, next] = take(index, arg)
					repoRoot = path.resolve(value)
					index = next
					break
				}
				case "--model": {
					const [value, next] = take(index, arg)
					model = value
					index = next
					break
				}
				case "--population": {
					const [value, next] = take(index, arg)
					population = positiveInteger(value, arg)
					index = next
					break
				}
				case "--generations": {
					const [value, next] = take(index, arg)
					generations = positiveInteger(value, arg)
					index = next
					break
				}
				case "--parent-policy": {
					const [value, next] = take(index, arg)
					if (!["champion-specialist-novelty", "pareto-front", "all-eligible"].includes(value)) throw new Error(`${arg} has an invalid policy`)
					parentSelectionPolicy = value as ParentSelectionPolicy
					index = next
					break
				}
				case "--mutation-kind": {
					const [value, next] = take(index, arg)
					if (!["corrective", "architectural", "search-policy", "curriculum", "model-adaptation"].includes(value)) throw new Error(`${arg} has an invalid mutation kind`)
					mutationKind = value as MutationKind
					hypothesis.statement = mutationTask
					index = next
					break
				}
				case "--hypothesis": {
					const [value, next] = take(index, arg)
					hypothesis.statement = value
					index = next
					break
				}
				case "--expected-effect": {
					const [value, next] = take(index, arg)
					hypothesis.expectedEffect = value
					index = next
					break
				}
				case "--potential-downside": {
					const [value, next] = take(index, arg)
					hypothesis.potentialDownside = value
					index = next
					break
				}
				case "--compute-policy": {
					const [value, next] = take(index, arg)
					if (!["single", "independent", "planner-executors", "critic-retry"].includes(value)) throw new Error(`${arg} has an invalid policy`)
					computePolicy = value as ComputePolicy
					index = next
					break
				}
				case "--max-concurrent": {
					const [value, next] = take(index, arg)
					maxConcurrent = positiveInteger(value, arg)
					index = next
					break
				}
				case "--eval": {
					const [value, next] = take(index, arg)
					evalCommands = splitCommands(value)
					index = next
					break
				}
				case "--hidden-eval": {
					const [value, next] = take(index, arg)
					hiddenEvalCommands.push(...splitCommands(value))
					index = next
					break
				}
				case "--mutation-task": {
					const [value, next] = take(index, arg)
					mutationTask = value
					index = next
					break
				}
				case "--archive-dir": {
					const [value, next] = take(index, arg)
					archiveDir = path.resolve(repoRoot, value)
					index = next
					break
				}
				case "--worktree-dir": {
					const [value, next] = take(index, arg)
					worktreeDir = path.resolve(repoRoot, value)
					index = next
					break
				}
				case "--trajectory-dir": {
					const [value, next] = take(index, arg)
					trajectoryDir = path.resolve(repoRoot, value)
					index = next
					break
				}
				case "--curriculum-dir": {
					const [value, next] = take(index, arg)
					curriculumDir = path.resolve(repoRoot, value)
					index = next
					break
				}
				case "--resume": {
					const [value, next] = take(index, arg)
					resumeRunId = value
					index = next
					break
				}
				case "--model-candidate-id": {
					const [value, next] = take(index, arg)
					modelCandidateId = value
					index = next
					break
				}
				case "--base-ref": {
					const [value, next] = take(index, arg)
					baseRef = value
					index = next
					break
				}
				case "--seed": {
					const [value, next] = take(index, arg)
					seed = value
					index = next
					break
				}
				case "--max-iterations": {
					const [value, next] = take(index, arg)
					maxIterations = positiveInteger(value, arg)
					index = next
					break
				}
				case "--timeout-ms": {
					const [value, next] = take(index, arg)
					commandTimeoutMs = positiveInteger(value, arg)
					index = next
					break
				}
				case "--dry-run":
					dryRun = true
					break
				case "--keep-worktrees":
					keepWorktrees = true
					break
				default:
					throw new Error(`unknown improve argument: ${arg}`)
			}
		}
		const resolvedRepo = path.resolve(repoRoot)
		return {
			config: {
				repoRoot: resolvedRepo,
				model,
				population,
				generations,
				maxConcurrent,
				mutationTask,
				parentSelectionPolicy,
				mutationKind,
				hypothesis: { ...hypothesis },
				computePolicy,
				evalCommands,
				hiddenEvalCommands,
				archiveDir: archiveDir ?? path.join(resolvedRepo, ".headlesscode", "rsi"),
				worktreeDir: worktreeDir ?? path.join(resolvedRepo, ".worktrees", "rsi"),
				trajectoryDir: trajectoryDir ?? path.join(archiveDir ?? path.join(resolvedRepo, ".headlesscode", "rsi"), "trajectories"),
				curriculumDir: curriculumDir ?? path.join(archiveDir ?? path.join(resolvedRepo, ".headlesscode", "rsi"), "curriculum"),
				baseRef,
				seed,
				dryRun,
				keepWorktrees,
				maxIterations,
				protectedPaths: [...DEFAULT_PROTECTED_PATHS],
				commandTimeoutMs,
				resumeRunId,
				modelCandidateId,
			},
		}
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	}
}
