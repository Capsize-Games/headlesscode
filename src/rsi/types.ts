import type { ChildProcess } from "node:child_process"

export type CandidateStatus = "planned" | "mutating" | "evaluating" | "accepted" | "rejected" | "failed"
export type MutationKind = "corrective" | "architectural" | "search-policy" | "curriculum" | "model-adaptation"
export type ParentSelectionPolicy = "champion-specialist-novelty" | "pareto-front" | "all-eligible"
export type ComputePolicy = "single" | "independent" | "planner-executors" | "critic-retry"

export interface MutationHypothesis {
	statement: string
	expectedEffect: string
	potentialDownside: string
	evidence?: string
}

export interface MetricVector {
	correctness: number
	reliability: number
	generalization: number
	hidden: number
	efficiency: number
	latency: number
	tokenUse: number
	recovery: number
	fabricationRate: number
	complexityPenalty: number
}

export interface ComplexityMetrics {
	diffLines: number
	changedFiles: number
	newDependencies: number
	additionalModelCalls: number
	runtimeOverheadMs: number
}

export interface ParentSelectionReason {
	strategy: "champion" | "specialist" | "novelty" | "pareto" | "archive" | "baseline"
	reason: string
	metrics?: Partial<MetricVector>
}

export type ModelRole =
	| "worker"
	| "mutation-architect"
	| "failure-analyst"
	| "critic"
	| "adversary"
	| "reviewer"
	| "curriculum-designer"
	| "training-data-curator"

export interface RoleModelConfig {
	provider: "ollama" | "openrouter" | "command"
	model: string
	baseUrl?: string
	command?: string
}

export type RsiRoleConfig = Partial<Record<ModelRole, RoleModelConfig>>

export interface TrainingConfig {
	method: "none" | "lora" | "qlora" | "sft" | "preference"
	command?: string
	seed?: number
	parameters?: Record<string, string | number | boolean>
}

export interface ModelCandidate {
	id: string
	parentModel: string
	trainingMethod: TrainingConfig["method"]
	datasetVersion?: string
	trainingConfig: TrainingConfig
	artifactPath?: string
	artifactHash?: string
	status: "base" | "prepared" | "trained" | "evaluated" | "accepted" | "rejected"
	createdAt: string
	provenance?: Record<string, string>
}

export interface HarnessModelCombination {
	id: string
	harnessCandidateId: string
	modelCandidateId: string
	status: "planned" | "evaluated" | "accepted" | "rejected"
	metrics?: MetricVector
	fitness?: Fitness
	createdAt: string
}

export type ResourceClass = "LOCAL_GPU" | "CPU" | "REMOTE_API" | "TRAINING_GPU"
export type ExperimentJobKind = "mutation" | "evaluation" | "adversarial" | "curriculum" | "training" | "model-evaluation" | "critic"
export type ExperimentJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export interface ResourceRequirements {
	class: ResourceClass
	units: number
	concurrencyKey?: string
}

export interface ExperimentJob {
	id: string
	kind: ExperimentJobKind
	status: ExperimentJobStatus
	resource: ResourceRequirements
	owner?: string
	candidateId?: string
	createdAt: string
	updatedAt: string
	attempts: number
	error?: string
}

export interface TrajectoryMessage {
	role: string
	content?: string
	tool_calls?: unknown[]
	tool_call_id?: string
	name?: string
}

export interface TrajectoryRecord {
	id: string
	task: string
	environment: { repoRoot: string; baseCommit: string; generation: number }
	model: { id: string; provider?: string; candidateId?: string }
	harnessVersion: string
	promptConfig: Record<string, unknown>
	messages: TrajectoryMessage[]
	toolCalls: number
	outcome: "success" | "failure" | "incomplete"
	verification: { verified: boolean; regressionPass: boolean; hiddenPass: boolean }
	failureClassification?: string
	criticDiagnosis?: string
	fitnessImpact?: number
	provenance: { source: string; capturedAt: string; trusted: boolean }
}

export interface TrajectorySummary {
	path: string
	messageCount: number
	toolCalls: number
	trusted: boolean
	outcome: TrajectoryRecord["outcome"]
	failureClassification?: string
}

