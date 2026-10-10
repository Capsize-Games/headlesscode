import type { Writable } from "node:stream"

const MAX_EVENT_CHARS = 16 * 1024
const MAX_STATUS_CHARS = 2 * 1024
const MAX_TURN_RENDERED_CHARS = 256 * 1024
const MAX_TURN_STATUS_EVENTS = 1_000

export interface TerminalRendererOptions {
	output: Writable
	color: boolean
	columns?: () => number | undefined
}

/** Plain-text terminal renderer. Untrusted event values are stripped of controls before output. */
export class TerminalRenderer {
	private streamedText = ""
	private currentTextLineOpen = false
	private streamTruncated = false
	private statusEventCount = 0
	private statusEventsTruncated = false
	private readonly columns: () => number | undefined

	constructor(private readonly options: TerminalRendererOptions) {
		this.columns = options.columns ?? (() => (options.output as Writable & { columns?: number }).columns)
	}

	writeHeader(sessionId: string, workspace: string, model: string, mode: string): void {
		this.writeStatus(`Session ${sessionId} | ${workspace} | ${model} | ${mode}`, "cyan")
	}

	writePrompt(text: string): void {
		this.writeStatus(text)
	}

	writeNotice(text: string): void { this.writeStatus(text, "yellow") }
	writeError(text: string): void { this.writeStatus(`Error: ${text}`, "red") }

	startTurn(): void {
		this.streamedText = ""
		this.currentTextLineOpen = false
		this.streamTruncated = false
		this.statusEventCount = 0
		this.statusEventsTruncated = false
	}

	renderEvent(type: string, fields: Record<string, unknown>): void {
		if (this.statusEventCount >= MAX_TURN_STATUS_EVENTS) {
			if (!this.statusEventsTruncated) {
				this.statusEventsTruncated = true
				this.writeStatus("Turn activity display limit reached; additional status events were omitted.", "yellow")
			}
			return
		}
		this.statusEventCount++
		const normalized = type.toLowerCase()
		if (normalized === "llm_stream_chunk" || normalized === "text_delta" || normalized === "assistant_delta" || normalized === "stream_text") {
			const kind = typeof fields.kind === "string" ? fields.kind : "text"
			if (kind !== "text") return
			const chunk = asString(fields.chunk ?? fields.text ?? fields.delta)
			if (!chunk) return
			const safe = sanitizeTerminalText(chunk).slice(0, MAX_EVENT_CHARS)
			const remaining = MAX_TURN_RENDERED_CHARS - this.streamedText.length
			const visible = safe.slice(0, Math.max(0, remaining))
			if (visible) {
				this.options.output.write(visible)
				this.streamedText += visible
				this.currentTextLineOpen = !visible.endsWith("\n")
			}
			if (visible.length < safe.length && !this.streamTruncated) {
				this.streamTruncated = true
				this.endStreamLine()
				this.writeStatus("Turn output display limit reached; remaining text was not rendered.", "yellow")
			}
			return
		}
		if (normalized === "tool_call" || normalized === "tool_start" || normalized === "tool_status") {
			this.endStreamLine()
			const tool = sanitizeTerminalText(asString(fields.tool ?? fields.name) || "tool").slice(0, 120)
			const args = sanitizeTerminalText(asString(fields.args ?? fields.command ?? fields.path)).slice(0, 320)
			this.writeStatus(`Tool: ${tool}${args ? ` — ${args}` : ""}`, "blue")
			return
		}
		if (normalized === "tool_result") {
			this.endStreamLine()
			const tool = sanitizeTerminalText(asString(fields.tool ?? fields.name) || "tool").slice(0, 120)
			const failed = fields.isError === true
			this.writeStatus(`Tool ${failed ? "failed" : "finished"}: ${tool}`, failed ? "red" : "green")
			const detail = sanitizeTerminalText(asString(fields.content ?? fields.result)).slice(0, MAX_STATUS_CHARS)
			if (detail) this.writeStatus(detail)
			return
		}
		if (normalized.includes("budget")) {
			this.endStreamLine()
			this.writeStatus(`Budget: ${fields.message ? asString(fields.message) : summarizeFields(fields)}`, "yellow")
			return
		}
		if (normalized === "history_warning" || normalized === "history_truncated") {
			this.endStreamLine()
			this.writeNotice(asString(fields.message) || "Some prior history was truncated before this turn.")
			return
		}
		if (normalized === "iteration" || normalized === "iteration_start" || normalized === "status") {
			const message = asString(fields.message) || summarizeFields(fields)
			if (message) this.writeStatus(message)
			return
		}
		if (normalized === "error" || normalized === "failure") {
			this.endStreamLine()
			this.writeError(asString(fields.message ?? fields.error) || "turn failed")
			return
		}
		if (normalized === "session_end" || normalized === "turn_complete" || normalized === "complete") {
			this.endStreamLine()
			const status = asString(fields.status)
			if (status) this.writeStatus(`Turn ${status}`, status === "success" ? "green" : "yellow")
			return
		}
		if (normalized.includes("reasoning")) return
		const summary = summarizeFields(fields)
		if (summary) this.writeStatus(`[${sanitizeTerminalText(type).slice(0, 60)}] ${summary}`)
	}

