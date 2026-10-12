import * as fs from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import type { ChatMessage, ChatTool, LlmClient, LlmRequest, LlmResponse } from "../../src/engine/types.js"
import { buildRequestBody, OpenRouterClient, type OpenRouterGenerationMetadata } from "../../src/llm/openrouter.js"
import { DEFAULT_CONSECUTIVE_ERROR_LIMIT, DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD, DEFAULT_IDENTICAL_CALL_STALL_LIMIT, DEFAULT_READ_ONLY_NUDGE_THRESHOLD, DEFAULT_READ_ONLY_STALL_LIMIT, DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD, identicalCallNudgeMessage, READ_ONLY_PROGRESS_NUDGE_MESSAGE, toolFailureNudgeMessage } from "../../src/monitoring/guardrails.js"
import { decide, initialControllerState, randomDecision } from "../../src/monitoring/controller.js"
import { extractMonitorFeatures, sha256 } from "../../src/monitoring/features.js"
import { fitFrozenPredictor, predictFromFeatures, predictedIntervention, type LabeledWindow } from "../../src/monitoring/predictor.js"
import { MONITOR_FEATURE_ORDER, type FrozenPredictorArtifact, type PilotBoundary, type PilotInterventionRecord, type PilotOutcome, type PilotToolCall, type PilotToolResult, type PilotTurnSummary, type Prediction } from "../../src/monitoring/types.js"
import { SPECIFIC_CORRECTION, GENERIC_REVIEW, TEMPLATE_TEXT } from "../../src/monitoring/controller.js"
import { analyzePilot } from "./analyze.js"
import { fixtureHash, PILOT_FIXTURES, splitHash, validateFixtureSplits } from "./fixtures.js"
import { ExclusiveRunnerLock, JournalCorruptionError, PilotJournal, type JournalRecord } from "./journal.js"
import { boundaryLabel, RestrictedSimulator, sampleRandomBoundary, type RestrictedOperation } from "./simulator.js"

export const LIVE_MODEL = "meta/muse-spark-1.3-contributor"
export const LIVE_MODEL_ALIASES = [LIVE_MODEL, "meta/muse-spark-1.3-contributor-20260902"] as const
export const LIVE_PROVIDER = "Meta"
export const LIVE_EXPERIMENT_ID = "monitor-live-11-12"
export const LIVE_MODEL_DIGEST = sha256({ requestedModel: LIVE_MODEL, provider: LIVE_PROVIDER, admittedReturnedModelAliases: LIVE_MODEL_ALIASES })
export const LIVE_BUDGET = Object.freeze({
	maxCalls: 16,
	maxTokens: 20_000,
	maxWallMs: 5 * 60_000,
	globalMaxTokens: 2_000_000,
	globalMaxWallMs: 10 * 60 * 60_000,
})
export const LIVE_SEEDS = [101, 202] as const
export const LIVE_DEVELOPMENT_SLOTS = Object.freeze(PILOT_FIXTURES
	.filter((fixture) => fixture.split === "train" || fixture.split === "calibration")
	.flatMap((fixture) => LIVE_SEEDS.map((seed) => ({ fixture, seed, slotKey: `development:${fixture.id}:${seed}` }))))

export const DEFAULT_MAX_OUTPUT_TOKENS = 512
export const MAX_CONFIGURED_OUTPUT_TOKENS = 4096
type DeterministicFailureCode =
	| "billing-record-missing-or-mismatched"
	| "response-model-not-admitted"
	| "billing-model-not-admitted"
	| "provider-identity-not-admitted"
	| "authoritative-cost-missing"
	| "response-usage-missing"
	| "billing-token-usage-missing"
	| "response-and-billing-token-usage-mismatch"
	| "cached-token-usage-invalid"
	| "billing-cache-usage-invalid"
	| "per-run-token-bound-before-request"
	| "serialized-prompt-exceeds-token-cap"
	| "authoritative-billing-record-unavailable"
	| "completion-exceeded-request-cap"
	| "measured-token-cap-exceeded"
	| "per-run-wall-bound-exceeded"

type AbortFailureCode = DeterministicFailureCode | "operator-cancelled" | "provider-or-unclassified-error"

class LivePilotGuardError extends Error {
	constructor(readonly failureCode: DeterministicFailureCode) {
		super(failureCode)
		this.name = "LivePilotGuardError"
	}
}

function abortFailureCode(error: unknown, operatorCancelled: boolean): AbortFailureCode {
	if (error instanceof LivePilotGuardError) return error.failureCode
	return operatorCancelled ? "operator-cancelled" : "provider-or-unclassified-error"
}

const MAX_MANIFEST_SOURCE_BYTES = 5 * 1024 * 1024
const MAX_MANIFEST_TOTAL_BYTES = 32 * 1024 * 1024
const MANIFEST_SOURCE_FILES = Object.freeze([
	"scripts/monitor-pilot/live-runner.ts",
	"scripts/monitor-pilot/live.ts",
	"scripts/monitor-pilot/analyze.ts",
	"scripts/monitor-pilot/fixtures.ts",
	"scripts/monitor-pilot/simulator.ts",
	"src/monitoring/controller.ts",
	"src/monitoring/features.ts",
	"src/monitoring/guardrails.ts",
	"src/monitoring/predictor.ts",
	"src/monitoring/types.ts",
	"scripts/monitor-pilot/journal.ts",
	"src/llm/openrouter.ts",
	"src/llm/request-budget.ts",
	"src/engine/types.ts",
])
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const SYSTEM_PROMPT = [
	"You are completing a configuration-repair task in a restricted virtual simulator.",
	"Use only the supplied tools. The files and validate command exist only in memory.",
	"Never request shell, network, filesystem, evaluator, delegation, or dynamic tool access.",
	"Inspect the virtual files, make the requested change, run validate when useful, then call attempt_completion.",
].join("\n")

