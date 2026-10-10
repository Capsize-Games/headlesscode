import * as fs from "node:fs"
import * as path from "node:path"

import { evidenceJournalFromConfig, type EvidenceConnectionConfig, type EvidenceRuntimeConfig } from "../evidence/index.js"
import type { ContainedRuntimeProfile } from "./profile.js"
import { EmergencyControl } from "../control/emergency-controller.js"

export const CONTAINED_EVIDENCE_CONFIG_DIR_ENV = "HEADLESSCODE_CONTAINED_EVIDENCE_CONFIG_DIR"
export const CONTROL_STATE_DIR_ENV = "HEADLESSCODE_CONTROL_STATE_DIR"
export const CONTROL_SOCKET_DIR_ENV = "HEADLESSCODE_CONTROL_SOCKET_DIR"
export const CONTAINED_SESSION_PREFIX_ENV = "HEADLESSCODE_CONTAINED_SESSION_PREFIX"

export interface ContainedSupervisorRuntime {
	sessionId: string
	evidence: EvidenceRuntimeConfig
	evidenceConnection: EvidenceConnectionConfig
	evidenceConfigPath: string
}

export function validateContainedSupervisorRoots(profile: ContainedRuntimeProfile, repoRoot: string, env: NodeJS.ProcessEnv = process.env): void {
	const configValue = env[CONTAINED_EVIDENCE_CONFIG_DIR_ENV]
	const stateValue = env[CONTROL_STATE_DIR_ENV]
	const socketValue = env[CONTROL_SOCKET_DIR_ENV] ?? stateValue
	if (!configValue || !stateValue || !socketValue) throw new Error("contained execution requires protected evidence-config, emergency-state, and emergency-socket directories")
	const socketProbeValue = socketValue.includes("{session}") ? socketValue.replaceAll("{session}", "__headlesscode_preflight__") : socketValue
	for (const value of [stateValue, socketProbeValue]) {
		assertNoSymlinkAncestors(path.resolve(value))
		fs.mkdirSync(path.resolve(value), { recursive: true, mode: 0o700 })
		fs.chmodSync(path.resolve(value), 0o700)
	}
	const configDir = safeDirectory(configValue)
	const stateDir = safeDirectory(stateValue)
	const socketDir = safeDirectory(socketProbeValue)
	const repo = fs.realpathSync(path.resolve(repoRoot))
	const scratch = env.HEADLESSCODE_OPENSHELL_SCRATCH_ROOT ? path.resolve(env.HEADLESSCODE_OPENSHELL_SCRATCH_ROOT) : profile.policySnapshotDir
	const protectedPaths = [repo, profile.policySnapshotDir, profile.evidenceSocketPath, profile.evidencePublicKeyPath, scratch]
	for (const dir of [configDir, stateDir, socketDir]) {
		for (const protectedPath of protectedPaths) if (overlaps(dir, protectedPath)) throw new Error("contained supervisor directories overlap guest-writable or protected runtime data")
	}
	if (overlaps(configDir, stateDir) || overlaps(configDir, socketDir) || (stateDir !== socketDir && overlaps(stateDir, socketDir))) throw new Error("contained evidence and emergency-control directories must be separate")
}

