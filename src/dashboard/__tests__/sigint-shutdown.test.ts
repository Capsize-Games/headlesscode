/**
 * Regression test for issue #75: the dashboard/trend CLIs could not be shut
 * down with Ctrl-C — the SIGINT handler resolved the process's exit-code
 * promise but never closed the HTTP server, so the listening handle kept the
 * event loop alive and the port stayed bound forever.
 *
 * Approach: drive the REAL CLI (`src/cli.ts trend|dashboard`) as a separate
 * child process and deliver a REAL OS-level SIGINT via `child.kill("SIGINT")`
 * once the server is up — the same signal a Ctrl-C sends to a foreground
 * process. The signal lands in the child process, never in the test process
 * itself, which is what keeps this runner-safe: a previous in-process version
 * used `process.emit("SIGINT")` and REMOVED the real handler on the way out,
 * so a real SIGINT delivered to the test process (as the GitHub Actions
 * runner does) hit a process with no handler registered and the suite died
 * red with exit 130, 3/3 on the runner. The port-released assertion fails on
 * the pre-fix code (server never closed) and passes on the fix.
 *
 * The child is spawned as `node --import <tsx-loader> src/cli.ts ...` — the
 * in-process tsx loader path, not the `tsx` bin: the bin is a process manager
 * that mis-relays SIGINT to the wrapper with exit 130 even when the script
 * itself handles it cleanly (reproduced deterministically while developing
 * this test), and the signal behavior of that wrapper is not the code under
 * test. What IS under test is the app's own handler, and that is identical
 * either way.
 *
 * Plain assert-based script (no test framework, no network beyond localhost),
 * run via `npm test`.
 */

import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)))

// The signal under test is delivered to the CHILD CLI process, never to this
// test process — the previous in-process version used `process.emit("SIGINT")`
// and REMOVED the real handler on the way out, so a real SIGINT from the
// runner with no handler registered terminated the suite with 130 (red 3/3 on
// the GitHub Actions runner). Registering a permanent no-op SIGINT/SIGTERM
// handler here means a stray runner signal is swallowed instead of terminating
// the suite in any window where the suite itself has no handler registered;
// the CLI child still receives its own SIGINT and must exit 0.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		// Intentionally empty — see above.
	})
}

/** Grab a currently-free port (bind on 0, note the port, close). */
async function freePort(): Promise<number> {
	const probe = net.createServer()
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()))
	const addr = probe.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	await new Promise<void>((resolve) => probe.close(() => resolve()))
	return port
}

/**
 * Resolve the tsx LOADER path by walking up from `dir` — the same walk-up
 * scripts/run-tests.mjs uses (worktrees are filesystem children of the main
 * checkout, which owns node_modules). The child is spawned as
 * `node --import <loader> src/cli.ts ...` so the CLI runs in-process with the
 * tsx loader and NO tsx process-manager wrapper (see the header note).
 */
function resolveTsxLoader(dir: string): string {
	let current = dir
	for (;;) {
		const candidate = path.join(current, "node_modules", "tsx", "dist", "loader.mjs")
		if (fsSync.existsSync(candidate)) {
			return candidate
		}
		const parent = path.dirname(current)
		if (parent === current) {
			throw new Error(`could not find node_modules/tsx/dist/loader.mjs walking up from ${dir}`)
		}
		current = parent
	}
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

/** Resolve the child's exit; SIGKILL + reject if it lingers past the deadline. */
function waitForExit(
	child: ChildProcess,
	timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			reject(new Error(`CLI child did not exit within ${timeoutMs}ms (SIGKILL sent)`))
		}, timeoutMs)
		child.once("exit", (code, signal) => {
			clearTimeout(timer)
			resolve({ code, signal })
		})
	})
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
 * Shared flow: spawn the real CLI subcommand in a separate process, wait
 * until it serves HTTP, deliver a REAL SIGINT, and assert it exits 0 AND the
 * port is released. `name` only labels diagnostics; child output is captured
 * for failure messages.
 */
async function assertSigintShutsDown(
	name: string,
	args: string[],
	port: number,
): Promise<void> {
	const child = spawn(
		process.execPath,
		["--import", resolveTsxLoader(REPO_ROOT), "src/cli.ts", ...args, "--port", String(port)],
		{ cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env },
	)
	let output = ""
	child.stdout?.on("data", (d: Buffer) => {
		output += d.toString()
	})
	child.stderr?.on("data", (d: Buffer) => {
		output += d.toString()
	})
	const exitPromise = waitForExit(child)
	try {
		await waitForServer(port)
		child.kill("SIGINT")
		const { code, signal } = await exitPromise
		assert.equal(
			code,
			0,
			`${name} must exit 0 on a real SIGINT (code=${code} signal=${signal}); output:\n${output}`,
		)
		assert.ok(
			await isPortFree(port),
			`${name} must release its port after SIGINT (issue #75); output:\n${output}`,
		)
	} finally {
		// Defensive: never leave a stray CLI process behind on a failed assert.
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL")
		}
	}
}

async function testTrendCliSigintClosesServer(): Promise<void> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "hc-sigint-trend-"))
	try {
		const port = await freePort()
		await assertSigintShutsDown("trend", ["trend", "--repo", repo], port)
	} finally {
		await fs.rm(repo, { recursive: true, force: true })
	}
}

async function testDashboardCliSigintClosesServer(): Promise<void> {
	const port = await freePort()
	await assertSigintShutsDown("dashboard", ["dashboard"], port)
}

const tests: Array<[string, () => Promise<void>]> = [
	["trend CLI: real SIGINT closes the HTTP server and releases the port", testTrendCliSigintClosesServer],
	["dashboard CLI: real SIGINT closes the HTTP server and releases the port", testDashboardCliSigintClosesServer],
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
