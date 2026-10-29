import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { snapshotRepositoryBrokerCapability } from "../../cloud/openshell-provider.js"
import { REPOSITORY_WORKER_BROKER_URL, REPOSITORY_WORKER_COMMAND, runContainedRepositoryWorker, writeRepositoryBrokerCapability, writeRepositoryWorkerTask } from "../repository-worker.js"
import type { ContainedRuntimeProfile } from "../../security/profile.js"

async function withTempDir(fn: (root: string) => Promise<void> | void): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "hcl-repository-worker-"))
	try { fs.chmodSync(root, 0o700); await fn(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

const capability = Buffer.alloc(32, 7).toString("base64url")

const tests: Array<[string, () => Promise<void>]> = [
	["stores the per-job broker capability in a private file, never command or environment text", async () => withTempDir((root) => {
		const file = writeRepositoryBrokerCapability(root, capability)
		assert.equal(fs.statSync(file).mode & 0o777, 0o600)
		assert.equal(fs.readFileSync(file, "utf8").trim(), capability)
		assert.equal(REPOSITORY_WORKER_COMMAND.includes(capability), false)
		assert.equal(REPOSITORY_WORKER_COMMAND.includes("OPENROUTER_API_KEY=\"$(cat /run/headlesscode/repository-broker-capability)\""), true)
		assert.equal(REPOSITORY_WORKER_COMMAND.includes("OPENROUTER_BASE_URL="), false)
		assert.equal(REPOSITORY_WORKER_BROKER_URL, "http://host.openshell.internal:4392")
	})],
	["rejects malformed capabilities and non-private directories", async () => withTempDir((root) => {
		assert.throws(() => writeRepositoryBrokerCapability(root, "bad"), /malformed/)
		const permissive = path.join(root, "permissive"); fs.mkdirSync(permissive, { mode: 0o755 }); fs.chmodSync(permissive, 0o755)
		assert.throws(() => writeRepositoryBrokerCapability(permissive, capability), /owner-only/)
	})],
	["writes only bounded, source-linked advisory facts and returns an immutable task digest", async () => withTempDir((root) => {
		const digest = writeRepositoryWorkerTask(root, { advisoryId: "CVE-2026-1024", sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1024",
			snapshotSha256: "a".repeat(64), summary: "A parser boundary issue.", affectedRange: "before 2.4.0", fixedVersion: "2.4.0" }, "b".repeat(40))
		const task = fs.readFileSync(path.join(root, "ORCHESTRATOR_TASK.md"), "utf8")
		assert.equal(digest.length, 64)
		assert.match(task, /untrusted source data/)
		assert.match(task, /CVE-2026-1024/)
		assert.equal(fs.statSync(path.join(root, "ORCHESTRATOR_TASK.md")).mode & 0o777, 0o600)
		assert.throws(() => writeRepositoryWorkerTask(root, { advisoryId: "CVE-2026-1024", sourceUrl: "https://example.com/x",
			snapshotSha256: "a".repeat(64), summary: "x", affectedRange: "", fixedVersion: null }, "b".repeat(40)), /approved source set/)
		assert.throws(() => writeRepositoryWorkerTask(root, { advisoryId: "CVE-2026-1024", sourceUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-1024",
			snapshotSha256: "a".repeat(64), summary: "x", affectedRange: "", fixedVersion: null }, "b".repeat(40)), /EEXIST/)
	})],
	["snapshots a broker capability read-only and rejects unprotected or malformed sources", async () => withTempDir((root) => {
		const source = writeRepositoryBrokerCapability(root, capability)
		const protectedDir = path.join(root, "protected"); fs.mkdirSync(protectedDir, { mode: 0o700 }); fs.chmodSync(protectedDir, 0o700)
		const destination = path.join(protectedDir, "mounted-token")
		snapshotRepositoryBrokerCapability(source, destination, [protectedDir])
		assert.equal(fs.statSync(destination).mode & 0o777, 0o400)
		assert.equal(fs.readFileSync(destination, "utf8").trim(), capability)
		assert.throws(() => snapshotRepositoryBrokerCapability(source, path.join(protectedDir, "rejected"), [root]), /outside the worktree/)
	})],
	["refuses a normal credential-bearing worker profile before launch", async () => withTempDir(async (root) => {
		const profile = { purpose: "worker", providers: ["headlesscode-openrouter"], inferenceEndpoint: { host: "openrouter.ai", port: 443 } } as unknown as ContainedRuntimeProfile
		await assert.rejects(runContainedRepositoryWorker({ repoRoot: root, worktree: root, profile, model: "fixture/model", capabilityFile: path.join(root, "cap"), taskSha256: "a".repeat(64) }), /fixed profile/)
	})],
]

for (const [name, run] of tests) {
	await run()
	console.log(`  ok   ${name}`)
}
console.log(`All ${tests.length} repository-worker tests passed`)
