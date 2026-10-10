import { createHash, createPublicKey } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { parse } from "yaml"

export type SecurityProfileName = "local" | "contained"
export type ContainedPurpose = "worker" | "evaluation"
export const CONTAINED_EVIDENCE_RUNTIME_PATH = "/run/headlesscode/evidence-runtime.json"

export interface ContainedRuntimeProfile {
	readonly name: "contained"
	readonly purpose: ContainedPurpose
	readonly version: number
	readonly profileSha256: string
	readonly runtimeVersion: string
	readonly gatewayIdentity: string
	readonly expectedGatewayIdentity: string
	readonly expectedEmergencyControllerIdentity: string
	readonly policySha256: string
	readonly policySnapshotPath: string
	readonly image: string
	readonly cpu: string
	readonly memory: string
	readonly providers: readonly string[]
	readonly inferenceEndpoint?: { readonly host: string; readonly port: number }
	readonly evidenceRequired: boolean
	readonly evidenceSocketPath: string
	readonly evidenceGuestPath: string
	readonly evidencePublicKeyPath: string
	readonly evidenceGuestPublicKeyPath: string
	readonly evidencePublicKeyFingerprint: string
	readonly allowedGuestEnv: readonly string[]
	readonly policySnapshotDir: string
}

export interface ResolveContainedProfileOptions {
	repoRoot: string
	purpose?: ContainedPurpose
	env?: NodeJS.ProcessEnv
	probe?: OpenShellProbe
}

export interface OpenShellProbeResult { status: number | null; stdout?: string; stderr?: string; error?: Error }
export type OpenShellProbe = (args: string[], timeoutMs: number) => OpenShellProbeResult

const HASH = /^[a-f0-9]{64}$/i
const IMAGE = /^.+@sha256:[a-f0-9]{64}$/i
const GUEST_ENV = new Set([
	"OPENROUTER_MODEL", "OPENROUTER_BASE_URL", "HEADLESSCODE_PROJECT", "HEADLESSCODE_MAX_COST_USD",
	"HEADLESSCODE_MAX_DURATION_MS", "HEADLESSCODE_MAX_ITERATIONS", "HEADLESSCODE_WINDOW_SIZE",
	"HEADLESSCODE_DECISION_TIMEOUT_MS", "HEADLESSCODE_CODE_MODE_MODEL",
])

