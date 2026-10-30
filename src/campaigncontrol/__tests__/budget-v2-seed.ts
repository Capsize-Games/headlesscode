import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
	createRepositoryCampaignBudgetBinding,
} from "../repository-budget-binding.js"
import {
	RepositoryCampaignStore, type RepositoryBudgetAuthority,
	type RepositoryCampaignDefinition,
} from "../repository-campaigns.js"
import { CampaignControlStore } from "../store.js"
import {
	definitions, fakeKey, grant, keyIdentity, privateDir, scope,
	type BridgeFlags, type Fixture,
} from "./budget-v2-fixtures.js"
import {
	makeInvoke, makeRequestStartHandoff, tryDispatchLockFile,
} from "./budget-v2-handoff.js"

export interface FixtureOptions {
	activeRun?: boolean
	repositoryEnabled?: boolean
}

async function freshFixtureHome(): Promise<{
	home: string
	campaign: string
	controlDir: string
}> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(),
		"hcl-fleet-v2-"))
	await fs.chmod(home, 0o700)
	const campaign = path.join(home, ".local", "state",
		"fleet-security-watch", "automation", "campaign")
	const controlDir = path.join(home, ".local", "share", "headlesscode",
		"campaign-control")
	await privateDir(campaign)
	await privateDir(controlDir)
	return { home, campaign, controlDir }
}

async function writeIdentityConfig(campaign: string): Promise<void> {
	const credential = path.join(campaign, "test-key")
	const config = path.join(campaign, "config.json")
	await fs.writeFile(credential, fakeKey, { mode: 0o600 })
	await fs.chmod(credential, 0o600)
	await fs.writeFile(config, JSON.stringify({ schema_version: 1,
		enabled: true, repository: "/fixture", base_sha: "a".repeat(40),
		board_card: "1c25cecf", image_digest: "b".repeat(64),
		credential_file: credential, key_identity: keyIdentity }),
		{ mode: 0o600 })
	await fs.chmod(config, 0o600)
}

async function writeScopesConfig(campaign: string): Promise<void> {
	const scopes = (["repo-a", "repo-b"] as const).map((id) => {
		const scoped = scope(id)
		return { repositoryCampaignId: scoped.repositoryCampaignId,
			repositoryId: scoped.repositoryId, repository: scoped.repository,
			sourceRevision: scoped.sourceRevision,
			policySha256: scoped.policySha256,
			model: scoped.model, profileId: scoped.profileId,
			maxLifetimeSpendMicros: 10_000, maxLifetimeTokens: 10_000 }
	})
	await fs.writeFile(path.join(campaign, "repository-scopes.json"),
		JSON.stringify({ schemaVersion: 1, repositories: scopes }),
		{ mode: 0o600 })
	await fs.chmod(path.join(campaign, "repository-scopes.json"), 0o600)
}

async function writeFixtureConfig(campaign: string): Promise<void> {
	await writeIdentityConfig(campaign)
	await writeScopesConfig(campaign)
}

interface ControlSetup {
	store: CampaignControlStore
	definitions: Map<string, RepositoryCampaignDefinition>
}

async function openControlStore(controlDir: string,
	options: FixtureOptions): Promise<ControlSetup> {
	const store = new CampaignControlStore(
		path.join(controlDir, "control.json"))
	await fs.writeFile(path.join(controlDir, "campaign-dispatch.lock"), "",
		{ mode: 0o600 })
	const found = new Map(definitions.map((entry) => [entry.id, entry]))
	await store.setBudgetLimit(5_000_000)
	await store.setEnabled(true)
	for (const entry of definitions)
		await store.setRepositoryCampaign(
			entry, options.repositoryEnabled ?? true)
	const globalControl = await store.snapshot()
	if (options.activeRun !== false) {
		await store.beginAdmittedRunIfIdle(new Date(), 300_000,
			globalControl.epoch)
	}
	return { store, definitions: found }
}

async function setControlValue(
	control: ControlSetup,
	next: Parameters<Fixture["setControl"]>[0],
): Promise<void> {
	if (next.globalEnabled !== undefined) {
		await control.store.setEnabled(next.globalEnabled)
	}
	for (const [id, enabled] of [["repo-a", next.repoAEnabled],
		["repo-b", next.repoBEnabled]] as const) {
		if (enabled !== undefined) {
			await control.store.setRepositoryCampaign(
				control.definitions.get(id)!, enabled)
		}
	}
}

