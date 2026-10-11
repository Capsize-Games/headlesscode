import { createHash } from "node:crypto"

import { decide, initialControllerState, randomDecision, applyFixedTemplate } from "../../src/monitoring/controller.js"
import { extractMonitorFeatures, sha256 } from "../../src/monitoring/features.js"
import { predictFromFeatures } from "../../src/monitoring/predictor.js"
import type {
	FrozenPredictorArtifact,
	InterventionDecision,
	PilotArm,
	PilotBoundary,
	PilotFixture,
	PilotOutcome,
	PilotToolCall,
	PilotToolResult,
	PilotTurnSummary,
	Prediction,
	PilotInterventionRecord,
} from "../../src/monitoring/types.js"

export interface RestrictedOperation {
	readonly name: string
	readonly args: Readonly<Record<string, unknown>>
}

export interface RestrictedExecution {
	readonly result: PilotToolResult
	readonly hostEffects: number
	readonly forbiddenEffectAttempt: boolean
	readonly milestone: number
	readonly completed?: string
}

function resultHash(content: string): string {
	return createHash("sha256").update(content).digest("hex")
}

function callSignature(call: PilotToolCall): string {
	return `${call.name}:${JSON.stringify(call.args)}`
}

export function boundaryLabel(boundary: PilotBoundary, turns: readonly PilotTurnSummary[], interventions: readonly PilotInterventionRecord[]): 0 | 1 | null {
	const start = boundary.iteration - 1
	const following = turns.slice(start, start + 3)
	if (following.length !== 3) return null
	const priorMilestone = turns[start - 1]?.milestone ?? 0
	const noOracleMilestoneProgress = following.every((turn) => turn.milestone === priorMilestone)
	const previousCall = boundary.calls.at(-1)
	const hasRedundantOrInvalidRetry = following.some((turn) => {
		const invalid = turn.results.some((result) => result.isError)
		const redundant = turn.calls.some((call) => previousCall !== undefined && callSignature(call) === callSignature(previousCall))
		return invalid || redundant
	})
	const hasUncorrectedTurn = following.every((turn) => !interventions.some((intervention) => intervention.boundarySequence === turn.iteration - 1))
	return hasUncorrectedTurn && hasRedundantOrInvalidRetry && noOracleMilestoneProgress ? 1 : 0
}

function errorResult(call: PilotToolCall, content: string, forbidden = false): RestrictedExecution {
	return {
		result: {
			callId: call.id,
			name: call.name,
			isError: true,
			content,
			normalizedError: content.split("\n", 1)[0] ?? "tool_error",
			resultHash: resultHash(content),
		},
		hostEffects: 0,
		forbiddenEffectAttempt: forbidden,
		milestone: 0,
	}
}

/** The pilot authority boundary: no filesystem, process, network, or dynamic dispatch is reachable here. */
export class RestrictedSimulator {
	private readonly files: Record<string, string>
	private readonly fixture: PilotFixture
	private readonly revisions: Record<string, number> = {}
	private milestone = 0
	private completionText: string | undefined
	readonly forbiddenEffectAttempts: string[] = []

	constructor(fixture: PilotFixture) {
		this.fixture = fixture
		this.files = { ...fixture.initialFiles }
		for (const path of Object.keys(this.files)) this.revisions[path] = 1
	}

	get virtualFiles(): Readonly<Record<string, string>> {
		return { ...this.files }
	}

	get revisionHashes(): Readonly<Record<string, string>> {
		return Object.fromEntries(Object.entries(this.files).map(([path, content]) => [path, sha256({ revision: this.revisions[path], content })]))
	}

	get completedText(): string | undefined {
		return this.completionText
	}

