import type { RepositoryCampaignDefinition } from "../repository-campaigns.js"
import {
	CURL_REPAIR_V2_EVALUATOR_DIGEST,
	CURL_REPAIR_V2_MODEL,
	CURL_REPAIR_V2_POLICY_SHA256,
	CURL_REPAIR_V2_PROFILE_ID,
	CURL_REPAIR_V2_RECIPE_DIGEST,
	CURL_REPAIR_V2_REPOSITORY_ID,
	CURL_REPAIR_V2_SOURCE_REVISION,
	CURL_REPAIR_V2_TARGET_REPOSITORY,
} from "../repository-curl-repair-v2-profile.js"
import { CURL_REPAIR_V2_CAMPAIGN_ID } from "../repository-campaign-ids.js"

export function makeCurlRepairV2Definition(): RepositoryCampaignDefinition {
	return {
		id: CURL_REPAIR_V2_CAMPAIGN_ID, name: "Historical Curl repair v2",
		repositoryId: CURL_REPAIR_V2_REPOSITORY_ID,
		repository: CURL_REPAIR_V2_TARGET_REPOSITORY,
		sourceRevision: CURL_REPAIR_V2_SOURCE_REVISION,
		policySha256: CURL_REPAIR_V2_POLICY_SHA256,
		workerProfile: CURL_REPAIR_V2_PROFILE_ID,
		recipeDigest: CURL_REPAIR_V2_RECIPE_DIGEST,
		evaluatorDigest: CURL_REPAIR_V2_EVALUATOR_DIGEST,
		model: CURL_REPAIR_V2_MODEL,
		dataAccessProfile: "public-source-and-published-advisory-only",
		qualification: {
			sourceAudited: true, workerQualified: true,
			recipeQualified: true, evaluatorQualified: true,
			modelApproved: true, dataApproved: true, accessApproved: true,
		},
	}
}
