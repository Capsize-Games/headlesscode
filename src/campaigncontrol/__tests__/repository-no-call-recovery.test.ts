import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { recoverAmbiguousPrepareWithNoCallProof, verifyRecoveredNoCallArtifact } from "../repository-no-call-recovery.js"
import type { RepositoryCampaignDefinition, RepositoryCampaignJob } from "../repository-campaigns.js"
import type { FleetRepositoryBudgetScope, FleetRepositoryNoCallProof } from "../../rsi/fleet-repository-budget-ledger.js"

const id = "4660c6ba-3e7e-438d-9db1-59b55674153e"
const claimId = "b16e3390-55b9-4d7f-a5bc-f8119b91598c"
const definition: RepositoryCampaignDefinition = {
	id: "curl-maintenance", name: "Curl qualification", repositoryId: "curl-maintenance",
	repository: "Capsize-Games/curl-maintenance", sourceRevision: "c".repeat(40), policySha256: "d".repeat(64),
	workerProfile: "curl-published-advisory-v1", recipeDigest: "e".repeat(64), evaluatorDigest: "f".repeat(64),
	model: "meta/muse-spark-1.3-contributor", dataAccessProfile: "public-upstream-source-and-published-advisory-only",
	qualification: { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
		modelApproved: true, dataApproved: true, accessApproved: true },
}
const scope: FleetRepositoryBudgetScope = { repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!,
	repository: definition.repository!, sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!,
	model: "meta/muse-spark-1.3-contributor", profileId: "muse-spark-contributor", repositoryEpoch: 3 }
const proof: FleetRepositoryNoCallProof = { campaignId: "fleet-security-watch", repositoryCampaignId: scope.repositoryCampaignId,
	repositoryId: scope.repositoryId, repository: scope.repository, sourceRevision: scope.sourceRevision,
	policySha256: scope.policySha256, repositoryEpoch: scope.repositoryEpoch, model: scope.model, profileId: scope.profileId,
	keyIdentity: "a".repeat(64), proved: true, disposition: "no-recorded-provider-activity", asOfMs: Date.now(), jobId: id,
	counts: { grants: 0, calls: 0, denials: 0 } }

async function fixture(options: { activeRun?: boolean; activeJobs?: boolean; sandboxes?: string[]; proof?: FleetRepositoryNoCallProof } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-no-call-recovery-")); await fs.chmod(root, 0o700)
	const sourceRoot = path.join(root, "source"); await fs.mkdir(sourceRoot, { mode: 0o700 })
	const worktreeRoot = path.join(sourceRoot, ".worktrees"); await fs.mkdir(worktreeRoot, { mode: 0o700 })
	const storePath = path.join(root, "repository-campaigns.json"); await fs.writeFile(storePath, "{}\n", { mode: 0o600 })
	const now = Date.now()
	const job = { id, campaignId: definition.id, advisoryId: "CVE-2026-92390", status: "ambiguous", epoch: 7,
		createdAt: now - 10_000, updatedAt: now - 1_000, month: new Date(now).toISOString().slice(0, 7), claimId,
		reservedMicros: 0, settledMicros: 8_000, reservedTokens: 0, settledTokens: 72_000, purpose: "qualification",
		progress: { executionKind: "live-cve", workerId: "curl-published-advisory-v1", goal: "fixed qualification",
			currentTask: "Prepare the bounded isolated workspace", stage: "prepare-candidate", completedSteps: ["intake", "deduplicate", "investigate"],
			requiredSteps: ["intake", "deduplicate", "investigate", "prepare-candidate", "verify", "deliver"],
			lastActionAt: now - 1_000, heartbeatAt: now - 1_000, leaseExpiresAt: now - 1_000,
			blocker: "registered-pipeline-step-failed", nextStep: "review private diagnostic", evidenceRefs: [] },
	} as unknown as RepositoryCampaignJob
	let proofCalls = 0, settlement: unknown
	let controlCalls = 0
	const dependencies = {
		store: { async recoveryView() { return { job: { ...job, progress: { ...job.progress } }, activeJobs: options.activeJobs ? [job] : [] } },
			async settleRecoveredClaim(...args: unknown[]) { settlement = args } } as never,
		controlStore: { async snapshot() { controlCalls += 1; return { activeRun: options.activeRun ? { id: "run", epoch: 1, startedAt: now, expiresAt: now + 60_000 } : null } } } as never,
		ledger: { async proveNoCall(jobId: string, repositoryEpoch: number) { proofCalls += 1; assert.equal(jobId, id); assert.equal(repositoryEpoch, scope.repositoryEpoch); return options.proof ?? proof } } as never,
		definition, scope, expectedKeyIdentity: "a".repeat(64), storePath,
		listRunningSandboxes: () => options.sandboxes ?? [], worktreeRoot, clock: () => now,
		withDispatchFence: async <T>(operation: () => Promise<T>) => await operation(),
	}
	return { root, storePath, job, dependencies, get proofCalls() { return proofCalls }, get settlement() { return settlement }, get controlCalls() { return controlCalls } }
}

