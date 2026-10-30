import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { RepositoryCampaignStore, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
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
import { FleetRepositoryBudgetLedger, type FleetRepositoryBudgetScope } from "../../rsi/fleet-repository-budget-ledger.js"
import type { RepositoryBudgetAuthority } from "../repository-campaigns.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const key = "offline-v2-budget-test-key"
const keyIdentity = createHash("sha256").update(key).digest("hex")
const qualified = { sourceAudited: true, workerQualified: true, recipeQualified: true,
	evaluatorQualified: true, modelApproved: true, dataApproved: true, accessApproved: true }
const definition: RepositoryCampaignDefinition = {
	id: CURL_REPAIR_V2_CAMPAIGN_ID, name: "Historical Curl repair v2",
	repositoryId: CURL_REPAIR_V2_REPOSITORY_ID, repository: CURL_REPAIR_V2_TARGET_REPOSITORY,
	sourceRevision: CURL_REPAIR_V2_SOURCE_REVISION, policySha256: CURL_REPAIR_V2_POLICY_SHA256,
	workerProfile: CURL_REPAIR_V2_PROFILE_ID, recipeDigest: CURL_REPAIR_V2_RECIPE_DIGEST,
	evaluatorDigest: CURL_REPAIR_V2_EVALUATOR_DIGEST, model: CURL_REPAIR_V2_MODEL,
	dataAccessProfile: "public-source-and-published-advisory-only", qualification: qualified,
}
const scope: FleetRepositoryBudgetScope = {
	repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!,
	repository: definition.repository!, sourceRevision: definition.sourceRevision!,
	policySha256: definition.policySha256!, model: "none", profileId: "no-model",
	repositoryEpoch: 1,
}

function pythonBridge(root: string, fleetRoot: string, message: Record<string, unknown>): Record<string, unknown> {
	const script = "import json,sys\nfrom unittest.mock import patch\n" +
		"import operations.campaign_budget as budget\nimport operations.campaign_budget_bridge as bridge\n" +
		"with patch.object(budget, '_provider_snapshot', return_value={'limit_micros':5000000,'remaining_micros':5000000,'usage_micros':0}):\n" +
		" print(json.dumps(bridge._authority().dispatch(json.load(sys.stdin)),separators=(',',':')))\n"
	const result = spawnSync("/usr/bin/python3", ["-c", script], {
		input: JSON.stringify(message), encoding: "utf8", timeout: 10_000,
		env: { HOME: root, PATH: "/usr/bin:/bin", PYTHONPATH: fleetRoot,
			PYTHONNOUSERSITE: "1" },
	})
	if (result.error || result.status !== 0) {
		throw new Error("offline Python bridge failed: " + (result.stderr ?? "").slice(0, 500))
	}
	return JSON.parse(result.stdout.trim()) as Record<string, unknown>
}

async function pythonBridgeFeedsV2SnapshotAndLocalClaim(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-curl-v2-budget-"))
	const fleetRoot = process.env.FLEET_SECURITY_WATCH_TEST_ROOT ??
		path.resolve(process.cwd(), "../fleet-curl-repair-v2-evaluator-20261030")
	const campaignRoot = path.join(root, ".local/state/fleet-security-watch/automation/campaign")
	const controlPath = path.join(root, ".local/share/headlesscode/campaign-control/control.json")
	try {
		await writeBridgeFiles(root, campaignRoot, controlPath)
		const control = new CampaignControlStore(controlPath)
		await control.setBudgetLimit(5_000_000)
		await control.setEnabled(true)
		await control.setRepositoryCampaign(definition, true)
		const ledger = new FleetRepositoryBudgetLedger({ expectedKeyIdentity: keyIdentity,
			scope, invoke: async (message) => pythonBridge(root, fleetRoot, message) })
		const budgetAuthority = async (): Promise<RepositoryBudgetAuthority> => {
			if (!(await control.snapshot()).activeRun) return await ledger.budgetSnapshotOnly()
			return { ...await ledger.budgetSnapshot(), mode: "fleet-v2-budget-only" }
		}
		const store = new RepositoryCampaignStore(path.join(root, "jobs.json"),
			[definition], budgetAuthority)
		await store.setCampaignBudget(definition.id,
			CURL_REPAIR_V2_LIFETIME_ALLOCATION.micros,
			CURL_REPAIR_V2_LIFETIME_ALLOCATION.tokens)
		const cold = await ledger.budgetSnapshotOnly()
		assert.equal(cold.repositoryLifetime.limitMicros, 400)
		assert.equal(cold.repositoryLifetime.limitTokens, 500)
		assert.equal(cold.available, false)
		assertPythonBridgeRejectsWrongIdentity(root, fleetRoot)
		await store.start(definition.id)
		await store.observeKnownRepairAdvisoryV2({ campaignId: definition.id,
			advisoryId: CURL_FIXED_ADVISORY, publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION,
			snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256, sourceUrl: CURL_DEBIAN_SOURCE_URL,
			sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256,
			affectedRange: CURL_DEBIAN_AFFECTED_RANGE })
		const current = await control.snapshot()
		const active = await control.beginAdmittedRunIfIdle(new Date(), 300_000, current.epoch)
		assert.ok(active)
		const live = await ledger.budgetSnapshot()
		assert.equal(live.available, false)
		assert.equal(live.snapshotOnly, true)
		assert.equal(live.runId, active!.id)
		const claim = await store.claimNext(definition.id, { micros: 1, tokens: 1 },
			new Date(), { executionKind: "live-cve" })
		assert.ok(claim)
		assert.equal(claim.job.advisoryId, CURL_FIXED_ADVISORY)
		assert.equal(claim.job.purpose, "repair")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

async function writeBridgeFiles(root: string, campaignRoot: string,
	controlPath: string): Promise<void> {
	await fs.mkdir(campaignRoot, { recursive: true, mode: 0o700 })
	await fs.mkdir(path.dirname(controlPath), { recursive: true, mode: 0o700 })
	const credentialFile = path.join(campaignRoot, "offline-test-key")
	await fs.writeFile(credentialFile, key, { mode: 0o600 })
	await fs.writeFile(path.join(campaignRoot, "config.json"), JSON.stringify({
		schema_version: 1, enabled: true, repository: "/offline-fixture",
		base_sha: definition.sourceRevision, board_card: "fixture-card",
		image_digest: "a".repeat(64), credential_file: credentialFile,
		key_identity: keyIdentity,
	}), { mode: 0o600 })
	await fs.writeFile(path.join(campaignRoot, "repository-scopes.json"),
		JSON.stringify({ schemaVersion: 1, repositories: [{
			repositoryCampaignId: scope.repositoryCampaignId,
			repositoryId: scope.repositoryId, repository: scope.repository,
			sourceRevision: scope.sourceRevision, policySha256: scope.policySha256,
			model: scope.model, profileId: scope.profileId,
			maxLifetimeSpendMicros: 400, maxLifetimeTokens: 500 }] }), { mode: 0o600 })
	await fs.chmod(root, 0o700)
}

function assertPythonBridgeRejectsWrongIdentity(root: string, fleetRoot: string): void {
	const request = { schemaVersion: 2, op: "repository-budget-snapshot",
		campaignId: "fleet-security-watch", keyIdentity,
		repositoryCampaignId: scope.repositoryCampaignId, repositoryId: scope.repositoryId,
		repository: scope.repository, sourceRevision: scope.sourceRevision,
		policySha256: scope.policySha256, model: scope.model, profileId: scope.profileId }
	for (const change of [{ policySha256: "f".repeat(64) },
		{ profileId: "wrong-profile" }, { repositoryCampaignId: "wrong-campaign" }]) {
		assert.throws(() => pythonBridge(root, fleetRoot, { ...request, ...change }),
			/offline Python bridge failed/)
	}
}

async function wrongV2PolicyOrProfileIsRejected(): Promise<void> {
	for (const change of [{ policySha256: "f".repeat(64) },
		{ profileId: "wrong-profile" }, { repositoryCampaignId: "wrong-campaign" }]) {
		assert.throws(() => new FleetRepositoryBudgetLedger({ expectedKeyIdentity: keyIdentity,
			scope: { ...scope, ...change } as FleetRepositoryBudgetScope,
			invoke: async () => ({}) }), /scope is invalid/)
	}
}

const tests: readonly SuiteTest[] = [
	["the Python bridge feeds exact v2 snapshots into a bounded local claim", pythonBridgeFeedsV2SnapshotAndLocalClaim],
	["the v2 budget ledger rejects wrong scope, profile and policy", wrongV2PolicyOrProfileIsRejected],
]

await runMain("repository-no-model-budget-v2", tests)