/** Resolves an operator-reviewed, digest-pinned profile before any worker launch. */
export function resolveContainedRuntimeProfile(options: ResolveContainedProfileOptions): ContainedRuntimeProfile {
	const env = options.env ?? process.env
	const purpose = options.purpose ?? "worker"
	const profilePathValue = env.HEADLESSCODE_CONTAINED_PROFILE
	const expectedProfileHash = env.HEADLESSCODE_CONTAINED_PROFILE_SHA256
	if (!profilePathValue || !expectedProfileHash || !HASH.test(expectedProfileHash)) {
		throw new Error("contained profile requires HEADLESSCODE_CONTAINED_PROFILE and a 64-character HEADLESSCODE_CONTAINED_PROFILE_SHA256 approved digest")
	}
	const repoRoot = fs.realpathSync(path.resolve(options.repoRoot))
	const profilePath = safeControlFile(profilePathValue, repoRoot, "profile")
	const profileBytes = fs.readFileSync(profilePath)
	const profileSha256 = sha256(profileBytes)
	if (profileSha256 !== expectedProfileHash.toLowerCase()) throw new Error("contained profile digest does not match HEADLESSCODE_CONTAINED_PROFILE_SHA256")
	const config = parse(profileBytes.toString("utf8")) as unknown
	if (!isRecord(config) || config.version !== 1 || config.profile !== "contained") throw new Error("contained profile must be a version 1 YAML document with profile: contained")
	if (config.gpu !== undefined || config.gpuDevices !== undefined || config.devices !== undefined) throw new Error("contained profile cannot request GPU devices or local accelerator access")
	const policyConfig = config.policy
	const resourceConfig = config.resources
	const evidenceConfig = config.evidence
	const controlConfig = config.externalControls
	const gatewayConfig = config.gateway
	if (!isRecord(policyConfig) || typeof policyConfig.path !== "string" || typeof policyConfig.sha256 !== "string" || !HASH.test(policyConfig.sha256)) {
		throw new Error("contained profile policy requires path and a pinned SHA-256 digest")
	}
	if (!isRecord(resourceConfig) || typeof resourceConfig.cpu !== "string" || typeof resourceConfig.memory !== "string") {
		throw new Error("contained profile requires explicit CPU and memory resource limits")
	}
	if (!isRecord(evidenceConfig) || evidenceConfig.required !== true || typeof evidenceConfig.socketPath !== "string" || typeof evidenceConfig.guestPath !== "string" || typeof evidenceConfig.publicKeyPath !== "string" || typeof evidenceConfig.publicKeyGuestPath !== "string" || typeof evidenceConfig.publicKeyFingerprint !== "string") {
		throw new Error("contained profile requires authenticated external evidence transport and a pinned collector fingerprint")
	}
	if (!isRecord(controlConfig) || controlConfig.emergencyStop !== "required" || controlConfig.evaluatorSupervisorOnly !== true) {
		throw new Error("contained profile requires emergency stop and supervisor-only evaluator controls")
	}
	if (typeof controlConfig.emergencyControllerIdentity !== "string" || !controlConfig.emergencyControllerIdentity.trim()) throw new Error("contained profile requires a pinned emergency controller identity")
	if (!isRecord(gatewayConfig) || typeof gatewayConfig.identity !== "string" || !gatewayConfig.identity.trim()) {
		throw new Error("contained profile requires an operator-pinned OpenShell gateway identity")
	}
	const image = config.image
	if (typeof image !== "string" || !IMAGE.test(image)) throw new Error("contained profile image must be pinned by an @sha256 digest")
	if (!isPositiveQuantity(resourceConfig.cpu) || !isPositiveQuantity(resourceConfig.memory)) throw new Error("contained profile CPU and memory limits must be positive quantities")
	const providers = stringArray(config.providers, "contained profile providers")
	const endpoint = parseInferenceEndpoint(config.inference, purpose)
	if (purpose === "evaluation" && providers.length) throw new Error("evaluation sessions must not attach credential providers")
	if (purpose === "worker" && (!providers.length || !endpoint)) throw new Error("worker sessions require explicit credential provider and inference endpoint")
	if (purpose === "worker" && providers.includes("headlesscode-openrouter") && !env.HEADLESSCODE_OPENROUTER_API_KEY) {
		throw new Error("contained OpenRouter worker requires the host-side provider credential")
	}
	if (purpose === "worker" && env.OPENROUTER_BASE_URL) {
		let configured: URL
		try { configured = new URL(env.OPENROUTER_BASE_URL) } catch { throw new Error("OPENROUTER_BASE_URL is not a valid URL") }
		if (configured.protocol !== "https:" || configured.hostname.toLowerCase() !== endpoint?.host || (configured.port && configured.port !== String(endpoint.port))) {
			throw new Error("OPENROUTER_BASE_URL must match the approved remote inference endpoint")
		}
	}
	if (purpose === "worker" && env.HEADLESSCODE_CODE_MODE_BACKEND && env.HEADLESSCODE_CODE_MODE_BACKEND !== "openrouter") {
		throw new Error("contained profile permits remote OpenRouter inference only; local model backends are disabled")
	}
	if (evidenceConfig.transport !== "unix") throw new Error("this contained runtime currently supports only an authenticated Unix evidence socket")
	const evidenceSocketPath = safeSocket(evidenceConfig.socketPath, repoRoot)
	const evidencePublicKeyPath = safeControlFile(path.resolve(path.dirname(profilePath), evidenceConfig.publicKeyPath), repoRoot, "evidence public key")
	const evidenceGuestPath = validateGuestPath(evidenceConfig.guestPath, "evidence guest path")
	const evidenceGuestPublicKeyPath = validateGuestPath(evidenceConfig.publicKeyGuestPath, "evidence public key guest path")
	if (evidenceGuestPath === "/" || ["/workspace", "/result", "/opt/headlesscode"].some((root) => pathsOverlap(evidenceGuestPath, root))) {
		throw new Error("evidence socket target overlaps a workspace, result, or runtime mount")
	}
	if (["/workspace", "/result", "/opt/headlesscode"].some((root) => pathsOverlap(evidenceGuestPublicKeyPath, root)) || pathsOverlap(evidenceGuestPath, evidenceGuestPublicKeyPath)) throw new Error("evidence public key target overlaps a writable or protected guest mount")
	if (!/^sha256:[a-f0-9]{64}$/i.test(evidenceConfig.publicKeyFingerprint)) throw new Error("evidence collector fingerprint must use sha256:<64 hex characters>")
	const evidenceKey = createPublicKey(fs.readFileSync(evidencePublicKeyPath))
	const actualEvidenceFingerprint = `sha256:${sha256(evidenceKey.export({ type: "spki", format: "der" }))}`
	if (actualEvidenceFingerprint !== evidenceConfig.publicKeyFingerprint.toLowerCase()) throw new Error("evidence collector public key does not match the pinned fingerprint")
	const policyPath = safeControlFile(path.resolve(path.dirname(profilePath), policyConfig.path), repoRoot, "policy")
	const policyBytes = fs.readFileSync(policyPath)
	const policySha256 = sha256(policyBytes)
	if (policySha256 !== policyConfig.sha256.toLowerCase()) throw new Error("OpenShell policy digest does not match the reviewed contained profile")
	const policyDoc = parse(policyBytes.toString("utf8")) as unknown
	if (isRecord(policyDoc) && ["gpu", "gpuDevices", "devices", "device_policy", "privileged", "capabilities"].some((key) => policyDoc[key] !== undefined)) {
		throw new Error("contained v1 policy cannot request GPU devices, privileged mode, or added process capabilities")
	}
	validatePolicy(policyDoc, { purpose, endpoint, evidenceGuestPath, evidenceGuestPublicKeyPath })
	const scratchRoot = path.resolve(env.HEADLESSCODE_OPENSHELL_SCRATCH_ROOT ?? path.join(os.homedir(), ".local", "share", "headlesscode", "openshell-sessions"))
	assertSafeDirectory(scratchRoot)
	for (const controlPath of [profilePath, policyPath, evidenceSocketPath, evidencePublicKeyPath]) {
		if (pathsOverlap(controlPath, scratchRoot)) throw new Error(`contained control path overlaps OpenShell scratch data: ${controlPath}`)
	}
	const snapshotDir = fs.mkdtempSync(path.join(scratchRoot, "headlesscode-policy-"))
	fs.chmodSync(snapshotDir, 0o700)
	const policySnapshotPath = path.join(snapshotDir, "policy.yaml")
	const frozenBytes = policyBytes
	fs.writeFileSync(policySnapshotPath, frozenBytes, { flag: "wx", mode: 0o400 })
	fs.chmodSync(policySnapshotPath, 0o400)
	if (sha256(fs.readFileSync(policySnapshotPath)) !== policySha256) {
		fs.rmSync(snapshotDir, { recursive: true, force: true })
		throw new Error("OpenShell policy snapshot changed while being prepared")
	}
	let runtime: { runtimeVersion: string; gatewayIdentity: string }
	try {
		runtime = verifyContainedPrerequisites({ probe: options.probe ?? defaultOpenShellProbe, expectedGatewayIdentity: gatewayConfig.identity })
	} catch (error) {
		fs.rmSync(snapshotDir, { recursive: true, force: true })
		throw error
	}
	const allowedGuestEnv = Object.freeze([...GUEST_ENV].filter((name) => env[name] !== undefined))
	return Object.freeze({
		name: "contained",
		purpose,
		version: 1,
		profileSha256,
		runtimeVersion: runtime.runtimeVersion,
		gatewayIdentity: runtime.gatewayIdentity,
		expectedGatewayIdentity: gatewayConfig.identity,
		expectedEmergencyControllerIdentity: controlConfig.emergencyControllerIdentity,
		policySha256,
		policySnapshotPath,
		image,
		cpu: resourceConfig.cpu,
		memory: resourceConfig.memory,
		providers: Object.freeze(providers),
		...(endpoint ? { inferenceEndpoint: Object.freeze(endpoint) } : {}),
		evidenceRequired: true,
		evidenceSocketPath,
		evidenceGuestPath,
		evidencePublicKeyPath,
		evidenceGuestPublicKeyPath,
		evidencePublicKeyFingerprint: evidenceConfig.publicKeyFingerprint.toLowerCase(),
		allowedGuestEnv,
		policySnapshotDir: snapshotDir,
	})
}

