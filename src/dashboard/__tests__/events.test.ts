/**
 * Unit tests for src/dashboard/aggregate.ts's `readSessionEvents` — the
 * incremental per-session event-feed reader behind `GET /api/session/:id/events`.
 * Plain assert-based script (no test framework, no HTTP server), run via
 * `npm test` -> `tsx src/dashboard/__tests__/events.test.ts`.
 *
 * Uses fixture `.jsonl` event files written to a real temp dir (matches the
 * project's other fixture-based tests).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { readSessionEvents, findSessionEventsFile } from "../aggregate.js"
import { eventsFilePath } from "../../engine/events.js"

async function tmpRepo(prefix = "hc-dash-events-"): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function event(type: string, ts: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ ts, sessionId: "session-1", type, ...extra })
}

/** Write a fixture events file with the given JSON lines. */
async function writeEventsFile(repo: string, sessionId: string, lines: string[]): Promise<string> {
	const file = eventsFilePath(repo, sessionId)
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, lines.join("\n") + "\n", "utf-8")
	return file
}

// ─── readSessionEvents: full read ───────────────────────────────────────────

async function testReadsAllEventsFromRepoRoot(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const file = await writeEventsFile(repo, "session-1", [
			event("session_start", "2026-08-01T00:00:00.000Z", { mode: "code" }),
			event("tool_call", "2026-08-01T00:00:01.000Z", { tool: "read_file", args: "a.txt" }),
			event("session_end", "2026-08-01T00:00:02.000Z", { status: "success" }),
		])

		const result = await readSessionEvents(repo, "session-1")
		assert.equal(result.events.length, 3)
		assert.equal(result.events[0].type, "session_start")
		assert.equal(result.events[1].type, "tool_call")
		assert.equal(result.events[2].type, "session_end")
		assert.equal(result.events[1].tool, "read_file")
		// nextOffset is the byte length of the whole file (all lines consumed).
		const raw = await fs.readFile(file, "utf-8")
		assert.equal(result.nextOffset, Buffer.byteLength(raw))
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testReadsFromWorktreeWhenNotInRepoRoot(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const file = await writeEventsFile(path.join(repo, ".worktrees", "w1"), "worker-session", [
			event("session_start", "2026-08-01T00:00:00.000Z"),
		])
		// A DIFFERENT session in the repo root must not shadow the worktree one.
		await writeEventsFile(repo, "root-session", [event("session_start", "2026-08-01T00:00:00.000Z")])

		const result = await readSessionEvents(repo, "worker-session")
		assert.equal(result.events.length, 1)
		assert.equal(result.events[0].type, "session_start")
		const raw = await fs.readFile(file, "utf-8")
		assert.equal(result.nextOffset, Buffer.byteLength(raw))

		const found = await findSessionEventsFile(repo, "worker-session")
		assert.equal(found?.source, ".worktrees/w1")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── readSessionEvents: incremental (sinceOffset) ───────────────────────────

/**
 * The offset mechanism must actually work, not just run: write a few events,
 * read with sinceOffset=0, append MORE events to the file between the two
 * calls, then read with sinceOffset=the previous nextOffset — only the newly
 * appended events must come back.
 */
async function testIncrementalReadReturnsOnlyNewEvents(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const file = await writeEventsFile(repo, "session-1", [
			event("session_start", "2026-08-01T00:00:00.000Z"),
			event("iteration_start", "2026-08-01T00:00:01.000Z", { iteration: 1 }),
		])

		// First poll: everything so far.
		const first = await readSessionEvents(repo, "session-1")
		assert.equal(first.events.length, 2)
		assert.equal(first.events[0].type, "session_start")
		assert.ok(first.nextOffset > 0, "nextOffset must advance past the consumed bytes")

		// Append more events (a running session keeps writing).
		await fs.appendFile(
			file,
			event("tool_call", "2026-08-01T00:00:02.000Z", { tool: "write_to_file", args: "b.txt" }) + "\n" +
				event("tool_result", "2026-08-01T00:00:03.000Z", { tool: "write_to_file", isError: false }) + "\n",
			"utf-8",
		)

		// Second poll with the previous nextOffset: ONLY the new events.
		const second = await readSessionEvents(repo, "session-1", first.nextOffset)
		assert.equal(second.events.length, 2, "only newly-appended events should be returned")
		assert.equal(second.events[0].type, "tool_call")
		assert.equal(second.events[1].type, "tool_result")
		assert.equal(second.events[0].tool, "write_to_file")
		assert.ok(second.nextOffset > first.nextOffset, "nextOffset keeps advancing")

		// Third poll: nothing new.
		const third = await readSessionEvents(repo, "session-1", second.nextOffset)
		assert.equal(third.events.length, 0)
		assert.equal(third.nextOffset, second.nextOffset)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

/**
 * Malformed / partially-written trailing lines (a worker mid-append) are
 * skipped by readEventsFile's loose validation — never thrown.
 */
async function testMalformedLinesSkipped(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeEventsFile(repo, "session-1", [
			event("session_start", "2026-08-01T00:00:00.000Z"),
			"not json at all",
			'{"ts": "2026-08-01T00:00:01.000Z"}', // missing type
			event("tool_call", "2026-08-01T00:00:02.000Z", { tool: "read_file" }),
		])

		const result = await readSessionEvents(repo, "session-1")
		assert.equal(result.events.length, 2, "only well-formed lines with ts/sessionId/type survive")
		assert.equal(result.events[0].type, "session_start")
		assert.equal(result.events[1].type, "tool_call")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── readSessionEvents: missing feed / offsets past EOF ─────────────────────

async function testMissingFeedYieldsEmpty(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const result = await readSessionEvents(repo, "no-such-session")
		assert.deepEqual(result.events, [])
		assert.equal(result.nextOffset, 0)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testOffsetBeyondEOFClampsToFileEnd(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const file = await writeEventsFile(repo, "session-1", [
			event("session_start", "2026-08-01T00:00:00.000Z"),
		])
		const raw = await fs.readFile(file, "utf-8")
		const hugeOffset = Buffer.byteLength(raw) + 9999

		const result = await readSessionEvents(repo, "session-1", hugeOffset)
		assert.equal(result.events.length, 0, "an offset past EOF yields no events (clamped)")
		assert.equal(result.nextOffset, Buffer.byteLength(raw), "nextOffset clamps to the actual file size")
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["readSessionEvents: reads the full feed from the repo root's events dir", testReadsAllEventsFromRepoRoot],
	["readSessionEvents: finds + reads a worktree session's feed (dual search)", testReadsFromWorktreeWhenNotInRepoRoot],
	["readSessionEvents: incremental sinceOffset returns ONLY newly-appended events", testIncrementalReadReturnsOnlyNewEvents],
	["readSessionEvents: malformed/partial lines are skipped, not thrown", testMalformedLinesSkipped],
	["readSessionEvents: missing feed -> empty result, nextOffset 0", testMissingFeedYieldsEmpty],
	["readSessionEvents: offset beyond EOF clamps to the file size", testOffsetBeyondEOFClampsToFileEnd],
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
	console.log(`\nAll ${tests.length} dashboard events tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
