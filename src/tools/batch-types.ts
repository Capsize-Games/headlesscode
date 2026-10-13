/**
 * Batch leaf types (issue #128).
 *
 * BatchSection + the minimal BatchExecutor interface lived in
 * src/tools/batch.ts, which the formatter (batch-format.ts) and the executor
 * need — batch-format importing batch while batch imports the executor closed
 * two import cycles (the architecture checker counts even type-only edges).
 * This leaf depends only on the engine types, so the formatter, batch, and
 * the executor can all share it cycle-free; batch.ts keeps re-exporting the
 * same names for backward compatibility.
 */

import type { ToolResult } from "../engine/types.js"

/** One executed, refused, or skipped sub-call, in submission order. */
export interface BatchSection {
	tool: string
	ok: boolean
	skipped: boolean
	content: string
}

/**
 * The minimal executor surface batch needs: presence check + dispatch.
 * ToolExecutor satisfies this structurally, so the executor passes itself in
 * at registration time without batch importing the executor module.
 */
export interface BatchExecutor {
	has(name: string): boolean
	execute(name: string, args: Record<string, unknown>): Promise<ToolResult>
}
