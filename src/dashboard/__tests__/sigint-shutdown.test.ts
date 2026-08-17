/**
 * Regression test for issue #75: the dashboard/trend CLIs could not be shut
 * down with Ctrl-C — the SIGINT handler resolved the process's exit-code
 * promise but never closed the HTTP server, so the listening handle kept the
 * event loop alive and the port stayed bound forever.
 *
 * Approach: drive the REAL `trendMain`/`dashboardMain` entry points in this
 * process and emit "SIGINT" on `process` once the server is up. A manual
 * `process.emit("SIGINT")` invokes the exact listener a real Ctrl-C triggers
 * (Node only terminates the process for the OS-level signal dispatch, not for
 * the event emission). The server is already listening — and the handler
 * already registered — by the time HTTP requests succeed, so no extra
 * handshake is needed. The port-released assertion fails on the pre-fix code
 * (server never closed) and passes on the fix.
 *
 * Plain assert-based script (no test framework, no network beyond localhost),
 * run via `npm test`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

import { dashboardMain } from "../cli.js"
import { trendMain } from "../trend-cli.js"

/** Grab a currently-free port (bind on 0, note the port, close). */
async function freePort(): Promise<number> {
	const probe = http.createServer()
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()))
	const addr = probe.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	await new Promise<void>((resolve) => probe.close(() => resolve()))
	return port
}

/** Poll `GET /` until the server responds (deadline-bounded). */
async function waitForServer(port: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/`)
			res.body?.cancel()
			if (res.status === 200) {
				return
			}
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) {
			throw new Error(`server on port ${port} did not start within ${timeoutMs}ms`)
		}
		await new Promise((r) => setTimeout(r, 25))
	}
}

/** True once `port` can be bound again (retried — close is async). */
async function isPortFree(port: number, timeoutMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const free = await new Promise<boolean>((resolve) => {
			const probe = net.createServer()
			probe.once("error", () => resolve(false))
			probe.listen(port, "127.0.0.1", () => {
				probe.close(() => resolve(true))
			})
		})
		if (free) {
			return true
		}
		if (Date.now() > deadline) {
			return false
		}
		await new Promise((r) => setTimeout(r, 20))
	}
}

/**
 * Shared flow: start the CLI, wait until it serves HTTP, deliver SIGINT, and
 * assert it exits 0 AND the port is released. `name` only labels diagnostics.
 */
async function assertSigintShutsDown(
	name: string,
	pending: Promise<number>,
	port: number,
): Promise<void> {
	try {
		await waitForServer(port)
		assert.ok(
			process.listenerCount("SIGINT") > 0,
			`${name} must register a SIGINT handler before serving`,
		)
		process.emit("SIGINT")
		const code = await pending
		assert.equal(code, 0, `${name} must exit 0 on SIGINT`)
		assert.ok(await isPortFree(port), `${name} must release its port after SIGINT (issue #75)`)
	} finally {
		// Defensive cleanup: if an assertion above failed before the signal
		// ran, make sure any registered handler closes the server so this
		// test process doesn't linger with a bound port.
		if (process.listenerCount("SIGINT") > 0) {
			process.emit("SIGINT")
		}
	}
}

async function testTrendCliSigintClosesServer(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-sigint-trend-"))
	try {
		const port = await freePort()
		const pending = trendMain(["--repo", repo, "--port", String(port)])
		await assertSigintShutsDown("trend", pending, port)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testDashboardCliSigintClosesServer(): Promise<void> {
	const port = await freePort()
	const pending = dashboardMain(["--port", String(port)])
	await assertSigintShutsDown("dashboard", pending, port)
}

const tests: Array<[string, () => Promise<void>]> = [
	["trend CLI: SIGINT closes the HTTP server and releases the port", testTrendCliSigintClosesServer],
	["dashboard CLI: SIGINT closes the HTTP server and releases the port", testDashboardCliSigintClosesServer],
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
	console.log(`\nAll ${tests.length} sigint-shutdown tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
