import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { main } from "../../cli.js"
import { workLoopMain } from "../work-loop-cli.js"

test("public CLI dispatches work-loop help through the protected host entrypoint", async () => {
	let stdout = ""; let stderr = ""
	assert.equal(await main(["work-loop", "--help"], { stdout: { write: (value) => { stdout += value } }, stderr: { write: (value) => { stderr += value } } }), 0)
	assert.match(stdout, /trusted host code/)
	assert.equal(stderr, "")
})
test("CLI runs a trusted driver and emits the settled stopping reason", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "hc-work-loop-cli-"))
	try {
		const commit = "a".repeat(40)
		const config = { tasks: [{ id: "fixture", prompt: "fix" }], harness: { commit, runtimeId: "fixture-runtime" }, ledgerPath: path.join(root, "ledger"), maxTasks: 1, maxTaskAttempts: 1, maxRepairs: 1, maxRepairAttempts: 1, maxRuntimeMs: 1000, maxSpendUsd: 1 }
		const configPath = path.join(root, "config.json"); const driverPath = path.join(root, "driver.mjs")
		await writeFile(configPath, JSON.stringify(config))
		await writeFile(driverPath, `export function createWorkLoopDriver(config) { return {
			runTask: async () => ({ candidate: { commit: config.harness.commit, workspace: ${JSON.stringify(root)} }, observations: [], costUsd: 0 }),
			verifyTask: async (_, candidate) => ({ passed: true, commit: candidate.commit, evidenceRef: 'fixture:independent-test' }),
			acceptTask: async () => {}
		} }`)
		let stdout = ""; let stderr = ""
		const before = process.listenerCount("SIGTERM")
		assert.equal(await workLoopMain(["--config", configPath, "--driver", driverPath], { stdout: { write: (value) => { stdout += value } }, stderr: { write: (value) => { stderr += value } } }), 0)
		assert.equal(JSON.parse(stdout).reason, "queue-complete")
		assert.deepEqual(JSON.parse(stdout).completedTasks, ["fixture"])
		assert.equal(stderr, "")
		assert.equal(process.listenerCount("SIGTERM"), before)
	} finally { await rm(root, { recursive: true, force: true }) }
})
test("CLI rejects missing, duplicate, and unknown options without importing a driver", async () => {
	const io = { stdout: { write: (_value: string) => {} }, stderr: { write: (_value: string) => {} } }
	assert.equal(await workLoopMain([], io), 2)
	assert.equal(await workLoopMain(["--config", "a", "--config", "b"], io), 2)
	assert.equal(await workLoopMain(["--unexpected", "x"], io), 2)
})
