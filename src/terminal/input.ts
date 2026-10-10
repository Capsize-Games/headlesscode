import * as readline from "node:readline"
import type { Readable, Writable } from "node:stream"

export type TerminalInputResult = { kind: "line"; line: string } | { kind: "interrupt" } | { kind: "eof" } | { kind: "overflow" }

export interface TerminalInputOptions {
	input: Readable
	output: Writable
	terminal: boolean
	historySize?: number
	maxQueuedLines?: number
	maxQueuedChars?: number
}

/** Read physical lines while keeping readline's native terminal history. */
export class TerminalInput {
	readonly interface: readline.Interface
	readonly history: string[] = []
	private readonly queued: TerminalInputResult[] = []
	private readonly waiters: Array<(value: TerminalInputResult) => void> = []
	private queuedChars = 0
	private closed = false
	private overflowed = false
	private overflowPending = false
	private interruptHandler?: () => boolean

	constructor(private readonly options: TerminalInputOptions) {
		this.interface = readline.createInterface({
			input: options.input,
			output: options.output,
			terminal: options.terminal,
			historySize: options.historySize ?? 500,
			removeHistoryDuplicates: true,
			crlfDelay: Infinity,
		})
		this.interface.on("line", (line) => this.push({ kind: "line", line }))
		this.interface.on("close", () => {
			this.closed = true
			this.push({ kind: "eof" })
		})
		this.interface.on("SIGINT", () => {
			if (this.interruptHandler?.()) return
			this.push({ kind: "interrupt" })
		})
	}

	setInterruptHandler(handler: (() => boolean) | undefined): void { this.interruptHandler = handler }

	async readLine(prompt: string): Promise<TerminalInputResult> {
		if (this.options.terminal && prompt) this.options.output.write(prompt)
		const queued = this.queued.shift()
		if (queued) {
			if (queued.kind === "line") this.queuedChars -= queued.line.length
			return queued
		}
		if (this.overflowPending) {
			this.overflowPending = false
			return { kind: "overflow" }
		}
		if (this.closed) return { kind: "eof" }
		return await new Promise((resolve) => this.waiters.push(resolve))
	}

	rememberPrompt(prompt: string): void {
		if (!prompt.trim()) return
		this.history.push(prompt)
		if (this.history.length > (this.options.historySize ?? 500)) this.history.shift()
	}

	close(): void { this.interface.close() }

	private push(value: TerminalInputResult): void {
		if (this.overflowed) {
			if (value.kind === "eof") this.closed = true
			return
		}
		const waiter = this.waiters.shift()
		if (waiter) waiter(value)
		else {
			if (value.kind === "line") {
				const maxLines = this.options.maxQueuedLines ?? 256
				const maxChars = this.options.maxQueuedChars ?? 1024 * 1024
				if (this.queued.length >= maxLines || this.queuedChars + value.line.length > maxChars) {
					this.overflowed = true
					this.overflowPending = true
					this.queued.length = 0
					this.queuedChars = 0
					this.options.input.pause()
					this.interface.close()
					return
				}
				this.queuedChars += value.line.length
			}
			this.queued.push(value)
		}
	}
}

export type ComposedInput = { kind: "message"; text: string } | { kind: "interrupt" } | { kind: "eof" } | { kind: "overflow" } | { kind: "too-long" }

const MAX_MESSAGE_CHARS = 50_000

/** `"""` on a line by itself enters a multiline draft; another closes it. */
export async function readComposedInput(input: TerminalInput, terminal: boolean): Promise<ComposedInput> {
	const first = await input.readLine(terminal ? "you> " : "")
	if (first.kind !== "line") return first
	if (first.line.trim() === "\"\"\"") {
		const lines: string[] = []
		let size = 0
		let tooLong = false
		for (;;) {
			const next = await input.readLine(terminal ? "... " : "")
			if (next.kind === "interrupt") return next
			if (next.kind === "eof") return next
			if (next.kind === "overflow") return next
			if (next.line.trim() === "\"\"\"") break
			size += next.line.length + 1
			if (!tooLong && size <= MAX_MESSAGE_CHARS) {
				lines.push(next.line)
			} else {
				tooLong = true
				lines.length = 0
			}
		}
		if (tooLong) return { kind: "too-long" }
		const text = lines.join("\n")
		input.rememberPrompt(text)
		return { kind: "message", text }
	}
	let size = first.line.length
	let lastLine = first.line
	let tooLong = size > MAX_MESSAGE_CHARS
	const lines = tooLong ? [] : [first.line]
	while (hasContinuation(lastLine)) {
		lastLine = lastLine.slice(0, -1)
		if (!tooLong) lines[lines.length - 1] = lastLine
		const next = await input.readLine(terminal ? "... " : "")
		if (next.kind === "interrupt" || next.kind === "eof") return next
		if (next.kind === "overflow") return next
		lastLine = next.line
		size += next.line.length + 1
		if (!tooLong && size <= MAX_MESSAGE_CHARS) lines.push(next.line)
		else {
			tooLong = true
			lines.length = 0
			while (hasContinuation(lastLine)) {
				const remainder = await input.readLine(terminal ? "... " : "")
				if (remainder.kind === "interrupt" || remainder.kind === "eof") return remainder
				if (remainder.kind === "overflow") return remainder
				lastLine = remainder.line
			}
			return { kind: "too-long" }
		}
	}
	if (tooLong) return { kind: "too-long" }
	const text = lines.join("\n")
	input.rememberPrompt(text)
	return { kind: "message", text }
}

function hasContinuation(value: string): boolean {
	let count = 0
	for (let index = value.length - 1; index >= 0 && value[index] === "\\"; index--) count++
	return count % 2 === 1
}
