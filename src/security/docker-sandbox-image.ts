import { spawnSync } from "node:child_process"
import * as os from "node:os"

const DOCKER_SOCKET = "unix:///var/run/docker.sock"
const MAX_CONTAINERS = 200
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/i

export interface DockerSandboxImageExpectation {
	sandboxId: string
	sandboxName: string
	image: string
	cpu: string
	memory: string
}

export interface DockerSandboxImageEvidence {
	imageId: string
	configImage: string
	localImageId: string
	cpuCores: number
	memoryBytes: number
}

export interface DockerCommandResult { status: number | null; stdout: string; error?: Error }
export type DockerCommandRunner = (args: string[], timeoutMs: number, maxBufferBytes: number) => DockerCommandResult
export type DockerSandboxImageObserver = (expectation: DockerSandboxImageExpectation) => DockerSandboxImageEvidence

export function inspectLocalDockerSandboxImage(
	expectation: DockerSandboxImageExpectation,
	run: DockerCommandRunner = runLocalDocker,
): DockerSandboxImageEvidence {
	validateExpectation(expectation)
	const idsResult = run([
		"ps", "-aq", "--no-trunc",
		"--filter", `label=openshell.ai/sandbox-id=${expectation.sandboxId}`,
		"--filter", `label=openshell.ai/sandbox-name=${expectation.sandboxName}`,
		"--filter", "label=openshell.ai/isolation-role=sandbox",
	], 10_000, 256 * 1024)
	if (idsResult.error || idsResult.status !== 0) throw new Error("could not enumerate matching local Docker workload containers for OpenShell identity verification")
	const ids = idsResult.stdout.split(/\r?\n/).filter(Boolean)
	if (ids.length > MAX_CONTAINERS || ids.some((id) => !/^[a-f0-9]{64}$/i.test(id))) throw new Error("local Docker container list is invalid or exceeds the verification bound")
	const inspected = ids.length ? run(["inspect", ...ids], 20_000, MAX_OUTPUT_BYTES) : { status: 0, stdout: "[]" }
	if (inspected.error || inspected.status !== 0) throw new Error("could not inspect matching local Docker workload identities")
	const containers = parseJsonArray(inspected.stdout, "matching local Docker workload inspection")
	if (containers.length !== ids.length) throw new Error("local Docker returned an incomplete workload identity set")
	const matching = containers.filter((container) => isOpenShellWorkload(container, expectation))
	if (matching.length !== 1) throw new Error(matching.length ? "multiple local Docker workload containers match the OpenShell sandbox" : "no local Docker workload container matches the OpenShell sandbox labels")
	const workload = matching[0]!
	const localImage = run(["image", "inspect", expectation.image], 10_000, 1024 * 1024)
	if (localImage.error || localImage.status !== 0) throw new Error("pinned contained image is unavailable in the local Docker image store")
	const imageDocuments = parseJsonArray(localImage.stdout, "local Docker image inspection")
	if (imageDocuments.length !== 1 || !isRecord(imageDocuments[0]) || typeof imageDocuments[0].Id !== "string" || !IMAGE_ID.test(imageDocuments[0].Id)) {
		throw new Error("local Docker returned an invalid pinned image identity")
	}
	const localImageId = imageDocuments[0].Id.toLowerCase()
	const imageId = workload.Image
	const configImage = workload.Config?.Image
	if (typeof imageId !== "string" || !IMAGE_ID.test(imageId) || imageId.toLowerCase() !== localImageId) {
		throw new Error("OpenShell workload image ID does not match the locally resolved pinned image")
	}
	if (typeof configImage !== "string" || !SAFE_IMAGE_REF.test(configImage) || (configImage !== expectation.image && configImage.toLowerCase() !== localImageId)) {
		throw new Error("OpenShell workload Config.Image is not the exact pinned reference or its local image ID")
	}
	const resources = readResources(workload.HostConfig)
	const wantedCpu = parseCpu(expectation.cpu)
	const wantedMemory = parseBytes(expectation.memory)
	if (resources.cpuCores !== wantedCpu || resources.memoryBytes !== wantedMemory) throw new Error("OpenShell workload CPU or memory limit differs from the contained profile")
	return { imageId: imageId.toLowerCase(), configImage, localImageId, ...resources }
}

