import * as path from "node:path"
import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type { RepositoryPipelineAdapterFactoryContext, RepositoryWorkerRegistration } from "./repository-worker-registration.js"
import type { RepositoryWorkerPipelineAdapters } from "./repository-worker-pipeline.js"
import { CURL_FIXED_ADVISORY } from "./repository-curl-evaluator.js"
import { CURL_DEBIAN_PUBLIC_BASE_REVISION, loadKnownCurlDebianAdvisory } from "./repository-known-advisory.js"
import {
	buildCurlHistoricalRepairCandidate, curlHistoricalRepairCandidateSha256,
	CURL_REPAIR_ADAPTER_ID, CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_CANDIDATE_REVISION,
	CURL_REPAIR_CANDIDATE_TREE_SHA, CURL_REPAIR_EVALUATOR_DIGEST, CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_DELIVERY_POLICY_SHA256_PIN, CURL_REPAIR_PATCH_SHA256, CURL_REPAIR_POLICY_SHA256, CURL_REPAIR_PROFILE_ID,
	CURL_REPAIR_RECIPE_DIGEST, CURL_REPAIR_REPOSITORY_ID, CURL_REPAIR_RESERVATION,
	CURL_REPAIR_PRIVATE_SOURCE_ROOT, CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_TARGET_REPOSITORY, verifyCurlHistoricalRepairSourcePin,
} from "./repository-curl-repair.js"
import { evaluateCurlHistoricalRepairCandidate } from "./repository-curl-repair-evaluator.js"
import { CURL_REPAIR_DELIVERY_POLICY_SHA256 } from "./repository-curl-repair-delivery.js"
import { writeRepositoryWorkerDiagnostic } from "./repository-worker-diagnostics.js"

const MODEL = "none"
const PROFILE_ID = "no-model"
const DATA_ACCESS_PROFILE = "public-source-and-published-advisory-only"

export interface CurlRepairRuntimeDependencies {
	sourceRoot?: string
	buildCandidate?: typeof buildCurlHistoricalRepairCandidate
	evaluateCandidate?: typeof evaluateCurlHistoricalRepairCandidate
	deliverRepair?: typeof import("./repository-curl-repair-delivery.js").deliverVerifiedCurlRepairDraft
	loadAdvisory?: typeof loadKnownCurlDebianAdvisory
	verifySource?: (sourceRoot: string) => Promise<void>
}

/** Separate, no-model historical repair path; the existing qualification adapter remains read-only. */
export function createCurlHistoricalRepairAdapters(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition, context: RepositoryPipelineAdapterFactoryContext,
	dependencies: CurlRepairRuntimeDependencies = {}): RepositoryWorkerPipelineAdapters {
	validateRepairRegistration(registration, definition, context)
	const sourceRoot = path.resolve(dependencies.sourceRoot ?? CURL_REPAIR_PRIVATE_SOURCE_ROOT)
	const buildCandidate = dependencies.buildCandidate ?? buildCurlHistoricalRepairCandidate
	const evaluateCandidate = dependencies.evaluateCandidate ?? evaluateCurlHistoricalRepairCandidate
	const loadAdvisory = dependencies.loadAdvisory ?? loadKnownCurlDebianAdvisory
	const verifySource = dependencies.verifySource ?? verifyCurlHistoricalRepairSourcePin
	return {
		workerProfile: registration.workerProfile,
		recipeDigest: registration.recipeDigest,
		evaluatorDigest: registration.evaluatorDigest,
		model: registration.model,
		executionKind: "live-cve",
		reservation: { ...registration.reservation },
		advisoryIntake: { source: "debian-tracker-repair-snapshot", publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
			poll: async () => await loadAdvisory(), verifySource: async () => await verifySource(sourceRoot) },
		async recordFailureDiagnostic(input) {
			return await writeRepositoryWorkerDiagnostic(context.store.path, { claim: input.claim, stage: input.stage, error: input.error })
		},
		async lookupAdvisory(advisoryId, currentDefinition) {
			if (currentDefinition.id !== CURL_REPAIR_CAMPAIGN_ID || advisoryId !== CURL_FIXED_ADVISORY) throw new Error("Curl repair advisory is outside the pinned profile")
			return await loadAdvisory()
		},
		async prepareWorkspace(input) {
			if (input.definition.id !== CURL_REPAIR_CAMPAIGN_ID || input.claim.job.campaignId !== CURL_REPAIR_CAMPAIGN_ID ||
				input.claim.job.advisoryId !== CURL_FIXED_ADVISORY || input.claim.job.purpose !== "repair") {
				throw new Error("Curl repair job identity or purpose is invalid")
			}
			await context.store.assertClaimCurrent(input.claim)
			const candidate = await buildCandidate(sourceRoot)
			return { worktree: sourceRoot, taskSha256: candidate.sourceEnvelopeSha256,
				historicalRepairCandidate: candidate,
				async runContained() { throw new Error("historical repair executes no contained model worker") },
				async candidateSha256() { return curlHistoricalRepairCandidateSha256(candidate) } }
		},
		async evaluate(input) {
			const candidate = input.workspace.historicalRepairCandidate
			if (input.claim.job.purpose !== "repair" || input.claim.job.campaignId !== CURL_REPAIR_CAMPAIGN_ID ||
				input.definition.id !== CURL_REPAIR_CAMPAIGN_ID || !candidate ||
				curlHistoricalRepairCandidateSha256(candidate) !== input.candidateSha256) {
				throw new Error("Curl repair candidate changed before protected historical evaluation")
			}
			await context.store.assertClaimCurrent(input.claim)
			const receipt = await evaluateCandidate({ candidate, jobId: input.claim.job.id })
			return { passed: receipt.disposition === "historical-fix-qualified", evidenceSha256: receipt.evidenceSha256,
				detail: receipt.disposition, historicalRepair: { candidate, receipt } }
		},
		async deliverPrivate(input) {
			const repair = input.verification.historicalRepair
			if (!repair || !input.verification.passed || input.claim.job.purpose !== "repair" ||
				input.claim.job.campaignId !== CURL_REPAIR_CAMPAIGN_ID || input.definition.id !== CURL_REPAIR_CAMPAIGN_ID ||
				input.advisory.advisoryId !== CURL_FIXED_ADVISORY || repair.receipt.evidenceSha256 !== input.verification.evidenceSha256 ||
				repair.candidate.sourceRevision !== CURL_REPAIR_HISTORICAL_BASE || repair.candidate.candidateRevision !== CURL_REPAIR_CANDIDATE_REVISION ||
				repair.candidate.candidateTreeSha !== CURL_REPAIR_CANDIDATE_TREE_SHA || repair.candidate.patchSha256 !== CURL_REPAIR_PATCH_SHA256) {
				throw new Error("Curl private repair delivery is not bound to an independently verified historical candidate")
			}
			await context.store.assertClaimCurrent(input.claim)
			const deliver = dependencies.deliverRepair ?? (await import("./repository-curl-repair-delivery.js")).deliverVerifiedCurlRepairDraft
			const result = await deliver({ claim: input.claim, candidate: repair.candidate, receipt: repair.receipt }, { store: context.store })
			return { accepted: result.accepted, evidenceSha256: result.evidenceSha256, boardRef: null }
		},
	}
}

