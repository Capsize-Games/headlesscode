import { createPublicKey, verify as verifySignature } from "node:crypto"
import { canonicalJson, boundedCanonicalJson, sha256 } from "./canonical.js"
import type { EvidenceBundle, EvidencePublicKey, EvidenceReceipt, EvidenceVerification, SignedSessionHead } from "./types.js"

function unsignedHead(head: SignedSessionHead): Omit<SignedSessionHead, "signature"> {
	const { signature: _signature, ...unsigned } = head
	return unsigned
}

function verifyReceipt(receipt: EvidenceReceipt, publicKey: EvidencePublicKey): boolean {
	const { signature, ...unsigned } = receipt
	return receipt.keyId === publicKey.keyId && verifySignature(null, Buffer.from(canonicalJson(unsigned)), createPublicKey(publicKey.publicKeyPem), Buffer.from(signature, "base64"))
}

export function verifyEvidenceBundle(bundle: EvidenceBundle, pinnedPublicKey: EvidencePublicKey, pinnedHead: SignedSessionHead): EvidenceVerification {
	const errors: string[] = []
	const history: EvidenceVerification["readableHistory"] = []
	if (bundle.schemaVersion !== 1) errors.push("unsupported bundle schema version")
	if (bundle.sessionId !== pinnedHead.sessionId || bundle.head.sessionId !== bundle.sessionId) errors.push("session id does not match pinned head")
	if (bundle.publicKey.keyId !== pinnedPublicKey.keyId || bundle.head.keyId !== pinnedPublicKey.keyId || pinnedHead.keyId !== pinnedPublicKey.keyId) errors.push("collector key id does not match pinned key")
	if (canonicalJson(bundle.head) !== canonicalJson(pinnedHead)) errors.push("exported final head does not match supervisor-pinned head")
	if ((bundle.receipts?.length ?? 0) !== bundle.records.length) errors.push("receipt count does not match record count")
	const key = createPublicKey(pinnedPublicKey.publicKeyPem)
	for (const [label, head] of [["bundle", bundle.head], ["pinned", pinnedHead]] as const) {
		const { signature, ...unsigned } = head
		if (!verifySignature(null, Buffer.from(canonicalJson(unsignedHead(head))), key, Buffer.from(signature, "base64"))) errors.push(`${label} head signature is invalid`)
	}
	let previous: string | null = null
	const seenRequests = new Set<string>()
	for (let index = 0; index < bundle.records.length; index++) {
		const record = bundle.records[index]
		if (record.sequence !== index + 1) errors.push(`sequence gap, duplicate, or reorder at record ${index + 1}`)
		if (record.previousDigest !== previous) errors.push(`previous digest mismatch at sequence ${record.sequence}`)
		if (seenRequests.has(record.requestId)) errors.push(`replayed request id at sequence ${record.sequence}`)
		seenRequests.add(record.requestId)
		const { digest, ...body } = record
		try {
			if (sha256(boundedCanonicalJson(body)) !== digest) errors.push(`record digest mismatch at sequence ${record.sequence}`)
		} catch (error) { errors.push(`record ${record.sequence} is invalid: ${error instanceof Error ? error.message : String(error)}`) }
		if (record.source !== "worker-reported" && record.source !== "supervisor-observed") errors.push(`invalid source marker at sequence ${record.sequence}`)
		const receipt = bundle.receipts?.[index]
		if (!receipt || !verifyReceipt(receipt, pinnedPublicKey)) errors.push(`receipt signature is invalid at sequence ${record.sequence}`)
		else if (receipt.sessionId !== bundle.sessionId || receipt.requestId !== record.requestId || receipt.sequence !== record.sequence || receipt.recordDigest !== record.digest || receipt.inputDigest !== record.requestDigest) errors.push(`receipt does not match record at sequence ${record.sequence}`)
		previous = record.digest
		history.push({ sequence: record.sequence, occurredAt: record.occurredAt, source: record.source, actor: record.actor, kind: record.kind, ...(record.actionId ? { actionId: record.actionId } : {}), payload: record.payload })
	}
	if (pinnedHead.sequence !== bundle.records.length) errors.push(`pinned head expects ${pinnedHead.sequence} records, found ${bundle.records.length}`)
	if (pinnedHead.digest !== previous) errors.push("final record digest does not match pinned head")
	if (!bundle.records.length && (pinnedHead.sequence !== 0 || pinnedHead.digest !== null)) errors.push("empty journal does not match pinned non-empty head")
	return { valid: errors.length === 0, checkedRecords: bundle.records.length, errors, readableHistory: history }
}