function runLocalDocker(args: string[], timeoutMs: number, maxBufferBytes: number): DockerCommandResult {
	const result = spawnSync("docker", ["--host", DOCKER_SOCKET, ...args], {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: maxBufferBytes,
		env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: os.homedir() },
	})
	return { status: result.status, stdout: result.stdout ?? "", ...(result.error ? { error: result.error } : {}) }
}

function validateExpectation(value: DockerSandboxImageExpectation): void {
	if (!value || !SAFE_UUID.test(value.sandboxId) || typeof value.sandboxName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.sandboxName) ||
		typeof value.image !== "string" || !/^.+@sha256:[a-f0-9]{64}$/i.test(value.image) || typeof value.cpu !== "string" || typeof value.memory !== "string") {
		throw new Error("OpenShell sandbox image inspection identity is invalid")
	}
	parseCpu(value.cpu)
	parseBytes(value.memory)
}

function parseJsonArray(value: string, label: string): unknown[] {
	try {
		const parsed: unknown = JSON.parse(value)
		if (!Array.isArray(parsed)) throw new Error()
		return parsed
	} catch {
		throw new Error(`${label} was not a JSON array`)
	}
}

function isOpenShellWorkload(value: unknown, expected: DockerSandboxImageExpectation): value is DockerContainer {
	if (!isRecord(value) || typeof value.Name !== "string" || !isRecord(value.Config) || !isRecord(value.Config.Labels)) return false
	const labels = value.Config.Labels
	return labels["openshell.ai/sandbox-id"] === expected.sandboxId &&
		labels["openshell.ai/sandbox-name"] === expected.sandboxName &&
		labels["openshell.ai/isolation-role"] === "sandbox"
}

function readResources(value: unknown): { cpuCores: number; memoryBytes: number } {
	if (!isRecord(value)) throw new Error("OpenShell workload resource limits are unavailable from local Docker")
	const nanoCpus = value.NanoCpus
	const cpuQuota = value.CpuQuota
	const cpuPeriod = value.CpuPeriod
	let cpuCores: number
	if (typeof nanoCpus === "number" && nanoCpus > 0) cpuCores = nanoCpus / 1_000_000_000
	else if (typeof cpuQuota === "number" && cpuQuota > 0 && typeof cpuPeriod === "number" && cpuPeriod > 0) cpuCores = cpuQuota / cpuPeriod
	else throw new Error("OpenShell workload CPU limit is unavailable from local Docker")
	if (typeof value.Memory !== "number" || value.Memory <= 0) throw new Error("OpenShell workload memory limit is unavailable from local Docker")
	return { cpuCores, memoryBytes: value.Memory }
}

function parseCpu(value: string): number {
	if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("contained profile CPU limit is invalid for Docker verification")
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("contained profile CPU limit is invalid for Docker verification")
	return parsed
}

function parseBytes(value: string): number {
	const match = /^(\d+)(B|Ki|Mi|Gi|K|M|G)?$/.exec(value)
	if (!match) throw new Error("contained profile memory limit is invalid for Docker verification")
	const factor = ({ B: 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, K: 1000, M: 1000 ** 2, G: 1000 ** 3 } as Record<string, number>)[match[2] ?? "B"]!
	const bytes = Number(match[1]) * factor
	if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("contained profile memory limit is invalid for Docker verification")
	return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface DockerContainer {
	Name: string
	Image: unknown
	Config: { Image: unknown; Labels: Record<string, unknown> }
	HostConfig: Record<string, unknown>
}
