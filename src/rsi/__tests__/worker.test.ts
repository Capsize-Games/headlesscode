import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { externalizeEvaluationOutputs, runRsiWorker } from "../worker.js"

test("RSI worker refuses to register more active slots than its serial OpenShell loop can execute", async () => {
	const queue = { artifactBackend: "s3" } as unknown as Parameters<typeof runRsiWorker>[0]["queue"]
	await assert.rejects(runRsiWorker({
		queue,
		workerId: "worker-one",
		gatewayId: "gateway-one",
		maxActive: 2,
		resourceClasses: ["LOCAL_GPU", "CPU"],
		scratchRoot: "/tmp/rsi-worker-test",
	}), /currently runs one guest at a time; configure maxActive=1/)
})

test("worker keeps large visible-test output in a content-addressed artifact", async () => {
	const full = "visible-test-output\n".repeat(450_000)
	let uploaded: Buffer | undefined
	const queue = {
		async putArtifact(content: Buffer) {
			uploaded = Buffer.from(content)
			return { sha256: createHash("sha256").update(content).digest("hex"), byteLength: content.byteLength }
		},
	} as unknown as Parameters<typeof externalizeEvaluationOutputs>[0]
	const result = await externalizeEvaluationOutputs(queue, {
		regression: { ok: false, command: "node test.js", exitCode: 1, durationMs: 10, stdout: full, stderr: full },
		visible: [],
	})
	assert.ok(uploaded)
	assert.ok(uploaded.byteLength > 16 * 1024 * 1024)
	assert.equal(createHash("sha256").update(uploaded).digest("hex"), result.outputArtifact.sha256)
	assert.equal(result.outputArtifact.bytes, uploaded.byteLength)
	assert.ok(result.evaluation.regression.stdout.length <= 2048)
	assert.ok(result.evaluation.regression.stderr.length <= 2048)
	assert.equal(result.evaluation.regression.outputArtifactSha256, result.outputArtifact.sha256)
	assert.ok(JSON.stringify(result).length < 10_000, "database result should contain only bounded previews and the artifact reference")
	const unpacked = JSON.parse(uploaded.toString("utf8")) as Array<{ stdout: string; stderr: string }>
	assert.equal(unpacked[0].stdout, full)
	assert.equal(unpacked[0].stderr, full)
})
