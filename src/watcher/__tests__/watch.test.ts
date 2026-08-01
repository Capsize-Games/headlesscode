/**
 * Unit tests for src/watcher/watch.ts — the poll/sweep/fan-out loop.
 * Plain assert-based, no network: the GitHub client and the spawner are
 * injected (same DI pattern as LlmClient in the engine). Covers:
 *   A. new labeled issue -> spawn once, entry 'done', runOnce exits
 *   B. same issue next sweep -> skipped (idempotent across "restarts")
 *   C. maxPerSweep cap: deferred issues stay 'pending' and spawn later
 *   D. spawn failure -> 'failed', no auto-retry; --retry-failed forces retry
 *   E. dry-run -> no spawn, no state writes, plan reported
 *   F. continuous mode stops cleanly on AbortSignal
 * Plus the write-ahead ordering guarantee (entry visible to the spawn step).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { Logger } from "../../engine/logger.js"
import { watchIssues, type SpawnBatch, type SpawnResult, type WatcherConfig } from "../watch.js"
import { loadWatcherState } from "../state.js"
import type { GhClient, GitHubIssue } from "../github.js"

const SILENT = new Logger({ level: "silent" })

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-watcher-repo-"))
}

function issue(number: number, title?: string): GitHubIssue {
	return {
		number,
		title: title ?? `issue ${number}`,
		body: `body of ${number}`,
		labels: ["needs-agent"],
		updated_at: "2026-08-01T00:00:00Z",
		html_url: `https://github.com/o/r/issues/${number}`,
	}
}

interface Harness {
	repoRoot: string
	stateFile: string
	spawnCalls: Array<{ batch: SpawnBatch; sawWriteAheadEntry: boolean }>
}

interface RunOptions {
	issues?: GitHubIssue[]
	maxPerSweep?: number
	retryFailed?: boolean
	dryRun?: boolean
	runOnce?: boolean
	spawnResult?: SpawnResult
	pollIntervalMs?: number
	signal?: AbortSignal
}

/** Run watchIssues once against a fresh (or shared) harness. */
async function runWatch(harness: Harness, options: RunOptions = {}): Promise<ReturnType<typeof watchIssues>> {
	const gh: GhClient = {
		listIssues: async () => options.issues ?? [],
		getIssue: async () => {
			throw new Error("unexpected getIssue")
		},
		addLabel: async () => {
			throw new Error("unexpected addLabel")
		},
	}
	const config: WatcherConfig = {
		owner: "o",
		repo: "r",
		targetLabel: "needs-agent",
		token: "test-token",
		ghBaseUrl: "https://api.github.com",
		stateFile: harness.stateFile,
		repoRoot: harness.repoRoot,
		runOnce: options.runOnce ?? true,
		maxPerSweep: options.maxPerSweep ?? 5,
		retryFailed: options.retryFailed,
		dryRun: options.dryRun,
		pollIntervalMs: options.pollIntervalMs ?? 1,
		signal: options.signal,
		logger: SILENT,
		gh,
		spawn: async (batch) => {
			// Write-ahead probe: the durable state must already carry this
			// issue as 'spawned' when the spawn step runs.
			const state = await loadWatcherState(harness.stateFile)
			const entry = state.processed[String(batch.issue.number)]
			harness.spawnCalls.push({ batch, sawWriteAheadEntry: entry?.status === "spawned" })
			return options.spawnResult ?? { ok: true, status: 0 }
		},
	}
	return watchIssues(config)
}

async function newHarness(): Promise<Harness> {
	const repoRoot = await tmpRepo()
	return { repoRoot, stateFile: path.join(repoRoot, ".worktrees", ".watcher-state.json"), spawnCalls: [] }
}

// ─── Scenario A: new labeled issue -> spawn once, done, runOnce exits ──────

async function testScenarioA(): Promise<void> {
	const h = await newHarness()
	const result = await runWatch(h, { issues: [issue(101)] })
	assert.equal(result.exitCode, 0)
	assert.equal(h.spawnCalls.length, 1, "spawn called exactly once")
	assert.equal(h.spawnCalls[0].batch.issue.number, 101)
	assert.equal(h.spawnCalls[0].batch.specs.length, 1, "one issue -> one worktree group")
	assert.equal(h.spawnCalls[0].batch.specs[0].taskFile, "w1-issue101.md")
	const state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed["101"]?.status, "done")
	assert.deepEqual(state.processed["101"]?.groups, h.spawnCalls[0].batch.specs)
	assert.ok(state.processed["101"]?.spawnedAt, "spawnedAt recorded")
	assert.ok(state.processed["101"]?.label === "needs-agent")
}

// ─── Scenario B: same issue next sweep -> skipped (idempotent) ──────────────

async function testScenarioB(): Promise<void> {
	const h = await newHarness()
	await runWatch(h, { issues: [issue(101)] })
	const before = h.spawnCalls.length
	assert.equal(before, 1)

	// Second sweep (fresh watchIssues = a "restart" that reloads the state
	// file): same label still present -> skipped, no respawn.
	const result2 = await runWatch(h, { issues: [issue(101)] })
	assert.equal(h.spawnCalls.length, before, "no duplicate spawn")
	assert.equal(result2.sweeps[0].skipped, 1)
	assert.equal(result2.sweeps[0].spawned, 0)
	assert.equal(result2.exitCode, 0)
}

