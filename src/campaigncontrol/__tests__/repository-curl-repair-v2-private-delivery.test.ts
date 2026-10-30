import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { deliverVerifiedCurlHistoricalRepairV2 } from
	"../repository-curl-repair-v2-private-delivery.js"
import {
	CURL_REPAIR_SOURCE_TREE_SHA,
	curlHistoricalRepairCandidateSha256,
} from "../repository-curl-repair.js"
import {
	makeDeliveryDependencies,
	type DeliveryFixture,
} from "./repository-curl-repair-v2-delivery-test-support.js"
import { makeDeliveryFixture } from
	"./repository-curl-repair-v2-delivery-evidence-fixture.js"
import { runMain, type SuiteTest } from "../../test-runner.js"


async function deliveryIsIdempotentForAlreadyFixedTarget(): Promise<void> {
	await withFixture(async (root, fixture) => {
		const dependencies = makeDeliveryDependencies(
			root, path.join(root, "private-state"), fixture, true,
		)
		const first = await deliverVerifiedCurlHistoricalRepairV2(
			fixture.input, dependencies,
		)
		const second = await deliverVerifiedCurlHistoricalRepairV2(
			fixture.input, dependencies,
		)
		assert.equal(first.accepted, true)
		assert.equal(first.boardRef, second.boardRef)
		assert.equal(dependencies.postCount(), 1)
	})
}

async function mismatchedClaimCannotPost(): Promise<void> {
	await withFixture(async (root, fixture) => {
		const wrong = structuredClone(fixture.input)
		wrong.claim.claimId = "33333333-3333-4333-8333-333333333333"
		const dependencies = makeDeliveryDependencies(
			root, path.join(root, "state"), fixture,
		)
		await assert.rejects(
			deliverVerifiedCurlHistoricalRepairV2(wrong, dependencies),
			/claim and candidate bindings|not bound to this job/,
		)
		assert.equal(dependencies.postCount(), 0)
	})
}

async function historicalTreePinRejectsPrivateTree(): Promise<void> {
	await withFixture(async (root, fixture) => {
		const candidate = fixture.input.verification.historicalRepairV2!.candidate
		candidate.sourceTreeSha = CURL_REPAIR_SOURCE_TREE_SHA
		fixture.input.candidateSha256 = curlHistoricalRepairCandidateSha256(candidate)
		const deps = makeDeliveryDependencies(root, path.join(root, "state"), fixture)
		await assert.rejects(
			deliverVerifiedCurlHistoricalRepairV2(fixture.input, deps),
			/candidate pins differ/)
		assert.equal(deps.postCount(), 0)
	})
}

async function staleOrForgedReceiptCannotPost(): Promise<void> {
	await withFixture(async (root, fixture) => {
		const deps = makeDeliveryDependencies(
			root, path.join(root, "state"), fixture,
		)
		fixture.workerStage.receipt.created_at_unix = 1
		await assert.rejects(
			deliverVerifiedCurlHistoricalRepairV2(fixture.input, deps),
			/stale/)
		fixture.workerStage.receipt.created_at_unix = Math.floor(Date.now() / 1000)
		const evidence = fixture.input.verification.historicalRepairV2!
		evidence.receipt.execution.evaluatorDigest = "forged"
		await assert.rejects(
			deliverVerifiedCurlHistoricalRepairV2(fixture.input, deps),
			/not bound to this job/)
		assert.equal(deps.postCount(), 0)
	})
}

async function withFixture(
	callback: (root: string, fixture: DeliveryFixture) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "curl-v2-"))
	try {
		await callback(root, await makeDeliveryFixture())
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
}

const tests: readonly SuiteTest[] = [
	[
		"v2 delivery recovers a lost acknowledgement without duplication",
		deliveryIsIdempotentForAlreadyFixedTarget,
	],
	[
		"v2 private delivery rejects mismatched claims before posting",
		mismatchedClaimCannotPost,
	],
	[
		"v2 candidate pin rejects private checkout tree substitution",
		historicalTreePinRejectsPrivateTree,
	],
	[
		"v2 delivery rejects stale or forged signed evidence",
		staleOrForgedReceiptCannotPost,
	],
]

await runMain("repository-curl-repair-v2-private-delivery", tests)
