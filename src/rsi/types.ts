import type { ChildProcess } from "node:child_process"
import type { CandidateDevelopmentProof, DevelopmentProofProtocol, DevelopmentProofRule } from "./development-proof.js"
import type { BenchmarkAttempt } from "./benchmark/types.js"
import type { OpenRouterDenialSummary, RsiOpenRouterProfileId } from "./inference-broker.js"

export type CandidateStatus = "planned" | "mutating" | "evaluating" | "accepted" | "rejected" | "failed"
export type MutationKind = "corrective" | "architectural" | "search-policy" | "curriculum" | "model-adaptation"
export type ParentSelectionPolicy = "champion-specialist-novelty" | "pareto-front" | "all-eligible"
export type WorkerHarnessMode = "fixed-control" | "self-hosted"
export type WorkerHarnessPhase = "development" | "confirmation"

export interface WorkerHarnessRuntimeIdentity {
	imageName: string
	imageDigest: string
	harnessCommit: string
	dependencyLockDigest: string
}

export interface ProofBenchmarkFixtureBinding {
	root: string
	manifestSha256: string
	snapshotPackage?: { path: string; digest: string }
}

export interface WorkerHarnessExecution {
	mode: WorkerHarnessMode
	parentCommit: string
	snapshotCommit: string
	snapshotTreeDigest: string
	runtime: WorkerHarnessRuntimeIdentity
	executedCliPath: string
}
export type ComputePolicy = "single" | "independent" | "adaptive-independent" | "planner-executors" | "critic-retry"

export interface AdaptiveSearchDecision {
	generation: number
	decision: "continue" | "stop"
	reason: "mixed-evidence" | "consistent-evidence" | "trajectory-cap" | "iteration-cap" | "runtime-cap" | "generation-cap" | "insufficient-results"
	candidateIds: string[]
	evidence: Array<{ candidateId: string; status: CandidateStatus; visiblePassRate?: number }>
	allocatedTrajectories: number
	remainingTrajectories: number
	allocatedIterations: number
	remainingIterations: number
	elapsedMs: number
	decidedAt: string
}

export interface MutationHypothesis {
	statement: string
	expectedEffect: string
	potentialDownside: string
	evidence?: string
}

export interface MetricVector {
	correctness: number
	reliability: number
	generalization: number | null
	hidden: number | null
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
	openRouterProfile?: RsiOpenRouterProfileId
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
	status: "base" | "prepared" | "trained" | "evaluated" | "accepted" | "rejected" | "failed" | "partial"
	createdAt: string
	eligibleForSelection?: boolean
	trainingResult?: {
		status: "completed" | "failed" | "partial"
		datasetVersion: string
		datasetSha256: string
		baseModelSha256: string
		artifactSha256?: string
		artifactBytes?: number
		stepsCompleted: number
		maxSteps: number
		error?: string
	}
	pairedEvaluation?: {
		cellSetSha256: string
		baseResultSha256: string
		adapterResultSha256?: string
		baseMetric: number
		adapterMetric?: number
		completedCellCount: number
		expectedCellCount: number
		seed: number
	}
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
	model: { id: string; provider?: string; candidateId?: string; returnedModels?: string[] }
	inferenceUsage?: CandidateRecord["inferenceUsage"]
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
	fixtureId: string
	fixtureDescription: string
	provenance: { sourceCandidateIds: string[]; failureClass: string; generatedAt: string }
	validated: boolean
	validation?: {
		baseCommit: string
		command: string
		validatedAt: string
		replays: Array<{ idempotencyKey: string; ok: boolean; exitCode: number | null; outputSha256?: string; failure?: string }>
		reproducible: boolean
		reason: string
	}
	promotedAt?: string
}

