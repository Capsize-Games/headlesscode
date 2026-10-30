import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { RepositoryCampaignStore, type RepositoryBudgetAuthority, type RepositoryCampaignDefinition } from "../repository-campaigns.js"
import { CURL_CAMPAIGN_POLICY_SHA256 } from "../repository-curl-runtime.js"
import { CURL_EVALUATOR_DIGEST, CURL_FIXED_ADVISORY, CURL_PRIVATE_SOURCE_REVISION, CURL_WORKER_DIGEST } from "../repository-curl-evaluator.js"
import { CURL_DEBIAN_AFFECTED_RANGE, CURL_DEBIAN_PUBLIC_BASE_REVISION, CURL_DEBIAN_SNAPSHOT_SHA256,
	CURL_DEBIAN_SOURCE_HTML_SHA256, CURL_DEBIAN_SOURCE_URL } from "../repository-known-advisory.js"

const qualified = { sourceAudited: true, workerQualified: true, recipeQualified: true, evaluatorQualified: true,
	modelApproved: true, dataApproved: true, accessApproved: true }
const definition: RepositoryCampaignDefinition = { id: "curl-maintenance", name: "Curl published advisory",
	repositoryId: "curl-maintenance", repository: "Capsize-Games/curl-maintenance", sourceRevision: CURL_PRIVATE_SOURCE_REVISION,
	policySha256: CURL_CAMPAIGN_POLICY_SHA256, workerProfile: "curl-published-advisory-v1", recipeDigest: CURL_WORKER_DIGEST,
	evaluatorDigest: CURL_EVALUATOR_DIGEST, model: "meta/muse-spark-1.3-contributor",
	dataAccessProfile: "public-upstream-source-and-published-advisory-only", qualification: qualified }
const empty = { settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0, settledTokens: 0, reservedTokens: 0, ambiguousTokens: 0 }
function authority(): RepositoryBudgetAuthority {
	const now = Date.now()
	return { mode: "fleet-v2", available: true, limitMicros: 20_000, limitTokens: 108_000,
		committedMicros: 0, committedTokens: 0, asOfMs: now, campaignId: "fleet-security-watch", globalEnabled: true,
		canAdmit: true, controlEpoch: 1, runId: "run-retry-test", runExpiresAtMs: now + 60_000,
		repositoryCampaignId: definition.id, repositoryId: definition.repositoryId!, repository: definition.repository!,
		sourceRevision: definition.sourceRevision!, policySha256: definition.policySha256!, model: definition.model!,
		profileId: "muse-spark-contributor", repositoryEnabled: true, repositoryEpoch: 1,
		monthly: { month: new Date(now).toISOString().slice(0, 7), limitMicros: 5_000_000, settledMicros: 0, reservedMicros: 0, ambiguousMicros: 0 },
		campaignLifetime: { limitMicros: 20_000, limitTokens: 108_000, ...empty }, legacyLifetime: { ...empty },
		repositoryLifetime: { limitMicros: 18_000, limitTokens: 90_000, ...empty } }
}

test("only one explicit child retry follows a recovered zero-cost Curl qualification", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-no-call-retry-")); t.after(() => fs.rm(root, { recursive: true, force: true }))
	await fs.chmod(root, 0o700)
	const store = new RepositoryCampaignStore(path.join(root, "campaigns.json"), [definition], () => authority())
	const now = new Date()
	await store.setCampaignBudget(definition.id, 18_000, 90_000, now)
	await store.start(definition.id, now)
	const parent = await store.enqueueKnownQualification({ campaignId: definition.id, advisoryId: CURL_FIXED_ADVISORY,
		publicBaseRevision: CURL_DEBIAN_PUBLIC_BASE_REVISION, snapshotSha256: CURL_DEBIAN_SNAPSHOT_SHA256,
		sourceUrl: CURL_DEBIAN_SOURCE_URL, sourceContentSha256: CURL_DEBIAN_SOURCE_HTML_SHA256, affectedRange: CURL_DEBIAN_AFFECTED_RANGE }, now)
	const claim = await store.claimNext(definition.id, { micros: 8_000, tokens: 72_000 }, now, { executionKind: "live-cve" })
	assert.ok(claim)
	await store.finish(claim!, { status: "ambiguous" }, now)
	const proofSha256 = "9".repeat(64)
	await store.settleRecoveredClaim(claim!, { status: "failed", actualMicros: 0, actualTokens: 0, proofSha256 }, new Date(now.getTime() + 1))
	const snapshot = await authority()
	const child = await store.enqueueVerifiedNoCallRetry(parent.id, `CONFIRM RETRY NO-CALL ${parent.id}`, new Date(snapshot.asOfMs!))
	assert.equal(child.retryOf, parent.id)
	assert.notEqual(child.id, parent.id)
	await assert.rejects(store.enqueueVerifiedNoCallRetry(parent.id, `CONFIRM RETRY NO-CALL ${parent.id}`), /already has a retry child/)
	const status = await store.status() as { jobs: Array<Record<string, unknown>>; intakeRecords: Array<Record<string, unknown>>; budget: Record<string, number> }
	assert.equal(status.jobs.filter((job) => job.id === parent.id).length, 1)
	assert.equal(status.jobs.find((job) => job.id === parent.id)?.status, "failed")
	assert.equal(status.jobs.find((job) => job.id === parent.id)?.settledMicros, 0)
	assert.equal(status.jobs.find((job) => job.id === child.id)?.retryOf, parent.id)
	assert.equal(status.intakeRecords.length, 1, "retry preserves the original intake record")
	assert.equal(status.budget.ambiguousMicros, 0)
	assert.equal(status.budget.ambiguousTokens, 0)
})
