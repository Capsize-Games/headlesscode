import type { SessionMessage, ArchivedToolCall } from "../types.js"
import { isRecord, opaque, type ParsedImport, safeString } from "./common.js"

function timestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined
	return value
}

function textContent(value: unknown): { text: string; opaque: { type: string; value: unknown }[] } {
	if (typeof value === "string") return { text: value, opaque: [] }
	if (!Array.isArray(value)) return { text: "", opaque: value === undefined ? [] : (opaque("codex-content", value) ?? []) }
	let text = ""
	const extra: { type: string; value: unknown }[] = []
	for (const part of value) {
		if (typeof part === "string") text += part
		else if (isRecord(part) && ["input_text", "output_text", "text"].includes(String(part.type)) && typeof part.text === "string") text += part.text
		else if (isRecord(part) && (part.type === "image" || part.type === "input_image" || part.type === "output_image")) {
			const metadata: Record<string, unknown> = { type: part.type }
			for (const key of ["id", "mime_type", "mimeType", "width", "height", "detail"]) if (part[key] !== undefined) metadata[key] = part[key]
			extra.push({ type: "codex-media-reference", value: metadata })
		}
		else extra.push(...(opaque(isRecord(part) && typeof part.type === "string" ? part.type : "codex-content-part", part) ?? []))
	}
	return { text, opaque: extra }
}

export function parseCodexRecords(records: unknown[]): ParsedImport {
	const warnings: string[] = []
	const messages: SessionMessage[] = []
	let sessionId: string | undefined
	let title = "Imported Codex conversation"
	let sawBranch = false
	const callIds = new Set<string>()
	const resultIds = new Set<string>()
	const recordIds = new Set<string>()
	for (const record of records) {
		if (!isRecord(record)) { warnings.push("A non-object Codex record was ignored."); continue }
		const type = record.type
		const payload = isRecord(record.payload) ? record.payload : record
		if (type === "session_meta") {
			if (typeof payload.id === "string") sessionId ??= payload.id
			if (typeof payload.title === "string" && payload.title.trim()) title = payload.title.slice(0, 200)
			continue
		}
		if (type === "event_msg") {
			// event_msg duplicates the user/assistant display stream represented by response_item.
			if (isRecord(payload) && (payload.type === "user_message" || payload.type === "agent_message")) continue
			continue
		}
		if (type === "response_item") {
			const itemType = payload.type
			const id = safeString(payload.id)
			if (id && recordIds.has(id)) { warnings.push(`Duplicate Codex response item ID ${id} was ignored.`); continue }
			if (id) recordIds.add(id)
			const time = timestamp(record.timestamp)
			if (itemType === "message") {
				const role = payload.role
				if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") {
					warnings.push("Codex response message has an unsupported role and was ignored.")
					continue
				}
				const body = textContent(payload.content)
				messages.push({ role, content: body.text || null, ...(time ? { timestamp: time } : {}), ...(body.opaque.length ? { opaque: body.opaque } : {}) })
			} else if (itemType === "function_call" || itemType === "custom_tool_call" || itemType === "mcp_tool_call") {
				const callId = safeString(payload.call_id ?? payload.id)
				const name = safeString(payload.name)
				if (!callId || !name) { warnings.push("Codex tool call without a stable call ID or name was retained as opaque content."); messages.push({ role: "assistant", content: null, opaque: opaque("codex-tool-call", payload), ...(time ? { timestamp: time } : {}) }); continue }
				let args: string
				try { args = typeof (payload.arguments ?? payload.input) === "string" ? String(payload.arguments ?? payload.input) : JSON.stringify(payload.arguments ?? payload.input ?? null) } catch { args = "null" }
				const call: ArchivedToolCall = { id: callId, name, arguments: args }
				if (callIds.has(callId)) warnings.push(`Duplicate Codex tool call ID ${callId} was retained.`)
				callIds.add(callId)
				messages.push({ role: "assistant", content: null, toolCalls: [call], ...(time ? { timestamp: time } : {}) })
			} else if (itemType === "function_call_output" || itemType === "custom_tool_call_output" || itemType === "mcp_tool_call_output") {
				const callId = safeString(payload.call_id ?? payload.id)
				const body = textContent(payload.output ?? payload.content)
				messages.push({ role: "tool", content: body.text || null, ...(callId ? { toolCallId: callId } : {}), ...(time ? { timestamp: time } : {}), ...(body.opaque.length ? { opaque: body.opaque } : {}) })
				if (callId) resultIds.add(callId)
			} else if (itemType === "reasoning") {
				if (payload.encrypted_content !== undefined || payload.ciphertext !== undefined || payload.redacted_content !== undefined) {
					messages.push({ role: "assistant", content: null, opaque: opaque("codex-encrypted-reasoning", { type: itemType, encrypted_content: payload.encrypted_content ?? payload.ciphertext ?? payload.redacted_content }) })
					warnings.push("Codex encrypted reasoning was retained as opaque archive data and excluded from continuation context.")
				} else warnings.push("Codex reasoning records were omitted; imported sessions never restore private reasoning.")
			} else {
				warnings.push(`Unsupported Codex response item ${String(itemType ?? "(missing)")} was retained as opaque history.`)
				messages.push({ role: "assistant", content: null, opaque: opaque(`codex-${String(itemType ?? "unknown")}`, payload), ...(time ? { timestamp: time } : {}) })
			}
			continue
		}
		if (type === "turn_context" || type === "token_count" || type === "compaction" || type === "model_settings") continue
		if (type === "compacted") {
			sawBranch = true
			warnings.push("Codex rollout contains compaction data; only explicit response items were imported.")
			const summary = safeString(payload.message ?? payload.summary)
			if (summary) messages.push({ role: "assistant", content: `[Imported Codex compaction summary]\n${summary}`, ...(timestamp(record.timestamp) ? { timestamp: timestamp(record.timestamp) } : {}) })
			continue
		}
		if (type === "reasoning" || type === "encrypted_reasoning") {
			warnings.push("Codex reasoning records were omitted; imported sessions never restore private reasoning.")
			continue
		}
		warnings.push(`Unsupported Codex record type ${String(type ?? "(missing)")} was retained as opaque history.`)
		messages.push({ role: "assistant", content: null, opaque: opaque(`codex-${String(type ?? "unknown")}`, record), ...(timestamp(record.timestamp) ? { timestamp: timestamp(record.timestamp) } : {}) })
	}
	for (const id of resultIds) if (!callIds.has(id)) warnings.push(`Codex tool result ${id} has no matching call; it was kept as historical output.`)
	for (const id of callIds) if (!resultIds.has(id)) warnings.push(`Codex tool call ${id} has no matching result.`)
	if (sawBranch) warnings.push("Codex compacted or branched history may omit earlier messages.")
	return { title, ...(sessionId ? { sessionId } : {}), messages, warnings }
}
