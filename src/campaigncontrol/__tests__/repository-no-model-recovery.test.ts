import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { recoverAmbiguousPrepareWithNoCallProof,
	verifyRecoveredNoCallArtifact,
	type RepositoryNoCallRecoveryDependencies } from
	"../repository-no-call-recovery.js"
import type { RepositoryCampaignJob } from "../repository-campaigns.js"
import type { FleetRepositoryNoCallProof, FleetRepositoryBudgetScope } from
	"../../rsi/fleet-repository-budget-ledger.js"
import { makeCurlRepairV2Definition } from
	"./curl-repair-v2-campaign-fixture.js"
import { CURL_DEBIAN_SNAPSHOT_SHA256 } from "../repository-known-advisory.js"

const id = "22222222-2222-4222-8222-222222222222"
const claimId = "11111111-1111-4111-8111-111111111111"
const confirmation = `CONFIRM RECOVER NO-CALL ${id}`
const definition = makeCurlRepairV2Definition()
const scope: FleetRepositoryBudgetScope = { repositoryCampaignId: definition.id,
	repositoryId: definition.repositoryId!, repository: definition.repository!,
	sourceRevision: definition.sourceRevision!,
	policySha256: definition.policySha256!,
	model: "none", profileId: "no-model", repositoryEpoch: 3 }

function makeJob(): RepositoryCampaignJob {
	const now = Date.now()
	return { id, claimId, campaignId: definition.id, advisoryId: "CVE-2026-92390",
		status: "ambiguous", epoch: 2, createdAt: now - 200_000,
		updatedAt: now - 100_000, month: "2026-10", purpose: "repair",
		reservedMicros: 0, reservedTokens: 0, settledMicros: 1, settledTokens: 1,
		progress: { executionKind: "live-cve", workerId: claimId, goal: "Repair",
			currentTask: "Prepare the bounded isolated workspace", stage: "verify",
			completedSteps: ["intake", "deduplicate", "investigate",
				"prepare-candidate"],
			requiredSteps: ["intake", "deduplicate", "investigate",
				"prepare-candidate", "verify", "deliver"],
			lastActionAt: now - 100_000, heartbeatAt: now - 100_000,
			leaseExpiresAt: now - 1000, blocker: "registered-pipeline-step-failed",
			nextStep: "Review diagnostic", evidenceRefs: [
				{ kind: "intake", id: CURL_DEBIAN_SNAPSHOT_SHA256, label: "Advisory" },
				{ kind: "diagnostic", id: "d".repeat(64), label: "Failure" }] } }
}
function makeProof(): FleetRepositoryNoCallProof {
	return { campaignId: "fleet-security-watch", ...scope, jobId: id,
		keyIdentity: "a".repeat(64), asOfMs: Date.now(), proved: true,
		disposition: "no-recorded-provider-activity", grant: null,
		counts: { grants: 0, calls: 0, denials: 0 } }
}
interface Fixture {
	root: string
	job: RepositoryCampaignJob
	proof: FleetRepositoryNoCallProof
	dependencies: RepositoryNoCallRecoveryDependencies
	settlements(): number
}
async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-recovery-"))
	const job = makeJob(), proof = makeProof()
	let settled = 0
	const dependencies: RepositoryNoCallRecoveryDependencies = {
		definition, scope, expectedKeyIdentity: proof.keyIdentity,
		storePath: path.join(root, "jobs.json"),
		worktreeRoot: path.join(root, "absent"),
		store: { recoveryView: async () => ({ job, activeJobs: [] }),
			settleRecoveredClaim: async () => { settled += 1 } } as never,
		controlStore: { snapshot: async () =>
			({ enabled: false, activeRun: null }) } as never,
		ledger: { proveNoCall: async () => proof } as never,
		listRunningSandboxes: () => [], listRunningRepairContainers: () => [],
		withDispatchFence: async (operation) => await operation(),
	}
	return { root, job, proof, dependencies, settlements: () => settled }
}

test("exact no-model failure saves proof and verifies retry evidence",
async (t) => {
	const f = await fixture()
		t.after(() => fs.rm(f.root, { recursive: true, force: true }))
	const result = await recoverAmbiguousPrepareWithNoCallProof(
		id, confirmation, f.dependencies)
	assert.equal(f.settlements(), 1)
	assert.equal(result.settledMicros, 0)
	const recovered = { ...f.job, status: "failed" as const, settledMicros: 0,
		settledTokens: 0, progress: { ...f.job.progress!, evidenceRefs: [
			...f.job.progress!.evidenceRefs, { kind: "no-call-proof" as const,
				id: result.proofSha256, label: "Fleet no-call proof" }] } }
	assert.equal(await verifyRecoveredNoCallArtifact(recovered,
		f.dependencies.storePath, scope, f.proof.keyIdentity), result.proofSha256)
})

test("no-model recovery rejects On, containers and candidate evidence",
async (t) => {
	for (const reason of ["on", "container", "candidate"] as const) {
		const f = await fixture()
		t.after(() => fs.rm(f.root, { recursive: true, force: true }))
		if (reason === "on") f.dependencies.controlStore = {
			snapshot: async () => ({ enabled: true, activeRun: null }) } as never
		if (reason === "container") {
			f.dependencies.listRunningRepairContainers = () => ["container"]
		}
		if (reason === "candidate") f.job.progress!.evidenceRefs.push({
			kind: "candidate", id: "b".repeat(64), label: "Candidate" })
		await assert.rejects(recoverAmbiguousPrepareWithNoCallProof(
			id, confirmation, f.dependencies))
		assert.equal(f.settlements(), 0)
	}
})

test("no-model recovery retains hold for policy or provider activity",
async (t) => {
	for (const reason of ["policy", "grant", "call", "denial"] as const) {
		const f = await fixture()
		t.after(() => fs.rm(f.root, { recursive: true, force: true }))
		if (reason === "policy") f.dependencies.definition = {
			...definition, policySha256: "0".repeat(64) }
		if (reason === "grant") f.proof.counts.grants = 1
		if (reason === "call") f.proof.counts.calls = 1
		if (reason === "denial") f.proof.counts.denials = 1
		await assert.rejects(recoverAmbiguousPrepareWithNoCallProof(
			id, confirmation, f.dependencies))
		assert.equal(f.settlements(), 0)
	}
})