/** Load one operator-provisioned, per-session handoff. It contains a scoped append capability, never collector key material. */
export function loadContainedSupervisorRuntime(options: {
	profile: ContainedRuntimeProfile
	sessionId: string
	repoRoot: string
	workspaceRoot?: string
	env?: NodeJS.ProcessEnv
}): ContainedSupervisorRuntime {
	const sessionId = validateSessionId(options.sessionId)
	const env = options.env ?? process.env
	const configDirValue = env[CONTAINED_EVIDENCE_CONFIG_DIR_ENV]
	if (!configDirValue) throw new Error(`${CONTAINED_EVIDENCE_CONFIG_DIR_ENV} must point to a protected per-session evidence config directory`)
	const configDir = safeDirectory(configDirValue)
	const repoRoot = fs.realpathSync(path.resolve(options.repoRoot))
	const workspaceRoot = options.workspaceRoot ? fs.realpathSync(path.resolve(options.workspaceRoot)) : repoRoot
	for (const protectedPath of [repoRoot, workspaceRoot, options.profile.policySnapshotDir, options.profile.policySnapshotPath]) {
		if (overlaps(configDir, protectedPath)) throw new Error("contained evidence runtime config directory overlaps worker-writable or frozen policy data")
	}
	if (overlaps(configDir, options.profile.evidenceSocketPath)) throw new Error("contained evidence runtime config directory overlaps collector socket data")
	const configPath = safePrivateFile(path.join(configDir, `${sessionId}.json`))
	for (const protectedPath of [repoRoot, workspaceRoot, options.profile.policySnapshotDir, options.profile.policySnapshotPath, options.profile.evidenceSocketPath, options.profile.evidencePublicKeyPath]) {
		if (overlaps(configPath, protectedPath)) throw new Error("contained evidence runtime config overlaps protected session data")
	}
	let raw: unknown
	try { raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown } catch { throw new Error("contained evidence runtime config is invalid JSON") }
	if (!isRecord(raw)) throw new Error("contained evidence runtime config must be an object")
	const allowedKeys = new Set(["sessionId", "socketPath", "capability", "pinnedPublicKey", "evidenceRequired"])
	if (Object.keys(raw).some((key) => !allowedKeys.has(key))) throw new Error("contained evidence runtime config contains unrecognized fields")
	if (raw.sessionId !== sessionId) throw new Error("contained evidence runtime config session ID does not match the requested worker")
	if (raw.socketPath !== options.profile.evidenceSocketPath) throw new Error("contained evidence runtime config socket differs from the reviewed profile")
	if (typeof raw.capability !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(raw.capability)) throw new Error("contained evidence runtime config does not contain a valid scoped capability")
	if (raw.evidenceRequired !== undefined && raw.evidenceRequired !== true) throw new Error("contained execution requires evidenceRequired: true")
	if (!isRecord(raw.pinnedPublicKey) || raw.pinnedPublicKey.keyId !== options.profile.evidencePublicKeyFingerprint || typeof raw.pinnedPublicKey.publicKeyPem !== "string") throw new Error("contained evidence runtime config public key does not match the reviewed profile")
	const pinnedPem = fs.readFileSync(options.profile.evidencePublicKeyPath, "utf8").trim()
	if (raw.pinnedPublicKey.publicKeyPem.trim() !== pinnedPem) throw new Error("contained evidence runtime config public key bytes do not match the reviewed profile")
	const connection: EvidenceConnectionConfig = {
		sessionId,
		capability: raw.capability,
		socketPath: options.profile.evidenceSocketPath,
		pinnedPublicKey: { keyId: raw.pinnedPublicKey.keyId, publicKeyPem: pinnedPem },
		evidenceRequired: true,
	}
	return { sessionId, evidence: evidenceJournalFromConfig(connection), evidenceConnection: connection, evidenceConfigPath: configPath }
}

export function containedControlStateDirectory(profile: ContainedRuntimeProfile, sessionId: string, repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
	const base = env[CONTROL_STATE_DIR_ENV]
	if (!base) throw new Error(`${CONTROL_STATE_DIR_ENV} must point to a protected supervisor state directory`)
	assertNoSymlinkAncestors(path.resolve(base))
	fs.mkdirSync(path.resolve(base), { recursive: true, mode: 0o700 })
	fs.chmodSync(path.resolve(base), 0o700)
	const root = safeDirectory(base)
	const repo = fs.realpathSync(path.resolve(repoRoot))
	const runtimeConfigDir = env[CONTAINED_EVIDENCE_CONFIG_DIR_ENV] ? path.resolve(env[CONTAINED_EVIDENCE_CONFIG_DIR_ENV]) : undefined
	const scratchRoot = env.HEADLESSCODE_OPENSHELL_SCRATCH_ROOT ? path.resolve(env.HEADLESSCODE_OPENSHELL_SCRATCH_ROOT) : undefined
	for (const protectedPath of [repo, profile.policySnapshotDir, profile.evidenceSocketPath, profile.evidencePublicKeyPath, ...(runtimeConfigDir ? [runtimeConfigDir] : []), ...(scratchRoot ? [scratchRoot] : [])]) {
		if (overlaps(root, protectedPath)) throw new Error("emergency control state directory overlaps guest or evidence data")
	}
	const sessionDir = path.join(root, validateSessionId(sessionId))
	fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
	fs.chmodSync(sessionDir, 0o700)
	if (fs.realpathSync(sessionDir) !== sessionDir || overlaps(sessionDir, repo)) throw new Error("emergency control session directory is unsafe")
	return sessionDir
}

