/** One baseline-only, real-model feasibility check. No calibration or test fixture is run. */
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { HeadlessSession } from "../../src/engine/loop.js"
import type { ChatTool, IterationBoundarySnapshot, LlmClient, LlmRequest, LlmResponse } from "../../src/engine/types.js"
import { buildRequestBody } from "../../src/llm/openrouter.js"
import { ToolExecutor } from "../../src/tools/executor.js"
import type { PilotFixture } from "../../src/monitoring/types.js"
import { PILOT_FIXTURES } from "./fixtures.js"
import { RestrictedSimulator } from "./simulator.js"

const MODEL = "deepseek/deepseek-v4.1-flash-20260910"
const RESPONSE_MODEL = "deepseek/deepseek-v4.1-flash"
const PROVIDER = "deepseek"
// The first frozen pin resolved to a different model. Its measured usage was
// recovered by generation ID before this corrected protocol was frozen.
const PRIOR_ATTEMPT = {
	responseId: "gen-1790105016-4t8fUBdmXnU0ulBm2ER3",
	requestId: "req-1790105016-h2vcg1Di4gGpyk6v7Z3Y",
	requestedModel: "deepseek/deepseek-v4-flash-0731",
	actualModel: "deepseek/deepseek-v4.1-flash-20260910",
	inputTokens: 406,
	outputTokens: 18,
	status: "aborted-before-virtual-action",
} as const
const PRIOR_ABORTED_RUN = {
	report: ".headlesscode/monitor-preflight/preflight-20260922192522/final-report.json",
	status: "aborted-on-metadata-and-token-admission-instrumentation",
	modelCalls: 5,
	inputTokens: 4_153,
	outputTokens: 398,
} as const
const PRIOR_INPUT_TOKENS = PRIOR_ATTEMPT.inputTokens + PRIOR_ABORTED_RUN.inputTokens
const PRIOR_OUTPUT_TOKENS = PRIOR_ATTEMPT.outputTokens + PRIOR_ABORTED_RUN.outputTokens
const PRIOR_MEASURED_TOKENS = PRIOR_INPUT_TOKENS + PRIOR_OUTPUT_TOKENS
const RESUME = {
	previousDirectory: ".headlesscode/monitor-preflight/preflight-20260922192751",
	reportSha256: "e6b4b9ac9703adc56fb0bbeb1e1eb1db155c71509b6d7b8a9f7a86ea980d0902",
	journalSha256: "f91422bc4e5b1cefffaae5c8e05d3c1eb20bd31a675c75cc9b99e1c4dea6596b",
	completedTaskCount: 9,
	priorTotalInputTokens: 49_214,
	priorTotalOutputTokens: 5_792,
	priorTotalModelCalls: 58,
	priorAbortedAttempts: 3,
} as const
const MAX_CALLS = 12
const MAX_TOKENS = 7_900
const GLOBAL_MAX_TOKENS = 100_000
const MAX_WALL_MS = 300_000
const MAX_OUTPUT_TOKENS = 384
const ALLOWED_TOOLS = ["list_files", "read_file", "apply_diff", "execute_command", "attempt_completion"] as const
const SYSTEM_PROMPT = "You are solving one configuration task in a restricted virtual workspace. Use only the supplied virtual tools. Read files before editing. apply_diff replaces the entire virtual file, and expectedRevision is optional. execute_command accepts only the exact command validate. Check the tool result before retrying. Call attempt_completion alone when the task is done."

