export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value)
}

export function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}
