import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
	RepositoryCampaignStore,
	type RepositoryCampaignDefinition,
} from "../repository-campaigns.js"
import { CampaignControlStore } from "../store.js"
import {
	CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_PUBLIC_BASE_REVISION,
	CURL_DEBIAN_SNAPSHOT_SHA256, CURL_DEBIAN_SOURCE_HTML_SHA256,
	CURL_DEBIAN_SOURCE_URL, CURL_FIXED_ADVISORY,
} from "../repository-known-advisory.js"
import {
	CURL_REPAIR_V2_CAMPAIGN_ID,
} from "../repository-campaign-ids.js"
import {
	CURL_REPAIR_V2_EVALUATOR_DIGEST, CURL_REPAIR_V2_LIFETIME_ALLOCATION,
	CURL_REPAIR_V2_MODEL, CURL_REPAIR_V2_POLICY_SHA256,
	CURL_REPAIR_V2_PROFILE_ID, CURL_REPAIR_V2_RECIPE_DIGEST,
	CURL_REPAIR_V2_REPOSITORY_ID, CURL_REPAIR_V2_SOURCE_REVISION,
	CURL_REPAIR_V2_TARGET_REPOSITORY,
} from "../repository-curl-repair-v2-profile.js"
import {
	FleetRepositoryBudgetLedger,
	type FleetRepositoryBudgetScope,
} from "../../rsi/fleet-repository-budget-ledger.js"
import type { RepositoryBudgetAuthority } from "../repository-campaigns.js"
import { runMain, type SuiteTest } from "../../test-runner.js"
import { pythonBridge } from "./repository-no-model-budget-bridge.js"

