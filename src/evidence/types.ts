export type EvidenceSource = "worker-reported" | "supervisor-observed"

export interface EvidenceInput {
	sessionId: string
	requestId: string
	actionId?: string
	iteration?: number
	kind: string
	actor: string
	origin: string
	occurredAt?: string
	payload: unknown
}

export interface CanonicalEvidenceRecord extends EvidenceInput {
	schemaVersion: 1
	sequence: number
	previousDigest: string | null
	requestDigest: string
	occurredAt: string
	recordedAt: string
	source: EvidenceSource
	digest: string
}

export interface EvidenceReceipt {
	schemaVersion: 1
	sessionId: string
	requestId: string
	sequence: number
	recordDigest: string
	inputDigest: string
	keyId: string
	signature: string
}

export interface SignedSessionHead {
	schemaVersion: 1
	sessionId: string
	sequence: number
	digest: string | null
	keyId: string
	signature: string
}

export interface EvidenceJournal {
	append(input: EvidenceInput, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<EvidenceReceipt>
}

export interface EvidencePublicKey {
	keyId: string
	publicKeyPem: string
}

export interface EvidenceBundle {
	schemaVersion: 1
	sessionId: string
	publicKey: EvidencePublicKey
	records: CanonicalEvidenceRecord[]
	receipts: EvidenceReceipt[]
	head: SignedSessionHead
}

export interface EvidenceVerification {
	valid: boolean
	checkedRecords: number
	errors: string[]
	readableHistory: Array<{
		sequence: number
		occurredAt: string
		source: EvidenceSource
		actor: string
		kind: string
		actionId?: string
		payload: unknown
	}>
}

export const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024
