#!/usr/bin/env tsx
/**
 * continuation-invoke.ts — Phase 2 e2e helper for issue #2 Part 2
 * (iteration-exhaustion auto-continue). Runs the REAL watchGroups() loop
 * against a target repo WITH the same continuation callback orchestrateMain
 * wires in (handleIterationExhaustion): a worker that fails specifically
 * because it hit --max-iterations is re-spawned on the SAME worktree up to
 * --max-continuations, then the group is marked needs-human.
 *
 * Usage:
 *   npx tsx scripts/e2e-phase2/continuation-invoke.ts <repo-root> <max-iterations> <max-continuations> [poll-ms]
 *
 *   OPENROUTER_BASE_URL / HEADLESSCODE_OPENROUTER_API_KEY / HEADLESSCODE_ROOT
 *   must be in the environment (inherited by the re-spawned workers).
 *
 * Prints:
 *   CONTINUE <name> count=<n> wrote=<task-file>
 *   NEEDS_HUMAN <name> count=<n>
 *   GROUP <name> status=<status> exit_code=<code> continuation_count=<n>
 *   ALL_TERMINAL=true|false
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

import { handleIterationExhaustion } from "../../src/orchestrator/cli.js"
import { loadStateSync, saveStateSync, updateGroup } from "../../src/orchestrator/state.js"
import { watchGroups } from "../../src/orchestrator/watch.js"

async function main(): Promise<void> {
	const repo = process.argv[2]
	if (!repo) {
		console.error("usage: continuation-invoke.ts <repo-root> <max-iterations> <max-continuations> [poll-ms]")
		process.exit(2)
	}
	const maxIterations = Number(process.argv[3] ?? 3)
	const maxContinuations = Number(process.argv[4] ?? 2)
	const pollMs = Number(process.argv[5] ?? 500)

	const statePath = path.join(repo, ".worktrees", ".orchestrator-state.json")
	const applyPatch = (groupName: string, patch: Parameters<typeof updateGroup>[2]): void => {
		saveStateSync(statePath, updateGroup(loadStateSync(statePath), groupName, patch))
	}

	const { state, allTerminal } = await watchGroups({
		repoRoot: repo,
		pollIntervalMs: pollMs,
		onGroupUpdate: async (group) => {
			if (group.status !== "failed") {
				return
			}
			const decision = handleIterationExhaustion(group, repo, maxContinuations, "code", undefined, maxIterations)
			if (decision.shouldSpawn && decision.taskFilePath && decision.taskContent && decision.spawnCommand) {
				fs.mkdirSync(path.dirname(decision.taskFilePath), { recursive: true })
				fs.writeFileSync(decision.taskFilePath, decision.taskContent, "utf-8")
				process.stdout.write(
					`CONTINUE ${group.name} count=${decision.newContinuationCount} wrote=${path.basename(decision.taskFilePath)}\n`,
				)
				const spawnResult = spawnSync("bash", ["-c", decision.spawnCommand], {
					cwd: repo,
					env: { ...process.env },
					stdio: "inherit",
				})
				if (spawnResult.status !== 0) {
					throw new Error(`continuation spawn for ${group.name} failed (exit ${spawnResult.status})`)
				}
				applyPatch(group.name, decision.patch)
				return true
			}
			if (decision.patch.status === "needs-human") {
				process.stdout.write(`NEEDS_HUMAN ${group.name} count=${decision.newContinuationCount}\n`)
				applyPatch(group.name, decision.patch)
				return true
			}
			// Real failure (not iteration exhaustion): stays failed.
			return
		},
	})

	for (const g of state.groups) {
		process.stdout.write(
			`GROUP ${g.name} status=${g.status} exit_code=${g.exit_code ?? "?"} continuation_count=${g.continuationCount ?? 0}\n`,
		)
	}
	process.stdout.write(`ALL_TERMINAL=${allTerminal}\n`)
	process.exit(allTerminal ? 0 : 1)
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack ?? err.message : String(err))
	process.exit(1)
})
