/**
 * SHIM — local replacement for the tiny `os-name` npm package.
 *
 * The vendored `src/core/prompts/sections/system-info.ts` imports a default
 * `osName()` function. The real package returns a human-readable OS name
 * (e.g. "macOS Sequoia"). This shim returns the same `<platform> <release>`
 * string the original code falls back to when `os-name` itself fails, keeping
 * the dependency count at the project minimum.
 *
 * The vendored `system-info.ts`'s default import of `os-name` is rewritten to
 * import this file by relative path (issue #99 rework).
 */

import * as os from "os"

export default function osName(): string {
	return `${os.platform()} ${os.release()}`
}
