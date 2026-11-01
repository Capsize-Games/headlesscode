import assert from "node:assert/strict"
import { test } from "node:test"
import { repositoryBudgetProfile } from "../repository-budget-authority.js"
import {
	makeCurlRepairV2Definition,
} from "./curl-repair-v2-campaign-fixture.js"

test("only the exact compiled v2 identity selects a no-model budget", () => {
	const definition = makeCurlRepairV2Definition()
	assert.deepEqual(repositoryBudgetProfile(definition), {
		model: "none", profileId: "no-model",
	})
	const wrongPolicy = { ...definition, policySha256: "f".repeat(64) }
	assert.equal(repositoryBudgetProfile(wrongPolicy), undefined)
	const paid = { ...definition, model: "meta/muse-spark-1.3-contributor" }
	assert.equal(repositoryBudgetProfile(paid), undefined)
	const wrongProfile = { ...definition, workerProfile: "other" }
	assert.equal(repositoryBudgetProfile(wrongProfile), undefined)
})
