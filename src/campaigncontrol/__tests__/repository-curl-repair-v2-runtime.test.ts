import assert from "node:assert/strict"
import type {
	ClaimedRepositoryJob, RepositoryCampaignDefinition,
} from "../repository-campaigns.js"
import {
	createRepositoryWorkerPipeline,
} from "../repository-worker-pipeline.js"
import type {
	RepositoryCampaignStore,
} from "../repository-campaigns.js"
import type {
	RepositoryWorkerRegistration,
} from "../repository-worker-registration.js"
import {
	createCurlHistoricalRepairV2Adapters,
	type CurlRepairV2RuntimeDependencies,
} from "../repository-curl-repair-v2-runtime.js"
import {
	CURL_REPAIR_V2_ADAPTER_ID,
	CURL_REPAIR_V2_PROFILE_ID, CURL_REPAIR_V2_RESERVATION,
	CURL_REPAIR_V2_IMAGE_DIGEST, CURL_REPAIR_V2_SOURCE_REVISION,
} from "../repository-curl-repair-v2-profile.js"
import type {
	CurlRepairV2ClaimIdentity,
	CurlRepairV2EvaluatorReceipt,
	CurlRepairV2WorkerReceipt,
} from "../repository-curl-repair-v2-execution.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "../repository-campaign-ids.js"
import {
	CURL_FIXED_ADVISORY,
} from "../repository-curl-evaluator.js"
import {
	CURL_REPAIR_CANDIDATE_REVISION, CURL_REPAIR_CANDIDATE_TREE_SHA,
	CURL_REPAIR_HISTORICAL_BASE,
	CURL_REPAIR_PATCH_SHA256,
} from "../repository-curl-repair.js"
import {
	buildCurlHistoricalRepairTestFixture,
} from "./curl-historical-repair-fixture.js"
import {
	evaluateCurlHistoricalRepairCandidate,
} from "../repository-curl-repair-evaluator.js"
import { runMain, type SuiteTest } from "../../test-runner.js"
import { makeCurlRepairV2Definition } from
	"./curl-repair-v2-campaign-fixture.js"

const claimId = "11111111-1111-4111-8111-111111111111"
const jobId = "22222222-2222-4222-8222-222222222222"

function registration(
	def: RepositoryCampaignDefinition,
): RepositoryWorkerRegistration {
	return {
		campaignId: def.id, repositoryId: def.repositoryId!,
		repository: def.repository!, sourceRevision: def.sourceRevision!,
		policySha256: def.policySha256!, workerProfile: def.workerProfile!,
		recipeDigest: def.recipeDigest!, evaluatorDigest: def.evaluatorDigest!,
		model: "none", profileId: "no-model",
		pipelineAdapterId: CURL_REPAIR_V2_ADAPTER_ID,
		executionKind: "live-cve", reservation: { ...CURL_REPAIR_V2_RESERVATION },
	}
}

async function v2RuntimeRunsNoProviderStages(): Promise<void> {
	const events: string[] = []
	const candidate = await buildCurlHistoricalRepairTestFixture()
	const def = makeCurlRepairV2Definition()
	const store = fakeStore(events)
	const adapters = createCurlHistoricalRepairV2Adapters(
		registration(def), def, { store },
		runtimeDependencies(events, candidate),
	)
	const result = await executePipeline(adapters, def)
	assert.equal(result.status, "succeeded")
	assert.equal(result.actualMicros, 0)
	assert.equal(result.actualTokens, 0)
	assert.deepEqual(events, ["claim-current", "claim-current", "claim-current",
		"claim-current", "private-delivery-adapter"])
}

function runtimeDependencies(
	events: string[],
	candidate: Awaited<ReturnType<typeof buildCurlHistoricalRepairTestFixture>>,
): CurlRepairV2RuntimeDependencies {
	return {
		sourceRoot: "/fixed/private/source",
		buildCandidate: async () => candidate,
		verifySource: async () => { events.push("source-check") },
		prepare: async (claim) => ({
			receipt: workerReceipt(claim), receiptFileSha256: "a".repeat(64),
		}),
		evaluate: async (claim) => ({
			receipt: evaluatorReceipt(claim), receiptFileSha256: "b".repeat(64),
		}),
		evaluateBase: async () => baseReceipt(candidate),
		deliverRepair: (input) => fakeDelivery(events, input.verification),
	}
}

