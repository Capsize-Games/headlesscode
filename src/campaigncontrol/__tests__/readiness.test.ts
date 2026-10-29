import assert from "node:assert/strict"
import { parseCampaignJobReport } from "../runner.js"
import { runMain, type SuiteTest } from "../../test-runner.js"

const readiness = { schemaVersion: 1 as const, configuredCount: 2, qualifiedCount: 1,
	profiles: [{ profileId: "curl-profile-v1", state: "qualified" as const },
		{ profileId: "expat-profile-v1", state: "recipe-unqualified" as const }],
	completion: { pendingHumanReview: 1, pendingHumanApproval: 0, failed: 0, deliveryPending: 1 } }

function testOldReleaseHasNoReadiness(): void {
	const report = parseCampaignJobReport({ jobs: [], jobDetailsAvailable: false })
	assert.equal(report.readiness, undefined)
}

function testValidReadinessPreservesCoverageAndCompletionCounts(): void {
	const report = parseCampaignJobReport({ jobs: [], jobDetailsAvailable: false, readiness })
	assert.deepEqual(report.readiness, readiness)
}

function testReadinessCountsAndMetadataAreStrict(): void {
	assert.throws(() => parseCampaignJobReport({ jobs: [{ jobId: "fleet-campaign-" + "a".repeat(40),
		package: "curl", advisoryId: "CVE-2026-12345", status: "queued", sourcePath: "/private" }],
		jobDetailsAvailable: true }), /job report is invalid/)
	assert.throws(() => parseCampaignJobReport({ jobs: [], jobDetailsAvailable: false,
		readiness: { ...readiness, qualifiedCount: 2 } }), /completion coverage/)
	assert.throws(() => parseCampaignJobReport({ jobs: [], jobDetailsAvailable: false,
		readiness: { ...readiness, profiles: [{ profileId: "same", state: "qualified" },
			{ profileId: "same", state: "qualified" }] } }), /profile coverage/)
	assert.throws(() => parseCampaignJobReport({ jobs: [], jobDetailsAvailable: false,
		readiness: { ...readiness, privatePath: "/private/state" } }), /readiness report is invalid/)
}

function testQualificationHistoryRemainsLabelled(): void {
	const job = { jobId: "fleet-campaign-" + "a".repeat(40), package: "expat",
		advisoryId: "CVE-2026-118370", status: "already-in-fork", purpose: "qualification" }
	const report = parseCampaignJobReport({ jobs: [job], jobDetailsAvailable: true })
	assert.equal(report.jobs[0]?.purpose, "qualification")
	assert.throws(() => parseCampaignJobReport({ jobs: [{ ...job, purpose: "run-command" }],
		jobDetailsAvailable: true }), /job report is invalid/)
}

const tests: readonly SuiteTest[] = [
	["old Fleet report remains explicitly without readiness", testOldReleaseHasNoReadiness],
	["fresh readiness report preserves safe coverage counts", testValidReadinessPreservesCoverageAndCompletionCounts],
	["readiness rejects malformed counts, duplicate profiles, and private extras", testReadinessCountsAndMetadataAreStrict],
	["qualification history keeps its label without expanding accepted purposes", testQualificationHistoryRemainsLabelled],
]
runMain("campaign-control-readiness", tests)