export function verifyContainedPrerequisites(options: {
	probe: OpenShellProbe
	expectedGatewayIdentity: string
}): { runtimeVersion: string; gatewayIdentity: string } {
	const versionResult = options.probe(["--version"], 5000)
	const versionOutput = `${versionResult.stdout ?? ""}${versionResult.stderr ?? ""}`.trim()
	const versionMatch = /\bopenshell\s+(\d+)\.(\d+)\.(\d+)\b/i.exec(versionOutput)
	if (versionResult.error || versionResult.status !== 0 || !versionMatch) throw new Error("contained execution requires a verifiable OpenShell CLI version")
	const version = versionMatch.slice(1).map(Number)
	if (version[0]! < 0 || (version[0] === 0 && (version[1]! < 1 || (version[1] === 1 && version[2]! < 2)))) {
		throw new Error(`OpenShell ${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]} is too old; contained execution requires at least 0.1.2`)
	}
	const gatewayResult = options.probe(["gateway", "info"], 10_000)
	const gatewayOutput = `${gatewayResult.stdout ?? ""}${gatewayResult.stderr ?? ""}`
	if (gatewayResult.error || gatewayResult.status !== 0 || !/Status:\s*healthy/i.test(gatewayOutput)) throw new Error("contained execution requires a healthy, reachable OpenShell gateway")
	const identity = /(?:Gateway|Name):\s*([^\r\n]+)/i.exec(gatewayOutput)?.[1]?.trim()
	if (!identity || identity !== options.expectedGatewayIdentity) throw new Error("OpenShell gateway identity does not match the pinned contained profile")
	return { runtimeVersion: `openshell ${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}`, gatewayIdentity: identity }
}

