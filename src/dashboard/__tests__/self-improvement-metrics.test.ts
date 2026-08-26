/**
 * Unit tests for src/dashboard/self-improvement-metrics.ts (issue #145).
 * Plain assert-based script (no test framework, no network for the pure
 * functions), run via `npm test` -> `tsx src/dashboard/__tests__/self-improvement-metrics.test.ts`.
 *
 * computeSessionOutcomesByHour/computeIterationEfficiencyByHour/
 * computeSessionVolumeByHour are pure (SessionRow[] in, buckets out) and
 * tested with in-memory fixtures. computeStandingGuardrails shells out to
 * `git log` — tested against a REAL temp git repo with crafted commits
 * (mirrors this project's other git-fixture tests, e.g.
 * src/tools/__tests__/run-tests.test.ts's git-status test). computeIssueLifecycle
 * shells out to `gh issue list` (real network) — only its graceful-
 * degradation path (non-git directory -> undefined, never throws) is
 * tested here, not the success path.
 */

import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"

import {
	computeIssueLifecycle,
	computeIterationEfficiencyByHour,
	computeSessionOutcomesByHour,
	computeSessionVolumeByHour,
	computeStandingGuardrails,
	extractIssueRefs,
} from "../self-improvement-metrics.js"
import type { SessionRow } from "../aggregate.js"

const execFileP = promisify(execFile)

function row(overrides: Partial<SessionRow> = {}): SessionRow {
	return {
		sessionId: "s1",
		mode: "code",
		model: "qwen3-14b:latest",
		iterations: 5,
		inputTokens: 100,
		outputTokens: 50,
		cachedTokens: 0,
		costUsd: 0,
		startedAt: "2026-08-21T22:00:00.000Z",
		endedAt: "2026-08-21T22:01:00.000Z",
		status: "success",
		workspaceRoot: "/tmp/x",
		source: ".",
		...overrides,
	}
}

// ─── extractIssueRefs ─────────────────────────────────────────────────────────

async function testExtractIssueRefsFindsAllUniqueRefs(): Promise<void> {
	assert.deepEqual(extractIssueRefs("fix(engine): repeated-tool-failure guardrail (#146)"), [146])
	assert.deepEqual(extractIssueRefs("no issue reference here"), [])
	assert.deepEqual(extractIssueRefs("fixes #1 and also #2, related to #1 again"), [1, 2])
}

// ─── computeSessionOutcomesByHour ─────────────────────────────────────────────

async function testSessionOutcomesByHourBucketsCorrectly(): Promise<void> {
	const sessions: SessionRow[] = [
		row({ startedAt: "2026-08-21T22:05:00.000Z", status: "success" }),
		row({ startedAt: "2026-08-21T22:40:00.000Z", status: "success" }),
		row({ startedAt: "2026-08-21T22:59:00.000Z", status: "error" }),
		row({ startedAt: "2026-08-21T23:01:00.000Z", status: "budget" }),
	]
	const buckets = computeSessionOutcomesByHour(sessions)
	assert.equal(buckets.length, 2, "two distinct hour buckets")
	assert.deepEqual(buckets[0], {
		hour: "2026-08-21T22:00:00.000Z",
		success: 2,
		error: 1,
		budget: 0,
		total: 3,
		successRate: 2 / 3,
	})
	assert.deepEqual(buckets[1], {
		hour: "2026-08-21T23:00:00.000Z",
		success: 0,
		error: 0,
		budget: 1,
		total: 1,
		successRate: 0,
	})
}

async function testSessionOutcomesByHourEmptyInput(): Promise<void> {
	assert.deepEqual(computeSessionOutcomesByHour([]), [])
}

// ─── computeIterationEfficiencyByHour ─────────────────────────────────────────

async function testIterationEfficiencyOnlyCountsSuccesses(): Promise<void> {
	const sessions: SessionRow[] = [
		row({ startedAt: "2026-08-21T22:05:00.000Z", status: "success", iterations: 10 }),
		row({ startedAt: "2026-08-21T22:10:00.000Z", status: "success", iterations: 4 }),
		row({ startedAt: "2026-08-21T22:15:00.000Z", status: "error", iterations: 20 }),
	]
	const buckets = computeIterationEfficiencyByHour(sessions)
	assert.equal(buckets.length, 1)
	assert.equal(buckets[0].successCount, 2, "the error session must not count")
	assert.equal(buckets[0].meanIterations, 7, "(10 + 4) / 2 = 7, the 20-iteration error must not skew this")
}

