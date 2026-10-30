import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { reconcileClosedCurlQualificationBilling } from "../repository-partial-billing-recovery.js"
import type { RepositoryCampaignDefinition, RepositoryCampaignJob } from "../repository-campaigns.js"
import type { FleetRepositoryBudgetScope, FleetRepositoryClosedSessionProof } from "../../rsi/fleet-repository-budget-ledger.js"

const jobId = "739886c8-2adc-4e4d-9f8d-42fa1d7153ab"
const claimId = "b16e3390-55b9-4d7f-a5bc-f8119b91598c"
const definition: RepositoryCampaignDefinition = { id: "curl-maintenance", name: "Curl qualification", repositoryId: "curl-maintenance",
	repository: "Capsize-Games/curl-maintenance", sourceRevision: "c".repeat(40), policySha256: "d".repeat(64), workerProfile: "curl-published-advisory-v1",
	recipeDigest: "e".repeat(64), evaluatorDigest: "f".repeat(64), model: "meta/muse-spark-1.3-contributor",
	dataAccessProfile: "public-upstream-source-and-published-advisory-only", qualification: { sourceAudited: true, workerQualified: true,
		recipeQualified: true, evaluatorQualified: true, modelApproved: true, dataApproved: true, accessApproved: true } }
const scope: FleetRepositoryBudgetScope = { repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!, repository: definition.repository!,
	sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!, model: "meta/muse-spark-1.3-contributor", profileId: "muse-spark-contributor", repositoryEpoch: 9 }
const proof: FleetRepositoryClosedSessionProof = { schemaVersion: 1, campaignId: "fleet-security-watch", repositoryCampaignId: scope.repositoryCampaignId,
	repositoryId: scope.repositoryId, repository: scope.repository, sourceRevision: scope.sourceRevision, policySha256: scope.policySha256,
	repositoryEpoch: scope.repositoryEpoch, model: scope.model, profileId: scope.profileId, keyIdentity: "a".repeat(64), jobId, asOfMs: Date.now(),
	grant: { grantSha256: "b".repeat(64), runId: "run-123", controlEpoch: 23, issuedAtMs: Date.now() - 400_000, deadlineAtMs: Date.now() - 100_000,
		limits: {} }, calls: [{ callId: "call-1", attemptId: "attempt-1", requestSha256: "c".repeat(64), reservedMicros: 4_000, reservedTokens: 36_000,
		actualMicros: 220, actualTokens: 3_000, settlement: {} }, { callId: "call-2", attemptId: "attempt-2", requestSha256: "d".repeat(64), reservedMicros: 4_000, reservedTokens: 36_000,
		actualMicros: 273, actualTokens: 3_064, settlement: {} }], denials: [{ statusCode: 429, reason: "budget-or-fence", count: 1 }],
	settledMicros: 493, settledTokens: 6_064, proofSha256: "f".repeat(64) }

async function fixture(options: { activeRun?: boolean; activeJobs?: boolean; proof?: FleetRepositoryClosedSessionProof } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-partial-billing-")); await fs.chmod(root, 0o700)
	const storePath = path.join(root, "campaign-state.json"); await fs.writeFile(storePath, "{}\n", { mode: 0o600 })
	const now = Date.now()
	const job = { id: jobId, campaignId: definition.id, advisoryId: "CVE-2026-92390", purpose: "qualification", status: "ambiguous", claimId,
		epoch: 4, createdAt: now - 20_000, updatedAt: now - 10_000, month: new Date(now).toISOString().slice(0, 7), reservedMicros: 0,
		settledMicros: 8_000, reservedTokens: 0, settledTokens: 72_000, progress: { executionKind: "live-cve", workerId: definition.workerProfile,
		goal: "fixed qualification", currentTask: "send requests", stage: "verify", completedSteps: ["intake"], requiredSteps: ["intake", "verify"],
		lastActionAt: now - 10_000, heartbeatAt: now - 10_000, leaseExpiresAt: now - 5_000, blocker: "provider-request-denied", nextStep: "review", evidenceRefs: [] } } as unknown as RepositoryCampaignJob
	let proofCalls = 0, settlement: unknown
	const dependencies = { store: { async recoveryView() { return { job: { ...job, progress: { ...job.progress } }, activeJobs: options.activeJobs ? [job] : [] } },
		async settleRecoveredClaim(...args: unknown[]) { settlement = args } } as never,
		controlStore: { async snapshot() { return { activeRun: options.activeRun ? { id: "active", epoch: 2, startedAt: now, expiresAt: now + 60_000 } : null } } } as never,
		ledger: { async proveClosedCurlQualificationSession() { proofCalls++; return options.proof ?? proof } } as never,
		definition, scope, expectedKeyIdentity: "a".repeat(64), storePath, worktreeRoot: path.join(root, "no-worktrees"), listRunningSandboxes: () => [],
		clock: () => now, withDispatchFence: async <T>(operation: () => Promise<T>) => await operation() }
	return { root, storePath, job, dependencies, get proofCalls() { return proofCalls }, get settlement() { return settlement } }
}

test("closed-session proof settles the paid amount as failed/unqualified and stores immutable proof", async (t) => {
	const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }))
	const result = await reconcileClosedCurlQualificationBilling(jobId, `CONFIRM SETTLE PARTIAL QUALIFICATION ${jobId}`, f.dependencies)
	assert.deepEqual([result.status, result.settledMicros, result.settledTokens], ["failed", 493, 6_064])
	assert.equal(f.proofCalls, 2)
	const args = f.settlement as [unknown, { status: string; actualMicros: number; actualTokens: number; proofSha256: string; proofKind: string }]
	assert.deepEqual([args[1].status, args[1].actualMicros, args[1].actualTokens, args[1].proofKind], ["failed", 493, 6_064, "billing-proof"])
	assert.equal(args[1].proofSha256, result.proofSha256)
	const dir = path.join(f.root, "partial-billing-proofs"), files = await fs.readdir(dir)
	assert.equal(files.length, 1); assert.equal((await fs.stat(path.join(dir, files[0]!))).mode & 0o777, 0o600)
	const record = JSON.parse(await fs.readFile(path.join(dir, files[0]!), "utf8"))
	assert.equal(record.proof.proofSha256, proof.proofSha256); assert.equal(record.proof.settledMicros, 493)
})

test("partial billing reconciliation refuses active work, wrong identity, and nonexact or paid totals", async (t) => {
	for (const options of [{ activeRun: true }, { activeJobs: true }, { proof: { ...proof, jobId: "other-job" } },
		{ proof: { ...proof, settledMicros: 494 } }, { proof: { ...proof, calls: [proof.calls[0]!] } }]) {
		const f = await fixture(options as Parameters<typeof fixture>[0]); t.after(() => fs.rm(f.root, { recursive: true, force: true }))
		await assert.rejects(reconcileClosedCurlQualificationBilling(jobId, `CONFIRM SETTLE PARTIAL QUALIFICATION ${jobId}`, f.dependencies))
		assert.equal(f.settlement, undefined)
	}
})

test("partial billing requires exact confirmation before reading the ledger", async (t) => {
	const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }))
	await assert.rejects(reconcileClosedCurlQualificationBilling(jobId, "CONFIRM", f.dependencies), /explicit partial billing confirmation/)
	assert.equal(f.proofCalls, 0); assert.equal(f.settlement, undefined)
})
