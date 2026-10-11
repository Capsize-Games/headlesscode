import type { SessionMessage, ArchivedToolCall } from "../types.js"
import { isRecord, opaque, type ParsedImport, safeString } from "./common.js"

function time(value: unknown): string | undefined {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined
	return value
}

function blocksToMessages(role: SessionMessage["role"], content: unknown, timestamp?: string): SessionMessage[] {
	if (typeof content === "string") return [{ role, content, ...(timestamp ? { timestamp } : {}) }]
	if (!Array.isArray(content)) return [{ role, content: null, opaque: opaque("claude-content", content), ...(timestamp ? { timestamp } : {}) }]
	let text = ""
	const calls: ArchivedToolCall[] = []
	const results: SessionMessage[] = []
	const unknown: { type: string; value: unknown }[] = []
	for (const block of content) {
		if (!isRecord(block)) {
			unknown.push(...(opaque("claude-content-block", block) ?? []))
			continue
		}
		if (block.type === "text" && typeof block.text === "string") {
			text += block.text
		} else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
			let args: string
			try { args = JSON.stringify(block.input ?? null) } catch { args = "null" }
			calls.push({ id: block.id, name: block.name, arguments: args })
		} else if (block.type === "tool_result") {
			const callId = safeString(block.tool_use_id)
			let result: string
			try { result = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null) } catch { result = "[unserializable result]" }
			results.push({ role: "tool", content: result, ...(callId ? { toolCallId: callId } : {}), ...(timestamp ? { timestamp } : {}), ...(block.is_error === true ? { opaque: opaque("claude-tool-error", true) } : {}) })
		} else if (block.type === "redacted_thinking") {
			// Preserve the encrypted block as opaque data; continuation ignores opaque content.
			unknown.push(...(opaque("claude-encrypted-reasoning", block) ?? []))
		} else if (block.type === "thinking") {
			// Plain reasoning is deliberately not imported.
		} else {
			unknown.push(...(opaque(typeof block.type === "string" ? block.type : "claude-content-block", block) ?? []))
		}
	}
	const messages: SessionMessage[] = []
	if (text || calls.length || unknown.length || (!results.length && !text)) {
		messages.push({ role, content: text || null, ...(timestamp ? { timestamp } : {}), ...(calls.length ? { toolCalls: calls } : {}), ...(unknown.length ? { opaque: unknown } : {}) })
	}
	messages.push(...results)
	return messages
}

export function parseClaudeRecords(records: unknown[]): ParsedImport {
	const warnings: string[] = []
	const messages: SessionMessage[] = []
	const seen = new Set<string>()
	const callIds = new Set<string>()
	const resultIds = new Set<string>()
	let sessionId: string | undefined
	let branching = false
	for (const record of records) {
		if (!isRecord(record)) {
			warnings.push("A non-object Claude record was ignored.")
			continue
		}
		if (typeof record.sessionId === "string") sessionId ??= record.sessionId
		const type = record.type
		if (type === "progress" || type === "queue-operation" || type === "file-history-snapshot") continue
		if (type === "assistant" || type === "user") {
			const id = typeof record.uuid === "string" ? record.uuid : undefined
			if (id && seen.has(id)) {
				warnings.push(`Duplicate Claude record ID ${id} was ignored.`)
				continue
			}
			if (id) seen.add(id)
			if (record.parentUuid !== undefined && record.parentUuid !== null) branching = true
			const message = isRecord(record.message) ? record.message : undefined
			const role = message ? message.role : type
			if (role !== "assistant" && role !== "user" && role !== "system" && role !== "developer") {
				warnings.push(`Claude ${type} record has an unsupported message role and was retained as opaque content.`)
				messages.push({ role: type, content: null, opaque: opaque("claude-message", record) })
				continue
			}
			const converted = blocksToMessages(role, message?.content, time(record.timestamp))
			for (const item of converted) {
				for (const call of item.toolCalls ?? []) {
					if (callIds.has(call.id)) warnings.push(`Duplicate Claude tool call ID ${call.id} was retained.`)
					callIds.add(call.id)
				}
				if (item.toolCallId) resultIds.add(item.toolCallId)
				messages.push(item)
			}
		} else if (type === "summary" && typeof record.summary === "string") {
			messages.push({ role: "assistant", content: `[Imported conversation summary]\n${record.summary}`, ...(time(record.timestamp) ? { timestamp: time(record.timestamp) } : {}) })
			warnings.push("Claude conversation summary was imported as historical context; earlier compacted messages may be absent.")
		} else if (type === "system" && typeof record.content === "string") {
			messages.push({ role: "system", content: record.content, ...(time(record.timestamp) ? { timestamp: time(record.timestamp) } : {}) })
		} else if (type === "compact_boundary" || type === "permission" || type === "approval" || type === "tool_decision" || type === "thinking" || type === "redacted_thinking") {
			warnings.push(`Claude ${String(type)} metadata was omitted from the imported conversation.`)
		} else {
			warnings.push(`Unsupported Claude record type ${String(type ?? "(missing)")} was retained as opaque history.`)
			messages.push({ role: "assistant", content: null, opaque: opaque(`claude-${String(type ?? "unknown")}`, record), ...(time(record.timestamp) ? { timestamp: time(record.timestamp) } : {}) })
		}
	}
	for (const id of resultIds) if (!callIds.has(id)) warnings.push(`Claude tool result ${id} has no matching call; it was kept as historical output.`)
	for (const id of callIds) if (!resultIds.has(id)) warnings.push(`Claude tool call ${id} has no matching result.`)
	if (branching) warnings.push("Claude transcript has parent-linked branches; records were imported in file order.")
	return { title: "Imported Claude conversation", ...(sessionId ? { sessionId } : {}), messages, warnings }
}
