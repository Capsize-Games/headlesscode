/**
 * Tests for the browser control-plane launch + answer endpoints
 * (src/dashboard/session-launch.ts + the HTTP wrappers in server.ts):
 *
 *  1. POST /api/session/start spawns a DETACHED background process — the
 *     endpoint returns before the spawned process finishes (proving it's
 *     genuinely non-blocking), and a tiny fake script stands in for the real
 *     CLI so the test is fast and deterministic.
 *  2. A malformed body (missing task) is rejected clearly.
 *  3. POST /api/session/:id/answer writes the exact marker content a real
 *     `ask_followup_question` call waiting on it would accept — proven by a
 *     round-trip: write the answer via the endpoint, then run the existing
 *     decision-escalation logic (createHeadlessExecutor) against it and
 *     confirm it unblocks.
 *
 * Plain assert-based script (no test framework), run via `npm test` ->
 * `tsx src/dashboard/__tests__/session-launch.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { startDashboardServer } from "../server.js"
import type { Server } from "node:http"
import { createHeadlessExecutor } from "../../tools/executor.js"
import { eventsFilePath } from "../../engine/events.js"
import { DECISION_MARKERS, validateSessionStartBody } from "../session-launch.js"

async function tmpRepo(prefix = "hc-launch-"): Promise<string> {
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

async function postJson(
	base: string,
	urlPath: string,
	payload: unknown,
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(base + urlPath, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	})
	const text = await res.text()
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: res.status, body }
}

// ─── validateSessionStartBody (pure) ────────────────────────────────────────

async function testValidateBodyRejectsMalformed(): Promise<void> {
	assert.match(validateSessionStartBody(null) ?? "", /must be a JSON object/i)
	assert.match(validateSessionStartBody([]) ?? "", /must be a JSON object/i)
	assert.match(validateSessionStartBody({}) ?? "", /missing or empty 'task'/i)
	assert.match(validateSessionStartBody({ task: "   " }) ?? "", /missing or empty 'task'/i)
	assert.match(validateSessionStartBody({ task: "x", repo: 42 }) ?? "", /'repo' must be a non-empty string/i)
	assert.match(validateSessionStartBody({ task: "x", mode: "" }) ?? "", /'mode' must be a non-empty string/i)
	// Valid bodies pass.
	assert.equal(validateSessionStartBody({ task: "do the thing" }), undefined)
	assert.equal(validateSessionStartBody({ task: "x", repo: "/tmp/r", mode: "code" }), undefined)
}

// ─── POST /api/session/start (detached + validation) ───────────────────────

/**
 * The fake "CLI" script: writes its PID + a marker file, then sleeps briefly
 * before exiting. The test asserts the endpoint returned BEFORE the marker
 * file existed and the process was still running shortly after the response —
 * proving the endpoint truly detached (spawn + unref), not awaited.
 */
async function makeFakeCli(): Promise<{ dir: string; script: string; marker: string }> {
	const dir = await tmpRepo("hc-launch-fakecli-")
	const script = path.join(dir, "fake-cli.mjs")
	const marker = path.join(dir, "started.marker")
	await fs.writeFile(
		script,
		`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, process.pid.toString(), "utf-8");
await new Promise((r) => setTimeout(r, 5000));
`,
		"utf-8",
	)
	return { dir, script, marker }
}

