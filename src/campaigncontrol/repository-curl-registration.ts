import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type { RepositoryWorkerRegistration,
	RepositoryPipelineAdapterFactoryContext } from
		"./repository-worker-registration.js"
import {
	CURL_CAMPAIGN_ID, CURL_PRIVATE_SOURCE_REVISION, CURL_WORKER_DIGEST,
	CURL_EVALUATOR_DIGEST,
} from "./repository-curl-evaluator.js"
import {
	MODEL, PROFILE_ID, REPOSITORY_ID, REPOSITORY, WORKER_PROFILE,
	MAX_JOB_MICROS, MAX_JOB_TOKENS, CURL_CAMPAIGN_POLICY_SHA256,
} from "./repository-curl-profile.js"

const PROFILE_MISMATCH =
	"Curl runtime registration is outside the compiled owner-qualified profile"

export function validateRegistration(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
	context: RepositoryPipelineAdapterFactoryContext): void {
	if (!context?.store) {
		throw new Error(PROFILE_MISMATCH)
	}
	assertCampaignIdentity(registration, definition)
	assertSourceProfile(registration, definition)
	assertRecipeIdentity(registration, definition)
	assertExecutionCaps(registration, definition)
}

function assertCampaignIdentity(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition): void {
	if (registration.campaignId !== CURL_CAMPAIGN_ID ||
		definition.id !== CURL_CAMPAIGN_ID ||
		registration.repositoryId !== REPOSITORY_ID ||
			definition.repositoryId !== REPOSITORY_ID ||
		registration.repository !== REPOSITORY ||
			definition.repository !== REPOSITORY) {
		throw new Error(PROFILE_MISMATCH)
	}
}

function assertSourceProfile(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition): void {
	if (registration.sourceRevision !== CURL_PRIVATE_SOURCE_REVISION ||
		definition.sourceRevision !== CURL_PRIVATE_SOURCE_REVISION ||
		registration.workerProfile !== WORKER_PROFILE ||
			definition.workerProfile !== WORKER_PROFILE ||
		registration.profileId !== PROFILE_ID ||
			definition.dataAccessProfile !==
				"public-upstream-source-and-published-advisory-only") {
		throw new Error(PROFILE_MISMATCH)
	}
}

function assertRecipeIdentity(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition): void {
	if (registration.recipeDigest !== CURL_WORKER_DIGEST ||
		definition.recipeDigest !== CURL_WORKER_DIGEST ||
		registration.evaluatorDigest !== CURL_EVALUATOR_DIGEST ||
			definition.evaluatorDigest !== CURL_EVALUATOR_DIGEST ||
		registration.policySha256 !== CURL_CAMPAIGN_POLICY_SHA256 ||
		definition.policySha256 !== CURL_CAMPAIGN_POLICY_SHA256) {
		throw new Error(PROFILE_MISMATCH)
	}
}

function assertExecutionCaps(registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition): void {
	if (registration.model !== MODEL || definition.model !== MODEL ||
		registration.pipelineAdapterId !== "curl-92390-private-runtime-v1" ||
			registration.executionKind !== "live-cve" ||
		registration.reservation.micros !== MAX_JOB_MICROS ||
		registration.reservation.tokens !== MAX_JOB_TOKENS ||
			!definition.repositoryId || !definition.repository) {
		throw new Error(PROFILE_MISMATCH)
	}
}