/** Check the gateway's loaded effective policy before the agent command starts. */
export function assertEffectiveOpenShellPolicy(policyText: string, profile: Pick<ContainedRuntimeProfile, "purpose" | "inferenceEndpoint" | "evidenceGuestPath" | "evidenceGuestPublicKeyPath">): void {
	let document: unknown
	try { document = parse(policyText) as unknown } catch { throw new Error("OpenShell did not return a parseable effective policy") }
	if (!isRecord(document)) throw new Error("OpenShell effective policy response was not a map")
	const networkMap = document.network_policies
	if (!isRecord(networkMap)) throw new Error("OpenShell effective policy omitted network_policies")
	const filesystem = document.filesystem_policy
	const landlock = document.landlock
	const processPolicy = document.process
	if (!isRecord(filesystem) || filesystem.include_workdir !== false || !Array.isArray(filesystem.read_only) || !Array.isArray(filesystem.read_write)) {
		throw new Error("effective OpenShell policy does not enforce explicit filesystem grants")
	}
	const readOnlyPaths = filesystem.read_only as unknown[]
	const readWritePaths = filesystem.read_write as unknown[]
	if (!isRecord(landlock) || landlock.compatibility !== "hard_requirement") throw new Error("effective OpenShell policy does not require Landlock")
	if (!isRecord(processPolicy) || !isNonRootIdentity(processPolicy.run_as_user) || !isNonRootIdentity(processPolicy.run_as_group)) {
		throw new Error("effective OpenShell policy does not enforce a non-root process identity")
	}
	for (const item of [...readOnlyPaths, ...readWritePaths]) validateGuestPath(item, "effective filesystem path")
	const allowedWriteRoots = new Set(["/tmp", "/dev/null", "/workspace", "/result", "/opt/headlesscode-data/checkpoints", profile.evidenceGuestPath])
	if (readWritePaths.some((item) => typeof item !== "string" || !allowedWriteRoots.has(item))) {
		throw new Error("effective OpenShell policy grants an unapproved writable filesystem path")
	}
	if (!["/workspace", "/result", profile.evidenceGuestPath].every((item) => readWritePaths.includes(item))) throw new Error("effective OpenShell policy omits the workspace, result, or evidence socket grant")
	if (!readOnlyPaths.includes(profile.evidenceGuestPublicKeyPath)) throw new Error("effective OpenShell policy does not expose the pinned evidence public key read-only")
	if (!readOnlyPaths.includes(CONTAINED_EVIDENCE_RUNTIME_PATH)) throw new Error("effective OpenShell policy does not expose the scoped evidence runtime config read-only")
	const endpoints: Array<{ host: string; port: number; enforcement?: string }> = []
	for (const [name, rawRule] of Object.entries(networkMap)) {
		if (!isRecord(rawRule) || !Array.isArray(rawRule.endpoints) || !Array.isArray(rawRule.binaries)) throw new Error(`effective OpenShell network rule ${name} is malformed`)
		validateNetworkBinaries(rawRule.binaries, `effective OpenShell network rule ${name}`)
		for (const rawEndpoint of rawRule.endpoints) {
			if (!isRecord(rawEndpoint) || typeof rawEndpoint.host !== "string" || !Number.isInteger(rawEndpoint.port)) throw new Error(`effective OpenShell network rule ${name} has an invalid endpoint`)
			endpoints.push({ host: rawEndpoint.host.toLowerCase(), port: rawEndpoint.port as number, enforcement: typeof rawEndpoint.enforcement === "string" ? rawEndpoint.enforcement : undefined })
		}
	}
	if (profile.purpose === "evaluation") {
		if (endpoints.length) throw new Error("effective evaluation policy grants network access")
		return
	}
	const expected = profile.inferenceEndpoint
	if (!expected || endpoints.length !== 1 || endpoints[0]?.host !== expected.host || endpoints[0]?.port !== expected.port || endpoints[0]?.enforcement !== "enforce") {
		throw new Error("effective OpenShell policy does not match the single approved, enforced inference route")
	}
}

