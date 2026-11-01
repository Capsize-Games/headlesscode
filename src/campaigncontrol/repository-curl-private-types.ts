import type * as fs from "node:fs"

export interface CurlPrivateBoardTransport {
	hasMarker(marker: string, lock: fs.promises.FileHandle): Promise<boolean>
	addComment(comment: string, lock: fs.promises.FileHandle): Promise<void>
}

export interface CurlPrivateDeliveryInput {
	campaignId: string
	jobId: string
	claimId: string
	epoch: number
	advisoryId: string
	candidateSha256: string
	verificationSha256: string
	disposition: "already-fixed"
	sourceRevision: string
	sourceTreeSha256: string
}

export interface DeliveryIdentity {
	campaignId: string
	advisoryId: string
	sourceRevision: string
	sourceTreeSha256: string
	candidateSha256: string
	verificationSha256: string
	evaluatorDigest: string
	disposition: "already-fixed"
}

export interface PrivateDeliveryRecord extends DeliveryIdentity {
	schemaVersion: 1
	firstJobId: string
	firstClaimId: string
	firstEpoch: number
	dedupKey: string
	evidenceSha256: string
	deliveryStatus: "pending" | "delivered"
	boardRef: string | null
}
