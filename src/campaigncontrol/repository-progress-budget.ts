import { REPOSITORY_PROGRESS_FRESH_MS } from "./repository-campaigns.js"
import { repositoryBudgetProfile } from "./repository-budget-authority.js"
import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type {
	FleetRepositoryBudgetSnapshot,
	RepositoryProgressBudget,
} from "./repository-progress-types.js"

export function repositoryProgressBudget(
	definition: RepositoryCampaignDefinition,
	budget: FleetRepositoryBudgetSnapshot | undefined,
	observedAt: number,
): RepositoryProgressBudget {
	if (!isFreshBudget(definition, budget, observedAt)) {
		return unavailableBudget()
	}
	return measuredBudget(budget)
}

function isFreshBudget(
	definition: RepositoryCampaignDefinition,
	budget: FleetRepositoryBudgetSnapshot | undefined,
	observedAt: number,
): budget is FleetRepositoryBudgetSnapshot {
	return budget !== undefined && modeIsValid(budget) &&
		timeIsValid(budget.asOfMs, observedAt) &&
		runIsValid(budget, observedAt) &&
		identityIsValid(definition, budget)
}

function modeIsValid(budget: FleetRepositoryBudgetSnapshot): boolean {
	if (budget.mode === "fleet-v2") {
		return budget.available && !budget.snapshotOnly
	}
	return (budget.mode === "fleet-v2-readonly" ||
		budget.mode === "fleet-v2-budget-only") &&
		budget.snapshotOnly === true && !budget.available
}

function timeIsValid(asOfMs: number, observedAt: number): boolean {
	return Number.isSafeInteger(asOfMs) &&
		observedAt - asOfMs <= REPOSITORY_PROGRESS_FRESH_MS &&
		asOfMs <= observedAt + REPOSITORY_PROGRESS_FRESH_MS
}

function runIsValid(
	budget: FleetRepositoryBudgetSnapshot,
	observedAt: number,
): boolean {
	if (budget.mode === "fleet-v2-readonly") {
		return budget.runId === null && budget.runExpiresAtMs === null
	}
	return budget.runExpiresAtMs !== null &&
		budget.runExpiresAtMs > observedAt
}

function identityIsValid(
	definition: RepositoryCampaignDefinition,
	budget: FleetRepositoryBudgetSnapshot,
): boolean {
	const profile = repositoryBudgetProfile(definition)
	return budget.repositoryCampaignId === definition.id &&
		budget.repositoryId === definition.repositoryId &&
		budget.repository === definition.repository &&
		budget.sourceRevision === definition.sourceRevision &&
		budget.policySha256 === definition.policySha256 &&
		budget.model === definition.model &&
		profile !== undefined && budget.profileId === profile.profileId &&
		/^[a-f0-9]{64}$/.test(budget.policySha256)
}

function measuredBudget(
	budget: FleetRepositoryBudgetSnapshot,
): RepositoryProgressBudget {
	return {
		source: "fleet-v2-ledger",
		updatedAt: budget.asOfMs,
		state: "measured",
		global: measuredGlobal(budget),
		monthly: { ...budget.monthly },
		campaignLifetime: { ...budget.campaignLifetime },
		legacyLifetime: { ...budget.legacyLifetime },
		repositoryLifetime: { ...budget.repositoryLifetime },
		control: measuredControl(budget),
		repository: measuredRepository(budget),
	}
}

function measuredGlobal(
	budget: FleetRepositoryBudgetSnapshot,
): RepositoryProgressBudget["global"] {
	return {
		limitMicros: budget.limitMicros,
		limitTokens: budget.limitTokens,
		committedMicros: budget.committedMicros,
		committedTokens: budget.committedTokens,
	}
}

function measuredControl(
	budget: FleetRepositoryBudgetSnapshot,
): RepositoryProgressBudget["control"] {
	return {
		campaignId: budget.campaignId,
		enabled: budget.globalEnabled,
		canAdmit: budget.canAdmit,
		epoch: budget.controlEpoch,
		runId: budget.runId,
		runExpiresAtMs: budget.runExpiresAtMs,
	}
}

function measuredRepository(
	budget: FleetRepositoryBudgetSnapshot,
): RepositoryProgressBudget["repository"] {
	return {
		id: budget.repositoryId,
		slug: budget.repository,
		sourceRevision: budget.sourceRevision,
		policySha256: budget.policySha256,
		model: budget.model,
		profileId: budget.profileId,
		enabled: budget.repositoryEnabled,
		epoch: budget.repositoryEpoch,
	}
}

function unavailableBudget(): RepositoryProgressBudget {
	return {
		source: "unavailable",
		updatedAt: null,
		state: "unavailable",
		global: unavailableGlobal(),
		monthly: unavailableMonthly(),
		campaignLifetime: nullLifetime(),
		legacyLifetime: nullUsage(),
		repositoryLifetime: nullLifetime(),
		control: unavailableControl(),
		repository: unavailableRepository(),
	}
}

function unavailableGlobal(): RepositoryProgressBudget["global"] {
	return {
		limitMicros: null,
		limitTokens: null,
		committedMicros: null,
		committedTokens: null,
	}
}

function unavailableMonthly(): RepositoryProgressBudget["monthly"] {
	return {
		month: null,
		limitMicros: null,
		settledMicros: null,
		reservedMicros: null,
		ambiguousMicros: null,
	}
}

function unavailableControl(): RepositoryProgressBudget["control"] {
	return {
		campaignId: null,
		enabled: null,
		canAdmit: null,
		epoch: null,
		runId: null,
		runExpiresAtMs: null,
	}
}

function unavailableRepository(): RepositoryProgressBudget["repository"] {
	return {
		id: null,
		slug: null,
		sourceRevision: null,
		policySha256: null,
		model: null,
		profileId: null,
		enabled: null,
		epoch: null,
	}
}

function nullLifetime(): RepositoryProgressBudget["campaignLifetime"] {
	return { ...nullUsage(), limitMicros: null, limitTokens: null }
}

function nullUsage(): RepositoryProgressBudget["legacyLifetime"] {
	return {
		settledMicros: null,
		reservedMicros: null,
		ambiguousMicros: null,
		settledTokens: null,
		reservedTokens: null,
		ambiguousTokens: null,
	}
}
