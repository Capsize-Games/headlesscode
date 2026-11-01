import type {
	RepositoryBudgetAuthority,
	RepositoryCampaignDefinition,
} from "../repository-campaigns.js"

export interface FleetAuthorityState {
	snapshotProvisioning: boolean
	globalEnabled: boolean
	liveRunId: string
}

type LifetimeCounters =
	NonNullable<RepositoryBudgetAuthority["legacyLifetime"]>

export function syntheticAuthority(): RepositoryBudgetAuthority {
	return {
		mode: "synthetic-test", available: true, limitMicros: 100_000,
		limitTokens: 100_000, committedMicros: 0, committedTokens: 0,
	}
}

function lifetimeZeros(): LifetimeCounters {
	return {
		settledMicros: 0,
		reservedMicros: 0,
		ambiguousMicros: 0,
		settledTokens: 0,
		reservedTokens: 0,
		ambiguousTokens: 0,
	}
}

function fleetControl(
	state: FleetAuthorityState,
	now: number,
): Pick<RepositoryBudgetAuthority, "mode" | "available" |
	"snapshotOnly" | "limitMicros" | "limitTokens" |
	"committedMicros" | "committedTokens" | "asOfMs" |
	"campaignId" | "globalEnabled" | "canAdmit" |
	"controlEpoch" | "runId" | "runExpiresAtMs"> {
	const provisioning = state.snapshotProvisioning
	return {
		mode: provisioning ? "fleet-v2-readonly" : "fleet-v2-budget-only",
		available: false, snapshotOnly: true,
		limitMicros: 20_000, limitTokens: 108_000,
		committedMicros: 0, committedTokens: 0, asOfMs: now,
		campaignId: "fleet-security-watch",
		globalEnabled: state.globalEnabled, canAdmit: true,
		controlEpoch: 1, runId: provisioning ? null : state.liveRunId,
		runExpiresAtMs: provisioning ? null : now + 300_000,
	}
}

function fleetRepository(
	definition: RepositoryCampaignDefinition,
): Pick<RepositoryBudgetAuthority, "repositoryCampaignId" |
	"repositoryId" | "repository" | "sourceRevision" |
	"policySha256" | "model" | "profileId" |
	"repositoryEnabled" | "repositoryEpoch"> {
	return {
		repositoryCampaignId: definition.id,
		repositoryId: definition.repositoryId,
		repository: definition.repository,
		sourceRevision: definition.sourceRevision!,
		policySha256: definition.policySha256!,
		model: "none", profileId: "no-model",
		repositoryEnabled: true, repositoryEpoch: 1,
	}
}

function fleetMonthly(): NonNullable<
	RepositoryBudgetAuthority["monthly"]> {
	return {
		month: new Date().toISOString().slice(0, 7),
		limitMicros: 5_000_000,
		settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0,
	}
}

function fleetLifetimes(
	counters: LifetimeCounters,
): Pick<RepositoryBudgetAuthority, "campaignLifetime" |
	"legacyLifetime" | "repositoryLifetime"> {
	return {
		campaignLifetime: {
			limitMicros: 20_000, limitTokens: 108_000, ...counters,
		},
		legacyLifetime: { ...counters },
		repositoryLifetime: {
			limitMicros: 1_000, limitTokens: 7_000, ...counters,
		},
	}
}

export function fleetAuthority(
	state: FleetAuthorityState,
	definition: RepositoryCampaignDefinition,
): RepositoryBudgetAuthority {
	const now = Date.now()
	return {
		...fleetControl(state, now),
		...fleetRepository(definition),
		monthly: fleetMonthly(),
		...fleetLifetimes(lifetimeZeros()),
	}
}