test("recovery requires the exact owner confirmation before any proof read", async (t) => {
	const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }))
	await assert.rejects(recoverAmbiguousPrepareWithNoCallProof(id, "CONFIRM", f.dependencies), /explicit no-call recovery confirmation/)
	assert.equal(f.proofCalls, 0)
	assert.equal(f.settlement, undefined)
})

test("recovery requires no active run, worker, worktree or sandbox", async (t) => {
	for (const option of [{ activeRun: true }, { activeJobs: true }, { sandboxes: ["container"] }]) {
		const f = await fixture(option); t.after(() => fs.rm(f.root, { recursive: true, force: true }))
		await assert.rejects(recoverAmbiguousPrepareWithNoCallProof(id, `CONFIRM RECOVER NO-CALL ${id}`, f.dependencies))
		assert.equal(f.settlement, undefined)
	}
	const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }))
	await fs.mkdir(path.join(f.dependencies.worktreeRoot!, "curl-campaign-leftover"), { mode: 0o700 })
	await assert.rejects(recoverAmbiguousPrepareWithNoCallProof(id, `CONFIRM RECOVER NO-CALL ${id}`, f.dependencies), /worktree remains/)
	assert.equal(f.settlement, undefined)
})

test("a fresh exact zero-call Fleet proof is saved before failed zero-cost settlement and never queues retry", async (t) => {
	const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }))
	const result = await recoverAmbiguousPrepareWithNoCallProof(id, `CONFIRM RECOVER NO-CALL ${id}`, f.dependencies)
	assert.equal(result.status, "failed")
	assert.equal(result.settledMicros, 0)
	assert.equal(result.settledTokens, 0)
	assert.match(result.proofSha256, /^[a-f0-9]{64}$/)
	const recordDir = path.join(path.dirname(f.storePath), "no-call-proofs")
	const files = await fs.readdir(recordDir)
	assert.equal(files.length, 1)
	const recordPath = path.join(recordDir, files[0]!)
	const info = await fs.lstat(recordPath)
	assert.equal(info.mode & 0o777, 0o600)
	const stored = JSON.parse(await fs.readFile(recordPath, "utf8"))
	assert.equal(stored.proof.jobId, id)
	const recoveredJob = { ...f.job, status: "failed" as const, settledMicros: 0, settledTokens: 0,
		progress: { ...f.job.progress!, evidenceRefs: [{ id: result.proofSha256, kind: "no-call-proof" as const, label: "Fleet no-call proof" }] } }
	assert.equal(await verifyRecoveredNoCallArtifact(recoveredJob, f.storePath, scope, proof.keyIdentity), result.proofSha256)
	assert.deepEqual(stored.proof.counts, { grants: 0, calls: 0, denials: 0 })
	const settlementArgs = f.settlement as [unknown, { proofSha256: string; status: string; actualMicros: number }]
	assert.equal(settlementArgs[1].proofSha256, result.proofSha256)
	assert.equal(settlementArgs[1].status, "failed")
	assert.equal(settlementArgs[1].actualMicros, 0)
})

test("recovery retains ambiguity when Fleet reports any grant or invalid scope", async (t) => {
	const activeProof = { ...proof, proved: false, disposition: "activity-present" as const, counts: { grants: 1, calls: 0, denials: 0 } }
	const f = await fixture({ proof: activeProof }); t.after(() => fs.rm(f.root, { recursive: true, force: true }))
	await assert.rejects(recoverAmbiguousPrepareWithNoCallProof(id, `CONFIRM RECOVER NO-CALL ${id}`, f.dependencies), /provider activity/)
	assert.equal(f.settlement, undefined)
	const mismatch = await fixture({ proof: { ...proof, sourceRevision: "9".repeat(40) } }); t.after(() => fs.rm(mismatch.root, { recursive: true, force: true }))
	await assert.rejects(recoverAmbiguousPrepareWithNoCallProof(id, `CONFIRM RECOVER NO-CALL ${id}`, mismatch.dependencies), /does not match/)
	assert.equal(mismatch.settlement, undefined)
})
