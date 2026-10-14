import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import type { LlmRequest, LlmResponse } from "../../engine/types.js"
import type { OpenRouterGenerationMetadata } from "../../llm/openrouter.js"
import { MONITOR_FEATURE_ORDER, type FrozenPredictorArtifact } from "../types.js"
import { sha256 } from "../features.js"
import { DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD, identicalCallNudgeMessage } from "../guardrails.js"
import { PilotJournal } from "../../../scripts/monitor-pilot/journal.js"
import { collectLiveDevelopment, collectLiveHeldout, DEFAULT_MAX_OUTPUT_TOKENS, deriveCalibrationRandomSchedule, LIVE_DEVELOPMENT_SLOTS, LIVE_EXPERIMENT_ID, LIVE_GUARDRAILS_HASH, LIVE_GUARDRAILS_MANIFEST, LIVE_MODEL, LIVE_MODEL_DIGEST, LIVE_TOOLS } from "../../../scripts/monitor-pilot/live-runner.js"
import { fixtureHash, splitHash } from "../../../scripts/monitor-pilot/fixtures.js"
import { main as liveCliMain } from "../../../scripts/monitor-pilot/live.js"
import { TEMPLATE_TEXT } from "../controller.js"

type Reply = { readonly name: string; readonly args?: string; readonly content?: string }
type MockBillingOverrides = {
	readonly responseUsage?: LlmResponse["usage"] | ((requestIndex: number) => LlmResponse["usage"])
	readonly metadata?: Partial<OpenRouterGenerationMetadata> | ((requestIndex: number) => Partial<OpenRouterGenerationMetadata>)
	readonly failBeforeResponse?: boolean
	readonly repeatReplies?: boolean
}

class MockBillingClient {
	readonly requests: LlmRequest[] = []
	readonly replies: Reply[]
	readonly responseModel: string
	readonly provider: string
	readonly overrides: MockBillingOverrides
	private sequence = 0

	constructor(replies: readonly Reply[], responseModel = LIVE_MODEL, provider = "Meta", overrides: MockBillingOverrides = {}) {
		this.replies = [...replies]
		this.responseModel = responseModel
		this.provider = provider
		this.overrides = overrides
	}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		if (this.overrides.failBeforeResponse) throw new Error("synthetic response transport failure")
		assert.equal(request.model, LIVE_MODEL)
		assert.equal(request.providerOnly, "meta")
		assert.equal(request.stream, true)
		assert.deepEqual((request.tools ?? []).map((tool) => tool.function.name), LIVE_TOOLS.map((tool) => tool.function.name))
		const requestIndex = this.sequence++
		const reply = this.replies[this.overrides.repeatReplies ? requestIndex % this.replies.length : Math.min(requestIndex, this.replies.length - 1)]
		const id = `gen-${requestIndex}`
		const responseUsage = this.overrides.responseUsage
		return {
			message: {
				role: "assistant",
				content: reply.content ?? null,
				tool_calls: [{ id: `provider-tool-${id}`, type: "function", function: { name: reply.name, arguments: reply.args ?? "{}" } }],
			},
			usage: typeof responseUsage === "function" ? responseUsage(requestIndex) : responseUsage ?? { promptTokens: 100, completionTokens: 5, totalTokens: 105, cachedTokens: 20 },
			generationId: id,
			returnedModel: this.responseModel,
			providerName: this.provider,
		}
	}

	async fetchGenerationMetadata(id: string) {
		const metadata = this.overrides.metadata
		const override = typeof metadata === "function" ? metadata(Number(id.slice(4))) : metadata
		return { id, model: LIVE_MODEL, providerName: "Meta", totalCostUsd: 0.000001, tokensPrompt: 100, tokensCompletion: 5, nativeTokensPrompt: 100, nativeTokensCompletion: 5, nativeTokensCached: 20, cacheDiscountUsd: 0, ...override }
	}
}

async function scratch(): Promise<string> {
	const root = path.resolve(".headlesscode/scratch/monitor-live-tests")
	await fs.mkdir(root, { recursive: true, mode: 0o700 })
	const child = path.join(root, randomUUID())
	await fs.mkdir(child, { mode: 0o700 })
	return child
}

