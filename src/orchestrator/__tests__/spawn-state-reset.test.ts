/**
 * Regression test for issue #28: a reused worktree slot (e.g. "w1", freed up
 * by `orchestrate cleanup --apply` removing the worktree dir but leaving the
 * group's state entry for history) must NOT inherit a previous round's
 * review_verdict/qa/cost_recorded/reviewed_at/pending_review_findings.
 *
 * scripts/spawn-parallel-worktrees.sh's merge_state() previously always
 * shallow-merged the fresh "spawned" patch onto any existing same-named
 * entry, so those stale fields survived untouched — cli.ts's review/QA gates
 * check `!== undefined` on them, so a brand-new round silently looked
 * already-reviewed/QA'd/costed and both were skipped for real. Caught live
 * running the round for issue #25 itself.
 *
 * Runs the REAL spawn script end-to-end against a throwaway fixture (same
 * pattern as spawn-model.test.ts), with HEADLESSCODE_CLI stubbed to `echo` so
 * no LLM/API key is needed.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const SPAWN_SCRIPT = path.join(REPO_ROOT, "scripts", "spawn-parallel-worktrees.sh")

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function makeFixtureWithStaleState(): Promise<string> {
	const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "headlesscode-spawn-state-reset-"))
	await fsPromises.mkdir(path.join(dir, "src"), { recursive: true })
	await fsPromises.mkdir(path.join(dir, "plans", "parallel-tasks"), { recursive: true })
	await fsPromises.writeFile(path.join(dir, "src", "a.js"), "module.exports = 1\n", "utf-8")
	await fsPromises.writeFile(
		path.join(dir, "plans", "parallel-tasks", "task.md"),
		"## assignment\nno-op fixture task\n",
		"utf-8",
	)
	execFileSync("git", ["init", "-q", "-b", "master", dir], { stdio: "ignore" })
	execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" })
	execFileSync(
		"git",
		[
			"-C", dir, "-c", "user.name=Headlesscode SpawnStateReset", "-c", "user.email=spawn-state-reset@headlesscode.invalid",
			"-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture",
		],
		{ stdio: "ignore" },
	)

	// Pre-seed a STALE "w1" entry — simulating a previous round's group that
	// finished, was reviewed clean, QA'd pass, cost recorded, and cleaned up
	// (worktree dir removed, state entry left behind).
	await fsPromises.mkdir(path.join(dir, ".worktrees"), { recursive: true })
	const staleState = {
		batch: "round-2026-01-01",
		groups: [
			{
				name: "w1",
				worktree: ".worktrees/w1",
				branch: "issues/w1-2026-01-01",
				issues: [999],
				status: "done",
				spawned: "2026-01-01T00:00:00.000Z",
				exit_code: 0,
				review_verdict: "clean",
				pending_review_findings: [],
				reviewed_at: "2026-01-01T00:05:00.000Z",
				qa: { status: "done", verdict: "pass", evidence: "stale evidence from a previous unrelated issue", updated: "2026-01-01T00:10:00.000Z" },
				cost_recorded: "2026-01-01T00:11:00.000Z",
				cleaned_at: "2026-01-01T00:12:00.000Z",
			},
		],
	}
	await fsPromises.writeFile(
		path.join(dir, ".worktrees", ".orchestrator-state.json"),
		JSON.stringify(staleState, null, 2) + "\n",
		"utf-8",
	)
	return dir
}

function runSpawn(fixture: string, spec: string): string {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		TARGET_REPO: fixture,
		HEADLESSCODE_ROOT: REPO_ROOT,
		HEADLESSCODE_CLI: "echo",
		ALLOW_UNINDEXED: "1",
		SPAWN_MODEL: "",
		OPENROUTER_MODEL: "",
	}
	return execFileSync("bash", [SPAWN_SCRIPT, spec], { env, encoding: "utf-8" })
}

async function waitForDone(wtPath: string, timeoutMs = 15000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (fs.existsSync(path.join(wtPath, ".harness.done"))) {
			return
		}
		await sleep(100)
	}
	throw new Error(`worker did not complete within ${timeoutMs}ms (no .harness.done at ${wtPath})`)
}

async function cleanupFixture(fixture: string, wtName: string): Promise<void> {
	const pgidFile = path.join(fixture, ".worktrees", wtName, ".harness.pgid")
	const pidFile = path.join(fixture, ".worktrees", wtName, ".harness.pid")
	for (const file of [pgidFile, pidFile]) {
		if (fs.existsSync(file)) {
			try {
				const pid = Number(fs.readFileSync(file, "utf-8"))
				process.kill(file === pgidFile ? -pid : pid, "SIGKILL")
			} catch {
				/* worker already gone */
			}
		}
	}
	try {
		execFileSync("git", ["-C", fixture, "worktree", "remove", "--force", path.join(fixture, ".worktrees", wtName)], {
			stdio: "ignore",
		})
	} catch {
		/* worktree not registered — rm -rf below cleans up */
	}
	await fsPromises.rm(fixture, { recursive: true, force: true })
}

async function testReusedSlotClearsStaleReviewQaCostFields(): Promise<void> {
	const fixture = await makeFixtureWithStaleState()
	try {
		const out = runSpawn(fixture, "w1:0:plans/parallel-tasks/task.md")
		const wtPath = path.join(fixture, ".worktrees", "w1")
		await waitForDone(wtPath)
		assert.ok(out.includes("Worktree 'w1' ready"), `spawn should succeed and reuse the "w1" name, got:\n${out}`)

		const state = JSON.parse(
			await fsPromises.readFile(path.join(fixture, ".worktrees", ".orchestrator-state.json"), "utf-8"),
		) as { groups: Array<Record<string, unknown>> }
		const group = state.groups.find((g) => g.name === "w1")
		assert.ok(group, "w1 group entry must exist after respawn")

		assert.equal(group!.review_verdict, undefined, "stale review_verdict must not survive a reused slot")
		assert.equal(group!.qa, undefined, "stale qa result must not survive a reused slot")
		assert.equal(group!.cost_recorded, undefined, "stale cost_recorded must not survive a reused slot")
		assert.equal(group!.reviewed_at, undefined, "stale reviewed_at must not survive a reused slot")
		assert.deepEqual(group!.pending_review_findings, undefined, "stale findings must not survive a reused slot")
		assert.equal(group!.cleaned_at, undefined, "stale cleaned_at must not survive a reused slot")

		// The NEW round's own data must be present and fresh.
		assert.deepEqual(group!.issues, [], "fresh spawn has this round's own issues, not the stale [999]")
		assert.notEqual(group!.spawned, "2026-01-01T00:00:00.000Z", "spawned timestamp must be from THIS spawn, not the stale one")
	} finally {
		await cleanupFixture(fixture, "w1")
	}
}

const tests: Array<[string, () => Promise<void>]> = [
	["reused worktree slot clears stale review_verdict/qa/cost_recorded (issue #28)", testReusedSlotClearsStaleReviewQaCostFields],
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
			console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} spawn-state-reset tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
