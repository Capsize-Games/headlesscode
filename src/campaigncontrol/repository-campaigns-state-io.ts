import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import type { CampaignState } from "./repository-campaigns-state-model.js"


function validCampaignStateFile(
	stat: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
	const owner = typeof process.getuid !== "function" ||
		stat.uid === process.getuid()
	return stat.isFile() && !stat.isSymbolicLink() &&
		stat.size <= 1024 * 1024 && owner
}

async function parseCampaignStateFile(
	filePath: string,
	validateState: (value: unknown) => value is CampaignState,
): Promise<CampaignState> {
	const stat = await fs.lstat(filePath)
	if (!validCampaignStateFile(stat)) {
		throw new Error("repository campaign state is not a bounded owner file")
	}
	const state = JSON.parse(await fs.readFile(filePath, "utf8")) as CampaignState
	if (state && typeof state === "object" && !Array.isArray(state) &&
		!Object.hasOwn(state, "intakeRecords")) {
		state.intakeRecords = []
	}
	if (!validateState(state)) {
		throw new Error("repository campaign state failed schema validation")
	}
	return state
}

export async function readCampaignStateFile(
	filePath: string,
	validateState: (value: unknown) => value is CampaignState,
): Promise<CampaignState | undefined> {
	try {
		return await parseCampaignStateFile(filePath, validateState)
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined
		}
		throw error
	}
}

export async function ensurePrivateCampaignRoot(parent: string): Promise<void> {
	await fs.mkdir(parent, { recursive: true, mode: 0o700 })
	const stat = await fs.lstat(parent)
	const owner = typeof process.getuid !== "function" ||
		stat.uid === process.getuid()
	const hasPrivateMode = (stat.mode & 0o077) === 0
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		!hasPrivateMode ||
		!owner
	) {
		throw new Error(
			"repository campaign root must be private and owner controlled",
		)
	}
}

async function createCampaignLock(
	lockPath: string,
): Promise<() => Promise<void>> {
	const file = await fs.open(lockPath, "wx", 0o600)
	await file.writeFile(`${process.pid}\n`)
	return async (): Promise<void> => {
		await file.close()
		await fs.rm(lockPath, { force: true })
	}
}

async function campaignLockOwnerAlive(lockPath: string): Promise<boolean> {
	const contents = await fs.readFile(lockPath, "utf8").catch(() => "")
	const owner = Number(contents.trim())
	if (!Number.isSafeInteger(owner) || owner <= 0) return false
	try { process.kill(owner, 0); return true }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

async function removeStaleCampaignLock(lockPath: string): Promise<void> {
	const stale = `${lockPath}.stale.${randomUUID()}`
	await fs.rename(lockPath, stale).catch(() => undefined)
	await fs.rm(stale, { force: true }).catch(() => undefined)
}

export async function acquireCampaignLock(
	lockPath: string,
): Promise<() => Promise<void>> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return await createCampaignLock(lockPath)
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error
			}
			if (!await campaignLockOwnerAlive(lockPath)) {
				await removeStaleCampaignLock(lockPath)
				continue
			}
			await new Promise((resolve) => setTimeout(resolve, 10 + attempt))
		}
	}
	throw new Error("repository campaign state is busy")
}

