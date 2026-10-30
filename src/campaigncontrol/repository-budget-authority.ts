import * as path from "node:path"
import { CAMPAIGN_CONTROL_FILE } from "./paths.js"
import { CampaignControlStore } from "./store.js"
import type { RepositoryBudgetAuthority, RepositoryCampaignDefinition } from "./repository-campaigns.js"
import { FleetRepositoryBudgetLedger, type FleetRepositoryBudgetLedgerOptions, type FleetRepositoryBudgetScope } from "../rsi/fleet-repository-budget-ledger.js"
import { readFleetBudgetKeyIdentity } from "../rsi/fleet-budget-ledger.js"
import { CURL_REPAIR_CAMPAIGN_ID, CURL_REPAIR_EVALUATOR_DIGEST, CURL_REPAIR_POLICY_SHA256,
	CURL_REPAIR_PROFILE_ID, CURL_REPAIR_RECIPE_DIGEST, CURL_REPAIR_REPOSITORY_ID,
	CURL_REPAIR_SOURCE_REVISION, CURL_REPAIR_TARGET_REPOSITORY } from "./repository-curl-repair.js"

const MODEL = "meta/muse-spark-1.3-contributor"
const PROFILE = "muse-spark-contributor"
const REPAIR_MODEL = "none"
const REPAIR_PROFILE = "no-model"

export interface RepositoryBudgetAuthorityReaderDependencies {
	/** Test seams only; production reads the existing host key-identity metadata and fixed bridge. */
	readKeyIdentity?: typeof readFleetBudgetKeyIdentity
	createLedger?: (options: FleetRepositoryBudgetLedgerOptions) => Pick<FleetRepositoryBudgetLedger, "budgetSnapshot" | "budgetSnapshotOnly">
}

export function repositoryBudgetProfile(
	definition: RepositoryCampaignDefinition,
): Pick<FleetRepositoryBudgetScope, "model" | "profileId"> | undefined {
	if (definition.id === CURL_REPAIR_CAMPAIGN_ID) {
		if (definition.repositoryId !== CURL_REPAIR_REPOSITORY_ID || definition.repository !== CURL_REPAIR_TARGET_REPOSITORY ||
			definition.sourceRevision !== CURL_REPAIR_SOURCE_REVISION || definition.policySha256 !== CURL_REPAIR_POLICY_SHA256 ||
			definition.workerProfile !== CURL_REPAIR_PROFILE_ID || definition.recipeDigest !== CURL_REPAIR_RECIPE_DIGEST ||
			definition.evaluatorDigest !== CURL_REPAIR_EVALUATOR_DIGEST || definition.model !== REPAIR_MODEL) return undefined
		return { model: REPAIR_MODEL, profileId: REPAIR_PROFILE }
	}
	return definition.model === MODEL ? { model: MODEL, profileId: PROFILE } : undefined
}

/** Current, source-bound Fleet v2 authority. Every call is a fresh bridge snapshot. */
export function createRepositoryBudgetAuthorityReader(
	definitions: readonly RepositoryCampaignDefinition[], controlPath = CAMPAIGN_CONTROL_FILE,
	dependencies: RepositoryBudgetAuthorityReaderDependencies = {},
): (campaignId?: string) => Promise<RepositoryBudgetAuthority> {
	const byId = new Map(definitions.map((definition) => [definition.id, structuredClone(definition)]))
	const control = new CampaignControlStore(controlPath)
	return async (campaignId) => {
		if (!campaignId) return unavailable()
		const definition = byId.get(campaignId)
		const profile = definition && repositoryBudgetProfile(definition)
		if (!definition || !profile || !definition.repositoryId || !definition.repository ||
			!definition.sourceRevision || !/^[a-f0-9]{40}$/.test(definition.sourceRevision) || !definition.policySha256 || !/^[a-f0-9]{64}$/.test(definition.policySha256)) {
			return unavailable()
		}
		try {
			const state = await control.snapshot()
			const row = state.repositoryCampaigns?.[campaignId]
			if (!row || row.repositoryId !== definition.repositoryId || row.sourceRevision !== definition.sourceRevision || row.policySha256 !== definition.policySha256) return unavailable()
			const expectedKeyIdentity = await (dependencies.readKeyIdentity ?? readFleetBudgetKeyIdentity)()
			const scope: FleetRepositoryBudgetScope = { repositoryCampaignId: definition.id, repositoryId: definition.repositoryId,
				repository: definition.repository, sourceRevision: definition.sourceRevision, policySha256: definition.policySha256,
				model: profile.model, profileId: profile.profileId, repositoryEpoch: row.epoch }
			const ledger = (dependencies.createLedger ?? ((options) => new FleetRepositoryBudgetLedger(options)))({ expectedKeyIdentity, scope })
			const hasLiveRun = state.enabled && state.activeRun !== null && state.activeRun.expiresAt > Date.now() && state.activeRun.epoch === state.epoch
			const isBudgetOnly = profile.model === REPAIR_MODEL && profile.profileId === REPAIR_PROFILE
			const snapshot = hasLiveRun ? await ledger.budgetSnapshot() : await ledger.budgetSnapshotOnly()
			const stateAfter = isBudgetOnly ? await control.snapshot() : state
			const runAfter = stateAfter.activeRun
			const rowAfter = stateAfter.repositoryCampaigns?.[campaignId]
			const stableRun = !isBudgetOnly || !hasLiveRun || (stateAfter.enabled && runAfter !== null && runAfter.id === state.activeRun!.id &&
				runAfter.epoch === state.epoch && runAfter.expiresAt > Date.now() && rowAfter?.enabled === row.enabled &&
				rowAfter.epoch === row.epoch && rowAfter.repositoryId === row.repositoryId && rowAfter.sourceRevision === row.sourceRevision &&
				rowAfter.policySha256 === row.policySha256)
			if (snapshot.repositoryCampaignId !== definition.id || snapshot.repositoryId !== definition.repositoryId ||
				snapshot.repository !== definition.repository || snapshot.sourceRevision !== definition.sourceRevision ||
				snapshot.policySha256 !== definition.policySha256 || snapshot.repositoryEpoch !== row.epoch ||
				snapshot.repositoryEnabled !== row.enabled || (hasLiveRun
					? isBudgetOnly
						? snapshot.snapshotOnly !== true || snapshot.available || snapshot.globalEnabled !== true || snapshot.canAdmit !== true ||
							!row.enabled || !stableRun || snapshot.runId !== state.activeRun!.id ||
							snapshot.runExpiresAtMs !== state.activeRun!.expiresAt || snapshot.controlEpoch !== state.activeRun!.epoch
						: snapshot.mode !== "fleet-v2" || snapshot.runId !== state.activeRun!.id || snapshot.controlEpoch !== state.activeRun!.epoch
					: snapshot.mode !== "fleet-v2-readonly" || snapshot.runId !== null || snapshot.runExpiresAtMs !== null) ||
				path.resolve(control.path) !== path.resolve(controlPath)) return unavailable()
			return isBudgetOnly && hasLiveRun ? { ...snapshot, mode: "fleet-v2-budget-only" } : snapshot
		} catch { return unavailable() }
	}
}

function unavailable(): RepositoryBudgetAuthority {
	return { mode: "unavailable", available: false, limitMicros: 0, limitTokens: 0, committedMicros: 0, committedTokens: 0 }
}