export function containedControlSocketDirectory(profile: ContainedRuntimeProfile, sessionId: string, repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
	const value = env[CONTROL_SOCKET_DIR_ENV] ?? env[CONTROL_STATE_DIR_ENV]
	if (!value) throw new Error(`${CONTROL_STATE_DIR_ENV} must point to a protected supervisor state directory`)
	const baseDirectory = path.resolve(value.replaceAll("{session}", validateSessionId(sessionId)))
	const socketDirectory = value.includes("{session}") ? baseDirectory : path.join(baseDirectory, validateSessionId(sessionId))
	assertNoSymlinkAncestors(path.resolve(path.dirname(socketDirectory)))
	fs.mkdirSync(socketDirectory, { recursive: true, mode: 0o700 })
	fs.chmodSync(socketDirectory, 0o700)
	const root = safeDirectory(socketDirectory)
	const repo = fs.realpathSync(path.resolve(repoRoot))
	const runtimeConfigDir = env[CONTAINED_EVIDENCE_CONFIG_DIR_ENV] ? path.resolve(env[CONTAINED_EVIDENCE_CONFIG_DIR_ENV]) : undefined
	const scratchRoot = env.HEADLESSCODE_OPENSHELL_SCRATCH_ROOT ? path.resolve(env.HEADLESSCODE_OPENSHELL_SCRATCH_ROOT) : undefined
	for (const protectedPath of [repo, profile.policySnapshotDir, profile.evidenceSocketPath, profile.evidencePublicKeyPath, ...(runtimeConfigDir ? [runtimeConfigDir] : []), ...(scratchRoot ? [scratchRoot] : [])]) {
		if (overlaps(root, protectedPath)) throw new Error("emergency control socket directory overlaps guest or evidence data")
	}
	if (fs.realpathSync(root) !== root || overlaps(root, repo)) throw new Error("emergency control socket directory is unsafe")
	return root
}

export async function startContainedSupervisor(options: {
	profile: ContainedRuntimeProfile
	sessionId: string
	repoRoot: string
	workspaceRoot?: string
	env?: NodeJS.ProcessEnv
}): Promise<ContainedSupervisorRuntime & { control: EmergencyControl; close(): Promise<void> }> {
	const evidenceRuntime = loadContainedSupervisorRuntime(options)
	const stateDirectory = containedControlStateDirectory(options.profile, options.sessionId, options.repoRoot, options.env)
	const socketDirectory = containedControlSocketDirectory(options.profile, options.sessionId, options.repoRoot, options.env)
	const control = await EmergencyControl.start({
		identity: options.profile.expectedEmergencyControllerIdentity,
		stateDirectory,
		socketDirectory,
		operatorId: `uid:${typeof process.getuid === "function" ? process.getuid() : "unknown"}`,
	})
	try {
		if (control.identity !== options.profile.expectedEmergencyControllerIdentity) throw new Error("active emergency controller identity does not match the reviewed contained profile")
		control.assertRunning()
	} catch (error) {
		await control.close().catch(() => undefined)
		throw error
	}
	let closed = false
	return {
		...evidenceRuntime,
		control,
		async close() {
			if (closed) return
			closed = true
			await control.close()
		},
	}
}

export function validateContainedSessionId(value: string): string { return validateSessionId(value) }

export function containedEvidenceSessionId(worktreeName: string, prefix = process.env[CONTAINED_SESSION_PREFIX_ENV], directSessionId?: string): string {
	const direct = directSessionId
	if (direct) return validateSessionId(direct)
	return validateSessionId(prefix ? `${prefix}-${worktreeName}` : worktreeName)
}

function safeDirectory(value: string): string {
	const absolute = path.resolve(value)
	assertNoSymlinkAncestors(absolute)
	const real = fs.realpathSync(absolute)
	const stat = fs.lstatSync(real)
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error(`protected runtime directory must be a private real directory: ${real}`)
	return real
}

function safePrivateFile(value: string): string {
	const absolute = path.resolve(value)
	assertNoSymlinkAncestors(absolute)
	const real = fs.realpathSync(absolute)
	const stat = fs.lstatSync(real)
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("contained evidence runtime config must be a private regular file")
	return real
}

function validateSessionId(value: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("contained session ID must contain only letters, numbers, underscore, or hyphen")
	return value
}

function assertNoSymlinkAncestors(value: string): void {
	const absolute = path.resolve(value)
	let cursor = absolute
	while (cursor !== path.dirname(cursor)) {
		try {
			const stat = fs.lstatSync(cursor)
			if (stat.isSymbolicLink()) throw new Error(`protected path contains a symbolic link: ${cursor}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		cursor = path.dirname(cursor)
	}
}

function overlaps(a: string, b: string): boolean {
	const left = path.resolve(a)
	const right = path.resolve(b)
	return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
