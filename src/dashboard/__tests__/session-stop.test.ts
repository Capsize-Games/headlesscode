/**
 * Tests for POST /api/session/:id/stop (session-stop.ts +
 * session-pids.ts + server.ts wrapper). Plain assert script, run
 * via `npm test`; a tiny fake CLI stands in for the real one.
 */


import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { Server } from "node:http"

import { startDashboardServer } from "../server.js"
import { eventsFilePath, readEventsFile } from "../../engine/events.js"
import { liveUsageFilePath, writeLiveUsage } from "../../engine/usage.js"
import { findSessionPidRecord, markSessionPidStopped,
	readSessionPidRecord, recordSessionPid } from "../session-pids.js"
import { runMain } from "../../test-runner.js"

interface HarnessOptions { ignoreTerm?: boolean; token?: string }
interface Harness { server: Server; base: string; repo: string
	fakeDir: string; marker: string; pid: number }
interface LaunchBody { sessionId: string; pid: number }
interface StopBody { status: string; signal?: string; pid?: number }
type Reply = { status: number; body: unknown }

async function tmpRepo(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "hc-stop-"))
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true } catch { return false }
}

function killQuiet(pid: number): void {
	if (pid <= 0) return
	try {
		process.kill(-pid, "SIGKILL")
	} catch {
		try { process.kill(pid, "SIGKILL") } catch { /* gone */ }
	}
}

