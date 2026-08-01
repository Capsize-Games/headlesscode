/**
 * Real Ollama smoke test for local output summarization.
 *
 * Runs the REAL executor (createHeadlessExecutor) with
 * HEADLESSCODE_LOCAL_SUMMARIZATION=1 against the REAL local Ollama server,
 * executing a command that produces oversized output, and prints the
 * summarized result. This proves the whole wiring end-to-end with real
 * hardware, not a fake server.
 *
 * Run: HEADLESSCODE_LOCAL_SUMMARIZATION=1 npx tsx recon/local-summ-fixtures/smoke-executor.mjs
 */
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHeadlessExecutor } from "../../src/tools/executor.js"

const ws = await fs.mkdtemp(path.join(os.tmpdir(), "hc-summ-smoke-"))
try {
	const executor = createHeadlessExecutor(ws)
	// A command that prints ~45KB of mostly-noise lines with one real error
	// buried near the end (past the 30KB blunt-truncation cutoff).
	const command =
		`node -e 'let s=""; for (let i=0;i<800;i++) s += "info: processing chunk " + i + " ok padding padding padding padding padding\\n"; ` +
		`s += "ERROR: the actual problem is in chunk 799 - config timeout\\n"; process.stdout.write(s)'`

	console.log("=== running execute_command with real Ollama summarization ===")
	const started = Date.now()
	const result = await executor.execute("execute_command", { command })
	console.log(`(took ${Date.now() - started}ms)`)
	console.log("isError:", result.isError)
	console.log("--- result content (first 1200 chars) ---")
	console.log(result.content.slice(0, 1200))
	console.log("--- end ---")
	console.log("content length:", result.content.length)
} finally {
	await fs.rm(ws, { recursive: true, force: true })
}
