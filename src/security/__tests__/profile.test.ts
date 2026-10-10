import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { assertEffectiveOpenShellPolicy, cleanupContainedRuntimeProfile, containedGuestEnvironment, loadResolvedContainedProfile, resolveContainedRuntimeProfile, serializeResolvedContainedProfile, verifyContainedPrerequisites } from "../profile.js"
import type { OpenShellProbe, OpenShellProbeResult } from "../profile.js"

const scratchRoot = path.join(process.cwd(), ".headlesscode", "scratch")
fs.mkdirSync(scratchRoot, { recursive: true })

interface Fixture {
	root: string
	repo: string
	profile: string
	policy: string
	key: string
	socket: string
	env: NodeJS.ProcessEnv
	server: net.Server
	policyText: string
	refreshProfile(): void
	close(): Promise<void>
}

async function fixture(overrides: { profile?: Record<string, unknown>; policy?: Record<string, unknown> } = {}): Promise<Fixture> {
	const root = fs.mkdtempSync(path.join(scratchRoot, "sp-"))
	const repo = path.join(root, "worker-repo")
	fs.mkdirSync(repo, { mode: 0o700 })
	const profile = path.join(root, "operator-profile.yaml")
	const policy = path.join(root, "operator-policy.yaml")
	const key = path.join(root, "collector-public.pem")
	const socket = path.join(root, "e.sock")
	const scratch = path.join(root, "openshell-scratch")
	fs.mkdirSync(scratch, { mode: 0o700 })
	const publicKey = generateKeyPairSync("ed25519").publicKey
	fs.writeFileSync(key, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 })
	const fingerprint = `sha256:${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")}`
	fs.rmSync(socket, { force: true })
	const socketDirectoryFd = fs.openSync(root, "r")
	const bindPath = process.platform === "linux" && Buffer.byteLength(socket) >= 108
		? `/proc/self/fd/${socketDirectoryFd}/e.sock`
		: socket
	const server = net.createServer((connection) => connection.end("ok"))
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen({ path: bindPath }, resolve)
	})
	assert.ok(fs.existsSync(socket), `fixture evidence socket did not bind: ${socket}; address=${JSON.stringify(server.address())}`)
	const policyValue: Record<string, unknown> = {
		version: 1,
		filesystem_policy: { include_workdir: false, read_only: ["/usr", "/lib", "/etc", "/opt/headlesscode", "/etc/headlesscode/collector.pem", "/run/headlesscode/evidence-runtime.json"], read_write: ["/tmp", "/workspace", "/result", "/run/headlesscode/evidence.sock"] },
		landlock: { compatibility: "hard_requirement" },
		process: { run_as_user: "sandbox", run_as_group: "sandbox" },
		network_policies: {
			inference: {
				endpoints: [{ host: "openrouter.ai", port: 443, protocol: "rest", enforcement: "enforce", access: "read-only" }],
				binaries: [{ path: "/usr/bin/node" }],
			},
		},
		...overrides.policy,
	}
	const policyText = yaml(policyValue)
	fs.writeFileSync(policy, policyText, { mode: 0o600 })
	const policyHash = createHash("sha256").update(policyText).digest("hex")
	const profileValue: Record<string, unknown> = {
		version: 1,
		profile: "contained",
		image: "registry.example/headlesscode@sha256:" + "a".repeat(64),
		policy: { path: "operator-policy.yaml", sha256: policyHash },
		resources: { cpu: "2", memory: "4Gi" },
		providers: ["headlesscode-openrouter"],
		inference: { host: "openrouter.ai", port: 443 },
		evidence: { transport: "unix", required: true, socketPath: socket, guestPath: "/run/headlesscode/evidence.sock", publicKeyPath: "collector-public.pem", publicKeyGuestPath: "/etc/headlesscode/collector.pem", publicKeyFingerprint: fingerprint },
		gateway: { identity: "local-docker" },
		externalControls: { emergencyStop: "required", emergencyControllerIdentity: "test-controller", evaluatorSupervisorOnly: true },
		...overrides.profile,
	}
	const writeProfile = (): void => fs.writeFileSync(profile, yaml(profileValue), { mode: 0o600 })
	writeProfile()
	const profileHash = createHash("sha256").update(fs.readFileSync(profile)).digest("hex")
	return {
		root, repo, profile, policy, key, socket, server, policyText,
		env: {
			HEADLESSCODE_CONTAINED_PROFILE: profile,
			HEADLESSCODE_CONTAINED_PROFILE_SHA256: profileHash,
			HEADLESSCODE_OPENSHELL_SCRATCH_ROOT: scratch,
			HEADLESSCODE_OPENROUTER_API_KEY: "host-secret-fixture",
			OPENROUTER_MODEL: "fixture/model",
			HEADLESSCODE_PROJECT: "fixture",
		},
		refreshProfile: writeProfile,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()))
			fs.closeSync(socketDirectoryFd)
			fs.rmSync(root, { recursive: true, force: true })
			fs.rmSync(socket, { force: true })
		},
	}
}

