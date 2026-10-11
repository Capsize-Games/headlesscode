import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { acquireRunnerPoolLock } from "../cli.js"
import { buildWorkerSpawnEnvironment, type SpawnBatch } from "../watch.js"

const batch: SpawnBatch = {
	issue: { number: 1, title: "synthetic", labels: [] },
	specs: [],
	repoRoot: "/synthetic/repo",
	batch: "watcher-test",
	executor: "builtin",
}

const poolCredentials: NodeJS.ProcessEnv = {
	GH_TOKEN: "supervisor-token",
	GITHUB_TOKEN: "compat-token",
	GH_ENTERPRISE_TOKEN: "enterprise-token",
	GITHUB_ENTERPRISE_TOKEN: "enterprise-compat-token",
	GITHUB_APP_ID: "1234",
	GITHUB_APP_PRIVATE_KEY: "synthetic-private-key",
	GITHUB_APP_PRIVATE_KEY_PATH: "/synthetic/key.pem",
	GITHUB_APP_INSTALLATION_ID: "4567",
	OPENROUTER_API_KEY: "worker-provider-key",
	HEADLESSCODE_EXECUTION_PROVIDER: "local",
}

const poolEnv = buildWorkerSpawnEnvironment(batch, { runnerId: "workstation", mode: "code" }, poolCredentials)
for (const name of [
	"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
	"GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY_PATH", "GITHUB_APP_INSTALLATION_ID",
]) {
	assert.equal(poolEnv[name], undefined, `${name} must not cross the runner-pool worker boundary`)
}
assert.equal(poolEnv.OPENROUTER_API_KEY, "worker-provider-key", "provider credentials are needed by the worker and are outside this GitHub auth boundary")
assert.equal(poolEnv.TARGET_REPO, "/synthetic/repo")

const ordinaryEnv = buildWorkerSpawnEnvironment(batch, { mode: "code" }, poolCredentials)
assert.equal(ordinaryEnv.GH_TOKEN, "supervisor-token", "non-pool behavior remains compatible")
assert.equal(ordinaryEnv.GITHUB_APP_PRIVATE_KEY, "synthetic-private-key")

const scratch = path.join(process.cwd(), ".headlesscode", "scratch", "runner-pool-lock-test")
await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
const stateHome = await fs.mkdtemp(path.join(scratch, "state-"))
const firstLock = await acquireRunnerPoolLock(stateHome, "workstation")
await assert.rejects(acquireRunnerPoolLock(stateHome, "alternate-id"), /runner-pool watcher already has a lock/)
await fs.rm(firstLock)
const secondLock = await acquireRunnerPoolLock(stateHome, "alternate-id")
await fs.rm(secondLock)
await fs.rm(stateHome, { recursive: true, force: true })

process.stdout.write("watcher spawn environment tests passed\n")
