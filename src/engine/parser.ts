/**
 * Tool-call parser for OpenAI/OpenRouter function-calling responses.
 *
 * Given a chat completion message with `tool_calls`:
 *
 *   [{ id, type: "function", function: { name, arguments } }]
 *
 * returns parsed { id, name, args } with `arguments` JSON.parsed. On a JSON
 * parse failure we try a best-effort partial-json extraction (balanced-brace
 * recovery then key/value scavenging); if that also fails, the call is marked
 * with a `parseError` and the loop feeds an error result back to the model.
 *
 * A message with zero tool_calls yields an empty array (text-only reply).
 */

import type { ChatMessage, ChatToolCall, ParsedToolCall } from "./types.js"

export function parseToolCalls(message: ChatMessage): ParsedToolCall[] {
	const calls = message.tool_calls
	if (!calls || calls.length === 0) {
		return []
	}
	return calls
		.filter((call) => call.type === "function" || !call.type)
		.map((call, index) => parseToolCall(call, index))
}

export function parseToolCall(call: ChatToolCall, index = 0): ParsedToolCall {
	const id = call.id || `call_${index}`
	const name = call.function?.name || "unknown_tool"
	const rawArguments = call.function?.arguments ?? ""

	let args: Record<string, unknown> = {}
	let parseError: string | undefined

	const trimmed = rawArguments.trim()
	if (trimmed === "") {
		// Empty arguments are allowed for some tools; treat as {}.
		args = {}
	} else {
		try {
			const parsed: unknown = JSON.parse(trimmed)
			if (isPlainObject(parsed)) {
				args = parsed as Record<string, unknown>
			} else {
				parseError = "arguments JSON did not parse to an object"
			}
		} catch (jsonErr) {
			const recovered = bestEffortPartialJson(trimmed)
			if (recovered) {
				args = recovered
			} else {
				parseError = `invalid JSON arguments: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`
			}
		}
	}

	return { id, name, args, rawArguments, parseError }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Best-effort extraction of an object from malformed JSON. Tries:
 *  1. Balanced-brace recovery: slice from the first "{" to the outermost "}"
 *     and JSON.parse the substrings at each depth — this handles trailing
 *     junk like `{"path": "x"} and then some`.
 *  2. Key/value scavenging: regex over `"key": value` pairs (strings,
 *     numbers, booleans, null) — handles truncated tail `{"path": "x", "lim`.
 *
 * Returns undefined when nothing usable is found.
 */
export function bestEffortPartialJson(input: string): Record<string, unknown> | undefined {
	// 1. Balanced-brace recovery.
	const firstBrace = input.indexOf("{")
	if (firstBrace !== -1) {
		let depth = 0
		for (let i = firstBrace; i < input.length; i++) {
			const ch = input[i]
			if (ch === "{") {
				depth++
			} else if (ch === "}") {
				depth--
				if (depth === 0) {
					const candidate = input.slice(firstBrace, i + 1)
					try {
						const parsed: unknown = JSON.parse(candidate)
						if (isPlainObject(parsed)) {
							return parsed as Record<string, unknown>
						}
					} catch {
						// fall through to scavenging
					}
					break
				}
			}
		}
	}

	// 2. Key/value scavenging.
	const scavenged: Record<string, unknown> = {}
	const pairRe = /"((?:\\.|[^"\\])*)"\s*:\s*("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g
	let match: RegExpExecArray | null
	let found = false
	while ((match = pairRe.exec(input)) !== null) {
		const key = unescapeJsonString(match[1])
		const rawValue = match[2]
		let value: unknown
		if (rawValue.startsWith('"')) {
			value = unescapeJsonString(rawValue.slice(1, -1))
		} else if (rawValue === "true") {
			value = true
		} else if (rawValue === "false") {
			value = false
		} else if (rawValue === "null") {
			value = null
		} else {
			const num = Number(rawValue)
			value = Number.isNaN(num) ? rawValue : num
		}
		scavenged[key] = value
		found = true
	}
	return found ? scavenged : undefined
}

function unescapeJsonString(s: string): string {
	return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n").replace(/\\t/g, "\t")
}
