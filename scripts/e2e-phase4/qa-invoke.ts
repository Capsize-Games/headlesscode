#!/usr/bin/env tsx
/**
 * qa-invoke.ts — Phase 4 e2e helper: run ONE headless QA session against a
 * worktree through the REAL runQa() code path, with the LLM client pointed at
 * the mock OpenRouter server via env.
 *
 * Usage:
 *   OPENROUTER_BASE_URL=http://127.0.0.1:<port> HEADLESSCODE_OPENROUTER_API_KEY=test-key \
 *     npx tsx scripts/e2e-phase4/qa-invoke.ts --workspace <path> [--mode <slug>]
 *
 * Prints:
 *   QA_VERDICT=pass|fail|error
 *   QA_EVIDENCE=<flattened evidence>
 *   QA_SUMMARY=<flattened summary>
 */

import { OpenRouterClient } from "../../src/llm/openrouter.js"
import { runQa } from "../../src/qa/qa.js"

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const wsIdx = args.indexOf("--workspace")
	if (wsIdx === -1 || !args[wsIdx + 1]) {
		console.error("usage: qa-invoke.ts --workspace <path> [--mode <slug>]")
		process.exit(2)
	}
	const workspaceRoot = args[wsIdx + 1]
	const modeIdx = args.indexOf("--mode")
	const mode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : "qa-agent"

	const client = new OpenRouterClient({
		apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY,
		defaultModel: process.env.OPENROUTER_MODEL,
	})
	const result = await runQa({ workspaceRoot, mode, llmClient: client })

	process.stdout.write(`QA_VERDICT=${result.verdict}\n`)
	process.stdout.write(`QA_EVIDENCE=${result.evidence.replace(/\n/g, " ").slice(0, 2000)}\n`)
	process.stdout.write(`QA_SUMMARY=${result.summary.replace(/\n/g, " ").slice(0, 2000)}\n`)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack ?? err.message : String(err))
	process.exit(1)
})