export function containedGuestEnvironment(
	profile: ContainedRuntimeProfile,
	ambient: NodeJS.ProcessEnv,
	requested: Record<string, string>,
	identity: Record<string, string> = {},
): Record<string, string> {
	const result: Record<string, string> = {}
	for (const name of profile.allowedGuestEnv) {
		const value = requested[name] ?? ambient[name]
		if (value !== undefined) result[name] = value
	}
	if (profile.purpose === "worker") result.HEADLESSCODE_CODE_MODE_BACKEND = "openrouter"
	result.HEADLESSCODE_EVIDENCE_CONFIG_PATH = CONTAINED_EVIDENCE_RUNTIME_PATH
	for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
		const value = identity[name]
		if (value !== undefined) result[name] = value
	}
	return result
}

export function resolveSecurityProfile(value: string | undefined): SecurityProfileName {
	const profile = value ?? "local"
	if (profile !== "local" && profile !== "contained") throw new Error(`security profile must be local or contained, got ${profile}`)
	return profile
}

export function securityProfileDescription(profile: SecurityProfileName): string {
	return profile === "local"
		? "local host execution; commands run with the invoking user's authority and are not OS-contained"
		: "OpenShell contained execution; launch fails closed unless the pinned runtime, policy, and external controls are verified"
}

