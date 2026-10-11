import { writeSync } from "node:fs"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"

const MAX_INPUT_BYTES = 384 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024
const ajv = new AjvJsonSchemaValidator()

function measureJson(value, budget, seen = new Set(), depth = 0) {
	if (depth > 32) return null
	if (value === null) return 4
	if (typeof value === "boolean") return value ? 4 : 5
	if (typeof value === "number") return Number.isFinite(value) ? Buffer.byteLength(String(value), "utf8") : null
	if (typeof value === "string") {
		const rawBytes = Buffer.byteLength(value, "utf8")
		return rawBytes * 6 + 2 <= budget ? rawBytes * 6 + 2 : null
	}
	if (typeof value !== "object" || seen.has(value)) return null
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null
	seen.add(value)
	let total = 2
	if (Array.isArray(value)) {
		const keys = Reflect.ownKeys(value)
		if (value.length > 4096 || keys.length !== value.length + 1 || !keys.includes("length")) return null
		for (let index = 0; index < value.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null
			const size = measureJson(descriptor.value, budget - total, seen, depth + 1)
			if (size === null) return null
			total += size + (index ? 1 : 0)
			if (total > budget) return null
		}
	} else {
		const keys = Reflect.ownKeys(value)
		if (keys.length > 4096 || keys.some((key) => typeof key !== "string")) return null
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null
			const keySize = Buffer.byteLength(JSON.stringify(key), "utf8")
			const childSize = measureJson(descriptor.value, budget - total - keySize - 1, seen, depth + 1)
			if (childSize === null) return null
			total += keySize + 1 + childSize + (total > 2 ? 1 : 0)
			if (total > budget) return null
		}
	}
	seen.delete(value)
	return total
}

function writeResult(result, callId, fd, maxBytes = MAX_OUTPUT_BYTES) {
	if (measureJson(result, maxBytes) === null) throw new Error("extension result is not finite JSON or exceeded output bounds")
	const encoded = JSON.stringify({ ok: true, callId, result })
	if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("extension result exceeded output bounds")
	writeSync(fd, `${encoded}\n`)
}

let protocolFd = -1
let requestCallId = ""
async function main() {
	let input = ""
	for await (const chunk of process.stdin) {
		input += chunk.toString("utf8")
		if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) throw new Error("adapter input exceeded bound")
	}
	if (!input.endsWith("\n")) throw new Error("adapter request was incomplete")
	const request = JSON.parse(input.slice(0, -1))
	requestCallId = typeof request.callId === "string" ? request.callId : ""
	protocolFd = Number(process.env.HEADLESSCODE_EXTENSION_PROTOCOL_FD)
	delete process.env.HEADLESSCODE_EXTENSION_PROTOCOL_FD
	if (!Number.isInteger(protocolFd) || protocolFd < 3) throw new Error("protocol descriptor is unavailable")
	if (request.operation === "validate") {
		const validator = ajv.getValidator(request.schema)
		const validation = validator(request.value)
		writeResult({ valid: validation.valid, ...(validation.valid ? {} : { error: String(validation.errorMessage ?? "schema mismatch").slice(0, 1000) }) }, request.callId, protocolFd)
		return
	}
	if (request.operation !== "invoke") throw new Error("unknown adapter operation")
	if (request.inputSchema) {
		const validator = ajv.getValidator(request.inputSchema)
		const validation = validator(request.input)
		if (!validation.valid) throw new Error(`input schema mismatch: ${validation.errorMessage ?? "invalid input"}`)
	}
	const loaded = await import(request.entrypoint)
	const handler = typeof loaded.run === "function" ? loaded.run : loaded.default
	if (typeof handler !== "function") throw new Error("extension module must export run(input) or default(input)")
		writeResult(await handler(request.input), request.callId, protocolFd, Math.min(MAX_OUTPUT_BYTES, request.maxOutputBytes ?? MAX_OUTPUT_BYTES))
}

main().catch((error) => {
	if (Number.isInteger(protocolFd) && protocolFd >= 3) {
		const message = error instanceof Error ? error.message.slice(0, 500) : "extension adapter failed"
		try { writeSync(protocolFd, `${JSON.stringify({ ok: false, callId: requestCallId, error: message })}\n`) } catch { /* parent detects missing protocol */ }
	}
	process.exitCode = 1
})
