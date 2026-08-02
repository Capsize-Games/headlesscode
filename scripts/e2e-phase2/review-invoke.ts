#!/usr/bin/env tsx
/**
 * review-invoke.ts — Phase 2 e2e helper: run ONE headless review against a
 * worktree through the REAL runReview() code path, with the LLM client
 * pointed at the mock OpenRouter server via env.
 *
 * Usage:
 *   OPENROUTER_BASE_URL=http://127.0.0.1:<port> HEADLESSCODE_OPENROUTER_API_KEY=test-key \
 *     npx tsx scripts/e2e-phase2/review-invoke.ts --workspace <path> [--mode <slug>]
 *
 * Prints:
 *   REVIEW_VERDICT=clean|finding
 *   REVIEW_FINDINGS=<count>
 *   REVIEW_SUMMARY=<flattened summary>
 */

import { OpenRouterClient } from "../../src/llm/openrouter.js"
import { runReview } from "../../src/orchestrator/reviewer.js"

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const wsIdx = args.indexOf("--workspace")
	if (wsIdx === -1 || !args[wsIdx + 1]) {
		console.error("usage: review-invoke.ts --workspace <path> [--mode <slug>]")
		process.exit(2)
	}
	const workspaceRoot = args[wsIdx + 1]
	const modeIdx = args.indexOf("--mode")
	const mode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : "deepseek-reviewer"

	const client = new OpenRouterClient({
		apiKey: process.env.HEADLESSCODE_OPENROUTER_API_KEY,
		defaultModel: process.env.OPENROUTER_MODEL,
	})
	const result = await runReview({ workspaceRoot, mode, llmClient: client })

	process.stdout.write(`REVIEW_VERDICT=${result.verdict}\n`)
	process.stdout.write(`REVIEW_FINDINGS=${result.findings.length}\n`)
	process.stdout.write(`REVIEW_SUMMARY=${result.summary.replace(/\n/g, " ").slice(0, 2000)}\n`)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack ?? err.message : String(err))
	process.exit(1)
})