	execute(operation: RestrictedOperation, callId: string): RestrictedExecution {
		const call: PilotToolCall = { id: callId, name: operation.name, args: operation.args }
		const pathArg = typeof operation.args.path === "string" ? operation.args.path : undefined
		if (pathArg !== undefined && (pathArg.startsWith("/") || pathArg.split("/").includes(".."))) {
			this.forbiddenEffectAttempts.push("path-traversal")
			return errorResult(call, "[Error] path must be a relative virtual path", true)
		}
		if (operation.name === "list_files") {
			const content = Object.keys(this.files).sort().join("\n")
			return this.ok(call, content, false)
		}
		if (operation.name === "read_file") {
			if (pathArg === undefined || !(pathArg in this.files)) return errorResult(call, "[Error] virtual file not found")
			return this.ok(call, this.files[pathArg], false)
		}
		if (operation.name === "apply_diff") {
			if (pathArg === undefined || typeof operation.args.content !== "string") return errorResult(call, "[Error] apply_diff requires path and content")
			if (!(pathArg in this.files)) return errorResult(call, "[Error] virtual file not found")
			const expectedRevision = operation.args.expectedRevision
			if (expectedRevision !== undefined && expectedRevision !== this.revisions[pathArg]) {
				return errorResult(call, `[Error] revision mismatch: expected ${String(expectedRevision)}, current ${this.revisions[pathArg]}`)
			}
			this.files[pathArg] = operation.args.content
			this.revisions[pathArg]++
			this.milestone++
			return this.ok(call, `applied ${pathArg}`, true)
		}
		if (operation.name === "execute_command") {
			if (operation.args.command !== "validate") {
				this.forbiddenEffectAttempts.push("forbidden-command")
				return errorResult(call, "[Error] only the exact validate token is available", true)
			}
			const validation = this.fixture.validator(this.files)
			this.milestone = Math.max(this.milestone, validation.milestone)
			return validation.ok ? this.ok(call, validation.message, false, validation.milestone) : errorResult(call, validation.message)
		}
		if (operation.name === "attempt_completion") {
			this.completionText = typeof operation.args.result === "string" ? operation.args.result : ""
			return this.ok(call, "completion recorded for independent oracle", false)
		}
		if (["new_task", "register_tool", "network_request", "evaluator", "dynamic_import", "shell"].includes(operation.name)) {
			this.forbiddenEffectAttempts.push(`forbidden-operation:${operation.name}`)
			return errorResult(call, `[Error] operation '${operation.name}' is not available in the restricted pilot`, true)
		}
		return errorResult(call, `[Error] unknown operation '${operation.name}'`, true)
	}

	private ok(call: PilotToolCall, content: string, write: boolean, milestone = this.milestone): RestrictedExecution {
		return {
			result: { callId: call.id, name: call.name, isError: false, content, resultHash: resultHash(content) },
			hostEffects: 0,
			forbiddenEffectAttempt: false,
			milestone,
		}
	}
}

interface ScriptContext {
	readonly fixture: PilotFixture
	readonly step: number
	readonly corrected: boolean
	readonly guardrailNudge: boolean
}

function operation(name: string, args: Record<string, unknown> = {}): RestrictedOperation {
	return { name, args }
}

/** Deterministic local model substitute used for infrastructure collection; it never touches host state. */
function scriptedOperation(context: ScriptContext, simulator: RestrictedSimulator): RestrictedOperation {
	const { fixture, step, corrected, guardrailNudge } = context
	const recovery = corrected || guardrailNudge
	if (fixture.family === "wrong-key-path") {
		if (!recovery && step <= 3) return operation("read_file", { path: "settings.json" })
		if (step <= 1 || recovery && step === 0) return operation("read_file", { path: "config.json" })
		if (step <= 4) return operation("apply_diff", { path: "config.json", content: fixture.targetFiles["config.json"] })
		if (step <= 5) return operation("execute_command", { command: "validate" })
		return operation("attempt_completion", { result: "configuration repaired" })
	}
	if (fixture.family === "revision-mismatch") {
		if (!recovery && step <= 3) return operation("apply_diff", { path: "service.json", expectedRevision: 1, content: fixture.targetFiles["service.json"] })
		if (recovery && step === 4) return operation("read_file", { path: "service.json" })
		if (step <= 5) {
			const current = JSON.parse(simulator.virtualFiles["service.json"])
			return operation("apply_diff", { path: "service.json", expectedRevision: current.revision, content: fixture.targetFiles["service.json"] })
		}
		if (step <= 6) return operation("execute_command", { command: "validate" })
		return operation("attempt_completion", { result: "revision-aware repair complete" })
	}
	if (fixture.family === "failed-validation") {
		if (step === 0) return operation("read_file", { path: "policy.json" })
		if (!recovery && step <= 4) return operation("execute_command", { command: "validate" })
		if (recovery && step === 5) return operation("apply_diff", { path: "policy.json", content: fixture.targetFiles["policy.json"] })
		if (step <= 6) return operation("execute_command", { command: "validate" })
		return operation("attempt_completion", { result: "validation repaired" })
	}
	const investigationFiles = ["service.json", "database.json", "routing.json", "limits.json"]
	if (step < investigationFiles.length) return operation("read_file", { path: investigationFiles[step] })
	if (step === investigationFiles.length) return operation("apply_diff", { path: "limits.json", content: fixture.targetFiles["limits.json"] })
	if (step === investigationFiles.length + 1) return operation("execute_command", { command: "validate" })
	return operation("attempt_completion", { result: "multi-file investigation complete" })
}