export interface RsiConfig {
	repoRoot: string
	/** Supervisor-only benchmark fixtures. This identity is never placed in a candidate job payload. */
	proofBenchmarkFixtures?: ProofBenchmarkFixtureBinding
	model: string
	population: number
	generations: number
	maxConcurrent: number
	mutationTask: string
	regressionCommand: string
	evalCommands: string[]
	hiddenEvalCommands: string[]
	hiddenSuitePath?: string
	hiddenSuiteSha256?: string
	hiddenPublicKeyPath?: string
	hiddenPrivateKeyPath?: string
	hiddenNonceStorePath?: string
	hiddenImageDigest?: string
	evaluatorSigningKeyPath?: string
	evaluatorTrustedPublicKeyPath?: string
	evaluatorTrustedKeySha256?: string
	archiveDir: string
	worktreeDir: string
	baseRef: string
	seed: string
	dryRun: boolean
	keepWorktrees: boolean
	maxIterations: number
	maxTokens?: number
	benchmarkHarnessCommit?: string
	workerHarnessMode?: WorkerHarnessMode
	workerHarnessPhase?: WorkerHarnessPhase
	/** Terminal, development-only paired run used to qualify the engineering chain before holdout freeze. */
	workerHarnessEngineeringOnly?: boolean
	workerHarnessPairId?: string
	/** Deterministic supervisor-owned run ID for restart-safe paired campaign admission. */
	workerHarnessRunId?: string
	workerHarnessRuntime?: WorkerHarnessRuntimeIdentity
	workerHarnessParentCommit?: string
	workerHarnessSnapshotTreeDigest?: string
	candidateIdNamespace?: string
	maxTrajectories?: number
	maxTotalIterations?: number
	maxRuntimeMs?: number
	protectedPaths: string[]
	developmentProofRule?: DevelopmentProofRule
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
	modelProvider?: string
	inferenceUsage?: {
		provider: "openrouter"
		endpointProvider: string
		profileId?: RsiOpenRouterProfileId
		model: string
		returnedModels: string[]
		returnedProviders: string[]
		calls: number
		promptTokens: number
		completionTokens: number
		totalTokens: number
		costUsd: number
		accounting: "supervisor-enforced"
		qualified: true
		jobId: string
		campaignId: string
		denials: OpenRouterDenialSummary[]
	}
	inferenceDenials?: OpenRouterDenialSummary[]
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
	pairedComparison?: PairedComparison
	developmentProof?: CandidateDevelopmentProof
	workerHarnessExecution?: WorkerHarnessExecution
	trajectory?: TrajectorySummary
}

export interface PairedComparison {
	baselinePasses: number
	candidatePasses: number
	trialCount: number
	baselineDurationMs: number
	candidateDurationMs: number
	durationRatio: number
	improved: boolean
	reason: string
}

export interface TrialResult {
	ok: boolean
	command: string
	exitCode: number | null
	durationMs: number
	stdout: string
	stderr: string
	timedOut?: boolean
	outputArtifactSha256?: string
	outputArtifactBytes?: number
}

export interface EvaluationSummary {
	regression: TrialResult
	typecheck?: TrialResult
	visible: TrialResult[]
	hidden: TrialResult[]
	completed: boolean
	crashed: boolean
	protectedPathViolation: boolean
	changedFiles: string[]
	committed?: boolean
	complexity?: ComplexityMetrics
	failureClassification?: string
	adversarialPass?: boolean
	adversarialPenalty?: number
}

export interface HardGates {
	regressionPass: boolean
	typecheckPass: boolean
	visibleEvalPass: boolean
	hiddenEvalPass: boolean | null
	adversarialPass: boolean
	noProtectedPathViolation: boolean
	completed: boolean
	noCrash: boolean
	committed: boolean
}

export interface Fitness {
	score: number
	components: {
	regression: number
		visible: number | null
		hidden: number | null
		efficiency: number
		recovery: number
	}
	metrics: MetricVector
	complexity: ComplexityMetrics
	paretoRank?: number
	hardGates: HardGates
	reason: string
	adversarialPenalty?: number
}

export interface AdversarialTestCase {
	id: string
	modulePath: string
	exportName: string
	args: unknown[]
	expected: unknown
	reason: string
}

export interface AdversarialFinding {
	severity: "major" | "minor"
	message: string
	testId?: string
}

