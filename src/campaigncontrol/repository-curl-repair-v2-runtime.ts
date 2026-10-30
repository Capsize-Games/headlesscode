import * as path from "node:path"
import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type { RepositoryPipelineAdapterFactoryContext, RepositoryWorkerRegistration } from "./repository-worker-registration.js"
import type { RepositoryPrivateDeliveryReceipt, RepositoryWorkerPipelineAdapters } from "./repository-worker-pipeline.js"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import { CURL_DEBIAN_PUBLIC_BASE_REVISION, loadKnownCurlDebianAdvisory } from "./repository-known-advisory.js"
import {
	buildCurlHistoricalRepairCandidate, curlHistoricalRepairCandidateSha256,
	CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE, CURL_REPAIR_PATCH_SHA256,
	CURL_REPAIR_PRIVATE_SOURCE_ROOT, CURL_REPAIR_SOURCE_REVISION,
	CURL_REPAIR_TARGET_REPOSITORY, verifyCurlHistoricalRepairSourcePin,
} from "./repository-curl-repair.js"
import { evaluateCurlHistoricalRepairV2 } from "./repository-curl-repair-v2-evaluator.js"
import { prepareCurlRepairV2Candidate, evaluateCurlRepairV2Candidate } from "./repository-curl-repair-v2-execution.js"
import {
	CURL_REPAIR_V2_ADAPTER_ID, CURL_REPAIR_V2_EVALUATOR_DIGEST,
	CURL_REPAIR_V2_MODEL, CURL_REPAIR_V2_POLICY_SHA256,
	CURL_REPAIR_V2_PROFILE_ID, CURL_REPAIR_V2_RECIPE_DIGEST,
	CURL_REPAIR_V2_REPOSITORY_ID, CURL_REPAIR_V2_RESERVATION,
} from "./repository-curl-repair-v2-profile.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "./repository-campaign-ids.js"
import { writeRepositoryWorkerDiagnostic } from "./repository-worker-diagnostics.js"

export interface CurlRepairV2RuntimeDependencies {
	sourceRoot?: string
	buildCandidate?: typeof buildCurlHistoricalRepairCandidate
	prepare?: typeof prepareCurlRepairV2Candidate
	evaluate?: typeof evaluateCurlRepairV2Candidate
	evaluateBase?: typeof import("./repository-curl-repair-evaluator.js").evaluateCurlHistoricalRepairCandidate
	deliverRepair?: (input: { claim: import("./repository-campaigns.js").ClaimedRepositoryJob;
		definition: RepositoryCampaignDefinition;
		candidateSha256: string;
		verification: import("./repository-worker-pipeline.js").RepositoryVerificationReceipt;
		signal: AbortSignal }) => Promise<RepositoryPrivateDeliveryReceipt>
	verifySource?: (sourceRoot: string) => Promise<void>
}

