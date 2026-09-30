import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const root = process.cwd()
const { saveStateSync, patchGroup, loadStateSync } = await import(pathToFileURL(path.join(root, "src/orchestrator/state.ts")))
const { watchGroups } = await import(pathToFileURL(path.join(root, "src/orchestrator/watch.ts")))
const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rsi-watch-abort-"))
const statePath = path.join(repoRoot, ".worktrees/.orchestrator-state.json")
const groupRoot = path.join(repoRoot, ".worktrees/w1")
const finishedPath = path.join(repoRoot, "callback-finished")
const controller = new AbortController()
try {
	await fs.mkdir(path.join(groupRoot, ".harness.done"), { recursive: true })
	await fs.writeFile(path.join(groupRoot, ".harness.exit"), "1\n")
	saveStateSync(statePath, {
		batch: "benchmark", updated: new Date().toISOString(), groups: [{
			name: "w1", worktree: ".worktrees/w1", branch: "benchmark", issues: [], task_file: "task.md",
			status: "running", spawned: new Date().toISOString(), commits: [], actions_taken: [], pending_review_findings: [],
		}],
	})
	const summary = await watchGroups({
		repoRoot, statePath, pollIntervalMs: 1, reviewEnabled: false, qaEnabled: false, signal: controller.signal,
		stderrWriter: () => {},
		onGroupUpdate: async () => {
			controller.abort()
			await new Promise((resolve) => setTimeout(resolve, 80))
			await patchGroup(statePath, "w1", { summary: "callback settled" })
			await fs.writeFile(finishedPath, "yes")
		},
	})
	assert.equal(summary.state.groups[0]?.summary, "callback settled", "watchGroups must drain callback state writes before returning")
	assert.equal(await fs.readFile(finishedPath, "utf8"), "yes", "watchGroups must not return while the callback is still running")
	assert.equal(loadStateSync(statePath).groups[0]?.summary, "callback settled")
	console.log("watch abort callback drain behavior passed")
} finally {
	await fs.rm(repoRoot, { recursive: true, force: true })
}
