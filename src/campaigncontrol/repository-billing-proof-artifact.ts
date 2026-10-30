import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "node:path"
import type { ClaimedRepositoryJob } from "./repository-campaigns.js"
import type {
	FleetRepositoryClosedSessionProof,
} from "../rsi/fleet-repository-budget-ledger.js"

export async function persistClosedSessionProof(
	storePath: string,
	claim: ClaimedRepositoryJob,
	proof: FleetRepositoryClosedSessionProof,
): Promise<string> {
	const parent = path.resolve(path.dirname(storePath))
	await verifyPrivateDirectory(parent, "billing proof parent")
	const directory = path.join(parent, "partial-billing-proofs")
	await fs.mkdir(directory, { mode: 0o700 }).catch(
		(error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error
		},
	)
	await verifyPrivateDirectory(directory, "billing proof directory")
	const record = { schemaVersion: 1, claimId: claim.claimId, epoch: claim.epoch,
		jobId: claim.job.id, proof }
	return writeProofArtifact(directory, claim, record)
}

async function verifyPrivateDirectory(
	directory: string,
	label: string,
): Promise<void> {
	const info = await fs.lstat(directory)
	const ownerMismatch = typeof process.getuid === "function" &&
		info.uid !== process.getuid()
	const privateDir = info.isDirectory() && !info.isSymbolicLink() &&
		!(info.mode & 0o077) && !ownerMismatch
	if (!privateDir) {
		throw new Error(`${label} is not owner-only`)
	}
}

async function writeProofArtifact(
	directory: string,
	claim: ClaimedRepositoryJob,
	record: Record<string, unknown>,
): Promise<string> {
	const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
	if (bytes.byteLength > 24 * 1024) {
		throw new Error("billing proof exceeds storage bound")
	}
	const digest = createHash("sha256").update(bytes).digest("hex")
	const target = path.join(directory, proofFilename(claim, digest))
	const temporary = path.join(directory, `.${claim.job.id}.${randomUUID()}.tmp`)
	await writeExclusiveFile(temporary, bytes)
	await linkOrVerify(temporary, target, bytes)
	return digest
}

function proofFilename(claim: ClaimedRepositoryJob, digest: string): string {
	return `${claim.job.id}-${claim.claimId}-${claim.epoch}-${digest}.json`
}

async function writeExclusiveFile(
	filename: string,
	bytes: Buffer,
): Promise<void> {
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT |
		fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
	const handle = await fs.open(filename, flags, 0o600)
	try {
		await handle.chmod(0o600)
		await handle.writeFile(bytes)
		await handle.sync()
	} finally {
		await handle.close()
	}
}

async function linkOrVerify(
	temporary: string,
	target: string,
	bytes: Buffer,
): Promise<void> {
	try {
		await fs.link(temporary, target)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		const existing = await fs.readFile(target)
		if (!existing.equals(bytes)) {
			throw new Error("existing billing proof conflicts")
		}
	} finally {
		await fs.unlink(temporary).catch(() => undefined)
	}
}
