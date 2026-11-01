import assert from "node:assert/strict"
import { inspectLocalDockerSandboxImage } from "../docker-sandbox-image.js"
import type {
	DockerCommandResult,
	DockerCommandRunner,
	DockerSandboxImageExpectation,
} from "../docker-sandbox-image.js"

export const imageRef = `headlesscode-openshell@sha256:${"a".repeat(64)}`
export const imageId = `sha256:${"b".repeat(64)}`
const sandboxId = "c5adaef3-8863-460b-ba74-3070d6788a12"
export const sandboxName = "hcl-85cb35de9a0ac88"
export const otherImage = `sha256:${"d".repeat(64)}`
export const foreignImage = `sha256:${"e".repeat(64)}`
export const wrongImage = `sha256:${"c".repeat(64)}`
export const workloadId = "1".repeat(64)
export const supervisorId = "2".repeat(64)
export const expectation: DockerSandboxImageExpectation = {
	sandboxId, sandboxName, image: imageRef, cpu: "2", memory: "4Gi",
}

function labelsFor(name: string, role: string): Record<string, string> {
	return {
		"openshell.ai/sandbox-id": sandboxId,
		"openshell.ai/sandbox-name": name,
		"openshell.ai/isolation-role": role,
	}
}

export function container(
	id: string,
	role: string,
	name: string,
	image = imageId,
	configImage = imageId,
	cpu = 2_000_000_000,
	memory = 4 * 1024 ** 3,
): Record<string, unknown> {
	return {
		Id: id,
		Name: `/${name}`,
		Image: image,
		Config: { Image: configImage, Labels: labelsFor(sandboxName, role) },
		HostConfig: {
			NanoCpus: cpu, CpuQuota: 0, CpuPeriod: 100_000, Memory: memory,
		},
	}
}

export function variantContainer(
	id: string,
	role: string,
	name: string,
	image: string,
	configName: string,
): Record<string, unknown> {
	return {
		...container(id, role, name, image),
		Config: { Image: imageId, Labels: labelsFor(configName, role) },
	}
}

function matchesLabels(entry: unknown): boolean {
	const labels = (
		entry as { Config?: { Labels?: Record<string, unknown> } }
	).Config?.Labels
	return (
		labels?.["openshell.ai/sandbox-id"] === sandboxId &&
		labels?.["openshell.ai/sandbox-name"] === sandboxName &&
		labels?.["openshell.ai/isolation-role"] === "sandbox"
	)
}

function assertPsArgs(args: string[]): void {
	assert.deepEqual(args, [
		"ps", "-aq", "--no-trunc", "--filter",
		`label=openshell.ai/sandbox-id=${sandboxId}`, "--filter",
		`label=openshell.ai/sandbox-name=${sandboxName}`, "--filter",
		"label=openshell.ai/isolation-role=sandbox",
	])
}

export function overBoundIds(): string {
	return Array.from({ length: 201 }, () => "a".repeat(64)).join("\n")
}

export function expectThrow(
	runner: DockerCommandRunner,
	pattern: RegExp,
): void {
	assert.throws(
		() => inspectLocalDockerSandboxImage(expectation, runner),
		pattern,
	)
}

export function fixedRunner(
	psStdout: string,
	otherStdout: string,
): DockerCommandRunner {
	return (args) =>
		args[0] === "ps"
			? { status: 0, stdout: psStdout }
			: { status: 0, stdout: otherStdout }
}

interface RunnerState {
	matching: unknown[]
	ids: string[]
	localId: string
	localRef: string
}

export function runWith(
	containers: unknown[],
	localId = imageId,
	localRef = imageRef,
): (
	args: string[],
	_timeout: number,
	_max: number,
) => DockerCommandResult {
	const matching = containers.filter(matchesLabels)
	const ids = matching.map((entry) => (entry as { Id: string }).Id)
	return (args) => respond(args, { matching, ids, localId, localRef })
}

function respond(args: string[], state: RunnerState): DockerCommandResult {
	if (args[0] === "ps") return psResult(args, state.ids)
	if (args[0] === "inspect") return inspectResult(state)
	if (isImageRef(args, state.localRef)) return refResult(state.localId)
	return { status: 1, stdout: "" }
}

function psResult(args: string[], ids: string[]): DockerCommandResult {
	assertPsArgs(args)
	return { status: 0, stdout: `${ids.join("\n")}${ids.length ? "\n" : ""}` }
}

function inspectResult(state: RunnerState): DockerCommandResult {
	const found = state.matching.filter((entry) =>
		state.ids.includes((entry as { Id: string }).Id),
	)
	return { status: 0, stdout: JSON.stringify(found) }
}

function isImageRef(args: string[], ref: string): boolean {
	return args[0] === "image" && args[1] === "inspect" && args[2] === ref
}

function refResult(localId: string): DockerCommandResult {
	return { status: 0, stdout: JSON.stringify([{ Id: localId }]) }
}