async function testStartSpawnsDetachedProcess(): Promise<void> {
	const repo = await tmpRepo()
	const fake = await makeFakeCli()
	try {
		// Start the dashboard server with the fake CLI injected, so the HTTP
		// endpoint itself is what spawns (not a direct launchSession call).
		const server = await startDashboardServer({
			port: 0,
			repo,
			cli: `node ${fake.script}`,
			repoRoot: fake.dir,
		})
		const addr = server.address()
		const port = typeof addr === "object" && addr ? addr.port : 0
		const base = `http://127.0.0.1:${port}`
		try {
			const start = Date.now()
			const res = await postJson(base, "/api/session/start", { task: "hello", mode: "code" })
			const elapsed = Date.now() - start
			// The fake sleeps 5s — the endpoint MUST have returned way earlier
			// (proving it's genuinely detached/non-blocking, not awaited).
			assert.ok(elapsed < 3000, `launch must be non-blocking (took ${elapsed}ms)`)
			assert.equal(res.status, 200)
			const launched = res.body as { sessionId: string; pid: number; mode: string }
			assert.ok(launched.sessionId && launched.sessionId.length > 0, "sessionId must be returned")
			assert.equal(launched.mode, "code")

			// The child really is running detached: give it a moment, then
			// assert its marker file exists and the PID is alive.
			await sleep(300)
			const pidRaw = await fs.readFile(fake.marker, "utf-8")
			const pid = Number(pidRaw)
			assert.ok(Number.isInteger(pid) && pid > 0, `expected a real child pid, got ${pidRaw}`)
			// The process must still be alive after the endpoint returned (it
			// sleeps 5s) — i.e. NOT reaped when the request resolved.
			let alive = true
			try {
				process.kill(pid, 0)
			} catch {
				alive = false
			}
			assert.ok(alive, "spawned session must still be running after the request resolved (detached)")

			// It also must be a DIFFERENT process from the test runner.
			assert.notEqual(pid, process.pid)
		} finally {
			server.close()
		}
	} finally {
		// Clean up the spawned child (it may still be sleeping).
		try {
			const pidRaw = await fs.readFile(fake.marker, "utf-8")
			process.kill(Number(pidRaw), "SIGKILL")
		} catch {
			// already gone
		}
		await fs.rm(fake.dir, { recursive: true, force: true })
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testStartHttpEndpointValidatesAndSpawns(): Promise<void> {
	const repo = await tmpRepo()
	const fake = await makeFakeCli()
	try {
		const server = await startDashboardServer({
			port: 0,
			repo,
			cli: `node ${fake.script}`,
			repoRoot: fake.dir,
		})
		const addr = server.address()
		const port = typeof addr === "object" && addr ? addr.port : 0
		const base = `http://127.0.0.1:${port}`
		try {
			// Missing task -> clear 400, nothing spawned.
			const bad = await postJson(base, "/api/session/start", { mode: "code" })
			assert.equal(bad.status, 400)
			assert.match(String((bad.body as { error?: string }).error ?? ""), /missing or empty 'task'/i)

			// Invalid JSON body -> 400.
			const badJsonRes = await fetch(base + "/api/session/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{ not json",
			})
			assert.equal(badJsonRes.status, 400)

			// GET to the launch route -> 405 (a GET must never trigger a launch).
			const getStart = await fetch(base + "/api/session/start")
			assert.equal(getStart.status, 405)

			// Valid -> 200 with a sessionId + pid, and the fake's marker file
			// gets written (proving the child really was spawned).
			const ok = await postJson(base, "/api/session/start", { task: "do work", mode: "code" })
			assert.equal(ok.status, 200)
			const body = ok.body as { sessionId: string; pid: number }
			assert.ok(typeof body.sessionId === "string" && body.sessionId.length > 0)
			assert.ok(Number.isInteger(body.pid) && body.pid > 0)
			await sleep(300)
			await fs.access(fake.marker)
		} finally {
			server.close()
		}
	} finally {
		try {
			const pidRaw = await fs.readFile(fake.marker, "utf-8")
			process.kill(Number(pidRaw), "SIGKILL")
		} catch {
			// already gone
		}
		await fs.rm(fake.dir, { recursive: true, force: true })
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── POST /api/session/:id/answer (round-trip with real escalation) ────────

async function testAnswerRoundTripUnblocksRealEscalation(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// A session whose events feed exists in a WORKTREE (the orchestrator
		// case) — the answer must land in the worktree root, not the repo root.
		const wtRoot = path.join(repo, ".worktrees", "w1")
		await writeEventFile(wtRoot, "worker-session", [
			event("session_start", "2026-08-01T00:00:00.000Z"),
			event("decision_blocked", "2026-08-01T00:00:05.000Z", { question: "Which config file should I edit?" }),
		])

		const { server, port } = await startServer(repo)
		const base = `http://127.0.0.1:${port}`
		try {
			// 1. Start a REAL ask_followup_question escalation against the
			//    worktree (the existing decision-escalation logic from
			//    src/tools/executor.ts — short poll so the test is fast).
			const executor = createHeadlessExecutor(wtRoot, {
				decisionTimeoutMs: 10_000,
				decisionPollIntervalMs: 25,
			})
			const execPromise = executor.execute("ask_followup_question", {
				question: "Which config file should I edit?",
				follow_up: [{ text: "./src/frontend-config.json", mode: null }],
			})

			// Give the handler a moment to write .harness.needs-decision.
			await sleep(80)
			await fs.access(path.join(wtRoot, DECISION_MARKERS.needsDecision))

			// 2. Answer via the HTTP endpoint (POST /api/session/:id/answer).
			const res = await postJson(base, "/api/session/worker-session/answer", {
				answer: "Use ./src/frontend-config.json",
			})
			assert.equal(res.status, 200)
			assert.equal((res.body as { ok: boolean }).ok, true)

			// 3. The escalation must unblock with the answer as a NON-error
			//    result — proving the endpoint writes exactly what a real
			//    ask_followup_question accepts.
			const result = await execPromise
			assert.equal(result.isError, false, "a real answer must be a NON-error tool result")
			assert.match(result.content, /Use \.\/src\/frontend-config\.json/)
			assert.equal((res.body as { worktree: string }).worktree, ".worktrees/w1")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testAnswerValidatesAndRejectsUnknown(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const { server, port } = await startServer(repo)
		const base = `http://127.0.0.1:${port}`
		try {
			// Unknown session -> 404.
			const unknown = await postJson(base, "/api/session/ghost/answer", { answer: "x" })
			assert.equal(unknown.status, 404)

			// Known session but missing/empty answer -> 400.
			await writeEventFile(repo, "s1", [event("session_start", "2026-08-01T00:00:00.000Z")])
			const noAnswer = await postJson(base, "/api/session/s1/answer", {})
			assert.equal(noAnswer.status, 400)
			assert.match(String((noAnswer.body as { error?: string }).error ?? ""), /missing or empty 'answer'/i)

			// GET (not POST) -> 405.
			const getRes = await fetch(base + "/api/session/s1/answer")
			assert.equal(getRes.status, 405)

			// Invalid JSON -> 400.
			const badJsonRes = await fetch(base + "/api/session/s1/answer", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{ not json",
			})
			assert.equal(badJsonRes.status, 400)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// GET to the launch route must be 405 — a GET must never trigger a launch.
// ─── GET /api/modes (mode selector) ─────────────────────────────────────────

async function testModesEndpointReturnsMergedModes(): Promise<void> {
	const repo = await tmpRepo()
	try {
		// A project .roomodes with one custom mode (mirrors the fixture shape).
		await fs.mkdir(path.join(repo, ".roo"), { recursive: true })
		await fs.writeFile(
			path.join(repo, ".roomodes"),
			"customModes:\n  - slug: issue-fixer\n    name: Issue Fixer\n    description: fix it\n    roleDefinition: you fix issues\n    groups:\n      - read\n      - edit\n      - command\n",
			"utf-8",
		)
		const { server, port } = await startServer(repo)
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/modes`)
			assert.equal(res.status, 200)
			const body = (await res.json()) as { modes: Array<{ slug: string }> }
			const slugs = body.modes.map((m) => m.slug)
			// The project's own mode is present.
			assert.ok(slugs.includes("issue-fixer"), "project .roomodes mode must appear")
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testModesEndpointRequiresRepo(): Promise<void> {
	const server = await startDashboardServer({ port: 0 })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/modes`)
		assert.equal(res.status, 400)
	} finally {
		server.close()
	}
}

// ─── Optional bearer token hook ─────────────────────────────────────────────

async function testTokenGatesControlPlanePosts(): Promise<void> {
	const repo = await tmpRepo()
	try {
		const server = await startDashboardServer({ port: 0, repo, token: "sekret" })
		const addr = server.address()
		const port = typeof addr === "object" && addr ? addr.port : 0
		const base = `http://127.0.0.1:${port}`
		try {
			// Without the header -> 401.
			const noAuth = await postJson(base, "/api/session/start", { task: "x" })
			assert.equal(noAuth.status, 401)

			// With the wrong token -> 401.
			const badAuth = await fetch(base + "/api/session/start", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer wrong" },
				body: JSON.stringify({ task: "x" }),
			})
			assert.equal(badAuth.status, 401)

			// With the right token -> passes validation (200, missing task
			// would be a 400 — meaning the token gate let it through).
			const goodAuth = await fetch(base + "/api/session/start", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer sekret" },
				body: JSON.stringify({ task: "x" }),
			})
			assert.equal(goodAuth.status, 200)

			// GETs are unaffected (read-only stays open).
			const getEvents = await fetch(base + "/api/session/nope/events")
			assert.equal(getEvents.status, 200)
		} finally {
			server.close()
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["session-launch: validateSessionStartBody rejects malformed bodies", testValidateBodyRejectsMalformed],
	["session-launch: launchSession spawns a detached process (returns before it finishes)", testStartSpawnsDetachedProcess],
	["session-launch: POST /api/session/start validates + returns sessionId", testStartHttpEndpointValidatesAndSpawns],
	["session-launch: POST /api/session/:id/answer round-trips and unblocks a real escalation", testAnswerRoundTripUnblocksRealEscalation],
	["session-launch: POST /api/session/:id/answer validates + rejects unknown sessions", testAnswerValidatesAndRejectsUnknown],
	["session-launch: GET /api/modes returns the merged mode list", testModesEndpointReturnsMergedModes],
	["session-launch: GET /api/modes requires repo (param or --repo)", testModesEndpointRequiresRepo],
	["session-launch: optional bearer token gates control-plane POSTs, off by default", testTokenGatesControlPlanePosts],
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
	console.log(`\nAll ${tests.length} session-launch tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