function yaml(value: unknown): string {
	return JSON.stringify(value, null, 2) + "\n"
}

const healthyProbe: OpenShellProbe = (args): OpenShellProbeResult => {
	if (args[0] === "--version") return { status: 0, stdout: "openshell 0.1.2\n" }
	return { status: 0, stdout: "Gateway: local-docker\nStatus: healthy\n" }
}

const tests: Array<[string, () => Promise<void>]> = [
	["resolves a pinned profile and snapshots the exact reviewed policy bytes", async () => {
		const f = await fixture()
		try {
			const resolved = resolveContainedRuntimeProfile({ repoRoot: f.repo, env: f.env, probe: healthyProbe })
			assert.equal(resolved.name, "contained")
			assert.equal(resolved.purpose, "worker")
			assert.equal(resolved.runtimeVersion, "openshell 0.1.2")
			assert.equal(resolved.gatewayIdentity, "local-docker")
			assert.deepEqual(fs.readFileSync(resolved.policySnapshotPath), fs.readFileSync(f.policy))
			assert.equal(fs.statSync(resolved.policySnapshotPath).mode & 0o777, 0o400)
			assert.equal(resolved.cpu, "2")
			assert.equal(resolved.memory, "4Gi")
			assert.equal(resolved.evidenceRequired, true)
			const transferred = loadResolvedContainedProfile(serializeResolvedContainedProfile(resolved))
			assert.deepEqual(transferred.providers, resolved.providers)
			assert.ok(Object.isFrozen(transferred.providers) && Object.isFrozen(transferred.allowedGuestEnv), "deserialized arrays are immutable")
			const malformed = JSON.parse(serializeResolvedContainedProfile(resolved)) as Record<string, unknown>
			malformed.allowedGuestEnv = ["HEADLESSCODE_OPENROUTER_API_KEY"]
			assert.throws(() => loadResolvedContainedProfile(JSON.stringify(malformed)), /allowlist/)
			cleanupContainedRuntimeProfile(resolved)
			assert.equal(fs.existsSync(resolved.policySnapshotDir), false)
		} finally { await f.close() }
	}],
	["rejects profile and policy tampering", async () => {
		const f = await fixture()
		try {
			fs.appendFileSync(f.profile, "# changed\n")
			assert.throws(() => resolveContainedRuntimeProfile({ repoRoot: f.repo, env: f.env, probe: healthyProbe }), /profile digest/)
		} finally { await f.close() }
	}],
	["rejects writable policy paths, root identity, and unpinned images", async () => {
		for (const policy of [
			{ filesystem_policy: { include_workdir: false, read_only: ["/usr"], read_write: ["/"] } },
			{ process: { run_as_user: "0", run_as_group: "0" } },
		]) {
			const f = await fixture({ policy })
			try { assert.throws(() => resolveContainedRuntimeProfile({ repoRoot: f.repo, env: f.env, probe: healthyProbe })) }
			finally { await f.close() }
		}
		const f = await fixture({ profile: { image: "headlesscode:local" } })
		try { assert.throws(() => resolveContainedRuntimeProfile({ repoRoot: f.repo, env: f.env, probe: healthyProbe }), /pinned by an @sha256/) }
		finally { await f.close() }
	}],
	["rejects operator controls inside the worker repository and symlink escapes", async () => {
		const f = await fixture()
		try {
			const inRepo = path.join(f.repo, "policy.yaml")
			fs.copyFileSync(f.policy, inRepo)
			assert.throws(() => resolveContainedRuntimeProfile({ repoRoot: f.repo, env: { ...f.env, HEADLESSCODE_CONTAINED_PROFILE: inRepo }, probe: healthyProbe }), /outside the worker-writable repository/)
			const link = path.join(f.root, "policy-link.yaml")
			fs.symlinkSync(f.policy, link)
			assert.throws(() => resolveContainedRuntimeProfile({ repoRoot: f.repo, env: { ...f.env, HEADLESSCODE_CONTAINED_PROFILE: link }, probe: healthyProbe }), /symlink/)
		} finally { await f.close() }
	}],
	["blocks local inference backends and keeps host credentials out of guest env", async () => {
		const f = await fixture()
		try {
			assert.throws(() => resolveContainedRuntimeProfile({ repoRoot: f.repo, env: { ...f.env, HEADLESSCODE_CODE_MODE_BACKEND: "ollama" }, probe: healthyProbe }), /local model backends/)
			const resolved = resolveContainedRuntimeProfile({ repoRoot: f.repo, env: f.env, probe: healthyProbe })
			const guest = containedGuestEnvironment(resolved, { ...f.env, SSH_AUTH_SOCK: "/tmp/agent.sock", AWS_SECRET_ACCESS_KEY: "secret" }, { HEADLESSCODE_PROJECT: "fixture" }, { GIT_AUTHOR_NAME: "Fixture" })
			assert.equal(guest.HEADLESSCODE_OPENROUTER_API_KEY, undefined)
			assert.equal(guest.SSH_AUTH_SOCK, undefined)
			assert.equal(guest.AWS_SECRET_ACCESS_KEY, undefined)
			assert.equal(guest.HEADLESSCODE_CODE_MODE_BACKEND, "openrouter")
			assert.equal(guest.GIT_AUTHOR_NAME, "Fixture")
			fs.rmSync(resolved.policySnapshotDir, { recursive: true, force: true })
		} finally { await f.close() }
	}],
	["fails closed on runtime and gateway preflight failures", async () => {
		assert.throws(() => verifyContainedPrerequisites({ expectedGatewayIdentity: "local-docker", probe: () => ({ status: 127, error: new Error("ENOENT") }) }), /verifiable OpenShell CLI/)
		assert.throws(() => verifyContainedPrerequisites({ expectedGatewayIdentity: "local-docker", probe: (args) => args[0] === "--version" ? { status: 0, stdout: "openshell 0.1.2" } : { status: 1, stderr: "unavailable" } }), /healthy, reachable/)
		assert.throws(() => verifyContainedPrerequisites({ expectedGatewayIdentity: "approved-gateway", probe: (args) => args[0] === "--version" ? { status: 0, stdout: "openshell 0.1.2" } : { status: 0, stdout: "Gateway: other-gateway\nStatus: healthy\n" } }), /identity does not match/)
	}],
	["accepts only the expected effective inference endpoint and denies evaluation network", async () => {
		const worker = { purpose: "worker" as const, inferenceEndpoint: { host: "openrouter.ai", port: 443 } }
		assert.doesNotThrow(() => assertEffectiveOpenShellPolicy(fixturePolicy("openrouter.ai"), { ...worker, evidenceGuestPath: "/run/headlesscode/evidence.sock", evidenceGuestPublicKeyPath: "/etc/headlesscode/collector.pem" }))
		assert.throws(() => assertEffectiveOpenShellPolicy(fixturePolicy("attacker.example"), { ...worker, evidenceGuestPath: "/run/headlesscode/evidence.sock", evidenceGuestPublicKeyPath: "/etc/headlesscode/collector.pem" }), /single approved/)
		assert.throws(() => assertEffectiveOpenShellPolicy(fixturePolicy("openrouter.ai", "audit"), { ...worker, evidenceGuestPath: "/run/headlesscode/evidence.sock", evidenceGuestPublicKeyPath: "/etc/headlesscode/collector.pem" }), /single approved/)
		assert.doesNotThrow(() => assertEffectiveOpenShellPolicy(fixturePolicy("openrouter.ai", "enforce", false), { purpose: "evaluation", evidenceGuestPath: "/run/headlesscode/evidence.sock", evidenceGuestPublicKeyPath: "/etc/headlesscode/collector.pem" }))
		assert.throws(() => assertEffectiveOpenShellPolicy(fixturePolicy("openrouter.ai"), { purpose: "evaluation", evidenceGuestPath: "/run/headlesscode/evidence.sock", evidenceGuestPublicKeyPath: "/etc/headlesscode/collector.pem" }), /grants network access/)
		const unsafeFs = JSON.parse(fixturePolicy("openrouter.ai")) as Record<string, any>
		unsafeFs.filesystem_policy.read_write = ["/"]
		assert.throws(() => assertEffectiveOpenShellPolicy(JSON.stringify(unsafeFs), { ...worker, evidenceGuestPath: "/run/headlesscode/evidence.sock", evidenceGuestPublicKeyPath: "/etc/headlesscode/collector.pem" }), /unapproved writable filesystem/)
		const softLandlock = JSON.parse(fixturePolicy("openrouter.ai")) as Record<string, any>
		softLandlock.landlock.compatibility = "best_effort"
		assert.throws(() => assertEffectiveOpenShellPolicy(JSON.stringify(softLandlock), { ...worker, evidenceGuestPath: "/run/headlesscode/evidence.sock", evidenceGuestPublicKeyPath: "/etc/headlesscode/collector.pem" }), /does not require Landlock/)
	}],
]

function fixturePolicy(host: string, enforcement = "enforce", includeNetwork = true): string {
	return JSON.stringify({
		filesystem_policy: { include_workdir: false, read_only: ["/etc/headlesscode/collector.pem", "/run/headlesscode/evidence-runtime.json"], read_write: ["/workspace", "/result", "/run/headlesscode/evidence.sock"] },
		landlock: { compatibility: "hard_requirement" },
		process: { run_as_user: "sandbox", run_as_group: "sandbox" },
		network_policies: includeNetwork ? { inference: { endpoints: [{ host, port: 443, enforcement }], binaries: [{ path: "/usr/bin/node" }] } } : {},
	})
}

for (const [name, run] of tests) {
	await run()
	console.log(`  ok   ${name}`)
}

console.log(`All ${tests.length} contained-profile tests passed`)

if (os.platform() === "win32") process.exitCode = 1