function validatePolicy(value: unknown, options: { purpose: ContainedPurpose; endpoint?: { host: string; port: number }; evidenceGuestPath: string; evidenceGuestPublicKeyPath: string }): void {
	if (!isRecord(value) || value.version !== 1) throw new Error("OpenShell policy must have version: 1")
	const filesystem = value.filesystem_policy
	const landlock = value.landlock
	const processPolicy = value.process
	const networks = value.network_policies
	if (!isRecord(filesystem) || filesystem.include_workdir !== false || !Array.isArray(filesystem.read_only) || !Array.isArray(filesystem.read_write)) {
		throw new Error("contained OpenShell policy must set filesystem_policy.include_workdir: false and explicit read_only/read_write arrays")
	}
	if (!isRecord(landlock) || landlock.compatibility !== "hard_requirement") throw new Error("contained OpenShell policy must require Landlock enforcement")
	if (!isRecord(processPolicy) || !isNonRootIdentity(processPolicy.run_as_user) || !isNonRootIdentity(processPolicy.run_as_group)) {
		throw new Error("contained OpenShell policy must explicitly run as a non-root user and group")
	}
	for (const item of [...filesystem.read_only, ...filesystem.read_write]) validateGuestPath(item, "filesystem policy path")
	const allowedWrite = new Set(["/tmp", "/dev/null", "/workspace", "/result", "/opt/headlesscode-data/checkpoints", options.evidenceGuestPath])
	if (filesystem.read_write.some((item) => item === "/" || pathsOverlap(item, "/opt/headlesscode") || typeof item !== "string" || !allowedWrite.has(item))) {
		throw new Error("contained OpenShell policy has a broad or runtime-overlapping writable path")
	}
	if (!filesystem.read_write.includes("/workspace") || !filesystem.read_write.includes("/result") || !filesystem.read_write.includes(options.evidenceGuestPath)) throw new Error("contained OpenShell policy must grant only the workspace, result, and evidence socket writable mounts")
	if (!filesystem.read_only.includes(options.evidenceGuestPublicKeyPath) || !filesystem.read_only.includes(CONTAINED_EVIDENCE_RUNTIME_PATH)) throw new Error("contained OpenShell policy must expose the evidence public key and scoped runtime config read-only")
	if (!isRecord(networks)) throw new Error("contained OpenShell policy must define network_policies as a map")
	const endpoints: Array<{ host: string; port: number; enforcement?: string }> = []
	for (const [key, rule] of Object.entries(networks)) {
		if (!isRecord(rule) || !Array.isArray(rule.endpoints) || !Array.isArray(rule.binaries)) throw new Error(`OpenShell network rule ${key} is malformed`)
		validateNetworkBinaries(rule.binaries, `OpenShell network rule ${key}`)
		for (const endpoint of rule.endpoints) {
			if (!isRecord(endpoint) || typeof endpoint.host !== "string" || typeof endpoint.port !== "number" || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
				throw new Error(`OpenShell network rule ${key} contains an invalid endpoint`)
			}
			if (endpoint.host.includes("*") || endpoint.host === "0.0.0.0" || endpoint.host === "::") throw new Error(`OpenShell network rule ${key} contains a wildcard endpoint`)
			endpoints.push({ host: endpoint.host.toLowerCase(), port: endpoint.port as number, enforcement: typeof endpoint.enforcement === "string" ? endpoint.enforcement : undefined })
		}
	}
	if (options.purpose === "evaluation") {
		if (endpoints.length) throw new Error("evaluation policy must grant no network endpoints")
	} else {
		const expected = options.endpoint
		if (!expected || endpoints.some((endpoint) => endpoint.host !== expected.host || endpoint.port !== expected.port)) {
			throw new Error("worker policy contains an endpoint outside its configured inference route")
		}
		if (endpoints.some((endpoint) => endpoint.enforcement !== "enforce")) throw new Error("inference endpoint must use enforcement: enforce")
	}
}