async function makeFakeCli(ignoreTerm: boolean):
	Promise<{ dir: string; script: string; marker: string }> {
	const dir = await tmpRepo()
	const script = path.join(dir, "fake-cli.mjs")
	const marker = path.join(dir, "started.marker")
	const lines = ['import { writeFileSync } from "node:fs";',
		ignoreTerm ? 'process.on("SIGTERM", () => {});' : "",
		`writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
		"await new Promise((r) => setTimeout(r, 60000));"]
	await fs.writeFile(script, lines.join("\n"), "utf-8")
	return { dir, script, marker }
}

async function startHarness(opts: HarnessOptions): Promise<Harness> {
	const repo = await tmpRepo()
	const fake = await makeFakeCli(opts.ignoreTerm ?? false)
	const server = await startDashboardServer({ port: 0, repo,
		token: opts.token, cli: `node ${fake.script}`,
		repoRoot: fake.dir })
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	return { server, repo, fakeDir: fake.dir, marker: fake.marker,
		base: `http://127.0.0.1:${port}`, pid: 0 }
}

async function closeHarness(h: Harness): Promise<void> {
	h.server.close()
	killQuiet(h.pid)
	await fs.rm(h.repo, { recursive: true, force: true })
	await fs.rm(h.fakeDir, { recursive: true, force: true })
}

async function post(base: string, urlPath: string, payload?: unknown,
	token?: string): Promise<Reply> {
	const headers = { "content-type": "application/json" } as
		Record<string, string>
	if (token) headers.authorization = "Bearer " + token
	const body = payload === undefined ? undefined : JSON.stringify(payload)
	const res = await fetch(base + urlPath, { method: "POST", headers, body })
	const text = await res.text()
	let parsed: unknown
	try { parsed = JSON.parse(text) } catch { parsed = text }
	return { status: res.status, body: parsed }
}

async function waitForPid(marker: string): Promise<number> {
	for (let i = 0; i < 60; i++) {
		try { return Number(await fs.readFile(marker, "utf-8")) }
		catch { await sleep(50) }
	}
	throw new Error("fake cli did not start")
}

async function launch(h: Harness, token?: string): Promise<LaunchBody> {
	const res = await post(h.base, "/api/session/start",
		{ task: "do work", mode: "code" }, token)
	assert.equal(res.status, 200)
	const launched = res.body as LaunchBody
	h.pid = await waitForPid(h.marker)
	assert.equal(launched.pid, h.pid)
	return launched
}

async function stop(h: Harness, id: string, payload?: unknown,
	token?: string): Promise<Reply> {
	return post(h.base, `/api/session/${id}/stop`, payload, token)
}

async function seedRunningState(repo: string, id: string): Promise<void> {
	await fs.writeFile(path.join(repo, ".harness.pause-requested"),
		new Date().toISOString() + "\n", "utf-8")
	await writeLiveUsage(repo, { sessionId: id, mode: "code",
		model: "fake", iterations: 1, inputTokens: 0, outputTokens: 0,
		costUsd: 0, startedAt: new Date().toISOString(),
		status: "running", workspaceRoot: repo })
}

async function stoppedEventCount(repo: string, id: string):
	Promise<number> {
	const events = await readEventsFile(eventsFilePath(repo, id))
	return events.filter((e) => e.type === "session_stopped").length
}

async function assertCleared(repo: string, id: string): Promise<void> {
	await assert.rejects(fs.access(
		path.join(repo, ".harness.pause-requested")),
		"pause marker must be cleared on stop")
	await assert.rejects(fs.access(liveUsageFilePath(repo, id)),
		"live usage snapshot must be removed on stop")
	assert.equal((await readSessionPidRecord(repo, id))?.status, "stopped")
	assert.equal(await stoppedEventCount(repo, id), 1)
}

async function testStopLiveSession(): Promise<void> {
	const h = await startHarness({})
	try {
		const launched = await launch(h)
		assert.ok(alive(launched.pid), "session runs before stop")
		await seedRunningState(h.repo, launched.sessionId)
		const res = await stop(h, launched.sessionId)
		assert.equal(res.status, 200)
		const body = res.body as StopBody
		assert.equal(body.status, "stopped")
		assert.equal(body.signal, "SIGTERM")
		assert.equal(body.pid, launched.pid)
		assert.ok(!alive(launched.pid), "pid is dead after stop")
		await assertCleared(h.repo, launched.sessionId)
	} finally { await closeHarness(h) }
}

async function testStopUnknownSession(): Promise<void> {
	const h = await startHarness({})
	try {
		const res = await stop(h, "ghost")
		assert.equal(res.status, 404)
		assert.equal((res.body as StopBody).status, "unknown")
		const getRes = await fetch(h.base + "/api/session/ghost/stop")
		assert.equal(getRes.status, 405, "a GET must never stop")
		const bad = await stop(h, "ghost", { graceMs: -1 })
		assert.equal(bad.status, 400, "bad graceMs is a clear 400")
	} finally { await closeHarness(h) }
}

async function testStopNoPidRecorded(): Promise<void> {
	const h = await startHarness({})
	try {
		// A CLI-launched session: event feed exists, no pid record.
		const file = eventsFilePath(h.repo, "cli-session")
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(file, JSON.stringify({
			ts: "2026-08-01T00:00:00.000Z", sessionId: "cli-session",
			type: "session_start" }) + "\n", "utf-8")
		const res = await stop(h, "cli-session")
		assert.equal(res.status, 404)
		assert.equal((res.body as StopBody).status, "no-pid-recorded")
	} finally { await closeHarness(h) }
}

async function testStopIsIdempotent(): Promise<void> {
	const h = await startHarness({})
	try {
		const launched = await launch(h)
		const first = await stop(h, launched.sessionId)
		assert.equal(first.status, 200)
		assert.equal((first.body as StopBody).status, "stopped")
		const second = await stop(h, launched.sessionId)
		assert.equal(second.status, 200)
		assert.equal((second.body as StopBody).status, "already-stopped")
		assert.ok(!alive(launched.pid))
		assert.equal(await stoppedEventCount(h.repo, launched.sessionId), 1)
	} finally { await closeHarness(h) }
}

async function testStopEscalatesToSigkill(): Promise<void> {
	const h = await startHarness({ ignoreTerm: true })
	try {
		const launched = await launch(h)
		const res = await stop(h, launched.sessionId, { graceMs: 150 })
		assert.equal(res.status, 200)
		assert.equal((res.body as StopBody).signal, "SIGKILL")
		assert.ok(!alive(launched.pid), "dead after SIGKILL")
	} finally { await closeHarness(h) }
}

async function testStopRequiresAuthToken(): Promise<void> {
	const h = await startHarness({ token: "sekret" })
	try {
		const launched = await launch(h, "sekret")
		const noAuth = await stop(h, launched.sessionId)
		assert.equal(noAuth.status, 401)
		assert.ok(alive(launched.pid), "401 stop must not kill")
		const good = await stop(h, launched.sessionId, undefined, "sekret")
		assert.equal(good.status, 200)
		assert.ok(!alive(launched.pid), "authorized stop kills")
	} finally { await closeHarness(h) }
}

async function testPidRegistryRoundTrip(): Promise<void> {
	const repo = await tmpRepo()
	try {
		await recordSessionPid({ sessionId: "s1", pid: 424242,
			workspaceRoot: repo, mode: "code" })
		const found = await findSessionPidRecord(repo, "s1")
		assert.equal(found?.record.pid, 424242)
		assert.equal(found?.record.status, "running")
		assert.equal(found?.source, ".")
		await markSessionPidStopped(repo, "s1", "SIGTERM")
		assert.equal((await readSessionPidRecord(repo, "s1"))?.status,
			"stopped")
		assert.equal(await readSessionPidRecord(repo, "../s1"), null)
	} finally { await fs.rm(repo, { recursive: true, force: true }) }
}

const tests: Array<[string, () => Promise<void>]> = [
	["stop: kills recorded pid + finalizes state", testStopLiveSession],
	["stop: unknown -> 404 (GET 405, bad grace 400)", testStopUnknownSession],
	["stop: feed w/o pid record -> 404", testStopNoPidRecorded],
	["stop: second stop idempotent", testStopIsIdempotent],
	["stop: SIGTERM-ignoring pid -> SIGKILL", testStopEscalatesToSigkill],
	["stop: bearer [REDACTED] gates stop", testStopRequiresAuthToken],
	["stop: pid registry round-trip", testPidRegistryRoundTrip],
]

runMain("session-stop", tests)