function validateRepairRegistration(registration: RepositoryWorkerRegistration, definition: RepositoryCampaignDefinition,
	context: RepositoryPipelineAdapterFactoryContext): void {
	if (!context?.store || CURL_REPAIR_DELIVERY_POLICY_SHA256 !== CURL_REPAIR_DELIVERY_POLICY_SHA256_PIN ||
		registration.campaignId !== CURL_REPAIR_CAMPAIGN_ID || definition.id !== CURL_REPAIR_CAMPAIGN_ID ||
		registration.repositoryId !== CURL_REPAIR_REPOSITORY_ID || definition.repositoryId !== CURL_REPAIR_REPOSITORY_ID ||
		registration.repository !== CURL_REPAIR_TARGET_REPOSITORY || definition.repository !== CURL_REPAIR_TARGET_REPOSITORY ||
		registration.sourceRevision !== CURL_REPAIR_SOURCE_REVISION || definition.sourceRevision !== CURL_REPAIR_SOURCE_REVISION ||
		registration.policySha256 !== CURL_REPAIR_POLICY_SHA256 || definition.policySha256 !== CURL_REPAIR_POLICY_SHA256 ||
		registration.workerProfile !== CURL_REPAIR_PROFILE_ID || definition.workerProfile !== CURL_REPAIR_PROFILE_ID ||
		registration.recipeDigest !== CURL_REPAIR_RECIPE_DIGEST || definition.recipeDigest !== CURL_REPAIR_RECIPE_DIGEST ||
		registration.evaluatorDigest !== CURL_REPAIR_EVALUATOR_DIGEST || definition.evaluatorDigest !== CURL_REPAIR_EVALUATOR_DIGEST ||
		registration.model !== MODEL || definition.model !== MODEL || registration.profileId !== PROFILE_ID ||
		definition.dataAccessProfile !== DATA_ACCESS_PROFILE || registration.pipelineAdapterId !== CURL_REPAIR_ADAPTER_ID ||
		registration.executionKind !== "live-cve" || registration.reservation.micros !== CURL_REPAIR_RESERVATION.micros ||
		registration.reservation.tokens !== CURL_REPAIR_RESERVATION.tokens || !definition.qualification.sourceAudited ||
		!definition.qualification.workerQualified || !definition.qualification.recipeQualified || !definition.qualification.evaluatorQualified ||
		!definition.qualification.dataApproved || !definition.qualification.accessApproved) {
		throw new Error("Curl historical repair registration is outside the compiled no-model profile")
	}
}