export interface AdversarialReviewRecord {
	candidateId: string
	role: "adversary"
	provider: RoleModelConfig["provider"]
	model: string
	promptVersion: string
	promptSha256: string
	promptArtifactSha256: string
	summary?: string
	resultSha256?: string
	resultArtifactSha256?: string
	errorSha256?: string
	errorArtifactSha256?: string
	testArtifactSha256?: string
	snapshotArtifactSha256?: string
	createdAt: string
	status: "passed" | "failed" | "error"
	findings: AdversarialFinding[]
	testResults: Array<{ id: string; passed: boolean; outputArtifactSha256?: string; failure?: string }>
	penaltyPoints: number
	jobId?: string
	error?: string
}

export interface RsiRunRecord {
	runId: string
	startedAt: string
	finishedAt?: string
	baseline?: TrialResult
	baselineEvaluation?: EvaluationSummary
	baselineFitness?: Fitness
	model: string
	openRouterProfileId?: RsiOpenRouterProfileId
	baseRef: string
	baseCommit: string
	evaluatorIntegrity?: {
		status: "sealed" | "unsealed"
		inputSha256?: string
		archiveStateSha256?: string
		manifestSha256?: string
		manifestPath?: string
		keyId?: string
		selectedCandidateId?: string
		outputs: Array<{ candidateId: string; taskId: string; outputSha256: string; artifactSha256?: string; artifactBytes?: number }>
		generations: Array<{ generation: number; selectedCandidateIds: string[]; selectedCandidateId?: string; decisionsSha256: string }>
	}
	hiddenVerifierIdentity?: { protocol: string; suiteSha256: string; imageDigest: string; publicKeySha256: string }
	generations: number
	selected?: string
	selectedCandidates?: string[]
	parentSelectionPolicy?: ParentSelectionPolicy
	parentChoices?: Record<string, ParentSelectionReason>
	modelCandidates?: ModelCandidate[]
	combinations?: HarnessModelCombination[]
	jobs?: ExperimentJob[]
	trajectoryRefs?: string[]
	adaptiveSearch?: AdaptiveSearchDecision[]
	curriculumTasks?: CurriculumTask[]
	developmentProofProtocol?: DevelopmentProofProtocol
	workerHarnessMode?: WorkerHarnessMode
	workerHarnessPairId?: string
	workerHarnessConfigDigest?: string
	workerHarnessPlannedGenerations?: number
	workerHarnessSamplingSeed?: string
	workerHarnessRuntime?: WorkerHarnessRuntimeIdentity
	/** Physical candidate/worktree suffix derived from this durable run ID; absent on legacy ordinary runs. */
	candidateIdNamespace?: string
	confirmationEvidence?: "unmeasured" | "complete" | "incomplete"
	confirmationAttempts?: BenchmarkAttempt[]
	proofConfirmation?: {
		selectedHarness: { candidateId: string; slotId: string; generation: number; commit: string; attemptIds: string[] }
		rootHarness: { commit: string; attemptIds: string[] }
	}
	proofCampaign?: {
		manifest: import("./proof-campaign.js").ProofCampaignManifest
		manifestSha256: string
		campaignId: string
		armId: string
		epoch: number
		sequence?: number
		ledgerSnapshot?: Record<string, unknown>
		incompleteReason?: string
		state: "running" | "evaluated" | "selected" | "rejected" | "incomplete" | "finished"
	}
	adversarialReviews?: AdversarialReviewRecord[]
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
	(candidate: CandidateRecord, config: RsiConfig): Promise<{ ok: boolean; result?: TrialResult; error?: string; workerHarnessExecution?: WorkerHarnessExecution }>
}

export interface RsiHooks {
	runCommand?: CommandRunner
	runMutation?: MutationRunner
	runAdversary?: (request: { role: RoleModelConfig; prompt: string }) => Promise<string>
	runDevelopmentBenchmark?: (request: { harnessCommit: string; model: string; outputRoot: string; protocol: DevelopmentProofProtocol }) => Promise<BenchmarkAttempt[]>
	now?: () => string
	log?: (line: string) => void
	/** Marks test-only injected runtimes so integrity records do not imply a production image identity. */
	syntheticRuntimeIdentity?: true
}

export type SpawnedProcess = ChildProcess
