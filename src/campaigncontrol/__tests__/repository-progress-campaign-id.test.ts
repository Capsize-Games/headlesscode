import assert from "node:assert/strict"
import { test } from "node:test"
import { repositoryProgressSnapshot } from "../repository-progress.js"
import type { RepositoryCampaignDefinition } from "../repository-campaigns.js"

test("progress response carries the exact registered campaign identity", () => {
	const definition: RepositoryCampaignDefinition = { id: "curl-maintenance", name: "Curl maintenance",
		repositoryId: "curl-maintenance", repository: "Capsize-Games/curl-maintenance", sourceRevision: "a".repeat(40),
		policySha256: "b".repeat(64), workerProfile: "curl-published-advisory-v1", recipeDigest: "c".repeat(64),
		evaluatorDigest: "d".repeat(64), model: "meta/muse-spark-1.3-contributor", dataAccessProfile: "fixed-test",
		qualification: { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
			modelApproved: true, dataApproved: true, accessApproved: true } }
	const snapshot = repositoryProgressSnapshot(definition, { id: definition.id, enabled: false, state: "stopped" }, [], Date.now())
	assert.equal(snapshot.campaignId, definition.id)
})