// ─── computeSessionVolumeByHour ───────────────────────────────────────────────

async function testSessionVolumeCountsAllStatuses(): Promise<void> {
	const sessions: SessionRow[] = [
		row({ startedAt: "2026-08-21T22:05:00.000Z", status: "success" }),
		row({ startedAt: "2026-08-21T22:50:00.000Z", status: "error" }),
		row({ startedAt: "2026-08-21T23:05:00.000Z", status: "budget" }),
	]
	const buckets = computeSessionVolumeByHour(sessions)
	assert.deepEqual(
		buckets.map((b) => [b.hour, b.count]),
		[
			["2026-08-21T22:00:00.000Z", 2],
			["2026-08-21T23:00:00.000Z", 1],
		],
	)
}

// ─── computeStandingGuardrails (real git log against a real temp repo) ────────

async function testStandingGuardrailsCountsCommitsReferencingIssues(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-guardrails-"))
	try {
		await execFileP("git", ["init", "-q"], { cwd: repo })
		await execFileP("git", ["config", "user.email", "test@example.com"], { cwd: repo })
		await execFileP("git", ["config", "user.name", "Test"], { cwd: repo })

		await fs.writeFile(path.join(repo, "a.txt"), "1\n")
		await execFileP("git", ["add", "a.txt"], { cwd: repo })
		await execFileP("git", ["commit", "-q", "-m", "chore: unrelated setup commit"], { cwd: repo })

		await fs.writeFile(path.join(repo, "a.txt"), "2\n")
		await execFileP("git", ["add", "a.txt"], { cwd: repo })
		await execFileP("git", ["commit", "-q", "-m", "fix(engine): real guardrail fix (#146)"], { cwd: repo })

		await fs.writeFile(path.join(repo, "a.txt"), "3\n")
		await execFileP("git", ["add", "a.txt"], { cwd: repo })
		await execFileP("git", ["commit", "-q", "-m", "fix(cli): another real fix (#150)"], { cwd: repo })

		const result = await computeStandingGuardrails(repo)
		assert.equal(result.totalCount, 2, "only the 2 commits referencing a real issue count, not the unrelated one")
		assert.deepEqual(
			result.commits.map((c) => c.issueRefs).flat(),
			[146, 150],
		)
		assert.ok(result.cumulativeByHour.length >= 1, "at least one cumulative bucket")
		const lastCumulative = result.cumulativeByHour[result.cumulativeByHour.length - 1].cumulative
		assert.equal(lastCumulative, 2, "cumulative count must reach the total by the last bucket")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testStandingGuardrailsHandlesNonGitDirectory(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-guardrails-nogit-"))
	try {
		const result = await computeStandingGuardrails(dir)
		assert.deepEqual(result, { commits: [], cumulativeByHour: [], totalCount: 0 })
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

// ─── computeIssueLifecycle graceful degradation ───────────────────────────────

async function testIssueLifecycleDegradesGracefullyWithoutGhRemote(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hc-lifecycle-nogh-"))
	try {
		// A real git repo but with no GitHub remote at all — `gh issue list`
		// must fail cleanly here, and this function must return undefined,
		// never throw.
		await execFileP("git", ["init", "-q"], { cwd: dir })
		const result = await computeIssueLifecycle(dir)
		assert.equal(result, undefined, "no GitHub remote -> undefined, not a thrown error")
	} finally {
		await fs.rm(dir, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["extractIssueRefs: finds all unique issue numbers referenced", testExtractIssueRefsFindsAllUniqueRefs],
	["computeSessionOutcomesByHour: buckets by hour, splits success/error/budget", testSessionOutcomesByHourBucketsCorrectly],
	["computeSessionOutcomesByHour: empty input -> empty output", testSessionOutcomesByHourEmptyInput],
	["computeIterationEfficiencyByHour: only successful sessions count toward the mean", testIterationEfficiencyOnlyCountsSuccesses],
	["computeSessionVolumeByHour: counts sessions of every status", testSessionVolumeCountsAllStatuses],
	["computeStandingGuardrails: counts real commits referencing real issues (real git repo)", testStandingGuardrailsCountsCommitsReferencingIssues],
	["computeStandingGuardrails: a non-git directory degrades to zero, never throws", testStandingGuardrailsHandlesNonGitDirectory],
	["computeIssueLifecycle: a repo with no GitHub remote degrades to undefined, never throws", testIssueLifecycleDegradesGracefullyWithoutGhRemote],
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
	console.log(`\nAll ${tests.length} self-improvement-metrics tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
