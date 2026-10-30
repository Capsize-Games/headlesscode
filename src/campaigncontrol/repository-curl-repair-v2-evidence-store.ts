import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type {
	CurlRepairV2ClaimIdentity,
	CurlRepairV2StageReceipt,
} from "./repository-curl-repair-v2-receipt-types.js"

const STATE_ROOT = path.join(
	os.homedir(),
	".local/state/fleet-security-watch/automation",
	"repository-campaign-evidence/curl-92390-historical-v2",
)
const MAX_RECEIPT_BYTES = 32_768

export function evidenceRoot(): string {
	return STATE_ROOT
}

export async function ensurePrivateRoot(directory: string): Promise<void> {
	await ensureOwnerPrivateRoot(directory)
}

export async function ensureCancelMarker(filePath: string): Promise<void> {
	await ensureOwnerPrivateRoot(path.dirname(filePath))
	try {
		const handle = await fs.open(filePath, "wx", 0o600)
		await handle.close()
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		const info = await fs.lstat(filePath)
		if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) {
			throw new Error("Curl v2 cancellation marker is unsafe")
		}
	}
}

export async function readReceipt<T>(
	claim: CurlRepairV2ClaimIdentity,
	name: string,
	validate: (value: unknown, claim: CurlRepairV2ClaimIdentity) => value is T,
): Promise<CurlRepairV2StageReceipt<T>> {
	const filePath = path.join(
		STATE_ROOT, "curl-historical-v2", claim.jobId, name,
	)
	await ensurePrivateRoot(path.dirname(filePath))
	const info = await fs.lstat(filePath)
	assertPrivateReceipt(info)
	const bytes = await fs.readFile(filePath)
	const value: unknown = JSON.parse(bytes.toString("utf8"))
	assertValidReceipt(validate, value, claim)
	return {
		receipt: value,
		receiptFileSha256: createHash("sha256").update(bytes).digest("hex"),
	}
}

function assertValidReceipt<T>(
	validate: (value: unknown, claim: CurlRepairV2ClaimIdentity) => value is T,
	value: unknown,
	claim: CurlRepairV2ClaimIdentity,
): asserts value is T {
	if (!validate(value, claim)) {
		throw new Error("Curl v2 receipt does not match the active claim")
	}
}

function assertPrivateReceipt(info: import("node:fs").Stats): void {
	if (!info.isFile() || info.isSymbolicLink() ||
		(typeof process.getuid === "function" && info.uid !== process.getuid()) ||
		info.mode & 0o077 || info.size > MAX_RECEIPT_BYTES) {
		throw new Error("Curl v2 receipt is not private")
	}
}

async function ensureOwnerPrivateRoot(directory: string): Promise<void> {
	const absolute = path.resolve(directory)
	const home = path.resolve(os.homedir())
	if (!absolute.startsWith(home + path.sep)) {
		throw new Error("Curl v2 state path is outside home")
	}
	await assertPrivateDirectory(home)
	const parts = path.relative(home, absolute).split(path.sep).filter(Boolean)
	for (const part of parts) {
		await ensurePrivateDirectory(path.join(home, part))
	}
	await fs.chmod(absolute, 0o700)
}

async function assertPrivateDirectory(directory: string): Promise<void> {
	const info = await fs.lstat(directory)
	if (!info.isDirectory() || info.isSymbolicLink() ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) {
		throw new Error("Curl v2 state path is not owner-private")
	}
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	try {
		await fs.mkdir(directory, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
	}
	await assertPrivateDirectory(directory)
}
