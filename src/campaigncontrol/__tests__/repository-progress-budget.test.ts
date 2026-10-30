import assert from "node:assert/strict"
import { test } from "node:test"
import type { RepositoryCampaignDefinition } from "../repository-campaigns.js"
import {
	repositoryProgressSnapshot,
	type FleetRepositoryBudgetSnapshot,
} from "../repository-progress.js"
import {
	CURL_REPAIR_CAMPAIGN_ID,
	CURL_REPAIR_EVALUATOR_DIGEST,
	CURL_REPAIR_POLICY_SHA256,
	CURL_REPAIR_PROFILE_ID,
	CURL_REPAIR_RECIPE_DIGEST,
	CURL_REPAIR_REPOSITORY_ID,
	CURL_REPAIR_SOURCE_REVISION,
	CURL_REPAIR_TARGET_REPOSITORY,
} from "../repository-curl-repair.js"

const now = Date.now()
const definition: RepositoryCampaignDefinition = {
	id: "example-repository", name: "Fixture repository",
	repositoryId: "example-repository", repository: "example/repository",
	sourceRevision: "a".repeat(40), policySha256: "b".repeat(64),
	workerProfile: "published-advisory-worker", recipeDigest: "c".repeat(64),
	evaluatorDigest: "d".repeat(64), model: "meta/muse-spark-1.3-contributor",
	dataAccessProfile: "synthetic-test",
	qualification: {
		sourceAudited: true, workerQualified: true, recipeQualified: true,
		evaluatorQualified: true, modelApproved: true, dataApproved: true,
		accessApproved: true,
	},
}
const repair: RepositoryCampaignDefinition = {
	...definition, id: CURL_REPAIR_CAMPAIGN_ID,
	repositoryId: CURL_REPAIR_REPOSITORY_ID,
	repository: CURL_REPAIR_TARGET_REPOSITORY,
	sourceRevision: CURL_REPAIR_SOURCE_REVISION,
	policySha256: CURL_REPAIR_POLICY_SHA256,
	workerProfile: CURL_REPAIR_PROFILE_ID,
	recipeDigest: CURL_REPAIR_RECIPE_DIGEST,
	evaluatorDigest: CURL_REPAIR_EVALUATOR_DIGEST,
	model: "none",
}
const zero = {
	settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0,
	settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0,
}
const lifetime = { ...zero, limitMicros: 20_000, limitTokens: 108_000 }

function budget(
	current: RepositoryCampaignDefinition,
	profileId: string,
): FleetRepositoryBudgetSnapshot {
	return {
		...budgetTotals(), repositoryCampaignId: current.id,
		repositoryId: current.repositoryId!, repository: current.repository!,
		sourceRevision: current.sourceRevision!,
		policySha256: current.policySha256!, model: current.model!, profileId,
	}
}

function budgetTotals(): Omit<FleetRepositoryBudgetSnapshot,
	"repositoryCampaignId" | "repositoryId" | "repository" |
	"sourceRevision" | "policySha256" | "model" | "profileId"> {
	return {
		mode: "fleet-v2-readonly", available: false, snapshotOnly: true,
		limitMicros: 20_000, limitTokens: 108_000,
		committedMicros: 493, committedTokens: 6_064, asOfMs: now,
		campaignId: "fleet-security-watch", globalEnabled: true,
		canAdmit: true, controlEpoch: 3, runId: null, runExpiresAtMs: null,
		repositoryEnabled: true, repositoryEpoch: 1,
		monthly: { month: "2026-10", limitMicros: 5_000_000,
			settledMicros: 493, reservedMicros: 0, ambiguousMicros: 0 },
		campaignLifetime: lifetime, legacyLifetime: zero,
		repositoryLifetime: lifetime,
	}
}

function progress(
	current: RepositoryCampaignDefinition,
	fleetBudget: FleetRepositoryBudgetSnapshot,
): ReturnType<typeof repositoryProgressSnapshot> {
	return repositoryProgressSnapshot(current, { state: "waiting" }, [], now,
		{ fleetBudget })
}

test("progress binds budget to the inference profile", () => {
	const result = progress(definition, budget(definition,
		"muse-spark-contributor"))
	assert.equal(result.budget.state, "measured")
	assert.equal(result.budget.global.committedTokens, 6_064)
	assert.equal(result.budget.repository.profileId, "muse-spark-contributor")
})

test("worker profile cannot substitute for the provider ledger profile", () => {
	const result = progress(definition, budget(definition,
		definition.workerProfile!))
	assert.equal(result.budget.state, "unavailable")
})

test("no-model repair progress displays read-only and active budget snapshots",
	() => {
		const snapshot = budget(repair, "no-model")
		assert.equal(progress(repair, snapshot).budget.state, "measured")
		const active: FleetRepositoryBudgetSnapshot = {
			...snapshot, mode: "fleet-v2-budget-only",
			runId: "active-run", runExpiresAtMs: now + 60_000,
		}
		assert.equal(progress(repair, active).budget.state, "measured")
		active.runExpiresAtMs = now - 1
		assert.equal(progress(repair, active).budget.state, "unavailable")
	})

test("unknown budget modes and source changes stay unavailable", () => {
	const snapshot = budget(definition, "muse-spark-contributor")
	const unknown = { ...snapshot, mode: "forged" } as unknown as
		FleetRepositoryBudgetSnapshot
	assert.equal(progress(definition, unknown).budget.state, "unavailable")
	const changed = { ...snapshot, sourceRevision: "f".repeat(40) }
	assert.equal(progress(definition, changed).budget.state, "unavailable")
})
