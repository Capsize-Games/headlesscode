import type { ActiveCampaignRun } from "../store.js"
import type {
	RepositoryCampaignRunLease,
} from "../repository-run-lease.js"
import type {
	RepositoryBudgetAuthority,
} from "../repository-campaigns.js"
import { CURL_REPAIR_PROFILE_ID } from "../repository-curl-repair.js"
import {
	createCurlHistoricalRepairAdapters,
	type CurlRepairRuntimeDependencies,
} from "../repository-curl-repair-runtime.js"
import type {
	RepositoryPipelineAdapterFactory,
} from "../repository-worker-registry.js"
import {
	campaignLifetimeBudget, emptyLifetime, liveRepositoryScope,
	liveRunScope, monthlyBudget, waitForTerminal,
} from "./coordinator-fixtures.js"
import {
	repairDefinition, repairRegistration,
} from "./repository-curl-repair-support.js"

export { waitForTerminal }

export const definition = repairDefinition()

export const registration = repairRegistration(definition)

type AuthorityBudgets = Pick<RepositoryBudgetAuthority,
	"monthly" | "campaignLifetime" | "legacyLifetime" |
	"repositoryLifetime">

function authorityBudgets(): AuthorityBudgets {
	return {
		monthly: monthlyBudget,
		campaignLifetime: campaignLifetimeBudget,
		legacyLifetime: emptyLifetime,
		repositoryLifetime: {
			limitMicros: 2_000, limitTokens: 18_000,
			...emptyLifetime,
		},
	}
}

export function authority(
	run: ActiveCampaignRun,
): RepositoryBudgetAuthority {
	return {
		mode: "fleet-v2", available: true,
		limitMicros: 20_000, limitTokens: 108_000,
		committedMicros: 0, committedTokens: 0, asOfMs: Date.now(),
		campaignId: "fleet-security-watch", globalEnabled: true,
		canAdmit: true, profileId: CURL_REPAIR_PROFILE_ID,
		repositoryEnabled: true, repositoryEpoch: 1,
		...liveRunScope(run), ...liveRepositoryScope(definition),
		...authorityBudgets(),
	}
}

export function runLease(run: ActiveCampaignRun): RepositoryCampaignRunLease {
	return {
		async acquire(): ReturnType<
			RepositoryCampaignRunLease["acquire"]> {
			return run
		},
		async finish(run: ActiveCampaignRun,
			status: "succeeded" | "failed"): ReturnType<
			RepositoryCampaignRunLease["finish"]> {
			return { ...run, status, finishedAt: Date.now() }
		},
	}
}

export function repairFactory(
	dependencies: CurlRepairRuntimeDependencies,
): RepositoryPipelineAdapterFactory {
	return (item, current, context) => {
		if (!context) {
			throw new Error("repair intake fixture requires its campaign store")
		}
		return createCurlHistoricalRepairAdapters(item, current, context,
			dependencies)
	}
}

