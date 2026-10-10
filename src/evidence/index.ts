import * as fs from "node:fs/promises"
import type { EvidenceBundle, EvidencePublicKey, EvidenceVerification, SignedSessionHead } from "./types.js"
import { verifyEvidenceBundle } from "./verify.js"
import { HttpEvidenceJournal, UnixEvidenceJournal } from "./collector.js"
import type { EvidenceJournal } from "./types.js"

export * from "./types.js"
export * from "./canonical.js"
export * from "./collector.js"
export * from "./verify.js"
export { evidenceMain, runEvidenceCli } from "./cli.js"

export async function verifyEvidenceFiles(bundlePath: string, pinnedKeyPath: string, pinnedHeadPath: string): Promise<EvidenceVerification> {
	const [bundleRaw, keyRaw, headRaw] = await Promise.all([
		fs.readFile(bundlePath, "utf8"), fs.readFile(pinnedKeyPath, "utf8"), fs.readFile(pinnedHeadPath, "utf8"),
	])
	const bundle = JSON.parse(bundleRaw) as EvidenceBundle
	const keyValue = JSON.parse(keyRaw) as EvidencePublicKey
	const pinnedHead = JSON.parse(headRaw) as SignedSessionHead
	return verifyEvidenceBundle(bundle, keyValue, pinnedHead)
}

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
