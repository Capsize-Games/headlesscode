import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { acquirePrivateDeliveryLock } from
	"./repository-curl-private-lock.js"

export interface CurlRepairV2DeliveryState {
	schemaVersion: 2
	campaignId: string
	repositoryId: string
	jobId: string
	firstClaimId: string
	firstEpoch: number
	policySha256: string
	candidateSha256: string
	evidenceSha256: string
	marker: string
	deliveryStatus: "pending" | "delivered"
	boardRef: string | null
	updatedAt: number
}

export async function withDeliveryState<T>(
	storePath: string,
	stateRoot: string | undefined,
	jobId: string,
	callback: (input: {
		directory: string
		statePath: string
		lock: fs.promises.FileHandle
	}) => Promise<T>,
): Promise<T> {
	const directory = await prepareDirectory(storePath, stateRoot)
	const lock = await openDeliveryLock(directory, jobId)
	try {
		return await runLocked(directory, jobId, lock, callback)
	} finally {
		await lock.close()
	}
}

async function runLocked<T>(
	directory: string,
	jobId: string,
	lock: fs.promises.FileHandle,
	callback: (input: {
		directory: string
		statePath: string
		lock: fs.promises.FileHandle
	}) => Promise<T>,
): Promise<T> {
	await acquirePrivateDeliveryLock(lock)
	return await callback({
		directory,
		statePath: path.join(directory, `${jobId}.json`),
		lock,
	})
}

async function prepareDirectory(
	storePath: string,
	stateRoot: string | undefined,
): Promise<string> {
	const directory = path.resolve(stateRoot ?? path.join(
		path.dirname(path.resolve(storePath)),
		"curl-repair-v2-delivery",
	))
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
	const info = await fs.promises.lstat(directory)
	if (!info.isDirectory() || info.isSymbolicLink() ||
		(info.mode & 0o077) !== 0 || !ownedByCurrentUser(info.uid)) {
		throw new Error("Curl v2 delivery state directory is not owner-only")
	}
	return directory
}

async function openDeliveryLock(
	directory: string,
	jobId: string,
): Promise<fs.promises.FileHandle> {
	const lockPath = path.join(directory, `${jobId}.lock`)
	const lock = await fs.promises.open(lockPath,
		fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
		0o600,
	)
	const info = await lock.stat()
	if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
		!ownedByCurrentUser(info.uid)) {
		await lock.close()
		throw new Error("Curl v2 delivery lock is not an owner-only file")
	}
	return lock
}

export async function readDeliveryState(
	statePath: string,
): Promise<CurlRepairV2DeliveryState | null> {
	try {
		const info = await fs.promises.lstat(statePath)
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
			(info.mode & 0o077) !== 0 || !ownedByCurrentUser(info.uid) ||
			info.size > 32_768) {
			throw new Error("Curl v2 delivery receipt has unsafe permissions")
		}
		return parseDeliveryState(await fs.promises.readFile(statePath, "utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw error
	}
}

function parseDeliveryState(value: string): CurlRepairV2DeliveryState {
	const record = JSON.parse(value) as Partial<CurlRepairV2DeliveryState>
	if (!hasDeliveryIdentity(record) || !hasDeliveryStatus(record)) {
		throw new Error("Curl v2 delivery receipt is invalid")
	}
	return record as CurlRepairV2DeliveryState
}

function hasDeliveryIdentity(
	record: Partial<CurlRepairV2DeliveryState>,
): boolean {
	return record.schemaVersion === 2 && typeof record.jobId === "string" &&
		typeof record.campaignId === "string" &&
		typeof record.repositoryId === "string" &&
		typeof record.policySha256 === "string" &&
		typeof record.candidateSha256 === "string" &&
		typeof record.evidenceSha256 === "string" &&
		typeof record.marker === "string"
}

function hasDeliveryStatus(
	record: Partial<CurlRepairV2DeliveryState>,
): boolean {
	return (record.deliveryStatus === "pending" ||
		record.deliveryStatus === "delivered") &&
		(record.boardRef === null || typeof record.boardRef === "string") &&
		Number.isSafeInteger(record.firstEpoch) &&
		typeof record.firstClaimId === "string" &&
		Number.isSafeInteger(record.updatedAt)
}

export async function writeDeliveryState(
	statePath: string,
	state: CurlRepairV2DeliveryState,
): Promise<void> {
	const temporary = `${statePath}.${randomUUID()}.tmp`
	await writeTemporary(temporary, state)
	await fs.promises.rename(temporary, statePath)
	await syncDirectory(path.dirname(statePath))
}

async function writeTemporary(
	temporary: string,
	state: CurlRepairV2DeliveryState,
): Promise<void> {
	const file = await fs.promises.open(
		temporary,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
			fs.constants.O_NOFOLLOW,
		0o600,
	)
	try {
		await file.chmod(0o600)
		await file.writeFile(`${JSON.stringify(state)}\n`)
		await file.sync()
	} finally {
		await file.close()
	}
	}

async function syncDirectory(directoryPath: string): Promise<void> {
	const directory = await fs.promises.open(directoryPath, fs.constants.O_RDONLY)
	try {
		await directory.sync()
	} finally {
		await directory.close()
	}
}

function ownedByCurrentUser(uid: number): boolean {
	return typeof process.getuid !== "function" || uid === process.getuid()
}