function bridgeControls(
	control: ControlSetup,
	controlDir: string,
	flags: BridgeFlags,
	invoke: Fixture["invoke"],
	requestStartHandoff: Fixture["requestStartHandoff"],
): Pick<Fixture, "setFault" | "setMonth" | "invoke" |
	"requestStartHandoff" | "tryDispatchLock" | "crashNextHandoff" |
	"setControl"> {
	return {
		setFault(value?: string): void { flags.fault = value },
		setMonth(value?: string): void { flags.month = value },
		invoke,
		requestStartHandoff,
		tryDispatchLock: () => tryDispatchLockFile(controlDir),
		crashNextHandoff(): void { flags.crashHandoff = true },
		setControl: (next) => setControlValue(control, next),
	}
}

interface SeededClaims {
	root: string
	store: RepositoryCampaignStore
	claims: Fixture["claims"]
	grants: Fixture["grants"]
	bindings: Fixture["bindings"]
}

async function openSeededCampaigns(
	store: RepositoryCampaignStore,
	now: Date,
): Promise<void> {
	for (const id of ["repo-a", "repo-b"] as const) {
		await store.setCampaignBudget(id, 10_000, 10_000, now)
		await store.start(id, now)
		await store.enqueue(id,
			id === "repo-a" ? "CVE-2026-1234" : "CVE-2026-1235", now)
	}
}

async function claimSeededPair(
	store: RepositoryCampaignStore,
	now: Date,
): Promise<{ claims: Fixture["claims"]; grants: Fixture["grants"] }> {
	const claimA = await store.claimNext("repo-a",
		{ micros: 10_000, tokens: 10_000 }, now)
	const claimB = await store.claimNext("repo-b",
		{ micros: 10_000, tokens: 10_000 }, now)
	assert.ok(claimA && claimB)
	const claims = { "repo-a": claimA, "repo-b": claimB }
	const grants = {
		"repo-a": grant(claims["repo-a"].job.id),
		"repo-b": grant(claims["repo-b"].job.id),
	}
	return { claims, grants }
}

function bindSeededClaims(
	store: RepositoryCampaignStore,
	claims: Fixture["claims"],
	invoke: Fixture["invoke"],
	requestStartHandoff: Fixture["requestStartHandoff"],
): Fixture["bindings"] {
	return Object.fromEntries((["repo-a", "repo-b"] as const).map((id) => [id,
		createRepositoryCampaignBudgetBinding({
			store,
			claim: claims[id],
			scope: scope(id),
			expectedKeyIdentity: keyIdentity,
			invoke,
			requestStartHandoff,
			assertDispatchFence: async () => undefined,
		})])) as Fixture["bindings"]
}

async function seedRepositoryClaims(
	home: string,
	invoke: Fixture["invoke"],
	requestStartHandoff: Fixture["requestStartHandoff"],
): Promise<SeededClaims> {
	const authority: RepositoryBudgetAuthority = { mode: "synthetic-test",
		available: true, limitMicros: 20_000, limitTokens: 20_000,
		committedMicros: 0, committedTokens: 0 }
	const root = path.join(home, "hcl")
	await privateDir(root)
	const store = new RepositoryCampaignStore(
		path.join(root, "repository-campaigns.json"), definitions,
		() => authority)
	const now = new Date("2026-10-29T12:00:00Z")
	await openSeededCampaigns(store, now)
	const { claims, grants } = await claimSeededPair(store, now)
	const bindings = bindSeededClaims(store, claims, invoke, requestStartHandoff)
	return { root, store, claims, grants, bindings }
}

export async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
	const paths = await freshFixtureHome()
	await writeFixtureConfig(paths.campaign)
	const flags: BridgeFlags = { crashHandoff: false }
	const control = await openControlStore(paths.controlDir, options)
	const invoke = makeInvoke(paths.home, flags)
	const requestStartHandoff = makeRequestStartHandoff(
		paths.home, paths.controlDir, flags)
	const seed = await seedRepositoryClaims(paths.home, invoke,
		requestStartHandoff)
	return {
		...seed,
		home: paths.home,
		controlStore: control.store,
		...bridgeControls(control, paths.controlDir, flags, invoke,
			requestStartHandoff),
		cleanup: () => fs.rm(paths.home, { recursive: true, force: true }),
	}
}
