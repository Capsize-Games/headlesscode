import assert from "node:assert/strict"
import { inspectLocalDockerSandboxImage, type DockerCommandResult, type DockerSandboxImageExpectation } from "../docker-sandbox-image.js"

const imageRef = `headlesscode-openshell@sha256:${"a".repeat(64)}`
const imageId = `sha256:${"b".repeat(64)}`
const sandboxId = "c5adaef3-8863-460b-ba74-3070d6788a12"
const sandboxName = "hcl-85cb35de9a0ac88"
const expectation: DockerSandboxImageExpectation = { sandboxId, sandboxName, image: imageRef, cpu: "2", memory: "4Gi" }
const workloadId = "1".repeat(64)
const supervisorId = "2".repeat(64)

function container(id: string, role: string, name: string, image = imageId, configImage = imageId, cpu = 2_000_000_000, memory = 4 * 1024 ** 3): Record<string, unknown> {
	return {
		Id: id,
		Name: `/${name}`,
		Image: image,
		Config: { Image: configImage, Labels: { "openshell.ai/sandbox-id": sandboxId, "openshell.ai/sandbox-name": sandboxName, "openshell.ai/isolation-role": role } },
		HostConfig: { NanoCpus: cpu, CpuQuota: 0, CpuPeriod: 100_000, Memory: memory },
	}
}

function runWith(containers: unknown[], localId = imageId, localRef = imageRef): (args: string[], _timeout: number, _max: number) => DockerCommandResult {
	const ids = containers.map((entry) => (entry as { Id: string }).Id)
	return (args) => {
		if (args[0] === "ps") return { status: 0, stdout: `${ids.join("\n")}\n` }
		if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify(containers) }
		if (args[0] === "image" && args[1] === "inspect" && args[2] === localRef) return { status: 0, stdout: JSON.stringify([{ Id: localId }]) }
		return { status: 1, stdout: "" }
	}
}

const tests: Array<[string, () => void]> = [
	["matches the exact workload labels and role, excluding the supervisor", () => {
		const result = inspectLocalDockerSandboxImage(expectation, runWith([
			container(supervisorId, "supervisor", "supervisor", `sha256:${"d".repeat(64)}`),
			container(workloadId, "sandbox", "workload"),
		]),)
		assert.equal(result.imageId, imageId)
		assert.equal(result.configImage, imageId)
		assert.equal(result.localImageId, imageId)
		assert.equal(result.cpuCores, 2)
		assert.equal(result.memoryBytes, 4 * 1024 ** 3)
	}],
	["accepts the exact pinned named reference in Config.Image", () => {
		const result = inspectLocalDockerSandboxImage(expectation, runWith([container(workloadId, "sandbox", "workload", imageId, imageRef)]))
		assert.equal(result.configImage, imageRef)
	}],
	["rejects missing or mismatched sandbox labels and role", () => {
		for (const candidate of [
			{ ...container(workloadId, "sandbox", "workload"), Config: { Image: imageId, Labels: { "openshell.ai/sandbox-id": sandboxId, "openshell.ai/sandbox-name": "other", "openshell.ai/isolation-role": "sandbox" } } },
			container(workloadId, "supervisor", "workload"),
		]) assert.throws(() => inspectLocalDockerSandboxImage(expectation, runWith([candidate])), /no local Docker workload/)
	}],
	["rejects duplicate workload matches", () => {
		assert.throws(() => inspectLocalDockerSandboxImage(expectation, runWith([
			container(workloadId, "sandbox", "workload"), container(supervisorId, "sandbox", "another-workload"),
		])), /multiple local Docker workload/)
	}],
	["rejects image identity and Config.Image mismatches", () => {
		assert.throws(() => inspectLocalDockerSandboxImage(expectation, runWith([container(workloadId, "sandbox", "workload", `sha256:${"c".repeat(64)}`)])), /image ID does not match/)
		assert.throws(() => inspectLocalDockerSandboxImage(expectation, runWith([container(workloadId, "sandbox", "workload", imageId, "headlesscode:latest")])), /Config.Image is not/)
	}],
	["rejects CPU and memory drift", () => {
		assert.throws(() => inspectLocalDockerSandboxImage(expectation, runWith([container(workloadId, "sandbox", "workload", imageId, imageId, 1_000_000_000)])), /CPU or memory limit/)
		assert.throws(() => inspectLocalDockerSandboxImage(expectation, runWith([container(workloadId, "sandbox", "workload", imageId, imageId, 2_000_000_000, 8 * 1024 ** 3)])), /CPU or memory limit/)
	}],
	["fails closed when local inspection is unavailable, malformed, or over bounds", () => {
		assert.throws(() => inspectLocalDockerSandboxImage(expectation, () => ({ status: 1, stdout: "" })), /enumerate local Docker/)
		assert.throws(() => inspectLocalDockerSandboxImage(expectation, (args) => args[0] === "ps" ? { status: 0, stdout: `${"f".repeat(64)}\n` } : { status: 0, stdout: "{}" }), /was not a JSON array/)
		assert.throws(() => inspectLocalDockerSandboxImage(expectation, (args) => args[0] === "ps" ? { status: 0, stdout: Array.from({ length: 201 }, () => "a".repeat(64)).join("\n") } : { status: 0, stdout: "[]" }), /verification bound/)
	}],
]

for (const [name, run] of tests) {
	run()
	console.log(`  ok   ${name}`)
}

console.log(`All ${tests.length} Docker sandbox image observer tests passed`)
