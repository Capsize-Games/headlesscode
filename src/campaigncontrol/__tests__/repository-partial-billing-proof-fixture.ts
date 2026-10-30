import { existsSync } from "node:fs"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import type {
	RepositoryCampaignDefinition,
} from "../repository-campaigns.js"
import type {
	FleetRepositoryBudgetScope,
	FleetRepositoryClosedSessionProof,
} from "../../rsi/fleet-repository-budget-ledger.js"

export const jobId = "739886c8-2adc-4e4d-9f8d-42fa1d7153ab"
export const claimId = "b16e3390-55b9-4d7f-a5bc-f8119b91598c"

export const definition: RepositoryCampaignDefinition = {
	id: "curl-maintenance",
	name: "Curl qualification",
	repositoryId: "curl-maintenance",
	repository: "Capsize-Games/curl-maintenance",
	sourceRevision: "3".repeat(40),
	policySha256: "c".repeat(64),
	workerProfile: "curl-published-advisory-v1",
	recipeDigest: "e".repeat(64),
	evaluatorDigest: "f".repeat(64),
	model: "meta/muse-spark-1.3-contributor",
	dataAccessProfile: "public-upstream-source-and-published-advisory-only",
	qualification: {
		sourceAudited: true,
		workerQualified: true,
		recipeQualified: true,
		evaluatorQualified: true,
		modelApproved: true,
		dataApproved: true,
		accessApproved: true,
	},
}

export const scope: FleetRepositoryBudgetScope = {
	repositoryCampaignId: definition.id,
	repositoryId: definition.repositoryId!,
	repository: definition.repository!,
	sourceRevision: definition.sourceRevision!,
	policySha256: definition.policySha256!,
	model: "meta/muse-spark-1.3-contributor",
	profileId: "muse-spark-contributor",
	repositoryEpoch: 1,
}

function makeCall(
	callId: string,
	attemptId: string,
	requestSha256: string,
	actualMicros: number,
	actualTokens: number,
): FleetRepositoryClosedSessionProof["calls"][number] {
	return {
		callId,
		attemptId,
		requestSha256,
		reservedMicros: 4_000,
		reservedTokens: 36_000,
		actualMicros,
		actualTokens,
		settlement: {},
	}
}

export const proof: FleetRepositoryClosedSessionProof = {
	schemaVersion: 1,
	campaignId: "fleet-security-watch",
	repositoryCampaignId: scope.repositoryCampaignId,
	repositoryId: scope.repositoryId,
	repository: scope.repository,
	sourceRevision: scope.sourceRevision,
	policySha256: scope.policySha256,
	repositoryEpoch: scope.repositoryEpoch,
	model: scope.model,
	profileId: scope.profileId,
	keyIdentity: "a".repeat(64),
	jobId,
	asOfMs: Date.now(),
	grant: {
		grantSha256: "b".repeat(64),
		runId: "run-123",
		controlEpoch: 23,
		issuedAtMs: Date.now() - 400_000,
		deadlineAtMs: Date.now() - 100_000,
		limits: {},
	},
	calls: [
		makeCall("call-1", "attempt-1", "c".repeat(64), 220, 3_000),
		makeCall("call-2", "attempt-2", "d".repeat(64), 273, 3_064),
	],
	denials: [{ statusCode: 429, reason: "budget-or-fence", count: 1 }],
	settledMicros: 493,
	settledTokens: 6_064,
	proofSha256: "f".repeat(64),
}

