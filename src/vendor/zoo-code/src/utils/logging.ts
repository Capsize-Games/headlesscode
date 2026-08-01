/**
 * SHIM — console-backed logger replacing zoo-code/src/utils/logging.ts.
 *
 * The original wraps VS Code output channels; the headless harness logs to
 * stdout/stderr instead.
 */

export const logger = {
	info: (message: string, meta?: unknown): void => {
		console.log(`[headlesscode] ${message}`, meta ?? "")
	},
	warn: (message: string, meta?: unknown): void => {
		console.warn(`[headlesscode] ${message}`, meta ?? "")
	},
	error: (message: string, meta?: unknown): void => {
		console.error(`[headlesscode] ${message}`, meta ?? "")
	},
	debug: (message: string, meta?: unknown): void => {
		console.debug(`[headlesscode] ${message}`, meta ?? "")
	},
}