	finishTurn(resultText: string, status: "success" | "error", cancelled = false): void {
		this.endStreamLine()
		const safeResult = sanitizeTerminalText(resultText).slice(0, MAX_EVENT_CHARS)
		if (safeResult && !this.streamedText) this.writeBlock(safeResult)
		else if (safeResult && !safeResult.startsWith(this.streamedText)) this.writeBlock(`Final response:\n${safeResult}`)
		this.writeStatus(cancelled ? "Turn cancelled." : `Turn ${status}.`, cancelled ? "yellow" : status === "success" ? "green" : "red")
	}

	private endStreamLine(): void {
		if (this.currentTextLineOpen) this.options.output.write("\n")
		this.currentTextLineOpen = false
	}

	private writeBlock(text: string): void {
		for (const line of text.split("\n")) this.writeWrapped(line)
	}

	writeStatus(text: string, color?: "red" | "green" | "yellow" | "blue" | "cyan"): void {
		const safe = sanitizeTerminalText(text).slice(0, MAX_STATUS_CHARS)
		const width = this.columns()
		const lines = width && width > 0 ? wrapPlainText(safe, Math.max(1, width)) : [safe]
		for (const line of lines) this.options.output.write(`${this.paint(line, color)}\n`)
	}

	private writeWrapped(text: string): void {
		const width = this.columns()
		if (!width || width < 1) {
			this.options.output.write(`${text}\n`)
			return
		}
		const lines = wrapPlainText(text, Math.max(1, width))
		this.options.output.write(`${lines.join("\n")}\n`)
	}

	private paint(text: string, color?: "red" | "green" | "yellow" | "blue" | "cyan"): string {
		if (!color || !this.options.color) return text
		const code = { red: 31, green: 32, yellow: 33, blue: 34, cyan: 36 }[color]
		return `\u001b[${code}m${text}\u001b[0m`
	}
}

export function sanitizeTerminalText(value: string): string {
	return value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[P^_].*?\u001b\\/gs, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
}

export function wrapPlainText(value: string, width: number): string[] {
	const lines: string[] = []
	for (const paragraph of value.split("\n")) {
		if (!paragraph) { lines.push(""); continue }
		let line = ""
		for (const word of paragraph.split(/\s+/)) {
			if (!line) { line = word; continue }
			if (line.length + 1 + word.length <= width) line += ` ${word}`
			else { lines.push(line); line = word }
			while (line.length > width) { lines.push(line.slice(0, width)); line = line.slice(width) }
		}
		if (line) lines.push(line)
	}
	return lines
}

function asString(value: unknown): string {
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "boolean") return String(value)
	return ""
}

function summarizeFields(fields: Record<string, unknown>): string {
	const entries: string[] = []
	for (const key of ["iteration", "toolCalls", "costUsd", "inputTokens", "outputTokens", "message"]) {
		const value = fields[key]
		if (typeof value === "string" || typeof value === "number") entries.push(`${key}=${value}`)
	}
	return entries.join(" ")
}
