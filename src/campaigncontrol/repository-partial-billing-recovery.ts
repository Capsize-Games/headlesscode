import path from "node:path"
import { CAMPAIGN_CONTROL_FILE } from "./paths.js"
import { withCampaignDispatchFence } from "./repository-run-lease.js"
import { CURL_PRIVATE_SOURCE_ROOT } from "./repository-curl-runtime.js"
import type { CampaignControlStore } from "./store.js"
import {
	RepositoryCampaignStore,
	type ClaimedRepositoryJob,
	type RepositoryCampaignDefinition,
	type RepositoryCampaignJob,
} from "./repository-campaigns.js"
import { persistClosedSessionProof } from
	"./repository-billing-proof-artifact.js"
import { assertClosedCurlProof } from "./repository-closed-session-proof.js"
import {
	assertNoActiveCurlWorktrees,
	listOpenShellSandboxes,
} from "./repository-billing-recovery-host-checks.js"
import {
	closedSessionImmutableSha256,
	FleetRepositoryBudgetLedger,
	type FleetRepositoryBudgetScope,
	type FleetRepositoryClosedSessionProof,
} from "../rsi/fleet-repository-budget-ledger.js"

const UUID = new RegExp([
	"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-",
	"[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
].join(""), "i")

type RecoveryResult = {
	jobId: string
	status: "failed"
	settledMicros: number
	settledTokens: number
	proofSha256: string
}
type RecheckedSession = {
	job: RepositoryCampaignJob
	proof: FleetRepositoryClosedSessionProof
}

export interface PartialBillingRecoveryDependencies {
	store: RepositoryCampaignStore
	controlStore: CampaignControlStore
	ledger: FleetRepositoryBudgetLedger
	definition: RepositoryCampaignDefinition
	scope: FleetRepositoryBudgetScope
	expectedKeyIdentity: string
	storePath: string
	worktreeRoot?: string
	listRunningSandboxes?: () => string[]
	clock?: () => number
	withDispatchFence?: <T>(operation: () => Promise<T>) => Promise<T>
}

/** Reconcile paid usage only from a verified closed Fleet session proof. */
export async function reconcileClosedCurlQualificationBilling(
	jobId: string,
	confirmation: string,
	dependencies: PartialBillingRecoveryDependencies,
): Promise<RecoveryResult> {
	validateConfirmation(jobId, confirmation)
	validateScope(dependencies.definition, dependencies.scope)
	await requireEligibleTarget(jobId, dependencies)
	await assertQuiet(dependencies)
	const proof = await readProof(jobId, dependencies)
	return settleUnderFence(jobId, proof, dependencies)
}

function validateConfirmation(jobId: string, confirmation: string): void {
	const expected = `CONFIRM SETTLE PARTIAL QUALIFICATION ${jobId}`
	if (!UUID.test(jobId) || confirmation !== expected) {
		throw new Error("explicit partial billing confirmation is required")
	}
}

function validateScope(
	definition: RepositoryCampaignDefinition,
	scope: FleetRepositoryBudgetScope,
): void {
	const matches = definition.id === "curl-maintenance" &&
		definition.repository === scope.repository &&
		definition.repositoryId === scope.repositoryId &&
		definition.sourceRevision === scope.sourceRevision &&
		definition.policySha256 === scope.policySha256 &&
		scope.repositoryCampaignId === definition.id &&
		scope.model === definition.model &&
		scope.profileId === "muse-spark-contributor"
	if (!matches) {
		throw new Error("billing reconciliation is outside the fixed Curl scope")
	}
}

async function requireEligibleTarget(
	jobId: string,
	dependencies: PartialBillingRecoveryDependencies,
): Promise<RepositoryCampaignJob> {
	const now = dependencies.clock?.() ?? Date.now()
	const control = await dependencies.controlStore.snapshot(new Date(now))
	const view = await dependencies.store.recoveryView(jobId, new Date(now))
	if (control.activeRun !== null || view.activeJobs.length ||
		!isTarget(view.job, dependencies.definition, now)) {
		throw new Error("billing reconciliation requires idle control and job")
	}
	return view.job
}