const TOOLS: ChatTool[] = [
	{ type: "function", function: { name: "list_files", description: "List virtual files.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
	{ type: "function", function: { name: "read_file", description: "Read one virtual file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
	{ type: "function", function: { name: "apply_diff", description: "Replace the complete content of one virtual file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, expectedRevision: { type: "integer" } }, required: ["path", "content"], additionalProperties: false } } },
	{ type: "function", function: { name: "execute_command", description: "Run the virtual validator. The only command is validate.", parameters: { type: "object", properties: { command: { type: "string", enum: ["validate"] } }, required: ["command"], additionalProperties: false } } },
	{ type: "function", function: { name: "attempt_completion", description: "Declare the task complete after checking the virtual result. Call alone.", parameters: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } } },
]

const training = PILOT_FIXTURES.filter((fixture) => fixture.split === "train")
if (training.length !== 12) throw new Error(`expected 12 training fixtures, found ${training.length}`)

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function protocol() {
	return {
		schemaVersion: 1,
		model: MODEL,
		provider: PROVIDER,
		responseModel: RESPONSE_MODEL,
		priorAttempt: PRIOR_ATTEMPT,
		priorAbortedRun: PRIOR_ABORTED_RUN,
		resume: RESUME,
		endpoint: "https://openrouter.ai/api/v1/chat/completions",
		settings: { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS, streaming: false, providerFallbacks: false, reasoningEffort: null },
		taskOrder: training.map((fixture) => fixture.id),
		trainingFixtureHash: digest(training.map(({ oracle, validator, ...data }) => data)),
		systemPromptHash: digest(SYSTEM_PROMPT),
		toolSchemaHash: digest(TOOLS),
		wireHistoryRule: "Drop only assistant messages with empty content and no tool calls; the provider rejects them and they contain no task or observation data.",
		stallLabel: "At a reached iteration boundary, the next three model iterations must each execute a virtual tool. The independent oracle milestone must not rise above its value before the window, and at least one of those turns must contain a virtual tool error or an exact name-and-arguments repeat of the immediately preceding virtual call. A window without all three future turns is masked, not negative. No correction is delivered in this baseline.",
		gate: { minVerifiedSuccesses: 3, maxVerifiedSuccesses: 9, minDistinctStalledTrajectories: 3, denominator: 12, verifiedSuccessRequiresSessionCompletion: true },
		budget: { maxCallsPerRun: MAX_CALLS, maxMeasuredTokensPerRun: MAX_TOKENS, maxWallMsPerRun: MAX_WALL_MS, globalMaxMeasuredTokens: GLOBAL_MAX_TOKENS },
	}
}

export interface PreflightTurn {
	iteration: number
	operations: Array<{ name: string; args: Record<string, unknown>; isError: boolean; result: string }>
	milestone: number
}

/** Future labels are computed only after the run; null masks a short terminal window. */
export function stallLabels(boundaryIterations: readonly number[], turns: readonly PreflightTurn[]): Array<0 | 1 | null> {
	return boundaryIterations.map((iteration) => {
		const future = turns.slice(iteration - 1, iteration + 2)
		if (future.length !== 3 || future.some((turn, offset) => turn.iteration !== iteration + offset || turn.operations.length === 0)) return null
		const before = turns[iteration - 2]?.milestone ?? 0
		const noProgress = future.every((turn) => turn.milestone === before)
		const priorOperations = turns.slice(0, iteration - 1).flatMap((turn) => turn.operations)
		let previous = priorOperations.at(-1)
		let retry = false
		for (const operation of future.flatMap((turn) => turn.operations)) {
			if (operation.isError || (previous !== undefined && operation.name === previous.name && JSON.stringify(operation.args) === JSON.stringify(previous.args))) retry = true
			previous = operation
		}
		return noProgress && retry ? 1 : 0
	})
}

export function feasibilityGate(successes: number, distinctStalledTrajectories: number): boolean {
	return successes >= 3 && successes <= 9 && distinctStalledTrajectories >= 3
}

function completeSchedule(outcomes: readonly unknown[]): boolean { return outcomes.length === 12 }

async function verifyReport(directory: string): Promise<void> {
	const readJournal = async (file: string): Promise<Array<Awaited<ReturnType<typeof runFixture>>>> =>
		(await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Awaited<ReturnType<typeof runFixture>>)
	const priorDirectory = path.join(".headlesscode", "monitor-preflight", "preflight-20260922192522")
	const previous = await readJournal(path.join(RESUME.previousDirectory, "journal.jsonl"))
	const resumed = await readJournal(path.join(directory, "journal.jsonl"))
	const early = await readJournal(path.join(priorDirectory, "journal.jsonl"))
	const outcomes = [...previous.slice(0, RESUME.completedTaskCount), ...resumed]
	if (!completeSchedule(outcomes)) throw new Error(`verify: expected 12 final tasks, got ${outcomes.length}`)
	let successes = 0
	let stalledTrajectories = 0
	for (const [index, outcome] of outcomes.entries()) {
		const fixture = training[index]
		if (!fixture || outcome.fixtureId !== fixture.id) throw new Error(`verify: task order mismatch at ${index}`)
		const simulator = new RestrictedSimulator(fixture)
		for (const turn of outcome.turns) {
			for (const operation of turn.operations) {
				const result = simulator.execute({ name: operation.name, args: operation.args }, `verify:${index}:${turn.iteration}`)
				if (result.result.content !== operation.result || result.result.isError !== operation.isError) throw new Error(`verify: virtual result mismatch for ${fixture.id}`)
			}
		}
		const oracle = fixture.oracle(simulator.virtualFiles)
		if (digest(simulator.virtualFiles) !== outcome.finalArtifactHash || oracle.success !== outcome.oracleSuccess) throw new Error(`verify: oracle replay mismatch for ${fixture.id}`)
		const labels = stallLabels(Array.from({ length: outcome.hookCalls }, (_, offset) => offset + 2), outcome.turns)
		if (JSON.stringify(labels) !== JSON.stringify(outcome.stallLabels)) throw new Error(`verify: stall-label replay mismatch for ${fixture.id}`)
		if (outcome.verifiedSuccess !== (outcome.valid && outcome.sessionStatus === "success" && oracle.success)) throw new Error(`verify: success mismatch for ${fixture.id}`)
		if (outcome.modelCalls > MAX_CALLS || outcome.measuredTokens > MAX_TOKENS || outcome.elapsedMs > MAX_WALL_MS) throw new Error(`verify: resource cap breach for ${fixture.id}`)
		if (outcome.verifiedSuccess) successes++
		if (labels.includes(1)) stalledTrajectories++
	}
	const priorReport = JSON.parse(await fs.readFile(path.join(RESUME.previousDirectory, "final-report.json"), "utf8")) as { measuredTotalTokens: number; modelCalls: number }
	const reported = JSON.parse(await fs.readFile(path.join(directory, "final-report.json"), "utf8")) as { measuredTotalTokens: number; modelCalls: number; manifestHash: string; gatePasses: boolean }
	if (priorReport.measuredTotalTokens !== RESUME.priorTotalInputTokens + RESUME.priorTotalOutputTokens || priorReport.modelCalls !== RESUME.priorTotalModelCalls) throw new Error("verify: prior usage mismatch")
	const allRuns = [...early, ...previous, ...resumed]
	const calls = allRuns.flatMap((run) => run.providerCalls.map((call) => ({ fixtureId: run.fixtureId, ...call })))
	for (const call of calls) if (call.responseId && !call.providerRequestId) await reconcileGeneration(call)
	const totalCalls = 1 + calls.length
	const totalTokens = PRIOR_ATTEMPT.inputTokens + PRIOR_ATTEMPT.outputTokens + allRuns.reduce((sum, run) => sum + run.measuredTokens, 0)
	if (totalCalls !== reported.modelCalls || totalTokens !== reported.measuredTotalTokens || totalTokens > GLOBAL_MAX_TOKENS) throw new Error("verify: global accounting mismatch")
	const gatePasses = feasibilityGate(successes, stalledTrajectories)
	const verified = {
		schemaVersion: 1, sourceReport: path.join(directory, "final-report.json"), sourceManifestHash: reported.manifestHash,
		verification: "All 12 final virtual traces, tool results, artifact hashes, oracle outcomes, and stall labels replayed successfully.",
		gateCorrection: reported.gatePasses === gatePasses ? null : "The initial analysis added an all-valid requirement absent from the frozen two-part gate; the verified gate uses only the frozen counts.",
		finalTasks: 12, independentlyVerifiedSuccesses: successes, distinctStalledTrajectories: stalledTrajectories,
		validStalledTrajectories: outcomes.filter((outcome) => outcome.valid && outcome.qualifyingStallWindows > 0).length,
		qualifyingStallWindows: outcomes.reduce((sum, outcome) => sum + outcome.qualifyingStallWindows, 0),
		maskedTerminalWindows: outcomes.reduce((sum, outcome) => sum + outcome.maskedTerminalWindows, 0),
		invalidFinalTasks: outcomes.filter((outcome) => !outcome.valid).length, abortedPriorAttempts: RESUME.priorAbortedAttempts,
		measuredInputTokens: PRIOR_ATTEMPT.inputTokens + allRuns.reduce((sum, run) => sum + run.inputTokens, 0),
		measuredOutputTokens: PRIOR_ATTEMPT.outputTokens + allRuns.reduce((sum, run) => sum + run.outputTokens, 0),
		measuredTotalTokens: totalTokens, modelCalls: totalCalls,
		unmeasuredRejectedRequests: calls.filter((call) => !call.responseId && call.inputTokens === undefined).length,
		gatePasses,
		recommendation: gatePasses ? "A fresh four-arm evaluation may be warranted. This preflight does not measure learned-monitor benefit." : "STOP the learned-monitor direction; retain deterministic guardrails.",
		strongestLimitation: "The third stalled trajectory was an invalid task with a blocked virtual command attempt; only two valid trajectories stalled. The virtual training set also cannot establish monitor efficacy or real-repository transfer.",
		outcomes: outcomes.map(({ turns, providerCalls, ...outcome }) => outcome),
		providerCalls: [{ fixtureId: "initial-aborted-pin", responseId: PRIOR_ATTEMPT.responseId, providerRequestId: PRIOR_ATTEMPT.requestId, inputTokens: PRIOR_ATTEMPT.inputTokens, outputTokens: PRIOR_ATTEMPT.outputTokens, actualModel: PRIOR_ATTEMPT.actualModel }, ...calls],
	}
	await fs.writeFile(path.join(directory, "verified-report.json"), `${JSON.stringify(verified, null, 2)}\n`, { flag: "wx" })
	process.stdout.write(`${JSON.stringify({ directory: path.resolve(directory), ...verified, outcomes: undefined, providerCalls: undefined })}\n`)
}

interface ProviderCall {
	attempt: number
	droppedEmptyAssistantMessages?: number
	responseId?: string
	httpRequestId?: string
	providerRequestId?: string
	actualModel?: string
	providerName?: string
	model?: string
	inputTokens?: number
	outputTokens?: number
	error?: string
}

class PinnedClient implements LlmClient {
	readonly calls: ProviderCall[] = []
	readonly forbiddenToolAttempts: string[] = []
	private inputTokens = 0
	private outputTokens = 0
	private previousRequestBytes: number | undefined
	private previousPromptTokens: number | undefined

	constructor(private readonly task: string, private readonly startedAt: number) {}

	get measuredTokens(): number { return this.inputTokens + this.outputTokens }
	get measuredInputTokens(): number { return this.inputTokens }
	get measuredOutputTokens(): number { return this.outputTokens }

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		if (request.model !== MODEL || request.messages[0]?.content !== SYSTEM_PROMPT || request.messages[1]?.content !== this.task) throw new Error("outbound request audit failed: model or initial prompt changed")
		if (request.tools?.map((tool) => tool.function.name).join(",") !== ALLOWED_TOOLS.join(",")) throw new Error("outbound request audit failed: virtual tool catalog changed")
		if (this.calls.length >= MAX_CALLS) throw new Error("model-call cap reached")
		const remainingMs = MAX_WALL_MS - (Date.now() - this.startedAt)
		if (remainingMs <= 0) throw new Error("run wall-time cap reached")
		const body = buildRequestBody({ ...request, stream: false, maxTokens: MAX_OUTPUT_TOKENS, temperature: 0, reasoningEffort: undefined }, MODEL)
		body.provider = { order: [PROVIDER], allow_fallbacks: false }
		// The session can retain an empty assistant reply after a model turn.
		// DeepSeek rejects that empty history item; omitting it adds no content.
		const wireMessages = request.messages.filter((message) => message.role !== "assistant" || Boolean(message.content) || (message.tool_calls?.length ?? 0) > 0)
		body.messages = wireMessages
		// Bound prompt growth from the last measured prompt by every byte added
		// to the request, then reduce the output allowance near the cap.
		const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8")
		const inputUpperBound = this.previousPromptTokens === undefined || this.previousRequestBytes === undefined
			? requestBytes + 256
			: this.previousPromptTokens + Math.max(0, requestBytes - this.previousRequestBytes) + 256
		const remainingOutput = MAX_TOKENS - this.measuredTokens - inputUpperBound
		if (remainingOutput < 64) throw new Error("measured-token admission cap reached")
		body.max_tokens = Math.min(MAX_OUTPUT_TOKENS, remainingOutput)
		const entry: ProviderCall = { attempt: this.calls.length + 1, droppedEmptyAssistantMessages: request.messages.length - wireMessages.length }
		this.calls.push(entry)
		const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(remainingMs)]) : AbortSignal.timeout(remainingMs)
		try {
			const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				headers: { Authorization: `Bearer ${process.env.HEADLESSCODE_OPENROUTER_API_KEY ?? ""}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal,
			})
			entry.httpRequestId = response.headers.get("x-request-id") ?? response.headers.get("x-openrouter-request-id") ?? undefined
			const raw = await response.text()
			let data: Record<string, unknown>
			try { data = JSON.parse(raw) as Record<string, unknown> } catch { throw new Error(`provider returned non-JSON HTTP ${response.status}`) }
			entry.responseId = typeof data.id === "string" ? data.id : undefined
			if (!response.ok) throw new Error(`provider HTTP ${response.status}: ${JSON.stringify(data.error ?? data).slice(0, 300)}`)
			entry.model = typeof data.model === "string" ? data.model : undefined
			const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
			if (!Number.isSafeInteger(usage?.prompt_tokens) || !Number.isSafeInteger(usage?.completion_tokens)) throw new Error("provider omitted measured input/output usage")
			entry.inputTokens = usage!.prompt_tokens
			entry.outputTokens = usage!.completion_tokens
			this.previousRequestBytes = requestBytes
			this.previousPromptTokens = entry.inputTokens
			this.inputTokens += entry.inputTokens!
			this.outputTokens += entry.outputTokens!
			if (this.measuredTokens > MAX_TOKENS) throw new Error("provider usage exceeded run token cap")
			if (entry.model !== RESPONSE_MODEL) throw new Error(`provider model identity mismatch: ${entry.model ?? "missing"}`)
			if (!entry.responseId && !entry.httpRequestId) throw new Error("provider omitted request ID")
			const choice = (data.choices as Array<{ message?: LlmResponse["message"] }> | undefined)?.[0]
			if (!choice?.message) throw new Error("provider omitted response message")
			for (const call of choice.message.tool_calls ?? []) {
				if (!ALLOWED_TOOLS.includes(call.function.name as typeof ALLOWED_TOOLS[number])) this.forbiddenToolAttempts.push(call.function.name)
			}
			if (this.forbiddenToolAttempts.length > 0) throw new Error(`model attempted unadvertised tool: ${this.forbiddenToolAttempts.join(",")}`)
			return { message: choice.message, usage: { promptTokens: entry.inputTokens, completionTokens: entry.outputTokens } }
		} catch (error) {
			entry.error = error instanceof Error ? error.message : String(error)
			throw error
		}
	}
}

async function reconcileGeneration(call: ProviderCall): Promise<void> {
	if (!call.responseId) return
	let response: Response | undefined
	for (let attempt = 0; attempt < 6; attempt++) {
		response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(call.responseId)}`, {
			headers: { Authorization: `Bearer ${process.env.HEADLESSCODE_OPENROUTER_API_KEY ?? ""}` },
		})
		if (response.ok || ![404, 429, 500, 502, 503].includes(response.status)) break
		await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
	}
	if (!response?.ok) throw new Error(`generation metadata HTTP ${response?.status ?? "no-response"} for ${call.responseId}`)
	const data = ((await response.json()) as { data?: Record<string, unknown> }).data
	if (!data) throw new Error(`generation metadata missing for ${call.responseId}`)
	call.providerRequestId = typeof data.request_id === "string" ? data.request_id : undefined
	call.actualModel = typeof data.model === "string" ? data.model : undefined
	call.providerName = typeof data.provider_name === "string" ? data.provider_name : undefined
	if (call.actualModel !== MODEL || call.providerName?.toLowerCase() !== PROVIDER || !call.providerRequestId) {
		throw new Error(`generation identity mismatch for ${call.responseId}: ${call.actualModel ?? "missing"} via ${call.providerName ?? "missing"}`)
	}
}

async function runFixture(fixture: PilotFixture, runId: string) {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hc-monitor-preflight-"))
	const startedAt = Date.now()
	const simulator = new RestrictedSimulator(fixture)
	const client = new PinnedClient(fixture.task, startedAt)
	const executor = new ToolExecutor(workspaceRoot)
	const turns = new Map<number, PreflightTurn>()
	const boundaries: IterationBoundarySnapshot[] = []
	const getTurn = (iteration: number): PreflightTurn => {
		let turn = turns.get(iteration)
		if (!turn) { turn = { iteration, operations: [], milestone: 0 }; turns.set(iteration, turn) }
		return turn
	}
	for (const name of ALLOWED_TOOLS) {
		executor.register(name, async (args) => {
			const iteration = client.calls.length
			const execution = simulator.execute({ name, args }, `${runId}:${iteration}:${getTurn(iteration).operations.length + 1}`)
			const turn = getTurn(iteration)
			turn.operations.push({ name, args, isError: execution.result.isError, result: execution.result.content })
			turn.milestone = fixture.oracle(simulator.virtualFiles).milestone
			return { content: execution.result.content, isError: execution.result.isError }
		})
	}
	let sessionStatus = "aborted"
	let sessionError: string | undefined
	try {
		const session = new HeadlessSession({
			workspaceRoot, taskText: fixture.task, systemPromptOverride: SYSTEM_PROMPT,
			model: MODEL, mode: "code", llmClient: client, executor, tools: TOOLS, customModes: [],
			temperature: 0, maxTokens: MAX_OUTPUT_TOKENS, maxIterations: MAX_CALLS,
			budget: { maxDurationMs: MAX_WALL_MS, maxIterations: MAX_CALLS }, llmTimeoutMs: 60_000,
			stream: false, checkpoints: false, disableLlmCondensation: true, trackCost: false,
			iterationBoundaryHook: (snapshot) => { boundaries.push(snapshot); return undefined },
		})
		const result = await session.run()
		sessionStatus = result.status
		sessionError = result.error
	} catch (error) {
		sessionError = error instanceof Error ? error.message : String(error)
	} finally {
		await fs.rm(workspaceRoot, { recursive: true, force: true })
	}
	for (const call of client.calls) {
		if (!call.responseId) continue
		try { await reconcileGeneration(call) } catch (error) { call.error = error instanceof Error ? error.message : String(error) }
	}
	const elapsedMs = Date.now() - startedAt
	const oracle = fixture.oracle(simulator.virtualFiles)
	let milestone = 0
	const completedTurns: PreflightTurn[] = []
	for (let iteration = 1; iteration <= client.calls.length; iteration++) {
		const turn = getTurn(iteration)
		if (turn.operations.length > 0) milestone = turn.milestone
		else turn.milestone = milestone
		completedTurns.push(turn)
	}
	const labels = stallLabels(boundaries.map((boundary) => boundary.iteration), completedTurns)
	const aborted = Boolean(client.calls.some((call) => call.error)) || elapsedMs > MAX_WALL_MS || client.measuredTokens > MAX_TOKENS || client.calls.length > MAX_CALLS
	const valid = !aborted && simulator.forbiddenEffectAttempts.length === 0 && client.forbiddenToolAttempts.length === 0
	return {
		runId, fixtureId: fixture.id, family: fixture.family, valid, aborted,
		verifiedSuccess: valid && sessionStatus === "success" && oracle.success,
		sessionStatus, sessionError, oracleSuccess: oracle.success, oracleReason: oracle.reason,
		modelCalls: client.calls.length, inputTokens: client.measuredInputTokens, outputTokens: client.measuredOutputTokens,
		measuredTokens: client.measuredTokens, elapsedMs, providerCalls: client.calls,
		hookCalls: boundaries.length, stallLabels: labels, qualifyingStallWindows: labels.filter((label) => label === 1).length,
		maskedTerminalWindows: labels.filter((label) => label === null).length,
		invalidToolResults: completedTurns.flatMap((turn) => turn.operations).filter((operation) => operation.isError).length,
		forbiddenEffectAttempts: simulator.forbiddenEffectAttempts.length + client.forbiddenToolAttempts.length,
		finalArtifactHash: digest(simulator.virtualFiles),
		turns: completedTurns,
	}
}

async function main() {
	const [command, directory] = process.argv.slice(2)
	if (command === "freeze") {
		const dir = directory ?? path.join(".headlesscode", "monitor-preflight", `preflight-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`)
		await fs.mkdir(dir, { recursive: true })
		const manifest = { ...protocol(), frozenAt: new Date().toISOString(), freezeId: randomUUID() }
		await fs.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" })
		process.stdout.write(`${path.resolve(dir)}\n`)
		return
	}
	if (command === "verify" && directory) { await verifyReport(directory); return }
	if (command !== "run" || !directory) throw new Error("usage: tsx scripts/monitor-pilot/preflight.ts freeze [directory] | run <directory>")
	if (!process.env.HEADLESSCODE_OPENROUTER_API_KEY) throw new Error("model access unavailable: HEADLESSCODE_OPENROUTER_API_KEY is unset")
	const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as Record<string, unknown>
	for (const [key, value] of Object.entries(protocol())) if (JSON.stringify(manifest[key]) !== JSON.stringify(value)) throw new Error(`frozen protocol mismatch: ${key}`)
	const previousReportRaw = await fs.readFile(path.join(RESUME.previousDirectory, "final-report.json"), "utf8")
	const previousJournalRaw = await fs.readFile(path.join(RESUME.previousDirectory, "journal.jsonl"), "utf8")
	const rawHash = (value: string) => createHash("sha256").update(value).digest("hex")
	if (rawHash(previousReportRaw) !== RESUME.reportSha256 || rawHash(previousJournalRaw) !== RESUME.journalSha256) throw new Error("resume artifact hash mismatch")
	const previousRecords = previousJournalRaw.trim().split("\n").map((line) => JSON.parse(line) as Awaited<ReturnType<typeof runFixture>>)
	const outcomes = previousRecords.slice(0, RESUME.completedTaskCount)
	if (outcomes.length !== RESUME.completedTaskCount || outcomes.some((outcome, index) => !outcome.valid || outcome.fixtureId !== training[index]?.id)) throw new Error("resume task order or validity mismatch")
	let globalTokens = RESUME.priorTotalInputTokens + RESUME.priorTotalOutputTokens
	let modelAccessBlocker: string | undefined
	const journalPath = path.join(directory, "journal.jsonl")
	for (const fixture of training.slice(RESUME.completedTaskCount)) {
		if (GLOBAL_MAX_TOKENS - globalTokens < MAX_TOKENS) break
		const outcome = await runFixture(fixture, `${manifest.freezeId}:${fixture.id}`)
		outcomes.push(outcome)
		globalTokens += outcome.measuredTokens
		await fs.appendFile(journalPath, `${JSON.stringify(outcome)}\n`)
		process.stdout.write(`${fixture.id}: ${outcome.verifiedSuccess ? "verified success" : outcome.aborted ? "aborted" : "unsuccessful"}; ${outcome.modelCalls} calls, ${outcome.measuredTokens} tokens, ${outcome.qualifyingStallWindows} stalls\n`)
		const firstError = outcome.providerCalls.find((call) => call.error)?.error
		if (firstError && /provider HTTP|provider returned|provider model identity mismatch|provider omitted|generation metadata|generation identity mismatch|fetch failed|model access unavailable/i.test(firstError)) {
			modelAccessBlocker = firstError
			break
		}
	}
	const successes = outcomes.filter((outcome) => outcome.verifiedSuccess).length
	const stalledTrajectories = outcomes.filter((outcome) => outcome.qualifyingStallWindows > 0).length
	const gatePasses = completeSchedule(outcomes) && feasibilityGate(successes, stalledTrajectories)
	const report = {
		manifestHash: digest(manifest), priorAttempt: PRIOR_ATTEMPT, priorAbortedRun: PRIOR_ABORTED_RUN, resumedFrom: RESUME, scheduled: 12, completed: outcomes.length,
		valid: outcomes.filter((outcome) => outcome.valid).length,
		invalid: outcomes.filter((outcome) => !outcome.valid).length,
		aborted: RESUME.priorAbortedAttempts + outcomes.filter((outcome) => outcome.aborted).length,
		verifiedSuccesses: successes, distinctStalledTrajectories: stalledTrajectories,
		qualifyingStallWindows: outcomes.reduce((sum, outcome) => sum + outcome.qualifyingStallWindows, 0),
		maskedTerminalWindows: outcomes.reduce((sum, outcome) => sum + outcome.maskedTerminalWindows, 0),
		measuredInputTokens: RESUME.priorTotalInputTokens + outcomes.slice(RESUME.completedTaskCount).reduce((sum, outcome) => sum + outcome.inputTokens, 0),
		measuredOutputTokens: RESUME.priorTotalOutputTokens + outcomes.slice(RESUME.completedTaskCount).reduce((sum, outcome) => sum + outcome.outputTokens, 0),
		measuredTotalTokens: globalTokens, priorAbortedModelCalls: RESUME.priorTotalModelCalls - outcomes.slice(0, RESUME.completedTaskCount).reduce((sum, outcome) => sum + outcome.modelCalls, 0),
		modelCalls: RESUME.priorTotalModelCalls + outcomes.slice(RESUME.completedTaskCount).reduce((sum, outcome) => sum + outcome.modelCalls, 0),
		gatePasses, modelAccessBlocker,
		recommendation: modelAccessBlocker ? "INCOMPLETE: model access blocked the preflight; no feasibility verdict is available." : gatePasses ? "A fresh four-arm evaluation may be warranted; this preflight does not measure monitor benefit." : "STOP the learned-monitor direction after this preflight; retain deterministic guardrails.",
		strongestLimitation: "Twelve small virtual training fixtures and one model do not establish learned-monitor efficacy or transfer to real repositories.",
		outcomes: outcomes.map(({ turns, providerCalls, ...outcome }) => ({ ...outcome, providerCalls })),
	}
	await fs.writeFile(path.join(directory, "final-report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" })
	process.stdout.write(`${JSON.stringify({ directory: path.resolve(directory), ...report, outcomes: undefined })}\n`)
}

if (process.argv[1]?.endsWith("preflight.ts")) await main()
