/**
 * Structured logger for the headless harness.
 *
 * Emits human-readable lines with ISO timestamps to stdout (info/debug) and
 * stderr (warn/error), and optionally mirrors every line to a log file.
 *
 * Format: `[2026-07-31T12:00:00.000Z] INFO  message {"meta": ...}`
 *
 * This is the Phase 1 choice: readable lines (grep-friendly) rather than raw
 * JSON-lines. A JSON-lines mode can be added later without changing callers.
 */

import * as fs from "node:fs"

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

export interface LoggerOptions {
	level?: LogLevel
	/** Optional file path to append every log line to. */
	filePath?: string
}

const LEVEL_PRIORITY: Record<Exclude<LogLevel, "silent">, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
}

export class Logger {
	private readonly level: LogLevel
	private readonly filePath?: string

	constructor(options: LoggerOptions = {}) {
		this.level = options.level ?? "info"
		this.filePath = options.filePath
	}

	private shouldEmit(level: Exclude<LogLevel, "silent">): boolean {
		if (this.level === "silent") {
			return false
		}
		return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level]
	}

	private emit(level: Exclude<LogLevel, "silent">, message: string, meta?: unknown): void {
		if (!this.shouldEmit(level)) {
			return
		}
		const ts = new Date().toISOString()
		const metaPart = meta === undefined ? "" : ` ${safeStringify(meta)}`
		const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${message}${metaPart}`

		if (level === "warn" || level === "error") {
			process.stderr.write(line + "\n")
		} else {
			process.stdout.write(line + "\n")
		}

		if (this.filePath) {
			try {
				fs.appendFileSync(this.filePath, line + "\n", "utf-8")
			} catch (err) {
				process.stderr.write(`[logger] failed to write log file ${this.filePath}: ${String(err)}\n`)
			}
		}
	}

	debug(message: string, meta?: unknown): void {
		this.emit("debug", message, meta)
	}

	info(message: string, meta?: unknown): void {
		this.emit("info", message, meta)
	}

	warn(message: string, meta?: unknown): void {
		this.emit("warn", message, meta)
	}

	error(message: string, meta?: unknown): void {
		this.emit("error", message, meta)
	}
}

function safeStringify(value: unknown): string {
	if (value === undefined) {
		return "undefined"
	}
	try {
		const str = JSON.stringify(value)
		return str ?? String(value)
	} catch {
		return String(value)
	}
}
