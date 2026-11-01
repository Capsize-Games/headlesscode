import type { RepositoryCampaignDefinition } from "./repository-campaigns.js"
import type { FleetRepositoryBudgetScope } from
	"../rsi/fleet-repository-budget-ledger.js"
import { CURL_PRIVATE_SOURCE_REVISION } from "./repository-curl-evaluator.js"
import { CURL_CAMPAIGN_POLICY_SHA256, MODEL, PROFILE_ID } from
	"./repository-curl-profile.js"
import { sha256 } from "./repository-curl-source.js"

export function makeRepositoryBudgetScope(definition:
	RepositoryCampaignDefinition,
	repositoryEpoch: number): FleetRepositoryBudgetScope {
	return {
		repositoryCampaignId: definition.id,
		repositoryId: definition.repositoryId!, repository: definition.repository!,
		sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
			policySha256: CURL_CAMPAIGN_POLICY_SHA256,
		model: MODEL, profileId: PROFILE_ID, repositoryEpoch,
	}
}

export function assertWorkerCredential(credential: { apiKey: string;
	keyIdentity:
	string },
	expectedKeyIdentity: string): void {
	if (!/^[a-f0-9]{64}$/.test(expectedKeyIdentity) ||
		credential.keyIdentity !== expectedKeyIdentity ||
			sha256(credential.apiKey) !== expectedKeyIdentity) {
		throw new Error("selected host credential does not match Fleet v2 identity")
	}
}
