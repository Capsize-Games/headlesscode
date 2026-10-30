import assert from "node:assert/strict"
import { test } from "node:test"
import {
	type FixtureOptions,
	assertPaidSettlement,
	cleanFixture,
	fixture,
	runRecovery,
} from "./repository-partial-billing-recovery-fixture.js"
import { reconcileClosedCurlQualificationBilling } from
	"../repository-partial-billing-recovery.js"
import {
	genuineFleetProofs,
	jobId,
	proof,
} from "./repository-partial-billing-proof-fixture.js"
import type { FleetRepositoryClosedSessionProof } from
	"../../rsi/fleet-repository-budget-ledger.js"

test("fresh real proofs settle measured usage", async (t) => {
	const proofReads = genuineFleetProofs(jobId)
	const [first, second] = proofReads
	assert.notEqual(first!.asOfMs, second!.asOfMs)
	assert.notEqual(first!.proofSha256, second!.proofSha256)
	const f = await fixture({
		proofReads: proofReads.slice(0, 2),
		verifyFleetProofs: true,
	})
	await cleanFixture(t, f)
	await runRecovery(f)
	assert.equal(f.proofCalls(), 2)
	await assertPaidSettlement(f, second!.proofSha256)
})

test("changed valid call and grant proofs cannot settle", async (t) => {
	const reads = genuineFleetProofs(jobId)
	for (const changed of [reads[2]!, reads[3]!]) {
		const f = await fixture({
			proofReads: [reads[0]!, changed],
			verifyFleetProofs: true,
		})
		await cleanFixture(t, f)
		await assert.rejects(runRecovery(f), /proof changed before settlement/)
		assert.equal(f.proofCalls(), 2)
		assert.equal(f.settlement(), undefined)
	}
})

test("active runs and mismatched proof data stay held", async (t) => {
	const cases: FixtureOptions[] = [
		{ activeRun: true },
		{ activeJobs: true },
		{ proof: { ...proof, jobId: "other-job" } },
		{ proof: { ...proof, settledMicros: 494 } },
	]
	for (const options of cases) {
		const f = await fixture(options)
		await cleanFixture(t, f)
		await assert.rejects(runRecovery(f))
		assert.equal(f.settlement(), undefined)
	}
})

test("confirmation is checked before any proof read", async (t) => {
	const f = await fixture()
	await cleanFixture(t, f)
	await assert.rejects(
		reconcileClosedCurlQualificationBilling(jobId, "CONFIRM", f.dependencies),
		/explicit partial billing confirmation/,
	)
	assert.equal(f.proofCalls(), 0)
	assert.equal(f.settlement(), undefined)
})
