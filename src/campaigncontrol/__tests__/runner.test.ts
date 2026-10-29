import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { CampaignControlStore } from "../store.js"
import { loadCampaignAdapterConfig, prepareDispatchLock, runCampaignTick, runFleetAdapterUnderLock, verifyCampaignRelease, type SpawnCampaign } from "../runner.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

async function testFixedAdapterArgvAndEnvironment(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-campaign-runner-"))
	const release = path.join(root, "release")
	const fleetState = path.join(root, "fleet-state")
	await fs.mkdir(release)
	const store = new CampaignControlStore(path.join(root, "control", "control.json"))
	let called = false
	const fake: SpawnCampaign = (file, args, options) => {
		called = true
		assert.equal(file, "/usr/bin/flock")
		assert.deepEqual(args.slice(0, 4), ["-n", "-E", "75", path.join(root, "control", "campaign-dispatch.lock")])
		assert.deepEqual(args.slice(-2), ["campaign", "_adapter-tick"])
		assert.equal(options.env.HEADLESSCODE_CAMPAIGN_FLEET_RELEASE_ROOT, path.join(root, "release"))
		assert.equal(options.shell, false)
		assert.equal(options.cwd, path.resolve(process.cwd()))
		assert.equal(options.env.PYTHONPATH, undefined, "the launch wrapper does not inherit provider or module paths")
		assert.equal(options.env.HEADLESSCODE_OPENROUTER_API_KEY, undefined)
		return nodeSpawn(process.execPath, ["-e", "process.exit(0)"], { cwd: root, stdio: "ignore" }) as ChildProcess
	}
	try {
		const result = await runCampaignTick(store, { releaseRoot: release, stateRoot: fleetState, releaseDigest: "a".repeat(64) }, fake)
		assert.equal(called, true)
		assert.equal(result.status, "succeeded")
		assert.equal(result.code, 0)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testRegistrationRequiresPrivateOwnerFileAndPinnedDigest(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-campaign-config-"))
	const release = path.join(root, "release")
	const state = path.join(root, "state")
	const configPath = path.join(root, "fleet-adapter.json")
	await fs.mkdir(release)
	await fs.mkdir(state)
	try {
		await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, releaseRoot: release, stateRoot: state, releaseDigest: "b".repeat(64) }), { mode: 0o600 })
		assert.deepEqual(await loadCampaignAdapterConfig(configPath), { releaseRoot: release, stateRoot: state, releaseDigest: "b".repeat(64) })
		await fs.chmod(configPath, 0o644)
		await assert.rejects(loadCampaignAdapterConfig(configPath), /owner-only regular file/)
		await fs.chmod(configPath, 0o600)
		const badPath = path.join(root, "bad.json")
		await fs.writeFile(badPath, JSON.stringify({ schemaVersion: 1, releaseRoot: release, stateRoot: state, releaseDigest: "not-a-digest" }), { mode: 0o600 })
		await assert.rejects(loadCampaignAdapterConfig(badPath), /schema validation/)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testDispatchBusyDoesNotRunSecondAdapter(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-campaign-busy-"))
	const release = path.join(root, "release")
	await fs.mkdir(release)
	const store = new CampaignControlStore(path.join(root, "control", "control.json"))
	const fake: SpawnCampaign = () => nodeSpawn(process.execPath, ["-e", "process.exit(75)"], { cwd: root, stdio: "ignore" }) as ChildProcess
	try {
		const result = await runCampaignTick(store, { releaseRoot: release, stateRoot: path.join(root, "state"), releaseDigest: "c".repeat(64) }, fake)
		assert.equal(result.status, "busy", "an occupied cross-process dispatch lock does not start a second campaign")
		assert.equal((await store.snapshot()).activeRun, null, "busy detection happens before writing the active run fence")
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}

async function testTickDoesNotOverwriteLiveRsiRunLease(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-campaign-live-rsi-"))
	const release = path.join(root, "release")
	const state = path.join(root, "fleet-state")
	await fs.mkdir(release)
	await fs.mkdir(state)
	await fs.chmod(release, 0o700)
	await fs.chmod(state, 0o700)
	const store = new CampaignControlStore(path.join(root, "control", "control.json"))
	let spawned = false
	const fake: SpawnCampaign = () => { spawned = true; throw new Error("the active RSI lease must short-circuit before spawning") }
	let lock: Awaited<ReturnType<typeof fs.open>> | undefined
	try {
		const active = await store.beginRun(new Date(), 60_000)
		const lockPath = await prepareDispatchLock(store.path)
		lock = await fs.open(lockPath, "r+")
		const result = await runFleetAdapterUnderLock(store, { releaseRoot: release, stateRoot: state, releaseDigest: "d".repeat(64) }, fake)
		assert.deepEqual({ status: result.status, code: result.code, adapterStatus: result.adapterStatus }, { status: "busy", code: 75, adapterStatus: "busy" })
		assert.equal(spawned, false)
		assert.equal((await store.snapshot()).activeRun?.id, active.id)
		assert.equal((await store.status()).runs.length, 0)
	} finally {
		await lock?.close()
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function testReleaseManifestBindsEveryFileAndWorkTarget(): Promise<void> {
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-campaign-release-"))
	const source = path.join(parent, "source")
	await fs.mkdir(source)
	const content = Buffer.from("fixed adapter test fixture\n")
	const files = { "module.py": createHash("sha256").update(content).digest("hex") }
	const canonical = JSON.stringify({ files: { "module.py": files["module.py"] }, work_target: source })
	const digest = createHash("sha256").update(canonical).digest("hex")
	const release = path.join(parent, digest)
	await fs.mkdir(release)
	await fs.writeFile(path.join(release, "module.py"), content, { mode: 0o444 })
	await fs.symlink(source, path.join(release, "work"))
	await fs.writeFile(path.join(release, "release-manifest.json"), JSON.stringify({
		schema_version: 1, files, work_target: source, aggregate_digest: digest,
	}), { mode: 0o444 })
	await fs.chmod(release, 0o555)
	try {
		const config = { releaseRoot: release, stateRoot: path.join(parent, "state"), releaseDigest: digest }
		await verifyCampaignRelease(config)
		await fs.chmod(release, 0o755)
		await fs.chmod(path.join(release, "module.py"), 0o600)
		await fs.writeFile(path.join(release, "module.py"), "changed", { mode: 0o600 })
		await fs.chmod(path.join(release, "module.py"), 0o444)
		await fs.chmod(release, 0o555)
		await assert.rejects(verifyCampaignRelease(config), /digest mismatch/)
	} finally {
		await fs.chmod(release, 0o755).catch(() => undefined)
		await fs.chmod(path.join(release, "module.py"), 0o600).catch(() => undefined)
		await fs.chmod(path.join(release, "release-manifest.json"), 0o600).catch(() => undefined)
		await fs.rm(parent, { recursive: true, force: true })
	}
}

const tests: readonly SuiteTest[] = [
	["fixed adapter argv uses no shell and receives no provider key", testFixedAdapterArgvAndEnvironment],
	["adapter registration is private and validates the release digest", testRegistrationRequiresPrivateOwnerFileAndPinnedDigest],
	["busy dispatch does not create a second active run", testDispatchBusyDoesNotRunSecondAdapter],
	["minute tick preserves an active RSI run lease", testTickDoesNotOverwriteLiveRsiRunLease],
	["release manifest pins every file and the exact work target", testReleaseManifestBindsEveryFileAndWorkTarget],
]

runMain("campaign-control-runner", tests)
