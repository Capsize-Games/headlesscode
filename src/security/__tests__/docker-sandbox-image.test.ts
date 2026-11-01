import assert from "node:assert/strict"
import { inspectLocalDockerSandboxImage } from "../docker-sandbox-image.js"
import {
	container,
	expectation,
	expectThrow,
	fixedRunner,
	foreignImage,
	imageId,
	imageRef,
	otherImage,
	overBoundIds,
	runWith,
	sandboxName,
	supervisorId,
	variantContainer,
	workloadId,
	wrongImage,
} from "./docker-sandbox-image-support.js"

const tests: Array<[string, () => void]> = [
	["filters Docker to exact workload labels", () => {
		const result = inspectLocalDockerSandboxImage(
			expectation,
			runWith([
				container(supervisorId, "supervisor", "supervisor", otherImage),
				container(workloadId, "sandbox", "workload"),
				variantContainer(
					"3".repeat(64), "sandbox", "unrelated", foreignImage,
					"other-sandbox",
				),
			]),
		)
		assert.equal(result.imageId, imageId)
		assert.equal(result.configImage, imageId)
		assert.equal(result.localImageId, imageId)
		assert.equal(result.cpuCores, 2)
		assert.equal(result.memoryBytes, 4 * 1024 ** 3)
	}],
	["accepts the exact pinned named reference in Config.Image", () => {
		const result = inspectLocalDockerSandboxImage(
			expectation,
			runWith([
				container(workloadId, "sandbox", "workload", imageId, imageRef),
			]),
		)
		assert.equal(result.configImage, imageRef)
	}],
	["revalidates exact labels after Docker filtering", () => {
		for (const candidate of [
			variantContainer(workloadId, "sandbox", "workload", imageId, "other"),
			variantContainer(
				workloadId, "supervisor", "workload", imageId, sandboxName,
			),
		]) {
			expectThrow(
				fixedRunner(`${workloadId}\n`, JSON.stringify([candidate])),
				/no local Docker workload/,
			)
		}
	}],
	["rejects duplicate workload matches", () => {
		expectThrow(
			runWith([
				container(workloadId, "sandbox", "workload"),
				container(supervisorId, "sandbox", "another-workload"),
			]),
			/multiple local Docker workload/,
		)
	}],
	["rejects image identity and Config.Image mismatches", () => {
		expectThrow(
			runWith([container(workloadId, "sandbox", "workload", wrongImage)]),
			/image ID does not match/,
		)
		expectThrow(
			runWith([
				container(
					workloadId, "sandbox", "workload", imageId, "headlesscode:latest",
				),
			]),
			/Config.Image is not/,
		)
	}],
	["rejects CPU and memory drift", () => {
		expectThrow(
			runWith([
				container(
					workloadId, "sandbox", "workload", imageId, imageId, 1_000_000_000,
				),
			]),
			/CPU or memory limit/,
		)
		expectThrow(
			runWith([
				container(
					workloadId, "sandbox", "workload", imageId, imageId,
					2_000_000_000, 8 * 1024 ** 3,
				),
			]),
			/CPU or memory limit/,
		)
	}],
	["fails closed when enumeration fails", () => {
		expectThrow(
			() => ({ status: 1, stdout: "" }),
			/enumerate matching local Docker/,
		)
	}],
	["fails closed on malformed inspection", () => {
		expectThrow(
			fixedRunner(`${"f".repeat(64)}\n`, "{}"),
			/was not a JSON array/,
		)
	}],
	["fails closed when results exceed bounds", () => {
		expectThrow(fixedRunner(overBoundIds(), "[]"), /verification bound/)
	}],
]

for (const [name, run] of tests) {
	run()
	console.log(`  ok   ${name}`)
}

console.log(`All ${tests.length} Docker sandbox image observer tests passed`)
