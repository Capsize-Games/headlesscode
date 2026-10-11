import assert from "node:assert/strict"
import test from "node:test"
import { formatCandidate } from "../reports.js"
import type { CandidateRecord } from "../types.js"

test("candidate report includes authenticated broker-denial summary from its receipt", () => {
	const candidate = {
		id: "candidate-1", status: "accepted", model: "deepseek/deepseek-v4-flash-0731", modelProvider: "openshell-openrouter",
		inferenceUsage: {
			provider: "openrouter", endpointProvider: "deepinfra", model: "deepseek/deepseek-v4-flash-0731", returnedModels: ["deepseek/deepseek-v4-flash-0731"],
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

test("candidate report preserves the exact executed harness and source snapshot identity", () => {
	const candidate = {
		id: "candidate-self-hosted",
		status: "accepted",
		workerHarnessExecution: {
			mode: "self-hosted",
			parentCommit: "a".repeat(40),
			snapshotCommit: "b".repeat(40),
			snapshotTreeDigest: "c".repeat(64),
			runtime: {
				imageName: "headlesscode-openshell-rsi:release",
				imageDigest: `sha256:${"d".repeat(64)}`,
				harnessCommit: "e".repeat(40),
				dependencyLockDigest: "f".repeat(64),
			},
			executedCliPath: "/workspace/src/cli.ts",
		},
	} as unknown as CandidateRecord
	const report = formatCandidate(candidate)
	assert.match(report, /harness=self-hosted/)
	assert.match(report, /parent=a{40}/)
	assert.match(report, /snapshot=b{40}\/c{64}/)
	assert.match(report, /image=sha256:d{64}/)
	assert.match(report, /commit=e{40}/)
	assert.match(report, /lock=f{64}/)
	assert.match(report, /cli=\/workspace\/src\/cli\.ts/)
})
