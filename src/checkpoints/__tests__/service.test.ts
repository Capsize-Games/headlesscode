/**
 * Unit tests for src/checkpoints/service.ts — the shadow-git checkpoint
 * wrapper around the vendored RepoPerTaskCheckpointService. Plain
 * assert-based script (no test framework), run via
 * `npm test` -> `tsx src/checkpoints/__tests__/service.test.ts`.
 *
 * Uses a real temp directory and the real `simple-git`-backed shadow repo —
 * no mocking of git itself. The workspace directory does NOT need to be a
 * real git repo; that's the point of "shadow".
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createCheckpointService } from "../service.js"

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/**
 * Checkpoint dirs must live OUTSIDE the workspace they track (see
 * src/checkpoints/service.ts's file header for why — a restore would
 * otherwise delete a nested shadow repo). Tests use their own tmp dir here
 * rather than the real default (`~/.headlesscode/checkpoints`) so they never
 * touch the developer's home directory.
 */
async function mkTmpCheckpointDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "hc-ckpt-shadow-"))
}

async function testInitCreatesShadowRepo(): Promise<void> {
	const workspaceRoot = await mkTmpWorkspace("hc-ckpt-init-")
	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "hello\n")

	const checkpointDir = await mkTmpCheckpointDir()
	const svc = createCheckpointService({ taskId: "task-1", workspaceRoot, checkpointDir })
	const result = await svc.init()

	assert.equal(result.created, true, "first init should create the shadow repo")
	const gitDir = path.join(svc.checkpointsDir, ".git")
	const stat = await fs.stat(gitDir)
	assert.ok(stat.isDirectory(), "shadow .git dir should exist")
	assert.ok(
		svc.checkpointsDir.includes(path.join("tasks", "task-1", "checkpoints")),
		`checkpointsDir should use the RepoPerTask layout, got: ${svc.checkpointsDir}`,
	)
}

async function testSaveCreatesCheckpoint(): Promise<void> {
	const workspaceRoot = await mkTmpWorkspace("hc-ckpt-save-")
	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "v1\n")

	const checkpointDir = await mkTmpCheckpointDir()
	const svc = createCheckpointService({ taskId: "task-2", workspaceRoot, checkpointDir })
	await svc.init()

	const before = await svc.list()
	assert.equal(before.length, 1, "init should have produced exactly the baseline commit")

	await fs.writeFile(path.join(workspaceRoot, "b.txt"), "new file\n")
	const saved = await svc.save("checkpoint after adding b.txt")
	assert.ok(saved && saved.commit, "save should return a commit result when there are changes")

	const after = await svc.list()
	assert.equal(after.length, 2, "list should now report baseline + the new checkpoint")
}

async function testSecondSaveAfterChangeCreatesNewCheckpoint(): Promise<void> {
	const workspaceRoot = await mkTmpWorkspace("hc-ckpt-save2-")
	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "v1\n")

	const checkpointDir = await mkTmpCheckpointDir()
	const svc = createCheckpointService({ taskId: "task-3", workspaceRoot, checkpointDir })
	await svc.init()

	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "v2\n")
	const first = await svc.save("edit a.txt to v2")
	assert.ok(first?.commit, "first edit should produce a checkpoint")

	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "v3\n")
	const second = await svc.save("edit a.txt to v3")
	assert.ok(second?.commit, "second edit should produce a distinct checkpoint")
	assert.notEqual(first?.commit, second?.commit, "checkpoints should have distinct hashes")

	const entries = await svc.list()
	assert.equal(entries.length, 3, "baseline + 2 checkpoints")

	// No changes -> no new commit unless allowEmpty.
	const noop = await svc.save("no changes")
	assert.equal(noop, undefined, "saving with no changes and allowEmpty unset should be a no-op")
}

async function testRestoreRevertsFileContent(): Promise<void> {
	const workspaceRoot = await mkTmpWorkspace("hc-ckpt-restore-")
	const filePath = path.join(workspaceRoot, "a.txt")
	await fs.writeFile(filePath, "original\n")

	const checkpointDir = await mkTmpCheckpointDir()
	const svc = createCheckpointService({ taskId: "task-4", workspaceRoot, checkpointDir })
	await svc.init()

	const entries1 = await svc.list()
	const baselineHash = entries1[0].hash

	await fs.writeFile(filePath, "modified\n")
	const saved = await svc.save("modify a.txt")
	assert.ok(saved?.commit, "modification should produce a checkpoint")

	// Sanity: the file really is modified before restore.
	assert.equal(await fs.readFile(filePath, "utf-8"), "modified\n")

	await svc.restore(baselineHash)
	const restored = await fs.readFile(filePath, "utf-8")
	assert.equal(restored, "original\n", "restoring the baseline checkpoint should revert the file content")
}

async function testListReturnsCheckpointsInOrder(): Promise<void> {
	const workspaceRoot = await mkTmpWorkspace("hc-ckpt-list-")
	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "1\n")

	const checkpointDir = await mkTmpCheckpointDir()
	const svc = createCheckpointService({ taskId: "task-5", workspaceRoot, checkpointDir })
	await svc.init()

	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "2\n")
	await svc.save("second")
	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "3\n")
	await svc.save("third")

	const entries = await svc.list()
	assert.equal(entries.length, 3, "baseline + 2 saves")
	assert.ok(entries[0].message.toLowerCase().includes("initial") || entries[0].message.length > 0)
	assert.equal(entries[1].message, "second")
	assert.equal(entries[2].message, "third")
	// Oldest-first: dates should be non-decreasing.
	const t0 = Date.parse(entries[0].date)
	const t1 = Date.parse(entries[1].date)
	const t2 = Date.parse(entries[2].date)
	assert.ok(t0 <= t1 && t1 <= t2, "list() should return checkpoints oldest-first")
}

async function testDiffReportsChangedFile(): Promise<void> {
	const workspaceRoot = await mkTmpWorkspace("hc-ckpt-diff-")
	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "before\n")

	const checkpointDir = await mkTmpCheckpointDir()
	const svc = createCheckpointService({ taskId: "task-6", workspaceRoot, checkpointDir })
	await svc.init()

	await fs.writeFile(path.join(workspaceRoot, "a.txt"), "after\n")
	await svc.save("edit a.txt")

	const diffs = await svc.diff({})
	const entry = diffs.find((d) => d.paths.relative === "a.txt")
	assert.ok(entry, "diff should report a.txt as changed")
	assert.equal(entry?.content.before, "before\n")
	assert.equal(entry?.content.after, "after\n")
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["init: creates the shadow repo at the RepoPerTask layout", testInitCreatesShadowRepo],
	["save: creates a checkpoint commit for changed files", testSaveCreatesCheckpoint],
	["save: a second save after a further change creates a distinct checkpoint", testSecondSaveAfterChangeCreatesNewCheckpoint],
	["restore: reverts a file to a prior checkpoint's content", testRestoreRevertsFileContent],
	["list: returns checkpoints oldest-first with message + date", testListReturnsCheckpointsInOrder],
	["diff: reports before/after content for a changed file", testDiffReportsChangedFile],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} checkpoints tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
