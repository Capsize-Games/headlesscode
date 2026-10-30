import assert from "node:assert/strict"
import {
	CURL_REPAIR_ADAPTER_ID,
	CURL_REPAIR_PROFILE_ID,
	CURL_REPAIR_CAMPAIGN_ID,
	CURL_REPAIR_PATCH_SHA256,
	CURL_REPAIR_EVALUATOR_DIGEST,
	CURL_REPAIR_POLICY_SHA256,
	CURL_REPAIR_RECIPE_DIGEST,
	CURL_REPAIR_REPOSITORY_ID,
	CURL_REPAIR_RESERVATION,
	CURL_REPAIR_TARGET_REPOSITORY,
	CURL_REPAIR_SOURCE_REVISION,
} from "../repository-curl-repair.js"
import { CURL_FIXED_ADVISORY } from "../repository-curl-evaluator.js"
import type {
	RepositoryCampaignDefinition,
	ClaimedRepositoryJob,
	RepositoryCampaignStore,
} from "../repository-campaigns.js"
import type { RepositoryWorkerRegistration } from
	"../repository-worker-registration.js"
import type { RepositoryWorkerPipelineAdapters } from
	"../repository-worker-pipeline.js"
import type {
	CurlHistoricalRepairCandidate,
} from "../repository-curl-repair.js"
import type {
	CurlHistoricalRepairReceipt,
} from "../repository-curl-repair-evaluator.js"
import {
	makeCurlDebianAdvisoryTestFixture,
} from "./curl-historical-repair-fixture.js"
import {
	acceptedProofStub,
	deliverRepairStub,
	type ProofStubState,
} from "./repository-curl-repair-stubs.js"
import * as RepairEvaluator from "../repository-curl-repair-evaluator.js"
import * as RepairRuntime from "../repository-curl-repair-runtime.js"

export {
	acceptedProofStub,
	assertQualifiedReceipt,
	rejectedProofStub,
} from "./repository-curl-repair-stubs.js"

export function repairQualification(): RepositoryCampaignDefinition[
	"qualification"
] {
	return {
		sourceAudited: true,
		workerQualified: true,
		recipeQualified: true,
		evaluatorQualified: true,
		modelApproved: true,
		dataApproved: true,
		accessApproved: true,
	}
}

export function repairDefinition(): RepositoryCampaignDefinition {
	return {
		id: CURL_REPAIR_CAMPAIGN_ID,
		name: "Historical Curl repair",
		model: "none",
		dataAccessProfile: "public-source-and-published-advisory-only",
		repositoryId: CURL_REPAIR_REPOSITORY_ID,
		repository: CURL_REPAIR_TARGET_REPOSITORY,
		sourceRevision: CURL_REPAIR_SOURCE_REVISION,
		policySha256: CURL_REPAIR_POLICY_SHA256,
		workerProfile: CURL_REPAIR_PROFILE_ID,
		recipeDigest: CURL_REPAIR_RECIPE_DIGEST,
		evaluatorDigest: CURL_REPAIR_EVALUATOR_DIGEST,
		qualification: repairQualification(),
	}
}

export function repairRegistration(
	definition: RepositoryCampaignDefinition,
): RepositoryWorkerRegistration {
	return {
		campaignId: definition.id,
		repositoryId: definition.repositoryId!,
		repository: definition.repository!,
		sourceRevision: definition.sourceRevision!,
		policySha256: definition.policySha256!,
		workerProfile: definition.workerProfile!,
		recipeDigest: definition.recipeDigest!,
		evaluatorDigest: definition.evaluatorDigest!,
		model: "none",
		profileId: "no-model",
		pipelineAdapterId: CURL_REPAIR_ADAPTER_ID,
		executionKind: "live-cve",
		reservation: { ...CURL_REPAIR_RESERVATION },
	}
}

export function recordingStore(calls: string[]): RepositoryCampaignStore {
	return {
		path: "/private/test/state.json",
		async assertClaimCurrent(): Promise<void> {
			calls.push("claim-check")
		},
	} as unknown as RepositoryCampaignStore
}

export function repairJob(): ClaimedRepositoryJob["job"] {
	return {
		id: "repair-fixture-001",
		campaignId: CURL_REPAIR_CAMPAIGN_ID,
		advisoryId: CURL_FIXED_ADVISORY,
		purpose: "repair",
		status: "running",
		epoch: 2,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		month: "2026-10",
		reservedMicros: 1,
		settledMicros: 0,
		reservedTokens: 1,
		settledTokens: 0,
	} as unknown as ClaimedRepositoryJob["job"]
}

export function repairClaim(): ClaimedRepositoryJob {
	return {
		claimId: "11111111-1111-4111-8111-111111111111",
		epoch: 2,
		job: repairJob(),
	} as unknown as ClaimedRepositoryJob
}

export function fixedCandidateEvaluator(
	candidate: CurlHistoricalRepairCandidate,
): (input: { jobId: string }) => Promise<CurlHistoricalRepairReceipt> {
	const state: ProofStubState = { calls: 0, revision: "" }
	return async (input) =>
		RepairEvaluator.evaluateCurlHistoricalRepairCandidate({
			candidate,
			jobId: input.jobId,
			buildCandidate: async () => candidate,
			evaluateFixedProof: acceptedProofStub(
				candidate,
				state,
				"a".repeat(64),
			),
		})
}

export function repairAdapters(
	candidate: CurlHistoricalRepairCandidate,
	calls: string[],
	definition: RepositoryCampaignDefinition,
	registration: RepositoryWorkerRegistration,
	store: RepositoryCampaignStore,
): RepositoryWorkerPipelineAdapters {
	return RepairRuntime.createCurlHistoricalRepairAdapters(
		registration,
		definition,
		{ store },
		adapterOverrides(candidate, calls),
	)
}

function adapterOverrides(
	candidate: CurlHistoricalRepairCandidate,
	calls: string[],
): Parameters<typeof RepairRuntime.createCurlHistoricalRepairAdapters>[3] {
	return {
		buildCandidate: async () => candidate,
		loadAdvisory: async () => makeCurlDebianAdvisoryTestFixture(),
		evaluateCandidate: fixedCandidateEvaluator(candidate),
		deliverRepair: deliverRepairStub(calls),
	}
}

export function assertRepairMeasured(
	result: {
		status: unknown
		actualMicros: unknown
		actualTokens: unknown
		accounting: unknown
	},
	calls: readonly string[],
): void {
	assert.equal(result.status, "succeeded")
	assert.equal(result.actualMicros, 0)
	assert.equal(result.actualTokens, 0)
	assert.equal(result.accounting, "measured")
	assert.deepEqual(calls, [
		"claim-check",
		"claim-check",
		"claim-check",
		"already-fixed-delivery",
	])
}

export function assertProofPhases(phases: unknown): void {
	assert.deepEqual(phases, [
		"historical_base-red",
		"reference_fix-green",
		"fork_head-green",
		"candidate-green",
	])
}

export function alteredCandidate(
	candidate: CurlHistoricalRepairCandidate,
): CurlHistoricalRepairCandidate {
	return {
		...candidate,
		patchBase64: Buffer.from("not the reviewed patch").toString("base64"),
	}
}

export { buildCurlHistoricalRepairTestFixture } from
	"./curl-historical-repair-fixture.js"
