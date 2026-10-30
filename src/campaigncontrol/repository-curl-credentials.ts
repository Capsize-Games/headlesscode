import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { verifyFleetBudgetCredential } from "../rsi/fleet-budget-ledger.js"

export async function readFleetOpenRouterCredential(): Promise<{ apiKey:
	string; keyIdentity: string }> {
	const configPath = path.join(os.homedir(), ".local", "state",
		"fleet-security-watch", "automation", "campaign", "config.json")
	if (!await verifyFleetBudgetCredential(configPath)) throw new
		Error("verified Fleet campaign credential is unavailable")
	const configHandle = await fs.promises.open(configPath,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		const keyReference = await readFleetKeyReference(configHandle)
		return await readFleetCredentialFile(keyReference)
	} finally {
		await configHandle.close().catch(() => undefined)
	}
}

interface FleetKeyReference {
	credentialPath: string
	keyIdentity: string
}

async function readFleetKeyReference(handle: fs.promises.FileHandle):
	Promise<FleetKeyReference> {
	await assertPrivateFleetCampaignConfig(handle)
	const value: unknown = JSON.parse(await handle.readFile("utf8"))
	return parseFleetKeyReference(value)
}

async function assertPrivateFleetCampaignConfig(handle:
	fs.promises.FileHandle): Promise<void> {
	const info = await handle.stat()
	if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid()) ||
			info.size > 32 * 1024) {
		throw new Error("verified Fleet campaign configuration is not private")
	}
}

function parseFleetKeyReference(value: unknown): FleetKeyReference {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("verified Fleet campaign configuration is invalid")
	}
	const config = value as Record<string, unknown>
	if (typeof config.credential_file !== "string" ||
		!path.isAbsolute(config.credential_file) ||
		typeof config.key_identity !== "string" ||
			!/^[a-f0-9]{64}$/.test(config.key_identity)) {
		throw new Error("verified Fleet campaign key reference is invalid")
	}
	return { credentialPath: path.resolve(config.credential_file),
		keyIdentity: config.key_identity }
}

async function readFleetCredentialFile(reference: FleetKeyReference):
	Promise<{ apiKey: string; keyIdentity: string }> {
	await assertTrustedCredentialParent(path.dirname(reference.credentialPath))
	const handle = await fs.promises.open(reference.credentialPath,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		await assertPrivateCredentialFile(handle)
		const apiKey = (await handle.readFile()).toString("utf8").trim()
		const keyIdentity = sha256(apiKey)
		if (apiKey.length < 16 || /[\r\n\0]/.test(apiKey) ||
			keyIdentity !== reference.keyIdentity) {
			throw new Error("Fleet credential identity check failed")
		}
		return { apiKey, keyIdentity }
	} finally {
		await handle.close().catch(() => undefined)
	}
}

async function assertTrustedCredentialParent(parentPath: string):
	Promise<void> {
	const parent = await fs.promises.lstat(parentPath)
	if (!parent.isDirectory() || parent.isSymbolicLink() ||
		(parent.mode & 0o022) !== 0 ||
		(typeof process.getuid === "function" && parent.uid !== process.getuid()) ||
		await fs.promises.realpath(parentPath) !== parentPath) {
		throw new Error("Fleet credential directory is not a trusted owner path")
	}
}

async function assertPrivateCredentialFile(handle: fs.promises.FileHandle):
	Promise<void> {
	const info = await handle.stat()
	if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
		info.size < 1 ||
		info.size > 4096 || (typeof process.getuid === "function" &&
			info.uid !== process.getuid())) {
		throw new Error("Fleet credential file is not a private regular file")
	}
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}
