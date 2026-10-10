import * as readline from "node:readline"
import type { Readable, Writable } from "node:stream"

export type TerminalInputResult = { kind: "line"; line: string } | { kind: "interrupt" } | { kind: "eof" }

export interface TerminalInputOptions {
	input: Readable
	output: Writable
	terminal: boolean
	historySize?: number
}

/** Read physical lines while keeping readline's native terminal history. */
export class TerminalInput {
	readonly interface: readline.Interface
	readonly history: string[] = []
	private readonly queued: TerminalInputResult[] = []
	private readonly waiters: Array<(value: TerminalInputResult) => void> = []
	private closed = false
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
		if (this.queued.length > 0) return this.queued.shift()!
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
		const waiter = this.waiters.shift()
		if (waiter) waiter(value)
		else this.queued.push(value)
	}
}

export type ComposedInput = { kind: "message"; text: string } | { kind: "interrupt" } | { kind: "eof" } | { kind: "too-long" }

const MAX_MESSAGE_CHARS = 50_000

/** `"""` on a line by itself enters a multiline draft; another closes it. */
export async function readComposedInput(input: TerminalInput, terminal: boolean): Promise<ComposedInput> {
	const first = await input.readLine(terminal ? "you> " : "")
	if (first.kind !== "line") return first
	if (first.line.trim() === "\"\"\"") {
		const lines: string[] = []
		let size = 0
		for (;;) {
			const next = await input.readLine(terminal ? "... " : "")
			if (next.kind === "interrupt") return next
			if (next.kind === "eof") return next
			if (next.line.trim() === "\"\"\"") break
			if (size <= MAX_MESSAGE_CHARS) {
				lines.push(next.line)
				size += next.line.length + 1
			}
		}
		if (size > MAX_MESSAGE_CHARS) return { kind: "too-long" }
		const text = lines.join("\n")
		input.rememberPrompt(text)
		return { kind: "message", text }
	}
	const lines = [first.line]
	let size = first.line.length
	while (hasContinuation(lines.at(-1)!)) {
		lines[lines.length - 1] = lines.at(-1)!.slice(0, -1)
		const next = await input.readLine(terminal ? "... " : "")
		if (next.kind === "interrupt" || next.kind === "eof") return next
		lines.push(next.line)
		size += next.line.length + 1
		if (size > MAX_MESSAGE_CHARS) {
			while (hasContinuation(lines.at(-1)!)) {
				const remainder = await input.readLine(terminal ? "... " : "")
				if (remainder.kind === "interrupt" || remainder.kind === "eof") return remainder
				lines.push(remainder.line)
			}
			return { kind: "too-long" }
		}
	}
	if (size > MAX_MESSAGE_CHARS) return { kind: "too-long" }
	const text = lines.join("\n")
	input.rememberPrompt(text)
	return { kind: "message", text }
}

function hasContinuation(value: string): boolean {
	let count = 0
	for (let index = value.length - 1; index >= 0 && value[index] === "\\"; index--) count++
	return count % 2 === 1
}