export interface CurriculumTask {
	id: string
	task: string
	difficulty: 1 | 2 | 3 | 4 | 5
	capability: string
	groundTruthCommand: string
	provenance: { sourceCandidateIds: string[]; failureClass: string; generatedAt: string }
	validated: boolean
}

export interface RsiConfig {
	repoRoot: string
	model: string
	population: number
	generations: number
	maxConcurrent: number
	mutationTask: string
	evalCommands: string[]
	hiddenEvalCommands: string[]
	archiveDir: string
	worktreeDir: string
	baseRef: string
	seed: string
	dryRun: boolean
	keepWorktrees: boolean
	maxIterations: number
	protectedPaths: string[]
	commandTimeoutMs: number
	parentSelectionPolicy?: ParentSelectionPolicy
	eliteCount?: number
	specialistCount?: number
	noveltyRate?: number
	mutationKind?: MutationKind
	hypothesis?: MutationHypothesis
	computePolicy?: ComputePolicy
	modelCandidateId?: string
	modelCandidates?: ModelCandidate[]
	roles?: RsiRoleConfig
	trajectoryDir?: string
	curriculumDir?: string
	resumeRunId?: string
}

export interface CandidateRecord {
	id: string
	generation: number
	parent: string
	branch: string
	worktree: string
	baseCommit: string
	status: CandidateStatus
	model: string
	mutation: string
	createdAt: string
	updatedAt: string
	commits: string[]
	changedFiles: string[]
	protectedPathViolations: string[]
	mutationKind?: MutationKind
	hypothesis?: MutationHypothesis
	parentSelection?: ParentSelectionReason
	parentCommit?: string
	modelCandidateId?: string
	combinationId?: string
	failure?: string
	result?: TrialResult
	fitness?: Fitness
	trajectory?: TrajectorySummary
}

export interface TrialResult {
	ok: boolean
	command: string
	exitCode: number | null
	durationMs: number
	stdout: string
	stderr: string
	timedOut?: boolean
}

export interface EvaluationSummary {
	regression: TrialResult
	visible: TrialResult[]
	hidden: TrialResult[]
	completed: boolean
	crashed: boolean
	protectedPathViolation: boolean
	changedFiles: string[]
	committed?: boolean
	complexity?: ComplexityMetrics
	failureClassification?: string
}

export interface HardGates {
	regressionPass: boolean
	visibleEvalPass: boolean
	hiddenEvalPass: boolean
	noProtectedPathViolation: boolean
	completed: boolean
	noCrash: boolean
	committed: boolean
}

export interface Fitness {
	score: number
	components: {
	regression: number
	visible: number
		hidden: number
		efficiency: number
		recovery: number
	}
	metrics: MetricVector
	complexity: ComplexityMetrics
	paretoRank?: number
	hardGates: HardGates
	reason: string
}

export interface RsiRunRecord {
	runId: string
	startedAt: string
	finishedAt?: string
	baseline?: TrialResult
	model: string
	baseRef: string
	baseCommit: string
	generations: number
	selected?: string
	selectedCandidates?: string[]
	parentSelectionPolicy?: ParentSelectionPolicy
	parentChoices?: Record<string, ParentSelectionReason>
	modelCandidates?: ModelCandidate[]
	combinations?: HarnessModelCombination[]
	jobs?: ExperimentJob[]
	trajectoryRefs?: string[]
	curriculumTasks?: CurriculumTask[]
	candidates: CandidateRecord[]
	reports: string[]
}

export interface RsiArchive {
	schemaVersion: 2
	updatedAt: string
	runs: RsiRunRecord[]
	activeRuns: RsiRunRecord[]
	candidates: CandidateRecord[]
	modelCandidates: ModelCandidate[]
	combinations: HarnessModelCombination[]
	jobs: ExperimentJob[]
	trajectoryRefs: string[]
	curriculumTasks: CurriculumTask[]
}

export interface CommandRunner {
	(command: string, cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<TrialResult>
}

export interface MutationRunner {
	(candidate: CandidateRecord, config: RsiConfig): Promise<{ ok: boolean; result?: TrialResult; error?: string }>
}

export interface RsiHooks {
	runCommand?: CommandRunner
	runMutation?: MutationRunner
	now?: () => string
	log?: (line: string) => void
}

export type SpawnedProcess = ChildProcess