const key = "offline-v2-budget-test-key"
const keyIdentity = createHash("sha256").update(key).digest("hex")
const qualified = {
	sourceAudited: true, workerQualified: true, recipeQualified: true,
	evaluatorQualified: true, modelApproved: true, dataApproved: true,
	accessApproved: true,
}
const definition: RepositoryCampaignDefinition = {
	id: CURL_REPAIR_V2_CAMPAIGN_ID, name: "Historical Curl repair v2",
	repositoryId: CURL_REPAIR_V2_REPOSITORY_ID,
	repository: CURL_REPAIR_V2_TARGET_REPOSITORY,
	sourceRevision: CURL_REPAIR_V2_SOURCE_REVISION,
	policySha256: CURL_REPAIR_V2_POLICY_SHA256,
	workerProfile: CURL_REPAIR_V2_PROFILE_ID,
	recipeDigest: CURL_REPAIR_V2_RECIPE_DIGEST,
	evaluatorDigest: CURL_REPAIR_V2_EVALUATOR_DIGEST,
	model: CURL_REPAIR_V2_MODEL,
	dataAccessProfile: "public-source-and-published-advisory-only",
	qualification: qualified,
}
const scope: FleetRepositoryBudgetScope = {
	repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!,
	repository: definition.repository!, sourceRevision: definition.sourceRevision!,
	policySha256: definition.policySha256!, model: "none", profileId: "no-model",
	repositoryEpoch: 1,
}
interface BudgetFixture {
	control: CampaignControlStore
	ledger: FleetRepositoryBudgetLedger
	store: RepositoryCampaignStore
	root: string
	fleetRoot: string
}
async function pythonBridgeFeedsV2SnapshotAndLocalClaim(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-curl-v2-budget-"))
	try {
		const fixture = await createBudgetFixture(root)
		await assertColdBudget(fixture)
		await queueRepair(fixture.store)
		const active = await startLiveRun(fixture.control)
		await assertLocalClaim(fixture, active.id)
	} finally { await fs.rm(root, { recursive: true, force: true }) }
}
async function createBudgetFixture(root: string): Promise<BudgetFixture> {
	const fleetRoot = process.env.FLEET_SECURITY_WATCH_TEST_ROOT ??
		path.resolve(process.cwd(), "../fleet-curl-repair-v2-evaluator-20261030")
	const campaignRoot = path.join(root,
		".local/state/fleet-security-watch/automation/campaign")
	const controlPath = path.join(root,
		".local/share/headlesscode/campaign-control/control.json")
	await writeBridgeFiles(root, campaignRoot, controlPath)
	const control = await configureControl(controlPath)
	const ledger = new FleetRepositoryBudgetLedger({
		expectedKeyIdentity: keyIdentity, scope,
		invoke: async (message) => pythonBridge(root, fleetRoot, message),
	})
	const store = createCampaignStore(root, control, ledger)
	return { control, ledger, store, root, fleetRoot }
}
async function configureControl(
	controlPath: string,
): Promise<CampaignControlStore> {
	const control = new CampaignControlStore(controlPath)
	await control.setBudgetLimit(5_000_000)
	await control.setEnabled(true)
	await control.setRepositoryCampaign(definition, true)
	return control
}
function createCampaignStore(root: string, control: CampaignControlStore,
	ledger: FleetRepositoryBudgetLedger): RepositoryCampaignStore {
	const readAuthority = async (): Promise<RepositoryBudgetAuthority> => {
		if (!(await control.snapshot()).activeRun) {
			return await ledger.budgetSnapshotOnly()
		}
			const snapshot = await ledger.budgetSnapshot()
			return { ...snapshot, mode: "fleet-v2-budget-only" }
	}
	return new RepositoryCampaignStore(
		path.join(root, "jobs.json"), [definition], readAuthority)
}
async function assertColdBudget(fixture: BudgetFixture): Promise<void> {
	await fixture.store.setCampaignBudget(definition.id,
		CURL_REPAIR_V2_LIFETIME_ALLOCATION.micros,
		CURL_REPAIR_V2_LIFETIME_ALLOCATION.tokens)
	const snapshot = await fixture.ledger.budgetSnapshotOnly()
	assert.equal(snapshot.repositoryLifetime.limitMicros, 400)
	assert.equal(snapshot.repositoryLifetime.limitTokens, 500)
	assert.equal(snapshot.available, false)
	assertPythonBridgeRejectsWrongIdentity(fixture.root, fixture.fleetRoot)
	await fixture.store.start(definition.id)
}
async function queueRepair(store: RepositoryCampaignStore): Promise<void> {
	await store.observeKnownRepairAdvisoryV2({ campaignId: definition.id,
		advisoryId: CURL_FIXED_ADVISORY,
		publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
		snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
		sourceUrl: CURL_DEBIAN_SOURCE_URL,
		sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
		affectedRange: CURL_DEBIAN_AFFECTED_RANGE,
	})
}
async function startLiveRun(control: CampaignControlStore): Promise<{
	id: string; epoch: number; startedAt: number; expiresAt: number
}> {
	const state = await control.snapshot()
	const active = await control.beginAdmittedRunIfIdle(
		new Date(), 300_000, state.epoch)
	assert.ok(active)
	return active
}
async function assertLocalClaim(
	fixture: BudgetFixture,
	runId: string,
): Promise<void> {
	const snapshot = await fixture.ledger.budgetSnapshot()
	assert.equal(snapshot.available, false)
	assert.equal(snapshot.snapshotOnly, true)
	assert.equal(snapshot.runId, runId)
	const claim = await fixture.store.claimNext(
		definition.id,
		{ micros: 1, tokens: 1 },
		new Date(), { executionKind: "live-cve" })
	assert.ok(claim)
	assert.equal(claim.job.advisoryId, CURL_FIXED_ADVISORY)
	assert.equal(claim.job.purpose, "repair")
}
async function writeBridgeFiles(root: string, campaignRoot: string,
	controlPath: string): Promise<void> {
	await fs.mkdir(campaignRoot, { recursive: true, mode: 0o700 })
	await fs.mkdir(path.dirname(controlPath), { recursive: true, mode: 0o700 })
	const credentialFile = path.join(campaignRoot, "offline-test-key")
	await fs.writeFile(credentialFile, key, { mode: 0o600 })
	await writeRuntimeConfig(campaignRoot, credentialFile)
	await writeScopeRegistry(campaignRoot)
	await fs.chmod(root, 0o700)
}
async function writeRuntimeConfig(campaignRoot: string,
	credentialFile: string): Promise<void> {
	const config = {
		schema_version: 1, enabled: true, repository: "/offline-fixture",
		base_sha: definition.sourceRevision, board_card: "fixture-card",
		image_digest: "a".repeat(64), credential_file: credentialFile,
		key_identity: keyIdentity,
	}
	await fs.writeFile(path.join(campaignRoot, "config.json"),
		JSON.stringify(config), { mode: 0o600 })
}
async function writeScopeRegistry(campaignRoot: string): Promise<void> {
	const registered = {
		repositoryCampaignId: scope.repositoryCampaignId,
		repositoryId: scope.repositoryId, repository: scope.repository,
		sourceRevision: scope.sourceRevision, policySha256: scope.policySha256,
		model: scope.model, profileId: scope.profileId,
		maxLifetimeSpendMicros: 400, maxLifetimeTokens: 500,
	}
	await fs.writeFile(path.join(campaignRoot, "repository-scopes.json"),
		JSON.stringify({ schemaVersion: 1, repositories: [registered] }),
		{ mode: 0o600 })
}
function assertPythonBridgeRejectsWrongIdentity(
	root: string,
	fleetRoot: string,
): void {
	const request = {
		schemaVersion: 2, op: "repository-budget-snapshot",
		campaignId: "fleet-security-watch", keyIdentity,
		repositoryCampaignId: scope.repositoryCampaignId,
		repositoryId: scope.repositoryId, repository: scope.repository,
		sourceRevision: scope.sourceRevision, policySha256: scope.policySha256,
		model: scope.model, profileId: scope.profileId,
	}
	for (const change of [{ policySha256: "f".repeat(64) },
		{ profileId: "wrong-profile" }, { repositoryCampaignId: "wrong-campaign" }]) {
		assert.throws(() => pythonBridge(root, fleetRoot, { ...request, ...change }),
			/offline Python bridge failed/)
	}
}
async function wrongV2PolicyOrProfileIsRejected(): Promise<void> {
	for (const change of [{ policySha256: "f".repeat(64) },
		{ profileId: "wrong-profile" }, { repositoryCampaignId: "wrong-campaign" }]) {
		assert.throws(() => new FleetRepositoryBudgetLedger({
			expectedKeyIdentity: keyIdentity,
			scope: { ...scope, ...change } as FleetRepositoryBudgetScope,
			invoke: async () => ({}) }), /scope is invalid/)
	}
}

const tests: readonly SuiteTest[] = [
	["Python bridge feeds exact v2 snapshots into a bounded claim",
		pythonBridgeFeedsV2SnapshotAndLocalClaim],
	["v2 ledger rejects wrong scope, profile and policy",
		wrongV2PolicyOrProfileIsRejected],
]

await runMain("repository-no-model-budget-v2", tests)
