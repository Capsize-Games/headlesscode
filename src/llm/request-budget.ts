import type { ChatMessage } from "../engine/types.js"

export const OPENROUTER_MAX_PROMPT_BYTES_ENV = "HEADLESSCODE_OPENROUTER_MAX_PROMPT_BYTES"
export const TOOL_RESULT_BUDGET_NOTICE = "\n\n[... middle omitted; tool result shortened to fit the request byte budget; full result remains in local session history ...]\n\n"

export class PromptByteBudgetError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "PromptByteBudgetError"
	}
}

export interface PackedRequestBody {
	body: Record<string, unknown>
	json: string
	bytes: number
	evictedGroups: number
	truncatedToolResults: number
}

/** Resolve a positive byte budget; an explicitly malformed value is a startup error. */
export function resolvePromptByteBudget(explicit: number | undefined, env: NodeJS.ProcessEnv = process.env): number | undefined {
	if (explicit !== undefined) return validatePromptByteBudget(explicit, "OpenRouter maxPromptBytes option")
	const raw = env[OPENROUTER_MAX_PROMPT_BYTES_ENV]
	if (raw === undefined) return undefined
	if (!/^[1-9]\d*$/.test(raw.trim())) {
		throw new PromptByteBudgetError(`${OPENROUTER_MAX_PROMPT_BYTES_ENV} must be a positive safe integer number of bytes`)
	}
	return validatePromptByteBudget(Number(raw), OPENROUTER_MAX_PROMPT_BYTES_ENV)
}

function validatePromptByteBudget(value: number, source: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new PromptByteBudgetError(`${source} must be a positive safe integer number of bytes`)
	}
	return value
}

interface MessageGroup {
	start: number
	end: number
	complete: boolean
	toolCallGroup: boolean
}

function clippedExcerpt(points: string[], keep: number): string {
	const headCount = Math.ceil(keep / 2)
	const tailCount = keep - headCount
	return `${points.slice(0, headCount).join("")}${TOOL_RESULT_BUDGET_NOTICE}${tailCount > 0 ? points.slice(-tailCount).join("") : ""}`
}

function maxRetainedCodePoints(points: string[], original: string): number | undefined {
	// A notice must never make a small tool result larger. Bound each result
	// independently by its original JSON-escaped byte cost so every candidate
	// in the global search is no larger than the corresponding original.
	const originalBytes = Buffer.byteLength(JSON.stringify(original), "utf8")
	let low = 0
	let high = points.length - 1
	let best = -1
	while (low <= high) {
		const middle = Math.floor((low + high) / 2)
		const excerptBytes = Buffer.byteLength(JSON.stringify(clippedExcerpt(points, middle)), "utf8")
		if (excerptBytes <= originalBytes) {
			best = middle
			low = middle + 1
		} else {
			high = middle - 1
		}
	}
	return best < 0 ? undefined : best
}

function messageGroups(messages: ChatMessage[], start: number): MessageGroup[] {
	const groups: MessageGroup[] = []
	let index = start
	while (index < messages.length) {
		const message = messages[index]!
		if (message.role === "assistant" && message.tool_calls?.length) {
			const expected = new Set(message.tool_calls.map((call) => call.id))
			let cursor = index + 1
			let complete = expected.size === message.tool_calls.length && expected.size > 0
			while (cursor < messages.length && messages[cursor]!.role === "tool") {
				const id = messages[cursor]!.tool_call_id
				if (!id || !expected.delete(id)) complete = false
				cursor++
			}
			if (expected.size > 0) complete = false
			groups.push({ start: index, end: cursor, complete, toolCallGroup: true })
			index = cursor
			continue
		}
		groups.push({ start: index, end: index + 1, complete: message.role !== "tool", toolCallGroup: false })
		index++
	}
	return groups
}

function requiredPrefixLength(messages: ChatMessage[]): number {
	let leadingSystems = 0
	while (messages[leadingSystems]?.role === "system") leadingSystems++
	const initialUser = messages.findIndex((message, index) => index >= leadingSystems && message.role === "user")
	if (initialUser >= 0) {
		const prefixEnd = initialUser + 1
		const crossingGroup = messageGroups(messages, leadingSystems).find((group) => group.start < prefixEnd && group.end > prefixEnd)
		return crossingGroup?.end ?? prefixEnd
	}
	return leadingSystems
}

function serializedCandidate(body: Record<string, unknown>, messages: ChatMessage[]): { body: Record<string, unknown>; json: string; bytes: number } {
	const candidate = { ...body, messages }
	const json = JSON.stringify(candidate)
	return { body: candidate, json, bytes: Buffer.byteLength(json, "utf8") }
}

