import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { createCheckpointService } from "../service.js"

const scratchRoot = path.join(process.cwd(), ".headlesscode", "scratch")

async function checkpointOperationsKeepApprovedGitEnvironment(): Promise<void> {
	await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 })
	const root = await fs.mkdtemp(path.join(scratchRoot, "checkpoint-ca-env-"))
	const workspaceRoot = path.join(root, "workspace")
	const checkpointDir = path.join(root, "checkpoint-store")
	await fs.mkdir(workspaceRoot)
	await fs.mkdir(checkpointDir)
	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "baseline\n")
	const caBundle = path.join(root, "custom-ca.pem")
	await fs.writeFile(caBundle, "local-test-ca-bundle\n")
	const originalCaInfo = process.env.GIT_SSL_CAINFO
	const originalConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM
	const originalConfigGlobal = process.env.GIT_CONFIG_GLOBAL
	process.env.GIT_SSL_CAINFO = caBundle
	process.env.GIT_CONFIG_NOSYSTEM = "1"
	process.env.GIT_CONFIG_GLOBAL = "/dev/null"
	try {
		const service = createCheckpointService({ taskId: "tls-ca-env", workspaceRoot, checkpointDir })
		const initialized = await service.init()
		assert.equal(initialized.created, true, "checkpoint baseline initializes with both approved Git environment values configured")

		await fs.writeFile(path.join(workspaceRoot, "b.txt"), "checkpoint\n")
		const saved = await service.save("save with configured TLS CA")
		assert.ok(saved?.commit, "checkpoint save succeeds with both approved Git environment values configured")
		assert.equal((await service.list()).length, 2, "baseline and saved checkpoint are both present")
		assert.equal(process.env.GIT_SSL_CAINFO, caBundle, "the caller's certificate configuration remains unchanged")
		assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1", "the caller's system-config setting remains unchanged")
	} finally {
		if (originalCaInfo === undefined) delete process.env.GIT_SSL_CAINFO
		else process.env.GIT_SSL_CAINFO = originalCaInfo
		if (originalConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
		else process.env.GIT_CONFIG_NOSYSTEM = originalConfigNoSystem
		if (originalConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
		else process.env.GIT_CONFIG_GLOBAL = originalConfigGlobal
		await fs.rm(root, { recursive: true, force: true })
	}
}

await checkpointOperationsKeepApprovedGitEnvironment()
console.log("All checkpoint Git environment tests passed")
