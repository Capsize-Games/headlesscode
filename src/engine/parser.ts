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

/**
 * Recovers a tool call a model wrote as plain text instead of using the
 * native tool-calling channel — observed live against Qwen2.5-Coder-14B
 * (2026-08-19 local-backend baseline runs, see
 * plans/local-dual-model-code-agent.md's handoff doc): the model reasons
 * correctly about which tool to call, then emits `{"name": "edit_file",
 * "arguments": {...}}` as prose (sometimes fenced in ```json, sometimes
 * with Python-literal syntax in the nested arguments — single-quoted
 * strings, `None`/`True`/`False`) instead of a real `tool_calls` entry.
 *
 * This is scanned for ONLY when the caller already knows the turn had zero
 * real tool_calls (a text-only reply) — never as an alternative to native
 * parsing. The caller must additionally check the extracted `name` against
 * the session's real tool catalog before treating this as an actual call;
 * this function only extracts a shape, it doesn't know what tools exist.
 *
 * Also recognizes a second observed shape (same 2026-08-19 session, a
 * different iteration): `[Called tool "read_file" with arguments {'path':
 * ...}]` — the model narrating, in past tense, that it already invoked a
 * tool, when no such call was ever made. Prose that merely CLAIMS an
 * action happened is exactly what requireExplicitCompletion exists to
 * distrust — but when the named tool is real and the caller (loop.ts)
 * confirms it against the session's actual catalog, actually running it
 * turns a hallucinated claim into real, verified progress instead of
 * wasting the turn on a nudge.
 *
 * Returns undefined when neither shape can be found — this is a
 * best-effort scan, not a guarantee.
 */
export function extractEmbeddedToolCall(text: string): ParsedToolCall | undefined {
	const narrated = /\[?Called tool ["']([\w-]+)["'] with arguments\s+(\{[\s\S]*?\})\]?/.exec(text)
	if (narrated) {
		const args = parsePermissiveObject(narrated[2]) ?? {}
		return {
			id: "embedded_0",
			name: narrated[1],
			args,
			rawArguments: JSON.stringify(args),
		}
	}

	const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text)
	const candidates = fenced ? [fenced[1], text] : [text]

	for (const candidate of candidates) {
		const obj = parsePermissiveObject(candidate)
		if (!obj) {
			continue
		}
		const name = obj.name
		if (typeof name !== "string" || name.trim() === "") {
			continue
		}
		const rawArgs = obj.arguments
		const args = isPlainObject(rawArgs) ? rawArgs : {}
		return {
			id: "embedded_0",
			name: name.trim(),
			args,
			rawArguments: JSON.stringify(args),
		}
	}
	return undefined
}

/**
 * Like `bestEffortPartialJson`'s balanced-brace recovery, but tolerant of
 * Python-literal syntax within the matched span: single-quoted strings and
 * `None`/`True`/`False`. Normalizes those to JSON before parsing rather
 * than hand-rolling a second recursive-descent parser.
 */
function parsePermissiveObject(input: string): Record<string, unknown> | undefined {
	const firstBrace = input.indexOf("{")
	if (firstBrace === -1) {
		return undefined
	}
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
						return parsed
					}
				} catch {
					const normalized = normalizePythonLiteral(candidate)
					try {
						const parsed: unknown = JSON.parse(normalized)
						if (isPlainObject(parsed)) {
							return parsed
						}
					} catch {
						// give up on this brace span
					}
				}
				return undefined
			}
		}
	}
	return undefined
}

/**
 * Best-effort Python-dict-repr → JSON normalization: swaps single-quoted
 * strings for double-quoted ones (respecting embedded escapes) and maps
 * None/True/False to their JSON equivalents. Not a full Python literal
 * parser — good enough for the shallow, flat-ish argument dicts a tool
 * call carries.
 */
function normalizePythonLiteral(input: string): string {
	let out = ""
	let inString = false
	let quoteChar = ""
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]
		if (inString) {
			if (ch === "\\" && i + 1 < input.length) {
				out += ch + input[i + 1]
				i++
				continue
			}
			if (ch === quoteChar) {
				out += '"'
				inString = false
				continue
			}
			out += ch === '"' ? '\\"' : ch
			continue
		}
		if (ch === "'" || ch === '"') {
			inString = true
			quoteChar = ch
			out += '"'
			continue
		}
		out += ch
	}
	return out.replace(/\bNone\b/g, "null").replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false")
}