async function testBillingIdentityPrecedesVirtualEffects(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "apply_diff", args: JSON.stringify({ path: "config.json", content: "changed" }) }], "unapproved/model")
		const summary = await collectLiveDevelopment({ outputDir: directory, client })
		assert.equal(summary.predictorStatus, "STOP")
		assert.match(summary.stopReason ?? "", /uncertain/)
		const journal = new PilotJournal(path.join(directory, "development", "journal.jsonl"))
		await journal.open()
		const records = journal.list()
		assert.equal(records.some((record) => record.type === "llm_response_received"), true, "unadmitted identities remain in the private append-only audit")
		assert.equal(records.some((record) => record.type === "virtual_turn"), false, "unverified billing identity must block all tool dispatch")
		assert.equal(records.some((record) => record.type === "trajectory_finished"), false)
		assert.equal(client.requests[0]?.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS)
		const manifest = JSON.parse(await fs.readFile(path.join(directory, "development", "manifest.json"), "utf8")) as { modelSettings: { maxOutputTokens: number }; outputDirectory: string }
		assert.equal(manifest.modelSettings.maxOutputTokens, 512, "the frozen default remains 512 tokens")
		assert.equal(manifest.outputDirectory, path.resolve(directory))
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testOutputCapValidationAndFrozenResumeConfiguration(): Promise<void> {
	const directory = await scratch()
	try {
		const invalidClient = new MockBillingClient([{ name: "attempt_completion" }])
		await assert.rejects(() => collectLiveDevelopment({ outputDir: directory, client: invalidClient, maxOutputTokens: 0 }), /max output tokens must be an integer/)
		assert.equal(invalidClient.requests.length, 0, "an invalid cap fails before any request")
		assert.equal(await liveCliMain(["collect-development", "--max-output-tokens", "4097"]), 2, "CLI rejects a cap above its configured bound")
		const configuredClient = new MockBillingClient([{ name: "attempt_completion", args: JSON.stringify({ result: "done" }) }])
		const configured = await collectLiveDevelopment({ outputDir: directory, client: configuredClient, maxOutputTokens: 2048 })
		assert.equal(configuredClient.requests[0]?.maxTokens, 2048)
		const manifest = JSON.parse(await fs.readFile(path.join(directory, "development", "manifest.json"), "utf8")) as { modelSettings: { maxOutputTokens: number }; outputDirectory: string }
		assert.equal(manifest.modelSettings.maxOutputTokens, 2048)
		assert.equal(manifest.outputDirectory, path.resolve(directory))
		const changedClient = new MockBillingClient([{ name: "attempt_completion" }])
		await assert.rejects(() => collectLiveDevelopment({ outputDir: directory, client: changedClient, maxOutputTokens: 1024 }), /manifest changed; refusing resume/)
		assert.equal(changedClient.requests.length, 0, "resume rejects a changed cap before inference")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testForbiddenToolHasZeroEffectsAndIsRecorded(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "node:fs", args: "not-json" }])
		const summary = await collectLiveDevelopment({ outputDir: directory, client })
		assert.equal(summary.completedRuns, 32)
		assert.equal(summary.unstartedSlots, 0)
		assert.equal(summary.invalidCompletedRuns, 32, "forbidden-only completions are recorded separately from unstarted slots")
		assert.equal(summary.abortedAttempts, 0)
		assert.equal(summary.predictorStatus, "STOP")
		const journal = new PilotJournal(summary.journalPath)
		await journal.open()
		const attempts = journal.list().filter((record) => record.type === "forbidden_operation")
		assert.equal(attempts.length, 32)
		assert.equal(attempts.every((record) => record.payload.hostEffects === 0), true)
		const outcomes = journal.list().filter((record) => record.type === "attempt_completed").map((record) => record.payload.outcome as { valid: boolean; forbiddenEffectAttempts: number; success: boolean })
		assert.equal(outcomes.every((outcome) => !outcome.valid && outcome.forbiddenEffectAttempts === 1 && !outcome.success), true)
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testShortLabelWindowsAreMasked(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "list_files" }])
		const summary = await collectLiveDevelopment({ outputDir: directory, client })
		const journal = new PilotJournal(summary.journalPath)
		await journal.open()
		const first = journal.list().find((record) => record.type === "attempt_completed")!
		const outcome = first.payload.outcome as { detectionLabels: readonly (0 | 1 | null)[]; stopReason: string; redundantCalls: number }
		assert.deepEqual(outcome.detectionLabels, [1, null, null], "windows without three later uncorrected turns are masked, not negative")
		assert.equal(outcome.stopReason, "identical-call-stop")
		assert.equal(outcome.redundantCalls, 3)
		const turns = journal.list().filter((record) => record.type === "virtual_turn" && record.attemptId === first.attemptId)
		const ids = turns.flatMap((turn) => (turn.payload.calls as { id: string }[]).map((call) => call.id))
		assert.equal(new Set(ids).size, ids.length, "tool evidence IDs remain unique across model turns")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testDevelopmentScheduleUsesSyntheticBillingOnly(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "attempt_completion", args: JSON.stringify({ result: "done" }) }])
		const summary = await collectLiveDevelopment({ outputDir: directory, client })
		assert.equal(summary.scheduledRuns, 32)
		assert.equal(summary.completedRuns, 32)
		assert.equal(summary.predictorStatus, "STOP")
		assert.match(summary.stopReason ?? "", /positive (?:train|calibration) windows/)
		assert.equal(client.requests.length, LIVE_DEVELOPMENT_SLOTS.length)
		assert.equal(summary.attempts, LIVE_DEVELOPMENT_SLOTS.length)
		assert.equal(summary.abortedAttempts, 0)
		assert.equal(summary.unstartedSlots, 0)
		assert.equal(summary.invalidCompletedRuns, 0)
		assert.deepEqual({ ...summary.billing, totalBilledCostUsd: 0 }, {
			admittedRequests: LIVE_DEVELOPMENT_SLOTS.length,
			responsesReceived: LIVE_DEVELOPMENT_SLOTS.length,
			unresolvedRequests: 0,
			generationRecords: LIVE_DEVELOPMENT_SLOTS.length,
			acceptedBillingRecords: LIVE_DEVELOPMENT_SLOTS.length,
			unacceptedBillingRecords: 0,
			unbilledResponses: 0,
			promptTokens: LIVE_DEVELOPMENT_SLOTS.length * 100,
			completionTokens: LIVE_DEVELOPMENT_SLOTS.length * 5,
			cachedPromptTokens: LIVE_DEVELOPMENT_SLOTS.length * 20,
			cachedTokenReports: LIVE_DEVELOPMENT_SLOTS.length,
			totalBilledCostUsd: 0,
			totalCacheDiscountUsd: 0,
		})
		assert.ok(Math.abs(summary.billing.totalBilledCostUsd - LIVE_DEVELOPMENT_SLOTS.length * 0.000001) < 1e-15)
		const manifestPath = path.join(directory, "development", "manifest.json")
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { sourceIdentity: { files: { path: string; bytes: number; sha256: string }[]; sha256: string } }
		assert.equal(manifest.sourceIdentity.files.some((file) => file.path === "src/llm/request-budget.ts"), true)
		assert.equal(manifest.sourceIdentity.files.some((file) => file.path === "src/monitoring/predictor.ts"), true)
		assert.equal(manifest.sourceIdentity.files.every((file) => file.bytes > 0 && /^[0-9a-f]{64}$/.test(file.sha256)), true)
		assert.equal(manifest.sourceIdentity.sha256, sha256(manifest.sourceIdentity.files))
		manifest.sourceIdentity.files[0]!.sha256 = "0".repeat(64)
		manifest.sourceIdentity.sha256 = sha256(manifest.sourceIdentity.files)
		await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
		const resumedClient = new MockBillingClient([{ name: "attempt_completion" }])
		await assert.rejects(() => collectLiveDevelopment({ outputDir: directory, client: resumedClient }), /manifest changed; refusing resume/)
		assert.equal(resumedClient.requests.length, 0, "changed source identities reject before any resumed inference")
		const journal = new PilotJournal(summary.journalPath)
		await journal.open()
		const global = new PilotJournal(path.join(directory, "global-budget.jsonl"))
		await global.open()
		assert.equal(global.list().filter((record) => record.type === "budget_reserved").length, 32)
		assert.equal(global.list().filter((record) => record.type === "budget_settled").length, 32)
		const first = journal.list().find((record) => record.type === "llm_response_billed")!
		assert.equal((first.payload.usage as { cachedTokens: number }).cachedTokens, 20)
		assert.equal((first.payload.billing as { totalCostUsd: number }).totalCostUsd, 0.000001)
		assert.equal((await fs.stat(summary.journalPath)).mode & 0o777, 0o600)
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testNativeGenerationTokensOverrideNormalizedAccounting(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "attempt_completion", args: JSON.stringify({ result: "done" }) }], LIVE_MODEL, "Meta", {
			responseUsage: { promptTokens: 862, completionTokens: 66, totalTokens: 928, cachedTokens: 20 },
			metadata: { tokensPrompt: 411, tokensCompletion: 24, nativeTokensPrompt: 862, nativeTokensCompletion: 66 },
		})
		const summary = await collectLiveDevelopment({ outputDir: directory, client })
		assert.equal(summary.completedRuns, 32)
		assert.equal(summary.billing.promptTokens, 32 * 862)
		assert.equal(summary.billing.completionTokens, 32 * 66)
		assert.equal(summary.billing.acceptedBillingRecords, 32)
		const journal = new PilotJournal(summary.journalPath)
		await journal.open()
		const first = journal.list().find((record) => record.type === "llm_response_billed")!
		assert.deepEqual(first.payload.usage && {
			promptTokens: (first.payload.usage as { promptTokens: number }).promptTokens,
			normalizedPromptTokens: (first.payload.usage as { normalizedPromptTokens: number }).normalizedPromptTokens,
			normalizedCompletionTokens: (first.payload.usage as { normalizedCompletionTokens: number }).normalizedCompletionTokens,
		}, { promptTokens: 862, normalizedPromptTokens: 411, normalizedCompletionTokens: 24 })
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testFiniteBillingIsCountedWhenAdmissionAborts(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "attempt_completion" }], "unapproved/model", "Meta", {
			responseUsage: { promptTokens: 862, completionTokens: 66 },
			metadata: { totalCostUsd: 0.0000994, tokensPrompt: 411, tokensCompletion: 24, nativeTokensPrompt: 862, nativeTokensCompletion: 66 },
		})
		const summary = await collectLiveDevelopment({ outputDir: directory, client })
		assert.equal(summary.abortedAttempts, 1)
		assert.equal(summary.billing.responsesReceived, 1)
		assert.equal(summary.billing.generationRecords, 1)
		assert.equal(summary.billing.acceptedBillingRecords, 0, "route identity failure remains unaccepted")
		assert.equal(summary.billing.unacceptedBillingRecords, 1)
		assert.equal(summary.billing.unbilledResponses, 0, "a finite matched generation record is not called unbilled just because admission aborted")
		assert.equal(summary.billing.promptTokens, 862)
		assert.equal(summary.billing.completionTokens, 66)
		assert.equal(summary.billing.totalBilledCostUsd, 0.0000994, "the received provider charge remains in totals after admission failure")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testUncertainRequestIsNotAutomaticallyReplayed(): Promise<void> {
	const directory = await scratch()
	try {
		const badClient = new MockBillingClient([{ name: "attempt_completion" }], "unapproved/model")
		const first = await collectLiveDevelopment({ outputDir: directory, client: badClient })
		assert.equal(first.predictorStatus, "STOP")
		assert.equal(first.completedRuns, 0)
		assert.equal(first.abortedAttempts, 1)
		assert.equal(first.unstartedSlots, LIVE_DEVELOPMENT_SLOTS.length - 1)
		assert.equal(first.billing.admittedRequests, 1)
		assert.equal(first.billing.responsesReceived, 1)
		assert.equal(first.billing.unresolvedRequests, 0)
		assert.equal(first.billing.generationRecords, 1)
		assert.equal(first.billing.acceptedBillingRecords, 0)
		assert.equal(first.billing.unacceptedBillingRecords, 1)
		assert.equal(first.billing.unbilledResponses, 0, "finite generation billing remains counted despite an unadmitted response identity")
		assert.equal(badClient.requests.length, 1)
		const goodClient = new MockBillingClient([{ name: "attempt_completion", args: JSON.stringify({ result: "done" }) }])
		const resumed = await collectLiveDevelopment({ outputDir: directory, client: goodClient })
		assert.equal(resumed.predictorStatus, "STOP")
		assert.match(resumed.stopReason ?? "", /uncertain attempt/)
		assert.equal(goodClient.requests.length, 0, "uncertain paid slot is not replayed without explicit retry")
		const global = new PilotJournal(path.join(directory, "global-budget.jsonl"))
		await global.open()
		assert.equal(global.list().filter((record) => record.type === "budget_reserved").length, 1)
		assert.equal(global.list().filter((record) => record.type === "budget_settled").length, 0, "unresolved reservation remains fully charged")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testCopiedGlobalLedgerEpochsDoNotBlockResume(): Promise<void> {
	const directory = await scratch()
	try {
		const firstSlot = LIVE_DEVELOPMENT_SLOTS[0]!
		const global = new PilotJournal(path.join(directory, "global-budget.jsonl"))
		await global.open()
		for (const epoch of [1, 2]) {
			const attemptId = `prior-attempt-${epoch}`
			await global.append("budget_reserved", LIVE_EXPERIMENT_ID, { attemptId, runId: firstSlot.slotKey, maxTokens: 20000, maxWallMs: 300000 }, { runId: firstSlot.slotKey, attemptId, epoch })
			await global.append("budget_settled", LIVE_EXPERIMENT_ID, { attemptId, actualTokens: 100, actualWallMs: 100 }, { runId: firstSlot.slotKey, attemptId, epoch })
		}
		const client = new MockBillingClient([{ name: "attempt_completion", args: JSON.stringify({ result: "done" }) }])
		const summary = await collectLiveDevelopment({ outputDir: directory, client })
		assert.equal(summary.completedRuns, 32)
		const journal = new PilotJournal(summary.journalPath)
		await journal.open()
		const first = journal.list().find((record) => record.type === "attempt_started" && record.payload.slotKey === firstSlot.slotKey)!
		assert.equal(first.epoch, 3, "resume advances past epochs already recorded in the copied shared ledger")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testKnownPerRunAdmissionStopCompletesAndSettlesTrajectory(): Promise<void> {
	const directory = await scratch()
	try {
		const replies: Reply[] = [
			{ name: "list_files" },
			{ name: "apply_diff", args: JSON.stringify({ path: "missing-1", content: "changed" }) },
			{ name: "list_files" },
			{ name: "apply_diff", args: JSON.stringify({ path: "missing-2", content: "changed" }) },
			{ name: "list_files" },
			{ name: "apply_diff", args: JSON.stringify({ path: "missing-3", content: "changed" }) },
			{ name: "list_files" },
			{ name: "apply_diff", args: JSON.stringify({ path: "missing-4", content: "changed" }) },
		]
		const usageAt = (requestIndex: number) => ({
			promptTokens: requestIndex % replies.length === replies.length - 1 ? 12_500 : 1_000,
			completionTokens: 5,
			totalTokens: (requestIndex % replies.length === replies.length - 1 ? 12_500 : 1_000) + 5,
			cachedTokens: 0,
		})
		const client = new MockBillingClient(replies, LIVE_MODEL, "Meta", {
			responseUsage: usageAt,
			metadata: (requestIndex) => {
				const usage = usageAt(requestIndex)
				return { tokensPrompt: usage.promptTokens, tokensCompletion: usage.completionTokens, nativeTokensPrompt: usage.promptTokens, nativeTokensCompletion: usage.completionTokens, nativeTokensCached: 0 }
			},
			repeatReplies: true,
		})
		const summary = await collectLiveDevelopment({ outputDir: directory, client, maxOutputTokens: 2048 })
		assert.equal(summary.scheduledRuns, LIVE_DEVELOPMENT_SLOTS.length)
		assert.equal(summary.completedRuns, LIVE_DEVELOPMENT_SLOTS.length, "a known pre-request budget stop is a completed bounded trajectory")
		assert.equal(summary.abortedAttempts, 0)
		assert.equal(summary.unstartedSlots, 0, "later frozen development slots still run")
		assert.equal(summary.billing.admittedRequests, LIVE_DEVELOPMENT_SLOTS.length * replies.length, "only the first eight requests per slot were admitted")
		assert.equal(summary.billing.responsesReceived, LIVE_DEVELOPMENT_SLOTS.length * replies.length)
		assert.equal(summary.billing.unresolvedRequests, 0)
		assert.equal(summary.billing.acceptedBillingRecords, LIVE_DEVELOPMENT_SLOTS.length * replies.length)
		const promptTokensPerRun = 7 * 1_000 + 12_500
		const tokensPerRun = promptTokensPerRun + replies.length * 5
		assert.equal(summary.billing.promptTokens, LIVE_DEVELOPMENT_SLOTS.length * promptTokensPerRun)
		assert.equal(summary.billing.completionTokens, LIVE_DEVELOPMENT_SLOTS.length * replies.length * 5)
		assert.ok(Math.abs(summary.billing.totalBilledCostUsd - LIVE_DEVELOPMENT_SLOTS.length * replies.length * 0.000001) < 1e-15)
		assert.equal(client.requests.length, LIVE_DEVELOPMENT_SLOTS.length * replies.length, "the rejected ninth request never reaches the fake provider")
		assert.equal(client.requests.every((request) => request.maxTokens === 2048), true, "the frozen output cap remains in force")
		const journal = new PilotJournal(summary.journalPath)
		await journal.open()
		const records = journal.list()
		const outcomes = records.filter((record) => record.type === "attempt_completed").map((record) => record.payload.outcome as { stopReason: string; detectionLabels: readonly (0 | 1 | null)[] })
		assert.equal(outcomes.length, LIVE_DEVELOPMENT_SLOTS.length)
		assert.equal(outcomes.every((outcome) => outcome.stopReason === "per-run-token-budget-exhausted"), true)
		assert.equal(outcomes.every((outcome) => outcome.detectionLabels.length === replies.length && outcome.detectionLabels.slice(-3).every((label) => label === null)), true, "the final three windows without complete lookahead stay masked")
		assert.equal(records.filter((record) => record.type === "attempt_aborted").length, 0)
		assert.equal(records.filter((record) => record.type === "trajectory_finished").length, LIVE_DEVELOPMENT_SLOTS.length)
		const global = new PilotJournal(path.join(directory, "global-budget.jsonl"))
		await global.open()
		const settlements = global.list().filter((record) => record.type === "budget_settled")
		assert.equal(settlements.length, LIVE_DEVELOPMENT_SLOTS.length)
		assert.equal(settlements.every((record) => record.payload.actualTokens === tokensPerRun), true, "each reservation settles with its accepted provider usage")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testResponseWithoutFiniteGenerationCostIsUnbilled(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "attempt_completion" }], LIVE_MODEL, "Meta", { metadata: { totalCostUsd: undefined } })
		const summary = await collectLiveDevelopment({ outputDir: directory, client })
		assert.equal(summary.billing.responsesReceived, 1)
		assert.equal(summary.billing.generationRecords, 1)
		assert.equal(summary.billing.acceptedBillingRecords, 0)
		assert.equal(summary.billing.unacceptedBillingRecords, 0)
		assert.equal(summary.billing.unbilledResponses, 1, "a generation record without finite cost is not billed evidence")
		assert.equal(summary.billing.totalBilledCostUsd, 0)
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testAdmittedRequestWithoutResponseIsShownAsUnresolved(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "attempt_completion" }], LIVE_MODEL, "Meta", { failBeforeResponse: true })
		const summary = await collectLiveDevelopment({ outputDir: directory, client })
		assert.equal(summary.abortedAttempts, 1)
		assert.equal(summary.billing.admittedRequests, 1)
		assert.equal(summary.billing.responsesReceived, 0)
		assert.equal(summary.billing.unresolvedRequests, 1, "a timed-out or failed admitted request remains visibly charge-uncertain")
		assert.equal(summary.billing.unbilledResponses, 0)
		const journal = new PilotJournal(summary.journalPath)
		await journal.open()
		const aborted = journal.list().find((record) => record.type === "attempt_aborted")!
		assert.equal(aborted.payload.failureCode, "provider-or-unclassified-error")
		assert.equal(JSON.stringify(aborted.payload).includes("synthetic response transport failure"), false, "raw provider errors are not persisted")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testCompletionOverrunIsJournaledBeforeAnyToolDispatch(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "attempt_completion", args: JSON.stringify({ result: "must not dispatch" }) }], LIVE_MODEL, "Meta", {
			responseUsage: { promptTokens: 100, completionTokens: 2049, totalTokens: 2149, cachedTokens: 20 },
			metadata: { totalCostUsd: 0.0000994, tokensPrompt: 100, tokensCompletion: 2049, nativeTokensPrompt: 100, nativeTokensCompletion: 2049, nativeTokensCached: 20 },
		})
		const summary = await collectLiveDevelopment({ outputDir: directory, client, maxOutputTokens: 2048 })
		assert.equal(summary.abortedAttempts, 1)
		assert.equal(summary.completedRuns, 0)
		assert.equal(summary.unstartedSlots, LIVE_DEVELOPMENT_SLOTS.length - 1)
		assert.equal(client.requests.length, 1)
		assert.equal(client.requests[0]?.maxTokens, 2048)
		assert.equal(summary.billing.responsesReceived, 1)
		assert.equal(summary.billing.generationRecords, 1)
		assert.equal(summary.billing.acceptedBillingRecords, 0)
		assert.equal(summary.billing.unacceptedBillingRecords, 1)
		assert.equal(summary.billing.unbilledResponses, 0)
		assert.equal(summary.billing.completionTokens, 2049)
		assert.equal(summary.billing.totalBilledCostUsd, 0.0000994)
		const journal = new PilotJournal(summary.journalPath)
		await journal.open()
		const records = journal.list()
		assert.equal(records.some((record) => record.type === "virtual_turn"), false, "over-cap response is rejected before tool dispatch")
		assert.equal(records.some((record) => record.type === "llm_response_received"), true)
		assert.equal(records.some((record) => record.type === "llm_billing_metadata_received"), true)
		assert.equal(records.some((record) => record.type === "llm_response_billed"), false)
		const aborted = records.find((record) => record.type === "attempt_aborted")!
		assert.equal(aborted.payload.failureCode, "completion-exceeded-request-cap")
		const global = new PilotJournal(path.join(directory, "global-budget.jsonl"))
		await global.open()
		assert.equal(global.list().filter((record) => record.type === "budget_reserved").length, 1)
		assert.equal(global.list().filter((record) => record.type === "budget_settled").length, 0, "full reservation remains charged after the rejected paid response")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

