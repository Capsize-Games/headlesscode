import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import type { PrivateDeliveryRecord } from
	"./repository-curl-private-types.js"

export async function persistReceipt(target: string,
	record: PrivateDeliveryRecord): Promise<void> {
	const temp = `${target}.${randomUUID()}.tmp`
	const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
	const fd = await fs.promises.open(temp,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
			fs.constants.O_NOFOLLOW, 0o600)
	try { await fd.chmod(0o600); await fd.writeFile(bytes); await fd.sync() }
		finally { await fd.close() }
	await fs.promises.rename(temp, target)
}


export function canonical(value: object): string {
	return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],
		[b]) => a.localeCompare(b))))
}

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}
