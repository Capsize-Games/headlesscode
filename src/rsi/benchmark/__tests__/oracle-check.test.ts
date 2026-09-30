import assert from "node:assert/strict"
import * as path from "node:path"
import { loadBenchmark } from "../runner.js"
import { verifyBenchmarkOracles } from "../oracle-check.js"
import { classifyOracleChild, ORACLE_INFRASTRUCTURE_EXIT } from "../oracle-process.mjs"
import type { BenchmarkVerifier } from "../runner.js"

const loaded = await loadBenchmark(path.resolve("fixtures/rsi-benchmark/smoke"))
const oneTask = { ...loaded, manifest: { ...loaded.manifest, tasks: [loaded.manifest.tasks[0]!] } }
let calls = 0
const infrastructureVerifier: BenchmarkVerifier = {
	async run() {
		calls += 1
		throw new Error("OpenShell verifier guest launch failed")
	},
}
await assert.rejects(verifyBenchmarkOracles(oneTask, infrastructureVerifier), /OpenShell verifier guest launch failed/)
assert.equal(calls, 1, "verifier infrastructure failure must abort the pair before known-bad is run")

calls = 0
const failedGoodVerifier: BenchmarkVerifier = {
	async run() {
		calls += 1
		return { success: false, output: "missing tsx runtime" }
	},
}
await assert.rejects(verifyBenchmarkOracles(oneTask, failedGoodVerifier), /known-good verifier failed; refusing to qualify the pair/)
assert.equal(calls, 1, "a failed known-good result must never count as known-bad rejection")

calls = 0
const timedOutKnownBadVerifier: BenchmarkVerifier = {
	async run() {
		calls += 1
		if (calls === 1) return { success: true, output: "known-good passed" }
		throw new Error("known-bad historical test child timed out (ETIMEDOUT)")
	},
}
await assert.rejects(verifyBenchmarkOracles(oneTask, timedOutKnownBadVerifier), /timed out \(ETIMEDOUT\)/)
assert.equal(calls, 2, "a known-bad child timeout must abort qualification rather than count as rejection")

assert.equal(classifyOracleChild({ status: null, error: { code: "ETIMEDOUT" }, signal: "SIGTERM" }), "infrastructure-failure")
assert.equal(classifyOracleChild({ status: ORACLE_INFRASTRUCTURE_EXIT }), "infrastructure-failure")
assert.equal(classifyOracleChild({ status: 1 }), "test-failure")
assert.equal(classifyOracleChild({ status: 0 }), "pass")

console.log("Oracle qualification aborts on verifier infrastructure or known-good failure")