function validateNetworkBinaries(value: unknown[], label: string): void {
	if (!value.length) throw new Error(`${label} has no binary restrictions`)
	for (const binary of value) {
		if (!isRecord(binary) || typeof binary.path !== "string" || !binary.path.startsWith("/") || path.posix.normalize(binary.path) !== binary.path || binary.path.includes("*") || binary.path.includes("..")) throw new Error(`${label} contains an unpinned or invalid binary rule`)
		if (binary.sha256 !== undefined && (typeof binary.sha256 !== "string" || !HASH.test(binary.sha256))) throw new Error(`${label} contains an invalid binary digest`)
	}
}

/** Confirm the sandbox actually uses the pinned image and loaded effective policy. */
export function verifyContainedSandboxIdentity(options: {
	probe: OpenShellProbe
	name: string
	profile: Pick<ContainedRuntimeProfile, "image" | "purpose" | "inferenceEndpoint" | "evidenceGuestPath" | "evidenceGuestPublicKeyPath">
}): void {
	const sandbox = options.probe(["sandbox", "get", options.name, "--output", "json"], 10_000)
	if (sandbox.error || sandbox.status !== 0) throw new Error("could not inspect created OpenShell sandbox identity")
	let sandboxDoc: unknown
	try { sandboxDoc = JSON.parse(sandbox.stdout ?? "") as unknown } catch { throw new Error("OpenShell sandbox identity response was not valid JSON") }
	const image = findStringValue(sandboxDoc, new Set(["image", "image_ref", "imageRef", "from"]))
	if (image !== options.profile.image) throw new Error("created OpenShell sandbox image does not match the digest-pinned contained profile")
	const policy = options.probe(["sandbox", "get", options.name, "--policy-only", "--output", "yaml"], 10_000)
	if (policy.error || policy.status !== 0) throw new Error("could not inspect created OpenShell effective policy")
	assertEffectiveOpenShellPolicy(policy.stdout ?? "", options.profile)
}

/** Reconstitute only a supervisor-produced runtime identity; verify its frozen policy bytes. */
export function loadResolvedContainedProfile(serialized: string | undefined): ContainedRuntimeProfile {
	if (!serialized) throw new Error("contained execution requires the supervisor's resolved immutable profile identity")
	let value: unknown
	try { value = JSON.parse(serialized) as unknown } catch { throw new Error("resolved contained profile identity is invalid JSON") }
	if (!isRecord(value) || value.name !== "contained" || value.version !== 1 || typeof value.policySnapshotPath !== "string" || typeof value.policySha256 !== "string" || typeof value.profileSha256 !== "string") {
		throw new Error("resolved contained profile identity is incomplete")
	}
	const snapshot = safeControlFile(value.policySnapshotPath, "/__contained_no_repo__", "frozen policy")
	if (sha256(fs.readFileSync(snapshot)) !== value.policySha256) throw new Error("frozen contained policy snapshot changed after approval")
	return Object.freeze({ ...value, policySnapshotPath: snapshot }) as unknown as ContainedRuntimeProfile
}

export function serializeResolvedContainedProfile(profile: ContainedRuntimeProfile): string {
	return JSON.stringify(profile)
}

