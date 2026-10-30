import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type { RepositoryWorkerRegistration,
	RepositoryPipelineAdapterFactoryContext } from
		"./repository-worker-registration.js"
import type { RepositoryWorkerPipelineAdapters } from
	"./repository-worker-pipeline.js"
import type { CurlRuntimeDependencies } from
	"./repository-curl-runtime-dependencies.js"
import { validateRegistration } from "./repository-curl-registration.js"
import {
	resolveCurlRuntimePaths,
	resolveCurlRuntimeServices,
	buildCurlPipelineAdapters,
} from "./repository-curl-adapter-builder.js"

export {
	CURL_PRIVATE_SOURCE_ROOT,
	CURL_CAMPAIGN_POLICY,
	CURL_CAMPAIGN_POLICY_SHA256,
	CURL_PRIVATE_RUNTIME_ADAPTER_ID,
	CURL_RUNTIME_CONFIG_PATH,
} from "./repository-curl-profile.js"
export {
	writePrivateCurlDeliveryReceipt,
	type CurlPrivateBoardTransport,
} from "./repository-curl-private-delivery.js"
export { validateCurlRuntimeConfig } from "./repository-curl-runtime-config.js"
export type { CurlRuntimeConfig } from "./repository-curl-runtime-config.js"

/** Bind the fixed Curl profile to owner-registered campaign dependencies. */
export function createCurlRepositoryPipelineAdapters(
	registration: RepositoryWorkerRegistration,
	definition: RepositoryCampaignDefinition,
	context: RepositoryPipelineAdapterFactoryContext,
	dependencies: CurlRuntimeDependencies = {},
): RepositoryWorkerPipelineAdapters {
	validateRegistration(registration, definition, context)
	const paths = resolveCurlRuntimePaths(dependencies)
	const services = resolveCurlRuntimeServices(definition, dependencies)
	return buildCurlPipelineAdapters({
		registration,
		definition,
		context,
		dependencies,
		paths,
		services,
	})
}
