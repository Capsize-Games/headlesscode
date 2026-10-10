import type { SessionMessage, ArchivedToolCall } from "../types.js"
import { isRecord, opaque, type ParsedImport, safeString } from "./common.js"

function timestamp(value: unknown): string | undefined {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined
	return value
}

function contentText(value: unknown): string | null {
	if (typeof value === "string") return value
	if (Array.isArray(value)) {
		const pieces: string[] = []
		for (const part of value) {
			if (typeof part === "string") pieces.push(part)
			else if (isRecord(part) && typeof part.text === "string" && (part.type === "text" || part.type === "input_text" || part.type === "output_text")) pieces.push(part.text)
		}
		return pieces.length ? pieces.join("") : null
	}
	return null
}

function normalizeMessage(value: unknown, warnings: string[]): SessionMessage | undefined {
	if (!isRecord(value)) { warnings.push("A non-object Muse message was ignored."); return undefined }
	const role = value.role
	if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer" && role !== "tool") {
		warnings.push(`Muse message with unsupported role ${String(role ?? "(missing)")} was retained as opaque content.`)
		return { role: "assistant", content: null, opaque: opaque("muse-message", value) }
	}
	const content = value.content ?? value.text ?? value.body
	const result: SessionMessage = { role, content: contentText(content), ...(timestamp(value.timestamp) ? { timestamp: timestamp(value.timestamp) } : {}) }
	const calls: ArchivedToolCall[] = []
	const callValues = Array.isArray(value.tool_calls) ? value.tool_calls : Array.isArray(value.toolCalls) ? value.toolCalls : []
	for (const callValue of callValues) {
		if (!isRecord(callValue)) { warnings.push("Malformed Muse tool call was retained as opaque content."); result.opaque = [...(result.opaque ?? []), ...(opaque("muse-tool-call", callValue) ?? [])]; continue }
		const id = safeString(callValue.id ?? callValue.call_id)
		const name = safeString(callValue.name)
		if (!id || !name) { warnings.push("Muse tool call without an ID or name was retained as opaque content."); result.opaque = [...(result.opaque ?? []), ...(opaque("muse-tool-call", callValue) ?? [])]; continue }
		let args: string
		try { args = typeof callValue.arguments === "string" ? callValue.arguments : JSON.stringify(callValue.arguments ?? callValue.input ?? null) } catch { args = "null" }
		calls.push({ id, name, arguments: args })
	}
	if (calls.length) result.toolCalls = calls
	const callId = safeString(value.tool_call_id ?? value.toolCallId)
	if (callId) result.toolCallId = callId
	if (value.encrypted_reasoning !== undefined || value.reasoning_ciphertext !== undefined || value.reasoning !== undefined) warnings.push("Muse reasoning fields were omitted; imported sessions never restore private reasoning.")
	return result
}

export function parseMuseExport(value: unknown): ParsedImport {
	if (!isRecord(value)) throw new Error("Muse export must be a JSON object (export schema v1).")
	if (value.export_schema_version !== 1) throw new Error(`Unsupported Muse export schema ${String(value.export_schema_version ?? "(missing)")}; expected schema v1.`)
	const warnings: string[] = []
	const messages: SessionMessage[] = []
	const calls = new Set<string>()
	const results = new Set<string>()
	let sessionId: string | undefined
	if (!Array.isArray(value.events)) throw new Error("Unsupported Muse export schema v1 shape: expected an events array.")
	for (const raw of value.events) {
		if (!isRecord(raw)) { warnings.push("A malformed Muse export event was ignored."); continue }
		if (raw.kind !== "record" || !isRecord(raw.envelope)) {
			if (raw.kind === "gap" || raw.kind === "omitted_live_only") warnings.push("Muse export contains a live-only or omitted event; it was not reconstructed.")
			continue
		}
		const envelope = raw.envelope
		if (isRecord(envelope.payload) && typeof envelope.payload.session_id === "string") sessionId ??= envelope.payload.session_id
		if (!isRecord(envelope.payload)) continue
		const payload = envelope.payload
		if (payload.kind === "run" && isRecord(payload.event)) {
			const message = museRunMessage(payload.event, envelope.recorded_at)
			if (message) {
				trackToolMessage(message, calls, results)
				messages.push(message)
				if (["summary", "compaction", "branch_summary"].includes(String(payload.event.kind))) warnings.push(`Muse ${String(payload.event.kind)} metadata was flattened into chronological history.`)
			}
			else if (/reasoning/i.test(String(payload.event.kind ?? ""))) {
				const encrypted = encryptedReasoning(payload.event)
				if (encrypted !== undefined) {
					messages.push({ role: "assistant", content: null, opaque: opaque("muse-encrypted-reasoning", encrypted), ...(timestamp(envelope.recorded_at) ? { timestamp: timestamp(envelope.recorded_at) } : {}) })
					warnings.push("Muse encrypted reasoning was retained as opaque archive data and excluded from continuation context.")
				} else warnings.push("Muse reasoning records were omitted; imported sessions never restore private reasoning.")
			} else if (isSafeRunEvent(payload.event.kind)) warnings.push(`Muse run event ${String(payload.event.kind)} was unsupported and retained as opaque history.`)
			if (isSafeRunEvent(payload.event.kind) && !message) messages.push({ role: "assistant", content: null, opaque: opaque(`muse-run-${String(payload.event.kind)}`, payload.event), ...(timestamp(envelope.recorded_at) ? { timestamp: timestamp(envelope.recorded_at) } : {}) })
		} else if (payload.kind === "run") {
			warnings.push("Muse run record has no event object and was omitted.")
		} else if (envelope.payload_type === "approval.review" || /approval|permission/i.test(String(envelope.payload_type ?? ""))) {
			warnings.push("Muse approval or permission records were omitted.")
		} else if (/reasoning/i.test(String(envelope.payload_type ?? ""))) {
			const encrypted = encryptedReasoning(payload)
			if (encrypted !== undefined) messages.push({ role: "assistant", content: null, opaque: opaque("muse-encrypted-reasoning", encrypted), ...(timestamp(envelope.recorded_at) ? { timestamp: timestamp(envelope.recorded_at) } : {}) })
			else warnings.push("Muse reasoning records were omitted; imported sessions never restore private reasoning.")
		}
	}
	for (const id of results) if (!calls.has(id)) warnings.push(`Muse tool result ${id} has no matching call; it was kept as historical output.`)
	for (const id of calls) if (!results.has(id)) warnings.push(`Muse tool call ${id} has no matching result.`)
	if (!messages.length) throw new Error("Muse export v1 contained no supported conversation events. Export the session again or select a supported session.jsonl file.")
	return {
		title: "Imported Muse conversation",
		...(sessionId ? { sessionId } : Array.isArray(value.sessions) && isRecord(value.sessions[0]) && typeof value.sessions[0].session_id === "string" ? { sessionId: value.sessions[0].session_id } : undefined),
		messages,
		warnings,
	}
}

