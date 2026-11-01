import * as fs from "node:fs"
import * as path from "node:path"
import { CURL_PRIVATE_BOARD_CARD_ID, CURL_PRIVATE_BOARD_API_URL as
	BOARD_API_URL } from "./repository-curl-profile.js"
import type { PrivateDeliveryRecord, DeliveryIdentity,
	CurlPrivateDeliveryInput } from "./repository-curl-private-types.js"
import { isDigest, isRecord, isUuid } from
	"./repository-curl-private-guards.js"
import { persistReceipt } from "./repository-curl-private-persistence.js"

const DELIVERY_SCHEMA = 1

export async function readOrCreateRecord(target: string, dedupKey: string,
	evidenceSha256: string,
	identity: DeliveryIdentity,
		input: CurlPrivateDeliveryInput): Promise<PrivateDeliveryRecord> {
	try {
		return await readExistingRecord(target, dedupKey, identity)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const record: PrivateDeliveryRecord = {
		schemaVersion: DELIVERY_SCHEMA, ...identity, firstJobId: input.jobId,
		firstClaimId: input.claimId, firstEpoch: input.epoch, dedupKey,
			evidenceSha256,
		deliveryStatus: "pending", boardRef: null,
	}
	await persistReceipt(target, record)
	return record
}

async function readExistingRecord(target: string, dedupKey: string,
	identity: DeliveryIdentity): Promise<PrivateDeliveryRecord> {
	const info = await fs.promises.lstat(target)
	if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
		throw new Error("private Curl delivery receipt has unsafe permissions")
	}
	const parsed: unknown = JSON.parse(await fs.promises.readFile(target, "utf8"))
	if (!isRecord(parsed)) throw new
		Error("private Curl delivery receipt is invalid")
	const prior = parsed as unknown as PrivateDeliveryRecord
	assertRecordIdentity(prior, identity, dedupKey)
	assertRecordReceipt(prior, dedupKey)
	return prior
}

function assertRecordIdentity(prior: PrivateDeliveryRecord,
	identity: DeliveryIdentity,
	dedupKey: string): void {
	assertRecordKey(prior, dedupKey)
	assertRecordCampaign(prior, identity)
	assertRecordSource(prior, identity)
}

function assertRecordKey(prior: PrivateDeliveryRecord, dedupKey: string): void {
	if (prior.schemaVersion !== DELIVERY_SCHEMA || prior.dedupKey !== dedupKey) {
		throw new Error("private Curl delivery receipt conflicts with prior evidence")
	}
}

function assertRecordCampaign(prior: PrivateDeliveryRecord,
	identity: DeliveryIdentity): void {
	if (prior.campaignId !== identity.campaignId ||
		prior.advisoryId !== identity.advisoryId ||
		prior.disposition !== identity.disposition) {
		throw new Error("private Curl delivery receipt conflicts with prior evidence")
	}
}

function assertRecordSource(prior: PrivateDeliveryRecord,
	identity: DeliveryIdentity): void {
	if (prior.sourceRevision !== identity.sourceRevision ||
		prior.sourceTreeSha256 !== identity.sourceTreeSha256 ||
		prior.candidateSha256 !== identity.candidateSha256 ||
			prior.verificationSha256 !== identity.verificationSha256 ||
		prior.evaluatorDigest !== identity.evaluatorDigest) {
		throw new Error("private Curl delivery receipt conflicts with prior evidence")
	}
}

function assertRecordReceipt(prior: PrivateDeliveryRecord,
	dedupKey: string): void {
	const expectedRef =
		`${BOARD_API_URL}/cards/${CURL_PRIVATE_BOARD_CARD_ID}` +
		`#hc-repository-result-v1:${dedupKey}`
	if (!isDigest(prior.evidenceSha256) || !isUuid(prior.firstJobId) ||
		!isUuid(prior.firstClaimId) ||
		!Number.isSafeInteger(prior.firstEpoch) || prior.firstEpoch < 1 ||
		!(prior.deliveryStatus === "pending" ||
			prior.deliveryStatus === "delivered") ||
		(prior.boardRef !== null && prior.boardRef !== expectedRef)) {
		throw new Error("private Curl delivery receipt conflicts with prior evidence")
	}
}
