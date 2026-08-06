/**
 * Per-session final-report persistence — `<workspaceRoot>/.headlesscode/reports/`.
 *
 * Mirrors the on-disk-layout modules idiom (src/engine/events.ts for the
 * events feed, src/engine/usage.ts for usage): one module owns one layout.
 *
 * Issue #34: a review/QA/worker session's final `attempt_completion` report
 * (the single most information-dense moment of any session) was never
 * durably persisted in full — the events feed recorded no tool_call/tool_result
 * pair for it (the loop intercepts attempt_completion before the tool-execution
 * loop), and the orchestrator state file only kept a narrow parsed slice
 * (`qa.evidence`, capped at 4000 chars, or the reviewer's findings list). A
 * surprising verdict therefore required re-running the whole session just to
 * see the reasoning that justified it. The loop writes the complete report
 * here at completion time, so the full text is one file-read away, never a
 * re-run away.
 *
 * The reports dir lives under `/.headlesscode/`, which is already gitignored,
 * and like every other auxiliary write path this is deliberately non-fatal:
 * callers wrap the write in try/catch and log a warning — a failed report
 * write must never abort or corrupt the session that produced the report.
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"

/** The reports dir for a workspace: `<workspaceRoot>/.headlesscode/reports`. */
export function reportsDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".headlesscode", "reports")
}

/** The report file path for one session: `<reportsDir>/<sessionId>.md`. */
export function reportFilePath(workspaceRoot: string, sessionId: string): string {
	return path.join(reportsDir(workspaceRoot), `${sessionId}.md`)
}

/**
 * Persist a session's complete final report as `<reportsDir>/<sessionId>.md`.
 * Creates the dir if needed and writes the raw report text verbatim. Throws
 * on failure (callers wrap this non-fatally — see the module doc comment).
 */
export async function writeSessionReport(workspaceRoot: string, sessionId: string, reportText: string): Promise<string> {
	const file = reportFilePath(workspaceRoot, sessionId)
	await fsp.mkdir(path.dirname(file), { recursive: true })
	await fsp.writeFile(file, reportText, "utf-8")
	return file
}
