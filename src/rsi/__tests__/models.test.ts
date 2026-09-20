import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { baseModelCandidate, createCombination, ExternalTrainingBackend, factorialCombinations, modelCombinationId } from "../models.js"

async function main(): Promise<void> {
	const base = baseModelCandidate("wxrq-qwen3.5-9b:latest", "now")
	assert.equal(base.status, "base")
	assert.equal(modelCombinationId("h1", base.id), "h1::model-base")
	assert.equal(createCombination("h1", base.id, "now").status, "planned")
	assert.equal(factorialCombinations(["h1", "h2"], ["m1", "m2"], "now").length, 4)

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-model-"))
	try {
		const artifact = path.join(dir, "adapter.bin")
		await fs.writeFile(artifact, "adapter")
		const inspected = await new ExternalTrainingBackend().inspectArtifact(artifact)
		assert.equal(inspected.bytes, 7)
		assert.equal(inspected.hash.length, 64)
		const result = await new ExternalTrainingBackend().train({ method: "lora" }, dir)
		assert.equal(result.ok, false)
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
	console.log("All 4 RSI model tests passed")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