/**
 * Pack a final OpenRouter JSON body under its exact UTF-8 wire-byte budget.
 * The leading system/task messages and every non-message body field remain
 * untouched. Only whole older message groups are evicted; only tool-result
 * content in the newest complete tool-call group may be shortened.
 */
export function packRequestBody(body: Record<string, unknown>, maxBytes: number): PackedRequestBody {
	validatePromptByteBudget(maxBytes, "OpenRouter prompt byte budget")
	const messages = body.messages
	if (!Array.isArray(messages)) throw new PromptByteBudgetError("OpenRouter request messages are not an array")
	const sourceMessages = messages as ChatMessage[]
	const original = serializedCandidate(body, sourceMessages)
	if (original.bytes <= maxBytes) return { ...original, evictedGroups: 0, truncatedToolResults: 0 }

	const prefix = sourceMessages.slice(0, requiredPrefixLength(sourceMessages))
	const prefixRequest = serializedCandidate(body, prefix)
	if (prefixRequest.bytes > maxBytes) {
		throw new PromptByteBudgetError(`OpenRouter required prompt, tools, and routing fields need ${prefixRequest.bytes} bytes, exceeding the ${maxBytes}-byte request budget`)
	}

	const groups = messageGroups(sourceMessages, prefix.length)
	let firstKeptGroup = 0
	let evictedGroups = 0
	while (groups.length - firstKeptGroup > 1) {
		const oldest = groups[firstKeptGroup]!
		if (!oldest.complete) break
		firstKeptGroup++
		evictedGroups++
		const kept = [...prefix, ...sourceMessages.slice(groups[firstKeptGroup]!.start)]
		const candidate = serializedCandidate(body, kept)
		if (candidate.bytes <= maxBytes) return { ...candidate, evictedGroups, truncatedToolResults: 0 }
	}

	if (groups.length === 0) {
		throw new PromptByteBudgetError(`OpenRouter required prompt and tools need ${original.bytes} bytes, exceeding the ${maxBytes}-byte request budget`)
	}
	const newest = groups[groups.length - 1]!
	if (firstKeptGroup !== groups.length - 1) {
		throw new PromptByteBudgetError(`OpenRouter newest complete conversation group cannot fit the ${maxBytes}-byte request budget without truncating non-tool content`)
	}
	if (!newest.complete) {
		throw new PromptByteBudgetError("OpenRouter latest tool-call group is incomplete; refusing to repack a partial tool result group")
	}
	if (!newest.toolCallGroup) {
		throw new PromptByteBudgetError(`OpenRouter newest complete conversation group cannot fit the ${maxBytes}-byte request budget without truncating non-tool content`)
	}
	const keptMessages = [...prefix, ...sourceMessages.slice(newest.start)]
	const localNewestStart = prefix.length
	const toolIndexes: number[] = []
	for (let i = localNewestStart + 1; i < keptMessages.length; i++) {
		if (keptMessages[i]!.role === "tool") toolIndexes.push(i)
	}
	if (toolIndexes.length === 0) {
		throw new PromptByteBudgetError(`OpenRouter newest tool-call group has no results to shorten and cannot fit the ${maxBytes}-byte request budget`)
	}

	const originals = toolIndexes.map((index) => keptMessages[index]!.content ?? "")
	const codePoints = originals.map((text) => Array.from(text))
	const retainedCaps = codePoints.map((points, index) => maxRetainedCodePoints(points, originals[index]!))
	const candidateAt = (fraction: number) => {
		const packed = keptMessages.map((message) => ({ ...message }))
		for (let i = 0; i < toolIndexes.length; i++) {
			const index = toolIndexes[i]!
			const points = codePoints[i]!
			const cap = retainedCaps[i]
			if (cap !== undefined) packed[index]!.content = clippedExcerpt(points, Math.floor(cap * fraction))
		}
		return serializedCandidate(body, [...prefix, ...packed.slice(prefix.length)])
	}

	const emptyResults = candidateAt(0)
	if (emptyResults.bytes > maxBytes) {
		throw new PromptByteBudgetError(`OpenRouter newest tool-call group structure needs ${emptyResults.bytes} bytes, exceeding the ${maxBytes}-byte request budget even with empty result excerpts`)
	}
	let low = 0
	let high = 1
	let best = emptyResults
	for (let attempt = 0; attempt < 24; attempt++) {
		const middle = (low + high) / 2
		const candidate = candidateAt(middle)
		if (candidate.bytes <= maxBytes) {
			low = middle
			best = candidate
		} else {
			high = middle
		}
	}
	return { ...best, evictedGroups, truncatedToolResults: toolIndexes.length }
}