function trackToolMessage(message: SessionMessage, calls: Set<string>, results: Set<string>): void {
	if (message.toolCalls) for (const call of message.toolCalls) calls.add(call.id)
	if (message.toolCallId) results.add(message.toolCallId)
}

function isSafeRunEvent(value: unknown): boolean {
	return typeof value === "string" && !/reasoning|approval|permission|credential|token|secret|config|budget/i.test(value)
}

function encryptedReasoning(value: unknown): unknown | undefined {
	if (!isRecord(value)) return undefined
	const encrypted = value.encrypted_content ?? value.ciphertext ?? value.redacted_content
	if (encrypted === undefined) return undefined
	const recordType = safeString(value.kind ?? value.type)
	return { ...(recordType ? { recordType } : {}), encrypted }
}

function museRunMessage(event: Record<string, unknown>, recordedAt?: unknown): SessionMessage | undefined {
	const kind = event.kind
	const time = timestamp(recordedAt) ?? timestamp(event.timestamp)
	if (kind === "started" && typeof event.prompt === "string") return { role: "user", content: event.prompt, ...(time ? { timestamp: time } : {}) }
	if (kind === "tool_result" && typeof event.text === "string") return { role: "tool", content: event.text, ...(safeString(event.call_id) ? { toolCallId: safeString(event.call_id) } : {}), ...(time ? { timestamp: time } : {}) }
	if (kind === "assistant_message_committed" && typeof event.text === "string") return { role: "assistant", content: event.text, ...(time ? { timestamp: time } : {}) }
	if ((kind === "summary" || kind === "compaction" || kind === "branch_summary") && typeof (event.summary ?? event.text) === "string") return { role: "assistant", content: `[Imported Muse ${String(kind)} context]\n${String(event.summary ?? event.text)}`, ...(time ? { timestamp: time } : {}) }
	if ((kind === "tool_call" || kind === "tool_call_committed") && typeof (event.name ?? event.tool_name) === "string") {
		const id = safeString(event.call_id ?? event.tool_call_id)
		const name = safeString(event.name ?? event.tool_name)
		if (id && name) {
			let args: string
			try { args = typeof event.arguments === "string" ? event.arguments : JSON.stringify(event.arguments ?? event.input ?? null) } catch { args = "null" }
			return { role: "assistant", content: null, toolCalls: [{ id, name, arguments: args }], ...(time ? { timestamp: time } : {}) }
		}
	}
	return undefined
}

