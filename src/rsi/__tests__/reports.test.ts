import assert from "node:assert/strict"
import test from "node:test"
import { formatCandidate } from "../reports.js"
import type { CandidateRecord } from "../types.js"

test("candidate report includes authenticated broker-denial summary from its receipt", () => {
	const candidate = {
		id: "candidate-1", status: "accepted", model: "deepseek/deepseek-v4-flash-0731", modelProvider: "openshell-openrouter",
		inferenceUsage: {
			provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731", returnedModels: ["deepseek/deepseek-v4-flash-0731"],
			calls: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12, costUsd: 0.000012,
			accounting: "supervisor-enforced", qualified: true, jobId: "job-1", campaignId: "campaign-1",
			denials: [{ statusCode: 429, reason: "budget-or-fence", count: 2 }],
		},
	} as unknown as CandidateRecord
	assert.match(formatCandidate(candidate), /denials=429:budget-or-fence=2/)
})

test("failed unqualified OpenRouter mutation report retains only denial categories", () => {
	const candidate = {
		id: "candidate-failed", status: "failed", model: "deepseek/deepseek-v4-flash-0731", modelProvider: "openshell-openrouter",
		inferenceDenials: [{ statusCode: 413, reason: "request-size-limit", count: 1 }],
	} as unknown as CandidateRecord
	assert.match(formatCandidate(candidate), /usage=unmeasured denials=413:request-size-limit=1/)
})