// ─── Scenario C: maxPerSweep=1, 2 new issues ────────────────────────────────

async function testScenarioC(): Promise<void> {
	const h = await newHarness()
	const r1 = await runWatch(h, { issues: [issue(101), issue(102)], maxPerSweep: 1 })
	assert.equal(r1.spawned, 1)
	assert.equal(r1.sweeps[0].deferred, 1)
	assert.equal(h.spawnCalls.length, 1)
	assert.equal(h.spawnCalls[0].batch.issue.number, 101, "lowest number spawned first")

	let state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed["101"]?.status, "done")
	assert.equal(state.processed["102"]?.status, "pending", "second issue deferred as pending")

	// Next sweep (same state file): the pending issue is picked up.
	const r2 = await runWatch(h, { issues: [issue(101), issue(102)], maxPerSweep: 1 })
	assert.equal(h.spawnCalls.length, 2)
	assert.equal(h.spawnCalls[1].batch.issue.number, 102)
	state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed["102"]?.status, "done")
	assert.equal(r2.sweeps[0].skipped, 1, "#101 was already processed")
}

// ─── Scenario D: spawn failure -> failed, no auto-retry, --retry-failed ─────

async function testScenarioD(): Promise<void> {
	const h = await newHarness()
	const fail: SpawnResult = { ok: false, status: 1, error: "spawn script exited 1" }
	const r1 = await runWatch(h, { issues: [issue(101)], spawnResult: fail })
	assert.equal(r1.exitCode, 1, "spawn errors surface as exit code 1")
	let state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed["101"]?.status, "failed")
	assert.match(state.processed["101"]?.error ?? "", /spawn script exited 1/)

	// Default: failed is NOT retried on the next sweep.
	const r2 = await runWatch(h, { issues: [issue(101)] })
	assert.equal(h.spawnCalls.length, 1, "no retry by default")
	assert.equal(r2.sweeps[0].skipped, 1)

	// --retry-failed: the failed issue is retried and succeeds this time.
	const r3 = await runWatch(h, { issues: [issue(101)], retryFailed: true })
	assert.equal(h.spawnCalls.length, 2, "retry forced by --retry-failed")
	assert.equal(r3.sweeps[0].spawned, 1)
	state = await loadWatcherState(h.stateFile)
	assert.equal(state.processed["101"]?.status, "done")
}

// ─── Scenario E: dry-run does not spawn or write state ──────────────────────

async function testScenarioE(): Promise<void> {
	const h = await newHarness()
	const r = await runWatch(h, { issues: [issue(101), issue(102)], dryRun: true })
	assert.equal(h.spawnCalls.length, 0, "dry-run never spawns")
	assert.equal(r.spawned, 0)
	assert.equal(r.exitCode, 0)
	const plan = r.sweeps[0].dryRunPlan ?? []
	assert.equal(plan.length, 2, "dry-run reports every new issue")
	assert.equal(plan[0].issue.number, 101)
	assert.equal(plan[0].specs[0].taskFile, "w1-issue101.md")
	// No state file was written.
	await assert.rejects(() => fs.access(h.stateFile), (err) => (err as NodeJS.ErrnoException).code === "ENOENT")
}

// ─── Scenario F: continuous mode stops cleanly on AbortSignal ───────────────

async function testScenarioF(): Promise<void> {
	const h = await newHarness()
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 150)
	try {
		const result = await watchIssues({
			owner: "o",
			repo: "r",
			targetLabel: "needs-agent",
			token: "test-token",
			stateFile: h.stateFile,
			repoRoot: h.repoRoot,
			runOnce: false,
			pollIntervalMs: 20,
			logger: SILENT,
			signal: controller.signal,
			gh: {
				listIssues: async () => [issue(101)],
				getIssue: async () => {
					throw new Error("unexpected")
				},
				addLabel: async () => {
					throw new Error("unexpected")
				},
			},
			spawn: async (batch) => {
				h.spawnCalls.push({ batch, sawWriteAheadEntry: true })
				return { ok: true, status: 0 }
			},
		})
		assert.ok(result.sweeps.length >= 1, "at least one sweep ran before abort")
		assert.equal(result.spawned, 1, "spawned exactly once despite multiple sweeps (idempotent)")
	} finally {
		clearTimeout(timer)
	}
}

// ─── Write-ahead ordering: entry visible to the spawn step ──────────────────

async function testWriteAheadOrdering(): Promise<void> {
	const h = await newHarness()
	await runWatch(h, { issues: [issue(101)] })
	assert.equal(h.spawnCalls.length, 1)
	assert.equal(
		h.spawnCalls[0].sawWriteAheadEntry,
		true,
		"the durable state already had status 'spawned' when the spawn step ran",
	)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["A: new labeled issue -> spawn once, entry done, runOnce exits", testScenarioA],
	["B: same issue next sweep -> skipped (idempotent across restarts)", testScenarioB],
	["C: maxPerSweep cap defers to pending, spawned next sweep", testScenarioC],
	["D: spawn failure -> failed, no auto-retry; --retry-failed forces retry", testScenarioD],
	["E: dry-run does not spawn or write state", testScenarioE],
	["F: continuous mode stops cleanly on AbortSignal", testScenarioF],
	["write-ahead: spawned entry durable before the spawn step", testWriteAheadOrdering],
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
	console.log(`\nAll ${tests.length} watcher tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
