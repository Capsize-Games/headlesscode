import assert from "node:assert/strict"
import type {
	CurlHistoricalRepairCandidate,
} from "../repository-curl-repair.js"
import {
	evaluateCurlHistoricalRepairCandidate,
} from "../repository-curl-repair-evaluator.js"
import type {
	CurlProtectedEvaluationResult,
} from "../repository-curl-evaluator.js"
import type {
	CurlRepairDeliveryInput, CurlRepairDeliveryReceipt,
} from "../repository-curl-repair-delivery-model.js"
import {
	CURL_REPAIR_ADAPTER_ID,
} from "../repository-curl-repair.js"
import type {
	KnownCurlDebianAdvisory,
} from "../repository-known-advisory.js"
import type {
	RepositoryPipelineAdapterFactory,
} from "../repository-worker-registry.js"
import { repairFactory } from "./curl-repair-intake-fixtures.js"
import {
	repairAdvisoryInput, type RepairAdvisoryInput,
} from "./repository-curl-repair-store-phases.js"

export { repairAdvisoryInput, type RepairAdvisoryInput }

export interface IntakeCounters {
	polls: number
	sourceChecks: number
	evaluatorCalls: number
	deliveryCalls: number
}

export function freshCounters(): IntakeCounters {
	return { polls: 0, sourceChecks: 0, evaluatorCalls: 0, deliveryCalls: 0 }
}

async function fixedProofReceipt(): Promise<CurlProtectedEvaluationResult> {
	return {
		schemaVersion: 1,
		accepted: true,
		disposition: "already-fixed",
		evidenceSha256: "a".repeat(64),
		reasonCode: "fixed-proof-verified",
	}
}

async function evaluateFixedReceipt(
	input: Parameters<typeof evaluateCurlHistoricalRepairCandidate>[0],
	candidate: CurlHistoricalRepairCandidate,
	counters: IntakeCounters,
): ReturnType<typeof evaluateCurlHistoricalRepairCandidate> {
	counters.evaluatorCalls += 1
	return evaluateCurlHistoricalRepairCandidate({
		...input,
		buildCandidate: async () => candidate,
		evaluateFixedProof: fixedProofReceipt,
	})
}

async function deliverFixedReceipt(
	received: CurlRepairDeliveryInput,
	candidate: CurlHistoricalRepairCandidate,
	counters: IntakeCounters,
): Promise<CurlRepairDeliveryReceipt> {
	assert.equal(received.claim.job.purpose, "repair")
	assert.equal(received.candidate.patchSha256, candidate.patchSha256)
	counters.deliveryCalls += 1
	return {
		accepted: true,
		disposition: "already-fixed",
		evidenceSha256: "d".repeat(64),
		privateRef: null,
		reasonCode: "candidate-already-in-private-base",
	}
}

export function intakeFactories(
	candidate: CurlHistoricalRepairCandidate,
	advisory: KnownCurlDebianAdvisory,
	counters: IntakeCounters,
): Map<string, RepositoryPipelineAdapterFactory> {
	return new Map([[CURL_REPAIR_ADAPTER_ID, repairFactory({
		buildCandidate: async () => candidate,
		loadAdvisory: async () => {
			counters.polls += 1
			return advisory
		},
		verifySource: async () => {
			counters.sourceChecks += 1
		},
		evaluateCandidate: (input) => evaluateFixedReceipt(input,
			candidate, counters),
		deliverRepair: (received) => deliverFixedReceipt(received,
			candidate, counters),
	})]])
}
