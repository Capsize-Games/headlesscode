import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import {
	RepositoryCampaignStore,
	type RepositoryBudgetAuthority,
	type RepositoryCampaignDefinition,
} from "../repository-campaigns.js"

const qualification = {
	sourceAudited: true,
	workerQualified: true,
	recipeQualified: true,
	evaluatorQualified: true,
	modelApproved: true,
	dataApproved: true,
	accessApproved: true,
}
const definitions: RepositoryCampaignDefinition[] =
	["repo-a", "repo-b"].map((id, index) => ({
		id,
		name: `Repository ${id}`,
		repositoryId: `fixture-${id}`,
		repository: `Capsize-Games/fixture-${id}`,
		sourceRevision: String(index + 1).repeat(40),
		policySha256: String(index + 1).repeat(64),
		workerProfile: "fixture-worker",
		recipeDigest: "c".repeat(64),
		evaluatorDigest: "d".repeat(64),
		model: "meta/muse-spark-1.3-contributor",
		dataAccessProfile: "fixture-data",
		qualification,
	}))

type AuthorityCaps = { micros: number; tokens: number }
type LifetimeCounters =
	NonNullable<RepositoryBudgetAuthority["legacyLifetime"]>

function lifetimeCounters(): LifetimeCounters {
	return {
		settledMicros: 0,
		reservedMicros: 0,
		ambiguousMicros: 0,
		settledTokens: 0,
		reservedTokens: 0,
		ambiguousTokens: 0,
	}
}

type AuthorityLimits = Pick<RepositoryBudgetAuthority, "mode" |
	"available" | "snapshotOnly" | "limitMicros" | "limitTokens" |
	"committedMicros" | "committedTokens">

function authorityLimits(): AuthorityLimits {
	return {
		mode: "fleet-v2-readonly",
		available: false,
		snapshotOnly: true,
		limitMicros: 20_000,
		limitTokens: 108_000,
		committedMicros: 0,
		committedTokens: 0,
	}
}

type AuthorityControl = Pick<RepositoryBudgetAuthority, "asOfMs" |
	"campaignId" | "globalEnabled" | "canAdmit" | "controlEpoch" |
	"runId" | "runExpiresAtMs">

function authorityControl(): AuthorityControl {
	return {
		asOfMs: Date.now(),
		campaignId: "fleet-security-watch",
		globalEnabled: true,
		canAdmit: true,
		controlEpoch: 1,
		runId: null,
		runExpiresAtMs: null,
	}
}

type AuthorityRepository = Pick<RepositoryBudgetAuthority,
	"repositoryCampaignId" | "repositoryId" | "repository" |
	"sourceRevision" | "policySha256" | "model" | "profileId" |
	"repositoryEnabled" | "repositoryEpoch">

function authorityRepository(
	id: string,
	definition: RepositoryCampaignDefinition,
): AuthorityRepository {
	return {
		repositoryCampaignId: id,
		repositoryId: definition.repositoryId!,
		repository: definition.repository!,
		sourceRevision: definition.sourceRevision!,
		policySha256: definition.policySha256!,
		model: definition.model!,
		profileId: "muse-spark-contributor",
		repositoryEnabled: true,
		repositoryEpoch: 1,
	}
}

function authorityMonthly(): NonNullable<
	RepositoryBudgetAuthority["monthly"]> {
	return {
		month: new Date().toISOString().slice(0, 7),
		limitMicros: 5_000_000,
		settledMicros: 0,
		reservedMicros: 0,
		ambiguousMicros: 0,
	}
}

type AuthorityLifetimes = Pick<RepositoryBudgetAuthority,
	"campaignLifetime" | "legacyLifetime" | "repositoryLifetime">

function authorityLifetimes(
	caps: AuthorityCaps,
	lifetime: LifetimeCounters,
): AuthorityLifetimes {
	return {
		campaignLifetime: {
			limitMicros: 20_000,
			limitTokens: 108_000,
			...lifetime,
		},
		legacyLifetime: { ...lifetime },
		repositoryLifetime: {
			limitMicros: caps.micros,
			limitTokens: caps.tokens,
			...lifetime,
		},
	}
}

function authorityFor(
	id: string,
	caps: AuthorityCaps = { micros: 18_000, tokens: 90_000 },
): RepositoryBudgetAuthority {
	const definition = definitions.find((item) => item.id === id)!
	return {
		...authorityLimits(),
		...authorityControl(),
		...authorityRepository(id, definition),
		monthly: authorityMonthly(),
		...authorityLifetimes(caps, lifetimeCounters()),
	}
}

const allocationTitle = "Fleet per-repository spend and token caps are " +
	"independent of aggregate campaign allocation"

type AllocationStatus = {
	campaigns: Array<{
		id: string
		budgetLimitMicros: number
		budgetLimitTokens: number
	}>
}

async function allocationsOf(
	store: RepositoryCampaignStore,
): Promise<Array<[number, number]>> {
	const status = await store.status() as AllocationStatus
	return status.campaigns.map(
		({ budgetLimitMicros, budgetLimitTokens }) =>
			[budgetLimitMicros, budgetLimitTokens])
}

async function rejectOverages(store: RepositoryCampaignStore): Promise<void> {
	await assert.rejects(store.setCampaignBudget("repo-a", 18_001, 90_000),
		/authoritative Fleet per-repository allocation/)
	await assert.rejects(store.setCampaignBudget("repo-a", 18_000, 90_001),
		/authoritative Fleet per-repository allocation/)
	assert.deepEqual(await allocationsOf(store), [[0, 0], [0, 0]],
		"rejected repository overages do not mutate either allocation")
}

async function blockReducedCap(statePath: string): Promise<void> {
	const reduced = new RepositoryCampaignStore(statePath, definitions,
		(id) => authorityFor(id ?? "repo-a",
			{ micros: 17_000, tokens: 80_000 }))
	await assert.rejects(reduced.start("repo-a"),
		/campaign is blocked: repository-budget-allocation/,
		"a persisted allocation above a later authoritative per-repository " +
		"cap cannot start")
}

test(allocationTitle, async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(),
		"hcl-budget-allocation-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const statePath = path.join(root, "campaigns.json")
	const store = new RepositoryCampaignStore(statePath, definitions,
		(id) => authorityFor(id ?? "repo-a"))
	await rejectOverages(store)
	await store.setCampaignBudget("repo-a", 18_000, 90_000)
	await blockReducedCap(statePath)
	await assert.rejects(store.setCampaignBudget("repo-b", 3_000, 18_000),
		/authoritative Fleet aggregate allocation/)
	await store.setCampaignBudget("repo-b", 2_000, 18_000)
	assert.deepEqual(await allocationsOf(store),
		[[18_000, 90_000], [2_000, 18_000]],
		"two repository allocations may use the global ceiling without " +
		"crossing per-repository caps")
})
