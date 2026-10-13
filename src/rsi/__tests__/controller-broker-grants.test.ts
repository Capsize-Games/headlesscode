import assert from "node:assert/strict"

import { runMain } from "../../test-runner.js"
import {
	admitMutationGrant,
	type MutationGrantArgs,
} from "../controller-broker-grants.js"
import { fleetPayloadDigest, type FleetJobPayload } from "../postgres-queue.js"
import type {
	PostgresProofCampaign,
	ProofCampaignArmLease,
} from "../proof-campaign.js"
import { candidate, metrics } from "./fixtures.js"

function limits(): Record<string, number | string> {
	return {
		campaignId: "campaign",
		maxCalls: 4,
		maxInputTokensPerCall: 100,
		maxOutputTokensPerCall: 100,
		maxTotalTokens: 400,
		maxDurationMs: 1000,
		maxRequestBytes: 1000,
		maxResponseBytes: 1000,
		maxInputPricePerMillionUsd: 1,
		maxOutputPricePerMillionUsd: 1,
		maxCallSpendUsd: 1,
		maxJobSpendUsd: 2,
		maxCampaignSpendUsd: 10,
	}
}

function payload(task: string, withLimits: boolean): FleetJobPayload {
	return {
		schemaVersion: 1,
		snapshotSha256: "snap",
		snapshotBytes: 1,
		snapshotCommit: "base",
		task,
		model: "qwen",
		...(withLimits ? { inferenceLimits: limits() } : {}),
	} as FleetJobPayload
}

function lease(): ProofCampaignArmLease {
	return { campaignId: "c", armId: "a", epoch: 1 } as ProofCampaignArmLease
}

function fakeStore(status: string): {
	store: PostgresProofCampaign
	admitted: unknown[]
	dispatched: Array<{ key: string; jobId?: string }>
} {
	const admitted: unknown[] = []
	const dispatched: Array<{ key: string; jobId?: string }> = []
	const store = {
		admit: async (_lease: unknown, input: unknown) => {
			admitted.push(input)
			return { duplicate: false, status }
		},
		markDispatched: async (_lease: unknown, key: string, jobId?: string) => {
			void dispatched.push({ key, jobId })
		},
	} as unknown as PostgresProofCampaign
	return { store, admitted, dispatched }
}

function baseArgs(store: PostgresProofCampaign): MutationGrantArgs {
	return {
		store,
		lease: lease(),
		attemptKey: "run:c:mutation",
		slotId: "g1-01",
		candidate: candidate("c", metrics({}), 80),
		seed: "seed",
		payload: payload("mutate", true),
	}
}

async function missingLimitsThrows(): Promise<void> {
	const { store } = fakeStore("admitted")
	await assert.rejects(
		admitMutationGrant({ ...baseArgs(store), payload: payload("mutate", false) }),
		/proof campaign mutation has no bounded broker limits/,
	)
}

async function admitsAndMarksDispatched(): Promise<void> {
	const { store, admitted, dispatched } = fakeStore("admitted")
	await admitMutationGrant(baseArgs(store))
	assert.equal(admitted.length, 1)
	const input = admitted[0] as Record<string, unknown>
	assert.equal(input.attemptKey, "run:c:mutation")
	assert.equal(input.calls, 4)
	assert.equal(input.tokens, 400)
	assert.equal(input.spendUsd, 2)
	assert.equal(dispatched.length, 1)
	assert.equal(dispatched[0].key, "run:c:mutation")
	assert.equal(dispatched[0].jobId, undefined)
}

async function completedAdmissionSkipsDispatch(): Promise<void> {
	const { store, dispatched } = fakeStore("completed")
	await admitMutationGrant(baseArgs(store))
	assert.equal(dispatched.length, 0)
}

async function existingJobBindsJobIdAndDigest(): Promise<void> {
	const { store, admitted, dispatched } = fakeStore("admitted")
	const prior = payload("older", true)
	const existing = { jobId: "job-1", status: "completed", payload: prior }
	await admitMutationGrant({
		...baseArgs(store),
		existing: existing as never,
	})
	const input = admitted[0] as Record<string, unknown>
	assert.equal(input.jobId, "job-1")
	assert.equal(input.requestSha256, fleetPayloadDigest(prior))
	assert.equal(dispatched[0].jobId, "job-1")
}

async function liveExistingDigestsNewPayload(): Promise<void> {
	const { store, admitted } = fakeStore("admitted")
	const args = baseArgs(store)
	const prior = payload("older", true)
	const existing = { jobId: "job-2", status: "running", payload: prior }
	await admitMutationGrant({ ...args, existing: existing as never })
	const input = admitted[0] as Record<string, unknown>
	assert.equal(input.requestSha256, fleetPayloadDigest(args.payload))
}

const tests: Array<[string, () => Promise<void>]> = [
	["missing limits throws", missingLimitsThrows],
	["admits and marks dispatched", admitsAndMarksDispatched],
	["completed admission skips dispatch", completedAdmissionSkipsDispatch],
	["existing job binds job id and digest", existingJobBindsJobIdAndDigest],
	["live existing digests new payload", liveExistingDigestsNewPayload],
]

runMain("controller-broker-grants", tests)