function reasoningHeavyClient(): MockBillingClient {
	const done = { name: "attempt_completion",
		args: JSON.stringify({ result: "done" }) }
	const usage = { promptTokens: 710, completionTokens: 1033,
		totalTokens: 1743 }
	const billing = { totalCostUsd: 0.0001, tokensPrompt: 710,
		tokensCompletion: 122, nativeTokensPrompt: 710,
		nativeTokensCompletion: 1033, nativeTokensReasoning: 884 }
	return new MockBillingClient([done], LIVE_MODEL, "Meta",
		{ responseUsage: usage, metadata: billing })
}

async function testReasoningHeavyNativeOverrunIsAccepted(): Promise<void> {
	const directory = await scratch()
	try {
		const client = reasoningHeavyClient()
		const options = { outputDir: directory, client,
			maxOutputTokens: 1024 }
		const summary = await collectLiveDevelopment(options)
		assert.equal(summary.abortedAttempts, 0)
		assert.equal(summary.completedRuns, 32)
		assert.equal(summary.billing.unacceptedBillingRecords, 0)
		assert.equal(summary.billing.completionTokens, 32 * 1033,
			"budget accounting still uses native tokens")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testHeldoutCannotStartWithoutQualifiedDevelopment(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "attempt_completion" }])
		await assert.rejects(() => collectLiveHeldout({ outputDir: directory, client }), /ENOENT|development did not freeze/)
		assert.equal(client.requests.length, 0, "test fixtures are never exposed before the verified development gate")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testHeldoutRejectsDifferentFrozenOutputCapBeforeInference(): Promise<void> {
	const directory = await scratch()
	try {
		const developmentDir = path.join(directory, "development")
		await fs.mkdir(developmentDir, { mode: 0o700 })
		const values = Object.fromEntries(MONITOR_FEATURE_ORDER.map((name) => [name, 0])) as FrozenPredictorArtifact["coefficients"]
		const predictorBase = {
			schemaVersion: 1 as const,
			featureOrder: MONITOR_FEATURE_ORDER,
			coefficients: values,
			intercept: 0,
			standardization: { mean: values, scale: Object.fromEntries(MONITOR_FEATURE_ORDER.map((name) => [name, 1])) as FrozenPredictorArtifact["coefficients"] },
			calibration: { intercept: 0, slope: 1 },
			threshold: 0.5,
			l2: 1 as const,
			modelDigest: LIVE_MODEL_DIGEST,
			templatesHash: sha256(TEMPLATE_TEXT),
		}
		const predictor: FrozenPredictorArtifact = { ...predictorBase, artifactHash: sha256(predictorBase) }
		const manifest = {
			experimentId: LIVE_EXPERIMENT_ID,
			outputDirectory: path.resolve(directory),
			modelSettings: { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
			fixturesHash: fixtureHash(),
			splitHash: splitHash(),
			guardrailsHash: LIVE_GUARDRAILS_HASH,
			templatesHash: sha256(TEMPLATE_TEXT),
			sourceIdentity: {},
		}
		await fs.writeFile(path.join(developmentDir, "development-summary.json"), JSON.stringify({ predictorStatus: "QUALIFIED", predictor, completedRuns: LIVE_DEVELOPMENT_SLOTS.length, manifestHash: "synthetic" }))
		await fs.writeFile(path.join(developmentDir, "predictor.json"), JSON.stringify(predictor))
		await fs.writeFile(path.join(developmentDir, "manifest.json"), JSON.stringify(manifest))
		await fs.writeFile(path.join(developmentDir, "journal.jsonl"), "")
		const client = new MockBillingClient([{ name: "attempt_completion" }])
		await assert.rejects(() => collectLiveHeldout({ outputDir: directory, client, maxOutputTokens: 2048 }), /development manifest no longer matches/)
		assert.equal(client.requests.length, 0, "held-out collection rejects a changed frozen cap before any model request")
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

async function testStorageRootSymlinkIsRejectedBeforeInference(): Promise<void> {
	const directory = await scratch()
	try {
		const target = path.join(directory, "target")
		const link = path.join(directory, "link")
		await fs.mkdir(target, { mode: 0o700 })
		await fs.symlink(target, link, "dir")
		const client = new MockBillingClient([{ name: "attempt_completion" }])
		await assert.rejects(() => collectLiveDevelopment({ outputDir: link, client }), /symlink or non-directory/)
		assert.equal(client.requests.length, 0)
		assert.deepEqual(await fs.readdir(target), [])
	} finally { await fs.rm(directory, { recursive: true, force: true }) }
}

assert.equal(LIVE_GUARDRAILS_HASH, sha256(LIVE_GUARDRAILS_MANIFEST))
assert.equal(LIVE_GUARDRAILS_MANIFEST.thresholds.identicalCallNudge, DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD)
assert.match(identicalCallNudgeMessage("read_file", 2), /IDENTICAL arguments/)
assert.equal(LIVE_DEVELOPMENT_SLOTS.length, 32)

await testBillingIdentityPrecedesVirtualEffects()
await testOutputCapValidationAndFrozenResumeConfiguration()
await testForbiddenToolHasZeroEffectsAndIsRecorded()
await testShortLabelWindowsAreMasked()
await testDevelopmentScheduleUsesSyntheticBillingOnly()
await testNativeGenerationTokensOverrideNormalizedAccounting()
await testFiniteBillingIsCountedWhenAdmissionAborts()
await testAdmittedRequestWithoutResponseIsShownAsUnresolved()
await testResponseWithoutFiniteGenerationCostIsUnbilled()
await testUncertainRequestIsNotAutomaticallyReplayed()
await testCopiedGlobalLedgerEpochsDoNotBlockResume()
await testKnownPerRunAdmissionStopCompletesAndSettlesTrajectory()
await testCompletionOverrunIsJournaledBeforeAnyToolDispatch()
await testReasoningHeavyNativeOverrunIsAccepted()
await testHeldoutCannotStartWithoutQualifiedDevelopment()
await testHeldoutRejectsDifferentFrozenOutputCapBeforeInference()
await testStorageRootSymlinkIsRejectedBeforeInference()
console.log("live monitor pilot tests passed (synthetic billing; no network inference)")

const featureValues = { identicalCallStreak: 0, sameToolErrorStreak: 0, readOnlyStreak: 0, uniqueCallFraction4: 0, errorFraction4: 0, turnsSinceSuccessfulVirtualWrite: 0, repeatedResultFraction4: 0, iterationBudgetFraction: 0 }
const firstTriggerPredictor: FrozenPredictorArtifact = {
	schemaVersion: 1, featureOrder: MONITOR_FEATURE_ORDER, coefficients: featureValues,
	intercept: 2, standardization: { mean: featureValues, scale: { identicalCallStreak: 1, sameToolErrorStreak: 1, readOnlyStreak: 1, uniqueCallFraction4: 1, errorFraction4: 1, turnsSinceSuccessfulVirtualWrite: 1, repeatedResultFraction4: 1, iterationBudgetFraction: 1 } },
	calibration: { intercept: 0, slope: 1 }, threshold: 0.5, l2: 1, modelDigest: "synthetic", templatesHash: "synthetic", artifactHash: "synthetic",
}
const firstTriggerSchedule = deriveCalibrationRandomSchedule([
	{ features: featureValues, trajectoryId: "one", boundarySequence: 7 },
	{ features: featureValues, trajectoryId: "one", boundarySequence: 2 },
	{ features: featureValues, trajectoryId: "one", boundarySequence: 4 },
	{ features: featureValues, trajectoryId: "two", boundarySequence: 5 },
], firstTriggerPredictor, ["one", "two", "no-eligible-window", "no-trigger"])
assert.deepEqual(firstTriggerSchedule, { probability: 0.5, distribution: [{ boundarySequence: 2, weight: 1 }, { boundarySequence: 5, weight: 1 }] }, "random timing matches first M triggers per assigned calibration trajectory, not the fraction of windows above threshold")
console.log("live monitor calibration first-trigger tests passed")
