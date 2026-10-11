import assert from "node:assert/strict"
import { runMutation } from "../mutation.js"
import type { CandidateRecord, RsiConfig } from "../types.js"

const candidate = { id: "candidate", generation: 0, model: "qwen" } as CandidateRecord
const config = {
	hiddenEvalCommands: ["scripts/eval-suite/hidden.sh"],
	roles: undefined,
	model: "qwen",
	maxIterations: 1,
	commandTimeoutMs: 1000,
	mutationTask: "task",
	regressionCommand: "npm test",
} as RsiConfig
const result = await runMutation(candidate, config)
assert.equal(result.ok, false)
assert.match(result.error ?? "", /hidden evaluations are disabled/)
console.log("All 3 RSI mutation assertions passed")
