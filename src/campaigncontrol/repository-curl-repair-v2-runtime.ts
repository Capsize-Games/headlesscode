import * as path from "node:path"
import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type {
	RepositoryPipelineAdapterFactoryContext,
	RepositoryWorkerRegistration,
} from "./repository-worker-registration.js"
import type {
	RepositoryWorkerPipelineAdapters,
} from "./repository-worker-pipeline.js"
import {
	buildCurlHistoricalRepairCandidate,
	CURL_REPAIR_PRIVATE_SOURCE_ROOT,
	verifyCurlHistoricalRepairSourcePin,
} from "./repository-curl-repair.js"
import {
	prepareCurlRepairV2Candidate,
	evaluateCurlRepairV2Candidate,
} from "./repository-curl-repair-v2-execution.js"
import {
	CURL_REPAIR_V2_ADAPTER_ID,
	CURL_REPAIR_V2_ACCESS_PROFILE,
	CURL_REPAIR_V2_EVALUATOR_DIGEST,
	CURL_REPAIR_V2_MODEL,
	CURL_REPAIR_V2_POLICY_SHA256,
	CURL_REPAIR_V2_PROFILE_ID,
	CURL_REPAIR_V2_RECIPE_DIGEST,
	CURL_REPAIR_V2_REPOSITORY_ID,
	CURL_REPAIR_V2_RESERVATION,
	CURL_REPAIR_V2_SOURCE_REVISION,
	CURL_REPAIR_V2_TARGET_REPOSITORY,
} from "./repository-curl-repair-v2-profile.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "./repository-campaign-ids.js"
import type {
	CurlRepairV2AdapterScope,
	CurlRepairV2RuntimeDependencies,
} from "./repository-curl-repair-v2-runtime-types.js"
import {
	createCurlRepairV2AdapterMethods,
} from "./repository-curl-repair-v2-runtime-hooks.js"

export type { CurlRepairV2RuntimeDependencies } from
	"./repository-curl-repair-v2-runtime-types.js"

/** Bind the fixed isolated worker and evaluator to the v2 campaign. */
export function createCurlHistoricalRepairV2Adapters(
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
	context: RepositoryPipelineAdapterFactoryContext,
	dependencies: CurlRepairV2RuntimeDependencies = {},
): RepositoryWorkerPipelineAdapters {
	validateRegistration(registration, definition, context)
	const scope = createScope(registration, definition, context, dependencies)
	return { ...registrationAdapterFields(registration),
		...createCurlRepairV2AdapterMethods(scope) }
}

function registrationAdapterFields(
	registration: RepositoryWorkerRegistration,
): Pick<RepositoryWorkerPipelineAdapters,
	"workerProfile" | "recipeDigest" | "evaluatorDigest" | "model" |
	"executionKind" | "reservation"> {
	return {
		workerProfile: registration.workerProfile,
		recipeDigest: registration.recipeDigest,
		evaluatorDigest: registration.evaluatorDigest,
		model: registration.model,
		executionKind: "live-cve",
		reservation: { ...registration.reservation },
	}
}

function createScope(
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
	context: RepositoryPipelineAdapterFactoryContext,
	dependencies: CurlRepairV2RuntimeDependencies,
): CurlRepairV2AdapterScope {
	return {
		registration, definition, context, dependencies,
		sourceRoot: path.resolve(
			dependencies.sourceRoot ?? CURL_REPAIR_PRIVATE_SOURCE_ROOT,
		),
		buildCandidate: dependencies.buildCandidate ??
			buildCurlHistoricalRepairCandidate,
		prepare: dependencies.prepare ?? prepareCurlRepairV2Candidate,
		evaluate: dependencies.evaluate ?? evaluateCurlRepairV2Candidate,
		verifySource: dependencies.verifySource ??
			verifyCurlHistoricalRepairSourcePin,
	}
}

function validateRegistration(
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
	context: RepositoryPipelineAdapterFactoryContext,
): void {
	if (!context?.store || !identitiesMatch(registration, definition) ||
		!profilesMatch(registration, definition) || !limitsMatch(registration) ||
		!qualificationMatches(definition)) {
		throw new Error("Curl v2 registration is outside its compiled profile")
	}
}

function identitiesMatch(
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
): boolean {
	return registration.campaignId === CURL_REPAIR_V2_CAMPAIGN_ID &&
		definition.id === CURL_REPAIR_V2_CAMPAIGN_ID &&
		registration.repositoryId === CURL_REPAIR_V2_REPOSITORY_ID &&
		definition.repositoryId === CURL_REPAIR_V2_REPOSITORY_ID &&
		registration.repository === CURL_REPAIR_V2_TARGET_REPOSITORY &&
		definition.repository === CURL_REPAIR_V2_TARGET_REPOSITORY &&
		registration.sourceRevision === CURL_REPAIR_V2_SOURCE_REVISION &&
		definition.sourceRevision === CURL_REPAIR_V2_SOURCE_REVISION &&
		registration.policySha256 === CURL_REPAIR_V2_POLICY_SHA256 &&
		definition.policySha256 === CURL_REPAIR_V2_POLICY_SHA256
}

function profilesMatch(
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
): boolean {
	return workerProfilesMatch(registration, definition) &&
		metadataProfilesMatch(registration, definition)
}

function workerProfilesMatch(
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
): boolean {
	return registration.workerProfile === CURL_REPAIR_V2_PROFILE_ID &&
		definition.workerProfile === CURL_REPAIR_V2_PROFILE_ID &&
		registration.recipeDigest === CURL_REPAIR_V2_RECIPE_DIGEST &&
		definition.recipeDigest === CURL_REPAIR_V2_RECIPE_DIGEST &&
		registration.evaluatorDigest === CURL_REPAIR_V2_EVALUATOR_DIGEST &&
		definition.evaluatorDigest === CURL_REPAIR_V2_EVALUATOR_DIGEST
}

function metadataProfilesMatch(
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
): boolean {
	return registration.model === CURL_REPAIR_V2_MODEL &&
		definition.model === CURL_REPAIR_V2_MODEL &&
		registration.profileId === "no-model" &&
		definition.dataAccessProfile === CURL_REPAIR_V2_ACCESS_PROFILE &&
		registration.pipelineAdapterId === CURL_REPAIR_V2_ADAPTER_ID
}

function limitsMatch(registration: RepositoryWorkerRegistration): boolean {
	return registration.executionKind === "live-cve" &&
		registration.reservation.micros === CURL_REPAIR_V2_RESERVATION.micros &&
		registration.reservation.tokens === CURL_REPAIR_V2_RESERVATION.tokens
}

function qualificationMatches(
	definition: RepositoryCampaignDefinition,
): boolean {
	const qualification = definition.qualification
	return qualification.sourceAudited && qualification.workerQualified &&
		qualification.recipeQualified && qualification.evaluatorQualified &&
		qualification.dataApproved && qualification.accessApproved
}