async function fakeDelivery(
	events: string[],
	verification: Parameters<
	NonNullable<CurlRepairV2RuntimeDependencies["deliverRepair"]>
>[0]["verification"],
): Promise<{ accepted: boolean; evidenceSha256: string }> {
	assert.equal(verification.historicalRepairV2?.candidate.patchSha256,
		CURL_REPAIR_PATCH_SHA256)
	events.push("private-delivery-adapter")
	return { accepted: true, evidenceSha256: "c".repeat(64) }
}

async function executePipeline(
	adapters: ReturnType<typeof createCurlHistoricalRepairV2Adapters>,
	def: RepositoryCampaignDefinition,
): Promise<Awaited<ReturnType<
	ReturnType<typeof createRepositoryWorkerPipeline>["execute"]
>>> {
	const pipeline = createRepositoryWorkerPipeline(adapters)
	return await pipeline.execute({
		definition: def, claim: jobClaim(), signal: new AbortController().signal,
		progress: async () => undefined,
	})
}

function fakeStore(events: string[]): RepositoryCampaignStore {
	return {
		path: "/private/v2-runtime-test/state.json",
		async assertClaimCurrent(): Promise<void> {
			events.push("claim-current")
		},
	} as unknown as RepositoryCampaignStore
}

function jobClaim(): ClaimedRepositoryJob {
	return {
		claimId, epoch: 3,
		job: {
			id: jobId, campaignId: CURL_REPAIR_V2_CAMPAIGN_ID,
			advisoryId: CURL_FIXED_ADVISORY, purpose: "repair",
			status: "running", epoch: 3,
			createdAt: Date.now(), updatedAt: Date.now(), month: "2026-10",
			reservedMicros: 1, settledMicros: 0,
			reservedTokens: 1, settledTokens: 0,
		},
	} as ClaimedRepositoryJob
}

function workerReceipt(
	claim: CurlRepairV2ClaimIdentity,
): CurlRepairV2WorkerReceipt {
	return {
		schema_version: 2, profile: CURL_REPAIR_V2_PROFILE_ID,
		job_id: claim.jobId, claim_id: claim.claimId, epoch: claim.epoch,
		stage: "candidate-preparation",
		source_revision: CURL_REPAIR_V2_SOURCE_REVISION,
		base_revision: CURL_REPAIR_HISTORICAL_BASE,
			candidate_revision: CURL_REPAIR_CANDIDATE_REVISION,
		candidate_tree: CURL_REPAIR_CANDIDATE_TREE_SHA,
			image_digest: CURL_REPAIR_V2_IMAGE_DIGEST,
		artifact_sha256: "d".repeat(64), artifact_bytes: 32,
		worker_recipe_sha256: "e".repeat(64), cleanup_confirmed: true,
		created_at_unix: 1, signature: "f".repeat(64),
	}
}

function evaluatorReceipt(
	claim: CurlRepairV2ClaimIdentity,
): CurlRepairV2EvaluatorReceipt {
	return {
		schema_version: 2, profile: CURL_REPAIR_V2_PROFILE_ID,
		job_id: claim.jobId, claim_id: claim.claimId, epoch: claim.epoch,
		stage: "candidate-evaluation",
		candidate_revision: CURL_REPAIR_CANDIDATE_REVISION,
		candidate_tree: CURL_REPAIR_CANDIDATE_TREE_SHA,
		image_digest: CURL_REPAIR_V2_IMAGE_DIGEST,
		worker_receipt_sha256: "a".repeat(64),
		candidate_artifact_sha256: "d".repeat(64),
		test_ids: [3037, 3038, 5033],
		test_results: { "3037": "pass", "3038": "pass", "5033": "pass" },
		sanitizer_clean: true, cleanup_confirmed: true,
		container_output_sha256: "1".repeat(64),
		script_sha256: "2".repeat(64), created_at_unix: 1,
		signature: "3".repeat(64),
	}
}

async function baseReceipt(candidate: Awaited<ReturnType<
	typeof buildCurlHistoricalRepairTestFixture
>>): Promise<Awaited<ReturnType<
	typeof evaluateCurlHistoricalRepairCandidate
>>> {
	return await evaluateCurlHistoricalRepairCandidate({
		candidate, jobId,
		buildCandidate: async () => candidate,
		evaluateFixedProof: async () => ({
			schemaVersion: 1, accepted: true, disposition: "already-fixed",
			evidenceSha256: "4".repeat(64),
			reasonCode: "fixed-proof-verified",
		}),
	})
}

const tests: readonly SuiteTest[] = [[
	"Curl v2 runtime runs fixed no-provider stages through private adapter",
	v2RuntimeRunsNoProviderStages,
]]

await runMain("repository-curl-repair-v2-runtime", tests)
