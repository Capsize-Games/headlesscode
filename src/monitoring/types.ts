import type { IterationInterventionTemplateId } from "../engine/types.js"

export { type IterationInterventionTemplateId }

export const MONITOR_FEATURE_ORDER = [
	"identicalCallStreak",
	"sameToolErrorStreak",
	"readOnlyStreak",
	"uniqueCallFraction4",
	"errorFraction4",
	"turnsSinceSuccessfulVirtualWrite",
	"repeatedResultFraction4",
	"iterationBudgetFraction",
] as const

export type MonitorFeatureName = (typeof MONITOR_FEATURE_ORDER)[number]
export type MonitorFeatureVector = Record<MonitorFeatureName, number>

export type PilotArm = "B" | "M" | "R" | "G"
export type FixtureFamily = "wrong-key-path" | "revision-mismatch" | "failed-validation" | "legitimate-investigation"
export type FixtureSplit = "train" | "calibration" | "test"

export interface PilotFileSet {
	readonly [relativePath: string]: string
}

export interface PilotFixture {
	readonly id: string
	readonly family: FixtureFamily
	readonly split: FixtureSplit
	readonly task: string
	readonly initialFiles: PilotFileSet
	readonly targetFiles: PilotFileSet
	readonly unrelatedPaths: readonly string[]
	readonly validator: (files: PilotFileSet) => { ok: boolean; message: string; milestone: number }
	readonly oracle: (files: PilotFileSet) => { success: boolean; reason: string; milestone: number }
}

export interface PilotToolCall {
	readonly id: string
	readonly name: string
	readonly args: Readonly<Record<string, unknown>>
}

export interface PilotToolResult {
	readonly callId: string
	readonly name: string
	readonly isError: boolean
	readonly content: string
	readonly normalizedError?: string
	readonly resultHash: string
}

export interface PilotTurnSummary {
	readonly iteration: number
	readonly calls: readonly PilotToolCall[]
	readonly results: readonly PilotToolResult[]
	readonly readOnly: boolean
	readonly successfulVirtualWrite: boolean
	readonly milestone: number
}

/** Complete supervisor-owned observation. It contains no oracle labels. */
export interface PilotBoundary {
	readonly schemaVersion: 1
	readonly experimentId: string
	readonly runId: string
	readonly attemptId: string
	readonly epoch: number
	readonly sequence: number
	readonly iteration: number
	readonly maxIterations: number
	readonly calls: readonly PilotToolCall[]
	readonly results: readonly PilotToolResult[]
	readonly recentTurns: readonly PilotTurnSummary[]
	readonly virtualRevisionHashes: Readonly<Record<string, string>>
	readonly inputTokens: number
	readonly outputTokens: number
	readonly reasoningAvailable: boolean
	readonly truncationFlags: readonly string[]
	readonly deterministicGuardrails: Readonly<{
		consecutiveMistakes: number
		identicalCallStreak: number
		readOnlyStreak: number
		sameToolErrorStreak: number
		repeatedToolFailureStreak: number
	}>
}

export interface Standardization {
	readonly mean: Record<MonitorFeatureName, number>
	readonly scale: Record<MonitorFeatureName, number>
}

export interface Calibration {
	readonly intercept: number
	readonly slope: number
}

export interface FrozenPredictorArtifact {
	readonly schemaVersion: 1
	readonly featureOrder: readonly MonitorFeatureName[]
	readonly coefficients: Record<MonitorFeatureName, number>
	readonly intercept: number
	readonly standardization: Standardization
	readonly calibration: Calibration
	readonly threshold: number
	readonly l2: 1
	readonly modelDigest: string
	readonly templatesHash: string
	readonly artifactHash: string
}

export interface Prediction {
	readonly probability: number
	readonly threshold: number
	readonly features: MonitorFeatureVector
	readonly featureHash: string
	readonly predictorHash: string
	readonly latencyNs: number
	readonly abstentionReason?: "missing" | "non-finite" | "unknown-model" | "malformed"
}

export interface InterventionDecision {
	readonly interventionId: string
	readonly templateId: IterationInterventionTemplateId
	readonly reason: "threshold" | "random-schedule"
}

export interface PilotInterventionRecord extends InterventionDecision {
	readonly boundarySequence: number
	readonly delivered: boolean
}

export interface PilotBudget {
	readonly maxCalls: 16
	readonly maxTokens: 20_000
	readonly maxWallMs: number
	readonly globalMaxTokens: number
	readonly globalMaxWallMs: number
}

export interface PilotManifest {
	readonly schemaVersion: 1
	readonly experimentId: string
	readonly createdAt: string
	readonly modelDigest: string
	readonly modelSettings: Readonly<Record<string, unknown>>
	readonly fixtureHash: string
	readonly splitHash: string
	readonly templatesHash: string
	readonly featureOrder: readonly MonitorFeatureName[]
	readonly predictorHash?: string
	readonly threshold?: number
	readonly armAssignments: readonly PilotArm[]
	readonly seeds: readonly number[]
	readonly budget: PilotBudget
	readonly randomProbability?: number
	readonly randomBoundaryDistribution?: readonly Readonly<{ boundarySequence: number; weight: number }>[]
}

export interface PilotOutcome {
	readonly experimentId: string
	readonly runId: string
	readonly attemptId: string
	readonly epoch: number
	readonly fixtureId: string
	readonly split: FixtureSplit
	readonly arm: PilotArm
	readonly valid: boolean
	readonly success: boolean
	readonly finalArtifactHash: string
	readonly oracleHash: string
	readonly verifierHash: string
	readonly milestoneCount: number
	readonly redundantCalls: number
	readonly invalidRetries: number
	readonly forbiddenEffectAttempts: number
	readonly experimentalInterventionAttempted: boolean
	readonly correctionDelivered: boolean
	readonly deterministicInterventionCount: number
	readonly tokens: number
	readonly calls: number
	readonly elapsedMs: number
	readonly stopReason: string
	readonly predictionRecords: readonly Prediction[]
	readonly interventions: readonly PilotInterventionRecord[]
	readonly scheduledIntervention: boolean
	readonly scheduledBoundarySequence?: number
	/** Labels are retained only in the outcome analysis, never passed to prediction. */
	readonly detectionLabels: readonly (0 | 1)[]
}
