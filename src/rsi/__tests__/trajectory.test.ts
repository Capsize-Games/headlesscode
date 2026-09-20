import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { captureCandidateTrajectory, exportTrajectoryDatasets } from "../trajectory.js"
import type { CandidateRecord, RsiConfig } from "../types.js"

async function main(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hc-rsi-trajectory-"))
	const worktree = path.join(root, "candidate")
	const output = path.join(root, "output")
	await fs.mkdir(path.join(worktree, ".headlesscode", "rsi-transcripts"), { recursive: true })
	await fs.writeFile(
		path.join(worktree, ".headlesscode", "rsi-transcripts", "ollama.jsonl"),
		`${JSON.stringify({ messages: [{ role: "user", content: "task" }], response: { message: { tool_calls: [{}] } }, model: "qwen" })}\n`,
	)
	const candidate: CandidateRecord = {
		id: "candidate-success",
		generation: 0,
		parent: "baseline",
		branch: "rsi/candidate-success",
		worktree,
		baseCommit: "abc",
		status: "accepted",
		model: "qwen",
		mutation: "fixture task",
		createdAt: "now",
		updatedAt: "now",
		commits: ["commit"],
		changedFiles: ["src/engine/loop.ts"],
		protectedPathViolations: [],
		fitness: {
			score: 90,
			components: { regression: 1, visible: 1, hidden: 1, efficiency: 1, recovery: 1 },
			metrics: { correctness: 1, reliability: 1, generalization: 1, hidden: 1, efficiency: 1, latency: 1, tokenUse: 1, recovery: 1, fabricationRate: 0, complexityPenalty: 0 },
			complexity: { diffLines: 1, changedFiles: 1, newDependencies: 0, additionalModelCalls: 0, runtimeOverheadMs: 0 },
			hardGates: { regressionPass: true, visibleEvalPass: true, hiddenEvalPass: true, noProtectedPathViolation: true, completed: true, noCrash: true, committed: true },
			reason: "all hard gates passed",
		},
	}
	const config = {
		repoRoot: root,
		model: "qwen",
		population: 1,
		generations: 1,
		maxConcurrent: 1,
		mutationTask: "fixture",
		evalCommands: [],
		hiddenEvalCommands: [],
		archiveDir: path.join(root, "archive"),
		worktreeDir: path.join(root, "worktrees"),
		trajectoryDir: output,
		baseRef: "HEAD",
		seed: "test",
		dryRun: false,
		keepWorktrees: false,
		maxIterations: 1,
		protectedPaths: [],
		commandTimeoutMs: 1000,
	} satisfies RsiConfig
	const captured = await captureCandidateTrajectory(candidate, config, "now")
	assert.equal(captured.summary.messageCount, 1)
	assert.equal(captured.summary.toolCalls, 1)
	assert.equal(captured.summary.trusted, true)
	const exported = await exportTrajectoryDatasets([captured.record], output)
	assert.equal(exported.sft, 1)
	assert.equal(exported.preferences, 0)
	assert.ok((await fs.readFile(path.join(output, "manifest.json"), "utf8")).includes('"trustedOnly": true'))
	await fs.rm(root, { recursive: true, force: true })
	console.log("All 1 RSI trajectory test passed")
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
