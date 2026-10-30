import { createHash } from "node:crypto"

export function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex")
}

export function canonical(value: unknown): string {
	if (value === null || typeof value !== "object")
		return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
		.join(",")}}`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}
