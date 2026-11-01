import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CURL_CANDIDATE_TREE_SHA, CURL_EVALUATOR_DIGEST, CURL_FIXED_ADVISORY,
	CURL_PRIVATE_SOURCE_REVISION } from "./repository-curl-evaluator.js"
import { CURL_PRIVATE_BOARD_CARD_ID,
	CURL_PRIVATE_BOARD_API_URL as BOARD_API_URL } from
		"./repository-curl-profile.js"
import { assertDeliveryInput } from "./repository-curl-private-validation.js"
import { fixedBoardTransport } from "./repository-curl-private-board.js"
import { acquirePrivateDeliveryLock } from "./repository-curl-private-lock.js"
import { canonical, persistReceipt, sha256 } from
	"./repository-curl-private-persistence.js"
import { readOrCreateRecord } from "./repository-curl-private-records.js"
import type {
	CurlPrivateBoardTransport, CurlPrivateDeliveryInput, DeliveryIdentity,
	PrivateDeliveryRecord,
} from "./repository-curl-private-types.js"
import { isDigest, isRecord, isUuid } from
	"./repository-curl-private-guards.js"

export type {
	CurlPrivateBoardTransport, CurlPrivateDeliveryInput, DeliveryIdentity,
	PrivateDeliveryRecord,
} from "./repository-curl-private-types.js"

const DELIVERY_SCHEMA = 1

export async function writePrivateCurlDeliveryReceipt(
	storePath: string,
	input: CurlPrivateDeliveryInput,
	board: CurlPrivateBoardTransport = fixedBoardTransport(),
): Promise<{ accepted: boolean; evidenceSha256: string; boardRef: string }> {
	assertDeliveryInput(input)
	const directory = await prepareDeliveryDirectory(storePath)
	const identity = makeDeliveryIdentity(input)
	return await withDeliveryLock(directory, identity, input, board)
}

async function prepareDeliveryDirectory(storePath: string): Promise<string> {
	const directory = path.join(path.dirname(path.resolve(storePath)),
		"repository-delivery")
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
	const info = await fs.promises.lstat(directory)
	if (!info.isDirectory() || info.isSymbolicLink() ||
		(info.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) {
		throw new Error("private delivery directory must be owner-only")
	}
	return directory
}

function makeDeliveryIdentity(input: CurlPrivateDeliveryInput):
	DeliveryIdentity {
	return {
		campaignId: input.campaignId, advisoryId: input.advisoryId,
		sourceRevision: input.sourceRevision,
			sourceTreeSha256: input.sourceTreeSha256,
		candidateSha256: input.candidateSha256,
			verificationSha256: input.verificationSha256,
		evaluatorDigest: CURL_EVALUATOR_DIGEST, disposition: input.disposition,
	}
}

async function withDeliveryLock(
	directory: string,
	identity: DeliveryIdentity,
	input: CurlPrivateDeliveryInput,
	board: CurlPrivateBoardTransport,
): Promise<{ accepted: boolean; evidenceSha256: string; boardRef: string }> {
	const dedupKey = sha256(canonical(identity))
	const evidenceSha256 = makeEvidenceDigest(identity, input)
	const lock = await openDeliveryLock(directory, dedupKey)
	try {
		await acquirePrivateDeliveryLock(lock)
		const target = path.join(directory, `${dedupKey}.json`)
		const record = await readOrCreateRecord(target, dedupKey, evidenceSha256,
			identity, input)
		return await deliverRecord({ target, dedupKey, record, input, board, lock })
	} finally {
		await lock.close()
	}
}

function makeEvidenceDigest(identity: DeliveryIdentity,
	input: CurlPrivateDeliveryInput): string {
	return sha256(canonical({ ...identity, firstJobId: input.jobId,
		firstClaimId: input.claimId, firstEpoch: input.epoch }))
}

async function openDeliveryLock(directory: string,
	dedupKey: string): Promise<fs.promises.FileHandle> {
	const lockPath = path.join(directory, `${dedupKey}.lock`)
	const lock = await fs.promises.open(lockPath,
		fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
	const info = await lock.stat()
	if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) {
		await lock.close()
		throw new
			Error("private Curl delivery lock is not an owner-only regular file")
	}
	return lock
}


interface DeliveryTask {
	target: string
	dedupKey: string
	record: PrivateDeliveryRecord
	input: CurlPrivateDeliveryInput
	board: CurlPrivateBoardTransport
	lock: fs.promises.FileHandle
}

async function deliverRecord(task: DeliveryTask): Promise<{ accepted:
	boolean; evidenceSha256: string; boardRef: string }> {
	const { target, dedupKey, record, input, board, lock } = task
	if (record.deliveryStatus === "delivered" && record.boardRef) {
		return { accepted: true, evidenceSha256: record.evidenceSha256,
			boardRef: record.boardRef }
	}
	const marker = `hc-repository-result-v1:${dedupKey}`
	const comment = makeDeliveryComment(marker, input, record)
	await ensureBoardComment(marker, comment, board, lock)
	const delivered = { ...record, deliveryStatus: "delivered" as const,
		boardRef: `${BOARD_API_URL}/cards/${CURL_PRIVATE_BOARD_CARD_ID}#${marker}` }
	await persistReceipt(target, delivered)
	return { accepted: true, evidenceSha256: record.evidenceSha256,
		boardRef: delivered.boardRef }
}

function makeDeliveryComment(marker: string, input: CurlPrivateDeliveryInput,
	record: PrivateDeliveryRecord): string {
	return [
		`[${marker}] ${CURL_FIXED_ADVISORY}: already-fixed in`,
		`${CURL_PRIVATE_SOURCE_REVISION} (tree ${CURL_CANDIDATE_TREE_SHA});`,
		`candidate ${input.candidateSha256}; protected evidence`,
		`${input.verificationSha256}; evaluator ${CURL_EVALUATOR_DIGEST}.`,
		`Job ${record.firstJobId}, claim ${record.firstClaimId},`,
		`epoch ${record.firstEpoch}. No public PR was created.`,
	].join(" ")
}

async function ensureBoardComment(marker: string, comment: string,
	board: CurlPrivateBoardTransport,
		lock: fs.promises.FileHandle): Promise<void> {
	if (await board.hasMarker(marker, lock)) return
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await board.addComment(comment, lock)
			break
		} catch {
			if (await board.hasMarker(marker, lock)) return
			if (attempt === 1) throw new
				Error("private board delivery is pending reconciliation")
		}
	}
	if (!await board.hasMarker(marker, lock)) {
		throw new Error("private board comment was not verified after delivery")
	}
}