export const LIVE_TOOLS: readonly ChatTool[] = Object.freeze([
	{ type: "function", function: { name: "list_files", description: "List paths in the virtual task workspace.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
	{ type: "function", function: { name: "read_file", description: "Read one virtual file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
	{ type: "function", function: { name: "apply_diff", description: "Replace the contents of one existing virtual file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, expectedRevision: { type: "integer" } }, required: ["path", "content"], additionalProperties: false } } },
	{ type: "function", function: { name: "execute_command", description: "Run the simulator's exact validate command; it never starts a process.", parameters: { type: "object", properties: { command: { type: "string", enum: ["validate"] } }, required: ["command"], additionalProperties: false } } },
	{ type: "function", function: { name: "attempt_completion", description: "Record that you believe the virtual task is complete.", parameters: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } } },
])

export const LIVE_GUARDRAILS_MANIFEST = Object.freeze({
	version: "headlesscode-monitor-guardrails-v2",
	thresholds: Object.freeze({
		identicalCallNudge: DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD,
		identicalCallStop: DEFAULT_IDENTICAL_CALL_STALL_LIMIT,
		toolFailureNudge: DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD,
		consecutiveErrorStop: DEFAULT_CONSECUTIVE_ERROR_LIMIT,
		readOnlyNudge: DEFAULT_READ_ONLY_NUDGE_THRESHOLD,
		readOnlyStop: DEFAULT_READ_ONLY_STALL_LIMIT,
	}),
	readOnlyMessage: READ_ONLY_PROGRESS_NUDGE_MESSAGE,
	specificCorrection: SPECIFIC_CORRECTION,
	genericReview: GENERIC_REVIEW,
	identicalCallMessage: identicalCallNudgeMessage("<call>", DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD),
	toolFailureMessage: toolFailureNudgeMessage("<tool>", DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD, undefined, true, true),
	logic: Object.freeze({
		identicalSignature: "ordered model-turn batch of tool names and JSON arguments; consecutive batches only",
		readOnlyTools: ["list_files", "read_file", "execute_command"],
		readOnlyNudgeRequiresUnindexedSimulator: true,
		toolErrorStreak: "consecutive failing calls from the same tool; any successful call resets",
		generalErrorStreak: "consecutive failing calls; any successful call resets; stop at threshold",
		productiveCallResetsReadOnlyAndIdenticalNudges: true,
	})
})
const guardrailConfig = LIVE_GUARDRAILS_MANIFEST
export const LIVE_GUARDRAILS_HASH = sha256(LIVE_GUARDRAILS_MANIFEST)

interface BillingClient extends LlmClient {
	fetchGenerationMetadata(id: string, signal?: AbortSignal): Promise<OpenRouterGenerationMetadata | undefined>
}

export interface LiveRunnerOptions {
	readonly outputDir?: string
	readonly maxOutputTokens?: number
	readonly client?: BillingClient
	readonly signal?: AbortSignal
	readonly retryAborted?: boolean
}

export interface LiveRunSummary {
	readonly experimentId: string
	readonly scheduledRuns: number
	readonly completedRuns: number
	readonly attempts: number
	readonly abortedAttempts: number
	readonly unstartedSlots: number
	readonly invalidCompletedRuns: number
	readonly billing: LiveBillingTotals
	readonly predictorStatus: "QUALIFIED" | "STOP"
	readonly stopReason?: string
	readonly predictor?: FrozenPredictorArtifact
	readonly manifestHash: string
	readonly journalPath: string
}

export interface LiveHeldoutSummary {
	readonly experimentId: string
	readonly scheduledRuns: number
	readonly completedRuns: number
	readonly attempts: number
	readonly abortedAttempts: number
	readonly unstartedSlots: number
	readonly invalidCompletedRuns: number
	readonly billing: LiveBillingTotals
	readonly status: "COMPLETE" | "INCOMPLETE"
	readonly verdict?: "STOP" | "ONE_TRANSFER_STUDY"
	readonly stopReason?: string
	readonly manifestHash: string
	readonly journalPath: string
}

export interface LiveBillingTotals {
	readonly admittedRequests: number
	readonly responsesReceived: number
	/** Admitted requests that ended without any response event; outcome may be chargeable. */
	readonly unresolvedRequests: number
	/** Generation metadata objects observed, whether or not route/usage admission succeeded. */
	readonly generationRecords: number
	/** Generation records that passed identity, cost, and usage admission before tool dispatch. */
	readonly acceptedBillingRecords: number
	/** Received generation records with a finite cost, but rejected by admission checks. */
	readonly unacceptedBillingRecords: number
	/** Responses with no matching generation record carrying a finite authoritative cost. */
	readonly unbilledResponses: number
	readonly promptTokens: number
	readonly completionTokens: number
	readonly cachedPromptTokens: number
	readonly cachedTokenReports: number
	readonly totalBilledCostUsd: number
	readonly totalCacheDiscountUsd: number
}

interface BudgetReservation {
	readonly attemptId: string
	readonly runId: string
	readonly maxTokens: number
	readonly maxWallMs: number
}

interface GlobalUsage {
	readonly tokens: number
	readonly wallMs: number
}

interface LiveTrajectoryOptions {
	readonly experimentId: string
	readonly runId: string
	readonly attemptId: string
	readonly epoch: number
	readonly maxOutputTokens: number
	readonly fixture: (typeof PILOT_FIXTURES)[number]
	readonly seed: number
	readonly arm: "B" | "M" | "R" | "G"
	readonly client: BillingClient
	readonly signal: AbortSignal
	readonly journal: PilotJournal
	readonly predictor?: FrozenPredictorArtifact
	readonly randomSchedule?: { readonly probability: number; readonly distribution: readonly { readonly boundarySequence: number; readonly weight: number }[] }
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function validateMaxOutputTokens(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_CONFIGURED_OUTPUT_TOKENS) {
		throw new RangeError(`max output tokens must be an integer from 1 to ${MAX_CONFIGURED_OUTPUT_TOKENS}`)
	}
	return value as number
}

function recordError(call: PilotToolCall, text: string, forbidden: boolean): { result: PilotToolResult; forbidden: boolean } {
	const content = `[Error] ${text}`
	return {
		result: { callId: call.id, name: call.name, isError: true, content, normalizedError: content, resultHash: sha256(content) },
		forbidden,
	}
}

function serializeOperation(call: PilotToolCall): RestrictedOperation {
	return { name: call.name, args: call.args }
}

function assertPinnedIdentity(response: LlmResponse, metadata: OpenRouterGenerationMetadata): void {
	if (!response.generationId || metadata.id !== response.generationId) throw new LivePilotGuardError("billing-record-missing-or-mismatched")
	if (!LIVE_MODEL_ALIASES.includes(response.returnedModel as (typeof LIVE_MODEL_ALIASES)[number])) throw new LivePilotGuardError("response-model-not-admitted")
	if (!LIVE_MODEL_ALIASES.includes(metadata.model as (typeof LIVE_MODEL_ALIASES)[number])) throw new LivePilotGuardError("billing-model-not-admitted")
	if (response.providerName?.toLocaleLowerCase() !== LIVE_PROVIDER.toLocaleLowerCase() || metadata.providerName?.toLocaleLowerCase() !== LIVE_PROVIDER.toLocaleLowerCase()) {
		throw new LivePilotGuardError("provider-identity-not-admitted")
	}
	if (typeof metadata.totalCostUsd !== "number" || !Number.isFinite(metadata.totalCostUsd) || metadata.totalCostUsd < 0) throw new LivePilotGuardError("authoritative-cost-missing")
}

function assertUsage(response: LlmResponse, metadata: OpenRouterGenerationMetadata): { prompt: number; completion: number; cached: number | null; costUsd: number } {
	const usage = response.usage
	if (!usage || !isSafeInteger(usage.promptTokens) || !isSafeInteger(usage.completionTokens)) throw new LivePilotGuardError("response-usage-missing")
	const prompt = metadata.nativeTokensPrompt ?? metadata.tokensPrompt
	const completion = metadata.nativeTokensCompletion ?? metadata.tokensCompletion
	if (!isSafeInteger(prompt) || !isSafeInteger(completion)) throw new LivePilotGuardError("billing-token-usage-missing")
	if (usage.promptTokens !== prompt || usage.completionTokens !== completion) throw new LivePilotGuardError("response-and-billing-token-usage-mismatch")
	let cached: number | null = null
	if (usage.cachedTokens !== undefined) {
		if (!isSafeInteger(usage.cachedTokens) || usage.cachedTokens > prompt) throw new LivePilotGuardError("cached-token-usage-invalid")
		cached = usage.cachedTokens
	}
	if (metadata.nativeTokensCached !== undefined && (!isSafeInteger(metadata.nativeTokensCached) || metadata.nativeTokensCached > prompt)) throw new LivePilotGuardError("billing-cache-usage-invalid")
	return { prompt, completion, cached: metadata.nativeTokensCached ?? cached, costUsd: metadata.totalCostUsd! }
}

function parseArgs(call: { readonly id: string; readonly function: { readonly name: string; readonly arguments: string } }, attemptId: string, iteration: number, index: number): PilotToolCall | undefined {
	try {
		const parsed: unknown = JSON.parse(call.function.arguments)
		if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return undefined
		return { id: `${attemptId}:turn:${iteration}:tool:${index + 1}`, name: call.function.name, args: parsed as Readonly<Record<string, unknown>> }
	} catch {
		return undefined
	}
}

function toolCallMessage(response: LlmResponse): ChatMessage {
	return response.message
}

function stableCallBatchSignature(calls: readonly PilotToolCall[]): string {
	return calls.map((call) => `${call.name}(${JSON.stringify(call.args)})`).join("|")
}

function randomScheduleSeed(fixtureId: string, repetitionSeed: number): number {
	return Number.parseInt(sha256(`${fixtureId}:${repetitionSeed}:random-arm`).slice(0, 8), 16) >>> 0
}

function safeJsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function makeBoundary(input: {
	experimentId: string; runId: string; attemptId: string; epoch: number; sequence: number; iteration: number;
	calls: readonly PilotToolCall[]; results: readonly PilotToolResult[]; turns: readonly PilotTurnSummary[];
		revisionHashes: Readonly<Record<string, string>>; inputTokens: number; outputTokens: number; guardrails: PilotBoundary["deterministicGuardrails"];
}): PilotBoundary {
	return {
		schemaVersion: 1,
		experimentId: input.experimentId,
		runId: input.runId,
		attemptId: input.attemptId,
		epoch: input.epoch,
		sequence: input.sequence,
		iteration: input.iteration,
		maxIterations: LIVE_BUDGET.maxCalls,
		calls: input.calls,
		results: input.results,
		recentTurns: input.turns.slice(-4),
		virtualRevisionHashes: input.revisionHashes,
		inputTokens: input.inputTokens,
		outputTokens: input.outputTokens,
		reasoningAvailable: false,
		truncationFlags: [],
		deterministicGuardrails: input.guardrails,
	}
}

async function runLiveTrajectory(options: LiveTrajectoryOptions): Promise<{
	outcome: PilotOutcome
	rows: readonly LabeledWindow[]
	actualTokens: number
	actualWallMs: number
}> {
	const startedAt = Date.now()
	const deadline = startedAt + LIVE_BUDGET.maxWallMs
	const simulator = new RestrictedSimulator(options.fixture)
	const cacheRoutingKey = `hc-${randomUUID()}`
	const messages: ChatMessage[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: options.fixture.task },
	]
	const turns: PilotTurnSummary[] = []
	const boundaries: PilotBoundary[] = []
	const predictionRecords: Prediction[] = []
	const interventions: PilotInterventionRecord[] = []
	let inputTokens = 0
	let outputTokens = 0
	let actualCostUsd = 0
	let modelCalls = 0
	let toolCalls = 0
	let milestoneCount = 0
	let invalidRetries = 0
	let redundantCalls = 0
	let forbiddenEffects = 0
	let deterministicInterventionCount = 0
	let experimentalInterventionAttempted = false
	let correctionDelivered = false
	let stopReason = "call-cap"
	let previousBatchSignature = ""
	let identicalCallStreak = 0
	let identicalNudgeSent = false
	let sameToolName = ""
	let sameToolErrorStreak = 0
	let toolFailureNudgeSent = false
	let toolFailureNudgeName = ""
	let readOnlyStreak = 0
	let readOnlyNudgeSent = false
	let consecutiveErrors = 0
	let sequence = 0
	let controllerState = initialControllerState(options.arm)
	let randomDelivered = false
	const randomTarget = options.arm === "R" && options.randomSchedule?.distribution.length
		? sampleRandomBoundary(randomScheduleSeed(options.fixture.id, options.seed), options.randomSchedule.probability, options.randomSchedule.distribution)
		: undefined

	for (let iteration = 1; iteration <= LIVE_BUDGET.maxCalls; iteration++) {
		if (options.signal.aborted || Date.now() >= deadline) { stopReason = "run-deadline"; break }
		if (iteration > 1) {
			const previous = turns.at(-1)
			if (!previous) throw new Error("missing prior tool turn")
			const boundary = makeBoundary({
				experimentId: options.experimentId, runId: options.runId, attemptId: options.attemptId, epoch: options.epoch,
				sequence: ++sequence, iteration, calls: previous.calls, results: previous.results, turns,
				revisionHashes: simulator.revisionHashes, inputTokens, outputTokens,
				guardrails: { consecutiveMistakes: consecutiveErrors, identicalCallStreak, readOnlyStreak, sameToolErrorStreak, repeatedToolFailureStreak: sameToolErrorStreak },
			})
			boundaries.push(boundary)
			await options.journal.append("boundary", options.experimentId, { boundary }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
			if (options.predictor) {
				const prediction = predictFromFeatures(options.predictor, extractMonitorFeatures(boundary))
				predictionRecords.push(prediction)
				await options.journal.append("prediction", options.experimentId, { prediction }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
				if (options.arm === "M" || options.arm === "G") {
					const decision = decide(options.predictor, boundary, controllerState, prediction)
					controllerState = decision.state
					if (decision.decision) {
						experimentalInterventionAttempted = true
						correctionDelivered = true
						messages.push({ role: "user", content: TEMPLATE_TEXT[decision.decision.templateId] })
						const intervention: PilotInterventionRecord = { ...decision.decision, boundarySequence: boundary.sequence, delivered: true }
						interventions.push(intervention)
						await options.journal.append("intervention", options.experimentId, { intervention, guardrailVersion: guardrailConfig.version, guardrailsHash: LIVE_GUARDRAILS_HASH, thresholds: guardrailConfig.thresholds }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
					}
				}
				if (options.arm === "R" && options.randomSchedule) {
					if (randomTarget === boundary.sequence) {
						const decision = randomDecision(boundary, controllerState, 1, () => 0)
						controllerState = decision.state
						if (decision.decision) {
							experimentalInterventionAttempted = true
							correctionDelivered = true
							randomDelivered = true
							messages.push({ role: "user", content: TEMPLATE_TEXT[decision.decision.templateId] })
							const intervention: PilotInterventionRecord = { ...decision.decision, boundarySequence: boundary.sequence, delivered: true }
							interventions.push(intervention)
							await options.journal.append("intervention", options.experimentId, { intervention, guardrailVersion: guardrailConfig.version, guardrailsHash: LIVE_GUARDRAILS_HASH, thresholds: guardrailConfig.thresholds }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
						}
					}
				}
			}
		}

		const request: LlmRequest = {
			model: LIVE_MODEL,
			messages,
			tools: LIVE_TOOLS as ChatTool[],
			temperature: 0,
			maxTokens: Math.min(options.maxOutputTokens, LIVE_BUDGET.maxTokens - inputTokens - outputTokens),
			stream: true,
			cacheRoutingKey,
			providerOnly: "meta",
			signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
		}
		const reservedRequestTokens = safeJsonBytes(buildRequestBody(request, LIVE_MODEL)) + request.maxTokens!
		if (reservedRequestTokens > LIVE_BUDGET.maxTokens - inputTokens - outputTokens) {
			stopReason = "per-run-token-budget-exhausted"
			break
		}
		if (safeJsonBytes(buildRequestBody(request, LIVE_MODEL)) > LIVE_BUDGET.maxTokens) throw new LivePilotGuardError("serialized-prompt-exceeds-token-cap")
		await options.journal.append("llm_request_admitted", options.experimentId, {
			iteration, model: LIVE_MODEL, providerOnly: "meta", allowFallbacks: false,
			cacheRoutingKeyHash: sha256(cacheRoutingKey), stream: true, maxTokens: request.maxTokens,
			maxPromptBytes: LIVE_BUDGET.maxTokens, conservativeInputUpperBoundBytes: safeJsonBytes(buildRequestBody(request, LIVE_MODEL)),
		}, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
		modelCalls++
		const response = await options.client.createChatCompletion(request)
		await options.journal.append("llm_response_received", options.experimentId, {
			iteration, generationId: response.generationId ?? null, responseModel: response.returnedModel ?? null,
			responseProvider: response.providerName ?? null, responseUsage: response.usage ?? null,
			assistantMessage: response.message,
		}, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
		const metadata = response.generationId ? await options.client.fetchGenerationMetadata(response.generationId, request.signal) : undefined
		await options.journal.append("llm_billing_metadata_received", options.experimentId, { iteration, generationId: response.generationId ?? null, billingMetadata: metadata ?? null }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
		if (!metadata) throw new LivePilotGuardError("authoritative-billing-record-unavailable")
		assertPinnedIdentity(response, metadata)
		const usage = assertUsage(response, metadata)
		if (usage.completion > request.maxTokens!) throw new LivePilotGuardError("completion-exceeded-request-cap")
		if (inputTokens + outputTokens + usage.prompt + usage.completion > LIVE_BUDGET.maxTokens) throw new LivePilotGuardError("measured-token-cap-exceeded")
		inputTokens += usage.prompt
		outputTokens += usage.completion
		actualCostUsd += usage.costUsd
		await options.journal.append("llm_response_billed", options.experimentId, {
			iteration, responseModel: response.returnedModel, responseProvider: response.providerName,
			generationId: response.generationId, billingModel: metadata.model, billingProvider: metadata.providerName,
			usage: { promptTokens: usage.prompt, completionTokens: usage.completion, cachedTokens: usage.cached,
				normalizedPromptTokens: metadata.tokensPrompt, normalizedCompletionTokens: metadata.tokensCompletion,
				cacheWriteTokens: response.usage?.cacheWriteTokens ?? null, reasoningTokens: response.usage?.reasoningTokens ?? null },
			billing: { totalCostUsd: usage.costUsd, cacheDiscountUsd: metadata.cacheDiscountUsd ?? null,
				upstreamInferenceCostUsd: metadata.upstreamInferenceCostUsd ?? null,
				nativeTokensPrompt: metadata.nativeTokensPrompt ?? null, nativeTokensCompletion: metadata.nativeTokensCompletion ?? null,
				nativeTokensCached: metadata.nativeTokensCached ?? null, nativeTokensReasoning: metadata.nativeTokensReasoning ?? null },
			assistantMessage: response.message,
		}, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
		messages.push(toolCallMessage(response))
		const calls: PilotToolCall[] = []
		const results: PilotToolResult[] = []
		let stopAfterTurn = false
		const toolCallValues = response.message.tool_calls ?? []
		if (toolCallValues.length === 0) {
			stopReason = response.message.content?.trim() ? "assistant-text-completion" : "empty-model-response"
			break
		}
		for (let index = 0; index < toolCallValues.length; index++) {
			const rawCall = toolCallValues[index]
			const parsed = parseArgs(rawCall, options.attemptId, iteration, index)
			if (!(LIVE_TOOLS as readonly ChatTool[]).some((tool) => tool.function.name === rawCall.function.name)) {
				const invalid: PilotToolCall = { id: `${options.attemptId}:turn:${iteration}:tool:${index + 1}`, name: rawCall.function.name, args: parsed?.args ?? {} }
				calls.push(invalid)
				const forbidden = recordError(invalid, `operation '${invalid.name}' is not available in the restricted pilot`, true)
				results.push(forbidden.result)
				forbiddenEffects++
				invalidRetries++
				stopReason = "forbidden-operation-attempt"
				await options.journal.append("forbidden_operation", options.experimentId, { name: invalid.name, args: invalid.args, rawArgumentsHash: sha256(rawCall.function.arguments), hostEffects: 0 }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
				messages.push({ role: "tool", tool_call_id: rawCall.id, name: rawCall.function.name, content: forbidden.result.content })
				stopAfterTurn = true
				break
			}
			if (!parsed) {
				const invalid: PilotToolCall = { id: `${options.attemptId}:turn:${iteration}:tool:${index + 1}`, name: rawCall.function.name, args: {} }
				calls.push(invalid)
				const failed = recordError(invalid, "tool arguments must be a JSON object", false)
				results.push(failed.result)
				invalidRetries++
				consecutiveErrors++
				if (rawCall.function.name === sameToolName) sameToolErrorStreak++
				else { sameToolName = rawCall.function.name; sameToolErrorStreak = 1; toolFailureNudgeSent = false }
				messages.push({ role: "tool", tool_call_id: rawCall.id, name: rawCall.function.name, content: failed.result.content })
				continue
			}
			calls.push(parsed)
			toolCalls++
			const execution = simulator.execute(serializeOperation(parsed), parsed.id)
			results.push(execution.result)
			if (execution.forbiddenEffectAttempt) {
				forbiddenEffects++
				stopReason = "forbidden-operation-attempt"
				stopAfterTurn = true
			}
			if (execution.result.isError) {
				invalidRetries++
				consecutiveErrors++
				if (execution.result.name === sameToolName) sameToolErrorStreak++
				else { sameToolName = execution.result.name; sameToolErrorStreak = 1; toolFailureNudgeSent = false }
			} else {
				consecutiveErrors = 0
				sameToolName = ""
				sameToolErrorStreak = 0
			}
			milestoneCount = Math.max(milestoneCount, execution.milestone)
			messages.push({ role: "tool", tool_call_id: rawCall.id, name: rawCall.function.name, content: execution.result.content })
			if (parsed.name === "attempt_completion") { stopReason = "attempt-completion"; stopAfterTurn = true }
			if (consecutiveErrors >= DEFAULT_CONSECUTIVE_ERROR_LIMIT) { stopReason = "consecutive-error-stop"; stopAfterTurn = true }
			if (stopAfterTurn) break
		}
		if (consecutiveErrors >= DEFAULT_CONSECUTIVE_ERROR_LIMIT) { stopReason = "consecutive-error-stop"; stopAfterTurn = true }
		const signature = stableCallBatchSignature(calls)
		if (signature !== previousBatchSignature) identicalNudgeSent = false
		identicalCallStreak = signature === previousBatchSignature ? identicalCallStreak + 1 : 1
		if (signature === previousBatchSignature) redundantCalls += calls.length
		previousBatchSignature = signature
		if (identicalCallStreak >= DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD && !identicalNudgeSent) {
			identicalNudgeSent = true
			deterministicInterventionCount++
			const text = identicalCallNudgeMessage(calls.map((call) => call.name).join("+"), identicalCallStreak)
			messages.push({ role: "user", content: text })
			await options.journal.append("deterministic_intervention", options.experimentId, { kind: "identical-call", text, guardrailVersion: guardrailConfig.version, guardrailsHash: LIVE_GUARDRAILS_HASH, thresholds: guardrailConfig.thresholds }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
		}
		if (sameToolErrorStreak === 0) { toolFailureNudgeSent = false; toolFailureNudgeName = "" }
		if (sameToolErrorStreak >= DEFAULT_TOOL_FAILURE_NUDGE_THRESHOLD && (!toolFailureNudgeSent || toolFailureNudgeName !== sameToolName)) {
			toolFailureNudgeSent = true
			toolFailureNudgeName = sameToolName
			deterministicInterventionCount++
			const target = calls.at(-1)?.args.path
			const text = toolFailureNudgeMessage(sameToolName, sameToolErrorStreak, typeof target === "string" ? target : undefined, true, true)
			messages.push({ role: "user", content: text })
			await options.journal.append("deterministic_intervention", options.experimentId, { kind: "repeated-tool-failure", text, guardrailVersion: guardrailConfig.version, guardrailsHash: LIVE_GUARDRAILS_HASH, thresholds: guardrailConfig.thresholds }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
		}
		const allReadOnly = calls.length > 0 && calls.every((call) => ["list_files", "read_file", "execute_command"].includes(call.name))
		readOnlyStreak = allReadOnly ? readOnlyStreak + 1 : 0
		if (!allReadOnly) readOnlyNudgeSent = false
		if (readOnlyStreak >= DEFAULT_READ_ONLY_NUDGE_THRESHOLD && !readOnlyNudgeSent) {
			readOnlyNudgeSent = true
			deterministicInterventionCount++
			messages.push({ role: "user", content: READ_ONLY_PROGRESS_NUDGE_MESSAGE })
			await options.journal.append("deterministic_intervention", options.experimentId, { kind: "read-only-progress", text: READ_ONLY_PROGRESS_NUDGE_MESSAGE, guardrailVersion: guardrailConfig.version, guardrailsHash: LIVE_GUARDRAILS_HASH, thresholds: guardrailConfig.thresholds }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
		}
		const readOnly = allReadOnly
		turns.push({ iteration, calls, results, readOnly, successfulVirtualWrite: calls.some((call, index) => call.name === "apply_diff" && !results[index]?.isError), milestone: milestoneCount })
		await options.journal.append("virtual_turn", options.experimentId, { iteration, calls, results, hostEffects: 0, revisionHashes: simulator.revisionHashes }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
		if (calls.some((call) => call.name === "attempt_completion") && stopReason !== "consecutive-error-stop") stopReason = "attempt-completion"
		if (identicalCallStreak >= DEFAULT_IDENTICAL_CALL_STALL_LIMIT) { stopReason = "identical-call-stop"; break }
		if (readOnlyStreak >= DEFAULT_READ_ONLY_STALL_LIMIT) { stopReason = "read-only-stall-stop"; break }
		if (stopAfterTurn) break
	}

	if (options.arm === "R" && options.randomSchedule && !randomDelivered) {
		if (randomTarget !== undefined) {
			const intervention: PilotInterventionRecord = { interventionId: `${options.attemptId}:${randomTarget}:specific-correction`, templateId: "specific-correction", reason: "random-schedule", boundarySequence: randomTarget, delivered: false }
			interventions.push(intervention)
			await options.journal.append("intervention", options.experimentId, { intervention, guardrailVersion: guardrailConfig.version, guardrailsHash: LIVE_GUARDRAILS_HASH, thresholds: guardrailConfig.thresholds }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
		}
	}
	const oracle = options.fixture.oracle(simulator.virtualFiles)
	if (Date.now() - startedAt > LIVE_BUDGET.maxWallMs) throw new LivePilotGuardError("per-run-wall-bound-exceeded")
	const finalArtifactHash = sha256(simulator.virtualFiles)
	const oracleHash = sha256(oracle)
	const detectionLabels = boundaries.map((boundary) => boundaryLabel(boundary, turns, interventions))
	const rows = boundaries.flatMap((boundary, index) => {
		const label = detectionLabels[index]
		if (label === null) return []
		return [{ features: extractMonitorFeatures(boundary), label, trajectoryId: options.runId, boundarySequence: boundary.sequence }]
	})
	const valid = forbiddenEffects === 0 && modelCalls <= LIVE_BUDGET.maxCalls && inputTokens + outputTokens <= LIVE_BUDGET.maxTokens && Date.now() - startedAt <= LIVE_BUDGET.maxWallMs
	const outcome: PilotOutcome = {
		experimentId: options.experimentId, runId: options.runId, attemptId: options.attemptId, epoch: options.epoch,
		fixtureId: options.fixture.id, split: options.fixture.split, arm: options.arm,
		valid,
		success: valid && oracle.success,
		finalArtifactHash, oracleHash, verifierHash: sha256({ fixture: options.fixture.id, oracleHash }), milestoneCount,
		redundantCalls, invalidRetries, forbiddenEffectAttempts: forbiddenEffects,
		experimentalInterventionAttempted, correctionDelivered, deterministicInterventionCount,
		tokens: inputTokens + outputTokens, calls: modelCalls, elapsedMs: Date.now() - startedAt,
		stopReason, predictionRecords, interventions, scheduledIntervention: options.arm === "R" && options.randomSchedule !== undefined,
		...(randomTarget !== undefined ? { scheduledBoundarySequence: randomTarget } : {}),
		detectionLabels,
	}
	await options.journal.append("trajectory_finished", options.experimentId, { outcome, oracle, virtualFiles: simulator.virtualFiles, actualCostUsd, cacheRoutingKeyHash: sha256(cacheRoutingKey) }, { runId: options.runId, attemptId: options.attemptId, epoch: options.epoch })
	return { outcome, rows, actualTokens: inputTokens + outputTokens, actualWallMs: Date.now() - startedAt }
}

async function sourceIdentityManifest(): Promise<{ files: readonly { path: string; bytes: number; sha256: string }[]; sha256: string }> {
	let totalBytes = 0
	const files: { path: string; bytes: number; sha256: string }[] = []
	for (const relativePath of MANIFEST_SOURCE_FILES) {
		const filePath = path.resolve(REPOSITORY_ROOT, relativePath)
		if (!filePath.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) throw new JournalCorruptionError("source manifest path escaped the repository")
		let parent = REPOSITORY_ROOT
		let finalLstat: Awaited<ReturnType<typeof fs.lstat>> | undefined
		for (const segment of relativePath.split("/")) {
			parent = path.join(parent, segment)
			const stat = await fs.lstat(parent)
			const final = parent === filePath
			if (stat.isSymbolicLink() || (final ? !stat.isFile() : !stat.isDirectory())) {
				throw new JournalCorruptionError(`source manifest contains a symlink or unexpected file type: ${relativePath}`)
			}
			if (final && stat.size > MAX_MANIFEST_SOURCE_BYTES) throw new JournalCorruptionError(`source manifest file exceeds its bound: ${relativePath}`)
			if (final) finalLstat = stat
		}
		if (!finalLstat) throw new JournalCorruptionError(`source manifest file is missing: ${relativePath}`)
		const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
		let content: Buffer
		let before: Awaited<ReturnType<typeof handle.stat>>
		let after: Awaited<ReturnType<typeof handle.stat>>
		try {
			before = await handle.stat()
			if (!before.isFile() || before.dev !== finalLstat.dev || before.ino !== finalLstat.ino || before.size > MAX_MANIFEST_SOURCE_BYTES) {
				throw new JournalCorruptionError(`source manifest file changed or exceeds its bound: ${relativePath}`)
			}
		totalBytes += before.size
		if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_MANIFEST_TOTAL_BYTES) throw new JournalCorruptionError("source manifest exceeds its aggregate byte bound")
		content = Buffer.alloc(before.size)
		let offset = 0
		while (offset < content.byteLength) {
			const read = await handle.read(content, offset, Math.min(64 * 1024, content.byteLength - offset), offset)
			if (read.bytesRead <= 0) break
			offset += read.bytesRead
		}
		after = await handle.stat()
		if (offset !== content.byteLength || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || content.byteLength !== before.size) {
			throw new JournalCorruptionError(`source changed while its identity was being frozen: ${relativePath}`)
		}
		} finally { await handle.close() }
		files.push({ path: relativePath, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") })
	}
	return { files, sha256: sha256(files) }
}

async function manifestBase(outputDir: string, maxOutputTokens: number): Promise<Record<string, unknown>> {
	const sourceIdentity = await sourceIdentityManifest()
	return {
		schemaVersion: 3,
		experimentId: LIVE_EXPERIMENT_ID,
		createdAt: new Date().toISOString(),
		kind: "restricted-virtual-task-loop",
		outputDirectory: outputDir,
		model: { requested: LIVE_MODEL, providerOnly: LIVE_PROVIDER, allowFallbacks: false, admittedReturnedModelAliases: LIVE_MODEL_ALIASES },
		modelSettings: { temperature: 0, maxOutputTokens, stream: true, samplingSeedSupported: false },
		randomization: { armOrder: "Fisher-Yates seeded from the first 32 bits of SHA-256(fixtureId:repetitionSeed)", randomTiming: "SHA-256(fixtureId:repetitionSeed:random-arm); calibration-only trigger distribution", providerSamplingSeed: "unsupported and not sent" },
		fixturesHash: fixtureHash(), splitHash: splitHash(),
		sourceIdentity,
		splits: { development: LIVE_DEVELOPMENT_SLOTS.map(({ fixture, seed }) => ({ fixtureId: fixture.id, split: fixture.split, seed, arm: "B" })) },
		features: MONITOR_FEATURE_ORDER,
		labelEligibility: "Only valid, completed B-arm development trajectories contribute labeled rows; invalid attempts remain journaled and charged.",
		templates: TEMPLATE_TEXT,
		templatesHash: sha256(TEMPLATE_TEXT),
		guardrails: guardrailConfig,
		guardrailsHash: LIVE_GUARDRAILS_HASH,
		budget: LIVE_BUDGET,
		limitations: ["This restricted virtual-task loop is not equivalent to normal HeadlessSession behavior.", "No host executor, filesystem, shell, browser, network tool, delegation, skill, memory, checkpoint, or auxiliary inference handler is exposed."],
	}
}

async function ensurePrivateDir(directory: string): Promise<void> {
	const resolved = path.resolve(directory)
	let current = path.parse(resolved).root
	const parts = resolved.slice(current.length).split(path.sep).filter(Boolean)
	for (let index = 0; index < parts.length; index++) {
		current = path.join(current, parts[index])
		try {
			const stat = await fs.lstat(current)
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`pilot storage path contains a symlink or non-directory component: ${current}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			await fs.mkdir(current, { mode: index === parts.length - 1 ? 0o700 : 0o755 })
		}
	}
	await fs.chmod(resolved, 0o700)
}

async function assertRegularFileNoSymlink(filePath: string): Promise<void> {
	try {
		const stat = await fs.lstat(filePath)
		if (stat.isSymbolicLink() || !stat.isFile()) throw new JournalCorruptionError(`pilot artifact is not a regular file: ${filePath}`)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
}

async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await assertRegularFileNoSymlink(filePath)
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`
	try {
		const handle = await fs.open(temporaryPath, "wx", 0o600)
		try {
			await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
			await handle.sync()
		} finally { await handle.close() }
		await fs.rename(temporaryPath, filePath)
		await fs.chmod(filePath, 0o600)
	} catch (error) {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
		throw error
	}
}

async function loadOrWriteManifest(experimentDir: string, outputDir: string, maxOutputTokens: number): Promise<{ manifest: Record<string, unknown>; hash: string }> {
	const expected = await manifestBase(outputDir, maxOutputTokens)
	const manifestPath = path.join(experimentDir, "manifest.json")
	await assertRegularFileNoSymlink(manifestPath)
	try {
		const existing = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>
		const { createdAt: _createdAt, ...rest } = existing
		const { createdAt: _expectedCreatedAt, ...expectedRest } = expected
		if (sha256(rest) !== sha256(expectedRest)) throw new JournalCorruptionError("live pilot manifest changed; refusing resume")
		return { manifest: existing, hash: sha256(existing) }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	await fs.writeFile(manifestPath, `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o600, flag: "wx" })
	await fs.chmod(manifestPath, 0o600)
	return { manifest: expected, hash: sha256(expected) }
}

function globalBudgetUsage(journal: PilotJournal): GlobalUsage {
	const reservations = new Map<string, BudgetReservation>()
	const settlements = new Map<string, GlobalUsage>()
	for (const record of journal.list()) {
		if (record.type === "budget_reserved") {
			const payload = record.payload as unknown as BudgetReservation
			if (typeof payload.attemptId !== "string" || !isSafeInteger(payload.maxTokens) || !isSafeInteger(payload.maxWallMs) || reservations.has(payload.attemptId)) {
				throw new JournalCorruptionError("invalid or duplicate global budget reservation")
			}
			reservations.set(payload.attemptId, payload)
		}
		if (record.type === "budget_settled") {
			const payload = record.payload as unknown as { attemptId: string; actualTokens: number; actualWallMs: number }
			if (!reservations.has(payload.attemptId) || !isSafeInteger(payload.actualTokens) || !isSafeInteger(payload.actualWallMs) || settlements.has(payload.attemptId)) {
				throw new JournalCorruptionError("invalid global budget settlement")
			}
			const reserved = reservations.get(payload.attemptId)!
			if (payload.actualTokens > reserved.maxTokens || payload.actualWallMs > reserved.maxWallMs) throw new JournalCorruptionError("settlement exceeds reservation")
			settlements.set(payload.attemptId, { tokens: payload.actualTokens, wallMs: payload.actualWallMs })
		}
	}
	let tokens = 0
	let wallMs = 0
	for (const [attemptId, reservation] of reservations) {
		const settled = settlements.get(attemptId)
		tokens += settled?.tokens ?? reservation.maxTokens
		wallMs += settled?.wallMs ?? reservation.maxWallMs
	}
	return { tokens, wallMs }
}

function completedRecords(journal: PilotJournal): Map<string, JournalRecord> {
	const done = new Map<string, JournalRecord>()
	for (const record of journal.list()) {
		if (record.type === "attempt_completed" && typeof record.payload.slotKey === "string") done.set(record.payload.slotKey, record)
	}
	return done
}

function latestEpochByRun(journal: PilotJournal): Map<string, number> {
	const epochs = new Map<string, number>()
	for (const record of journal.list()) {
		if (record.runId !== undefined && record.epoch !== undefined) {
			epochs.set(record.runId, Math.max(epochs.get(record.runId) ?? record.epoch, record.epoch))
		}
	}
	return epochs
}

function billingTotals(journal: PilotJournal): LiveBillingTotals {
	const records = journal.list()
	const accepted = records.filter((record) => record.type === "llm_response_billed")
	const responseEvents = records.filter((record) => record.type === "llm_response_received")
	const admittedEvents = records.filter((record) => record.type === "llm_request_admitted")
	const generationEvents = records.filter((record) => record.type === "llm_billing_metadata_received" && record.payload.billingMetadata !== null && typeof record.payload.billingMetadata === "object")
	const acceptedIds = new Set(accepted.map((record) => record.payload.generationId).filter((value): value is string => typeof value === "string"))
	let promptTokens = 0
	let completionTokens = 0
	let cachedPromptTokens = 0
	let cachedTokenReports = 0
	let totalBilledCostUsd = 0
	let totalCacheDiscountUsd = 0
	const billableGenerationIds = new Set<string>()
	for (const record of generationEvents) {
		const expectedId = record.payload.generationId
		const billing = record.payload.billingMetadata as OpenRouterGenerationMetadata
		if (typeof expectedId !== "string" || billing.id !== expectedId) continue
		if (typeof billing.totalCostUsd === "number" && Number.isFinite(billing.totalCostUsd) && billing.totalCostUsd >= 0) {
			billableGenerationIds.add(expectedId)
			totalBilledCostUsd += billing.totalCostUsd
		}
		const prompt = billing.nativeTokensPrompt ?? billing.tokensPrompt
		const completion = billing.nativeTokensCompletion ?? billing.tokensCompletion
		if (isSafeInteger(prompt) && isSafeInteger(completion)) {
			promptTokens += prompt
			completionTokens += completion
		}
		const cached = billing.nativeTokensCached
		if (isSafeInteger(cached) && (!isSafeInteger(prompt) || cached <= prompt)) { cachedPromptTokens += cached; cachedTokenReports++ }
		if (typeof billing.cacheDiscountUsd === "number" && Number.isFinite(billing.cacheDiscountUsd)) totalCacheDiscountUsd += billing.cacheDiscountUsd
	}
	if (![promptTokens, completionTokens, cachedPromptTokens, totalBilledCostUsd, totalCacheDiscountUsd].every(Number.isFinite)) throw new JournalCorruptionError("billing totals overflowed")
	const billableByAttemptIteration = new Set(generationEvents.filter((record) => {
		const billing = record.payload.billingMetadata as OpenRouterGenerationMetadata
		return typeof record.payload.generationId === "string" && billing.id === record.payload.generationId && typeof billing.totalCostUsd === "number" && Number.isFinite(billing.totalCostUsd) && billing.totalCostUsd >= 0
	}).map((record) => `${record.attemptId ?? ""}\0${String(record.payload.iteration ?? "")}\0${record.payload.generationId}`))
	const unbilledResponses = responseEvents.filter((record) => typeof record.payload.generationId !== "string" || !billableByAttemptIteration.has(`${record.attemptId ?? ""}\0${String(record.payload.iteration ?? "")}\0${record.payload.generationId}`)).length
	const responseAttemptIterations = new Set(responseEvents.map((record) => `${record.attemptId ?? ""}\0${String(record.payload.iteration ?? "")}`))
	const unresolvedRequests = admittedEvents.filter((record) => !responseAttemptIterations.has(`${record.attemptId ?? ""}\0${String(record.payload.iteration ?? "")}`)).length
	const unacceptedBillingRecords = [...billableGenerationIds].filter((id) => !acceptedIds.has(id)).length
	return {
		admittedRequests: admittedEvents.length,
		responsesReceived: responseEvents.length,
		unresolvedRequests,
		generationRecords: generationEvents.length,
		acceptedBillingRecords: accepted.length,
		unacceptedBillingRecords,
		unbilledResponses,
		promptTokens, completionTokens, cachedPromptTokens, cachedTokenReports, totalBilledCostUsd, totalCacheDiscountUsd,
	}
}

async function createProductionClient(): Promise<BillingClient> {
	if (!process.env.HEADLESSCODE_OPENROUTER_API_KEY) throw new Error("Set HEADLESSCODE_OPENROUTER_API_KEY before starting the live pilot.")
	const configuredBase = process.env.OPENROUTER_BASE_URL
	if (configuredBase && configuredBase.replace(/\/+$/, "") !== "https://openrouter.ai") throw new Error("Live pilot requires the official https://openrouter.ai endpoint.")
	return new OpenRouterClient({ apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY, defaultModel: LIVE_MODEL, disableTranscriptCapture: true, maxPromptBytes: LIVE_BUDGET.maxTokens })
}

export async function collectLiveDevelopment(options: LiveRunnerOptions = {}): Promise<LiveRunSummary> {
	validateFixtureSplits()
	const outputDir = path.resolve(options.outputDir ?? ".headlesscode/monitor-pilot-live")
	const maxOutputTokens = validateMaxOutputTokens(options.maxOutputTokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : options.maxOutputTokens)
	await ensurePrivateDir(outputDir)
	const lock = new ExclusiveRunnerLock(path.join(outputDir, "runner.lock"))
	await lock.acquire()
	try {
		const experimentDir = path.join(outputDir, "development")
		await ensurePrivateDir(experimentDir)
		const { manifest, hash: manifestHash } = await loadOrWriteManifest(experimentDir, outputDir, maxOutputTokens)
		const journal = new PilotJournal(path.join(experimentDir, "journal.jsonl"))
		await assertRegularFileNoSymlink(journal.filePath)
		await journal.open()
		await fs.chmod(journal.filePath, 0o600).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
		const active = journal.activeAttempts()
		if (active.length > 0) await journal.abortActiveAttempts(LIVE_EXPERIMENT_ID, "process-interrupted; reservation remains fully charged")
		const global = new PilotJournal(path.join(outputDir, "global-budget.jsonl"))
		await assertRegularFileNoSymlink(global.filePath)
		await global.open()
		await fs.chmod(global.filePath, 0o600).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
		const client = options.client ?? await createProductionClient()
		const done = completedRecords(journal)
		const globalEpochByRun = latestEpochByRun(global)
		const localEpochByRun = latestEpochByRun(journal)
		const allRows: LabeledWindow[] = []
		let completedRuns = 0
		let stopReason: string | undefined
		for (const slot of LIVE_DEVELOPMENT_SLOTS) {
			const prior = done.get(slot.slotKey)
			if (prior) {
				const payload = prior.payload
				const rows = Array.isArray(payload.rows) ? payload.rows as LabeledWindow[] : []
				if ((payload.outcome as PilotOutcome | undefined)?.valid) allRows.push(...rows)
				completedRuns++
				continue
			}
			const priorAttempts = journal.list().filter((record) => record.type === "attempt_started" && record.payload.slotKey === slot.slotKey)
			const aborted = priorAttempts.filter((record) => journal.list().some((event) => event.attemptId === record.attemptId && event.type === "attempt_aborted"))
			if (aborted.length > 0 && !options.retryAborted) {
				stopReason = `STOP: ${slot.slotKey} has an aborted/uncertain attempt; explicit retry is required.`
				break
			}
			const runId = slot.slotKey
			const epoch = Math.max(priorAttempts.length, globalEpochByRun.get(runId) ?? 0, localEpochByRun.get(runId) ?? 0) + 1
			const attemptId = randomUUID()
			const reservation: BudgetReservation = { attemptId, runId, maxTokens: LIVE_BUDGET.maxTokens, maxWallMs: LIVE_BUDGET.maxWallMs }
			const used = globalBudgetUsage(global)
			if (used.tokens + reservation.maxTokens > LIVE_BUDGET.globalMaxTokens || used.wallMs + reservation.maxWallMs > LIVE_BUDGET.globalMaxWallMs) {
				stopReason = "STOP: the next full per-run reservation does not fit the remaining shared #11/#12 global budget."
				break
			}
			await global.append("budget_reserved", LIVE_EXPERIMENT_ID, reservation as unknown as Record<string, unknown>, { runId, attemptId, epoch })
			await fs.chmod(global.filePath, 0o600)
			await journal.append("attempt_started", LIVE_EXPERIMENT_ID, { slotKey: slot.slotKey, fixtureId: slot.fixture.id, split: slot.fixture.split, seed: slot.seed, arm: "B", model: LIVE_MODEL, epoch }, { runId, attemptId, epoch })
			await fs.chmod(journal.filePath, 0o600)
			const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(LIVE_BUDGET.maxWallMs)]) : AbortSignal.timeout(LIVE_BUDGET.maxWallMs)
			try {
				const result = await runLiveTrajectory({ experimentId: LIVE_EXPERIMENT_ID, runId, attemptId, epoch, maxOutputTokens, fixture: slot.fixture, seed: slot.seed, arm: "B", client, signal, journal })
				await journal.append("attempt_completed", LIVE_EXPERIMENT_ID, { slotKey: slot.slotKey, outcome: result.outcome, rows: result.rows }, { runId, attemptId, epoch })
				await global.append("budget_settled", LIVE_EXPERIMENT_ID, { attemptId, actualTokens: result.actualTokens, actualWallMs: result.actualWallMs }, { runId, attemptId, epoch })
				if (result.outcome.valid) allRows.push(...result.rows)
				completedRuns++
			} catch (error) {
				await journal.append("attempt_aborted", LIVE_EXPERIMENT_ID, {
					slotKey: slot.slotKey,
					reason: options.signal?.aborted ? "operator-cancelled; request outcome may be uncertain" : "model, billing, or budget outcome uncertain",
					failureCode: abortFailureCode(error, !!options.signal?.aborted),
				}, { runId, attemptId, epoch })
				stopReason = options.signal?.aborted ? "STOP: development collection was cancelled; the active reservation remains charged." : "STOP: model, billing, or budget result is uncertain; inspect the private journal before retrying."
				break
			}
		}
		const trainRows = allRows.filter((row) => LIVE_DEVELOPMENT_SLOTS.some((slot) => slot.fixture.split === "train" && slotKeyFor(row.trajectoryId) === slot.slotKey))
		const calibrationRows = allRows.filter((row) => LIVE_DEVELOPMENT_SLOTS.some((slot) => slot.fixture.split === "calibration" && slotKeyFor(row.trajectoryId) === slot.slotKey))
		const positiveTrain = trainRows.filter((row) => row.label === 1)
		const positiveCalibration = calibrationRows.filter((row) => row.label === 1)
		const trainTrajectories = new Set(positiveTrain.map((row) => row.trajectoryId)).size
		const calibrationTrajectories = new Set(positiveCalibration.map((row) => row.trajectoryId)).size
		let predictor: FrozenPredictorArtifact | undefined
		if (stopReason === undefined) {
			if (completedRuns !== LIVE_DEVELOPMENT_SLOTS.length) stopReason = "STOP: development schedule incomplete"
			else if (positiveTrain.length < 20 || trainTrajectories < 8) stopReason = "STOP: fewer than 20 positive train windows across eight trajectories"
			else if (positiveCalibration.length < 10 || calibrationTrajectories < 4) stopReason = "STOP: fewer than 10 positive calibration windows across four trajectories"
			else {
				try {
					predictor = fitFrozenPredictor(trainRows, calibrationRows, { modelDigest: LIVE_MODEL_DIGEST, templatesHash: sha256(TEMPLATE_TEXT) })
				} catch (error) { stopReason = error instanceof Error ? error.message : "STOP: predictor qualification failed" }
			}
		}
		if (predictor) {
			const predictorPath = path.join(experimentDir, "predictor.json")
			await assertRegularFileNoSymlink(predictorPath)
			await fs.writeFile(predictorPath, `${JSON.stringify(predictor, null, 2)}\n`, { mode: 0o600, flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error
				const prior = JSON.parse(await fs.readFile(predictorPath, "utf8")) as FrozenPredictorArtifact
				if (sha256(prior) !== sha256(predictor)) throw new JournalCorruptionError("existing frozen predictor differs from recomputed artifact")
			})
			await journal.append("predictor_frozen", LIVE_EXPERIMENT_ID, { predictor, predictorHash: predictor.artifactHash, threshold: predictor.threshold, manifestHash, guardrailVersion: guardrailConfig.version, guardrailsHash: LIVE_GUARDRAILS_HASH }, {})
		} else {
			await journal.append("pilot_stopped", LIVE_EXPERIMENT_ID, { reason: stopReason, positiveTrain: positiveTrain.length, positiveTrainTrajectories: trainTrajectories, positiveCalibration: positiveCalibration.length, positiveCalibrationTrajectories: calibrationTrajectories, manifestHash }, {})
		}
		const records = journal.list()
		const startedSlots = new Set(records.filter((record) => record.type === "attempt_started").map((record) => record.payload.slotKey).filter((slot): slot is string => typeof slot === "string"))
		const completedOutcomes = records.filter((record) => record.type === "attempt_completed").map((record) => record.payload.outcome as PilotOutcome)
		const summary: LiveRunSummary = { experimentId: LIVE_EXPERIMENT_ID, scheduledRuns: LIVE_DEVELOPMENT_SLOTS.length, completedRuns, attempts: records.filter((record) => record.type === "attempt_started").length, abortedAttempts: records.filter((record) => record.type === "attempt_aborted").length, unstartedSlots: LIVE_DEVELOPMENT_SLOTS.filter((slot) => !startedSlots.has(slot.slotKey)).length, invalidCompletedRuns: completedOutcomes.filter((outcome) => !outcome.valid).length, billing: billingTotals(journal), predictorStatus: predictor ? "QUALIFIED" : "STOP", ...(stopReason ? { stopReason } : {}), ...(predictor ? { predictor } : {}), manifestHash, journalPath: journal.filePath }
		const reportPath = path.join(experimentDir, "development-summary.json")
		await journal.append("development_summary", LIVE_EXPERIMENT_ID, { summaryHash: sha256(summary), summary, manifestHash }, {})
		await writePrivateJsonAtomic(reportPath, summary)
		return summary
	} finally {
		await lock.release()
	}
}

function slotKeyFor(trajectoryId: string): string {
	return trajectoryId
}

function deterministicArmOrder(fixtureId: string, seed: number): readonly ("B" | "M" | "R" | "G")[] {
	let state = Number.parseInt(sha256(`${fixtureId}:${seed}`).slice(0, 8), 16) >>> 0
	const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x1_0000_0000 }
	const arms: ("B" | "M" | "R" | "G")[] = ["B", "M", "R", "G"]
	for (let index = arms.length - 1; index > 0; index--) {
		const other = Math.floor(next() * (index + 1))
		;[arms[index], arms[other]] = [arms[other], arms[index]]
	}
	return arms
}

interface HeldoutSlot {
	readonly fixture: (typeof PILOT_FIXTURES)[number]
	readonly seed: number
	readonly arm: "B" | "M" | "R" | "G"
	readonly slotKey: string
}

function heldoutSlots(): readonly HeldoutSlot[] {
	return PILOT_FIXTURES.filter((fixture) => fixture.split === "test").flatMap((fixture) => LIVE_SEEDS.flatMap((seed) =>
		deterministicArmOrder(fixture.id, seed).map((arm) => ({ fixture, seed, arm, slotKey: `heldout:${fixture.id}:${seed}:${arm}` })),
	))
}

async function requireQualifiedDevelopment(outputDir: string, maxOutputTokens: number): Promise<{ predictor: FrozenPredictorArtifact; rows: LabeledWindow[]; outcomes: PilotOutcome[]; calibrationBoundaries: Pick<LabeledWindow, "features" | "trajectoryId" | "boundarySequence">[]; manifestHash: string }> {
	const developmentDir = path.join(outputDir, "development")
	for (const file of ["development-summary.json", "predictor.json", "manifest.json", "journal.jsonl"]) await assertRegularFileNoSymlink(path.join(developmentDir, file))
	const summary = JSON.parse(await fs.readFile(path.join(developmentDir, "development-summary.json"), "utf8")) as LiveRunSummary
	if (summary.predictorStatus !== "QUALIFIED" || !summary.predictor || summary.completedRuns !== LIVE_DEVELOPMENT_SLOTS.length) throw new Error("held-out collection is gated: development did not freeze a qualifying predictor")
	const predictor = JSON.parse(await fs.readFile(path.join(developmentDir, "predictor.json"), "utf8")) as FrozenPredictorArtifact
	const { artifactHash, ...withoutHash } = predictor
	if (sha256(withoutHash) !== artifactHash || summary.predictor.artifactHash !== artifactHash) throw new JournalCorruptionError("frozen predictor hash mismatch")
	if (predictor.modelDigest !== LIVE_MODEL_DIGEST || predictor.templatesHash !== sha256(TEMPLATE_TEXT) || predictor.threshold < 0.5 || predictor.threshold > 0.95 || Math.round(predictor.threshold * 20) !== predictor.threshold * 20) {
		throw new JournalCorruptionError("frozen predictor identity or threshold is not admitted")
	}
	const manifest = JSON.parse(await fs.readFile(path.join(developmentDir, "manifest.json"), "utf8")) as Record<string, unknown>
	const currentSourceIdentity = await sourceIdentityManifest()
	if (manifest.experimentId !== LIVE_EXPERIMENT_ID || manifest.outputDirectory !== outputDir || (manifest.modelSettings as { maxOutputTokens?: unknown } | undefined)?.maxOutputTokens !== maxOutputTokens || manifest.fixturesHash !== fixtureHash() || manifest.splitHash !== splitHash() || manifest.guardrailsHash !== LIVE_GUARDRAILS_HASH || manifest.templatesHash !== sha256(TEMPLATE_TEXT)) {
		throw new JournalCorruptionError("development manifest no longer matches the frozen live-pilot contract")
	}
	if (sha256(manifest.sourceIdentity) !== sha256(currentSourceIdentity)) throw new JournalCorruptionError("development source identities changed; held-out collection is not admitted")
	if (summary.manifestHash !== sha256(manifest) || sha256(summary.predictor) !== sha256(predictor)) throw new JournalCorruptionError("development summary does not bind the frozen manifest and predictor")
	const journal = new PilotJournal(path.join(developmentDir, "journal.jsonl"))
	await journal.open()
	const completions = journal.list().filter((record) => record.type === "attempt_completed")
	const completedBySlot = new Map<string, JournalRecord>()
	for (const record of completions) if (typeof record.payload.slotKey === "string") completedBySlot.set(record.payload.slotKey, record)
	if (completedBySlot.size !== LIVE_DEVELOPMENT_SLOTS.length) throw new JournalCorruptionError("development journal does not contain all 32 completed runs")
	const rows: LabeledWindow[] = []
	const outcomes: PilotOutcome[] = []
	for (const slot of LIVE_DEVELOPMENT_SLOTS) {
		const record = completedBySlot.get(slot.slotKey)
		if (!record || !Array.isArray(record.payload.rows) || !record.payload.outcome) throw new JournalCorruptionError(`development run missing frozen rows: ${slot.slotKey}`)
		const outcome = record.payload.outcome as PilotOutcome
		if (outcome.arm !== "B" || outcome.fixtureId !== slot.fixture.id || outcome.split !== slot.fixture.split || outcome.runId !== slot.slotKey) throw new JournalCorruptionError(`development outcome identity mismatch: ${slot.slotKey}`)
		const billedCalls = journal.list().filter((event) => event.attemptId === record.attemptId && event.type === "llm_response_billed")
		if (billedCalls.length !== outcome.calls || billedCalls.length === 0) throw new JournalCorruptionError(`development billing call count mismatch: ${slot.slotKey}`)
		let measuredTokens = 0
		for (const event of billedCalls) {
			const payload = event.payload
			const usage = payload.usage as { promptTokens?: unknown; completionTokens?: unknown } | undefined
			const billing = payload.billing as { totalCostUsd?: unknown } | undefined
			if (!LIVE_MODEL_ALIASES.includes(payload.responseModel as (typeof LIVE_MODEL_ALIASES)[number]) || !LIVE_MODEL_ALIASES.includes(payload.billingModel as (typeof LIVE_MODEL_ALIASES)[number]) || payload.responseProvider !== LIVE_PROVIDER || payload.billingProvider !== LIVE_PROVIDER || typeof payload.generationId !== "string" || !/^gen-[0-9A-Za-z-]{1,124}$/.test(payload.generationId) || !isSafeInteger(usage?.promptTokens) || !isSafeInteger(usage?.completionTokens) || typeof billing?.totalCostUsd !== "number" || !Number.isFinite(billing.totalCostUsd) || billing.totalCostUsd < 0) {
				throw new JournalCorruptionError(`development call is missing admitted billing identity: ${slot.slotKey}`)
			}
			measuredTokens += usage.promptTokens + usage.completionTokens
		}
		if (measuredTokens !== outcome.tokens) throw new JournalCorruptionError(`development usage total mismatch: ${slot.slotKey}`)
		if (outcome.valid) rows.push(...record.payload.rows as LabeledWindow[])
		outcomes.push(outcome)
	}
	const train = rows.filter((row) => LIVE_DEVELOPMENT_SLOTS.some((slot) => slot.fixture.split === "train" && slot.slotKey === row.trajectoryId))
	const calibration = rows.filter((row) => LIVE_DEVELOPMENT_SLOTS.some((slot) => slot.fixture.split === "calibration" && slot.slotKey === row.trajectoryId))
	const positiveTrain = train.filter((row) => row.label === 1)
	const positiveCalibration = calibration.filter((row) => row.label === 1)
	if (positiveTrain.length < 20 || new Set(positiveTrain.map((row) => row.trajectoryId)).size < 8 || positiveCalibration.length < 10 || new Set(positiveCalibration.map((row) => row.trajectoryId)).size < 4) {
		throw new JournalCorruptionError("frozen predictor no longer satisfies the recorded data sufficiency gate")
	}
	const recomputed = fitFrozenPredictor(train, calibration, { modelDigest: LIVE_MODEL_DIGEST, templatesHash: sha256(TEMPLATE_TEXT) })
	if (recomputed.artifactHash !== predictor.artifactHash) throw new JournalCorruptionError("frozen predictor does not match the journaled development rows")
	const validCalibrationRuns = new Set(outcomes.filter((outcome) => outcome.valid && outcome.split === "calibration").map((outcome) => outcome.runId))
	const calibrationBoundaries = journal.list().filter((event) => event.type === "boundary" && validCalibrationRuns.has(event.runId ?? ""))
		.map((event) => {
			const boundary = event.payload.boundary as PilotBoundary
			return { features: extractMonitorFeatures(boundary), trajectoryId: boundary.runId, boundarySequence: boundary.sequence }
		})
	return { predictor, rows: calibration, outcomes, calibrationBoundaries, manifestHash: sha256(manifest) }
}

async function loadOrWriteHeldoutManifest(directory: string, expected: Record<string, unknown>): Promise<string> {
	const manifestPath = path.join(directory, "manifest.json")
	await assertRegularFileNoSymlink(manifestPath)
	try {
		const existing = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>
		const { createdAt: _createdAt, ...rest } = existing
		const { createdAt: _expectedCreatedAt, ...expectedRest } = expected
		if (sha256(rest) !== sha256(expectedRest)) throw new JournalCorruptionError("held-out manifest changed; refusing resume")
		return sha256(existing)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	await fs.writeFile(manifestPath, `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o600, flag: "wx" })
	await fs.chmod(manifestPath, 0o600)
	return sha256(expected)
}

/** Root-supervised held-out collection. It refuses to run without a verified development gate and freezes all 64 assignments first. */
export async function collectLiveHeldout(options: LiveRunnerOptions = {}): Promise<LiveHeldoutSummary> {
	validateFixtureSplits()
	const outputDir = path.resolve(options.outputDir ?? ".headlesscode/monitor-pilot-live")
	const maxOutputTokens = validateMaxOutputTokens(options.maxOutputTokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : options.maxOutputTokens)
	await ensurePrivateDir(outputDir)
	const lock = new ExclusiveRunnerLock(path.join(outputDir, "runner.lock"))
	await lock.acquire()
	try {
		const development = await requireQualifiedDevelopment(outputDir, maxOutputTokens)
		const randomSchedule = deriveCalibrationRandomSchedule(development.calibrationBoundaries, development.predictor)
		const slots = heldoutSlots()
		if (slots.length !== 64) throw new JournalCorruptionError(`held-out plan changed: expected 64 runs, got ${slots.length}`)
		const heldoutDir = path.join(outputDir, "heldout")
		await ensurePrivateDir(heldoutDir)
		const expectedManifest = {
			...await manifestBase(outputDir, maxOutputTokens),
			createdAt: new Date().toISOString(),
			kind: "restricted-virtual-task-loop-heldout",
			developmentManifestHash: development.manifestHash,
			predictorHash: development.predictor.artifactHash,
			threshold: development.predictor.threshold,
			randomSchedule,
			armAssignments: slots.map(({ fixture, seed, arm }) => ({ fixtureId: fixture.id, seed, arm })),
		}
		const manifestHash = await loadOrWriteHeldoutManifest(heldoutDir, expectedManifest)
		const journal = new PilotJournal(path.join(heldoutDir, "journal.jsonl"))
		await assertRegularFileNoSymlink(journal.filePath)
		await journal.open()
		await fs.chmod(journal.filePath, 0o600).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
		if (journal.activeAttempts().length > 0) await journal.abortActiveAttempts(LIVE_EXPERIMENT_ID, "process-interrupted; reservation remains fully charged")
		const global = new PilotJournal(path.join(outputDir, "global-budget.jsonl"))
		await assertRegularFileNoSymlink(global.filePath)
		await global.open()
		const done = completedRecords(journal)
		const globalEpochByRun = latestEpochByRun(global)
		const localEpochByRun = latestEpochByRun(journal)
		const outstanding = slots.filter((slot) => !done.has(slot.slotKey)).length
		const used = globalBudgetUsage(global)
		let stopReason: string | undefined
		const hasAbortedSlot = slots.some((slot) => {
			if (done.has(slot.slotKey)) return false
			return journal.list().some((record) => record.type === "attempt_started" && record.payload.slotKey === slot.slotKey && journal.list().some((event) => event.attemptId === record.attemptId && event.type === "attempt_aborted"))
		})
		if (hasAbortedSlot && !options.retryAborted) stopReason = "STOP: a held-out slot has an aborted/uncertain attempt; explicit retry is required."
		else if (used.tokens + outstanding * LIVE_BUDGET.maxTokens > LIVE_BUDGET.globalMaxTokens || used.wallMs + outstanding * LIVE_BUDGET.maxWallMs > LIVE_BUDGET.globalMaxWallMs) {
			stopReason = "STOP: full remaining held-out reservations do not fit the shared #11/#12 global ceiling."
		}
		const client = stopReason === undefined ? options.client ?? await createProductionClient() : undefined
		for (const slot of stopReason === undefined ? slots : []) {
			if (done.has(slot.slotKey)) continue
			const priorAttempts = journal.list().filter((record) => record.type === "attempt_started" && record.payload.slotKey === slot.slotKey)
			const aborted = priorAttempts.filter((record) => journal.list().some((event) => event.attemptId === record.attemptId && event.type === "attempt_aborted"))
			if (aborted.length > 0 && !options.retryAborted) {
				stopReason = `STOP: held-out slot ${slot.slotKey} has an aborted/uncertain attempt; explicit retry is required.`
				break
			}
			const runId = `heldout-${slot.fixture.id}-${slot.seed}-${slot.arm}`
			const epoch = Math.max(priorAttempts.length, globalEpochByRun.get(runId) ?? 0, localEpochByRun.get(runId) ?? 0) + 1
			const attemptId = randomUUID()
			const reservation: BudgetReservation = { attemptId, runId, maxTokens: LIVE_BUDGET.maxTokens, maxWallMs: LIVE_BUDGET.maxWallMs }
			const current = globalBudgetUsage(global)
			if (current.tokens + reservation.maxTokens > LIVE_BUDGET.globalMaxTokens || current.wallMs + reservation.maxWallMs > LIVE_BUDGET.globalMaxWallMs) {
				stopReason = "STOP: shared global budget exhausted before the next run; no request was sent."
				break
			}
			await global.append("budget_reserved", LIVE_EXPERIMENT_ID, reservation as unknown as Record<string, unknown>, { runId, attemptId, epoch })
			await fs.chmod(global.filePath, 0o600)
			await journal.append("attempt_started", LIVE_EXPERIMENT_ID, { slotKey: slot.slotKey, fixtureId: slot.fixture.id, split: slot.fixture.split, seed: slot.seed, arm: slot.arm, epoch, predictorHash: development.predictor.artifactHash, randomScheduleHash: sha256(randomSchedule) }, { runId, attemptId, epoch })
			await fs.chmod(journal.filePath, 0o600)
			const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(LIVE_BUDGET.maxWallMs)]) : AbortSignal.timeout(LIVE_BUDGET.maxWallMs)
			try {
				const result = await runLiveTrajectory({ experimentId: LIVE_EXPERIMENT_ID, runId, attemptId, epoch, maxOutputTokens, fixture: slot.fixture, seed: slot.seed, arm: slot.arm, client: client!, signal, journal, predictor: development.predictor, randomSchedule })
				await journal.append("attempt_completed", LIVE_EXPERIMENT_ID, { slotKey: slot.slotKey, outcome: result.outcome, rows: result.rows }, { runId, attemptId, epoch })
				await global.append("budget_settled", LIVE_EXPERIMENT_ID, { attemptId, actualTokens: result.actualTokens, actualWallMs: result.actualWallMs }, { runId, attemptId, epoch })
			} catch (error) {
				await journal.append("attempt_aborted", LIVE_EXPERIMENT_ID, {
					slotKey: slot.slotKey,
					reason: options.signal?.aborted ? "operator-cancelled; request outcome may be uncertain" : "model, billing, or budget outcome uncertain",
					failureCode: abortFailureCode(error, !!options.signal?.aborted),
				}, { runId, attemptId, epoch })
				stopReason = options.signal?.aborted ? "STOP: held-out collection was cancelled; the active reservation remains charged." : "STOP: model, billing, or budget result is uncertain; inspect the private journal before retrying."
				break
			}
		}
		const currentJournal = new PilotJournal(journal.filePath)
		await assertRegularFileNoSymlink(currentJournal.filePath)
		await currentJournal.open()
		const heldoutOutcomes = currentJournal.list().filter((record) => record.type === "attempt_completed").map((record) => record.payload.outcome as PilotOutcome)
		const analysis = analyzePilot([...development.outcomes, ...heldoutOutcomes], development.predictor, randomSchedule.probability, "This is a restricted virtual-task loop using live Meta Muse Contributor calls. It is not normal HeadlessSession behavior and does not establish transfer to real repositories.")
		const heldoutRecords = currentJournal.list()
		const startedSlots = new Set(heldoutRecords.filter((record) => record.type === "attempt_started").map((record) => record.payload.slotKey).filter((slot): slot is string => typeof slot === "string"))
		const summary: LiveHeldoutSummary = { experimentId: LIVE_EXPERIMENT_ID, scheduledRuns: 64, completedRuns: heldoutOutcomes.length, attempts: heldoutRecords.filter((record) => record.type === "attempt_started").length, abortedAttempts: heldoutRecords.filter((record) => record.type === "attempt_aborted").length, unstartedSlots: slots.filter((slot) => !startedSlots.has(slot.slotKey)).length, invalidCompletedRuns: heldoutOutcomes.filter((outcome) => !outcome.valid).length, billing: billingTotals(currentJournal), status: heldoutOutcomes.length === 64 ? "COMPLETE" : "INCOMPLETE", ...(heldoutOutcomes.length === 64 ? { verdict: analysis.verdict } : {}), ...(stopReason ? { stopReason } : {}), manifestHash, journalPath: journal.filePath }
		const reportPath = path.join(heldoutDir, "heldout-summary.json")
		await assertRegularFileNoSymlink(reportPath)
		await journal.append("heldout_summary", LIVE_EXPERIMENT_ID, { summaryHash: sha256(summary), analysisHash: sha256(analysis), summary, analysis }, {})
		await writePrivateJsonAtomic(reportPath, { summary, analysis })
		return summary
	} finally { await lock.release() }
}

/** Derive the R arm's fixed random schedule only from frozen-predictor triggers on calibration rows. */
export function deriveCalibrationRandomSchedule(
	rows: readonly Pick<LabeledWindow, "features" | "trajectoryId" | "boundarySequence">[],
	predictor: FrozenPredictorArtifact,
	trajectoryIds: readonly string[] = LIVE_DEVELOPMENT_SLOTS.filter((slot) => slot.fixture.split === "calibration").map((slot) => slot.slotKey),
): { probability: number; distribution: readonly { boundarySequence: number; weight: number }[] } {
	const scheduled = new Set(trajectoryIds)
	const firstTrigger = new Map<string, number>()
	for (const row of rows) {
		if (!scheduled.has(row.trajectoryId) || row.boundarySequence === undefined || !predictedIntervention(predictor, predictFromFeatures(predictor, row.features))) continue
		const prior = firstTrigger.get(row.trajectoryId)
		if (prior === undefined || row.boundarySequence < prior) firstTrigger.set(row.trajectoryId, row.boundarySequence)
	}
	const counts = new Map<number, number>()
	for (const boundary of firstTrigger.values()) counts.set(boundary, (counts.get(boundary) ?? 0) + 1)
	return {
		probability: scheduled.size === 0 ? 0 : firstTrigger.size / scheduled.size,
		distribution: [...counts.entries()].sort(([a], [b]) => a - b).map(([boundarySequence, weight]) => ({ boundarySequence, weight })),
	}
}

export function makeLiveOpenRouterClient(options: { apiKey: string; baseUrl?: string } ): BillingClient {
	return new OpenRouterClient({ apiKey: options.apiKey, baseUrl: options.baseUrl, defaultModel: LIVE_MODEL, disableTranscriptCapture: true, maxPromptBytes: LIVE_BUDGET.maxTokens })
}