export function parseMuseRecords(records: unknown[]): ParsedImport {
	if (records.length === 1 && isRecord(records[0]) && records[0].export_schema_version !== undefined) return parseMuseExport(records[0])
	const warnings: string[] = []
	const messages: SessionMessage[] = []
	let sessionId: string | undefined
	let title = "Imported Muse conversation"
	const calls = new Set<string>()
	const results = new Set<string>()
	for (const record of records) {
		if (!isRecord(record)) { warnings.push("A non-object Muse JSONL record was ignored."); continue }
		if (record.export_schema_version !== undefined) {
			if (record.export_schema_version !== 1) throw new Error(`Unsupported Muse export schema ${String(record.export_schema_version)}; expected schema v1.`)
			warnings.push("Muse export envelope appeared in JSONL; supported export input is a single schema v1 JSON document.")
			continue
		}
		if (typeof record.session_id === "string") sessionId ??= record.session_id
		if (typeof record.sessionId === "string") sessionId ??= record.sessionId
		if (typeof record.title === "string" && record.title.trim()) title = record.title.slice(0, 200)
		const kind = record.type ?? record.event ?? record.kind
		const payload = isRecord(record.payload) ? record.payload : undefined
		if (payload && typeof payload.session_id === "string") sessionId ??= payload.session_id
		if (payload && typeof payload.sessionId === "string") sessionId ??= payload.sessionId
		const event = payload?.kind === "run" && isRecord(payload.event) ? payload.event : undefined
		if (event) {
			const message = museRunMessage(event, record.recorded_at)
			if (message) {
				trackToolMessage(message, calls, results)
				messages.push(message)
				if (["summary", "compaction", "branch_summary"].includes(String(event.kind))) warnings.push(`Muse ${String(event.kind)} metadata was flattened into chronological history.`)
				continue
			}
			if (isSafeRunEvent(event.kind)) {
				warnings.push(`Muse run event ${String(event.kind ?? "(missing)")} was retained as opaque history.`)
				messages.push({ role: "assistant", content: null, opaque: opaque(`muse-run-${String(event.kind ?? "unknown")}`, event), ...(timestamp(record.recorded_at) ? { timestamp: timestamp(record.recorded_at) } : {}) })
			}
			continue
		}
		if (/reasoning/i.test(String(record.payload_type ?? ""))) {
			const encrypted = encryptedReasoning(payload)
			if (encrypted !== undefined) messages.push({ role: "assistant", content: null, opaque: opaque("muse-encrypted-reasoning", encrypted), ...(timestamp(record.recorded_at) ? { timestamp: timestamp(record.recorded_at) } : {}) })
			else warnings.push("Muse reasoning records were omitted; imported sessions never restore private reasoning.")
			continue
		}
		if (kind === "approval" || kind === "approval_outcome" || kind === "question_outcome" || kind === "permission" || kind === "config" || /approval|permission/i.test(String(record.payload_type ?? ""))) continue
		if (kind === "message" || kind === "user_message" || kind === "assistant_message" || kind === "tool_call" || kind === "tool_result" || ["user", "assistant", "system", "developer", "tool"].includes(String(record.role))) {
			const rawMessage = isRecord(record.message) ? record.message : kind === "tool_call"
				? { role: "assistant", content: null, tool_calls: [record.tool_call ?? record] }
				: kind === "tool_result"
					? { role: "tool", content: record.output ?? record.content, tool_call_id: record.tool_call_id ?? record.call_id, timestamp: record.timestamp }
					: record
			const normalized = normalizeMessage(rawMessage, warnings)
			if (normalized) {
				if (kind === "tool_call" && normalized.toolCalls) normalized.role = "assistant"
				if (normalized.toolCalls) for (const call of normalized.toolCalls) calls.add(call.id)
				if (normalized.toolCallId) results.add(normalized.toolCallId)
				messages.push(normalized)
			}
		} else if (kind === "reasoning" || kind === "encrypted_reasoning") {
			warnings.push("Muse reasoning records were omitted; imported sessions never restore private reasoning.")
		} else if (kind === "branch" || kind === "compaction" || kind === "summary") {
			const summary = safeString(record.summary ?? record.text)
			if (summary) messages.push({ role: "assistant", content: `[Imported ${String(kind)} context]\n${summary}`, ...(timestamp(record.timestamp) ? { timestamp: timestamp(record.timestamp) } : {}) })
			warnings.push(`Muse ${String(kind)} metadata was flattened into chronological history.`)
		} else {
			warnings.push(`Unsupported Muse JSONL record type ${String(kind ?? "(missing)")} was retained as opaque history.`)
			messages.push({ role: "assistant", content: null, opaque: opaque(`muse-${String(kind ?? "unknown")}`, record), ...(timestamp(record.timestamp) ? { timestamp: timestamp(record.timestamp) } : {}) })
		}
	}
	for (const id of results) if (!calls.has(id)) warnings.push(`Muse tool result ${id} has no matching call; it was kept as historical output.`)
	for (const id of calls) if (!results.has(id)) warnings.push(`Muse tool call ${id} has no matching result.`)
	if (!messages.length) throw new Error("Muse JSONL contained no supported conversation events. Select a documented session.jsonl or export schema v1 file.")
	return { title, ...(sessionId ? { sessionId } : {}), messages, warnings }
}
