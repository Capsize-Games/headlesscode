#!/usr/bin/env tsx
/**
 * watch-invoke.ts — Phase 2 e2e helper: run the REAL watchGroups() loop once
 * against a target repo. Because workers already wrote their .harness.done
 * markers, the watcher transitions every group to done/failed, persists the
 * state file, and returns.
 *
 * Usage:
 *   npx tsx scripts/e2e-phase2/watch-invoke.ts <repo-root> [poll-ms]
 *
 * Prints:
 *   GROUP <name> status=<status> exit_code=<code>
 *   ALL_TERMINAL=true|false
 */

import { watchGroups } from "../../src/orchestrator/watch.js"

async function main(): Promise<void> {
	const repo = process.argv[2]
	if (!repo) {
		console.error("usage: watch-invoke.ts <repo-root> [poll-ms]")
		process.exit(2)
	}
	const pollMs = Number(process.argv[3] ?? 500)
	const { state, allTerminal } = await watchGroups({ repoRoot: repo, pollIntervalMs: pollMs })

	for (const g of state.groups) {
		process.stdout.write(`GROUP ${g.name} status=${g.status} exit_code=${g.exit_code ?? "?"}\n`)
	}
	process.stdout.write(`ALL_TERMINAL=${allTerminal}\n`)
	process.exit(allTerminal ? 0 : 1)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack ?? err.message : String(err))
	process.exit(1)
})
