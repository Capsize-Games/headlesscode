import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority, type RepositoryCampaignDefinition } from "../repository-campaigns.js"

const qualification = { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definitions: RepositoryCampaignDefinition[] = ["repo-a", "repo-b"].map((id, index) => ({
	id, name: `Repository ${id}`, repositoryId: `fixture-${id}`, repository: `Capsize-Games/fixture-${id}`,
	sourceRevision: String(index + 1).repeat(40), policySha256: String(index + 1).repeat(64), workerProfile: "fixture-worker",
	recipeDigest: "c".repeat(64), evaluatorDigest: "d".repeat(64), model: "meta/muse-spark-1.3-contributor",
	dataAccessProfile: "fixture-data", qualification,
}))

function authorityFor(id: string, caps = { micros: 18_000, tokens: 90_000 }): RepositoryBudgetAuthority {
	const definition = definitions.find((item) => item.id === id)!
	const lifetime = { settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0,
		settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0 }
	return {
		mode: "fleet-v2-readonly", available: false, snapshotOnly: true,
		limitMicros: 20_000, limitTokens: 108_000, committedMicros: 0, committedTokens: 0,
		asOfMs: Date.now(), campaignId: "fleet-security-watch", globalEnabled: true, canAdmit: true, controlEpoch: 1,
		runId: null, runExpiresAtMs: null, repositoryCampaignId: id, repositoryId: definition.repositoryId!,
		repository: definition.repository!, sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!,
		model: definition.model!, profileId: "muse-spark-contributor", repositoryEnabled: true, repositoryEpoch: 1,
		monthly: { month: new Date().toISOString().slice(0, 7), limitMicros: 5_000_000,
			settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 },
		campaignLifetime: { limitMicros: 20_000, limitTokens: 108_000, ...lifetime },
		legacyLifetime: { ...lifetime },
		repositoryLifetime: { limitMicros: caps.micros, limitTokens: caps.tokens, ...lifetime },
	}
}

test("Fleet per-repository spend and token caps are independent of aggregate campaign allocation", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-budget-allocation-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const statePath = path.join(root, "campaigns.json")
	const store = new RepositoryCampaignStore(statePath, definitions,
		(id) => authorityFor(id ?? "repo-a"))

	await assert.rejects(store.setCampaignBudget("repo-a", 18_001, 90_000), /authoritative Fleet per-repository allocation/)
	await assert.rejects(store.setCampaignBudget("repo-a", 18_000, 90_001), /authoritative Fleet per-repository allocation/)
	let status = await store.status() as { campaigns: Array<{ id: string; budgetLimitMicros: number; budgetLimitTokens: number }> }
	assert.deepEqual(status.campaigns.map(({ budgetLimitMicros, budgetLimitTokens }) => [budgetLimitMicros, budgetLimitTokens]), [[0, 0], [0, 0]],
		"rejected repository overages do not mutate either allocation")

	await store.setCampaignBudget("repo-a", 18_000, 90_000)
	const reducedCapStore = new RepositoryCampaignStore(statePath, definitions,
		(id) => authorityFor(id ?? "repo-a", { micros: 17_000, tokens: 80_000 }))
	await assert.rejects(reducedCapStore.start("repo-a"), /campaign is blocked: repository-budget-allocation/,
		"a persisted allocation above a later authoritative per-repository cap cannot start")
	await assert.rejects(store.setCampaignBudget("repo-b", 3_000, 18_000), /authoritative Fleet aggregate allocation/)
	await store.setCampaignBudget("repo-b", 2_000, 18_000)
	status = await store.status() as typeof status
	assert.deepEqual(status.campaigns.map(({ budgetLimitMicros, budgetLimitTokens }) => [budgetLimitMicros, budgetLimitTokens]),
		[[18_000, 90_000], [2_000, 18_000]], "two repository allocations may use the global ceiling without crossing per-repository caps")
})
