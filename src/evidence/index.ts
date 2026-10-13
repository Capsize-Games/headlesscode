import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { EvidencePublicKey } from "./types.js"
import { HttpEvidenceJournal, UnixEvidenceJournal } from "./collector.js"
import type { EvidenceJournal } from "./types.js"

export * from "./types.js"
export * from "./canonical.js"
export * from "./collector.js"
export * from "./verify.js"
export { evidenceMain, runEvidenceCli } from "./cli.js"

// Re-exported for backward compatibility (the leaf now owns the function).
export { verifyEvidenceFiles } from "./verify.js"

export interface EvidenceRuntimeConfig { sessionId: string; evidenceJournal: EvidenceJournal; evidenceRequired: boolean }
export type EvidenceConnectionConfig = {
	sessionId: string
	capability: string
	pinnedPublicKey: EvidencePublicKey
	evidenceRequired?: boolean
} & ({ socketPath: string } | { baseUrl: string; tlsServerFingerprintSha256?: string })

/** Construct a worker client from a supervisor-only in-memory handoff object. */
export function evidenceJournalFromConfig(config: EvidenceConnectionConfig): EvidenceRuntimeConfig {
	if (!config.capability || !config.sessionId) throw new Error("evidence runtime handoff is missing its session or append capability")
	const common = { sessionId: config.sessionId, capability: config.capability, pinnedPublicKey: config.pinnedPublicKey }
	const evidenceJournal = "socketPath" in config
		? new UnixEvidenceJournal({ ...common, socketPath: config.socketPath })
		: new HttpEvidenceJournal({ ...common, baseUrl: config.baseUrl, tlsServerFingerprintSha256: config.tlsServerFingerprintSha256 })
	return { sessionId: config.sessionId, evidenceJournal, evidenceRequired: config.evidenceRequired ?? false }
}

export async function evidenceJournalFromProtectedConfigFile(configPath: string, options: { expectedSessionId?: string; forbiddenRoots?: string[] } = {}): Promise<EvidenceRuntimeConfig> {
	const absolute = path.resolve(configPath)
	let ancestor = absolute
	while (ancestor !== path.dirname(ancestor)) {
		const ancestorStat = await fs.lstat(ancestor)
		if (ancestorStat.isSymbolicLink()) throw new Error("evidence runtime config path must not traverse symbolic links")
		ancestor = path.dirname(ancestor)
	}
	const stat = await fs.lstat(absolute)
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o400) throw new Error("evidence runtime config must be owner-read-only")
	const real = await fs.realpath(absolute)
	for (const root of options.forbiddenRoots ?? []) {
		const forbidden = path.resolve(root)
		if (real === forbidden || real.startsWith(`${forbidden}${path.sep}`)) throw new Error("evidence runtime config must be outside worker-writable paths")
	}
	let raw: unknown
	try { raw = JSON.parse(await fs.readFile(absolute, "utf8")) as unknown } catch { throw new Error("evidence runtime config is invalid JSON") }
	if (!isRecord(raw) || typeof raw.sessionId !== "string" || typeof raw.capability !== "string" || (raw.evidenceRequired !== undefined && typeof raw.evidenceRequired !== "boolean") || !isRecord(raw.pinnedPublicKey) || typeof raw.pinnedPublicKey.keyId !== "string" || typeof raw.pinnedPublicKey.publicKeyPem !== "string") throw new Error("evidence runtime config is incomplete")
	const allowedKeys = new Set(["sessionId", "capability", "evidenceRequired", "pinnedPublicKey", "socketPath", "baseUrl", "tlsServerFingerprintSha256"])
	if (Object.keys(raw).some((key) => !allowedKeys.has(key)) || Object.keys(raw.pinnedPublicKey).some((key) => key !== "keyId" && key !== "publicKeyPem")) throw new Error("evidence runtime config contains unrecognized fields")
	const evidenceRequired = raw.evidenceRequired ?? true
	if (options.expectedSessionId && raw.sessionId !== options.expectedSessionId) throw new Error("evidence runtime config session ID does not match the active runtime")
	const hasSocket = typeof raw.socketPath === "string"
	const hasUrl = typeof raw.baseUrl === "string"
	if (hasSocket === hasUrl) throw new Error("evidence runtime config must contain exactly one collector route")
	if (hasSocket) {
		if (typeof raw.socketPath !== "string") throw new Error("evidence runtime config socket route is invalid")
		return evidenceJournalFromConfig({ sessionId: raw.sessionId, capability: raw.capability, pinnedPublicKey: { keyId: raw.pinnedPublicKey.keyId, publicKeyPem: raw.pinnedPublicKey.publicKeyPem }, socketPath: raw.socketPath, evidenceRequired })
	}
	if (hasUrl) {
		if (typeof raw.baseUrl !== "string") throw new Error("evidence runtime config URL route is invalid")
		return evidenceJournalFromConfig({ sessionId: raw.sessionId, capability: raw.capability, pinnedPublicKey: { keyId: raw.pinnedPublicKey.keyId, publicKeyPem: raw.pinnedPublicKey.publicKeyPem }, baseUrl: raw.baseUrl, ...(typeof raw.tlsServerFingerprintSha256 === "string" ? { tlsServerFingerprintSha256: raw.tlsServerFingerprintSha256 } : {}), evidenceRequired })
	}
	throw new Error("evidence runtime config has no collector route")
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }

/**
 * Build the client using non-secret route settings from the environment and a
 * capability passed separately when available. A protected process environment
 * may carry the capability for controlled CLI integrations.
 */
export function evidenceJournalFromEnv(env: NodeJS.ProcessEnv = process.env, capability?: string): EvidenceRuntimeConfig | undefined {
	const sessionId = env.HEADLESSCODE_EVIDENCE_SESSION_ID
	const scopedCapability = capability ?? env.HEADLESSCODE_EVIDENCE_CAPABILITY
	const keyId = env.HEADLESSCODE_EVIDENCE_KEY_ID
	const publicKeyBase64 = env.HEADLESSCODE_EVIDENCE_PUBLIC_KEY_B64
	const socketPath = env.HEADLESSCODE_EVIDENCE_SOCKET
	const baseUrl = env.HEADLESSCODE_EVIDENCE_URL
	const enabledRaw = env.HEADLESSCODE_EVIDENCE_REQUIRED
	const evidenceRequired = enabledRaw === "1" || enabledRaw?.toLowerCase() === "true"
	if (!sessionId && !capability && !keyId && !publicKeyBase64 && !socketPath && !baseUrl && !evidenceRequired) return undefined
	if (!sessionId || !scopedCapability || !keyId || !publicKeyBase64 || Boolean(socketPath) === Boolean(baseUrl)) {
		throw new Error("evidence configuration is incomplete; provide session id, a runtime-only scoped capability, pinned key, and exactly one collector route")
	}
	const pinnedPublicKey = { keyId, publicKeyPem: Buffer.from(publicKeyBase64, "base64").toString("utf8") }
	return evidenceJournalFromConfig({
		sessionId,
		capability: scopedCapability,
		pinnedPublicKey,
		evidenceRequired,
		...(socketPath ? { socketPath } : { baseUrl: baseUrl!, tlsServerFingerprintSha256: env.HEADLESSCODE_EVIDENCE_TLS_FINGERPRINT }),
	})
}
