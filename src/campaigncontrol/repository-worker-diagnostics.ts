import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ClaimedRepositoryJob, RepositoryCampaignStep } from "./repository-campaigns.js"

const MAX_DIAGNOSTIC_BYTES = 4 * 1024
const MAX_MESSAGE_LENGTH = 512

export interface RepositoryWorkerDiagnosticInput {
	claim: ClaimedRepositoryJob
	stage: RepositoryCampaignStep
	error: unknown
	observedAt?: number
}

/** Persist a private, bounded failure note and return only its content digest. */
export async function writeRepositoryWorkerDiagnostic(storePath: string,
	input: RepositoryWorkerDiagnosticInput): Promise<{ digest: string }> {
	if (!input?.claim?.job || !/^[0-9a-f-]{36}$/.test(input.claim.job.id) ||
		!/^[0-9a-f-]{36}$/.test(input.claim.claimId) || !Number.isSafeInteger(input.claim.epoch) || input.claim.epoch < 1 ||
		!(["intake", "deduplicate", "investigate", "prepare-candidate", "verify", "deliver"] as string[]).includes(input.stage)) {
		throw new Error("repository worker diagnostic identity is invalid")
	}
	const parent = path.resolve(path.dirname(storePath))
	const parentStat = await fs.lstat(parent)
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && parentStat.uid !== process.getuid()) || await fs.realpath(parent) !== parent) {
		throw new Error("repository worker diagnostic parent is not private")
	}
	const directory = path.join(parent, "worker-diagnostics")
	await fs.mkdir(directory, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error
	})
	const directoryStat = await fs.lstat(directory)
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) || await fs.realpath(directory) !== directory) {
		throw new Error("repository worker diagnostic directory is not private")
	}
	const message = safeErrorMessage(input.error)
	const record = {
		schemaVersion: 1,
		campaignId: input.claim.job.campaignId,
		jobId: input.claim.job.id,
		claimId: input.claim.claimId,
		epoch: input.claim.epoch,
		stage: input.stage,
		observedAt: input.observedAt ?? Date.now(),
		errorName: safeErrorName(input.error),
		message,
		messageSha256: sha256(message),
	}
	if (!Number.isSafeInteger(record.observedAt) || record.observedAt < 0) throw new Error("repository worker diagnostic time is invalid")
	const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
	if (bytes.length > MAX_DIAGNOSTIC_BYTES) throw new Error("repository worker diagnostic exceeds its bound")
	const claimKey = sha256(`${input.claim.job.id}:${input.claim.claimId}:${input.claim.epoch}`)
	const target = path.join(directory, `${claimKey}.json`)
	try {
		const existing = await readPrivateFile(target)
		return { digest: sha256(existing) }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	const temporary = path.join(directory, `.${claimKey}.${randomUUID()}.tmp`)
	const handle = await fs.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
	try {
		await handle.chmod(0o600)
		await handle.writeFile(bytes)
		await handle.sync()
	} finally { await handle.close() }
	try {
		await fs.link(temporary, target)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
	} finally { await fs.unlink(temporary).catch(() => undefined) }
	return { digest: sha256(await readPrivateFile(target)) }
}

async function readPrivateFile(file: string): Promise<Buffer> {
	const info = await fs.lstat(file)
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > MAX_DIAGNOSTIC_BYTES ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("repository worker diagnostic file is not private")
	const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		const opened = await handle.stat()
		if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 || opened.size > MAX_DIAGNOSTIC_BYTES ||
			opened.ino !== info.ino || opened.dev !== info.dev) throw new Error("repository worker diagnostic file changed while opening")
		return await handle.readFile()
	} finally { await handle.close() }
}

function safeErrorName(error: unknown): string {
	const name = error instanceof Error && typeof error.name === "string" ? error.name : "Error"
	return name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error"
}

function safeErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "untyped failure"
	return raw.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted-token]")
		.replace(/\b[A-Za-z0-9_./+=:-]{40,}\b/g, "[redacted-value]")
		.replace(/https?:\/\/[^\s?]+\?[^\s]*/gi, "[redacted-url]")
		.replace(/(?:\/home\/|\/root\/|\/tmp\/|\/var\/tmp\/|\/run\/user\/)[^\s,;)]*/g, "[local-path]")
		.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH)
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex") }
