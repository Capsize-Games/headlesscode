import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import * as Delivery from "../repository-curl-repair-delivery.js"

import type * as Repair from "../repository-curl-repair.js"
import {
	claim,
	makeReceipt,
} from "./repository-curl-repair-delivery-fixture.js"

export { assert, createHash, os, path }
export * from "../repository-curl-repair-delivery.js"
export * from "../repository-curl-repair-evaluator.js"
export * from "../repository-curl-repair.js"
export { CURL_FIXED_ADVISORY } from "../repository-curl-evaluator.js"
export {
	branch,
	claim,
	fixture,
	jobId,
	makeCandidate,
	makeReceipt,
	repo,
} from "./repository-curl-repair-delivery-fixture.js"
export { runMain } from "../../test-runner.js"
export type { SuiteTest } from "../../test-runner.js"
type Candidate = Repair.CurlHistoricalRepairCandidate

export function makeRepairRequest(
	candidate: Candidate,
): Delivery.CurlRepairDeliveryInput {
	return { claim, candidate, receipt: makeReceipt(candidate) }
}

export function deliverFixture(
	candidate: Candidate,
	dependencies: Delivery.CurlRepairDeliveryDependencies,
): Promise<Delivery.CurlRepairDeliveryReceipt> {
	return Delivery.deliverVerifiedCurlRepairDraft(
		makeRepairRequest(candidate),
		dependencies,
	)
}
