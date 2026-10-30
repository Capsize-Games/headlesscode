import { CURL_FIXED_ADVISORY } from "../repository-curl-evaluator.js"
import type {
	CurlRepairClaim,
	CurlRepairPullRequest,
} from "../repository-curl-repair-delivery.js"

export const repo = "Capsize-Games/curl-maintenance"
export const branch = "reviewed-source-ce573393"
export const jobId = "repair-delivery-fixture"
export const claim: CurlRepairClaim = {
	claimId: "11111111-1111-4111-8111-111111111111",
	epoch: 4,
	job: {
		id: jobId,
		campaignId: "curl-historical-repair",
		advisoryId: CURL_FIXED_ADVISORY,
		status: "running",
		epoch: 4,
		createdAt: 1,
		updatedAt: 1,
		month: "2026-10",
		reservedMicros: 1,
		settledMicros: 0,
		reservedTokens: 1,
		settledTokens: 0,
	},
}

export type FixtureState = {
	calls: string[]
	created: { branch: string; title: string; body: string }[]
	pushed: boolean
	persistedPull?: CurlRepairPullRequest
}