function isTarget(
	job: RepositoryCampaignJob | undefined,
	definition: RepositoryCampaignDefinition,
	now: number,
): job is RepositoryCampaignJob {
	return Boolean(job && job.campaignId === definition.id &&
		job.advisoryId === "CVE-2026-92390" && job.purpose === "qualification" &&
		job.status === "ambiguous" && UUID.test(job.claimId ?? "") &&
		Number.isSafeInteger(job.epoch) && job.epoch! > 0 && job.progress &&
		Number.isSafeInteger(job.progress.leaseExpiresAt) &&
		job.progress.leaseExpiresAt <= now && job.settledMicros === 8_000 &&
		job.settledTokens === 72_000 && job.reservedMicros === 0 &&
		job.reservedTokens === 0 &&
		!job.progress.evidenceRefs.some((ref) =>
			ref.kind === "billing-proof" || ref.kind === "no-call-proof"))
}

async function assertQuiet(
	dependencies: PartialBillingRecoveryDependencies,
): Promise<void> {
	const root = dependencies.worktreeRoot ??
		path.join(CURL_PRIVATE_SOURCE_ROOT, ".worktrees")
	assertNoActiveCurlWorktrees(root)
	const listSandboxes = dependencies.listRunningSandboxes ??
		listOpenShellSandboxes
	if (listSandboxes().length) {
		throw new Error("billing reconciliation requires no OpenShell sandbox")
	}
}

async function readProof(
	jobId: string,
	dependencies: PartialBillingRecoveryDependencies,
): Promise<FleetRepositoryClosedSessionProof> {
	const proof = await dependencies.ledger.proveClosedCurlQualificationSession(
		jobId,
		dependencies.scope.repositoryEpoch,
	)
	assertClosedCurlProof(
		proof, jobId, dependencies.scope, dependencies.expectedKeyIdentity,
	)
	return proof
}

async function settleUnderFence(
	jobId: string,
	firstProof: FleetRepositoryClosedSessionProof,
	dependencies: PartialBillingRecoveryDependencies,
): Promise<RecoveryResult> {
	const withFence = dependencies.withDispatchFence ??
		((operation) => withCampaignDispatchFence(CAMPAIGN_CONTROL_FILE, operation))
	return withFence(() => settleOnQuietRun(
		jobId, firstProof, dependencies,
	))
}

async function settleOnQuietRun(
	jobId: string,
	firstProof: FleetRepositoryClosedSessionProof,
	dependencies: PartialBillingRecoveryDependencies,
): Promise<RecoveryResult> {
	const rechecked = await recheckInsideFence(jobId, firstProof, dependencies)
	const proof = rechecked.proof
	const claim = makeClaim(rechecked.job)
	const proofSha256 = await persistClosedSessionProof(
		dependencies.storePath, claim, proof,
	)
	await dependencies.store.settleRecoveredClaim(claim, {
		status: "failed", actualMicros: proof.settledMicros,
		actualTokens: proof.settledTokens, proofSha256,
		proofKind: "billing-proof",
	}, new Date())
	return { jobId, status: "failed", settledMicros: proof.settledMicros,
		settledTokens: proof.settledTokens, proofSha256 }
}

async function recheckInsideFence(
	jobId: string,
	firstProof: FleetRepositoryClosedSessionProof,
	dependencies: PartialBillingRecoveryDependencies,
): Promise<RecheckedSession> {
	const control = await dependencies.controlStore.snapshot(new Date())
	const latest = await dependencies.store.recoveryView(jobId)
	if (control.activeRun !== null || latest.activeJobs.length ||
		!isTarget(latest.job, dependencies.definition, Date.now())) {
		throw new Error("billing reconciliation preconditions changed")
	}
	await assertQuiet(dependencies)
	const proof = await readProof(jobId, dependencies)
	if (closedSessionImmutableSha256(firstProof) !==
		closedSessionImmutableSha256(proof)) {
		throw new Error("Fleet closed-session proof changed before settlement")
	}
	return { job: latest.job!, proof }
}

function makeClaim(target: RepositoryCampaignJob): ClaimedRepositoryJob {
	return { claimId: target.claimId!, epoch: target.epoch!, job: target }
}
