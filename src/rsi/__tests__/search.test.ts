import assert from "node:assert/strict"
import { boundedSearchBudget, chooseComputePolicy } from "../search.js"

assert.equal(chooseComputePolicy({ taskLength: 100, priorFailures: 0, uncertainty: 0.1, repeatedFailure: false }).policy, "single")
assert.equal(chooseComputePolicy({ taskLength: 700, priorFailures: 0, uncertainty: 0.2, repeatedFailure: false }).attempts, 2)
assert.equal(chooseComputePolicy({ taskLength: 1500, priorFailures: 0, uncertainty: 0.9, repeatedFailure: false }).policy, "planner-executors")
assert.equal(chooseComputePolicy({ taskLength: 100, priorFailures: 2, uncertainty: 0.1, repeatedFailure: true }).policy, "critic-retry")
assert.equal(boundedSearchBudget({ policy: "independent", attempts: 2, criticAfterFailure: false, reason: "fixture" }, 5), 10)
console.log("All 5 RSI search assertions passed")
