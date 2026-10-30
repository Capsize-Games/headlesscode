import { createHash } from "node:crypto"

export function sameCanonical(left: unknown, right: unknown): boolean {
	return sha256(canonical(left)) === sha256(canonical(right))
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}

export function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`
	}
	const entries = Object.entries(value as Record<string, unknown>)
	const sorted = entries.sort(([left], [right]) => left.localeCompare(right))
	const fields = sorted.map(([key, item]) =>
		`${JSON.stringify(key)}:${canonical(item)}`)
	return `{${fields.join(",")}}`
}

export function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}
