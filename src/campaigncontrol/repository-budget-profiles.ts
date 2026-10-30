import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type { FleetRepositoryBudgetScope } from
	"../rsi/fleet-repository-budget-ledger.js"
import * as v1 from "./repository-curl-repair.js"
import * as v2 from "./repository-curl-repair-v2-profile.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "./repository-campaign-ids.js"

type PinKey = "id" | "repositoryId" | "repository" | "sourceRevision" |
	"policySha256" | "workerProfile" | "recipeDigest" | "evaluatorDigest" |
	"model"
type DefinitionPin = Required<Pick<RepositoryCampaignDefinition, PinKey>>
type BudgetProfile = Pick<FleetRepositoryBudgetScope, "model" | "profileId">

const NO_MODEL_PINS: readonly DefinitionPin[] = [{
	id: v1.CURL_REPAIR_CAMPAIGN_ID,
	repositoryId: v1.CURL_REPAIR_REPOSITORY_ID,
	repository: v1.CURL_REPAIR_TARGET_REPOSITORY,
	sourceRevision: v1.CURL_REPAIR_SOURCE_REVISION,
	policySha256: v1.CURL_REPAIR_POLICY_SHA256,
	workerProfile: v1.CURL_REPAIR_PROFILE_ID,
	recipeDigest: v1.CURL_REPAIR_RECIPE_DIGEST,
	evaluatorDigest: v1.CURL_REPAIR_EVALUATOR_DIGEST,
	model: "none",
}, {
	id: CURL_REPAIR_V2_CAMPAIGN_ID,
	repositoryId: v2.CURL_REPAIR_V2_REPOSITORY_ID,
	repository: v2.CURL_REPAIR_V2_TARGET_REPOSITORY,
	sourceRevision: v2.CURL_REPAIR_V2_SOURCE_REVISION,
	policySha256: v2.CURL_REPAIR_V2_POLICY_SHA256,
	workerProfile: v2.CURL_REPAIR_V2_PROFILE_ID,
	recipeDigest: v2.CURL_REPAIR_V2_RECIPE_DIGEST,
	evaluatorDigest: v2.CURL_REPAIR_V2_EVALUATOR_DIGEST,
	model: "none",
}]

export function repositoryBudgetProfile(
	definition: RepositoryCampaignDefinition,
): BudgetProfile | undefined {
	const pin = NO_MODEL_PINS.find((item) => item.id === definition.id)
	if (pin) return matchesPin(definition, pin)
		? { model: "none", profileId: "no-model" } : undefined
	return definition.model === "meta/muse-spark-1.3-contributor"
		? { model: definition.model, profileId: "muse-spark-contributor" }
		: undefined
}

function matchesPin(
	definition: RepositoryCampaignDefinition,
	pin: DefinitionPin,
): boolean {
	return Object.entries(pin).every(([key, value]) =>
		definition[key as PinKey] === value)
}
