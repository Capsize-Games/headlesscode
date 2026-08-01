/**
 * Tests for src/dashboard/server.ts — the HTTP layer: live session events
 * (Phase 1/2) + pause/resume control endpoints (Phase 3). Plain assert-based
 * script (no test framework), run via `npm test` ->
 * `tsx src/dashboard/__tests__/server.test.ts`.
 *
 * Spins up a real dashboard server on an ephemeral port against a temp repo
 * with fixture events + usage files, then drives it with fetch (Node >= 18).
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { startDashboardServer } from "../server.js"
import type { Server } from "node:http"
import { eventsFilePath } from "../../engine/events.js"

async function tmpRepo(prefix = "hc-server-"): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function startServer(repo: string): Promise<{ server: Server; port: number }> {
	const server = await startDashboardServer({ port: 0, repo })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	return { server, port }
}

async function writeEventFile(repo: string, sessionId: string, lines: string[]): Promise<void> {
	const file = eventsFilePath(repo, sessionId)
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, lines.join("\n") + "\n", "utf-8")
}

function event(type: string, ts: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ ts, sessionId: "session-1", type, ...extra })
}

async function getJson(base: string, urlPath: string): Promise<{ status: number; body: unknown }> {
	const res = await fetch(base + urlPath)
	const text = await res.text()
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: res.status, body }
}

// ─── GET /api/session/:id/events ────────────────────────────────────────────

async function testEventsEndpointReturnsFeedWithNextOffset(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeEventFile(repo, "session-1", [
			event("session_start", "2026-08-01T00:00:00.000Z"),
			event("tool_call", "2026-08-01T00:00:01.000Z", { tool: "read_file" }),
		])
		const { server, port } = await startServer(repo)
		try {
			const { status, body } = await getJson(`http://127.0.0.1:${port}`, "/api/session/session-1/events")
			assert.equal(status, 200)
			const data = body as { events: Array<{ type: string }>; nextOffset: number; sessionId: string }
			assert.equal(data.sessionId, "session-1")
			assert.equal(data.events.length, 2)
			assert.equal(data.events[0].type, "session_start")
			assert.equal(data.events[1].type, "tool_call")
			assert.ok(data.nextOffset > 0)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testEventsEndpointIncrementalSince(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const file = eventsFilePath(repo, "session-1")
		await writeEventFile(repo, "session-1", [event("session_start", "2026-08-01T00:00:00.000Z")])
		const { server, port } = await startServer(repo)
		try {
			const base = `http://127.0.0.1:${port}`
			const first = (await getJson(base, "/api/session/session-1/events")).body as { nextOffset: number }
			// Append a new event mid-poll (a live worker keeps writing).
			await fs.appendFile(file, event("tool_call", "2026-08-01T00:00:01.000Z", { tool: "write_to_file" }) + "\n", "utf-8")
			const second = (await getJson(base, `/api/session/session-1/events?since=${first.nextOffset}`)).body as {
				events: Array<{ type: string }>
			}
			assert.equal(second.events.length, 1)
			assert.equal(second.events[0].type, "tool_call")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testEventsEndpointMissingRepoParam(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// A server started WITHOUT --repo must require ?repo=<path>.
		const server = await startDashboardServer({ port: 0 })
		const addr = server.address()
		const port = typeof addr === "object" && addr ? addr.port : 0
		try {
			const { status } = await getJson(`http://127.0.0.1:${port}`, "/api/session/session-1/events")
			assert.equal(status, 400)
			// With ?repo= it works.
			const ok = await getJson(`http://127.0.0.1:${port}`, `/api/session/session-1/events?repo=${encodeURIComponent(repo)}`)
			assert.equal(ok.status, 200)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testEventsEndpointMissingSessionIsEmpty(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			const { status, body } = await getJson(`http://127.0.0.1:${port}`, "/api/session/nope/events")
			assert.equal(status, 200)
			assert.deepEqual((body as { events: unknown[] }).events, [])
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── POST /api/session/:id/pause|resume (Phase 3) ───────────────────────────

async function testPauseResumeWriteRemoveMarker(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// Session lives in a worktree (the orchestrator case).
		const wtRoot = path.join(repo, ".worktrees", "w1")
		await writeEventFile(wtRoot, "worker-session", [event("session_start", "2026-08-01T00:00:00.000Z")])
		const { server, port } = await startServer(repo)
		const base = `http://127.0.0.1:${port}`
		try {
			// Pause: writes .harness.pause-requested in the worktree.
			const pauseRes = await fetch(base + "/api/session/worker-session/pause", { method: "POST" })
			assert.equal(pauseRes.status, 200)
			const pauseBody = (await pauseRes.json()) as { ok: boolean; worktree: string }
			assert.equal(pauseBody.ok, true)
			assert.equal(pauseBody.worktree, ".worktrees/w1")
			const marker = path.join(wtRoot, ".harness.pause-requested")
			await fs.access(marker)
			const raw = await fs.readFile(marker, "utf-8")
			assert.ok(!Number.isNaN(Date.parse(raw.trim())), "marker holds an ISO timestamp")

			// Resume: removes it.
			const resumeRes = await fetch(base + "/api/session/worker-session/resume", { method: "POST" })
			assert.equal(resumeRes.status, 200)
			await assert.rejects(fs.access(marker), "pause marker must be removed on resume")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testPauseUnknownSessionIs404(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/session/ghost/pause`, { method: "POST" })
			assert.equal(res.status, 404)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

/**
 * Non-GET / non-POST methods to unrelated routes are still rejected: the
 * pause/resume POST routes are the ONLY non-GET routes the server accepts.
 */
async function testNonGetPostMethodsStillRejected(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await writeEventFile(repo, "session-1", [event("session_start", "2026-08-01T00:00:00.000Z")])
		const { server, port } = await startServer(repo)
		const base = `http://127.0.0.1:${port}`
		try {
			// DELETE to the summary route -> 405.
			const del = await fetch(base + "/api/summary", { method: "DELETE" })
			assert.equal(del.status, 405)
			// PUT to the root -> 405.
			const put = await fetch(base + "/", { method: "PUT" })
			assert.equal(put.status, 405)
			// PATCH to the events route -> 405 (only GET is allowed there).
			const patch = await fetch(base + "/api/session/session-1/events", { method: "PATCH" })
			assert.equal(patch.status, 405)
			// GET to the pause route -> 405 (pause is POST-only — a GET must
			// never trigger a state change).
			const getPause = await fetch(base + "/api/session/session-1/pause")
			assert.equal(getPause.status, 405)
			// POST to an unrelated route -> 405.
			const postOther = await fetch(base + "/api/other", { method: "POST" })
			assert.equal(postOther.status, 405)
			// A still-valid GET still works.
			const ok = await getJson(base, "/api/session/session-1/events")
			assert.equal(ok.status, 200)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["server: GET /api/session/:id/events returns the feed + nextOffset", testEventsEndpointReturnsFeedWithNextOffset],
	["server: events endpoint is incremental via ?since=<offset>", testEventsEndpointIncrementalSince],
	["server: events endpoint requires repo (param or --repo)", testEventsEndpointMissingRepoParam],
	["server: events endpoint for an unknown session -> empty feed, 200", testEventsEndpointMissingSessionIsEmpty],
	["server: POST pause/resume write/remove .harness.pause-requested in the worktree", testPauseResumeWriteRemoveMarker],
	["server: POST pause for an unknown session -> 404", testPauseUnknownSessionIs404],
	["server: non-GET/non-POST methods to unrelated routes are still rejected (405)", testNonGetPostMethodsStillRejected],
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
	console.log(`\nAll ${tests.length} dashboard server tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
