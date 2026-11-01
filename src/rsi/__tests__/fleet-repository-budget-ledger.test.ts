import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { closedSessionImmutableSha256, FleetRepositoryBudgetLedger, type FleetRepositoryBudgetScope,
	type FleetRepositoryClosedSessionProof } from "../fleet-repository-budget-ledger.js"

const scope: FleetRepositoryBudgetScope = { repositoryCampaignId: "curl-maintenance", repositoryId: "curl-maintenance",
	repository: "Capsize-Games/curl-maintenance", sourceRevision: "c".repeat(40), policySha256: "d".repeat(64),
	model: "meta/muse-spark-1.3-contributor", profileId: "muse-spark-contributor", repositoryEpoch: 9 }
const jobId = "739886c8-2adc-4e4d-9f8d-42fa1d7153ab"
const keyIdentity = "f".repeat(64)
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}

test("proof canonicalization follows Python's independent sorted-key byte order", () => {
	assert.equal(canonical({ maxCalls: 2, maxCallSpendUsd: 4_000 }), '{"maxCallSpendUsd":4000,"maxCalls":2}')
})

function createProof(overrides: Record<string, unknown> = {}) {
	const now = Date.now()
	const limits = { maxCalls: 2, maxInputTokensPerCall: 32_000, maxOutputTokensPerCall: 4_000, maxTotalTokens: 72_000,
		maxDurationMs: 300_000, maxRequestBytes: 32_768, maxResponseBytes: 65_536, maxInputPricePerMillionUsd: "0.1",
		maxOutputPricePerMillionUsd: "0.2", maxCallSpendUsd: 4_000, maxJobSpendUsd: 8_000, maxCampaignSpendUsd: 20_000 }
	const settlement = (tokens: number, cost: number, completedAt: string) => ({ state: "complete", qualified: true,
		returnedModel: "meta/muse-spark-1.3-contributor", returnedProvider: "meta", providerRequestId: `req-${tokens}`,
		promptTokens: tokens - 1000, completionTokens: 1000, costUsd: cost, responseSha256: "e".repeat(64), completedAt })
	const calls = [{ callId: "call-1", attemptId: "attempt-1", requestSha256: "a".repeat(64), reservedMicros: 4_000, reservedTokens: 36_000,
		actualMicros: 220, actualTokens: 3_000, settlement: settlement(3_000, 0.00022, new Date(now - 200_000).toISOString()) },
	{ callId: "call-2", attemptId: "attempt-2", requestSha256: "b".repeat(64), reservedMicros: 4_000, reservedTokens: 36_000,
		actualMicros: 273, actualTokens: 3_064, settlement: settlement(3_064, 0.000273, new Date(now - 100_000).toISOString()) }]
	const record: Record<string, unknown> = { schemaVersion: 1, campaignId: "fleet-security-watch", repositoryCampaignId: scope.repositoryCampaignId,
		repositoryId: scope.repositoryId, repository: scope.repository, sourceRevision: scope.sourceRevision, policySha256: scope.policySha256,
		repositoryEpoch: scope.repositoryEpoch, model: scope.model, profileId: scope.profileId, keyIdentity, jobId, asOfMs: now,
		grant: { grantSha256: "c".repeat(64), runId: "run-123", controlEpoch: 4, issuedAtMs: now - 300_000, deadlineAtMs: now - 50_000, limits },
		calls, denials: [{ statusCode: 429, reason: "budget-or-fence", count: 1 }], settledMicros: 493, settledTokens: 6_064, ...overrides }
	delete record.proofSha256
	record.proofSha256 = createHash("sha256").update(canonical(record)).digest("hex")
	return record
}
function redigest(proof: FleetRepositoryClosedSessionProof): FleetRepositoryClosedSessionProof {
	const unsigned = { ...proof } as Record<string, unknown>
	delete unsigned.proofSha256
	return { ...proof, proofSha256: createHash("sha256").update(canonical(unsigned)).digest("hex") }
}
function ledger(response: Record<string, unknown>) {
	return new FleetRepositoryBudgetLedger({ scope, expectedKeyIdentity: keyIdentity, invoke: async () => response })
}

test("closed settlement binds nested call identity", async () => {
	const proof = createProof() as unknown as FleetRepositoryClosedSessionProof
	const first = proof.calls[0]!
	first.settlement.callId = first.callId
	first.settlement.cachedPromptTokens = 0
	const accepted = ledger({ ...redigest(proof) })
	const verified = await accepted.proveClosedCurlQualificationSession(
		jobId, scope.repositoryEpoch,
	)
	assert.equal(verified.settledMicros, 493)
	first.settlement.callId = "another-call"
	const rejected = ledger({ ...redigest(proof) })
	await assert.rejects(rejected.proveClosedCurlQualificationSession(
		jobId, scope.repositoryEpoch,
	), /unsettled or mismatched call/)
})

test("closed Curl qualification proof verifies exact settled calls and cap denial", async () => {
	const verified = await ledger(createProof()).proveClosedCurlQualificationSession(jobId, scope.repositoryEpoch)
	assert.deepEqual([verified.settledMicros, verified.settledTokens, verified.calls.length, verified.denials.length], [493, 6_064, 2, 1])
})

test("closed-session verifier rejects forged digest, mismatched job, active grant and unsettled receipt", async () => {
	const forged = createProof(); forged.settledMicros = 492
	await assert.rejects(ledger(forged).proveClosedCurlQualificationSession(jobId, scope.repositoryEpoch), /digest is forged/)
	const wrongJob = createProof({ jobId: "different-job" })
	await assert.rejects(ledger(wrongJob).proveClosedCurlQualificationSession(jobId, scope.repositoryEpoch), /identity is invalid/)
	const liveGrant = createProof(); (liveGrant.grant as Record<string, unknown>).deadlineAtMs = Date.now() + 60_000
	delete liveGrant.proofSha256; liveGrant.proofSha256 = createHash("sha256").update(canonical(liveGrant)).digest("hex")
	await assert.rejects(ledger(liveGrant).proveClosedCurlQualificationSession(jobId, scope.repositoryEpoch), /active or outside/)
	const unsettled = createProof(); (unsettled.calls as Array<Record<string, unknown>>)[0]!.settlement = { state: "ambiguous" }
	delete unsettled.proofSha256; unsettled.proofSha256 = createHash("sha256").update(canonical(unsettled)).digest("hex")
	await assert.rejects(ledger(unsettled).proveClosedCurlQualificationSession(jobId, scope.repositoryEpoch), /unsettled or mismatched/)
})

test("immutable proof comparison ignores read time and detects changed session records", () => {
	const first = createProof() as unknown as FleetRepositoryClosedSessionProof
	const later = redigest({ ...first, asOfMs: first.asOfMs + 1 })
	assert.notEqual(first.proofSha256, later.proofSha256)
	assert.equal(closedSessionImmutableSha256(first), closedSessionImmutableSha256(later))
	const callChange = structuredClone(first)
	callChange.calls[0]!.settlement.providerRequestId = "changed-request-id"
	const grantChange = structuredClone(first)
	grantChange.grant.grantSha256 = "9".repeat(64)
	const denialChange = structuredClone(first)
	denialChange.denials[0]!.reason = "invalid-request"
	for (const changed of [callChange, grantChange, denialChange]) {
		assert.notEqual(closedSessionImmutableSha256(first), closedSessionImmutableSha256(changed))
	}
})
