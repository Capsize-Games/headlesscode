/**
 * Unit tests for src/budget/concurrency.ts — the in-process ConcurrencyLimiter,
 * the cross-process activeSessionCount from durable state files, and the
 * watcher's global-cap interplay (3 issues, cap 2 -> 2 spawned, 1 pending).
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` → `tsx src/budget/__tests__/concurrency.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { Logger } from "../../engine/logger.js"
import {
	activeSessionCount,
	activeSessionCountForRepo,
	ConcurrencyLimiter,
	DEFAULT_MAX_CONCURRENT_SESSIONS,
	maxConcurrentSessionsFromEnv,
} from "../concurrency.js"
import { saveState, type OrchestratorGroup, type OrchestratorState } from "../../orchestrator/state.js"
import { saveWatcherState, type WatcherState } from "../../watcher/state.js"
import { watchIssues, type SpawnBatch, type WatcherConfig } from "../../watcher/watch.js"
import { loadWatcherState } from "../../watcher/state.js"
import type { GhClient, GitHubIssue } from "../../watcher/github.js"

const SILENT = new Logger({ level: "silent" })

// ─── ConcurrencyLimiter ──────────────────────────────────────────────────────

async function testLimiterAcquireReleaseCap(): Promise<void> {
	const limiter = new ConcurrencyLimiter(2)
	assert.equal(limiter.maxSessions, 2)
	assert.equal(limiter.current(), 0)

	assert.deepEqual(limiter.acquire(), { ok: true })
	assert.deepEqual(limiter.acquire(), { ok: true })
	assert.equal(limiter.current(), 2)

	// Third acquire fails fast with a clear reason (never queues).
	const denied = limiter.acquire()
	assert.equal(denied.ok, false)
	assert.match(denied.reason ?? "", /concurrency cap reached/)

	// Release frees a slot; acquire succeeds again.
	limiter.release()
	assert.equal(limiter.current(), 1)
	assert.equal(limiter.acquire().ok, true)

	// Release never goes below 0.
	limiter.release()
	limiter.release()
	limiter.release()
	assert.equal(limiter.current(), 0)

	// Invalid caps are rejected at construction.
	assert.throws(() => new ConcurrencyLimiter(0), /positive integer/)
	assert.throws(() => new ConcurrencyLimiter(2.5), /positive integer/)
}

async function testMaxConcurrentSessionsFromEnv(): Promise<void> {
	const saved = process.env.HEADLESSCODE_MAX_CONCURRENT_SESSIONS
	try {
		delete process.env.HEADLESSCODE_MAX_CONCURRENT_SESSIONS
		assert.equal(maxConcurrentSessionsFromEnv(), DEFAULT_MAX_CONCURRENT_SESSIONS)
		process.env.HEADLESSCODE_MAX_CONCURRENT_SESSIONS = "7"
		assert.equal(maxConcurrentSessionsFromEnv(), 7)
		process.env.HEADLESSCODE_MAX_CONCURRENT_SESSIONS = "garbage"
		assert.equal(maxConcurrentSessionsFromEnv(), DEFAULT_MAX_CONCURRENT_SESSIONS, "invalid falls back to default")
	} finally {
		if (saved === undefined) {
			delete process.env.HEADLESSCODE_MAX_CONCURRENT_SESSIONS
		} else {
			process.env.HEADLESSCODE_MAX_CONCURRENT_SESSIONS = saved
		}
	}
}

// ─── activeSessionCount from durable state fixtures ─────────────────────────

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-concurrency-repo-"))
}

function group(name: string, status: string): OrchestratorGroup {
	return { name, status }
}

async function testActiveSessionCountFromStateFiles(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const orchState: OrchestratorState = {
			batch: "b",
			groups: [group("w1", "spawned"), group("w2", "running"), group("w3", "done"), group("w4", "failed"), group("w5", "spawned")],
		}
		const watcherState: WatcherState = {
			processed: {
				"101": { number: 101, title: "a", label: "needs-agent", status: "spawned", updatedAt: "t" },
				"102": { number: 102, title: "b", label: "needs-agent", status: "done", updatedAt: "t" },
				"103": { number: 103, title: "c", label: "needs-agent", status: "pending", updatedAt: "t" },
			},
		}

		// Direct function: orchestrator spawned/running only.
		assert.equal(activeSessionCount(orchState, null), 3, "spawned x2 + running x1 = 3")
		// Watcher in-flight 'spawned' entries only.
		assert.equal(activeSessionCount(null, watcherState), 1, "watcher 'spawned' entries = 1 (pending is NOT active)")
		// Combined cross-process view.
		assert.equal(activeSessionCount(orchState, watcherState), 4)

		// From disk (both files under <repo>/.worktrees/).
		await fs.mkdir(path.join(repo, ".worktrees"), { recursive: true })
		await saveState(path.join(repo, ".worktrees", ".orchestrator-state.json"), orchState)
		await saveWatcherState(path.join(repo, ".worktrees", ".watcher-state.json"), watcherState)
		assert.equal(activeSessionCountForRepo(repo), 4)

		// Missing files -> 0 (tolerated).
		const empty = await tmpRepo()
		try {
			assert.equal(activeSessionCountForRepo(empty), 0)
		} finally {
			await fs.rm(empty, { recursive: true, force: true })
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Watcher global-cap interplay ────────────────────────────────────────────

function issue(number: number): GitHubIssue {
	return {
		number,
		title: `issue ${number}`,
		body: `body of ${number}`,
		labels: ["needs-agent"],
		updated_at: "2026-08-01T00:00:00Z",
		html_url: `https://github.com/o/r/issues/${number}`,
	}
}

interface Harness {
	repoRoot: string
	stateFile: string
	spawnCalls: Array<{ batch: SpawnBatch }>
}

async function newHarness(): Promise<Harness> {
	const repoRoot = await tmpRepo()
	return { repoRoot, stateFile: path.join(repoRoot, ".worktrees", ".watcher-state.json"), spawnCalls: [] }
}

async function runWatch(
	harness: Harness,
	options: { issues?: GitHubIssue[]; maxConcurrentSessions?: number; maxPerSweep?: number },
) {
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
		runOnce: true,
		maxPerSweep: options.maxPerSweep ?? 5,
		maxConcurrentSessions: options.maxConcurrentSessions,
		logger: SILENT,
		gh,
		spawn: async (batch) => {
			harness.spawnCalls.push({ batch })
			return { ok: true, status: 0 }
		},
	}
	return watchIssues(config)
}

async function testWatcherGlobalCap3IssuesCap2(): Promise<void> {
	const h = await newHarness()
	try {
		const result = await runWatch(h, {
			issues: [issue(201), issue(202), issue(203)],
			maxConcurrentSessions: 2,
		})
		assert.equal(h.spawnCalls.length, 2, "cap 2 -> exactly 2 spawned in the sweep")
		assert.equal(result.sweeps[0].spawned, 2)
		assert.equal(result.sweeps[0].deferred, 1, "third issue deferred by the global cap")

		const state = await loadWatcherState(h.stateFile)
		assert.equal(state.processed["201"]?.status, "done")
		assert.equal(state.processed["202"]?.status, "done")
		assert.equal(state.processed["203"]?.status, "pending", "cap-exceeding issue stays pending (not spawned)")
		assert.ok(result.exitCode === 0, "a deferred (not failed) sweep is not an error")
	} finally {
		await fs.rm(h.repoRoot, { recursive: true, force: true })
	}
}

async function testWatcherGlobalCapInterplayWithMaxPerSweep(): Promise<void> {
	// maxPerSweep=1 still bounds the burst per sweep: with cap 5, 3 issues ->
	// 1 spawned, 2 pending (the maxPerSweep behavior is unchanged).
	const h = await newHarness()
	try {
		const result = await runWatch(h, {
			issues: [issue(301), issue(302), issue(303)],
			maxConcurrentSessions: 5,
			maxPerSweep: 1,
		})
		assert.equal(h.spawnCalls.length, 1, "maxPerSweep=1 still bounds the sweep burst")
		assert.equal(result.sweeps[0].deferred, 2)
	} finally {
		await fs.rm(h.repoRoot, { recursive: true, force: true })
	}
}

async function testWatcherGlobalCapRespectsActiveFleet(): Promise<void> {
	// Pre-existing orchestrator state with 2 'running' groups + cap 2 ->
	// available = 0: ALL new issues stay pending (cross-process view).
	const h = await newHarness()
	try {
		await fs.mkdir(path.join(h.repoRoot, ".worktrees"), { recursive: true })
		await saveState(path.join(h.repoRoot, ".worktrees", ".orchestrator-state.json"), {
			batch: "b",
			groups: [group("running-1", "running"), group("running-2", "spawned")],
		})
		const result = await runWatch(h, {
			issues: [issue(401), issue(402), issue(403)],
			maxConcurrentSessions: 2,
		})
		assert.equal(h.spawnCalls.length, 0, "no spawns when the fleet is already at the cap")
		assert.equal(result.sweeps[0].spawned, 0)
		assert.equal(result.sweeps[0].deferred, 3)
		const state = await loadWatcherState(h.stateFile)
		assert.equal(state.processed["401"]?.status, "pending")
		assert.equal(state.processed["402"]?.status, "pending")
		assert.equal(state.processed["403"]?.status, "pending")
	} finally {
		await fs.rm(h.repoRoot, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["limiter: acquire/release/cap fail-fast + never-below-zero", testLimiterAcquireReleaseCap],
	["maxConcurrentSessionsFromEnv: flag env, invalid falls back", testMaxConcurrentSessionsFromEnv],
	["activeSessionCount: fixture state files (orchestrator + watcher, from disk)", testActiveSessionCountFromStateFiles],
	["watcher: 3 issues, cap 2 -> 2 spawned, 1 stays pending", testWatcherGlobalCap3IssuesCap2],
	["watcher: maxPerSweep still bounds bursts (interplay with the global cap)", testWatcherGlobalCapInterplayWithMaxPerSweep],
	["watcher: pre-existing running fleet at cap -> all new issues deferred", testWatcherGlobalCapRespectsActiveFleet],
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
	console.log(`\nAll ${tests.length} concurrency tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
