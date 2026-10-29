import * as path from "node:path"
import { CAMPAIGN_CONTROL_FILE } from "./paths.js"
import { CampaignControlStore } from "./store.js"
import type { RepositoryBudgetAuthority, RepositoryCampaignDefinition } from "./repository-campaigns.js"
import { FleetRepositoryBudgetLedger, type FleetRepositoryBudgetScope } from "../rsi/fleet-repository-budget-ledger.js"
import { readFleetBudgetKeyIdentity } from "../rsi/fleet-budget-ledger.js"

const MODEL = "meta/muse-spark-1.3-contributor"
const PROFILE = "muse-spark-contributor"

/** Current, source-bound Fleet v2 authority. Every call is a fresh bridge snapshot. */
export function createRepositoryBudgetAuthorityReader(
	definitions: readonly RepositoryCampaignDefinition[], controlPath = CAMPAIGN_CONTROL_FILE,
): (campaignId?: string) => Promise<RepositoryBudgetAuthority> {
	const byId = new Map(definitions.map((definition) => [definition.id, structuredClone(definition)]))
	const control = new CampaignControlStore(controlPath)
	return async (campaignId) => {
		if (!campaignId) return unavailable()
		const definition = byId.get(campaignId)
		if (!definition || definition.model !== MODEL || !definition.repositoryId || !definition.repository ||
			!definition.sourceRevision || !/^[a-f0-9]{40}$/.test(definition.sourceRevision) || !definition.policySha256 || !/^[a-f0-9]{64}$/.test(definition.policySha256)) {
			return unavailable()
		}
		try {
			const state = await control.snapshot()
			const row = state.repositoryCampaigns?.[campaignId]
			if (!row || row.repositoryId !== definition.repositoryId || row.sourceRevision !== definition.sourceRevision || row.policySha256 !== definition.policySha256) return unavailable()
			const expectedKeyIdentity = await readFleetBudgetKeyIdentity()
			const scope: FleetRepositoryBudgetScope = { repositoryCampaignId: definition.id, repositoryId: definition.repositoryId,
				repository: definition.repository, sourceRevision: definition.sourceRevision, policySha256: definition.policySha256,
				model: MODEL, profileId: PROFILE, repositoryEpoch: row.epoch }
			const ledger = new FleetRepositoryBudgetLedger({ expectedKeyIdentity, scope })
			const hasLiveRun = state.enabled && state.activeRun !== null && state.activeRun.expiresAt > Date.now() && state.activeRun.epoch === state.epoch
			const snapshot = hasLiveRun ? await ledger.budgetSnapshot() : await ledger.budgetSnapshotOnly()
			if (snapshot.repositoryCampaignId !== definition.id || snapshot.repositoryId !== definition.repositoryId ||
				snapshot.repository !== definition.repository || snapshot.sourceRevision !== definition.sourceRevision ||
				snapshot.policySha256 !== definition.policySha256 || snapshot.repositoryEpoch !== row.epoch ||
				snapshot.repositoryEnabled !== row.enabled || (hasLiveRun
					? snapshot.mode !== "fleet-v2" || snapshot.runId !== state.activeRun!.id || snapshot.controlEpoch !== state.activeRun!.epoch
					: snapshot.mode !== "fleet-v2-readonly") ||
				path.resolve(control.path) !== path.resolve(controlPath)) return unavailable()
			return snapshot
		} catch { return unavailable() }
	}
}

function unavailable(): RepositoryBudgetAuthority {
	return { mode: "unavailable", available: false, limitMicros: 0, limitTokens: 0, committedMicros: 0, committedTokens: 0 }
}
