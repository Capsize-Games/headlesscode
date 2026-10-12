import assert from "node:assert/strict"
import { test } from "node:test"
import { fleetPayload } from "../controller.js"
import type { CandidateRecord, RsiConfig } from "../types.js"

test("proof benchmark fixture path and package identity stay supervisor-only in candidate payloads", () => {
	const binding = { root: "/operator/private/benchmark-fixtures", manifestSha256: "a".repeat(64), snapshotPackage: { path: "snapshots", digest: "b".repeat(64) } }
	const payload = fleetPayload({
		proofBenchmarkFixtures: binding,
		model: "pinned-model",
		mutationTask: "modify one value",
		maxIterations: 1,
		commandTimeoutMs: 1000,
		protectedPaths: ["src/rsi"],
		regressionCommand: "npm test",
		evalCommands: [],
	} as unknown as RsiConfig, {
		id: "g0-candidate-0",
		generation: 0,
		parent: "root-control",
		model: "pinned-model",
		mutationKind: "corrective",
	} as CandidateRecord, { content: Buffer.from("only the assigned source tree"), snapshotCommit: "c".repeat(40) })
	assert.equal(Object.hasOwn(payload, "proofBenchmarkFixtures"), false)
	assert.equal(JSON.stringify(payload).includes(binding.root), false)
	assert.equal(JSON.stringify(payload).includes(binding.manifestSha256), false)
	assert.equal(JSON.stringify(payload).includes(binding.snapshotPackage.digest), false)
	assert.equal(payload.snapshotBytes, Buffer.byteLength("only the assigned source tree"))
})
