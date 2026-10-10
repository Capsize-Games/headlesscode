import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

import { UnixEvidenceJournal } from "../../evidence/collector.js"
import { evidenceJournalFromProtectedConfigFile } from "../../evidence/index.js"
import { loadContainedSupervisorRuntime } from "../supervisor.js"
import { startContainedEvidenceService } from "../contained-evidence-service.js"
import { startContainedSupervisor } from "../supervisor.js"
import { controlMain } from "../../control/cli.js"
import type { ContainedRuntimeProfile } from "../profile.js"

const scratch = path.join(process.cwd(), ".headlesscode", "scratch")
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 })

async function testProtectedPerSessionHandoffIsBoundAndRequired(): Promise<void> {
	const root = fs.mkdtempSync(path.join(scratch, "supervisor-config-"))
	const repo = path.join(root, "repo")
	const configDir = path.join(root, "runtime")
	const keyPath = path.join(root, "public.pem")
	const socketDirectory = path.join(root, "socket")
	fs.mkdirSync(socketDirectory, { mode: 0o700 })
	const socketPath = path.join(socketDirectory, "collector.sock")
	fs.mkdirSync(repo, { mode: 0o700 })
	fs.mkdirSync(configDir, { mode: 0o700 })
	const key = generateKeyPairSync("ed25519").publicKey
	const publicPem = key.export({ type: "spki", format: "pem" }).toString()
	const fingerprint = `sha256:${createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex")}`
	fs.writeFileSync(keyPath, publicPem, { mode: 0o400 })
	const socketServer = net.createServer((connection) => connection.end())
	await new Promise<void>((resolve, reject) => { socketServer.once("error", reject); socketServer.listen(socketPath, resolve) })
	const profile = {
		name: "contained", purpose: "worker", version: 1, profileSha256: "a".repeat(64), runtimeVersion: "openshell 0.1.2",
		gatewayIdentity: "gw", expectedGatewayIdentity: "gw", expectedEmergencyControllerIdentity: "control",
		policySha256: "b".repeat(64), policySnapshotPath: path.join(root, "policy.yaml"), image: `registry.test/worker@sha256:${"c".repeat(64)}`,
		cpu: "2", memory: "4Gi", providers: [], evidenceRequired: true, evidenceSocketPath: socketPath,
		evidenceGuestPath: "/run/headlesscode/evidence.sock", evidencePublicKeyPath: keyPath,
		evidenceGuestPublicKeyPath: "/etc/headlesscode/collector.pem", evidencePublicKeyFingerprint: fingerprint,
		allowedGuestEnv: [], policySnapshotDir: path.join(root, "policy"),
	} as unknown as ContainedRuntimeProfile
	const configPath = path.join(configDir, "s.json")
	fs.writeFileSync(configPath, JSON.stringify({ sessionId: "s", socketPath, capability: "A".repeat(43), pinnedPublicKey: { keyId: fingerprint, publicKeyPem: publicPem } }), { mode: 0o400 })
	const loaded = loadContainedSupervisorRuntime({ profile, sessionId: "s", repoRoot: repo, workspaceRoot: repo, env: { HEADLESSCODE_CONTAINED_EVIDENCE_CONFIG_DIR: configDir } })
	assert.equal(loaded.evidence.sessionId, "s")
	assert.equal(loaded.evidence.evidenceRequired, true, "required defaults true in a protected runtime config")
	assert.equal(loaded.evidenceConnection.capability, "A".repeat(43))
	const guestRuntime = await evidenceJournalFromProtectedConfigFile(configPath, { expectedSessionId: "s", forbiddenRoots: [repo] })
	assert.equal(guestRuntime.evidenceRequired, true, "read-only runtime file defaults evidenceRequired to true")
	await assert.rejects(() => evidenceJournalFromProtectedConfigFile(configPath, { expectedSessionId: "other-session" }), /does not match/)
	await assert.rejects(() => evidenceJournalFromProtectedConfigFile(configPath, { forbiddenRoots: [configDir] }), /outside worker-writable paths/)
	const originalConfig = fs.readFileSync(configPath, "utf8")
	fs.chmodSync(configPath, 0o600)
	fs.writeFileSync(configPath, JSON.stringify({ sessionId: "s", socketPath, capability: "A".repeat(43), pinnedPublicKey: { keyId: fingerprint, publicKeyPem: publicPem }, privateSigningKey: "forbidden" }), { mode: 0o400 })
	fs.chmodSync(configPath, 0o400)
	await assert.rejects(() => evidenceJournalFromProtectedConfigFile(configPath), /unrecognized fields/)
	fs.chmodSync(configPath, 0o600)
	fs.writeFileSync(configPath, originalConfig, { mode: 0o400 })
	fs.chmodSync(configPath, 0o400)
	const stateDir = path.join(root, "control-state")
	const socketDir = path.join(root, "control-sockets")
	fs.mkdirSync(stateDir, { mode: 0o700 })
	fs.mkdirSync(socketDir, { mode: 0o700 })
	const supervisorEnv = {
		HEADLESSCODE_CONTAINED_EVIDENCE_CONFIG_DIR: configDir,
		HEADLESSCODE_CONTROL_STATE_DIR: stateDir,
		HEADLESSCODE_CONTROL_SOCKET_DIR: path.join(process.cwd(), ".headlesscode", "{session}"),
	}
	const running = await startContainedSupervisor({ profile, sessionId: "s", repoRoot: repo, workspaceRoot: repo, env: supervisorEnv })
	const oldSignal = running.control.signal
	assert.equal(running.control.identity, profile.expectedEmergencyControllerIdentity)
	await running.control.command("pause", "CPU test pause")
	assert.equal(oldSignal.aborted, true)
	await running.close()
	await assert.rejects(() => startContainedSupervisor({ profile, sessionId: "s", repoRoot: repo, workspaceRoot: repo, env: supervisorEnv }), /pause/)
	assert.equal(await controlMain([profile.expectedEmergencyControllerIdentity, "resume", "--session", "s"], supervisorEnv), 0, "explicit operator resume clears persisted pause state")
	const resumed = await startContainedSupervisor({ profile, sessionId: "s", repoRoot: repo, workspaceRoot: repo, env: supervisorEnv })
	assert.equal(resumed.control.signal.aborted, false, "a fresh controller starts with a fresh signal after explicit resume")
	assert.equal(oldSignal.aborted, true, "resume never revives the signal captured by the paused session")
	await resumed.close()
	assert.throws(() => loadContainedSupervisorRuntime({ profile, sessionId: "worker-b", repoRoot: repo, workspaceRoot: repo, env: { HEADLESSCODE_CONTAINED_EVIDENCE_CONFIG_DIR: configDir } }), /ENOENT/)
	fs.chmodSync(configPath, 0o644)
	assert.throws(() => loadContainedSupervisorRuntime({ profile, sessionId: "s", repoRoot: repo, workspaceRoot: repo, env: { HEADLESSCODE_CONTAINED_EVIDENCE_CONFIG_DIR: configDir } }), /private regular file/)
	await new Promise<void>((resolve) => socketServer.close(() => resolve()))
	fs.rmSync(path.join(process.cwd(), ".headlesscode", "s"), { recursive: true, force: true })
	fs.rmSync(root, { recursive: true, force: true })
}

