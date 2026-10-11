import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

const fixtureRoot = path.resolve("fixtures/rsi-benchmark")
const manifest = JSON.parse(await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8")) as { tasks: Array<{ id: string; verifierPath: string }> }
const task = manifest.tasks.find((entry) => entry.id === "artifact-deferral-bound")!
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-generated-verifier-timeout-"))
const verifierWorkspace = path.join(tempRoot, "workspace")
const hangingRuntime = path.join(tempRoot, "hang.mjs")
const previousRuntime = process.env.HEADLESSCODE_BENCHMARK_TSX
try {
	await fs.mkdir(verifierWorkspace)
	await fs.writeFile(hangingRuntime, "await new Promise((resolve) => setTimeout(resolve, 1_000))\n")
	process.env.HEADLESSCODE_BENCHMARK_TSX = hangingRuntime
	const result = spawnSync(process.execPath, [path.join(fixtureRoot, task.verifierPath), verifierWorkspace, task.id, "10"], { encoding: "utf8", timeout: 5000 })
	assert.equal(result.status, 125, `timed out child should return infrastructure exit code 125; stderr=${result.stderr}`)
	assert.equal(result.error, undefined)
	assert.match(result.stderr, /RSI_BENCHMARK_VERIFIER_INFRA_FAILURE:ETIMEDOUT/)
	assert.doesNotMatch(result.stdout + result.stderr, /historical independent regression checks passed/)
	console.log("Generated historical verifier classifies a child timeout as infrastructure failure")
} finally {
	if (previousRuntime === undefined) delete process.env.HEADLESSCODE_BENCHMARK_TSX
	else process.env.HEADLESSCODE_BENCHMARK_TSX = previousRuntime
	await fs.rm(tempRoot, { recursive: true, force: true })
}
