import { createHash } from "node:crypto"
import { DEFAULT_MAX_RECORD_BYTES } from "./types.js"

const SECRET_FIELD = /(?:api.?key|access.?token|auth(?:orization)?|password|passwd|secret|private.?key|credential|cookie)/i
const SECRET_TEXT = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*|\b(sk-[A-Za-z0-9_-]{12,})\b|\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g

export function canonicalJson(value: unknown, depth = 0): string {
	if (depth > 100) throw new RangeError("evidence JSON exceeds maximum nesting depth")
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("evidence JSON cannot contain non-finite numbers")
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`
	if (typeof value !== "object") throw new TypeError(`evidence JSON cannot contain ${typeof value}`)
	const object = value as Record<string, unknown>
	if (Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) throw new TypeError("evidence JSON must contain only plain objects")
	return `{${Object.keys(object)
		.sort()
		.filter((key) => object[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], depth + 1)}`)
		.join(",")}}`
}

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}

export function redactEvidenceValue(value: unknown, secrets: readonly string[] = []): unknown {
	if (Array.isArray(value)) return value.map((item) => redactEvidenceValue(item, secrets))
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			result[key] = SECRET_FIELD.test(key) ? "[REDACTED]" : redactEvidenceValue(item, secrets)
		}
		return result
	}
	if (typeof value !== "string") return value
	let text = value.replace(SECRET_TEXT, (_match, bearerPrefix: string | undefined) => `${bearerPrefix ?? ""}[REDACTED]`)
	for (const secret of secrets) {
		if (secret.length >= 4) text = text.split(secret).join("[REDACTED]")
	}
	return text
}

export function boundedCanonicalJson(value: unknown, maxBytes = DEFAULT_MAX_RECORD_BYTES): string {
	const serialized = canonicalJson(value)
	const bytes = Buffer.byteLength(serialized, "utf8")
	if (bytes > maxBytes) throw new RangeError(`evidence record exceeds ${maxBytes} byte limit (${bytes} bytes)`)
	return serialized
}