/** Bind the fresh isolated worker and evaluator to the separate v2 campaign. */
export function createCurlHistoricalRepairV2Adapters(
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
	context: RepositoryPipelineAdapterFactoryContext,
	dependencies: CurlRepairV2RuntimeDependencies = {},
): RepositoryWorkerPipelineAdapters {
	validateRegistration(registration, definition, context)
	const sourceRoot = path.resolve(dependencies.sourceRoot ?? CURL_REPAIR_PRIVATE_SOURCE_ROOT)
	const buildCandidate = dependencies.buildCandidate ?? buildCurlHistoricalRepairCandidate
	const prepare = dependencies.prepare ?? prepareCurlRepairV2Candidate
	const evaluate = dependencies.evaluate ?? evaluateCurlRepairV2Candidate
	const verifySource = dependencies.verifySource ?? verifyCurlHistoricalRepairSourcePin
	return {
		workerProfile: registration.workerProfile, recipeDigest: registration.recipeDigest,
		evaluatorDigest: registration.evaluatorDigest, model: registration.model,
		executionKind: "live-cve", reservation: { ...registration.reservation },
		advisoryIntake: { source: "debian-tracker-repair-v2-snapshot",
			publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
			poll: async () => await loadKnownCurlDebianAdvisory(),
			verifySource: async () => await verifySource(sourceRoot) },
		async recordFailureDiagnostic(input) {
			return await writeRepositoryWorkerDiagnostic(context.store.path,
				{ claim: input.claim, stage: input.stage, error: input.error })
		},
		async lookupAdvisory(advisoryId, currentDefinition) {
			if (currentDefinition.id !== CURL_REPAIR_V2_CAMPAIGN_ID || advisoryId !== CURL_FIXED_ADVISORY) {
				throw new Error("Curl v2 advisory is outside the pinned profile")
			}
			return await loadKnownCurlDebianAdvisory()
		},
		async prepareWorkspace(input) {
			const campaignId = input.claim.job.campaignId
			const advisoryId = input.claim.job.advisoryId
			if (!campaignId || !advisoryId) throw new Error("Curl v2 claimed job identity is incomplete")
			assertRepairJob(input.definition, campaignId,
				advisoryId, input.claim.job.purpose)
			await context.store.assertClaimCurrent(input.claim)
			const candidate = await buildCandidate(sourceRoot)
			let workerReceipt: Awaited<ReturnType<typeof prepare>> | undefined
			return { worktree: sourceRoot, taskSha256: candidate.sourceEnvelopeSha256,
				historicalRepairCandidate: candidate, requiresContainedRepairWorker: true,
				async runContained(signal) {
					await context.store.assertClaimCurrent(input.claim)
					workerReceipt = await prepare({ jobId: input.claim.job.id,
						claimId: input.claim.claimId, epoch: input.claim.epoch }, signal)
					return { ok: true, durationMs: 0, outputSha256: workerReceipt.receiptFileSha256,
						actualMicros: 0, actualTokens: 0 }
				},
				async candidateSha256() {
					if (!workerReceipt) throw new Error("Curl v2 candidate worker did not finish")
					return curlHistoricalRepairCandidateSha256(candidate)
				},
				async cleanup() { /* Fleet helper owns and verifies named container cleanup. */ },
				get v2WorkerReceipt() { return workerReceipt },
			}
		},
		async evaluate(input) {
			const candidate = input.workspace.historicalRepairCandidate
			const worker = (input.workspace as typeof input.workspace & {
				v2WorkerReceipt?: Awaited<ReturnType<typeof prepare>>
			}).v2WorkerReceipt
			if (!candidate || !worker || input.claim.job.purpose !== "repair" ||
				input.claim.job.campaignId !== CURL_REPAIR_V2_CAMPAIGN_ID ||
				input.definition.id !== CURL_REPAIR_V2_CAMPAIGN_ID ||
				curlHistoricalRepairCandidateSha256(candidate) !== input.candidateSha256) {
				throw new Error("Curl v2 candidate or worker receipt is not bound to the current job")
			}
			await context.store.assertClaimCurrent(input.claim)
			const evaluator = await evaluate({ jobId: input.claim.job.id,
				claimId: input.claim.claimId, epoch: input.claim.epoch }, input.signal)
			const receipt = await evaluateCurlHistoricalRepairV2({ candidate,
				jobId: input.claim.job.id, claimId: input.claim.claimId, epoch: input.claim.epoch,
				worker, evaluator, ...(dependencies.evaluateBase ? { evaluateBase: dependencies.evaluateBase } : {}) })
			return { passed: true, evidenceSha256: receipt.evidenceSha256,
				detail: receipt.disposition, historicalRepairV2: { candidate, receipt, worker, evaluator } }
		},
		async deliverPrivate(input) {
			const repair = input.verification.historicalRepairV2
			if (!repair || !input.verification.passed || input.claim.job.purpose !== "repair" ||
				input.claim.job.campaignId !== CURL_REPAIR_V2_CAMPAIGN_ID ||
				input.definition.id !== CURL_REPAIR_V2_CAMPAIGN_ID ||
				input.advisory.advisoryId !== CURL_FIXED_ADVISORY ||
				repair.receipt.evidenceSha256 !== input.verification.evidenceSha256 ||
				repair.candidate.sourceRevision !== CURL_REPAIR_HISTORICAL_BASE ||
				repair.candidate.candidateRevision !== CURL_REPAIR_CANDIDATE_REVISION ||
				repair.candidate.candidateTreeSha !== CURL_REPAIR_CANDIDATE_TREE_SHA ||
				repair.candidate.patchSha256 !== CURL_REPAIR_PATCH_SHA256) {
				throw new Error("Curl v2 private delivery is not bound to the verified candidate")
			}
			if (!dependencies.deliverRepair) {
				throw new Error("Curl v2 private delivery facade is unavailable")
			}
			await context.store.assertClaimCurrent(input.claim)
			return await dependencies.deliverRepair({ claim: input.claim,
				definition: input.definition, candidateSha256: input.candidateSha256,
				verification: input.verification, signal: input.signal })
		},
	}
}

