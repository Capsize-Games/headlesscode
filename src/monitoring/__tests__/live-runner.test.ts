import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import type { LlmRequest, LlmResponse } from "../../engine/types.js"
import { sha256 } from "../features.js"
import { DEFAULT_IDENTICAL_CALL_NUDGE_THRESHOLD, identicalCallNudgeMessage } from "../guardrails.js"
import { PilotJournal } from "../../../scripts/monitor-pilot/journal.js"
import { collectLiveDevelopment, collectLiveHeldout, LIVE_DEVELOPMENT_SLOTS, LIVE_GUARDRAILS_HASH, LIVE_GUARDRAILS_MANIFEST, LIVE_MODEL, LIVE_TOOLS } from "../../../scripts/monitor-pilot/live-runner.js"

type Reply = { readonly name: string; readonly args?: string; readonly content?: string }

class MockBillingClient {
	readonly requests: LlmRequest[] = []
	readonly replies: Reply[]
	readonly responseModel: string
	readonly provider: string
	private sequence = 0

	constructor(replies: readonly Reply[], responseModel = LIVE_MODEL, provider = "Meta") {
		this.replies = [...replies]
		this.responseModel = responseModel
		this.provider = provider
	}

	async createChatCompletion(request: LlmRequest): Promise<LlmResponse> {
		this.requests.push(request)
		assert.equal(request.model, LIVE_MODEL)
		assert.equal(request.providerOnly, "meta")
		assert.equal(request.stream, true)
		assert.deepEqual((request.tools ?? []).map((tool) => tool.function.name), LIVE_TOOLS.map((tool) => tool.function.name))
		const reply = this.replies[Math.min(this.sequence, this.replies.length - 1)]
		const id = `gen-${this.sequence++}`
		return {
			message: {
				role: "assistant",
				content: reply.content ?? null,
				tool_calls: [{ id: `provider-tool-${id}`, type: "function", function: { name: reply.name, arguments: reply.args ?? "{}" } }],
			},
			usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105, cachedTokens: 20 },
			generationId: id,
			returnedModel: this.responseModel,
			providerName: this.provider,
		}
	}

	async fetchGenerationMetadata(id: string) {
		return { id, model: LIVE_MODEL, providerName: "Meta", totalCostUsd: 0.000001, tokensPrompt: 100, tokensCompletion: 5, nativeTokensCached: 20, cacheDiscountUsd: 0 }
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
		const outcome = first.payload.outcome as { detectionLabels: readonly (0 | 1 | null)[]; stopReason: string }
		assert.deepEqual(outcome.detectionLabels, [1, null, null], "windows without three later uncorrected turns are masked, not negative")
		assert.equal(outcome.stopReason, "identical-call-stop")
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
			generationRecords: LIVE_DEVELOPMENT_SLOTS.length,
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
		assert.equal(first.billing.unbilledResponses, 1)
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

async function testHeldoutCannotStartWithoutQualifiedDevelopment(): Promise<void> {
	const directory = await scratch()
	try {
		const client = new MockBillingClient([{ name: "attempt_completion" }])
		await assert.rejects(() => collectLiveHeldout({ outputDir: directory, client }), /ENOENT|development did not freeze/)
		assert.equal(client.requests.length, 0, "test fixtures are never exposed before the verified development gate")
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
await testForbiddenToolHasZeroEffectsAndIsRecorded()
await testShortLabelWindowsAreMasked()
await testDevelopmentScheduleUsesSyntheticBillingOnly()
await testUncertainRequestIsNotAutomaticallyReplayed()
await testHeldoutCannotStartWithoutQualifiedDevelopment()
await testStorageRootSymlinkIsRejectedBeforeInference()
console.log("live monitor pilot tests passed (synthetic billing; no network inference)")