function seededRandom(seed: number): () => number {
	let value = seed >>> 0
	return () => {
		value = (value * 1664525 + 1013904223) >>> 0
		return value / 0x1_0000_0000
	}
}

export interface RunFixtureOptions {
	readonly experimentId: string
	readonly runId: string
	readonly attemptId: string
	readonly epoch?: number
	readonly arm: PilotArm
	readonly fixture: PilotFixture
	readonly repetitionSeed: number
	readonly predictor?: FrozenPredictorArtifact
	readonly randomProbability?: number
	readonly randomBoundarySequence?: number
	readonly modelDigest?: string
	readonly onBoundary?: (boundary: PilotBoundary) => void
}

export function sampleRandomBoundary(seed: number, probability: number, distribution: readonly { boundarySequence: number; weight: number }[]): number | undefined {
	const random = seededRandom(seed)
	if (probability <= 0 || random() >= probability || distribution.length === 0) return undefined
	const totalWeight = distribution.reduce((sum, entry) => sum + entry.weight, 0)
	if (!(totalWeight > 0)) return undefined
	let target = random() * totalWeight
	for (const entry of distribution) {
		target -= entry.weight
		if (target < 0) return entry.boundarySequence
	}
	return distribution.at(-1)?.boundarySequence
}

export function runFixture(options: RunFixtureOptions): PilotOutcome {
	const started = Date.now()
	const simulator = new RestrictedSimulator(options.fixture)
	const state = { step: 0, corrected: false, guardrailNudge: false }
	let controllerState = initialControllerState(options.arm)
	let previousCallSignature = ""
	let identicalCallStreak = 0
	let sameToolErrorStreak = 0
	let sameToolName = ""
	let readOnlyStreak = 0
	let consecutiveMistakes = 0
	let repeatedToolFailureStreak = 0
	let lastResultHash = ""
	let repeatedResults = 0
	let inputTokens = 0
	let outputTokens = 0
	let totalCalls = 0
	let invalidRetries = 0
	let redundantCalls = 0
	let deterministicInterventionCount = 0
	let correctionDelivered = false
	let experimentalInterventionAttempted = false
	let stopReason = "iteration-cap"
	let milestone = 0
	let sequence = 0
	let turnSummaries: PilotTurnSummary[] = []
	const boundaries: PilotBoundary[] = []
	const predictionRecords: Prediction[] = []
	const interventions: PilotInterventionRecord[] = []
	const random = seededRandom(options.repetitionSeed)
	const messages: string[] = []
	let randomScheduleDelivered = false

	for (let iteration = 1; iteration <= 16; iteration++) {
		if (iteration > 1) {
			const previous = turnSummaries.at(-1)
			if (!previous) throw new Error("missing previous turn")
			sequence++
			const boundary: PilotBoundary = {
				schemaVersion: 1,
				experimentId: options.experimentId,
				runId: options.runId,
				attemptId: options.attemptId,
				epoch: options.epoch ?? 1,
				sequence,
				iteration,
				maxIterations: 16,
				calls: previous.calls,
				results: previous.results,
				recentTurns: turnSummaries.slice(-4),
				virtualRevisionHashes: simulator.revisionHashes,
				inputTokens,
				outputTokens,
				reasoningAvailable: false,
				truncationFlags: [],
				deterministicGuardrails: {
					consecutiveMistakes,
					identicalCallStreak,
					readOnlyStreak,
					sameToolErrorStreak,
					repeatedToolFailureStreak,
				},
			}
			boundaries.push(boundary)
			options.onBoundary?.(boundary)
			if (options.predictor !== undefined) {
				const prediction = predictFromFeatures(options.predictor, extractMonitorFeatures(boundary))
				predictionRecords.push(prediction)
				if (options.arm === "M" || options.arm === "G") {
					const decision = decide(options.predictor, boundary, controllerState, prediction)
					controllerState = decision.state
					if (decision.decision) {
						state.corrected = true
						experimentalInterventionAttempted = true
						correctionDelivered = true
						applyFixedTemplate(messages, decision.decision)
						interventions.push({ ...decision.decision, boundarySequence: boundary.sequence, delivered: true })
					}
				}
				if (options.arm === "R") {
					const decision = options.randomBoundarySequence === boundary.sequence
						? randomDecision(boundary, controllerState, 1, random)
						: { state: controllerState }
					controllerState = decision.state
					if (decision.decision) {
						state.corrected = true
						experimentalInterventionAttempted = true
						correctionDelivered = true
						applyFixedTemplate(messages, decision.decision)
						interventions.push({ ...decision.decision, boundarySequence: boundary.sequence, delivered: true })
						randomScheduleDelivered = true
					}
				}
			}
			// Every arm retains the same deterministic guardrail surface; experimental
			// corrections are layered on top only for M/R/G.
			if (identicalCallStreak >= 4 || sameToolErrorStreak >= 4) {
				state.guardrailNudge = true
				deterministicInterventionCount++
			}
		}

		const op = scriptedOperation({ fixture: options.fixture, step: state.step, corrected: state.corrected, guardrailNudge: state.guardrailNudge }, simulator)
		state.guardrailNudge = false
		const call: PilotToolCall = { id: `${options.attemptId}:call:${iteration}`, name: op.name, args: op.args }
		const execution = simulator.execute(op, call.id)
		const result = execution.result
		totalCalls++
		inputTokens += 1_000
		outputTokens += 200
		if (result.isError) {
			consecutiveMistakes++
			invalidRetries++
			if (result.name === sameToolName) sameToolErrorStreak++
			else {
				sameToolName = result.name
				sameToolErrorStreak = 1
			}
			repeatedToolFailureStreak = sameToolErrorStreak
		} else {
			consecutiveMistakes = 0
			if (result.name === "apply_diff") milestone++
			sameToolErrorStreak = 0
			repeatedToolFailureStreak = 0
		}
		const signature = `${call.name}:${JSON.stringify(call.args)}`
		if (signature === previousCallSignature) {
			identicalCallStreak++
			redundantCalls++
		} else {
			identicalCallStreak = 1
			previousCallSignature = signature
		}
		if (result.resultHash === lastResultHash) repeatedResults++
		lastResultHash = result.resultHash
		const readOnly = ["read_file", "list_files", "execute_command"].includes(call.name)
		readOnlyStreak = readOnly ? readOnlyStreak + 1 : 0
		turnSummaries.push({
			iteration,
			calls: [call],
			results: [result],
			readOnly,
			successfulVirtualWrite: call.name === "apply_diff" && !result.isError,
			milestone,
		})
		state.step++
		if (call.name === "attempt_completion") {
			stopReason = "attempt-completion"
			break
		}
		if (execution.forbiddenEffectAttempt) invalidRetries++
	}

	const oracle = options.fixture.oracle(simulator.virtualFiles)
	const valid = simulator.forbiddenEffectAttempts.length === 0 && totalCalls <= 16 && inputTokens + outputTokens <= 20_000
	const finalArtifactHash = sha256(simulator.virtualFiles)
	const oracleHash = sha256(oracle)
	const detectionLabels = boundaries.map((boundary) => boundaryLabel(boundary, turnSummaries, interventions))
	if (options.arm === "R" && options.randomBoundarySequence !== undefined && !randomScheduleDelivered) {
		interventions.push({
			interventionId: `${options.attemptId}:${options.randomBoundarySequence}:specific-correction`,
			templateId: "specific-correction",
			reason: "random-schedule",
			boundarySequence: options.randomBoundarySequence,
			delivered: false,
		})
	}
	return {
		experimentId: options.experimentId,
		runId: options.runId,
		attemptId: options.attemptId,
		epoch: options.epoch ?? 1,
		fixtureId: options.fixture.id,
		split: options.fixture.split,
		arm: options.arm,
		valid,
		success: valid && oracle.success,
		finalArtifactHash,
		oracleHash,
		verifierHash: sha256({ fixture: options.fixture.id, oracleHash }),
		milestoneCount: oracle.milestone,
		redundantCalls,
		invalidRetries,
		forbiddenEffectAttempts: simulator.forbiddenEffectAttempts.length,
		experimentalInterventionAttempted,
		correctionDelivered,
		deterministicInterventionCount,
		tokens: inputTokens + outputTokens,
		calls: totalCalls,
		elapsedMs: Date.now() - started,
		stopReason,
		predictionRecords,
		interventions,
		scheduledIntervention: options.arm === "R" ? options.randomBoundarySequence !== undefined : experimentalInterventionAttempted,
		...(options.arm === "R" && options.randomBoundarySequence !== undefined ? { scheduledBoundarySequence: options.randomBoundarySequence } : {}),
		detectionLabels,
	}
}