const proofScript = [
	"import json, sys, time, hashlib, sqlite3",
	"from contextlib import closing",
	"from unittest.mock import patch",
	"from fleet_watch.test_repository_campaign_budget_bridge import (",
	" RepositoryBudgetBridgeTests, BridgeError)",
	"case = RepositoryBudgetBridgeTests(); case.setUp()",
	"try:",
	" bridge, identity = case.closed_session_fixture(job=sys.argv[1])",
	" base = time.time()",
	" with patch('operations.campaign_budget_bridge.time.time',",
	"            side_effect=[base, base + 2]):",
	"  request = {**identity, 'op': 'repository-closed-session-proof'}",
	"  first = bridge.dispatch(request)",
	"  second = bridge.dispatch(request)",
	" with closing(sqlite3.connect(bridge.path)) as db:",
	"  query = 'UPDATE calls SET request_sha=? WHERE job_id=? AND call_id=?'",
	"  values = ('f'*64, identity['jobId'], 'qualification-call-1')",
	"  db.execute(query, values); db.commit()",
	" call_changed = bridge.dispatch(request)",
	" with closing(sqlite3.connect(bridge.path)) as db:",
	"  query = ('SELECT run_id,control_epoch,issued_at_ms,deadline_at_ms,'",
	"           'limits_json FROM grants WHERE job_id=?')",
	"  row = db.execute(query, (identity['jobId'],)).fetchone()",
	"  run_id = 'run-proof-changed'; limits = json.loads(row[4])",
	"  binding = {'jobId':identity['jobId'], 'campaignId':'fleet-security-watch',",
	"   'keyIdentity':identity['keyIdentity'], 'model':identity['model'],",
	"   'profileId':identity['profileId'], 'runId':run_id, 'controlEpoch':row[1],",
	"   'issuedAtMs':row[2], 'deadlineAtMs':row[3], 'limits':limits,",
	"   'repository':identity['repository'],",
	"   'repositoryCampaignId':identity['repositoryCampaignId'],",
	"   'repositoryId':identity['repositoryId'],",
	"   'sourceRevision':identity['sourceRevision'],",
	"   'policySha256':identity['policySha256'],",
	"   'repositoryEpoch':identity['repositoryEpoch']} ",
	"  encoded = json.dumps(binding, sort_keys=True, separators=(',', ':'))",
	"  digest = hashlib.sha256(encoded.encode()).hexdigest()",
	"  query = 'UPDATE grants SET run_id=?,grant_sha256=? WHERE job_id=?'",
	"  db.execute(query, (run_id, digest, identity['jobId']))",
	"  db.commit()",
	" grant_changed = bridge.dispatch(request)",
	" with closing(sqlite3.connect(bridge.path)) as db:",
	"  query = 'UPDATE denials SET reason=? WHERE job_id=?'",
	"  db.execute(query, ('invalid-request', identity['jobId']))",
	"  db.commit()",
	" try:",
	"  bridge.dispatch(request)",
	"  denial_rejected = False",
	" except BridgeError:",
	"  denial_rejected = True",
	" rows = [first, second, call_changed, grant_changed]",
	" print(json.dumps({'proofs': rows,",
	"                   'denialRejected': denial_rejected}))",
	"finally: case.doCleanups()",
].join("\n")

function privateFleetRoot(): string {
	const root = process.env.FLEET_SOURCE_ROOT ??
		"/home/joe/Projects/fleet-security-watch"
	const bridgeFile = "operations/campaign_budget_bridge.py"
	const fixtureFile = "fleet_watch/test_repository_campaign_budget_bridge.py"
	if (!existsSync(path.join(root, bridgeFile)) ||
		!existsSync(path.join(root, fixtureFile))) {
		throw new Error("private Fleet bridge source is unavailable")
	}
	const remote = spawnSync("git", ["remote", "get-url", "origin"], {
		cwd: root,
		encoding: "utf8",
		timeout: 2_000,
	})
	if (remote.status !== 0 || !isFleetPrivateRemote(remote.stdout.trim())) {
		throw new Error("closed-session fixture requires the private Fleet copy")
	}
	return root
}

function isFleetPrivateRemote(remote: string): boolean {
	const remotes = [
		/^git@github\.com:Capsize-Games\/fleet-security-watch\.git$/,
		/^https:\/\/github\.com\/Capsize-Games\/fleet-security-watch\.git$/,
	]
	return remotes.some((pattern) => pattern.test(remote))
}

export function genuineFleetProofs(
	job: string,
): FleetRepositoryClosedSessionProof[] {
	const root = privateFleetRoot()
	const child = spawnSync("/usr/bin/python3", ["-c", proofScript, job], {
		cwd: root,
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1" },
	})
	if (child.error || child.status !== 0) {
		throw new Error("real Fleet proof fixture failed")
	}
	return parseProofOutput(child.stdout)
}

function parseProofOutput(stdout: string): FleetRepositoryClosedSessionProof[] {
	const result = JSON.parse(stdout) as {
		proofs: FleetRepositoryClosedSessionProof[]
		denialRejected: boolean
	}
	assert.equal(result.denialRejected, true)
	return result.proofs
}