async function testContainedEvidenceServiceProvisionsDistinctWorkerCapabilities(): Promise<void> {
	const root = fs.mkdtempSync(path.join(scratch, "supervisor-service-"))
	const repo = path.join(root, "repo")
	const storageDir = path.join(root, "collector")
	const configDirectory = path.join(root, "runtime")
	const socketPath = path.join(scratch, "es.sock")
	fs.rmSync(socketPath, { force: true })
	fs.mkdirSync(repo, { mode: 0o700 })
	const service = await startContainedEvidenceService({ storageDir, configDirectory, socketPath, sessionIds: ["worker-a", "worker-b"], repoRoot: repo })
	try {
		assert.deepEqual(service.sessions, ["worker-a", "worker-b"])
		const first = JSON.parse(fs.readFileSync(path.join(configDirectory, "worker-a.json"), "utf8")) as { capability: string; evidenceRequired: boolean; pinnedPublicKey: { keyId: string } }
		const second = JSON.parse(fs.readFileSync(path.join(configDirectory, "worker-b.json"), "utf8")) as { capability: string }
		assert.notEqual(first.capability, second.capability, "worker capabilities are individually scoped")
		assert.equal(first.evidenceRequired, true)
		assert.equal(fs.statSync(path.join(configDirectory, "worker-a.json")).mode & 0o777, 0o400)
		const journal = new UnixEvidenceJournal({ sessionId: "worker-a", capability: first.capability, pinnedPublicKey: service.collector.publicKey, socketPath })
		await journal.append({ sessionId: "worker-a", requestId: "test_append_1", kind: "test", actor: "worker", origin: "cpu-test", payload: { ok: true } })
		const bundle = await service.collector.exportBundle("worker-a")
		assert.equal(bundle.records.length, 1)
		assert.equal(bundle.publicKey.keyId, first.pinnedPublicKey.keyId)
		assert.ok(fs.existsSync(path.join(storageDir, "ed25519-private.pem")), "signing key remains in supervisor storage")
	} finally {
		await service.close()
	}
	assert.ok(!fs.existsSync(path.join(configDirectory, "worker-a.json")), "closing service removes runtime capability handoffs")
	assert.ok(!fs.existsSync(socketPath), "closing service removes its Unix socket")
	fs.rmSync(root, { recursive: true, force: true })
}

await testProtectedPerSessionHandoffIsBoundAndRequired()
await testContainedEvidenceServiceProvisionsDistinctWorkerCapabilities()
console.log("Contained supervisor tests passed")