function parseInferenceEndpoint(value: unknown, purpose: ContainedPurpose): { host: string; port: number } | undefined {
	if (purpose === "evaluation") {
		if (value !== undefined) throw new Error("evaluation profile cannot configure an inference network endpoint")
		return undefined
	}
	if (!isRecord(value) || typeof value.host !== "string" || !Number.isInteger(value.port)) throw new Error("contained worker profile requires an inference host and port")
	const host = value.host.toLowerCase()
	if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..") || host.includes("*") || host === "localhost") {
		throw new Error("contained inference endpoint must be an exact public DNS hostname")
	}
	const port = value.port as number
	if (port !== 443) throw new Error("contained inference endpoint must use TLS port 443")
	return { host, port }
}

function safeControlFile(value: string, repoRoot: string, kind: string): string {
	const absolute = path.resolve(value)
	assertNoSymlinkAncestors(absolute)
	assertSafeParentDirectory(absolute)
	const real = fs.realpathSync(absolute)
	const stat = fs.lstatSync(real)
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`contained ${kind} must be a regular non-symlink file`)
	if (stat.mode & 0o022) throw new Error(`contained ${kind} must not be group- or world-writable`)
	if (pathsOverlap(real, repoRoot)) throw new Error(`contained ${kind} must be outside the worker-writable repository: ${real}`)
	return real
}

function safeSocket(value: string, repoRoot: string): string {
	const absolute = path.resolve(value)
	assertNoSymlinkAncestors(absolute)
	assertSafeParentDirectory(absolute)
	const stat = fs.lstatSync(absolute)
	if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error("evidence socket must be an existing Unix socket, not a symlink")
	if (pathsOverlap(absolute, repoRoot)) throw new Error("evidence socket must be outside the worker-writable repository")
	return absolute
}

function validateGuestPath(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.startsWith("/") || path.posix.normalize(value) !== value || value.includes("\\") || value.includes("\0")) {
		throw new Error(`${label} must be a normalized absolute guest path`)
	}
	return value
}

function isNonRootIdentity(value: unknown): boolean {
	return value === "sandbox" || (typeof value === "string" && /^[1-9]\d*$/.test(value) && Number(value) <= 4_294_967_294)
}

function isPositiveQuantity(value: string): boolean {
	return /^(?:[1-9]\d*(?:\.\d+)?|[1-9]\d*m)$/.test(value) || /^(?:[1-9]\d*(?:\.\d+)?)(?:Ki|Mi|Gi|Ti|K|M|G|T)$/.test(value)
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item))) throw new Error(`${label} must be an explicit array of provider names`)
	return [...new Set(value as string[])]
}

function assertSafeDirectory(value: string): void {
	fs.mkdirSync(value, { recursive: true, mode: 0o700 })
	assertNoSymlinkAncestors(value)
	const stat = fs.lstatSync(value)
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error(`OpenShell scratch root must be a private, non-symlink directory: ${value}`)
}

function assertNoSymlinkAncestors(value: string): void {
	const absolute = path.resolve(value)
	const parsed = path.parse(absolute)
	let current = parsed.root
	for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment)
		try {
			if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`contained control path traverses a symlink: ${current}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") break
			throw error
		}
	}
}

function assertSafeParentDirectory(value: string): void {
	const parent = path.dirname(path.resolve(value))
	const stat = fs.lstatSync(parent)
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error(`contained control path has an unsafe writable parent directory: ${parent}`)
}

function pathsOverlap(a: string, b: string): boolean {
	const left = path.resolve(a)
	const right = path.resolve(b)
	return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)
}

function defaultOpenShellProbe(args: string[], timeoutMs: number): OpenShellProbeResult {
	const result = spawnSync("openshell", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		...(result.error ? { error: result.error } : {}),
	}
}

function findStringValue(value: unknown, keys: Set<string>): string | undefined {
	if (Array.isArray(value)) {
		for (const item of value) { const result = findStringValue(item, keys); if (result) return result }
		return undefined
	}
	if (!isRecord(value)) return undefined
	for (const [key, item] of Object.entries(value)) {
		if (keys.has(key) && typeof item === "string") return item
		const nested = findStringValue(item, keys)
		if (nested) return nested
	}
	return undefined
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex") }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