function assertRepairJob(definition: RepositoryCampaignDefinition, campaignId: string,
	advisoryId: string, purpose: string | undefined): void {
	if (definition.id !== CURL_REPAIR_V2_CAMPAIGN_ID || campaignId !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		advisoryId !== CURL_FIXED_ADVISORY || purpose !== "repair") {
		throw new Error("Curl v2 job identity or purpose is invalid")
	}
}

function validateRegistration(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition, context: RepositoryPipelineAdapterFactoryContext): void {
	if (!context?.store || registration.campaignId !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		definition.id !== CURL_REPAIR_V2_CAMPAIGN_ID ||
		registration.repositoryId !== CURL_REPAIR_V2_REPOSITORY_ID ||
		definition.repositoryId !== CURL_REPAIR_V2_REPOSITORY_ID ||
		registration.repository !== CURL_REPAIR_TARGET_REPOSITORY ||
		definition.repository !== CURL_REPAIR_TARGET_REPOSITORY ||
		registration.sourceRevision !== CURL_REPAIR_SOURCE_REVISION ||
		definition.sourceRevision !== CURL_REPAIR_SOURCE_REVISION ||
		registration.policySha256 !== CURL_REPAIR_V2_POLICY_SHA256 ||
		definition.policySha256 !== CURL_REPAIR_V2_POLICY_SHA256 ||
		registration.workerProfile !== CURL_REPAIR_V2_PROFILE_ID ||
		definition.workerProfile !== CURL_REPAIR_V2_PROFILE_ID ||
		registration.recipeDigest !== CURL_REPAIR_V2_RECIPE_DIGEST ||
		definition.recipeDigest !== CURL_REPAIR_V2_RECIPE_DIGEST ||
		registration.evaluatorDigest !== CURL_REPAIR_V2_EVALUATOR_DIGEST ||
		definition.evaluatorDigest !== CURL_REPAIR_V2_EVALUATOR_DIGEST ||
		registration.model !== CURL_REPAIR_V2_MODEL || definition.model !== CURL_REPAIR_V2_MODEL ||
		registration.profileId !== "no-model" || definition.dataAccessProfile !== "public-source-and-published-advisory-only" ||
		registration.pipelineAdapterId !== CURL_REPAIR_V2_ADAPTER_ID || registration.executionKind !== "live-cve" ||
		registration.reservation.micros !== CURL_REPAIR_V2_RESERVATION.micros ||
		registration.reservation.tokens !== CURL_REPAIR_V2_RESERVATION.tokens ||
		!definition.qualification.sourceAudited || !definition.qualification.workerQualified ||
		!definition.qualification.recipeQualified || !definition.qualification.evaluatorQualified ||
		!definition.qualification.dataApproved || !definition.qualification.accessApproved) {
		throw new Error("Curl v2 registration is outside its compiled no-model profile")
	}
}
