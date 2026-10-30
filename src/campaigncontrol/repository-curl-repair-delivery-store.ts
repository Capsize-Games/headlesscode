import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
	canonical,
	isDigest,
	sha256,
} from "./repository-curl-repair-delivery-primitives.js"
export { isDigest } from "./repository-curl-repair-delivery-primitives.js"
import {
	isDeliveryState,
} from "./repository-curl-repair-delivery-state-validation.js"
import type { DeliveryState } from "./repository-curl-repair-delivery-model.js"
import { CURL_REPAIR_PATCH_SHA256 } from "./repository-curl-repair.js"
import {
	BRANCH_PREFIX,
	MAX_STATE_BYTES,
	STATE_SCHEMA,
} from "./repository-curl-repair-delivery-model.js"

export async function ensurePrivateDirectory(directory: string): Promise<void> {
	await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
	const stat = await fsp.lstat(directory)
	if (!isPrivateRealDirectory(directory, stat)) {
		throw new Error(
			"Curl delivery state directory must be an owner-only real directory",
		)
	}
}

async function isPrivateRealDirectory(
	directory: string,
	stat: fs.Stats,
): Promise<boolean> {
	return (
		stat.isDirectory() &&
		!stat.isSymbolicLink() &&
		(stat.mode & 0o077) === 0 &&
		(typeof process.getuid !== "function" ||
			stat.uid === process.getuid()) &&
		(await fsp.realpath(directory)) === directory
	)
}

export async function acquireLock(
	lockPath: string,
): Promise<{ close(): void }> {
	const fd = openLockFile(lockPath)
	try {
		await validateLockFile(fd)
		await acquireExclusiveLock(fd)
		return { close: () => fs.closeSync(fd) }
	} catch (error) {
		fs.closeSync(fd)
		throw error
	}
}

function openLockFile(lockPath: string): number {
	return fs.openSync(
		lockPath,
		fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
		0o600,
	)
}

async function validateLockFile(fd: number): Promise<void> {
	const stat = fs.fstatSync(fd)
	if (!isPrivateOwnerFile(stat)) {
		throw new Error("Curl delivery lock is not a private owner file")
	}
}

function isPrivateOwnerFile(stat: fs.Stats): boolean {
	return (
		stat.isFile() &&
		(stat.mode & 0o077) === 0 &&
		(typeof process.getuid !== "function" || stat.uid === process.getuid())
	)
}

async function acquireExclusiveLock(fd: number): Promise<void> {
	const result = spawnSync(
		"/usr/bin/flock",
		["-n", "-x", "3"],
		lockOptions(fd),
	)
	if (result.error || result.status !== 0) {
		throw new Error("Curl private delivery is already being reconciled")
	}
}

function lockOptions(
	fd: number,
): import("node:child_process").SpawnSyncOptionsWithStringEncoding {
	return {
		encoding: "utf8",
		timeout: 5_000,
		maxBuffer: 16 * 1024,
		stdio: ["ignore", "ignore", "ignore", fd],
		env: {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: os.homedir(),
		},
	}
}

export async function readState(file: string): Promise<DeliveryState> {
	try {
		return await readExistingState(file)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { schemaVersion: STATE_SCHEMA, entries: {} }
		throw error
	}
}

async function readExistingState(file: string): Promise<DeliveryState> {
	const stat = await fsp.lstat(file)
	if (!isPrivateStateFile(stat)) {
		throw new Error("Curl delivery state file is not private or bounded")
	}
	const parsed: unknown = JSON.parse(await fsp.readFile(file, "utf8"))
	if (!isDeliveryState(parsed)) {
		throw new Error("Curl delivery state file has an invalid schema")
	}
	return parsed
}

function isPrivateStateFile(stat: fs.Stats): boolean {
	return (
		stat.isFile() &&
		!stat.isSymbolicLink() &&
		stat.size <= MAX_STATE_BYTES &&
		(stat.mode & 0o077) === 0 &&
		(typeof process.getuid !== "function" || stat.uid === process.getuid())
	)
}

export async function writeState(
	file: string,
	state: DeliveryState,
): Promise<void> {
	const bytes = Buffer.from(canonical(state))
	if (bytes.length > MAX_STATE_BYTES)
		throw new Error("Curl delivery state exceeds its bound")
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
	const handle = await fsp.open(
		temporary,
		fs.constants.O_CREAT |
			fs.constants.O_EXCL |
			fs.constants.O_WRONLY |
			fs.constants.O_NOFOLLOW,
		0o600,
	)
	await writeAndClose(handle, bytes)
	await fsp.rename(temporary, file)
	await syncParentDirectory(file)
}

async function writeAndClose(
	handle: fsp.FileHandle,
	bytes: Buffer,
): Promise<void> {
	try {
		await handle.writeFile(bytes)
		await handle.sync()
	} finally {
		await handle.close()
	}
}

async function syncParentDirectory(file: string): Promise<void> {
	const directory = await fsp.open(path.dirname(file), fs.constants.O_RDONLY)
	try {
		await directory.sync()
	} finally {
		await directory.close()
	}
}

export function validateBranch(branch: string): void {
	if (!validBranch(branch))
		throw new Error("Curl repair branch is outside its fixed identity")
}
function validBranch(branch: string): boolean {
	return new RegExp(
		`^${BRANCH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-f0-9]{16}$`,
	).test(branch)
}
export function isSha(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{40}$/.test(value)
}
