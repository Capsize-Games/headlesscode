import assert from "node:assert/strict"
import type { SuiteTest } from "../../test-runner.js"
import { runMain } from "../../test-runner.js"
import * as WorkerPipeline from "../repository-worker-pipeline.js"
import {
	assertRepairMeasured,
	buildCurlHistoricalRepairTestFixture,
	repairAdapters,
	repairClaim,
	repairDefinition,
	repairRegistration,
	recordingStore,
} from "./repository-curl-repair-support.js"

async function syntheticRepairPipelineNeverStartsAModelWorker(): Promise<
	void
> {
	const calls: string[] = []
	const candidate = await buildCurlHistoricalRepairTestFixture()
	const definition = repairDefinition()
	const adapters = repairAdapters(
		candidate,
		calls,
		definition,
		repairRegistration(definition),
		recordingStore(calls),
	)
	assertNoModelWorker(adapters)
	const result = await executePipeline(adapters, definition)
	assertRepairMeasured(result, calls)
}

function assertNoModelWorker(
	adapters: Pick<
		ReturnType<typeof repairAdapters>,
		"model" | "reservation"
	>,
): void {
	assert.equal(adapters.model, "none")
	assert.deepEqual(adapters.reservation, { micros: 1, tokens: 1 })
}

async function executePipeline(
	adapters: ReturnType<typeof repairAdapters>,
	definition: ReturnType<typeof repairDefinition>,
): Promise<{
	status: unknown
	actualMicros: unknown
	actualTokens: unknown
	accounting: unknown
}> {
	const pipeline = WorkerPipeline.createRepositoryWorkerPipeline(adapters)
	return await pipeline.execute({
		definition,
		claim: repairClaim(),
		signal: new AbortController().signal,
		progress: async () => undefined,
	})
}

const tests: readonly SuiteTest[] = [
	[
		"synthetic repair pipeline uses no model worker",
		syntheticRepairPipelineNeverStartsAModelWorker,
	],
]

await runMain("repository-curl-repair-pipeline", tests)
